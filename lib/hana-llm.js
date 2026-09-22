/**
 * lib/hana-llm.js — 复用 Hanako 宿主已配好的模型（2026-09-22）。
 *
 * ⭐ 为什么要有这个：知识地图要调 LLM，但 App 给子进程的 env 是白名单，
 *   宿主里配的 key 到不了 python（同类坑还有 PYTHONUTF8）。而 App 的 fs 也被限在
 *   安装目录 + app-data 里，读不到 ~/.hanako/models.json。
 *
 *   唯一稳的路径是宿主自己在进程里告诉 App：
 *     ctx.bus.request("provider:models-by-type", {type:"chat"})  → 有哪些聊天模型
 *     ctx.bus.request("provider:credentials", {providerId})      → 该供应商的 baseUrl + apiKey
 *
 *   于是这里的职责是：把"用户已经配好的模型"解析成 {baseUrl, apiKey, model}，
 *   再由调用方（工具/路由）传给 Python。**key 只在服务端流转，永不回前端。**
 *
 * 实现参照 hanako-mail/backend/hana-llm.mjs（同一宿主 API，已在跑的 App）。
 * 全部函数不抛：拿不到就返回 ok:false + 原因，让上层给人话。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 协议归一：目前只区分 OpenAI 兼容与 Anthropic messages 两种（Python 侧支持这俩）。 */
export function normalizeApi(api) {
  const v = String(api || "openai-completions").toLowerCase();
  if (v.startsWith("anthropic")) return "anthropic-messages";
  if (v.includes("codex")) return "unsupported";
  return "openai-completions";
}

/** 明显不是聊天模型的 id（向量/重排/图片/语音）—— 列给用户时过滤，选默认时也要跳过。
 *  实测教训：默认取了 siliconflow 的 BAAI/bge-m3（向量模型），/chat/completions 直接 400。 */
const NOT_CHAT = /embed|bge\b|bge-|rerank|image|video|audio|whisper|tts|speech|vision-ocr/i;

/**
 * 列出宿主里已配置的聊天模型（按供应商分组）。
 * @returns {Promise<{ok:boolean, providers:Array, error?:string, detail?:string}>}
 */
export async function listChatModels(ctx) {
  if (!ctx?.bus?.request) return { ok: false, error: "hana_bus_unavailable", providers: [] };
  try {
    const result = await ctx.bus.request("provider:models-by-type", { type: "chat" });
    const models = Array.isArray(result?.models) ? result.models : [];
    const providers = new Map();
    for (const m of models) {
      const providerId = String(m?.provider || "").trim();
      const modelId = String(m?.id || "").trim();
      if (!providerId || !modelId) continue;
      if (NOT_CHAT.test(modelId)) continue;
      if (!providers.has(providerId)) providers.set(providerId, { models: [], modelMeta: {} });
      const entry = providers.get(providerId);
      if (!entry.models.includes(modelId)) entry.models.push(modelId);
      entry.modelMeta[modelId] = { reasoning: !!m?.reasoning };
    }
    return {
      ok: true,
      providers: [...providers.entries()].map(([id, { models, modelMeta }]) => ({ id, models, modelMeta })),
    };
  } catch (error) {
    return { ok: false, error: "provider_list_failed", detail: error?.message || String(error), providers: [] };
  }
}

/** 挑模型：显式 provider+model → 只给 model 就反查 → 默认第一个可用供应商的首个模型。 */
export function selectChatModel(providers, requestedProviderId, requestedModel) {
  const available = Array.isArray(providers) ? providers : [];
  const pid = String(requestedProviderId || "").trim();
  const mid = String(requestedModel || "").trim();
  if (pid && mid) {
    const p = available.find(it => it.id === pid);
    if (p && !p.models?.includes(mid)) return { ok: false, error: "llm_model_not_available" };
    return { ok: true, providerId: pid, model: mid, reasoning: !!p?.modelMeta?.[mid]?.reasoning };
  }
  let provider = pid ? available.find(it => it.id === pid) : null;
  if (!provider && mid) provider = available.find(it => it.models?.includes(mid));
  if (pid && !provider) return { ok: false, error: "llm_provider_not_configured" };
  if (!provider) provider = available[0];
  if (!provider) return { ok: false, error: "llm_provider_not_configured" };
  const model = mid || provider.models?.[0];
  if (!model) return { ok: false, error: "llm_model_not_available" };
  return { ok: true, providerId: provider.id, model, reasoning: !!provider.modelMeta?.[model]?.reasoning };
}

/**
 * 兜底：直接读宿主全局供应商目录（明文 key）。
 * ⚠️ App 的 fs 被限在安装目录 + app-data 里，这个读**很可能直接 EACCES/ENOENT** ——
 *    所以它只是"能读到就用"的加分项，绝不作为主路径。进程内缓存。
 */
let _catalogCache;
export function getProviderCatalog() {
  if (_catalogCache !== undefined) return _catalogCache;
  try {
    const home = process.env.HANAKO_HOME || path.join(os.homedir(), ".hanako");
    const parsed = JSON.parse(fs.readFileSync(path.join(home, "provider-catalog.json"), "utf-8"));
    _catalogCache = parsed && typeof parsed.providers === "object" ? parsed.providers : {};
  } catch {
    _catalogCache = {};
  }
  return _catalogCache;
}

