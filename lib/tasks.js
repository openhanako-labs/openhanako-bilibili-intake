/**
 * lib/tasks.js — 把「会撞穿 180 秒」的采集丢到后台。
 *
 * 为什么需要它：lib/runtime.js 的 SPAWN_TIMEOUT_MS 是 180_000（v1 遗留，与路由层
 * execFileSync 对齐）。B站有字幕时走 yt-dlp 直连官方字幕，几十秒就完；但**无字幕
 * 视频要跑 Whisper 兜底转写**，CPU 上十分钟的片子几乎必然撞穿 —— 撞穿的代价是
 * 那一整次采集全部白费，只能重跑。
 *
 * 用的是官方文档给的形态（「后台任务与审批」小节的示例）：在工具 execute 里
 * `create` 一个任务、把重活丢进 void async IIFE、立刻返回 taskId。不注册
 * `ctx.tasks.registerHandler` —— 那是给 handler/schedule 自己创建的任务用的，
 * 这里不需要。
 *
 * 需要能力：app/tasks.manage（创建与结算）+ app/session.start-turn（唤醒会话）。
 */

function messageFor(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {object} input 工具的原始入参
 * @param {object} ctx   legacyCtx 投影（含 ctx.tasks）
 * @param {object} deps  { ingest, formatAgentPayload }
 * @returns {Promise<object>} 立即返回的工具结果
 */
export async function submitBackground(input, ctx, deps) {
  const { ingest, formatAgentPayload } = deps;

  // 没有 callToken 就没有来源会话，投递无处可去 —— 只能前台跑。
  const tasks = ctx?.tasks;
  if (!tasks?.create) {
    return deps.toToolError(new Error("本应用没有后台任务能力（ctx.tasks 不可用）。"), {
      action: "bilibili_video_intake",
      hint: "把 background 去掉，前台执行。",
    });
  }

  const label = input.source
    ? `采集 ${String(input.source).slice(0, 60)}`
    : `采集 ${input.searchKeyword || input.mode || "任务"}`;

  let task;
  try {
    task = await tasks.create({ label, delivery: "next-step" });
  } catch (error) {
    return deps.toToolError(error, {
      action: "bilibili_video_intake",
      hint: "后台任务创建被拒。需要 app/tasks.manage（唤醒会话还要 app/session.start-turn）授权。",
    });
  }

  const taskId = task?.taskId || task?.id;

  void (async () => {
    try {
      const result = await ingest(input, ctx);
      const summary = formatAgentPayload(result);
      await tasks.complete(taskId, {
        ok: true,
        summary,
        outputDir: result?.outputDir || null,
        title: result?.title || null,
        transcriptSource: result?.transcriptSource || null,
      });
    } catch (error) {
      try {
        await tasks.fail(taskId, messageFor(error));
      } catch (recordError) {
        ctx?.log?.error?.(`无法记录后台任务 ${taskId} 的失败`, { error: messageFor(recordError) });
      }
    }
  })().catch((error) => {
    ctx?.log?.error?.(`后台任务 ${taskId} 异常`, { error: messageFor(error) });
  });

  return {
    content: [{
      type: "text",
      text: typeof deps.startText === "function"
        ? deps.startText(taskId)
        : `已在后台开始采集（taskId: ${taskId}）。\n`
          + `完成后结果会自动回到这个对话 —— 无字幕的长视频要跑 Whisper，可能要几分钟到十几分钟，不用等着。\n`
          + `期间可以继续别的事。`,
    }],
  };
}
