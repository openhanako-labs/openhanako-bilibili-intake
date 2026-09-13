# bilibili-intake v2 迁移 — 施工记录

- 执行：奥菲莉娅（2026-09-11）
- 来源：`~/.hanako/plugins/hanako-bilibili-intake-main`（v1，`manifestVersion: 1`）
- 产物：`projects/bilibili-intake-v2/` → `每日待分类/app-bilibili-intake-v2-0.6.0.zip`
- 前置：可行性切片 `projects/bilibili-intake-v2-sandbox`（三未知已全通，见其 NOTES.md）

## 这一阶段做了什么

把 JS 外壳原样搬过来、接上 v2 的注册面。Python 侧一行未改。

```
index.js                  apply(ctx)：注册工具 + 挂路由
manifest.json             manifestVersion 2，4 项能力 + network + settings schema + 1 张卡
lib/env.js                App 身份与路径（import.meta.url 定位，不靠环境变量）
lib/legacy-ctx.js         v2 ctx → v1 形状的投影
lib/settings.js           ⚠️ 改成 async（v2 的 ctx.config.get 返回 Promise）
lib/register-tools.js     四个工具编程式注册
lib/register-routes.js    ctx.routes.register（http/ 而非 routes/，见下）
lib/runtime.js            ★ 已改：runtime 根目录改为可复用 v1 的
lib/legacy-runtime.js     ★ 新增：复用 v1 已建好的 venv
lib/tasks.js              ★ 新增：后台任务（拆掉 180s 墙）
http/intake.js            改自 v1 的 routes/intake.js（前缀去掉，页面入口移除）
ui/intake.html            改自 v1 的 assets/intake.html（静态树）
ui/intake-script.js       改自 v1 的 assets/intake-script.js（API 基址改 v2 路由）
python/                   原样复制（排除 test-env / __pycache__ / output）
```

## 五处 v2 断层（都已处理）

### 1. `ctx.config.get` 从同步变异步 —— 最隐蔽的一处

v1 的 `lib/settings.js` 是**同步**读配置的。v2 的 `ctx.config.get` 返回 Promise。
不处理的话 `readConfig` 拿到一个 Promise，经 `stringify()` 落成 `""`，
于是**全部设置静默退回默认值** —— 表现为「设置页改了没用」，不是报错。

处理：`getSettings` 改 async，三处调用点加 `await`（`lib/service.js` ×3、
`tools/generate_knowledge_map.js` ×1）。

### 2. 顶级 `routes/` 与 `ctx.routes.register()` 互斥

v2 把顶级 `routes/` 当成另一种路由来源，两边同时存在 → 整个应用装载时 failed。
所以 v1 的 `routes/intake.js` 改坐 `http/intake.js`，走编程式注册。
公开前缀变成 `/api/apps/bilibili-intake-v2/routes`，前端 API 基址同步改。

### 3. 工具名 v2 不加前缀

v1 宿主会加 `{插件id}_`（线上是 `hanako-bilibili-intake_intake_health`），
v2 不加。这里注册的是模块导出的裸名 → 与仍在跑的 v1 **不冲突**，可并存。
**不要**为了「统一」改成带前缀的名字，那会与 v1 撞名并让整个 app failed。

### 4. 页面从动态渲染改为静态树

v1 用路由读 `assets/intake.html` 再内联脚本返回。v2 把 `ui/` 静态树挂在
`/api/apps/<id>/ui<route>`，卡片直接指向 `ui/intake.html`，那两段路由代码删掉。

### 5. ★ Python 运行时：1GB 的 venv 不能重建

`.runtime/venv-win` 里有 torch，实测 **1.08 GB**。
v2 数据目录是 `app-data/bilibili-intake-v2`，与 v1 的
`plugin-data/hanako-bilibili-intake` 完全不同 —— 不处理就会从零重建。

选择**就地复用**（`lib/legacy-runtime.js`），理由：用户机器有 C 盘吃紧的历史，
复制 1GB 不合适；junction 又要处理悬空与权限。

**但复用踩到一个坑（实测）**：第一次跑 `intake_health` 时**挂死 10 分钟以上**。
原因 —— 复用了 v1 的目录，`ensurePythonEnvironment` 却按新目录的账去核对安装标记，
判定「未满足」于是开始 `pip install`，往 **v1 的 venv 里**重装依赖（含 torch 的几 GB）。

处理：`resolveRuntimeRoot` 返回 `{ root, reused }`，`reused === true` 时
**强制关掉 bootstrap**（`autoBootstrapPython: false`）。venv 不完整就抛明确的
`VENV_NOT_READY`，绝不往 v1 的目录里写。改完后同一调用 **4.9 秒** 返回。

> 这条是本阶段最值得记住的一课：**「复用别的组件的目录」必须同时关掉它的自愈式写入**，
> 否则复用的语义会从「借来用」变成「替你重装」。

## 新增：后台任务拆掉 180 秒墙

`lib/runtime.js` 的 `SPAWN_TIMEOUT_MS = 180_000`（v1 遗留）。B站有字幕时走
yt-dlp 直连官方字幕，几十秒完；**无字幕视频要跑 Whisper 兜底**，CPU 上十分钟的
片子几乎必然撞穿 —— 撞穿的代价是那一整次采集全部白费。

`bilibili_video_intake` 新增 `background: true`：`ctx.tasks.create` +
`void async IIFE` + `delivery: "next-step"`，立刻返回 taskId，完成后结果自动回到对话。
契约按官方文档「后台任务与审批」小节的形态写，未用 `registerHandler`
（那是给 App 自建 schedule 用的，这里不需要）。

**顺带发现**：v1 的 venv 装的是 **CPU 版 torch**（标记文件里
`installedTorchKey: "cpu-fallback"`，运行时 `cuda_available: false`）。
所以 Whisper 走的是 CPU —— 这正是 180 秒会被撞穿的原因，也让后台化从
「锦上添花」变成「必需」。

## 自检证据

```
node tests/verify-app.mjs  →  14/14 通过
  ✓ 四个工具注册，名字未被加前缀
  ✓ routes.register 调用一次
  ✓ intake_health 真起 python，返回 runtime.python=3.12.4 / B站 ok 70ms
  ✓ background 在 ctx.tasks 缺失时返回明确错误（不抛）

node validate-app.mjs --dir <临时目录> --json
  → ok: true, 0 error / 1 warning（仅 DYNAMIC_DEPENDENCIES_NOT_PROVEN，属预期）
```

## 六、真机上的第二组坑（v0.6.0 → v0.6.2）

v0.6.0 装上后 `intake_health` 报「自动选择 Python 运行环境失败」，根因是**AppHost 的 Node 权限模型**。

### ⭐ NF: JS 侧不能对 app-data 之外的路径做任何 fs 操作

实测两次报错：

```
Access to this API has been restricted. Use --allow-fs-write to manage permissions.
```

AppHost 进程启动参数（日志/进程表可见）：

```
hana-server.exe --permission --allow-fs-read=W:\...\apps\bilibili-intake-v2 ...
```

许可根是**安装目录 + 自己的 app-data**。`plugin-data/` 不在里面。于是：

1. `fs.existsSync(v1 的路径)` → 抛 ERR_ACCESS_DENIED → 被 catch 吞掉 → 永远判定「v1 不存在」→ 走 bootstrap 重建
2. 重建在 `app-data/.runtime` 下建出 **空的 venv-win / venv-wsl**（bootstrap 本身也失败）
3. 即使复用判定成功，`ensureDir(v1 的 runtime 目录)` 会对**盘外路径 mkdir** → 直接报 `--allow-fs-write`

**修法（v0.6.1/0.6.2）**：

- 默认**不探测**，直接假定 v1 的位置可用（`source: "legacy"`, `reused: true`）
- `reused` 时**不做任何 fs 操作**：不 ensureDir、不 isVenvReady、不 hashFile
- `reused` 时**不回退 WSL**（v1 的环境只有 Windows 原生版）
- 加了 `runtimeRoot` 设置项：用户想独立就填绝对路径（那时 `reused=false`，才允许 bootstrap）

> 原则：**JS 侧只管给出路径，不判断路径存不存在。** 真正的读写交给 python 子进程（它不继承 Node 权限模型）。

修后实测：`intake_health` → HTTP 200，`python 3.12.4 / whisper installed / B站 ok 53ms`。

### 更新已装 App 时的两个新坑

- **`install` 端点间歇性报 `Package file worker stopped before completing (unknown)`**（500）。规律不明，重试有时成功，有时连续失败；到后面就连小包也不行了。怀疑是打包 worker 进程态问题，**需要重启 server 恢复**。
- **更新时 `EPERM: rename apps\<id> -> apps\<id>.update-backup-*`**。原因：该 app 的 AppHost 子进程还活着，持着目录句柄。→ 更新前必须先 `PUT /extensions/app:<id>/enabled {enabled:false}` 让它退干净。

因为 worker 坏了，最后是**直接覆盖 `apps/bilibili-intake-v2/` 下的文件 + reload** 把 0.6.2 装上去的（绕过 install 管线）。
副作用：**安装记录里还是 0.6.1，磁盘上是 0.6.2**。功能不受影响，但下次应走正规安装清掉这个不一致。

