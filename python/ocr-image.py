#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ocr-image.py —— 图片文字识别（离线，无需 Token、无需联网）【APP 内置副本】

来源：Work/scripts/ocr-image.py，2026-11-27 移植进 APP 的 python/ 目录。
为什么要副本：APP 进程的 Node fs 有白名单，读不到 Work\\临时\\ 下的脚本（实测 ERR_ACCESS_DENIED）。
OCR 能力必须落在 APP 自己的目录里，走 venv 的子进程通道。

引擎：rapidocr-onnxruntime（venv 内，ONNX 推理，中文模型，离线）。
对界面截图 / 文档扫描件的印刷体识别良好；
**手写体、竖排、复杂版面未做验证**，用在正式材料上前先抽查。

子命令
------
  probe                          自检：引擎可用性、依赖版本、耗时
  ocr <路径...>                  识别单张/多张图片，结果打印到 stdout
  ocr <路径...> --json           结构化 JSON（含每行置信度与四点坐标）

常用参数
-------
  --json            输出结构化 JSON（含每行的置信度与四点坐标）
  --min-score 0.5   低于此置信度的行丢弃（默认 0）
  --quiet           不打印进度，只出结果

铁律
----
  * 只读图片，绝不修改或删除输入。
  * 输出文件一律 UTF-8 无 BOM。
  * 输入不存在 → 明确报错并给退出码 2，不静默跳过。
"""

import argparse
import json
import os
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff", ".gif")

_ENGINE = None


def get_engine():
    """懒加载。只在真正要识别时才 import + 初始化（约 1.4 秒）。"""
    global _ENGINE
    if _ENGINE is not None:
        return _ENGINE
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as exc:
        sys.stderr.write(
            "错误：未找到 rapidocr-onnxruntime。\n"
            "  安装：pip install rapidocr-onnxruntime\n"
            f"  (原始错误: {exc})\n"
        )
        sys.exit(3)
    _ENGINE = RapidOCR()
    return _ENGINE


def collect_inputs(paths):
    files, errors = [], []
    for p in paths:
        if os.path.isdir(p):
            for root, _dirs, names in os.walk(p):
                for n in sorted(names):
                    if n.lower().endswith(IMAGE_EXTS):
                        files.append(os.path.join(root, n))
        elif os.path.isfile(p):
            files.append(p)
        else:
            errors.append(p)
    return files, errors


def run_ocr(path, min_score=0.0):
    engine = get_engine()
    result, _elapse = engine(path)
    lines = []
    for item in (result or []):
        box, text, score = item[0], item[1], float(item[2])
        if score < min_score:
            continue
        lines.append({
            "text": str(text),
            "score": round(score, 4),
            "box": [[int(round(x)), int(round(y))] for x, y in box],
        })
    return lines, result


def cmd_probe(_args):
    print("=== 环境自检 ===")
    try:
        import rapidocr_onnxruntime  # noqa: F401
    except ImportError:
        print("rapidocr-onnxruntime : 未安装")
        return 3
    try:
        import importlib.metadata as md
        for pkg in ("rapidocr-onnxruntime", "onnxruntime", "opencv-python", "numpy"):
            try:
                print(f"{pkg:21}: {md.version(pkg)}")
            except Exception:
                print(f"{pkg:21}: ?")
    except Exception:
        pass
    t0 = time.time()
    get_engine()
    print(f"{'引擎初始化':21}: {time.time() - t0:.2f}s")
    print()
    print("状态：可用。离线、无需 Token。")
    return 0


def cmd_ocr(args):
    files, errors = collect_inputs(args.paths)
    if errors:
        for e in errors:
            sys.stderr.write(f"错误：路径不存在 —— {e}\n")
        if not files:
            return 2
    if not files:
        sys.stderr.write("错误：没有找到任何图片文件。\n")
        return 2

    total_lines = 0
    ok, failed = 0, []
    report = []

    for i, f in enumerate(files, 1):
        if not args.quiet:
            sys.stderr.write(f"[{i}/{len(files)}] {os.path.basename(f)} ... ")
            sys.stderr.flush()
        t0 = time.time()
        try:
            lines, _raw = run_ocr(f, args.min_score)
        except Exception as exc:
            failed.append((f, str(exc)))
            if not args.quiet:
                sys.stderr.write(f"失败: {exc}\n")
            continue
        cost = time.time() - t0
        ok += 1
        total_lines += len(lines)
        if not args.quiet:
            sys.stderr.write(f"{len(lines)} 行  {cost:.2f}s\n")
        report.append({"source": f, "lines": lines, "elapsed": round(cost, 3)})

    if args.json:
        print(json.dumps(
            {"ok": ok, "failed": [{"source": s, "error": e} for s, e in failed],
             "total_lines": total_lines, "results": report},
            ensure_ascii=False, indent=2,
        ))
    else:
        for r in report:
            print(f"=== {r['source']} ({len(r['lines'])} 行) ===")
            for l in r["lines"]:
                print(l["text"])
            print()

    if failed and not args.quiet:
        print(f"失败 {len(failed)} 个，成功 {ok} 个。", file=sys.stderr)
    return 0 if not failed else 1


def main():
    ap = argparse.ArgumentParser(
        description="图片文字识别（离线 rapidocr，无需 Token）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("probe", help="环境自检：引擎可用性与版本")
    p = sub.add_parser("ocr", help="识别图片（文件或目录）")
    p.add_argument("paths", nargs="+", help="图片路径，或包含图片的目录")
    p.add_argument("--json", action="store_true", help="输出结构化 JSON")
    p.add_argument("--min-score", type=float, default=0.0, help="置信度下限（默认 0）")
    p.add_argument("--quiet", action="store_true", help="不打印进度")
    args = ap.parse_args()
    if args.cmd == "probe":
        return cmd_probe(args)
    if args.cmd == "ocr":
        return cmd_ocr(args)
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
