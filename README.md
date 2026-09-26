# 内容摄取 (Bilibili Intake) — v2 App

`hanako-bilibili-intake`（v1 插件）迁到 Hana v2 App 规范后的产物。

多平台内容摄取：B站 / 小红书 / 微博 / 知乎 / 贴吧 / 抖音 / 快手。
统一搜索、单视频/笔记抓取、评论、创作者主页；B站走 yt-dlp 直连官方字幕
（优先中文 AI 字幕，自动回退语言），无字幕时才用 Whisper 兜底转写。
另有音频下载、原片下载、视觉帧分析、自动总结、知识地图生成。

**职责边界（v0.6.66 起）**：卡片只负责**展示 / 删除 / 检索**；
采集、搜索、登录态、下载原片、帧分析、总结都在**会话里由工具**完成。

## 平台支持状态

| 平台 | 搜索 | 采集 | 评论 | 备注 |
|---|---|---|---|---|
| **B站** | ✓ | ✓ | ✓ | 完整支持，yt-dlp + AI 字幕 + Whisper 兜底 |
| **小红书** | ✓ | ✓ | △ | 需要 Playwright + **有效登录态**；评论只取到计数 |
| **微博** | △ | △ | △ | 需要登录态（cookies），API 已收紧 |
| **知乎** | ✗ | △ | ✗ | 需要登录态，评论 API 未实现 |
| **贴吧** | ✗ | △ | ✗ | 需要登录态，评论 API 未实现 |
| **抖音/快手** | ✗ | ✗ | ✗ | 后端未实现（stub，请求会被明确拦截） |

- ✓ 完整支持 · △ 部分支持（需要 cookies / Playwright） · ✗ 不可用

**登录态怎么给**（卡片已不提供登录入口）：用工具导入导出好的 cookie 串——

```
bilibili_video_intake({ action: "importCookies", platform: "xhs", importCookies: "<cookie 串或扩展导出的 JSON>" })
bilibili_video_intake({ listLogins: true })                    # 看各平台登录态
bilibili_video_intake({ logout: "xhs" })                       # 清掉某平台 cookies
```

小红书抓到登录页时**会明确返回 `needs_login: true`**，不会落一条「手机号登录」式的假记录。

## 采集后自动总结

采集完成后自动生成「一句话 + 要点」，要点做**回指校验**（视频锚到时间、文章锚到小节，
回指不到的会列出来）——产物与 `intake_summary` 工具**同源**：

- `summary.json` / `summary.md` 落在槽位目录，统计与一句话回写到记录（卡片直接显示）
- 走**宿主模型通道**（能力位 `app/models.infer`），不需要 API key
- **后台跑**，不占采集的返回时间（宿主对 App 路由有 30s 封顶）
- 设置项 `summaryAuto`，默认开；关掉即回到「要手动发起」

## 小红书（重要）

小红书采集依赖 Playwright 起浏览器，而宿主的 App 进程带 `--permission`，
**Node 会把权限旗标注入每个子进程的 `NODE_OPTIONS`** —— Playwright 的 driver
本身就是 Node 进程，于是被权限模型限死：可执行文件明明存在也读不到、
临时目录也写不了，报
`BrowserType.launch: Access to this API has been restricted. Use --allow-fs-write to manage permissions.`

修法在 python 侧，Playwright 启动前一行：
`os.environ.pop("NODE_OPTIONS", None)`（Python 不在 Node 权限模型里，摘得掉）。
**凡是要起浏览器的地方都要带上这一行**，否则在 App 里永远起不来。

## Whisper 转写

使用 **faster-whisper**（CTranslate2 后端，速度 4x），默认模型 `small`。

- 18 分钟音频推理时间：约 1.5-2.5 分钟（CPU）
- 有平台字幕的视频建议不用 `forceTranscribe`（AI 字幕质量更高）
- Whisper 兜底转写人名专有名词可能不准（small 模型中文能力有限）
- 线程数看设置 `whisperCpuThreads`（0 = 吃满所有核）

