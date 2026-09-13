import path from "node:path";
import { BiliIntakeError } from "./errors.js";
import { getSettings } from "./settings.js";
import { prepareRuntime, runCollector } from "./runtime.js";
import { ensureDir, hashText, normalizeBilibiliSource, sanitizePathSegment, truncateText } from "./utils.js";

export async function ingestBilibiliVideo(input, ctx) {
  // Health check / routing status — bypass full pipeline
  if (input.action === "health" || input.action === "routing-status") {
    return ingestAction(input, ctx);
  }

  if (input.mode && input.mode !== "single") {
    return ingestMulti(input, ctx);
  }

  const source = normalizeBilibiliSource(input.source, input.page);
  if (!source) {
    throw new BiliIntakeError("source 不能为空，必须是 BV 号或 B站/小红书链接。", { code: "MISSING_SOURCE" });
  }

  const settings = await getSettings(ctx);
  const runtime = await prepareRuntime(ctx, settings);
  const slotName = buildSlotName(source, input.page);
  const outputDir = await ensureDir(path.join(runtime.capturesRoot, slotName));
  const payload = {
    source,
    mode: "single",
    platform: input.platform || "auto",
    page: input.page,
    outputDir,
    whisperModel: input.whisperModel || settings.whisperModel,
    whisperDevice:
      typeof input.whisperDevice === "string" && input.whisperDevice.trim()
        ? input.whisperDevice.trim()
        : settings.whisperDevice,
    whisperLanguage: input.whisperLanguage ?? settings.whisperLanguage,
    forceTranscribe: input.forceTranscribe === true,
    returnTextLimit: typeof input.returnTextLimit === "number" && Number.isFinite(input.returnTextLimit)
      ? input.returnTextLimit
      : settings.maxReturnedTranscriptChars,
    withComments: input.withComments !== false,
    withSubComments: input.withSubComments !== false,
    withCreator: input.withCreator === true,
    commentLimit: input.commentLimit || 50,
    noAudio: input.noAudio === true,
    cookiesDir: input.cookiesDir || settings.cookiesDir || "",
    login: input.login || "",
    loginTimeout: input.loginTimeout || 180,
    logout: input.logout || "",
    listLogins: input.listLogins === true,
    importCookies: input.importCookies || "",
    extractCookies: input.extractCookies || "",

    // Visual analysis params (v0.3+)
    visual: input.visual === true,
    visionBackend: input.visionBackend || "hanako",
    frameDetail: input.frameDetail || "balanced",
    frameResolution: input.frameResolution || 512,
    visualPrompt: input.visualPrompt || "",
    visionApiKey: input.visionApiKey || "",
    visionModel: input.visionModel || "",
    visionBaseUrl: input.visionBaseUrl || "",
  };

  const result = await runCollector(runtime, payload);
  result.ok = true;
  result.requested = {
    source: input.source,
    normalizedSource: source,
    mode: "single",
    page: input.page || null,
    forceTranscribe: payload.forceTranscribe,
    whisperModel: payload.whisperModel,
    whisperDevice: payload.whisperDevice,
    whisperLanguage: payload.whisperLanguage || null,
  };
  result.runtime = {
    mode: runtime.selectedMode,
    fallbackUsed: runtime.fallbackUsed === true,
    candidateModes: runtime.candidateModes,
    venvDir: runtime.venvDir,
  };
  result.agentTextPreview = truncateText(result.transcriptText || "", payload.returnTextLimit);
  return result;
}

async function ingestMulti(input, ctx) {
  const settings = await getSettings(ctx);
  const runtime = await prepareRuntime(ctx, settings);
  const outputDir = await ensureDir(path.join(runtime.capturesRoot, `search-${hashText(input.searchKeyword || "search")}`));

  const payload = {
    mode: input.mode,
    platform: input.platform || "auto",
    source: input.source || "",
    searchKeyword: input.searchKeyword || "",
    searchLimit: input.searchLimit || 10,
    searchSort: input.searchSort !== undefined ? input.searchSort : 0,
    page: input.page || 0,
    outputDir,
    returnTextLimit: typeof input.returnTextLimit === "number" && Number.isFinite(input.returnTextLimit)
      ? input.returnTextLimit
      : settings.maxReturnedTranscriptChars,
    withComments: input.withComments !== false,
    withSubComments: input.withSubComments !== false,
    commentLimit: input.commentLimit || 50,
    cookiesDir: input.cookiesDir || settings.cookiesDir || "",
    login: input.login || "",
    loginTimeout: input.loginTimeout || 180,
    logout: input.logout || "",
    listLogins: input.listLogins === true,
    importCookies: input.importCookies || "",
    extractCookies: input.extractCookies || "",
  };

  const result = await runCollector(runtime, payload);
  result.ok = true;
  result.requested = {
    source: input.source || null,
    mode: input.mode,
    searchKeyword: input.searchKeyword || null,
    searchLimit: input.searchLimit || 10,
    searchSort: input.searchSort !== undefined ? input.searchSort : 0,
  };
  result.runtime = {
    mode: runtime.selectedMode,
    fallbackUsed: runtime.fallbackUsed === true,
    candidateModes: runtime.candidateModes,
    venvDir: runtime.venvDir,
  };
  return result;
}

