"""Xiaohongshu (小红书) adapter — Playwright-driven version.

Strategy: bypass the heavily rate-limited HTTP API by using a real
Chromium browser (already logged in via QR code) to fetch rendered pages.
This trades speed (3-10s per request) for reliability against 小红书's
anti-bot measures.

The adapter keeps a long-lived browser instance and reuses it across
requests. Cookies are loaded from the unified CookieStore so a previous
QR-code login is reused without re-scanning.

Note: The original HTTP-API-based search/get_item are kept as fallbacks
for cases where the browser is unavailable or cookies are missing.
"""
from __future__ import annotations

import asyncio
import re
import sys
import time
import os
from pathlib import Path
from typing import Any

from . import (
    CommentNode,
    PlatformAdapter,
    SearchResult,
    register,
)


# Lazy globals (initialized once)
_BROWSER_LOCK = asyncio.Lock() if False else None  # not used in sync API
_BROWSER_INSTANCE: Any = None
_BROWSER_CONTEXT: Any = None
_BROWSER_PAGE: Any = None
_BROWSER_COOKIES_DOMAIN = "xiaohongshu.com"
_BROWSER_INIT_TIME: float = 0.0
_BROWSER_MAX_AGE_SECONDS = 1800  # 30 min auto-restart


# ============================================================
# Adapter
# ============================================================

