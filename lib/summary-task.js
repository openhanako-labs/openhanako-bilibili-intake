/**
 * lib/summary-task.js — 给「采集后写总结」找一个站得住的调用范围。
 *
 * ## 原来为什么每一次都失败
 *
 * 2026-09-26 那版的形态是：采集请求一返回，就在后台 `void autoSummarize(...)`。
 * 看着合理（模型一次几十秒，不能占着请求），实际每一次都死。宿主日志从那天起到
 * 今天全是同一句：
 *
 *     自动总结未完成：…（App invocation expired or belongs to another App）
 *
 * 缺的那句话在宿主的模型通道契约里：**「调用范围来自有效 callToken 或本应用的
 * 活动 taskId；两者都不传时明确归属 App 自己」**。请求一返回，那次 invocation
 * 就被回收，后台 promise 再打 `ctx.models.*` 就没有归属。
 * 于是 22 条记录里 21 条 summary 是空的，卡片整齐地显示「未写总结」，
 * 而没有任何一处告诉用户「其实是写失败了」—— 这就是「卡片不显示总结内容」的真相。
 *
 * ## 现在的形态
 *
 * 两个事实决定了形状：
 *   · `ctx.models.stream()` **吃** taskId —— 活动任务的 id 就是合法调用范围；
 *   · `ctx.models.list()` **不吃**任何参数 —— 取清单必须还在调用窗口内。
 *
 * 所以：
 *   ① 还在窗口内时先把模型选好（`pickChatModel`），别留给后台；
 *   ② 采集方有三种，各走各的：
 *      · 工具前台（bilibili_video_intake，不带 background）
 *        → execute 还没返回，invocation 是活的 → **await** 就地跑，不需要 taskId。
 *        回执里的 autoSummary 从此是真结果，不是 {pending:true} 的谎话。
 *      · 工具后台（background:true）
 *        → submitBackground 建的那个任务全程处于 running，就是「本应用的活动任务」
 *        → 把它的 taskId 交给模型通道，仍然 await 在 ingest 里（后台没有 30s 封顶）。
 *      · 卡片路由 / 卡片「补写总结」按钮
 *        → 请求必须在 30s 内返回，等不起 → 自己建一个 scope:"app" 的持久任务，
 *          出窗之后带着这个 taskId 在后台跑，跑完把它结掉。
 *
 * 无论哪条路，结果都写回记录：summaryStatus = pending / ok / failed / no-text / skipped
 * + summaryNote。delivery:"none" —— 内部流水线，不往任何对话里插消息。
 * 能力位复用 manifest 已有的 app/tasks.manage + app/models.infer，不新增授权。
 */
import { autoSummarize, pickChatModel } from "./auto-summary.js";
import { readRecords, sameDirPath, upsertRecord } from "./records.js";

/** 任务通道是否可用（卡片路由那条路需要它）。 */
export function summaryTaskAvailable(ctx) {
  return typeof ctx?.tasks?.create === "function";
}

/**
 * 把总结状态写进记录。卡片按 summaryStatus 说话，不再只有一行「未写总结」。
 * recordId 缺失时按产物目录反查（与 intake_summary 同一套定位规则）。
 */
export function markSummary(ctx, { recordId = "", slotDir = "", status = "", note = "", taskId = "" } = {}) {
  try {
    let id = recordId || "";
    if (!id && slotDir) {
      const hit = readRecords(ctx).find((r) => r.artifactDir && sameDirPath(r.artifactDir, slotDir));
      id = hit?.id || "";
    }
    if (!id) return null;
    const { record } = upsertRecord(ctx, {
      id,
      summaryStatus: status || undefined,
      summaryNote: note || undefined,
      summaryTaskId: taskId || undefined,
    });
    return record;
  } catch {
    // 状态写不进去不该拖垮总结本身；下次启动对账还有兜底。
    return null;
  }
}

/** 把 autoSummarize 的结果映射成记录上的状态。 */
function applyOutcome(ctx, { recordId, slotDir, taskId, r }) {
  const who = { recordId: r?.recordId || recordId, slotDir, taskId };
  if (r?.ok) markSummary(ctx, { ...who, status: "ok", note: `要点 ${r.counts?.total ?? 0} · 回指 ${r.counts?.grounded ?? 0}` });
  else if (r?.skipped) markSummary(ctx, { ...who, status: r.noText ? "no-text" : "skipped", note: r.reason || "跳过" });
  else markSummary(ctx, { ...who, status: "failed", note: r?.error || r?.reason || "未知原因" });
  ctx?.log?.info?.(`自动总结${r?.ok ? "完成" : "未完成"}：${slotDir}`
    + (r?.ok ? `（要点 ${r.counts?.total ?? 0} · 回指 ${r.counts?.grounded ?? 0}）`
             : `（${r?.reason || r?.error || "未知"}）`));
  return r;
}

