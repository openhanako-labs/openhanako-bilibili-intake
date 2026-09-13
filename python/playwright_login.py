"""Multi-platform interactive login via CDP (Chrome DevTools Protocol).

Connects to an existing Chrome/Edge instance with remote debugging enabled,
so users don't need to install a separate Playwright Chromium binary.

Supported flows:
  - xhs (小红书): QR-code scan
  - bilibili: QR-code scan
  - weibo: QR-code scan

Usage:
    python -c "from playwright_login import do_login; do_login('xhs', cookies_dir='./cookies')"

The login page opens as a new tab in your existing browser. After scanning,
cookies are extracted and saved to the CookieStore.

Prerequisites:
  - Chrome/Edge running with --remote-debugging-port=9222
    (or enabled at chrome://inspect/#remote-debugging)
"""
from __future__ import annotations

import asyncio
import json
import time
import urllib.request
from pathlib import Path
from typing import Any

from cookies_store import CookieStore, CookieBundle, CookieEntry


# ============================================================
# CDP constants
# ============================================================

CDP_HOST = "127.0.0.1"
CDP_PORT = 9222
CDP_TIMEOUT = 10  # seconds to wait for CDP connection


# ============================================================
# Platform login configs
# ============================================================

LOGIN_FLOWS = {
    "xhs": {
        "start_url": "https://www.xiaohongshu.com",
        "logged_in_check": "() => /a1=|web_session=|webId=/.test(document.cookie)",
        "cookie_domains": ["xiaohongshu.com", "xhslink.com"],
        "user_agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        ),
    },
    "bilibili": {
        "start_url": "https://passport.bilibili.com/login",
        "logged_in_check": "() => /DedeUserID=|SESSDATA=/.test(document.cookie)",
        "cookie_domains": ["bilibili.com", "passport.bilibili.com"],
        "user_agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        ),
    },
    "weibo": {
        "start_url": "https://passport.weibo.com/sso/signin?entry=miniblog&from=miniblog&source=miniblog",
        "logged_in_check": "() => /SUB=|SUHB=/.test(document.cookie)",
        "cookie_domains": ["weibo.com", "passport.weibo.com", "weibo.cn"],
        "user_agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        ),
    },
}


def _get_ws_endpoint() -> str | None:
    """Get the browser WebSocket debugger URL from CDP endpoint."""
    try:
        resp = urllib.request.urlopen(
            f"http://{CDP_HOST}:{CDP_PORT}/json/version",
            timeout=CDP_TIMEOUT,
        )
        data = json.loads(resp.read().decode())
        ws_url = data.get("webSocketDebuggerUrl")
        if ws_url:
            return ws_url
        # Fallback: try /json/version's webSocketDebuggerUrl
        # For newer Chrome versions (136+), the endpoint format may differ
        resp2 = urllib.request.urlopen(
            f"http://{CDP_HOST}:{CDP_PORT}/json",
            timeout=CDP_TIMEOUT,
        )
        pages = json.loads(resp2.read().decode())
        if pages and isinstance(pages, list):
            # Return first page's webSocketDebuggerUrl for connection
            # (chromium.connect_over_cdp only needs the browser-level ws)
            pass
        return None
    except Exception:
        return None


def _check_cdp_available() -> bool:
    """Quick check whether CDP port is reachable."""
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(3)
            return s.connect_ex((CDP_HOST, CDP_PORT)) == 0
    except Exception:
        return False


