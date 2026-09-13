"""Platform adapter base class and registry.

Each platform (bilibili, xhs, douyin, kuaishou, weibo, zhihu, tieba) implements
a PlatformAdapter. The collector dispatches work to the right adapter based on
the source URL or explicit platform parameter.

Adapters are deliberately minimal:
  - HTTP-first, no Playwright by default
  - Optional login state via cookies_file or localStorage JSON
  - Sync API (the collector's caller is sync; async is only used internally)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable



# ============================================================
# Data structures
# ============================================================

@dataclass
class SearchResult:
    """A single item returned by a platform search."""
    platform: str
    item_id: str
    title: str
    author: str = ""
    url: str = ""
    cover: str = ""
    duration: str = ""
    play_count: int = 0
    like_count: int = 0
    comment_count: int = 0
    pub_date: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "platform": self.platform,
            "item_id": self.item_id,
            "title": self.title,
            "author": self.author,
            "url": self.url,
            "cover": self.cover,
            "duration": self.duration,
            "play_count": self.play_count,
            "like_count": self.like_count,
            "comment_count": self.comment_count,
            "pub_date": self.pub_date,
            **self.extra,
        }


@dataclass
class CommentNode:
    """A single comment, possibly with nested replies."""
    rpid: str
    username: str = ""
    content: str = ""
    like_count: int = 0
    ctime: int = 0  # unix timestamp
    level: int = 0
    replies: list["CommentNode"] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rpid": self.rpid,
            "username": self.username,
            "content": self.content,
            "like_count": self.like_count,
            "ctime": self.ctime,
            "level": self.level,
            "replies": [r.to_dict() for r in self.replies],
        }


# ============================================================
# Adapter base
# ============================================================

class PlatformAdapter:
    """Base class for platform adapters.

    Subclasses set `platform_id` and `url_patterns` and override the methods
    they need. Methods that aren't overridden raise NotImplementedError, and
    the collector will treat them as unsupported (returning empty data, not
    failing the whole call).
    """

    platform_id: str = ""
    display_name: str = ""
    url_patterns: list[re.Pattern[str]] = []
    enabled_by_default: bool = False
    # When True, the adapter expects cookies (login state) to fetch full data.
    # If no cookies are provided, only public/search results will work.
    needs_login_for_full: bool = True

    def __init__(self, cookies_file: str = "", cookies_dir: str = "", http_client: Any | None = None):
        self.cookies_file = cookies_file
        self.cookies_dir = cookies_dir
        self._http = http_client  # may be None; adapters create their own
        self._cookies: dict[str, str] = {}

    # ---- public API ----

    def matches_url(self, source: str) -> bool:
        if not source:
            return False
        return any(p.search(source) for p in self.url_patterns)

    def search(
        self,
        keyword: str,
        *,
        limit: int = 10,
        sort: int = 0,
        page: int = 1,
    ) -> list[SearchResult]:
        """Search the platform for a keyword. Returns a list of results."""
        raise NotImplementedError

    def get_item(
        self,
        source: str,
        *,
        page: int = 0,
    ) -> dict[str, Any]:
        """Fetch the detailed metadata for a single item (video / note / post)."""
        raise NotImplementedError

    def get_comments(
        self,
        source: str,
        *,
        limit: int = 50,
        max_depth: int = 3,
        with_sub_comments: bool = True,
    ) -> list[CommentNode]:
        """Fetch comments. `with_sub_comments` enables the 2nd-level fan-out."""
        raise NotImplementedError

    def get_creator(
        self,
        creator_id: str,
    ) -> dict[str, Any]:
        """Fetch a creator/author profile."""
        raise NotImplementedError

    # ---- cookie helpers ----

    def load_cookies(self) -> dict[str, str]:
        """Load cookies from cookies_file (Netscape format) or cookies_dir (JSON)."""
        if self._cookies:
            return self._cookies
        if self.cookies_file and Path(self.cookies_file).is_file():
            self._cookies = _read_netscape_cookies(self.cookies_file)
        return self._cookies

    def cookie_header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self.load_cookies().items())


# ============================================================
# Registry
# ============================================================

_REGISTRY: dict[str, type[PlatformAdapter]] = {}


def register(adapter_cls: type[PlatformAdapter]) -> type[PlatformAdapter]:
    """Decorator to register a platform adapter."""
    if not adapter_cls.platform_id:
        raise ValueError(f"{adapter_cls.__name__} must define platform_id")
    _REGISTRY[adapter_cls.platform_id] = adapter_cls
    return adapter_cls


def get_adapter(
    platform: str,
    *,
    cookies_file: str = "",
    cookies_dir: str = "",
) -> PlatformAdapter | None:
    """Get an adapter instance by platform id. Returns None if unknown."""
    cls = _REGISTRY.get(platform)
    if cls is None:
        return None
    return cls(cookies_file=cookies_file, cookies_dir=cookies_dir)


def detect_platform(source: str) -> str | None:
    """Return the platform_id of the first adapter whose url_patterns match."""
    for pid, cls in _REGISTRY.items():
        if any(p.search(source) for p in cls.url_patterns):
            return pid
    return None


def list_platforms() -> list[dict[str, Any]]:
    """Return a list of all registered platforms and their default state."""
    return [
        {
            "id": cls.platform_id,
            "name": cls.display_name,
            "enabled_by_default": cls.enabled_by_default,
            "needs_login": cls.needs_login_for_full,
        }
        for cls in _REGISTRY.values()
    ]


# ============================================================
# Helpers
# ============================================================

def _read_netscape_cookies(path: str) -> dict[str, str]:
    """Read a Netscape cookies.txt and return a {name: value} dict."""
    cookies: dict[str, str] = {}
    try:
        for line in Path(path).read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith(("#", "//")):
                continue
            parts = line.split("\t")
            if len(parts) >= 7:
                cookies[parts[5]] = parts[6]
    except Exception:
        pass
    return cookies


def http_get_json(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    cookies: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    timeout: float = 15.0,
    proxy: str | None = None,
) -> dict[str, Any] | list[Any] | None:
    """Synchronous JSON GET via httpx. Returns parsed JSON or None on failure."""
    try:
        import httpx
    except ImportError as exc:
        raise RuntimeError("httpx is required for platform adapters") from exc

    default_headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        ),
    }
    if headers:
        default_headers.update(headers)

    cookie_str = ""
    if cookies:
        cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())

    try:
        with httpx.Client(timeout=timeout, headers=default_headers, proxy=proxy) as client:
            r = client.get(url, params=params, cookies=cookies or None)
            r.raise_for_status()
            return r.json()
    except Exception:
        return None


# ============================================================
# Eagerly import platform adapters (after _REGISTRY is defined)
# ============================================================
# Why here and not at top? Each adapter module's top-level code uses
# @register, which writes to _REGISTRY. If we imported the submodules
# before _REGISTRY was defined, the decorator would fail.
# Putting the imports at the bottom guarantees the registry is ready.

_ADAPTER_MODULES = (
    "bilibili",
    "xhs",
    "douyin",
    "kuaishou",
    "weibo",
    "zhihu",
    "tieba",
)

for _mod_name in _ADAPTER_MODULES:
    try:
        __import__(f"adapters.{_mod_name}", fromlist=["*"])
    except Exception as _exc:  # noqa: BLE001
        # 单个适配器加载失败不应阻塞其他适配器。
        import sys as _sys
        print(f"[adapters] failed to load {_mod_name}: {_exc}", file=_sys.stderr)