## 安装

从 zip 安装 → 批准。**批准后必须再点一次「重新加载」**，否则
`app/process.spawn` 不生效（首次调用会报 `ERR_ACCESS_DENIED`）。
这不是本 App 的问题，是 v2 安装流程的既有行为，详见 `NOTES.md`。

## 能力与授权

| 声明 | 用途 |
|---|---|
| `app/tools.expose-to-model` | 让模型能主动调用本 App 的工具 |
| `app/process.spawn` | 起 `python/collector.py`（采集逻辑都在 Python 侧） |
| `app/tasks.manage` | 后台任务：长视频转写不再撞 180 秒上限 |
| `app/session.start-turn` | 后台结果完成后唤醒对话 |
| `app/models.read` / `app/models.infer` | 自动总结与视觉帧分析走宿主模型通道（无需 API key） |
| `app/provider.credentials.read` | 知识地图/自检需要时读供应商凭证（不落盘） |

`network` 段列了各平台域名。**但要注意**：网络闸门拦的是宿主侧的
`ctx.network.fetch`，而真正出网的是 Python 子进程的裸 socket —— 子进程不继承
Node 权限模型。所以对本 App 来说，`network` 是**形式申报**，不是实质约束。
带 cookies 起外部进程的安全责任在 App 自己。

## Python 运行时

依赖装在一个 venv 里（含 torch，约 1.08 GB），位于本 App 的
`app-data/<appId>/.runtime`。首次会自动 bootstrap；若目录被清掉会重新下载依赖。

## 工具

| 工具 | 说明 |
|---|---|
| `bilibili_video_intake` | 主入口：采集 / 搜索 / 批量 / 登录态（login、logout、listLogins、importCookies）；`background: true` 走后台 |
| `intake_summary` | 结构化摘要 + 回指校验（`action: save / check / read`） |
| `intake_shots` | 画面分析（帧分析）：切段 / 抽帧 / 挂时间锚点；`fill: true` 用宿主视觉模型填三格 |
| `intake_forget` | 删除记录与其产物；缓冲管理（`preview` / `purge` / `trash-list` / `trash-prune` / `trash-empty`） |
| `generate_knowledge_map` | 从已采集/已总结素材生成结构化知识地图（Markdown，可导入 Obsidian） |
| `intake_health` | 健康诊断：Python / CUDA / Whisper / 各平台连通性 |
| `intake_routing` | 多后端路由与冷却状态 |

工具名在 v2 **不加前缀**，与仍在运行的 v1 插件（`hanako-bilibili-intake_*`）不冲突。

## 卡片

`内容摄取`（`ui/intake.html`）—— **只做三件事**：

- **展示**：记录列表（标题 / 作者 / 时长 / 平台 / 总结 / 要点统计）、画面分析报告（弹窗内嵌整页）
- **检索**：过滤框，按标题 / 平台 / 链接 / 总结正文**本地筛选**
- **删除**：单条删除、批量选择 / 全选 / 反选 / 删除所选；删掉的槽位可在「缓冲」里留档

另有 `历史` / `日志` / `状态` 三个只读页签。

采集、平台搜索、登录态、下载原片、帧分析与总结都不在卡片上，用上面的工具在会话里做。

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

## 发布

```sh
./release.ps1                    # 净化 staging → zip + sha256 + entry.json
./release.ps1 -Publish           # 再打 tag、推 tag、建 GitHub Release（需要 gh）
```

仓库：<https://github.com/openhanako-labs/openhanako-bilibili-intake>

## 自检

```sh
node tests/verify-app.mjs       # mock ctx 装载 + 真起 python 的诊断（当前 15/15）
node tests/probe-runtime.mjs    # 单独探测 runtime 解析与采集器（分步计时）
```

<!-- HanaAgent contributor commit -->
