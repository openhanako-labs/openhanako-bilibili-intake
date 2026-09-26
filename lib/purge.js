/**
 * lib/purge.js — W3（2026-09-26）：删除记录与产物。
 *
 * 规则（月曦夜 2026-09-26 定）：
 *   · **直接删** —— 记录与中间产物（正文 / 字幕 / 帧 / 报告 / 原片）当场删掉，不进回收站
 *   · 唯一的例外是「已总结」的槽位：把**总结后产生的文件**先挪进
 *     `captures/.trash/<日期>/<槽位名>/`，再删其余
 *     —— 摘要是有价值的产出，几百 MB 的中间产物不值得留
 *
 * 两条边界（都不许越）：
 *   1. 槽位必须落在 captures 之内（与 /intake/artifact 同一条线）
 *   2. 不允许把 captures 根目录本身当槽位删
 *
 * ⚠️ 这个模块只做删除。**调用方负责二次确认**——UI 侧有确认条，
 *   工具侧要求显式 confirm（见 tools/intake-forget.js）。
 */
import fs from "node:fs";
import path from "node:path";
import { isInsideDir, readRecords, sameDirPath, writeRecords } from "./records.js";
import { summaryHistoryDir, summaryMarkdownPath, summaryPath } from "./summary.js";

export const TRASH_DIRNAME = ".trash";

/** captures 根目录。ctx.dataDir 缺失时返回空串（调用方会因此拒绝删除）。 */
export function capturesDirOf(ctx) {
  const dataDir = ctx?.dataDir || "";
  return dataDir ? path.join(dataDir, "captures") : "";
}

function dayStamp() {
  return new Date().toISOString().slice(0, 10);
}

/** 「总结后产生的文件」：summary.json / summary.md / summary-history/。 */
function summaryArtifacts(slotDir) {
  const out = [];
  for (const f of [summaryPath(slotDir), summaryMarkdownPath(slotDir)]) {
    try { if (fs.existsSync(f)) out.push(f); } catch { /* 读不到就当没有 */ }
  }
  try { if (fs.existsSync(summaryHistoryDir(slotDir))) out.push(summaryHistoryDir(slotDir)); } catch { /* 同上 */ }
  return out;
}

/**
 * 删一个槽位目录。已总结的先留档再删。
 * @returns {{dir:string, existed:boolean, trashed:string[], trashDir:string, error:string}}
 */
export function purgeSlot(slotDir, capturesDir) {
  const out = { dir: String(slotDir || ""), existed: false, trashed: [], trashDir: "", error: "" };
  const dir = String(slotDir || "").trim();
  if (!dir) { out.error = "槽位目录为空"; return out; }
  if (!capturesDir || !isInsideDir(dir, capturesDir)) { out.error = "槽位不在 captures 之内，拒绝删除"; return out; }
  if (sameDirPath(dir, capturesDir)) { out.error = "拒绝把 captures 根目录当槽位删除"; return out; }

  try {
    if (!fs.existsSync(dir)) return out;   // 已经不在了：正常，不算失败
    out.existed = true;

    // ① 已总结 → 总结后产生的文件先进缓冲
    const arts = summaryArtifacts(dir);
    if (arts.length) {
      const trash = path.join(capturesDir, TRASH_DIRNAME, dayStamp(), path.basename(dir));
      fs.mkdirSync(trash, { recursive: true });
      for (const a of arts) {
        const dest = path.join(trash, path.basename(a));
        try {
          fs.renameSync(a, dest);
          out.trashed.push(path.basename(a));
        } catch {
          // 跨盘 / 被占用 → 退回复制后删源
          try {
            fs.cpSync(a, dest, { recursive: true });
            fs.rmSync(a, { recursive: true, force: true });
            out.trashed.push(path.basename(a));
          } catch { /* 挪不动就随槽位一起删，不因此判失败 */ }
        }
      }
      out.trashDir = trash;
    }

    // ② 其余直接删
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    out.error = e?.message || String(e);
  }
  return out;
}

