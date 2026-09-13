#!/usr/bin/env python3
"""Xiaohongshu (RED/小红书) adapter for Scrapling.

Extracts metadata from Xiaohongshu note pages via browser automation.
Requires a valid login cookie for full content access.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


def extract_xiaohongshu_metadata(
    note_id_or_url: str,
    cookies_file: str = "",
) -> dict[str, Any]:
    """Extract Xiaohongshu note metadata using Scrapling DynamicFetcher."""
    from scrapling import DynamicFetcher

    note_id = _extract_note_id(note_id_or_url)
    if not note_id:
        return {"error": "Could not extract note ID", "_xhs": False}

    url = f"https://www.xiaohongshu.com/explore/{note_id}"
    log_msg(f"extracting Xiaohongshu note: {url}")

    cookies = {}
    if cookies_file:
        cookies = _read_netscape_cookies(cookies_file)

    try:
        fetcher = DynamicFetcher(
            browser_type="chrome",
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            ),
            cookies=cookies if cookies else None,
        )
        r = fetcher.fetch(url)
        html = r.html_content

        if "error_code=300031" in r.url or "暂时无法浏览" in html:
            log_msg(f"note restricted/blocked: {note_id}")
            return {
                "note_id": note_id,
                "restricted": True,
                "error": "Note temporarily unavailable (requires login)",
                "_xhs": True,
            }

        state = _parse_initial_state(html)
        if not state:
            log_msg("no __INITIAL_STATE__ found")
            return {"note_id": note_id, "error": "No page data", "_xhs": True}

        return _parse_note_from_state(state, note_id, url)

    except Exception as e:
        log_msg(f"Xiaohongshu extraction failed: {e}")
        return {"error": str(e), "_xhs": False}


def extract_xiaohongshu_explore(
    cookies_file: str = "",
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Scrape the Xiaohongshu explore (recommendation) page."""
    from scrapling import DynamicFetcher

    cookies = {}
    if cookies_file:
        cookies = _read_netscape_cookies(cookies_file)

    try:
        fetcher = DynamicFetcher(
            browser_type="chrome",
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            ),
            cookies=cookies if cookies else None,
        )
        r = fetcher.fetch("https://www.xiaohongshu.com/explore")
        html = r.html_content

        state = _parse_initial_state(html)
        if not state:
            return []

        return _parse_explore_notes(state, limit)

    except Exception as e:
        log_msg(f"Xiaohongshu explore scrape failed: {e}")
        return []


def _extract_note_id(text: str) -> str | None:
    """Extract note ID from URL or bare ID string."""
    m = re.search(r'xiaohongshu\.com/explore/([a-f0-9]+)', text)
    if m:
        return m.group(1)
    m = re.match(r'^([a-f0-9]{20,24})$', text)
    if m:
        return m.group(1)
    return None


def _parse_initial_state(html: str) -> dict[str, Any] | None:
    """Extract and parse __INITIAL_STATE__ from Xiaohongshu page."""
    idx = html.find('__INITIAL_STATE__=')
    if idx < 0:
        return None

    rest = html[idx + len('__INITIAL_STATE__='):]
    depth = 0
    end = 0
    in_string = False
    escape_next = False
    for i, c in enumerate(rest):
        if escape_next:
            escape_next = False
            continue
        if c == '\\':
            escape_next = True
            continue
        if c == '"':
            in_string = not in_string
        if not in_string:
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break

    json_str = rest[:end]
    json_str = json_str.replace('undefined', 'null')

    try:
        return json.loads(json_str)
    except json.JSONDecodeError:
        return None


