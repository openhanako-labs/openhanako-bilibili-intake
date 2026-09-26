"""Bilibili video pipeline — Scrapling metadata, yt-dlp audio/subtitles, Whisper transcription.

Extracted from collector.py for maintainability.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import yt_dlp

from subtitle_parser import (
    choose_subtitle_text,
    find_subtitle_files,
    subtitle_priority_key,
)


# ── Quiet yt-dlp logger ──

class QuietLogger:
    def debug(self, msg: str) -> None:
        if msg and "[debug]" in msg.lower():
            print(f"[bilibili_pipeline] {msg}", file=sys.stderr, flush=True)

    def warning(self, msg: str) -> None:
        if msg:
            print(f"[bilibili_pipeline] {msg}", file=sys.stderr, flush=True)

    def error(self, msg: str) -> None:
        if msg:
            print(f"[bilibili_pipeline] {msg}", file=sys.stderr, flush=True)


# ── Metadata extraction ──


def extract_info_via_scrapling(source: str) -> dict[str, Any]:
    """Extract video metadata using Scrapling DynamicFetcher."""
    from scrapling import DynamicFetcher

    log(f"extracting metadata via Scrapling: {source}")
    scrapling_data: dict[str, Any] = {}
    try:
        fetcher = DynamicFetcher(
            browser_type="chrome",
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            headers={"Origin": "https://www.bilibili.com", "Referer": source},
        )
        r = fetcher.fetch(source)

        title = r.css("title")[0].text.strip() if r.css("title") else ""
        meta_desc = _get_meta_attr(r, 'meta[itemprop="description"]', "content")
        parsed = _parse_bili_meta(meta_desc)
        keywords_str = _get_meta_attr(r, 'meta[itemprop="keywords"]', "content")
        tags = [k.strip() for k in keywords_str.split(",") if k.strip()] if keywords_str else []
        cover = _get_meta_attr(r, 'meta[itemprop="image"]', "content")
        og_desc = _get_meta_attr(r, 'meta[property="og:description"]', "content") or parsed.get("description", "")

        scrapling_data = {
            "title": title, "description": og_desc,
            "uploader": parsed.get("author", ""), "tags": tags,
            "thumbnail": cover or "",
            "view_count": parsed.get("view_count"),
            "like_count": parsed.get("like_count"),
            "comment_count": parsed.get("reply_count"),
            "_scrapling": True, "_meta_description": meta_desc,
        }
        log(f"Scrapling extracted: title={title[:50]}, author={parsed.get('author', '')}")
    except Exception as e:
        log(f"Scrapling extraction failed: {e}, falling back to yt-dlp")
        return extract_info_via_ytdlp(source, "")

    # Supplement duration and formats via yt-dlp
    try:
        opts = build_common_ydl_opts("", source)
        opts["quiet"] = True
        opts["no_warnings"] = True
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl_info = ydl.extract_info(source, download=False)
        if isinstance(ydl_info, dict):
            scrapling_data["duration"] = ydl_info.get("duration")
            scrapling_data["duration_ms"] = ydl_info.get("duration_ms")
            scrapling_data["formats"] = ydl_info.get("formats", [])
            scrapling_data["subtitles"] = ydl_info.get("subtitles", {})
            scrapling_data["automatic_captions"] = ydl_info.get("automatic_captions", {})
            log(f"yt-dlp supplemented: duration={scrapling_data.get('duration')}s")
    except Exception as e:
        log(f"yt-dlp supplement failed: {e}, continuing with Scrapling-only data")

    return scrapling_data


def _get_meta_attr(r, selector: str, attr: str) -> str | None:
    els = r.css(selector)
    return els[0].attrib.get(attr) if els else None


def _parse_bili_meta(desc: str | None) -> dict[str, Any]:
    """Parse Bilibili structured meta description."""
    result: dict[str, Any] = {}
    if not desc:
        return result

    pat_stat = r"视频播放量\s*([\d,]+)、弹幕量\s*([\d,]+)、点赞数\s*([\d,]+)、投硬币枚数\s*([\d,]+)、收藏人数\s*([\d,]+)、转发人数\s*([\d,]+)"
    sm = re.search(pat_stat, desc)
    if sm:
        result["view_count"] = int(sm.group(1).replace(",", ""))
        result["danmaku"] = int(sm.group(2).replace(",", ""))
        result["like_count"] = int(sm.group(3).replace(",", ""))
        result["coin_count"] = int(sm.group(4).replace(",", ""))
        result["favorite_count"] = int(sm.group(5).replace(",", ""))
        result["share_count"] = int(sm.group(6).replace(",", ""))

    am = re.search(r"视频作者\s*([^,，]+)", desc)
    if am:
        result["author"] = am.group(1).strip()

    dm = re.match(r"^([^,，]+)[,，]", desc)
    if dm:
        result["description"] = dm.group(1).strip()

    bm = re.search(r"作者简介\s*([^，,]+)", desc)
    if bm:
        result["author_bio"] = bm.group(1).strip()

    return result


def extract_info_via_ytdlp(source: str, cookies_file: str) -> dict[str, Any]:
    """Extract metadata via yt-dlp (fallback)."""
    opts = build_common_ydl_opts(cookies_file, source)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(source, download=False)
    if not isinstance(info, dict):
        raise RuntimeError("yt-dlp returned non-dict info.")
    log(f"yt-dlp fallback extracted: title={info.get('title','')[:50]}")
    return info


def build_common_ydl_opts(cookies_file: str, source: str = "") -> dict[str, Any]:
    opts: dict[str, Any] = {
        "noplaylist": True, "quiet": True, "no_warnings": True,
        "logger": QuietLogger(), "restrictfilenames": False, "consoletitle": False,
        # ⭐ 连接失败必须快速报错。B 站音频 CDN（如 mcdn.bilivideo.cn:8082）
        # 在某些网络下根本连不上，yt-dlp 默认会默默重试十几轮、
        # 卡上两分钟才抛异常。把重试压到 2 次、socket 超时 15s，
        # 配合 _run_single 里 Step 4 的 try/except，音频失败在十秒内就能降级。
        "socket_timeout": 15,
        "retries": 2,
        "fragment_retries": 2,
        "extractor_retries": 2,
        "http_headers": {
            "Origin": "https://www.bilibili.com",
            "Referer": source or "https://www.bilibili.com",
        },
    }
    if cookies_file:
        # yt-dlp 会把本次会话收到的新 cookie **写回** cookiefile。
        # 直接指用户那一份的话，一次采集就会把 SESSDATA 换成匿名 cookie，
        # 之后评论永远卡在未登录的 3 条上限。这里先拷一份到 temp，只读原件。
        opts["cookiefile"] = _read_only_cookies_copy(cookies_file)
    return opts


_cookies_copy_cache: dict[str, str] = {}


def _read_only_cookies_copy(cookies_file: str) -> str:
    """把 cookies 文件拷到 temp，让 yt-dlp 只能写副本。

    按 mtime 失效：用户重新导入 / 重新提取 cookies 后自动重新拷贝。
    """
    src = Path(cookies_file)
    try:
        key = (str(src), src.stat().st_mtime_ns, src.stat().st_size)
    except OSError:
        return cookies_file  # 文件不可读，让 yt-dlp 自己报错
    if key in _cookies_copy_cache:
        return _cookies_copy_cache[key]
    dst = Path(tempfile.gettempdir()) / f"hanako-ck-{os.getpid()}-{int(src.stat().st_mtime_ns)}.txt"
    try:
        shutil.copy2(src, dst)
        # 注意：不要 chmod 只读。yt-dlp 需要往副本写回新 cookie（那就是目的），
        # 只读会让它 Permission denied 直接炸。保护靠的是「写的是副本」而不是权限。
    except Exception:
        return cookies_file
    _cookies_copy_cache[key] = str(dst)
    return str(dst)


def build_metadata(info: dict[str, Any], source: str) -> dict[str, Any]:
    """Build unified metadata dict from Scrapling or yt-dlp info."""
    is_scrapling = info.pop("_scrapling", False)
    parsed_meta = info.pop("_parsed_meta", {})

    if is_scrapling:
        return {
            "id": "", "title": info.get("title") or "",
            "description": info.get("description") or parsed_meta.get("description", ""),
            "uploader": info.get("uploader") or parsed_meta.get("author", ""),
            "channel": info.get("channel") or "",
            "duration": info.get("duration"),
            "webpageUrl": info.get("webpage_url") or source, "originalUrl": source,
            "thumbnail": info.get("thumbnail") or info.get("_cover"),
            "tags": info.get("tags") or [],
            "uploadDate": info.get("upload_date") or parsed_meta.get("_upload_date", ""),
            "viewCount": info.get("view_count") or parsed_meta.get("view_count"),
            "likeCount": info.get("like_count") or parsed_meta.get("like_count"),
            "commentCount": info.get("comment_count") or parsed_meta.get("reply_count"),
            "subtitleLanguages": [], "automaticCaptionLanguages": [],
            "scraplingMetadata": True,
        }

    return {
        "id": info.get("id"), "title": info.get("title"),
        "description": info.get("description") or "",
        "uploader": info.get("uploader") or info.get("channel") or info.get("uploader_id") or "",
        "channel": info.get("channel") or "",
        "duration": info.get("duration"),
        "webpageUrl": info.get("webpage_url") or source, "originalUrl": source,
        "thumbnail": info.get("thumbnail") or "", "tags": info.get("tags") or [],
        "uploadDate": info.get("upload_date") or "",
        "viewCount": info.get("view_count"), "likeCount": info.get("like_count"),
        "commentCount": info.get("comment_count"),
        "subtitleLanguages": sorted((info.get("subtitles") or {}).keys()),
        "automaticCaptionLanguages": sorted((info.get("automatic_captions") or {}).keys()),
    }


# ── Audio streams ──


def build_audio_streams(info: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract audio stream info from yt-dlp formats."""
    formats = info.get("formats") or []
    audio_only: list[dict[str, Any]] = []
    with_audio: list[dict[str, Any]] = []
    for fmt in formats:
        if not isinstance(fmt, dict) or not fmt.get("url"):
            continue
        acodec = fmt.get("acodec")
        vcodec = fmt.get("vcodec")
        if not acodec or acodec == "none":
            continue
        entry = {
            "format_id": fmt.get("format_id"), "format_note": fmt.get("format_note"),
            "ext": fmt.get("ext"), "audio_ext": fmt.get("audio_ext"),
            "protocol": fmt.get("protocol"), "url": fmt.get("url"),
            "abr": fmt.get("abr"), "asr": fmt.get("asr"), "tbr": fmt.get("tbr"),
            "filesize": fmt.get("filesize") or fmt.get("filesize_approx"),
            "language": fmt.get("language"), "acodec": acodec, "vcodec": vcodec,
        }
        with_audio.append(entry)
        if not vcodec or vcodec == "none":
            audio_only.append(entry)

    target = audio_only or with_audio
    target.sort(key=lambda item: ((item.get("abr") or 0), (item.get("tbr") or 0), (item.get("filesize") or 0)), reverse=True)
    return target


