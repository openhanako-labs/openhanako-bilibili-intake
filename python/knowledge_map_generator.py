"""知识地图生成 CLI 入口 — 供插件 JS 工具调用。

用法：
  python knowledge_map_generator.py --topic "C++ 指针" --videos <json_path>

参数：
  --topic      学习主题
  --direction  学习方向（可选）
  --videos     视频素材 JSON 文件路径
  --output     输出目录（可选，默认 OUTPUT_DIR）
  --mode       directions|map|challenge （默认 map）
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

# 确保能找到 knowledge_maps 包
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


async def main():
    parser = argparse.ArgumentParser(description="知识地图生成 CLI")
    parser.add_argument("--topic", required=True, help="学习主题")
    parser.add_argument("--direction", default="", help="学习方向")
    parser.add_argument("--videos", required=True, help="视频素材 JSON 文件路径")
    parser.add_argument("--output", default="", help="输出目录")
    parser.add_argument("--mode", default="directions", choices=["directions", "map", "challenge", "perspectives", "ask"],
                        help="运行模式")
    parser.add_argument("--search-query", default="", help="搜索词（map 模式）")
    args = parser.parse_args()

    # 读取视频素材
    with open(args.videos, "r", encoding="utf-8") as f:
        videos = json.load(f)

    result = {}

    if args.mode == "directions":
        from knowledge_maps.pipeline import generate_directions
        result = await generate_directions(args.topic, videos)
        result["type"] = "directions"

    elif args.mode == "map":
        from knowledge_maps.pipeline import generate_knowledge_map, save_markdown

        # 区分主线视频和进阶视频
        main_videos = videos
        advanced_videos = []

        search_query = args.search_query or f"{args.topic} {args.direction}"

        map_data = await generate_knowledge_map(
            topic=args.topic,
            direction_title=args.direction,
            search_query=search_query,
            main_videos=main_videos,
            advanced_videos=advanced_videos,
        )

        # 保存 Markdown
        output_dir = args.output or os.environ.get(
            "KNOWLEDGE_MAP_OUTPUT",
            "W:/Games/Hanako/Work/output/知识地图/"
        )
        filepath = save_markdown(map_data, output_dir)

        result = {
            "type": "map",
            "filepath": filepath,
            "topic": args.topic,
            "direction": args.direction,
            "estHours": map_data.get("estHours", 0),
            "stages": len(map_data.get("stages", [])),
            "markdown": map_data,
        }

    elif args.mode == "challenge":
        from knowledge_maps.pipeline import generate_challenge
        concept = videos  # 直接传入 concept 节点
        result = await generate_challenge(concept)
        result["type"] = "challenge"

    elif args.mode == "perspectives":
        from knowledge_maps.pipeline import generate_perspectives
        concept = videos if isinstance(videos, dict) else {}
        result = await generate_perspectives(concept)
        result["type"] = "perspectives"

    elif args.mode == "ask":
        from knowledge_maps.pipeline import answer_or_branch
        concept = videos if isinstance(videos, dict) else {}
        result = await answer_or_branch(
            node_id=args.topic,
            question=args.direction or args.topic,
            concept=concept,
        )
        result["type"] = "ask"

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())