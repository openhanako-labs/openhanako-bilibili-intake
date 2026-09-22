/**
 * lib/anchors.js — 把"带时间锚点的正文"从采集产物里取出来（2026-09-22 新增）。
 *
 * ⭐ 要解决的问题：锚点在交接处被拍平。
 *   采集层本来有锚点（subtitle_parser 出 start/end 段；audio_chunker 分块转写会落
 *   transcript_merged.json），但出口是 `"".join(seg.text)` → text.txt，再被
 *   truncateText(…, 12000) 截断喂给 Agent。于是：
 *     ① 长视频静默丢尾（1 小时视频字幕纯文本常见 1.5–2 万字）；
 *     ② 总结无法回指原文、卡片无法"跳到那段"。
 *   这里只做加法：产物不变，额外把锚点读出来交给上层。
 *
 * 依赖关系：纯读文件，不碰网络、不碰 Python。任一步失败都返回 null，
 * 上层退回旧行为（不要因为锚点读不出来就让整次采集失败）。
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ANCHOR_LIMIT = 400;
const DEFAULT_CHAR_BUDGET = 24_000;

/** 秒 → mm:ss / h:mm:ss */
export function fmtTimestamp(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(2, "0");
  const sss = String(ss).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}

/** "00:01:23,456" / "00:01:23.456" → 秒 */
function parseClock(s) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(String(s || "").trim());
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return (Number(h || 0) * 3600) + (Number(mm) * 60) + Number(ss) + Number(ms) / 1000;
}

/** SRT / VTT 通用：按空行切成块，取时间轴行与正文行。 */
export function parseSubtitleText(text) {
  const segments = [];
  const blocks = String(text || "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const tIdx = lines.findIndex(l => l.includes("-->"));
    if (tIdx < 0) continue;
    const [a, b] = lines[tIdx].split("-->");
    const start = parseClock(a);
    const end = parseClock(b);
    if (start === null) continue;
    // 去掉 VTT 的 cue 设置（位置/对齐）与行内标签，再拼正文。
    const body = lines.slice(tIdx + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!body) continue;
    segments.push({ start, end: end === null ? start : end, text: body });
  }
  return segments;
}

/** B站/YouTube 常见的 json3 字幕：events[].tStartMs / dDurationMs / segs[].utf8 */
export function parseJson3(text) {
  let doc;
  try { doc = JSON.parse(String(text || "")); } catch { return []; }
  const events = Array.isArray(doc?.events) ? doc.events : [];
  const segments = [];
  for (const e of events) {
    const body = (e?.segs || []).map(s => s?.utf8 || "").join("").replace(/\n/g, " ").trim();
    if (!body) continue;
    const start = (Number(e.tStartMs) || 0) / 1000;
    const end = start + (Number(e.dDurationMs) || 0) / 1000;
    segments.push({ start, end, text: body });
  }
  return segments;
}

/** 按后缀挑解析器；不认识的后缀返回空数组。 */
export function parseSubtitleFile(file) {
  let raw;
  const ext = path.extname(file).toLowerCase();
  try { raw = fs.readFileSync(file, "utf-8"); } catch { return []; }
  if (ext === ".json" || ext === ".json3") return parseJson3(raw);
  if (ext === ".srt" || ext === ".vtt") return parseSubtitleText(raw);
  if (ext === ".lrc" || ext === ".ass" || ext === ".ssa" || ext === ".ttml") {
    // 暂不解析：这些格式的时间轴语义不同（逐字/样式/滚动），
    // 乱解析出来的锚点比没有更坏 —— 交给 srt/vtt/json3 或 merged json。
    return [];
  }
  return parseSubtitleText(raw);
}

/**
 * 从采集产物取锚点段。
 * 顺序：transcript_merged.json（Whisper 长音频分块转写的产物，段最完整）
 *       → subtitleFiles 里的第一个能解析的文件（平台字幕）
 * @returns {{source: string, segments: Array, totalSegments: number, durationSec: number}|null}
 */
export function readTranscriptAnchors(outputDir, subtitleFiles = []) {
  const dir = outputDir ? String(outputDir) : "";
  if (dir) {
    const merged = path.join(dir, "transcript_merged.json");
    if (fs.existsSync(merged)) {
      try {
        const doc = JSON.parse(fs.readFileSync(merged, "utf-8"));
        const segs = (Array.isArray(doc?.segments) ? doc.segments : [])
          .map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || "").trim() }))
          .filter(s => s.text);
        if (segs.length > 0) return finish("merged", segs);
      } catch { /* 落到字幕文件 */ }
    }
  }
  if (dir) {
    // ⭐ 0.6.27：Whisper 转写的段落（collector 新落盘的 transcript_segments.json）。
    //   没有这一步，"平台不给字幕、只能靠 Whisper"的视频就永远没锚点。
    const segFile = path.join(dir, "transcript_segments.json");
    if (fs.existsSync(segFile)) {
      try {
        const doc = JSON.parse(fs.readFileSync(segFile, "utf-8"));
        const segs = (Array.isArray(doc?.segments) ? doc.segments : [])
          .map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || "").trim() }))
          .filter(s => s.text);
        if (segs.length > 0) return finish("whisper", segs);
      } catch { /* 落到字幕文件 */ }
    }
  }
  for (const f of Array.isArray(subtitleFiles) ? subtitleFiles : []) {
    const segs = parseSubtitleFile(f);
    if (segs.length > 0) return finish("subtitle", segs, path.basename(f));
  }
  return null;

  function finish(source, segments, name) {
    const durationSec = segments.reduce((max, s) => Math.max(max, s.end || 0), 0);
    return { source: name ? `${source}:${name}` : source, segments, totalSegments: segments.length, durationSec };
  }
}

/**
 * 组装交给 Agent 的锚点载荷：按 offset/limit 与字符预算切片，**明确报告是否还有后续**。
 * 截断不再静默 —— 这是本次改动的重点。
 */
export function buildAnchorPayload({
  outputDir,
  subtitleFiles,
  textPath,
  textChars,
  offset = 0,
  limit = DEFAULT_ANCHOR_LIMIT,
  charBudget = DEFAULT_CHAR_BUDGET,
} = {}) {
  const anchors = readTranscriptAnchors(outputDir, subtitleFiles);
  if (!anchors) return null;
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const max = Math.max(1, Math.floor(Number(limit) || DEFAULT_ANCHOR_LIMIT));
  const budget = Math.max(1000, Math.floor(Number(charBudget) || DEFAULT_CHAR_BUDGET));
  const picked = [];
  let chars = 0;
  for (let i = start; i < anchors.segments.length; i++) {
    const seg = anchors.segments[i];
    if (picked.length >= max) break;
    if (picked.length > 0 && chars + seg.text.length > budget) break;
    picked.push(seg);
    chars += seg.text.length;
  }
  const nextOffset = start + picked.length;
  return {
    source: anchors.source,
    totalSegments: anchors.totalSegments,
    durationSec: anchors.durationSec,
    textPath: textPath || "",
    textChars: Number(textChars) || 0,
    offset: start,
    returned: picked.length,
    truncated: nextOffset < anchors.totalSegments,
    nextOffset: nextOffset < anchors.totalSegments ? nextOffset : null,
    coveredSeconds: picked.length ? picked[picked.length - 1].end : 0,
    segments: picked,
  };
}