# ── Audio download ──


def download_audio(source: str, output_dir: Path, audio_format: str, cookies_file: str) -> Path:
    """Download audio from a Bilibili video."""
    opts = build_common_ydl_opts(cookies_file, source)
    opts.update({
        "format": "bestaudio/best",
        "outtmpl": {"default": str(output_dir / "audio.%(ext)s")},
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": audio_format, "preferredquality": "0"}],
    })
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([source])

    direct_target = output_dir / f"audio.{audio_format}"
    if direct_target.exists():
        return direct_target.resolve()
    candidates = sorted(output_dir.glob("audio.*"))
    for candidate in candidates:
        return candidate.resolve()
    raise RuntimeError("No audio file generated")


# ── Subtitle download ──


def download_subtitles(source: str, output_dir: Path, subtitle_languages: list[str], cookies_file: str) -> list[Path]:
    """Download subtitles for a Bilibili video via yt-dlp."""
    opts = build_common_ydl_opts(cookies_file, source)
    opts.update({
        "skip_download": True, "writesubtitles": True, "writeautomaticsub": True,
        "subtitleslangs": subtitle_languages or ["all"],
        "outtmpl": {"default": str(output_dir / "subtitle.%(ext)s")},
    })
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([source])

    files = [
        p for p in output_dir.iterdir()
        if p.is_file() and p.suffix.lower() in {".srt", ".vtt", ".ass", ".ssa", ".lrc", ".json", ".json3", ".srv3", ".ttml"}
        and p.name.startswith("subtitle")
    ]
    files.sort(key=lambda p: subtitle_priority_key(p, subtitle_languages))
    # Log danmaku
    for d in output_dir.iterdir():
        if d.is_file() and d.suffix.lower() == ".xml" and d.name.startswith("subtitle"):
            print(f"[bilibili_pipeline] danmaku detected: {d.name}", file=sys.stderr)
    return files


