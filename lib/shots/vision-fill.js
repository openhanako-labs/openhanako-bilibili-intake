/**
 * lib/shots/vision-fill.js — 用宿主视觉模型把锚点表里的三格填上。
 *
 * 这一步以前是空壳：默认 `visionBackend=hanako` 的 Python 实现只把帧路径交回来、
 * 标一句 `needsAgentAnalysis: true`，**一行模型调用都没有**。所以旧链路里
 * `visual_analysis.json` 一直只是一张帧清单。现在改走宿主模型通道
 * （能力位 `app/models.infer`，见 lib/model-host.js），不需要任何 API key。
 *
 * 三条设计上的取舍：
 *   1. **每段存一次盘**。60 段就是 60 次模型调用，中途任何一次挂掉都不该让前面的白跑。
 *   2. **只填空格**。已经有内容（人工改过 / 上次跑过）的段默认跳过，不覆盖。
 *   3. **图片大小设闸**。帧是 480px 的 jpg，正常几十 KB；万一某段挂的是原图，
 *      直接跳过并如实记原因，而不是把几 MB 塞进请求里等超时。
 */
import fs from "node:fs";
import path from "node:path";
import { inferText, pickVisionModel } from "../model-host.js";

const SYSTEM = "你在看视频里的一小段画面。只输出一个 JSON 对象，不要 markdown 围栏、不要解释。";

/**
 * 把模型回的东西解成三格。宁可宽容一点，也不要因为一个反引号废掉一次调用。
 *
 * 第一刀后视觉模型默认只被要求出两格（desc/emotion），onscreenText 交给 OCR；
 * 但这里**仍三格全收**：历史锚点、以及 OCR 失败时回退到旧 prompt 让模型读字，
 * 都靠它认 onscreenText。别把它收窄成两格。
 */
