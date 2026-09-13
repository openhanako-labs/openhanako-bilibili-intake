"""Timeline alignment module for video analysis.

Aligns transcript segments with extracted frames to create a unified timeline.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def align_timeline(
    frames: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    tolerance: float = 2.0,
) -> dict[str, Any]:
    """Align transcript segments with extracted frames.

    Args:
        frames: List of frame dicts with 'timestamp_seconds' and 'path'
        segments: List of transcript segments with 'start', 'end', and 'text'
        tolerance: Maximum time difference for alignment (seconds)

    Returns:
        {
            "timeline": [...],
            "frame_count": 10,
            "segment_count": 20,
            "aligned_count": 8,
            "unaligned_frames": [...],
            "unaligned_segments": [...],
        }
    """
    if not frames or not segments:
        return {
            "timeline": [],
            "frame_count": len(frames),
            "segment_count": len(segments),
            "aligned_count": 0,
            "unaligned_frames": frames,
            "unaligned_segments": segments,
        }

    # Sort frames and segments by timestamp
    sorted_frames = sorted(frames, key=lambda f: f.get("timestamp_seconds", 0))
    sorted_segments = sorted(segments, key=lambda s: s.get("start", 0))

    timeline = []
    aligned_frames = set()
    aligned_segments = set()

    # For each frame, find the closest segment
    for i, frame in enumerate(sorted_frames):
        frame_ts = frame.get("timestamp_seconds", 0)
        best_match = None
        best_diff = float("inf")

        for j, seg in enumerate(sorted_segments):
            if j in aligned_segments:
                continue

            seg_start = seg.get("start", 0)
            seg_end = seg.get("end", 0)

            # Check if frame timestamp is within segment range
            if seg_start <= frame_ts <= seg_end:
                diff = 0
            else:
                # Calculate distance to nearest segment boundary
                diff = min(abs(frame_ts - seg_start), abs(frame_ts - seg_end))

            if diff < best_diff and diff <= tolerance:
                best_diff = diff
                best_match = j

        if best_match is not None:
            seg = sorted_segments[best_match]
            timeline.append({
                "timestamp": frame_ts,
                "frame_index": i,
                "frame_path": frame.get("path", ""),
                "frame_reason": frame.get("reason", ""),
                "segment_index": best_match,
                "segment_start": seg.get("start", 0),
                "segment_end": seg.get("end", 0),
                "segment_text": seg.get("text", ""),
                "alignment_confidence": 1.0 - (best_diff / tolerance),
                "evidence_type": "both",
            })
            aligned_frames.add(i)
            aligned_segments.add(best_match)
        else:
            timeline.append({
                "timestamp": frame_ts,
                "frame_index": i,
                "frame_path": frame.get("path", ""),
                "frame_reason": frame.get("reason", ""),
                "segment_index": None,
                "segment_start": None,
                "segment_end": None,
                "segment_text": None,
                "alignment_confidence": 0.0,
                "evidence_type": "visual_only",
            })

    # Add unaligned segments
    for j, seg in enumerate(sorted_segments):
        if j not in aligned_segments:
            timeline.append({
                "timestamp": seg.get("start", 0),
                "frame_index": None,
                "frame_path": None,
                "frame_reason": None,
                "segment_index": j,
                "segment_start": seg.get("start", 0),
                "segment_end": seg.get("end", 0),
                "segment_text": seg.get("text", ""),
                "alignment_confidence": 0.0,
                "evidence_type": "audio_only",
            })

    # Sort timeline by timestamp
    timeline.sort(key=lambda x: x["timestamp"])

    # Calculate statistics
    aligned_count = sum(1 for item in timeline if item["evidence_type"] == "both")
    unaligned_frames = [frames[i] for i in range(len(frames)) if i not in aligned_frames]
    unaligned_segments = [segments[j] for j in range(len(segments)) if j not in aligned_segments]

    return {
        "timeline": timeline,
        "frame_count": len(frames),
        "segment_count": len(segments),
        "aligned_count": aligned_count,
        "unaligned_frames": unaligned_frames,
        "unaligned_segments": unaligned_segments,
    }


def merge_evidence(
    timeline: list[dict[str, Any]],
    analysis_type: str = "summary",
) -> dict[str, Any]:
    """Merge visual and audio evidence from timeline.

    Args:
        timeline: Aligned timeline from align_timeline
        analysis_type: Type of analysis to perform

    Returns:
        {
            "summary": "...",
            "key_moments": [...],
            "visual_evidence": [...],
            "audio_evidence": [...],
            "model_inferences": [...],
        }
    """
    visual_evidence = []
    audio_evidence = []
    model_inferences = []

    for item in timeline:
        evidence_type = item.get("evidence_type", "unknown")

        if evidence_type in ("both", "visual_only"):
            visual_evidence.append({
                "timestamp": item["timestamp"],
                "frame_path": item.get("frame_path", ""),
                "frame_reason": item.get("frame_reason", ""),
            })

        if evidence_type in ("both", "audio_only"):
            audio_evidence.append({
                "timestamp": item["timestamp"],
                "segment_start": item.get("segment_start", 0),
                "segment_end": item.get("segment_end", 0),
                "segment_text": item.get("segment_text", ""),
            })

    # Generate summary based on analysis type
    summary = _generate_summary(timeline, analysis_type)

    # Extract key moments
    key_moments = _extract_key_moments(timeline)

    return {
        "summary": summary,
        "key_moments": key_moments,
        "visual_evidence": visual_evidence,
        "audio_evidence": audio_evidence,
        "model_inferences": model_inferences,
    }


def _generate_summary(timeline: list[dict[str, Any]], analysis_type: str) -> str:
    """Generate summary from timeline."""
    if not timeline:
        return "No timeline data available."

    # Collect all text from segments
    texts = []
    for item in timeline:
        if item.get("segment_text"):
            texts.append(item["segment_text"])

    if not texts:
        return "No transcript text available."

    # Simple concatenation for now
    return " ".join(texts)


def _extract_key_moments(timeline: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Extract key moments from timeline."""
    key_moments = []

    # Look for scene changes (frames with reason "scene-change")
    for item in timeline:
        if item.get("frame_reason") == "scene-change":
            key_moments.append({
                "timestamp": item["timestamp"],
                "type": "scene_change",
                "description": f"Scene change at {item['timestamp']:.1f}s",
                "evidence_type": item.get("evidence_type", "unknown"),
            })

    # Look for long segments (potential key points)
    for item in timeline:
        if item.get("segment_start") and item.get("segment_end"):
            duration = item["segment_end"] - item["segment_start"]
            if duration > 10:  # Long segment
                key_moments.append({
                    "timestamp": item["timestamp"],
                    "type": "long_segment",
                    "description": f"Long segment ({duration:.1f}s): {item.get('segment_text', '')[:50]}...",
                    "evidence_type": item.get("evidence_type", "unknown"),
                })

    # Sort by timestamp
    key_moments.sort(key=lambda x: x["timestamp"])

    return key_moments


