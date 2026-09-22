/**
 * lib/artifacts.js — 统一素材描述（artifact.json）。
 *
 * ⭐ P1（2026-09-22）：总结层不该认识平台。
 *   视频、笔记、文章、本地文档走到这里形状必须一样：
 *     { kind, anchorKind, text, anchors, resources }
 *   text 是唯一的正文入口，anchorKind 说明"锚点是什么坐标"（时间轴 / 小节 / 无），
 *   resources 挂帧图、字幕原文件、音频这些附属物。
 *   这样总结层只吃一种东西 —— 加一种素材（比如本地 PDF）只是多一个 kind，
 *   不用再写一条总结逻辑。
 *
 * 写入是尽力而为：任何异常都返回 null，绝不让采集本身失败。
 */
import fs from "node:fs";
import path from "node:path";
import { readTranscriptAnchors } from "./anchors.js";
import { readAnchors, writeAnchors } from "./summary.js";

const VIDEO_PLATFORMS = new Set(["bilibili", "youtube", "douyin", "kuaishou"]);
const ARTICLE_PLATFORMS = new Set(["xhs", "xiaohongshu", "weibo", "zhihu", "tieba"]);

export function detectKind(result = {}) {
  if (result.kind) return result.kind;
  if (result.documentPath || result.textKind === "document") return "document";
  if (result.textKind === "article") return "article";
  const p = String(result.platform || "").toLowerCase();
  if (ARTICLE_PLATFORMS.has(p)) return "article";
  if (VIDEO_PLATFORMS.has(p)) return "video";
  return result.duration ? "video" : "article";
}

/**
 * 文章类的"锚点"：按 Markdown 标题切小节；没有标题就按空行段落聚成 ~800 字的块。
 * 返回 [{start, end, label, text}]，start/end 是字符偏移（视频用秒，文章用字符 —— 各自的坐标）。
 */
export function parseSectionAnchors(text, maxSections = 400) {
  const src = String(text || "");
  if (!src.trim()) return [];
  const out = [];
  const heads = [...src.matchAll(/^#{1,6}[ \t]*(.+)$/gm)];
  if (heads.length >= 2) {
    for (let i = 0; i < heads.length; i++) {
      const start = heads[i].index;
      const end = i + 1 < heads.length ? heads[i + 1].index : src.length;
      const body = src.slice(start, end).trim();
      if (!body) continue;
      out.push({ start, end, label: heads[i][1].trim().slice(0, 80), text: body.slice(0, 4000) });
      if (out.length >= maxSections) break;
    }
    return out;
  }
  const paras = src.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  let buf = [];
  let cursor = 0;
  let idx = 0;
  const flush = () => {
    if (!buf.length) return;
    const body = buf.join("\n\n");
    out.push({ start: cursor, end: cursor + body.length, label: `§${++idx}`, text: body.slice(0, 4000) });
    cursor += body.length;
    buf = [];
  };
  for (const p of paras) {
    buf.push(p);
    if (buf.join("\n\n").length >= 800) flush();
    if (out.length >= maxSections) break;
  }
  flush();
  return out;
}

/** 数一下目录里的附属资源（帧图 / 图片子目录）。 */
function countResources(dir) {
  const resources = { frames: 0, images: 0, subtitleFiles: 0, audio: "" };
  try {
    if (!dir || !fs.existsSync(dir)) return resources;
    for (const sub of ["frames", "images"]) {
      const p = path.join(dir, sub);
      if (!fs.existsSync(p)) continue;
      const n = fs.readdirSync(p).filter(f => /\.(png|jpe?g|webp|bmp)$/i.test(f)).length;
      resources[sub === "frames" ? "frames" : "images"] = n;
    }
  } catch { /* 资源计数失败不影响主体 */ }
  return resources;
}

export function buildArtifact(result = {}, { slotDir, anchors = null } = {}) {
  const dir = slotDir || result.outputDir || "";
  const kind = detectKind(result);
  const textPath = result.transcriptTextPath || (dir ? path.join(dir, "text.txt") : "");
  const textExists = textPath ? fs.existsSync(textPath) : false;
  const textChars = Number(result.transcriptText?.length || result.textChars || 0);

  let anchorStats = null;
  if (anchors && anchors.totalSegments > 0) {
    anchorStats = { kind: "time", source: anchors.source, count: anchors.totalSegments, durationSec: anchors.durationSec };
  } else if (textExists && kind !== "video") {
    try {
      const sections = parseSectionAnchors(fs.readFileSync(textPath, "utf-8"));
      if (sections.length > 0) anchorStats = { kind: "section", source: "text-structure", count: sections.length };
    } catch { /* 锚点统计失败 → none */ }
  }

  const resources = countResources(dir);
  resources.subtitleFiles = Array.isArray(result.subtitleFiles) ? result.subtitleFiles.length : 0;
  resources.audio = result.audioPath || "";

  return {
    spec: "1.0",
    kind,
    anchorKind: anchorStats ? anchorStats.kind : "none",
    platform: result.platform || "",
    source: result.url || result.source || "",
    title: result.title || "",
    author: result.uploader || result.author || "",
    durationSec: Number(result.duration || result.durationSec) || 0,
    text: { file: textPath, exists: textExists, chars: textChars },
    anchors: anchorStats,
    resources,
    reports: result.reports || null,
    generatedAt: new Date().toISOString(),
  };
}

/** 写 <slot>/artifact.json。返回描述对象；失败返回 null。 */
export function writeArtifact(result = {}, opts = {}) {
  try {
    const artifact = buildArtifact(result, opts);
    const dir = opts.slotDir || result.outputDir;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "artifact.json"), JSON.stringify(artifact, null, 2), "utf-8");
      // ⭐ P2（2026-09-22）：把**锚点本体**也落一份。
      //   artifact.json 只存统计（count/durationSec），而摘要要回指到具体某一段 ——
      //   没有段本体就无从校验。
      ensureAnchorIndex(dir, artifact, { subtitleFiles: result.subtitleFiles });
    }
    return artifact;
  } catch { return null; }
}

