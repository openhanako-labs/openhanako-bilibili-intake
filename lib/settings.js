import path from "node:path";
import fs from "node:fs";
import { DEFAULT_SETTINGS } from "./constants.js";

/**
 * lib/settings.js — 配置读取。
 *
 * ⚠️ 本插件有**两套**并行配置源，历史上从没对上，表现是「设置页改了没用」：
 *
 *   1. 卡片设置页 → POST /intake/settings → 写 app-data/settings.json（扁平对象）
 *   2. v1 遗留的 ctx.config.get(key) → 宿主级配置（v2 返回 Promise）
 *
 * lib/settings.js 原来只读 2，所以卡片设置页写进去的 cookiesFile 永远到不了
 * Python 管道，评论永远卡在未登录的 3 条上限。这里改成三级合并：
 *
 *     宿主 ctx.config.get(key)   >   settings.json[key]   >   DEFAULT_SETTINGS
 *
 * 宿主级优先：管理员在别处改过的配置仍然赢。卡片页写入的值在宿主没覆盖时才生效。
 * 两者都空才落默认值。
 */

/** 读一项配置，按上述优先级。 */
async function readConfig(ctx, key, fileSettings) {
  // ① 宿主级（v1 是同步，v2 返回 Promise —— 统一 await，两种都能吃）
  let v;
  try {
    const g = ctx?.config?.get?.(key);
    v = g && typeof g.then === "function" ? await g : g;
  } catch {
    v = undefined;
  }
  if (v !== undefined && v !== null && v !== "") return v;

  // ② 卡片设置页写入的 settings.json
  return fileSettings?.[key];
}

/** 读 settings.json。缺失、目录不存在、JSON 损坏一律返回 {}，绝不抛。 */
function readSettingsFile(ctx) {
  const dataDir = ctx?.dataDir || process.env.HANAKO_PLUGIN_DATA || "";
  if (!dataDir) return {};
  try {
    const p = path.join(dataDir, "settings.json");
    if (!fs.existsSync(p)) return {};
    const v = JSON.parse(fs.readFileSync(p, "utf-8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** 一次性把整组配置读出来（async）。调用方必须 await —— 见 lib/legacy-ctx.js 顶部注释。 */
export async function getSettings(ctx) {
  // ⭐ 关键：把卡片设置页写的那个文件读进来，否则 ① 空 ② 也永远是空。
  const fileSettings = readSettingsFile(ctx);
  const read = (k) => readConfig(ctx, k, fileSettings);

  const [
    runtimeMode, nativePythonCommand, wslPythonCommand,
    whisperModel, whisperDevice, whisperLanguage,
    preferredSubtitleLanguagesRaw, audioFormat,
    cookiesFile, autoBootstrapPython, maxReturnedTranscriptChars, runtimeRootRaw,
    llmApiKey, llmBaseUrl, llmModel, llmProvider,
  ] = await Promise.all([
    read("runtimeMode"), read("nativePythonCommand"), read("wslPythonCommand"),
    read("whisperModel"), read("whisperDevice"), read("whisperLanguage"),
    read("preferredSubtitleLanguages"), read("audioFormat"),
    read("cookiesFile"), read("autoBootstrapPython"), read("maxReturnedTranscriptChars"),
    read("runtimeRoot"),
    // ⭐ P3（2026-09-22）：知识地图的 LLM 凭证。
    //   App 给子进程的 env 是白名单 —— 宿主里设的 OPENAI_API_KEY 到不了 python，
    //   所以这三项要从设置里读出来、显式传进去（不设就让调用方看到清楚的原因）。
    read("llmApiKey"), read("llmBaseUrl"), read("llmModel"), read("llmProvider"),
  ]);

  return {
    runtimeMode: normalizeMode(runtimeMode ?? DEFAULT_SETTINGS.runtimeMode),
    nativePythonCommand:
      stringify(nativePythonCommand) || DEFAULT_SETTINGS.nativePythonCommand,
    wslPythonCommand: stringify(wslPythonCommand) || DEFAULT_SETTINGS.wslPythonCommand,
    whisperModel: stringify(whisperModel) || DEFAULT_SETTINGS.whisperModel,
    whisperDevice: normalizeWhisperDevice(whisperDevice ?? DEFAULT_SETTINGS.whisperDevice),
    whisperLanguage: stringify(whisperLanguage) || DEFAULT_SETTINGS.whisperLanguage,
    preferredSubtitleLanguages: parseLanguages(
      preferredSubtitleLanguagesRaw ?? DEFAULT_SETTINGS.preferredSubtitleLanguages.join(","),
    ),
    audioFormat: stringify(audioFormat) || DEFAULT_SETTINGS.audioFormat,
    cookiesFile: normalizePath(stringify(cookiesFile) || DEFAULT_SETTINGS.cookiesFile),
    runtimeRoot: stringify(runtimeRootRaw),
    llmApiKey: stringify(llmApiKey),
    llmBaseUrl: stringify(llmBaseUrl),
    llmModel: stringify(llmModel),
    // ⭐ 用户选的那一项（供应商 id）。默认空 → 用宿主里第一个可用供应商。
    //   注意：settings.json 里只存"选谁"，key 每次现解现用，不落盘。
    llmProvider: stringify(llmProvider),
    autoBootstrapPython: booleanValue(autoBootstrapPython, DEFAULT_SETTINGS.autoBootstrapPython),
    maxReturnedTranscriptChars: numberValue(
      maxReturnedTranscriptChars,
      DEFAULT_SETTINGS.maxReturnedTranscriptChars,
    ),
    // 诊断用：把两个来源各自给了什么露出来，排查「设置没生效」时一眼看清。
    _source: {
      cookiesFile: typeof cookiesFile === "string" ? cookiesFile : "",
      fromHostConfig: typeof cookiesFile === "string" && cookiesFile.length > 0,
      fileKeys: Object.keys(fileSettings),
    },
  };
}

function stringify(value) {
  return typeof value === "string" ? value.trim() : "";
}

function booleanValue(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseLanguages(value) {
  if (Array.isArray(value)) {
    return value.map(it => String(it).trim()).filter(Boolean);
  }
  return String(value ?? "")
    .split(",")
    .map(it => it.trim())
    .filter(Boolean);
}

function normalizeMode(value) {
  return ["auto", "native", "wsl"].includes(value) ? value : DEFAULT_SETTINGS.runtimeMode;
}

function normalizeWhisperDevice(value) {
  return ["auto", "cuda", "cpu"].includes(value) ? value : DEFAULT_SETTINGS.whisperDevice;
}

function normalizePath(value) {
  if (!value) {
    return "";
  }
  return path.normalize(value);
}
