/**
 * lib/legacy-runtime.js — 决定用哪个 Python 运行时根目录。
 *
 * 背景：v1 建好的 `.runtime/venv-win` 里有 torch，实测 **1.08 GB**，
 * 重建代价极大（而且实测重建会失败，见下）。
 *
 * ⚠️ 本文件的核心约束：**AppHost 跑在 Node 权限模型下，读不到 `app-data` 之外的路径。**
 *
 * 这条约束推翻了一个看起来很自然的写法：
 *
 *     if (fs.existsSync(候选路径)) 用 v1 的   // ← 错的
 *
 * `fs.existsSync` 会抛 ERR_ACCESS_DENIED（被 catch 吞掉），于是永远判定"v1 不存在"，
 * 转而走 bootstrap 重建 —— 实测结果：`.runtime/venv-win` 和 `venv-wsl` 建出来都是
 * **空目录**，bootstrap 失败，最终报「自动选择 Python 运行环境失败」。
 * 而真实原因只是**探测被权限拒了**，v1 的环境其实完好。
 *
 * 所以这里的原则是：**JS 侧不做任何关于盘外文件的存在性判断。**
 * 盘外的读写交给 python 子进程（它不继承 Node 权限模型），JS 只负责给出路径。
 *
 * 解析优先级：
 *   1. 用户显式配置的 `runtimeRoot`（可写、可 bootstrap）
 *   2. 自有目录里**确实已有** venv（app-data 内，探测可靠）
 *   3. 默认指向 v1 的位置 —— **不探测**，直接假定可用
 */

import fs from "node:fs";
import path from "node:path";

const LEGACY_PLUGIN_ID = "hanako-bilibili-intake";

/** 一个 venv 根目录里，判定"已就绪"要找的可执行文件（按平台各一种）。 */
function venvPythonCandidates(venvDir) {
  return [
    path.join(venvDir, "Scripts", "python.exe"),
    path.join(venvDir, "bin", "python"),
    path.join(venvDir, "bin", "python3"),
  ];
}

/** `<HANA_HOME>`：`<HANA_HOME>/app-data/<id>` 往上两层。 */
export function hanakoHomeFromDataDir(dataDir) {
  return path.dirname(path.dirname(dataDir));
}

/** v1 的 runtime 根目录候选（纯函数，方便单测）。 */
export function legacyRuntimeCandidate(dataDir, runtimeDirName) {
  return path.join(hanakoHomeFromDataDir(dataDir), "plugin-data", LEGACY_PLUGIN_ID, runtimeDirName);
}

/**
 * @param {string} dataDir 本 App 的数据目录
 * @param {string} runtimeDirName 例如 ".runtime"
 * @param {{ warn?: Function, info?: Function }} [log]
 * @param {string} [configured] 用户在设置里显式指定的 runtime 根目录（绝对路径）
 * @returns {{ root: string, reused: boolean, source: "config"|"own"|"legacy" }}
 *   `reused: true` 表示用的是 **App 之外的目录**（v1 的）。调用方据此必须：
 *     a) 关掉 bootstrap —— 往别人的目录里 pip install 会同时搞坏 v1 的环境；
 *     b) 跳过一切 fs 检查 —— 那些路径本进程读不到，检查只会误判；
 *     c) 不回退 WSL —— v1 的环境只有 Windows 原生版。
 */
export function resolveRuntimeRoot(dataDir, runtimeDirName, log, configured) {
  // 1) 显式配置优先。用户自己指的目录，视为可写、可 bootstrap。
  const want = typeof configured === "string" ? configured.trim() : "";
  if (want) {
    const root = path.resolve(want);
    log?.info?.("使用配置指定的 Python 运行时目录", { runtimeRoot: root });
    return { root, reused: false, source: "config" };
  }

  // 2) 自有目录里已经有可用 venv → 用它。app-data 在许可根内，这个探测是可靠的。
  const own = path.join(dataDir, runtimeDirName);
  try {
    for (const winVenv of ["venv-win", "venv-wsl"]) {
      const venvDir = path.join(own, winVenv);
      if (venvPythonCandidates(venvDir).some((p) => fs.existsSync(p))) {
        log?.info?.("复用本 App 自有目录里的 Python 环境", { runtimeRoot: own });
        return { root: own, reused: false, source: "own" };
      }
    }
  } catch { /* app-data 内不该被拒；真被拒了就当没有 */ }

  // 3) 默认指向 v1 的位置，**不做探测**（探测必被权限拒，见文件头）。
  const legacy = legacyRuntimeCandidate(dataDir, runtimeDirName);
  log?.warn?.(
    "默认复用 v1 插件的 Python 环境（有意不做探测：AppHost 读不到 app-data 之外）",
    { runtimeRoot: legacy, hint: "若该路径已不存在，请在设置里指定 runtimeRoot，或清空它让本 App 自行重建" },
  );
  return { root: legacy, reused: true, source: "legacy" };
}
