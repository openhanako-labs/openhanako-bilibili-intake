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
import path from "node:path";
import { legacyCtx } from "./lib/legacy-ctx.js";
import { backfillFromCaptures } from "./lib/records.js";
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

  // ⭐ 2026-09-22：启动时把 captures 里还没登记成记录的采集回填一次。
  //   以前只在卡片「记录」tab 渲染**且记录为空**时触发 —— 既依赖人去点那个 tab，
  //   又只要有一条记录就再也不跑（旧采集永远睡着）。
  //
  //   ⚠️ 用 setTimeout 推迟到 apply() **返回之后**再跑：回填是同步 fs 批量活（每个揃位
  //   读写一次 records.json），夹在启动流程里会撞在宿主的启动握手窗口上（实测：夹在里面时
  //   路由/设置都注册成功、工具回调通道却是死的 → 调用回 RPC peer closed）。
  setTimeout(() => {
    try {
      const stats = backfillFromCaptures(ctx, path.join(lctx.dataDir, "captures"));
      if (stats.created || stats.updated) {
        log.info(`记录回填：扫描 ${stats.scanned}，新建 ${stats.created}，更新 ${stats.updated}，跳过/失败 ${stats.failed}`);
      }
    } catch (e) {
      log.error("记录回填失败（不影响启动）", { error: e.message });
    }
  }, 0);

  return () => {
    for (const off of disposers) {
      try { off(); } catch { /* fiber teardown */ }
    }
  };
}

export default { name, apply };
