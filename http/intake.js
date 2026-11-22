/**
 * http/intake.js — 内容摄取页面的后端 API
 *
 * v2 差异：
 *   - 文件从 routes/ 改坐 http/：v2 把顶级 routes/ 目录当成另一种路由来源，
 *     与 ctx.routes.register() **互斥**，两边同时存在整个应用装载时直接 failed。
 *   - 路径前缀去掉 /api/intake/...，改成 /intake/...，因为 ctx.routes.register
 *     已经把自己挂在 /api/apps/<appId>/routes/ 下面。
 *   - 页面本身不再由这里渲染：v2 把 ui/ 静态树挂在 /api/apps/<id>/ui<route>，
 *     卡片直接指向 ui/intake.html。
 *
 * ⭐ v0.6.4：统一 Python 运行时。
 *   本文件过去是 v1 的 routes/intake.js 原样搬来的，7 处 `execFileSync("python", …)`
 *   走的是**系统 Python**，而模型工具走的是**共享 venv** —— 同一个 App 里两个解释器，
 *   health 报 cuda 12.8/true、工具报 cpu，互相矛盾。
 *   现在全部改走 lib/runtime.js 的 runCollectorArgs()，与模型工具同源。
 */
import fs from "node:fs";
import path from "node:path";
// ⭐ 2026-11-21：登录链路要"启动一个长时间存在的子进程立刻返回"，
//   runCollectorArgs 是等待型（会阻塞成分钟级）。
import { spawn } from "node:child_process";
import { getSettings } from "../lib/settings.js";
import { getVenvPython, prepareRuntime, runCollector, runCollectorArgs } from "../lib/runtime.js";
// ⭐ 2026-09-22：记录读写抽到共享实现（卡片侧与模型工具侧同一份）。
import { backfillFromCaptures, canonicalId, listRecords, patchFromResult, readRecords, reconcileSummaries, recordsStamp, upsertRecord, writeRecords } from "../lib/records.js";
// ⭐ W3（2026-09-26）：删除（记录 + 本地产物）与缓冲。
import { emptyTrash, listTrash, purgeRecords } from "../lib/purge.js";
import { writeArtifact } from "../lib/artifacts.js";

/**
 * runtime 解析结果的短缓存。
 *
 * 为什么需要：prepareRuntime 每次都会起 python 探一次 torch（`import torch`，实测秒级），
 * 若每个 HTTP 请求都走一遍，页面每点一下都要白等。runtime 的形态（用哪个 venv、
 * 哪个模式）在一次进程生命周期内是稳定的，缓存住即可。
 *
 * 失效方式：TTL 到期，或调用方显式 invalidate（改设置后）。
 */
const RUNTIME_TTL_MS = 60_000;
let runtimeCache = null;

/**
 * 起一个 Python 进程收集 stdout，并从里面挑出第一行能解析的 JSON。
 *
 * ⭐ 2026-11-21：登录链路的两个辅助端点（取平台清单 / 探 browser_login）
 *   跑的不是 collector.py，runCollectorArgs 用不上。这里只做一件事：
 *   把“跑个脚本、拿最后那条 JSON”包成 Promise。
 */
