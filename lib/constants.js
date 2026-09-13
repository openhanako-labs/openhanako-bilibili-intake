export const PLUGIN_ID = "hanako-bilibili-intake";
export const PLUGIN_VERSION = "0.1.3";

export const DEFAULT_SETTINGS = Object.freeze({
  runtimeMode: "auto",
  nativePythonCommand: process.platform === "win32" ? "python" : "python3",
  wslPythonCommand: "python3",
  whisperModel: "base",
  whisperDevice: "auto",
  whisperLanguage: "",
  preferredSubtitleLanguages: ["zh-Hans", "zh-CN", "zh", "ai-zh", "zh-TW", "en", "ja"],
  audioFormat: "mp3",
  cookiesFile: "",
  cookiesDir: "",  // v0.2+ 默认空；如需启用统一 cookies 存储，在 manifest.json 或 settings.json 中设置路径
  autoBootstrapPython: true,
  maxReturnedTranscriptChars: 12_000,
});

export const RUNTIME_DIR = ".runtime";
export const CAPTURES_DIR = "captures";
export const REQUIREMENTS_FILE = "python/requirements.txt";
export const COLLECTOR_SCRIPT = "python/collector.py";