def _parse_note_from_state(state: dict, note_id: str, url: str) -> dict[str, Any]:
    """Parse a single note from __INITIAL_STATE__ data."""
    note_section = state.get('note', {})
    note_detail_map = note_section.get('noteDetailMap', {})

    note_data = None
    if note_id in note_detail_map:
        note_data = note_detail_map[note_id]
    else:
        note_data = _find_in_dict(note_detail_map, note_id)

    if not note_data:
        return {
            'note_id': note_id,
            'url': url,
            'error': 'Note data not found',
            '_xhs': True,
        }

    note_card = note_data.get('noteCard', {})
    user = note_card.get('user', {})
    interact = note_card.get('interactInfo', {})
    media = note_card.get('video', {})

    result = {
        'note_id': note_id,
        'url': url,
        'title': note_card.get('displayTitle') or note_card.get('title', ''),
        'description': note_card.get('desc', ''),
        'note_type': note_card.get('type', ''),
        'created_at': note_card.get('time', ''),
        'author': {
            'id': user.get('userId', ''),
            'nickname': user.get('nickname', ''),
            'url': user.get('link', ''),
        },
        'interact_info': {
            'likes': interact.get('likedCount', 0),
            'collects': interact.get('collectedCount', 0),
            'comments': interact.get('commentCount', 0),
        },
        'images': [],
        'video': {},
        '_xhs': True,
    }

    image_list = note_card.get('imageList', [])
    for img in image_list:
        if isinstance(img, dict):
            result['images'].append(img.get('url', ''))

    if media:
        result['video'] = {
            'stream': media.get('stream', {}),
            'cover': media.get('cover', ''),
            'download_url': media.get('downloadUrl', ''),
        }

    return result


def _parse_explore_notes(state: dict, limit: int = 20) -> list[dict[str, Any]]:
    """Parse note summaries from explore/recommend page."""
    notes = []
    feed = state.get('feed', {})
    note_feed = feed.get('noteFeed', [])
    if not isinstance(note_feed, list):
        note_feed = []
    if not note_feed:
        wrapper = feed.get('feedsWrapper', {})
        if isinstance(wrapper, dict):
            note_feed = wrapper.get('list', [])
            if not isinstance(note_feed, list):
                note_feed = []
    if not note_feed:
        note_feed = feed.get('feeds', [])
        if not isinstance(note_feed, list):
            note_feed = []

    for item in note_feed[:limit]:
        if not isinstance(item, dict):
            continue
        note_card = item.get('noteCard', {})
        user = note_card.get('user', {})
        interact = note_card.get('interactInfo', {})
        cover = note_card.get('cover', {})
        if not isinstance(cover, dict):
            cover = {}

        notes.append({
            'note_id': item.get('id', ''),
            'title': note_card.get('displayTitle') or note_card.get('title', ''),
            'description': note_card.get('desc', ''),
            'note_type': note_card.get('type', ''),
            'author': user.get('nickname', ''),
            'likes': interact.get('likedCount', 0),
            'cover': cover.get('url', ''),
            '_xhs': True,
        })

    return notes


def _find_in_dict(d: dict, target_id: str) -> dict | None:
    """Recursively search dict for target_id as a key."""
    if not isinstance(d, dict):
        return None
    if target_id in d:
        return d[target_id]
    for v in d.values():
        if isinstance(v, (dict, list)):
            result = _find_in_dict(v, target_id)
            if result:
                return result
    return None


def _read_netscape_cookies(filepath: str) -> dict[str, str]:
    """Read Netscape-format cookie file into a dict."""
    cookies = {}
    try:
        path = Path(filepath)
        if not path.exists():
            return cookies
        for line in path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line or line.startswith('#') or line.startswith('//'):
                continue
            parts = line.split('\t')
            if len(parts) >= 7:
                cookies[parts[5]] = parts[6]
    except Exception:
        pass
    return cookies


def log_msg(msg: str):
    print(f'[xiaohongshu_adapter] {msg}', file=sys.stderr, flush=True)


if __name__ == '__main__':
    target = sys.argv[1] if len(sys.argv) > 1 else '6a380dbc0000000016024d06'
    result = extract_xiaohongshu_metadata(target)
    print(json.dumps(result, indent=2, ensure_ascii=False))
