"""Health check and routing utilities for bilibili-intake collector.

Separated from collector.py to keep that file manageable.
"""

from __future__ import annotations

import importlib.util
import platform as _platform
import sys
import time
from typing import Any, Callable

# ── 多后端路由表（v0.3+）──
# 每个平台配一个"首选 + 备选"列表，失败自动降级
#
# ⚠️ 2026-09-26：adapter 名必须是能对上的东西。以前写的是 "xhs_adapter" / "playwright_xhs" /
#   "weibo_adapter" 这一串 —— 代码里没有这些模块，真实实现全在 adapters/ 下。
#   而这个字段会原样显示到卡片的「状态」里，名字对不上就等于在给用户编一个不存在的后端。
_BACKENDS: dict[str, list[dict[str, Any]]] = {
    "bilibili": [
        {"adapter": "adapters/bilibili.py + yt-dlp", "priority": 0, "online_check": True},
        {"adapter": "adapters/bilibili.py（HTTP 兜底）", "priority": 1, "online_check": True},
    ],
    "xhs": [
        # 走真浏览器，必须有 cookies（卡片「扫码登录」或 --login xhs）；同文件自带 HTTP 兜底。
        {"adapter": "adapters/xhs.py（Playwright，需登录）", "priority": 0, "online_check": False},
        {"adapter": "adapters/xhs.py（HTTP 兜底）", "priority": 1, "online_check": False},
    ],
    "weibo": [{"adapter": "adapters/weibo.py", "priority": 0, "online_check": True}],
    "zhihu": [{"adapter": "adapters/zhihu.py", "priority": 0, "online_check": True}],
    "tieba": [{"adapter": "adapters/tieba.py", "priority": 0, "online_check": True}],
    "douyin": [{"adapter": "adapters/douyin.py（未完整实现）", "priority": 0, "online_check": False}],
    "kuaishou": [{"adapter": "adapters/kuaishou.py（未完整实现）", "priority": 0, "online_check": False}],
}

# 失败计数，临时跳过不可用后端（300 秒冷却）
_BACKEND_FAILURES: dict[str, float] = {}


def try_backends(platform: str, fetch_func: Callable, *args, **kwargs) -> tuple[Any, str, list[dict]]:
    """按优先级尝试各后端，失败自动降级。

    返回 (result, backend_used, fallback_chain)
    - result: 采集结果
    - backend_used: 成功后使用的后端名称
    - fallback_chain: 已尝试但失败的后端列表
    """
    backends = _BACKENDS.get(platform, [])
    failures: list[dict] = []

    for backend in backends:
        key = f"{platform}/{backend['adapter']}"

        # 跳过冷却中的后端
        if key in _BACKEND_FAILURES:
            if time.time() < _BACKEND_FAILURES[key]:
                failures.append({"adapter": backend["adapter"], "reason": "cooldown"})
                continue
            else:
                del _BACKEND_FAILURES[key]

        try:
            result = fetch_func(*args, backend=backend["adapter"], **kwargs)
            if result is not None:
                return result, backend["adapter"], failures
            failures.append({"adapter": backend["adapter"], "reason": "empty"})
        except Exception as e:
            failures.append({"adapter": backend["adapter"], "reason": str(e)[:200]})
            _BACKEND_FAILURES[key] = time.time() + 300

    raise RuntimeError(f"平台 {platform} 所有后端均失败: {failures}")


def get_routing_status() -> dict[str, Any]:
    """输出当前路由状态。"""
    status: dict[str, Any] = {}
    for platform, backends in _BACKENDS.items():
        status[platform] = []
        for b in backends:
            key = f"{platform}/{b['adapter']}"
            cooled = _BACKEND_FAILURES.get(key, 0)
            status[platform].append({
                "adapter": b["adapter"],
                "priority": b["priority"],
                "status": "cooling" if cooled > 0 else "ready",
            })
    return status


def run_health_check() -> dict[str, Any]:
    """执行健康诊断，返回完整诊断报告。"""
    report: dict[str, Any] = {
        "action": "health",
        "runtime": {},
        "platforms": {},
        "suggestions": [],
    }

    # ── Runtime ──
    report["runtime"]["python"] = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    report["runtime"]["platform"] = _platform.system()

    # CUDA
    try:
        import torch
        report["runtime"]["cuda"] = torch.version.cuda or "cpu"
        report["runtime"]["cuda_available"] = torch.cuda.is_available()
    except ImportError:
        report["runtime"]["cuda"] = None
        report["runtime"]["cuda_available"] = False

    # Whisper
    try:
        spec = importlib.util.find_spec("whisper")
        report["runtime"]["whisper"] = "installed" if spec else "missing"
    except Exception:
        report["runtime"]["whisper"] = "unknown"

    # Scrapling
    try:
        spec = importlib.util.find_spec("scrapling")
        report["runtime"]["scrapling"] = "installed" if spec else "missing"
    except Exception:
        report["runtime"]["scrapling"] = "unknown"

    # ── Platform connectivity ──
    for platform_id, backends in _BACKENDS.items():
        entry: dict[str, Any] = {"backends": len(backends), "status": "unknown"}
        try:
            if platform_id == "bilibili":
                import httpx
                r = httpx.get(
                    "https://api.bilibili.com/x/web-interface/online",
                    timeout=10,
                    headers={"User-Agent": "Mozilla/5.0"},
                )
                if r.status_code == 200:
                    entry["status"] = "ok"
                    entry["latency_ms"] = int(r.elapsed.total_seconds() * 1000)
                else:
                    entry["status"] = "fail"
                    entry["http_status"] = r.status_code
            elif platform_id in ("xhs", "weibo", "zhihu", "tieba"):
                entry["status"] = "unchecked"
                entry["note"] = "需要实际采集时才能确认可用性"
            else:
                entry["status"] = "stub"
                entry["note"] = "尚未实现完整支持"
        except Exception as e:
            entry["status"] = "error"
            entry["error"] = str(e)[:100]

        report["platforms"][platform_id] = entry

    # ── Suggestions ──
    if not report["runtime"].get("cuda"):
        report["suggestions"].append("CUDA 不可用，Whisper 将使用 CPU 转写（较慢）")
    if report["runtime"].get("whisper") == "missing":
        report["suggestions"].append("Whisper 未安装，B 站字幕自动转写功能不可用")

    return report