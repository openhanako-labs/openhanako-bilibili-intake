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
# buvid3 / _uuid 全部与预期完全一致。
#
# ⚠️ 2026-10-04 纠正一句旧结论：以当时把「剥完前缀评论从 3 条跳到 20 条/页」当成
#   解密问题的证据。相关性是真的，因果不是 —— 后来实测：评论接口 /x/v2/reply 已经
#   废弃，带不带 cookie、解得对不对都只回 3 条；换成 /x/v2/reply/wbi/main 之后，
#   反而是**带着 buvid3 会被砍回 3 条**，剔掉才拿得到 20 条/页。
#   解密该修仍然要修（别的接口吃这个），但评论条数不再靠它 —— 见 bilibili_comments.py。
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
    # ⭐ 2026-11-21：国内用户实际装得很开的几个 Chromium 系浏览器。
    #   它们的 cookie 库结构与 Chrome 完全一致（同一套 SQLite + DPAPI + AES-GCM），
    #   所以复用 extract_chrome_cookies 即可，只差一个路径。
    "brave": [
        Path.home() / "AppData/Local/BraveSoftware/Brave-Browser/User Data",
    ],
    "vivaldi": [
        Path.home() / "AppData/Local/Vivaldi/User Data",
    ],
    "360": [
        Path.home() / "AppData/Local/360Chrome/Chrome/User Data",
        Path.home() / "AppData/Local/360ChromeX/Chrome/User Data",
        Path.home() / "AppData/Roaming/360se6/User Data",
    ],
    "qq": [
        Path.home() / "AppData/Local/Tencent/QQBrowser/User Data",
        Path.home() / "AppData/Roaming/Tencent/QQBrowser/User Data",
    ],
    "firefox": [
        # Firefox uses a different mechanism (NSS) — handled separately.
    ],
}


def _find_cookie_dbs(user_data_dir: Path) -> list[Path]:
    """列出这个 User Data 下**所有 profile** 的 cookie 库。

    ⭐ 2026-11-21：以前只认 `Default`。多账号用户的登录态常在 Profile 1/2 里，
    只查 Default 就表现为“浏览器里明明登录着，工具说没 cookie”。
    一个库都没有时返回空表，由调用方决定怎么报错。
    """
    out: list[Path] = []
    seen: set[Path] = set()
    profiles: list[Path] = []
    try:
        profiles.append(user_data_dir / "Default")
        profiles.extend(sorted(p for p in user_data_dir.glob("Profile *") if p.is_dir()))
    except Exception:
        pass
    for prof in profiles:
        # 新版 Chromium 系：<profile>/Network/Cookies；老版本：<profile>/Cookies
        for cand in (prof / "Network" / "Cookies", prof / "Cookies"):
            try:
                if cand.is_file() and cand not in seen:
                    out.append(cand)
                    seen.add(cand)
            except Exception:
                continue
    return out


# ⭐ 2026-11-21：用户完全可能把浏览器数据目录搬到别处。
#   实测这台机器的 Edge 就在 `<Edge用户数据目录>`（进程命令行里带着
#   `--user-data-dir=...`），而 `%LOCALAPPDATA%\Microsoft\Edge\User Data` 是个空壳目录。
#   任何写死的路径表都盖不住这种情况，所以再补一层：从**运行中的浏览器进程**里
#   把实际的 --user-data-dir 挖出来。
_PROCESS_DATA_DIRS_CACHE: list[Path] | None = None

# ⭐ 2026-11-22：发现过的自定义目录要**记住**。
#   否则会死锁在一步上：Edge 开着时它的库读不了（独占锁）→ 用户关掉 Edge →
#   进程没了 → `--user-data-dir` 也问不到了 → 反而彻底找不到 `<Edge用户数据目录>`。
#   存到本地一份小 JSON，下次直接读。
_DIRS_MEMO = Path.home() / "AppData" / "Local" / "hanako-intake" / "browser-dirs.json"


def _memo_read() -> list[Path]:
    try:
        import json
        if not _DIRS_MEMO.is_file():
            return []
        data = json.loads(_DIRS_MEMO.read_text(encoding="utf-8"))
        return [Path(p) for p in (data.get("dirs") or []) if isinstance(p, str)]
    except Exception:
        return []


