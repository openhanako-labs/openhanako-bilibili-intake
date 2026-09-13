import { BiliIntakeError } from "../lib/errors.js";
import { ingestBilibiliVideo, formatAgentPayload } from "../lib/service.js";
import { toToolError, toToolResult } from "../lib/tool-output.js";
import { submitBackground } from "../lib/tasks.js";

export const name = "bilibili_video_intake";
export const description = "多平台内容摄取引擎 — 支持 B站/小红书/微博/知乎/贴吧/抖音/快手。统一接口提供单视频抓取、搜索、批量采集、元数据/评论/创作者/音频/转写。";
export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["", "health", "routing-status"],
      description: "特殊操作：health=健康诊断, routing-status=路由状态（空=正常采集）",
    },
    platform: {
      type: "string",
      enum: ["auto", "bilibili", "xhs", "douyin", "kuaishou", "weibo", "zhihu", "tieba"],
      description: "目标平台（默认 auto 从 URL 自动检测）",
      default: "auto",
    },
    mode: {
      type: "string",
      enum: ["single", "search", "batch"],
      description: "操作模式：single(默认) 单视频抓取 / search 仅搜索列表 / batch 搜索+批量抓取",
    },
    source: {
      type: "string",
      description: "BV号/av号/B站链接/小红书笔记ID或链接/微博状态ID。search/batch 模式时可省略。",
    },
    searchKeyword: {
      type: "string",
      description: "搜索关键词（mode=search/batch 时必填）",
    },
    searchLimit: {
      type: "number",
      description: "搜索返回条数上限，默认 10，最大 50（mode=search/batch 时使用）",
    },
    searchSort: {
      type: "number",
      enum: [0, 1, 2, 3],
      description: "搜索排序：0=综合(默认) 1=最多播放/点击 2=最新发布 3=最多互动",
    },
    page: {
      type: "number",
      description: "可选分P页码；source 已经包含 p 参数时通常不需要。",
    },
    withComments: {
      type: "boolean",
      description: "是否采集评论（默认 true，单视频模式）",
      default: true,
    },
    withSubComments: {
      type: "boolean",
      description: "是否拉取二级评论（默认 true）",
      default: true,
    },
    withCreator: {
      type: "boolean",
      description: "是否同时采集创作者/作者主页信息（默认 false）",
      default: false,
    },
    commentLimit: {
      type: "number",
      description: "评论采集上限（默认 50）",
    },
    noAudio: {
      type: "boolean",
      description: "仅采集元数据/评论，不下载音频（B站有效，默认 false）",
      default: false,
    },
    forceTranscribe: {
      type: "boolean",
      description: "即使平台字幕存在，也强制使用 Whisper 转写。",
    },
    whisperModel: {
      type: "string",
      description: "可选覆盖配置中的 Whisper 模型名；默认 base。",
    },
    whisperDevice: {
      type: "string",
      description: "可选覆盖配置中的转写设备：auto / cuda / cpu。默认 auto，会优先尝试 GPU。",
    },
    whisperLanguage: {
      type: "string",
      description: "可选覆盖配置中的 Whisper 语言，如 zh / en；留空自动识别。",
    },
    returnTextLimit: {
      type: "number",
      description: "可选覆盖回传给 Agent 的最大正文字符数。",
    },
    cookiesDir: {
      type: "string",
      description: "统一 cookies 存储目录路径（可选）。如果提供，collector 会自动从该目录加载对应平台的 cookies。",
    },
    login: {
      type: "string",
      enum: ["", "bilibili", "xhs", "weibo", "tieba", "zhihu", "douyin", "kuaishou"],
      description: "启动 Playwright 扫码登录指定平台并保存 cookies（需要人工扫二维码）。",
    },
    logout: {
      type: "string",
      description: "删除指定平台的本地 cookies。",
    },
    listLogins: {
      type: "boolean",
      description: "列出所有已保存 cookies 的平台状态。",
    },
    importCookies: {
      type: "string",
      description: "从 Netscape cookies.txt 导入，格式：<platform>:<path>。",
    },
    extractCookies: {
      type: "string",
      description: "从浏览器提取 cookies，格式：<platform>:<browser>，browser=edge|chrome|firefox。",
    },

    // v2：无字幕视频的 Whisper 兜底会撞穿 runtime 的 180s 上限，交给后台跑。
    background: {
      type: "boolean",
      description: "丢到后台执行，立刻返回 taskId，完成后结果自动回到对话。无字幕的长视频建议开启（Whisper 转写可能超过 3 分钟）。",
      default: false,
    },

    // Visual analysis (v0.3+)
    visual: {
      type: "boolean",
      description: "启用视觉帧分析（默认 false，关闭）",
      default: false,
    },
    visionBackend: {
      type: "string",
      enum: ["siliconflow", "openai", "qwen-local"],
      description: "视觉模型后端（默认 siliconflow）",
      default: "siliconflow",
    },
    frameDetail: {
      type: "string",
      enum: ["efficient", "balanced", "token-burner"],
      description: "帧提取粒度（默认 balanced）",
      default: "balanced",
    },
    frameResolution: {
      type: "number",
      description: "帧宽度像素（默认 512）",
      default: 512,
    },
    visualPrompt: {
      type: "string",
      description: "自定义视觉分析提示词",
    },
    visionApiKey: {
      type: "string",
      description: "视觉模型 API key（覆盖配置）",
    },
    visionModel: {
      type: "string",
      description: "视觉模型名称（默认 Qwen/Qwen3.5-397B-A17B）",
    },
    visionBaseUrl: {
      type: "string",
      description: "视觉 API 基础 URL（默认 SiliconFlow）",
    },
  },
};

export async function execute(input = {}, ctx) {
  try {
    const mode = input.mode || "single";

    // Health/routing — skip source validation
    if (input.action === "health" || input.action === "routing-status") {
      const result = await ingestBilibiliVideo(input, ctx);
      return toToolResult(result, formatAgentPayload(result));
    }

    // v2 后台通道：换一条不阻塞模型回合的路。
    if (input.background === true) {
      return await submitBackground(input, ctx, {
        ingest: ingestBilibiliVideo,
        formatAgentPayload,
        toToolError,
      });
    }

    // Validate required fields based on mode
    if (mode !== "single" && !input.searchKeyword && !input.source) {
      return toToolError(new Error("search/batch 模式需要 searchKeyword 或 source。"), {
        action: name,
        source: input.source || null,
        mode,
        platform: input.platform || "auto",
      });
    }

    if (mode === "single" && (!input.source || typeof input.source !== "string")) {
      throw new BiliIntakeError("single 模式下 source 必须是 BV 号或链接。", { code: "INVALID_SOURCE" });
    }

    const result = await ingestBilibiliVideo(input, ctx);
    return toToolResult(result, formatAgentPayload(result));
  } catch (error) {
    return toToolError(error, {
      action: name,
      source: input.source || null,
      mode: input.mode || "single",
      platform: input.platform || "auto",
    });
  }
}