/**
 * 就地跑一次总结（await）。
 *
 * @param {string} taskId 交给模型通道的范围凭证；留空表示"靠当前调用窗口的归属"。
 * @param {boolean} settle 这个任务是不是本次总结建的（是才结它的终态）。
 */
export async function runSummaryNow(ctx, {
  slotDir = "", recordId = "", model = "", picked = null, taskId = "", settle = false,
} = {}) {
  if (!slotDir) return { ok: false, error: "没有产物目录" };
  // 清单必须在调用窗口内取：出窗之后再 list() 就撞回 expired。
  let chosen = picked && picked.provider && picked.model ? picked : null;
  if (!chosen) { try { chosen = await pickChatModel(model, { taskId }); } catch { chosen = null; } }

  markSummary(ctx, { recordId, slotDir, status: "pending", taskId });
  const r = await autoSummarize(ctx, { slotDir, recordId, taskId, picked: chosen });
  applyOutcome(ctx, { recordId, slotDir, taskId, r });

  if (taskId && settle) {
    try {
      if (r?.ok) await ctx.tasks.complete(taskId, { ok: true, summary: { slotDir, recordId, points: r.counts?.total ?? 0 } });
      else if (r?.skipped) await ctx.tasks.complete(taskId, { ok: true, skipped: true, reason: r.reason || "跳过" });
      else await ctx.tasks.fail(taskId, r?.error || r?.reason || "未知原因");
    } catch { /* 结算失败不影响已经落盘的 summary 与记录 */ }
  }
  return r;
}

/**
 * 提交一次总结给后台：建自己的持久任务 → 带着 taskId 在后台跑 → 自己结掉。
 * 卡片路由与卡片「补写总结」按钮走这条路（30s 封顶，等不起模型）。永远不抛。
 */
export async function submitAutoSummary(ctx, { slotDir = "", recordId = "", title = "", model = "", picked: preset = null } = {}) {
  if (!slotDir) return { ok: false, error: "没有产物目录" };

  // 窗口内先把模型挑好，随任务一起交给后台。后台 detached 上下文里再取清单未必能成，
  // 所以调用方能把手上已有的挑选结果递进来（工具后台通道就是这么做的）。
  let picked = preset && preset.provider && preset.model ? preset : null;
  if (!picked) { try { picked = await pickChatModel(model); } catch { picked = null; } }

  if (!summaryTaskAvailable(ctx)) {
    // 没任务通道：只能就地试。仍然可能受 invocation 生命周期限制，
    // 但至少状态一定会写进记录，不再静默。
    ctx?.log?.warn?.("总结任务通道不可用，就地执行（可能受调用生命周期限制）");
    void runSummaryNow(ctx, { slotDir, recordId, picked });
    return { ok: false, error: "宿主未提供任务通道（app/tasks.manage）", fallback: true };
  }

  let taskId = "";
  try {
    const task = await ctx.tasks.create({
      scope: "app",                      // 内部工作，不绑任何会话
      label: `写总结 ${String(title || slotDir.split(/[\\/]/).pop() || "").slice(0, 40)}`,
      delivery: "none",                  // 不往对话里插消息
      metadata: { kind: "auto-summary", slotDir, recordId },
    });
    taskId = task?.taskId || task?.id || "";
  } catch (e) {
    void runSummaryNow(ctx, { slotDir, recordId, picked });
    return { ok: false, error: String(e?.message || e), fallback: true };
  }
  if (!taskId) {
    void runSummaryNow(ctx, { slotDir, recordId, picked });
    return { ok: false, error: "任务没有返回 taskId", fallback: true };
  }

  markSummary(ctx, { recordId, slotDir, status: "pending", taskId });
  void runSummaryNow(ctx, { slotDir, recordId, taskId, picked, settle: true })
    .then((r) => {
      // runSummaryNow 内部已经结过任务；这里只兜住「整个 promise 被拒」这一种意外。
      if (!r) return;
    })
    .catch((e) => {
      const msg = String(e?.message || e);
      ctx?.log?.error?.(`总结任务异常退出：${taskId} ${msg}`);
      markSummary(ctx, { recordId, slotDir, status: "failed", note: msg, taskId });
      try { void ctx.tasks.fail(taskId, msg); } catch { /* 已经记在记录上了 */ }
    });
  return { ok: true, taskId };
}