function runPythonCapture(pythonExe, args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn(pythonExe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      return done({ ok: false, error: String(err?.message || err) });
    }
    let out = "";
    let errText = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      done({ ok: false, error: `超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { errText += String(d); });
    child.on("error", (e) => { clearTimeout(timer); done({ ok: false, error: String(e?.message || e) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      for (const line of out.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith("{") || !t.endsWith("}")) continue;
        try { return done(JSON.parse(t)); } catch { /* 不是 JSON 行 */ }
      }
      done({ ok: false, error: (out || errText || `退出码 ${code}`).slice(-400) });
    });
  });
}

// ⭐ v0.6.17：health 会起 Python 探 torch，实测冷启动 5.9s / 命中 runtime 缓存后仍 3.4s
//（health 这个 action 自己就在探）。卡片点「状态」tab 才调它，不该每次白等。
const HEALTH_TTL_MS = 120_000;
let healthCache = null;
let cookiesCache = null;
const COOKIES_TTL_MS = 60_000;

async function runtimeFor(ctx) {
  const now = Date.now();
  if (runtimeCache && now - runtimeCache.at < RUNTIME_TTL_MS) {
    return runtimeCache.runtime;
  }
  const settings = await getSettings(ctx);
  const runtime = await prepareRuntime(ctx, settings);
  runtimeCache = { at: now, runtime };
  return runtime;
}

/** 供设置保存等场景主动失效（下一请求重新解析）。 */
export function invalidateRuntimeCache() {
  runtimeCache = null;
  healthCache = null;
  cookiesCache = null;
}

/** 跑一次 collector，返回解析后的 JSON；失败时抛出带 stderr 的错误。 */
async function runJson(ctx, args, { label, timeoutMs, inputPaths } = {}) {
  const runtime = await runtimeFor(ctx);
  const { stdout } = await runCollectorArgs(runtime, args, { label, timeoutMs, inputPaths });
  const text = String(stdout || "");
  try {
    return JSON.parse(text.trim());
  } catch {
    // ⭐ 2026-11-22：Python 侧某一行 print 忘了写 stderr（实测：cookies_store 的两行
    //   "User Data 目录未找到"），stdout 就被诊断文字污染，整段 JSON.parse 直接抛，
    //   前端只看到一句 `Unexpected token 'c'`——既看不出哪个平台失败，也不知道为什么。
    //   已经把那几行改成 stderr 了；这里再加一道：从后往前找第一条可解析的 JSON 行。
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.startsWith("{") && !line.startsWith("[")) continue;
      try { return JSON.parse(line); } catch { /* 不完整，继续往前 */ }
    }
    throw new Error(`${label || "collector"} 的输出不是 JSON：${text.slice(0, 200)}`);
  }
}

/**
 * ⭐ v0.6.10：页面端采集改走 canonical 的 runCollector(payload)。
 *
 * 以前 fetch / search 两条路由自己拼 args，漏了三样关键参数：
 *   1. --cookies-file（settings.cookiesFile）——B 站字幕/音频要登录态，
 *      不带就等于匿名采集，B 站直接不给字幕；
 *   2. --with-comments + --comment-limit——cli.py 里是 store_true，
 *      不传就是 0 条评论，容易被误判成「cookies 没生效」；
 *   3. --no-audio——音频 CDN 连不上时会抛异常炸掉整个进程。
 * 改走 runCollector 后，whisper 模型/设备/字幕语言/audioFormat 也自动带上，
 * 与模型工具同一套行为，不会再出现「卡片结果和工具结果不一致」。
 */
async function runPayload(ctx, payload, { timeoutMs } = {}) {
  const runtime = await runtimeFor(ctx);
  return runCollector(runtime, payload, { timeoutMs });
}

/** 把异常统一成页面能读的形状（v1 时代也是这个约定：{ ok:false, error }）。 */
function fail(c, e) {
  const detail = e?.details?.stderr ? `：${String(e.details.stderr).trim().slice(0, 300)}` : "";
  return c.json({ ok: false, error: `${e?.message || String(e)}${detail}` });
}

export default function (app, ctx) {
  const dataDir = ctx.dataDir || path.join(ctx.pluginDir, ".data");

  // ── API: 健康诊断 ──
  // 带 TTL 缓存；?refresh=1 强制重探。卡片前端读 cached 字段决定是否显示「x 分钟前」。
  app.get("/intake/health", async (c) => {
    try {
      const force = c.req.query("refresh") === "1";
      const now = Date.now();
      if (!force && healthCache && now - healthCache.at < HEALTH_TTL_MS) {
        return c.json({ ...healthCache.body, _cached: true, _cachedAt: healthCache.at });
      }
      const body = await runJson(ctx, ["--action", "health"], { label: "health", timeoutMs: 60_000 });
      // venv 决策（自有 / 复用 v1 / 显式 runtimeRoot）只有 JS 侧知道，Python 报不了。
      // runtimeFor 带 60s 缓存且 health 本来就要起 Python，这里顺手带上零成本。
      try {
        const runtime = await runtimeFor(ctx);
        body.env = {
          venvDir: runtime.venvDir || "",
          mode: runtime.mode || "",
          runtimeSource: runtime.runtimeSource || "",
          reusedLegacyRuntime: !!runtime.reusedLegacyRuntime,
        };
      } catch { body.env = null; }
      healthCache = { at: now, body };
      return c.json({ ...body, _cached: false });
    } catch (e) { return fail(c, e); }
  });

  // ── API: 路由状态 ──
  app.get("/intake/routing", async (c) => {
    try {
      return c.json(await runJson(ctx, ["--action", "routing-status"], { label: "routing", timeoutMs: 30_000 }));
    } catch (e) { return fail(c, e); }
  });

  // ── API: 采集 ──
  //
  // ⭐ 边界说明：卡片路由是**同步短请求**，宿主对 app 路由有 30s 封顶（实测，
  // 超了直接 HTTP 500 `Internal Server Error`，不走本文件的 fail()）。
  // 所以这里默认 noAudio=true：只做 metadata + 字幕 + 评论，实测 4-6s。
  // 音频下载 + Whisper 转写是长任务，走模型工具 bilibili_video_intake
  // 的 background 通道，那里没有 30s 限制。不要在这里默默接受 noAudio:false
  // ——那样调用方只会看到一个看不懂的 500。
  app.post("/intake/fetch", async (c) => {
    try {
      const body = await c.req.json();
      const { source, platform, mode } = body;
      if (!source) return c.json({ ok: false, error: "需要 source" }, 400);
      if (body.noAudio === false) {
        return c.json({
          ok: false,
          error: "卡片接口不支持音频下载 + Whisper 转写：宿主对 app 路由有 30s 封顶，"
            + "音频路径经常超时。请用模型工具 bilibili_video_intake（传 background:true），"
            + "那里走后台通道，没有 30s 限制。",
        }, 400);
      }
      const outputDir = path.join(dataDir, "captures", `p_${Date.now()}`);
      const result = await runPayload(ctx, {
        source,
        platform,
        mode,
        outputDir,
        // 默认带评论（与工具端一致），可显式关闭。
        withComments: body.withComments !== false,
        // ⭐ withSubComments 也要转发。漏了的话卡片侧关不掉二级评论，
        // 而工具侧可以——两边行为不一致。
        withSubComments: body.withSubComments !== false,
        commentLimit: Number(body.commentLimit) > 0 ? Number(body.commentLimit) : 50,
        noAudio: true,
        withCreator: body.withCreator === true,
        page: Number(body.page) > 0 ? Number(body.page) : 0,
        cookiesDir: body.cookiesDir || "",
      }, { timeoutMs: 25_000 });

      // ⭐ P1（2026-09-22）：统一素材描述。卡片侧采集也落 artifact.json，
      //   与模型工具侧同源 —— 否则同一个 App 里两条路径产出的"素材"形状又不一样。
      result.artifact = writeArtifact(result, { slotDir: result.outputDir || outputDir, anchors: null });
      if (result.artifact?.kind) result.kind = result.artifact.kind;

      // ⭐ v0.6.16：采集完自动落一条记录（不含总结，总结由模型工具补）。
      //   saveRecord:false 可跳过。批量模式不记录，只记单条采集。
      if (body.saveRecord !== false && mode !== "batch" && result?.title) {
        try {
          // ⭐ 2026-09-22：改用共享 upsert + patchFromResult。
          //   以前这里自己拼一遍字段，漏掉了 result 里现成的产物与转写信息
          //   （outputDir / transcriptTextPath / transcriptSource / subtitleFiles / reports）——
          //   记录里看不到产物，用户只能猜"总结之后文件到底有没有留存"。
          const { record } = upsertRecord(ctx, patchFromResult(result, { platform, source }));
          result.savedRecordId = record.id;
        } catch (e) { result.saveRecordError = e?.message || String(e); }
      }
      // ⭐ 2026-09-26：采集完**自动**写总结（用户原话「要自动」）。
      //   形态：走宿主模型通道（app/models.infer），不往对话里插消息、不需要用户在场；
      //   产物与助手写的完全同源（summary.json + 记录回写）。
      //   ⭐ 2026-10-04：不再自己 `void` 后台 promise，改提交给宿主的 App 任务通道。
      //   原因：后台 promise 跑起来时这次请求的 invocation 已经被回收，模型通道按
      //   「有效 callToken 或本应用活动 taskId」认范围 —— 两者都拿不到，于是
      //   每一次自动总结都死在 `App invocation expired or belongs to another App`（日志里 13 条，
      //   21/22 条记录没总结就是这么来的）。现在交给一个 scope:"app" 的持久任务，
      //   后台带着它的 taskId 打模型通道。细节见 lib/summary-task.js。
      //   关掉它：设置 summaryAuto = false。
      if (body.autoSummary !== false && mode !== "batch" && result?.title) {
        try {
          const { getSettings } = await import("../lib/settings.js");
          const settings = await getSettings(ctx);
          if (settings.summaryAuto) {
            const { submitAutoSummary } = await import("../lib/summary-task.js");
            const slotDir = result.outputDir || outputDir;
            // submitAutoSummary 自己带退路：建不上任务也会就地试一次，并把状态写进记录。
            const t = await submitAutoSummary(ctx, {
              slotDir,
              recordId: result.savedRecordId || "",
              title: result.title,
            });
            result.autoSummary = t.ok
              ? { pending: true, taskId: t.taskId }
              : { pending: true, inline: true, note: t.error };
          } else {
            result.autoSummary = { skipped: true, reason: "设置里关了「采集后自动写总结」" };
          }
        } catch (e) {
          result.autoSummary = { ok: false, error: e?.message || String(e) };
        }
      }
      return c.json(result);
    } catch (e) { return fail(c, e); }
  });

  // ── API: 给已有记录补写 / 重试总结（2026-10-04）──
  //
  // 为什么需要这个入口：卡片以前对「没总结」只做一件事 —— 显示「未写总结」。
  //   但实际有三种不同的情：从没跑过 / 跑了但模型通道拒了（invocation 过期）/
  //   根本没正文可总结。对用户都是四个字，对排障完全无用。
  //   这个入口把「重跑一次」交给用户，同时把失败原因写回记录（summaryNote），
  //   下次卡片就能说清楚是哪一种。
  // body: { recordId } 或 { slot }（captures 下的目录名 / 完整路径）
  app.post("/intake/summarize", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const { submitAutoSummary, markSummary } = await import("../lib/summary-task.js");
      const { readRecords, sameDirPath } = await import("../lib/records.js");

      const all = readRecords(ctx);
      let rec = null;
      if (body.recordId) rec = all.find((r) => r.id === body.recordId) || null;
      if (!rec && body.slot) {
        const want = String(body.slot).replace(/[\\/]+$/, "");
        const full = want.includes("\\") || want.includes("/")
          ? want : path.join(dataDir, "captures", want);
        rec = all.find((r) => r.artifactDir && sameDirPath(r.artifactDir, full)) || null;
      }
      if (!rec) return c.json({ ok: false, error: "找不到这条记录" }, 404);

      const slotDir = String(rec.artifactDir || "").trim();
      if (!slotDir || !fs.existsSync(slotDir)) {
        // 没产物就没法总结（老记录只存了摘要文本，没落过槽位）。
        markSummary(ctx, { recordId: rec.id, slotDir, status: "no-text", note: "这条记录没有本地产物目录，正文已不在，无法补写总结" });
        return c.json({ ok: false, error: "这条记录没有本地产物目录，无法补写总结", recordId: rec.id });
      }

      const job = { slotDir, recordId: rec.id, title: rec.title || "" };
      // submitAutoSummary 自带退路：建不上任务也会就地试一次，并把结果写回记录。
      // 所以这里不管哪种情都回 ok —— 区别只在跑在哪条路上。
      const t = await submitAutoSummary(ctx, job);
      return c.json({
        ok: true,
        recordId: rec.id,
        pending: true,
        taskId: t.taskId || undefined,
        inline: !t.ok,
        note: t.ok ? undefined : t.error,
      });
    } catch (e) { return fail(c, e); }
  });

  // ── API: 搜索 ──
  app.get("/intake/search", async (c) => {
    try {
      const kw = c.req.query("keyword") || "";
      const sort = parseInt(c.req.query("sort") || "0", 10);
      const limit = parseInt(c.req.query("limit") || "10", 10);
      const platform = c.req.query("platform") || "";
      if (!kw) return c.json({ ok: false, error: "需要 keyword" }, 400);
      const out = path.join(dataDir, "captures", `s_${Date.now()}`);
      return c.json(await runPayload(ctx, {
        mode: "search",
        outputDir: out,
        searchKeyword: kw,
        searchSort: sort,
        searchLimit: limit,
        platform,
      }, { timeoutMs: 60_000 }));
    } catch (e) { return fail(c, e); }
  });

  // ── API: 历史列表 ──
  //
  // ⭐ 2026-09-22：以前直接列 captures 下的目录，同一视频采集多次就重复好几条
  //   （每次卡片采集开一个 p_<ts> 目录）。改按 canonical id 去重，保留最新一次，
  //   并把槽位名 + mtime 一并返回（卡片可以拿它去调 /intake/artifact 看产物）。
  app.get("/intake/history", async (c) => {
    try {
      const captures = path.join(dataDir, "captures");
      const items = [];
      if (fs.existsSync(captures)) {
        const dirs = fs.readdirSync(captures).filter(d => fs.statSync(path.join(captures, d)).isDirectory());
        for (const d of dirs) {
          const full = path.join(captures, d);
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
          try {
            const data = JSON.parse(fs.readFileSync(path.join(full, "result.json"), "utf-8"));
            items.push({
              id: d, slot: d, title: data.title || d, platform: data.platform || "?",
              url: data.url || "", date: data.date || d.slice(0, 10),
              type: data.platform === "bilibili" ? "video" : "note",
              artifactDir: data.outputDir || full, mtimeMs,
            });
          } catch {
            items.push({ id: d, slot: d, title: d, platform: "?", date: d.slice(0, 10), type: "unknown", artifactDir: full, mtimeMs });
          }
        }
      }
      const seen = new Map();
      for (const item of items) {
        const key = canonicalId(item.platform, item.url || item.slot);
        const prev = seen.get(key);
        if (!prev || (item.mtimeMs || 0) > (prev.mtimeMs || 0)) seen.set(key, item);
      }
      const deduped = [...seen.values()].sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0)).slice(0, 50);
      return c.json({ ok: true, total: deduped.length, raw: items.length, items: deduped });
    } catch (e) { return fail(c, e); }
  });

  // ── API: 配置读取 ──
  app.get("/intake/settings", async (c) => {
    try {
      const settingsPath = path.join(dataDir, "settings.json");
      let settings = {};
      if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      return c.json({ ok: true, settings });
    } catch (e) { return fail(c, e); }
  });

  // ── API: 配置保存 ──
  app.post("/intake/settings", async (c) => {
    try {
      const body = await c.req.json();
      fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify(body, null, 2), "utf-8");
      // 改设置立即生效：运行时/健康/cookies 三个缓存全部作废，下一请求重新解析。
      // 以前只有 60s TTL 兜底，改完 setting 要等一分钟才生效，像「改了没用」。
      invalidateRuntimeCache();
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });

  // ── API: 知识地图用哪个模型（复用宿主已配好的；**key 只到服务端为止**） ──
  app.get("/intake/llm/models", async (c) => {
    try {
      const { describeForUi } = await import("../lib/hana-llm.js");
      const settingsPath = path.join(dataDir, "settings.json");
      let saved = {};
      if (fs.existsSync(settingsPath)) saved = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const list = await describeForUi(ctx);
      return c.json({
        ok: list.ok,
        providers: list.providers,
        current: { providerId: saved.llmProvider || "", model: saved.llmModel || "" },
        busError: list.busError || "",
        detail: list.detail || "",
      });
    } catch (e) { return fail(c, e); }
  });

  // ── API: 试一下选中的模型能不能用（真实打一次，1 token） ──
  // ⭐ 走 python 而不是 JS fetch：① 与真实调用的 env 路径完全一致；
  //   ② App 自己的 fetch 受 manifest 的 network.allowedHosts 限制，python 不受。
  app.post("/intake/llm/test", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const settings = await getSettings(ctx);
      const { resolveLlmConfig } = await import("../lib/hana-llm.js");
      const { spawn } = await import("node:child_process");
      const { getVenvPython } = await import("../lib/runtime.js");

      const apiKey = settings.llmApiKey || "";
      let resolved = { ok: false };
      if (!apiKey) resolved = await resolveLlmConfig(ctx, { providerId: body?.providerId || settings.llmProvider, model: body?.model || settings.llmModel });
      const key = apiKey || (resolved.ok ? resolved.apiKey : "");
      const baseUrl = settings.llmBaseUrl || (resolved.ok ? resolved.baseUrl : "");
      const model = body?.model || settings.llmModel || (resolved.ok ? resolved.model : "");
      if (!key || !model) {
        return c.json({ ok: false, error: resolved.error || "no_model_selected", detail: resolved.detail || "没解析到可用的 key / 模型" });
      }

      const runtime = await runtimeFor(ctx);
      const code = [
        "import os, json, time, httpx",
        "t = time.time()",
        "r = httpx.post(os.environ['OPENAI_BASE_URL'].rstrip('/') + '/chat/completions',",
        "    headers={'Authorization': 'Bearer ' + os.environ['OPENAI_API_KEY'], 'content-type': 'application/json'},",
        "    json={'model': os.environ['OPENAI_MODEL'], 'messages': [{'role': 'user', 'content': 'ping'}], 'max_tokens': 1},",
        "    timeout=15)",
        "print(json.dumps({'status': r.status_code, 'ms': int((time.time() - t) * 1000), 'body': r.text[:200]}, ensure_ascii=False))",
      ].join("\n");

      const out = await new Promise((resolve) => {
        const child = spawn(getVenvPython(runtime), ["-c", code], {
          windowsHide: true,
          env: {
              ...process.env,
              OPENAI_API_KEY: key,
              OPENAI_BASE_URL: baseUrl || "https://api.openai.com/v1",
              OPENAI_MODEL: model,
              PYTHONUTF8: "1",
              PYTHONIOENCODING: "utf-8",
            },        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* 已退出 */ } }, 25000);
        child.stdout.on("data", (ch) => { stdout += String(ch); });
        child.stderr.on("data", (ch) => { stderr += String(ch); });
        child.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr }); });
        child.on("error", (e) => { clearTimeout(timer); resolve({ stdout: "", stderr: e.message }); });
      });

      let parsed = null;
      try { parsed = JSON.parse(String(out.stdout).trim().split("\n").pop()); } catch { /* 下面按失败处理 */ }
      if (!parsed) {
        return c.json({ ok: false, providerId: resolved.providerId || "", model, error: "python 调用失败", detail: String(out.stderr || out.stdout).trim().slice(-400) });
      }
      return c.json({
        ok: parsed.status >= 200 && parsed.status < 300,
        providerId: resolved.providerId || "(settings)",
        model,
        ms: parsed.ms,
        error: parsed.status >= 200 && parsed.status < 300 ? "" : `HTTP ${parsed.status}`,
        detail: parsed.status >= 200 && parsed.status < 300 ? "" : String(parsed.body || "").slice(0, 300),
      });
    } catch (e) { return fail(c, e); }
  });

  // ── API: 浏览器登录（点按钮 → 弹窗 → 扫码 → 自动存 cookie）──
  //
  // ⭐ 2026-11-21：之前的登录只有两条路——命令行 `--login <platform>`（同步阻塞到
  //   用户扫码完）和"粘贴 cookie"。卡片上没有一个能直接用的按钮。
  //   这里补上第三条：后台跑 python/browser_login.py，立刻返回，前端轮询状态。
  //
  // 为什么不在 HTTP 请求里等：扫码是人的动作，最长 180s，等在里面就是一次必超时的请求。
  const loginJobs = new Map();

  app.post("/intake/login/browser", async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch { body = {}; }
    const platform = String(body.platform || "").trim();
    if (!platform) return c.json({ ok: false, error: "缺少 platform" }, 400);

    const running = loginJobs.get(platform);
    if (running && running.status === "running") {
      return c.json({ ok: true, platform, status: "running", alreadyRunning: true });
    }

    const dataDir = ctx.dataDir || path.join(ctx.pluginDir, ".data");
    const cookiesDir = path.join(dataDir, "cookies");
    const stateDir = path.join(dataDir, "login-state");
    try { fs.mkdirSync(stateDir, { recursive: true }); } catch { /* 权限问题留到 spawn 报 */ }

    const timeout = Number(body.timeout) > 0 ? Math.min(Number(body.timeout), 600) : 180;

    let runtime;
    try { runtime = await runtimeFor(ctx); }
    catch (err) { return c.json({ ok: false, error: `Python 运行时不可用：${String(err?.message || err)}` }, 500); }

    const pythonExe = getVenvPython(runtime);
    const script = path.join(ctx.pluginDir, "python", "browser_login.py");
    if (!fs.existsSync(script)) return c.json({ ok: false, error: `缺失登录脚本：${script}` }, 500);

    const job = { platform, status: "running", startedAt: Date.now(), result: null, output: "" };
    loginJobs.set(platform, job);

    let child;
    try {
      child = spawn(pythonExe, [
        script, platform,
        "--cookies-dir", cookiesDir,
        "--state-dir", stateDir,
        "--timeout", String(timeout),
      ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      job.status = "failed";
      job.result = { ok: false, error: `无法启动登录进程：${String(err?.message || err)}` };
      return c.json({ ok: false, error: job.result.error }, 500);
    }

    const collect = (chunk) => { job.output = (job.output + String(chunk)).slice(-4000); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (err) => {
      job.status = "failed";
      job.result = { ok: false, error: `登录进程出错：${String(err?.message || err)}` };
    });
    child.on("close", (code) => {
      // 脚本最后一行是 JSON。只认能解析的最后一条，避免把中间日志误当结果。
      let parsed = null;
      for (const line of String(job.output).split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith("{") || !t.endsWith("}")) continue;
        try { parsed = JSON.parse(t); } catch { /* 不是 JSON 行，跳过 */ }
      }
      job.result = parsed || { ok: false, error: `登录进程退出（code=${code}），无结构化结果`, tail: job.output.slice(-600) };
      job.status = job.result.ok ? "ok" : "failed";
      cookiesCache = null; // 登录成功要立刻反映到 cookies 列表
    });

    return c.json({ ok: true, platform, status: "running", timeout });
  });

  app.get("/intake/login/status", async (c) => {
    const platform = String(c.req.query("platform") || "").trim();
    if (!platform) return c.json({ ok: false, error: "缺少 platform" }, 400);
    const job = loginJobs.get(platform);
    if (!job) return c.json({ ok: true, platform, status: "idle" });
    return c.json({
      ok: true,
      platform,
      status: job.status,
      elapsed: Math.round((Date.now() - job.startedAt) / 1000),
      result: job.result,
    });
  });

  // ── API: 系统浏览器登录（不依赖 playwright）──
  //
  // ⭐ 2026-11-21：playwright 那条路在 App 的 Python 子进程里起不来浏览器（卡片上
  //   实际报的就是 chromium 缺失）。而用户机器上 Chrome 就在那儿，且人已经登过了。
  //   所以换成两步：
  //     ① /intake/login/open   —— 命令行拉起系统默认浏览器，停在登录页
  //     ② /intake/login/extract —— 从浏览器的 cookie 库里直接解密重建
  //   没有任何自动化依赖：cookie 本来就是浏览器存在磁盘上的东西，我们有解密实现
  //   （python/cookies_store.py 的 DPAPI 路径，实测 Chrome 157 可用，bilibili 拿到 23 条）。
  //
  // 平台清单与登录地址一律问 Python（browser_login.py 无参输出 JSON），不在 Node 里再写一份。
  // ⭐ 2026-11-22：登录地址直接写在这里。
  //   之前为了“单一事实源”去起一个 Python 读 browser_login.py 的输出，
  //   代价是点一下要等一两秒才弹浏览器（用户看到的就是“打开中…”一直转）。
  //   为了七行常量起一个解释器，这是错的取舍。
  //   python/browser_login.py 的 LOGIN_TARGETS 仍是真相，这里只是快照；
  //   改那边时顺手改这里（两边都是七行，漂了一眼就能看出来）。
  const LOGIN_URLS = {
    bilibili: { name: "啤哩啤哩", url: "https://passport.bilibili.com/login" },
    xhs:      { name: "小红书",   url: "https://www.xiaohongshu.com/explore" },
    weibo:    { name: "微博",     url: "https://weibo.com/login.php" },
    zhihu:    { name: "知乎",     url: "https://www.zhihu.com/signin" },
    tieba:    { name: "百度贴吧", url: "https://tieba.baidu.com/" },
    kuaishou: { name: "快手",     url: "https://www.kuaishou.com/" },
    xiaoheihe:{ name: "小黑盒",   url: "https://www.xiaoheihe.cn/" },
  };

  let loginTargetsCache = null;
  const LOGIN_TARGETS_TTL_MS = 600_000;

  async function loginTargets(ctx) {
    const now = Date.now();
    if (loginTargetsCache && now - loginTargetsCache.at < LOGIN_TARGETS_TTL_MS) {
      return loginTargetsCache.value;
    }
    const runtime = await runtimeFor(ctx);
    const pythonExe = getVenvPython(runtime);
    const script = path.join(ctx.pluginDir, "python", "browser_login.py");
    const out = await runPythonCapture(pythonExe, [script], 20_000);
    const value = out && out.ok && out.targets ? out.targets : {};
    loginTargetsCache = { at: now, value };
    return value;
  }

  app.get("/intake/login/targets", async (c) => {
    try {
      const targets = await loginTargets(ctx);
      return c.json({ ok: true, targets });
    } catch (err) {
      return c.json({ ok: false, error: String(err?.message || err) }, 500);
    }
  });

  // ── API: 登录态的极速版（直读目录，不起 Python）──
  //
  // ⭐ 2026-11-22：/intake/cookies 要起一个 collector.py 跑 --list-logins。
  //   命令行里它只要 0.57 秒，但经过宿主路由 + 冷启动，面板上就是“检查中…”挂很久。
  //   而登录面板其实只需要两个字段：哪个平台、有没有 cookie 文件。
  //   目录一读就是毫秒级。
  app.get("/intake/logins-fast", async (c) => {
    const dataDir = ctx.dataDir || path.join(ctx.pluginDir, ".data");
    const dir = path.join(dataDir, "cookies");
    const logins = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        const platform = f.slice(0, -5);
        let count = 0;
        let capturedAt = "";
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
          count = Array.isArray(j.cookies) ? j.cookies.length : 0;
          capturedAt = j.captured_at || "";
        } catch { /* 文件坏了就当 0 条 */ }
        logins.push({ platform, logged_in: count > 0, cookies_count: count, captured_at: capturedAt });
      }
    } catch { /* 目录不存在 = 全部未登录 */ }
    return c.json({ ok: true, logins, _fast: true });
  });

  app.post("/intake/login/open", async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch { body = {}; }
    const platform = String(body.platform || "").trim();
    if (!platform) return c.json({ ok: false, error: "缺少 platform" }, 400);

    // 本地表直接查——不起 Python，不等网络
    const target = LOGIN_URLS[platform];
    if (!target || !target.url) return c.json({ ok: false, error: `未知平台：${platform}` }, 400);

    try {
      if (process.platform === "win32") {
        // start 第一个参数是窗口标题，必须留空，否则带 & 的 URL 会被拆成多个参数
        spawn("cmd.exe", ["/c", "start", "", target.url], {
          windowsVerbatimArguments: true, windowsHide: true, detached: true, stdio: "ignore",
        }).unref();
      } else if (process.platform === "darwin") {
        spawn("open", [target.url], { detached: true, stdio: "ignore" }).unref();
      } else {
        spawn("xdg-open", [target.url], { detached: true, stdio: "ignore" }).unref();
      }
    } catch (err) {
      return c.json({ ok: false, error: `打不开浏览器：${String(err?.message || err)}` }, 500);
    }

    return c.json({ ok: true, platform, url: target.url, name: target.name });
  });

  app.post("/intake/login/extract", async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch { body = {}; }
    const platform = String(body.platform || "").trim();
    const browser = String(body.browser || "auto").trim();
    if (!platform) return c.json({ ok: false, error: "缺少 platform" }, 400);

    const dataDir = ctx.dataDir || path.join(ctx.pluginDir, ".data");
    const cookiesDir = path.join(dataDir, "cookies");

    let out = null;
    try {
      // ⚠️ 超时必须低于宿主路由封顶（30s）——超了宿主会直接回纯文本
      //   `HTTP 500: Internal Server Error`，前端根本看不到真正的错误。
      out = await runJson(ctx, ["--extract-cookies", `${platform}:${browser}`, "--cookies-dir", cookiesDir],
        { label: "cookies-extract", timeoutMs: 20_000 });
    } catch (err) {
      return c.json({ ok: false, error: `提取失败：${String(err?.message || err)}` }, 200);
    }
    cookiesCache = null; // 提取成功要立刻反映到 cookies 列表

    if (out && out.ok) {
      return c.json({ ok: true, platform, browser, count: out.count || 0 });
    }
    // ⚠️ 失败也返回 200：让前端能拿到 JSON 里的 error 字段。
    //   之前返回 500，前端只能看到宿主包装后的纯文本。
    return c.json({
      ok: false,
      platform,
      browser,
      error: (out && out.error) || "没取到 cookie：浏览器里可能还没登录这个平台，或浏览器不是 " + browser,
      notes: (out && out.notes) || [],
    });
  });

  // ── API: Cookies 状态 ──
  // 起 Python 跑 --list-logins，实测 571ms。加 TTL 缓存，?refresh=1 强制重查。
  app.get("/intake/cookies", async (c) => {
    try {
      const force = c.req.query("refresh") === "1";
      const now = Date.now();
      if (!force && cookiesCache && now - cookiesCache.at < COOKIES_TTL_MS) {
        return c.json({ ...cookiesCache.body, _cached: true, _cachedAt: cookiesCache.at });
      }
      const cookiesDir = path.join(dataDir, "cookies");
      const body = await runJson(ctx, [
        "--list-logins", "--cookies-dir", cookiesDir,
      ], { label: "cookies-list", timeoutMs: 30_000 });
      cookiesCache = { at: now, body };
      return c.json({ ...body, _cached: false });
    } catch (e) { return fail(c, e); }
  });

  // ── API: Cookies 清除 ──
  app.post("/intake/cookies-logout", async (c) => {
    try {
      const body = await c.req.json();
      // ⚠️ 必须传 --cookies-dir：不传时 Python 的 CookieStore 落到源码目录，
      // 登出删的是错误位置，真登录态永远删不掉（e2e 实测抓到的）。
      await runJson(ctx, ["--logout", body.platform || "xhs", "--cookies-dir", path.join(dataDir, "cookies")], { label: "cookies-logout", timeoutMs: 30_000 });
      cookiesCache = null;
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });

  // ── API: 粘贴导入登录态（2026-10-11 补：UI 一直在调这条，后端一直缺这条）──
  //
  // 卡片的「粘贴 cookie」按钮发 POST /intake/login/import-cookies，期望 {ok, count, names}。
  // 后端从来没实现过这个路由 —— 点保存必 404。
  //
  // 设计：JS 直接写 <dataDir>/cookies/<platform>.json，不 spawn Python（快，且和
  // --list-logins 读的是同一个目录）。文件格式严格对齐 python/cookies_store.py 的
  // CookieBundle：条目只有七个 snake_case 字段（CookieEntry(**c) 遇未知键会崩）。
  // 三种输入都收：
  //   ① document.cookie 的整串（a=1; b=2）
  //   ② Cookie-Editor 导出的 JSON 数组（能带上 HttpOnly 条目，更完整）
  //   ③ 「复制备份」导出的整份 bundle JSON —— 恢复走同一个入口，备份闭环
  const COOKIE_ENTRY_KEYS = ["name", "value", "domain", "path", "expires", "http_only", "secure"];

  const normalizeEntry = (x) => ({
    name: String(x.name),
    value: String(x.value),
    domain: String(x.domain || ""),
    path: String(x.path || "/"),
    // Cookie-Editor 用 expirationDate（unix 秒，可能带小数），bundle 内部叫 expires
    expires: Math.max(0, Math.round(Number(x.expirationDate ?? x.expires ?? 0)) || 0),
    http_only: !!(x.http_only ?? x.httpOnly),
    secure: !!x.secure,
  });

  function parseCookieText(text) {
    const t = String(text || "").trim();
    if (!t) return [];
    if (t.startsWith("[") || t.startsWith("{")) {
      const obj = JSON.parse(t);
      const arr = Array.isArray(obj) ? obj : obj.cookies;
      if (!Array.isArray(arr)) throw new Error("JSON 里没有 cookies 数组");
      return arr.filter((x) => x && x.name && x.value != null).map(normalizeEntry);
    }
    return t
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const i = pair.indexOf("=");
        if (i <= 0) return null;
        return normalizeEntry({ name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() });
      })
      .filter(Boolean);
  }

  function localStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
      + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  app.post("/intake/login/import-cookies", async (c) => {
    try {
      const body = await c.req.json();
      const platform = String(body.platform || "").trim();
      if (!platform || !/^[A-Za-z0-9_-]+$/.test(platform)) {
        return c.json({ ok: false, error: "platform 名不合法" }, 400);
      }
      let entries;
      try {
        entries = parseCookieText(body.text);
      } catch (e) {
        return c.json({ ok: false, error: "解析失败：" + (e?.message || e) }, 400);
      }
      if (!entries.length) {
        return c.json({ ok: false, error: "没能从输入里解析出任何 cookie" }, 400);
      }
      for (const e of entries) {
        for (const k of Object.keys(e)) {
          if (!COOKIE_ENTRY_KEYS.includes(k)) delete e[k];
        }
      }
      const cookiesDir = path.join(dataDir, "cookies");
      fs.mkdirSync(cookiesDir, { recursive: true });
      const file = path.join(cookiesDir, platform + ".json");
      // 保留旧文件里的 headers / user（粘贴导入通常不带这些；换 cookie 不该换 UA 指纹）
      let headers = {};
      let user = {};
      try {
        const old = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (old && typeof old === "object") {
          if (old.headers && typeof old.headers === "object") headers = old.headers;
          if (old.user && typeof old.user === "object") user = old.user;
        }
      } catch { /* 没有旧文件或损坏：从零开始 */ }
      const bundle = {
        platform,
        cookies: entries,
        headers,
        user,
        captured_at: localStamp(),
        source: "manual-paste",
        expires_at: "",
      };
      fs.writeFileSync(file, JSON.stringify(bundle, null, 2), "utf-8");
      cookiesCache = null;   // 登录态变了，下一轮 /intake/cookies 重查
      return c.json({
        ok: true,
        action: "import",
        platform,
        count: entries.length,
        names: entries.map((e) => e.name),
      });
    } catch (e) { return fail(c, e); }
  });

  // ── API: 导出登录态备份 ──
  // 把某平台整份 bundle JSON 吐给卡片（前端复制到剪贴板存文件）。
  // 恢复 = 原样粘回 /intake/login/import-cookies，同一个入口闭环。
  // 边界：platform 正则校验（无路径分隔符），只读 cookies 目录内的文件。
  app.get("/intake/cookies-export", async (c) => {
    try {
      const platform = c.req.query("platform") || "";
      if (!/^[A-Za-z0-9_-]+$/.test(platform)) {
        return c.json({ ok: false, error: "platform 名不合法" }, 400);
      }
      const file = path.join(dataDir, "cookies", platform + ".json");
      if (!fs.existsSync(file)) {
        return c.json({ ok: false, error: "该平台还没有登录态" }, 404);
      }
      return c.json({ ok: true, platform, text: fs.readFileSync(file, "utf-8") });
    } catch (e) { return fail(c, e); }
  });

  // ── API: 记录（采集/总结过的内容）──
  //
  // ⭐ v0.6.16：卡片是**展示面**，不是抓取器。
  //   iframe 拿不到 Bearer token（宿主把 token 放在 scoped UI 路径里，
  //   卡片 JS 从 location.pathname 取出来放 X-Hana-App-Surface-Session 头，
  //   这条链路已实测 200）——所以卡片能读能写，但重活（音频+Whisper）
  //   仍然走模型工具。这里存的是「结果」：标题、作者、总结文本、标签。
  //
  // 三种写入方式：
  //   1. POST /intake/fetch 带 saveRecord:true —— 采集完自动落一条元数据
  //   2. POST /intake/record  —— 手动补/更新总结（按 id upsert）
  //   3. 模型工具侧采集后，agent 调 POST /intake/record 补总结
  // ⭐ 2026-09-22：记录的读写实现已抽到 lib/records.js（卡片侧与模型工具侧共用）。
  //   这里不再自己实现 canonicalId / findRec —— 两处各写一份 = id 规则必然漂移，
  //   而漂移的后果就是同一视频长出两条记录。
  //   readRecords / writeRecords / upsertRecord / listRecords / patchFromResult 均从那边导入。

  app.get("/intake/records", (c) => {
    try {
      const limit = Math.max(1, Math.min(200, parseInt(c.req.query("limit") || "100", 10)));
      // ⭐ 2026-09-26：带 rev 时先比版本 —— 版本没变就不读盘、不出列表，只回一句 unchanged。
      //   卡片每 15 秒轮询一次，正常情况下的每一轮都从这里返回（几十字节）。
      const rev = c.req.query("rev") || "";
      const stamp = recordsStamp(ctx);
      if (rev && rev === stamp) return c.json({ ok: true, unchanged: true, rev: stamp });
      // ⭐ 2026-09-22：以前是 all.slice(-limit).reverse()（按**插入顺序**取最后 N 条）。
      //   补写总结走的是 upsert（原地更新、createdAt 保留），所以刚补完总结的记录
      //   既不上浮、显示时间也还是旧的 —— 卡片看起来就是"没同步"。
      //   改按 updatedAt（缺失时退回 createdAt）倒序。
      const { total, items } = listRecords(ctx, limit);
      return c.json({ ok: true, total, items, rev: stamp });
    } catch (e) { return fail(c, e); }
  });

  app.post("/intake/record", async (c) => {
    try {
      const body = await c.req.json();
      if (!body.title && !body.source) return c.json({ ok: false, error: "需要 title 或 source" }, 400);
      // 走共享 upsert：空值不覆盖已有字段（尤其不覆盖手写总结），刷新 updatedAt。
      const { record } = upsertRecord(ctx, {
        id: body.id,
        platform: body.platform || "bilibili",
        source: body.source || "",
        title: body.title || "",
        author: body.author || "",
        durationSec: Number(body.durationSec) > 0 ? Number(body.durationSec) : 0,
        summary: body.summary || "",
        tags: Array.isArray(body.tags) ? body.tags.slice(0, 16) : [],
      });
      return c.json({ ok: true, record });
    } catch (e) { return fail(c, e); }
  });

  // ⭐ W3（2026-09-26）：删除不再只删记录 —— **记录与本地产物一起删**。
  //   规则见 lib/purge.js：直接删；只有「已总结」的槽位把总结后产生的文件
  //   （summary.json / summary.md / summary-history）先挪进 captures/.trash/。
  //   二次确认在卡片侧做（确认条），这里只负责执行。
  app.delete("/intake/record/:id", (c) => {
    try {
      const id = c.req.param("id");
      const r = purgeRecords(ctx, [id], { capturesDir: path.join(dataDir, "captures") });
      if (!r.deleted) {
        return c.json({ ok: false, error: r.items[0]?.error || "删除失败", detail: r }, 404);
      }
      return c.json({ ok: true, ...r });
    } catch (e) { return fail(c, e); }
  });

  // ⭐ W3：批量删除。body: { ids: [...] }
  app.post("/intake/records/purge", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      if (!ids.length) return c.json({ ok: false, error: "ids 不能为空" }, 400);
      const r = purgeRecords(ctx, ids, { capturesDir: path.join(dataDir, "captures") });
      return c.json({ ok: true, ...r });
    } catch (e) { return fail(c, e); }
  });

  // ⭐ W3：缓冲查看 / 清空 —— 删「已总结」的槽位时留下的总结文件在这里。
  app.get("/intake/trash", (c) => {
    try { return c.json({ ok: true, ...listTrash(path.join(dataDir, "captures")) }); }
    catch (e) { return fail(c, e); }
  });

  app.post("/intake/trash/empty", (c) => {
    try { return c.json({ ok: true, ...emptyTrash(path.join(dataDir, "captures")) }); }
    catch (e) { return fail(c, e); }
  });

  // ── API: 从 captures 回填记录（2026-09-22）──
  //
  // 背景：0.6.26 及以前，只有卡片侧的采集会写 records.json，模型工具侧一个字都不写。
  // 于是会出现「历史里有、记录是 0」——captures/ 里躺着一堆产物，records.json 是空的。
  // 这个接口扫 captures/*/result.json 建记录（按 canonical id 去重，同一视频收敛成一条，
  // 保留最新产物目录）。只补不改：已有总结的记录不会被覆盖。
  app.post("/intake/records/backfill", (c) => {
    try {
      // 实现抽到 lib/records.js（App 启动时也会跑一次，见 index.js）——
      // 两处共用一份，避免「卡片点一次」与「启动回填」两套逻辑各走各的。
      const capturesDir = path.join(dataDir, "captures");
      const stats = backfillFromCaptures(ctx, capturesDir);
      // ⭐ W4：顺带跑一次摘要对账（把「有 summary.json、记录里却空着」的补上）。
      const summaries = reconcileSummaries(ctx, capturesDir);
      return c.json({ ok: true, ...stats, summaries });
    } catch (e) { return fail(c, e); }
  });

  // ⭐ 2026-09-26：扫码登录。
  //   以前只能从命令行 `--login xhs` 做，卡片里没有入口 —— 而小红书**没有 cookies 就取不到内容**。
  //   登录态与登出走已有的 /intake/cookies 与 /intake/cookies-logout（它们已经正确传了
  //   --cookies-dir），这里只补上缺的那一条，不重复造。
  //
  //   ⚠️ cookies 必须落到 <dataDir>/cookies：不带 --cookies-dir 时 Python 那边会落到**源码目录**
  //   （实测 --list-logins 回的 cookies_dir 是 apps/bilibili-intake-v2/python）。
  //   ⚠️ 扫码是交互动作：playwright_login 会**弹出真实 Chromium 窗口**，所以给 200 秒超时。
  //   即使外层把请求提早断了也不丢：cookies 是子进程自己落盘的。
        
          
// ── API: 读回采集产物（2026-09-22）──
  //
  // 回答的就是那个疑虑：「总结之后文件到底有没有保留、能不能读回来」。
  // 传记录里的 artifactDir（或 captures 下的槽位名），返回文件清单 + 正文分页。
  // 安全边界：只允许读 <dataDir>/captures 之内的目录（防目录穿越）。
  app.get("/intake/artifact", async (c) => {
    try {
      const root = path.resolve(path.join(dataDir, "captures"));
      const slot = c.req.query("slot") || "";
      const raw = c.req.query("dir") || "";
      const target = path.resolve(slot ? path.join(root, slot) : raw);
      if (target !== root && !target.startsWith(root + path.sep)) {
        return c.json({ ok: false, error: "只允许读 captures 目录内的产物" }, 400);
      }
      if (!fs.existsSync(target)) return c.json({ ok: false, error: "目录不存在: " + target }, 404);
      // ⭐ 2026-09-26：传 file 时直接吐单个文件的内容（卡片「报告」弹窗要内嵌 report.html）。
      //   边界与上面同一套：必须落在 captures 之内（防目录穿越）。
      const wantFile = c.req.query("file") || "";
      if (wantFile) {
        const fp = path.resolve(path.join(target, wantFile));
        if (fp !== root && !fp.startsWith(root + path.sep)) {
          return c.json({ ok: false, error: "只允许读 captures 内的文件" }, 400);
        }
        if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
          return c.json({ ok: false, error: "文件不存在: " + wantFile }, 404);
        }
        const body = fs.readFileSync(fp, "utf-8");
        return c.json({ ok: true, file: wantFile, size: Buffer.byteLength(body), isHtml: /\.html?$/i.test(fp), content: body });
      }

      const files = [];
      for (const name of fs.readdirSync(target)) {
        try {
          const st = fs.statSync(path.join(target, name));
          files.push({ name, size: st.size, dir: st.isDirectory(), mtime: st.mtime.toISOString() });
        } catch { /* 跳过不可读项 */ }
      }
      files.sort((a, b) => (b.size || 0) - (a.size || 0));
      const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10));
      const limit = Math.max(0, Math.min(20000, parseInt(c.req.query("limit") || "2000", 10)));
      const textFile = path.join(target, "text.txt");
      let text = null;
      if (fs.existsSync(textFile)) {
        const full = fs.readFileSync(textFile, "utf-8");
        text = {
          total: full.length,
          offset,
          chars: full.slice(offset, offset + limit),
          nextOffset: offset + limit < full.length ? offset + limit : null,
        };
      }
      // ⭐ P1：有 artifact.json 就一并带回（kind / anchorKind / 资源清单），
      //   调用方不用自己猜这堆文件是什么。
      let artifact = null;
      const artifactFile = path.join(target, "artifact.json");
      if (fs.existsSync(artifactFile)) {
        try { artifact = JSON.parse(fs.readFileSync(artifactFile, "utf-8")); } catch { artifact = null; }
      }
      // ⭐ P2：结构化摘要与回指校验统计一并带回（summary.json 由 intake_summary 工具落盘）
      let summary = null;
      const summaryFile = path.join(target, "summary.json");
      if (fs.existsSync(summaryFile)) {
        try { summary = JSON.parse(fs.readFileSync(summaryFile, "utf-8")); } catch { summary = null; }
      }
      return c.json({ ok: true, dir: target, files, artifact, summary, text });
    } catch (e) { return fail(c, e); }
  });

  // ── API: 日志 ──
  app.get("/intake/logs", async (c) => {
    try {
      const logDir = path.join(dataDir, "logs");
      let logs = [];
      if (fs.existsSync(logDir)) {
        const files = fs.readdirSync(logDir).filter(f => f.endsWith(".log")).sort().slice(-20);
        for (const f of files) {
          try { logs.push({ file: f, content: fs.readFileSync(path.join(logDir, f), "utf-8").slice(-2000) }); } catch {}
        }
      }
      return c.json({ ok: true, logs });
    } catch (e) { return fail(c, e); }
  });

  // ── API: 前端错误遥测（2026-10-11）──
  // 卡片 iframe 的 console 错误外面看不到 —— 白屏排查曾只能靠猜。
  // 前端 window.onerror/unhandledrejection 把错误 POST 到这里，落盘 ui-error.log，
  // agent 读文件即可定位。限流在前端做（同错误只报一次）。
  app.post("/intake/ui-error", async (c) => {
    try {
      const b = await c.req.json().catch(() => ({}));
      const line = JSON.stringify({
        at: new Date().toISOString(),
        type: String(b.type || "error").slice(0, 40),
        message: String(b.message || "").slice(0, 500),
        stack: String(b.stack || "").slice(0, 2000),
        url: String(b.url || "").slice(0, 300),
      }) + "\n";
      const logDir = path.join(dataDir, "logs");
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, "ui-error.log"), line, "utf-8");
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });
}

function fallbackPage(name) {
  return `<!doctype html><html><body data-hana-theme="light" data-surface="page" style="background:#F4F3F0;color:#1E1D1C;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><h2>${name}</h2><p style="color:#9E9B97;font-size:13px;margin-top:8px">页面文件未加载</p></body></html>`;
}
