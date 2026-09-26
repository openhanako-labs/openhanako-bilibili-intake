import path from "node:path";
import { execFile } from "node:child_process";
import { BiliIntakeError } from "./errors.js";
import { PYTHON_DIR } from "./env.js";
import { getSettings } from "./settings.js";
import { getVenvPython, prepareRuntime, runCollector } from "./runtime.js";
import { ensureDir, hashText, normalizeBilibiliSource, sanitizePathSegment, truncateText } from "./utils.js";
import { buildAnchorPayload, fmtTimestamp } from "./anchors.js";
import { writeArtifact, parseSectionAnchors } from "./artifacts.js";
import { patchFromResult, upsertRecord } from "./records.js";

// ⭐ BUG-4 修复：采集路径的 Whisper 兜底会远超 lib/runtime.js 的 SPAWN_TIMEOUT_MS(180s)。
// 无平台字幕的长视频要跑 CPU Whisper，三分钟几乎必然撞穿——撞穿的代价是整次采集白费。
// 前台同步采集会阻塞模型回合，给足一个长视频转写的时间；后台通道(background:true)再放大，
// 真正把墙拆掉。runCollector 的 timeoutMs 覆盖 runtime 默认 180s。
const COLLECT_TIMEOUT_MS = 30 * 60 * 1000;               // 30 min — 前台采集(单视频 / 搜索批量)
const BACKGROUND_COLLECT_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h — 后台采集(background:true，不阻塞回合)

function collectTimeoutMs(input) {
  return input?.background === true ? BACKGROUND_COLLECT_TIMEOUT_MS : COLLECT_TIMEOUT_MS;
}

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
    // ⭐ 2026-09-26：原片下载（目前用于小红书视频笔记）。
    downloadVideo: settings.shotsDownloadVideo === true,
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

  };

  const result = await runCollector(runtime, payload, { timeoutMs: collectTimeoutMs(input) });
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

  // ⭐ 2026-09-22（见 03c 实施计划 P0）：
  //   ① 锚点化交接 —— 把 subtitle_parser / audio_chunker 早就产出的时间轴交给上层，
  //      不再只给一坨被截断的纯文本（截断也不再静默：载荷里带 truncated/nextOffset）。
  //   ② 采集即落记录 —— 以前只有卡片路由会写 records.json，工具侧一个字都不写，
  //      于是卡片里的"历史"不等于实际采集过的内容。现在两侧共用 lib/records.js。
  //   两处都不改 Python、不删既有字段；任一步失败只降级，不让整次采集失败。
  result.transcriptAnchors = safeAnchors(result, input);
  // ⭐ P1（2026-09-22）：统一素材描述落盘（artifact.json）——
  //   kind（video/article/document）+ anchorKind（time/section/none）+ 正文 + 资源。
  //   总结层从此外只看一种形状，加素材类型不再需要新写一条总结逻辑。
  result.artifact = writeArtifact(result, { slotDir: result.outputDir, anchors: result.transcriptAnchors });
  if (result.artifact?.kind) result.kind = result.artifact.kind;
  try {
    const { record, created } = upsertRecord(ctx, patchFromResult(result, { platform: payload.platform, source }));
    result.recordId = record.id;
    result.recordCreated = created;
  } catch (e) {
    result.recordError = e?.message || String(e);
  }
      // ⭐ 2026-09-26：采集完**自动**写总结（用户原话「要自动」）。
      //   卡片已收成「只做展示 / 删除 / 检索」，采集与搜索回到会话 —— 所以触发点也从卡片路由挪到这里：
      //   在会话里采完，记录同样会自动带上总结。
      //   后台跑（不 await）：模型一次几十秒，不能占着工具返回。关掉它：设置 summaryAuto = false。
      result.autoSummary = { pending: true };
      void (async () => {
        try {
          const { getSettings } = await import("./settings.js");
          const settings = await getSettings(ctx);
          if (!settings.summaryAuto) { result.autoSummary = { skipped: true, reason: "设置里关了" }; return; }
          const { autoSummarize } = await import("./auto-summary.js");
          const r = await autoSummarize(ctx, { slotDir: result.outputDir });
          result.autoSummary = r;
          ctx.log?.info?.(`自动总结${r?.ok ? "完成" : "未完成"}：${result.outputDir}`
            + (r?.ok ? `（要点 ${r.counts?.total ?? 0} · 回指 ${r.counts?.grounded ?? 0}）` : `（${r?.reason || r?.error || "未知"}）`));
        } catch (e) {
          result.autoSummary = { ok: false, error: e?.message || String(e) };
        }
      })();
  return result;
}