function findCatalogProvider(providerId) {
  const catalog = getProviderCatalog();
  if (!providerId) return null;
  if (catalog[providerId]) return { id: providerId, ...catalog[providerId] };
  const lower = String(providerId).toLowerCase();
  for (const [pid, p] of Object.entries(catalog)) {
    if (pid.toLowerCase() === lower) return { id: pid, ...p };
  }
  return null;
}

/** 某供应商的真实凭据：宿主 bus 优先，provider-catalog.json 兜底。 */
export async function getProviderCredentials(ctx, providerId) {
  if (ctx?.bus?.request) {
    try {
      const cred = await ctx.bus.request("provider:credentials", { providerId });
      if (cred && !cred.error && cred.apiKey && cred.baseUrl) {
        return { ok: true, baseUrl: cred.baseUrl, apiKey: cred.apiKey, api: normalizeApi(cred.api) };
      }
    } catch { /* 落兜底 */ }
  }
  const p = findCatalogProvider(providerId);
  if (p && p.base_url && p.api_key) {
    return { ok: true, baseUrl: p.base_url, apiKey: p.api_key, api: normalizeApi(p.api) };
  }
  return { ok: false, error: "provider_credentials_missing" };
}

/**
 * 解析成可直接用的配置。
 * @param {object} ctx
 * @param {{providerId?:string, model?:string}} requested 用户选的那一项
 * @returns {Promise<{ok:boolean, providerId?, model?, baseUrl?, apiKey?, api?, error?, detail?}>}
 */
export async function resolveLlmConfig(ctx, requested = {}) {
  // ① 用户明确点了某个供应商：catalog 命中就直接信它（不依赖 ctx.bus，最稳）
  if (requested.providerId) {
    const p = findCatalogProvider(requested.providerId);
    if (p && p.base_url && p.api_key) {
      const models = Array.isArray(p.models) ? p.models : [];
      // 默认模型也要跳过向量/图片类（catalog 不区分类型）
      const ids = models
        .map(m => (typeof m === "object" ? m.id : String(m)))
        .filter(m => m && !NOT_CHAT.test(m));
      const model = requested.model || ids[0] || "";
      if (model) {
        return { ok: true, providerId: requested.providerId, model, baseUrl: p.base_url, apiKey: p.api_key, api: normalizeApi(p.api) };
      }
    }
  }
  // ② 走宿主 bus
  const list = await listChatModels(ctx);
  if (!list.ok) return { ok: false, error: list.error, detail: list.detail };
  const sel = selectChatModel(list.providers, requested.providerId, requested.model);
  if (!sel.ok) return { ok: false, error: sel.error };
  const cred = await getProviderCredentials(ctx, sel.providerId);
  if (!cred.ok) return { ok: false, error: cred.error, detail: cred.detail };
  return { ok: true, providerId: sel.providerId, model: sel.model, baseUrl: cred.baseUrl, apiKey: cred.apiKey, api: cred.api };
}

/** 给前端看的清单：只有 id / 模型名 / 打字，**不含任何 key**。 */
export async function describeForUi(ctx) {
  const list = await listChatModels(ctx);
  const catalog = getProviderCatalog();
  const providers = (list.ok ? list.providers : []).map(p => ({
    id: p.id,
    models: p.models,
    reasoning: Object.entries(p.modelMeta || {}).filter(([, v]) => v?.reasoning).map(([k]) => k),
  }));
  // bus 不可用时，catalog 里有模型的供应商也列出来（至少让用户能选）。
  // ⚠️ catalog 的 models 不区分类型，向量/图片/视频模型也会在里面 —— 过滤掉明显不是聊天的，
  //    并打上 fallback 标记，让界面能诚实地告知“这不是权威清单”。
  if (!providers.length) {
    for (const [id, p] of Object.entries(catalog)) {
      const models = (Array.isArray(p.models) ? p.models : [])
        .map(m => (typeof m === "object" ? m.id : String(m)))
        .filter(m => m && !NOT_CHAT.test(m));
      if (models.length) providers.push({ id, models, reasoning: [], fallback: true });
    }
  }
  return {
    ok: list.ok || providers.length > 0,
    providers,
    fallback: providers.some(p => p.fallback),
    busError: list.ok ? "" : list.error,
    detail: list.detail || "",
  };
}

/** 发一个最小请求验证可用性（真实打一次，超时 15s）。 */
export async function testLlm(ctx, requested = {}) {
  const cfg = await resolveLlmConfig(ctx, requested);
  if (!cfg.ok) return { ok: false, error: cfg.error, detail: cfg.detail || "" };
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(String(cfg.baseUrl).replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - started;
    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      return { ok: false, providerId: cfg.providerId, model: cfg.model, ms, error: `HTTP ${resp.status}`, detail: text.slice(0, 300) };
    }
    return { ok: true, providerId: cfg.providerId, model: cfg.model, ms, api: cfg.api };
  } catch (e) {
    return {
      ok: false,
      providerId: cfg.providerId,
      model: cfg.model,
      ms: Date.now() - started,
      error: e?.name === "AbortError" ? "timeout" : (e?.message || String(e)),
    };
  }
}
