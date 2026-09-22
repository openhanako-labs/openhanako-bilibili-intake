"""本地文档取文本 —— P1（2026-09-22）。

为什么单独一个脚本，而不是塞进 collector.py：
    collector.py 是「平台采集」的 dispatcher；本地文件与它无关。
    这个脚本只干一件事：把本地文档变成 text.txt + 小节结构，
    之后与视频/文章走同一条总结链路（artifact.json 由 JS 侧统一落盘）。

⭐ 为什么解析放在 Python 而不是 Node：
    App 的 JS 跑在宿主的 Node 权限模型里（--permission
    --allow-fs-read=<安装目录> --allow-fs-read/write=<app-data>），
    **任何越界的 fs 调用都会抛 ERR_ACCESS_DENIED，连 fs.existsSync 都会抛**。
    用户丢过来的 PDF 在哪都可能，所以 JS 侧一律不碰用户路径与其它插件目录；
    由这个子进程（子进程不继承权限模型）负责 stat / 读取 / 调用外部工具。

解析策略（两级）：
    ① 复用环境里已装好的 doc-intake（MinerU / PaddleOCR / 本地 PyMuPDF 三档降级链）——
       重活都在它那边，本脚本只负责找它、跑它、把 markdown 收回来；
    ② doc-intake 不在 / 失败 / 格式太轻时，用标准库自己解析（txt/md/html/docx/csv/json）。

用法：
    python doc_extract.py --source <文件> --output-dir <目录> [--builtin-only]
                          [--delegate-python <exe>] [--delegate-script <main.py>]
输出：stdout 一份 JSON。
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

TEXT_SUFFIXES = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".yaml", ".yml", ".rst"}
HTML_SUFFIXES = {".html", ".htm", ".xhtml"}
DOCX_SUFFIXES = {".docx", ".docm"}
PDF_SUFFIXES = {".pdf"}
# 这些格式本脚本不解析，交给 doc-intake（它才有版面分析 / OCR）
HEAVY_SUFFIXES = PDF_SUFFIXES | {
    ".doc", ".ppt", ".pptx", ".xls", ".xlsx",
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff",
}

# ⭐ 把输出钉成 UTF-8（2026-09-22 实测的坑）：
#   AppHost 给子进程的环境是**白名单**，不带 PYTHONUTF8；Windows 下 Python 的 stdout
#   就退回本地编码（cp936），而 JS 端按 UTF-8 解码 —— 中文全变 U+FFFD。
#   这里不依赖环境变量，直接把 stdout/stderr reconfigure 成 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # 不是 TextIOWrapper 就算了
        pass

INLINE_TEXT_LIMIT = 20_000
DELEGATE_TIMEOUT = 600


# ────────────────────────── doc-intake 复用 ──────────────────────────

def find_doc_intake_script(explicit: str = "") -> str:
    """找 doc-intake 的 main.py。子进程里可以自由 stat，所以这里不猜死路径。"""
    candidates = [
        explicit,
        os.environ.get("DOC_INTAKE_SCRIPT", ""),
        os.path.join(os.environ.get("HANA_HOME", ""), "plugins", "doc-intake", "python", "main.py"),
        os.path.join(os.path.expanduser("~"), ".hanako", "plugins", "doc-intake", "python", "main.py"),
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return ""


def find_delegate_python(explicit: str = "") -> list[str]:
    """找一个**真能跑 doc-intake** 的解释器：必须能 import fitz / PIL / requests。"""
    candidates: list[list[str]] = []
    if explicit and explicit.strip():
        candidates.append([explicit.strip()])
    for name in ("python", "python3"):
        found = shutil.which(name)
        if found:
            candidates.append([found])
    if os.name == "nt":
        found = shutil.which("py")
        if found:
            candidates.append([found, "-3"])
    probe = "import fitz, PIL, requests"
    for c in candidates:
        try:
            r = subprocess.run(c + ["-c", probe], capture_output=True, text=True, timeout=30)
            if r.returncode == 0:
                return c
        except Exception:
            continue
    return []


def _last_json(text: str):
    """doc-intake 的 stdout 里最后一段 JSON（它的日志走 stderr，但保险起见）。"""
    s = (text or "").strip()
    if not s:
        return None
    try:
        return json.loads(s)
    except Exception:
        pass
    i, j = s.find("{"), s.rfind("}")
    if i >= 0 and j > i:
        try:
            return json.loads(s[i:j + 1])
        except Exception:
            return None
    return None


def run_doc_intake(script: str, python_prefix: list[str], source: str, work_dir: Path) -> tuple[str, dict, str]:
    """跑一次 doc-intake，返回 (markdown, meta, error)。"""
    # 它的 save_result 拒绝覆盖已存在的 <文件名>.md，所以每次先清自己的暂存目录。
    if work_dir.exists():
        shutil.rmtree(work_dir, ignore_errors=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    settings = {
        "defaultBackend": "auto",
        "pdfBackendChain": ["local"],
        "includeMedia": False,
        "includeImages": False,
        "saveJson": False,
        "logLevel": "WARN",
        "defaultLanguage": "zh",
    }
    env = {**os.environ, "PYTHONUTF8": "1", "DOC_INTAKE_LOG_LEVEL": "WARN"}
    try:
        proc = subprocess.run(
            python_prefix + [script, "--source", str(source), "--output-dir", str(work_dir)],
            input=json.dumps(settings, ensure_ascii=False),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=env, timeout=DELEGATE_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return "", {}, f"doc-intake 超时（{DELEGATE_TIMEOUT}s）"
    except Exception as exc:
        return "", {}, f"doc-intake 起不来: {exc}"

    doc = _last_json(proc.stdout)
    if proc.returncode == 0 and isinstance(doc, dict) and doc.get("markdown"):
        return str(doc["markdown"]).strip(), (doc.get("metadata") or {}), ""
    tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-4:]
    return "", {}, " | ".join(t.strip() for t in tail)[:400] or f"退出码 {proc.returncode}"


# ────────────────────────── 标准库解析（回退档） ──────────────────────────

def read_text_file(path: Path) -> str:
    for enc in ("utf-8", "utf-8-sig", "gbk", "latin-1"):
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="replace")


def html_to_text(raw: str) -> tuple[str, str]:
    """HTML → 轻量 Markdown（保留标题层级），返回 (title, text)。"""
    title = ""
    m = re.search(r"<title[^>]*>(.*?)</title>", raw, re.I | re.S)
    if m:
        title = html.unescape(re.sub(r"\s+", " ", m.group(1))).strip()

    body = re.sub(r"<(script|style|noscript)[^>]*>.*?</\1>", " ", raw, flags=re.I | re.S)
    for level in range(1, 7):
        body = re.sub(
            rf"<h{level}[^>]*>(.*?)</h{level}>",
            lambda mm, lv=level: "\n\n" + "#" * lv + " " + re.sub(r"<[^>]+>", "", mm.group(1)).strip() + "\n\n",
            body, flags=re.I | re.S,
        )
    body = re.sub(r"<li[^>]*>", "\n- ", body, flags=re.I)
    body = re.sub(r"<br\s*/?>", "\n", body, flags=re.I)
    body = re.sub(r"</(p|div|section|article|tr|h[1-6]|ul|ol|table)>", "\n\n", body, flags=re.I)
    body = re.sub(r"<[^>]+>", "", body)
    text = html.unescape(body)
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return title, text.strip()


def docx_to_text(path: Path) -> tuple[str, str]:
    """DOCX = zip + word/document.xml。保留标题层级。"""
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        xml = zf.read("word/document.xml").decode("utf-8", errors="replace")
        title = ""
        if "docProps/core.xml" in names:
            core = zf.read("docProps/core.xml").decode("utf-8", errors="replace")
            m = re.search(r"<dc:title[^>]*>(.*?)</dc:title>", core, re.S)
            if m:
                title = html.unescape(m.group(1)).strip()

    out: list[str] = []
    for para in re.findall(r"<w:p[ >].*?</w:p>|<w:p/>", xml, re.S):
        style = re.search(r'<w:pStyle w:val="([^"]+)"', para)
        body = "".join(html.unescape(t) for t in re.findall(r"<w:t[^>]*>(.*?)</w:t>", para, re.S))
        body = re.sub(r"<w:br\s*/>", "\n", body).strip()
        if not body:
            continue
        level = 0
        if style:
            m = re.search(r"[Hh]eading\s*([1-6])", style.group(1))
            if m:
                level = int(m.group(1))
        out.append(("#" * level + " " if level else "") + body)
    return title, re.sub(r"\n{3,}", "\n\n", "\n\n".join(out)).strip()


def parse_builtin(path: Path) -> tuple[str, str, str]:
    """标准库解析，返回 (title, text, extractor)。"""
    suffix = path.suffix.lower()
    if suffix in HTML_SUFFIXES:
        title, text = html_to_text(read_text_file(path))
        return title, text, "html-stdlib"
    if suffix in DOCX_SUFFIXES:
        title, text = docx_to_text(path)
        return title, text, "docx-stdlib"
    if suffix in PDF_SUFFIXES:
        return "", "", ""  # PDF 只走 doc-intake（本环境的 venv 没有 pypdf）
    if suffix in TEXT_SUFFIXES or suffix == "":
        return "", read_text_file(path), "plain"
    return "", read_text_file(path), "plain-guess"


def count_sections(text: str) -> int:
    heads = re.findall(r"^#{1,6}[ \t]+\S", text, re.M)
    if heads:
        return len(heads)
    return len([p for p in re.split(r"\n{2,}", text) if len(p.strip()) >= 200])


def main() -> int:
    parser = argparse.ArgumentParser(description="本地文档取文本（P1）")
    parser.add_argument("--source", required=True, help="本地文件路径")
    parser.add_argument("--output-dir", required=True, help="输出目录")
    parser.add_argument("--title", default="", help="可选：覆盖标题")
    parser.add_argument("--builtin-only", action="store_true", help="只用标准库解析，不调 doc-intake")
    parser.add_argument("--delegate-python", default="", help="可选：跑 doc-intake 的解释器")
    parser.add_argument("--delegate-script", default="", help="可选：doc-intake main.py 路径")
    args = parser.parse_args()

    src = Path(args.source).expanduser()
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not src.exists():
        print(json.dumps({"ok": False, "error": f"文件不存在：{src}"}, ensure_ascii=False))
        return 1
    if src.is_dir():
        print(json.dumps({"ok": False, "error": f"这是一个目录，不是文件：{src}"}, ensure_ascii=False))
        return 1

    suffix = src.suffix.lower()
    title, text, extractor = "", "", ""
    meta: dict = {}
    delegate_error = ""

    # ① 优先 doc-intake：重格式（PDF/Office/图片）必走，轻格式也先试（它更全）
    if not args.builtin_only:
        script = find_doc_intake_script(args.delegate_script)
        if not script:
            delegate_error = "未找到 doc-intake（plugins/doc-intake/python/main.py）"
        else:
            py_prefix = find_delegate_python(args.delegate_python)
            if not py_prefix:
                delegate_error = "没有能 import fitz/PIL/requests 的解释器"
            else:
                md, meta, delegate_error = run_doc_intake(script, py_prefix, str(src), out_dir / "doc-intake")
                # ⚠️ 2026-09-22 实测：doc-intake 对**不支持的格式**（比如 .md）会正常退出、
                #   还返一份 markdown —— 内容是 “# 错误 / 所有提取后端都失败”。
                #   当成功收下它，产出的正文就只有 15 个字。
                #   所以：必须看 metadata.usedBackend —— 空就意味着没有后端真的干成活。
                if md and meta.get("usedBackend"):
                    text = md
                    extractor = f"doc-intake:{meta.get('usedBackend')}"
                elif md:
                    delegate_error = "doc-intake 没有接手该格式（它返回的是失败说明），改用内置解析器"

    # ② 回退：标准库（doc-intake 不在/失败，或本来就是轻格式）
    if not text:
        if suffix in PDF_SUFFIXES:
            print(json.dumps({
                "ok": False,
                "error": "PDF 需要 doc-intake 解析，但它这次没跑成。",
                "hint": delegate_error or "检查 doc-intake 是否安装、python 是否有 fitz/PIL/requests。",
            }, ensure_ascii=False))
            return 1
        try:
            title, text, extractor = parse_builtin(src)
        except Exception as exc:
            print(json.dumps({"ok": False, "error": f"解析失败: {exc}", "suffix": suffix}, ensure_ascii=False))
            return 1

    text = (text or "").strip()
    if not text:
        print(json.dumps({
            "ok": False,
            "error": "没有提取到任何正文（可能是扫描件或纯图片）。",
            "hint": delegate_error or "扫描件请走 doc-intake（需要 MinerU / PaddleOCR token）。",
        }, ensure_ascii=False))
        return 1

    if not title:
        if extractor.startswith("doc-intake"):
            # doc-intake 的 markdown 首个标题是通用文案（“PDF 本地提取结果”之类），
            # 当标题没意义 —— 用文件名。
            title = src.stem
        else:
            head = re.search(r"^#{1,6}[ \t]*(.+)$", text, re.M)
            title = head.group(1).strip() if head else src.stem
    if args.title:
        title = args.title

    text_path = out_dir / "text.txt"
    text_path.write_text(text, encoding="utf-8")

    result = {
        "ok": True,
        "kind": "document",
        "textKind": "document",
        "platform": "document",
        "extractor": extractor or "plain",
        "extractorDetail": (
            {
                "engine": "doc-intake",
                "usedBackend": meta.get("usedBackend") or "",
                "reader": meta.get("reader") or "",
                "backendChain": meta.get("backendChain") or [],
                "mdPath": meta.get("mdPath") or "",
                "warnings": meta.get("warnings") or [],
            }
            if extractor.startswith("doc-intake")
            else {"engine": "builtin", "note": delegate_error or ""}
        ),
        "source": str(src),
        "title": title,
        "outputDir": str(out_dir),
        "transcriptTextPath": str(text_path),
        "textChars": len(text),
        "sections": count_sections(text),
        "text": text if len(text) <= INLINE_TEXT_LIMIT else text[:INLINE_TEXT_LIMIT],
        "truncatedInJson": len(text) > INLINE_TEXT_LIMIT,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
