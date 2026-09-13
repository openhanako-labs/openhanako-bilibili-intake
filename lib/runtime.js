import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BiliIntakeError } from "./errors.js";
import { CAPTURES_DIR, COLLECTOR_SCRIPT, REQUIREMENTS_FILE, RUNTIME_DIR } from "./constants.js";
import { ensureDir, fileExists, hashFile } from "./utils.js";
import { resolveRuntimeRoot } from "./legacy-runtime.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_DIR = path.resolve(CURRENT_DIR, "..");
const TORCH_INSTALL_MARKER_VERSION = 2;
const TORCH_CPU_INDEX_URL = "https://download.pytorch.org/whl/cpu";
const TORCH_CUDA_WHEELS = [
  { tag: "cu130", minCuda: "13.0" },
  { tag: "cu128", minCuda: "12.8" },
  { tag: "cu126", minCuda: "12.6" },
  { tag: "cu124", minCuda: "12.4" },
  { tag: "cu121", minCuda: "12.1" },
  { tag: "cu118", minCuda: "11.8" },
];

export async function prepareRuntime(ctx, settings) {
  const pluginDir = ctx?.pluginDir ? path.resolve(ctx.pluginDir) : DEFAULT_PLUGIN_DIR;
  const dataDir = ctx?.dataDir ? path.resolve(ctx.dataDir) : path.join(pluginDir, ".data");

  const resolved = resolveRuntimeRoot(dataDir, RUNTIME_DIR, ctx?.log, settings.runtimeRoot);
  const { root: resolvedRoot, reused } = resolved;
  // ⚠️ reused 时**不能 ensureDir** —— 那会对 app-data 之外的路径 mkdir，
  //    直接被 Node 权限模型拒（"Use --allow-fs-write to manage permissions"）。
  //    复用的目录必然已存在（是 v1 建的 venv），不需要也不应该创建它。
  const runtimeRoot = reused ? resolvedRoot : await ensureDir(resolvedRoot);
  const capturesRoot = await ensureDir(path.join(dataDir, CAPTURES_DIR));
  const requirementsPath = path.join(pluginDir, REQUIREMENTS_FILE);
  const collectorPath = path.join(pluginDir, COLLECTOR_SCRIPT);
  const effectiveSettings = reused ? { ...settings, autoBootstrapPython: false } : settings;

  // 复用外部环境时**彻底跳过文件检查与自愈**：
  //   - AppHost 读不到 app-data 之外，任何 isVenvReady / existsSync 都只会误判；
  //   - bootstrap 会往 v1 的目录里 pip install，既搞坏 v1、又会拖到超时；
  //   - WSL 兜底也跳过 —— v1 的环境只有 Windows 原生版。
  // 真出问题会在起 python 时暴露，错误信息足够定位。
  const candidateModes = reused ? ["native"] : resolveRuntimeModePlan(settings.runtimeMode);

  const baseRuntime = {
    pluginDir,
    dataDir,
    runtimeRoot,
    capturesRoot,
    requirementsPath,
    collectorPath,
    settings: effectiveSettings,
    reusedLegacyRuntime: reused,
    runtimeSource: resolved.source,
  };
  const failures = [];

  for (const mode of candidateModes) {
    const runtime = createRuntimeForMode(baseRuntime, mode, candidateModes);
    try {
      if (reused) {
        return runtime;
      }
      if (effectiveSettings.autoBootstrapPython) {
        await ensurePythonEnvironment(runtime);
      } else if (!(await isVenvReady(runtime))) {
        throw new BiliIntakeError(
          "当前运行模式下还没有准备好的 Python 虚拟环境。",
          {
            code: "VENV_NOT_READY",
            details: {
              mode,
              venvDir: runtime.venvDir,
              runtimeRoot: resolvedRoot,
              runtimeSource: resolved.source,
            },
          },
        );
      }
      return runtime;
    } catch (error) {
      if (candidateModes.length === 1) {
        // 单模式时也要把 attempts 记进日志，否则只剩一句笼统的失败。
        ctx?.log?.error?.("Python 运行环境准备失败", {
          mode,
          runtimeRoot: resolvedRoot,
          runtimeSource: resolved.source,
          reusedLegacyRuntime: reused,
          failure: summarizeRuntimeFailure(mode, runtime, error),
        });
        throw error;
      }
      failures.push(summarizeRuntimeFailure(mode, runtime, error));
    }
  }

  // 多模式全失败：把每次尝试的详情写进日志（工具返回值放不下这些）。
  ctx?.log?.error?.("Python 运行环境准备失败：所有模式都不可用", {
    runtimeRoot: resolvedRoot,
    runtimeSource: resolved.source,
    requestedMode: settings.runtimeMode,
    attempts: failures,
  });

  // ⚠️ 报错要说真话。
  //
  // 实测踩到过：AppHost 丢了 `--allow-child-process` 时，spawn 被 Node 权限模型拒，
  // 每一次尝试都失败 —— 但底层的 `Access to this API has been restricted` 被
  // 层层包装后，外层只剩一句「自动选择 Python 运行环境失败」。
  // 这句话把排查者往「Python 装坏了」的方向带，而真因跟 Python 毫无关系。
  // 这里把权限类的失败单独认出来，直接把解法写在错误里。
  const permDenied = failures.some((f) =>
    /allow-child-process|allow-fs-|Access to this API has been restricted/i.test(f?.message || ""),
  );
  if (permDenied) {
    throw new BiliIntakeError(
      "子进程权限被拒：本 App 的 AppHost 缺少 --allow-child-process。" +
      "这通常发生在宿主重启后（AppHost 起得早于权限记录可见）。" +
      "解法：POST /api/extensions/app:bilibili-intake-v2/reload 让 AppHost 带权限重起。" +
      "（与本 App 的 Python 环境无关，venv 是好的。）",
      {
        code: "SPAWN_PERMISSION_DENIED",
        details: {
          requestedMode: settings.runtimeMode,
          runtimeRoot: resolvedRoot,
          runtimeSource: resolved.source,
          attempts: failures,
          hint: "POST /api/extensions/app:bilibili-intake-v2/reload",
        },
      },
    );
  }

  throw new BiliIntakeError("自动选择 Python 运行环境失败：原生环境不可用，且 WSL 兜底也未成功。", {
    code: "RUNTIME_SELECTION_FAILED",
    details: {
      requestedMode: settings.runtimeMode,
      runtimeRoot: resolvedRoot,
      runtimeSource: resolved.source,
      attempts: failures,
    },
  });
}

