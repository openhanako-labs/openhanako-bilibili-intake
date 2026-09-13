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
import { toToolError, toToolResult } from "../lib/tool-output.js";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";

export const name = "generate_knowledge_map";
export const description = "从采集的视频素材生成结构化知识地图（Markdown 格式，可导入 Obsidian）。基于 b-mind-ai 的 LLM prompt 管线，支持方向归纳、知识地图生成、知识点验证。";
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
  },
  required: [],
};

export async function execute(input = {}, ctx) {
  try {
    const mode = input.mode || "directions";
    const topic = input.topic || "";

    if (!topic && mode !== "challenge") {
      return toToolError(new Error("directions/map 模式需要 topic 参数。"));
    }

    // 准备运行环境
    const settings = await getSettings(ctx);
    const runtime = await prepareRuntime(ctx, settings);
    const pythonExe = getVenvPython(runtime);

    // 获取视频素材
    let videos = input.videos || [];
    if (videos.length === 0 && input.source) {
      // 先采集视频
      const source = normalizeBilibiliSource(input.source);
      if (!source) {
        return toToolError(new Error("source 格式无效，必须是 BV 号或 B站链接。"));
      }
      const captureResult = await ingestBilibiliVideo({
        source,
        platform: "bilibili",
        mode: "single",
        noAudio: true,
        withComments: false,
      }, ctx);
      if (captureResult.ok === false) {
        return toToolError(new Error(`视频采集失败：${captureResult.error?.message || "未知错误"}`));
      }
      videos = [{
        bvid: source,
        title: captureResult.result?.title || "",
        up: captureResult.result?.up || "",
        desc: captureResult.result?.desc || "",
        plays: captureResult.result?.plays || "",
      }];
    } else if (videos.length === 0 && mode !== "challenge") {
      // 自动搜索 B 站
      const searchResult = await ingestBilibiliVideo({
        mode: "search",
        searchKeyword: topic,
        searchLimit: 10,
        platform: "bilibili",
        noAudio: true,
        withComments: false,
      }, ctx);
      if (searchResult.ok === false) {
        return toToolError(new Error(`搜索失败：${searchResult.error?.message || "未知错误"}`));
      }
      videos = (searchResult.result?.results || []).map(v => ({
        bvid: v.bvid || v.id,
        title: v.title || "",
        up: v.author || v.up || "",
        desc: v.desc || "",
        plays: String(v.playCount || v.plays || ""),
        pic: v.pic || v.cover || "",
      }));
    }

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
    const stdout = execSync(args.join(" "), {
      encoding: "utf-8",
      timeout: 120000, // 2 分钟超时
      maxBuffer: 10 * 1024 * 1024,
    });

    const result = JSON.parse(stdout);

    // 格式化输出文本
    let text = "";
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

    return toToolResult(result, text);

  } catch (error) {
    return toToolError(error, {
      action: name,
      mode: input.mode || "directions",
      topic: input.topic || "",
    });
  }
}