def format_timeline_report(
    alignment_result: dict[str, Any],
    analysis_result: dict[str, Any],
) -> str:
    """Format timeline alignment and analysis results as a readable report.

    Args:
        alignment_result: Result from align_timeline
        analysis_result: Result from merge_evidence

    Returns:
        Formatted report string
    """
    lines = []
    lines.append("# 视频分析时间线报告\n")

    # Statistics
    lines.append("## 统计信息")
    lines.append(f"- 帧数: {alignment_result['frame_count']}")
    lines.append(f"- 转写段数: {alignment_result['segment_count']}")
    lines.append(f"- 对齐数: {alignment_result['aligned_count']}")
    lines.append(f"- 未对齐帧: {len(alignment_result['unaligned_frames'])}")
    lines.append(f"- 未对齐段: {len(alignment_result['unaligned_segments'])}")
    lines.append("")

    # Timeline
    lines.append("## 时间线")
    for item in alignment_result["timeline"]:
        ts = item["timestamp"]
        evidence = item["evidence_type"]
        text = item.get("segment_text", "")
        frame = item.get("frame_path", "")

        if evidence == "both":
            lines.append(f"[{ts:.1f}s] 🎬+🔊 {text[:50]}...")
        elif evidence == "visual_only":
            lines.append(f"[{ts:.1f}s] 🎬 仅画面")
        elif evidence == "audio_only":
            lines.append(f"[{ts:.1f}s] 🔊 {text[:50]}...")
    lines.append("")

    # Summary
    lines.append("## 摘要")
    lines.append(analysis_result.get("summary", "无摘要"))
    lines.append("")

    # Key moments
    lines.append("## 关键时刻")
    for moment in analysis_result.get("key_moments", []):
        ts = moment["timestamp"]
        desc = moment["description"]
        lines.append(f"- [{ts:.1f}s] {desc}")
    lines.append("")

    return "\n".join(lines)


if __name__ == "__main__":
    import json

    # Example usage
    frames = [
        {"index": 0, "timestamp_seconds": 0.0, "path": "frame_0001.jpg", "reason": "first-frame"},
        {"index": 1, "timestamp_seconds": 5.0, "path": "frame_0002.jpg", "reason": "scene-change"},
        {"index": 2, "timestamp_seconds": 10.0, "path": "frame_0003.jpg", "reason": "uniform"},
    ]

    segments = [
        {"start": 0.0, "end": 3.0, "text": "Hello, welcome to this video."},
        {"start": 3.5, "end": 7.0, "text": "Today we'll discuss something interesting."},
        {"start": 7.5, "end": 12.0, "text": "Let's get started."},
    ]

    # Align timeline
    alignment = align_timeline(frames, segments)
    print("Alignment result:")
    print(json.dumps(alignment, indent=2, ensure_ascii=False))

    # Merge evidence
    analysis = merge_evidence(alignment["timeline"])
    print("\nAnalysis result:")
    print(json.dumps(analysis, indent=2, ensure_ascii=False))

    # Format report
    report = format_timeline_report(alignment, analysis)
    print("\nReport:")
    print(report)