/** 锚点载荷；任何异常都降级成 null（上层退回旧的纯文本预览）。 */
function safeAnchors(result, input) {
  try {
    return buildAnchorPayload({
      outputDir: result.outputDir,
      subtitleFiles: result.subtitleFiles,
      textPath: result.transcriptTextPath,
      textChars: typeof result.transcriptText === "string" ? result.transcriptText.length : 0,
      offset: input.anchorOffset,
      limit: input.anchorLimit,
    });
  } catch { return null; }
}

/* ────────────────────────── 本地文档（P1，2026-09-22） ────────────────────────── */

/**
 * 跑任意 python 脚本并拿 stdout。
 * 平台采集走 runCollector（绑定 collector.py），这里是本地文档解析的专用通道。
 */
function runPythonScript(pythonExe, scriptPath, args, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      pythonExe,
      [scriptPath, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
        // ⭐ AppHost 给子进程的 env 是白名单，**不带 PYTHONUTF8** —— Windows 下 python
        //   会把 stdout 退回 cp936，而这里按 UTF-8 解码，中文全变 U+FFFD（实测复现）。
        //   doc_extract.py 自己也 reconfigure 了一次，这里是第二道保险。
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || "").trim().slice(0, 400);
          return reject(new BiliIntakeError(`本地文档解析失败：${detail}`, { code: "DOC_EXTRACT_FAILED" }));
        }
        resolve(String(stdout || ""));
      },
    );
  });
}

/**
 * 本地文档取文本并入库（P1）。
 * 轻量格式（txt/md/html/docx）由 python/doc_extract.py 用标准库解析；
 * PDF 需要 pypdf；扫描件与 Office 二进制格式交给环境里的 doc-intake 插件。
 * 产物与平台采集同构：text.txt + artifact.json + 一条记录。
 */
export async function ingestLocalDocument(input = {}, ctx) {
  const target = String(input.path || input.source || "").trim();
  if (!target) throw new BiliIntakeError("path 不能为空，必须是本地文件路径。", { code: "MISSING_SOURCE" });
  const file = path.resolve(target);
  // ⚠️ 这里**故意不检查文件是否存在**：
  //   App 的 JS 跑在宿主的 Node 权限模型里（--allow-fs-read=<安装目录> +
  //   --allow-fs-read/write=<app-data>），越界的 fs 调用（连 fs.existsSync）
  //   会直接抛 ERR_ACCESS_DENIED —— 用户丢过来的文件在哪都可能，JS 碰一下就死。
  //   存在性、读取、以及调用 doc-intake，全部交给 python 子进程（它不继承权限模型）。

  const settings = await getSettings(ctx);
  const runtime = await prepareRuntime(ctx, settings);
  if (runtime.selectedMode !== "native") {
    throw new BiliIntakeError("本地文档解析目前只支持 native 模式（WSL 模式下文件路径跨不过去）。", { code: "UNSUPPORTED_MODE" });
  }

  const outputDir = await ensureDir(path.join(runtime.capturesRoot, `doc-${hashText(file)}`));

  // 单次调用：解析优先级（doc-intake 优先、标准库回退）现在完全在 python 侧决定，
  // 因为只有子进程能自由地 stat 用户路径与其它插件目录。
  const stdout = await runPythonScript(getVenvPython(runtime), path.join(PYTHON_DIR, "doc_extract.py"), [
    "--source", file,
    "--output-dir", outputDir,
    ...(input.title ? ["--title", String(input.title)] : []),
    ...(input.extractor === "builtin" ? ["--builtin-only"] : []),
    ...(input.docIntakePython ? ["--delegate-python", String(input.docIntakePython)] : []),
  ]);

  let result;
  try { result = JSON.parse(stdout.trim()); } catch { throw new BiliIntakeError("解析器没有返回合法 JSON。", { code: "DOC_EXTRACT_FAILED" }); }
  if (!result?.ok) {
    throw new BiliIntakeError(result?.error || "解析失败", { code: "DOC_EXTRACT_FAILED", hint: result?.hint });
  }

  result.platform = "document";
  result.kind = "document";
  result.source = file;
  // 不塞 transcriptText：它可能是被截到 20000 的副本，会把「字数」带偏。
  // 记录里的字数用 python 给的 textChars（精确值），取文本方式记在 transcriptSource。
  result.transcriptSource = result.extractor || "document";
  result.artifact = writeArtifact(result, { slotDir: outputDir, anchors: null });
  try {
    const { record } = upsertRecord(ctx, patchFromResult(result, { platform: "document", source: file }));
    result.recordId = record.id;
  } catch (e) { result.recordError = e?.message || String(e); }
  return result;
}

/**
 * ⚠️ 本地文档的 doc-intake 复用**已移到 python 侧**（见 python/doc_extract.py）。
 *   原因：App 的 JS 跑在宿主的 Node 权限模型里，只要 fs 碰到安装目录 / app-data
 *   之外的路径（连 fs.existsSync 也一样）就抛 ERR_ACCESS_DENIED —— 而 doc-intake 的
 *   main.py 在 plugins/ 下、用户的文件更不知在哪。
 *   所以「找 doc-intake、探解释器、跑它、收回 markdown」全交给 python 子进程；
 *   原先的 lib/docintake.js 已删除（在宿主里它根本 stat 不出去，是个陷阱）。
 */

