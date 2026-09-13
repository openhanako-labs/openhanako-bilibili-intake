"""CLI argument parser for collector.py.

Extracted from collector.py for maintainability.
"""
from __future__ import annotations

import argparse


def build_parser() -> argparse.ArgumentParser:
    """Build and return the argument parser with all CLI options."""
    parser = argparse.ArgumentParser(
        description="Collect Bilibili metadata via Scrapling, audio/subtitles via yt-dlp, "
                    "and fallback transcript via Whisper."
    )
    parser.add_argument("--source")
    parser.add_argument("--output-dir")
    parser.add_argument("--audio-format", default="mp3")
    parser.add_argument("--whisper-model", default="small")
    parser.add_argument("--whisper-device", default="auto")
    parser.add_argument("--whisper-language", default="")
    parser.add_argument("--subtitle-language", action="append", dest="subtitle_languages", default=[])
    parser.add_argument("--cookies-file", default="")
    parser.add_argument("--page", type=int, default=0)
    parser.add_argument("--force-transcribe", action="store_true")
    parser.add_argument("--return-text-limit", type=int, default=12000)
    parser.add_argument("--use-scrapling", action="store_true", default=True,
                        help="Use Scrapling for metadata (default: True)")
    parser.add_argument("--with-comments", action="store_true",
                        help="Fetch video comments")
    parser.add_argument("--comment-limit", type=int, default=50,
                        help="Max comments to fetch (default: 50)")

    # --- Multi-platform ---
    parser.add_argument(
        "--action",
        default="",
        choices=["", "health", "routing-status"],
        help="特殊操作：health=健康诊断, routing-status=路由状态（默认空=正常采集）",
    )
    parser.add_argument(
        "--platform",
        default="auto",
        choices=["auto", "bilibili", "xhs", "douyin", "kuaishou", "weibo", "zhihu", "tieba"],
        help="目标平台（默认 auto 自动检测；可显式指定）",
    )
    parser.add_argument(
        "--with-sub-comments",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="采集评论时拉取二级评论（默认 True；传 --no-with-sub-comments 关闭）",
    )
    parser.add_argument(
        "--with-creator",
        action="store_true",
        help="顺便采集创作者/作者主页信息",
    )
    parser.add_argument(
        "--no-audio",
        action="store_true",
        help="仅采集元数据/评论，不下载音频（B站有效）",
    )

    # --- Cookies management (v0.2+) ---
    parser.add_argument(
        "--cookies-dir",
        default="",
        help="统一 cookies 存储目录（默认 <dataDir>/cookies）；可与 --cookies-file 并用但 --cookies-dir 优先",
    )
    parser.add_argument(
        "--import-cookies",
        default="",
        help="从 Netscape cookies.txt 导入到统一存储，格式：<platform>:<path>",
    )
    parser.add_argument(
        "--extract-cookies",
        default="",
        help="从浏览器提取 cookies 到统一存储，格式：<platform>:<browser>，browser=edge|chrome|firefox",
    )
    parser.add_argument(
        "--login",
        default="",
        help="启动 Playwright 扫码登录指定平台并保存 cookies，例：--login xhs",
    )
    parser.add_argument(
        "--login-timeout",
        type=int,
        default=180,
        help="--login 超时秒数（默认 180）",
    )
    parser.add_argument(
        "--logout",
        default="",
        help="删除指定平台的本地 cookies，例：--logout xhs",
    )
    parser.add_argument(
        "--list-logins",
        action="store_true",
        help="列出所有已保存 cookies 的平台状态",
    )

    # --- Batch / search mode ---
    parser.add_argument(
        "--mode",
        choices=["single", "search", "batch"],
        default="single",
        help="Operation mode: single (default) / search (list results only) / batch (search + fetch)",
    )
    parser.add_argument(
        "--search-keyword",
        default="",
        help="Search keyword (used when mode=search or mode=batch)",
    )
    parser.add_argument(
        "--search-limit",
        type=int,
        default=10,
        help="Max search results to return (default 10, max 50)",
    )
    parser.add_argument(
        "--search-sort",
        type=int,
        default=0,
        choices=[0, 1, 2, 3],
        help="Sort order: 0=comprehensive(default) 1=most played 2=most clicks 3=newest",
    )

    # --- Visual analysis (Claude Video integration) ---
    parser.add_argument(
        "--visual",
        action="store_true",
        help="Enable visual frame analysis of video content",
    )
    parser.add_argument(
        "--vision-backend",
        default="hanako",
        choices=["hanako", "siliconflow", "openai", "qwen-local"],
        help="Vision backend (default: hanako — Agent-side, no API call)",
    )
    parser.add_argument(
        "--frame-detail",
        default="balanced",
        choices=["efficient", "balanced", "token-burner"],
        help="Frame extraction detail level (default: balanced)",
    )
    parser.add_argument(
        "--frame-resolution",
        type=int,
        default=512,
        help="Frame width in pixels (default: 512, max: 1998)",
    )
    parser.add_argument(
        "--visual-prompt",
        default="",
        help="Custom visual analysis prompt (overrides default)",
    )
    parser.add_argument(
        "--vision-api-key",
        default="",
        help="Vision model API key (overrides config/env)",
    )
    parser.add_argument(
        "--vision-model",
        default="",
        help="Vision model name (default: Qwen/Qwen3.5-397B-A17B for siliconflow)",
    )
    parser.add_argument(
        "--vision-base-url",
        default="",
        help="Vision API base URL (default: https://api.siliconflow.cn/v1)",
    )
    return parser


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments. Accepts optional argv list for testing."""
    parser = build_parser()
    return parser.parse_args(argv)