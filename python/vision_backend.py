"""Vision model backend abstraction.

Pluggable vision model backends for visual analysis of video frames.
The default backend uses OpenAI-compatible API (works with SiliconFlow,
OpenRouter, local vLLM/Ollama, or any OpenAI-compatible endpoint).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any


class VisionBackend(ABC):
    """Abstract base class for vision model backends."""

    @abstractmethod
    async def analyze(
        self,
        frames: list[dict],
        transcript: str,
        prompt: str = "Describe what happens in this video, including visual elements, on-screen text, and scene changes.",
    ) -> dict[str, Any]:
        """
        Analyze video frames + transcript with a vision model.

        Args:
            frames: List of frame dicts from frame_extractor.extract_frames(),
                    each with keys: index, timestamp_seconds, path, reason
            transcript: Video transcript text (with optional timestamps)
            prompt: Analysis prompt sent to the vision model

        Returns:
            {
                "summary": "High-level summary of the video content...",
                "timeline": [
                    {
                        "timestamp": "00:00",
                        "endTimestamp": "00:30",
                        "description": "Scene description...",
                        "keyFrame": "frame_001.jpg",
                        "spokenContent": "What was said at this moment...",
                    },
                    ...
                ],
                "keyMoments": [
                    {"time": "01:23", "description": "..."},
                    ...
                ],
                "screenText": [
                    {"time": "00:30", "text": "On-screen text..."},
                    ...
                ],
                "visualStyle": "vlog/tutorial/review/...",
                "sceneCount": 8,
            }
        """

    @abstractmethod
    def name(self) -> str:
        """Return the backend identifier, e.g. 'siliconflow'."""


def load_backend(name: str, config: dict[str, Any] | None = None) -> VisionBackend:
    """
    Factory to load a vision backend by name.

    Args:
        name: Backend identifier ("hanako", "siliconflow", "openai", "qwen-local")
        config: Provider-specific config (api_key, base_url, model, etc.)

    Returns:
        A VisionBackend instance

    Raises:
        ValueError: If the backend name is not recognized
    """
    if name == "hanako":
        return HanakoVisionBackend(config or {})
    if name == "siliconflow":
        from vision_backends.siliconflow import OpenAICompatibleBackend
        return OpenAICompatibleBackend(config or {})
    elif name == "openai":
        from vision_backends.openai import OpenAIBackend
        return OpenAIBackend(config or {})
    elif name == "qwen-local":
        from vision_backends.local_qwen import QwenLocalBackend
        return QwenLocalBackend(config or {})
    else:
        raise ValueError(
            f"Unknown vision backend: {name}. "
            f"Supported: hanako, siliconflow, openai, qwen-local"
        )


class HanakoVisionBackend(VisionBackend):
    """
    Agent-side vision backend.

    This backend does NOT call any vision API. It only extracts frames and
    returns them along with the transcript, so the calling Agent can perform
    the actual visual analysis using its own vision capability (current chat
    model or Hanako's configured auxiliary vision model).

    The result includes:
    - frames_dir: directory containing extracted frames
    - frames: list of frame references (path, timestamp, filename)
    - transcript_preview: first ~1000 chars of the transcript
    - needsAgentAnalysis: True (a marker the Agent uses to know it should analyze)
    - analysisInstructions: human-readable instructions for the Agent
    """

    def __init__(self, config: dict[str, Any] | None = None):
        self.config = config or {}

    def name(self) -> str:
        return "hanako"

    async def analyze(
        self,
        frames: list[dict],
        transcript: str,
        prompt: str = "Describe what happens in this video.",
    ) -> dict[str, Any]:
        frames_dir = ""
        if frames:
            frames_dir = str(Path(frames[0]["path"]).parent)
        return {
            "ok": True,
            "summary": f"已提取 {len(frames)} 帧视频画面，等待 Agent 分析",
            "frames_dir": frames_dir,
            "frame_count": len(frames),
            "frames": [
                {
                    "index": f.get("index", i),
                    "timestamp": f.get("timestamp_seconds", 0.0),
                    "path": f["path"],
                    "filename": Path(f["path"]).name,
                }
                for i, f in enumerate(frames[:50])
            ],
            "transcript_preview": transcript[:1000] if transcript else "",
            "needsAgentAnalysis": True,
            "analysisInstructions": (
                "请用当前模型的视觉能力（或 Hanako 的视觉辅助模型）"
                "读取关键帧图片，分析内容并更新 visual_analysis.md。"
            ),
            "_backend": "hanako",
        }