/** 本地文档的工具回执：先报结构，再给正文前段，不重复全文。 */
export function formatDocumentPayload(result = {}) {
  const parts = [
    "本地文档已入库。",
    `标题: ${result.title || ""}`,
    `来源: ${result.source || ""}`,
    `提取器: ${result.extractor || "?"}（小节 ${result.sections || 0} 个 / ${result.textChars || 0} 字）`,
    `工作目录: ${result.outputDir || ""}`,
    `纯文本文件: ${result.transcriptTextPath || ""}`,
  ];
  if (String(result.note_type || "") === "video") parts.push("⚠️ 视频笔记：正文只有标题/简介/评论，视频内容未采集");
  if (result.recordId) parts.push(`记录ID: ${result.recordId}（写完总结用 POST /intake/record 回写同一 id）`);
  if (result.truncatedInJson) parts.push("（注：超大文档的正文没随结果返回，请直接读上面的纯文本文件）");
  parts.push("", "以下正文已提供给 Agent（过长时会被截断，完整文本请读取纯文本文件）：", String(result.text || "").slice(0, 6000));
  return parts.join("\n");
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

  const result = await runCollector(runtime, payload, { timeoutMs: collectTimeoutMs(input) });
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

/**
 * 把原片下到指定目录（帧分析用）。走采集同一条 python 子进程通道。
 *
 * ⭐ 2026-09-26：旧视觉链路里的下载代码随 frame_extractor 一起删了 —— 这条补回来，
 * 由工具 intake_shots 在「下载原片」开关打开、槽位里又没有原片时调它。
 * 下载仍然在 python 子进程里做（yt-dlp 只在 venv 里），不是绕权限模型。
 */
export async function downloadVideoForShots(ctx, { source = "", outputDir = "", timeoutMs = 15 * 60 * 1000 } = {}) {
  if (!outputDir) throw new BiliIntakeError("outputDir 不能为空", { code: "BAD_ARGS" });
  const settings = await getSettings(ctx);
  const runtime = await prepareRuntime(ctx, settings);
  return await runCollector(runtime, {
    action: "download-video",
    source: String(source || ""),
    outputDir: String(outputDir),
  }, { timeoutMs });
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

  if (result.recordId) {
    parts.push(`记录ID: ${result.recordId}（采集已自动落记录；写完总结用 POST /intake/record 回写同一 id）`);
  }

  // ⭐ 锚点可用时给带时间轴的正文，并**明确报告还剩多少段**；不可用时退回旧的纯文本预览。
  const anchors = result.transcriptAnchors;
  if (anchors && anchors.returned > 0) {
    parts.push(
      "",
      `带时间轴的正文（锚点源: ${anchors.source}；共 ${anchors.totalSegments} 段 / 全长 ${fmtTimestamp(anchors.durationSec)}；`
      + `本次给第 ${anchors.offset + 1}–${anchors.offset + anchors.returned} 段）:`,
    );
    for (const s of anchors.segments) {
      parts.push(`[${fmtTimestamp(s.start)} → ${fmtTimestamp(s.end)}] ${s.text}`);
    }
    if (anchors.truncated) {
      parts.push(
        `⚠️ 未给全：本次只覆盖到 ${fmtTimestamp(anchors.coveredSeconds)} / ${fmtTimestamp(anchors.durationSec)}，`
        + `还剩 ${anchors.totalSegments - anchors.nextOffset} 段。续读请再调本工具（同一 source）并传 anchorOffset: ${anchors.nextOffset}；`
        + `要纯文本可读 ${anchors.textPath}`,
      );
    } else {
      parts.push(`（已覆盖全片；纯文本: ${anchors.textPath || ""}）`);
    }
  } else {
    parts.push("", "以下正文已提供给 Agent（过长时会被截断，完整文本请读取纯文本文件）：", result.agentTextPreview || "");
  }

  // ⭐ 2026-09-26：小红书视频笔记的边界必须说出来。
  //   正文只有标题 / 简介 / 评论 —— 视频里的语音和画面都不在这条路径上
  //   （xhs 分支不走 download_audio/Whisper，也没下视频）。
  //   不说清的话，总结会看起来“覆盖了视频”，其实没有。
  if (/video/i.test(String(result.note_type || ""))) {
    parts.push("", "⚠️ 这是小红书**视频笔记**：上面只有标题 / 简介 / 评论。视频里的语音与画面都没有采集（这条路径不转写、不下视频），总结只能针对文字内容。");
  }
  return parts.join("\n");
}
