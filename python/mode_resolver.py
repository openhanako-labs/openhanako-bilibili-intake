"""Analysis mode resolver — five-mode switch with compatibility layer.

Supports five analysis modes:
  - transcript   : subtitle/whisper only, no frame extraction or vision analysis
  - efficient    : keyframe-only extraction (default budget 50 frames)
  - balanced     : scene-change detection + uniform fallback (default 100 frames)
  - token-burner : dense uniform extraction (default 200+ frames)
  - frames-only  : extract frames but skip vision model analysis

Compatibility layer maps legacy --frame-detail values to the new mode system
and preserves backward-compatible parameters (--frame-detail, --frame-resolution).

Usage:
    from mode_resolver import resolve_mode, ModeMeta

    meta = resolve_mode(
        analysis_mode="balanced",
        frame_detail="token-burner",       # legacy compat
        frame_resolution=768,              # legacy compat
        max_frames_override=150,           # explicit override
        resolution_override=1024,          # explicit override
        visual_enabled=True,
    )
    print(meta.mode)        # "balanced"
    print(meta.frame_budget)  # 150 (overridden)
    print(meta.degradation_reason)  # None
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field, asdict
from typing import Any, Optional


# ── Mode definitions ─────────────────────────────────────────────────────────

VALID_MODES = frozenset(["transcript", "efficient", "balanced", "token-burner", "frames-only"])

DEFAULT_FRAME_BUDGETS: dict[str, Optional[int]] = {
    "transcript": None,       # no frames
    "efficient": 50,
    "balanced": 100,
    "token-burner": 200,
    "frames-only": 100,
}

LEGACY_DETAIL_MAP: dict[str, str] = {
    "efficient": "efficient",
    "balanced": "balanced",
    "token-burner": "token-burner",
}

# ── Data classes ─────────────────────────────────────────────────────────────


@dataclass
class ModeMeta:
    """Result of mode resolution — the single source of truth."""
    mode: str                              # resolved mode name
    frame_budget: Optional[int]            # actual frame budget used
    resolution: int                        # actual resolution used
    legacy_detail: Optional[str]           # original --frame-detail value (if any)
    has_overrides: bool                    # whether user explicitly overrode budget/resolution
    degradation_reason: Optional[str]      # reason for any downgrade/fallback
    is_transcript_only: bool               # True if transcript mode
    is_frames_only: bool                   # True if frames-only mode
    will_extract_frames: bool              # True if frames will be extracted
    will_run_vision: bool                  # True if vision analysis will run

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2)


@dataclass
class ResolutionConfig:
    """Resolution configuration with clamping and override support."""
    default: int = 512
    max_allowed: int = 1998
    min_allowed: int = 256

    def clamp(self, value: int) -> int:
        return max(self.min_allowed, min(self.max_allowed, value))


# ── Core resolver ────────────────────────────────────────────────────────────


def resolve_mode(
    analysis_mode: Optional[str] = None,
    frame_detail: Optional[str] = None,
    frame_resolution: Optional[int] = None,
    max_frames_override: Optional[int] = None,
    resolution_override: Optional[int] = None,
    visual_enabled: bool = True,
    legacy_compat: bool = True,
) -> ModeMeta:
    """Resolve analysis mode with full compatibility layer.

    Args:
        analysis_mode: New-style analysis mode (primary)
        frame_detail: Legacy --frame-detail value (compatibility layer)
        frame_resolution: Legacy --frame-resolution value (compatibility layer)
        max_frames_override: Explicit max frames cap (overrides mode default)
        resolution_override: Explicit resolution override
        visual_enabled: Whether vision analysis is enabled
        legacy_compat: Enable legacy parameter mapping

    Returns:
        ModeMeta with resolved values and metadata
    """
    rc = ResolutionConfig()
    degradation_reason = None
    has_overrides = False

    # ── Step 1: Determine effective mode ──
    effective_mode = _resolve_effective_mode(
        analysis_mode, frame_detail, frame_resolution,
        legacy_compat,
    )

    # ── Step 2: Resolve frame budget ──
    base_budget = DEFAULT_FRAME_BUDGETS.get(effective_mode, 100)
    frame_budget = base_budget

    if max_frames_override is not None:
        if max_frames_override <= 0:
            degradation_reason = f"max_frames_override={max_frames_override} is non-positive, capping to 1"
            max_frames_override = 1
        elif max_frames_override > 500:
            degradation_reason = f"max_frames_override={max_frames_override} exceeds 500, clamping to 500"
            max_frames_override = 500
        frame_budget = max_frames_override
        has_overrides = True

    if effective_mode == "transcript":
        frame_budget = None
        degradation_reason = "transcript mode skips frame extraction entirely"

    # ── Step 3: Resolve resolution ──
    resolution = rc.clamp(frame_resolution or rc.default)
    if resolution_override is not None:
        resolution = rc.clamp(resolution_override)
        has_overrides = True
        if resolution != rc.default:
            degradation_reason = f"resolution overridden to {resolution}px (default {rc.default}px)"

    # ── Step 4: Build result ──
    is_transcript = effective_mode == "transcript"
    is_frames_only = effective_mode == "frames-only"

    return ModeMeta(
        mode=effective_mode,
        frame_budget=frame_budget,
        resolution=resolution,
        legacy_detail=frame_detail if legacy_compat else None,
        has_overrides=has_overrides,
        degradation_reason=degradation_reason,
        is_transcript_only=is_transcript,
        is_frames_only=is_frames_only,
        will_extract_frames=not is_transcript,
        will_run_vision=visual_enabled and not is_transcript and not is_frames_only,
    )


def _resolve_effective_mode(
    analysis_mode: Optional[str],
    frame_detail: Optional[str],
    frame_resolution: Optional[int],
    legacy_compat: bool,
) -> str:
    """Determine the effective mode from all inputs."""
    # Priority: analysis_mode > frame_detail (legacy) > default
    if analysis_mode:
        if analysis_mode in VALID_MODES:
            return analysis_mode
        # Unknown analysis_mode — warn and fall back
        print(
            f"[mode_resolver] WARNING: unknown analysis_mode '{analysis_mode}', "
            f"falling back to frame_detail or 'balanced'",
            file=sys.stderr, flush=True,
        )

    if legacy_compat and frame_detail:
        mapped = LEGACY_DETAIL_MAP.get(frame_detail)
        if mapped:
            return mapped
        # Unknown legacy detail — warn
        print(
            f"[mode_resolver] WARNING: unknown frame_detail '{frame_detail}', falling back to 'balanced'",
            file=sys.stderr, flush=True,
        )

    return "balanced"  # ultimate default


# ── Compatibility helpers ────────────────────────────────────────────────────


def map_legacy_args(args: dict[str, Any]) -> dict[str, Any]:
    """Map legacy CLI/tool arguments to the new unified format.

    Accepts a dict like:
        {"frame_detail": "token-burner", "frame_resolution": 768, ...}
    Returns:
        {"analysis_mode": "token-burner", "resolution_override": 768, ...}
    """
    result = {}

    # Map frame_detail → analysis_mode
    fd = args.get("frame_detail")
    if fd and fd in LEGACY_DETAIL_MAP:
        result["analysis_mode"] = LEGACY_DETAIL_MAP[fd]

    # Map frame_resolution → resolution_override
    fr = args.get("frame_resolution")
    if fr is not None:
        result["resolution_override"] = int(fr)

    # Pass through other known params
    for key in ("max_frames", "visual"):
        if key in args:
            result[key] = args[key]

    return result


def build_compatibility_layer(input_args: dict[str, Any]) -> dict[str, Any]:
    """Full compatibility layer: detect legacy params, normalize, merge.

    This is the entry point called from collector.py / bilibili_video_intake.js.
    """
    normalized = dict(input_args)

    # Check for legacy frame_detail
    if "frame_detail" in normalized and "analysis_mode" not in normalized:
        fd = normalized["frame_detail"]
        if fd in LEGACY_DETAIL_MAP:
            normalized["analysis_mode"] = LEGACY_DETAIL_MAP[fd]
            # Keep frame_detail for logging
            normalized["_legacy_frame_detail"] = fd

    # Check for legacy frame_resolution
    if "frame_resolution" in normalized and "resolution_override" not in normalized:
        fr = normalized.get("frame_resolution")
        if fr is not None:
            normalized["resolution_override"] = int(fr)
            normalized["_legacy_frame_resolution"] = int(fr)

    # Normalize boolean flags
    if "visual" not in normalized:
        normalized["visual"] = True

    return normalized


# ── Logging helpers ──────────────────────────────────────────────────────────


def log_mode_meta(meta: ModeMeta, prefix: str = "[mode_resolver]") -> None:
    """Log resolved mode metadata to stderr."""
    lines = [
        f"{prefix} analysis_mode={meta.mode}",
        f"{prefix} frame_budget={'unlimited' if meta.frame_budget is None else meta.frame_budget}",
        f"{prefix} resolution={meta.resolution}px",
        f"{prefix} will_extract_frames={meta.will_extract_frames}",
        f"{prefix} will_run_vision={meta.will_run_vision}",
    ]
    if meta.legacy_detail:
        lines.append(f"{prefix} legacy_frame_detail={meta.legacy_detail}")
    if meta.has_overrides:
        lines.append(f"{prefix} overrides_applied=true")
    if meta.degradation_reason:
        lines.append(f"{prefix} note={meta.degradation_reason}")

    for line in lines:
        print(line, file=sys.stderr, flush=True)


def print_mode_summary(meta: ModeMeta) -> dict[str, Any]:
    """Print human-readable summary and return structured dict."""
    summary = {
        "mode": meta.mode,
        "frame_budget": meta.frame_budget,
        "resolution": meta.resolution,
        "will_extract_frames": meta.will_extract_frames,
        "will_run_vision": meta.will_run_vision,
        "legacy_detail": meta.legacy_detail,
        "overrides_applied": meta.has_overrides,
        "note": meta.degradation_reason,
    }

    print(f"\n{'='*60}", file=sys.stderr, flush=True)
    print(f"  Analysis Mode: {meta.mode.upper()}", file=sys.stderr, flush=True)
    print(f"  Frame Budget:  {'∞ unlimited' if meta.frame_budget is None else meta.frame_budget}, "
          f"{'capped' if meta.has_overrides else 'default'}", file=sys.stderr, flush=True)
    print(f"  Resolution:    {meta.resolution}px", file=sys.stderr, flush=True)
    print(f"  Extract Frames: {meta.will_extract_frames}", file=sys.stderr, flush=True)
    print(f"  Vision Model:   {meta.will_run_vision}", file=sys.stderr, flush=True)
    if meta.degradation_reason:
        print(f"  Note:           {meta.degradation_reason}", file=sys.stderr, flush=True)
    print(f"{'='*60}\n", file=sys.stderr, flush=True)

    return summary


# ── Main (standalone test) ──────────────────────────────────────────────────


if __name__ == "__main__":
    # Quick self-test
    tests = [
        {"analysis_mode": "transcript"},
        {"frame_detail": "token-burner"},
        {"analysis_mode": "balanced", "max_frames_override": 150},
        {"analysis_mode": "frames-only", "resolution_override": 1024},
        {"frame_detail": "efficient", "frame_resolution": 768},
        {"analysis_mode": "invalid-fallback-to-detail", "frame_detail": "balanced"},
    ]

    for i, kwargs in enumerate(tests, 1):
        print(f"\n--- Test {i}: {kwargs} ---")
        meta = resolve_mode(**kwargs)
        log_mode_meta(meta)
        summary = print_mode_summary(meta)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
