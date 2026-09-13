/**
 * intake-health.js
 * bilibili-intake — 独立健康诊断工具
 *
 * 不需要 source 参数，直接检查运行环境和各平台连通性。
 * 比通过 bilibili_video_intake(action="health") 更轻量。
 */

import { ingestBilibiliVideo, formatAgentPayload } from "../lib/service.js";
import { toToolResult } from "../lib/tool-output.js";

export const name = "intake_health";
export const description = "bilibili-intake 健康诊断 — 检查 Python 运行时、CUDA、Whisper、各平台 API 连通性。无需 source 参数。";
export const parameters = {
  type: "object",
  properties: {},
};

export async function execute(input = {}, ctx) {
  const result = await ingestBilibiliVideo({ action: "health" }, ctx);
  return toToolResult(result, formatAgentPayload(result));
}