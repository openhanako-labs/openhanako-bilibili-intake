#!/usr/bin/env python3
"""Multi-platform content collector — orchestrator.

Routes requests to the appropriate platform adapter, handles B站 yt-dlp/Whisper
pipeline, and manages cookies. CLI args parsed by cli.py, platform-specific
logic lives in adapters/ and bilibili_pipeline.py.

Usage:
    # B站 (backward compatible)
    python collector.py --source BV1xx411t7dR --output-dir ./output

    # Multi-platform
    python collector.py --platform xhs --source https://www.xiaohongshu.com/explore/abc...
    python collector.py --platform bilibili --search-keyword "李永乐"

    # Health / routing
    python collector.py --action health
    python collector.py --action routing-status
"""
from __future__ import annotations

# ⭐ v0.6.21：venv 在 Windows 上默认拿不到系统根证书，whisper / huggingface_hub
# 下载模型会报 SSL: CERTIFICATE_VERIFY_FAILED（因为 Python 构建时 ssl
# get_default_verify_paths 只看到 XBL Client IPsec CA 这种企业 CA）。
# 把 ssl.create_default_context 包一层，在 Windows 上自动 load_default_certs，
# 这样 requests / httpx / urllib / huggingface_hub 走默认 context 时都能过 TLS。
# 必须在其他 import 之前，否则 openai-whisper 一 import 就预热了自己的客户端。
try:
    import ssl
    _orig_create_default_context = ssl.create_default_context
    def _create_default_context_with_system_certs(*args, **kwargs):
        ctx = _orig_create_default_context(*args, **kwargs)
        try:
            ctx.load_default_certs()
        except Exception:
            pass
        return ctx
    ssl.create_default_context = _create_default_context_with_system_certs
    # SSL_CERT_FILE 兼容回退：httpx 内部不读 ssl module，而是直接开新 context
    # 从 env 读 cafile，所以顺手把 certifi 路径写进环境变量作为兜底。
    try:
        import os
        import certifi
        _CA_BUNDLE = certifi.where()
        os.environ.setdefault("SSL_CERT_FILE", _CA_BUNDLE)
        os.environ.setdefault("REQUESTS_CA_BUNDLE", _CA_BUNDLE)
        os.environ.setdefault("CURL_CA_BUNDLE", _CA_BUNDLE)
    except ImportError:
        pass
except Exception:
    # 任何加载失败都不阻塞采集主流程，只是 SSL 可能继续失败。
    pass

import json
import re
import sys
from pathlib import Path
from typing import Any

import argparse
import yt_dlp

from cli import parse_args
from health import run_health_check, get_routing_status

# Multi-platform adapter framework
try:
    from adapters import (
        CommentNode, PlatformAdapter, SearchResult,
        detect_platform, get_adapter, list_platforms,
    )
    import adapters.bilibili  # noqa: F401
    import adapters.xhs  # noqa: F401
    import adapters.douyin  # noqa: F401
    import adapters.kuaishou  # noqa: F401
    import adapters.weibo  # noqa: F401
    import adapters.zhihu  # noqa: F401
    import adapters.tieba  # noqa: F401
    _ADAPTERS_AVAILABLE = True
except ImportError as _exc:
    _ADAPTERS_AVAILABLE = False
    _adapters_import_error = str(_exc)

PLUGIN_ROOT = Path(__file__).resolve().parent.parent


def log(message: str) -> None:
    print(f"[collector] {message}", file=sys.stderr, flush=True)


class QuietLogger:
    def debug(self, msg: str) -> None:
        if msg and "[debug]" in msg.lower():
            log(msg)

    def warning(self, msg: str) -> None:
        if msg:
            log(msg)

    def error(self, msg: str) -> None:
        if msg:
            log(msg)


class CollectorError(RuntimeError):
    pass


# ============================================================
# Search & batch
# ============================================================

_SORT_ORDER_MAP = {0: "totalrank", 1: "click", 2: "pubdate", 3: "uvclick"}


