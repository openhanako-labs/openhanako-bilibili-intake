/**
 * lib/env.js — App 身份与路径的单一来源。
 *
 * v2 与 v1 的两处硬差异收敛在这里：
 *   1) 安装目录在 v2 **只读**（Node 权限模型约束的是 AppHost 进程；由它 spawn 出的
 *      python 子进程反而没有这层限制 —— 见 hana-app-creator「外部命令不自动继承
 *      Node Permission Model」）。所以 JS 侧一切写入必须落到 ctx.dataDir。
 *   2) 本插件的 JS 只用到 ctx 的两个字段：pluginDir / dataDir，且 dataDir 是
 *      **直接**用的（`path.join(dataDir, ".runtime")`），不像 mail 那样需要
 *      「报成父目录」的反向偏移。所以投影层可以做得很薄。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** 应用 id：必须与 manifest.json 的 id 一致，也必须是安装目录名。 */
export const APP_ID = "bilibili-intake-v2";

/** App 包根目录（= 安装目录，只读）。'lib/env.js' -> '..' */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 静态 UI 树根（v2 卡片 route 解析到 /api/apps/<id>/ui<route>）。 */
export const UI_DIR = path.join(PLUGIN_ROOT, "ui");

/** Python 采集器目录。 */
export const PYTHON_DIR = path.join(PLUGIN_ROOT, "python");

/** HANA_HOME：优先从 ctx.dataDir 反推，不依赖环境变量（AppHost 的 env 是白名单）。 */
export function hanakoHome() {
  const dataDir = process.env.HANAKO_PLUGIN_DATA;
  if (dataDir) return path.dirname(path.dirname(dataDir));
  return process.env.HANA_HOME || path.join(process.env.USERPROFILE || "", ".hanako");
}
