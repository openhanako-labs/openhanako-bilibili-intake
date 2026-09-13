---
name: hanako-bilibili-intake
description: 多平台内容摄取引擎 (v0.5+) — 支持 B站/小红书/微博/知乎/贴吧/抖音/快手/YouTube。统一搜索、单条/笔记抓取、批量采集、元数据/评论/创作者/音频/转写/视觉帧分析，全平台流程同步。知识地图：从采集视频生成结构化学习路径 — 支持 B站/小红书/微博/知乎/贴吧/抖音/快手/YouTube。统一搜索、单条/笔记抓取、批量采集、元数据/评论/创作者/音频/转写/视觉帧分析，全平台流程同步。
---

# Hanako Bilibili Intake (v0.4+)

多平台内容采集 + 视觉分析统一管线。

## 支持的平台

| 平台 | 元数据 | 评论 | 下载视频 | 视觉分析 |
|------|--------|------|----------|----------|
| B站 (bilibili) | ✅ | ✅ | ✅ yt-dlp + B站Referer | ✅ |
| 小红书 (xhs) | ✅ | ✅ | ✅ yt-dlp generic | ✅ |
| 抖音 (douyin) | ✅ | ⚠️ | ✅ yt-dlp generic | ✅ |
| 快手 (kuaishou) | ✅ | ⚠️ | ✅ yt-dlp generic | ✅ |
| YouTube (youtube) | ✅ | ✅ | ✅ yt-dlp native | ✅ |
| 微博 (weibo) | ✅ | ✅ | ⚠️ 部分支持 | ⚠️ |
| 知乎 (zhihu) | ✅ | ✅ | ⚠️ 仅图文 | ❌ |
| 贴吧 (tieba) | ✅ | ✅ | ❌ 文字为主 | ❌ |

全平台通用视频下载：yt-dlp generic options（带 `Origin` / `Referer` headers）。
仅文本平台（知乎/贴吧）：跳过视觉分析，只生成 transcript_analysis.md。

## 知识地图（v0.5+ 新增）

基于 b-mind-ai 的 LLM prompt 管线，采集的视频内容可自动生成结构化知识地图：

| 能力 | 用途 |
|------|------|
| 方向生成 | 用户输入主题 → 从真实视频归纳 2-4 个学习方向 |
| 地图生成 | 方向 → 素材 → LLM 组织成递归学习地图（collection→episode→clip→concept） |
| 知识点验证 | 每个知识点现场出题（problem/quiz）+ LLM 判分 |
| 补给支线 | 追问 → 搜索 → 生成补给子树 |

输出格式：Markdown（可直接在 Obsidian 中阅读）。
代码位置：`python/knowledge_maps/`

## 视觉分析全流程同步

无论哪个平台，只要 `args.visual=true`，都会自动执行：

```
1. 元数据提取     → adapter.get_item(source)
2. 音频下载       → yt-dlp + FFmpeg
3. Whisper 转写   → text.txt
4. 视频下载       → yt-dlp generic / B站-specific
5. 帧提取         → frame_extractor（balanced / efficient / token-burner）
6. HanakoVisionBackend → 返回 frames + needsAgentAnalysis
7. 报告生成        → transcript_analysis.md + visual_analysis.md
8. Agent 视觉能力 → 自动分析关键帧 → 更新 visual_analysis.md
```

## Agent 自动行为规范

当插件返回以下标记时，Agent **必须**自动执行视觉分析：

```json
{
  "visualOk": true,
  "visualAnalysis": {
    "needsAgentAnalysis": true,
    "frames_dir": "path/to/visual_frames",
    "analysisInstructions": "请读取关键帧图片，用视觉能力分析内容，然后更新 visual_analysis.md 报告"
  },
  "reports": {
    "visual_report": "path/to/visual_analysis.md"
  }
}
```

**Agent 应执行的步骤：**

1. 读取关键帧图片（5-10帧，均匀分布）
2. 用当前模型的视觉能力分析每帧内容
3. 整合分析结果，更新 `visual_analysis.md` 报告
4. 报告应包含：
   - 视频内容概述
   - 关键帧分析（时间戳 + 画面描述）
   - 故事线梳理
   - 视觉风格总结
5. 可选：用 Python `reportlab` 把分析结果转成 PDF（含图片嵌入）

## 输出文件

| 文件 | 说明 |
|------|------|
| `result.json` | 完整结果（元数据+转写+视觉分析） |
| `text.txt` | 纯文本转写 |
| `audio.mp3` | 音频文件 |
| `transcript_analysis.md` | 字幕分析报告 |
| `visual_analysis.md` | 视觉分析报告（Agent更新，含图片引用） |
| `visual_analysis.pdf` | 可选 PDF 版本（含图片内嵌） |
| `visual_frames/` | 帧图片目录 |
| `visual_video.mp4` | 下载的视频文件 |

## Git 工作流

本插件在 master 分支开发：

```bash
git add -A
git commit -m "feat(visual): add hanako agent-side vision backend + report generation"
git push origin master
```

不在 master 上开新分支，所有改动直接进入 master。

## 参数速查

```typescript
{
  source: string,           // BV号/av号/链接（自动识别平台）
  platform: string,         // auto/bilibili/xhs/douyin/kuaishou/weibo/zhihu/tieba/youtube
  visual: boolean,          // 启用视觉分析
  frameDetail: string,      // efficient/balanced/token-burner
  specificTimestamps: string, // 定点截图 "00:30,01:20"
  localVideo: string,       // 本地视频路径
  analysisMode: string,     // transcript/efficient/balanced/token-burner/frames-only
  cookiesFile: string,      // 登录态
}
```

## 五种分析模式

| 模式 | 帧提取 | Whisper | 适用场景 |
|------|--------|---------|----------|
| `transcript` | ❌ | ✅ | 只要字幕 |
| `frames-only` | ✅ | ❌ | 只要画面 |
| `efficient` | ✅ | ✅ | 快速浏览 |
| `token-burner` | ✅ | ✅ | 密集分析 |
| `balanced` | ✅ | ✅ | 默认推荐 |

---

*版本：v0.4+ | 更新：2026-07-18*
