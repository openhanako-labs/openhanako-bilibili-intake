/**
 * lib/summary.js — 结构化摘要 + 可回指校验（P2，2026-09-22）。
 *
 * ⭐ 要解决的问题：今天的总结层没有"对不对"这个概念。
 *   模型读完正文写一段话，谁也不知道那句话是从正文哪一段来的 —— 编了也看不出来。
 *   这里给它一个可验证的形状：
 *
 *     摘要 = brief（卡片一句话）+ points[]（要点）
 *     每个 point 必须能回指到锚点（视频=秒区间 / 文章文档=小节字符区间）
 *
 *   回指有两种来源：
 *     · 显式 —— 模型自己写了 `at`（"12:30" / "§3" / "第 3 节"），我们解析成锚点；
 *     · 隐式 —— 没写 at 时，用**逐字最长公共子串**把要点文本对到最像的锚点段上，
 *               给一个 score，低于阈值就当“回指不到”，记为未验证。
 *               （试过 n-gram 重叠率，会被“可以/总结”这类常用词骗过去 —— 已换成逐字比对）
 *
 *   校验结果会落盘（summary.json + summary.md），并回写到记录字段上，
 *   卡片一眼能看到"要点 N 个 / 未回指 M 个"。
 *
 * 设计原则：**不阻断**。校验失败不拒绝保存，只如实记录 —— 它是仪表盘，不是门卫。
 */
import fs from "node:fs";
import path from "node:path";

export const SUMMARY_SPEC = "1.0";
export const ANCHORS_SPEC = "1.0";

/** 打包时最多保留多少条锚点（够回指了，别把产物撑爆）。 */
export const MAX_ANCHORS = 6000;
/** 隐式回指的分数阈值。*/
export const GROUND_SCORE = 0.5;

export function anchorsPath(slotDir) { return path.join(slotDir, "anchors.json"); }
export function summaryPath(slotDir) { return path.join(slotDir, "summary.json"); }
export function summaryMarkdownPath(slotDir) { return path.join(slotDir, "summary.md"); }
export function summaryHistoryDir(slotDir) { return path.join(slotDir, "summary-history"); }

/* ────────────────────────── 锚点索引 ────────────────────────── */

/** 写 anchors.json（锚点本体，artifact.json 只存统计）。失败返回 null，不抛。 */
export function writeAnchors(slotDir, { kind, source, durationSec, segments, sections } = {}) {
  try {
    if (!slotDir) return null;
    const doc = {
      spec: ANCHORS_SPEC,
      kind: kind || "none",
      source: source || "",
      durationSec: Number(durationSec) || 0,
      generatedAt: new Date().toISOString(),
      segments: (kind === "time" ? (segments || []) : []).slice(0, MAX_ANCHORS),
      sections: (kind === "section" ? (sections || []) : []).slice(0, MAX_ANCHORS),
    };
    if (doc.kind === "time") doc.count = doc.segments.length;
    else if (doc.kind === "section") doc.count = doc.sections.length;
    else doc.count = 0;
    if (doc.count === 0) return null;
    fs.mkdirSync(slotDir, { recursive: true });
    fs.writeFileSync(anchorsPath(slotDir), JSON.stringify(doc, null, 2), "utf-8");
    return doc;
  } catch { return null; }
}

export function readAnchors(slotDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(anchorsPath(slotDir), "utf-8"));
    return doc && typeof doc === "object" ? doc : null;
  } catch { return null; }
}

/* ────────────────────────── 回指 ────────────────────────── */

/** "12:30" / "1:02:03" / "750" → 秒；不认就返回 null。 */
export function parseTimestamp(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/.exec(s);
  if (clock) {
    const [, h, m, sec] = clock;
    return Number(h || 0) * 3600 + Number(m) * 60 + Number(sec);
  }
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return null;
}

/** 去掉空白与标点，便于做逐字比对。 */
function cleanText(text) {
  return String(text || "").replace(/[\s\p{P}\p{S}]/gu, "");
}

/**
 * 最长公共子串（逐字）。为什么不用 n-gram 重叠率：
 *   实测中“本 App 已对接 OpenAI Realtime API…“这种凭空写的要点，
 *   靠“可以/总结/实时”这类常用词的二字组也能跟某一节撞到 0.54 —— 被判成“有出处”。
 *   逐字最长公共串要求**有一整段逐字相同的话**，对中文的判断力强得多：
 *   真出处的要点通常带着 10 字以上的原文片段，编的要点凑不出 8 个字。
 */
