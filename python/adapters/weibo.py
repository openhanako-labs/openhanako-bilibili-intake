"""Weibo (微博) adapter — search + post detail via public API.

微博 m.weibo.cn 有相对开放的公开 API，搜索和详情都能拿到（限流）。
"""
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
class WeiboAdapter(PlatformAdapter):
    platform_id = "weibo"
    display_name = "微博"
    url_patterns = [
        re.compile(r"weibo\.com/(?:\d+|[a-zA-Z0-9_]+)/([A-Za-z0-9]+)"),
        re.compile(r"m\.weibo\.cn/(?:status|detail)/(\d+)"),
        re.compile(r"weibo\.cn/(?:status|detail)/(\d+)"),
    ]
    enabled_by_default = True
    needs_login_for_full = False

    def search(self, keyword: str, *, limit: int = 10, sort: int = 0, page: int = 1) -> list[SearchResult]:
        if not keyword:
            return []
        cookies = self.load_cookies()
        data = http_get_json(
            "https://m.weibo.cn/api/container/getIndex",
            params={
                "containerid": f"100103type=1&q={keyword}",
                "page_type": "searchall",
                "page": page,
            },
            cookies=cookies,
            headers={"Referer": "https://m.weibo.cn/search"},
        )
        if not isinstance(data, dict) or data.get("ok") != 1:
            return []
        cards = (data.get("data") or {}).get("cards") or []
        results: list[SearchResult] = []
        for card in cards:
            if not isinstance(card, dict):
                continue
            mb = card.get("mblog") or {}
            if not mb:
                continue
            bid = mb.get("id", "")
            if not bid:
                continue
            user = mb.get("user") or {}
            results.append(SearchResult(
                platform="weibo",
                item_id=str(bid),
                title=mb.get("text", "")[:100].replace("<br/>", " ").replace("</br>", " "),
                author=user.get("screen_name", ""),
                url=f"https://m.weibo.cn/detail/{bid}",
                cover=(mb.get("pics") or [{}])[0].get("url", "") if mb.get("pics") else "",
                duration="",
                play_count=mb.get("reposts_count", 0) or 0,
                like_count=mb.get("attitudes_count", 0) or 0,
                comment_count=mb.get("comments_count", 0) or 0,
                pub_date=mb.get("created_at", ""),
                extra={"user_id": user.get("id", "")},
            ))
            if len(results) >= limit:
                break
        return results

    def get_item(self, source: str, *, page: int = 0) -> dict[str, Any]:
        bid = self._extract_bid(source)
        if not bid:
            return {"ok": False, "error": "invalid weibo url", "platform": "weibo"}
        cookies = self.load_cookies()
        data = http_get_json(
            f"https://m.weibo.cn/statuses/show",
            params={"id": bid},
            cookies=cookies,
            headers={"Referer": f"https://m.weibo.cn/detail/{bid}"},
        )
        if not isinstance(data, dict) or data.get("ok") != 1:
            return {"ok": False, "error": "weibo show failed", "platform": "weibo"}
        mb = data.get("data") or {}
        user = mb.get("user") or {}
        return {
            "ok": True,
            "platform": "weibo",
            "item_id": str(mb.get("id", bid)),
            "title": mb.get("text", "")[:200],
            "description": mb.get("text", ""),
            "author": user.get("screen_name", ""),
            "uploader_id": user.get("id", ""),
            "pub_date": mb.get("created_at", ""),
            "like_count": mb.get("attitudes_count", 0),
            "comment_count": mb.get("comments_count", 0),
            "repost_count": mb.get("reposts_count", 0),
            "pics": [p.get("url", "") for p in (mb.get("pics") or [])],
            "url": f"https://m.weibo.cn/detail/{bid}",
        }

    def get_comments(self, source: str, *, limit: int = 50, max_depth: int = 3, with_sub_comments: bool = True) -> list[CommentNode]:
        # ⭐ v0.6.26：实现微博评论抓取
        # 移动端 API: https://m.weibo.cn/api/comments/show?id=<status_id>&count=20&offset=<offset>
        # 可能需要登录态（cookies），但部分公开微博可能不需要。
        import re as _re
        from datetime import datetime as _dt

        # 从 source 提取 status_id（URL 或纯数字）
        status_id = ""
        if "detail/" in source:
            m = _re.search(r"detail/(\d+)", source)
            if m:
                status_id = m.group(1)
        elif source.isdigit():
            status_id = source
        if not status_id:
            return []

        cookies = self.load_cookies()
        headers = {
            "Referer": f"https://m.weibo.cn/detail/{status_id}",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15",
        }

        results: list[CommentNode] = []
        offset = 0
        page_size = min(20, limit)

        while len(results) < limit:
            url = f"https://m.weibo.cn/api/comments/show?id={status_id}&count={page_size}&offset={offset}"
            data = http_get_json(url, cookies=cookies, headers=headers)
            if not isinstance(data, dict) or data.get("ok") != 1:
                break
            data_list = (data.get("data") or [])
            if not data_list:
                break
            for item in data_list:
                if not isinstance(item, dict):
                    continue
                user = item.get("user") or {}
                # 微博评论时间格式："2024-01-01 12:00" 或 "1 小时前"
                ctime_str = item.get("created_at", "")
                ctime = 0
                if ctime_str:
                    try:
                        ctime = int(_dt.strptime(ctime_str[:16], "%Y-%m-%d %H:%M").timestamp())
                    except (ValueError, TypeError):
                        pass
                node = CommentNode(
                    rpid=str(item.get("id", "")),
                    username=user.get("screen_name", ""),
                    content=item.get("text", ""),
                    like_count=item.get("like_count", 0) or 0,
                    ctime=ctime,
                    level=0,
                )
                results.append(node)
            offset += len(data_list)
            if len(data_list) < page_size:
                break

        return results[:limit]

    def get_creator(self, creator_id: str) -> dict[str, Any]:
        """通过微博用户 ID 获取创作者信息。"""
        cookies = self.load_cookies()
        data = http_get_json(
            f"https://m.weibo.cn/api/container/getIndex?type=uid&value={creator_id}",
            cookies=cookies,
            headers={"Referer": f"https://m.weibo.cn/u/{creator_id}"},
        )
        if not isinstance(data, dict):
            return {"ok": False, "error": "creator API failed", "platform": "weibo"}
        info = (data.get("data") or {}).get("userInfo") or {} if isinstance(data.get("data"), dict) else {}
        return {
            "ok": True,
            "platform": "weibo",
            "creator_id": creator_id,
            "name": info.get("screen_name", ""),
            "description": info.get("description", ""),
            "followers_count": info.get("followers_count", 0),
            "statuses_count": info.get("statuses_count", 0),
            "url": f"https://weibo.com/u/{creator_id}",
        }

    @staticmethod
    def _extract_bid(source: str) -> str | None:
        s = (source or "").strip()
        m = re.search(r"m\.weibo\.cn/(?:status|detail)/(\d+)", s)
        if m:
            return m.group(1)
        m = re.search(r"weibo\.com/\d+/([A-Za-z0-9]+)", s)
        if m:
            return m.group(1)
        if re.fullmatch(r"\d{10,}", s):
            return s
        return None