def search_videos(keyword: str, sort: int = 0, limit: int = 10, cookies_file: str = "") -> list[dict[str, Any]]:
    """Search Bilibili via public search API."""
    from urllib.parse import quote_plus
    if not keyword:
        return []

    sort_order = _SORT_ORDER_MAP.get(sort, "totalrank")
    limit = min(max(limit, 1), 50)
    base_url = f"https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword={quote_plus(keyword)}&order={sort_order}&page=1&pagesize={limit}"

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
        "Referer": "https://www.bilibili.com/search?q=" + quote_plus(keyword),
        "Origin": "https://www.bilibili.com",
    }

    try:
        import requests as _requests
        cookies = {}
        if cookies_file:
            for part in _read_cookies_for_request(cookies_file).split(";"):
                part = part.strip()
                if "=" in part:
                    k, v = part.split("=", 1)
                    cookies[k.strip()] = v.strip()
        resp = _requests.get(base_url, headers=headers, cookies=cookies, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        log(f"search API error: {exc}")
        return []

    if not isinstance(data, dict):
        return []

    result_list: list[dict[str, Any]] = []
    items = []
    try:
        stage = data.get("data", {})
        items = stage.get("result", []) if isinstance(stage, dict) else []
    except Exception:
        pass

    _meta = {"_keyword": keyword, "_sort": sort}
    for item in (items or []):
        if not isinstance(item, dict):
            continue
        bv_id = str(item.get("bvid") or item.get("aid") or "")
        if not bv_id:
            continue
        result_list.append({
            "bv_id": bv_id, "title": item.get("title") or "",
            "author": item.get("author") or item.get("writer") or "",
            "play_count": item.get("order") or item.get("play") or item.get("video_review") or 0,
            "duration": item.get("duration") or "",
            "pub_date": item.get("pubdate") or item.get("created") or "",
            "url": f"https://www.bilibili.com/video/{bv_id}",
            "full_url": f"https://www.bilibili.com/video/{bv_id}",
            **_meta,
        })

    log(f"search '{keyword}' returned {len(result_list)} results")
    return result_list


def _read_cookies_for_request(cookies_file: str) -> str:
    try:
        lines = Path(cookies_file).read_text(encoding="utf-8").splitlines()
    except Exception:
        return ""
    cookies: list[str] = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith(("#", "//")):
            continue
        parts = line.split("\t")
        if len(parts) >= 7:
            cookies.append(f"{parts[5]}={parts[6]}")
    return "; ".join(cookies)


# ============================================================
# B站 single video pipeline (imports from bilibili_pipeline)
# ============================================================

def _run_single(args: argparse.Namespace) -> None:
    """Execute a single B站 video fetch with full pipeline."""
    from bilibili_pipeline import (
        build_audio_streams, build_common_ydl_opts, build_metadata,
        download_audio, download_subtitles,
        extract_info_via_scrapling, extract_info_via_ytdlp,
        transcribe_audio, log as bili_log,
    )
    from subtitle_parser import choose_subtitle_text

    source = normalize_source(args.source, args.page)
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: Extract metadata
    info = extract_info_via_scrapling(source) if args.use_scrapling else extract_info_via_ytdlp(source, args.cookies_file)
    metadata = build_metadata(info, source)
    write_json(output_dir / "metadata.json", metadata)

    # Step 2: Extract raw yt-dlp info for stream/subtitle/audio
    try:
        raw_opts = build_common_ydl_opts(args.cookies_file, source)
        with yt_dlp.YoutubeDL(raw_opts) as ydl:
            raw_info = ydl.extract_info(source, download=False)
        if isinstance(raw_info, dict):
            write_json(output_dir / "raw_info.json", raw_info)
            streams = build_audio_streams(raw_info)
            write_json(output_dir / "audio_streams.json", streams)
    except Exception as e:
        log(f"yt-dlp raw info failed: {e}")

    # Step 3: Download subtitles
    subtitle_files = download_subtitles(source, output_dir, args.subtitle_languages, args.cookies_file)
    transcript_text = choose_subtitle_text(subtitle_files, args.subtitle_languages)

    # Step 4: Audio + Whisper fallback
    # 整段包 try/except：音频 CDN（如 mcdn.bilivideo.cn:8082）在某些网络下
    # 连不上，yt-dlp 抛出的异常若不被吃掉，会一路顶到 main() 的兜底 except，
    # 整个进程 exit 3 —— 连已经拿到的 metadata / 字幕 / 评论一起丢掉。
    # 降级策略：音频失败不致命，继续往下走（评论、字幕、元数据都还在）。
    audio_path = None
    transcribe_device = None
    transcription_error = None
    # ⭐ v0.6.27：Whisper 的段落级时间轴（锚点）。以前只在函数内部拼成纯文本就丢，
    #   导致"无平台字幕、只能靠 Whisper"的视频完全没有锚点可用。
    transcript_segments: list = []
    try:
        if not args.no_audio:
            if args.force_transcribe:
                # ⭐ v0.6.18：force_transcribe 必须排在「已有字幕就跳过」之前。
                #   旧代码先判 `transcript_text != ""` 直接 pass，force_transcribe
                #   对任何有平台字幕的视频（B 站基本都有 AI 字幕）都是死参数，
                #   而且 transcriptSource 仍然报 platform_subtitle——调用方完全看不出来。
                audio_path = download_audio(source, output_dir, args.audio_format, args.cookies_file)
                transcript_text, transcribe_device, transcript_segments = transcribe_audio(
                    audio_path, args.whisper_model, args.whisper_language, args.whisper_device,
                    getattr(args, "whisper_cpu_threads", 0),
                )
            elif transcript_text != "":
                pass  # 已有平台字幕，不重复下载音频
            else:
                audio_path = download_audio(source, output_dir, args.audio_format, args.cookies_file)
                transcript_text, transcribe_device, transcript_segments = transcribe_audio(
                    audio_path, args.whisper_model, args.whisper_language, args.whisper_device,
                    getattr(args, "whisper_cpu_threads", 0),
                )
    except Exception as exc:
        # ⭐ v0.6.21：以前只 log 就吃掉，上层完全看不出来 Whisper 挂了。
        #   transcriptSource 还是 "none"，和「没字幕没音频」无法区分。
        #   把异常写进 result，让卡片能显示「音频已下载但转写失败：...」。
        transcription_error = f"{type(exc).__name__}: {exc}"
        log(f"[bilibili_pipeline] 音频下载/转写失败，降级跳过（metadata/字幕/评论不受影响）: {transcription_error}")

    # Step 5: Collect comments
    comments = []
    if args.with_comments:
        comments = fetch_comments(source, args.cookies_file, args.comment_limit,
                                  with_sub_comments=args.with_sub_comments)

    visual_result = None

    # Step 6: Build output
    result = {
        "ok": True, "platform": "bilibili",
        "item_id": metadata.get("id", ""),
        "title": metadata.get("title", ""),
        "uploader": metadata.get("uploader", ""),
        "description": metadata.get("description", ""),
        "duration": metadata.get("duration"),
        "view_count": metadata.get("viewCount"),
        "like_count": metadata.get("likeCount"),
        "danmaku_count": 0,
        "reply_count": metadata.get("commentCount"),
        "url": source, "outputDir": str(output_dir),
        # ⭐ v0.6.18：不能用「有没有字幕文件」推断转写来源——
        #   旧写法 `"platform_subtitle" if subtitle_files` 在 force_transcribe
        #   路径下照样报 platform_subtitle，而 transcript_text 已经是 Whisper 输出，
        #   调用方会以为拿到的是 B 站字幕。
        #   改看 transcribe_device 有没有被赋值：transcribe_audio() 只在真的跑过才会写它。
        # ⭐ v0.6.21：transcriptSource="none" 以前无法区分「本来就没字幕」和
        #   「音频下载成功但 Whisper 挂掉」两种情形，上层看到「采集完成」会误以为成功。
        #   新加 audioDownloaded / transcriptionError，让 UI 能区分。
        "transcriptSource": "whisper" if transcribe_device is not None else ("platform_subtitle" if subtitle_files else "none"),
        "transcriptDevice": transcribe_device,
        "audioDownloaded": audio_path is not None,
        "transcriptionError": transcription_error,
        "comments": comments[:args.comment_limit],
    }

    if audio_path:
        result["audioPath"] = str(audio_path)
    result["subtitleFiles"] = [str(s) for s in subtitle_files]

    # ── Write transcript text ──
    if transcript_text:
        text_path = output_dir / "text.txt"
        text_path.write_text(transcript_text, encoding="utf-8")
        result["transcriptText"] = transcript_text
        result["transcriptTextPath"] = str(text_path)

    # ⭐ v0.6.27：转写段落单独落盘（锚点）。上层 lib/anchors.js 依次找
    #   transcript_merged.json（长音频分块）→ transcript_segments.json（本次新增）
    #   → 平台字幕文件。
    if transcript_segments:
        seg_path = output_dir / "transcript_segments.json"
        seg_path.write_text(
            json.dumps(
                {"source": "whisper", "device": transcribe_device, "segments": transcript_segments},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        result["transcriptSegmentsPath"] = str(seg_path)
        result["transcriptSegmentCount"] = len(transcript_segments)

    # Add visual analysis to result
    if visual_result:
        result["visualAnalysis"] = visual_result
        result["visualOk"] = visual_result.get("ok", False)

    write_json(output_dir / "result.json", result)

    # Generate analysis report
    #   ⭐ 2026-09-26：只出正文报告。视觉报告（visual_analysis.md/html）随旧视觉链路
    #   （frame_extractor / visual_analyzer）一起下线；画面分析现在走 lib/shots，
    #   产物落在槽位的 shots/ 下，不再由采集命令顺手写一份。
    try:
        from report_generator import generate_transcript_report
        report_path = generate_transcript_report(
            title=result.get("title", ""),
            uploader=result.get("uploader", ""),
            duration=result.get("duration") or 0,
            transcript=result.get("transcriptText", ""),
            output_dir=output_dir,
        )
        result["reports"] = {"transcript_report": str(report_path)}
        log(f"Report generated: {report_path.name}")
    except Exception as e:
        log(f"Report generation failed (non-fatal): {e}")

    sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2))


# ============================================================
# Comments
# ============================================================

def _extract_aid(source: str) -> str | None:
    """Extract B站 video ID (av or BV) from a full URL **or a bare ID**.

    旧版正则要求 ID 前面必须有 "/"，裸 BV 号（`BV1DtQABpEJH`）会被判为 None。
    工具入参允许裸 ID（normalize_source 会转成完整 URL），但 fetch_comments 等函数
    可能被直接调用，不能依赖上层一定已经 normalize。先 fullmatch，再 fallback 搜索。
    """
    s = (source or "").strip()
    if not s:
        return None
    if re.fullmatch(r"(av\d+|BV[\w=]+)", s, re.I):
        return s
    m = re.search(r"(?:video/)?(av\d+|BV[\w=]+)", s, re.I)
    return m.group(1) if m else None


def _bv_to_av(bv: str) -> str | None:
    """Convert BV ID to av ID via API."""
    cookies = {"Cookie": ""}
    data = _call_api(f"https://api.bilibili.com/x/web-interface/view?bvid={bv}")
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        return f'av{data["data"].get("aid", "")}'
    return None


def _call_api(url: str, cookies_file: str = "") -> dict | None:
    import urllib.request
    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com"}
    if cookies_file:
        headers["Cookie"] = _read_cookies_for_request(cookies_file)
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def _parse_api_comment(node: dict, level: int = 0, max_depth: int = 3,
                       with_sub_comments: bool = True) -> dict | None:
    if not isinstance(node, dict):
        return None
    comment = {
        "rpid": str(node.get("rpid") or node.get("id", "")),
        "username": (node.get("member") or {}).get("uname", ""),
        "content": (node.get("content") or {}).get("message", ""),
        "like_count": node.get("like", 0),
        "ctime": node.get("ctime", 0),
        "level": level,
        "replies": [],
    }
    # ⭐ 内联 replies 受 with_sub_comments 控制。
    # /x/v2/reply 会把第一层子评论直接塞在每条评论的 replies 字段里，
    # 以前这里无条件递归，导致 withSubComments:false 仍然拿到二级评论。
    if with_sub_comments and level < max_depth:
        for reply in (node.get("replies") or []):
            if isinstance(reply, dict):
                parsed = _parse_api_comment(reply, level + 1, max_depth,
                                            with_sub_comments=with_sub_comments)
                if parsed:
                    comment["replies"].append(parsed)
    return comment


def fetch_comments_via_api(source: str, cookies_file: str = "", limit: int = 50,
                           with_sub_comments: bool = True) -> list[dict]:
    aid = _extract_aid(source)
    if not aid:
        return []
    if aid.upper().startswith("BV"):
        av = _bv_to_av(aid)
        if av:
            aid = av
    oid_match = re.search(r"av(\d+)", aid)
    if not oid_match:
        return []
    oid = oid_match.group(1)
    # 用 /x/v2/reply 而不是已废弃的 medialist/content：
    # 实测 medialist 返回非 JSON（code=None），reply 接口正常且无需 WBI 签名。
    # sort=2 = 按热度（与 adapters/bilibili.py 一致）；单页上限 20，需分页。
    # _parse_api_comment 取的是 member.uname / content.message，本就匹配 reply 的形状。
    #
    # 关键坑：接口在空页/末页会把 "replies" 字段置为 null（键存在、值为 None）。
    # 此时 .get("replies", []) 拿不到默认值，返回 None，后面 for 循环就炸。
    # 必须用 `or []` 而不能靠 .get 的默认值。
    comments: list[dict] = []
    pn, ps = 1, 20
    while len(comments) < limit:
        want = min(ps, limit - len(comments))
        data = _call_api(
            f"https://api.bilibili.com/x/v2/reply?type=1&oid={oid}&sort=2&pn={pn}&ps={want}",
            cookies_file)
        body = data.get("data") if isinstance(data, dict) else None
        replies = (body or {}).get("replies") or []
        for reply in replies:
            parsed = _parse_api_comment(reply, with_sub_comments=with_sub_comments)
            if parsed:
                comments.append(parsed)
        if not replies or len(comments) >= limit:
            break
        pn += 1
    return comments[:limit]


def fetch_comments_via_ytdlp(source: str, cookies_file: str = "") -> list[dict]:
    opts = {
        "quiet": True, "no_warnings": True, "logger": QuietLogger(),
        "extract_comments": True, "noplaylist": True, "max_comments": 48,
        "http_headers": {"Origin": "https://www.bilibili.com", "Referer": source},
    }
    if cookies_file:
        opts["cookiefile"] = cookies_file
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(source, download=False)
    comments = []
    for item in (info.get("comments") if isinstance(info, dict) else []):
        if isinstance(item, dict):
            comments.append({
                "rpid": str(item.get("id", "")),
                "username": item.get("author") or item.get("user", {}).get("name", ""),
                "content": item.get("text", ""),
                "like_count": item.get("like_count", 0),
                "ctime": item.get("timestamp", 0),
                "level": 0,
                "replies": [],
            })
    return comments


def fetch_comments(source: str, cookies_file: str = "", limit: int = 50,
                   with_sub_comments: bool = True) -> list[dict]:
    try:
        comments = fetch_comments_via_api(source, cookies_file, limit,
                                          with_sub_comments=with_sub_comments)
        if comments:
            return comments[:limit]
    except Exception:
        pass
    try:
        comments = fetch_comments_via_ytdlp(source, cookies_file)
        if comments:
            return comments[:limit]
    except Exception:
        pass
    return []


# ============================================================
# Platform helpers
# ============================================================

def normalize_source(source: str, page: int = 0) -> str:
    """Normalize a B站 video source to full URL."""
    s = (source or "").strip()
    if not s:
        return ""
    if s.startswith("http"):
        base = s.split("?")[0]
        if page and page > 1:
            sep = "&" if "?" in base else "?"
            return f"{base}{sep}p={page}"
        return s.replace("?&", "?")
    if re.fullmatch(r"(av\d+|BV[\w=]+)", s, re.I):
        base = f"https://www.bilibili.com/video/{s}"
        return f"{base}?p={page}" if page and page > 1 else base
    if re.fullmatch(r"\d{10,}", s):
        base = f"https://www.xiaohongshu.com/explore/{s}"
        return base
    return s


def normalize_whisper_device(device_preference: str) -> str:
    pref = device_preference.strip().lower()
    if pref == "cuda":
        return "cuda"
    return pref


def detect_nvidia_gpu() -> bool:
    try:
        import subprocess
        result = subprocess.run(["nvidia-smi"], capture_output=True, text=True, timeout=10)
        return result.returncode == 0
    except Exception:
        return False


def truncate_text(text: str, max_length: int) -> str:
    if not text or not max_length:
        return text or ""
    return text if len(text) <= max_length else text[:max_length] + "…"


def write_json(file_path: Path, payload: Any) -> None:
    file_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


# ============================================================
# Xiaohongshu helpers
# ============================================================

def _is_xiaohongshu_url(source: str) -> bool:
    return "xiaohongshu.com" in (source or "")


def _extract_xhs_note_id(text: str) -> str | None:
    for pat in [r"xiaohongshu\.com/explore/([a-f0-9]+)", r"xiaohongshu\.com/discovery/item/([a-f0-9]+)", r"xhslink\.com/[A-Za-z0-9]+"]:
        m = re.search(pat, text)
        if m:
            return m.group(1)
    m = re.fullmatch(r"[a-f0-9]{24}", text)
    return text if m else None


def _parse_xhs_initial_state(html: str) -> dict[str, Any] | None:
    m = re.search(r'<script>window\.__INITIAL_STATE__\s*=\s*({.*?});</script>', html, re.DOTALL)
    if not m:
        m = re.search(r'window\.__INITIAL_STATE__\s*=\s*({.*?});?\s*</script>', html, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    return None


def _find_xhs_in_dict(d: dict, target_id: str) -> dict | None:
    if not isinstance(d, dict):
        return None
    for k, v in d.items():
        if k == "noteDetail" and isinstance(v, dict):
            return v
        result = _find_xhs_in_dict(v, target_id) if isinstance(v, (dict, str)) else None
        if result:
            return result
    return None


def _fetch_xiaohongshu_note(source: str, output_dir: Path, cookies_file: str) -> dict[str, Any]:
    """Fetch a Xiaohongshu note detail via Scrapling + __INITIAL_STATE__ parsing."""
    note_id = _extract_xhs_note_id(source)
    if not note_id:
        return {"ok": False, "error": "invalid xhs url"}

    try:
        from scrapling.fetchers import StealthyFetcher
        StealthyFetcher.adaptive = True
        page = StealthyFetcher.fetch(f"https://www.xiaohongshu.com/explore/{note_id}", headless=True, network_idle=True)
        if not page.html_content:
            return {"ok": False, "error": "failed to fetch xhs page", "hint": "may need login"}
        html = page.html_content
    except Exception as e:
        return {"ok": False, "error": str(e), "hint": "Scrapling failed"}

    state = _parse_xhs_initial_state(html)
    if state:
        note = _find_xhs_in_dict(state, note_id) or state.get("note", {})
        if note:
            return {
                "ok": True, "_xhs": True, "platform": "xhs", "item_id": note_id,
                "title": note.get("title", ""),
                "description": note.get("desc", ""),
                "author": note.get("user", {}).get("nickname", ""),
                "images": note.get("imageList", []) or note.get("images", []),
                "note_type": note.get("type", ""),
                "interact_info": note.get("interactInfo", {}),
                "url": source, "outputDir": str(output_dir),
            }

    return {"ok": True, "_xhs": True, "platform": "xhs", "item_id": note_id,
            "title": "", "description": "(需要登录)", "url": source, "outputDir": str(output_dir)}


# ============================================================
# Cookies CLI
# ============================================================

def log_msg(msg: str):
    print(msg, file=sys.stderr, flush=True)


def _handle_cookies_cli(args: argparse.Namespace) -> int:
    """Handle cookies management commands.

    ⚠️ 这段在 v1 里整段是**坏死代码**（迁移时发现）：调用了 CookieStore 上
    根本不存在的方法 —— `CookiesStore`（类名多一个 s）、`store.list()`、
    `store.remove()`、`store.import_netscape()`、`store.extract_from_browser()`、
    `store.ensure_dirs()`、`playwright_login.run_login` 全都不存在。
    真实接口：`CookieStore` / `list_platforms()` / `delete()` /
    `import_netscape_cookies_txt()` / `extract_platform_cookies()` /
    `playwright_login.do_login()`。
    后果是 Cookies 面板的五个按钮（列出/清除/导入/提取/登录）全部报错。
    """
    from cookies_store import (
        CookieStore, CookieBundle,
        import_netscape_cookies_txt, extract_platform_cookies,
    )
    store = CookieStore(args.cookies_dir)
    log_msg(f"cookies dir: {store.cookies_dir}")
    log_msg(f"cookies files: {list(store.cookies_dir.iterdir()) if store.cookies_dir.exists() else '(empty)'}")

    # listLogins —— 前端读的是 logins 字段
    if args.list_logins:
        logins = []
        for platform in store.list_platforms():
            try:
                from playwright_login import check_login_status
                logins.append(check_login_status(platform, store.cookies_dir))
            except Exception as e:
                logins.append({"platform": platform, "logged_in": True, "error": str(e)})
        output = {"action": "list", "cookies_dir": str(store.cookies_dir), "logins": logins}
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    # importCookies
    if args.import_cookies:
        parts = args.import_cookies.split(":", 1)
        if len(parts) != 2:
            print(json.dumps({"ok": False, "error": "格式错误，应为 <platform>:<path>"}))
            return 1
        platform, path = parts
        try:
            entries = import_netscape_cookies_txt(path)
            if not entries:
                print(json.dumps({"ok": False, "error": f"未能从 {path} 解析出 cookies"}))
                return 0
            bundle = CookieBundle(platform=platform, cookies=entries, source=f"netscape:{path}")
            store.save(bundle)
            print(json.dumps({"ok": True, "action": "import", "platform": platform,
                              "count": len(entries)}))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
        return 0

    # extractCookies
    if args.extract_cookies:
        parts = args.extract_cookies.split(":", 1)
        if len(parts) != 2:
            print(json.dumps({"ok": False, "error": "格式错误，应为 <platform>:<browser>"}))
            return 1
        platform, browser = parts
        try:
            entries = extract_platform_cookies(platform, browser=browser)
            if not entries:
                print(json.dumps({"ok": False,
                                  "error": f"从 {browser} 未取到 {platform} 的 cookies（未登录或浏览器未安装）"}))
                return 0
            bundle = CookieBundle(platform=platform, cookies=entries, source=f"browser:{browser}")
            store.save(bundle)
            print(json.dumps({"ok": True, "action": "extract", "platform": platform,
                              "browser": browser, "count": len(entries)}))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
        return 0

    # login（扫码）
    if args.login:
        try:
            from playwright_login import do_login
            bundle = do_login(args.login, store.cookies_dir, timeout_seconds=args.login_timeout)
            print(json.dumps({"ok": True, "action": "login", "platform": args.login,
                              "count": len(bundle.cookies)}))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
        return 0


    # logout
    if args.logout:
        try:
            removed = store.delete(args.logout)
            print(json.dumps({"ok": True, "action": "logout", "platform": args.logout,
                              "removed": removed}))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
        return 0

    return 0


# ============================================================
# Multi-platform dispatch
# ============================================================

def _safe_filename(name: str, maxlen: int = 80) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|]', "_", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:maxlen] if cleaned else "untitled"


def _run_via_adapter(args: argparse.Namespace, source: str, output_dir: Path) -> int:
    """Dispatch to platform adapter (non-B站 platforms)."""
    if not _ADAPTERS_AVAILABLE:
        log("adapters not available")
        print(json.dumps({"ok": False, "error": "adapters not available"}, ensure_ascii=False))
        return 1

    platform_id = args.platform
    if platform_id == "auto" or not platform_id:
        platform_id = detect_platform(source)
        if not platform_id:
            log("cannot detect platform from URL")
            print(json.dumps({"ok": False, "error": "cannot detect platform"}, ensure_ascii=False))
            return 1

    adapter = get_adapter(platform_id, cookies_file=args.cookies_file, cookies_dir=args.cookies_dir)
    if not adapter:
        log(f"no adapter for platform {platform_id}")
        print(json.dumps({"ok": False, "error": f"no adapter for {platform_id}"}))
        return 1

    # Determine mode
    is_search = args.mode == "search"
    is_batch = args.mode == "batch"

    if is_search or is_batch:
        keyword = args.search_keyword or source
        results = adapter.search(keyword, limit=args.search_limit, sort=args.search_sort, page=max(1, args.page))
        if is_batch:
            summaries = []
            for item in results[:args.search_limit]:
                try:
                    detail = adapter.get_item(item.url)
                    summaries.append(detail)
                except Exception as e:
                    summaries.append({"ok": False, "error": str(e), "item_id": item.item_id})
            output = {"mode": "batch", "platform": platform_id, "keyword": keyword, "total": len(summaries), "results": summaries}
        else:
            output = {"mode": "search", "platform": platform_id, "keyword": keyword, "total": len(results),
                      "results": [r.to_dict() for r in results[:args.search_limit]]}
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    # Single item
    item = adapter.get_item(source, page=args.page)
    if not isinstance(item, dict):
        item = {"ok": True, "platform": platform_id, "item_id": "", "url": source}

    # Comments
    if args.with_comments and hasattr(adapter, 'get_comments'):
        try:
            # ⭐ with_sub_comments 要显式传下去。adapter 侧签名是
            # get_comments(source, *, limit, max_depth, with_sub_comments)，
            # 以前这里只传了 limit，参数在 argparse 解析完就丢了——
            # 表现为工具侧传 withSubComments:false 被静默忽略、二级评论永远拉。
            comments = adapter.get_comments(
                source,
                limit=args.comment_limit,
                with_sub_comments=args.with_sub_comments,
            )
            item["comments"] = [c.to_dict() for c in comments[:args.comment_limit]]
        except NotImplementedError:
            pass

    # Creator
    if args.with_creator and hasattr(adapter, 'get_creator'):
        creator_id = item.get("uploader_id", "") or item.get("author", "")
        if creator_id:
            try:
                item["creator"] = adapter.get_creator(creator_id)
            except NotImplementedError:
                pass

    item["platform"] = platform_id
    item["source"] = source

    # ⭐ v0.6.27（P1）：非 B 站平台（笔记 / 文章 / 回答 / 帖子）也要产出统一的"文本层"。
    #   以前只有视频侧写 text.txt，文章类正文只躺在 result 的 description / content 里 ——
    #   于是"素材 → 文本 → 总结"这条链一到文章就断：没 text.txt、没锚点、没产物可读。
    #   这里取最长的可用正文字段落 text.txt，并把锚点类型标成 article（文章用字符/小节坐标，不是时间轴）。
    article_text = ""
    for key in ("transcriptText", "content", "description", "text", "body", "answer"):
        val = item.get(key)
        if isinstance(val, str) and val.strip() and len(val.strip()) > len(article_text):
            article_text = val.strip()
    if article_text:
        if not item.get("transcriptText"):
            item["transcriptText"] = article_text
        text_path = output_dir / "text.txt"
        text_path.write_text(article_text, encoding="utf-8")
        item["transcriptTextPath"] = str(text_path)
        item["textKind"] = "article"
        item["textChars"] = len(article_text)
        log(f"article text layer written: {len(article_text)} chars")

    # ⭐ 2026-09-26：小红书视频笔记 —— 把原片下下来，接上帧分析链路。
    #   地址在 item["video"]["info"]["media"]["stream"] 里（key 是 EF4/EF5 这种编码），
    #   每路有 masterUrl（带 sign+t 的签名地址）+ backupUrls；取 size 最大的那路。
    #   ⚠️ 必须带 Referer: https://www.xiaohongshu.com/，否则 CDN 直接 403（实测）。
    #   文件名固定 source_video.mp4 —— intake_shots 认的就是这个名字。
    if getattr(args, "download_video", False):
        try:
            import urllib.request as _ur
            _vinfo = (item.get("video") or {}).get("info") or {}
            _streams = (_vinfo.get("media") or {}).get("stream") or {}
            _cands = []
            for _codec, _arr in _streams.items():
                for _st in (_arr or []):
                    if _st.get("masterUrl"):
                        _cands.append((int(_st.get("size") or 0), _st))
            _cands.sort(key=lambda x: -x[0])
            if _cands:
                _size, _best = _cands[0]
                _dst = output_dir / "source_video.mp4"
                _req = _ur.Request(_best["masterUrl"], headers={
                    "Referer": "https://www.xiaohongshu.com/",
                    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                                   "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"),
                })
                with _ur.urlopen(_req, timeout=120) as _resp:
                    _data = _resp.read()
                _dst.write_bytes(_data)
                item["sourceVideoPath"] = str(_dst)
                item["sourceVideoBytes"] = len(_data)
                log("xhs 原片已下载: %d 字节 -> %s" % (len(_data), _dst.name))
            else:
                log("没有可下载的视频流（图文 / 文字笔记）")
        except Exception as _e:
            item["sourceVideoError"] = str(_e)[:200]
            log("xhs 原片下载失败: %s" % _e)
    item["outputDir"] = str(output_dir)
    write_json(output_dir / "result.json", item)

    visual_result = None

    print(json.dumps(item, ensure_ascii=False, indent=2))
    return 0


