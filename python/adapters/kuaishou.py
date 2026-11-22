"""快手 (Kuaishou) adapter — 桌面页 __APOLLO_STATE__ 直读。

为什么不用 yt-dlp：yt-dlp 没有 Kuaishou extractor（2026.06.09 实测 1746 个
extractor 里没有），所以这个平台必须自己解析。参考实现见
baishu136/OmniDownloader 的 windows/engine/kuaishou.py（MIT），但那边用的是
移动 UA + 正则嗅 `"srcNoMark"`，实测移动 UA 拿回来是 63 字节的空壳（要靠 JS
渲染），正则路径走不通。这里改走桌面页。

实测结论（2026-11-21）：
  · 桌面 UA → https://www.kuaishou.com/short-video/<photoId> 返回 ~86KB SSR HTML
  · 数据在 window.__APOLLO_STATE__ 这个 Apollo GraphQL cache 里
  · VisionVideoDetailPhoto:<id> 给 caption / coverUrl / photoUrl / duration
  · VisionVideoDetailAuthor:<id> 给作者名
  · 短链 /f/<code> 靠 HTTP 302 落地并带上 photoId，所以必须先跟随重定向

没有用「正则嗅直链」是刻意的：那种写法一改版就静默失效，而 Apollo state 是
SSR 的数据源，结构变的时候页面本身也变了，失败会明显得多。
"""
from __future__ import annotations

import json
import re
import time
from typing import Any

import httpx

from . import (
    CommentNode,
    PlatformAdapter,
    SearchResult,
    register,
)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

# 快手 CDN 下载时带这个 Referer 更稳（不是所有节点都校验，但带上不会错）
MEDIA_HEADERS = {"User-Agent": UA, "Referer": "https://www.kuaishou.com/"}

_ID_PATTERNS = (
    re.compile(r"kuaishou\.com/(?:short-video|photo|fw/photo)/([a-zA-Z0-9_-]{6,})"),
    re.compile(r"chenzhongtech\.com/fw/photo/([a-zA-Z0-9_-]{6,})"),
    re.compile(r"[?&]photoId=([a-zA-Z0-9_-]{6,})"),
    re.compile(r"gifshow\.com/(?:short-video|photo)/([a-zA-Z0-9_-]{6,})"),
)

# 短链域名：这类只能靠跟随重定向拿到 photoId
_SHORT_HOSTS = ("v.kuaishou.com", "k.kwai.com", "short.kwai.com", "g.e.kuaishou.com")

_APOLLO_MARKER = "window.__APOLLO_STATE__="
_INIT_STATE_MARKER = re.compile(r"window\.INIT_STATE\s*=\s*")

# ⭐ 移动页才是快手的数据富矿。实测：桌面页第二次访问开始就只回骨架
#   （__APOLLO_STATE__ 里只剩配置和 Banner，没有 PhotoDetail），
#   而 v.m.chenzhongtech.com/fw/photo/<id> 稳定回 160KB 且带完整 INIT_STATE。
#   所以主路走移动页，桌面页降为兜底。
MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
)
MOBILE_HEADERS = {"User-Agent": MOBILE_UA, "Accept-Language": "zh-CN,zh;q=0.9"}

# 同一次采集里 get_item 之后往往还要拿原片，页面别解析两遍
_PAGE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_CACHE_TTL = 300.0


def extract_photo_id(url: str) -> str:
    text = (url or "").strip()
    for pat in _ID_PATTERNS:
        m = pat.search(text)
        if m:
            return m.group(1)
    return ""


def parse_apollo(html: str) -> dict[str, Any]:
    """从 SSR HTML 里抠出 __APOLLO_STATE__。

    用 JSONDecoder.raw_decode 而不是正则配大括号：这份 JSON 里有大量
    `\\u002F` 转义和嵌套对象，正则数括号数错一次就整块解析不出来。
    """
    idx = html.find(_APOLLO_MARKER)
    if idx < 0:
        return {}
    start = idx + len(_APOLLO_MARKER)
    try:
        data, _end = json.JSONDecoder().raw_decode(html[start:])
    except (json.JSONDecodeError, ValueError):
        return {}
    if isinstance(data, dict) and isinstance(data.get("defaultClient"), dict):
        return data["defaultClient"]
    return data if isinstance(data, dict) else {}