/** 目录里自己找字幕文件（老槽位从 artifact.json 拿不到清单）。 */
function scanSubtitleFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => /\.(srt|vtt)$/i.test(f)).map(f => path.join(dir, f));
  } catch { return []; }
}

/** 从产物自身尽力重建锚点索引。 */
function anchorsFromFiles(dir, artifact = {}, hints = {}) {
  // 先试时间锚点：转写段落是比正文分段更精确的坐标（视频转写没有标题，
  // 切成 800 字的块基本是随意的）。而且不看 artifact.anchorKind ——
  // P1 之前的槽位只有 result.json，根本没有 artifact.json。
  const list = (Array.isArray(hints.subtitleFiles) && hints.subtitleFiles.length) ? hints.subtitleFiles : scanSubtitleFiles(dir);
  const found = readTranscriptAnchors(dir, list);
  if (found && found.segments && found.segments.length) {
    return { kind: "time", source: found.source, durationSec: found.durationSec, segments: found.segments };
  }
  // 建不出时间锚点，才退回正文结构：有正文就有可回指的位置。
  const textFile = artifact.text && artifact.text.file ? artifact.text.file : path.join(dir, "text.txt");
  try {
    if (!fs.existsSync(textFile)) return null;
    const sections = parseSectionAnchors(fs.readFileSync(textFile, "utf-8"));
    if (sections.length) return { kind: "section", source: "text-structure", sections };
  } catch { /* 读不出来就算了 */ }
  return null;
}

/**
 * 拿到可用的锚点索引：已有 anchors.json 直接用；没有就从产物自身重建并落盘。
 * ⭐ P2：P2 之前采集的槽位只有 artifact.json、没有 anchors.json ——
 *   不能因此就判“没有锚点”。摘要要回指，索引应该自己长出来。
 */
export function ensureAnchorIndex(slotDir, artifact = {}, hints = {}) {
  try {
    if (!slotDir) return null;
    const existing = readAnchors(slotDir);
    if (existing && existing.count) return existing;
    const built = anchorsFromFiles(slotDir, artifact, hints);
    return built ? writeAnchors(slotDir, built) : null;
  } catch { return null; }
}
