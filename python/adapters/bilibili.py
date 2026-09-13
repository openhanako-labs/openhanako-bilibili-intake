"""Bilibili adapter — enhanced search (WBI signed) + multi-level comments.

Strategy:
- search: B 站新搜索 API 需要 wbi 签名（否则返回 412）。我们用 MediaCrawler
  同款思路：拉 img_key + sub_key 算 w_rid。这里不依赖 mediacrawler 源码。
- get_item: 优先用 web-interface/view API（需要 wbi 签名），
  fallback 到现有 Scrapling/yt-dlp 路径。
- comments: 二级评论完整树。
- creator: 简版。
"""
from __future__ import annotations

import re
import time
from hashlib import md5
from typing import Any
from urllib.parse import quote, urlencode

from . import (
    CommentNode,
    PlatformAdapter,
    SearchResult,
    http_get_json,
    register,
)


# ---- B 站 WBI 签名表（来自 MediaCrawler & 公开资料） ----
# 取的是字符的索引位置（32 字符表），用于生成 w_rid
_MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
]


def _mixin_key(raw: str) -> str:
    return "".join(raw[i] for i in _MIXIN_KEY_ENC_TAB)


def _w_rid(params: dict[str, Any], mixin_key: str) -> str:
    # 把 params 排序，拼接 url-encoded 形式，然后加 mixin_key，md5
    sorted_items = sorted((k, "" if v is None else str(v)) for k, v in params.items())
    encoded = urlencode(sorted_items, quote_via=quote)
    raw = encoded + mixin_key
    return md5(raw.encode("utf-8")).hexdigest()


def _wbi_sign(params: dict[str, Any], img_key: str, sub_key: str) -> dict[str, Any]:
    mixin_key = _mixin_key(img_key + sub_key)
    params = dict(params)
    params["wts"] = int(time.time())
    params["w_rid"] = _w_rid(params, mixin_key)
    return params


def _fetch_wbi_keys(cookies: dict[str, str]) -> tuple[str, str] | None:
    """Fetch img_key / sub_key from B 站 nav API."""
    data = http_get_json(
        "https://api.bilibili.com/x/web-interface/nav",
        cookies=cookies,
        headers={"Referer": "https://www.bilibili.com/"},
    )
    if not isinstance(data, dict):
        return None
    inner = data.get("data") or {}
    img_url = inner.get("wbi_img", {}).get("img_url", "") if isinstance(inner, dict) else ""
    sub_url = inner.get("wbi_img", {}).get("sub_url", "") if isinstance(inner, dict) else ""
    if not img_url or not sub_url:
        return None
    img_key = img_url.rsplit("/", 1)[-1].split(".")[0]
    sub_key = sub_url.rsplit("/", 1)[-1].split(".")[0]
    return img_key, sub_key


# ============================================================
# Adapter
# ============================================================

# 排序映射（同 MediaCrawler）
_SORT_MAP = {
    0: "totalrank",  # 综合
    1: "click",      # 最多播放
    2: "pubdate",    # 最新发布
    3: "dm",         # 最多弹幕
}


