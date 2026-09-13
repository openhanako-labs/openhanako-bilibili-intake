"""Douyin (抖音) adapter — minimal.

抖音 web API 都需要 msToken + X-Bogus 签名（极复杂），公开数据基本只能
通过 Playwright 拿。本 adapter 默认返回空，提示需要登录。
完整实现见 mediacrawler/media_platform/douyin/（作为参考）。
"""
from __future__ import annotations

import re
from typing import Any

from . import (
    CommentNode,
    PlatformAdapter,
    SearchResult,
    register,
)


@register
class DouyinAdapter(PlatformAdapter):
    platform_id = "douyin"
    display_name = "抖音"
    url_patterns = [
        re.compile(r"douyin\.com/video/(\d+)"),
        re.compile(r"iesdouyin\.com/web/api/v1/.*"),
    ]
    enabled_by_default = False  # 默认关闭，需要登录态才有价值
    needs_login_for_full = True

    def search(self, keyword: str, *, limit: int = 10, sort: int = 0, page: int = 1) -> list[SearchResult]:
        # 抖音 web search 需要 msToken + X-Bogus 签名；未实现。
        # 实现参考 mediacrawler/media_platform/douyin/client.py
        return []

    def get_item(self, source: str, *, page: int = 0) -> dict[str, Any]:
        return {
            "ok": False,
            "platform": "douyin",
            "error": "抖音需要 msToken + X-Bogus 签名，公开 API 不可用。请用 mediacrawler 模式或 Playwright 登录后接入。",
            "needs_login": True,
        }

    def get_comments(self, source: str, *, limit: int = 50, max_depth: int = 3, with_sub_comments: bool = True) -> list[CommentNode]:
        return []