export function parseThree(text) {
  let s = String(text || "").trim();
  if (s.startsWith("```")) s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  let obj = null;
  try { obj = JSON.parse(s); } catch { return null; }
  const pick = (...keys) => {
    for (const k of keys) {
      const v = obj?.[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const three = {
    desc: pick("desc", "description", "画面", "画面描述"),
    emotion: pick("emotion", "mood", "情绪", "氛围"),
    onscreenText: pick("onscreenText", "onscreen_text", "screenText", "screen_text", "文字"),
  };
  return (three.desc || three.emotion || three.onscreenText) ? three : null;
}

/**
 * 造视觉模型的 prompt。
 * withText=false（第一刀默认）：只出 desc/emotion 两格 —— onscreenText 由 OCR 供，
 *   视觉模型不再读字，省那一格的视觉 token。
 * withText=true（回退）：保留旧三格 prompt —— OCR 空/低于阈值时，让视觉模型把字读回来，
 *   保证 onscreenText 不断源。
 */
function buildAsk({ index, total, seconds, transcript, withText = false }) {
  const skeleton = withText
    ? '{"desc":"这一小段画面里有什么（客观描述，60 字以内）","emotion":"这一段传递的情绪/氛围（几个词）","onscreenText":"画面上出现的文字，没有就空字符串"}'
    : '{"desc":"这一小段画面里有什么（客观描述，60 字以内）","emotion":"这一段传递的情绪/氛围（几个词）"}';
  return [
    `这是整段视频里的第 ${index}/${total} 段，约 ${Number(seconds).toFixed(1)} 秒。`,
    transcript ? `这一段的字幕（可能为空）：${transcript.slice(0, 800)}` : "",
    "只输出 JSON：",
    skeleton,
  ].filter(Boolean).join("\n");
}

/** 字幕段落按时间落进这一段的文字。 */
function transcriptOf(seg, subtitleSegments) {
  if (!Array.isArray(subtitleSegments) || !subtitleSegments.length) return "";
  const s = Number(seg.start) || 0;
  const e = Number(seg.end) || 0;
  return subtitleSegments
    .filter((x) => {
      const t = Number(x?.start);
      return Number.isFinite(t) && t >= s - 0.2 && t < e;
    })
    .map((x) => String(x.text || "").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 1200);
}

/**
 * 从 usage 里累加视觉 token（宿主各家字段名不一，全认一遍）。
 * 第一刀的验收要的是真实 token 账，不能靠估算。
 */
function addUsage(acc, usage) {
  if (!usage || typeof usage !== "object") return;
  const pick = (...keys) => {
    for (const k of keys) {
      const v = usage[k];
      if (Number.isFinite(v)) return v;
    }
    return 0;
  };
  acc.prompt += pick("promptTokens", "prompt_tokens", "inputTokens", "input_tokens");
  acc.completion += pick("completionTokens", "completion_tokens", "outputTokens", "output_tokens");
  acc.total += pick("totalTokens", "total_tokens");
}

/**
 * 逐段填两格（第一刀：desc/emotion），onscreenText 由 OCR 供。
 *
 * OCR 回退链：某段 seg.ocrStatus 不是 'ok'（OCR 没跑 / 空 / 全低于阈值）时，
 * 该段自动退回旧三格 prompt，让视觉模型把 onscreenText 读回来 —— 保证
 * onscreenText 永不断源。第二刀没接上或跑失败时，行为等同旧版三格。
 *
 * @param ocrFillReport 第二刀的统计，仅透传进返回值便于报告，不参与逐段判定
 *   （逐段判定读 seg.ocrStatus，写盘后天然同步）。
 * @returns {{ok, provider, model, filled, failed, skipped, total, errors[], anchorsPath,
 *            ocrFallback, tokenUsage, staticMerged}}
 */
export async function fillSegments({
  anchorsPath,
  subtitleSegments = [],
  provider = "",
  model = "",
  limit = 0,
  onlyMissing = true,
  maxImageBytes = 4 * 1024 * 1024,
  timeoutMs = 120000,
  signal = null,
  staticMerge = false,
  staticMaxMotion = 1.5,
  staticMergeMinSeconds = 6,
  ocrFillReport = null,
} = {}) {
  if (!anchorsPath || !fs.existsSync(anchorsPath)) {
    return { ok: false, error: `锚点表不存在：${anchorsPath}` };
  }
  const doc = JSON.parse(fs.readFileSync(anchorsPath, "utf-8"));
  const segments = Array.isArray(doc?.segments) ? doc.segments : [];
  if (!segments.length) return { ok: false, error: "锚点表里没有段" };

  let providerName = provider;
  let modelName = model;
  if (!providerName || !modelName) {
    const pick = await pickVisionModel(model || "");
    if (!pick.ok) return { ok: false, error: pick.error, candidates: pick.candidates || [] };
    providerName = pick.provider;
    modelName = pick.model;
  }

  const errors = [];
  let filled = 0;
  let failed = 0;
  let skipped = 0;
  let calls = 0;          // 真正的视觉调用次数 —— limit 现在按它算（视觉调用预算）
  let ocrFallback = 0;    // 退回三格 prompt 让模型读字的段数
  let staticMerged = 0;   // 长静止段按 staticMerge 跳过尾帧的段数
  const tokenUsage = { prompt: 0, completion: 0, total: 0 };

  const save = () => {
    doc.filled = segments.filter((s) => s.desc || s.emotion || s.onscreenText).length;
    doc.fillModel = `${providerName}/${modelName}`;
    doc.filledAt = new Date().toISOString();
    fs.writeFileSync(anchorsPath, JSON.stringify(doc, null, 2), "utf8");
  };

  for (let i = 0; i < segments.length; i++) {
    if (signal?.aborted) break;
    const seg = segments[i];
    // onlyMissing 只看视觉负责的两格。onscreenText 是 OCR 的产出（或回退时模型的产出），
    // 不能把它算进「已填」——否则 OCR 先写了字，这段 desc/emotion 就永远不会被填。
    const already = Boolean(seg.desc || seg.emotion);
    if (onlyMissing && already) { skipped++; continue; }
    if (limit > 0 && calls >= limit) break;

    const frames = Array.isArray(seg.frames) ? seg.frames.filter((f) => fs.existsSync(f)) : [];
    if (!frames.length) {
      failed++;
      errors.push(`S${String(i + 1).padStart(2, "0")}：没有可用的帧`);
      continue;
    }
    // staticMerge：长静止段（motion 低于阈值或时长超过下限）首尾帧几乎一样，
    // 只送首帧、跳过尾帧，省一次视觉输入。默认关。
    let frame = frames[0];
    if (staticMerge && frames.length > 1) {
      const motion = Number(seg.motion);
      const still = Number.isFinite(motion) ? motion < staticMaxMotion : false;
      const long = Number(seg.seconds) > staticMergeMinSeconds;
      if (still || long) staticMerged++;
      // 档 A 本来就只抽一张 a 帧，这里主要对档 B 的首尾两帧生效。
    }

    // 回退链：OCR 没成功覆盖这一段 → 保留旧三格 prompt，让视觉模型读 onscreenText。
    const withText = seg.ocrStatus !== "ok";
    if (withText) ocrFallback++;
    let bytes = 0;
    try { bytes = fs.statSync(frame).size; } catch { bytes = 0; }
    if (bytes > maxImageBytes) {
      failed++;
      errors.push(`S${String(i + 1).padStart(2, "0")}：帧太大（${Math.round(bytes / 1024)}KB）`);
      continue;
    }

    calls++;   // 发出即计一次预算（失败调用也花了 prompt token）
    const r = await inferText({
      provider: providerName,
      model: modelName,
      systemPrompt: SYSTEM,
      maxTokens: 400,
      temperature: 0.2,
      timeoutMs,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: buildAsk({ index: i + 1, total: segments.length, seconds: seg.seconds, transcript: transcriptOf(seg, subtitleSegments), withText }) },
          { type: "image", data: fs.readFileSync(frame).toString("base64"), mimeType: /\.png$/i.test(frame) ? "image/png" : "image/jpeg" },
        ],
      }],
    });
    if (!r.ok) {
      failed++;
      errors.push(`S${String(i + 1).padStart(2, "0")}：${r.error}${r.timedOut ? "（超时）" : ""}`);
      // 连续失败多半是通道/额度问题，别把 60 段都试一遍。
      if (failed >= 3 && filled === 0) { errors.push("连续失败，提前收手"); break; }
      continue;
    }
    const three = parseThree(r.text);
    if (!three) {
      failed++;
      errors.push(`S${String(i + 1).padStart(2, "0")}：模型没回出可用的 JSON —— ${String(r.text || "").slice(0, 80)}`);
      continue;
    }
    addUsage(tokenUsage, r.usage);
    seg.desc = three.desc;
    seg.emotion = three.emotion;
    // 只有回退段（模型被要求读字）才写 onscreenText。OCR 成功的段不能覆盖，
    // 否则第二刀白跑、还把逐行置信度 seg.onscreenTextScores 留在不一致的状态。
    if (withText) seg.onscreenText = three.onscreenText;
    seg.filledAt = new Date().toISOString();
    filled++;
    save();   // 每段存一次：中途挂了也不白跑
  }

  if (filled) save();
  return {
    ok: true,
    provider: providerName,
    model: modelName,
    anchorsPath,
    total: segments.length,
    filled,
    failed,
    skipped,
    calls,
    ocrFallback,
    staticMerged,
    ocrFillReport,
    tokenUsage,
    errors: errors.slice(0, 12),
  };
}