/**
 * 删记录（连带产物）。
 *
 * 一条记录的槽位删失败时，**保留这条记录**并回报错误 —— 让它留在卡片上可重试，
 * 比"记录没了、目录还在"更接近"零残留"的意图。
 *
 * @param {object} ctx
 * @param {string[]} ids 记录 id 列表
 * @param {{capturesDir?: string}} [opts]
 * @returns {{requested:number, deleted:number, failed:number, trashedFiles:number, items:Array}}
 */
export function purgeRecords(ctx, ids, { capturesDir } = {}) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || "").trim()).filter(Boolean));
  const result = { requested: wanted.size, deleted: 0, failed: 0, trashedFiles: 0, items: [] };
  if (!wanted.size) return result;

  const captures = capturesDir || capturesDirOf(ctx);
  const all = readRecords(ctx);
  const kept = [];
  let changed = false;

  for (const rec of all) {
    if (!wanted.has(rec.id)) { kept.push(rec); continue; }
    wanted.delete(rec.id);

    const slot = String(rec.artifactDir || "").trim();
    const purged = slot
      ? purgeSlot(slot, captures)
      : { dir: "", existed: false, trashed: [], trashDir: "", error: "" };

    const item = {
      id: rec.id,
      title: rec.title || rec.source || "(无标题)",
      dir: purged.dir,
      slotExisted: purged.existed,
      trashed: purged.trashed,
      trashDir: purged.trashDir,
      error: purged.error,
    };
    result.items.push(item);

    if (purged.error) {
      result.failed++;
      kept.push(rec);          // 槽位没删干净 → 记录留着，可重试
    } else {
      result.deleted++;
      result.trashedFiles += purged.trashed.length;
      changed = true;
    }
  }

  // 名义上要删、但没有对应记录的 id，也算失败（要如实回报，不能悄悄吞）
  for (const missing of wanted) {
    result.failed++;
    result.items.push({ id: missing, title: "", dir: "", slotExisted: false, trashed: [], trashDir: "", error: "记录不存在" });
  }

  if (changed) writeRecords(ctx, kept);
  return result;
}

/** 缓冲目录的绝对路径（不含日期层）。 */
export function trashRoot(capturesDir) {
  return capturesDir ? path.join(capturesDir, TRASH_DIRNAME) : "";
}

/** 列出缓冲里有什么。返回 {count, bytes, items:[{day, slot, files, bytes}]}。 */
export function listTrash(capturesDir) {
  const out = { count: 0, bytes: 0, items: [] };
  const root = trashRoot(capturesDir);
  if (!root) return out;
  let days = [];
  try { days = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()); } catch { return out; }

  for (const day of days) {
    const dayDir = path.join(root, day);
    let slots = [];
    try { slots = fs.readdirSync(dayDir).filter((s) => fs.statSync(path.join(dayDir, s)).isDirectory()); } catch { continue; }
    for (const slot of slots) {
      const slotDir = path.join(dayDir, slot);
      let files = [];
      let bytes = 0;
      const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else {
            files.push(e.name);
            try { bytes += fs.statSync(full).size; } catch { /* 拿不到大小就不计 */ }
          }
        }
      };
      walk(slotDir);
      out.count++;
      out.bytes += bytes;
      out.items.push({ day, slot, files, bytes });
    }
  }
  return out;
}

/** 清空缓冲（真删）。返回 {removed, bytes}。 */
export function emptyTrash(capturesDir) {
  const root = trashRoot(capturesDir);
  if (!root) return { removed: 0, bytes: 0 };
  const before = listTrash(capturesDir);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 删不动就如实回报 0 */ }
  return { removed: before.count, bytes: before.bytes };
}

