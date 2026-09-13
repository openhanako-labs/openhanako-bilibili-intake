"""Audio chunking module for long audio transcription.

Splits long audio files into chunks for Whisper transcription,
then merges the results with proper timestamp alignment.

Usage:
    from audio_chunker import chunk_and_transcribe

    result = chunk_and_transcribe(
        audio_path=Path("./long_audio.mp3"),
        output_dir=Path("./chunks"),
        whisper_model="base",
        language="zh",
        device="auto",
    )
"""
from __future__ import annotations

import json
import logging
import subprocess
import sys
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Default chunk settings
DEFAULT_CHUNK_DURATION = 300  # 5 minutes in seconds
DEFAULT_OVERLAP = 5  # 5 seconds overlap between chunks
MIN_CHUNK_DURATION = 30  # Minimum chunk duration in seconds


def get_audio_duration(audio_path: Path) -> float:
    """Get audio duration in seconds using ffprobe."""
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", str(audio_path.resolve()),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.strip()}")

    data = json.loads(result.stdout or "{}")
    fmt = data.get("format", {})
    return float(fmt.get("duration") or 0)


def split_audio(
    audio_path: Path,
    output_dir: Path,
    chunk_duration: float = DEFAULT_CHUNK_DURATION,
    overlap: float = DEFAULT_OVERLAP,
) -> list[dict[str, Any]]:
    """Split audio into chunks with optional overlap.

    Args:
        audio_path: Path to audio file
        output_dir: Directory for chunk files
        chunk_duration: Duration of each chunk in seconds
        overlap: Overlap between chunks in seconds

    Returns:
        List of chunk info dicts:
        [{"index": 0, "path": "...", "start": 0.0, "end": 300.0, "duration": 300.0}, ...]
    """
    audio_path = Path(audio_path)
    output_dir = Path(output_dir)

    if not audio_path.exists():
        raise FileNotFoundError(f"Audio not found: {audio_path}")

    duration = get_audio_duration(audio_path)
    if duration <= 0:
        raise ValueError(f"Invalid audio duration: {duration}")

    output_dir.mkdir(parents=True, exist_ok=True)

    # Calculate chunk boundaries
    chunks = []
    start = 0.0
    index = 0

    while start < duration:
        end = min(start + chunk_duration, duration)
        actual_duration = end - start

        # Skip if chunk is too short (unless it's the last chunk)
        if actual_duration < MIN_CHUNK_DURATION and end < duration:
            start = end - overlap
            continue

        chunk_path = output_dir / f"chunk_{index:04d}_{start:.1f}_{end:.1f}.mp3"

        # Extract chunk using ffmpeg
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{start:.3f}",
            "-to", f"{end:.3f}",
            "-i", str(audio_path.resolve()),
            "-acodec", "libmp3lame",
            "-q:a", "4",
            str(chunk_path),
        ]

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            logger.error(f"Failed to extract chunk {index}: {result.stderr.strip()}")
            start = end - overlap
            continue

        chunks.append({
            "index": index,
            "path": str(chunk_path),
            "start": start,
            "end": end,
            "duration": actual_duration,
        })

        index += 1
        start = end - overlap  # Move to next chunk with overlap

    return chunks


def transcribe_chunk(
    chunk_path: Path,
    whisper_model: str = "base",
    language: str = "",
    device: str = "auto",
) -> dict[str, Any]:
    """Transcribe a single audio chunk using Whisper.

    Args:
        chunk_path: Path to audio chunk
        whisper_model: Whisper model name
        language: Language code (empty for auto-detect)
        device: Device preference (auto/cuda/cpu)

    Returns:
        {"text": "...", "segments": [...], "device": "...", "language": "..."}
    """
    import whisper
    from bilibili_pipeline import resolve_whisper_device, resolve_whisper_model_reference

    chunk_path = Path(chunk_path)
    if not chunk_path.exists():
        raise FileNotFoundError(f"Chunk not found: {chunk_path}")

    device = resolve_whisper_device(device)
    model_ref = resolve_whisper_model_reference(whisper_model)
    model = whisper.load_model(model_ref, device=device)

    opts: dict[str, Any] = {"fp16": device.startswith("cuda")}
    if language:
        opts["language"] = language

    result = model.transcribe(str(chunk_path), **opts)

    return {
        "text": result.get("text", "").strip(),
        "segments": result.get("segments", []),
        "device": device,
        "language": result.get("language", ""),
    }


