"""Zhihu (知乎) adapter — search + question/answer via public API."""
from __future__ import annotations

import html as _html
import re
from typing import Any

from . import (
    CommentNode,
    PlatformAdapter,
    SearchResult,
    http_get_json,
    register,
)


def _html_to_text(raw: str) -> str:
    """知乎正文 HTML → 纯文本。

    知乎答案的 content 是一大块富文本（含 <figure>、<noscript> 懒加载图），
    直接存进 text.txt 的话，总结吃到的全是标签。这里只做三件事：
    剔 script/style、块级标签换行、实体反转义。
    """
    if not raw:
        return ""
    text = re.sub(r"(?is)<(script|style|noscript)\b.*?</\1>", "", raw)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(?:p|div|li|h[1-6]|blockquote|figure)>\s*", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = _html.unescape(text)
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _images_from_html(raw: str) -> list[dict[str, Any]]:
    """从正文 HTML 里抽图片。

    知乎用懒加载，真地址在 data-original / data-actualsrc，src 可能是占位符。
    优先取前者，都没有才用 src。
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for m in re.finditer(r"<img\b[^>]*>", raw or "", re.IGNORECASE):
        tag = m.group(0)
        url = ""
        for attr in ("data-original", "data-actualsrc", "src"):
            am = re.search(rf'{attr}\s*=\s*["\']([^"\']+)["\']', tag, re.IGNORECASE)
            if am:
                cand = am.group(1)
                if cand.startswith("http") and not cand.startswith("data:"):
                    url = cand
                    break
        if not url or url in seen:
            continue
        seen.add(url)
        out.append({
            "url": url,
            "thumb": url,
            "width": 0,
            "height": 0,
            "caption": f"图 {len(out) + 1}",
            # 知乎图床（pic1.zhimg.com）校 Referer
            "headers": {"Referer": "https://www.zhihu.com/"},
        })
    return out


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
                # ⚠️ 2026-11-22：这里以前写成 `item.object.object`，多取了一层。
                #   实测 search_v3 的结构是 item.object 就是答案/问题本体（
                #   item.object.type 直接是 "answer"/"question"/"article"），
                #   再往下取一层就是空 dict —— 后果是搜索结果 title 全空、
                #   url 拼成 `https://www.zhihu.com/answer/`（无 id），get_item 报 invalid url。
                inner_obj = obj
                t2 = obj.get("type")
                if t2 == "answer":
                    results.append(SearchResult(
                        platform="zhihu",
                        item_id=str(inner_obj.get("id", "")),
                        title=(inner_obj.get("title")
                               or (inner_obj.get("question") or {}).get("name")
                               or inner_obj.get("excerpt", "")[:40]),
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
                        title=inner_obj.get("title") or inner_obj.get("name", ""),
                        author=inner_obj.get("author", {}).get("name", "") if isinstance(inner_obj.get("author"), dict) else "",
                        url=f"https://www.zhihu.com/question/{inner_obj.get('id', '')}",
                        duration="",
                        like_count=0,
                        comment_count=inner_obj.get("comment_count", 0) or 0,
                        extra={"type": "question", "answer_count": inner_obj.get("answer_count", 0)},
                    ))
                elif t2 == "article":
                    results.append(SearchResult(
                        platform="zhihu",
                        item_id=str(inner_obj.get("id", "")),
                        title=inner_obj.get("title", ""),
                        author=(inner_obj.get("author") or {}).get("name", ""),
                        url=f"https://zhuanlan.zhihu.com/p/{inner_obj.get('id', '')}",
                        duration="",
                        like_count=inner_obj.get("voteup_count", 0) or 0,
                        comment_count=inner_obj.get("comment_count", 0) or 0,
                        extra={"type": "article", "excerpt": inner_obj.get("excerpt", "")},
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
        # ⭐ 2026-11-22：单独的 /answer/<id> 链接。搜索结果的 url 就是这个形式，
        #   以前只认 /question/<qid>/answer/<aid>，于是搜到了也打不开（报 invalid url）。
        m = re.search(r"zhihu\.com/answer/(\d+)", source)
        if m:
            return self._get_question_or_answer("", m.group(1))
        m = re.search(r"zhuanlan\.zhihu\.com/p/(\d+)", source)
        if m:
            return self._get_article(m.group(1))
        return {"ok": False, "error": "invalid zhihu url", "platform": "zhihu"}

    def _get_question_or_answer(self, qid: str, aid: str | None) -> dict[str, Any]:
        cookies = self.load_cookies()
        if aid:
            # qid 可能为空（直接给的是 /answer/<id>）——Referer 对应换个形式
            ref = (f"https://www.zhihu.com/question/{qid}/answer/{aid}" if qid
                   else f"https://www.zhihu.com/answer/{aid}")
            data = http_get_json(
                f"https://www.zhihu.com/api/v4/answers/{aid}",
                # ⚠️ 2026-11-22：不带 include=content 时接口**不返回正文**（实测裸调用
                #   1588 字节，带 include 是 2397 字节，差的正好是 content）。
                #   表现就是标题作者都有、正文 0 字。
                params={"include": "content"},
                cookies=cookies,
                headers={"Referer": ref},
            )
            if not isinstance(data, dict):
                return {"ok": False, "error": "answer API failed", "platform": "zhihu"}
            q = data.get("question") or {}
            # 正文是 HTML。以前直接丢给下游，text.txt 里存的是标签——总结和锚点都吃不到字。
            body = _html_to_text(str(data.get("content") or ""))
            return {
                "ok": True,
                "platform": "zhihu",
                "item_id": aid,
                "title": q.get("title", ""),
                "description": data.get("excerpt", ""),
                "content": body or data.get("excerpt", ""),
                "transcriptText": body or data.get("excerpt", ""),
                "textKind": "article",
                "kind": "post",
                "author": (data.get("author") or {}).get("name", ""),
                "uploader_id": (data.get("author") or {}).get("id", ""),
                "voteup_count": data.get("voteup_count", 0),
                "comment_count": data.get("comment_count", 0),
                "images": _images_from_html(data.get("content") or ""),
                "imageCount": len(_images_from_html(data.get("content") or "")),
                "url": f"https://www.zhihu.com/question/{q.get('id', qid)}/answer/{aid}",
            }
        else:
            data = http_get_json(
                f"https://www.zhihu.com/api/v4/questions/{qid}",
                params={"include": "detail"},
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