# ============================================================
# Main
# ============================================================

def _run_download_video(args: argparse.Namespace, output_dir: Path) -> int:
    """把原片下到 output_dir（帧分析用），写 source_video.<ext>。

    ⭐ 2026-09-26：旧视觉链路里的下载代码随 frame_extractor 一起删了，
    但“帧分析需要本地原片”这件事还在 —— 所以单独立一个动作，
    由工具 intake_shots 在开关打开（shotsDownloadVideo）、槽位里又没有原片时调它。

    选择刻意简单：不碰 Node 权限模型（下载跟采集一样在 python 子进程里做），
    产物就一个文件，路径写回 stdout 的 JSON。
    """
    import yt_dlp

    source = normalize_source(args.source, args.page) if args.source else ""
    if not source:
        sys.stdout.write(json.dumps({"ok": False, "error": "缺少 --source"}, ensure_ascii=False))
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        from bilibili_pipeline import build_common_ydl_opts
        opts = build_common_ydl_opts(args.cookies_file, source)
    except Exception:
        opts = {
            "noplaylist": True, "quiet": True, "no_warnings": True,
            "http_headers": {"Referer": source, "User-Agent": "Mozilla/5.0"},
        }
    opts.update({
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
        "outtmpl": str(output_dir / "source_video.%(ext)s"),
        "merge_output_format": "mp4",
    })
    if args.cookies_file:
        opts["cookiefile"] = args.cookies_file

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([source])
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "error": f"下载失败：{type(e).__name__}: {e}"}, ensure_ascii=False))
        return 1

    found = ""
    for suffix in (".mp4", ".mkv", ".webm", ".mov"):
        p = output_dir / f"source_video{suffix}"
        if p.exists():
            found = str(p)
            break
    sys.stdout.write(json.dumps({
        "ok": bool(found), "videoPath": found, "outputDir": str(output_dir),
    }, ensure_ascii=False))
    return 0 if found else 1

