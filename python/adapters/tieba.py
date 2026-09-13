"""Tieba (百度贴吧) adapter — search + post detail via public API."""
from __future__ import annotations

import re
from typing import Any

from . import (
    CommentNode,
    PlatformAdapter,
    SearchResult,
    http_get_json,
    register,
)


@register
class TiebaAdapter(PlatformAdapter):
    platform_id = "tieba"
    display_name = "百度贴吧"
    url_patterns = [
        re.compile(r"tieba\.baidu\.com/p/(\d+)"),
        re.compile(r"tieba\.baidu\.com/f\?kw=([^&]+)"),
    ]
    enabled_by_default = True
    needs_login_for_full = False

    def search(self, keyword: str, *, limit: int = 10, sort: int = 0, page: int = 1) -> list[SearchResult]:
        if not keyword:
            return []
        cookies = self.load_cookies()
        data = http_get_json(
            "https://tieba.baidu.com/f/search/ures",
            params={
                "ie": "utf-8",
                "kw": keyword,
                "rn": min(limit, 20),
                "pn": page,
            },
            cookies=cookies,
            headers={"Referer": "https://tieba.baidu.com/"},
        )
        if not isinstance(data, dict):
            return []
        posts = data.get("post_list") or []
        results: list[SearchResult] = []
        for p in posts:
            if not isinstance(p, dict):
                continue
            pid = p.get("pid", "")
            if not pid:
                continue
            results.append(SearchResult(
                platform="tieba",
                item_id=str(pid),
                title=p.get("title", ""),
                author=p.get("user_name", "") or p.get("author", ""),
                url=f"https://tieba.baidu.com/p/{p.get('tid', '')}",
                duration="",
                play_count=0,
                like_count=0,
                comment_count=p.get("reply_num", 0) or 0,
                pub_date=p.get("create_time", ""),
                extra={"forum": p.get("forum_name", "")},
            ))
            if len(results) >= limit:
                break
        return results

    def get_item(self, source: str, *, page: int = 0) -> dict[str, Any]:
        m = re.search(r"tieba\.baidu\.com/p/(\d+)", source)
        if not m:
            return {"ok": False, "error": "invalid tieba url", "platform": "tieba"}
        tid = m.group(1)
        cookies = self.load_cookies()
        data = http_get_json(
            f"https://tieba.baidu.com/p/{tid}",
            cookies=cookies,
            headers={"Referer": f"https://tieba.baidu.com/p/{tid}"},
        )
        # 贴吧详情页是 HTML，需要用 lxml/parsel 解析
        # 这里简化为只返回基础信息
        if not isinstance(data, dict):
            return {
                "ok": True,
                "platform": "tieba",
                "item_id": tid,
                "title": "",
                "description": "(需要 HTML 解析; 详情见 mediacrawler/media_platform/tieba/)",
                "url": f"https://tieba.baidu.com/p/{tid}",
            }
        return {
            "ok": True,
            "platform": "tieba",
            "item_id": tid,
            "title": data.get("title", ""),
            "url": f"https://tieba.baidu.com/p/{tid}",
        }

    def get_comments(self, source: str, *, limit: int = 50, max_depth: int = 3, with_sub_comments: bool = True) -> list[CommentNode]:
        return []

    def get_creator(self, creator_id: str) -> dict[str, Any]:
        """通过百度用户名获取创作者信息（简要）。"""
        cookies = self.load_cookies()
        data = http_get_json(
            f"https://tieba.baidu.com/home/get/panel?ie=utf-8&un={creator_id}",
            cookies=cookies,
            headers={"Referer": "https://tieba.baidu.com/"},
        )
        if not isinstance(data, dict):
            return {"ok": False, "error": "creator API failed", "platform": "tieba"}
        return {
            "ok": True,
            "platform": "tieba",
            "creator_id": creator_id,
            "name": creator_id,
            "description": (data.get("data") or {}).get("introduction", "") if isinstance(data.get("data"), dict) else "",
            "url": f"https://tieba.baidu.com/home/main?un={creator_id}",
        }