export function resolveRuntimeModePlan(configuredMode, platform = process.platform) {
  if (configuredMode === "native" || configuredMode === "wsl") {
    return [configuredMode];
  }
  return platform === "win32" ? ["native", "wsl"] : ["native"];
}

function createRuntimeForMode(baseRuntime, mode, candidateModes) {
  const runtimeRoot = baseRuntime.runtimeRoot;
  const venvDir = path.join(runtimeRoot, mode === "native" && process.platform === "win32" ? "venv-win" : `venv-${mode}`);
  return {
    ...baseRuntime,
    mode,
    venvDir,
    candidateModes: [...candidateModes],
    selectedMode: mode,
    fallbackUsed: mode !== candidateModes[0],
  };
}

function summarizeRuntimeFailure(mode, runtime, error) {
  const normalized = error instanceof BiliIntakeError
    ? {
        code: error.code || "RUNTIME_ERROR",
        message: error.message,
        details: error.details || null,
      }
    : {
        code: "RUNTIME_ERROR",
        message: error instanceof Error ? error.message : String(error),
        details: null,
      };
  return {
    mode,
    venvDir: runtime.venvDir,
    ...normalized,
  };
}

async function ensurePythonEnvironment(runtime) {
  if (runtime.mode === "wsl" && process.platform !== "win32") {
    throw new BiliIntakeError("当前进程不是 Windows，不能启用 WSL 运行模式。", { code: "INVALID_WSL_MODE" });
  }

  await ensureDir(runtime.venvDir);
  const markerFile = path.join(runtime.venvDir, ".requirements.sha256");
  const requirementsHash = await hashFile(runtime.requirementsPath);
  const torchPlan = await resolveTorchInstallPlan(runtime);
  const venvReady = await isVenvReady(runtime);
  const installMarker = await readInstallMarker(markerFile);

  if (!venvReady) {
    const bootstrapPython = getBootstrapPython(runtime);
    await runCommand(runtime, [bootstrapPython, "-m", "venv", runtime.venvDir], {
      label: "create-venv",
      inputPaths: [runtime.venvDir],
    });
  }

  if (venvReady && await isInstallSatisfied(runtime, installMarker, requirementsHash, torchPlan)) {
    return;
  }

  const pythonExe = getVenvPython(runtime);
  await runCommand(runtime, [pythonExe, "-m", "pip", "install", "--upgrade", "pip", "wheel", "setuptools"], {
    label: "pip-bootstrap",
    inputPaths: [pythonExe],
  });
  const installedTorch = await installTorch(runtime, pythonExe, torchPlan);
  await runCommand(runtime, [pythonExe, "-m", "pip", "install", "-r", runtime.requirementsPath], {
    label: "pip-install",
    inputPaths: [pythonExe, runtime.requirementsPath],
  });
  await writeInstallMarker(markerFile, {
    version: TORCH_INSTALL_MARKER_VERSION,
    requirementsHash,
    torchPolicyKey: torchPlan.policyKey,
    installedTorchKey: installedTorch.markerKey,
  });
}