def _pick_photo(state: dict[str, Any], photo_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """返回 (photo, author)。photoId 对不上就不猜——拿错作品的代价太大。"""
    photo: dict[str, Any] = {}
    author: dict[str, Any] = {}
    for key, value in state.items():
        if not isinstance(value, dict):
            continue
        if key.startswith("VisionVideoDetailPhoto:") and (not photo_id or key.endswith(photo_id)):
            photo = value
        elif key.startswith("VisionVideoDetailAuthor:"):
            author = value
    return photo, author


def parse_init_state(html: str) -> dict[str, Any]:
    """从移动页里抠出 window.INIT_STATE。

    ⚠️ 它的 key 是混淆过的（每个字符偏移过一位，`tusjoh` 就是 `string`），
    所以**不能按键名取**，只能在值里找。结构是
        { <混淆key>: {"photo": {...}, "counts": {...}}, ... }
    图集作品还会多一个带 "atlas" 的节点。
    """
    m = _INIT_STATE_MARKER.search(html)
    if not m:
        return {}
    try:
        data, _end = json.JSONDecoder().raw_decode(html[m.end():])
    except (json.JSONDecodeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _find_photo_nodes(state: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """在 INIT_STATE 里找出 photo 节点和它旁边的图集节点。"""
    photo: dict[str, Any] = {}
    holder: dict[str, Any] = {}
    for value in state.values():
        if not isinstance(value, dict):
            continue
        cand = value.get("photo")
        if isinstance(cand, dict) and (cand.get("caption") is not None or cand.get("mainMvUrls") or cand.get("atlas")):
            photo = cand
            holder = value
            break
        # 图集作品有时把 photo 嵌在更深一层
        for sub in value.values():
            if isinstance(sub, dict) and isinstance(sub.get("photo"), dict):
                photo, holder = sub["photo"], sub
                break
        if photo:
            break
    return photo, holder


def _atlas_images(state: dict[str, Any], photo: dict[str, Any], photo_id: str) -> list[dict[str, Any]]:
    """图集（图文作品）：atlas.list 是相对路径，cdn 是主机列表。

    这是参照 OmniDownloader 对快手图集的处理（MIT）：`atlas.cdnList[].cdn` 和
    `atlas.cdn` 都可能是主机，取第一个看起来合法的 CDN 域名拼上去。
    """
    atlas = photo.get("atlas") or {}
    if not isinstance(atlas, dict):
        return []
    # 有些情况下 atlas 挂在外层（photo 的兄弟节点），再兜一层
    if not atlas.get("list"):
        for value in state.values():
            if isinstance(value, dict) and isinstance(value.get("atlas"), dict) and value["atlas"].get("list"):
                if str(value.get("photoId") or photo_id) == photo_id:
                    atlas = value["atlas"]
                    break
    items = atlas.get("list") or []
    if not items:
        return []

    cdns = [str(i.get("cdn") or "") for i in (atlas.get("cdnList") or []) if isinstance(i, dict)]
    cdns += [str(c) for c in (atlas.get("cdn") or []) if isinstance(c, str)]
    host = next(
        (h for h in cdns if re.fullmatch(r"[a-zA-Z0-9.-]+", h)
         and h.endswith((".yximgs.com", ".kwaicdn.com", ".kwimgs.com"))),
        "",
    )
    sizes = atlas.get("size") or []
    out: list[dict[str, Any]] = []
    for index, src in enumerate(items):
        if not isinstance(src, str):
            continue
        url = ("https://" + host + src) if (src.startswith("/") and host) else src
        if not url.startswith("http"):
            continue
        size = sizes[index] if index < len(sizes) and isinstance(sizes[index], dict) else {}
        out.append({
            "url": url,
            "thumb": url,
            "width": int(size.get("w") or 0),
            "height": int(size.get("h") or 0),
            "caption": "",
        })
    return out


def _duration_text(ms: Any) -> str:
    try:
        total = int(ms) // 1000
    except (TypeError, ValueError):
        return ""
    if total <= 0:
        return ""
    return f"{total // 60:02d}:{total % 60:02d}"


@register
class KuaishouAdapter(PlatformAdapter):
    platform_id = "kuaishou"
    display_name = "快手"
    url_patterns = [
        re.compile(r"kuaishou\.com/(?:short-video|photo|f)/[a-zA-Z0-9_-]+"),
        re.compile(r"v\.kuaishou\.com/[a-zA-Z0-9_-]+"),
        re.compile(r"(?:chenzhongtech|gifshow)\.com/"),
        re.compile(r"k\.kwai\.com/|short\.kwai\.com/"),
    ]
    enabled_by_default = False
    needs_login_for_full = False

    def _load(self, source: str) -> dict[str, Any]:
        """抓页面并解析成 {photoId, photo, author, html, finalUrl}。

        两条路，顺序很重要：移动页优先。桌面页在同一个 IP 上第一次访问
        会给完整 SSR，第二次开始就降级成骨架页（实测），而移动页不降级。
        """
        cached = _PAGE_CACHE.get(source)
        if cached and (time.monotonic() - cached[0]) < _CACHE_TTL:
            return cached[1]

        photo_id = extract_photo_id(source)
        mobile_error = ""

        # ── 主路：移动页 INIT_STATE ──
        if not photo_id:
            # 短链靠重定向落地；顺手留下桌面页 HTML，下面兜底还能用
            try:
                with httpx.Client(timeout=25, headers=HEADERS, follow_redirects=True) as client:
                    resp = client.get(source)
                    resp.raise_for_status()
                photo_id = extract_photo_id(str(resp.url))
                desktop_html = resp.text
            except Exception as exc:  # noqa: BLE001
                desktop_html = ""
                mobile_error = f"短链解析失败：{exc}"
        else:
            desktop_html = ""

        if not photo_id:
            raise RuntimeError(
                mobile_error or f"快手链接没有落到作品页（{source[:100]}）。短链可能已过期，或者分享的不是单个作品。"
            )

        try:
            mobile_url = f"https://v.m.chenzhongtech.com/fw/photo/{photo_id}"
            with httpx.Client(timeout=25, headers=MOBILE_HEADERS, follow_redirects=True) as client:
                mr = client.get(mobile_url)
                mr.raise_for_status()
            mstate = parse_init_state(mr.text)
            photo, holder = _find_photo_nodes(mstate) if mstate else ({}, {})
            if photo:
                data = {
                    "photoId": photo_id,
                    "photo": photo,
                    "atlas_holder": holder,
                    "author": {"name": str(photo.get("userName") or "")},
                    "finalUrl": mobile_url,
                    "origin": "mobile",
                }
                _PAGE_CACHE[source] = (time.monotonic(), data)
                if len(_PAGE_CACHE) > 32:
                    _PAGE_CACHE.clear()
                return data
            mobile_error = "移动页里没找到 photo 节点"
        except Exception as exc:  # noqa: BLE001 - 移动页失败就降级到桌面页
            mobile_error = f"移动页失败：{exc}"

        # ── 兜底：桌面页 APOLLO_STATE ──
        try:
            if not desktop_html:
                with httpx.Client(timeout=25, headers=HEADERS, follow_redirects=True) as client:
                    dr = client.get(f"https://www.kuaishou.com/short-video/{photo_id}")
                    dr.raise_for_status()
                desktop_html = dr.text
            state = parse_apollo(desktop_html)
            photo, author = _pick_photo(state, photo_id)
            if photo:
                data = {"photoId": photo_id, "photo": photo, "atlas_holder": {},
                        "author": author, "finalUrl": source, "origin": "desktop"}
                _PAGE_CACHE[source] = (time.monotonic(), data)
                if len(_PAGE_CACHE) > 32:
                    _PAGE_CACHE.clear()
                return data
        except Exception as exc:  # noqa: BLE001
            desktop_html = desktop_html or ""
            raise RuntimeError(f"{mobile_error}；桌面页也失败：{exc}") from None

        raise RuntimeError(
            f"快手两条路都没拿到作品数据（{mobile_error}）。桌面页通常是降级骨架页——"
            "带登录态（--login kuaishou）或者换个网络再试。"
        )

    def search(self, keyword: str, *, limit: int = 10, sort: int = 0, page: int = 1) -> list[SearchResult]:
        # 快手搜索页是纯前端渲染，graphql 接口要 did/cookie 签名，先不做。
        return []

    def get_item(self, source: str, *, page: int = 0) -> dict[str, Any]:
        try:
            data = self._load(source)
        except Exception as exc:  # noqa: BLE001 - 采集失败要变成结构化结果
            return {"ok": False, "platform": "kuaishou", "error": str(exc)[:300]}

        photo = data["photo"]
        author = data["author"]
        photo_id = data["photoId"]

        caption = str(photo.get("caption") or "").strip()
        images = _atlas_images(data.get("atlas_holder") or {}, photo, photo_id)

        # 视频直链：移动页在 mainMvUrls[]，桌面页在 photoUrl。两边都认。
        video_url = str(photo.get("photoUrl") or "").strip()
        if not video_url:
            mvs = photo.get("mainMvUrls") or []
            if isinstance(mvs, list) and mvs and isinstance(mvs[0], dict):
                video_url = str(mvs[0].get("url") or "")

        # 封面：移动页 coverUrls[].url，桌面页 coverUrl
        cover = str(photo.get("coverUrl") or "").strip()
        if not cover:
            covers = photo.get("coverUrls") or []
            if isinstance(covers, list) and covers and isinstance(covers[0], dict):
                cover = str(covers[0].get("url") or "")

        media_sources: list[dict[str, Any]] = []
        if video_url.startswith("http"):
            media_sources.append({
                "type": "video",
                "url": video_url,
                # 快手 CDN 有的节点要 Referer，有的不校验；带上更稳
                "headers": {"User-Agent": MOBILE_UA, "Referer": "https://www.kuaishou.com/"},
                "height": int(photo.get("height") or 0),
                "width": int(photo.get("width") or 0),
                "bytes": 0,
            })

        is_image_post = bool(images) and not media_sources
        if not media_sources and not images:
            return {
                "ok": False,
                "platform": "kuaishou",
                "item_id": photo_id,
                "error": "快手作品里既没有视频直链也没有图集（可能是直播回放或权限作品）",
            }

        return {
            "ok": True,
            "platform": "kuaishou",
            "item_id": photo_id,
            "url": f"https://www.kuaishou.com/short-video/{photo_id}",
            "title": caption[:120] or f"快手作品_{photo_id}",
            "author": str(author.get("name") or photo.get("userName") or ""),
            "cover": cover,
            "content": caption,
            "description": caption,
            "textKind": "article",
            "durationText": _duration_text(photo.get("duration")),
            "durationSec": int(int(photo.get("duration") or 0) / 1000),
            "images": images,
            "imageCount": len(images),
            "isImagePost": is_image_post,
            "mediaSources": media_sources,
            "hasVideo": bool(media_sources),
            "stats": {
                "like": _num(photo.get("likeCount")),
                "comment": _num(photo.get("commentCount")),
                "view": _num(photo.get("viewCount")),
            },
        }

    def get_comments(self, source: str, *, limit: int = 50, max_depth: int = 3,
                     with_sub_comments: bool = True) -> list[CommentNode]:
        # 快手评论走 graphql（visionVideoDetailCommentList），需要 did + 签名。
        # 和抖音同样的处境：公开接口拿不到，硬做就是每天跟签名打架。
        return []


def _num(v: Any) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0
