"""Pixiv adapter — illust / 漫画 / ugoira 动图。

三条数据来源（都是公开 ajax 接口，未登录也能读公开作品）：
  /ajax/illust/<id>             作品详情（标题、作者、标签、页数、类型）
  /ajax/illust/<id>/pages       每一页的原图地址与尺寸
  /ajax/illust/<id>/ugoira_meta 动图的帧包 zip + 每帧延时

两个必须知道的约束：

1. **i.pximg.net 强制校验 Referer**。图片 URL 直接扔给浏览器/下载器会 403，
   必须带 `Referer: https://www.pixiv.net/`。所以这里每张图都挂上 headers，
   交给 collector 的 _save_post_images 原样使用。

2. **国内直连 pixiv.net 会超时**（实测 2026-11-21：WinError 10060 / ConnectTimeout）。
   所以这个 adapter 完全依赖 settings 里的 proxyUrl。没配代理时给的是
   明确的"需要代理"错误，而不是一句含糊的解析失败。

ugoira（动图）这里**不转 GIF**。它本质上是一包 jpg 帧 + 一份延时表，转 GIF
是纯展示需求，而我们要的是素材本身：存 zip、记下帧数与时延，需要动图时
下游自己用 ffmpeg 拼——不需要为了看一眼动图就把 FFmpeg 拖进依赖链。
"""
from __future__ import annotations

import re
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
# ⚠️ Referer 不是可选项：i.pximg.net 会校验它，缺了就是 403。
IMG_HEADERS = {"User-Agent": UA, "Referer": "https://www.pixiv.net/"}
API_HEADERS = {
    "User-Agent": UA,
    "Referer": "https://www.pixiv.net/",
    "Accept": "application/json",
    # 不加这条会拿到一张 HTML 的登录提示页而不是 JSON
    "x-requested-with": "XMLHttpRequest",
}

_ID_PATTERNS = (
    re.compile(r"pixiv\.net/(?:en/|zh/|ja/)?artworks/(\d+)"),
    re.compile(r"pixiv\.net/(?:en/)?member_illust\.php\?[^#]*illust_id=(\d+)"),
    re.compile(r"pixiv\.net/i/(\d+)"),
)


def extract_illust_id(source: str) -> str:
    for pat in _ID_PATTERNS:
        m = pat.search(source or "")
        if m:
            return m.group(1)
    return ""