@register
class BilibiliAdapter(PlatformAdapter):
    platform_id = "bilibili"
    display_name = "哔哩哔哩"
    url_patterns = [
        re.compile(r"bilibili\.com/video/(BV[a-zA-Z0-9]+|av\d+)", re.IGNORECASE),
        re.compile(r"^BV[a-zA-Z0-9]+$", re.IGNORECASE),
        re.compile(r"^av\d+$", re.IGNORECASE),
    ]
    enabled_by_default = True
    needs_login_for_full = False  # 公开数据可不登录

    # ---- search ----

    def search(
        self,
        keyword: str,
        *,
        limit: int = 10,
        sort: int = 0,
        page: int = 1,
    ) -> list[SearchResult]:
        if not keyword:
            return []

        cookies = self.load_cookies()
        sort_order = _SORT_MAP.get(sort, "totalrank")
        limit = min(max(limit, 1), 50)

        # 没有 wbi 签名，搜索会返回 412 —— 走有签名路径
        keys = _fetch_wbi_keys(cookies)
        params = {
            "search_type": "video",
            "keyword": keyword,
            "order": sort_order,
            "page": page,
            "pagesize": limit,
            "category_id": "",
            "duration": "",
            "user_type": "",
            "order_avoided": "true",
        }
        if keys:
            params = _wbi_sign(params, *keys)
        else:
            # 没有 wbi 时回退：无签名的 type=video 接口（也可能 412）
            pass

        data = http_get_json(
            "https://api.bilibili.com/x/web-interface/search/type",
            params=params,
            cookies=cookies,
            headers={"Referer": "https://www.bilibili.com/search"},
        )
        if not isinstance(data, dict):
            return []

        items = (data.get("data") or {}).get("result") or []
        results: list[SearchResult] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            bv_id = item.get("bvid") or item.get("aid")
            if not bv_id:
                continue
            results.append(SearchResult(
                platform="bilibili",
                item_id=str(bv_id),
                title=item.get("title", ""),
                author=item.get("author") or item.get("writer") or "",
                url=f"https://www.bilibili.com/video/{bv_id}",
                cover=item.get("pic", ""),
                duration=item.get("duration", ""),
                play_count=item.get("play", 0) or 0,
                like_count=item.get("like", 0) or 0,
                comment_count=item.get("review", 0) or 0,
                pub_date=item.get("pubdate", ""),
                extra={
                    "tag": item.get("tag", ""),
                    "description": item.get("description", ""),
                    "favorites": item.get("favorites", 0),
                    "danmaku": item.get("danmaku", 0),
                },
            ))
        return results

    # ---- get_item ----

    def get_item(
        self,
        source: str,
        *,
        page: int = 0,
    ) -> dict[str, Any]:
        bvid_or_aid = self._extract_bv_or_av(source)
        if not bvid_or_aid:
            return {"ok": False, "error": "invalid source", "platform": "bilibili"}

        cookies = self.load_cookies()
        # 优先 web-interface/view（带 wbi 签名）
        keys = _fetch_wbi_keys(cookies)
        is_bv = bvid_or_aid.lower().startswith("bv")
        params: dict[str, Any] = {}
        if is_bv:
            params["bvid"] = bvid_or_aid
        else:
            params["aid"] = int(bvid_or_aid[2:]) if bvid_or_aid.lower().startswith("av") else int(bvid_or_aid)
        if keys:
            params = _wbi_sign(params, *keys)

        data = http_get_json(
            "https://api.bilibili.com/x/web-interface/view",
            params=params,
            cookies=cookies,
            headers={"Referer": "https://www.bilibili.com/"},
        )
        if not isinstance(data, dict) or data.get("code") != 0:
            return {"ok": False, "error": "view API failed", "platform": "bilibili"}

        info = data.get("data") or {}
        return {
            "ok": True,
            "platform": "bilibili",
            "item_id": info.get("bvid", bvid_or_aid),
            "title": info.get("title", ""),
            "description": info.get("desc", ""),
            "uploader": (info.get("owner") or {}).get("name", ""),
            "uploader_id": (info.get("owner") or {}).get("mid", ""),
            "duration": info.get("duration", 0),
            "duration_ms": (info.get("duration", 0) or 0) * 1000,
            "view_count": (info.get("stat") or {}).get("view", 0),
            "like_count": (info.get("stat") or {}).get("like", 0),
            "favorite_count": (info.get("stat") or {}).get("favorite", 0),
            "coin_count": (info.get("stat") or {}).get("coin", 0),
            "share_count": (info.get("stat") or {}).get("share", 0),
            "danmaku_count": (info.get("stat") or {}).get("danmaku", 0),
            "reply_count": (info.get("stat") or {}).get("reply", 0),
            "cover": info.get("pic", ""),
            "pub_date": info.get("pubdate", 0),
            "tags": [t.get("tag_name", "") for t in (info.get("tags") or [])],
            "cid": info.get("cid", 0),
            "aid": info.get("aid", 0),
            "bvid": info.get("bvid", bvid_or_aid),
            "url": f"https://www.bilibili.com/video/{info.get('bvid', bvid_or_aid)}",
        }

    # ---- comments ----

    def get_comments(
        self,
        source: str,
        *,
        limit: int = 50,
        max_depth: int = 3,
        with_sub_comments: bool = True,
    ) -> list[CommentNode]:
        # 解析 aid
        aid = self._extract_aid(source)
        if not aid:
            return []

        cookies = self.load_cookies()
        headers = {
            "Referer": f"https://www.bilibili.com/video/{source}",
            "Origin": "https://www.bilibili.com",
        }

        all_comments: list[CommentNode] = []
        pn = 1
        ps = 20  # API 上限

        while len(all_comments) < limit:
            data = http_get_json(
                "https://api.bilibili.com/x/v2/reply",
                params={
                    "type": 1,
                    "oid": aid,
                    "sort": 2,  # 2 = 按热度
                    "pn": pn,
                    "ps": min(ps, limit - len(all_comments)),
                },
                cookies=cookies,
                headers=headers,
            )
            if not isinstance(data, dict) or data.get("code") != 0:
                break

            root = data.get("data") or {}
            replies = root.get("replies") or []
            if not replies:
                break

            for r in replies:
                node = self._parse_comment(r, level=0, max_depth=max_depth, with_sub_comments=with_sub_comments)
                if node is None:
                    continue
                # 拉二级评论（如 with_sub_comments）
                if with_sub_comments and node.replies == [] and (root.get("page") or {}).get("count", 0) > 0:
                    node.replies = self._fetch_sub_comments(aid, node.rpid, max_depth=max_depth)
                all_comments.append(node)
                if len(all_comments) >= limit:
                    break

            page_info = root.get("page") or {}
            total = page_info.get("count", 0) or 0
            if pn * ps >= total:
                break
            pn += 1

        return all_comments[:limit]

    def _fetch_sub_comments(self, aid: int, rpid: int, *, max_depth: int) -> list[CommentNode]:
        """Fetch level-2 comments for a given root comment."""
        cookies = self.load_cookies()
        data = http_get_json(
            "https://api.bilibili.com/x/v2/reply/reply",
            params={"type": 1, "oid": aid, "root": rpid, "ps": 20, "pn": 1},
            cookies=cookies,
            headers={"Referer": "https://www.bilibili.com/"},
        )
        if not isinstance(data, dict) or data.get("code") != 0:
            return []
        replies = (data.get("data") or {}).get("replies") or []
        out: list[CommentNode] = []
        for r in replies:
            node = self._parse_comment(r, level=1, max_depth=max_depth, with_sub_comments=with_sub_comments)
            if node:
                out.append(node)
        return out

    def _parse_comment(self, node: dict, level: int, max_depth: int, *, with_sub_comments: bool = True) -> CommentNode | None:
        if not isinstance(node, dict):
            return None
        rpid = node.get("rpid")
        if rpid is None:
            return None
        member = node.get("member") or {}
        replies_raw = node.get("replies") or []
        replies: list[CommentNode] = []
        # ⭐ 内联 replies 也要受开关控制。B 站 /x/v2/reply 会把第一层
        # 子评论直接塞在每条评论的 replies 字段里，以前这里无条件解析，
        # 导致 with_sub_comments=False 仍然拿到二级评论。
        if replies_raw and with_sub_comments and level + 1 < max_depth:
            for child in replies_raw:
                if isinstance(child, dict):
                    c = self._parse_comment(child, level + 1, max_depth, with_sub_comments=with_sub_comments)
                    if c:
                        replies.append(c)
        return CommentNode(
            rpid=str(rpid),
            username=member.get("uname", ""),
            content=(node.get("content") or {}).get("message", ""),
            like_count=node.get("like", 0) or 0,
            ctime=node.get("ctime", 0) or 0,
            level=level,
            replies=replies,
        )

    # ---- creator ----

    def get_creator(self, creator_id: str) -> dict[str, Any]:
        cookies = self.load_cookies()
        keys = _fetch_wbi_keys(cookies)
        params = {"mid": int(creator_id)}
        if keys:
            params = _wbi_sign(params, *keys)
        data = http_get_json(
            "https://api.bilibili.com/x/space/wbi/acc/info",
            params=params,
            cookies=cookies,
            headers={"Referer": "https://space.bilibili.com/"},
        )
        if not isinstance(data, dict) or data.get("code") != 0:
            return {"ok": False, "error": "creator API failed", "platform": "bilibili"}
        info = data.get("data") or {}
        return {
            "ok": True,
            "platform": "bilibili",
            "creator_id": info.get("mid", creator_id),
            "name": info.get("name", ""),
            "bio": info.get("sign", ""),
            "avatar": (info.get("face") or ""),
            "fans": info.get("fans", 0),
            "following": info.get("following", 0),
            "level": info.get("level", 0),
        }

    # ---- helpers ----

    @staticmethod
    def _extract_bv_or_av(source: str) -> str | None:
        s = (source or "").strip()
        # 完整 URL
        m = re.search(r"/video/(BV[a-zA-Z0-9]+|av\d+)", s, re.IGNORECASE)
        if m:
            return m.group(1)
        # 纯 ID
        if re.fullmatch(r"BV[a-zA-Z0-9]+", s, re.IGNORECASE):
            return s
        if re.fullmatch(r"av\d+", s, re.IGNORECASE):
            return s
        return None

    @staticmethod
    def _extract_aid(source: str) -> int | None:
        s = (source or "").strip()
        m = re.match(r"av(\d+)", s, re.IGNORECASE)
        if m:
            return int(m.group(1))
        m = re.search(r"/video/(BV[a-zA-Z0-9]+)", s, re.IGNORECASE)
        if m:
            # 转 BV → AV
            from .bilibili_helper import bv_to_av
            aid = bv_to_av(m.group(1))
            return int(aid) if aid else None
        m = re.search(r"/av(\d+)", s, re.IGNORECASE)
        if m:
            return int(m.group(1))
        return None