async function isVenvReady(runtime) {
  return fileExists(getVenvPython(runtime));
}

function getBootstrapPython(runtime) {
  return runtime.mode === "wsl" ? runtime.settings.wslPythonCommand : runtime.settings.nativePythonCommand;
}

export function getVenvPython(runtime) {
  if (runtime.mode === "native") {
    if (process.platform === "win32") {
      return path.join(runtime.venvDir, "Scripts", "python.exe");
    }
    return path.join(runtime.venvDir, "bin", "python");
  }
  return path.join(runtime.venvDir, "bin", "python");
}

export async function runCollector(runtime, payload, options = {}) {
  // options.timeoutMs：覆盖 runCommand 的 180s 默认值。
  // 页面端路由要传更长的超时（长视频 + Whisper）；不传则保持原行为。
  const pythonExe = getVenvPython(runtime);
  const args = [
    pythonExe,
    runtime.collectorPath,
    "--output-dir", payload.outputDir,
  ];

  // Action (health / routing-status)
  if (payload.action) {
    args.push("--action", payload.action);
  }

  // ⭐ 只在有值时才传，避免 undefined 被转成字符串 "undefined" 给 CLI。
  //   旧写法 `payload.whisperModel || runtime.settings.whisperModel` 在两者都为 undefined 时
  //   会传字符串 "undefined"，argparse 解析为字面量 "undefined"，覆盖默认值。
  //   目前 settings.json 有值所以不触发，但卡片路由改架构时需要注意。
  const wm = payload.whisperModel || runtime.settings.whisperModel;
  if (wm) args.push("--whisper-model", wm);
  const wd = payload.whisperDevice || runtime.settings.whisperDevice;
  if (wd) args.push("--whisper-device", wd);
  args.push("--audio-format", runtime.settings.audioFormat);
  if (typeof payload.returnTextLimit === "number" && Number.isFinite(payload.returnTextLimit)) {
    args.push("--return-text-limit", String(payload.returnTextLimit));
  }

  // Platform (v0.2+)
  if (payload.platform) {
    args.push("--platform", payload.platform);
  }
  if (payload.noAudio === true) {
    args.push("--no-audio");
  }
  if (payload.withCreator === true) {
    args.push("--with-creator");
  }
  // 注意：cli.py 的 --with-comments 是 store_true 正向开关（默认 False），
  // 没有对应的 --no-* 反向参数，withComments=false 时不传任何参数即可。
  // --with-sub-comments 不同：它用 BooleanOptionalAction，有两个方向的开关。
  // 两者都统一在下方 “// Comments” 段处理，避免重复 push。

  // Cookies management (v0.2+)
  if (payload.cookiesDir) {
    args.push("--cookies-dir", payload.cookiesDir);
  }
  if (payload.login) {
    args.push("--login", payload.login);
  }
  if (payload.loginTimeout) {
    args.push("--login-timeout", String(payload.loginTimeout));
  }
  if (payload.logout) {
    args.push("--logout", payload.logout);
  }
  if (payload.listLogins) {
    args.push("--list-logins");
  }
  if (payload.importCookies) {
    args.push("--import-cookies", payload.importCookies);
  }
  if (payload.extractCookies) {
    args.push("--extract-cookies", payload.extractCookies);
  }

  // Mode
  if (payload.mode && payload.mode !== "single") {
    args.push("--mode", payload.mode);
  }

  // Source (only for single mode)
  if (payload.source) {
    args.push("--source", payload.source);
  }

  // Search parameters
  if (payload.searchKeyword) {
    args.push("--search-keyword", payload.searchKeyword);
  }
  if (payload.searchLimit) {
    args.push("--search-limit", String(payload.searchLimit));
  }
  if (payload.searchSort !== undefined) {
    args.push("--search-sort", String(payload.searchSort));
  }

  // Comments
  // ⭐ --with-sub-comments 用 argparse.BooleanOptionalAction（v0.6.13），
  // 有真正的反向开关。默认 True，显式传 --no-with-sub-comments 才关。
  // 以前这里只 push --with-comments，二级评论参数在 Python 侧被丢。
  if (payload.withComments === true) {
    args.push("--with-comments");
  }
  if (payload.withComments === true && payload.withSubComments === false) {
    args.push("--no-with-sub-comments");
  }
  if (payload.commentLimit) {
    args.push("--comment-limit", String(payload.commentLimit));
  }

  // Visual analysis (v0.3+)
  if (payload.visual === true) {
    args.push("--visual");
    if (payload.frameDetail) {
      args.push("--frame-detail", payload.frameDetail);
    }
    if (payload.frameResolution) {
      args.push("--frame-resolution", String(payload.frameResolution));
    }
    // Note: --vision-backend is intentionally NOT forwarded here.
    // The "visual analysis" output is consumed by the current chat Agent
    // (which reads the extracted frames and uses its own vision capability),
    // or by Hanako's auxiliary vision model configured in user preferences.
    // The plugin collector only extracts frames; it does not call any vision API itself.
  }

  const whisperLanguage = payload.whisperLanguage ?? runtime.settings.whisperLanguage;
  if (whisperLanguage) {
    args.push("--whisper-language", whisperLanguage);
  }
  if (payload.forceTranscribe === true) {
    args.push("--force-transcribe");
  }
  for (const language of runtime.settings.preferredSubtitleLanguages) {
    args.push("--subtitle-language", language);
  }
  if (runtime.settings.cookiesFile) {
    args.push("--cookies-file", runtime.settings.cookiesFile);
  }
  if (payload.page && Number(payload.page) > 1) {
    args.push("--page", String(payload.page));
  }

  const inputPaths = [pythonExe, runtime.collectorPath, payload.outputDir];
  if (runtime.settings.cookiesFile) {
    inputPaths.push(runtime.settings.cookiesFile);
  }

  const result = await runCommand(runtime, args, {
    label: "collector",
    inputPaths,
    timeoutMs: options.timeoutMs,
  });

  try {
    return parseHelperJson(result.stdout);
  } catch (error) {
    throw new BiliIntakeError("Python helper 没有返回合法 JSON。", {
      code: "INVALID_HELPER_OUTPUT",
      details: {
        stdout: result.stdout,
        stderr: result.stderr,
      },
      cause: error,
    });
  }
}

