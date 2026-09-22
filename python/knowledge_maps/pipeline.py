"""知识地图管线编排：采集 → LLM 结构化 → Markdown 输出。

从 b-mind-ai 的 directions.py 和 maps.py 提取核心逻辑，适配 Bilibili Intake 插件：
- 数据采集复用插件已有的 bilibili_pipeline.py
- 输出格式改为 Markdown（供 Obsidian 阅读）而非 React Flow JSON
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from .llm_client import complete_json
from .prompts import (
    DIRECTIONS_SYSTEM, directions_prompt,
    MAP_SYSTEM, map_instructions, materials_for_prompt,
    CHALLENGE_SYSTEM, JUDGE_SYSTEM,
    SUPPLY_SYSTEM,
)
from .validator import collect_bvids, sanitize_graph

# 默认输出目录
OUTPUT_DIR = os.environ.get("KNOWLEDGE_MAP_OUTPUT", "W:/Games/Hanako/Work/output/知识地图/")


# =============================================================================
# 方向生成
# =============================================================================

async def generate_directions(
    topic: str,
    videos: list[dict[str, Any]],
) -> dict[str, Any]:
    """从主题 + 真实视频列表生成学习方向卡片。

    Args:
        topic: 用户输入的学习主题
        videos: 搜索到的真实视频列表（每项含 bvid, title, up, desc, plays 等）

    Returns:
        {
            "topic": str,
            "aliases": [str],
            "count": int,
            "directions": [
                {
                    "key": str,
                    "title": str,
                    "desc": str,
                    "tags": [str],
                    "searchQuery": str,
                    "source": dict,  # 真实视频来源
                }
            ]
        }
    """
    data = await complete_json(
        DIRECTIONS_SYSTEM,
        directions_prompt(topic, videos),
        temperature=0.5,
    )

    raw_dirs = data.get("directions") or []
    directions: list[dict[str, Any]] = []
    for i, d in enumerate(raw_dirs[:4]):
        index = d.get("videoIndex")
        if not isinstance(index, int) or not (0 <= index < len(videos)):
            index = i % len(videos)
        source = videos[index]
        directions.append({
            "key": str(d.get("key") or f"dir{i+1}").strip(),
            "title": str(d.get("title") or f"方向{i+1}").strip(),
            "desc": str(d.get("desc") or "").strip(),
            "tags": [str(t).strip() for t in (d.get("tags") or []) if str(t).strip()][:3],
            "searchQuery": str(d.get("searchQuery") or f"{topic} {d.get('title', '')}").strip(),
            "source": {
                "bvid": source.get("bvid", ""),
                "title": source.get("title", ""),
                "up": source.get("up", ""),
                "kind": source.get("kind", "video"),
            },
        })

    return {
        "topic": topic,
        "aliases": data.get("aliases", []),
        "count": len(videos),
        "directions": directions,
    }


# =============================================================================
# 知识地图生成
# =============================================================================

async def generate_knowledge_map(
    topic: str,
    direction_title: str,
    search_query: str,
    main_videos: list[dict[str, Any]],
    advanced_videos: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """从方向 + 真实素材生成递归学习地图。

    Args:
        topic: 学习主题
        direction_title: 方向标题
        search_query: B 站搜索词
        main_videos: 主线视频素材列表
        advanced_videos: 进阶视频素材列表（可选）

    Returns:
        清洗后的学习地图 JSON
    """
    adv = advanced_videos or []

    data = await complete_json(
        MAP_SYSTEM,
        map_instructions(topic, direction_title)
        + "\n\n真实素材：\n" + materials_for_prompt(main_videos, adv),
        temperature=0.5,
    )

    allowed = collect_bvids(main_videos, adv)
    raw_stages = data.get("stages") or []
    all_nodes = [n for st in raw_stages for n in (st.get("nodes") or [])]
    all_edges = [e for st in raw_stages for e in (st.get("edges") or [])]
    clean_nodes, clean_edges = sanitize_graph(all_nodes, all_edges, allowed, require_single_root=True)

    if not clean_nodes:
        raise RuntimeError("LLM 未能生成有效的地图节点，请重试。")

    # 重组阶段
    stages = _regroup_stages(raw_stages, clean_nodes, clean_edges)

    # 估算时长
    est_hours = _est_hours(main_videos, adv)

    return {
        "topic": topic,
        "direction": direction_title,
        "goal": str(data.get("goal") or f"走通「{direction_title}」这条学习路线。").strip(),
        "estHours": est_hours,
        "stages": stages,
        "generatedAt": int(time.time()),
    }


def _regroup_stages(raw_stages, clean_nodes, clean_edges):
    """按原始 stage 归属，把清洗后的节点/边重新分层。"""
    id2stage = {}
    for si, st in enumerate(raw_stages):
        for n in st.get("nodes") or []:
            nid = str(n.get("id") or "")
            if nid:
                id2stage[nid] = si

    stages = []
    for si, st in enumerate(raw_stages):
        s_nodes = [n for n in clean_nodes if id2stage.get(n["id"], 0) == si]
        s_edges = [e for e in clean_edges if id2stage.get(e["target"], 0) == si]
        if not s_nodes and not s_edges:
            continue
        stages.append({
            "depth": int(st.get("depth", si)),
            "title": str(st.get("title") or f"第 {si} 层"),
            "detail": str(st.get("detail") or ""),
            "nodes": s_nodes,
            "edges": s_edges,
        })

    if not stages and clean_nodes:
        stages = [{
            "depth": 0, "title": "学习地图", "detail": "",
            "nodes": clean_nodes, "edges": clean_edges,
        }]
    return stages


def _est_hours(main_videos, adv_videos) -> int:
    total = sum(int(m.get("durationSec") or 0) for m in main_videos + adv_videos)
    return max(2, round(total / 3600)) if total else 6


# =============================================================================
# 知识点验证
# =============================================================================

async def generate_challenge(concept: dict[str, Any]) -> dict[str, Any]:
    """为一个知识点现场生成一道检验。

    Args:
        concept: 知识点节点，含 title, learningGoal, keyPoints, domain

    Returns:
        {"kind": "problem"|"quiz", "prompt": str, "items": [str] (quiz 时)}
    """
    prompt = (
        f"知识点信息：\n{json.dumps({
            'title': concept.get('title', ''),
            'learningGoal': concept.get('learningGoal', ''),
            'keyPoints': [str(k) for k in (concept.get('keyPoints') or [])][:6],
            'domain': concept.get('domain', ''),
        }, ensure_ascii=False)}\n\n"
        "请输出 JSON：\n"
        "{\n"
        '  "kind": "problem 或 quiz",\n'
        '  "prompt": "题面/作答说明",\n'
        '  "items": ["quiz 才填：2-3 道小题"]\n'
        "}\n"
    )
    data = await complete_json(CHALLENGE_SYSTEM, prompt, temperature=0.6)
    kind = data.get("kind")
    if kind not in ("problem", "quiz"):
        kind = "quiz" if concept.get("keyPoints") else "problem"
    items = [str(i).strip() for i in (data.get("items") or []) if str(i).strip()][:4]
    text = str(data.get("prompt") or "").strip()
    if kind == "quiz" and not items:
        items = [f"请解释：{k}" for k in (concept.get("keyPoints") or [])[:3]]
        if not items:
            kind = "problem"
    if not text:
        text = "请围绕这个知识点作答，说明你的理解与推导过程。" if kind == "problem" else "请回答下列小题："
    out: dict[str, Any] = {"kind": kind, "prompt": text}
    if kind == "quiz":
        out["items"] = items
    return out


async def judge_answer(
    concept: dict[str, Any],
    challenge: dict[str, Any],
    answers: list[str],
) -> dict[str, Any]:
    """依据题面 + 用户答案判分。

    Returns:
        {"verdict": "pass"|"fail", "feedback": str, "hint": str}
    """
    kind = challenge.get("kind") or "problem"
    items = [str(i) for i in (challenge.get("items") or [])]
    ans = [str(a) for a in (answers or [])]
    if kind == "quiz" and items:
        qa = [{"question": items[i], "answer": ans[i] if i < len(ans) else ""} for i in range(len(items))]
        answer_block = json.dumps(qa, ensure_ascii=False)
    else:
        answer_block = json.dumps({"answer": ans[0] if ans else ""}, ensure_ascii=False)

    prompt = (
        f"知识点：{json.dumps({
            'title': concept.get('title', ''),
            'learningGoal': concept.get('learningGoal', ''),
            'keyPoints': [str(k) for k in (concept.get('keyPoints') or [])][:6],
        }, ensure_ascii=False)}\n"
        f"题型：{kind}\n"
        f"题面：{challenge.get('prompt') or ''}\n"
        f"用户作答：{answer_block}\n\n"
        "请判分并输出 JSON：\n"
        "{\n"
        '  "verdict": "pass 或 fail",\n'
        '  "feedback": "一句话总体点评",\n'
        '  "hint": "未通过时给一条改进方向；通过可留空"\n'
        "}"
    )
    data = await complete_json(JUDGE_SYSTEM, prompt, temperature=0.2)
    verdict = "pass" if str(data.get("verdict")).lower() == "pass" else "fail"
    return {
        "verdict": verdict,
        "feedback": str(data.get("feedback") or "").strip()
        or ("回答基本到位，已掌握。" if verdict == "pass" else "回答还没抓住核心，再想想。"),
        "hint": str(data.get("hint") or "").strip(),
    }


# =============================================================================
# 补给支线生成
# =============================================================================

async def generate_supply(
    node_id: str,
    question: str,
    materials: list[dict[str, Any]],
    *,
    topic: str | None = None,
    concept: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """生成一条补给支线。

    Args:
        node_id: 追问的知识点节点 ID
        question: 用户追问
        materials: 搜索到的相关视频素材
        topic: 子主题
        concept: 原知识点

    Returns:
        补给支线数据
    """
    allowed = collect_bvids(materials)

    data = await complete_json(
        SUPPLY_SYSTEM,
        _supply_prompt(question, materials, topic=topic or "", concept=concept),
        temperature=0.5,
    )

    clean_nodes, clean_edges = sanitize_graph(
        data.get("nodes") or [], data.get("edges") or [], allowed, require_single_root=True
    )
    if not clean_nodes:
        raise RuntimeError("LLM 未能生成有效的补给子树，请重试。")

    return {
        "id": f"sl_{int(time.time() * 1000)}",
        "parentNodeId": node_id,
        "question": question,
        "title": str(data.get("title") or f"「{topic or question}」补给包"),
        "nodes": clean_nodes,
        "edges": clean_edges,
    }


# =============================================================================
# 多视角对比：同一个知识点找不同 UP 主讲解对比
# =============================================================================

PERSPECTIVES_SYSTEM = """\
你是学习视角对比助手。用户正在跟随某位 UP 主学习一个知识点，
你会拿到其他 UP 主讲解同一知识点的【真实 B 站视频素材】。
请对比不同 UP 主的讲法差异，严格输出 JSON。
铁律：alternatives 里的 bvid 必须原样来自素材；startSec 只能取该素材 segments 中出现的 sec，
要选真正展开讲解该知识点的片段；讲法概述与差异要点必须基于素材内容，不得编造。
uniquePoints 只列该 UP 主确实讲到、而当前知识点关键点没有覆盖的增量知识点。"""

_PREJUDGE_SYSTEM = """\
你是学习规划助手。判断一个知识点是否值得去看其他老师的不同讲法：
典型值得的情况如一道题有多种解法、一个概念有多种理解路径/类比/应用场景；
不值得的如纯语法拼写、固定操作步骤、定义性知识等讲法大同小异的内容。
严格输出 JSON，不确定时宁可判 false。"""


async def generate_perspectives(
    concept: dict[str, Any],
    current_video: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """为知识点生成多视角对比（其他 UP 主的不同讲法）。

    Args:
        concept: 知识点节点，含 title, learningGoal, keyPoints, domain
        current_video: 当前视频信息，含 bvid, up

    Returns:
        {"needed": bool, "reason": str, "summary": str, "alternatives": [...]}
    """
    title = str(concept.get("title") or "").strip()
    if not title:
        return {"needed": False, "reason": "缺少知识点标题", "summary": "", "alternatives": []}

    current_video = current_video or {}
    exclude_bvid = str(current_video.get("bvid") or "")
    current_up = str(current_video.get("up") or "").strip()

    # 预判是否值得对比
    prej_prompt = (
        f"知识点：{title}\n"
        f"学习目标：{concept.get('learningGoal') or ''}\n"
        f"关键点：{json.dumps(concept.get('keyPoints') or [], ensure_ascii=False)}\n"
        f"领域：{concept.get('domain') or ''}\n\n"
        "请输出 JSON：\n"
        "{\n"
        '  "multiAngle": true或false（是否可能存在值得对比的不同讲法/解法）,\n'
        '  "reason": "一句话原因",\n'
        '  "query": "若值得对比，给出适合搜到不同讲法的 B 站检索词"\n'
        "}"
    )
    judged = await complete_json(_PREJUDGE_SYSTEM, prej_prompt, temperature=0.2)
    if not judged.get("multiAngle"):
        return {
            "needed": False,
            "reason": judged.get("reason") or "这个知识点各家讲法基本一致，无需额外对比。",
            "summary": "",
            "alternatives": [],
        }

    return {
        "needed": True,
        "reason": str(judged.get("reason") or ""),
        "summary": "值得对比其他 UP 主的讲法，建议搜索：「{}」".format(judged.get("query", title)),
        "query": str(judged.get("query") or title),
        "alternatives": [],  # 返回预判结果，具体对比由调用方按需触发
    }


# =============================================================================
# 追问分流：判断追问是当场答还是开支线
# =============================================================================

ASK_SYSTEM = """\
你是学习答疑助手。用户正在学习某个知识点，对它提出一个追问。
请判断如何回应这条追问，严格输出 JSON。两种回应二选一：
· answer（面板内直接作答）：适用于一句到几句话就能讲清的追问——概念澄清、举例、
比较区别、为什么、某一步怎么算、视频里讲过的具体问题等。
· branch（长出一条补给支线并找其他视频）：当追问指向一个【够大、值得系统展开】的子主题
或相关知识板块时使用——比如追问一个更深的原理、一个相关的大知识点。
branch 时必须给出 branchTopic 与 searchQuery。
铁律：不要编造视频事实。"""


async def answer_or_branch(
    node_id: str,
    question: str,
    *,
    concept: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """追问分流：判断是直接作答还是长出补给支线。

    Args:
        node_id: 追问的知识点节点 ID
        question: 用户追问
        concept: 原知识点

    Returns:
        {"mode": "answer"|"supply", "answer": str, "citations": [...], "line": {...} (supply 时)}
    """
    concept = concept or {}
    prompt = (
        f"用户追问：{question}\n"
        f"当前知识点：{concept.get('title') or ''}（{concept.get('learningGoal') or ''}）\n\n"
        "请输出 JSON：\n"
        "{\n"
        '  "mode": "answer" 或 "branch",\n'
        '  "answer": "answer 模式下给出简洁清楚的中文解答；branch 模式留空",\n'
        '  "branchTopic": "branch 模式下这条支线聚焦的子主题",\n'
        '  "searchQuery": "branch 模式下用来搜索相关视频的检索词"\n'
        "}"
    )
    data = await complete_json(ASK_SYSTEM, prompt, temperature=0.3)
    mode = str(data.get("mode") or "").strip().lower()
    answer_text = str(data.get("answer") or "").strip()

    if mode != "branch":
        return {
            "mode": "answer",
            "answer": answer_text or "这个问题我暂时没能整理出解答，换个问法再试试看。",
            "citations": [],
        }

    # branch 模式：返回路由信息，由调用方触发搜索和生成
    topic = str(data.get("branchTopic") or "").strip() or str(concept.get("title") or "")
    query = str(data.get("searchQuery") or "").strip() or f"{concept.get('title', '')} {question}"

    return {
        "mode": "supply",
        "answer": "",
        "branchTopic": topic,
        "searchQuery": query,
    }


def _supply_prompt(
    question: str,
    materials: list[dict],
    *,
    topic: str = "",
    concept: dict | None = None,
) -> str:
    packed = [
        {
            # 文档/文章类素材没有 BV 号 —— 别写死必填键
            "bvid": m.get("bvid", ""),
            "title": m.get("title", ""),
            "up": m.get("up", ""),
            "segments": [{"sec": s.get("sec", 0), "text": str(s.get("text", ""))[:80]} for s in (m.get("segments") or [])[:5]],
            # ⭐ P3：优先吃已总结素材（digest），其次字幕摘录，最后才是简介
            "summary": (m.get("digest") or m.get("subtitleExcerpt") or m.get("desc") or "")[:800],
        }
        for m in materials
    ]
    concept_title = str((concept or {}).get("title") or "")
    return (
        f"用户追问：{question}\n"
        f"聚焦子主题：{topic or question}\n"
        f"来源知识点：{concept_title}\n"
        f"真实素材：\n{json.dumps(packed, ensure_ascii=False)}\n\n"
        "请输出 JSON：\n"
        "{\n"
        '  "title": "补给包标题（紧扣聚焦子主题，如 「XXX」补给包）",\n'
        '  "nodes": [ 一棵子树：根 autoCollection(parent=null) → episode → clip → 1-2个 concept ],\n'
        '  "edges": [ {id,source,target} ]\n'
        "}\n"
        "节点字段：autoCollection{title,meta}；episode/clip 带 video{bvid,startSec,title,up}；"
        "concept 带 learningGoal,keyPoints,video,verification（编程 code / 其它 qa）。"
    )


# =============================================================================
# Markdown 输出
# =============================================================================

def map_to_markdown(map_data: dict[str, Any]) -> str:
    """将知识地图 JSON 转换为 Obsidian 可读的 Markdown。

    Args:
        map_data: generate_knowledge_map 的返回值

    Returns:
        Markdown 格式的知识地图文档
    """
    lines = []
    lines.append(f"# 知识地图：{map_data.get('topic', '')}")
    lines.append(f"方向：{map_data.get('direction', '')}")
    lines.append(f"目标：{map_data.get('goal', '')}")
    lines.append(f"预计时长：约 {map_data.get('estHours', '?')} 小时")
    lines.append(f"生成时间：{datetime.fromtimestamp(map_data.get('generatedAt', 0)).strftime('%Y-%m-%d %H:%M')}")
    lines.append("")

    for stage in map_data.get("stages", []):
        lines.append(f"## 阶段 {stage.get('depth', 0) + 1}：{stage.get('title', '')}")
        if stage.get("detail"):
            lines.append(f"> {stage['detail']}")
        lines.append("")

        for node in stage.get("nodes", []):
            kind = node.get("kind", "")
            title = node.get("title", "")
            vid = node.get("video", {})

            if kind == "collection":
                lines.append(f"### 📚 合集：{title}")
                if node.get("meta"):
                    lines.append(f"  {node['meta']}")
            elif kind == "episode":
                bvid = vid.get("bvid", "")
                up = vid.get("up", "")
                lines.append(f"- **🎬 {title}**")
                if bvid:
                    lines.append(f"  - BV：[{bvid}](https://www.bilibili.com/video/{bvid})")
                if up:
                    lines.append(f"  - UP主：{up}")
            elif kind == "clip":
                sec = vid.get("startSec", 0)
                bvid = vid.get("bvid", "")
                # ⭐ 2026-09-22：没有秒数（文档/文章类素材根本没有时间轴）就不写 `@?` ——
                #   以前会渲染成 `📌 标题 \`@?\``，看上去像个坏掉的跳转。
                ts = f"{sec // 60}:{sec % 60:02d}" if sec else ""
                url = f"https://www.bilibili.com/video/{bvid}?t={sec}" if (bvid and sec) else ""
                lines.append(f"  - 📌 {title}" + (f" `@{ts}`" if ts else ""))
                if url:
                    lines.append(f"    - [跳转]({url})")
                if node.get("summary"):
                    lines.append(f"    - {node['summary']}")
            elif kind == "concept":
                lines.append(f"    - 💡 **{title}**")
                if node.get("learningGoal"):
                    lines.append(f"      - 目标：{node['learningGoal']}")
                for kp in node.get("keyPoints", []):
                    lines.append(f"      - {kp}")
                ver = node.get("verification", {})
                if ver.get("type") == "qa":
                    lines.append(f"      - 验证：[{ver.get('question', '出题')}]")
                elif ver.get("type") == "code":
                    lines.append(f"      - 验证：[编程题]")
            elif kind == "autoCollection":
                lines.append(f"  - 🔄 进阶：{title}")
                if node.get("meta"):
                    lines.append(f"    - {node['meta']}")

            lines.append("")

    lines.append("---")
    lines.append("*由 [Bilibili Intake 知识地图] 自动生成*")
    return "\n".join(lines)


def save_markdown(map_data: dict[str, Any], output_dir: str | None = None) -> str:
    """将知识地图保存为 Markdown 文件。

    Args:
        map_data: 知识地图数据
        output_dir: 输出目录，默认 OUTPUT_DIR

    Returns:
        保存的文件路径
    """
    out_dir = output_dir or OUTPUT_DIR
    os.makedirs(out_dir, exist_ok=True)

    topic = map_data.get("topic", "untitled")
    direction = map_data.get("direction", "unknown")
    filename = f"{datetime.now().strftime('%Y-%m-%d')}-{_slugify(topic)}-{_slugify(direction)}-map.md"
    filepath = os.path.join(out_dir, filename)

    content = map_to_markdown(map_data)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

    return filepath


def _slugify(s: str) -> str:
    """生成简短的文件名 slug。"""
    s = s.lower().strip()
    s = s.replace(" ", "-")
    s = "".join(c for c in s if c.isalnum() or c in "-_")
    return s[:30] or "map"