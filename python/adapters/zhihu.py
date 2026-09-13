"""Zhihu (知乎) adapter — search + question/answer via public API."""
from __future__ import annotations

import re
from typing import Any

from . import (
    CommentNode,
    PlatformAdapter,
    SearchResult,
    http_get_json,
    register,
)


@register
class ZhihuAdapter(PlatformAdapter):
    platform_id = "zhihu"
    display_name = "知乎"
    url_patterns = [
        re.compile(r"zhihu\.com/question/(\d+)"),
        re.compile(r"zhihu\.com/answer/(\d+)"),
        re.compile(r"zhuanlan\.zhihu\.com/p/(\d+)"),
    ]
    enabled_by_default = True
    needs_login_for_full = False

    def search(self, keyword: str, *, limit: int = 10, sort: int = 0, page: int = 1) -> list[SearchResult]:
        if not keyword:
            return []
        cookies = self.load_cookies()
        data = http_get_json(
            "https://www.zhihu.com/api/v4/search_v3",
            params={
                "q": keyword,
                "t": "general",
                "limit": min(limit, 20),
                "offset": (page - 1) * limit,
            },
            cookies=cookies,
            headers={"Referer": "https://www.zhihu.com/search"},
        )
        if not isinstance(data, dict):
            return []
        items = data.get("data") or []
        results: list[SearchResult] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            obj = item.get("object") or {}
            t = item.get("type")
            if t == "search_result":
                # 嵌套
                inner_obj = (item.get("object") or {}).get("object") or {}
                t2 = (item.get("object") or {}).get("type")
                if t2 == "answer":
                    results.append(SearchResult(
                        platform="zhihu",
                        item_id=str(inner_obj.get("id", "")),
                        title=inner_obj.get("question", {}).get("title", ""),
                        author=(inner_obj.get("author") or {}).get("name", ""),
                        url=f"https://www.zhihu.com/answer/{inner_obj.get('id', '')}",
                        duration="",
                        like_count=inner_obj.get("voteup_count", 0) or 0,
                        comment_count=inner_obj.get("comment_count", 0) or 0,
                        extra={"type": "answer", "excerpt": inner_obj.get("excerpt", "")},
                    ))
                elif t2 == "question":
                    results.append(SearchResult(
                        platform="zhihu",
                        item_id=str(inner_obj.get("id", "")),
                        title=inner_obj.get("title", ""),
                        author=inner_obj.get("author", {}).get("name", "") if isinstance(inner_obj.get("author"), dict) else "",
                        url=f"https://www.zhihu.com/question/{inner_obj.get('id', '')}",
                        duration="",
                        like_count=0,
                        comment_count=inner_obj.get("comment_count", 0) or 0,
                        extra={"type": "question", "answer_count": inner_obj.get("answer_count", 0)},
                    ))
            elif t == "moment":
                # 想法
                pass
        return results[:limit]

    def get_item(self, source: str, *, page: int = 0) -> dict[str, Any]:
        # 支持 question / answer / article
        m = re.search(r"zhihu\.com/question/(\d+)(?:/answer/(\d+))?", source)
        if m:
            qid = m.group(1)
            aid = m.group(2)
            return self._get_question_or_answer(qid, aid)
        m = re.search(r"zhuanlan\.zhihu\.com/p/(\d+)", source)
        if m:
            return self._get_article(m.group(1))
        return {"ok": False, "error": "invalid zhihu url", "platform": "zhihu"}

    def _get_question_or_answer(self, qid: str, aid: str | None) -> dict[str, Any]:
        cookies = self.load_cookies()
        if aid:
            data = http_get_json(
                f"https://www.zhihu.com/api/v4/answers/{aid}",
                cookies=cookies,
                headers={"Referer": f"https://www.zhihu.com/question/{qid}/answer/{aid}"},
            )
            if not isinstance(data, dict):
                return {"ok": False, "error": "answer API failed", "platform": "zhihu"}
            return {
                "ok": True,
                "platform": "zhihu",
                "item_id": aid,
                "title": (data.get("question") or {}).get("title", ""),
                "description": data.get("excerpt", ""),
                "content": data.get("content", ""),
                "author": (data.get("author") or {}).get("name", ""),
                "uploader_id": (data.get("author") or {}).get("id", ""),
                "voteup_count": data.get("voteup_count", 0),
                "comment_count": data.get("comment_count", 0),
                "url": f"https://www.zhihu.com/question/{qid}/answer/{aid}",
            }
        else:
            data = http_get_json(
                f"https://www.zhihu.com/api/v4/questions/{qid}",
                cookies=cookies,
                headers={"Referer": f"https://www.zhihu.com/question/{qid}"},
            )
            if not isinstance(data, dict):
                return {"ok": False, "error": "question API failed", "platform": "zhihu"}
            return {
                "ok": True,
                "platform": "zhihu",
                "item_id": qid,
                "title": data.get("title", ""),
                "description": data.get("detail", ""),
                "answer_count": data.get("answer_count", 0),
                "follower_count": data.get("follower_count", 0),
                "url": f"https://www.zhihu.com/question/{qid}",
            }

    def _get_article(self, aid: str) -> dict[str, Any]:
        cookies = self.load_cookies()
        data = http_get_json(
            f"https://zhuanlan.zhihu.com/api/articles/{aid}",
            cookies=cookies,
            headers={"Referer": f"https://zhuanlan.zhihu.com/p/{aid}"},
        )
        if not isinstance(data, dict):
            return {"ok": False, "error": "article API failed", "platform": "zhihu"}
        return {
            "ok": True,
            "platform": "zhihu",
            "item_id": aid,
            "title": data.get("title", ""),
            "content": data.get("content", ""),
            "author": (data.get("author") or {}).get("name", ""),
            "voteup_count": data.get("voteup_count", 0),
            "comment_count": data.get("comment_count", 0),
            "url": f"https://zhuanlan.zhihu.com/p/{aid}",
        }

    def get_comments(self, source: str, *, limit: int = 50, max_depth: int = 3, with_sub_comments: bool = True) -> list[CommentNode]:
        # 知乎评论 API 需要登录态
        return []

    def get_creator(self, creator_id: str) -> dict[str, Any]:
        """通过用户 URL token 获取创作者信息。"""
        cookies = self.load_cookies()
        url_token = creator_id.strip()
        if not url_token.isalnum():
            return {"ok": False, "error": "invalid zhihu url token"}
        data = http_get_json(
            f"https://www.zhihu.com/api/v4/members/{url_token}",
            cookies=cookies,
            headers={"Referer": "https://www.zhihu.com/people/" + url_token},
        )
        if not isinstance(data, dict):
            return {"ok": False, "error": "creator API failed", "platform": "zhihu"}
        return {
            "ok": True,
            "platform": "zhihu",
            "creator_id": creator_id,
            "name": data.get("name", ""),
            "headline": data.get("headline", ""),
            "description": data.get("description", ""),
            "follower_count": data.get("follower_count", 0),
            "voteup_count": data.get("voteup_count", 0),
            "url": f"https://www.zhihu.com/people/{url_token}",
        }