def main() -> int:
    args = parse_args()

    # Resolve output directory early (used by batch and single modes)
    output_dir = Path(args.output_dir).resolve() if args.output_dir else Path.cwd() / "output"
    output_dir = output_dir.resolve()

    # --- Health / Routing ---
    if args.action == "health":
        report = run_health_check()
        sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    if args.action == "routing-status":
        status = get_routing_status()
        sys.stdout.write(json.dumps(status, ensure_ascii=False, indent=2))
        return 0
    if args.action == "download-video":
        return _run_download_video(args, output_dir)

    # --- Cookies management ---
    if args.list_logins or args.login or args.logout or args.import_cookies or args.extract_cookies:
        return _handle_cookies_cli(args)

    # --- Search mode ---
    if args.mode == "search":
        # ⭐ v0.6.20：搜索模式下 args.platform 之前完全没被读。
        #   卡片选了小红书/微博/知乎，后端照样走 B 站 search_videos 返回 B 站结果，
        #   而卡片状态条写「正在搜索 小红书」——参数在 http/intake.js 收得到，
        #   runtime.js 也推了 --platform，是 main 分发的这一支没读。
        #   和单视频模式（L1011 会读 platform）不一致。
        #   非 bilibili 的搜索改走 adapter 分派。
        if args.platform and args.platform not in ("bilibili", "auto"):
            return _run_via_adapter(args, args.search_keyword or args.source, output_dir)
        keyword = args.search_keyword or args.source
        results = search_videos(keyword=keyword, sort=args.search_sort, limit=args.search_limit, cookies_file=args.cookies_file)
        output = {
            "mode": "search", "keyword": keyword, "sort": args.search_sort,
            "limit": args.search_limit, "total": len(results),
            "results": [{"bv_id": r["bv_id"], "title": r["title"], "author": r["author"],
                         "play_count": r["play_count"], "duration": r["duration"],
                         "pub_date": r["pub_date"], "url": r["url"]} for r in results],
        }
        sys.stdout.write(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    # --- Batch mode ---
    if args.mode == "batch":
        # ⭐ 同上：batch 底层复用的是搜索，一并修，否则两条路径又不一致。
        if args.platform and args.platform not in ("bilibili", "auto"):
            return _run_via_adapter(args, args.search_keyword or args.source, output_dir)
        # Reuse search + _run_single for each result
        from bilibili_pipeline import build_common_ydl_opts
        keyword = args.search_keyword or args.source
        results = search_videos(keyword=keyword, sort=args.search_sort, limit=args.search_limit, cookies_file=args.cookies_file)
        if not results:
            output = {"mode": "batch", "keyword": keyword, "total": 0, "results": []}
            sys.stdout.write(json.dumps(output, ensure_ascii=False, indent=2))
            return 0

        summaries = []
        for idx, item in enumerate(results):
            log(f"[{idx + 1}/{len(results)}] fetching: {item.get('title', '')[:60]}")
            try:
                from bilibili_pipeline import (
                    build_metadata, download_audio, download_subtitles,
                    extract_info_via_scrapling, transcribe_audio,
                )
                from subtitle_parser import choose_subtitle_text

                tmp_source = item.get("url", "")
                tmp_output = output_dir / _safe_filename(f"{idx + 1:04d}_{item.get('title', 'untitled')}")
                tmp_output.mkdir(exist_ok=True)

                info = extract_info_via_scrapling(tmp_source)
                meta = build_metadata(info, tmp_source)
                subs = download_subtitles(tmp_source, tmp_output, args.subtitle_languages, args.cookies_file)
                transcript = choose_subtitle_text(subs, args.subtitle_languages)
                if not args.no_audio and (args.force_transcribe or not transcript):
                    audio = download_audio(tmp_source, tmp_output, args.audio_format, args.cookies_file)
                    transcript, dev, _segs = transcribe_audio(audio, args.whisper_model, args.whisper_language, args.whisper_device, getattr(args, "whisper_cpu_threads", 0))

                # Write transcript text to file
                if transcript:
                    (tmp_output / "text.txt").write_text(transcript, encoding="utf-8")

                summaries.append({
                    "bv_id": item.get("bv_id", ""), "title": meta.get("title", ""),
                    "uploader": meta.get("uploader", ""), "duration": meta.get("duration"),
                    "transcriptSource": "whisper" if transcript else "none",
                    "transcriptText": transcript or "",
                })
            except Exception as e:
                summaries.append({"bv_id": item.get("bv_id", ""), "title": item.get("title", ""), "error": str(e)[:100]})

        output = {"mode": "batch", "keyword": keyword, "total": len(summaries), "results": summaries}
        sys.stdout.write(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    # --- Single mode ---
    source = normalize_source(args.source, args.page)
    if not source:
        print(json.dumps({"ok": False, "error": "source required"}, ensure_ascii=False))
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)

    # Auto-detect platform
    platform_id = args.platform
    if platform_id == "auto" or not platform_id:
        if _is_xiaohongshu_url(source):
            platform_id = "xhs"
        elif _ADAPTERS_AVAILABLE:
            detected = detect_platform(source)
            if detected:
                platform_id = detected

    # Dispatch
    if platform_id and platform_id != "auto" and platform_id != "bilibili":
        return _run_via_adapter(args, source, output_dir)

    # B站 pipeline
    _run_single(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CollectorError as exc:
        log(str(exc))
        raise SystemExit(2)
    except Exception as exc:
        log(f"unexpected error: {exc}")
        raise SystemExit(3)