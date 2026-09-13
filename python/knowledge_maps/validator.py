"""bvid 校验：确保 LLM 输出中的视频引用全部来自真实素材。

从 b-mind-ai 的 validate.py 提取。
核心保证：任何节点的 video.bvid 必须出现在本次真实抓取的 bvid 集合里，
否则剥离该 video 字段（保留结构，绝不展示伪造视频）。
"""
from __future__ import annotations

from typing import Any, Iterable

VALID_KINDS = {"collection", "autoCollection", "episode", "clip", "concept"}


def collect_bvids(*material_lists: Iterable[dict[str, Any]]) -> set[str]:
    """从素材列表中收集所有合法的 bvid。"""
    out: set[str] = set()
    for lst in material_lists:
        for m in lst or []:
            b = str(m.get("bvid") or "").strip()
            if b:
                out.add(b)
    return out


def _clean_video(video: Any, allowed: set[str]) -> dict[str, Any] | None:
    """清洗 video 字段：bvid 不在允许集合中则丢弃。"""
    if not isinstance(video, dict):
        return None
    bvid = str(video.get("bvid") or "").strip()
    if not bvid or bvid not in allowed:
        return None
    out: dict[str, Any] = {
        "bvid": bvid,
        "startSec": int(video.get("startSec") or 0),
        "title": str(video.get("title") or "").strip() or bvid,
    }
    if video.get("endSec"):
        try:
            out["endSec"] = int(video["endSec"])
        except (TypeError, ValueError):
            pass
    if video.get("up"):
        out["up"] = str(video["up"]).strip()
    return out


def _clean_verification(ver: Any) -> dict[str, Any] | None:
    """清洗 verification 字段。"""
    if not isinstance(ver, dict):
        return None
    vtype = ver.get("type")
    if vtype == "code":
        req = ver.get("requiredSnippets")
        if not isinstance(req, list) or not req:
            return None
        return {
            "type": "code",
            "prompt": str(ver.get("prompt") or "").strip(),
            "starterCode": str(ver.get("starterCode") or "").strip(),
            "expectedOutput": str(ver.get("expectedOutput") or "").strip(),
            "requiredSnippets": [str(s) for s in req][:6],
            "hint": str(ver.get("hint") or "").strip(),
        }
    if vtype == "qa":
        return {
            "type": "qa",
            "question": str(ver.get("question") or "").strip(),
            "referenceAnswer": str(ver.get("referenceAnswer") or "").strip(),
            "rubric": [str(s) for s in (ver.get("rubric") or []) if str(s).strip()][:6],
        }
    return None


def sanitize_graph(
    nodes: Iterable[dict[str, Any]],
    edges: Iterable[dict[str, Any]],
    allowed_bvids: set[str],
    *,
    require_single_root: bool = False,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """清洗节点与边：去非法 kind / 去重 id / 校验 bvid / 过滤悬空边。

    Args:
        nodes: LLM 输出的节点列表
        edges: LLM 输出的边列表
        allowed_bvids: 允许的 bvid 集合
        require_single_root: 是否要求单根

    Returns:
        (clean_nodes, clean_edges) 清洗后的节点和边
    """
    clean_nodes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        nid = str(n.get("id") or "").strip()
        kind = n.get("kind") or n.get("type")
        if not nid or nid in seen or kind not in VALID_KINDS:
            continue
        seen.add(nid)
        node: dict[str, Any] = {
            "id": nid,
            "kind": kind,
            "title": str(n.get("title") or "").strip() or nid,
            "parent": n.get("parent") if n.get("parent") else None,
        }
        if isinstance(n.get("order"), int) and n["order"] > 0:
            node["order"] = n["order"]
        for key in ("meta", "summary", "learningGoal", "supplyConcept"):
            if n.get(key):
                node[key] = str(n[key]).strip()
        if isinstance(n.get("keyPoints"), list):
            node["keyPoints"] = [str(k).strip() for k in n["keyPoints"] if str(k).strip()][:6]
        if isinstance(n.get("deps"), list):
            deps = [str(d).strip() for d in n["deps"] if str(d).strip()]
            if deps:
                node["deps"] = deps
        vid = _clean_video(n.get("video"), allowed_bvids)
        if vid:
            node["video"] = vid
        ver = _clean_verification(n.get("verification"))
        if ver and kind == "concept":
            node["verification"] = ver
        clean_nodes.append(node)

    ids = {n["id"] for n in clean_nodes}
    for n in clean_nodes:
        if n["parent"] is not None and n["parent"] not in ids:
            n["parent"] = None

    clean_edges: list[dict[str, Any]] = []
    eseen: set[str] = set()
    for e in edges or []:
        if not isinstance(e, dict):
            continue
        src, tgt = str(e.get("source") or ""), str(e.get("target") or "")
        if src not in ids or tgt not in ids:
            continue
        eid = str(e.get("id") or f"e-{src}-{tgt}")
        if eid in eseen:
            continue
        eseen.add(eid)
        clean_edges.append({"id": eid, "source": src, "target": tgt})

    if require_single_root:
        roots = [n for n in clean_nodes if n["parent"] is None]
        root = next((n for n in roots if n["kind"] == "collection"), roots[0] if roots else None)
        if root:
            for n in clean_nodes:
                if n is not root and n["parent"] is None:
                    n["parent"] = root["id"]
                    clean_edges.append({
                        "id": f"e-{root['id']}-{n['id']}",
                        "source": root["id"],
                        "target": n["id"],
                    })

    return clean_nodes, clean_edges