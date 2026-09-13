---
name: bilibili-video-intake
description: 当用户给出 BV 号 / av 号 / B站视频链接，并且明确希望把字幕、音频、标题、简介保存到本地，在没有字幕时自动转写，把去掉时间轴的纯文本正文交给 Agent。触发词：B站视频、B站字幕、BV号、bilibili视频、视频转写、字幕提取。
---

# Bilibili Video Intake

当用户给出 **BV 号 / av 号 / B站视频链接**，并且明确希望：

- 把字幕、音频、标题、简介保存到本地
- 在没有字幕时自动转写
- 把去掉时间轴的纯文本正文交给 Agent

优先调用工具：`bilibili_video_intake`

## 推荐调用场景

- “帮我读这个 BV 视频内容”
- “把这个 B 站视频转成可读文本”
- “先抓字幕，没有字幕就转写”
- “把视频标题、简介、音频、字幕都落本地”

## 建议参数

```json
{
  "source": "BVxxxxxxxxxx",
  "page": 1,
  "forceTranscribe": false
}
```

## 调用后你应该做什么

1. 读取返回结果里的 `transcriptText`
2. 如果正文被截断，再读取 `transcriptTextPath`
3. 如需核对来源或重新处理，查看：
   - `metadataPath`
   - `audioStreamsPath`
   - `audioPath`
   - `subtitleFiles`