def _memo_write(dirs: list[Path]) -> None:
    try:
        import json
        _DIRS_MEMO.parent.mkdir(parents=True, exist_ok=True)
        _DIRS_MEMO.write_text(
            json.dumps({"dirs": [str(p) for p in dirs]}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass
_BROWSER_PROCESS_NAMES = (
    "msedge.exe", "chrome.exe", "brave.exe", "vivaldi.exe",
    "360chrome.exe", "360ChromeX.exe", "QQBrowser.exe",
)


def _user_data_dirs_from_processes() -> list[Path]:
    r"""从运行中的浏览器进程命令行里读 `--user-data-dir`。

    ⚠️ 参数形式实测是 `"--user-data-dir=<Edge用户数据目录>"` —— **引号包的是整个参数**，
    不是只包值。用正则 `--user-data-dir="([^"]+)"` 会一个都匹配不到（踩过）。
    所以优先用 psutil：它已经把 cmdline 拆成参数数组，没有引号问题。

    只在 Windows 上有意义。失败一律返回空表——探测不到不能让整个提取挂掉。
    结果缓存在进程生命周期内（浏览器不会中途换目录）。
    """
    global _PROCESS_DATA_DIRS_CACHE
    if _PROCESS_DATA_DIRS_CACHE is not None:
        return _PROCESS_DATA_DIRS_CACHE

    found: list[Path] = []
    names = {n.lower() for n in _BROWSER_PROCESS_NAMES}

    def _add(raw: str) -> None:
        raw = (raw or "").strip().strip('"')
        if not raw:
            return
        try:
            p = Path(raw)
            if p.is_dir() and p not in found:
                found.append(p)
        except Exception:
            pass

    # ① psutil（首选：cmdline 已是参数数组）
    try:
        import psutil
        for proc in psutil.process_iter(["name", "cmdline"]):
            try:
                if str(proc.info.get("name") or "").lower() not in names:
                    continue
                for arg in (proc.info.get("cmdline") or []):
                    if isinstance(arg, str) and arg.startswith("--user-data-dir="):
                        _add(arg.split("=", 1)[1])
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
    except ImportError:
        pass
    except Exception:
        pass

    # ② 兜底：psutil 拿不到时走 PowerShell（两种参数形式都认）
    if not found and sys.platform == "win32":
        try:
            import subprocess
            flt = " or ".join(f"Name='{n}'" for n in _BROWSER_PROCESS_NAMES)
            script = (f"Get-CimInstance Win32_Process -Filter \"{flt}\" | "
                      "Select-Object -ExpandProperty CommandLine")
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True, text=True, timeout=12, errors="ignore",
            )
            for m in re.finditer(r'"--user-data-dir=([^"]+)"|--user-data-dir=(\S+)', proc.stdout or ""):
                _add(m.group(1) or m.group(2) or "")
        except Exception:
            pass

    # ⚠️ 这里存进缓存的必须是 **merged**（进程发现 + 历史记住），不能是 found。
    #   踩过的坑：先写 `_PROCESS_DATA_DIRS_CACHE = found`，于是第一次调用返回 merged（正确），
    #   第二次调用命中缓存直接返回 found（Edge 关了就是空表）——
    #   表现就是“auto 里 chrome 还能读、轮到 edge 就找不到目录”，而单独调用又一切正常。
    merged = list(found)
    for p in _memo_read():
        if p not in merged:
            merged.append(p)
    if found:
        _memo_write(merged)
    _PROCESS_DATA_DIRS_CACHE = merged
    return merged


# 从 --user-data-dir 路径推断它属于哪个浏览器。
# 为什么需要：实测 Edge 把数据放到了 `<Edge用户数据目录>`，如果把这个目录
# 无差别地赠给每个浏览器分支，Brave/Vivaldi 也会去读 Edge 的库，然后
# 全部报“被占用”——诊断信息反而把人带沟里。
_DYNAMIC_DIR_KEYS: dict[str, tuple[str, ...]] = {
    "chrome": ("chrome",),
    "edge": ("edge",),
    "brave": ("brave",),
    "vivaldi": ("vivaldi",),
    "360": ("360",),
    "qq": ("qqbrowser", "\\qq"),
}


def _dynamic_dirs_for(browser: str) -> list[Path]:
    keys = _DYNAMIC_DIR_KEYS.get(browser, (browser,))
    out: list[Path] = []
    for p in _user_data_dirs_from_processes():
        low = str(p).lower()
        if any(k in low for k in keys):
            out.append(p)
    return out


def _find_chrome_user_data_dir(candidates: list[Path]) -> Path | None:
    """Find the first existing User Data dir from candidates.

    新版 Chrome 把 Cookies 数据库放在 `Default/Network/Cookies`；
    旧版在 `Default/Cookies`。两者都要认，不然新版 Chrome 会被误报为未找到。

    ⭐ 2026-11-21：还要认 “没有 Default、只有 Profile 1” 的情况。
    Edge 首次启动就可能把主 profile 建成 Profile 1（用户在登录页登过就更是如此），
    旧逻辑只查 Default，于是报了“User Data 目录未找到”——而目录明明存在。
    """
    for p in candidates:
        try:
            if not p.is_dir():
                continue
            if (p / "Local State").is_file():
                return p
            if _find_cookie_dbs(p):
                return p
        except Exception:
            continue
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
            # 导致 B 站这类 API 直接 HTTP 400。
            # ⚠️ 这里以前写的实测结论是「剥完 bilibili 评论从 3 条（未登录天花板）跳到
            #   20 条/页」，那句已作废：评论只给 3 条不是登录问题，是 /x/v2/reply 废弃了；
            #   新接口上 buvid3 还会反向砍条数。见 python/bilibili_comments.py 头部。
            plaintext = plaintext[_CHROME_PLAINTEXT_PREFIX_LEN:]
            return plaintext.decode("utf-8", errors="ignore")
        except Exception as exc:
            # ⭐ 2026-11-22：把“缺依赖”和“解密失败”分开报。
            #   以前两者都只打一句 AES-GCM decrypt failed（而且只上 stderr），
            #   表现就是“所有 cookie 解出空字符串”，根本看不出是 venv 里没装 cryptography。
            if isinstance(exc, ImportError):
                _note("解不开浏览器 cookie：运行环境缺 cryptography（pip install cryptography）")
                print("[cookies] 缺 cryptography，无法解密浏览器 cookie", file=sys.stderr)
            else:
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

    # ⭐ 动态发现作为**兜底**放在已知路径之后，不能放前面：
    #   实测把动态目录放前面时，chrome 分支会先去读 Edge 的库（<Edge用户数据目录>），
    #   而那份库的 AES key 与 Chrome 的 Local State 对不上 → 解密全失败 → 0 条。
    #   而且只能赠给**路径名对得上的那个浏览器**（见 _dynamic_dirs_for）。
    _dynamic = _dynamic_dirs_for(browser)
    _all_dirs = [p for p in paths if p not in _dynamic] + list(_dynamic)

    if browser_user_data_dir:
        user_data_dir = Path(browser_user_data_dir)
    else:
        user_data_dir = _find_chrome_user_data_dir(_all_dirs)
        if user_data_dir is None:
            print(f"[cookies] {browser} User Data 目录未找到。请确认:", file=sys.stderr)
            for cand in _all_dirs:
                print(f"          - {cand} (存在: {cand.is_dir()})", file=sys.stderr)
            print(f"[cookies] 提示: 首次运行 {browser} 会自动创建 User Data 目录", file=sys.stderr)
            return []

    local_state = user_data_dir / "Local State"
    cookie_dbs = _find_cookie_dbs(user_data_dir)
    if not cookie_dbs:
        print(f"[cookies] cookies db not found under {user_data_dir}", file=sys.stderr)
        return []

    key = None
    if local_state.is_file():
        key = _chrome_get_key(local_state)

    # Chrome 运行时 Cookies 库会被**独占锁住**：shutil.copy2 直接 WinError 32
    #（实测：Edge 开着的时候复制 <Edge用户数据目录>\Default\Network\Cookies 必失败）。
    # 所以先试 `mode=ro&nolock=1` 直连原库——只读 + 不申请锁，能绕开浏览器的独占句柄；
    # 不行再退回复制（浏览器已关的情况下复制是最稳的）。
    # ⭐ 2026-11-21：改成遍历**所有 profile**。以前只读 Default，多账号用户
    #   （登录态在 Profile 1/2 里）就表现为“浏览器里明明登录了，工具说没 cookie”。
    import tempfile
    results: list[CookieEntry] = []
    for _db in cookie_dbs:
        _tag = _db.parent.parent.name or "default"
        conn = None
        tmp: Path | None = None
        try:
            try:
                conn = sqlite3.connect(f"file:{_db.as_posix()}?mode=ro&nolock=1", uri=True, timeout=3)
                conn.execute("SELECT name FROM cookies LIMIT 1")
            except Exception:
                # 直连不行（老版本 SQLite 或权限问题）→ 复制一份再读
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass
                    conn = None
                tmp = Path(tempfile.gettempdir()) / f"cookies-{int(time.time() * 1000)}-{_tag}.db"
                import shutil
                shutil.copy2(_db, tmp)
                conn = sqlite3.connect(f"file:{tmp.as_posix()}?mode=ro", uri=True, timeout=3)

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
        except Exception as exc:
            msg = str(exc)
            if "Permission" in msg or "WinError 32" in msg or "being used" in msg:
                # 典型：Edge 运行时独占 Cookies 文件。这句话比“提取失败”有用得多。
                _note(f"{browser} 的 cookie 库被浏览器占用（先把 {browser} 完全关闭再试）")
            else:
                _note(f"{browser}: {msg[:80]}")
            print(f"[cookies] read db {_db} failed: {exc}", file=sys.stderr)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
            if tmp is not None:
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
    if browser in ("edge", "chrome", "chromium", "brave", "vivaldi", "360", "qq", "opera"):
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
    # ⭐ 2026-11-21：后面加的两个。之前这两个平台只能粘贴 cookie——
    #   因为报名单里没它们，从浏览器提取永远是 0 条。
    "xiaoheihe": ["xiaoheihe.cn", "heybox.cn"],
    "pixiv": ["pixiv.net"],
}