function buildSlotName(source, page) {
  const url = new URL(source);
  const pageSuffix = page && Number(page) > 1 ? `-p${page}` : "";
  const token = sanitizePathSegment(url.pathname.split("/").filter(Boolean).pop() || "video");
  return `${token}${pageSuffix}-${hashText(source)}`;
}

export async function ingestAction(input, ctx) {
  const settings = await getSettings(ctx);
  const runtime = await prepareRuntime(ctx, settings);
  const payload = {
    action: input.action,
    outputDir: runtime.capturesRoot,
    platform: input.platform || "auto",
    cookiesDir: input.cookiesDir || settings.cookiesDir || "",
  };
  const result = await runCollector(runtime, payload);
  result.action = input.action;
  return result;
}

export function formatAgentPayload(result) {
  // Health check / routing status results
  if (result.action === "health" || result.action === "routing-status") {
    return JSON.stringify(result, null, 2);
  }

  // Search / batch mode
  if (result.requested?.mode === "search" || result.requested?.mode === "batch") {
    const parts = [
      `搜索模式: ${result.requested.mode}`,
      `关键词: ${result.requested.searchKeyword || ""}`,
      `总结果: ${result.total || 0}`,
    ];
    if (Array.isArray(result.results)) {
      for (const r of result.results.slice(0, 10)) {
        parts.push(`  - ${r.title || "?"} (${r.author || "?"}) ${r.url || ""}`);
      }
      if (result.results.length > 10) {
        parts.push(`  ... 还有 ${result.results.length - 10} 条结果`);
      }
    }
    parts.push(`工作目录: ${result.outputDir || result.requested?.outputDir || ""}`);
    return parts.join("\n");
  }

  // Xiaohongshu result
  if (result._xhs || result.detail?._xhs) {
    const detail = result.detail || result;
    const parts = [
      "小红书笔记采集完成。",
      `标题: ${detail.title || ""}`,
      `作者: ${detail.author?.nickname || detail.author || ""}`,
    ];
    if (detail.description) parts.push(`描述: ${detail.description}`);
    if (detail.interact_info) {
      parts.push(`点赞: ${detail.interact_info.likes || 0}  收藏: ${detail.interact_info.collects || 0}  评论: ${detail.interact_info.comments || 0}`);
    }
    if (detail.note_type) parts.push(`类型: ${detail.note_type}`);
    if (detail.images?.length) parts.push(`图片数: ${detail.images.length}`);
    if (!detail.ok) parts.push(`注意: ${detail.error || "内容受限"}`);
    parts.push(`链接: ${detail.url || ""}`);
    parts.push(`工作目录: ${result.outputDir || ""}`);
    return parts.join("\n");
  }

  // Bilibili single video (original logic)
  const parts = [
    "B站视频采集完成。",
    `标题: ${result.title || ""}`,
  ];

  if (result.uploader) {
    parts.push(`UP主: ${result.uploader}`);
  }
  if (result.description) {
    parts.push(`简介: ${result.description}`);
  }
  if (result.duration) {
    parts.push(`时长(秒): ${result.duration}`);
  }

  if (result.runtime?.mode) {
    parts.push(`运行模式: ${result.runtime.mode}`);
    if (result.runtime.fallbackUsed) {
      parts.push("运行模式说明: 已从默认候选回退到备用环境。");
    }
  }
  parts.push(`字幕来源: ${result.transcriptSource}`);
  if (result.transcriptDevice) {
    parts.push(`转写设备: ${result.transcriptDevice}`);
  }
  parts.push(`工作目录: ${result.outputDir}`);
  parts.push(`元信息文件: ${result.metadataPath}`);
  if (result.rawInfoPath) {
    parts.push(`原始信息文件: ${result.rawInfoPath}`);
  }
  parts.push(`纯文本文件: ${result.transcriptTextPath}`);
  if (result.audioPath) {
    parts.push(`音频文件: ${result.audioPath}`);
  }
  if (Array.isArray(result.subtitleFiles) && result.subtitleFiles.length > 0) {
    parts.push(`原始字幕文件: ${result.subtitleFiles.join(", ")}`);
  }
  if (result.audioStreamsPath) {
    parts.push(`音频流信息: ${result.audioStreamsPath}`);
  }

  // Visual analysis output
  if (result.visualOk !== undefined) {
    parts.push(`视觉分析: ${result.visualOk ? "已启用" : "未启用"}`);
    if (result.visualOk && result.visualAnalysis) {
      const va = result.visualAnalysis;
      parts.push(`  模型: ${va.backend || "unknown"}`);
      parts.push(`  帧数: ${va.framesExtracted || 0}`);
      parts.push(`  引擎: ${va.engine || "unknown"}`);
      if (va.summary) {
        const summaryPreview = va.summary.length > 200 ? va.summary.substring(0, 200) + "…" : va.summary;
        parts.push(`  摘要: ${summaryPreview}`);
      }
      if (va.timeline && va.timeline.length > 0) {
        parts.push(`  时间线: ${va.timeline.length} 个片段`);
      }
    } else if (result.visualAnalysis && !result.visualOk) {
      parts.push(`  错误: ${result.visualAnalysis.error || "未知错误"}`);
    }
  }

  parts.push("", "以下正文已提供给 Agent（过长时会被截断，完整文本请读取纯文本文件）：", result.agentTextPreview || "");
  return parts.join("\n");
}
