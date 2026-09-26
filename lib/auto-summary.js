/**
 * lib/auto-summary.js — 采集完成后**自动**写一份结构化总结。
 *
 * 为什么要有它：以前总结要么等助手调 intake_summary 工具、要么等用户手点。
 * 用户的原话是「要自动」。
 *
 * 形态（有意选择的）：
 *   · 走**宿主模型通道**（app/models.infer，早已授权）——不新增任何权限；
 *   · **不往用户对话里插消息**：不需要会话地址，也不需要用户在场；
 *   · 产物与工具侧**完全同源**：summary.json / summary.md + 记录回写，
 *     复用 lib/summary.js 的 buildSummary / writeSummary / patchFromSummary，
 *     以及 lib/records.js 的 upsertRecord —— 两条路写出来的东西形状一样。
 *
 * 失败永远不影响采集：调用方拿到 {ok:false, error} 就够，采集回执照出。
 */
import fs from "node:fs";
import path from "node:path";
import { buildSummary, patchFromSummary, writeSummary } from "./summary.js";
import { patchFromResult, readRecords, sameDirPath, upsertRecord } from "./records.js";
import { ensureAnchorIndex } from "./artifacts.js";
import { bindModels, inferText, isSendable, listModels, modelsAvailable, splitModelRef } from "./model-host.js";

const MAX_LINES = 90;          // 正文摘要最多带几段（成本闸门）
const MAX_CHARS = 14000;       // 再多就截断
const MAX_POINTS = 10;

const SYSTEM = [
  "你是内容总结助手。输入是一份视频/文章的正文摘要（每行前面的方括号是时间或小节号）。",
  "输出「一句话摘要 + 要点列表」。",
  "· brief：一句话说清这是什么内容（30~60 字，具体，不要“本视频介绍了…”这种空话）。",
  "· points：4~10 条事实性要点，按正文顺序，每条 20~60 字，不要评价、不要建议。",
  "· 每条要点可以带 at 表示出处：视频写 mm:ss（必须**逐字取自**输入里出现过的时间），文章写 \"§N\"。",
  "  宁可不写 at —— 系统会按文本相似度自动回指；**编造时间戳是不可接受的**。",
  "只输出 JSON，不要解释、不要 ``` 代码块：",
  '{"brief":"…","points":[{"text":"…","at":"01:23"}]}',
].join("\n");

function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** 正文摘要：优先用 anchors（带时间/小节），退化到 text.txt。 */
function buildDigest(slotDir, index) {
  const lines = [];
  try {
    if (index && Array.isArray(index.segments) && index.segments.length) {
      for (const seg of index.segments.slice(0, MAX_LINES)) {
        const t = String(seg.text || seg.title || "").replace(/\s+/g, " ").trim();
        if (t) lines.push(`[${fmtClock(seg.start ?? seg.startSec ?? 0)}] ${t}`);
      }
    } else if (index && Array.isArray(index.sections) && index.sections.length) {
      index.sections.slice(0, MAX_LINES).forEach((sec, i) => {
        const t = String(sec.text || sec.title || "").replace(/\s+/g, " ").trim();
        if (t) lines.push(`[§${i + 1}] ${t}`);
      });
    }
  } catch { /* 索引坏了就走下面的兜底 */ }

  if (!lines.length) {
    for (const name of ["text.txt", "transcript.txt", "content.txt"]) {
      try {
        const p = path.join(slotDir, name);
        if (!fs.existsSync(p)) continue;
        const raw = fs.readFileSync(p, "utf8").replace(/\s+/g, " ").trim();
        if (raw) { lines.push(raw.slice(0, MAX_CHARS)); break; }
      } catch { /* 试下一个 */ }
    }
  }
  return lines.join("\n").slice(0, MAX_CHARS);
}

/** 从模型目录里挑一条**能发出去**的聊天模型（provider 可能是中文名，要跳过）。 */
async function pickChatModel(prefer = "") {
  const r = await listModels();
  if (!r.ok) return { ok: false, error: r.error };
  const cands = r.models.map((m) => {
    const ref = m.provider && m.id ? { provider: m.provider, model: m.id } : splitModelRef(m.name || m.id || "");
    return { provider: ref.provider, model: ref.model, info: m, ref: `${ref.provider}/${ref.model}` };
  });
  const sendable = cands.filter((c) => isSendable(c));
  if (!sendable.length) {
    return { ok: false, error: `模型目录里没有标识符合规的条目（共 ${r.models.length} 条）` };
  }
  if (prefer) {
    const hit = sendable.find((c) => c.ref === prefer || c.model === prefer || c.info?.name === prefer);
    if (hit) return { ok: true, provider: hit.provider, model: hit.model };
    return { ok: false, error: `指定的模型不合规或不在目录里：${prefer}` };
  }
  const pick = sendable.find((c) => /agnes/i.test(c.provider)) || sendable[0];
  return { ok: true, provider: pick.provider, model: pick.model };
}

