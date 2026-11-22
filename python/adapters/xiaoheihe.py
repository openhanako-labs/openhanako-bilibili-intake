"""小黑盒 (Xiaoheihe / Heybox) adapter — 帖子 API + hkey v2 签名。

为什么单独写一个而不是抄 OmniDownloader：它那边抓小黑盒要靠"内置浏览器点开
再嗅探"，因为它把解析建立在 WebView 上。小黑盒的 API 其实只要一个 hkey v2
签名就能直连，一次请求拿到正文、配图、作者、评论——比开浏览器快两个数量级，
也省掉一个 Playwright 依赖。

hkey v2 签名算法移植自 butlanys/xiaoheihe-telegraph-bot（MIT），
原实现参考 luckylca/xhhBackCrack。算法要点：
  timestamp / 规范化路径 / nonce 三个分量各自按 KEY_STR 做字符映射，
  交错取前 20 字符做 MD5，再取 MD5 前 5 位映射成 28 字符的前缀、
  后 6 位的字节混淆和取模 100 得到 2 位后缀。
实测 2026-11-21 有效。

图片原图规则（实测）：URL 去掉 `?imageMogr2/...` 这段 mogrify 参数即为原图。
带参数是 726x1450 的缩略图，去参数是 1080x2156 的原图——宽度差一倍以上，
所以想留档必须去参数，否则存下来的全是糊的。

未实测的部分：视频帖。手头只有图文帖样本，`has_video=1` 的 link 里挂视频
直链的字段名没法确认，所以对视频走「递归找 .mp4/.m3u8」的宽容解析，
遇到真实样本再收紧。
"""
from __future__ import annotations

import hashlib
import json
import random
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

# ============================================================
# hkey v2 签名
# ============================================================

KEY_STR = "AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89"


def _vm(n: int) -> int:
    """字节混淆：高位为 1 时左移后异或 27，结果截到 8 位。"""
    return 255 & ((n << 1) ^ 27) if (n & 128) else n << 1


def _qm(n: int) -> int:
    return _vm(n) ^ n


def _dm(n: int) -> int:
    return _qm(_vm(n))


def _ym(n: int) -> int:
    return _dm(_qm(_vm(n)))


def _gm(n: int) -> int:
    return _ym(n) ^ _dm(n) ^ _qm(n)


def _mix(e: list[int]) -> list[int]:
    t = [0] * 6
    t[0] = _gm(e[0]) ^ _ym(e[1]) ^ _dm(e[2]) ^ _qm(e[3])
    t[1] = _qm(e[0]) ^ _gm(e[1]) ^ _ym(e[2]) ^ _dm(e[3])
    t[2] = _dm(e[0]) ^ _qm(e[1]) ^ _gm(e[2]) ^ _ym(e[3])
    t[3] = _ym(e[0]) ^ _dm(e[1]) ^ _qm(e[2]) ^ _gm(e[3])
    t[4] = e[4] if len(e) > 4 else 0
    t[5] = e[5] if len(e) > 5 else 0
    return t


def _av(s: str, key: str, n: int) -> str:
    """按 key[:len+n] 那张表逐字符映射（n 为负，即砍掉尾部）。"""
    idx = key[: len(key) + n]
    return "".join(idx[ord(ch) % len(idx)] for ch in s)


def _sv(s: str, key: str) -> str:
    return "".join(key[ord(ch) % len(key)] for ch in s)


def _interleave(parts: list[str]) -> str:
    """三个分量按位交错：p1[0] p2[0] p3[0] p1[1] ..."""
    out: list[str] = []
    for i in range(max(len(p) for p in parts)):
        for p in parts:
            if i < len(p):
                out.append(p[i])
    return "".join(out)


