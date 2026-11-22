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
  // ⭐ 2026-11-21：出网代理。国内直连 Pixiv / X / YouTube / Instagram 全部会超时
  //   （实测本机 pixiv.net 直接 WinError 10060），所以这不是可选优化项，是那几个
  //   平台的必要条件。格式：http://127.0.0.1:7890 或 socks5://127.0.0.1:1080，
  //   留空 = 不走代理。
  proxyUrl: "",
});

export const RUNTIME_DIR = ".runtime";
export const CAPTURES_DIR = "captures";
export const REQUIREMENTS_FILE = "python/requirements.txt";
export const COLLECTOR_SCRIPT = "python/collector.py";
