/**
 * intake-forget.js — W3（2026-09-26）：删除采集记录与本地产物。
 *
 * 为什么要有它：删除不只是卡片上的按钮。月曦夜明确要「助手也能操作」——
 * 采错了、重复了、不要了，模型应该能直接清掉，而不是让用户去点卡片。
 *
 * 安全设计（这是不可逆动作，三道闸）：
 *   1. 默认 **preview**：只列出会删什么，一个字不删
 *   2. 真删要 action="purge" **且** confirm=true —— 两个条件缺一不可
 *   3. 槽位边界由 lib/purge.js 兜：必须在 captures 之内，且不许把 captures 根当槽位
 *
 * 删除规则（月曦夜定）：直接删；只有「已总结」的槽位，把总结后产生的文件
 * （summary.json / summary.md / summary-history）先挪进 captures/.trash/ 再删其余。
 */
import { capturesDirOf, emptyTrash, listTrash, pruneTrash, purgeRecords } from "../lib/purge.js";
import { locateRecord, readRecords } from "../lib/records.js";
import { getSettings } from "../lib/settings.js";
import { toToolError, toToolResult } from "../lib/tool-output.js";

export const name = "intake_forget";

export const description =
  "删除采集记录与其本地产物（正文 / 字幕 / 帧 / 原片），或管理删除缓冲。" +
  "action: preview（默认，只列出会删什么，不执行）| purge（真删，必须同时传 confirm:true）| trash-list | trash-prune（按设置的天数/体积清缓冲）| trash-empty（全清）。" +
  "目标用 ids（记录 id 数组）或 source（BV 号 / 链接 / 标题片段）指定。" +
  "规则：直接删；只有「已总结」的槽位会把总结文件留档到 captures/.trash/。不可恢复，删前先 preview。";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["preview", "purge", "trash-list", "trash-prune", "trash-empty"],
      default: "preview",
      description: "preview=只列出会删什么（默认）；purge=真删（需 confirm:true）；trash-list=看缓冲里有什么；trash-prune=按设置的天数/体积只删该删的；trash-empty=清空缓冲（需 confirm:true）。",
    },
    ids: {
      type: "array",
      items: { type: "string" },
      description: "记录 id 列表（采集回执里的『记录ID』）。",
    },
    source: {
      type: "string",
      description: "也可以用 BV 号 / 链接 / 标题片段定位一条记录。",
    },
    confirm: {
      type: "boolean",
      default: false,
      description: "不可恢复动作的确认闸。purge 与 trash-empty 必须显式传 true。",
    },
    keepDays: {
      type: "number",
      description: "只在 trash-prune 时用：临时覆盖设置里的保留天数。",
    },
  },
};

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

function renderTrash(t) {
  if (!t.count) return "删除缓冲是空的。";
  const lines = [`缓冲里有 ${t.count} 个槽位的留档，共 ${fmtBytes(t.bytes)}：`];
  for (const it of t.items) lines.push(`  · ${it.day}/${it.slot} —— ${it.files.join(", ")}`);
  lines.push("", "要按保留天数/体积只删该删的：action=\"trash-prune\"；要全清：action=\"trash-empty\" + confirm:true。");
  return lines.join("\n");
}