function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  if (a.length > b.length) { const t = a; a = b; b = t; }
  const prev = new Int32Array(a.length + 1);
  const cur = new Int32Array(a.length + 1);
  let best = 0;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      cur[i] = a[i - 1] === b[j - 1] ? prev[i - 1] + 1 : 0;
      if (cur[i] > best) best = cur[i];
    }
    prev.set(cur);
    cur.fill(0);
  }
  return best;
}

/** 回指分数 = 最长公共子串 / min(要点长度, 16)；短要点不被稀释。 */
function matchScore(pointText, targetText) {
  const p = cleanText(pointText);
  if (!p) return { score: 0, lcs: 0 };
  const denom = Math.max(6, Math.min(p.length, 16));
  const lcs = longestCommonSubstring(p, cleanText(targetText));
  return { score: Math.min(1, lcs / denom), lcs };
}

/** "§3" / "第3节" / "3" → 0 基下标；不认就返回 null。 */
export function parseSectionRef(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = /(?:§|第)?\s*(\d+)\s*(?:节|段|部分)?/.exec(s);
  return m ? Math.max(0, Number(m[1]) - 1) : null;
}

/**
 * 把一个要点对到锚点上。
 * @returns {{anchor: object|null, match: "explicit"|"explicit-invalid"|"keyword"|null, score: number, reason: string}}
 */
export function resolvePoint(point = {}, index) {
  const text = String(point.text || "").trim();
  const at = point.at === undefined || point.at === null ? "" : String(point.at).trim();
  if (!index) {
    return { anchor: null, match: null, score: 0, reason: "锚点索引不可用：产物里既没有转写段落也没有正文" };
  }
  if (!index.kind || index.kind === "none") {
    return { anchor: null, match: null, score: 0, reason: "该素材没有锚点（anchorKind=none）" };
  }

  if (at) {
    if (index.kind === "time") {
      const sec = parseTimestamp(at);
      if (sec === null) return { anchor: null, match: "explicit-invalid", score: 0, reason: `at="${at}" 解析不出时间` };
      if (index.durationSec && sec > index.durationSec + 1) {
        return { anchor: null, match: "explicit-invalid", score: 0, reason: `at=${at} 超出全长 ${index.durationSec}s` };
      }
      const seg = index.segments.find(s => sec >= s.start - 1 && sec <= s.end + 1) || null;
      // 落在缝隙里就取最近的一段（时间轴常有空档，别因为 1 秒的缝判它没出处）
      const nearest = seg || index.segments.reduce((best, s) => {
        const d = Math.min(Math.abs(s.start - sec), Math.abs(s.end - sec));
        return !best || d < best.d ? { s, d } : best;
      }, null);
      const picked = seg || (nearest && nearest.d <= 5 ? nearest.s : null);
      if (!picked) return { anchor: null, match: "explicit-invalid", score: 0, reason: `at=${at} 附近没有字幕段` };
      return {
        anchor: { kind: "time", start: picked.start, end: picked.end, label: fmtClock(picked.start) },
        match: "explicit",
        score: 1,
        reason: seg ? "" : "时间点落在字幕空档，取最近段",
      };
    }
    // section
    const idx = parseSectionRef(at);
    if (idx === null || idx >= index.sections.length) {
      return { anchor: null, match: "explicit-invalid", score: 0, reason: `at="${at}" 不是有效小节` };
    }
    const sec = index.sections[idx];
    return {
      anchor: { kind: "section", index: idx, label: sec.label || `§${idx + 1}`, start: sec.start, end: sec.end },
      match: "explicit",
      score: 1,
      reason: "",
    };
  }

  // 隐式：拿要点文本去对逐字最像的一段
  const pool = index.kind === "time"
    ? index.segments.map((s, i) => ({ i, text: s.text, anchor: { kind: "time", start: s.start, end: s.end, label: fmtClock(s.start) } }))
    : index.sections.map((s, i) => ({ i, text: s.text, anchor: { kind: "section", index: i, label: s.label || `§${i + 1}`, start: s.start, end: s.end } }));
  let best = null;
  for (const cand of pool) {
    const { score, lcs } = matchScore(text, cand.text);
    if (!best || score > best.score) best = { score, lcs, anchor: cand.anchor };
    if (score >= 1) break;
  }
  if (!best || best.score < GROUND_SCORE) {
    return {
      anchor: null,
      match: null,
      score: best ? Number(best.score.toFixed(3)) : 0,
      reason: best && best.lcs
        ? `在锚点里找不到逐字相同的出处（最长同串仅 ${best.lcs} 字）—— 请显式给 at`
        : "在锚点里找不到逐字相同的出处 —— 请显式给 at",
    };
  }
  return { anchor: best.anchor, match: "keyword", score: Number(best.score.toFixed(3)), reason: "" };
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * 校验一份摘要的要点。
 * @returns {{spec, points: Array, counts: {total, grounded, ungrounded, explicit, keyword}, ok: boolean}}
 */
export function validatePoints(points = [], index) {
  const out = [];
  for (const p of Array.isArray(points) ? points : []) {
    const text = String(p?.text || "").trim();
    if (!text) continue;
    const r = resolvePoint({ text, at: p.at }, index);
    out.push({ text, at: p.at || null, anchor: r.anchor, match: r.match, score: r.score, reason: r.reason, verified: Boolean(r.anchor) });
  }
  const counts = {
    total: out.length,
    grounded: out.filter(p => p.verified).length,
    ungrounded: out.filter(p => !p.verified).length,
    explicit: out.filter(p => p.match === "explicit").length,
    keyword: out.filter(p => p.match === "keyword").length,
  };
  return { spec: SUMMARY_SPEC, points: out, counts, ok: counts.total > 0 && counts.ungrounded === 0 };
}

/* ────────────────────────── 落盘与读回 ────────────────────────── */

export function buildSummary({ recordId, artifact, brief, points, model, promptVersion, index } = {}) {
  const validation = validatePoints(points, index);
  return {
    spec: SUMMARY_SPEC,
    recordId: recordId || "",
    kind: artifact?.kind || "unknown",
    anchorKind: artifact?.anchorKind || "none",
    generatedAt: new Date().toISOString(),
    model: model || "",
    promptVersion: promptVersion || "",
    brief: String(brief || "").trim(),
    counts: validation.counts,
    briefGrounded: Boolean(validation.counts.total),
    points: validation.points,
  };
}

export function writeSummary(slotDir, summary, { keepHistory = true } = {}) {
  try {
    if (!slotDir) return null;
    fs.mkdirSync(slotDir, { recursive: true });
    const file = summaryPath(slotDir);
    if (keepHistory && fs.existsSync(file)) {
      try {
        const dir = summaryHistoryDir(slotDir);
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.copyFileSync(file, path.join(dir, `summary-${stamp}.json`));
      } catch { /* 历史留档失败不影响主流程 */ }
    }
    fs.writeFileSync(file, JSON.stringify(summary, null, 2), "utf-8");
    fs.writeFileSync(summaryMarkdownPath(slotDir), renderSummaryMarkdown(summary), "utf-8");
    return summary;
  } catch { return null; }
}

export function readSummary(slotDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(summaryPath(slotDir), "utf-8"));
    return doc && typeof doc === "object" ? doc : null;
  } catch { return null; }
}

