/**
 * tests/verify-app.mjs — 不装 Hana，用 mock ctx 把装载路径跑一遍。
 *
 * 覆盖：apply() 能否跑完、四个工具是否注册、routes.register 是否被调用、
 * intake_health 能否真起 python 并拿到真实环境数据、新加的 background 分支
 * 在没有 ctx.tasks 时是否优雅降级（而不是抛）。
 *
 * 用法：node tests/verify-app.mjs
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { legacyRuntimeCandidate, resolveRuntimeRoot } from "../lib/legacy-runtime.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// 自检的数据目录要落在**真实 HANA_HOME 结构**下，否则 v1 runtime 的候选路径推不出来。
// HANA_HOME 在 Windows 上是 %USERPROFILE%\.hanako（本机为指向 W: 的符号链接）。
const HANA_HOME = process.env.HANA_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || "", ".hanako");
const DATA_DIR = path.join(HANA_HOME, "app-data", "bilibili-intake-v2-selfcheck");
const RESULTS = [];
const ok = (n, d = "") => { RESULTS.push(["ok", n, d]); console.log(`  ✓ ${n}${d ? " — " + d : ""}`); };
const bad = (n, d = "") => { RESULTS.push(["FAIL", n, d]); console.log(`  ✗ ${n}${d ? " — " + d : ""}`); };

function makeCtx() {
  const state = { tools: [], routes: 0, taskNoop: true };
  const ctx = {
    dataDir: DATA_DIR,
    logger: { info: () => {}, warn: () => {}, error: (...a) => console.log("    [app-error]", ...a), debug: () => {} },
    config: { get: async () => undefined },
    tools: {
      register(def) { state.tools.push(def); return () => {}; },
    },
    routes: {
      async register(cb) { state.routes++; cb({ get() {}, post() {} }); return () => {}; },
    },
    // 有意**不**提供 ctx.tasks —— 验证降级路径
  };
  return { ctx, state };
}

console.log("=== bilibili-intake-v2 装载自检 ===\n");

// ── 单测：v1 runtime 路径推导 ──
console.log("--- legacy runtime 路径解析 ---");
const fakeDataDir = path.join("C:", "H", "app-data", "bilibili-intake-v2");
const cand = legacyRuntimeCandidate(fakeDataDir, ".runtime");
if (cand === path.join("C:", "H", "plugin-data", "hanako-bilibili-intake", ".runtime")) ok("候选路径推导正确", cand);
else bad("候选路径推导错误", cand);

// 没有任何 runtime 时：默认指向 v1 的位置且 reused=true（有意不探测 —— AppHost 读不到盘外）。
const emptyRoot = path.join(ROOT, "nowhere-does-not-exist");
const r1 = resolveRuntimeRoot(emptyRoot, ".runtime");
if (r1.reused === true && r1.source === "legacy" && r1.root === legacyRuntimeCandidate(emptyRoot, ".runtime")) {
  ok("无自有 venv 时默认指向 v1 位置（reused=true）", r1.root);
} else bad("默认回退逻辑异常", JSON.stringify(r1));

// 显式配置优先且 reused=false。
const r2 = resolveRuntimeRoot(emptyRoot, ".runtime", undefined, "D:\\my-runtime");
if (r2.reused === false && r2.source === "config") ok("显式配置的 runtimeRoot 优先，reused=false");
else bad("配置优先逻辑异常", JSON.stringify(r2));

// 让 intake_health 能直接复用 v1 已建好的 1GB venv —— 这正是修好后的生产路径，
// 不再需要 junction 伪装自有目录。
const legacyRoot = path.join(HANA_HOME, "plugin-data", "hanako-bilibili-intake", ".runtime", "venv-win", "Scripts", "python.exe");
if (fs.existsSync(legacyRoot)) console.log(`  使用 v1 运行时: ${legacyRoot}`);
else console.log(`  ! 未找到 v1 运行时 (${legacyRoot})，intake_health 会尝试 bootstrap（很慢）`);
console.log("");

const { ctx, state } = makeCtx();
const mod = await import(pathToFileURL(path.join(ROOT, "index.js")).href);

if (typeof mod.apply !== "function") { bad("index.js 导出 apply"); process.exit(1); }
ok("index.js 导出 apply", `name=${mod.name}`);

let disposer;
try {
  disposer = await mod.apply(ctx);
  ok("apply() 正常返回");
} catch (e) {
  bad("apply() 抛错", e.message);
  process.exit(1);
}

// ── 工具注册 ──
const names = state.tools.map((t) => t.name).sort();
const expected = ["bilibili_video_intake", "generate_knowledge_map", "intake_health", "intake_routing"];
console.log("\n  注册的工具:", names.join(", "));
if (expected.every((n) => names.includes(n))) ok("四个工具都已注册");
else bad("工具注册不全", `缺 ${expected.filter((n) => !names.includes(n)).join(", ")}`);

if (names.every((n) => !n.includes("_" + "v2") && !n.startsWith("bilibili-intake-v2"))) ok("工具名未被加前缀（与 v1 不撞名）");
for (const t of state.tools) {
  if (!t.description || !t.parameters || typeof t.execute !== "function") bad(`工具 ${t.name} 契约不完整`);
}
ok("每个工具的 description/parameters/execute 齐备");

// ── 路由 ──
if (state.routes === 1) ok("routes.register 被调用一次");
else bad("routes.register 调用次数异常", String(state.routes));

// ── intake_health 真跑 ──
console.log("\n=== intake_health（真起 python）===");
const health = state.tools.find((t) => t.name === "intake_health");
if (!health) {
  bad("找不到 intake_health");
} else {
  try {
    const res = await health.execute({ context: { sessionPath: "x", callToken: null } });
    const text = String(res?.content?.[0]?.text ?? "");
    const parsed = JSON.parse(text);
    // v1 的 intake_health 直接回 collector 的原始 JSON（{action, runtime, platforms}），
    // 不是沙盒那种 {ok, stdout} 信封 —— 两种都接受。
    const runtimeInfo = parsed.runtime || (parsed.stdout ? JSON.parse(parsed.stdout).runtime : null);
    if (parsed.ok === true || runtimeInfo?.python) ok("intake_health 返回真实环境数据", `elapsed=${parsed.elapsedMs ?? "?"}ms`);
    else bad("intake_health 未成功", text.slice(0, 300));
    if (runtimeInfo?.python) ok("拿到真实 python 版本", runtimeInfo.python);
    const platforms = parsed.platforms || (parsed.stdout ? JSON.parse(parsed.stdout).platforms : null);
    if (platforms?.bilibili?.status) ok("拿到 B站连通状态", `${platforms.bilibili.status} / ${platforms.bilibili.latency_ms ?? "?"}ms`);
    if (runtimeInfo) console.log(`   （注：cuda_available=${runtimeInfo.cuda_available}，与 v1 venv 装的 CPU 版 torch 一致）`);
  } catch (e) {
    bad("intake_health 执行抛错", e.message);
  }
}

// ── background 降级 ──
console.log("\n=== background 分支（ctx.tasks 缺失时应优雅降级）===");
const intake = state.tools.find((t) => t.name === "bilibili_video_intake");
if (!intake) {
  bad("找不到 bilibili_video_intake");
} else {
  const hasParam = !!intake.parameters?.properties?.background;
  hasParam ? ok("background 参数已进 schema") : bad("background 参数缺失");
  try {
    const res = await intake.execute({ source: "BV1xx411c7mD", background: true });
    const text = String(res?.content?.[0]?.text ?? "");
    if (text.includes("后台任务能力") || text.includes("ctx.tasks")) ok("无 ctx.tasks 时返回明确错误而非抛异常");
    else if (text.includes("taskId")) bad("mock ctx 没有 tasks 却仍然创建了任务");
    else ok("background 分支返回了结果", text.slice(0, 80));
  } catch (e) {
    bad("background 分支抛异常", e.message);
  }
}

try { disposer?.(); ok("disposer 可调用"); } catch (e) { bad("disposer 抛错", e.message); }

// 清理自检数据目录（真实 HANA_HOME 下，不留垃圾）
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

// ── 汇总 ──
const failed = RESULTS.filter(([s]) => s === "FAIL");
console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} 通过 ===`);
if (failed.length) {
  for (const [, n, d] of failed) console.log(`  FAIL ${n}: ${d}`);
  process.exit(1);
}
