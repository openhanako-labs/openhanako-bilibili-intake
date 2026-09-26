/**
 * lib/records.js — 记录（records.json）的单一读写实现。
 *
 * ⭐ 为什么抽出来（2026-09-22）：
 *   落记录过去只有卡片侧一处（http/intake.js 的 POST /intake/fetch）；
 *   模型工具（lib/service.js）采集完**一个字都不写记录**。
 *   于是卡片里的"历史"只等于"从卡片采过的"，不等于实际采集过的内容 ——
 *   用户看到的现象就是"卡片的 UI 跟历史记录不同步"。
 *   现在卡片侧与工具侧共用这一份实现：任何一条采集路径完成都会落记录。
 *
 * ⭐ 顺带补上的两处：
 *   1) 产物字段。以前采集 result 里明明有 outputDir / transcriptTextPath /
 *      transcriptSource / subtitleFiles / reports，一个都没进记录 ——
 *      用户无法判断"总结之后文件有没有留存"。现在全部落进记录。
 *   2) updatedAt。以前只有 createdAt（且 upsert 时保留旧值），补写总结后
 *      记录既不上浮、也看不出什么时候总结的。现在排序看 updatedAt。
 */
import fs from "node:fs";
import path from "node:path";
// ⭐ W4：摘要对账要用到摘要的读法与「摘要 → 记录字段」的映射。
//   summary.js 不反向 import 本文件，无循环。
import { patchFromSummary, readSummary, writeSummary } from "./summary.js";

/** records.json 的绝对路径。dataDir 缺失时退回到与 http/intake.js 一致的位置。 */
export function recordsFile(ctx) {
  const dataDir = ctx?.dataDir || path.join(ctx?.pluginDir || "", ".data");
  return path.join(dataDir, "records.json");
}

/**
 * ⭐ v0.6.17 的 canonical id 规则，原样保留（卡片侧与工具侧必须同源，
 *   否则同一视频两条 id，upsert 对不上就会长出无总结的重复记录）。
 *   BV/AV 号优先，否则取 URL 最后一段，拼 `rec_<platform>_<key>`。
 */
export function canonicalId(platform, source) {
  let key = String(source || "").trim();
  const idm = key.match(/(?:BV|AV|bv|av)[0-9A-Za-z]+/);
  if (idm) {
    key = idm[0].toUpperCase();
  } else if (/^https?:\/\//i.test(key)) {
    try { key = decodeURIComponent(new URL(key).pathname.split("/").filter(Boolean).pop() || key); } catch { /* 非法 URL 用原串 */ }
  }
  key = key.replace(/[^0-9A-Za-z_\-]/g, "") || "unknown";
  // ⭐ 0.6.27：以前直接截到 48 字符 —— 本地文档这种长路径截出来的前缀几乎一样
  //   （`...intake-doc-te`），不同文件可能撞成同一条记录。
  //   改成「可读尾段 + 短哈希」。BV 号这类短 key 不受影响。
  if (key.length > 40) {
    const tail = key.slice(-24);
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    key = `${tail}_${h.toString(36)}`;
  }
  return `rec_${String(platform || "bilibili").toLowerCase()}_${key}`;
}

// ⭐ 2026-09-26：读盘缓存（卡片轮询的省）。
//   卡片每 15 秒轮询一次 /intake/records，旧写法每次都 readFileSync + JSON.parse 整份
//   records.json（现在 71KB）。文件没变就没必要反复解析 —— 用 `size:mtimeMs` 当版本号，
//   版本没变直接还上次解析好的对象。
//   ⚠️ 返还的是**浅拷贝**：调用方（upsert）会 push、会整项替换，拷贝能挡住
//      “改了数组却没落盘、缓存先脏了”这种情况。
const _readCache = new Map(); // 文件绝对路径 -> { stamp, list }

/**
 * 存缓存。顺带把每个记录对象**冻住**：
 * 调用方要是原地改记录（`rec.title = ...`），会当场抛错；
 * 不冻的话就是另一种更难查的错 —— 改到了缓存、没落盘，下次读盘又"自己恢复"了。
 * 已确认现有代码没有这种写法（都走 upsert 整项替换），这道防护是给以后写的。
 */
function cachePut(file, stamp, list) {
  _readCache.set(file, {
    stamp,
    list: list.map((r) => (r && typeof r === "object" && !Object.isFrozen(r) ? Object.freeze(r) : r)),
  });
}

