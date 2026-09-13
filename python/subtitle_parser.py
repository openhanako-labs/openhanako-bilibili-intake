"""Subtitle parsing utilities for bilibili-intake.

Supports: .srt, .vtt, .json, .json3, .srv3, .ass, .ssa, .xml, .ttml
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


# ── Subtitle file selection ──

_REAL_SUBTITLE_EXTS = {".srt", ".vtt", ".ass", ".ssa", ".lrc", ".json", ".json3", ".srv3", ".ttml"}
_REAL_SUBTITLE_EXTS_LOWER = {e.lower() for e in _REAL_SUBTITLE_EXTS}


def find_subtitle_files(output_dir: Path) -> list[Path]:
    """Find subtitle files in output_dir, excluding danmaku (.xml)."""
    files = [
        p for p in output_dir.iterdir()
        if p.is_file()
        and p.suffix.lower() in _REAL_SUBTITLE_EXTS_LOWER
        and p.name.startswith("subtitle")
    ]
    files.sort(key=lambda p: subtitle_priority_key(p, []))
    return files


def subtitle_priority_key(path: Path, preferred_languages: list[str]) -> tuple[int, int, str]:
    """Sort key: preferred language first, then format quality, then name."""
    name = path.name.lower()
    language_score = len(preferred_languages) + 1
    for index, language in enumerate(preferred_languages):
        token = language.lower()
        if f".{token}." in name or name.startswith(f"{token}.") or token in name:
            language_score = index
            break
    extension_order = {
        ".srt": 0, ".vtt": 1, ".json": 2, ".json3": 3, ".srv3": 4,
        ".ass": 5, ".ssa": 6, ".lrc": 7, ".xml": 8, ".ttml": 9,
    }
    return (language_score, extension_order.get(path.suffix.lower(), 99), name)


def choose_subtitle_text(subtitle_files: list[Path], preferred_languages: list[str]) -> str:
    """Pick the best subtitle file and return its plain text content."""
    ranked = sorted(subtitle_files, key=lambda p: subtitle_priority_key(p, preferred_languages))
    for subtitle_file in ranked:
        text = parse_subtitle_file(subtitle_file)
        if text:
            return text
    return ""


# ── Subtitle parsing ──


def parse_subtitle_file(file_path: Path) -> str:
    """Parse a subtitle file by its extension."""
    suffix = file_path.suffix.lower()
    text = file_path.read_text(encoding="utf-8", errors="ignore")
    if suffix in {".json", ".json3", ".srv3"}:
        return parse_json_subtitle_text(text)
    if suffix in {".ass", ".ssa"}:
        return parse_ass_text(text)
    if suffix in {".xml", ".ttml"}:
        return parse_xml_caption_text(text)
    return strip_timed_text(text)


def parse_json_subtitle_text(raw: str) -> str:
    """Parse JSON subtitle formats (B站 json3, YouTube srv3, generic)."""
    try:
        data: Any = json.loads(raw)
    except json.JSONDecodeError:
        return strip_timed_text(raw)

    lines: list[str] = []
    if isinstance(data, dict):
        body = data.get("body")
        if isinstance(body, list):
            for item in body:
                if isinstance(item, dict):
                    lines.append(str(item.get("content") or item.get("text") or ""))
        events = data.get("events")
        if isinstance(events, list):
            for event in events:
                if not isinstance(event, dict):
                    continue
                segs = event.get("segs") or []
                for seg in segs:
                    if isinstance(seg, dict):
                        lines.append(str(seg.get("utf8") or seg.get("text") or ""))
        segments = data.get("segments")
        if isinstance(segments, list):
            for item in segments:
                if isinstance(item, dict):
                    lines.append(str(item.get("text") or item.get("content") or ""))
    return normalize_plain_text("\n".join(lines))


def parse_ass_text(raw: str) -> str:
    """Parse ASS/SSA subtitle format."""
    lines: list[str] = []
    for line in raw.splitlines():
        if not line.startswith("Dialogue:"):
            continue
        parts = line.split(",", 9)
        if len(parts) == 10:
            lines.append(parts[-1])
    return normalize_plain_text("\n".join(lines))


def parse_xml_caption_text(raw: str) -> str:
    """Parse XML/TTML caption format."""
    matches = re.findall(r">([^<]+)<", raw)
    return normalize_plain_text("\n".join(matches))


def strip_timed_text(raw: str) -> str:
    """Strip timing markers from SRT/VTT format, keeping only text."""
    cleaned_lines: list[str] = []
    for line in raw.splitlines():
        candidate = line.strip().replace("\ufeff", "")
        if not candidate:
            continue
        if candidate.upper() in {"WEBVTT", "STYLE", "NOTE"}:
            continue
        if re.fullmatch(r"\d+", candidate):
            continue
        if re.search(r"\d{1,2}:\d{2}:\d{2}[\.,]\d{2,3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[\.,]\d{2,3}", candidate):
            continue
        if re.search(r"\d{1,2}:\d{2}[\.,]\d{2,3}\s+-->\s+\d{1,2}:\d{2}[\.,]\d{2,3}", candidate):
            continue
        if candidate.startswith(("Kind:", "Language:", "X-TIMESTAMP-MAP")):
            continue
        cleaned_lines.append(candidate)
    return normalize_plain_text("\n".join(cleaned_lines))


def normalize_plain_text(raw: str) -> str:
    """Normalize plain text: strip HTML/ASS tags, deduplicate lines."""
    lines: list[str] = []
    previous = ""
    for line in str(raw).splitlines():
        candidate = line.replace("\\N", " ")
        candidate = re.sub(r"<[^>]+>", " ", candidate)
        candidate = re.sub(r"\{[^}]+\}", " ", candidate)
        candidate = re.sub(r"\s+", " ", candidate).strip()
        if not candidate:
            continue
        if candidate == previous:
            continue
        previous = candidate
        lines.append(candidate)
    return "\n".join(lines)