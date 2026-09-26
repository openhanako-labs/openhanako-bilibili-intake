"""Report generator for video analysis.

Generates reports in multiple formats:
1. Transcript analysis (Markdown)
2. Visual analysis (Markdown + HTML with embedded frames)
3. Combined report (HTML for PDF export with images)
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any


def generate_transcript_report(
    title: str,
    uploader: str,
    duration: float,
    transcript: str,
    output_dir: Path,
) -> Path:
    """
    Generate transcript analysis report.
    
    Args:
        title: Video title
        uploader: UP主 name
        duration: Video duration in seconds
        transcript: Transcript text
        output_dir: Output directory
    
    Returns:
        Path to generated report
    """
    # Format duration
    minutes = int(duration // 60)
    seconds = int(duration % 60)
    duration_str = f"{minutes}:{seconds:02d}"
    
    # Word count
    word_count = len(transcript.split()) if transcript else 0
    char_count = len(transcript) if transcript else 0
    
    # Generate report
    report = f"""# 视频字幕分析报告

## 基本信息

| 项目 | 内容 |
|------|------|
| 标题 | {title} |
| UP主 | {uploader} |
| 时长 | {duration_str} |
| 字数 | {word_count} 词 / {char_count} 字符 |
| 生成时间 | {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} |

---

## 字幕内容

{transcript if transcript else "（无字幕）"}

---

## 统计信息

- 总词数：{word_count}
- 总字符数：{char_count}
- 平均语速：{word_count / (duration / 60):.1f} 词/分钟（如果有时长）

---

*报告由 hanako-bilibili-intake 插件自动生成*
"""
    
    # Write report
    report_path = output_dir / "transcript_analysis.md"
    report_path.write_text(report, encoding="utf-8")
    
    return report_path



# ── 以下三个函数（generate_visual_report / generate_visual_report_html / generate_reports）
#    已随旧视觉链路（frame_extractor / visual_analyzer）于 2026-09-26 删除。
#    画面分析现在走 lib/shots + 宿主视觉通道，产物是 shots/ 下的 shots.json / frames/ / visual_anchors.json，
#    不再由采集命令生成 visual_analysis.md / .html。