@register
class XhsAdapter(PlatformAdapter):
    platform_id = "xhs"
    display_name = "小红书"
    url_patterns = [
        re.compile(r"xiaohongshu\.com/(?:explore|discovery/item)/([a-f0-9]+)", re.IGNORECASE),
        re.compile(r"xhslink\.com/[a-zA-Z0-9/]+"),
        re.compile(r"^([a-f0-9]{20,24})$"),
    ]
    enabled_by_default = True
    needs_login_for_full = True

    # ---- Playwright helpers (sync wrapper around async) ----

    def _run(self, coro):
        """Run an async coroutine from a sync context."""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # We're in an async context — should not happen for sync API
                raise RuntimeError("XhsAdapter sync API called from async context")
        except RuntimeError:
            loop = None
        if loop is None:
            return asyncio.run(coro)
        # If loop exists but not running, use it
        return loop.run_until_complete(coro)

    def _ensure_browser(self):
        """Get or create the persistent browser + page.

        Returns (browser, context, page) tuple.
        """
        global _BROWSER_INSTANCE, _BROWSER_CONTEXT, _BROWSER_PAGE, _BROWSER_INIT_TIME

        now = time.time()
        if (_BROWSER_INSTANCE is not None
            and (now - _BROWSER_INIT_TIME) < _BROWSER_MAX_AGE_SECONDS):
            return _BROWSER_INSTANCE, _BROWSER_CONTEXT, _BROWSER_PAGE

        # Restart
        self._close_browser_silent()
        return self._start_browser()

    def _start_browser(self):
        global _BROWSER_INSTANCE, _BROWSER_CONTEXT, _BROWSER_PAGE, _BROWSER_INIT_TIME
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise RuntimeError(
                "Playwright is required for xhs Playwright adapter. "
                "Run: test-env\\Scripts\\python.exe -m playwright install chromium"
            ) from exc

        # Load cookies to inject into a fresh context
        cookies = self.load_cookies()
        if not cookies:
            raise RuntimeError(
                "小红书 Playwright adapter 需要 cookies。请先 --login xhs。"
            )

        playwright_cookies = []
        for name, value in cookies.items():
            playwright_cookies.append({
                "name": name,
                "value": value,
                "domain": ".xiaohongshu.com",
                "path": "/",
            })

        # Try to load the actual user-agent from bundle (set during login)
        user_agent = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        )

        # ⚠️ 2026-09-26：**必须先把临时目录指到 app-data 里面**，否则宿主沙箱会拒掉整个 launch：
        #   "BrowserType.launch: Access to this API has been restricted. Use --allow-fs-write to
        #    manage permissions."（实测：四个候选 exe/channel/bundled 报的是**同一句** ——
        #    说明不是"哪个浏览器"的问题，而是 Playwright 要往系统临时目录写 profile，
        #    而沙箱只允许写 app-data。）
        #   登录那条流程加了这个重定向之后权限报错就消失了 —— 这里是同一个坑，之前漏了。
        try:
            _tmp = Path(str(self.cookies_dir)).parent / "py-tmp"
            _tmp.mkdir(parents=True, exist_ok=True)
            os.environ["TEMP"] = str(_tmp)
            os.environ["TMP"] = str(_tmp)
            os.environ["TMPDIR"] = str(_tmp)
        except Exception:
            pass

        # ⭐ 2026-09-26（实证闭环）：宿主的 App 进程带 --permission，而 **Node 会把权限旗标
        #   注入每个子进程的 NODE_OPTIONS**。Playwright 的 driver 是 Node 进程 → 被限死：
        #   exe 明明存在也读不到、临时目录也写不了，报
        #   "BrowserType.launch: Access to this API has been restricted. Use --allow-fs-write..."。
        #   Python 不在 Node 权限模型里 → 摘掉这个变量，driver 就自由了。
        #   自检探针实测：同一个沙箱内，pop 掉之后 chromium LAUNCH OK。
        os.environ.pop("NODE_OPTIONS", None)
        playwright = sync_playwright().start()
        # ⚠️ 2026-09-26：**必须**指定可执行文件。不指定时 Playwright 会去找自带的
        #   chromium_headless_shell（本机没装 → "Executable doesn't exist at ...
        #   chromium_headless_shell-1234\chrome-headless-shell.exe"），而 channel 又靠注册表。
        #   顺序：系统 Chrome / Edge 的可执行文件 → channel → 自带。
        _browser = None
        _errs = []
        _bases = [os.environ.get("ProgramFiles") or "C:/Program Files", "C:/Program Files (x86)"]
        _subs = ["Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"]
        _cands = []
        for _b in _bases:
            for _sub in _subs:
                _p = os.path.join(_b, _sub)
                if os.path.exists(_p):
                    _cands.append(("exe", _p))
        _cands += [("channel", "chrome"), ("channel", "msedge"), ("bundled", None)]
        for _kind, _val in _cands:
            try:
                if _kind == "exe":
                    _browser = playwright.chromium.launch(headless=True, executable_path=_val)
                elif _kind == "channel":
                    _browser = playwright.chromium.launch(headless=True, channel=_val)
                else:
                    _browser = playwright.chromium.launch(headless=True)
                break
            except Exception as _e:
                _errs.append(_kind + ":" + str(_val) + " -> " + str(_e)[:120])
        if _browser is None:
            raise RuntimeError("浏览器起不来：" + " | ".join(_errs))
        _BROWSER_INSTANCE = _browser
        _BROWSER_CONTEXT = _BROWSER_INSTANCE.new_context(
            user_agent=user_agent,
            viewport={"width": 1280, "height": 800},
            locale="zh-CN",
        )
        # Inject cookies (must be done before any navigation)
        _BROWSER_CONTEXT.add_cookies(playwright_cookies)
        _BROWSER_PAGE = _BROWSER_CONTEXT.new_page()
        _BROWSER_INIT_TIME = time.time()
        print(f"[xhs-pw] browser started with {len(playwright_cookies)} cookies", file=sys.stderr)
        return _BROWSER_INSTANCE, _BROWSER_CONTEXT, _BROWSER_PAGE

    def _close_browser_silent(self):
        global _BROWSER_INSTANCE, _BROWSER_CONTEXT, _BROWSER_PAGE, _BROWSER_INIT_TIME
        try:
            if _BROWSER_CONTEXT is not None:
                _BROWSER_CONTEXT.close()
        except Exception:
            pass
        try:
            if _BROWSER_INSTANCE is not None:
                _BROWSER_INSTANCE.close()
        except Exception:
            pass
        _BROWSER_INSTANCE = None
        _BROWSER_CONTEXT = None
        _BROWSER_PAGE = None
        _BROWSER_INIT_TIME = 0.0

    # ---- Public API: search / get_item / comments ----

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
        try:
            _, _, page_obj = self._ensure_browser()
        except Exception as exc:
            print(f"[xhs-pw] browser init failed: {exc}", file=sys.stderr)
            return []

        # 小红书搜索 URL
        sort_map = {0: "general", 1: "popular_descending", 2: "time_descending", 3: "comment_descending"}
        sort_value = sort_map.get(sort, "general")
        url = (
            f"https://www.xiaohongshu.com/search_result"
            f"?keyword={keyword}&source=web_explore_feed"
            f"&sort={sort_value}&page={page}"
        )
        try:
            page_obj.goto(url, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            print(f"[xhs-pw] search navigate failed: {exc}", file=sys.stderr)
            return []

        # 等待搜索结果出现
        try:
            page_obj.wait_for_selector("section.note-item", timeout=10000)
        except Exception:
            # 备用：直接拿全部 anchors
            pass

        # 滚动加载更多（小红书 SPA 懒加载）
        for _ in range(2):
            page_obj.evaluate("window.scrollBy(0, window.innerHeight * 2)")
            time.sleep(1)

        # 解析卡片
        try:
            cards = page_obj.query_selector_all("section.note-item")
        except Exception:
            cards = []

        results: list[SearchResult] = []
        for card in cards[:limit]:
            try:
                # 链接里包含 note id
                link = card.query_selector("a.cover")
                if link is None:
                    link = card.query_selector("a")
                href = link.get_attribute("href") if link else ""
                m = re.search(r"/(?:explore|search_result)/([a-f0-9]+)", href or "")
                if not m:
                    continue
                note_id = m.group(1)

                title_el = card.query_selector(".title span") or card.query_selector(".title")
                title = title_el.inner_text().strip() if title_el else ""

                author_el = card.query_selector(".author .name") or card.query_selector(".author")
                author = author_el.inner_text().strip() if author_el else ""

                like_el = card.query_selector(".like-wrapper .count") or card.query_selector(".interaction-info span:first-child")
                like_text = like_el.inner_text().strip() if like_el else "0"
                like_count = _parse_count(like_text)

                results.append(SearchResult(
                    platform="xhs",
                    item_id=note_id,
                    title=title,
                    author=author,
                    url=f"https://www.xiaohongshu.com/explore/{note_id}",
                    like_count=like_count,
                    extra={"source": "playwright"},
                ))
            except Exception:
                continue
        return results

    def get_item(
        self,
        source: str,
        *,
        page: int = 0,
    ) -> dict[str, Any]:
        note_id = self._extract_note_id(source)
        if not note_id:
            return {"ok": False, "error": "invalid note source", "platform": "xhs"}

        try:
            _, _, page_obj = self._ensure_browser()
        except Exception as exc:
            return {"ok": False, "error": f"browser: {exc}", "platform": "xhs", "needs_login": True}

        # ⚠️ 2026-09-26：**别丢掉 xsec_token**。原来一律用 note_id 重建 URL，
        #   而 xhs 对很多笔记要求带 xsec_token，不带就渲染成"当前笔记暂时无法浏览"，
        #   正文 / 图片 / 视频全空（实测踩到）。用户给的原链接里本来就有 token，直接用。
        _src = str(source or "")
        if _src.startswith("http") and ("xiaohongshu.com" in _src or "xhslink.com" in _src):
            url = _src
        else:
            url = f"https://www.xiaohongshu.com/explore/{note_id}"
        try:
            page_obj.goto(url, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            return {"ok": False, "error": f"navigate: {exc}", "platform": "xhs"}

        # 等待内容加载
        try:
            page_obj.wait_for_selector("#noteContainer, .note-content, .interaction-info", timeout=10000)
        except Exception:
            pass

        # 拿标题、作者、正文、图片、点赞数
        try:
            data = page_obj.evaluate("""() => {
                const $ = (s) => document.querySelector(s);
                const $$ = (s) => Array.from(document.querySelectorAll(s));
                const text = (el) => el ? el.innerText.trim() : '';
                const title = text($('#detail-title') || $('.title') || $('h1'));
                const desc = text($('#detail-desc') || $('.desc') || $('.note-content'));
                const author = text($('.author .name') || $('.user-info .username') || $('.author-wrapper .name'));
                const avatar = $('.author img')?.src || $('.user-info img')?.src || '';
                const pubDate = text($('.date') || $('.publish-date') || $('time'));
                const likesText = text($('.interaction-info .like-wrapper .count') ||
                                       $('.like-wrapper .count') ||
                                       $$('.interaction-info span')[0]);
                const collectsText = text($$('.interaction-info span')[1]);
                const commentsText = text($$('.interaction-info span')[2]);
                const images = $$('.carousel-image img, .note-content img').map(img => img.src || img.dataset.src).filter(Boolean);
                const videoSrc = $('video')?.src || $('source')?.src || '';
                // ⭐ 2026-09-26：DOM 的 src 常是 blob:（外面拿不到）。__INITIAL_STATE__ 里
                //   的 note.video.media 才有真正可下载的签名地址，一并带出来。
                let videoInfo = null;
                try {
                    const _st = window.__INITIAL_STATE__;
                    const _nd = _st && _st.note && _st.note.noteDetailMap;
                    const _first = _nd ? Object.values(_nd)[0] : null;
                    const _v = _first && _first.note && _first.note.video;
                    if (_v) videoInfo = { media: _v.media || null, consumer: _v.consumer || null, capa: _v.capa || null };
                } catch (e) { videoInfo = null; }
                return {title, desc, author, avatar, pubDate, likesText, collectsText, commentsText, images, videoSrc, videoInfo};
            }""")
        except Exception as exc:
            return {"ok": False, "error": f"evaluate: {exc}", "platform": "xhs"}

        # ⭐ 2026-09-26：抓成登录页就**别当数据用**。
        #   实测（用户当场撞到）：xhs cookie 失效时页面是「手机号登录」，标题被抓成「手机号登录」、
        #   正文变成 [object Object] —— 结果是一条**看着像采集成功**的垃圾记录。
        #   宁可明确失败：告诉调用方需要重新登录。
        _title = str(data.get("title") or "").strip()
        _desc = str(data.get("desc") or "").strip()
        _looks_like_login = (
            (not _title)
            or ("登录" in _title)
            or _title.startswith("[object")
            or ("登录" in _desc)
            or _desc.startswith("[object")
        )
        if _looks_like_login:
            return {
                "ok": False,
                "platform": "xhs",
                "needs_login": True,
                "error": (
                    "小红书返回的是登录页 / 空数据（cookie 已失效）。"
                    "请在浏览器里登录小红书，然后用 agent 工具导入 cookies："
                    "bilibili_video_intake(action=importCookies, platform=xhs, importCookies=<导出的 cookie 串>)"
                ),
            }
        return {
            "ok": True,
            "platform": "xhs",
            "note_id": note_id,
            "title": data.get("title", ""),
            "description": data.get("desc", ""),
            "author": {
                "nickname": data.get("author", ""),
                "avatar": data.get("avatar", ""),
            },
            "interact_info": {
                "likes": _parse_count(data.get("likesText", "0")),
                "collects": _parse_count(data.get("collectsText", "0")),
                "comments": _parse_count(data.get("commentsText", "0")),
            },
            "images": data.get("images", []),
            "video": {
                "url": data.get("videoSrc", ""),
                "info": data.get("videoInfo"),
            },
            "pub_date": data.get("pubDate", ""),
            "url": url,
            "_via": "playwright",
        }

    def get_comments(
        self,
        source: str,
        *,
        limit: int = 50,
        max_depth: int = 2,
        with_sub_comments: bool = True,
    ) -> list[CommentNode]:
        note_id = self._extract_note_id(source)
        if not note_id:
            return []

        try:
            _, _, page_obj = self._ensure_browser()
        except Exception as exc:
            print(f"[xhs-pw] browser init failed: {exc}", file=sys.stderr)
            return []

        # ⚠️ 2026-09-26：**别丢掉 xsec_token**。原来一律用 note_id 重建 URL，
        #   而 xhs 对很多笔记要求带 xsec_token，不带就渲染成"当前笔记暂时无法浏览"，
        #   正文 / 图片 / 视频全空（实测踩到）。用户给的原链接里本来就有 token，直接用。
        _src = str(source or "")
        if _src.startswith("http") and ("xiaohongshu.com" in _src or "xhslink.com" in _src):
            url = _src
        else:
            url = f"https://www.xiaohongshu.com/explore/{note_id}"
        try:
            page_obj.goto(url, wait_until="domcontentloaded", timeout=30000)
            page_obj.wait_for_selector(".comment-item, .comments-container, .interaction-list", timeout=10000)
        except Exception as exc:
            print(f"[xhs-pw] comments navigate failed: {exc}", file=sys.stderr)
            return []

        # 滚动加载评论
        for _ in range(3):
            page_obj.evaluate("window.scrollBy(0, window.innerHeight * 2)")
            time.sleep(1.5)

        # 解析评论
        try:
            items = page_obj.query_selector_all(".comment-item, .comment-container")
        except Exception:
            items = []

        comments: list[CommentNode] = []
        for item in items[:limit]:
            try:
                username = item.query_selector(".username, .name")
                content = item.query_selector(".content, .comment-content, .text")
                like = item.query_selector(".like-count, .count")
                # sub comments: 展开按钮
                sub = []
                # 简单实现：1 级评论
                rpid = item.get_attribute("data-id") or item.get_attribute("id") or ""
                comments.append(CommentNode(
                    rpid=rpid or str(len(comments)),
                    username=username.inner_text().strip() if username else "",
                    content=content.inner_text().strip() if content else "",
                    like_count=_parse_count(like.inner_text().strip() if like else "0"),
                    level=0,
                ))
            except Exception:
                continue
        return comments

    def get_creator(self, creator_id: str) -> dict[str, Any]:
        try:
            _, _, page_obj = self._ensure_browser()
        except Exception as exc:
            return {"ok": False, "error": str(exc), "platform": "xhs"}

        url = f"https://www.xiaohongshu.com/user/profile/{creator_id}"
        try:
            page_obj.goto(url, wait_until="domcontentloaded", timeout=30000)
            page_obj.wait_for_selector(".user-info, .user-detail", timeout=10000)
        except Exception as exc:
            return {"ok": False, "error": f"navigate: {exc}", "platform": "xhs"}

        try:
            data = page_obj.evaluate("""() => {
                const $ = (s) => document.querySelector(s);
                const text = (el) => el ? el.innerText.trim() : '';
                return {
                    nickname: text($('.user-info .username') || $('.user-detail .name')),
                    bio: text($('.user-info .desc') || $('.user-detail .desc')),
                    avatar: $('.user-info img')?.src || '',
                    fans: text($('.data-info .fans') || $('.fans .count')),
                    following: text($('.data-info .follows') || $('.follows .count')),
                    notes: text($('.data-info .notes') || $('.notes .count')),
                };
            }""")
        except Exception as exc:
            return {"ok": False, "error": f"evaluate: {exc}", "platform": "xhs"}

        return {
            "ok": True,
            "platform": "xhs",
            "creator_id": creator_id,
            "name": data.get("nickname", ""),
            "bio": data.get("bio", ""),
            "avatar": data.get("avatar", ""),
            "fans": _parse_count(data.get("fans", "0")),
            "following": _parse_count(data.get("following", "0")),
            "notes_count": _parse_count(data.get("notes", "0")),
        }

    @staticmethod
    def _extract_note_id(source: str) -> str | None:
        s = (source or "").strip()
        m = re.search(r"xiaohongshu\.com/(?:explore|discovery/item)/([a-f0-9]+)", s, re.IGNORECASE)
        if m:
            return m.group(1)
        m = re.search(r"xhslink\.com/[a-zA-Z0-9/]+", s)
        if m:
            return None
        if re.fullmatch(r"[a-f0-9]{20,24}", s):
            return s
        return None


def _parse_count(text: str) -> int:
    """Parse '1.2万' / '3,456' / '789' to int."""
    if not text:
        return 0
    t = text.replace(",", "").replace("+", "").strip()
    try:
        if "万" in t:
            return int(float(t.replace("万", "")) * 10000)
        if "亿" in t:
            return int(float(t.replace("亿", "")) * 100000000)
        return int(t)
    except Exception:
        return 0
