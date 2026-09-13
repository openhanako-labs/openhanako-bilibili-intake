#!/usr/bin/env python3
"""YouTube adapter for Scrapling — extracts metadata from YouTube pages.

This file is a standalone adapter. It can be imported into collector.py
or used independently for YouTube content intake.
"""
from __future__ import annotations

import json
import re
import sys
from typing import Any


def extract_youtube_metadata(video_id: str, cookies_file: str = "") -> dict[str, Any]:
    """Extract YouTube video metadata using Scrapling DynamicFetcher.

    YouTube uses JSON-LD structured data embedded in the page, which
    Scrapling can parse reliably.
    """
    from scrapling import DynamicFetcher

    url = f"https://www.youtube.com/watch?v={video_id}"
    log_msg(f"extracting YouTube metadata: {url}")

    try:
        fetcher = DynamicFetcher(
            browser_type="chrome",
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        )
        r = fetcher.fetch(url)

        # 1. Title from <title> tag
        title = r.css("title")[0].text.strip() if r.css("title") else ""
        # Clean up YouTube suffix: " - YouTube"
        title = re.sub(r"\s*[-–—]\s*YouTube\s*$", "", title).strip()

        # 2. JSON-LD structured data (rich metadata)
        json_ld_scripts = r.css("script[type='application/ld+json']")
        metadata = _parse_json_ld(json_ld_scripts)

        # 3. Meta tags as fallback
        if not metadata:
            meta_desc = _get_meta_attr(r, 'meta[name="description"]', "content")
            meta_channel = _get_meta_attr(r, 'meta[name="og:video:creator"]', "content")
            meta_url = _get_meta_attr(r, 'meta[property="og:url"]', "content")
            metadata = {
                "description": meta_desc or "",
                "channel": meta_channel or "",
                "url": meta_url or url,
            }

        # 4. Try to extract stats from page text
        text = r.text
        view_match = re.search(r'(\d[\d,]*)\s*(?:views?|view)', text, re.IGNORECASE)
        like_match = re.search(r'(\d[\d,]*)\s*(?:likes?|like)', text, re.IGNORECASE)
        comment_match = re.search(r'(\d[\d,]*)\s*(?:comments?|comment)', text, re.IGNORECASE)

        # 5. Channel info
        channel_match = re.search(r'"owner":"([^"]+)".*"channelHandle":"(@[^"]+)"', text)
        if not channel_match:
            channel_match = re.search(r'"owner":"([^"]+)"', text)

        result = {
            "title": title,
            "video_id": video_id,
            "url": url,
            "description": metadata.get("description", ""),
            "channel": metadata.get("channel", channel_match.group(1) if channel_match else ""),
            "channel_handle": metadata.get("channelHandle", ""),
            "view_count": int(view_match.group(1).replace(",", "")) if view_match else None,
            "like_count": int(like_match.group(1).replace(",", "")) if like_match else None,
            "comment_count": int(comment_match.group(1).replace(",", "")) if comment_match else None,
            "upload_date": metadata.get("uploadDate", ""),
            "duration": metadata.get("duration", ""),
            "tags": metadata.get("keywords", []),
            "thumbnail": metadata.get("thumbnailUrl", ""),
            "_json_ld": metadata,
            "_scrapling": True,
        }

        log_msg(f"YouTube extracted: title={title[:50]}, channel={result['channel']}, views={result['view_count']}")
        return result

    except Exception as e:
        log_msg(f"YouTube Scrapling extraction failed: {e}")
        return {"error": str(e), "_scrapling": False}


def _parse_json_ld(json_ld_scripts) -> dict[str, Any]:
    """Parse JSON-LD structured data from YouTube page."""
    if not json_ld_scripts:
        return {}

    for script in json_ld_scripts:
        try:
            data = json.loads(script.text)
            # YouTube usually wraps in a single object
            if isinstance(data, dict):
                return _flatten_json_ld(data)
            # Or an array
            elif isinstance(data, list):
                for item in data:
                    if isinstance(item, dict) and item.get("@type") == "VideoObject":
                        return _flatten_json_ld(item)
        except json.JSONDecodeError:
            continue
    return {}


def _flatten_json_ld(data: dict) -> dict[str, Any]:
    """Extract common fields from JSON-LD VideoObject."""
    result = {}

    # Direct fields
    for key in ["name", "description", "uploadDate", "duration", "thumbnailUrl", "keywords"]:
        if key in data:
            result[key.replace("thumbnailUrl", "thumbnail").replace("uploadDate", "upload_date")] = data[key]

    # Author
    author = data.get("author", {})
    if isinstance(author, dict):
        result["channel"] = author.get("name", "")
        result["channel_handle"] = author.get("url", "")

    # Interaction statistics (view count, like count)
    interactions = data.get("interactionStatistic", [])
    if isinstance(interactions, list):
        for stat in interactions:
            if stat.get("userInteractionCount"):
                type_val = stat.get("@type", "")
                if "ViewCount" in type_val:
                    result["view_count"] = stat["userInteractionCount"]
                elif "LikeCount" in type_val:
                    result["like_count"] = stat["userInteractionCount"]

    return result


def _get_meta_attr(r, selector: str, attr: str) -> str | None:
    """Get an attribute value from a CSS-matched element."""
    els = r.css(selector)
    return els[0].attrib.get(attr) if els else None


def log_msg(msg: str):
    print(f"[youtube_adapter] {msg}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    video_id = sys.argv[1] if len(sys.argv) > 1 else "dQw4w9WgXcQ"
    result = extract_youtube_metadata(video_id)
    print(json.dumps(result, indent=2, ensure_ascii=False))