# ── Whisper transcription ──


def transcribe_audio(audio_path: Path, model_name: str, language: str, device_preference: str, cpu_threads: Any = 0) -> tuple[str, str, list]:
    """Transcribe audio using Whisper. Returns (text, device_used, segments)。

    ⭐ v0.6.27：把段落一起还回去。以前只回 `"".join(seg.text)` 的纯文本，
    段落级时间轴（start/end）在函数内部就被丢掉了 —— 上层拿不到锚点，
    长视频只能整段截断喂给模型。segments 形如
    [{"start": 0.0, "end": 2.4, "text": "..."}]，由调用方落盘。
    
    ⭐ v0.6.24：优先用 faster-whisper（CTranslate2 后端，速度 4x），
    没装则回退到 openai-whisper。两者 API 不同：
    - openai-whisper: whisper.load_model() → model.transcribe() → result["text"]
    - faster-whisper: WhisperModel() → model.transcribe() → 迭代 segments 拼接
    """
    try:
        from faster_whisper import WhisperModel
        return _transcribe_faster_whisper(audio_path, model_name, language, device_preference, WhisperModel, cpu_threads)
    except ImportError:
        return _transcribe_openai_whisper(audio_path, model_name, language, device_preference)


def _transcribe_faster_whisper(audio_path: Path, model_name: str, language: str, device_preference: str, WhisperModel, cpu_threads: Any = 0) -> tuple[str, str, list]:
    """faster-whisper 实现：CTranslate2 后端，速度 4x。"""
    device = resolve_whisper_device(device_preference)
    model_ref = resolve_whisper_model_reference(model_name)
    
    # faster-whisper 用 compute_type 控制精度：
    # - int8: CPU 最快，质量略有损失
    # - float16: CUDA 默认，质量更好
    compute_type = "int8" if device == "cpu" else "float16"

    # ⭐ v0.6.38：不传 cpu_threads 的话，faster-whisper 默认就吃满所有核 ——
    #   长视频一转写，整台机器就卡住。默认改成“一半的核”，见 resolve_whisper_cpu_threads。
    threads = resolve_whisper_cpu_threads(cpu_threads, device)
    model_kwargs: dict[str, Any] = {"device": device, "compute_type": compute_type}
    if threads > 0:
        model_kwargs["cpu_threads"] = threads

    model = WhisperModel(model_ref, **model_kwargs)
    
    opts: dict[str, Any] = {}
    if language:
        opts["language"] = language
    
    segments, info = model.transcribe(str(audio_path), **opts)
    
    # faster-whisper 返回迭代器，需要拼接
    # ⭐ v0.6.27：拼接的同时把段落留住（时间轴是锚点，不在这里丢掉）
    parts: list[str] = []
    seg_out: list[dict[str, Any]] = []
    for seg in segments:
        piece = (seg.text or "").strip()
        if piece:
            parts.append(piece)
        seg_out.append({
            "start": round(float(seg.start or 0.0), 3),
            "end": round(float(seg.end or 0.0), 3),
            "text": piece,
        })
    return "".join(parts).strip(), device, seg_out


