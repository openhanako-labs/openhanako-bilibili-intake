/**
 * intake-routing.js
 * bilibili-intake — 路由状态诊断工具
 */

import { ingestBilibiliVideo, formatAgentPayload } from "../lib/service.js";
import { toToolResult } from "../lib/tool-output.js";

export const name = "intake_routing";
export const description = "查看多后端路由状态 — 检查各平台的后端配置和冷却状态。";
export const parameters = {
  type: "object",
  properties: {},
};

export async function execute(input = {}, ctx) {
  const result = await ingestBilibiliVideo({ action: "routing-status" }, ctx);
  return toToolResult(result, formatAgentPayload(result));
}