"""Kuaishou (快手) adapter — minimal stub."""
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
class KuaishouAdapter(PlatformAdapter):
    platform_id = "kuaishou"
    display_name = "快手"
    url_patterns = [
        re.compile(r"kuaishou\.com/short-video/\w+"),
        re.compile(r"v\.kuaishou\.com/\w+"),
    ]
    enabled_by_default = False
    needs_login_for_full = True

    def search(self, keyword: str, *, limit: int = 10, sort: int = 0, page: int = 1) -> list[SearchResult]:
        return []

    def get_item(self, source: str, *, page: int = 0) -> dict[str, Any]:
        return {
            "ok": False,
            "platform": "kuaishou",
            "error": "快手公开 API 受限，需登录态。完整实现见 mediacrawler/media_platform/kuaishou/。",
            "needs_login": True,
        }

    def get_comments(self, source: str, *, limit: int = 50, max_depth: int = 3, with_sub_comments: bool = True) -> list[CommentNode]:
        return []
