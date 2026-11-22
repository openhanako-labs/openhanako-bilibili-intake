"""可见浏览器登录链路 —— 点一下，弹窗，扫码，cookie 自动落盘。

为什么不再走 playwright_login.py：那个文件用 CDP 连"你已经开着的 Chrome"，
要求用户先手工用 `--remote-debugging-port=9222` 启动浏览器，否则退回独立浏览器。
对"卡片上点一个按钮"这个场景来说，那一步是多余的。这里直接起一个**带持久化
profile 的可见 Chrome**：

  点按钮 → 弹出 Chrome 窗口停在登录页 → 你扫码/输密码 → 检测到登录态 →
  窗口自动关 → cookies 写进 cookies/<platform>.json

三个实测结论决定了这个写法：

1. **playwright 自带的 chromium 在这台机器上是缺的**（chromium-1223 不存在），
   但 `channel="chrome"` 可用（本机 Chrome 157）。所以启动顺序是
   channel=chrome → 常见安装路径 → playwright 自带，全部失败才报错。

2. **登录态必须用 `context.cookies()` 判断，不能用 `document.cookie`。**
   B 站的 SESSDATA/DedeUserID、百度的 BDUSS、微博的 SUB 全是 HttpOnly，
   在页面里读 `document.cookie` 永远读不到 —— 旧实现就是这么写的，
   表现是"明明登录了却一直不认"。

3. profile 要持久化。这样第二次点同一个平台，页面一加载就已经是登录态，
   第一次轮询就通过，用户感觉是"秒进"。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

# ============================================================
# 平台登录配置
# ============================================================

# `check`: cookie 名 → 判定函数。任何一个命中就算登录成功。
# 只用**登录后才会出现**的 cookie，不能用匿名访客也有的（那是旧实现最大的坑：
# 小红书拿 a1/webId 当登录标志，结果第一次轮询就假阳性）。
LOGIN_TARGETS: dict[str, dict[str, Any]] = {
    "bilibili": {
        "name": "哔哩哔哩",
        "url": "https://passport.bilibili.com/login",
        "check": {"DedeUserID": lambda v: bool(v), "SESSDATA": lambda v: len(v) > 20},
        "cookie_domains": ("bilibili.com",),
        "home": "https://www.bilibili.com/",
    },
    "xhs": {
        "name": "小红书",
        "url": "https://www.xiaohongshu.com/explore",
        "check": {"web_session": lambda v: len(v) >= 16},
        "cookie_domains": ("xiaohongshu.com",),
        "home": "https://www.xiaohongshu.com/explore",
    },
    "weibo": {
        "name": "微博",
        "url": "https://weibo.com/login.php",
        "check": {"SUB": lambda v: len(v) > 10},
        "cookie_domains": ("weibo.com", "weibo.cn", "sina.com.cn"),
        "home": "https://weibo.com/",
    },
    "zhihu": {
        "name": "知乎",
        "url": "https://www.zhihu.com/signin",
        # z_c0 是知乎的登录令牌，未登录时不存在
        "check": {"z_c0": lambda v: len(v) > 20},
        "cookie_domains": ("zhihu.com",),
        "home": "https://www.zhihu.com/",
    },
    "tieba": {
        "name": "百度贴吧",
        "url": "https://tieba.baidu.com/",
        # BDUSS 是百度系登录态核心，HttpOnly
        "check": {"BDUSS": lambda v: len(v) > 20},
        "cookie_domains": ("baidu.com", "tieba.baidu.com"),
        "home": "https://tieba.baidu.com/",
    },
    "kuaishou": {
        "name": "快手",
        "url": "https://www.kuaishou.com/",
        # 快手 web 的登录态在 kuaishou.server.web_st（HttpOnly）；
        # passToken 是移动端的，web 端登录后也可能带过来。
        "check": {
            "kuaishou.server.web_st": lambda v: len(v) > 20,
            "passToken": lambda v: len(v) > 10,
            "userId": lambda v: bool(v),
        },
        "cookie_domains": ("kuaishou.com", "gifshow.com"),
        "home": "https://www.kuaishou.com/",
    },
    "xiaoheihe": {
        "name": "小黑盒",
        "url": "https://www.xiaoheihe.cn/",
        # ⚠️ 未实测：小黑盒 web 端的登录 cookie 名没有验证过。
        #   这里用几个已知会随登录出现的键 + 一个"cookie 数量明显增长"的兜底，
        #   第一次真登录时如果没认出来，把日志里的 cookie 名贴出来我再收紧。
        "check": {
            "heybox_id": lambda v: bool(v),
            "user_heybox_id": lambda v: bool(v),
            "pkey": lambda v: len(v) > 10,
        },
        "cookie_domains": ("xiaoheihe.cn", "heybox.cn", "max-c.com"),
        "home": "https://www.xiaoheihe.cn/",
    },
}

# 匿名访客也会有的 cookie —— 永远不能当登录标志
_ANONYMOUS_KEYS = frozenset({
    "a1", "webId", "acw_tc", "xsecappid", "gid", "buvid3", "buvid4",
    "_uuid", "b_lsid", "buvid_fp", "_zap", "_xsrf", "BEC", "tid",
})

CHROME_CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
)


def _find_browser_executable() -> str:
    for path in CHROME_CANDIDATES:
        if Path(path).is_file():
            return path
    return ""


async def _launch_context(playwright: Any, profile_dir: Path, headless: bool):
    """按 可用性 依次尝试：系统 Chrome → 找到的 exe → playwright 自带。"""
    args = [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    attempts: list[dict[str, Any]] = [{"channel": "chrome"}]
    exe = _find_browser_executable()
    if exe:
        attempts.append({"executable_path": exe})
    attempts.append({})

    last_error = ""
    for kwargs in attempts:
        try:
            return await playwright.chromium.launch_persistent_context(
                str(profile_dir), headless=headless, args=args, **kwargs
            )
        except Exception as exc:  # noqa: BLE001 - 换下一个候选
            last_error = f"{list(kwargs.keys()) or 'default'}: {str(exc)[:120]}"
            continue
    raise RuntimeError(
        "起不了浏览器。playwright 自带的 chromium 没装（playwright install chromium），"
        f"系统 Chrome 也用不上。最后一次错误：{last_error}"
    )


def _cookies_to_map(cookies: list[dict[str, Any]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for c in cookies:
        name = c.get("name")
        if name:
            # 同名不同域时保留最长值（通常是主域那条）
            val = str(c.get("value") or "")
            if len(val) >= len(out.get(name, "")):
                out[name] = val
    return out


def _detect_logged_in(cookies: dict[str, str], cfg: dict[str, Any]) -> bool:
    for key, test in (cfg.get("check") or {}).items():
        if key in cookies and test(cookies[key]):
            return True
    return False


def _domain_ok(domain: str, suffixes: tuple[str, ...]) -> bool:
    d = (domain or "").lstrip(".").lower()
    return any(d == s or d.endswith("." + s) for s in suffixes)


async def run_login(
    platform: str,
    *,
    cookies_dir: str | Path,
    state_dir: str | Path | None = None,
    timeout: int = 180,
    headless: bool = False,
) -> dict[str, Any]:
    """跑一次登录。返回结构化结果（给 CLI / HTTP 层原样输出）。"""
    cfg = LOGIN_TARGETS.get(platform)
    if not cfg:
        return {
            "ok": False,
            "error": f"没有这个平台的登录配置：{platform}",
            "supported": sorted(LOGIN_TARGETS),
        }

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return {"ok": False, "error": "缺少 playwright，先 pip install playwright"}

    import asyncio

    cookies_path = Path(cookies_dir)
    profile = Path(state_dir) / platform if state_dir else cookies_path.parent / "login-state" / platform
    profile.mkdir(parents=True, exist_ok=True)

    started = time.time()
    async with async_playwright() as p:
        try:
            ctx = await _launch_context(p, profile, headless)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "platform": platform, "error": str(exc)[:300]}

        try:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            try:
                await page.goto(cfg["url"], wait_until="domcontentloaded", timeout=45000)
            except Exception:
                # 首页加载慢不算失败，用户还能在里面自己点
                pass
            if not headless:
                try:
                    await page.bring_to_front()
                except Exception:
                    pass

            deadline = time.time() + max(10, timeout)
            logged_in = False
            while time.time() < deadline:
                cookies = _cookies_to_map(await ctx.cookies())
                if _detect_logged_in(cookies, cfg):
                    logged_in = True
                    break
                await asyncio.sleep(2)

            if not logged_in:
                cookies = _cookies_to_map(await ctx.cookies())
                names = sorted(k for k in cookies if k not in _ANONYMOUS_KEYS)[:12]
                return {
                    "ok": False,
                    "platform": platform,
                    "reason": "timeout",
                    "elapsed": round(time.time() - started, 1),
                    "error": f"等了 {timeout} 秒没检测到登录态",
                    # 这条最有用：用户实际登录了却没被认出来时，照着这串名字改 check
                    "cookie_names_seen": names,
                }

            # 给剩下的 cookie 一点落地时间（扫码后几个 Set-Cookie 不是同一毫秒到的）
            await asyncio.sleep(1.5)
            raw = await ctx.cookies()

            from cookies_store import CookieBundle, CookieEntry, CookieStore

            entries = [
                CookieEntry(
                    name=c.get("name", ""),
                    value=str(c.get("value") or ""),
                    domain=c.get("domain", ""),
                    path=c.get("path", "/"),
                    expires=int(c.get("expires") or 0) if (c.get("expires") or 0) > 0 else 0,
                    http_only=bool(c.get("httpOnly")),
                    secure=bool(c.get("secure")),
                )
                for c in raw
                if c.get("name") and _domain_ok(c.get("domain", ""), cfg["cookie_domains"])
            ]

            if not entries:
                return {"ok": False, "platform": platform, "error": "登录成功但没取到该平台的 cookie（域名过滤太严？）"}

            bundle = CookieBundle(
                platform=platform,
                cookies=entries,
                source="browser-login",
                user={"name": cfg["name"]},
            )
            store = CookieStore(cookies_path)
            store.save(bundle)

            return {
                "ok": True,
                "platform": platform,
                "platform_name": cfg["name"],
                "count": len(entries),
                "elapsed": round(time.time() - started, 1),
                "cookie_path": str(store.cookies_dir / f"{platform}.json"),
            }
        finally:
            try:
                await ctx.close()
            except Exception:
                pass


# ============================================================
# CLI
# ============================================================

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="可见浏览器登录：扫码后自动保存 cookies")
    parser.add_argument("platform", nargs="?", help="平台 id；留空列出全部")
    parser.add_argument("--cookies-dir", default="")
    parser.add_argument("--state-dir", default="", help="浏览器 profile 目录（默认 cookies 的上一级/login-state）")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--headless", action="store_true", help="调试用：不开窗口（没法扫码，只验证流程）")
    args = parser.parse_args(argv)

    if not args.platform:
        # ⭐ 2026-11-21：改成输出 JSON。卡片（Node 侧）要拿平台清单与登录页地址，
        #   一律以本文件为唯一事实源——否则哪边头一个改，两边就漂开。
        print(json.dumps({
            "ok": True,
            "targets": {
                pid: {"name": c["name"], "url": c["url"], "home": c.get("home", c["url"])}
                for pid, c in LOGIN_TARGETS.items()
            },
        }, ensure_ascii=False))
        return 0

    import asyncio as _asyncio

    result = _asyncio.run(run_login(
        args.platform,
        cookies_dir=args.cookies_dir or str(Path.home() / ".hanako-cookies"),
        state_dir=args.state_dir or "",
        timeout=args.timeout,
        headless=args.headless,
    ))
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
