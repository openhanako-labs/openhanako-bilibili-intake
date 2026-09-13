/**
 * bilibili-intake-v2/index.js — v2 App 入口。
 *
 * 这是 hanako-bilibili-intake（v1 插件）迁到 v2 App 的第一阶段产物：
 * 把 JS 外壳原样搬过来、接上 v2 的注册面，Python 侧一行未改。
 *
 * 前端 / 后端的边界：
 *   ┌─ AppHost（宿主应用的 Node 子进程，Node 权限模型内）──────────┐
 *   │  · ctx.tools.register()   四个工具（不加前缀）                 │
 *   │  · ctx.routes.register()  /intake 页面要调的后端 API           │
 *   │  ✗ 默认没有子进程能力 → 需 app/process.spawn                   │
 *   └───────────────┬──────────────────────────────────────────────┘
 *                   │ child_process.spawn（获准后）
 *   ┌───────────────▼──────────────────────────────────────────────┐
 *   │  python/collector.py（独立进程）                               │
 *   │  · 不继承 Node 权限模型 —— 网络与文件范围不受 AppHost 约束       │
 *   │  · 所以 manifest 里的 network 声明对本 App 只是形式申报          │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * 与 v1 的关键差异（都已在本目录内处理完）：
 *   1) 工具必须编程式注册（v1 靠 manifest contributes.tools）→ lib/register-tools.js
 *   2) 路由必须走 ctx.routes.register，且顶级 routes/ 与它互斥 → 文件改坐 http/
 *   3) ctx.config.get 从同步变异步，不处理会让设置**静默**全退回默认值 → lib/settings.js
 *   4) 工具名 v2 不加前缀，与仍在跑的 v1 插件不撞名
 */

import { APP_ID } from "./lib/env.js";
import { legacyCtx } from "./lib/legacy-ctx.js";
import { registerTools } from "./lib/register-tools.js";
import { registerRoutes } from "./lib/register-routes.js";

export const name = APP_ID;

export async function apply(ctx) {
  // 把数据目录钉早一点：legacy 投影与 http 层都按它解析。
  if (ctx.dataDir) process.env.HANAKO_PLUGIN_DATA = ctx.dataDir;

  const lctx = legacyCtx(ctx);
  const log = lctx.log;
  log.info(`${APP_ID} v2 loaded`, { dataDir: lctx.dataDir, pluginDir: lctx.pluginDir });

  const disposers = [];

  try {
    disposers.push(registerTools(ctx, lctx));
  } catch (e) {
    log.error("工具注册整体失败", { error: e.message });
  }

  try {
    const offRoutes = await registerRoutes(ctx, lctx);
    if (typeof offRoutes === "function") disposers.push(offRoutes);
  } catch (e) {
    log.error("路由注册失败", { error: e.message });
  }

  return () => {
    for (const off of disposers) {
      try { off(); } catch { /* fiber teardown */ }
    }
  };
}

export default { name, apply };
