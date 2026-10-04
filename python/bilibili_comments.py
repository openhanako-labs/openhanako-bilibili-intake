"""B 站评论取数 —— collector.py 与 adapters/bilibili.py 共用的唯一入口。

## 为什么要有这个文件

评论取数以前有两份实现：`collector.py::fetch_comments_via_api`（urllib，B 站单视频
管道走这条）和 `adapters/bilibili.py::get_comments`（httpx，adapter 分派走这条）。
两份都写死了 `/x/v2/reply`。接口一改，两边同时烂，而且烂得很安静 —— 返回 code=0、
只给 3 条，看起来像"这个视频就 3 条评论"。2026-10-04 实测：

    /x/v2/reply        带不带 cookie 都只回 3 条（page.count 却报 13）→ 已废弃
    /x/v2/reply/wbi/main + WBI 签名   20 条/页，游标翻页正常，all_count 准

## 两条硬事实（别再当成"未登录上限"）

1. **`buvid3` 会把评论接口砍到 3 条。** 同一条评论数 184111 的视频：
       无 cookie        → 20 条/页，all_count=184111
       全量浏览器 cookie → 3 条，is_end=true，all_count=4
       去掉 buvid3       → 20 条/页，all_count=184111
       只带登录态三件套  → 20 条/页
   所以 `cookies_store.py` / `settings.js` 里"评论卡在未登录的 3 条上限"那句
   旧结论已经不成立：不是登录不够，是**设备指纹 cookie 太多**。登录态该留，
   buvid 家族该在评论请求上摘掉。这里就是摘的那一刀。

2. **二级评论接口 `/x/v2/reply/reply` 没坏**（实测 20 条/页、count 准），
   不要跟着一起换 —— 新接口没有对应的 wbi/main 变体（404）。

失败时返回空列表而不是抛，交给上层降级；调用方自己决定要不要退回 yt-dlp。
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from hashlib import md5
from typing import Any, Iterable

# ------------------------------------------------------------------
# Cookie 净化
# ------------------------------------------------------------------

# 实测会把 /x/v2/reply/wbi/main 砍到 3 条的设备指纹类 cookie。
# 只出现在评论请求上；其他接口（view / search / space）照旧带全量。
COMMENT_COOKIE_DENY = frozenset({
    "buvid3",
    "buvid4",
    "buvid_fp",
    "buvid_fp_plain",
    "_uuid",
    "fingerprint",
    "rpdid",
})

# 二级评论也按同一套净化（同一套风控，留着没有代价）。
SUB_COMMENT_COOKIE_DENY = COMMENT_COOKIE_DENY


def sanitize_cookie_header(header: str, deny: Iterable[str] = COMMENT_COOKIE_DENY) -> str:
    """把 "a=1; b=2" 形式的 cookie 头里命中 deny 的项摘掉。"""
    deny_set = set(deny)
    kept = []
    for part in (header or "").split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name = part.split("=", 1)[0].strip()
        if name.lower() in {d.lower() for d in deny_set}:
            continue
        kept.append(part)
    return "; ".join(kept)


def sanitize_cookie_dict(cookies: dict[str, Any] | None,
                         deny: Iterable[str] = COMMENT_COOKIE_DENY) -> dict[str, str]:
    deny_set = {d.lower() for d in set(deny)}
    return {str(k): str(v) for k, v in (cookies or {}).items()
            if str(k).lower() not in deny_set}


def cookies_to_header(cookies: dict[str, Any] | None,
                      deny: Iterable[str] = COMMENT_COOKIE_DENY) -> str:
    return "; ".join(f"{k}={v}" for k, v in sanitize_cookie_dict(cookies, deny).items())


# ------------------------------------------------------------------
# HTTP
# ------------------------------------------------------------------

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")


def get_json(url: str, *, cookies: str = "", referer: str = "https://www.bilibili.com/",
             timeout: float = 15.0) -> dict[str, Any] | None:
    """一次 GET，拿 JSON。任何失败都返回 None（调用方按空数据处理）。

    单独抽出来是为了回归测试能在这一层挂假响应，不去打真实网络。
    """
    headers = {"User-Agent": _UA, "Referer": referer}
    if cookies:
        headers["Cookie"] = cookies
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None


# ------------------------------------------------------------------
# WBI 签名
# ------------------------------------------------------------------

_MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
]

_wbi_cache: dict[str, Any] = {"key": "", "at": 0.0}
_WBI_TTL = 6 * 3600.0


def _mixin_key() -> str:
    """取 WBI mixin key。nav 接口不需要 cookie，也不该带 cookie。"""
    now = time.time()
    if _wbi_cache["key"] and now - _wbi_cache["at"] < _WBI_TTL:
        return str(_wbi_cache["key"])
    data = get_json("https://api.bilibili.com/x/web-interface/nav",
                    referer="https://www.bilibili.com/")
    wbi = ((data or {}).get("data") or {}).get("wbi_img") or {}
    img = str(wbi.get("img_url") or "").rsplit("/", 1)[-1].split(".")[0]
    sub = str(wbi.get("sub_url") or "").rsplit("/", 1)[-1].split(".")[0]
    if not img or not sub:
        return ""
    raw = img + sub
    key = "".join(raw[i] for i in _MIXIN_KEY_ENC_TAB)
    _wbi_cache.update(key=key, at=now)
    return key


def invalidate_wbi_keys() -> None:
    """签名被拒时清缓存重取（B 站每天轮换一次，进程跑久了会撞上）。"""
    _wbi_cache.update(key="", at=0.0)


def sign_params(params: dict[str, Any]) -> dict[str, Any]:
    """给参数加 wts + w_rid。拿不到 key 就原样返回（调用方会退化到旧接口）。"""
    key = _mixin_key()
    if not key:
        return dict(params)
    p = dict(params)
    p["wts"] = int(time.time())
    items = sorted((k, "" if v is None else str(v)) for k, v in p.items())
    encoded = urllib.parse.urlencode(items, quote_via=urllib.parse.quote)
    p["w_rid"] = md5((encoded + key).encode("utf-8")).hexdigest()
    return p


def _signed_query(params: dict[str, Any]) -> str:
    return urllib.parse.urlencode(sign_params(params), quote_via=urllib.parse.quote)


# ------------------------------------------------------------------
# aid 解析
# ------------------------------------------------------------------

def resolve_aid(source: str, *, cookies: str = "") -> int | None:
    """BV / av / 完整链接 → aid（数字）。"""
    s = (source or "").strip()
    if not s:
        return None
    m = re.fullmatch(r"av(\d+)", s, re.I)
    if m:
        return int(m.group(1))
    m = re.search(r"(?:^|/)(av\d+|BV[\w=]+)", s, re.I)
    ident = m.group(1) if m else (s if re.fullmatch(r"BV[\w=]+", s, re.I) else "")
    if not ident:
        return None
    if ident.lower().startswith("av"):
        return int(ident[2:])
    data = get_json(
        "https://api.bilibili.com/x/web-interface/view?" + _signed_query({"bvid": ident}),
        cookies=cookies)
    if not data or data.get("code") != 0:
        # 签名版拿不到就退回裸参数：view 接口目前两种都认。
        data = get_json(f"https://api.bilibili.com/x/web-interface/view?bvid={ident}",
                        cookies=cookies)
    if not data or data.get("code") != 0:
        return None
    aid = ((data.get("data") or {}).get("aid"))
    try:
        return int(aid) if aid else None
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------
# 评论
# ------------------------------------------------------------------

# mode: B 站新接口只认 support_mode 里那几个，2/3 是热度系列；3 = 热门评论。
MODE_HOT = 3
MODE_NEW = 2

PAGE_SIZE = 20


def fetch_root_comments(aid: int, *, limit: int = 50, cookies: str = "", mode: int = MODE_HOT,
                        page_size: int = PAGE_SIZE, timeout: float = 15.0,
                        max_pages: int = 50) -> list[dict[str, Any]]:
    """拉一级评论的**原始节点**（B 站 replies 原样），带游标翻页。

    翻页靠 `cursor.pagination_reply.next_offset` → 下一次请求的
    `pagination_str={"offset": …}`。只传 next 也能走（它是页号），但 B 站对
    next=0/1 给的是同一页，所以这里以 offset 游标为准、next 只当辅助。

    空页时 `replies` 是 null 不是 []，一律 `or []`。
    """
    if not aid:
        return []
    cookie = sanitize_cookie_header(cookies, COMMENT_COOKIE_DENY)
    out: list[dict[str, Any]] = []
    seen: set[Any] = set()
    offset = ""
    page_no = 0
    while len(out) < limit and page_no < max_pages:
        page_no += 1
        params: dict[str, Any] = {
            "type": 1, "oid": aid, "mode": mode,
            "ps": min(page_size, limit - len(out)),
            "next": page_no - 1,
        }
        if offset:
            params["pagination_str"] = json.dumps(
                {"offset": offset}, ensure_ascii=False, separators=(",", ":"))
        data = get_json(
            "https://api.bilibili.com/x/v2/reply/wbi/main?" + _signed_query(params),
            cookies=cookie,
            referer=f"https://www.bilibili.com/video/av{aid}",
            timeout=timeout)
        if not isinstance(data, dict) or data.get("code") != 0:
            if data and data.get("code") in (-403, -352):
                invalidate_wbi_keys()
            break
        body = data.get("data") or {}
        replies = body.get("replies") or []
        if not replies:
            break
        fresh = 0
        for r in replies:
            if not isinstance(r, dict):
                continue
            rpid = r.get("rpid")
            if rpid in seen:      # 游标失效时 B 站会重发同一页，不去重就死循环
                continue
            seen.add(rpid)
            out.append(r)
            fresh += 1
        cursor = body.get("cursor") or {}
        offset = str((cursor.get("pagination_reply") or {}).get("next_offset") or "")
        if cursor.get("is_end") or not offset or fresh == 0:
            break
        time.sleep(0.35)          # 别把翻页打成连击
    return out[:limit]


def fetch_sub_comments(aid: int, root_rpid: Any, *, limit: int = 20, cookies: str = "",
                       timeout: float = 15.0) -> list[dict[str, Any]]:
    """二级评论。走 /x/v2/reply/reply —— 实测这条没坏，没有 wbi/main 变体。"""
    if not aid or root_rpid in (None, ""):
        return []
    cookie = sanitize_cookie_header(cookies, SUB_COMMENT_COOKIE_DENY)
    query = urllib.parse.urlencode({
        "type": 1, "oid": aid, "root": root_rpid, "ps": min(max(int(limit), 1), 20), "pn": 1,
    })
    data = get_json(f"https://api.bilibili.com/x/v2/reply/reply?{query}",
                    cookies=cookie,
                    referer=f"https://www.bilibili.com/video/av{aid}",
                    timeout=timeout)
    if not isinstance(data, dict) or data.get("code") != 0:
        return []
    return (data.get("data") or {}).get("replies") or []
