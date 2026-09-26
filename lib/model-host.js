/**
 * lib/model-host.js — 宿主模型通道（能力位 `app/models.infer`）。
 *
 * 为什么要有它：画面描述那三格（desc / 情绪 / 屏幕文字）得有人"看"。
 * 默认的 `visionBackend=hanako` 是把帧交回给智能体（Python 那份实现里
 * `needsAgentAnalysis: true`，一行模型调用都没有）；要让 App 自己看图，
 * 就得走宿主这条通道 —— 它不需要任何 API key。
 *
 * 做法照搬图库（hanako-gallery/lib/model-host.mjs，那条路已经过验证）：
 *   • `ctx.models.stream(...)` 流式返回，用宿主给的 `readAppModelStream` 解码，
 *     别自己 split("\n")（UTF-8 分片与终止校验都在那个解码器里）。
 *   • **超时必须自己设**：宿主模型层挂住时一个事件都不会回来，没有上限就是无限转圈。
 *     超时后必须 cancel，否则宿主那边可能一直挂着那次请求。
 *   • 宿主的模型标识符规则是 `^[A-Za-z0-9._:-]{1,128}$` —— 不吃斜杠，
 *     所以 `agnes/agnes-3.0-flash` 要拆成 provider=agnes、model=agnes-3.0-flash。
 */
import { readAppModelStream } from "../sdk/app-contract/model-stream.js";

let _ctx = null;

/** index.js 装载时转一手 —— 模块级拿不到 ctx。 */
export function bindModels(ctx) {
  _ctx = ctx || null;
}

export function modelsAvailable() {
  return Boolean(_ctx?.models?.stream);
}

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** `agnes/agnes-3.0-flash` → {provider:"agnes", model:"agnes-3.0-flash"}。 */
export function splitModelRef(ref) {
  const s = String(ref || "").trim();
  const i = s.indexOf("/");
  if (i < 0) return { provider: "", model: s };
  return { provider: s.slice(0, i), model: s.slice(i + 1) };
}

export function isSendable({ provider, model } = {}) {
  return ID_RE.test(String(provider || "")) && ID_RE.test(String(model || ""));
}

/** 宿主给了哪些模型。 */
export async function listModels() {
  if (!modelsAvailable()) {
    return { ok: false, error: "宿主没有提供模型能力（app/models.infer 未授权或宿主版本不支持）" };
  }
  try {
    const r = await _ctx.models.list();
    return { ok: true, models: Array.isArray(r?.models) ? r.models : [] };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** 这一条认不认图片。字段名各版本不一，宽松认几个常见的写法。 */
export function acceptsImage(info) {
  if (!info || typeof info !== "object") return false;
  const inputs = info.input ?? info.inputs ?? info.modalities ?? info.capabilities;
  if (Array.isArray(inputs)) return inputs.some((x) => String(x).toLowerCase().includes("image"));
  if (typeof inputs === "string") return inputs.toLowerCase().includes("image");
  return false;
}

/** 从模型目录里挑一条能看图的（优先用调用方给的名字）。 */
export async function pickVisionModel(prefer = "") {
  const r = await listModels();
  if (!r.ok) return { ok: false, error: r.error };
  const models = r.models;

  // ⚠️ 先归一化成 provider/model 再筛：provider 可能是**中文名**（实测有「新疆幻城」），
  //   而宿主的标识符规则只吃 [A-Za-z0-9._:-] —— 这种条目根本发不出去，
  //   要跳过它继续找，不能在第一条上就报错退出。
  const cands = models.map((m) => {
    const ref = m.provider && m.id ? { provider: m.provider, model: m.id } : splitModelRef(m.name || m.id || "");
    return { provider: ref.provider, model: ref.model, info: m, ref: `${ref.provider}/${ref.model}` };
  });
  const sendable = cands.filter((c) => isSendable(c));

  if (prefer) {
    const hit = cands.find((c) => c.ref === prefer || c.model === prefer || c.info?.name === prefer);
    if (hit && isSendable(hit)) return { ok: true, provider: hit.provider, model: hit.model, info: hit.info };
    return {
      ok: false,
      error: hit
        ? `指定的模型不合宿主标识符规则：${hit.ref}`
        : `模型目录里没有 ${prefer}`,
      candidates: sendable.map((c) => c.ref),
    };
  }

  const vision = sendable.filter((c) => acceptsImage(c.info));
  if (!vision.length) {
    return {
      ok: false,
      error: `没有「能看图 + 标识符合规」的模型（目录共 ${models.length} 条，合规 ${sendable.length} 条）`,
      candidates: sendable.map((c) => c.ref),
    };
  }
  // agnes 是图库那边实测最快最准的一条，优先。
  const pick = vision.find((c) => /agnes/i.test(c.provider)) || vision[0];
  return {
    ok: true,
    provider: pick.provider,
    model: pick.model,
    info: pick.info,
    candidates: vision.map((c) => c.ref),
  };
}

/**
 * 跑一次流式推理，把全文收起来返回。
 * @returns {{ok: boolean, text?: string, usage?: any, error?: string, timedOut?: boolean, requestId?: string}}
 */
export async function inferText({
  provider, model, messages, systemPrompt, maxTokens, temperature, timeoutMs = 120000,
} = {}) {
  if (!modelsAvailable()) {
    return { ok: false, error: "宿主没有提供模型能力（app/models.infer 未授权）" };
  }
  if (!isSendable({ provider, model })) {
    return { ok: false, error: `provider/model 不满足宿主标识符要求：${provider} / ${model}` };
  }

  const requestId = `intake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let timer = null;
  let text = "";
  let usage = null;
  let streamError = null;

  try {
    const response = await Promise.race([
      _ctx.models.stream({ requestId, provider, model, messages, systemPrompt, maxTokens, temperature }),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`模型 ${Math.round(timeoutMs / 1000)}s 内没有响应`)), timeoutMs);
      }),
    ]);
    for await (const ev of readAppModelStream(response)) {
      if (ev?.type === "text-delta") text += ev.delta || "";
      else if (ev?.type === "error") streamError = ev;
      else if (ev?.type === "done") usage = ev.usage ?? null;
    }
  } catch (e) {
    const msg = String(e?.message || e);
    try { await _ctx.models.cancel(requestId); } catch { /* 取消失败不掩盖原错误 */ }
    return { ok: false, error: msg, timedOut: /内没有响应/.test(msg), requestId };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (streamError) {
    return {
      ok: false,
      error: `${streamError.code || "stream-error"}: ${streamError.message || ""}`.trim(),
      requestId,
    };
  }
  return { ok: true, text, usage, requestId };
}