/** 从模型输出里抠出 JSON（容忍代码块、前后废话）。 */
function parseModelJson(text) {
  const raw = String(text || "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(body.slice(start, end + 1));
    if (!obj || typeof obj !== "object") return null;
    const brief = String(obj.brief || obj.oneLine || "").trim();
    const points = (Array.isArray(obj.points) ? obj.points : [])
      .map((p) => ({
        text: String((p && (p.text ?? p.point)) || "").trim(),
        ...(p && p.at ? { at: String(p.at).trim() } : {}),
      }))
      .filter((p) => p.text)
      .slice(0, MAX_POINTS);
    if (!brief && !points.length) return null;
    return { brief, points };
  } catch {
    return null;
  }
}

/**
 * 自动写总结。永远不抛。
 * @returns {{ok:boolean, skipped?:boolean, reason?:string, error?:string, recordId?:string, counts?:object}}
 */
export async function autoSummarize(ctx, { slotDir = "", model = "" } = {}) {
  try {
    if (!slotDir) return { ok: false, skipped: true, reason: "没有产物目录" };
    if (!modelsAvailable()) return { ok: false, skipped: true, reason: "宿主没有提供模型能力（app/models.infer）" };
    try { bindModels(ctx); } catch { /* 已绑过就算了 */ }

    const artifact = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(slotDir, "artifact.json"), "utf8")); } catch { return {}; }
    })();
    const index = ensureAnchorIndex(slotDir, artifact || {});
    const digest = buildDigest(slotDir, index);
    if (!digest) return { ok: false, skipped: true, reason: "没有可用正文（既没锚点也没 text.txt）" };

    const picked = await pickChatModel(model);
    if (!picked.ok) return { ok: false, error: picked.error };

    const title = String(artifact.title || artifact.source || "").trim();
    const res = await inferText({
      provider: picked.provider,
      model: picked.model,
      systemPrompt: SYSTEM,
      messages: [{
        role: "user",
        content: `${title ? `标题：${title}\n\n` : ""}正文：\n${digest}`,
      }],
      maxTokens: 1600,
      temperature: 0.2,
      timeoutMs: 180000,
    });
    if (!res?.ok || !res.text) {
      return { ok: false, error: res?.error || "模型没有返回正文" };
    }

    const parsed = parseModelJson(res.text);
    if (!parsed) {
      return { ok: false, error: "模型输出不是可解析的 JSON", raw: String(res.text).slice(0, 300) };
    }

    // 与工具侧同源：buildSummary 会跑回指校验
    const summary = buildSummary({
      recordId: "",
      artifact,
      brief: parsed.brief,
      points: parsed.points,
      model: `${picked.provider}/${picked.model}`,
      promptVersion: "auto-1",
      index,
    });
    writeSummary(slotDir, summary);

    // 回写记录：先按目录找，找不到就用 result.json 现造一条（与 intake_summary 一致）
    let record = readRecords(ctx).find((r) => sameDirPath(r.artifactDir, slotDir)) || null;
    let recordId = record?.id || "";
    if (!recordId) {
      try {
        const result = (() => {
          try { return JSON.parse(fs.readFileSync(path.join(slotDir, "result.json"), "utf8")); } catch { return {}; }
        })();
        const { record: created } = upsertRecord(ctx, patchFromResult(
          { ...result, outputDir: slotDir },
          { artifactDir: slotDir, source: result.url || result.bvid || path.basename(slotDir) },
        ));
        recordId = created.id;
        summary.recordId = recordId;
        try { writeSummary(slotDir, summary, { keepHistory: false }); } catch { /* 补归属失败不影响 */ }
      } catch { /* 造记录失败就只留摘要 */ }
    }
    if (recordId) {
      try { upsertRecord(ctx, patchFromSummary(summary, { slotDir, recordId })); } catch { /* 回写失败下次对账会补 */ }
    }

    return {
      ok: true,
      recordId,
      model: `${picked.provider}/${picked.model}`,
      counts: summary.counts,
      brief: summary.brief,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