/** 给人看的一份：未回指的要点明确标出来。 */
export function renderSummaryMarkdown(summary = {}) {
  const lines = [];
  if (summary.brief) lines.push(summary.brief, "");
  const counts = summary.counts || {};
  lines.push(`> 要点 ${counts.total || 0} 个 · 可回指 ${counts.grounded || 0} 个 · 未回指 ${counts.ungrounded || 0} 个（显式 ${counts.explicit || 0} / 关键词 ${counts.keyword || 0}）`);
  lines.push("");
  for (const p of summary.points || []) {
    const where = p.verified
      ? (p.anchor?.kind === "time" ? `→ ${p.anchor.label}-${fmtClock(p.anchor.end)}` : `→ §${(p.anchor?.index ?? 0) + 1}${p.anchor?.label ? "" : ""}`)
      : "→ ⚠️ 回指不到";
    lines.push(`- ${p.text}  ${where}${p.verified && p.match === "keyword" ? `（自动匹配 ${p.score}）` : ""}`);
    if (!p.verified && p.reason) lines.push(`  <sub>${p.reason}</sub>`);
  }
  lines.push("", `<sub>spec ${summary.spec || SUMMARY_SPEC}${summary.model ? ` · ${summary.model}` : ""}${summary.promptVersion ? ` · prompt ${summary.promptVersion}` : ""} · ${summary.generatedAt || ""}</sub>`);
  return lines.join("\n");
}
