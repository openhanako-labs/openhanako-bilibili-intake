/**
 * intake-summary.js — 结构化摘要 + 可回指校验（P2，2026-09-22）
 *
 * 用途：把一条记录的总结写成「一句话 + 要点列表」，每个要点标明出处 ——
 * 工具会拿正文锚点校验：能回指的标出处，回指不到的**明确列出来**。
 *
 * 为什么值得这么麻烦：今天的总结层没有"对不对"这个概念。模型写完一段话，
 * 谁也不知道哪句是从正文哪一段来的 —— 编了也看不出来。有了要点级回指，
 * "总结在编"这件事第一次变成可检查的。
 *
 * 出处的两种给法：
 *   · 显式：视频给时间（`at: "12:30"`），文章/文档给小节号（`at: "§3"` 或 `"第3节"`）
 *   · 隐式：不写 at，工具按字符重叠自动匹配最像的一段，并给出相似度分数
 *
 * 三个动作：
 *   action=save   落 summary.json + summary.md，并把统计回写到记录
 *   action=check  只校验不落盘（拿来先试）
 *   action=read   读回已存的摘要
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildSummary,
  patchFromSummary,
  readSummary,
  renderSummaryMarkdown,
  validatePoints,
  writeSummary,
} from "../lib/summary.js";
import { canonicalId, findRec, patchFromResult, readRecords, sameDirPath, upsertRecord } from "../lib/records.js";
import { ensureAnchorIndex } from "../lib/artifacts.js";
import { toToolError, toToolResult } from "../lib/tool-output.js";

export const name = "intake_summary";

export const description =
  "结构化摘要 + 可回指校验 —— 把一条记录的总结写成「一句话 + 要点列表」并校验每个要点能否回指正文锚点：" +
  "视频用时间（at: \"12:30\"）、文章/文档用小节号（at: \"§3\"）；不写 at 就按文本相似度自动匹配。" +
  "回指不到的要点会被明确列出（含原因），摘要与校验结果落 summary.json / summary.md。" +
  "target 可以传记录 id、也可以传 BV 号 / 链接 / 本地文件路径（自动找记录）。";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["save", "check", "read"],
      description: "save（默认）=校验并落盘；check=只校验不落盘；read=读回已存摘要。",
      default: "save",
    },
    recordId: { type: "string", description: "记录 id（推荐，来自采集回执的『记录ID』）。" },
    source: { type: "string", description: "也可以用 BV 号 / 链接 / 本地文件路径 / 标题片段来定位记录。" },
    slotDir: { type: "string", description: "直接指定产物目录（一般不用，定位不到记录时用）。" },
    brief: { type: "string", description: "卡片级一句话摘要（会写进记录的 summary 字段）。" },
    points: {
      type: "array",
      description: "要点列表。每项 {text, at?}：text 是要点本身，at 是出处（视频 \"12:30\"、文章 \"§3\"）。",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          at: { type: "string" },
        },
        required: ["text"],
      },
    },
    model: { type: "string", description: "可选：写这份摘要的模型名（落到摘要里，便于以后比较重跑结果）。" },
    promptVersion: { type: "string", description: "可选：prompt 版本标记。" },
  },
};

/** 用记录 id / source 片段 / slotDir 之一定位产物目录。 */
function locate(input, ctx) {
  const all = readRecords(ctx);
  if (input.recordId) {
    const i = findRec(all, String(input.recordId));
    if (i >= 0) return all[i];
  }
  if (input.source) {
    const s = String(input.source).trim();
    const hit = all.find(r => r.id === s)
      || all.find(r => canonicalId(r.platform, s) === r.id)
      || all.find(r => String(r.source || "") === s)
      || all.find(r => String(r.source || "").includes(s))
      || all.find(r => String(r.title || "").includes(s));
    if (hit) return hit;
  }
  return null;
}

function readArtifact(slotDir) {
  try {
    return JSON.parse(fs.readFileSync(slotDir + "/artifact.json", "utf-8"));
  } catch { return null; }
}

/** ⭐ W4：定位不到记录时，用产物目录里的 result.json 现造一条。 */
function readResultJson(slotDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(slotDir, "result.json"), "utf-8"));
  } catch { return null; }
}