def make_hkey(path: str, timestamp: int = 0, nonce: str = "") -> tuple[str, int, str]:
    """返回 (hkey, timestamp, nonce)。"""
    if not timestamp:
        timestamp = int(time.time())
    if not nonce:
        nonce = hashlib.md5(f"{timestamp}{random.random()}".encode()).hexdigest().upper()

    # 路径规范化：去掉空段后前后补斜杠，`/bbs/app/link/tree` → `/bbs/app/link/tree/`
    segs = [p for p in path.split("/") if p]
    normalized = "/" + "/".join(segs) + "/"

    interleaved = _interleave([
        _av(str(timestamp), KEY_STR, -2),
        _sv(normalized, KEY_STR),
        _sv(nonce, KEY_STR),
    ])
    digest = hashlib.md5(interleaved[:20].encode()).hexdigest()
    prefix = _av(digest[:5], KEY_STR, -4)
    checksum = sum(_mix([ord(c) for c in digest[-6:]])) % 100
    return prefix + f"{checksum:02d}", timestamp, nonce


# ============================================================
# HTTP
# ============================================================

API_BASE = "https://api.xiaoheihe.cn"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Origin": "https://www.xiaoheihe.cn",
    "Referer": "https://www.xiaoheihe.cn/",
    "User-Agent": UA,
}

# 图片域名有三个已知前缀（imgheybox1/2/3.max-c.com），统一当通配：
# 下载时走同一份 header 就行，不需要按域名分支。
_IMG_MOGR = re.compile(r"\?imageMogr2.*$", re.IGNORECASE)


def original_image(url: str) -> str:
    """去掉 mogrify 参数拿原图（实测宽度差一倍以上）。"""
    if not url:
        return ""
    return _IMG_MOGR.sub("", url)


def _api_get(path: str, extra: dict[str, Any] | None = None, timeout: float = 20.0) -> dict[str, Any]:
    # ⭐ 节流：小黑盒有频率风控，实测连续十来次请求后会回 `status: show_captcha`，
    #   之后一段时间**所有**请求都只回这个。不是 IP 永久封，但恢复要等。
    #   进程级最小间隔 + 同一进程内不并发，是成本最低的那道防护。
    global _last_request_at
    wait = _MIN_INTERVAL - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.monotonic()

    hkey, ts, nonce = make_hkey(path)
    params: dict[str, Any] = {
        "os_type": "web",
        "app": "heybox",
        "client_type": "web",
        "version": "999.0.4",
        "web_version": "3.0",
        "x_client_type": "web",
        "x_app": "heybox_website",
        "heybox_id": "",
        "x_os_type": "Windows",
        "device_info": "Chrome",
        "device_id": "0" * 32,
        "hkey": hkey,
        "_time": str(ts),
        "nonce": nonce,
    }
    if extra:
        params.update(extra)
    with httpx.Client(timeout=timeout, headers=HEADERS, follow_redirects=True) as client:
        r = client.get(API_BASE + path, params=params)
        r.raise_for_status()
        data = r.json()
    # 风控信号单独拎出来：含糊的“没有 link 字段”会把人带向“链接错了”的错误方向。
    if str(data.get("status") or "") == "show_captcha":
        raise RuntimeError(
            "小黑盒触发了风控验证（show_captcha）：短时间内请求过多。等几分钟到十几分钟再试，"
            "或在浏览器里打开 www.xiaoheihe.cn 过一次验证。"
        )
    return data


# 同一帖子 get_item + get_comments 会各请求一次 tree 接口；缓存一下就把请求数减半。
# TTL 不用长 —— 评论是活的，但 2 分钟内重复采集没有意义。
_TREE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_TREE_TTL = 120.0
_last_request_at = 0.0
_MIN_INTERVAL = 1.5


# ============================================================
# 富文本解析
# ============================================================

_MEDIA_EXT = re.compile(r"\.(?:mp4|m3u8|m4v|webm)(?:\?|$)", re.IGNORECASE)


