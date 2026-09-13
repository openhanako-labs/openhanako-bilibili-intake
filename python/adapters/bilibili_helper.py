"""BV → AV 转换（参考 MediaCrawler 实现）"""
from __future__ import annotations

import urllib.request
import ssl
import json


_XOR_CODE = 23442827791579
_MAX_AID = 1 << 51
_BASE = 58
_BV_TABLE = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf"


def _bv_to_av_int(bv: str) -> int | None:
    """Convert BV 号 to numeric AV id using the standard algorithm."""
    if not bv or not bv.startswith("BV") or len(bv) != 12:
        return None
    # 1. swap positions
    bv_arr = list(bv)
    bv_arr[3], bv_arr[9] = bv_arr[9], bv_arr[3]
    bv_arr[4], bv_arr[7] = bv_arr[7], bv_arr[4]
    bv_str = "".join(bv_arr[3:])
    # 2. base58 decode
    r = 0
    for ch in bv_str:
        if ch not in _BV_TABLE:
            return None
        r = r * _BASE + _BV_TABLE.index(ch)
    # 3. subtract xor
    aid = (r - _XOR_CODE) ^ _MAX_AID
    return aid


def bv_to_av(bv: str) -> str | None:
    """Convert BV 号 to AV 号 string. Returns None on failure."""
    aid_int = _bv_to_av_int(bv)
    if aid_int is None:
        # fallback to web API
        try:
            url = f"https://api.bilibili.com/x/web-interface/view?bvid={bv}"
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://www.bilibili.com/",
            })
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if data.get("code") == 0:
                return str(data["data"]["aid"])
        except Exception:
            return None
        return None
    return str(aid_int)
