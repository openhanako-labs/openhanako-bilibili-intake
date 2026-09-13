"""Video frame extraction module — inspired by claude-video /watch.

Extracts frames from video files at a duration-aware rate, with scene-change
detection, keyframe-only mode, and perceptual deduplication.

Usage as a library:
    from frame_extractor import extract_frames, get_video_metadata

    meta = get_video_metadata("/path/to/video.mp4")
    frames = extract_frames(
        video_path="/path/to/video.mp4",
        output_dir=Path("./frames"),
        detail="balanced",  # or "efficient" | "token-burner"
        resolution=512,
    )
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

# ── Constants ────────────────────────────────────────────────────────────────

MAX_FPS = 2.0
SCENE_THRESHOLD = 0.20
SCENE_MIN_FRAMES = 8
KEYFRAME_MIN = 4
MAX_READ_DIMENSION = 1998
DEDUP_THUMB = 16
DEDUP_THRESHOLD = 2.0
SHOWINFO_TS_RE = re.compile(r"pts_time:([0-9.]+)")


# ── Helpers ──────────────────────────────────────────────────────────────────

def _scale_filter(resolution: int) -> str:
    return (
        f"scale=w='min({resolution},iw)':h='min({MAX_READ_DIMENSION},ih)':"
        "force_original_aspect_ratio=decrease:force_divisible_by=2"
    )


def _clamp_fps(fps: float, duration_seconds: float, max_frames: int) -> tuple[float, int]:
    fps = min(fps, MAX_FPS)
    target = min(max_frames, max(1, int(round(fps * duration_seconds))))
    return fps, target


def parse_time(value: str | float | int | None) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return None
    parts = s.split(":")
    try:
        if len(parts) == 1:
            return float(parts[0])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except ValueError:
        pass
    raise ValueError(f"Cannot parse time value: {value!r}")


def format_time(seconds: float) -> str:
    total = int(round(seconds))
    hours, rem = divmod(total, 3600)
    minutes, sec = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{sec:02d}"
    return f"{minutes:02d}:{sec:02d}"


def _even_indices(count: int, n: int) -> list[int]:
    if n >= count:
        return list(range(count))
    if n <= 1:
        return [0]
    return [round(i * (count - 1) / (n - 1)) for i in range(n)]


# ── Metadata ─────────────────────────────────────────────────────────────────

def get_video_metadata(video_path: str | Path) -> dict[str, Any]:
    """Probe video metadata via ffprobe."""
    video_path = Path(video_path)
    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", str(video_path.resolve()),
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.strip()}")

    data = json.loads(result.stdout or "{}")
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = float(fmt.get("duration") or video_stream.get("duration") or 0)
    return {
        "duration_seconds": duration,
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "codec": video_stream.get("codec_name"),
        "size_bytes": int(fmt.get("size") or 0),
        "has_audio": audio_stream is not None,
    }


# ── Frame budgets ────────────────────────────────────────────────────────────

def auto_fps(duration_seconds: float, max_frames: int = 100) -> tuple[float, int]:
    """Pick fps targeting a sensible frame budget for full-video scans."""
    if duration_seconds <= 0:
        return 1.0, 1
    if duration_seconds <= 30:
        target = min(max_frames, max(12, int(round(duration_seconds))))
    elif duration_seconds <= 60:
        target = min(max_frames, 40)
    elif duration_seconds <= 180:
        target = min(max_frames, 60)
    elif duration_seconds <= 600:
        target = min(max_frames, 80)
    else:
        target = max_frames
    return _clamp_fps(target / duration_seconds, duration_seconds, max_frames)


def auto_fps_focus(duration_seconds: float, max_frames: int = 100) -> tuple[float, int]:
    """Denser budget for user-specified ranges."""
    if duration_seconds <= 0:
        return min(MAX_FPS, 2.0), 2
    if duration_seconds <= 5:
        target = min(max_frames, max(10, int(round(duration_seconds * 6))))
    elif duration_seconds <= 15:
        target = min(max_frames, max(30, int(round(duration_seconds * 4))))
    elif duration_seconds <= 30:
        target = min(max_frames, 60)
    elif duration_seconds <= 60:
        target = min(max_frames, 80)
    else:
        target = max_frames
    return _clamp_fps(target / duration_seconds, duration_seconds, max_frames)


# ── Extraction engines ───────────────────────────────────────────────────────

def _uniform_extract(
    video_path: str | Path, out_dir: Path, fps: float,
    resolution: int = 512, max_frames: int = 100,
    start_seconds: float | None = None, end_seconds: float | None = None,
) -> list[dict]:
    """Uniform frame extraction via ffmpeg fps filter."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for existing in out_dir.glob("frame_*.jpg"):
        existing.unlink()

    output_pattern = str(out_dir / "frame_%04d.jpg")
    cmd: list[str] = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
    ]
    if start_seconds is not None:
        cmd += ["-ss", f"{start_seconds:.3f}"]
    if end_seconds is not None:
        cmd += ["-to", f"{end_seconds:.3f}"]
    cmd += [
        "-i", str(Path(video_path).resolve()),
        "-vf", f"fps={fps},{_scale_filter(resolution)}",
        "-frames:v", str(max_frames),
        "-q:v", "4",
        output_pattern,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg frame extraction failed: {result.stderr.strip()}")

    offset = start_seconds or 0.0
    frames = sorted(out_dir.glob("frame_*.jpg"))
    return [
        {
            "index": i,
            "timestamp_seconds": round(offset + (i / fps if fps > 0 else 0.0), 2),
            "path": str(p),
            "reason": "uniform",
        }
        for i, p in enumerate(frames)
    ]


def _scene_extract(
    video_path: str | Path, out_dir: Path,
    resolution: int = 512, max_frames: int | None = 100,
    start_seconds: float | None = None, end_seconds: float | None = None,
    threshold: float = SCENE_THRESHOLD,
) -> list[dict]:
    """Scene-change frame extraction."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for existing in out_dir.glob("frame_*.jpg"):
        existing.unlink()

    output_pattern = str(out_dir / "frame_%04d.jpg")
    cmd: list[str] = [
        "ffmpeg", "-hide_banner", "-loglevel", "info", "-y",
    ]
    if start_seconds is not None:
        cmd += ["-ss", f"{start_seconds:.3f}"]
    if end_seconds is not None:
        cmd += ["-to", f"{end_seconds:.3f}"]
    vf = f"select='eq(n,0)+gt(scene,{threshold})',{_scale_filter(resolution)},showinfo"
    cmd += [
        "-i", str(Path(video_path).resolve()),
        "-vf", vf,
        "-fps_mode", "vfr",
    ]
    if max_frames is not None:
        cmd += ["-frames:v", str(max_frames)]
    cmd += ["-q:v", "4", output_pattern]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg scene extraction failed: {result.stderr.strip()}")

    offset = start_seconds or 0.0
    timestamps = [round(offset + float(m.group(1)), 2)
                  for m in SHOWINFO_TS_RE.finditer(result.stderr)]
    frames = sorted(out_dir.glob("frame_*.jpg"))
    out: list[dict] = []
    for i, path in enumerate(frames):
        ts = timestamps[i] if i < len(timestamps) else offset
        out.append({
            "index": i,
            "timestamp_seconds": ts,
            "path": str(path),
            "reason": "first-frame" if i == 0 else "scene-change",
        })
    return out


def _keyframe_extract(
    video_path: str | Path, out_dir: Path,
    resolution: int = 512, max_frames: int | None = 50,
    start_seconds: float | None = None, end_seconds: float | None = None,
) -> tuple[list[dict], dict]:
    """Keyframe-only extraction (cheap, near-instant)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for existing in out_dir.glob("frame_*.jpg"):
        existing.unlink()

    output_pattern = str(out_dir / "frame_%04d.jpg")
    cmd: list[str] = [
        "ffmpeg", "-hide_banner", "-loglevel", "info", "-y",
        "-skip_frame", "nokey",
        "-i", str(Path(video_path).resolve()),
        "-vf", f"{_scale_filter(resolution)},showinfo",
        "-fps_mode", "vfr",
        "-q:v", "4",
        output_pattern,
    ]
    if start_seconds is not None:
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info", "-y",
               "-ss", f"{start_seconds:.3f}", "-skip_frame", "nokey",
               "-i", str(Path(video_path).resolve()),
               "-vf", f"{_scale_filter(resolution)},showinfo",
               "-fps_mode", "vfr", "-q:v", "4", output_pattern]
    if end_seconds is not None:
        cmd.insert(cmd.index("-i") - 1, "-to")
        cmd.insert(cmd.index("-i"), f"{end_seconds:.3f}")

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg keyframe extraction failed: {result.stderr.strip()}")

    offset = start_seconds or 0.0
    timestamps = [round(offset + float(m.group(1)), 2)
                  for m in SHOWINFO_TS_RE.finditer(result.stderr)]
    files = sorted(out_dir.glob("frame_*.jpg"))
    candidates: list[dict] = []
    for i, path in enumerate(files):
        ts = timestamps[i] if i < len(timestamps) else offset
        candidates.append({
            "index": i,
            "timestamp_seconds": ts,
            "path": str(path),
            "reason": "keyframe",
        })

    if len(candidates) < KEYFRAME_MIN:
        for cand in candidates:
            try:
                Path(cand["path"]).unlink()
            except OSError:
                pass
        meta = get_video_metadata(video_path)
        eff_duration = max(0.0, (end_seconds or meta["duration_seconds"]) - (start_seconds or 0.0))
        budget = max_frames if max_frames is not None else 100
        fps, _ = auto_fps(eff_duration, max_frames=budget)
        frames_out = _uniform_extract(
            video_path, out_dir, fps=fps, resolution=resolution,
            max_frames=budget, start_seconds=start_seconds, end_seconds=end_seconds,
        )
        frames_out, n_dropped = _dedupe(frames_out)
        return frames_out, {
            "engine": "uniform", "candidate_count": len(candidates),
            "deduped_count": n_dropped, "selected_count": len(frames_out),
            "fallback": True,
        }

    deduped, n_dropped = _dedupe(candidates)
    cap = len(deduped) if max_frames is None else max_frames
    selected = [deduped[i] for i in _even_indices(len(deduped), cap)]
    for i, frame in enumerate(selected):
        frame["index"] = i
    return selected, {
        "engine": "keyframe", "candidate_count": len(candidates),
        "deduped_count": n_dropped, "selected_count": len(selected),
        "fallback": False,
    }


