---
name: hanako-bilibili-intake
description: 多平台内容摄取引擎（当前 v0.6.35）—— 从 B站/小红书/微博/知乎/贴吧/抖音/快手/YouTube 采集内容：单条/笔记抓取、搜索、批量、元数据/评论/创作者主页/音频下载/Whisper 转写/视觉帧分析。⚠️ 评论默认就会采集，但不会随返回值回传，采完必须自己读 outputDir/result.json 的 comments[]。本地文件（PDF/Office/图片/txt/md/html/csv/json）请改用 intake_document；写可回指的结构化总结用 intake_summary。触发词：B站视频、BV号、av号、bilibili链接、小红书笔记、微博、知乎、贴吧、抖音、快手、YouTube链接、采集这个视频、提取字幕、转写、总结这个视频、拉评论、看评论。
---

# Hanako Bilibili Intake — 多平台内容摄取（当前 v0.6.35）

一个统一接口吃多平台内容。采集产物统一落盘（`text.txt` + `artifact.json` + 「记录」里一条），
采集过的内容可补写结构化总结（`intake_summary`），也可生成知识地图（`generate_knowledge_map`）。

## 支持平台

| 平台 | platform | 元数据 | 评论 | 视频下载 | 视觉分析 |
|------|----------|--------|------|----------|----------|
| B站 | `bilibili` | ✅ | ✅ | ✅ yt-dlp + Referer | ✅ |
| 小红书 | `xhs` | ✅ | ✅ | ✅ yt-dlp generic | ✅ |
| 抖音 | `douyin` | ✅ | ⚠️ | ✅ yt-dlp generic | ✅ |
| 快手 | `kuaishou` | ✅ | ⚠️ | ✅ yt-dlp generic | ✅ |
| YouTube | `youtube` | ✅ | ✅ | ✅ yt-dlp native | ✅ |
| 微博 | `weibo` | ✅ | ✅ | ⚠️ 部分 | ⚠️ |
| 知乎 | `zhihu` | ✅ | ✅ | ⚠️ 仅图文 | ❌ 仅文本 |
| 贴吧 | `tieba` | ✅ | ✅ | ❌ 文字为主 | ❌ 仅文本 |

`platform: "auto"` 会从 source 自动识别；纯文本平台（知乎/贴吧）自动跳过视觉分析，只出正文。

## 优先调用工具

`bilibili_video_intake`（多平台统一入口）。本机另有：
- **`intake_document`** —— 本地文件/文档（PDF/扫描件 OCR/Office/图片/txt/md/html/csv/json）。给本地路径时用它，别用本工具。
- **`intake_summary`** —— 给一条已采集记录写「一句话 + 要点」的结构化总结，并校验每个要点能否回指正文（防"总结在编"）。
- **`generate_knowledge_map`** —— 由采集内容生成结构化学习路径（默认后台跑）。

## 参数速查（以 bilibili_video_intake.js 为准）

```typescript
{
  source,            // 必填(single)：BV号 / av号 / 链接 / 小红书ID / 微博ID
  platform,          // auto/bilibili/xhs/douyin/kuaishou/weibo/zhihu/tieba/youtube
  mode,              // single(默认) / search / batch
  searchKeyword, searchLimit, searchSort, page,   // search/batch 用
  noAudio,           // 默认 false；true=只取元数据/字幕，不下载音频
  forceTranscribe,   // 有平台字幕也强制 Whisper 转写
  whisperModel,      // tiny/base/small/medium/large，默认 base
  whisperDevice,     // auto(默认)/cuda/cpu
  whisperLanguage,   // 留空自动识别
  preferredSubtitleLanguages,   // 内部：优先字幕语言顺序
  returnTextLimit,   // 回传正文最大字符数
  anchorOffset, anchorLimit,    // 长视频按时间轴分段续读（见下）
  withComments,      // 默认 true（不传也采，见「评论」）
  withSubComments, withCreator, commentLimit,
  cookiesDir, login, importCookies, extractCookies,
  visual, frameDetail, frameResolution,   // 视觉帧分析
  background,        // 默认 false；无字幕长视频建议 true（见「长视频」）
  action             // health / routing-status（诊断）
}
```

> ⚠️ 旧资料里的 `specificTimestamps` / `localVideo` / `analysisMode` / `cookiesFile` 参数已不存在，别再传。

## 调用后你应该做什么（按顺序，别跳）

1. **正文**：读返回值里的 `transcriptText`。
2. **被截断**：读 `transcriptTextPath` 指向的完整 `text.txt`。
3. **长视频分段回传**：若返回带 `transcriptAnchors`，本次没给完的部分用 `anchorOffset = 上一次的 nextOffset` 续读，不会静默截断。
4. **评论**：读 `<outputDir>/result.json` 的 `comments[]`（见下节，**这步不能省**）。
5. **核对来源 / 重新处理**：看 `metadataPath` / `audioStreamsPath` / `audioPath` / `subtitleFiles`。
6. **写总结**：用 `intake_summary`，要点标出处（视频给 `at: "12:30"`），别手写外部脚本绕。

## ⚠️ 评论：默认采集、但不回传——必须自己读文件

`withComments` 默认 **true**、`commentLimit` 默认 50——**不传参数也会采**。
但工具返回给 Agent 的 payload 里没有评论正文：`lib/tool-output.js` 不提 comments，
`lib/records.js` 只留 `commentCount`（一个数字）。评论正文只落在磁盘：

```
<outputDir>/result.json → comments[]
  每条形如 { user, content, like }
```

所以采完**务必读这个文件**。评论区常有 UP 主没讲、观众实测补上的关键信息——
参数调法、低配可行性、以及对正文结论的反驳，价值不低于正文。

> 已知的源码层缺口：让 comments 默认进 payload 是待修的 `lib/tool-output.js` 问题，
> 当前靠 agent 自觉补这一步。

## 长视频与超时

无平台字幕的长视频要走 Whisper 兜底转写，CPU 上可能要几分钟到十几分钟。两条路：

- **前台**：`runCollector` 采集超时已放开到 30 分钟（详见 `lib/service.js` 的 `COLLECT_TIMEOUT_MS`）。
- **后台**：`background: true` 丢给宿主任务通道，立刻返回 taskId，完成后结果自动回到对话，超时放到 2 小时。长视频优先用这个。

## 视觉分析

`visual: true` 时自动：元数据 → 音频 → Whisper 转写 → 视频下载 → 抽帧 → 生成 `visual_analysis.md`。
返回 `needsAgentAnalysis` 时，按提示读关键帧图片、用视觉能力分析、回写报告。
`frameDetail`：`efficient` / `balanced`(默认) / `token-burner`。

## 知识地图

`generate_knowledge_map` 由已采集/已总结内容生成结构化学习路径（方向→地图→知识点验证→补给支线）。
**默认后台跑**（`background` 默认 true），返回 taskId，完成自动回对话。

---
*当前版本 v0.6.35 · 更新 2026-09-22*
