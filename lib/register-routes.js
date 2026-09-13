/**
 * lib/register-routes.js — 把 v1 的 HTTP 后端挂到 v2 的路由 app 上。
 *
 * 为什么文件在 `http/` 而不在 `routes/`：v2 把顶级 `routes/` 目录当成另一种
 * 路由来源，与 `ctx.routes.register()` **互斥** —— 两边同时存在，整个应用在
 * 装载时直接 failed。改成 `http/` 名字不同，就不撞那条规则。
 *
 * `http/intake.js` 的默认导出形状 (app, ctx) 与 v1 完全一致，可直接复用。
 * 公开前缀：/api/apps/bilibili-intake-v2/routes
 */

import registerIntake from "../http/intake.js";

export async function registerRoutes(ctx, lctx) {
  const dispose = await ctx.routes.register((app) => {
    registerIntake(app, lctx);
  });
  lctx.log.info("intake 后端路由已挂载", { prefix: "/api/apps/bilibili-intake-v2/routes" });
  return dispose;
}