/** records.json 当前的版本号（`size:mtimeMs`）。文件不存在时是 `0:0`。 */
export function recordsStamp(ctx) {
  try {
    const st = fs.statSync(recordsFile(ctx));
    return st.size + ":" + Math.round(st.mtimeMs);
  } catch { return "0:0"; }
}

export function readRecords(ctx) {
  const file = recordsFile(ctx);
  const stamp = recordsStamp(ctx);
  const hit = _readCache.get(file);
  if (hit && hit.stamp === stamp) return hit.list.slice();
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, "utf-8")) || []; } catch { list = []; }
  cachePut(file, stamp, list);
  return list.slice();
}

export function writeRecords(ctx, list) {
  const file = recordsFile(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 写入前备份：防止写入中途崩溃导致数据损坏。只保留最近一份（.bak 覆盖写）。
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");
  } catch { /* 备份失败不阻断主流程 */ }
  fs.writeFileSync(file, JSON.stringify(list, null, 2), "utf-8");
  // ⭐ 写完立刻把缓存对齐到刚落盘的内容 —— 挡住“同一毫秒内、长度又一样”的极端情况，
  //   也让“写完之后紧接着读”不再走一次解析。
  cachePut(file, recordsStamp(ctx), list);
}

/**
 * 查重：同时比对存储 id 和**由 source 重算的 canonical id**。
 * 迁移期关键 —— 0.6.16 及更早的记录 id 是 `rec_<timestamp>_<rand>`，
 * 仅按存储 id 查重会让旧记录和新记录并存。
 */
export function findRec(all, canonId) {
  const i = all.findIndex(r => r.id === canonId);
  if (i >= 0) return i;
  return all.findIndex(r => canonicalId(r.platform, r.source) === canonId);
}

/** 合并时忽略的"空"值：不覆盖已有内容（尤其不能覆盖手写总结）。 */
function isEmpty(v) {
  return v === "" || v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}

/**
 * 唯一的 upsert 入口。空值不覆盖已有字段；保留 createdAt；刷新 updatedAt。
 * @returns {{record: object, created: boolean}}
 */
export function upsertRecord(ctx, patch) {
  const all = readRecords(ctx);
  const now = new Date().toISOString();
  const platform = patch.platform || "bilibili";
  const id = patch.id || canonicalId(platform, patch.source || "");
  const clean = {};
  for (const [k, v] of Object.entries({ ...patch, id })) {
    if (!isEmpty(v)) clean[k] = v;
  }
  const i = findRec(all, id);
  if (i >= 0) {
    const createdAt = all[i].createdAt || now;
    all[i] = {
      ...all[i],
      ...clean,
      id,
      createdAt,
      updatedAt: patch.updatedAt || now,
      // 手写总结优先级最高：新值空着就留着旧的。
      summary: clean.summary || all[i].summary || "",
    };
    writeRecords(ctx, all);
    return { record: all[i], created: false };
  }
  const rec = {
    id,
    platform,
    source: patch.source || "",
    title: "",
    author: "",
    durationSec: 0,
    summary: "",
    tags: [],
    createdAt: now,
    ...clean,
    updatedAt: patch.updatedAt || now,
  };
  all.push(rec);
  writeRecords(ctx, all);
  return { record: rec, created: true };
}

/**
 * 用记录 id / BV 号 / 链接 / 本地路径 / 标题片段定位一条记录。
 * ⭐ P3：知识地图、摘要回写都要“拿一个东西找到那条记录”，别各写一份。
 */
export function locateRecord(all, key) {
  const s = String(key || "").trim();
  if (!s || !Array.isArray(all)) return null;
  return all.find(r => r.id === s)
    || all.find(r => canonicalId(r.platform, s) === r.id)
    || all.find(r => String(r.source || "") === s)
    || all.find(r => String(r.source || "").includes(s))
    || all.find(r => String(r.title || "").includes(s))
    || null;
}

/** 最近更新在前。旧记录没有 updatedAt 时退回 createdAt。 */
export function listRecords(ctx, limit = 100) {
  const all = readRecords(ctx);
  const sorted = all.slice().sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
    const tb = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
    return tb - ta;
  });
  return { total: all.length, items: sorted.slice(0, Math.max(1, Math.min(200, limit))) };
}

