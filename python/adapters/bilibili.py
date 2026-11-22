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

# ⭐ 2026-11-21：专栏正文是 HTML，要转纯文本。用 html 模块做实体反转义——
#   很多专栏正文里有 &amp; &#39; 这类，不转义会跟着进 text.txt 和总结。
import html as _html

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

def _html_to_text(raw: str) -> str:
    """专栏正文 HTML → 纯文本。

    只做三件事：剔除 script/style、把块级标签换行、反转义实体。
    不做完整 HTML 解析——正文是富文本但结构很浅，为了它拖个解析库不划算，
    而这条链上少一个依赖就少一个环境坑。
    """
    if not raw:
        return ""
    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", "", raw)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(?:p|div|li|h[1-6]|blockquote)>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = _html.unescape(text)
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


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
        # ⭐ 2026-11-21：图文帖。专栏（read/cv）与动态（opus / t.bilibili）走
        #   _get_article 分支——它们不是视频，走 view API 必输。
        re.compile(r"bilibili\.com/read/(?:mobile/)?(cv\d+)", re.IGNORECASE),
        re.compile(r"bilibili\.com/opus/(\d{6,})", re.IGNORECASE),
        re.compile(r"t\.bilibili\.com/(\d{6,})"),
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
        # ⭐ 2026-11-21：图文帖分流。专栏 cv 与动态 opus 都不是视频，
        #   走下面的 view API 只会得到 code != 0。
        if re.search(r"/read/(?:mobile/)?cv\d+", source or "", re.IGNORECASE) \
                or re.search(r"(?:/opus/|t\.bilibili\.com/)\d{6,}", source or ""):
            return self._get_article(source)

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

    # ---- 图文帖（专栏 cv / 动态 opus） ----

    def _get_article(self, source: str) -> dict[str, Any]:
        """图文帖入口。专栏与动态是两套完全不同的接口。"""
        cookies = self.load_cookies()
        m = re.search(r"/read/(?:mobile/)?cv(\d+)", source, re.IGNORECASE)
        if m:
            return self._get_column(int(m.group(1)), cookies)
        m = re.search(r"(?:/opus/|t\.bilibili\.com/)(\d{6,})", source)
        if m:
            return self._get_dynamic(m.group(1), cookies)
        return {"ok": False, "platform": "bilibili", "error": "认不出 B 站图文帖 ID"}

    def _get_column(self, cv_id: int, cookies: dict[str, str]) -> dict[str, Any]:
        """专栏（read/cv）。

        ⚠️ Referer **必须**是具体那篇 cv 页（`/read/cv<id>/`）。实测用站点根
        `https://www.bilibili.com/` 会稳定回 -509「请求过于频繁」——那不是真的频控，
        是接口在拿 Referer 判来源，同一秒内换几次都一样结果。
        """
        data = http_get_json(
            "https://api.bilibili.com/x/article/view",
            params={"id": cv_id},
            cookies=cookies,
            headers={"Referer": f"https://www.bilibili.com/read/cv{cv_id}/"},
            proxy=self.proxy or None,
        )
        if not isinstance(data, dict) or data.get("code") != 0:
            err = (data or {}).get("message") if isinstance(data, dict) else ""
            return {
                "ok": False,
                "platform": "bilibili",
                "item_id": f"cv{cv_id}",
                "error": f"专栏接口失败（code={(data or {}).get('code') if isinstance(data, dict) else '?'} {err}）",
            }

        d = data.get("data") or {}
        author = d.get("author") or {}
        # 正文是 HTML，压成纯文本——总结和锚点要的是文字，不是标签
        content = _html_to_text(str(d.get("content") or ""))
        images = []
        for idx, url in enumerate(d.get("origin_image_urls") or [], 1):
            if isinstance(url, str) and url.startswith("http"):
                images.append({
                    "url": url.replace("http://", "https://"),
                    "thumb": url,
                    "width": 0,
                    "height": 0,
                    "caption": f"插图 {idx}",
                    # B 站图床会校 Referer，不带就是 403
                    "headers": {"Referer": "https://www.bilibili.com/"},
                })

        return {
            "ok": True,
            "platform": "bilibili",
            "item_id": f"cv{cv_id}",
            "bvid": "",
            "title": str(d.get("title") or f"专栏 cv{cv_id}"),
            "author": str(author.get("name") or d.get("author_name") or ""),
            "uploader_id": str(author.get("mid") or ""),
            "content": content,
            "description": content[:200],
            "transcriptText": content,
            "textKind": "article",
            "kind": "post",
            "cover": str(d.get("banner_url") or "").replace("http://", "https://"),
            "images": images,
            "imageCount": len(images),
            "mediaSources": [],
            "hasVideo": False,
            "isArticle": True,
            "tags": [str(t.get("name")) for t in (d.get("tags") or []) if isinstance(t, dict)],
            "stats": {
                "view": int(d.get("stats", {}).get("view") or 0) if isinstance(d.get("stats"), dict) else 0,
                "like": int(d.get("like") or 0),
                "coin": int(d.get("coin") or 0),
                "favorite": int(d.get("favorite") or 0),
            },
            "pubDate": int(d.get("publish_time") or 0),
            "url": f"https://www.bilibili.com/read/cv{cv_id}/",
        }

    def _get_dynamic(self, dyn_id: str, cookies: dict[str, str]) -> dict[str, Any]:
        """动态（opus / t.bilibili）。

        ⚠️ 这个接口比专栏敏感得多：实测同一 cookie 连续请求几次就开始给空结果
        （code 0 但 items=[]），属于降级而不是报错。所以采集失败时报的是
        “可能被风控弱化”，而不是“作品不存在”。
        """
        data = http_get_json(
            "https://api.bilibili.com/x/polymer/web-dynamic/v1/detail",
            params={"id": dyn_id},
            cookies=cookies,
            headers={"Referer": f"https://t.bilibili.com/{dyn_id}"},
            proxy=self.proxy or None,
        )
        if not isinstance(data, dict) or data.get("code") != 0:
            err = (data or {}).get("message") if isinstance(data, dict) else ""
            return {
                "ok": False,
                "platform": "bilibili",
                "item_id": dyn_id,
                "error": f"动态接口失败（code={(data or {}).get('code') if isinstance(data, dict) else '?'} {err}）",
            }

        item = (data.get("data") or {}).get("item") or {}
        if not item:
            return {
                "ok": False,
                "platform": "bilibili",
                "item_id": dyn_id,
                "error": "动态接口回了空 item（大概是被风控弱化，过一会再试）",
            }

        mods = item.get("modules") or {}
        md = mods.get("module_dynamic") or {}
        major = md.get("major") or {}
        opus = major.get("opus") or {}
        author = mods.get("module_author") or {}
        stat = mods.get("module_stat") or {}

        text = str((opus.get("summary") or {}).get("text")
                   or (md.get("desc") or {}).get("text") or "").strip()
        images = []
        for idx, pic in enumerate(opus.get("pics") or [], 1):
            if not isinstance(pic, dict):
                continue
            url = str(pic.get("url") or "")
            if not url.startswith("http"):
                continue
            images.append({
                "url": url,
                "thumb": url,
                "width": int(pic.get("width") or 0),
                "height": int(pic.get("height") or 0),
                "caption": f"图 {idx}",
                "headers": {"Referer": "https://www.bilibili.com/"},
            })

        # 专栏类动态（DYNAMIC_TYPE_ARTICLE）正文不在 opus 里，得再拉一次 cv
        if item.get("type") == "DYNAMIC_TYPE_ARTICLE":
            rid = str((item.get("basic") or {}).get("rid_str") or "")
            if rid.isdigit():
                col = self._get_column(int(rid), cookies)
                if col.get("ok"):
                    # 专栏才是完整正文，动态壳只是跳转
                    col["item_id"] = dyn_id
                    col["url"] = f"https://www.bilibili.com/opus/{dyn_id}"
                    col["columnId"] = f"cv{rid}"
                    return col

        title = str(opus.get("title") or text[:40] or f"B站动态 {dyn_id}")
        return {
            "ok": True,
            "platform": "bilibili",
            "item_id": dyn_id,
            "bvid": "",
            "title": title,
            "author": str(author.get("name") or ""),
            "uploader_id": str(author.get("mid") or ""),
            "content": text,
            "description": text[:200],
            "transcriptText": text,
            "textKind": "article",
            "kind": "post",
            "cover": images[0]["url"] if images else "",
            "images": images,
            "imageCount": len(images),
            "mediaSources": [],
            "hasVideo": False,
            "dynamicType": str(item.get("type") or ""),
            "stats": {
                "like": int((stat.get("like") or {}).get("count") or 0),
                "comment": int((stat.get("comment") or {}).get("count") or 0),
                "forward": int((stat.get("forward") or {}).get("count") or 0),
            },
            "pubDate": int(author.get("pub_ts") or 0),
            "url": f"https://www.bilibili.com/opus/{dyn_id}",
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
        # ⭐ 2026-10-04：取数抽到 bilibili_comments.py，与 collector.py 共用一份。
        #   以前这里直接打 /x/v2/reply（已废弃，恒定只回 3 条），而且把 load_cookies()
        #   里的 buvid3 全量带走 —— 新接口同样会被砍回 3 条。两个坑叠在一起。
        #   翻页也从 pn 换成 cursor.pagination_reply.next_offset（B 站新游标语义）。
        from bilibili_comments import fetch_root_comments, fetch_sub_comments

        aid = self._extract_aid(source)
        if not aid:
            return []

        cookie = self.cookie_header()   # 净化在 bilibili_comments 里面统一做
        raws = fetch_root_comments(aid, limit=limit, cookies=cookie)
        nodes: list[CommentNode] = []
        sub_budget = 12
        for raw in raws:
            node = self._parse_comment(raw, level=0, max_depth=max_depth,
                                       with_sub_comments=with_sub_comments)
            if node is None:
                continue
            if with_sub_comments and sub_budget > 0:
                rcount = int(raw.get("rcount") or 0)
                if rcount > len(node.replies):
                    sub_budget -= 1
                    for sub in fetch_sub_comments(aid, node.rpid, cookies=cookie):
                        child = self._parse_comment(sub, level=1, max_depth=max_depth,
                                                    with_sub_comments=False)
                        if child:
                            node.replies.append(child)
            nodes.append(node)
        return nodes[:limit]

    def _fetch_sub_comments(self, aid: int, rpid: int, *, max_depth: int) -> list[CommentNode]:
        """Fetch level-2 comments for a given root comment.

        ⭐ 2026-10-04：换用 bilibili_comments.fetch_sub_comments —— 二级评论的
        /x/v2/reply/reply 实测没被砍（新接口那边也没有 wbi/main 变体，404），
        这里要的只是同一套 cookie 净化 + 统一的失败处理。
        """
        from bilibili_comments import fetch_sub_comments
        out: list[CommentNode] = []
        for r in fetch_sub_comments(aid, rpid, cookies=self.cookie_header()):
            node = self._parse_comment(r, level=1, max_depth=max_depth,
                                       with_sub_comments=False)
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
        # ⭐ 2026-10-04：走 bilibili_comments.resolve_aid（带 WBI 签名的 view 接口，
        #   失败再退裸参数）。原来这里依赖同目录的 bilibili_helper.bv_to_av（纯本地算法），
        #   而 collector 那边用的是 view 接口 —— 同一件事两套真相，BV 号算法一改就飘。
        try:
            from bilibili_comments import resolve_aid
            aid = resolve_aid(source)
            if aid:
                return int(aid)
        except Exception:
            pass
        # 兜底：旧的本地算法 + 裸接口，保持升级前行为。
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
