/**
 * generate_knowledge_map.js
 * bilibili-intake — 知识地图生成工具（v0.5+）
 *
 * 基于 b-mind-ai 的 LLM prompt 管线，从采集的视频素材生成结构化知识地图。
 * 输出为 Markdown 格式，可直接在 Obsidian 中阅读。
 */

import path from "node:path";
import { BiliIntakeError } from "../lib/errors.js";
import { ingestBilibiliVideo, formatAgentPayload } from "../lib/service.js";
import { prepareRuntime, runCollector, getVenvPython } from "../lib/runtime.js";
import { getSettings } from "../lib/settings.js";
import { ensureDir, normalizeBilibiliSource, sanitizePathSegment } from "../lib/utils.js";
import { materialFromSlot, describeMaterials } from "../lib/materials.js";
import { locateRecord, readRecords } from "../lib/records.js";
import { submitBackground } from "../lib/tasks.js";
import { toToolError, toToolResult } from "../lib/tool-output.js";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";

export const name = "generate_knowledge_map";
export const description = "从已采集/已总结的素材生成结构化知识地图（Markdown，可导 Obsidian）。" +
  "素材优先吃成品：该素材的 summary.json（一句话 + 带出处的要点）→ 没有就用锚点段落 → 再没有才用标题简介；" +
  "可用 recordId 指定已采集的记录（不重复采集），materialSource 可指定只吃哪一档。";
export const parameters = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["directions", "map", "challenge"],
      description: "运行模式：directions=从主题归纳学习方向，map=生成递归知识地图，challenge=为知识点出题验证",
      default: "directions",
    },
    topic: {
      type: "string",
      description: "学习主题，如「C++ 指针」「摄影构图」（directions/map 模式必填）",
    },
    direction: {
      type: "string",
      description: "学习方向标题（map 模式必填，directions 模式可选）",
    },
    searchQuery: {
      type: "string",
      description: "B 站搜索词（map 模式，默认自动根据 topic+direction 生成）",
    },
    videos: {
      type: "array",
      description: "视频素材列表（可选，不传时自动从 B 站搜索）。每项含 bvid, title, up, desc, plays, pic, pubdate",
      items: {
        type: "object",
        properties: {
          bvid: { type: "string", description: "BV 号" },
          title: { type: "string", description: "视频标题" },
          up: { type: "string", description: "UP 主名称" },
          desc: { type: "string", description: "视频简介" },
          plays: { type: "string", description: "播放量" },
          pic: { type: "string", description: "封面图 URL" },
        },
      },
    },
    source: {
      type: "string",
      description: "B站视频链接/BV号（可选，提供后自动采集作为素材，不传则直接使用 videos 参数或搜索）",
    },
    recordId: {
      type: "string",
      description: "已采集/已总结的记录 id（可选）。传了就直接吃那份素材的摘要，不重复采集。也可传 BV 号、链接、本地文件路径。",
    },
    materialSource: {
      type: "string",
      enum: ["auto", "summary", "anchors", "metadata", "full"],
      description: "吃哪一档素材：auto（默认，摘要→锚点→元数据）、summary（只要结构化摘要）、anchors（摘要没有就用锚点段落）、metadata（只用标题简介）、full（显式要全文开头）",
      default: "auto",
    },
    concept: {
      type: "object",
      description: "知识点节点（challenge 模式必填）。含 title, learningGoal, keyPoints, domain",
      properties: {
        title: { type: "string" },
        learningGoal: { type: "string" },
        keyPoints: { type: "array", items: { type: "string" } },
        domain: { type: "string", enum: ["coding", "highschool", "general"] },
      },
    },
    output: {
      type: "string",
      description: "输出目录（可选，默认 W:/Games/Hanako/Work/output/知识地图/）",
    },
    background: {
      type: "boolean",
      description: "丢后台执行，立刻返回 taskId，完成后结果自动回到对话。默认 true —— 宿主给工具调用的 RPC 上限是 30s，而这一步要调 LLM（尤其 map 模式），同步等必被掐断。要同步拿结果就传 false。",
      default: true,
    },
  },
  required: [],
};

export async function execute(input = {}, ctx) {
  const mode = input.mode || "directions";
  // ⭐ 2026-09-22 实测：宿主给工具调用的 RPC 上限是 **30s**，而 LLM 模式（尤其 map）
  //   经常跑更久 —— 同步等就必然被掐断（`RPC callback.tools.execute timed out after 30000ms`）。
  //   所以默认丢后台，同 intake_document。
  if (input.background !== false && ctx?.tasks?.create) {
    return await submitBackground(input, ctx, {
      ingest: runKnowledgeMap,
      formatAgentPayload: payload => String(payload?.text || "知识地图已生成（无文本摘要）"),
      toToolError,
      startText: (taskId) => `知识地图已在后台生成（taskId: ${taskId}）。\n`
        + `模式：${mode}${input.topic ? ` · 主题：${input.topic}` : ""}\n`
        + `素材：${input.recordId ? "指定记录（吃已总结素材）" : input.videos ? "传入列表" : input.source ? "现场采集" : "B站搜索"}\n`
        + `完成后结果会自动回到这个对话；这一步要调 LLM，通常一两分钟，不用等着。`,
    });
  }
  try {
    const payload = await runKnowledgeMap(input, ctx);
    return toToolResult(payload.result, String(payload.text || ""));
  } catch (error) {
    return toToolError(error, { action: name, mode, topic: input.topic || "" });
  }
}