/**
 * ⭐ 扫 captures 下每个槽位的 result.json 建记录（自愈入口，2026-09-22）。
 *
 * 背景：0.6.26 及以前只有卡片侧采集会写 records.json，模型工具侧一个字都不写 ——
 * 于是会出现「历史里有、记录是 0」。这里把旧采集认领成记录。
 *
 * 只补不改：已有总结的记录不会被覆盖；同一 canonical id 多次采集收敛成一条
 * （旧 → 新遍历，后者赢——保留最新产物目录）；
 * captures 在 App 自己的 dataDir 内，所以 JS 权限模型放行。
 */
export function backfillFromCaptures(ctx, capturesDir, { skipPrefix = /^(search-|verify-)/ } = {}) {
  const stats = { scanned: 0, created: 0, updated: 0, failed: 0 };
  let dirs = [];
  try {
    if (!fs.existsSync(capturesDir)) return stats;
    dirs = fs.readdirSync(capturesDir)
      .filter(d => !skipPrefix.test(d) && fs.statSync(path.join(capturesDir, d)).isDirectory())
      .map(d => ({ d, mtimeMs: (() => { try { return fs.statSync(path.join(capturesDir, d)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch { return stats; }

  for (const { d, mtimeMs } of dirs) {
    const full = path.join(capturesDir, d);
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(full, "result.json"), "utf-8")); } catch { stats.failed++; continue; }
    if (!data || (!data.title && !data.url && !data.source)) { stats.failed++; continue; }
    stats.scanned++;
    const patch = patchFromResult(
      { ...data, outputDir: data.outputDir || full },
      { artifactDir: full, source: data.url || d },
    );
    if (mtimeMs) {
      const iso = new Date(mtimeMs).toISOString();
      patch.createdAt = iso;
      patch.updatedAt = iso;
    }
    try {
      const { created } = upsertRecord(ctx, patch);
      if (created) stats.created++; else stats.updated++;
    } catch { stats.failed++; }
  }
  return stats;
}

/**
 * ⭐ 从采集 result 提记录字段 —— 卡片路由与模型工具共用，避免两侧字段漂移。
 *
 * 注意 source 的取值顺序：bvid → 调用方给的 source → url。
 * **刻意不用 item_id**：B站 item_id 是 aid，用它会让 canonicalId 从 BV 号
 * 变成数字串，和 0.6.17 之前的记录对不上，凭空长出重复条目。
 */
export function patchFromResult(result, fallback = {}) {
  const r = result || {};
  const platform = r.platform || fallback.platform || "bilibili";
  const source = r.bvid || fallback.source || r.url || "";
  return {
    platform,
    source,
    title: r.title || "",
    author: r.uploader || r.author?.nickname || r.author || "",
    durationSec: Number(r.duration || r.durationSec) || 0,
    tags: [platform].filter(Boolean),
    // ── 产物与转写（新增：result 里早就有，只是没进记录）──
    artifactDir: r.outputDir || fallback.artifactDir || "",
    transcriptPath: r.transcriptTextPath || "",
    transcriptChars: typeof r.transcriptText === "string" && r.transcriptText
      ? r.transcriptText.length
      : (Number(r.textChars) || 0),
    transcriptSource: r.transcriptSource || "",
    transcriptDevice: r.transcriptDevice || "",
    subtitleFiles: Array.isArray(r.subtitleFiles) ? r.subtitleFiles : [],
    commentCount: Array.isArray(r.comments) ? r.comments.length : 0,
    reports: r.reports || null,
    // ── P1：素材类型与锚点类型（卡片上能看到“这是视频/文章/文档、锚点是时间轴/小节”）──
    kind: r.kind || r.artifact?.kind || "",
    anchorKind: r.artifact?.anchorKind || (r.transcriptAnchors ? "time" : ""),
  };
}

/* ──────────────────── W4（2026-09-26）：摘要对账 ──────────────────── */

/**
 * 宽松比较两个目录路径是否同一个（Windows 大小写 / 斜杠不敏感）。
 *
 * ⭐ 2026-09-26：本机的 `C:\Users\Administrator\.hanako` 是一个 **SymbolicLink**，
 *   指向 `W:\Games\Hanako\.hanako` —— 同一个目录两个名字。纯字符串比较在这种情况下
 *   永远比不出“同一”（实测直接把对账跑成 0 命中）。所以快路径不中就上 realpath 再比一次。
 */
export function sameDirPath(a, b) {
  const norm = (p) => String(p || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  const x = norm(a);
  if (x.length === 0) return false;
  if (x === norm(b)) return true;
  const real = (p) => {
    const abs = path.resolve(String(p || ""));
    try { return norm(fs.realpathSync.native(abs)); } catch { /* 符号链接解析不了就退回字面值 */ }
    try { return norm(fs.realpathSync(abs)); } catch { return norm(p); }
  };
  const rx = real(a);
  return rx.length > 0 && rx === real(b);
}

/**
 * target 是否在 root 之内（或等于 root）。把槽位限制在 captures 下，与 /intake/artifact 同一条边界。
 * 同样要过 realpath —— 否则 records 里存 W: 盘路径、配置里是 C: 盘路径时，包含关系判不出来。
 */
/**
 * target 是否在 root 之内（或等于 root）。把槽位限制在 captures 下，与 /intake/artifact 同一条边界。
 * 同样要过 realpath —— 否则 records 里存 W: 盘路径、配置里是 C: 盘路径时，包含关系判不出来。
 * ⭐ 导出给 lib/purge.js 用：删产物前必须确认槽位真在 captures 之下。
 */
export function isInsideDir(target, root) {
  const norm = (p) => String(p || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  const real = (p) => {
    const abs = path.resolve(String(p || ""));
    try { return norm(fs.realpathSync.native(abs)); } catch { /* 同上 */ }
    try { return norm(fs.realpathSync(abs)); } catch { return norm(p); }
  };
  const t = real(target);
  const r = real(root);
  return t === r || t.startsWith(r + "/");
}

/**
 * ⭐ W4（2026-09-26）：摘要对账 —— 自愈“总结过但卡片显示未总结”。
 *
 * 现场：intake_summary 落了 summary.json，但因为定位不到记录（recordId 为空）
 * 而整段跳过回写；回写外面又套了 catch{} 静默吞异常。于是槽位里有 9~14 个要点的摘要，
 * records.json 里 summary 是空串，卡片按 record.summary 判“未总结”。**实测 3 条。**
 *
 * 只补不改：
 *   · 记录已有 summary 文本、也有要点统计 → 跳过
 *   · 记录缺 summary 文本 且 summary.json 有 brief → 补 summary 文本
 *   · 记录缺要点统计 且 summary.json 有点数 → 补统计
 *   · summary.json 里 recordId 为空 → 顺手补上（它自称归属哪条记录，便于以后自解释）
 */
export function reconcileSummaries(ctx, capturesDir) {
  const stats = { scanned: 0, filled: 0, relinked: 0, skipped: 0, failed: 0 };
  const all = readRecords(ctx);
  for (const rec of all) {
    const dir = String(rec.artifactDir || "").trim();
    if (!dir) { stats.skipped++; continue; }
    if (capturesDir && !isInsideDir(dir, capturesDir)) { stats.skipped++; continue; }
    stats.scanned++;
    try {
      const summary = readSummary(dir);
      if (!summary) { stats.skipped++; continue; }

      const hasBrief = Boolean(String(summary.brief || "").trim());
      const hasPoints = Number(summary.counts?.total) > 0;
      if (!hasBrief && !hasPoints) { stats.skipped++; continue; }

      const recHasSummary = Boolean(String(rec.summary || "").trim());
      const recHasStats = Number(rec.summaryPoints) > 0;
      const needSummary = hasBrief && !recHasSummary;
      const needStats = hasPoints && !recHasStats;
      if (!needSummary && !needStats) { stats.skipped++; continue; }

      const patch = patchFromSummary(summary, { slotDir: dir, recordId: rec.id });
      if (!needSummary) delete patch.summary;   // 记录已有总结文本，别拿文件的 brief 盖掉它
      upsertRecord(ctx, patch);
      stats.filled++;

      if (!String(summary.recordId || "").trim()) {
        try {
          writeSummary(dir, { ...summary, recordId: rec.id }, { keepHistory: false });
          stats.relinked++;
        } catch { /* 补归属失败不影响补字段 */ }
      }
    } catch { stats.failed++; }
  }
  return stats;
}
