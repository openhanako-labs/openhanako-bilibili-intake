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

/** 把模型回的东西解成三格。宁可宽容一点，也不要因为一个反引号废掉一次调用。 */
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

function buildAsk({ index, total, seconds, transcript }) {
  return [
    `这是整段视频里的第 ${index}/${total} 段，约 ${Number(seconds).toFixed(1)} 秒。`,
    transcript ? `这一段的字幕（可能为空）：${transcript.slice(0, 800)}` : "",
    "只输出 JSON：",
    '{"desc":"这一小段画面里有什么（客观描述，60 字以内）","emotion":"这一段传递的情绪/氛围（几个词）","onscreenText":"画面上出现的文字，没有就空字符串"}',
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
 * 逐段填三格。
 * @returns {{ok, provider, model, filled, failed, skipped, total, errors[], anchorsPath}}
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

  const save = () => {
    doc.filled = segments.filter((s) => s.desc || s.emotion || s.onscreenText).length;
    doc.fillModel = `${providerName}/${modelName}`;
    doc.filledAt = new Date().toISOString();
    fs.writeFileSync(anchorsPath, JSON.stringify(doc, null, 2), "utf8");
  };

  for (let i = 0; i < segments.length; i++) {
    if (signal?.aborted) break;
    const seg = segments[i];
    const already = Boolean(seg.desc || seg.emotion || seg.onscreenText);
    if (onlyMissing && already) { skipped++; continue; }
    if (limit > 0 && filled >= limit) break;

    const frames = Array.isArray(seg.frames) ? seg.frames.filter((f) => fs.existsSync(f)) : [];
    if (!frames.length) {
      failed++;
      errors.push(`S${String(i + 1).padStart(2, "0")}：没有可用的帧`);
      continue;
    }
    const frame = frames[0];
    let bytes = 0;
    try { bytes = fs.statSync(frame).size; } catch { bytes = 0; }
    if (bytes > maxImageBytes) {
      failed++;
      errors.push(`S${String(i + 1).padStart(2, "0")}：帧太大（${Math.round(bytes / 1024)}KB）`);
      continue;
    }

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
          { type: "text", text: buildAsk({ index: i + 1, total: segments.length, seconds: seg.seconds, transcript: transcriptOf(seg, subtitleSegments) }) },
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
    seg.desc = three.desc;
    seg.emotion = three.emotion;
    seg.onscreenText = three.onscreenText;
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
    errors: errors.slice(0, 12),
  };
}
