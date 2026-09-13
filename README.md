# 内容摄取 (Bilibili Intake) — v2 App

`hanako-bilibili-intake`（v1 插件）迁到 Hana v2 App 规范的第一阶段产物。
JS 外壳按 v2 契约重接，**Python 侧一行未改**。

多平台内容摄取：B站 / 小红书 / 微博 / 知乎 / 贴吧 / 抖音 / 快手。
统一搜索、单视频/笔记抓取、评论、创作者主页；B站走 yt-dlp 直连官方字幕
（优先中文 AI 字幕，自动回退语言），无字幕时才用 Whisper 兜底转写。
另有音频下载、视觉帧分析、知识地图生成。

## 平台支持状态

| 平台 | 搜索 | 采集 | 评论 | 备注 |
|---|---|---|---|---|
| **B站** | ✓ | ✓ | ✓ | 完整支持，走 yt-dlp + AI 字幕 + Whisper 兜底 |
| **小红书** | ✗ | ✗ | ✗ | 需要 Playwright 浏览器（未默认安装） |
| **微博** | △ | △ | △ | 需要登录态（cookies），API 已收紧 |
| **知乎** | ✗ | △ | ✗ | 需要登录态，评论 API 未实现 |
| **贴吧** | ✗ | △ | ✗ | 需要登录态，评论 API 未实现 |
| **抖音/快手** | ✗ | ✗ | ✗ | 后端未实现（stub） |

- ✓ 完整支持
- △ 部分支持（需要配置 cookies 或 Playwright）
- ✗ 不可用

**配置方法**：
- **微博/知乎/贴吧**：在 `plugin-data/hanako-bilibili-intake/cookies/` 下放对应平台的 cookies 文件（Netscape 格式，如 `weibo.txt`）
- **小红书**：需要安装 Playwright（`pip install playwright && playwright install chromium`）

## Whisper 转写

使用 **faster-whisper**（CTranslate2 后端，速度 4x），默认模型 `small`。

- 18 分钟音频推理时间：约 1.5-2.5 分钟（CPU）
- 有平台字幕的视频建议不用 `forceTranscribe`（AI 字幕质量更高）
- Whisper 兜底转写人名专有名词可能不准（small 模型中文能力有限）

## 安装

从本地 zip 安装 → 批准。**批准后必须再点一次「重新加载」**，否则
`app/process.spawn` 不生效（首次调用会报 `ERR_ACCESS_DENIED`）。
这不是本 App 的问题，是 v2 安装流程的既有行为，详见 `NOTES.md`。

## 能力与授权

| 声明 | 用途 |
|---|---|
| `app/tools.expose-to-model` | 让模型能主动调用四个工具 |
| `app/process.spawn` | 起 `python/collector.py`（全部采集逻辑都在 Python 侧） |
| `app/tasks.manage` | 后台任务：长视频转写不再撞 180 秒上限 |
| `app/session.start-turn` | 后台结果完成后唤醒对话 |

`network` 段列了各平台域名。**但要注意**：网络闸门拦的是宿主侧的
`ctx.network.fetch`，而真正出网的是 Python 子进程的裸 socket —— 子进程不继承
Node 权限模型。所以对本 App 来说，`network` 是**形式申报**，不是实质约束。
带 cookies 起外部进程的安全责任在 App 自己。

## Python 运行时

依赖装在一个 venv 里（含 torch，约 1.08 GB）。首次会用到
`plugin-data/hanako-bilibili-intake/.runtime` —— 如果那里已经有 v1 建好的环境，
本 App **就地复用**（不复制、不重建，也不往里面装东西）。
若 v1 的数据目录被清掉，本 App 会需要自行重建 venv（会重新下载依赖）。

## 工具

| 工具 | 说明 |
|---|---|
| `bilibili_video_intake` | 主入口。采集/搜索/批量；新增 `background: true` 走后台 |
| `intake_health` | 健康诊断：Python/CUDA/Whisper/各平台连通性 |
| `intake_routing` | 多后端路由与冷却状态 |
| `generate_knowledge_map` | 从采集素材生成结构化知识地图（Markdown，可导入 Obsidian） |

工具名在 v2 **不加前缀**，与仍在运行的 v1 插件（`hanako-bilibili-intake_*`）
不冲突，两者可并存。

## 卡片

`内容摄取`（`ui/intake.html`）：粘贴链接采集、搜索、批量、健康诊断、历史、
Cookies 管理、设置。

## 后台任务

无字幕长视频的 Whisper 转写可能远超 3 分钟（`lib/runtime.js` 的
`SPAWN_TIMEOUT_MS = 180_000`）。传 `background: true` 即可丢到后台：

```
bilibili_video_intake({ source: "BV...", background: true })
→ 立刻返回 taskId，完成后结果自动回到对话
```

## 贡献者

| 贡献者 | 角色 |
|---|---|
| [Yuexiye](https://github.com/Yuexiye) | 主要维护者，v2 迁移与全部功能开发 |
| [hanaagent](https://github.com/hanaagent) | 项目托管与发布 |

## 自检

```sh
node tests/verify-app.mjs       # mock ctx 装载 + 真起 python 的诊断
node tests/probe-runtime.mjs    # 单独探测 runtime 解析与采集器（分步计时）
```
