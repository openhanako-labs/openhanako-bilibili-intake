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


def generate_visual_report(
    title: str,
    uploader: str,
    duration: float,
    frames: list[dict[str, Any]],
    transcript: str,
    output_dir: Path,
    visual_analysis: dict[str, Any] | None = None,
) -> Path:
    """
    Generate visual analysis report.
    
    Args:
        title: Video title
        uploader: UP主 name
        duration: Video duration in seconds
        frames: List of frame dicts with timestamp and path
        transcript: Transcript text
        output_dir: Output directory
        visual_analysis: Optional visual analysis result from Agent
    
    Returns:
        Path to generated report
    """
    # Format duration
    minutes = int(duration // 60)
    seconds = int(duration % 60)
    duration_str = f"{minutes}:{seconds:02d}"
    
    # Frame statistics
    frame_count = len(frames)
    if frames:
        first_ts = frames[0].get("timestamp", 0)
        last_ts = frames[-1].get("timestamp", 0)
        time_span = last_ts - first_ts
    else:
        time_span = 0
    
    # Generate frame timeline
    timeline_lines = []
    for i, frame in enumerate(frames[:50]):  # Limit to 50 frames
        ts = frame.get("timestamp", 0)
        ts_str = f"{int(ts // 60):02d}:{int(ts % 60):02d}"
        filename = frame.get("filename", f"frame_{i:04d}.jpg")
        timeline_lines.append(f"| {ts_str} | {filename} |")
    
    timeline_table = "\n".join(timeline_lines) if timeline_lines else "| - | 无帧 |"
    
    # Visual analysis content
    if visual_analysis and visual_analysis.get("ok"):
        analysis_content = f"""
## 视觉分析结果

{visual_analysis.get('summary', '无分析结果')}

### 关键帧

"""
        # Add key frames if available
        key_frames = visual_analysis.get("key_frames", [])
        if key_frames:
            for kf in key_frames[:10]:
                analysis_content += f"- **{kf.get('timestamp', '')}**: {kf.get('description', '')}\n"
        else:
            analysis_content += "（未提供关键帧分析）\n"
    else:
        analysis_content = """
## 视觉分析结果

待分析...

*请使用 Agent 的视觉能力分析帧图片*

"""
    
    # Generate report
    report = f"""# 视频视觉分析报告

## 基本信息

| 项目 | 内容 |
|------|------|
| 标题 | {title} |
| UP主 | {uploader} |
| 时长 | {duration_str} |
| 帧数 | {frame_count} |
| 时间跨度 | {time_span:.1f} 秒 |
| 生成时间 | {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} |

---

## 帧时间线

| 时间戳 | 文件名 |
|--------|--------|
{timeline_table}

---

{analysis_content}

---

## 帧文件位置

```
{output_dir / 'visual_frames'}
```

---

*报告由 hanako-bilibili-intake 插件自动生成*
"""
    
    # Write report
    md_report_path = output_dir / "visual_analysis.md"
    md_report_path.write_text(report, encoding="utf-8")
    
    # Also generate HTML version with embedded frame images for PDF export
    html_report_path = generate_visual_report_html(
        title=title,
        uploader=uploader,
        duration=duration,
        frames=frames,
        transcript=transcript,
        output_dir=output_dir,
        visual_analysis=visual_analysis,
    )
    
    return {"md": md_report_path, "html": html_report_path}


def generate_visual_report_html(
    title: str,
    uploader: str,
    duration: float,
    frames: list[dict[str, Any]],
    transcript: str,
    output_dir: Path,
    visual_analysis: dict[str, Any] | None = None,
) -> Path:
    """
    Generate HTML version of visual analysis report with embedded frame images.
    
    This ensures images render correctly when converting to PDF.
    
    Args:
        title: Video title
        uploader: UP主 name
        duration: Video duration in seconds
        frames: List of frame dicts with timestamp and path
        transcript: Transcript text
        output_dir: Output directory
        visual_analysis: Optional visual analysis result
    
    Returns:
        Path to generated HTML report
    """
    # Format duration
    minutes = int(duration // 60)
    seconds = int(duration % 60)
    duration_str = f"{minutes}:{seconds:02d}"
    
    # Frame statistics
    frame_count = len(frames)
    if frames:
        first_ts = frames[0].get("timestamp", 0)
        last_ts = frames[-1].get("timestamp", 0)
        time_span = last_ts - first_ts
    else:
        time_span = 0
    
    # Generate frame timeline table rows
    timeline_rows = ""
    for i, frame in enumerate(frames[:50]):  # Limit to 50 frames
        ts = frame.get("timestamp", 0)
        ts_str = f"{int(ts // 60):02d}:{int(ts % 60):02d}"
        filename = frame.get("filename", f"frame_{i:04d}.jpg")
        timeline_rows += f"<tr><td>{ts_str}</td><td>{filename}</td></tr>\n"
    
    if not timeline_rows:
        timeline_rows = '<tr><td>-</td><td>无帧</td></tr>\n'
    
    # Visual analysis content
    analysis_section = ""
    if visual_analysis and visual_analysis.get("ok"):
        key_frames_html = ""
        key_frames = visual_analysis.get("key_frames", [])
        if key_frames:
            for kf in key_frames[:10]:
                key_frames_html += f"<li><strong>{kf.get('timestamp', '')}</strong>: {kf.get('description', '')}</li>\n"
        else:
            key_frames_html = "<li>（未提供关键帧分析）</li>\n"
        
        analysis_section = f"""
<section class="analysis">
<h2>视觉分析结果</h2>
<p>{visual_analysis.get('summary', '无分析结果')}</p>
<h3>关键帧</h3>
<ul>{key_frames_html}</ul>
</section>
"""
    else:
        analysis_section = """
<section class="analysis">
<h2>视觉分析结果</h2>
<p>待分析...</p>
<p><em>请使用 Agent 的视觉能力分析帧图片</em></p>
</section>
"""
    
    # Frame thumbnails section (show all frames as thumbnails with timestamps)
    frame_thumbnails = ""
    for i, frame in enumerate(frames[:50]):
        ts = frame.get("timestamp", 0)
        ts_str = f"{int(ts // 60):02d}:{int(ts % 60):02d}"
        filename = frame.get("filename", f"frame_{i:04d}.jpg")
        frame_thumbnails += f"""
<div class="frame-item">
<img src="{filename}" alt="Frame at {ts_str}">
<p class="frame-time">{ts_str}</p>
</div>"""
    
    # Generate full HTML document
    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>视频视觉分析报告 - {title}</title>
<style>
  body {{ font-family: "Microsoft YaHei", sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }}
  h1 {{ font-size: 24px; border-bottom: 2px solid #333; padding-bottom: 10px; }}
  h2 {{ font-size: 20px; border-left: 4px solid #4a90d9; padding-left: 12px; margin-top: 30px; }}
  h3 {{ font-size: 17px; color: #4a90d9; margin-top: 20px; }}
  table {{ border-collapse: collapse; width: 100%; margin: 15px 0; }}
  th, td {{ border: 1px solid #ddd; padding: 8px 12px; text-align: left; }}
  th {{ background: #f5f5f5; font-weight: 600; }}
  .meta {{ font-size: 14px; color: #666; margin-bottom: 20px; }}
  .frames-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }}
  .frame-item {{ text-align: center; }}
  .frame-item img {{ max-width: 100%; height: auto; border: 1px solid #ddd; border-radius: 4px; }}
  .frame-time {{ font-size: 12px; color: #666; margin-top: 5px; }}
  footer {{ margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; font-size: 14px; color: #999; text-align: center; }}
</style>
</head>
<body>
<h1>「{title}」视频视觉分析报告</h1>
<p class="meta">UP主: {uploader} | 时长: {duration_str} | 帧数: {frame_count} | 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</p>

<section class="info">
<h2>基本信息</h2>
<table>
<tr><th>项目</th><th>内容</th></tr>
<tr><td>标题</td><td>{title}</td></tr>
<tr><td>UP主</td><td>{uploader}</td></tr>
<tr><td>时长</td><td>{duration_str}</td></tr>
<tr><td>帧数</td><td>{frame_count}</td></tr>
<tr><td>时间跨度</td><td>{time_span:.1f} 秒</td></tr>
</table>
</section>

<section class="timeline">
<h2>帧时间线</h2>
<table>
<thead><tr><th>时间戳</th><th>文件名</th></tr></thead>
<tbody>
{timeline_rows}</tbody>
</table>
</section>

<section class="frames">
<h2>帧画面预览</h2>
<div class="frames-grid">
{frame_thumbnails}
</div>
</section>

{analysis_section}

<footer>
<p>报告由 hanako-bilibili-intake 插件自动生成</p>
</footer>
</body>
</html>"""
    
    # Write HTML report
    html_report_path = output_dir / "visual_analysis.html"
    html_report_path.write_text(html, encoding="utf-8")
    
    return html_report_path


def generate_reports(
    result: dict[str, Any],
    output_dir: Path,
    visual_analysis: dict[str, Any] | None = None,
) -> dict[str, Path]:
    """
    Generate both reports from video analysis result.
    
    Args:
        result: Video analysis result from collector
        output_dir: Output directory
        visual_analysis: Optional visual analysis result
    
    Returns:
        Dict with report paths (includes both MD and HTML versions)
    """
    title = result.get("title", "未知标题")
    uploader = result.get("uploader", "未知UP主")
    duration = result.get("duration", 0)
    transcript = result.get("transcriptText", "")
    
    # Get frames from visual analysis
    frames = []
    if visual_analysis and visual_analysis.get("frames"):
        frames = visual_analysis["frames"]
    elif result.get("visualAnalysis", {}).get("frames"):
        frames = result["visualAnalysis"]["frames"]
    
    # Generate reports
    transcript_report = generate_transcript_report(
        title=title,
        uploader=uploader,
        duration=duration,
        transcript=transcript,
        output_dir=output_dir,
    )
    
    visual_reports = generate_visual_report(
        title=title,
        uploader=uploader,
        duration=duration,
        frames=frames,
        transcript=transcript,
        output_dir=output_dir,
        visual_analysis=visual_analysis,
    )
    
    return {
        "transcript_report": transcript_report,
        "visual_report_md": visual_reports.get("md"),
        "visual_report_html": visual_reports.get("html"),
    }