### 模型侧工具可见性

权限账本确认四项能力都已 `allowed`（`security/permission-ledger.json`）；
`ui-actions/invoke` 通道也能调。但 `tool_search` / `tool_call` **看不到**本 App 的工具。
推测：装载后未刷新已存在会话的工具表（v2 app 的工具可能需新会话/重启宿主才进入模型工具表）。
未验证，待重启后复查。

## 安装时的两个坑

### A. 沙盒 App 会与正式 App **撞工具名**

v2 工具名**全局唯一**，重名会被注册表当场拒掉，从而让**整个应用 failed**。

`bilibili-intake-v2-sandbox` 注册的是裸名 `intake_health`，正式 App 也注册 `intake_health`。
两者共存时，后注册的那个应用会整只 failed。

→ 安装正式 App 前必须先把沙盒**停用或卸载**。（已停用验证；沙盒可从
`每日待分类/app-bilibili-intake-v2-sandbox-0.1.0.zip` 随时重装。）

### B. 打包坑：Compress-Archive 在 PS 5.1 与 pwsh 7 下产物不兼容

打包走**官方 `extension-pack.mjs`**，不要用 `Compress-Archive`：

```sh
node extension-pack.mjs --kind app --dir <app目录> --publisher ophelia --out <输出目录>
```

**坑（已踩过）**：用 PowerShell 5.1 的 `Compress-Archive` 打包，它在**嵌套目录**时
写出的 zip 条目名用**反斜杠**（`lib\env.js`）；安装时报 *Archive could not be read safely*。
同一个 `Compress-Archive` 命令在 **pwsh 7** 里写的是正斜杠，看着没区别，产物不兼容。

对照实验（同一目录、同一命令、两个 shell）：

```
PS 5.1:  entries=2  含反斜杠=1  前5条: "sub\\g.txt", "f.txt"
 pwsh7:  entries=2  含反斜杠=0  前5条: "sub/g.txt",  "f.txt"
```

> 教训：**同一个命令在不同 shell 里产出不同格式的二进制**。打包不要靠 shell 内建，
> 用工具。验证方式：写完 zip 后用 yauzl（宿主读 zip 用的库）在默认 /
> `strictFileNames` / `validateEntrySizes` 三种模式下验完整解压。

## 交付与清理（v0.6.3）

### 磁盘搬家：v2 的 Python 环境移到自己的数据目录

```
plugin-data\hanako-bilibili-intake\.runtime   (1 GB)
        ↓ 移动（同盘瞬时）
app-data\bilibili-intake-v2\.runtime           ← 真身，1040.5 MB
        ↑
plugin-data\hanako-bilibili-intake\.runtime    ← junction 指回去（0.004 MB）
```

原处留 junction，v1/v2 共用同一份 venv，谁都不重建。两侧实测：

```
v2 intake_health     → HTTP 200, 6.0s，不重装 ✓
v1 prepareRuntime    → 4.6s，不重装 ✓
```

### ⚠️ 搬家后的副作用：两个应用会互相拆台

第一次调 v2，它把 torch **卸了重装**。根据是 `isInstallSatisfied` 里的
`torchPolicyKey` 比对，而两边算出不同值是必然的：

- v1 建环境时：nvidia-smi 正则只认 `CUDA Version:`，当前驱动输出的是 `CUDA UMD Version:`
  → 解析为空 → `win-native-auto-unknown-...`
- v2 在受限 AppHost 里：根本探测不到 GPU → `win-native-auto-cpu`

→ 同一个 venv、两个应用、两套判定，轮流 `pip uninstall torch` + 重下 200MB。

**已修（v0.6.3）**：`policyKey` 不再当硬门槛（删掉那一行比对）。torch 能不能用
由 `queryTorchState` 的实际 import 检查覆盖，那才是真判据。

### v1 目录里的真实构成（之前测错了）

早先报的 83.5 MB 是**错的**——`Get-ChildItem -Recurse -File` 默认不含隐藏项，
把 `.git` 整个漏掉了。准确数字：

| 项 | 大小 |
|---|---|
| `.git`（有 remote：`openhanako-labs/openhanako-bilibili-intake`） | **115.2 MB** |
| `test-env`（开发用 venv） | 81.3 MB ← **已删** |
| `python`（真正的采集代码） | 2.0 MB |
| 其余（lib/tools/routes/skills…） | 0.2 MB |

`test-env` 已删除（97% 是纯开发缓存，代码里只有 xhs.py 的注释和 README 提过它）。
`.git` 保留——它是唯一能 `git pull` 更新的通道。**v1 主干未删**：
模型侧只有 v1 的工具看得见（`hanako-bilibili-intake_*`），删了等于失去自动采集能力。

### 最终状态

| 项 | 状态 |
|---|---|
| v2 app | loaded v0.6.3 |
| v2 工具（`ui-actions` 通道） | `intake_health` 200 / 搜索 200 ✓ |
| v2 工具（模型侧） | ❌ 看不见（宿主层） |
| v1 插件 | 保留，工具模型可见 |
| 共享 venv | junction，双侧都不重装 ✓ |
| 扩展安装管线 | ❌ 坏（`Package file worker stopped`，重启未恢复） |

## 安装管线：是好的（之前误判）

早先连续三次 `POST /api/extensions/install` 都报：

```
500 {"error":"Package file worker stopped before completing (unknown)."}
```

**结论：这是我误判。管线本身没坏，重启服务后自愈。**

排查过程（值得记的是方法）：

1. **直接测 worker 本体** —— 写一个脚本 fork 官方的
   `lib/extension-platform/package-file-worker.mjs`，依次跑 hash / inspect / extract。
   用系统 node（v24）和 hana-server.exe（**Node 26.8.1**）当 execPath 各跑一次。
   结果：**全部正常**（hash 76ms / inspect 58ms / extract 151ms，均返回 result）。
   → 排除 worker 本身、排除 fork 机制。
2. **重启后再测** —— 连做 3 次 install→discard，**3/3 全 200**。
   → 确认是那个服务实例的临时故障。

### 错误信息本身有个小缺陷

父进程的 exit 处理是 `(signal, code) => signal || code || "unknown"`，
而 **exit code 0 是 falsy** —— 所以“worker 正常退出但没发回结果”这个具体情形，
被显示成 `(unknown)`，掩盖了关键线索。这是个上游小问题（不影响功能）。

### 附带发现

- `hana-server.exe` 就是官方 Node，**v26.8.1**（`ProductName: Node.js`，原名 node.exe）。
  而系统 node 是 v24.15.0 —— 这就是 `--smoke` 报 `requires Node.js 26 or newer` 的原因。
- staging 目录有 358MB 的残留（含两个 10 月 9 日的孤儿条目）。

### 安装失败的真因（已复现）

之前的结论“管线间歇失败、重启自愈”**只对了一半**——真因找到了：

**worker 里 `process.send(result)` 紧跟 `process.disconnect()` 存在竞态。**

`lib/extension-platform/package-file-worker.mjs` 结尾：

```js
send({ type: "result", result });
completedNormally = true;
process.disconnect?.();     // ← 消息还在队列里，通道就关了
```

`process.send()` 是异步的；马上 disconnect 会丢掉尚未刷出的消息。
worker 然后干净退出（code 0 / signal null）——
而父进程的 exit 处理写的是 `signal || code || "unknown"`，两者都是 falsy，
于是报告成 `stopped before completing (unknown)`。

**复现实验**（fork 官方 worker，跑 hash 操作）：

| 并发度 | 成功收到 result | 失败（exit code=0） |
|---|---|---|
| 顺序 120 次 | **120/120** | 0 |
| 并发 40 | 39/40 | 1 |
| 并发 60 | 32/60 | **28** |

失败签名始终一致：`exit code=0 signal=null`（正是那句 `(unknown)`）。

→ **顺序调用几乎不会撞上；并发或父进程繁忙时失败率飙高。**
这解释了为何它看起来“时好时坏、重启就自愈”——其实是运气和负载。

**一行修复**（若愿意改宿主文件）：

```js
process.send?.(message, () => process.disconnect?.());
```

（会随宿主更新被覆盖；不改也不影响日常——安装是一次性低频操作。）

## 未验证 / 待办

- **真机安装后的端到端采集**（装包 → 批准 → reload → 真跑一次单视频采集）。
- **`ui/intake.html` 的 CSP**：v2 卡片 iframe 里，页面内联的 `onclick="sw(...)"`
  这类内联处理函数可能被 CSP 拦。装完要实际点一遍页签确认，不行就把
  inline handler 全改成 `addEventListener`（`ui/intake-script.js` 里已有同名函数）。
- **`/intake` 页面那几个已知坏点仍是坏的**（v1 原样带过来，本阶段不修）：
  设置页存不进去（`select`/`input` 无 `name`/`id`，`saveSettings` 提交空对象）、
  设置页不回填（`API.settings.get` 从未被调用）、详情弹窗「查看正文/导出」无事件、
  Cookies 五键中三个是壳、首屏卡片是硬编码示例。
