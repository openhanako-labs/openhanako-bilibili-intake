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
// ⭐ W2（2026-09-26）：画面描述那三格要有人"看" —— 走宿主模型通道（能力位 app/models.infer），
//   不需要任何 API key。这里只把 ctx 转一手，用的时候再说。
import { bindModels } from "./lib/model-host.js";
import { backfillFromCaptures, reconcileSummaries } from "./lib/records.js";
import { pruneTrash } from "./lib/purge.js";
import { getSettings } from "./lib/settings.js";
import { registerTools } from "./lib/register-tools.js";
import { registerRoutes } from "./lib/register-routes.js";

export const name = APP_ID;

export async function apply(ctx) {
  // 把数据目录钉早一点：legacy 投影与 http 层都按它解析。
  if (ctx.dataDir) process.env.HANAKO_PLUGIN_DATA = ctx.dataDir;

  const lctx = legacyCtx(ctx);
  const log = lctx.log;
  bindModels(ctx);
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
    const capturesDir = path.join(lctx.dataDir, "captures");
    try {
      const stats = backfillFromCaptures(ctx, capturesDir);
      if (stats.created || stats.updated) {
        log.info(`记录回填：扫描 ${stats.scanned}，新建 ${stats.created}，更新 ${stats.updated}，跳过/失败 ${stats.failed}`);
      }
    } catch (e) {
      log.error("记录回填失败（不影响启动）", { error: e.message });
    }
    // ⭐ W4（2026-09-26）：摘要对账。“槽位有 summary.json 而记录里 summary 为空”
    //   就补上 —— 这是“总结过但卡片显示未总结”的旧数据自愈入口。
    //   与回填同处一个 setTimeout：都是同步 fs 批量活，不能夹在启动握手窗口里。
    try {
      const rs = reconcileSummaries(ctx, capturesDir);
      if (rs.filled || rs.relinked) {
        log.info(`摘要对账：扫描 ${rs.scanned}，补字段 ${rs.filled}，补归属 ${rs.relinked}，跳过 ${rs.skipped}，失败 ${rs.failed}`);
      }
    } catch (e) {
      log.error("摘要对账失败（不影响启动）", { error: e.message });
    }

    // ⭐ 2026-09-26：删除缓冲清理（两道闸门：保留天数 / 体积上限）。
    //   只删不写；没东西可删时一次 fs 写操作都不做。
    //   放在这个 setTimeout 里，跟回填/对账一样避开启动握手窗口。
    (async () => {
      try {
        const s = await getSettings(ctx);
        const r = pruneTrash(capturesDir, {
          maxAgeDays: Number(s.trashKeepDays) || 0,
          maxBytes: (Number(s.trashMaxMB) || 0) * 1024 * 1024,
        });
        if (r.removed) {
          log.info(`缓冲清理：删掉 ${r.removed} 项（${Math.round(r.bytes / 1024)}KB），原因：${r.reasons.join("、")}；剩余 ${r.kept} 项`);
        }
      } catch (e) {
        log.error("缓冲清理失败（不影响启动）", { error: e.message });
      }
    })();
  }, 0);

  return () => {
    for (const off of disposers) {
      try { off(); } catch { /* fiber teardown */ }
    }
  };
}

export default { name, apply };