# ── Deduplication ────────────────────────────────────────────────────────────

def _thumb_frames(paths: list[Path]) -> list[bytes]:
    """Decode frames to small grayscale thumbnails for dedup comparison."""
    if not paths:
        return []
    paths = [Path(p) for p in paths]
    m = re.match(r"(.*?)(\d+)(\.[A-Za-z0-9]+)$", paths[0].name)
    if m is None:
        return []
    prefix, digits, ext = m.group(1), m.group(2), m.group(3)
    pattern = str(paths[0].parent / f"{prefix}%0{len(digits)}d{ext}")

    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-start_number", str(int(digits)),
        "-i", pattern,
        "-vf", f"scale={DEDUP_THUMB}:{DEDUP_THUMB},format=gray",
        "-f", "rawvideo", "-",
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        return []

    chunk = DEDUP_THUMB * DEDUP_THUMB
    data = result.stdout
    if len(data) != chunk * len(paths):
        return []
    return [data[i * chunk:(i + 1) * chunk] for i in range(len(paths))]


def _frame_delta(a: bytes, b: bytes) -> float:
    if not a or len(a) != len(b):
        return float("inf")
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def _dedupe_by_deltas(
    candidates: list[dict], thumbs: list[bytes],
    threshold: float = DEDUP_THRESHOLD,
) -> tuple[list[dict], int]:
    if len(thumbs) != len(candidates) or len(candidates) <= 1:
        return candidates, 0

    kept = [candidates[0]]
    last = thumbs[0]
    dropped: list[dict] = []
    for cand, thumb in zip(candidates[1:], thumbs[1:]):
        if _frame_delta(thumb, last) <= threshold:
            dropped.append(cand)
        else:
            kept.append(cand)
            last = thumb

    for cand in dropped:
        try:
            Path(cand["path"]).unlink()
        except OSError:
            pass
    for i, frame in enumerate(kept):
        frame["index"] = i
    return kept, len(dropped)