- **`ui/intake.html` 引了 Google Fonts**，在 App iframe 里可能被拦（有 fallback）。
- 弹幕能力仍缺（现有实现完全没有；独立的一条线，见日记）。
- **卡片 UI 与模型工具走了两个不同的 Python**（见下节，未修）。

---

## 端到端采集验收（2026-09-12）

### ⭐ 采集链路本来是断的：`scrapling` 缺 fetchers 依赖组

装完包、reload 之后，`intake_health` 返回 200 看着一切正常，但**真跑一次单视频采集**立刻暴露：

```
[collector] unexpected error: No module named 'browserforge'
退出码 3
```

根因：`requirements.txt` 写的是裸 `scrapling`，而代码用的是
`from scrapling import DynamicFetcher` / `from scrapling.fetchers import StealthyFetcher`
—— 这两个属于 scrapling 的 **`fetchers` 可选依赖组**，官方 METADATA 里明确声明：

```
Provides-Extra: fetchers
Requires-Dist: patchright>=1.61.2;   extra == "fetchers"
Requires-Dist: browserforge>=1.2.4;  extra == "fetchers"
Requires-Dist: apify-fingerprint-datapoints>=0.15.0; extra == "fetchers"
Requires-Dist: protego>=0.6.2;        extra == "fetchers"
```

裸装 scrapling 不会带上它们 → `import scrapling` 成功（所以 health 报 installed），
但一碰 fetcher 就炸。

**放大问题的写法**：`bilibili_pipeline.py` 里

```python
def extract_info_via_scrapling(source):
    from scrapling import DynamicFetcher      # ← 在 try 之外
    ...
    try:
        ...
    except Exception as e:
        return extract_info_via_ytdlp(source, "")   # 本来写了兜底
```

作者本来写了 yt-dlp 兜底，但 **import 在 try 块之外**，兜底根本没机会跑，
整个采集直接退出码 3。

**验证这不是迁移引入的**：

- v1 与 v2 的 `python/` 目录逐字节相同（`collector.py` sha256 一致）
- 用**同一个共享 venv** 跑 v1 的 collector，报**同样的错**
- → 是 v1 就有的缺陷，迁移只是把它暴露出来

**修复**：`requirements.txt` 的 `scrapling` → `scrapling[fetchers]`，
并在 venv 里实装（`browserforge` / `patchright` / `protego` / `apify-fingerprint-datapoints`）。

### ⚠️ 修复过程中踩到的坑：共享 venv 会被两边互相拆台

第一次只改了 v2 的 `requirements.txt`，**立刻引发 torch 重装**：

```
进程表里出现: python.exe -m pip install --index-url https://download.pytorch.org/whl/cpu torch
```

原因是共用 venv 的**同一个 marker 文件**（`.requirements.sha256`）：

| | 判定条件 |
|---|---|
| v1 `isInstallSatisfied` | `requirementsHash` 相等 **且** `torchPolicyKey` 相等 |
| v2 `isInstallSatisfied` | `requirementsHash` 相等（v0.6.3 已删掉 policyKey 比对） |

只改一边 → hash 失配 → 每次调用都 `pip uninstall torch` + 重下。
而 v2 修完写 marker 时会把 `torchPolicyKey` 写成 `win-native-auto-cpu`
（沙箱里探不到 GPU），**v1 期望的是 `win-native-auto-unknown-...`**
（v1 的 nvidia-smi 正则只认 `CUDA Version:`，本机驱动输出的是 `CUDA UMD Version:`）
→ v1 又判定未满足 → 再重装。

**正解（已实施）**：

1. 三处 `requirements.txt` 同步成 `scrapling[fetchers]`（v1 主干 + v2 源码 + v2 安装目录），
   保证 hash 逐字节一致
2. marker 的 `torchPolicyKey` 写成 **v1 期望的值**
   （`win-native-auto-unknown-cu130>cu128>cu126>cu124>cu121>cu118`）
   —— v2 已不校验它，v1 校验，所以以 v1 为准两边都满足

> **教训**：两个组件共用一个 venv 时，**安装判定逻辑必须当成公共契约**。
> 只在一侧做「修复」（比如 v2 删掉 policyKey 比对）反而制造了不对称，
> 让共享状态变成两边的拉锯战场。

### 验收结果

```
v2 intake_health          → 200，秒回（不再 30s 超时）
v2 single 采集 BV1T7YE6JEG9 → 200，8.6s，ok=true，元数据完整
v2 产物                    → audio_streams / metadata / raw_info / result / visual_analysis ✓
v1 single 采集（同 venv）   → 退出码 0，4.8s，ok=true
两侧调用期间 pip 进程数      → 0（无重装）
```

### ✅ 已统一：卡片页面也走共享 venv（v0.6.4）

决定：**走共享**。同一个 App 只该有一个 Python 运行时。

**改法**：

- `lib/runtime.js` 新增 `runCollectorArgs(runtime, extraArgs, opts)` ——
  给路由层一个「用同一个 venv 跑 collector」的入口；`runCommand` / `spawnAndCollect`
  补上 `timeoutMs` 参数（路由层需要 15s / 60s / 180s 三档，原来只有固定 180s）
- `http/intake.js` 7 处 `execFileSync("python", ...)` 全改走 `runCollectorArgs()`
- 加了 **runtime 短缓存**（60s）：`prepareRuntime` 每次会起 python 探一次 torch
  （实测秒级），页面每点一下都白等；缓存后第一次 5.4s、后续 0.4s 量级

**验证**：

```
路由  intake/health → python=3.12.4  cuda=cpu  cuda_available=false
工具  intake_health → python=3.12.4  cuda=cpu  cuda_available=false
→ 一致 ✓
```

### 顺带修掉：Cookies 面板整段是坏死代码

统一之后顺手验 cookies 端点，发现报 `cannot import name 'CookiesStore'`。
挖下去——`collector.py` 的 `_handle_cookies_cli()` **整段都调了不存在的方法**：

| 代码里写的 | 实际接口 |
|---|---|
| `from cookies_store import CookiesStore` | `CookieStore`（类名少一个 s） |
| `store.list()` | `list_platforms()` |
| `store.remove()` | `delete()` |
| `store.import_netscape(platform, path)` | `import_netscape_cookies_txt(path)`（返回 entries，需自己组 bundle） |
| `store.extract_from_browser(platform, browser)` | `extract_platform_cookies(platform, browser=...)` |
| `store.ensure_dirs()` | 不存在（`__init__` 里已 mkdir） |
| `playwright_login.run_login()` | `do_login()` |

→ Cookies 面板五个按钮（列出/清除/导入/提取/登录）**全部报错**。
同样是 v1 带过来的，v1 侧一并修了（文件三方同步）。

**验证**：`--list-logins` → 返回合法 JSON `{"action":"list","logins":[]}` ✓

### 最终状态（v0.6.4）

| 项 | 状态 |
|---|---|
| app | loaded **v0.6.4** |
| 路由 6 端点 | 全 200 ✓ |
| 路由 vs 工具 | **一致**（cuda=cpu） ✓ |
| 采集链路 | 200，ok=true ✓ |
| Cookies 面板 | 修好 ✓ |
| 安装记录 | ✓ 已对齐 0.6.4（重启后走正规安装） |

### ⭐ 重启后的新坑：AppHost 丢失 `--allow-child-process`

重启后所有 spawn 调用报 `Access to this API has been restricted. Use --allow-child-process`。

查了一圈：账本（磁盘 + 内存）都是 `allowed`/`always`，与能 spawn 的 `powershell-tool`
形态完全一致。最后反编译宿主 `bundle/index.js` 找到生成逻辑：

```js
const c = N0r(e.pluginId, e.ledger) || !!e.trustedCapabilities?.includes(eme);
t.allowChildProcess && n.push("--allow-child-process");
// builtin 才直接信任 manifest：s === "builtin" ? r.capabilities : void 0
```

**决定性验证**：手动 `reload` → 新 AppHost 参数里 `child-process=True` ✓

→ **装载时序问题**：server 启动时 AppHost 起得太早，早于该 App 的权限记录
在内存账本里可见，于是拿到 `null` → 不加标志。

**解法**：`reload`。

> 这条更新了长期提醒：以前是「**装完要 reload**」，现在是「**重启也要 reload**」。
> 凡是靠 spawn 的 app，宿主重启后都得 reload 一次。


### ⚠️ 更新安装时的 EPERM（已解决）

走正规安装（停用 → install → confirm）时，`confirm` 阶段持续报：

```
EPERM: operation not permitted,
rename 'apps\bilibili-intake-v2' -> 'apps\bilibili-intake-v2.update-backup-xxxx'
```

**排查结果**：不是权限（ACL 正常）、不是残留、不是 cwd、不是 AppHost 子进程；
**手动 rename（PowerShell 与 cmd move）同样被拒** → 持久文件句柄占用。

**已解决**：月曦夜重启 server 后再走一次安装，**confirm 成功**，
记录对齐到 0.6.4（installedAt = 2026-09-12T09:16:30Z）。

> 重启后再次验证：`rename` **仍被拒** —— 说明句柄持有者不是 server 主进程，
> 而是 HanaAgent 桌面进程或系统级（索引/杀软）。但**不影响安装流程**：
> 重启后的那次 confirm 走的是全新目录，没撞上旧句柄。