/** 目录递归统计：字节数 + 最新 mtime。读不动就算了，不报错。 */
function dirStats(dir) {
  let bytes = 0;
  let newest = 0;
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const f of names) {
      const p = path.join(d, f);
      let st = null;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else { bytes += st.size; if (st.mtimeMs > newest) newest = st.mtimeMs; }
    }
  };
  walk(dir);
  return { bytes, newest };
}

/**
 * 缓冲清理（⭐ 2026-09-26 新增）。月曦夜定的口径：「一样的，不要重复写入」。
 *
 * 两条闸门，任一触发就删（都从**最旧的**开始）：
 *   ① maxAgeDays：留档超过这个天数
 *   ② maxBytes：整个缓冲超过这个体积
 *
 * ⚠️ 全程**只删不写**：没有可删的东西时一次 fs 写操作都不做。
 *   也不碰 records.json —— 缓冲里是产物留档，跟记录无关。（若哪天要它写什么，
 *   先想清楚：这个函数会在每次启动时跑，写就意味着每次启动都在改盘。）
 *
 * @returns {{removed:number, bytes:number, kept:number, keptBytes:number, reasons:string[]}}
 */
export function pruneTrash(capturesDir, { maxAgeDays = 30, maxBytes = 500 * 1024 * 1024, now = Date.now() } = {}) {
  const out = { removed: 0, bytes: 0, kept: 0, keptBytes: 0, reasons: [] };
  const root = trashRoot(capturesDir);
  if (!root || !fs.existsSync(root)) return out;

  // 铺平成一个条目清单：{dayDir, dir, at, bytes}
  const entries = [];
  let days = [];
  try {
    days = fs.readdirSync(root).filter((d) => {
      try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
    });
  } catch { return out; }

  for (const day of days) {
    const dayDir = path.join(root, day);
    let slots = [];
    try {
      slots = fs.readdirSync(dayDir).filter((s) => {
        try { return fs.statSync(path.join(dayDir, s)).isDirectory(); } catch { return false; }
      });
    } catch { continue; }
    // 日期层就用日期当年龄；不是日期（比如手工归类的 oldchain-*）就用内容的最新 mtime。
    const dayMs = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(day) : NaN;
    for (const slot of slots) {
      const dir = path.join(dayDir, slot);
      const { bytes, newest } = dirStats(dir);
      entries.push({ dayDir, dir, at: Number.isFinite(dayMs) ? dayMs : (newest || now), bytes });
    }
  }

  const doomed = [];
  const cutoff = now - Math.max(0, maxAgeDays) * 86400000;
  if (maxAgeDays > 0) {
    for (const e of entries) if (e.at < cutoff) doomed.push({ ...e, why: `超过 ${maxAgeDays} 天` });
  }

  const dead = new Set(doomed.map((d) => d.dir));
  const rest = entries.filter((e) => !dead.has(e.dir)).sort((a, b) => a.at - b.at);
  let total = rest.reduce((s, e) => s + e.bytes, 0);
  if (maxBytes > 0 && total > maxBytes) {
    for (const e of rest) {
      if (total <= maxBytes) break;
      doomed.push({ ...e, why: maxBytes >= 1048576 ? `缓冲超过 ${Math.round(maxBytes / 1048576)}MB` : `缓冲超过 ${Math.round(maxBytes / 1024)}KB` });
      total -= e.bytes;
    }
  }

  for (const e of doomed) {
    try {
      fs.rmSync(e.dir, { recursive: true, force: true });
      out.removed++;
      out.bytes += e.bytes;
    } catch { /* 删不动就跳过，不报错 */ }
    // 空的日期层顺手收掉（只在真的空了时）
    try { if (!fs.readdirSync(e.dayDir).length) fs.rmdirSync(e.dayDir); } catch { /* ignore */ }
  }

  const after = listTrash(capturesDir);
  out.kept = after.count;
  out.keptBytes = after.bytes;
  out.reasons = [...new Set(doomed.map((d) => d.why))];
  return out;
}