async function isInstallSatisfied(runtime, installMarker, requirementsHash, torchPlan) {
  if (!installMarker || installMarker.version !== TORCH_INSTALL_MARKER_VERSION) {
    return false;
  }
  if (installMarker.requirementsHash !== requirementsHash) {
    return false;
  }
  // ⚠️ 有意**不**把 torchPlan.policyKey 当硬门槛（v2 相对 v1 的唯一改动）。
  //
  // 为什么：policyKey 由 nvidia-smi 输出解析而来，而**解析结果会随驱动版本漂移**。
  // 本机实测：v1 建环境时拿到的 key 是 `win-native-auto-unknown-...`（当时解析不出 CUDA 版本），
  // 而 v2 在受限 AppHost 里根本探测不到 GPU，算出 `win-native-auto-cpu`。
  // 两边不一致 → 判定“未满足” → `pip uninstall torch` + 重下 200MB。
  // 共享同一个 venv 时，两个应用会这样互相拆台。
  //
  // policyKey 的本意只是“要不要换成 CUDA 版”这个优化，不该是装不装的硬门槛；
  // torch 到底能不能用，由下面的 torchState 检查覆盖。
  const torchState = await queryTorchState(runtime);
  return isTorchStateCompatible(torchState, torchPlan, installMarker.installedTorchKey);
}

