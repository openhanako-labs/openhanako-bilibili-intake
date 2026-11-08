# Whisper 幻觉检测器（30s 循环短句问题）

## 背景

某些纯背景音乐视频（如 GSV.CPP、AnyAudio、小鲸鱼等来源），Whisper 转写时会稳定地产生“字幕 by 索兰娅”之类的重复短句，且片段边界精确落在 **30 秒的整数倍**上。

这是 Whisper 在寂静环境中产生的**周期性幻觉**。

## 判据

如果同时满足以下条件 → 判定为**无人声 / 识别错误**：

1. 至少有 3 个连续段落（segments）
2. 相邻段落的文本相似度 > 90%（Levenshtein 距离归一化）
3. 段落之间的时间间隔恒定在 30 秒左右（±0.5 秒）

## 处理方式

检测到幻觉后：
- **清空转写文本**（返回空字符串）
- **清空 segments 列表**
- 在日志中输出 `Whisper hallucination detected: ...`

这样下游不会误把幻觉内容当作有效字幕写入记录。

## 集成点

文件：`python/bilibili_pipeline.py`

修改了两个函数：
1. `_transcribe_faster_whisper()` - faster-whisper (CTranslate2) 路径
2. `_transcribe_openai_whisper()` - openai-whisper 回退路径

在每个函数返回前调用 `detect_whisper_hallucination(segments)`。

## 测试验证

```bash
cd python
python whisper_hallucination_detector.py
```

预期输出：
```
Hallucination test:
  is_hallucination=True, confidence=1.00
  explanation: Hallucination detected: 4 near-identical segments with ~30.0s intervals. Confidence: 1.00

Normal test:
  is_hallucination=False, confidence=0.00
  explanation: Interval pattern not found (target=30.0s, tol=0.5s)
```

## 后续建议

这个规则应该反馈给 App 作者（GSV.CPP/AnyAudio/小鲸鱼的开发者），他们可以在前端加一个类似的校验逻辑，避免给用户展示这种明显的幻觉结果。
