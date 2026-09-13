"""Unified cookies management for all platform adapters.

Architecture:
  - One `cookies/` directory under the plugin's data dir
  - One JSON file per platform: cookies/bilibili.json, cookies/xhs.json, etc.
  - Each file contains:
      {
        "cookies": [{"name": "...", "value": "...", "domain": "..."}, ...],
        "headers": {"User-Agent": "...", "Referer": "..."},
        "user": {"id": "123", "name": "..."},       # optional
        "captured_at": "2026-06-28T12:00:00",
        "source": "browser-edge" | "playwright-login" | "manual",
        "expires_at": "2026-07-28T12:00:00"          # optional
      }

Sources:
  1. Browser extraction (Edge/Chrome/Firefox via win32 API or sqlite)
  2. Playwright interactive login (QR scan, web form)
  3. Manual import (Netscape cookies.txt)

The CookieStore is sync (we want it to work without async overhead).
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

PLUGIN_DATA_COOKIES_DIR = "cookies"  # under dataDir


@dataclass
class CookieEntry:
    name: str
    value: str
    domain: str = ""
    path: str = "/"
    expires: int = 0  # 0 = session
    http_only: bool = False
    secure: bool = False

    def to_json(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v or k in ("name", "value")}


@dataclass
class CookieBundle:
    """A platform's cookies + relevant headers + metadata."""
    platform: str
    cookies: list[CookieEntry] = field(default_factory=list)
    headers: dict[str, str] = field(default_factory=dict)
    user: dict[str, Any] = field(default_factory=dict)
    captured_at: str = ""
    source: str = ""
    expires_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "platform": self.platform,
            "cookies": [c.to_json() for c in self.cookies],
            "headers": self.headers,
            "user": self.user,
            "captured_at": self.captured_at,
            "source": self.source,
            "expires_at": self.expires_at,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CookieBundle":
        return cls(
            platform=d.get("platform", ""),
            cookies=[CookieEntry(**c) for c in d.get("cookies", []) if isinstance(c, dict)],
            headers=d.get("headers", {}),
            user=d.get("user", {}),
            captured_at=d.get("captured_at", ""),
            source=d.get("source", ""),
            expires_at=d.get("expires_at", ""),
        )

    def to_header_dict(self) -> dict[str, str]:
        """Return as {name: value} dict (for httpx cookies=)."""
        return {c.name: c.value for c in self.cookies}

    def to_cookie_str(self) -> str:
        return "; ".join(f"{c.name}={c.value}" for c in self.cookies)


