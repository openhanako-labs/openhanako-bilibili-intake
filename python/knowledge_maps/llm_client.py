"""LLM 调用封装：强制 JSON 输出 + 自动重试 + 端点兼容。

从 b-mind-ai 的 llm_client.py 提取，适配 Bilibili Intake 插件配置。
兼容两种端点形态，运行时自动探测：
- OpenAI Chat Completions（默认，/chat/completions）
- Anthropic 风格 Messages API（/messages）
"""
from __future__ import annotations

import asyncio
import json
import re
import os
from typing import Any

import httpx
# ⭐ 2026-09-22（P3）：不再依赖 `openai` 包。
#   App 的 venv 里只装了 requirements.txt 里那些（httpx 在内，openai 不在），
#   而地址、模型、key 本来就是从环境变量读的 —— 包这个依赖只用了一次
#   `client.chat.completions.create`。实测：map/directions/challenge 三个模式
#   全部在 `from openai import OpenAI` 这一行 ModuleNotFoundError，
#   即知识地图的 LLM 链路在本 App 里从来没跑通过。改成 httpx 直连，少一个依赖。

# 配置：从环境变量读取，与插件统一配置
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o")
LLM_TIMEOUT = int(os.environ.get("LLM_TIMEOUT", "60"))
LLM_RETRIES = int(os.environ.get("LLM_RETRIES", "3"))

_mode: str | None = None  # None=未知, "chat"=Chat Completions, "messages"=Messages API


def _require_key() -> str:
    if not OPENAI_API_KEY:
        raise RuntimeError("未配置 OPENAI_API_KEY（环境变量；App 子进程的 env 是白名单，创建进程时显式传入）")
    return OPENAI_API_KEY


_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def _extract_json(text: str) -> dict[str, Any]:
    """从模型输出里稳健地抽出 JSON 对象。"""
    s = _FENCE_RE.sub("", text).strip()
    try:
        return json.loads(s)
    except Exception:
        pass
    start, end = s.find("{"), s.rfind("}")
    if start != -1 and end != -1 and end > start:
        return json.loads(s[start: end + 1])
    raise ValueError("LLM 未返回可解析的 JSON")


def _call_chat(system: str, user: str, temperature: float, use_json: bool) -> dict[str, Any]:
    """OpenAI Chat Completions 形态（httpx 直连，不依赖 openai 包）。"""
    key = _require_key()
    url = OPENAI_BASE_URL.rstrip("/") + "/chat/completions"
    payload: dict[str, Any] = {
        "model": OPENAI_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
    }
    if use_json:
        payload["response_format"] = {"type": "json_object"}
    resp = httpx.post(
        url,
        headers={"Authorization": f"Bearer {key}", "content-type": "application/json"},
        json=payload,
        timeout=LLM_TIMEOUT,
    )
    # ⭐ 带响应体报错：`raise_for_status()` 只会说“400 Bad Request”，
    #   而真正的原因（模型不存在 / 不支持 response_format / 参数不合法）都在 body 里。
    #   顺带：complete_json 的重试判断看的是错误文本，带上 body 才能触发“去掉 response_format 重试”。
    if resp.status_code >= 400:
        raise RuntimeError(f"HTTP {resp.status_code}（{OPENAI_MODEL} @ {url}）：{resp.text[:400]}")
    data = resp.json()
    choices = data.get("choices") or []
    content = ((choices[0].get("message") or {}).get("content") if choices else "") or ""
    if not content:
        raise ValueError(f"LLM 返回为空（{OPENAI_MODEL} @ {url}）：{str(data)[:300]}")
    return _extract_json(content)


def _call_messages(system: str, user: str, temperature: float) -> dict[str, Any]:
    """Anthropic 风格 Messages API 形态（/messages）。"""
    key = _require_key()
    url = OPENAI_BASE_URL.rstrip("/") + "/messages"
    headers = {
        "Authorization": f"Bearer {key}",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload: dict[str, Any] = {
        "model": OPENAI_MODEL,
        "max_tokens": 8192,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    resp = httpx.post(url, headers=headers, json=payload, timeout=LLM_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
    return _extract_json("".join(parts))


def _looks_like_messages_api(msg: str) -> bool:
    m = msg.lower()
    return "messages api" in m or "/v1/messages" in m or "not enabled for the chat completions" in m


def _is_retryable(e: Exception) -> bool:
    if isinstance(e, (ValueError, json.JSONDecodeError)):
        return True
    m = str(e).lower()
    if any(k in m for k in ("401", "403", "404", "unauthorized", "forbidden", "invalid api key", "invalid_api_key")):
        return False
    if any(k in m for k in ("429", "rate limit", "overloaded", "500", "502", "503", "504",
                            "timeout", "timed out", "connection", "temporarily")):
        return True
    if "400" in m or "bad request" in m or "invalid" in m:
        return False
    return True


async def complete_json(
    system: str,
    user: str,
    *,
    temperature: float = 0.4,
    retries: int | None = None,
) -> dict[str, Any]:
    """异步 LLM 调用入口：强制 JSON 输出，自动重试与端点切换。

    Args:
        system: 系统级提示词
        user: 用户输入
        temperature: 温度参数，默认 0.4
        retries: 重试次数，默认 LLM_RETRIES

    Returns:
        解析后的 JSON 字典

    Raises:
        RuntimeError: LLM 调用失败
    """
    global _mode
    if retries is None:
        retries = LLM_RETRIES
    use_json = True
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            if _mode == "messages":
                return await asyncio.to_thread(_call_messages, system, user, temperature)
            return await asyncio.to_thread(_call_chat, system, user, temperature, use_json)
        except Exception as e:
            last = e
            msg = str(e).lower()
            if _mode != "messages" and _looks_like_messages_api(msg):
                _mode = "messages"
                continue
            if _mode != "messages" and use_json and ("response_format" in msg or ("json" in msg and "400" in msg)):
                use_json = False
                continue
            if not _is_retryable(e):
                break
            if attempt < retries:
                await asyncio.sleep(min(30.0, 2.0 * (2 ** attempt)))
    raise RuntimeError(f"LLM 调用失败：{last}")