/**
 * lib/register-tools.js — 把 v1 形状的工具模块注册进 v2 工具表。
 *
 * 两处契约差异在这里一次抹平，工具模块本身不改：
 *   1) v1 靠 manifest 的 contributes.tools[] 声明；v2 必须编程式 ctx.tools.register()。
 *   2) v1 工具导出 `execute(input, ctx)` 双参；v2 只调一次，payload 里带
 *      `context: { sessionPath, messageId, messageText, callToken }`。
 *
 * ⚠️ 工具名：v1 宿主会给工具名加 `{插件id}_` 前缀（所以线上看到的是
 * `hanako-bilibili-intake_intake_health`），**v2 不加前缀**。
 * 这里注册的是模块自己导出的裸名（`intake_health` 等），因此与仍在跑的
 * v1 插件**不撞名**，两者可以并存。若哪天想把名字改成带前缀的，
 * 就会与 v1 冲突并让整个 app failed —— 别改。
 */

import * as videoIntake from "../tools/bilibili_video_intake.js";
import * as knowledgeMap from "../tools/generate_knowledge_map.js";
import * as intakeHealth from "../tools/intake-health.js";
import * as intakeRouting from "../tools/intake-routing.js";

const MODULES = [videoIntake, knowledgeMap, intakeHealth, intakeRouting];

/**
 * @param {object} ctx v2 App ctx
 * @param {object} lctx legacyCtx 投影出的 v1 形状 ctx
 * @returns {() => void} disposer
 */
export function registerTools(ctx, lctx) {
  const offs = [];

  for (const mod of MODULES) {
    const tool = {
      name: mod.name,
      description: mod.description,
      parameters: mod.parameters,
      // v2 单参调用 → 还原成 v1 的 (input, ctx)
      async execute(payload = {}) {
        const { context, ...input } = payload || {};
        return await mod.execute(input, lctx);
      },
    };
    try {
      const off = ctx.tools.register(tool);
      if (typeof off === "function") offs.push(off);
    } catch (e) {
      lctx.log.error(`工具注册失败: ${mod.name}`, { error: e.message });
    }
  }

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* fiber teardown */ }
    }
  };
}