class CookieStore:
    """File-system backed cookie storage."""

    def __init__(self, cookies_dir: str | Path):
        self.cookies_dir = Path(cookies_dir).expanduser().resolve()
        self.cookies_dir.mkdir(parents=True, exist_ok=True)

    def path_for(self, platform: str) -> Path:
        return self.cookies_dir / f"{platform}.json"

    def exists(self, platform: str) -> bool:
        return self.path_for(platform).is_file()

    def save(self, bundle: CookieBundle) -> Path:
        if not bundle.captured_at:
            bundle.captured_at = time.strftime("%Y-%m-%dT%H:%M:%S")
        path = self.path_for(bundle.platform)
        path.write_text(
            json.dumps(bundle.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return path

    def load(self, platform: str) -> CookieBundle | None:
        path = self.path_for(platform)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return CookieBundle.from_dict(data)
        except json.JSONDecodeError as exc:
            print(f"[cookies] {platform}.json 损坏: {exc}", file=sys.stderr)
            print(f"[cookies] 请删除后重试: {path}", file=sys.stderr)
            return None
        except Exception as exc:
            print(f"[cookies] 加载 {platform} 失败: {exc}", file=sys.stderr)
            return None

    def delete(self, platform: str) -> bool:
        path = self.path_for(platform)
        if path.is_file():
            path.unlink()
            return True
        return False

    def list_platforms(self) -> list[str]:
        return sorted(p.stem for p in self.cookies_dir.glob("*.json"))


# ============================================================
# Browser cookie extraction
# ============================================================

# Browsers' local storage locations on Windows.
# We read directly from the SQLite Cookies DB and decrypt the value field
# using the browser's local encryption key (on Windows, this is usually
# the DPAPI-protected "Local State" JSON).
#
# Note: Modern Chrome (>= v80) uses AES-GCM with a key derived from DPAPI.
# This implementation uses `cryptography` (already in our venv via Scrapling
# or its deps) for AES-GCM. If absent, we fall back to plain (no encryption)
# which only works for older Chrome versions.

# Chrome v10 cookie 格式：加密前的明文会被拼上一段 32 字节的不透明前缀，
# 解完必须剥掉。实测所有 bilibili cookie 都是 32 字节（不是 16/24/40），
# 且不同 cookie 行之间前缀内容可不同，所以只能按固定长度切，不能按内容识别。
# 来源：与系统 Python 直接解 AES-GCM 对比，剥 32 后 SESSDATA / DedeUserID /
# buvid3 / _uuid 全部与预期完全一致，B 站评论接口从 3 条跳到 20 条/页。
_CHROME_PLAINTEXT_PREFIX_LEN = 32

_BROWSER_PATHS_WIN = {
    "edge": [
        # 微软 Edge: 优先使用 Edge 自己的 User Data
        Path.home() / "AppData/Local/Microsoft/Edge/User Data",
        # 某些企业版 Edge 可能使用 BHO 路径
        Path.home() / "AppData/Local/Microsoft/EdgeBho",
    ],
    "chrome": [
        Path.home() / "AppData/Local/Google/Chrome/User Data",
        # Beta/Dev/Canary 多 profile 安装可能使用这些路径
        Path.home() / "AppData/Local/Google/Chrome Beta/User Data",
        Path.home() / "AppData/Local/Google/Chrome SxS/User Data",
    ],
    "firefox": [
        # Firefox uses a different mechanism (NSS) — handled separately.
    ],
}


def _find_chrome_user_data_dir(candidates: list[Path]) -> Path | None:
    """Find the first existing User Data dir from candidates.

    新版 Chrome 把 Cookies 数据库放在 `Default/Network/Cookies`；
    旧版在 `Default/Cookies`。两者都要认，不然新版 Chrome 会被误报为未找到。
    """
    for p in candidates:
        if ((p / "Default" / "Network" / "Cookies").is_file()
                or (p / "Default" / "Cookies").is_file()
                or (p / "Local State").is_file()):
            return p
    return None


def _dpapi_decrypt(encrypted: bytes) -> bytes | None:
    """Decrypt DPAPI-protected bytes (Windows)."""
    try:
        import ctypes
        from ctypes import wintypes
        # CryptUnprotectData
        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]
        p = ctypes.create_string_buffer(encrypted, len(encrypted))
        # 注意：ctypes 不能把 c_char_Array_N 直接当 LP_c_byte 传，
        # 必须显式 cast。否则会报 `incompatible types, c_char_Array_288
        # instance instead of LP_c_byte instance`。
        blob_in = DATA_BLOB(
            len(encrypted), ctypes.cast(p, ctypes.POINTER(ctypes.c_byte)))
        blob_out = DATA_BLOB()
        if ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
        ):
            buf = ctypes.string_at(blob_out.pbData, blob_out.cbData)
            ctypes.windll.kernel32.LocalFree(blob_out.pbData)
            return buf
    except Exception as exc:
        print(f"[cookies] dpapi decrypt failed: {exc}", file=sys.stderr)
    return None


def _chrome_get_key(local_state_path: Path) -> bytes | None:
    """Get the AES key from Chrome's Local State JSON."""
    try:
        import base64
        state = json.loads(local_state_path.read_text(encoding="utf-8"))
        encrypted_key_b64 = state.get("os_crypt", {}).get("encrypted_key", "")
        if not encrypted_key_b64:
            return None
        encrypted_key = base64.b64decode(encrypted_key_b64)
        # First 5 bytes are "DPAPI" — strip and decrypt
        if encrypted_key.startswith(b"DPAPI"):
            return _dpapi_decrypt(encrypted_key[5:])
        # Older versions: just DPAPI-decrypt the whole thing
        return _dpapi_decrypt(encrypted_key)
    except Exception as exc:
        print(f"[cookies] chrome key extract failed: {exc}", file=sys.stderr)
        return None


