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
import { getSettings } from "../lib/settings.js";
import { prepareRuntime, runCollector, runCollectorArgs } from "../lib/runtime.js";
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
  return JSON.parse(String(stdout).trim());
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
      //   为什么是后台跑（不 await）：宿主对 App 路由有 30s 封顶，而模型一次要几十秒 ——
      //   等它就会把「采集成功」变成「请求超时」。后台跑完，卡片 15s 轮询自然就把总结显示出来。
      //   关掉它：设置 summaryAuto = false。
      if (body.autoSummary !== false && mode !== "batch" && result?.title) {
        try {
          const { getSettings } = await import("../lib/settings.js");
          const settings = await getSettings(ctx);
          if (settings.summaryAuto) {
            const { autoSummarize } = await import("../lib/auto-summary.js");
            const slotDir = result.outputDir || outputDir;
            result.autoSummary = { pending: true };
            void autoSummarize(ctx, { slotDir })
              .then((r) => {
                ctx.log?.info?.(`自动总结${r?.ok ? "完成" : "未完成"}：${slotDir}`
                  + (r?.ok ? `（要点 ${r.counts?.total ?? 0} 个 · 回指 ${r.counts?.grounded ?? 0}）` : `（${r?.reason || r?.error || "未知原因"}）`));
              })
              .catch((e) => ctx.log?.warn?.("自动总结异常", { error: e?.message || String(e) }));
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
      await runJson(ctx, ["--logout", body.platform || "xhs"], { label: "cookies-logout", timeoutMs: 30_000 });
      return c.json({ ok: true });
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
}

function fallbackPage(name) {
  return `<!doctype html><html><body data-hana-theme="light" data-surface="page" style="background:#F4F3F0;color:#1E1D1C;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><h2>${name}</h2><p style="color:#9E9B97;font-size:13px;margin-top:8px">页面文件未加载</p></body></html>`;
}
