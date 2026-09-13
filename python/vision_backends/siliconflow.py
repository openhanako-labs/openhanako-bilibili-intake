"""OpenAI-compatible vision model backend.

Uses any OpenAI-compatible API endpoint (SiliconFlow, OpenRouter, local vLLM, etc.)
to analyze video frames with vision-capable models.
Supports Qwen-VL, GLM-5V, InternVL, and any model with OpenAI chat/completions vision API.
"""
from __future__ import annotations

import base64
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class OpenAICompatibleBackend:
    """
    Vision model backend for any OpenAI-compatible API endpoint.

    Works with:
    - SiliconFlow (Qwen-VL, GLM-5V, InternVL, etc.)
    - OpenRouter (any vision model)
    - Local vLLM / Ollama / LM Studio
    - Any provider with OpenAI chat/completions vision API

    The backend name is "siliconflow" for backward compatibility,
    but it accepts any OpenAI-compatible endpoint.
    """

    DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
    # Default model: Qwen3.5-397B-A17B on SiliconFlow
    # Users should override with their preferred model
    DEFAULT_MODEL = "Qwen/Qwen3.5-397B-A17B"

    def __init__(self, config: dict[str, Any]):
        self.api_key = config.get("api_key", "")
        self.base_url = config.get("base_url", self.DEFAULT_BASE_URL)
        self.model = config.get("model", self.DEFAULT_MODEL)
        self.max_frames_per_batch = config.get("max_frames_per_batch", 10)
        self.temperature = config.get("temperature", 0.3)

        if not self.api_key:
            raise ValueError(
                "Vision API key not configured. "
                "Set VISION_API_KEY in the environment, "
                "or pass it via config."
            )

    def name(self) -> str:
        return "siliconflow"  # backward compat

    @property
    def endpoint_description(self) -> str:
        """Return a human-readable description of the configured endpoint."""
        if self.base_url == self.DEFAULT_BASE_URL:
            return f"SiliconFlow ({self.model})"
        else:
            return f"{self.base_url} ({self.model})"

    def _encode_frame(self, frame_path: str) -> str:
        """Encode a local image file as base64."""
        p = Path(frame_path)
        if not p.exists():
            logger.warning(f"Frame file not found: {frame_path}")
            return ""
        return base64.b64encode(p.read_bytes()).decode("utf-8")

    def _build_system_prompt(self, prompt: str) -> str:
        return (
            "You are a professional video analyst. You will receive video frames "
            "with timestamps and a transcript. Analyze the visual content precisely. "
            "Be specific about what you see — objects, people, text on screen, "
            "scene transitions, actions, and visual style. "
            "Respond in the following JSON structure:\n"
            "{\n"
            '  "summary": "Brief overall summary of the video content",\n'
            '  "timeline": [\n'
            "    {\n"
            '      "timestamp": "00:00",\n'
            '      "endTimestamp": "00:30",\n'
            '      "description": "Detailed visual description of this segment",\n'
            '      "keyFrame": "frame_001.jpg",\n'
            '      "spokenContent": "What was said during this segment"\n'
            "    }\n"
            "  ],\n"
            '  "keyMoments": [\n'
            '    {"time": "01:23", "description": "Notable event"}\n'
            "  ],\n"
            '  "screenText": [\n'
            '    {"time": "00:30", "text": "Text visible on screen"}\n'
            "  ],\n"
            '  "visualStyle": "vlog/tutorial/review/documentary/...",\n'
            '  "sceneCount": 8\n'
            "}\n"
            "Important: Only output valid JSON. Do not include markdown code fences."
        )

    def _build_api_payload(self, messages: list[dict]) -> dict:
        """Build the OpenAI-compatible API request payload."""
        return {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": 4096,
        }

    def _build_user_message(self, frames: list[dict], transcript: str, prompt: str) -> list[dict]:
        """Build the multimodal user message with frames + transcript."""
        content: list[dict] = []

        # Add frames
        for frame in frames:
            b64 = self._encode_frame(frame["path"])
            if b64:
                content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/jpeg;base64,{b64}",
                        "detail": "low",  # frames are already 512px
                    },
                })

        # Add text prompt + transcript
        text_parts = [prompt]
        if transcript:
            text_parts.append(f"\n\nTranscript:\n{transcript[:4000]}")  # cap transcript length
        content.append({"type": "text", "text": "\n".join(text_parts)})

        return content

    async def analyze(
        self,
        frames: list[dict],
        transcript: str,
        prompt: str = "Analyze the visual content of this video. Describe what happens in each segment, note any on-screen text, and identify key moments.",
    ) -> dict[str, Any]:
        """
        Analyze frames using SiliconFlow's vision model API.

        For efficiency, frames are sent in batches (default 10 per batch)
        to avoid hitting token limits. Results are merged.
        """
        try:
            import httpx
        except ImportError:
            # Fallback to urllib if httpx not available
            return await self._analyze_urllib(frames, transcript, prompt)

        # Split frames into batches
        batches = self._split_batches(frames)
        all_results = []

        for batch in batches:
            messages = [
                {"role": "system", "content": self._build_system_prompt(prompt)},
                {"role": "user", "content": self._build_user_message(batch, transcript, prompt)},
            ]

            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=self._build_api_payload(messages),
                )
                response.raise_for_status()
                data = response.json()

            # Parse response
            content = data["choices"][0]["message"]["content"].strip()
            # Remove markdown code fences if present
            if content.startswith("```"):
                content = content.split("\n", 1)[-1]
                if content.endswith("```"):
                    content = content[:-3]
                content = content.strip()
            all_results.append(content)

        # Merge results from all batches
        return self._merge_results(all_results, frames, transcript)

    async def _analyze_urllib(self, frames, transcript, prompt):
        """Fallback analysis using urllib (no httpx dependency)."""
        import json
        import urllib.request

        batches = self._split_batches(frames)
        all_results = []

        for batch in batches:
            messages = [
                {"role": "system", "content": self._build_system_prompt(prompt)},
                {"role": "user", "content": self._build_user_message(batch, transcript, prompt)},
            ]

            payload = json.dumps(self._build_api_payload(messages)).encode("utf-8")

            req = urllib.request.Request(
                f"{self.base_url}/chat/completions",
                data=payload,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode())

            content = data["choices"][0]["message"]["content"].strip()
            if content.startswith("```"):
                content = content.split("\n", 1)[-1]
                if content.endswith("```"):
                    content = content[:-3]
                content = content.strip()
            all_results.append(content)

        return self._merge_results(all_results, frames, transcript)

    def _split_batches(self, frames: list[dict]) -> list[list[dict]]:
        """Split frames into batches for API calls."""
        batch_size = self.max_frames_per_batch
        return [frames[i:i + batch_size] for i in range(0, len(frames), batch_size)]

    def _merge_results(
        self, results: list[str], frames: list[dict], transcript: str
    ) -> dict[str, Any]:
        """Merge results from multiple API calls into a single structured output."""
        if not results:
            return self._empty_result(frames)

        # If only one batch, parse directly
        if len(results) == 1:
            try:
                parsed = json.loads(results[0])
                parsed["_frameCount"] = len(frames)
                return parsed
            except json.JSONDecodeError:
                logger.warning(f"Failed to parse vision model response: {results[0][:200]}")
                return self._fallback_result(frames, transcript)

        # Multiple batches: combine summaries, merge timelines
        try:
            parsed_batches = [json.loads(r) for r in results]
            # Merge timelines
            merged_timeline = []
            for batch in parsed_batches:
                if "timeline" in batch:
                    merged_timeline.extend(batch["timeline"])

            return {
                "summary": parsed_batches[0].get("summary", "Video analyzed in multiple segments."),
                "timeline": merged_timeline,
                "keyMoments": parsed_batches[0].get("keyMoments", []),
                "screenText": parsed_batches[0].get("screenText", []),
                "visualStyle": parsed_batches[0].get("visualStyle", "unknown"),
                "sceneCount": parsed_batches[0].get("sceneCount", len(merged_timeline)),
                "_frameCount": len(frames),
            }
        except (json.JSONDecodeError, KeyError):
            return self._fallback_result(frames, transcript)

    def _empty_result(self, frames: list[dict]) -> dict[str, Any]:
        return {
            "summary": "No frames to analyze.",
            "timeline": [],
            "keyMoments": [],
            "screenText": [],
            "visualStyle": "unknown",
            "sceneCount": 0,
            "_frameCount": 0,
        }

    def _fallback_result(self, frames: list[dict], transcript: str) -> dict[str, Any]:
        """Fallback when JSON parsing fails — return raw text + basic structure."""
        return {
            "summary": "Analysis returned non-JSON format. Raw text available.",
            "rawResponse": frames[0].get("_rawResponse", "") if frames else "",
            "timeline": [
                {
                    "timestamp": f.format_time(f["timestamp_seconds"]) if "format_time" in dir() else str(f.get("timestamp_seconds", 0)),
                    "description": "Frame-based analysis unavailable",
                    "keyFrame": Path(f["path"]).name,
                }
                for f in frames[:5]
            ],
            "keyMoments": [],
            "screenText": [],
            "visualStyle": "unknown",
            "sceneCount": len(frames),
            "_frameCount": len(frames),
        }