export async function execute(input = {}, ctx) {
  try {
    const action = input.action || "save";
    let record = locate(input, ctx);
    let slotDir = String(input.slotDir || record?.artifactDir || "").trim();
    // ⭐ W4（2026-09-26）：定位兜底 —— 只给了 slotDir（或 source 片段没对上标题）时，
    //   按产物目录反查记录。实测 3 条就死在下一步：record = null → recordId 空 → 整段回写被跳过。
    if (!record && slotDir) {
      record = readRecords(ctx).find((r) => sameDirPath(r.artifactDir, slotDir)) || null;
    }
    if (record && !input.slotDir) slotDir = String(record.artifactDir || "").trim();
    if (!slotDir) {
      return toToolError(new Error("定位不到产物目录：请传记录 id / source（BV 号、链接、文件路径）或 slotDir。"), {
        action: name,
        hint: "采集回执里的『记录ID』或『工作目录』直接传进来就行。",
      });
    }

    const artifact = readArtifact(slotDir);
    // ⭐ 老槽位只有 artifact.json、没有 anchors.json —— 这里顺手把索引重建出来。
    const index = ensureAnchorIndex(slotDir, artifact || {});

    if (action === "read") {
      const stored = readSummary(slotDir);
      if (!stored) return toToolResult({ ok: false, slotDir, error: "这份产物还没有摘要" }, `产物目录 ${slotDir} 还没有摘要。`);
      return toToolResult({ ok: true, slotDir, summary: stored }, renderSummaryMarkdown(stored));
    }

    const points = Array.isArray(input.points) ? input.points : [];
    if (points.length === 0) {
      return toToolError(new Error("points 不能为空：摘要至少要有 1 个要点才能校验回指。"), { action: name, source: slotDir });
    }

    if (action === "check") {
      const validation = validatePoints(points, index);
      return toToolResult(
        {
          ok: true,
          slotDir,
          anchorKind: index?.kind || "none",
          anchorSource: index?.source || "",
          anchorCount: index?.count || 0,
          counts: validation.counts,
          points: validation.points,
        },
        [
          `回指校验（未落盘）：要点 ${validation.counts.total} 个 · 可回指 ${validation.counts.grounded} · 未回指 ${validation.counts.ungrounded}`,
          renderSummaryMarkdown({ brief: "", points: validation.points, counts: validation.counts, spec: validation.spec }),
        ].join("\n"),
      );
    }

    const summary = buildSummary({
      recordId: record?.id || input.recordId || "",
      artifact,
      brief: input.brief,
      points,
      model: input.model,
      promptVersion: input.promptVersion,
      index,
    });
    writeSummary(slotDir, summary);

    // 回写记录：summary 存一句话（卡片用），统计单独存（卡片显示"要点 N · 未回指 M"）
    //
    // ⭐ W4（2026-09-26）：这里**不再静默吞异常**。旧写法是
    //   `catch { /* 记录回写失败不影响摘要落盘 */ }` —— 结果就是摘要落了盘、
    //   卡片永远显示"未总结"，而没有任何人被告知。实测 3 条记录死在这条静默上。
    //   摘要该落盘仍然落盘（上一步已完成），但失败必须回到调用方眼里。
    let recordId = summary.recordId || (record ? record.id : "");
    let writebackError = "";

    // 情况二：连记录都没有 → 用产物目录现造一条，别让摘要成为孤儿。
    //   source 取 url → bvid → 槽位目录名；槽位名里带着 BV 号，canonicalId 认得出。
    if (!recordId) {
      try {
        const result = readResultJson(slotDir) || {};
        const { record: created } = upsertRecord(
          ctx,
          patchFromResult(
            { ...result, outputDir: slotDir },
            { artifactDir: slotDir, source: result.url || result.bvid || path.basename(slotDir) },
          ),
        );
        recordId = created.id;
        summary.recordId = recordId;
        // 把这个归属写回 summary.json（keepHistory=false：不因此产生历史副本）
        try { writeSummary(slotDir, summary, { keepHistory: false }); } catch { /* 补归属失败不影响回写 */ }
      } catch (e) {
        writebackError = e?.message || String(e);
      }
    }
    if (recordId && !writebackError) {
      try {
        upsertRecord(ctx, patchFromSummary(summary, { slotDir, recordId }));
      } catch (e) {
        writebackError = e?.message || String(e);
      }
    }

    const head = `摘要已保存（要点 ${summary.counts.total} 个 · 可回指 ${summary.counts.grounded} · 未回指 ${summary.counts.ungrounded}）`;
    const warn = writebackError
      ? `\n⚠️ 记录回写失败：${writebackError}\n（摘要已落盘在 ${slotDir}，但卡片不会显示"已总结"。修好后重跑一次 action=save 即可补上。）`
      : "";
    return toToolResult(
      {
        ok: true,
        slotDir,
        recordId,
        counts: summary.counts,
        summaryPath: `${slotDir}/summary.json`,
        recordWriteback: writebackError ? { ok: false, error: writebackError } : { ok: true },
        summary,
      },
      `${head}${warn}\n${renderSummaryMarkdown(summary)}`,
    );
  } catch (error) {
    return toToolError(error, { action: name, source: input.recordId || input.source || input.slotDir || null });
  }
}
