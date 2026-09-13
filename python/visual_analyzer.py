"""Visual analyzer — high-level orchestration for video visual analysis.

Coordinates frame extraction and vision model backend to produce
structured visual analysis output.

Usage:
    from visual_analyzer import run_visual_analysis

    result = run_visual_analysis(
        output_dir=Path("./output"),
        video_path=Path("./output/video.mp4"),
        transcript="Video transcript text...",
        backend="siliconflow",
        backend_config={"api_key": "..."},
        detail="balanced",
    )
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from frame_extractor import extract_frames
from vision_backend import load_backend

logger = logging.getLogger(__name__)


async def run_visual_analysis(
    video_path: str | Path,
    output_dir: str | Path,
    transcript: str = "",
    backend_name: str = "siliconflow",
    backend_config: dict[str, Any] | None = None,
    detail: str = "balanced",
    resolution: int = 512,
    prompt: str | None = None,
    max_frames: int | None = None,
) -> dict[str, Any]:
    """
    End-to-end visual analysis pipeline.

    Steps:
    1. Extract frames from video using frame_extractor
    2. Send frames + transcript to vision model backend
    3. Return structured analysis result

    Args:
        video_path: Path to video file
        output_dir: Directory for extracted frames and output
        transcript: Video transcript text (from subtitles or Whisper)
        backend_name: Vision backend identifier ("siliconflow", "openai", "qwen-local")
        backend_config: Backend-specific config (api_key, base_url, model, etc.)
        detail: Frame extraction detail ("efficient", "balanced", "token-burner")
        resolution: Frame width in pixels
        prompt: Custom analysis prompt (default: video analysis prompt)
        max_frames: Hard cap on frames (None = use detail-based default)

    Returns:
        Complete visual analysis result dict, ready to merge into result.json
    """
    backend_config = backend_config or {}
    prompt = prompt or (
        "Analyze this video's visual content. Provide a summary, a timeline of "
        "key segments with descriptions, notable key moments, any on-screen text, "
        "and the overall visual style."
    )

    output_dir = Path(output_dir)
    frames_dir = output_dir / "visual_frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: Extract frames
    logger.info(f"Extracting frames from {video_path} (detail={detail})")
    extraction_result = extract_frames(
        video_path=video_path,
        output_dir=frames_dir,
        detail=detail,
        resolution=resolution,
        max_frames=max_frames,
    )
    frames = extraction_result["frames"]
    logger.info(f"Extracted {len(frames)} frames using {extraction_result['engine']} engine")

    if not frames:
        logger.warning("No frames extracted — returning empty analysis")
        return _empty_result()

    # Step 2: Load vision backend and analyze
    logger.info(f"Analyzing {len(frames)} frames with {backend_name} backend")
    try:
        backend = load_backend(backend_name, backend_config)
        analysis = await backend.analyze(
            frames=frames,
            transcript=transcript,
            prompt=prompt,
        )
    except Exception as e:
        logger.error(f"Vision analysis failed: {e}")
        return _error_result(frames, str(e))

    # Step 3: Assemble result
    analysis["backend"] = backend_name
    analysis["framesExtracted"] = len(frames)
    analysis["frameDetail"] = detail
    analysis["frameResolution"] = resolution
    analysis["engine"] = extraction_result["engine"]
    analysis["engineMeta"] = extraction_result.get("engine_meta", {})

    # Save frame list for reference
    frame_refs = [
        {
            "index": f["index"],
            "timestamp": _format_ts(f["timestamp_seconds"]),
            "path": Path(f["path"]).name,
            "reason": f["reason"],
        }
        for f in frames
    ]
    analysis["frameReferences"] = frame_refs

    # Save analysis to file
    output_path = output_dir / "visual_analysis.json"
    import json
    output_path.write_text(
        json.dumps(analysis, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    logger.info(f"Visual analysis saved to {output_path}")

    return analysis


def _format_ts(seconds: float) -> str:
    """Format seconds as MM:SS."""
    total = int(round(seconds))
    minutes, sec = divmod(total, 60)
    return f"{minutes:02d}:{sec:02d}"


def _empty_result() -> dict[str, Any]:
    return {
        "ok": False,
        "error": "No frames extracted",
        "summary": "",
        "timeline": [],
        "keyMoments": [],
        "screenText": [],
        "visualStyle": "unknown",
        "sceneCount": 0,
    }


def _error_result(frames: list[dict], error: str) -> dict[str, Any]:
    return {
        "ok": False,
        "error": error,
        "summary": "Visual analysis failed.",
        "timeline": [
            {
                "timestamp": _format_ts(f["timestamp_seconds"]),
                "keyFrame": Path(f["path"]).name,
                "description": f"Analysis unavailable: {error}",
            }
            for f in frames[:5]
        ],
        "keyMoments": [],
        "screenText": [],
        "visualStyle": "unknown",
        "sceneCount": len(frames),
        "framesExtracted": len(frames),
    }