def _chrome_decrypt_value(encrypted_value: bytes, key: bytes | None) -> str:
    """Decrypt a Chrome cookie value. Falls back to plain if key is unavailable."""
    # v10 prefix = AES-GCM encrypted
    # 布局：v10 | 12 字节 nonce | ciphertext‖16 字节 tag
    # AESGCM.decrypt 要的最后一个参数就是「密文‖tag」拼在一起——
    # 所以直接把 raw[15:] 整个传进去就行。旧版先切成 ct/tag 再拼回去，
    # 看上去没丢字节，实际上把认证标签的位置弄丢了，解出来全是乱码。
    if encrypted_value[:3] == b"v10" and key is not None:
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            nonce = encrypted_value[3:15]
            aesgcm = AESGCM(key)
            plaintext = aesgcm.decrypt(nonce, encrypted_value[15:], None)
            # Chrome 在把值加密前会先拼上一段 32 字节的「不透明前缀」
            # （v10 格式的实测行为，与 app-bound encryption 的回退相关）。
            # 不剥掉的话，前 32 字节全是二进制噪声，会把整个 cookie 头弄脏，
            # 导致 B 站这类 API 直接 HTTP 400。实测：剥掉之后 bilibili
            # 评论接口从 3 条（未登录天花板）跳到 20 条/页。
            plaintext = plaintext[_CHROME_PLAINTEXT_PREFIX_LEN:]
            return plaintext.decode("utf-8", errors="ignore")
        except Exception as exc:
            print(f"[cookies] AES-GCM decrypt failed: {exc}", file=sys.stderr)
            return ""
    # v11+ uses app-bound encryption (we don't support it)
    if encrypted_value[:3] in (b"v11", b"v12"):
        return ""  # can't decrypt
    # Plain (old Chrome)
    try:
        return encrypted_value.decode("utf-8", errors="ignore")
    except Exception:
        return ""


def extract_chrome_cookies(
    domain_filter: str,
    *,
    browser: str = "edge",
    browser_user_data_dir: str | None = None,
) -> list[CookieEntry]:
    """Extract cookies for a domain from a Chromium-based browser.

    Args:
        domain_filter: e.g. "bilibili.com" — only return cookies whose domain
            contains this substring.
        browser: "edge" | "chrome" | "chromium" | "brave" | "opera"
        browser_user_data_dir: optional override; default uses the platform's
            default path.
    """
    paths = _BROWSER_PATHS_WIN.get(browser, [])
    if not paths and browser_user_data_dir is None:
        print(f"[cookies] unknown browser: {browser}", file=sys.stderr)
        return []

    if browser_user_data_dir:
        user_data_dir = Path(browser_user_data_dir)
        local_state = user_data_dir / "Local State"
        # 新版 Chrome: Default/Network/Cookies；旧版: Default/Cookies
        _cands = [user_data_dir / "Default" / "Network" / "Cookies",
                  user_data_dir / "Default" / "Cookies"]
        cookies_db = next((d for d in _cands if d.is_file()), _cands[0])
    else:
        user_data_dir = _find_chrome_user_data_dir(paths)
        if user_data_dir is None:
            print(f"[cookies] {browser} User Data 目录未找到。请确认:")
            for cand in paths:
                print(f"          - {cand} (存在: {cand.is_dir()})")
            print(f"[cookies] 提示: 首次运行 {browser} 会自动创建 User Data 目录", file=sys.stderr)
            return []
        local_state = user_data_dir / "Local State"
        # 新版 Chrome: Default/Network/Cookies；旧版: Default/Cookies
        candidates_db = [user_data_dir / "Default" / "Network" / "Cookies",
                         user_data_dir / "Default" / "Cookies"]
        cookies_db = next((d for d in candidates_db if d.is_file()), candidates_db[0])

    if not cookies_db.is_file():
        print(f"[cookies] cookies db not found: {cookies_db}", file=sys.stderr)
        return []

    key = None
    if local_state.is_file():
        key = _chrome_get_key(local_state)

    # Chrome's Cookies DB is locked while the browser is running. We copy
    # to a temp file to read.
    import tempfile
    tmp = Path(tempfile.gettempdir()) / f"cookies-{int(time.time())}.db"
    try:
        import shutil
        shutil.copy2(cookies_db, tmp)
    except Exception as exc:
        print(f"[cookies] failed to copy db: {exc}", file=sys.stderr)
        return []

    results: list[CookieEntry] = []
    try:
        conn = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        cur = conn.cursor()
        cur.execute(
            "SELECT name, encrypted_value, value, host_key, path, expires_utc, is_httponly, is_secure "
            "FROM cookies WHERE host_key LIKE ?",
            (f"%{domain_filter}%",),
        )
        for row in cur.fetchall():
            name, enc_value, plain_value, host, path, expires, http_only, secure = row
            # 新版 Chrome 把密文存在 `encrypted_value`（BLOB），`value`（TEXT）是空的。
            # 旧版相反：`value` 里直接存明文。两边都要试。
            if isinstance(enc_value, (bytes, bytearray)) and enc_value:
                value = _chrome_decrypt_value(enc_value, key)
            else:
                value = str(plain_value or "")
            if not value:
                continue
            results.append(CookieEntry(
                name=name,
                value=value,
                domain=host,
                path=path or "/",
                expires=int(expires or 0),
                http_only=bool(http_only),
                secure=bool(secure),
            ))
        cur.close()
        conn.close()
    finally:
        try:
            tmp.unlink()
        except Exception:
            pass
    return results