def _walk_media(obj: Any, out: list[str], depth: int = 0) -> None:
    """宽容地在任意嵌套里找视频直链（视频帖字段未实测，先这样兜）。

    只认看起来像媒体文件后缀的 http(s) 地址，避免把 API 地址当视频。
    """
    if depth > 6:
        return
    if isinstance(obj, dict):
        for v in obj.values():
            _walk_media(v, out, depth + 1)
    elif isinstance(obj, list):
        for v in obj:
            _walk_media(v, out, depth + 1)
    elif isinstance(obj, str):
        if obj.startswith("http") and _MEDIA_EXT.search(obj) and obj not in out:
            out.append(obj)


def parse_rich_text(raw: Any) -> dict[str, Any]:
    """把帖子的 `text` 解析成 {plain, images, videos}。

    `text` 是一个 JSON 字符串，形如
      [{"type":"text","text":"..."},{"type":"img","url":"...","width":"306","height":"611"}]
    纯文本帖可能直接是普通字符串——两可都吃。

    ⚠️ 评论里的 text 也是同一套结构（有时是空串 + imgs 单独挂），所以这个
    函数两处共用。
    """
    plain_parts: list[str] = []
    images: list[dict[str, Any]] = []
    videos: list[str] = []

    nodes: list[Any] = []
    if isinstance(raw, str):
        s = raw.strip()
        if s.startswith("[") or s.startswith("{"):
            try:
                parsed = json.loads(s)
                nodes = parsed if isinstance(parsed, list) else [parsed]
            except (json.JSONDecodeError, ValueError):
                plain_parts.append(s)
        elif s:
            plain_parts.append(s)
    elif isinstance(raw, list):
        nodes = raw

    for node in nodes:
        if not isinstance(node, dict):
            continue
        ntype = str(node.get("type") or "").lower()
        if ntype == "img" or node.get("url") and ntype in ("image", "picture"):
            url = original_image(str(node.get("url") or ""))
            if url:
                images.append({
                    "url": url,
                    "thumb": str(node.get("url") or ""),
                    # ⚠️ API 给的 width/height 是**缩略图显示尺寸**，不是原图尺寸
                    #   （实测：API 报 306x611，原图 1080x2156，比例一致、数值不对）。
                    #   直接把这两个数当尺寸用会让卡片和统计全错，所以置 0 表示未知，
                    #   让下游下载后自己探测。原值留在 apiWidth/apiHeight 备查。
                    "width": 0,
                    "height": 0,
                    "apiWidth": _int(node.get("width")),
                    "apiHeight": _int(node.get("height")),
                    # 富文本里的 img 节点没有标题，用 alt/desc 兜一下
                    "caption": str(node.get("text") or node.get("alt") or ""),
                })
        elif ntype in ("video", "movie"):
            for key in ("url", "video_url", "src"):
                v = node.get(key)
                if isinstance(v, str) and v.startswith("http"):
                    videos.append(v)
        else:
            txt = node.get("text")
            if isinstance(txt, str) and txt.strip():
                plain_parts.append(txt)

    if not videos:
        _walk_media(nodes, videos)

    return {
        "plain": "\n".join(p for p in plain_parts if p).strip(),
        "images": images,
        "videos": videos,
    }


def _int(v: Any) -> int:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return 0


# ============================================================
# URL 解析
# ============================================================

# 小黑盒的分享短链是 hex（37af72cc35fb），老格式和接口链接是十进制 linkid。
_ID_PATTERNS = (
    re.compile(r"xiaoheihe\.cn/(?:app/)?bbs/link/([0-9a-fA-F]{6,})"),
    re.compile(r"xiaoheihe\.cn/bbs/app/link/([0-9]+)"),
    re.compile(r"[?&]link_id=([0-9a-zA-Z]+)"),
    re.compile(r"^([0-9a-fA-F]{12})$"),
    re.compile(r"^(\d{6,})$"),
)