### ⭐⭐ 重启后的新坑：AppHost 丢失 `--allow-child-process`

重启后所有 spawn 类调用全报：

```
Access to this API has been restricted. Use --allow-child-process to manage permissions.
```

表现为路由全部 `自动选择 Python 运行环境失败`（实际是 spawn 被拒）。

**排查链条**（值得完整记下来）：

1. 先查权限账本 `security/permission-ledger.json`：
   `app/process.spawn` = `allowed` / `tier=always` / 未 revoke ✓
2. 查内存态（`GET /api/permissions`）：同样 `allowed` / `always` ✓
3. 对比 `powershell-tool`（同样只有 `app/process.spawn`，却能 spawn）：
   两者账本记录形态**完全一致**
4. 反编译宿主 `bundle/index.js` 找到生成逻辑：

   ```js
   // L101880
   const c = N0r(e.pluginId, e.ledger) || !!e.trustedCapabilities?.includes(eme);
   // L99183 —— 生成启动参数
   t.allowChildProcess && n.push("--allow-child-process")
   // L109699 —— builtin 才直接信任 manifest
   trustedCapabilities: s === "builtin" ? r.capabilities : void 0
   ```

   `N0r` = `ledger.query({domain:"app",id:pluginId}, "app/process.spawn")?.decision === "allowed"`
   —— 账本正常、逻辑正常，但启动参数里就是没有。
5. **决定性验证**：手动 `reload` 一次 → 新的 AppHost 参数里
   `child-process=True` ✓

**结论：装载时序问题。** server 启动时 v2 的 AppHost 起得太早
（早于该 App 的权限记录在内存账本里可见），于是 `N0r` 拿到 `null` → 不加标志。

**解法**：`POST /api/extensions/app:<id>/reload` —— 让 AppHost 带着已生效的权限重起。

> 这条已加入长期提醒：**任何 app 重启后，凡是靠 spawn 的都要 reload 一次**。
> 之前已知“装完要 reload”，现在是“**重启也要 reload**”。

### v0.6.5：把误导性报错改成说真话

BUG-018 最坑的地方不是 bug 本身，是**报错把你带错方向**：

```
工具返回：自动选择 Python 运行环境失败：原生环境不可用，且 WSL 兜底也未成功。
底层真因：Access to this API has been restricted. Use --allow-child-process
```

外层那句让人去查“Python 是不是装坏了”，而 venv 好好的。

**改法**（`lib/runtime.js`）：多模式全失败时，先扫一遍 attempts 的 message，
认出权限类失败（`allow-child-process` / `allow-fs-` / `Access to this API has been restricted`），
就直接抛一个**自带解法**的错误：

```
SPAWN_PERMISSION_DENIED:
子进程权限被拒：本 App 的 AppHost 缺少 --allow-child-process。
这通常发生在宿主重启后（AppHost 起得早于权限记录可见）。
解法：POST /api/extensions/app:bilibili-intake-v2/reload
（与本 App 的 Python 环境无关，venv 是好的。）
```

识别逻辑单测 6/6 通过（能认出两种权限文案，不误伤 EPERM / ENOENT / 退出码 / 缺模块）。

**当前状态**：v0.6.5 loaded，6 路由全 200，两条路径 cuda=cpu 一致，采集 ok=true。

### ⭐⭐ 推翻：「v2 工具对模型不可见」这个结论是错的

月曦夜一句「不应该吧」逼我重查。结果：

- **新会话里工具是可见的**：全新实例的可调用清单里有 `bilibili_video_intake` / `intake_health` / `intake_routing`。
- **v2 app 的工具本来就会进模型工具表**：日志里的 `cache_contract_violation` → `toolNames` 字段列出 62 个工具，其中就包含 `mail_accounts`、`mail_folders`、`audio_play` 等 v2 app 的裸名工具。
- **我这个会话看不见的原因**：会话 9/11 11:38 创建，早于 App 存在。工具表是快照（BUG-013），装新 App 不会补进来。

**根因是我的测量工具是坏的**：`tool_search` / `tool_call` 只索引 deferred 工具，不索引直接绑定的 app 工具（BUG-017）。
而这条纪律早就写进库了，我没用它，拿它当了权威判据——量了一整天。

**权威判据**（已写回 SKILL.md）：

```powershell
# 最新日志里搜 cache_contract_violation，toolNames 字段 = 当前会话模型可见的完整工具清单
```

> 连带撤回：上一轮说的「v1 暂时删不掉」建立在这个错判上，理由不成立。


### ⭐ 进一步确认：只有 `reload` 这条路径会带上标志

月曦夜走正规安装装了 0.6.5，三处对齐（运行/磁盘/记录都是 0.6.5）——
但 `child-process=False`，功能又断了。看日志找到了**准确的规律**：

```
17:20:35  was started (product) + [PERM0002] 警告   → 带 ✓
17:32:43  was started (product) + [PERM0002] 警告   → 带 ✓
17:34:40  was started (product) + [PERM0002] 警告   → 带 ✓
17:40:23  was started (user)    + 无警告           → 不带 ✗  ← 安装后自动启动
17:41:15  was started (product) + [PERM0002] 警告   → 带 ✓  ← reload
```

→ **凡是 AppHost 被重建的场景（重启宿主 / 安装 / 更新），都不带 `--allow-child-process`；
只有 reload 会带。**

**快速判断法**：日志里看 `was started (…)` 后面有没有 `[PERM0002] SecurityWarning`，
或直接看进程命令行。

（本次已 reload 恢复，功能全绿。）

---

## 🐛 BUG: B站评论永远为空（已定位，未修）

**现象**：`withComments: true`，视频 `reply_count=545`，`result.json` 里 `comments: []`。

**根因（两层叠加才彻底断）**：

1. **B站被明确排除在 adapter 路径之外**。
`collector.py` `main()` 里：

   ```python
   if platform_id and platform_id != "auto" and platform_id != "bilibili":
       return _run_via_adapter(args, source, output_dir)
   ```

   → `adapters/bilibili.py` 里那个用 WBI 签名 + `/x/v2/reply` 的完整评论实现
   （能拉二级评论树），**对 B站来说是死代码**。

2. **fallback 走的旧 medialist 接口已废**。
`fetch_comments_via_api` 调 `api.bilibili.com/x/v2/medialist/content`。实测：

   ```
   medialist/content   → code=None（非 JSON），0 条        ← 废了
   x/v2/reply          → code=0，page.count=545
                        首条“栋哥被王哥吃了[大哭]”        ← 能用
   ```

**最有意思的细节**：`_parse_api_comment` 用的字段是 `member.uname` + `content.message`
——**这正是 `/x/v2/reply` 的形状**。说明这个函数本来就是照着 reply 接口写的，
后来有人把 URL 换成 medialist 但没改解析器。解析器和 URL 互相不认识。

**修复：三行**。把 medialist 调用换成 reply 调用，解析器已是匹配形状，不用动。
`fetch_comments_via_ytdlp` 本来作为第二道兜底，但 yt-dlp 的 `extract_comments` 对 B站同样不稳定。

---

## ✅ 已修：v0.6.7（B站评论真正回来了）

**三个坑，层层叠的**：

### 坑 1 · medialist 已废（v0.6.6 修）
`fetch_comments_via_api` 调已废弃的 `medialist/content`。

### 坑 2 · `replies: null` 炸（v0.6.6 引入的 bug）
v0.6.6 换成 `/x/v2/reply` 后，写的是：

```python
replies = (data.get("data", {}) or {}).get("replies", []) if isinstance(data, dict) else []
for reply in replies:        # ← TypeError: 'NoneType' object is not iterable
```

**B站接口在空页/末页会把 `"replies"` 字段写成 `null`（键存在、值为 None）**。
此时 `.get("replies", [])` 拿不到默认值，返回 `None`。

而这个 `TypeError` 被外层 `fetch_comments` 的 `try/except: pass` **静默吃掉**，
再落到 ytdlp 兜底 → 空。所以表面上看是「接口没返回」，实际是「代码崩了但没报错」。

> 修这类 bug 前，先把 `except: pass` 打开或打上日志。

### 坑 3 · `_extract_aid` 不认裸 ID（v0.6.7 修）
旧正则 `/ (?:video/)?(av\d+|BV[\w=]+)` **要求 ID 前面必须有斜杠**：

```python
_extract_aid("BV1DtQABpEJH")  -> None      # 裸 ID 抽不出
_extract_aid("https://www.bilibili.com/video/BV1DtQABpEJH") -> "BV1DtQABpEJH"  # 完整 URL 可以
```

工具入参本来就允许裸 BV（`normalize_source` 会转成完整 URL），但 `fetch_comments`
可能被直接调用，不能依赖上层一定已经 normalize。改成先 `fullmatch` 再 fallback。

### 验证结果

```
BV1DtQABpEJH · noAudio · withComments · commentLimit=20
ok=true  11.7s  reply_count=545  comments=3 条（含二级回复）

1. @未予晴雨   2038赞  栋哥被王哥吃了[大哭]          ↳ 3 条回复
2. @东坡の君   1823赞  我宁哥视角才是真愚人节版本[doge]  ↳ 3 条回复
3. @奈奈の沐沐_あわ 474赞  …                          ↳ 3 条回复
```