export async function execute(input = {}, ctx) {
  try {
    const action = input.action || "preview";
    const capturesDir = capturesDirOf(ctx);

    if (action === "trash-list") {
      const t = listTrash(capturesDir);
      return toToolResult({ ok: true, ...t }, renderTrash(t));
    }

    if (action === "trash-empty") {
      if (input.confirm !== true) {
        return toToolError(new Error("清空缓冲不可恢复：需要显式传 confirm: true。"), {
          action: name,
          hint: "先 action=\"trash-list\" 看一眼里面有什么。",
        });
      }
      const r = emptyTrash(capturesDir);
      return toToolResult({ ok: true, ...r }, `缓冲已清空：删掉 ${r.removed} 个槽位的留档（${fmtBytes(r.bytes)}）。`);
    }

    if (action === "trash-prune") {
      // 按设置里那两道闸门清（只删不写）。不传 confirm —— 它删的是**已过期/超量**的留档，
      //   不是全清；想全清走 trash-empty（那个要 confirm）。
      const s = await getSettings(ctx);
      const r = pruneTrash(capturesDir, {
        maxAgeDays: Number(input.keepDays) > 0 ? Number(input.keepDays) : (Number(s.trashKeepDays) || 0),
        maxBytes: (Number(s.trashMaxMB) || 0) * 1024 * 1024,
      });
      return toToolResult({ ok: true, ...r }, r.removed
        ? `缓冲清理：删掉 ${r.removed} 项（${fmtBytes(r.bytes)}），原因：${r.reasons.join("、")}；剩 ${r.kept} 项（${fmtBytes(r.keptBytes)}）。`
        : `缓冲没什么要清的：${r.kept} 项，共 ${fmtBytes(r.keptBytes)}。`);
    }

    // ── 解析目标 ──
    const all = readRecords(ctx);
    const picked = new Map();
    const missed = [];
    for (const raw of Array.isArray(input.ids) ? input.ids : []) {
      const key = String(raw || "").trim();
      if (!key) continue;
      const rec = locateRecord(all, key);
      if (rec) picked.set(rec.id, rec); else missed.push(key);
    }
    if (input.source) {
      const key = String(input.source);
      const rec = locateRecord(all, key);
      if (rec) picked.set(rec.id, rec); else missed.push(key);
    }
    const targets = [...picked.values()];

    if (!targets.length) {
      return toToolError(
        new Error(missed.length ? `没有匹配到记录：${missed.join("、")}` : "没有指定要删的记录（ids 或 source）。"),
        { action: name, hint: "先看有哪些记录（卡片「记录」tab，或 GET /intake/records），再传 id 或 source 片段。" },
      );
    }

    const preview = targets.map((r) => ({
      id: r.id,
      title: r.title || r.source || "(无标题)",
      dir: r.artifactDir || "",
      summarized: Boolean(String(r.summary || "").trim()),
    }));

    if (action !== "purge" || input.confirm !== true) {
      const lines = [
        `将要删除 ${preview.length} 条记录与其本地产物 —— **尚未执行**：`,
        ...preview.map((p) => `  · ${p.title}${p.summarized ? "（已总结，总结文件会留档）" : ""}\n      ${p.dir || "(无产物目录)"}`),
      ];
      if (missed.length) lines.push("", `（没匹配到：${missed.join("、")}）`);
      lines.push("", "确认要删：再调一次，action=\"purge\" 且 confirm=true。");
      return toToolResult({ ok: true, dryRun: true, count: preview.length, targets: preview, missed }, lines.join("\n"));
    }

    const r = purgeRecords(ctx, targets.map((t) => t.id), { capturesDir });
    const okLines = r.items.filter((i) => !i.error).map((i) => `  · 已删 ${i.title}${i.trashed.length ? `（留档：${i.trashed.join(", ")}）` : ""}`);
    const badLines = r.items.filter((i) => i.error).map((i) => `  · ✗ ${i.title || i.id}：${i.error}`);
    const text = [
      `删除完成：成功 ${r.deleted} 条，失败 ${r.failed} 条${r.trashedFiles ? `，留档 ${r.trashedFiles} 项` : ""}。`,
      ...okLines,
      ...badLines,
    ].join("\n");

    return toToolResult(
      { ok: r.failed === 0, deleted: r.deleted, failed: r.failed, trashedFiles: r.trashedFiles, items: r.items },
      text,
    );
  } catch (error) {
    return toToolError(error, { action: name, source: input.source || (Array.isArray(input.ids) ? input.ids.join(",") : null) });
  }
}