async function readInstallMarker(markerFile) {
  if (!(await fileExists(markerFile))) {
    return null;
  }
  const raw = (await fs.readFile(markerFile, "utf-8")).trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {
      version: 1,
      requirementsHash: raw,
    };
  }
}

async function writeInstallMarker(markerFile, marker) {
  await fs.writeFile(markerFile, `${JSON.stringify(marker)}\n`, "utf-8");
}

async function resolveTorchInstallPlan(runtime) {
  const devicePreference = runtime.settings.whisperDevice;
  if (runtime.mode !== "native" || process.platform !== "win32") {
    return {
      policyKey: `generic-${runtime.mode}-${devicePreference}`,
      candidates: [],
      preferredFamily: "any",
      requiredFamily: devicePreference === "cuda" ? "cuda" : null,
      allowFallback: devicePreference !== "cuda",
    };
  }

  if (devicePreference === "cpu") {
    return {
      policyKey: "win-native-cpu",
      candidates: [{ family: "cpu", tag: "cpu", indexUrl: TORCH_CPU_INDEX_URL }],
      preferredFamily: "cpu",
      requiredFamily: null,
      allowFallback: true,
    };
  }

  const gpuInfo = await probeWindowsNvidia();
  if (!gpuInfo.detected) {
    if (devicePreference === "cuda") {
      throw new BiliIntakeError("已显式要求使用 CUDA，但当前 Windows 环境没有检测到可用的 NVIDIA GPU。", {
        code: "CUDA_GPU_NOT_FOUND",
      });
    }
    return {
      policyKey: "win-native-auto-cpu",
      candidates: [{ family: "cpu", tag: "cpu", indexUrl: TORCH_CPU_INDEX_URL }],
      preferredFamily: "cpu",
      requiredFamily: null,
      allowFallback: true,
      gpuInfo,
    };
  }

  const cudaTags = buildCudaWheelTags(gpuInfo.cudaVersion);
  const cudaCandidates = cudaTags.map(tag => ({
    family: "cuda",
    tag,
    indexUrl: `https://download.pytorch.org/whl/${tag}`,
  }));
  const candidates = [
    ...cudaCandidates,
    ...(devicePreference === "auto" ? [{ family: "cpu", tag: "cpu-fallback", indexUrl: TORCH_CPU_INDEX_URL }] : []),
  ];
  return {
    policyKey: `win-native-${devicePreference}-${gpuInfo.cudaVersion || "unknown"}-${cudaTags.join(">")}`,
    candidates,
    preferredFamily: "cuda",
    requiredFamily: devicePreference === "cuda" ? "cuda" : null,
    allowFallback: devicePreference === "auto",
    gpuInfo,
  };
}

