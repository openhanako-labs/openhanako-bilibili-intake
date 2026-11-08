"""Whisper 转写幻觉检测器

⭐ 背景：GSV.CPP / AnyAudio / 小鲸鱼 等纯 BGM 视频，Whisper 会稳定地幻觉出
"字幕 by 索兰娅"之类的短句，且片段边界精确落在 30 秒的整数倍上。

⭐ 判据：如果转写结果是**循环同一短句**且**间隔恒为 30 秒** → 直接判定为无人声
       （即识别错误，应返回空文本或标记为 BGM -only）。

⭐ 实现：v0.6.68+
   - 输入：segments list（faster-whisper / openai-whisper 的原生 segments）
   - 输出：(is_hallucination, confidence, details)
   - is_hallucination: bool
   - confidence: float (0~1)
   - details: str (解释为什么判断为幻觉)
"""
from __future__ import annotations

import re
from typing import Any


def detect_whisper_hallucination(segments: list[dict[str, Any]],
                                   threshold_similar: float = 0.9,
                                   target_interval: float = 30.0,
                                   interval_tolerance: float = 0.5) -> tuple[bool, float, str]:
    """Detect if Whisper transcription is hallucinating periodic BGM-only text.

    Criteria (all must be true):
    1. At least 3 consecutive segments with near-identical text
    2. Time intervals between these similar segments are approximately constant and close to 30s (±tolerance)

    Args:
        segments: List of Whisper segments with keys: start, end, text
        threshold_similar: Text similarity threshold (Levenshtein-based), default 0.9
        target_interval: Target interval in seconds (default 30)
        interval_tolerance: Allowed deviation from target interval, default 0.5s

    Returns:
        (is_hallucination, confidence, explanation)
    """
    # 过滤掉空文本
    non_empty = [s for s in segments if (s.get("text") or "").strip()]
    if len(non_empty) < 3:
        return False, 0.0, "Too few segments to detect pattern"

    # 提取所有段起点
    starts = [s.get("start", 0.0) for s in non_empty]
    texts = [s.get("text", "") for s in non_empty]
    
    # 计算相邻段的间隔
    intervals = []
    for i in range(1, len(starts)):
        gap = starts[i] - starts[i - 1]
        if gap > 0:  # 只考虑正向间隔
            intervals.append(gap)

    if len(intervals) < 2:
        return False, 0.0, "Cannot compute enough intervals"

    # 检查间隔是否接近 30 秒且恒定
    interval_matches = []
    for gap in intervals:
        diff = abs(gap - target_interval)
        if diff <= interval_tolerance:
            interval_matches.append(gap)

    if len(interval_matches) < 2:
        return False, 0.0, f"Interval pattern not found (target={target_interval}s, tol={interval_tolerance}s)"

    # 计算文本相似度（简单 Levenshtein 距离归一化）
    texts = [s.get("text", "") for s in non_empty]
    similar_count = 0
    total_pairs = 0

    for i in range(len(texts) - 1):
        sim = _normalized_similarity(texts[i], texts[i + 1])
        total_pairs += 1
        if sim >= threshold_similar:
            similar_count += 1

    if total_pairs == 0 or similar_count / total_pairs < 0.7:
        return False, 0.0, "Text segments not sufficiently similar"

    # 综合置信度
    interval_score = len(interval_matches) / len(intervals)
    text_score = similar_count / total_pairs
    confidence = (interval_score * 0.6 + text_score * 0.4)

    if confidence >= 0.7:
        explanation = (
            f"Hallucination detected: {len(non_empty)} near-identical segments "
            f"with ~{target_interval}s intervals. Confidence: {confidence:.2f}"
        )
        return True, confidence, explanation

    return False, confidence, "Pattern weak, may not be hallucination"


def _normalized_similarity(s1: str, s2: str) -> float:
    """Compute normalized similarity using Levenshtein distance.

    Returns a value in [0, 1], where 1 means identical.
    """
    s1, s2 = s1.lower().strip(), s2.lower().strip()
    if s1 == s2:
        return 1.0

    # Quick check for case-insensitive exact match
    if s1 == s2:
        return 1.0

    # Levenshtein distance
    m, n = len(s1), len(s2)
    if m == 0 or n == 0:
        return 0.0

    # Use simplified DP for speed
    prev_row = list(range(n + 1))
    for i in range(1, m + 1):
        curr_row = [i]
        for j in range(1, n + 1):
            cost = 0 if s1[i - 1] == s2[j - 1] else 1
            curr_row.append(min(prev_row[j] + 1, curr_row[j - 1] + 1, prev_row[j - 1] + cost))
        prev_row = curr_row

    edit_distance = prev_row[n]
    max_len = max(m, n)
    return 1.0 - (edit_distance / max_len)


# Test cases
if __name__ == "__main__":
    # Simulate the "索兰娅" hallucination pattern
    hall_segments = [
        {"start": 0.0, "end": 5.0, "text": "This is background music"},
        {"start": 30.0, "end": 35.0, "text": "This is background music"},
        {"start": 60.0, "end": 65.0, "text": "This is background music"},
        {"start": 90.0, "end": 95.0, "text": "This is background music"},
    ]

    normal_segments = [
        {"start": 0.0, "end": 2.4, "text": "Welcome to this video"},
        {"start": 2.5, "end": 5.0, "text": "Today we will talk about something interesting"},
        {"start": 5.2, "end": 8.0, "text": "Let me show you some examples"},
    ]

    print("Hallucination test:")
    result = detect_whisper_hallucination(hall_segments)
    print(f"  is_hallucination={result[0]}, confidence={result[1]:.2f}")
    print(f"  explanation: {result[2]}")

    print("\nNormal test:")
    result = detect_whisper_hallucination(normal_segments)
    print(f"  is_hallucination={result[0]}, confidence={result[1]:.2f}")
    print(f"  explanation: {result[2]}")