/**
 * 真正干活的那个（前台与后台共用）。**抛错即失败** ——
 * 前台由 execute 转成 toToolError，后台由 tasks.fail 记录。
 */
async function runKnowledgeMap(input = {}, ctx) {
  try {
    const mode = input.mode || "directions";
    const topic = input.topic || "";

    if (!topic && mode !== "challenge") {
      throw new Error("directions/map 模式需要 topic 参数。");
    }

    // 准备运行环境
    const settings = await getSettings(ctx);
    const runtime = await prepareRuntime(ctx, settings);
    const pythonExe = getVenvPython(runtime);

    // ⭐ P3：LLM 配置 —— 优先**复用宿主已配好的模型**（用户选的那个供应商）。
    //   key 由宿主给出、只在服务端流转；settings 里的 llmApiKey/llmBaseUrl/llmModel
    //   作为手动覆盖保留（自定义端点 / 离线场景）。
    const llmEnv = {};
    let hostLlm = { ok: false, error: "not_attempted" };
    const apiKeyFromSettings = settings.llmApiKey || process.env.OPENAI_API_KEY || "";
    if (!apiKeyFromSettings) {
      try {
        const { resolveLlmConfig } = await import("../lib/hana-llm.js");
        hostLlm = await resolveLlmConfig(ctx, { providerId: settings.llmProvider, model: settings.llmModel });
      } catch (e) {
        hostLlm = { ok: false, error: "resolve_failed", detail: e?.message || String(e) };
      }
    }
    const apiKey = apiKeyFromSettings || (hostLlm.ok ? hostLlm.apiKey : "");
    const baseUrl = settings.llmBaseUrl || (hostLlm.ok ? hostLlm.baseUrl : "") || "";
    const model = settings.llmModel || (hostLlm.ok ? hostLlm.model : "") || "";
    if (apiKey) llmEnv.OPENAI_API_KEY = apiKey;
    if (baseUrl) llmEnv.OPENAI_BASE_URL = baseUrl;
    if (model) llmEnv.OPENAI_MODEL = model;
    if (!apiKey) {
      throw new Error(
        `知识地图要调 LLM，但没拿到可用的模型配置（${hostLlm.error}${hostLlm.detail ? "：" + hostLlm.detail : ""}）。\n`
        + "① 在卡片「状态 → 设置 → 知识地图模型」里选一个宿主已配好的模型（推荐，key 不用手填）；"
        + "② 或在 app-data/bilibili-intake-v2/settings.json 手填 llmApiKey / llmBaseUrl / llmModel。",
      );
    }

    // 获取素材
    let videos = input.videos || [];
    const materialSource = input.materialSource || "auto";
    const materialNotes = {};

    // ⭐ P3：先找“已总结素材” —— 有摘要就别重新采集，更别重读全文。
    //   （地图不需要原文，它需要已经被读过一遍、并且标了出处的结论）
    const pickKey = String(input.recordId || (input.videos ? "" : input.source) || "").trim();
    if (videos.length === 0 && pickKey) {
      const rec = locateRecord(readRecords(ctx), pickKey);
      if (rec && rec.artifactDir) {
        const built = materialFromSlot({
          slotDir: rec.artifactDir,
          base: { bvid: rec.id, title: rec.title || "", up: rec.author || "", desc: "" },
          source: materialSource,
        });
        if (built) {
          videos = [built.item];
          if (built.note) materialNotes[built.source] = built.note;
        }
      }
    }

    if (videos.length === 0 && input.source) {
      // 先采集视频
      const source = normalizeBilibiliSource(input.source);
      if (!source) {
        throw new Error("source 格式无效，必须是 BV 号或 B站链接。");
      }
      const captureResult = await ingestBilibiliVideo({
        source,
        platform: "bilibili",
        mode: "single",
        noAudio: true,
        withComments: false,
      }, ctx);
      if (captureResult.ok === false) {
        throw new Error(`视频采集失败：${captureResult.error?.message || "未知错误"}`);
      }
      const base = {
        bvid: source,
        title: captureResult.result?.title || "",
        // collector 的原始字段名是 uploader/description/view_count —— 两套命名都收
        up: captureResult.result?.up || captureResult.result?.uploader || "",
        desc: captureResult.result?.desc || captureResult.result?.description || "",
        plays: String(captureResult.result?.plays || captureResult.result?.view_count || ""),
      };
      // ⭐ P3：刚采完就把素材整理好（此前只把标题与简介递下去）
      const outDir = captureResult.result?.outputDir || "";
      const built = outDir ? materialFromSlot({ slotDir: outDir, base, source: materialSource }) : null;
      videos = [built ? built.item : base];
      if (built && built.note) materialNotes[built.source] = built.note;
    } else if (videos.length === 0 && mode !== "challenge") {
      // 自动搜索 B 站（搜索结果一般没采集过，只有元数据 —— 地图会如实标出来）
      const searchResult = await ingestBilibiliVideo({
        mode: "search",
        searchKeyword: topic,
        searchLimit: 10,
        platform: "bilibili",
        noAudio: true,
        withComments: false,
      }, ctx);
      if (searchResult.ok === false) {
        throw new Error(`搜索失败：${searchResult.error?.message || "未知错误"}`);
      }
      const all = readRecords(ctx);
      videos = (searchResult.result?.results || []).map(v => {
        const base = {
          bvid: v.bvid || v.id,
          title: v.title || "",
          up: v.author || v.up || "",
          desc: v.desc || "",
          plays: String(v.playCount || v.plays || ""),
          pic: v.pic || v.cover || "",
        };
        // 搜到的东西如果以前采集过，就把已总结素材挂上去
        const rec = locateRecord(all, base.bvid);
        if (!rec || !rec.artifactDir) return base;
        const built = materialFromSlot({ slotDir: rec.artifactDir, base, source: materialSource });
        return built ? built.item : base;
      });
    }

    const materialReport = describeMaterials(videos, materialNotes);

    // 写入临时视频 JSON 文件
    const tempDir = await ensureDir(path.join(runtime.capturesRoot, "_knowledge_map_temp"));
    const videosJsonPath = path.join(tempDir, "videos.json");
    const conceptJsonPath = path.join(tempDir, "concept.json");
    await fs.writeFile(videosJsonPath, JSON.stringify(videos, null, 2), "utf-8");

    // 构建 Python 调用参数
    const knowledgeMapPy = path.join(runtime.pluginDir, "python", "knowledge_map_generator.py");
    const args = [
      pythonExe,
      knowledgeMapPy,
      "--topic", topic,
      "--videos", videosJsonPath,
      "--mode", mode,
    ];

    if (input.direction) {
      args.push("--direction", input.direction);
    }
    if (input.searchQuery) {
      args.push("--search-query", input.searchQuery);
    }
    if (input.output) {
      args.push("--output", input.output);
    }

    // challenge 模式：写入 concept JSON
    if (mode === "challenge" && input.concept) {
      await fs.writeFile(conceptJsonPath, JSON.stringify(input.concept, null, 2), "utf-8");
      args[args.indexOf("--videos") + 1] = conceptJsonPath;
    }

    // 执行
    // ⭐ P3：改用 spawnSync + 参数数组 —— 不再让 cmd 去切 `--topic "带 空格 的主题"`，
    //   也不会把用户输入当成命令拼进 shell。同时把 Python 的 UTF-8 环境带上（同 intake_document），
    //   并把 stderr 原样带回来（LLM 缺 key 这类错误以前只能看到一个退出码）。
    const proc = spawnSync(args[0], args.slice(1), {
      encoding: "utf-8",
      timeout: 240000, // LLM 模式可能需要几分钟；再长的话应该改成后台任务
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...llmEnv, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    if (proc.error) throw proc.error;
    if (proc.status !== 0) {
      throw new Error(`知识地图生成失败（exit ${proc.status}）：${String(proc.stderr || proc.stdout || "").trim().slice(-800)}`);
    }
    const stdout = proc.stdout;

    const result = JSON.parse(stdout);

    // ⭐ P3：地图是从什么素材上长出来的，一并回报（摘要 / 锚点 / 只有元数据）。
    result.materialSource = materialReport;
    result.materials = videos.map(v => ({
      title: v.title || "",
      digestSource: v.digestSource || "metadata",
      summaryPoints: v.summaryPoints || 0,
    }));

    // 格式化输出文本
    let text = `${materialReport}\n\n`;
    if (result.type === "directions") {
      text = `## 学习方向：${result.topic}\n\n`;
      for (const dir of result.directions || []) {
        text += `### ${dir.title}\n`;
        text += `${dir.desc}\n`;
        text += `标签：${dir.tags?.join(", ") || "无"}\n`;
        text += `来源：${dir.source?.title || "未知"}（UP: ${dir.source?.up || "未知"}）\n`;
        text += `搜索词：${dir.searchQuery}\n\n`;
      }
    } else if (result.type === "map") {
      text = `✅ 知识地图已生成\n`;
      text += `主题：${result.topic}\n`;
      text += `方向：${result.direction}\n`;
      text += `预计时长：约 ${result.estHours} 小时\n`;
      text += `阶段数：${result.stages}\n`;
      text += `输出文件：${result.filepath}\n\n`;
      text += `---\n\n`;
      text += result.markdown ? `（完整 Markdown 已保存到文件）\n` : "";
    } else if (result.type === "challenge") {
      text = `## 验证题\n\n`;
      text += `题型：${result.kind === "problem" ? "类题" : "概念抽查"}\n\n`;
      text += `**${result.prompt}**\n\n`;
      if (result.items?.length) {
        for (const item of result.items) {
          text += `- ${item}\n`;
        }
      }
    }

    return { result, text };
  } catch (error) {
    throw error; // 前台走 toToolError，后台由 tasks.fail 记录（见 execute）
  }
}