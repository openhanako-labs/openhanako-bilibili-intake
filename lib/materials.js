/**
 * lib/materials.js — 把"已总结素材"喂给知识地图（P3，2026-09-22）。
 *
 * ⭐ 问题：`generate_knowledge_map` 以前只拿到标题与简介 —— 视频里到底讲了什么，
 *   一个字都没进 prompt，地图基本靠标题猜。而直接塞全文同样不对：
 *   知识地图不需要原文，它需要**已经被读过一遍、并且标了出处的结论**。
 *
 * 优先级（正是这个顺序，不重读全文）：
 *   1. summary  —— summary.json：一句话 + 带出处的要点（未通过回指校验的要点不进 digest）
 *   2. anchors  —— 没摘要时退到锚点段落：视频=带时间戳的段落，文章/文档=小节
 *   3. metadata —— 只有标题简介时老实承认
 *   4. full     —— 显式要求才给全文开头（默认不用）
 *
 * 每个素材都会带上 `digestSource`，地图是从什么长出来的有据可查。
 */
import fs from "node:fs";
import path from "node:path";
import { fmtTimestamp } from "./anchors.js";
import { ensureAnchorIndex } from "./artifacts.js";

export const MATERIAL_SOURCES = ["summary", "anchors", "metadata", "full"];
/** digest 的长度上限 —— 是摘要不是文献，别把 prompt 撑爆。 */
export const DIGEST_MAX_CHARS = 6000;
const FULL_MAX_CHARS = 12000;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

function clip(text, max = DIGEST_MAX_CHARS) {
  const s = String(text || "").trim();
  return s.length > max ? `${s.slice(0, max)}\n…（已截断，原文 ${s.length} 字）` : s;
}

/** 摘要 → digest。只收通过回指校验的要点，并如实交代有几条被略去。 */
function digestFromSummary(summary, artifact = {}) {
  if (!summary) return null;
  const lines = [];
  if (summary.brief) lines.push(String(summary.brief).trim());
  const points = Array.isArray(summary.points) ? summary.points : [];
  const grounded = points.filter(p => p.verified);
  const dropped = points.length - grounded.length;
  for (const p of grounded) {
    const where = p.anchor
      ? (p.anchor.kind === "time" ? `${p.anchor.label}-${fmtTimestamp(p.anchor.end)}` : `§${(p.anchor.index ?? 0) + 1}`)
      : "";
    lines.push(`- ${p.text}${where ? `（→ ${where}）` : ""}`);
  }
  if (dropped > 0) lines.push(`（另有 ${dropped} 条要点未通过回指校验，已略去）`);
  if (!lines.length) return null;
  const counts = summary.counts || {};
  const header = `【已总结素材 · 要点 ${counts.grounded || grounded.length}/${counts.total || points.length} 条通过回指校验`
    + `${artifact.title ? ` · ${artifact.title}` : ""}】`;
  return clip([header, ...lines].join("\n"));
}

/** 锚点 → digest：视频给带时间戳的段落，文章/文档给小节。 */
function digestFromAnchors(anchors, artifact = {}) {
  if (!anchors || !anchors.count) return null;
  const lines = [`【未成形摘要，以下为素材锚点 · ${artifact.title || ""}】`];
  if (anchors.kind === "time") {
    for (const s of (anchors.segments || []).slice(0, 60)) {
      lines.push(`${fmtTimestamp(s.start)} ${String(s.text || "").trim()}`);
      if (lines.join("\n").length > DIGEST_MAX_CHARS) break;
    }
  } else {
    for (const [i, s] of (anchors.sections || []).slice(0, 40).entries()) {
      const body = String(s.text || "").replace(/\s+/g, " ").trim();
      const label = String(s.label || "").trim();
      const head = /^§/.test(label) ? label : `§${i + 1}${label ? ` ${label}` : ""}`;
      lines.push(`${head}：${body.slice(0, 260)}`);
      if (lines.join("\n").length > DIGEST_MAX_CHARS) break;
    }
  }
  return lines.length > 1 ? clip(lines.join("\n")) : null;
}

/** 全文 → digest（只在显式要求时用）。 */
function digestFromFull(slotDir) {
  try {
    const file = path.join(slotDir, "text.txt");
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf-8");
    return clip(`【全文开头（显式要求）】\n${text.slice(0, FULL_MAX_CHARS)}`, FULL_MAX_CHARS + 200);
  } catch { return null; }
}

/**
 * 从产物目录建一条知识地图素材。
 * @param {{slotDir: string, base?: object, source?: string}} opts
 *        source: auto（默认）| summary | anchors | metadata | full
 * @returns {{item: object, source: string, note: string}|null}
 */
export function materialFromSlot({ slotDir, base = {}, source = "auto" } = {}) {
  if (!slotDir) return null;
  const artifact = readJson(path.join(slotDir, "artifact.json")) || {};
  const summary = readJson(path.join(slotDir, "summary.json"));
  const anchors = readJson(path.join(slotDir, "anchors.json")) || ensureAnchorIndex(slotDir, artifact);
  // digest 里的标题要能回退到 base —— 老槽位没有 artifact.json，标题只在记录里
  const hint = { ...artifact, title: base.title || artifact.title || "" };

  const candidates = {
    summary: () => digestFromSummary(summary, hint),
    anchors: () => digestFromAnchors(anchors, hint),
    metadata: () => (base.desc ? clip(String(base.desc)) : null),
    full: () => digestFromFull(slotDir),
  };
  const order = source === "auto"
    ? ["summary", "anchors", "metadata"]
    : [source, "summary", "anchors", "metadata"];

  let picked = null;
  let pickedName = "";
  for (const name of order) {
    const value = candidates[name] ? candidates[name]() : null;
    if (value) { picked = value; pickedName = name; break; }
  }
  if (!picked) return null;

  const note = pickedName === source || source === "auto"
    ? ""
    : `（请求 ${source}，实际只能用 ${pickedName}）`;

  return {
    source: pickedName,
    note,
    item: {
      ...base,
      title: base.title || artifact.title || "",
      up: base.up || artifact.author || "",
      kind: artifact.kind || base.kind || "video",
      anchorKind: artifact.anchorKind || "none",
      digest: picked,
      digestSource: pickedName,
      summaryPoints: summary?.counts?.total || 0,
      summaryGrounded: summary?.counts?.grounded || 0,
      // 时间锚点同时给出 segments —— 地图里的"跳转"要用秒，digest 里只有给人看的时间串
      segments: anchors?.kind === "time"
        ? (anchors.segments || []).slice(0, 200).map(s => ({ sec: Math.floor(s.start) || 0, text: String(s.text || "").slice(0, 80) }))
        : [],
    },
  };
}

/** 一句话说清这次地图是从什么上长出来的。 */
export function describeMaterials(materials = [], sources = {}) {
  const bySource = {};
  for (const m of materials) {
    const key = m.digestSource || "metadata";
    bySource[key] = (bySource[key] || 0) + 1;
  }
  const parts = Object.entries(bySource).map(([k, v]) => `${k}×${v}`);
  const notes = Object.entries(sources).filter(([, v]) => v).map(([k, v]) => `${k}${v}`);
  return `素材来源：${parts.join(" / ") || "无"}${notes.length ? `；${notes.join("；")}` : ""}`;
}