async function installTorch(runtime, pythonExe, torchPlan) {
  if (torchPlan.candidates.length === 0) {
    const existing = await queryTorchState(runtime);
    return {
      markerKey: existing?.cudaAvailable ? "existing-cuda" : "existing-or-managed-by-requirements",
    };
  }

  const failures = [];
  for (const candidate of torchPlan.candidates) {
    try {
      await runCommand(runtime, [pythonExe, "-m", "pip", "uninstall", "-y", "torch", "torchvision", "torchaudio"], {
        label: `pip-uninstall-torch-${candidate.tag}`,
        inputPaths: [pythonExe],
      });
      await runCommand(runtime, [pythonExe, "-m", "pip", "install", "--index-url", candidate.indexUrl, "torch"], {
        label: `pip-install-torch-${candidate.tag}`,
        inputPaths: [pythonExe],
      });
      const torchState = await queryTorchState(runtime);
      if (!isTorchStateCompatible(torchState, {
        preferredFamily: candidate.family,
        requiredFamily: candidate.family === "cuda" ? "cuda" : null,
      })) {
        throw new BiliIntakeError(`已尝试安装 ${candidate.tag} 版 torch，但当前环境仍未满足 ${candidate.family} 要求。`, {
          code: "TORCH_VARIANT_MISMATCH",
          details: {
            candidate: candidate.tag,
            torchState,
          },
        });
      }
      return {
        markerKey: candidate.tag,
        state: torchState,
      };
    } catch (error) {
      failures.push({
        candidate: candidate.tag,
        message: error instanceof Error ? error.message : String(error),
      });
      if (!torchPlan.allowFallback || candidate === torchPlan.candidates.at(-1)) {
        throw new BiliIntakeError("安装 Whisper 所需的 torch 运行时失败。", {
          code: "TORCH_INSTALL_FAILED",
          details: {
            preferredFamily: torchPlan.preferredFamily,
            requiredFamily: torchPlan.requiredFamily,
            failures,
          },
          cause: error,
        });
      }
    }
  }

  throw new BiliIntakeError("安装 Whisper 所需的 torch 运行时失败。", {
    code: "TORCH_INSTALL_FAILED",
    details: {
      preferredFamily: torchPlan.preferredFamily,
      requiredFamily: torchPlan.requiredFamily,
      failures,
    },
  });
}

export function parseHelperJson(stdout) {
  const normalized = String(stdout ?? "").trim();
  if (!normalized) {
    throw new Error("empty stdout");
  }

  try {
    return JSON.parse(normalized);
  } catch {
    // helper 的 stdout 理论上应该只包含 JSON，但第三方库偶尔会向 stdout 打日志。
    // 这里按行倒序回溯，提取最后一个可解析的 JSON 对象。
    const lines = normalized
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines.slice(index).join("\n").trim();
      if (!(candidate.startsWith("{") || candidate.startsWith("["))) {
        continue;
      }
      try {
        return JSON.parse(candidate);
      } catch {
        // try earlier line
      }
    }
    throw new Error("no JSON payload found in stdout");
  }
}

async function queryTorchState(runtime) {
  if (!(await isVenvReady(runtime))) {
    return null;
  }
  const pythonExe = getVenvPython(runtime);
  try {
    const result = await runCommand(runtime, [
      pythonExe,
      "-c",
      "import json, torch; print(json.dumps({'version': torch.__version__, 'cudaVersion': torch.version.cuda, 'cudaAvailable': bool(torch.cuda.is_available()), 'deviceCount': int(torch.cuda.device_count())}, ensure_ascii=False))",
    ], {
      label: "torch-probe",
      inputPaths: [pythonExe],
    });
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

function isTorchStateCompatible(torchState, torchPlan, installedTorchKey = "") {
  if (!torchState || !torchState.version) {
    return false;
  }
  if (torchPlan.requiredFamily === "cuda") {
    return torchState.cudaAvailable === true;
  }
  if (torchPlan.preferredFamily === "cuda") {
    if (torchState.cudaAvailable === true) {
      return true;
    }
    return typeof installedTorchKey === "string" && installedTorchKey.startsWith("cpu");
  }
  return true;
}

async function probeWindowsNvidia() {
  try {
    const result = await spawnAndCollect("nvidia-smi", [], "nvidia-smi", {
      mode: "native",
      runtimeRoot: process.cwd(),
    });
    const text = `${result.stdout}\n${result.stderr}`;
    return {
      detected: true,
      cudaVersion: parseCudaVersionFromNvidiaSmi(text),
      raw: text,
    };
  } catch {
    return {
      detected: false,
      cudaVersion: "",
      raw: "",
    };
  }
}

export function parseCudaVersionFromNvidiaSmi(text) {
  const match = /CUDA Version:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(String(text || ""));
  return match ? match[1] : "";
}

export function buildCudaWheelTags(cudaVersion) {
  const parsed = parseNumericVersion(cudaVersion);
  if (parsed === null) {
    return TORCH_CUDA_WHEELS.map(item => item.tag);
  }
  const supported = TORCH_CUDA_WHEELS
    .filter(item => parsed >= parseNumericVersion(item.minCuda))
    .map(item => item.tag);
  return supported.length > 0 ? supported : ["cu118"];
}

function parseNumericVersion(version) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(version || "").trim());
  if (!match) {
    return null;
  }
  return Number(match[1]) + Number(match[2] || 0) / 10;
}