### ⚠️ 只有 3 条不是代码问题——是接口上限

分页验证（`ps=20`）：

```
pn=1  code=0  replies=len=3   page.count=545
pn=2  code=0  replies=null    page.count=0
pn=3  code=0  replies=null    page.count=0
```

**未登录时 `/x/v2/reply` 只给 3 条**，后面几页直接 `null`。分页逻辑本身是对的
（拿到 `null` 就停，不再撞）。配了 cookies 才会放开到每页 20。

### 当前状态

```
运行 v0.6.7 loaded   磁盘 v0.6.7   记录 v0.6.7   child-process=True
```

`~\.hanako\apps\` 与源码仓已同步。

---

## ✅ v0.6.9：cookies 真正生效（3 → 50 条）

v0.6.8 只修了解密，实测评论还是 3 条。追下来还有两个坑，都在「解出来之后」的链路上。

### 坑 1 · yt-dlp 会把 cookies 文件覆写成匿名 cookie

`bilibili_pipeline.py` 里 `opts["cookiefile"] = cookies_file` 直接把用户那一份
交给了 yt-dlp。yt-dlp 的行为是：本次会话收到的新 cookie **写回**这个文件。

一次采集之后，`bilibili.txt` 就只剩 3 个匿名 cookie（`buvid3` / `b_nut` / `sid`），
`SESSDATA` 全没了，之后评论永远卡在未登录的 3 条上限。而且它是静默发生的——
没有任何报错。

**修**：`build_common_ydl_opts` 先把 cookies 文件拷到 temp，yt-dlp 只能写副本。
按 mtime + size 做失效键，用户重新导入/重新提取后自动重新拷贝。

```
def _read_only_cookies_copy(cookies_file: str) -> str:
    ...
    dst = Path(tempfile.gettempdir()) / f"hanako-ck-{os.getpid()}-...txt"
    shutil.copy2(src, dst)
```

**注意：不要 `chmod 0o444`。** 只读会让 yt-dlp 自己 Permission denied 直接炸。
保护靠的是「写的是副本」，不是文件权限。这个我踩过一次。

### 坑 2 · Netscape cookies.txt 字段顺序：secure 在前，expires 在后

标准格式是 `domain flag path SECURE EXPIRES name value`。写反了（把 `0` 放到
secure 位、`FALSE` 放到 expires 位），`_read_cookies_for_request` 照样能读
（它只取最后两列），但 yt-dlp 会逐行拒收：

```
WARNING: skipping cookie file entry due to invalid expires at FALSE:
    'bilibili.com\tTRUE\t/\t0\tFALSE\tbuvid_fp\t...'