@register
class PixivAdapter(PlatformAdapter):
    platform_id = "pixiv"
    display_name = "Pixiv"
    url_patterns = [
        re.compile(r"pixiv\.net/(?:en/|zh/|ja/)?artworks/\d+"),
        re.compile(r"pixiv\.net/(?:en/)?member_illust\.php\?.*illust_id=\d+"),
        re.compile(r"pixiv\.net/i/\d+"),
    ]
    enabled_by_default = False
    # R-18 / 限定公开的作品需要登录态；全年龄公开作品不登录也能读。
    needs_login_for_full = True

    # ---- 内部 ----

    def _client(self) -> httpx.Client:
        kwargs: dict[str, Any] = {"timeout": 25, "headers": API_HEADERS, "follow_redirects": True}
        if self.proxy:
            kwargs["proxy"] = self.proxy
        return httpx.Client(**kwargs)

    def _ajax(self, path: str) -> Any:
        try:
            with self._client() as client:
                resp = client.get("https://www.pixiv.net" + path)
                resp.raise_for_status()
                data = resp.json()
        except httpx.ConnectTimeout:
            hint = (
                f"（当前代理 {self.proxy} 也没连上，检查代理是否在跑）" if self.proxy
                else "（没配代理的话 pixiv.net 在国内直连必超时，去设置里填 proxyUrl）"
            )
            raise RuntimeError(f"连不上 pixiv.net：连接超时{hint}") from None
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Pixiv 请求失败：{type(exc).__name__}: {exc}") from None

        if isinstance(data, dict) and data.get("error"):
            msg = str(data.get("message") or "")
            if "login" in msg.lower() or "403" in msg:
                raise RuntimeError("Pixiv 需要登录态才能读这个作品（--login pixiv 后再试）")
            raise RuntimeError(f"Pixiv 返回错误：{msg[:160]}")
        return data.get("body") if isinstance(data, dict) else data

    # ---- PlatformAdapter ----

    def search(self, keyword: str, *, limit: int = 10, sort: int = 0, page: int = 1) -> list[SearchResult]:
        # /ajax/search/artworks 未登录时基本不给结果（要 cookie 里的 PHPSESSID），先不做。
        return []

    def get_item(self, source: str, *, page: int = 0) -> dict[str, Any]:
        illust_id = extract_illust_id(source)
        if not illust_id:
            return {
                "ok": False,
                "platform": "pixiv",
                "error": "无法从链接里认出 Pixiv 作品 ID（支持 /artworks/<id>、member_illust.php?illust_id=<id>、/i/<id>）",
            }

        try:
            detail = self._ajax(f"/ajax/illust/{illust_id}") or {}
        except Exception as exc:  # noqa: BLE001 - 采集失败要变成结构化结果
            return {"ok": False, "platform": "pixiv", "item_id": illust_id, "error": str(exc)[:300]}

        illust_type = int(detail.get("illustType") or 0)  # 0=插画 1=漫画 2=ugoira
        title = str(detail.get("illustTitle") or detail.get("title") or f"Pixiv_{illust_id}")
        author = str(detail.get("userName") or "")
        description = str(detail.get("description") or "")
        tags = [str(t.get("tag")) for t in ((detail.get("tags") or {}).get("tags") or []) if isinstance(t, dict)]
        page_count = int(detail.get("pageCount") or 1)
        cover = str(((detail.get("urls") or {}).get("original")) or ((detail.get("urls") or {}).get("regular")) or "")

        images: list[dict[str, Any]] = []
        ugoira: dict[str, Any] = {}

        if illust_type == 2:
            # ── 动图：帧包 zip + 延时表 ──
            try:
                meta = self._ajax(f"/ajax/illust/{illust_id}/ugoira_meta") or {}
                frames = meta.get("frames") or []
                ugoira = {
                    "zipUrl": str(meta.get("originalSrc") or meta.get("src") or ""),
                    "mimeType": str(meta.get("mime_type") or "image/jpeg"),
                    "frameCount": len(frames),
                    "frameDelays": [int(f.get("delay") or 0) for f in frames if isinstance(f, dict)],
                }
                if ugoira["zipUrl"]:
                    images.append({
                        "url": ugoira["zipUrl"],
                        "thumb": cover,
                        "width": int(detail.get("width") or 0),
                        "height": int(detail.get("height") or 0),
                        "caption": "ugoira 帧包（zip）",
                        "kind": "ugoiraZip",
                        "headers": dict(IMG_HEADERS),
                    })
            except Exception as exc:  # noqa: BLE001 - 动图信息拿不到不该让整个作品失败
                ugoira = {"error": str(exc)[:200]}
        else:
            # ── 静图 / 漫画：逐页原图 ──
            try:
                pages = self._ajax(f"/ajax/illust/{illust_id}/pages") or []
            except Exception:  # noqa: BLE001 - 退回到详情里的单图
                pages = []
            for idx, item in enumerate(pages if isinstance(pages, list) else [], 1):
                if not isinstance(item, dict):
                    continue
                urls = item.get("urls") or {}
                url = str(urls.get("original") or urls.get("regular") or "")
                if not url:
                    continue
                images.append({
                    "url": url,
                    "thumb": str(urls.get("small") or urls.get("thumb") or url),
                    "width": int(item.get("width") or 0),
                    "height": int(item.get("height") or 0),
                    "caption": f"第 {idx} 页 / 共 {page_count} 页",
                    # Referer 必须带上，否则 i.pximg.net 直接 403
                    "headers": dict(IMG_HEADERS),
                })

        kind_label = {0: "插画", 1: "漫画", 2: "动图"}.get(illust_type, "作品")
        return {
            "ok": True,
            "platform": "pixiv",
            "item_id": illust_id,
            "url": f"https://www.pixiv.net/artworks/{illust_id}",
            "title": title,
            "author": author,
            "author_id": str(detail.get("userId") or ""),
            "cover": cover,
            "content": description,
            "description": description,
            "textKind": "article",
            "tags": tags,
            "images": images,
            "imageCount": len(images),
            "mediaSources": [],
            "hasVideo": False,
            "isImagePost": True,
            "illustType": illust_type,
            "illustTypeLabel": kind_label,
            "pageCount": page_count,
            "ugoira": ugoira or None,
            "stats": {
                "like": int(detail.get("likeCount") or 0),
                "view": int(detail.get("viewCount") or 0),
                "bookmark": int(detail.get("bookmarkCount") or 0),
            },
            "createTime": str(detail.get("createDate") or ""),
        }

    def get_comments(self, source: str, *, limit: int = 50, max_depth: int = 3,
                     with_sub_comments: bool = True) -> list[CommentNode]:
        # 评论区走 /ajax/illust/<id>/comments，要登录态才有完整内容，且价值不高。
        return []