# 自动探测的顺序。全都走同一套 Chromium cookie 库逻辑；Firefox 单独一套。
# 顺序按国内桌面端的普及率排：Chrome / Edge 先试，后面是本地的国产 Chromium 系。
_AUTO_BROWSERS = ("chrome", "edge", "brave", "vivaldi", "360", "qq", "firefox")

# ⭐ 2026-11-21：提取失败时的诊断记录。
#   为什么需要：实测 Edge 运行时会把 Cookies 文件**独占**（Chrome 允许共享读，Edge 不允许），
#   任何读取方式都拿 PermissionError——而用户看到的只是“没取到 cookie”。
#   这些 notes 会被 collector 拼进错误信息，让用户知道“关掉浏览器再试”而不是去怀疑没登录。
LAST_EXTRACT_NOTES: list[str] = []


def _note(msg: str) -> None:
    if msg and msg not in LAST_EXTRACT_NOTES:
        LAST_EXTRACT_NOTES.append(msg)


def extract_platform_cookies(
    platform: str,
    *,
    browser: str = "auto",
) -> list[CookieEntry]:
    """Extract all cookies for a platform from the given browser.

    `browser="auto"`：依次试 Chrome / Edge / Firefox，返回第一个有结果的。
    这样不管用户默认浏览器是哪个都能工作——之前写死 chrome，用户机器上
    默认是 Edge，结果是“登录成功了却说没取到 cookie”。
    """
    domains = PLATFORM_DOMAINS.get(platform, [])
    if not domains:
        return []

    LAST_EXTRACT_NOTES.clear()
    candidates = _AUTO_BROWSERS if browser == "auto" else (browser,)
    for name in candidates:
        seen: dict[str, CookieEntry] = {}  # name -> latest
        for dom in domains:
            for c in extract_browser_cookies(dom, browser=name):
                seen[c.name] = c
        if seen:
            return list(seen.values())
    return []

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