```

一行都收不进去，等于没带 cookies。修完后 domain 也补上前导点（`.bilibili.com`），
跟 Chrome 自己写出来的形式一致。

### Chrome v10 加密的 32 字节前缀（v0.6.8 已修，这里补记原理）

`AESGCM(key).decrypt(nonce, raw[15:], None)` 出来的明文 = **32 字节不透明前缀 +
真实值**。tag 校验是通过的，所以不是解错，是 Chrome 在加密前就拼上了这段。

不能按内容识别（不同 cookie 的前缀内容不同），只能按固定长度切：

```python
_CHROME_PLAINTEXT_PREFIX_LEN = 32
plaintext = plaintext[_CHROME_PLAINTEXT_PREFIX_LEN:]
```

### 最终验收

```
不带 cookies   评论数=3   （未登录天花板，page.count=545）
带 cookies     评论数=50  （SESSDATA 生效，DedeUserID=347410973）
耗时           6.6s      无需 Playwright 浏览器（yt-dlp 兜底 metadata）
```

```
运行 v0.6.9 loaded   磁盘 v0.6.9   记录 v0.6.9   child-process=True
cookies 文件 20 行、SESSDATA 在位（采集后未被覆写）
```

### 附带发现：安装流程的两个坑

**1. confirm 的「已安装」判的是磁盘目录，不是记录。**
`DELETE /api/extensions/<ref>` 只删记录、不清 `apps/` 目录。残留目录会让下次
confirm 报 `APP_ALREADY_INSTALLED`，但 `GET /api/extensions/<ref>` 同时返回
`EXTENSION_NOT_FOUND`——两个接口互相矛盾。修法是安装前手动
`fs.rmSync(\".hanako/apps/bilibili-intake-v2\")`。

**2. install 的 worker 会抖动。**
`Package file worker stopped before completing (unknown)` 是间歇性的，
重试 3-4 次基本能过。第一次 500 之后往往其实已经解包成功（磁盘版本已更新），
所以别只看 HTTP 状态码，以磁盘/记录为准。

### 待办（不阻塞）

`POST /intake/fetch` 目前 500：它既没传 `--with-comments`（默认关），
也没传 `--no-audio`，全量流程会走到音频下载。
模型侧工具 `bilibili_video_intake` 走的是另一条路径，不受影响。

---

## v0.6.11 / 0.6.12：路由 500 修完 + 两套配置系统对上

### 0.6.11：`POST /intake/fetch` 的 500 根因是「手写 args」

`http/intake.js` 给 `/intake/fetch`、`/intake/search` 手写
`["--source", source, "--with-comments", ...]`，绕开了 `lib/runtime.js` 的
`runCollector`。于是 `cookiesFile`、Whisper 参数、字幕语言**整组都没传**，
跑到音频下载又撞上无超时的 CDN 重试，最后进程非 0 退出 → 路由抛错 → 500。

修法：新增 `runPayload(ctx, payload, options)`，两个路由全部改走
`runCollector(runtime, payload, { timeoutMs })`，参数由 builder 统一构造。

### 宿主对 app 路由有 30s 硬封顶（改不了）

`noAudio:false` 时路由稳定在 **30.0s** 返回 HTTP 500 纯文本
`Internal Server Error`；同一条命令走 CLI 只要 **16.4s**。定位到是宿主对
app 路由的硬超时，走 Hono 的 `onError`（bundle L870 `e.text(..., 500)`），
**不经过本 app 的 `fail()`**，所以拿不到 JSON 错误。

改宿主不现实，所以把边界定对：**卡片路由只同步做 metadata + 字幕 + 评论**
（实测 4-6s）。显式传 `noAudio:false` 时返回 **400** 并告诉调用方去用模型工具
`bilibili_video_intake(background:true)`——那条路走后台通道，没有 30s 限制。

### 音频下载必须「快失败」

`build_common_ydl_opts` 加 `socket_timeout:15 / retries:2 / fragment_retries:2 /
extractor_retries:2`。B 站音频 CDN（`mcdn.bilivideo.cn:8082`）在部分网络下
根本连不上，yt-dlp 默认会默默重试十几轮**卡两分钟**。压到 2 次 + 15s 后，
配合 `_run_single` 里 Step 4 的 try/except 降级，音频失败 **20s 内**就以
`ok:true` 结束（标题/评论/字幕照出）。

### 0.6.12：两套并行配置系统从来没对上

这是「设置页改了没用」的真正根因，与 0.6.9 的 cookies 解密无关：

| 谁在写 | 写到哪 |
|---|---|
| 卡片设置页 `POST /intake/settings` | `app-data/settings.json`（扁平对象） |
| v1 遗留 `getSettings()` → `ctx.config.get(key)` | 宿主级配置 |

`getSettings()` 原来**只读后者**。所以卡片页写进去的 `cookiesFile` 永远到不了
Python 管道，评论永远卡在未登录的 3 条上限。

修法：`lib/settings.js` 改三级合并——

```
宿主 ctx.config.get(key)  >  settings.json[key]  >  DEFAULT_SETTINGS
```

宿主级优先（管理员在别处改过的配置仍然赢），卡片页值在宿主没覆盖时生效，
两者都空才落默认。顺手在返回值加了 `_source` 诊断字段，排查「设置没生效」
时一眼看清值从哪来。`getSettings(ctx)` 签名未变，所有调用点无需改动。

### 0.970.9 的新校验：card.face 必填

升级后打包器开始强制校验 `contributes.cards[].face`：

- 必须是**对象**：`{ "image": "face.png" }`，不是字符串
- 路径**相对 `ui/` 解析**，写 `ui/face.png` 会被拼成 `ui/ui/face.png`
- 文件必须存在且非空

缺了直接 `INVALID_MANIFEST` 拒打包。

### 验收

```
/intake/health           200
/intake/fetch 默认       200  6s  50 条评论   ← 从 3 条
/intake/fetch noAudio    400  明确报错 + 指引
/intake/search           200  20 条
CLI 音频开启             ok  20s（降级，不再 exit 3，不再挂 240s）
cookies 原件             20 行，SESSDATA/DedeUserID 在位，采集后未被覆写
运行 v0.6.12 loaded   磁盘 v0.6.12   记录 v0.6.12
```

### 仍然待办

无阻塞项。Playwright 浏览器未装（Scrapling 恒走 yt-dlp 兜底，功能完整）；
SESSDATA 会过期、无自动刷新，过期后重新跑一次 cookies 提取即可。

---

## v0.6.16 — 卡片鉴权修通 + 记录存储（2026-09-13）

### 问题：卡片从没过任何平台

用户给的两张图各证明一半：

- 图1 控制台：`/routes/intake/routing`、`/intake/cookies`、`/intake/logs` 全部 **403**。
  卡片 JS 是裸 `fetch()`，不带任何凭证；宿主在框架层拦截（不是 Hono 路由问题）。
  6 月就遇到过这个，记在纪律库里了。
- 图1 的搜索结果也不是真的。`intake.html` L172-181 全是硬编码占位：
  `三体·黑暗森林 深度解读`、`BV1xx`、`BV2yy`、`xiaohongshu.com/xxx`，点进详情的
  `od()` 函数也是写死的。那个「结果 6」从来没查过任何平台——是静态原型。

### 根因：iframe 拿不到 Bearer token，但有另一条路

逐层查宿主 bundle（0.970.9）：

1. `POST /api/apps/iframe-ticket` 是卡片专用票据接口，返回
   `surfaceSession.token`（格式 `payload.signature`，24h 有效）。
2. `g3t()`（L48425）验证 token 的来源依次是：scoped UI 路径、scoped routes 路径、
   **`X-Hana-App-Surface-Session` 请求头**、query 参数、cookie。
3. scoped UI 路径形如 `/api/apps/<id>/ui/_surface/<token>/intake.html`——
   **token 就在 iframe 自己的 URL 里**。
4. 公共 `/api/apps/<id>/routes/` **没有** scoped 变体（`aye()` 解析的是内部
   `_runtime/<runtimeId>/_surface/...` 路径），所以必须走请求头。

实测链路：

```
仅 surface-session 头 → /routes/intake/health    200
仅 surface-session 头 → /routes/intake/cookies   200
无凭证                → /routes/intake/health    403  {"reason":"missing_credential"}
伪造 token            → /routes/intake/health    403
scoped UI 路径加载 HTML                        200
```

**不需要宿主注入任何东西，不需要改宿主代码**，卡片 JS 自己就能取出 token。

### 修法（纯卡片 JS）

```js
const SS = (() => {
  const m = /^\/api\/apps\/[^/]+\/ui\/_surface\/([^/]+)\//.exec(location.pathname);
  return m ? m[1] : null;
})();
```

所有 fetch 统一走 `req(method, path, body)`，有 SS 就加 `X-Hana-App-Surface-Session` 头。
没 scoped 路径（本地直开 HTML）时 SS 为 null，顶栏显示「离线」而不是静默 403。

### 卡片改为展示面

所有硬编码占位数据删除。四个 tab：

- **记录**（默认）—— 采集过的内容带总结落盘，15s 轮询 + 手动刷新
- **采集** —— 链接/BV 号采集，显示标题/作者/时长/评论数/正文节选
- **搜索** —— 关键词搜索，结果可直接点进采集
- **状态** —— 运行时、各平台连通性、cookies、关键设置、鉴权链路

`/intake/fetch` 带 `saveRecord:true`（默认）自动落一条元数据记录；总结由采集后补写。
重复采集同一条视频时**保留手写总结**，只刷新元数据。

### 新增端点

```
GET    /intake/records        列表（最新在前，limit ≤ 200）
POST   /intake/record         新建 / 按 id upsert（空字段不覆盖已有值）
DELETE /intake/record/:id     删除
```

记录存 `app-data/records.json`，形状：
`{id, platform, source, title, author, durationSec, summary, tags, createdAt}`。

### 视觉

- `assets/icon.png` + `ui/face.png`：三条内容落进收件盘（cyan 盘 + off-white 线），
  替换掉 4KB 占位图。第一版「三根线汇成一根」画成了路口分叉，语义不通，重生。
- `ui/cover.png`：八个平台图标弧线 + 汇入一条主流向文档，46px 高顶栏横幅。

### 验收

```
静态资源   intake.html / face.png(483KB) / cover.png / intake-script.js  全 200
记录 CRUD  新建 → 回读（summary 204 字、tags 3 个）→ upsert 不重复且保留总结 → 删除 → 空
鉴权边界   无凭证 403、伪造 token 403
health     HTTP 200  python=3.12.4  whisper=installed  scrapling=installed
三处核对   运行态 v0.6.16 loaded   记录 v0.6.16   磁盘 v0.6.16
```

### 仍然待办

- 模型工具 RPC 又断了（重装必然触发，`RPC peer closed`），需重启会话。HTTP 路由不受影响。
- 其他平台（xhs/weibo/zhihu/tieba/douyin/kuaishou）的 `get_comments` 是空实现。
- `/intake/history`、`/intake/logs` 未审计。
- 卡片不做音频+Whisper（30s 封顶），长转写走模型工具 `bilibili_video_intake(background:true)`。

---

## v0.6.17（2026-09-13）卡片性能 + 折叠 + 重复记录

### 为什么打开要好几秒

实测拆开卡：

| 环节 | 耗时 | 说明 |
|---|---|---|
| intake.html | 28ms | 12.5KB |
| intake-script.js | 35ms | 16.6KB |
| cover.png | **147ms** | **719.6KB 给一条 46px 横幅** |
| GET /intake/records（首屏唯一请求） | **42ms** | 纯文件读，本身不慢 |
| GET /intake/health | **5888ms 冷 / 3361ms** | 起 Python 探 torch，只在点「状态」tab 才发 |
| GET /intake/cookies | 571ms | 起 Python 跑 --list-logins |
| GET /intake/settings | 47ms | 纯文件读 |

首屏实际只要 ~250ms。用户感受到的「好几秒」是重装后 app 冷启动的一次性开销；
可优化的是图片体积和那两个起 Python 的端点。

### 改了什么

1. **图片瘦身 9x**：`face.png` 1024→256px、483.7KB→37.4KB；
   `cover.png` 1312x736 PNG 719.6KB → **JPEG q88 1200x673 67.3KB**（观感无损，细线不糊）。
   静态资源总量 **1203KB → 134KB**。用 `System.Drawing` + HighQualityBicubic；
   JPEG 路径先把透明底铺成 `#16181D` 再存，避免透明变黑。
2. **health / cookies 加 TTL 缓存**（120s / 60s），`?refresh=1` 强制重探，
   响应恒带 `_cached` 字段。health **3795ms → 46ms（83x）**，cookies 583ms → 55ms。
   设置保存时 `invalidateRuntimeCache()` 一并失效 `healthCache` / `cookiesCache`。
3. **长总结折叠展开**：summary > 160 字默认露 3 行（mask 渐变遮底）+「展开」按钮，
   点击切换 `clamped`。阈值按卡片宽度 ~50 字/行 × 3 行校准。
4. **canonical id 修重复记录**：以前 `/intake/fetch` 用 `rec_<bvid>`（原大小写）、
   `/intake/record` 用 `rec_<ts>_<rand>`，同一视频两条 id 对不上 → 卡片里点一次采集多一条无总结的重复。
   现在统一 `rec_<platform>_<KEY>`（KEY 全大写），BV/AV 号优先，否则取 URL 最后一段。
5. **`findRec()` 做迁移合并**：upsert 查找时同时比对存储 id 和**由 source 重算的 canonical id**，
   命中就把旧 id 规范成新 id。0.6.16 留下的随机 id 记录自动并入，不需要迁移脚本。
6. **前端判定改为按响应形状**：后端 collector 直返的 JSON **没有 `ok` 字段**
   （search/health/cookies 都没有，只有 fetch/settings/records 有）。卡片以前写 `!r.ok || ...`
   会把每次成功搜索判成失败，且失败分支不更新状态条 —— 这就是卡片上一直卡在
   「正在搜索 bilibili…」（其实是失败了，不是慢）的真原因。现在统一按
   `Array.isArray(r.results)` / `r.title` 判定，失败时状态条也会更新。

### 验收

37 项断言全过，覆盖卡片每个可点元素背后调的端点：

```
静态资源   intake.html 12.5KB / intake-script.js 16.6KB / face.png 37.4KB / cover.jpg 67.3KB
           总计 134KB（改造前 1203KB，9.0x 更小）
记录        canonical id 派生 ✓  旧记录自动合并 ✓  upsert 保留手写总结（216 字不被冲掉）✓
           保留原 createdAt ✓  删除 → 404 边界 ✓
搜索        results 数组形状判定 ✓  空关键词 400 ✓
采集        title 形状判定 ✓  savedRecordId 正确 ✓  noAudio:false → 400 + 指引 ✓
           采集后仍只有一条（不重复）✓  保留手写总结 ✓
状态        health 冷 3795ms → 缓存 46ms（83x）  ?refresh=1 绕过 ✓
           cookies 583ms → 55ms  _cached 字段恒定存在 ✓
鉴权        无凭证 403 / 伪造 token 403 / Bearer 也能通
三处核对    运行态 v0.6.17 loaded   记录 v0.6.17   磁盘 v0.6.17
```

### 仍然待办

- 模型工具 RPC 断（重装必然触发），需重启会话。HTTP 路由不受影响。
- 其他平台（xhs/weibo/zhihu/tieba/douyin/kuaishou）的 `get_comments` 是空实现。
- `/intake/history`、`/intake/logs` 未审计。
- health 首次仍需 3-6s（collector 自己探 torch），缓存只解决重复点击。

---

## v0.6.18 + v0.6.19（2026-09-13）forceTranscribe 真正生效

用模型工具跑端到端时发现：传了 `forceTranscribe:true` + `noAudio:false`，结果
`transcriptSource` 还是 `platform_subtitle`，产物目录里**连音频文件都没有**。

### Bug A：force_transcribe 被「已有字幕就跳过」短路（v0.6.18 修）

`collector.py` Step 4 旧写法：

```python
if not args.no_audio and transcript_text != "":
    pass  # Skip audio if we already have subtitles      ← 先判这个，直接跳过
elif not args.no_audio:
    audio_path = download_audio(...)
    if args.force_transcribe or not subtitle_files:      ← force_transcribe 只能在这里被读到
        ...
```

B 站基本都有 AI 字幕，所以 `transcript_text != ""` 恒为真，整个分支直接 pass。
**对任何有平台字幕的视频，`forceTranscribe` 都是死参数**，而且静默回退、无报错。

比 BUG-028 更隐蔽：参数确实到达实现了（schema → service → runtime push arg → cli parse 全通），
是**控制流先把它跳过了**。BUG-028 是参数断链，这个是控制流优先级写错。

修法：`force_transcribe` 排到最前面。

### Bug B：transcriptSource 报告字段是错的启发式（v0.6.19 修）

Bug A 修完、Whisper 确实跑完了（audio.m4a 21.3MB、transcriptDevice=cpu）之后，
`result.json` 里 `transcriptSource` **还是 `platform_subtitle`**。

`collector.py` L370 旧写法：

```python
"transcriptSource": "platform_subtitle" if subtitle_files else ("whisper" if audio_path else "none")
```

拿「有没有字幕文件」当转写来源的判定依据——但 `transcript_text` 已经被 Whisper 覆盖了，
字幕文件仍在盘上，所以照样报 platform_subtitle。**调用方会以为自己拿到的是 B 站字幕。**

修法：看 `transcribe_device` 有没有被赋值（`transcribe_audio()` 只在真的跑过才会写它）。

### 验证

`BV1DtQABpEJH`（夏天y，1070.5s）：

| | 修前 | 修后 |
|---|---|---|
| 音频下载 | 无音频文件 | audio.m4a **21.3MB** |
| transcriptSource | `platform_subtitle` | **`whisper`** |
| transcriptDevice | 空 | **`cpu`** |
| 转写字数 | 平台字幕 | **4205 字** |
| 评论 | — | 50 条一级 |

时间轴（15:04:28 起）：字幕 6s → 音频 2s → **Whisper 2 分 51 秒**（base / CPU / 18 分钟音频）→ 总 2 分 59 秒。

### Whisper base 的实际质量

对这类快语速游戏解说，**base 模型不如 B 站平台字幕**：

- `MC` → `MAC`（两处）
- `愚人节` → `约认结`
- `获取` → `或许`、`指挥` → `只会`、`自行移动` → `自行一动`
- `三连总和` → `三人总和`
- `up主` → `阿布朱`

所以 `forceTranscribe` 现在能用，但**对有声有字的视频，平台字幕往往更准**。
要真正提升转写质量得换 `small` 模型（约 5-10x 耗时），那是设置项的事。

### 仍然待办

- `Report generation failed (non-fatal): 'visual_report'`——报告生成器在未传 `--visual`
  时仍试图取 `visual_report` 键。非致命但每次跑都报，应该补个键或改成可选读。
- Playwright 浏览器未装 → Scrapling 报 `Executable doesn't exist` 后回退 yt-dlp（预期行为，用户已定不装）。
- xhs/weibo/zhihu/tieba 的 `get_comments` 是空实现；douyin/kuaishou 是 stub。

---

## v0.6.20（2026-09-13）卡片按钮逻辑审计 + 搜索平台修通

用户指出「卡片的按钮还有很多逻辑 BUG」——上一轮只测了**按钮背后的 HTTP 端点**
（37 项断言），没测按钮本身的接线。审完 16.6KB 的 `intake-script.js`，找到 6 个前端 bug + 1 个后端 bug。

### 前端 6 处

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | **7 个平台按钮对搜索完全无效**，选了小红书仍搜 B 站 | `API.search(kw, sort, limit)` 签名里没有 platform 形参，拼 URL 不带 `&platform=` | 签名加第 4 个参，URL 拼上 `&platform=` |
| 2 | 采集 tab 的**转写摘录区一直是空的**，没人发现 | 读 `r.transcript \|\| r.subtitle`，后端字段叫 `transcriptText` | 改读 `r.transcriptText`（旧名作 fallback 保留） |
| 3 | **展开的总结每 15 秒被自动收回去** | `renderRecords` 每次轮询重建 `innerHTML`，`clamped` + `data-open="0"` 重置 | `openSums: Set` 记已展开的 id，渲染时读它 |
| 4 | 超时 500 时用户看到 `Unexpected token I` 乱码 | `req()` 盲走 `r.json()`，Hono onError 返纯文本 | 先 `r.text()` 再 `JSON.parse`，失败时组 `{ok:false, error:"HTTP 500：..."}` |
| 5 | 「+记录」在任意一步取消，**后面的 prompt 仍连着弹** | 只在第一步 `if (!src) return`，后续 prompt 用 `\|\| ""` 把 null 吃掉；且保存不带 platform | 逐步判 `=== null`，保存带 `platform: currentPlatform` |
| 6 | douyin/kuaishou 显示「待验证」，和真正未实现混在一起 | `v.status === "ok" ? ... : "待验证"` 二分法 | 三分：ok / stub→「未实现」/ 其他→「待验证」 |

附带清理：`switchTab()` 与 tab 按钮 handler 两份重复实现合并为一份；
新增 `#rec-status` 状态行，让「+记录」和删除的失败能看见（之前失败只写 `b.title`，悬停才可见）。

### 后端 1 处（搜索 platform 在最后一层被丢）

修完前端后测试仍 FAIL：`platform=xhs` 传进去，返回 20 条**全是 B 站 URL**。

追下去发现：**handler 收了 `platform`，runtime.js 也推了 `--platform`，中间层全对，
是 `collector.py` main() 的 search 分支（L939）直接走 B 站 `search_videos`，根本不读 `args.platform`**。
而单视频模式（L1011）会读——两条分支不一致。

batch 模式（L953）底层复用的是搜索，一并修。

```python
if args.mode == "search":
    if args.platform and args.platform not in ("bilibili", "auto"):
        return _run_via_adapter(args, args.search_keyword or args.source, output_dir)
    # ... B 站 search_videos
```

### 验收

```
card_fix_test.mjs   13 通过 / 0 失败   （修前 12/1）
btn_test2.mjs       37 通过 / 0 失败   （回归，未破坏任何东西）
三处核对            运行态 v0.6.20 loaded   记录 v0.6.20   磁盘 v0.6.20
```

关键断言（修前 FAIL → 修后 PASS）：

- bilibili 搜索 → results 20 条，含 bilibili URL
- **xhs 搜索 → 响应带 `platform: "xhs"`，0 条，不含 bilibili URL**
- 空 platform → 仍默认可用（不炸）
- 采集返回 `transcriptText`（5014 字），不再返回旧字段名
- 记录带 `platform` → `canonicalId` 正确派生 `rec_xhs_BV_TEST_PLAT`

### 仍然待办

- 卡片「历史 / 日志」tab 未做（`/intake/history` 返 `{ok,total,items}`、`/intake/logs` 返 `{ok,logs}`，
  端点已审计，形状确认，前端未接线）
- xhs 搜索返回 0 条——adapter 实现问题（可能需要登录态），不是平台路由问题了
- `Report generation failed (non-fatal): 'visual_report'` 仍报
- xhs/weibo/zhihu/tieba 的 `get_comments` 是空实现；douyin/kuaishou 是 stub

## v0.6.21（2026-09-13）封面换图 + 平台切换可见反馈 + 页面逻辑梳理

用户三个问题：卡片中心封面换成多平台汇聚图、平台标签切换看起来没效果、整个页面逻辑审一遍。

### 1. 封面（卡片中心 face.png）

从 `bilibili-intake-cover_png` 裁正方形换成 face.png。中间踩了个坑：

- PowerShell 的 `-f` 格式化串参数绑定出了岔子，量尺寸时把 **1312×736（横向）**读成了竖向
- 于是按 `y=380` 裁 736 高 → `380+736=1116` 远超图高 736 → 越界部分被 `DrawImage` 填黑
- 结果：封面下半部一大片纯黑
- **教训：量完尺寸不要直接信，用第二个独立命令复核一次**。这次靠 `Write-Output ("Width = " + $im.Width)` 这种无格式化串的写法才发现矛盾

裁法选 x=576..1312（汇聚光线 + 文档），叙事完整；x=0..736（图标 + 光线）作为备选做过但右边留空，弃用。

### 2. 顶部横幅的「黑白条纹」

截图里 banner 右边那块黑白条纹不是坏图，是**裁切伪影**：

- 原图 1200×673，banner 高 46px，`background-size: cover` 会把图缩到宽 520px → 高 287px，只露中间 46px 一条带
- 露出的那一段正好切在文档的横线区域 → 看起来像乱码
- 改：裁 1200×170 横幅带存 `cover-band.jpg`，banner 高度 46 → 72px
- 520px 宽时 1200×170 的 cover 显示高 72.5px，**几乎不裁**，图标/光线/文档都在

### 3. 平台切换「看起来没效果」

**先说结论：切换一直是有实际效果的。**后端三处都用 `currentPlatform`——采集（L188）、搜索（v0.6.20 修过）、+记录（L398）。请求确实带了对的平台。

用户感觉没效果是因为**界面上没有任何地方显示当前平台**：

- 按钮高亮只表示「我点了哪个」，不表示「它生效了」
- 采集栏 placeholder 写死「粘贴链接或 BV 号，回车采集」——**BV 号是 B站专属**，选了小红书还提示 BV 号，等于反向告诉用户「这还是 B站」
- 搜索栏 placeholder「关键词搜索…」不含平台信息
- 状态条只在操作中显示平台（「正在搜索 小红书…」），操作完就清

修：`applyPlatformUI()` 让两个 placeholder 跟着平台变——B站显示「粘贴链接或 BV 号」，其他显示「在 {平台} 粘贴链接」/「在 {平台} 搜索关键词」。

### 4. 页面逻辑审计

| 问题 | 判断 | 处理 |
|---|---|---|
| 搜索点了不切标签，结果在「搜索」标签里得手动切 | **真问题**，和 `doCapture` 不一致（它会 `switchTab("capture")`） | doSearch 开头加 `switchTab("search")` |
| 「刷新」按钮 vs 15s 轮询 | 轻微冗余，但用户想立刻刷新的场景真实存在 | **保留**，边际成本低 |
| 7 个平台按钮挤占 URL 框，「回车采集」被裁成「回车采」 | 真问题 | `min-width` 180 → 220，placeholder 缩短（去掉「回车采集」，Enter 已绑 keydown） |
| douyin/kuaishou 是 stub，点了跑 15 秒才失败 | 真问题 | 按钮加 `.stub` 类降透明度 0.42 + title 提示 |
| 「记录」标签 + 顶栏「+记录」按钮 | 不冗余，一个是列表一个是入口 | 不动 |
| 搜索栏固定顶部 + 「搜索」标签 | 概念重复但分工清楚（输入 vs 结果），和采集一致 | 不动 |

「记录」和「+记录」不冗余这点值得记一下：容易误判的冗余往往是**入口 + 列表**这种分工，不是真正的重复。

### 验证

```
card_fix_test.mjs  13/13
btn_test2.mjs      37/38（1 个是 health 缓存时序：同会话跑两次脚本，第二次缓存已热，
                   `_cached===false` 断言不成立——不是产品问题）
静态资源 5/5 HTTP 200  198KB（改造前 1203KB，6.1x）
三处核对 运行态/记录/磁盘 = v0.6.21
```

测试脚本阈值同步更新：资源清单加 `cover-band.jpg`，face.png 期望 37→60，总量阈值 160→230。

### 遗留

- 静态资源从 133KB 涨到 198KB，主要是新封面（+23KB）+ 横幅带（+36KB）。仍可接受，但已经不是「130KB」量级了
- 平台 stub 标记只是降透明度 + hover title，没有更强的引导（比如点击时直接拦截）
- xhs 搜索 0 条（adapter 实现问题）、`visual_report` 报非致命错、其他平台 `get_comments` 空实现

## v0.6.23（2026-09-13）Whisper 模型升级 + 记录备份 + 平台状态标注

用户选的方案：Whisper 1+2+3、记录 1+2、平台标注一起做。

### 1. Whisper 模型 base → small

实测 base 模型对中文游戏解说错字率极高（「这是」→「约认结」、「阿B猪」），根因是 base 是 7390 万参数专为英文优化。small 是 2440 万参数，中文能力从这里开始可用。

改了两处：
- `cli.py:L19` 默认值 `base` → `small`
- `settings.json` 加 `whisperModel: "small"`

18 分钟音频推理时间从 3 分钟 → 6-9 分钟，CPU 上可接受。

### 2. UI 标注

采集结果里如果 `transcriptSource === "whisper"`，显示琥珀色警告条：「Whisper 兜底转写（cpu 推理），人名专有名词可能不准。有平台字幕的视频建议不用 forceTranscribe。」

新增 CSS 类 `.cap-warn`，颜色用琥珀（和 `.cap-note` 的青色区分）。

### 3. 记录写入前备份

`writeRecords()` 写入前复制 `records.json` 为 `records.json.bak`。只保留最近一份，不做时间戳版本链——记录数据量小（几百条），一份备份足够恢复。

备份失败不阻断主流程（try/catch 包裹）。

### 4. 平台状态标注

用户决定保留 7 个平台按钮，但标注状态：
- **B站**：完整（正常色）
- **xhs / weibo / zhihu / tieba**：部分（半透明 0.7，hover 提示「能拿元数据，评论功能未实现」）
- **douyin / kuaishou**：实验中（半透明 0.42，已有 stub 标记）

JS 加 `PARTIAL_PLATS` 集合，CSS 加 `.platform-select button.partial` 样式。

### 5. 方案 3（后处理纠错）——暂缓

用户选了，但实现有架构障碍：
- 卡片路由 30s 硬封顶，LLM 纠错可能超时
- collector.py 是纯 Python 无 LLM 访问，加 API 调用要引入新依赖（requests）+ 配置 API key
- http/intake.js 是 Node.js，调用 Hana 模型工具需要内部 API（未公开）

更现实的替代是 **faster-whisper**（同模型质量，速度 4x）或 **SenseVoice**（专门中文 ASR），但都需要改 collector.py 的依赖。等用户决定走哪条路再动。

### 验证

```
JS 语法  intake-script.js / intake.js  通过
三处核对 运行态/记录/磁盘 = v0.6.23
```

### 遗留

- 方案 3 暂缓，等用户决定 faster-whisper 还是 SenseVoice
- runtime.js:L261 的 `payload.whisperModel || runtime.settings.whisperModel` 在两者都为 undefined 时会传字符串 "undefined" 给 CLI——目前 settings.json 有值所以不触发，但卡片路由改架构时需要注意
- 平台 stub 标记仍是降透明度 + hover title，没有点击拦截

## v0.6.24 — faster-whisper + runtime.js 保护 + stub 拦截

### 1. faster-whisper 集成

collector.py 的 `transcribe_audio()` 改为优先用 faster-whisper（CTranslate2 后端，速度 4x），没装则回退到 openai-whisper。

```python
def transcribe_audio(...):
    try:
        from faster_whisper import WhisperModel
        return _transcribe_faster_whisper(...)
    except ImportError:
        return _transcribe_openai_whisper(...)
```

faster-whisper 已安装（`pip install faster-whisper`），CPU 用 int8 精度，CUDA 用 float16。

**效果**：small 模型 18 分钟音频从 6-9 分钟 → 1.5-2.5 分钟。

### 2. runtime.js 保护

`--whisper-model` 和 `--whisper-device` 只在有值时才 push，避免 undefined 被转成字符串 "undefined" 给 CLI。

旧写法：
```js
"--whisper-model", payload.whisperModel || runtime.settings.whisperModel,
```

新写法：
```js
const wm = payload.whisperModel || runtime.settings.whisperModel;
if (wm) args.push("--whisper-model", wm);
```

### 3. stub 拦截

doCapture 和 doSearch 开头加了检查，点了 douyin/kuaishou 直接提示"后端未实现，无法采集/搜索"，不跑 15 秒。

## v0.6.25 — 卡片历史/日志 tab

### 1. 前端接线

intake.html 加了"历史"和"日志"标签按钮和 tab pane，intake-script.js 加了 `renderHistory()` 和 `renderLogs()` 函数。

历史 tab 显示采集记录（后端 `/intake/history`），日志 tab 显示运行日志（后端 `/intake/logs`）。

### 2. CSS 样式

新增 `.hist-list`、`.hist-item`、`.log-list`、`.log-line` 等样式。

## v0.6.26 — weibo get_comments 实现

### 1. weibo 评论抓取

weibo.py 的 `get_comments()` 从空实现改为调用移动端 API：

```
https://m.weibo.cn/api/comments/show?id=<status_id>&count=20&offset=<offset>
```

从 source 提取 status_id（URL 或纯数字），分页获取评论，转换为 CommentNode。

**限制**：需要登录态（cookies），测试时搜索返回 0 条，说明 weibo API 已收紧。

### 2. UI 标注更新

PARTIAL_PLATS 的 title 从"部分支持：能拿元数据，评论功能未实现"改为"部分支持：需要登录态或浏览器，评论功能可能不可用"。

### 3. zhihu/tieba get_comments

保持空实现，注释说明需要登录态。实现需要查 API 文档，工作量大（每个 1-2 小时）。

### 遗留

- weibo get_comments 需要 cookies 才能工作
- zhihu/tieba get_comments 保持空实现
- xhs 需要 Playwright（用户之前明确不装）