async function runCommand(runtime, args, options = {}) {
  const { label = "command", inputPaths = [], timeoutMs } = options;
  if (runtime.mode === "wsl") {
    const translated = [];
    for (const arg of args) {
      translated.push(await maybeToWslPath(arg, inputPaths));
    }
    return spawnAndCollect("wsl.exe", ["-e", ...translated], label, runtime, timeoutMs);
  }
  return spawnAndCollect(args[0], args.slice(1), label, runtime, timeoutMs);
}

/**
 * 用 runtime 解析出的 python 跑 collector，参数由调用方原样给。
 *
 * 存在的意义：路由层（http/intake.js）需要几种 runCollector 不覆盖的参数形状
 * （--action / --list-logins / --logout …），而它过去是 `execFileSync("python", …)`
 * 硬编码 —— 那会走系统 Python，与模型工具走的共享 venv 不是同一个解释器，
 * 于是同一个 App 里 health 报 cuda true、工具报 cpu，两个答案。
 * 统一到这条通道后，两条路径共用一个 venv、一套环境变量、一套超时。
 */
export async function runCollectorArgs(runtime, extraArgs, options = {}) {
  const pythonExe = getVenvPython(runtime);
  return runCommand(runtime, [pythonExe, runtime.collectorPath, ...extraArgs], {
    label: options.label || "collector",
    inputPaths: [pythonExe, runtime.collectorPath, ...(options.inputPaths || [])],
    timeoutMs: options.timeoutMs,
  });
}

const SPAWN_TIMEOUT_MS = 180_000; // 3 min — matches route-layer execFileSync timeout

function spawnAndCollect(command, args, label, runtime, timeoutMs = SPAWN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildEnv(runtime),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGTERM"); } catch {}
        reject(new BiliIntakeError(`执行 ${label} 超时（${timeoutMs / 1000}s）。`, {
          code: "COMMAND_TIMEOUT",
          details: { command, args, timeout: timeoutMs },
        }));
      }
    }, timeoutMs);

    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    child.on("error", error => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new BiliIntakeError(`执行 ${label} 失败。`, {
          code: "SPAWN_FAILED",
          details: { command, args },
          cause: error,
        }));
      }
    });
    child.on("close", code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new BiliIntakeError(`执行 ${label} 失败，退出码 ${code}。`, {
          code: "COMMAND_FAILED",
          details: { command, args, stdout, stderr, code },
        }));
      }
    });
  });
}

function buildEnv(runtime) {
  const env = { ...process.env };
  env.PYTHONUTF8 = "1";
  env.PIP_DISABLE_PIP_VERSION_CHECK = "1";
  if (runtime.mode === "native") {
    const cacheRoot = path.join(runtime.runtimeRoot, "cache");
    env.WHISPER_CACHE_DIR = path.join(cacheRoot, "whisper");
    if (process.platform !== "win32") {
      env.XDG_CACHE_HOME = cacheRoot;
    }
  }
  return env;
}

async function maybeToWslPath(value, candidates) {
  if (typeof value !== "string" || !value) {
    return value;
  }

  const matchedPath = candidates.find(candidate => candidate && path.normalize(candidate) === path.normalize(value));
  if (matchedPath) {
    return toWslPath(matchedPath);
  }
  if (/^[A-Za-z]:\\/.test(value) || /^[A-Za-z]:\//.test(value)) {
    return toWslPath(value);
  }
  return value;
}

async function toWslPath(inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("wsl.exe", ["-e", "wslpath", "-a", inputPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    child.on("error", error => {
      reject(new BiliIntakeError("调用 wslpath 失败。", {
        code: "WSLPATH_FAILED",
        details: { inputPath },
        cause: error,
      }));
    });
    child.on("close", code => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new BiliIntakeError(`wslpath 失败，退出码 ${code}。`, {
        code: "WSLPATH_FAILED",
        details: { inputPath, stderr, code },
      }));
    });
  });
}