async def _do_login_async(
    platform: str,
    cookies_dir: str | Path,
    *,
    timeout_seconds: int = 180,
) -> CookieBundle:
    """Internal: do the login flow asynchronously via CDP."""
    cfg = LOGIN_FLOWS.get(platform)
    if cfg is None:
        raise ValueError(f"no login flow for platform: {platform}")

    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise RuntimeError("playwright package is required for interactive login") from exc

    store = CookieStore(cookies_dir)
    bundle = CookieBundle(platform=platform, source="cdp-login")

    async with async_playwright() as p:
        cdp_available = _check_cdp_available()
        ws_endpoint = _get_ws_endpoint() if cdp_available else None

        if ws_endpoint:
            # === CDP mode: connect to existing browser ===
            print(f"[login:{platform}] connecting to existing browser via CDP: {ws_endpoint}")
            browser = await p.chromium.connect_over_cdp(ws_endpoint, timeout=30000)
            # Use the default browser context (which has login state / cookies)
            contexts = browser.contexts
            if contexts:
                context = contexts[0]
                print(f"[login:{platform}] using existing browser context ({len(contexts)} context(s))")
            else:
                context = await browser.new_context(
                    user_agent=cfg["user_agent"],
                    viewport={"width": 1280, "height": 800},
                    locale="zh-CN",
                )
            page = await context.new_page()
            _using_cdp = True
        else:
            # === Fallback mode: launch standalone browser ===
            print(f"[login:{platform}] CDP not available (port {CDP_PORT}), launching standalone browser...")
            print(f"[login:{platform}] for best experience, start Chrome with:")
            print(f"    chrome --remote-debugging-port={CDP_PORT} --user-data-dir=<your-profile>")
            try:
                browser = await p.chromium.launch(headless=False, channel="chrome")
            except Exception as launch_exc:
                err_msg = str(launch_exc)
                if "Executable doesn't exist" in err_msg or "channel" in err_msg.lower():
                    print(f"[login:{platform}] Chrome channel failed ({err_msg[:80]}), trying Playwright Chromium...")
                    try:
                        browser = await p.chromium.launch(headless=False)
                    except Exception as exc2:
                        raise RuntimeError(
                            f"启动浏览器失败。Playwright Chromium 未安装或 CDP 端口不可用。\n"
                            f"方式一：启动 Chrome 后访问 chrome://inspect/#remote-debugging 启用远程调试\n"
                            f"方式二：运行 playwright install chromium 安装独立浏览器\n"
                            f"原始错误: {exc2}"
                        ) from exc2
                else:
                    raise RuntimeError(f"启动浏览器失败: {launch_exc}") from launch_exc
            context = await browser.new_context(
                user_agent=cfg["user_agent"],
                viewport={"width": 1280, "height": 800},
                locale="zh-CN",
            )
            page = await context.new_page()
            _using_cdp = False

        # === Login flow ===
        print(f"[login:{platform}] navigating to {cfg['start_url']}")
        await page.goto(cfg["start_url"], wait_until="domcontentloaded", timeout=30000)

        # Wait for the user to scan. We poll for a logged-in signal.
        print(f"[login:{platform}] waiting for QR scan (timeout {timeout_seconds}s)")
        print(f"[login:{platform}] please scan the QR code shown in the browser window")

        deadline = time.time() + timeout_seconds
        logged_in = False
        while time.time() < deadline:
            try:
                logged_in = await page.evaluate(cfg["logged_in_check"])
            except Exception:
                logged_in = False
            if logged_in:
                print(f"[login:{platform}] login detected!")
                break
            await asyncio.sleep(2)

        if not logged_in:
            # Final check: maybe the detection didn't trigger but cookies exist
            try:
                final_cookies = await context.cookies()
                login_cookie_names = {
                    "xhs": {"a1", "web_session", "webId"},
                    "bilibili": {"DedeUserID", "SESSDATA", "bili_jct"},
                    "weibo": {"SUB", "SUBP", "SUHB"},
                }.get(platform, set())
                has_login_cookie = any(
                    c["name"] in login_cookie_names
                    and any(d in c.get("domain", "") for d in cfg["cookie_domains"])
                    for c in final_cookies
                )
                if has_login_cookie:
                    print(f"[login:{platform}] timeout, but login cookies detected — saving anyway")
                    logged_in = True
            except Exception:
                pass

        if not logged_in:
            # Close only pages we created; in CDP mode, don't close browser/context
            await page.close()
            if not _using_cdp:
                if not ws_endpoint:
                    await context.close()
                    await browser.close()
            raise TimeoutError(f"login timeout after {timeout_seconds}s (未检测到登录态)")

        # Give the page a moment to settle cookies
        await page.wait_for_timeout(2000)

        # Extract cookies
        raw_cookies = await context.cookies()
        for c in raw_cookies:
            domain = c.get("domain", "")
            if not any(d in domain for d in cfg["cookie_domains"]):
                continue
            bundle.cookies.append(CookieEntry(
                name=c["name"],
                value=c["value"],
                domain=domain,
                path=c.get("path", "/"),
                expires=int(c.get("expires", 0) or 0),
                http_only=bool(c.get("httpOnly", False)),
                secure=bool(c.get("secure", False)),
            ))

        # Try to extract user info
        try:
            user_info = await page.evaluate("""() => {
                try { return JSON.parse(localStorage.getItem('user') || '{}'); }
                catch { return {}; }
            }""")
            if user_info:
                bundle.user = dict(user_info)
        except Exception:
            pass

        # Close login page (keep browser open in CDP mode)
        await page.close()
        if not _using_cdp and not ws_endpoint:
            await context.close()
            await browser.close()

    store.save(bundle)
    print(f"[login:{platform}] saved {len(bundle.cookies)} cookies to {store.path_for(platform)}")
    return bundle


def do_login(
    platform: str,
    cookies_dir: str | Path,
    *,
    timeout_seconds: int = 180,
) -> CookieBundle:
    """Sync wrapper for `_do_login_async`."""
    return asyncio.run(_do_login_async(platform, cookies_dir, timeout_seconds=timeout_seconds))


# ============================================================
# Status check
# ============================================================

def check_login_status(platform: str, cookies_dir: str | Path) -> dict[str, Any]:
    """Check whether we have fresh cookies for a platform."""
    store = CookieStore(cookies_dir)
    bundle = store.load(platform)
    if bundle is None:
        return {"logged_in": False, "reason": "no cookies saved"}
    info: dict[str, Any] = {
        "logged_in": True,
        "platform": platform,
        "cookies_count": len(bundle.cookies),
        "captured_at": bundle.captured_at,
        "source": bundle.source,
        "cookies_file": str(store.path_for(platform)),
    }
    if bundle.expires_at:
        info["expires_at"] = bundle.expires_at
    if bundle.user:
        info["user"] = bundle.user
    return info