def extract_link_id(source: str) -> str:
    text = (source or "").strip()
    for pat in _ID_PATTERNS:
        m = pat.search(text)
        if m:
            return m.group(1)
    return ""


# ============================================================
# Adapter
# ============================================================

@register
class XiaoheiheAdapter(PlatformAdapter):
    platform_id = "xiaoheihe"
    display_name = "小黑盒"
    url_patterns = [
        re.compile(r"xiaoheihe\.cn/(?:app/)?bbs/link/[0-9a-fA-F]+"),
        re.compile(r"xiaoheihe\.cn/bbs/app/link/\d+"),
        re.compile(r"api\.xiaoheihe\.cn/.*link_id=[0-9a-zA-Z]+"),
        re.compile(r"^[0-9a-fA-F]{12}$"),
    ]
    enabled_by_default = False
    # 公开帖子不用登录也能读；登录能多拿到关注态的完整楼层。
    needs_login_for_full = False

    # ---- 内部 ----

    def _fetch_tree(self, link_id: str, comment_limit: int = 0) -> dict[str, Any]:
        cache_key = link_id
        hit = _TREE_CACHE.get(cache_key)
        if hit and (time.monotonic() - hit[0]) < _TREE_TTL:
            return hit[1]

        extra: dict[str, Any] = {"link_id": link_id}
        # ⭐ limit 是评论楼的「楼层数」参数，不传时接口只回 1 层（实测）。
        #   一次最多给 50 层就够总结了，再多也没人看。
        if comment_limit:
            extra["limit"] = max(1, min(int(comment_limit), 50))
        data = _api_get("/bbs/app/link/tree", extra)
        if str(data.get("status") or "") == "failed":
            raise RuntimeError(f"小黑盒接口返回失败：{data.get('msg') or '未知原因'}")
        result = data.get("result") or {}
        if not result.get("link"):
            raise RuntimeError(
                f"小黑盒返回里没有 link 字段（status={data.get('status')!r}），可能是链接已删除、"
                "需要登录，或风控。"
            )
        _TREE_CACHE[cache_key] = (time.monotonic(), result)
        if len(_TREE_CACHE) > 32:
            _TREE_CACHE.clear()
        return result

    # ---- PlatformAdapter ----

    def search(self, keyword: str, *, limit: int = 10, sort: int = 0, page: int = 1) -> list[SearchResult]:
        # 搜索接口（/bbs/app/link/search）在 web 版 404，/bbs/app/link/list 要新版
        # 客户端参数。先不做，返回空而不是抛——collector 会把空列表当"没搜到"。
        return []

    def get_item(self, source: str, *, page: int = 0) -> dict[str, Any]:
        link_id = extract_link_id(source)
        if not link_id:
            return {
                "ok": False,
                "platform": "xiaoheihe",
                "error": "无法从链接里认出小黑盒帖子 ID（支持 /app/bbs/link/<id>、/bbs/app/link/<id>、?link_id=<id>）",
            }

        try:
            result = self._fetch_tree(link_id)
        except Exception as exc:  # noqa: BLE001 - 采集失败要变成结构化结果，不是崩掉
            return {"ok": False, "platform": "xiaoheihe", "item_id": link_id, "error": str(exc)[:300]}

        link = result.get("link") or {}
        body = parse_rich_text(link.get("text"))
        user = link.get("user") or {}

        # 正文为空但 description 有内容时（部分帖子只填简介）用它兜底
        content = body["plain"] or str(link.get("description") or "").strip()

        videos = list(body["videos"])
        _walk_media({k: v for k, v in link.items() if k not in ("text", "feedback", "feedback_config")}, videos)

        images = body["images"]
        # 封面图（帖子只有一张图时，link 里可能还有独立封面字段）
        cover = ""
        for key in ("thumb", "share_image", "cover"):
            cand = link.get(key)
            if isinstance(cand, str) and cand.startswith("http"):
                cover = original_image(cand)
                break
        if not cover and images:
            cover = images[0]["url"]

        topics = [t.get("name") for t in (link.get("topics") or []) if isinstance(t, dict) and t.get("name")]
        hashtags = [h.get("name") for h in (link.get("hashtags") or []) if isinstance(h, dict) and h.get("name")]

        return {
            "ok": True,
            "platform": "xiaoheihe",
            "item_id": str(link.get("linkid") or link_id),
            "url": f"https://www.xiaoheihe.cn/app/bbs/link/{link_id}",
            "title": str(link.get("title") or "").strip() or (content[:40] if content else "小黑盒帖子"),
            "author": str(user.get("username") or ""),
            "author_id": str(user.get("userid") or ""),
            "author_avatar": str(user.get("avatar") or ""),
            "cover": cover,
            "content": content,
            "description": str(link.get("description") or ""),
            # 图文帖没有时间轴，锚点走 article（字符坐标）——和知乎/公众号同一套
            "textKind": "article",
            "images": images,
            "imageCount": len(images),
            "mediaSources": [
                {"type": "video", "url": u, "headers": {"Referer": "https://www.xiaoheihe.cn/", "User-Agent": UA}}
                for u in dict.fromkeys(videos)
            ],
            "hasVideo": bool(videos),
            "stats": {
                "like": _int(link.get("link_award_num")),
                "favour": _int(link.get("favour_count")),
                "comment": _int(link.get("comment_num")),
                "view": _int(link.get("click")),
            },
            "createTime": _int(link.get("create_at")),
            "ipLocation": str(link.get("ip_location") or ""),
            "topics": topics,
            "hashtags": hashtags,
            "isArticle": bool(link.get("is_article")),
        }

    def get_comments(self, source: str, *, limit: int = 50, max_depth: int = 3,
                     with_sub_comments: bool = True) -> list[CommentNode]:
        link_id = extract_link_id(source)
        if not link_id:
            return []
        try:
            result = self._fetch_tree(link_id, comment_limit=limit)
        except Exception:  # noqa: BLE001 - 评论失败不该拖垮整条采集
            return []

        nodes: list[CommentNode] = []
        for floor in (result.get("comments") or []):
            replies_raw = floor.get("comment") or []
            if not replies_raw:
                continue
            main_node: CommentNode | None = None
            for raw in replies_raw:
                if not isinstance(raw, dict):
                    continue
                parsed = parse_rich_text(raw.get("text"))
                # ⭐ 评论的图片是**独立字段** raw["imgs"]]，不在 text 富文本里。
                #   纯图评论（text 为空 + imgs 有值）很常见，只解 text 会丢成空字符串。
                imgs = [dict(i) for i in parsed["images"]]
                for item_img in (raw.get("imgs") or []):
                    if not isinstance(item_img, dict):
                        continue
                    u = original_image(str(item_img.get("url") or ""))
                    if u:
                        imgs.append({"url": u, "thumb": str(item_img.get("url") or ""),
                                     "width": 0, "height": 0, "caption": ""})
                text = parsed["plain"]
                if imgs:
                    # 纯图评论：把图片地址写进正文，否则这条评论在总结里等于不存在
                    text = (text + "\n" if text else "") + "\n".join(f"[图] {i['url']}" for i in imgs)
                user = raw.get("user") or {}
                node = CommentNode(
                    rpid=str(raw.get("commentid") or ""),
                    username=str(user.get("username") or ""),
                    content=text.strip(),
                    like_count=_int(raw.get("up")),
                    ctime=_int(raw.get("create_at")),
                    level=0,
                    replies=[],
                )
                if main_node is None:
                    main_node = node
                    nodes.append(node)
                elif with_sub_comments:
                    # 同层后续条目是楼中楼
                    main_node.replies.append(node)
                if len(nodes) >= limit:
                    break
            if len(nodes) >= limit:
                break

        return nodes[:limit]