def _transcribe_openai_whisper(audio_path: Path, model_name: str, language: str, device_preference: str) -> tuple[str, str, list]:
    """openai-whisper 实现（回退路径）。"""
    import whisper
    
    device = resolve_whisper_device(device_preference)
    model_ref = resolve_whisper_model_reference(model_name)
    model = whisper.load_model(model_ref, device=device)
    
    opts: dict[str, Any] = {"fp16": device.startswith("cuda")}
    if language:
        opts["language"] = language
    
    result = model.transcribe(str(audio_path), **opts)
    text = result.get("text", "").strip()
    # ⭐ v0.6.27：openai-whisper 本来就返回 result["segments"]，同样留住。
    seg_out = [
        {
            "start": round(float(s.get("start") or 0.0), 3),
            "end": round(float(s.get("end") or 0.0), 3),
            "text": (s.get("text") or "").strip(),
        }
        for s in (result.get("segments") or [])
    ]
    return text, device, seg_out


def resolve_whisper_cpu_threads(preference: Any, device: str) -> int:
    """CPU 跑 Whisper 时用多少线程。

    ⭐ v0.6.38：faster-whisper 的 `cpu_threads` 默认是 **0 = 吃满所有核**。
    以前没传过这个参数，于是一转写整台机器就卡住。现在默认改成“核数一半，最少 1”。

      -1 / "all"  → 不限制（回 0，旧行为）
       0 / "auto" → 自动：核数一半（最少 1）
       N > 0       → 指定线程数

    GPU 路径不用这个参数，直接回 0。
    """
    if device != "cpu":
        return 0
    raw = str(preference).strip().lower() if preference is not None else ""
    if raw in ("", "auto"):
        n = 0
    elif raw == "all":
        n = -1
    else:
        try:
            n = int(float(raw))
        except (TypeError, ValueError):
            n = 0
    if n < 0:
        return 0
    if n > 0:
        return n
    cores = os.cpu_count() or 2
    return max(1, cores // 2)


def resolve_whisper_device(device_preference: str) -> str:
    """Resolve device preference to actual device string."""
    import torch

    pref = device_preference.strip().lower()
    if pref == "cuda":
        if torch.cuda.is_available():
            return "cuda"
        raise RuntimeError("CUDA requested but not available")
    if pref == "cpu":
        return "cpu"
    if pref == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return "cpu"


def resolve_whisper_model_reference(model_name: str) -> str:
    """Return a Whisper-compatible model reference string."""
    m = model_name.strip().lower()
    if m in ("tiny", "base", "small", "medium", "large", "large-v2", "large-v3"):
        return m
    return "base"


# ── Helpers ──


def log(message: str) -> None:
    print(f"[bilibili_pipeline] {message}", file=sys.stderr, flush=True)