def merge_transcripts(
    chunk_results: list[dict[str, Any]],
    chunk_infos: list[dict[str, Any]],
) -> dict[str, Any]:
    """Merge chunk transcription results with proper timestamp alignment.

    Args:
        chunk_results: List of transcription results from transcribe_chunk
        chunk_infos: List of chunk info from split_audio

    Returns:
        {
            "text": "Full merged text",
            "segments": [{"start": 0.0, "end": 1.5, "text": "..."}, ...],
            "chunks": [{"index": 0, "start": 0.0, "end": 300.0, "text": "..."}, ...],
            "failed_chunks": [{"index": 2, "error": "..."}],
        }
    """
    if len(chunk_results) != len(chunk_infos):
        raise ValueError("chunk_results and chunk_infos must have same length")

    all_text = []
    all_segments = []
    chunk_summaries = []
    failed_chunks = []

    for i, (result, info) in enumerate(zip(chunk_results, chunk_infos)):
        chunk_start = info["start"]
        chunk_end = info["end"]

        if "error" in result:
            failed_chunks.append({
                "index": i,
                "start": chunk_start,
                "end": chunk_end,
                "error": result["error"],
            })
            continue

        # Add chunk text
        chunk_text = result.get("text", "")
        all_text.append(chunk_text)

        # Adjust segment timestamps
        segments = result.get("segments", [])
        for seg in segments:
            adjusted_seg = {
                "start": chunk_start + seg.get("start", 0),
                "end": chunk_start + seg.get("end", 0),
                "text": seg.get("text", "").strip(),
            }
            all_segments.append(adjusted_seg)

        chunk_summaries.append({
            "index": i,
            "start": chunk_start,
            "end": chunk_end,
            "text": chunk_text,
            "segments_count": len(segments),
        })

    # Sort segments by start time
    all_segments.sort(key=lambda x: x["start"])

    # Remove duplicate segments from overlap regions
    deduped_segments = []
    for seg in all_segments:
        if deduped_segments and abs(seg["start"] - deduped_segments[-1]["start"]) < 1.0:
            # Skip duplicate segment
            continue
        deduped_segments.append(seg)

    return {
        "text": " ".join(all_text),
        "segments": deduped_segments,
        "chunks": chunk_summaries,
        "failed_chunks": failed_chunks,
    }


def chunk_and_transcribe(
    audio_path: Path,
    output_dir: Path,
    whisper_model: str = "base",
    language: str = "",
    device: str = "auto",
    chunk_duration: float = DEFAULT_CHUNK_DURATION,
    overlap: float = DEFAULT_OVERLAP,
) -> dict[str, Any]:
    """End-to-end chunking and transcription pipeline.

    Args:
        audio_path: Path to audio file
        output_dir: Directory for chunks and output
        whisper_model: Whisper model name
        language: Language code (empty for auto-detect)
        device: Device preference (auto/cuda/cpu)
        chunk_duration: Duration of each chunk in seconds
        overlap: Overlap between chunks in seconds

    Returns:
        {
            "text": "Full merged text",
            "segments": [...],
            "chunks": [...],
            "failed_chunks": [...],
            "total_chunks": 10,
            "successful_chunks": 9,
            "duration": 600.0,
            "chunk_duration": 300,
            "overlap": 5,
        }
    """
    audio_path = Path(audio_path)
    output_dir = Path(output_dir)

    if not audio_path.exists():
        raise FileNotFoundError(f"Audio not found: {audio_path}")

    # Get audio duration
    duration = get_audio_duration(audio_path)

    # If audio is short enough, transcribe directly
    if duration <= chunk_duration:
        logger.info(f"Audio is short ({duration:.1f}s), transcribing directly")
        result = transcribe_chunk(audio_path, whisper_model, language, device)
        return {
            "text": result["text"],
            "segments": result.get("segments", []),
            "chunks": [{
                "index": 0,
                "start": 0.0,
                "end": duration,
                "text": result["text"],
                "segments_count": len(result.get("segments", [])),
            }],
            "failed_chunks": [],
            "total_chunks": 1,
            "successful_chunks": 1,
            "duration": duration,
            "chunk_duration": chunk_duration,
            "overlap": overlap,
        }

    # Split audio into chunks
    logger.info(f"Splitting audio ({duration:.1f}s) into chunks of {chunk_duration}s")
    chunks_dir = output_dir / "chunks"
    chunks = split_audio(audio_path, chunks_dir, chunk_duration, overlap)
    logger.info(f"Created {len(chunks)} chunks")

    # Transcribe each chunk
    chunk_results = []
    for i, chunk in enumerate(chunks):
        logger.info(f"Transcribing chunk {i+1}/{len(chunks)}: {chunk['start']:.1f}-{chunk['end']:.1f}s")
        try:
            result = transcribe_chunk(
                Path(chunk["path"]),
                whisper_model,
                language,
                device,
            )
            chunk_results.append(result)
        except Exception as e:
            logger.error(f"Failed to transcribe chunk {i}: {e}")
            chunk_results.append({"error": str(e)})

    # Merge results
    logger.info("Merging transcription results")
    merged = merge_transcripts(chunk_results, chunks)

    # Add metadata
    merged["total_chunks"] = len(chunks)
    merged["successful_chunks"] = len(chunks) - len(merged["failed_chunks"])
    merged["duration"] = duration
    merged["chunk_duration"] = chunk_duration
    merged["overlap"] = overlap

    # Save merged result
    output_path = output_dir / "transcript_merged.json"
    output_path.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    logger.info(f"Merged transcript saved to {output_path}")

    return merged


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Chunk and transcribe long audio files")
    parser.add_argument("audio", help="Path to audio file")
    parser.add_argument("--output-dir", default="./chunks_output", help="Output directory")
    parser.add_argument("--model", default="base", help="Whisper model name")
    parser.add_argument("--language", default="", help="Language code")
    parser.add_argument("--device", default="auto", help="Device preference")
    parser.add_argument("--chunk-duration", type=float, default=300, help="Chunk duration in seconds")
    parser.add_argument("--overlap", type=float, default=5, help="Overlap in seconds")

    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)

    result = chunk_and_transcribe(
        audio_path=Path(args.audio),
        output_dir=Path(args.output_dir),
        whisper_model=args.model,
        language=args.language,
        device=args.device,
        chunk_duration=args.chunk_duration,
        overlap=args.overlap,
    )

    print(f"\nTranscription complete:")
    print(f"  Total chunks: {result['total_chunks']}")
    print(f"  Successful: {result['successful_chunks']}")
    print(f"  Failed: {len(result['failed_chunks'])}")
    print(f"  Text length: {len(result['text'])} characters")
