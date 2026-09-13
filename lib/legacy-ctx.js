/**
 * lib/legacy-ctx.js — 把 v2 的 App ctx 投影成 v1 插件 ctx 的形状。
 *
 * 为什么需要它：lib/*.js、tools/*.js、http/intake.js 共 ~80KB，但只用到
 * ctx 的 pluginDir / dataDir / config 三类成员。与其把调用点散落改一遍
 * （改错一处就是一个新 bug），不如在一个地方做投影：
 *
 *   v1 写法                    v2 真身
 *   ─────────────────────────  ────────────────────────────────────────
 *   ctx.pluginDir           →  App 包根目录（安装目录，只读）
 *   ctx.dataDir             →  ctx.dataDir（v2 已是 App 专属目录，直接用）
 *   ctx.pluginId            →  manifest 的 id
 *   ctx.config.get(k)       →  ctx.config（异步；见下方 ⚠️）
 *   ctx.log.info/warn/error →  ctx.logger（吞掉 Promise，老代码不 await）
 *
 * ⚠️ config 是本插件最隐蔽的一处断层。
 * v1 的 `ctx.config.get(key)` 是**同步**的，lib/settings.js 就是同步读它。
 * v2 的 `ctx.config.get` 返回 Promise —— 若不处理，`readConfig` 会拿到一个
 * Promise，经 stringify() 后落成 ""，于是**全部设置静默退回默认值**，
 * 表现为「设置页改了没用」，而不是报错。
 * 处理方式：lib/settings.js 改成 async，调用方 await（见 utils.readConfigSync 的注释）。
 */

import path from "node:path";
import { APP_ID, PLUGIN_ROOT } from "./env.js";

/**
 * 把 logger 包装成「调用即忘、绝不抛」的 v1 风格 log。
 *
 * v2 的 `ctx.logger.info(format, ...param)` 把额外参数交给宿主格式器，
 * 实测不会落到日志行里（只打 format）；v1 的 `ctx.log.*(msg, data)` 会一起打。
 * 所以自己拼串，否则 `log.warn("失败", { error })` 会变成半句话。
 */
function stringify(v) {
  if (v instanceof Error) return v.message;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function makeLog(logger) {
  const call = (level) => (msg, ...rest) => {
    try {
      const fn = logger?.[level];
      if (typeof fn !== "function") return;
      const text = rest.length ? `${msg} ${rest.map(stringify).join(" ")}` : String(msg);
      // v2 logger 返回 Promise；老代码不会 await，必须自己兜住 rejection。
      const r = fn.call(logger, text);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch { /* 日志失败不影响业务 */ }
  };
  return { info: call("info"), warn: call("warn"), error: call("error"), debug: call("debug") };
}

/**
 * @param {object} ctx v2 App ctx
 * @returns {object} 兼具 v1 成员与 v2 真实成员的投影对象
 */
export function legacyCtx(ctx) {
  return {
    // ── v2 真实成员：原样透传 ──
    ...ctx,
    appId: APP_ID,

    // ── v1 投影 ──
    pluginId: APP_ID,
    pluginDir: PLUGIN_ROOT,
    dataDir: ctx.dataDir || process.env.HANAKO_PLUGIN_DATA || "",
    log: makeLog(ctx.logger),
  };
}