def _dedupe(candidates: list[dict]) -> tuple[list[dict], int]:
    if len(candidates) <= 1:
        return candidates, 0
    thumbs = _thumb_frames([Path(c["path"]) for c in candidates])
    if not thumbs:
        return candidates, 0
    return _dedupe_by_deltas(candidates, thumbs)


# ── Public API ───────────────────────────────────────────────────────────────

def extract_frames(
    video_path: str | Path,
    output_dir: str | Path,
    detail: str = "balanced",
    resolution: int = 512,
    max_frames: int | None = None,
    start_seconds: float | None = None,
    end_seconds: float | None = None,
) -> dict[str, Any]:
    """
    Extract frames from a video file.

    Args:
        video_path: Path to video file (.mp4, .mov, .mkv, .webm)
        output_dir: Directory to write frame JPEGs
        detail: "efficient" (keyframes only) | "balanced" (scene-change) | "token-burner" (dense uniform)
        resolution: Frame width in pixels (default 512, max 1998)
        max_frames: Hard cap on frames (None = uncapped, detail-dependent default)
        start_seconds: Optional start offset in seconds
        end_seconds: Optional end offset in seconds

    Returns:
        {
            "frames": [{"index": 0, "timestamp_seconds": 0.0, "path": "...", "reason": "..."}, ...],
            "metadata": {"duration_seconds": 600, "width": 1920, "height": 1080, ...},
            "engine": "scene" | "keyframe" | "uniform",
            "total_frames": 60,
            "detail": "balanced",
            "resolution": 512,
        }
    """
    video_path = Path(video_path)
    output_dir = Path(output_dir)

    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    meta = get_video_metadata(video_path)
    duration = meta["duration_seconds"]

    eff_start = start_seconds or 0.0
    eff_end = end_seconds if end_seconds is not None else duration
    eff_duration = max(0.0, eff_end - eff_start)
    focused = start_seconds is not None or end_seconds is not None

    # Determine frame budget
    if max_frames is None:
        if detail == "efficient":
            max_frames = 50
        elif detail == "balanced":
            max_frames = 100
        else:
            max_frames = None  # uncapped

    if detail == "efficient":
        frames, engine_meta = _keyframe_extract(
            video_path, output_dir, resolution=resolution,
            max_frames=max_frames, start_seconds=start_seconds,
            end_seconds=end_seconds,
        )
    elif detail == "balanced":
        # Scene-change detection with uniform fallback
        fps, target = (auto_fps_focus(eff_duration, max_frames)
                       if focused else auto_fps(eff_duration, max_frames))

        output_dir.mkdir(parents=True, exist_ok=True)
        scene_frames = _scene_extract(
            video_path, output_dir, resolution=resolution,
            max_frames=None, start_seconds=start_seconds,
            end_seconds=end_seconds,
        )
        if len(scene_frames) >= SCENE_MIN_FRAMES:
            deduped, n_dropped = _dedupe(scene_frames)
            cap = len(deduped) if max_frames is None else max_frames
            selected = [deduped[i] for i in _even_indices(len(deduped), cap)]
            for i, f in enumerate(selected):
                f["index"] = i
            frames = selected
            engine_meta = {
                "engine": "scene", "candidate_count": len(scene_frames),
                "deduped_count": n_dropped, "selected_count": len(frames),
                "fallback": False,
            }
        else:
            frames = _uniform_extract(
                video_path, output_dir, fps=fps, resolution=resolution,
                max_frames=target, start_seconds=start_seconds,
                end_seconds=end_seconds,
            )
            frames, n_dropped = _dedupe(frames)
            engine_meta = {
                "engine": "uniform", "candidate_count": len(scene_frames),
                "deduped_count": n_dropped, "selected_count": len(frames),
                "fallback": True,
            }
    elif detail == "token-burner":
        fps, target = (auto_fps_focus(eff_duration, max_frames or 200)
                       if focused else auto_fps(eff_duration, max_frames or 200))
        frames = _uniform_extract(
            video_path, output_dir, fps=fps, resolution=resolution,
            max_frames=(max_frames or 200), start_seconds=start_seconds,
            end_seconds=end_seconds,
        )
        frames, n_dropped = _dedupe(frames)
        engine_meta = {
            "engine": "uniform", "candidate_count": 0,
            "deduped_count": n_dropped, "selected_count": len(frames),
            "fallback": False,
        }
    else:
        raise ValueError(f"Unknown detail mode: {detail}. Use: efficient, balanced, token-burner")

    return {
        "frames": frames,
        "metadata": meta,
        "engine": engine_meta["engine"],
        "total_frames": len(frames),
        "detail": detail,
        "resolution": resolution,
        "engine_meta": engine_meta,
    }


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: frame_extractor.py <video-path> <out-dir> [--detail MODE] [--resolution W]",
              file=sys.stderr)
        raise SystemExit(2)

    video = sys.argv[1]
    out = Path(sys.argv[2])
    kwargs: dict[str, Any] = {"detail": "balanced", "resolution": 512}

    i = 3
    while i < len(sys.argv):
        if sys.argv[i] == "--detail" and i + 1 < len(sys.argv):
            kwargs["detail"] = sys.argv[i + 1]; i += 2
        elif sys.argv[i] == "--resolution" and i + 1 < len(sys.argv):
            kwargs["resolution"] = int(sys.argv[i + 1]); i += 2
        else:
            i += 1

    result = extract_frames(video, out, **kwargs)
    print(json.dumps(result, indent=2, ensure_ascii=False))