def extract_firefox_cookies(domain_filter: str) -> list[CookieEntry]:
    """Extract cookies from Firefox profiles.

    Firefox uses a different storage format (SQLite with NSS encryption).
    This is a best-effort implementation — full support requires the
    `pycryptodome` + NSS libs, which is heavier. We only return *unencrypted*
    cookies (older Firefox versions or cookies without `encrypted_value`).
    """
    profiles_ini = Path.home() / "AppData/Roaming/Mozilla/Firefox/profiles.ini"
    if not profiles_ini.is_file():
        print(f"[cookies] firefox profiles.ini not found", file=sys.stderr)
        return []

    import configparser
    cp = configparser.ConfigParser()
    try:
        cp.read(profiles_ini, encoding="utf-8")
    except Exception:
        return []

    results: list[CookieEntry] = []
    for section in cp.sections():
        if not cp.has_option(section, "Path"):
            continue
        profile_path = Path(cp.get(section, "Path"))
        if not profile_path.is_absolute():
            profile_path = profiles_ini.parent / profile_path
        cookies_db = profile_path / "cookies.sqlite"
        if not cookies_db.is_file():
            continue
        import tempfile
        tmp = Path(tempfile.gettempdir()) / f"ff-cookies-{int(time.time())}-{profile_path.name}.db"
        try:
            import shutil
            shutil.copy2(cookies_db, tmp)
            conn = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
            cur = conn.cursor()
            cur.execute(
                "SELECT name, value, host, path, expiry, isSecure, isHttpOnly "
                "FROM moz_cookies WHERE host LIKE ?",
                (f"%{domain_filter}%",),
            )
            for row in cur.fetchall():
                name, value, host, path, expiry, secure, http_only = row
                # Firefox may store encrypted_value; we ignore those.
                if not value or not isinstance(value, str):
                    continue
                results.append(CookieEntry(
                    name=name, value=value, domain=host, path=path or "/",
                    expires=int(expiry or 0),
                    http_only=bool(http_only), secure=bool(secure),
                ))
            cur.close()
            conn.close()
        except Exception as exc:
            print(f"[cookies] firefox profile {profile_path}: {exc}", file=sys.stderr)
        finally:
            try:
                tmp.unlink()
            except Exception:
                pass
    return results


def extract_browser_cookies(
    domain_filter: str,
    *,
    browser: str = "edge",
) -> list[CookieEntry]:
    """Dispatch to the right extractor based on browser type."""
    if browser in ("edge", "chrome", "chromium", "brave", "opera"):
        return extract_chrome_cookies(domain_filter, browser=browser)
    if browser == "firefox":
        return extract_firefox_cookies(domain_filter)
    print(f"[cookies] unknown browser: {browser}", file=sys.stderr)
    return []


# ============================================================
# Domain mapping (which browser cookies cover which platform)
# ============================================================

PLATFORM_DOMAINS = {
    "bilibili": ["bilibili.com"],
    "xhs": ["xiaohongshu.com", "xhslink.com"],
    "weibo": ["weibo.com", "weibo.cn"],
    "zhihu": ["zhihu.com"],
    "tieba": ["tieba.baidu.com", "baidu.com"],
    "douyin": ["douyin.com", "iesdouyin.com"],
    "kuaishou": ["kuaishou.com"],
}


def extract_platform_cookies(
    platform: str,
    *,
    browser: str = "edge",
) -> list[CookieEntry]:
    """Extract all cookies for a platform from the given browser."""
    domains = PLATFORM_DOMAINS.get(platform, [])
    seen: dict[str, CookieEntry] = {}  # name -> latest
    for dom in domains:
        for c in extract_browser_cookies(dom, browser=browser):
            seen[c.name] = c
    return list(seen.values())


# ============================================================
# Importers
# ============================================================

def import_netscape_cookies_txt(path: str | Path) -> list[CookieEntry]:
    """Parse a Netscape-format cookies.txt (e.g. from EditThisCookie)."""
    results: list[CookieEntry] = []
    p = Path(path)
    if not p.is_file():
        return results
    for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith(("#", "//")):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        # domain, http_only_flag, path, secure_flag, expires, name, value
        try:
            results.append(CookieEntry(
                name=parts[5],
                value=parts[6],
                domain=parts[0] or "",
                path=parts[2] or "/",
                expires=int(parts[4] or 0) if parts[4].isdigit() else 0,
                secure=parts[3].upper() == "TRUE",
                http_only=parts[1].upper() == "TRUE",
            ))
        except Exception:
            continue
    return results
