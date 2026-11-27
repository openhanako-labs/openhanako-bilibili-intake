/**
 * lib/shots/ocr-fill.js — 第二刀：定时 OCR 补静态小字。
 *
 * 分工：视觉模型只描述画面（desc/emotion），屏幕文字交给离线 OCR。
 * 为什么补 OCR：场景切镜天生偏重"变化大的片段"，字幕 / 参数 / 静态图表恰恰
 * 攒不出变化；档 A 又把整段的视觉判断押在 start+15%span 一张帧上，段中闪现的
 * 小字命中全凭运气（实测 B 段 12s 的营收漏读）。OCR 按固定节奏扫多帧，不赌。
 *
 * 采样节奏（"宁可别漏"档）：
 *   - 每段首帧必 OCR；
 *   - 长静止段补采中段一帧（防字卡翻转 / 段中闪现）。
 * 与场景切镜互补，不替代。
 *
 * 回退链：某段 OCR 为空或全低于阈值 → 不打 'ok' 标记，vision-fill 见状自动
 * 退回旧三格 prompt，让视觉模型读该段 onscreenText。所以 onscreenText 不断源。
 *
 * 子进程通道：走 runtime 的 venv python（getVenvPython），脚本在 APP 自己的
 * python/ 目录 —— 不依赖 Work 路径（AppHost 的 Node fs 白名单读不到，实测 ERR_ACCESS_DENIED）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getVenvPython, prepareRuntime } from "../runtime.js";
import { getSettings } from "../settings.js";
import { resolveFfmpeg } from "./index.js";

const r2 = (n) => Math.round(Number(n) * 100) / 100;

/** 段是否"长静止档"：秒数够长，或实测运动量低于阈值。档 A 没有 motion，就按时长兜底。 */
function isLongStill(seg, { minSeconds, staticMaxMotion }) {
  const seconds = Number(seg?.seconds) || 0;
  if (seconds >= minSeconds) return true;
  const m = Number(seg?.motion);
  return Number.isFinite(m) && m < staticMaxMotion && seconds >= 2;
}

/**
 * 用 ffmpeg 从视频抽一帧到 outPath（-ss 精确定位到"中段"）。
 * 失败返回 false，不阻断整段 —— 首帧 OCR 仍在。
 */
function grabFrame(videoPath, at, outPath, ffmpegBin, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    const child = spawn(ffmpegBin, [
      "-v", "error", "-y", "-ss", String(r2(at)), "-i", videoPath,
      "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "3", outPath,
    ], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* noop */ } finish(false); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); finish(false); });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0);
    });
  });
}

/** 跑一次内置 OCR 脚本，返回 JSON 报告。stdout 里可能混进告警，取第一个 { 到最后一个 }。 */
function runOcrScript(pythonExe, scriptPath, framePaths, minScore, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [scriptPath, "ocr", ...framePaths, "--json", "--quiet", "--min-score", String(minScore)];
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(pythonExe, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch { /* noop */ }
      reject(new Error(`OCR 超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new Error(`OCR 子进程启动失败：${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`OCR 退出码 ${code}：${String(stderr).slice(-300)}`));
        return;
      }
      const i = stdout.indexOf("{");
      const j = stdout.lastIndexOf("}");
      if (i < 0 || j <= i) {
        reject(new Error(`OCR 没回 JSON：${String(stdout).slice(0, 200)}`));
        return;
      }
      try { resolve(JSON.parse(stdout.slice(i, j + 1))); }
      catch (e) { reject(new Error(`OCR JSON 解析失败：${e.message}`)); }
    });
  });
}

/**
 * 给锚点表逐段补 onscreenText / onscreenTextScores。
 *
 * @returns {{ok, total, ocrd, empty, failed, fallback, midFrames, minScore, elapses, errors[], anchorsPath}}
 */
export async function fillOcr({
  anchorsPath,
  videoPath = "",
  ctx = null,
  settings = null,
  minScore = 0.5,
  midFrameSeconds = 6,
  staticMaxMotion = 1.5,
  ocrTimeoutMs = 120000,
  ffmpegTimeoutMs = 30000,
  signal = null,
} = {}) {
  if (!anchorsPath || !fs.existsSync(anchorsPath)) {
    return { ok: false, error: `锚点表不存在：${anchorsPath}` };
  }
  const doc = JSON.parse(fs.readFileSync(anchorsPath, "utf-8"));
  const segments = Array.isArray(doc?.segments) ? doc.segments : [];
  if (!segments.length) return { ok: false, error: "锚点表里没有段" };

  const pluginDir = String(ctx?.pluginDir || "").trim()
    || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const scriptPath = path.join(pluginDir, "python", "ocr-image.py");
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `APP 内置 OCR 脚本缺失：${scriptPath}` };
  }

  const effectiveSettings = settings || (ctx ? await getSettings(ctx) : {});
  const runtime = ctx ? await prepareRuntime(ctx, effectiveSettings) : null;
  const pythonExe = runtime ? getVenvPython(runtime) : "python";

  let ffmpegBin = "ffmpeg";
  if (videoPath) {
    try {
      const b = resolveFfmpeg({
        ffmpegPath: effectiveSettings.ffmpegPath || "",
        ffprobePath: effectiveSettings.ffprobePath || "",
      });
      ffmpegBin = b.ffmpeg || "ffmpeg";
    } catch { ffmpegBin = "ffmpeg"; }
  }

  const errors = [];
  let ocrd = 0;
  let empty = 0;
  let failed = 0;
  let midFrames = 0;
  const elapses = [];

  const save = () => {
    doc.ocrFill = { minScore, filledAt: new Date().toISOString(), ocrd, empty, failed, midFrames };
    fs.writeFileSync(anchorsPath, JSON.stringify(doc, null, 2), "utf8");
  };

  // 先把每段的待 OCR 帧列出来（首帧必取；长静止段补采中段），一次性批量喂给 OCR 脚本，
  // 省掉每段一次引擎初始化（实测冷启 0.5s，逐段 spawn 会放大 60 倍）。
  const plan = [];
  for (let i = 0; i < segments.length; i++) {
    if (signal?.aborted) break;
    const seg = segments[i];
    const frames = [];
    const first = (Array.isArray(seg.frames) ? seg.frames : []).find((f) => f && fs.existsSync(f));
    if (first) frames.push({ path: first, role: "first" });

    const needMid = Boolean(videoPath) && isLongStill(seg, { minSeconds: midFrameSeconds, staticMaxMotion });
    if (needMid && first) {
      const start = Number(seg.start) || 0;
      const end = Number(seg.end) || start;
      const at = start + Math.max(0, end - start) * 0.5;
      const midPath = path.join(path.dirname(first), `${seg.shotId || `S${String(i + 1).padStart(2, "0")}`}m.jpg`);
      const ok = await grabFrame(videoPath, at, midPath, ffmpegBin, ffmpegTimeoutMs);
      if (ok) { frames.push({ path: midPath, role: "mid" }); midFrames++; }
    }
    plan.push({ seg, index: i, frames });
  }

  // 全部帧一次 OCR（--json 按 source 分组回传）。
  const allPaths = plan.flatMap((p) => p.frames.map((f) => f.path));
  let report = null;
  if (allPaths.length) {
    try {
      report = await runOcrScript(pythonExe, scriptPath, allPaths, minScore, ocrTimeoutMs);
      for (const r of report.results || []) {
        if (Number.isFinite(r.elapsed)) elapses.push(r.elapsed);
      }
    } catch (e) {
      const msg = `OCR 整批失败：${e.message}`;
      errors.push(msg);
      // 整批失败 → 全部段不打 ok 标记，交给 vision-fill 回退读字。
      for (const p of plan) { p.seg.ocrStatus = "failed"; p.seg.onscreenTextScores = []; }
      save();
      return {
        ok: false, error: msg, total: segments.length, ocrd: 0, empty: 0,
        failed: segments.length, fallback: segments.length, midFrames,
        minScore, elapses, errors, anchorsPath,
      };
    }
  }

  const bySource = new Map();
  for (const r of (report?.results || [])) {
    bySource.set(String(r.source), r.lines || []);
  }
  for (const f of (report?.failed || [])) {
    errors.push(`OCR 单帧失败：${path.basename(String(f.source))} —— ${f.error}`);
  }

  // 按段汇总：首帧 + 中段帧的行一起，按置信度排序，去重（同文本保留最高分）。
  for (const p of plan) {
    const seg = p.seg;
    const lines = [];
    for (const fr of p.frames) {
      for (const l of (bySource.get(fr.path) || [])) {
        lines.push({ text: String(l.text || "").trim(), score: Number(l.score) || 0 });
      }
    }
    if (!lines.length) {
      seg.ocrStatus = "empty";
      seg.onscreenText = "";
      seg.onscreenTextScores = [];
      empty++;
      continue;
    }
    const seen = new Map();
    for (const l of lines) {
      if (!l.text) continue;
      const prev = seen.get(l.text);
      if (!prev || l.score > prev.score) seen.set(l.text, l);
    }
    const sorted = [...seen.values()].sort((a, b) => b.score - a.score);
    seg.onscreenText = sorted.map((l) => l.text).join("\n");
    seg.onscreenTextScores = sorted.map((l) => ({ text: l.text, score: l.score }));
    seg.ocrStatus = "ok";   // ← vision-fill 见此标记就走两格，不再读字
    seg.ocrAt = new Date().toISOString();
    ocrd++;
    save();   // 每段存一次
  }

  const fallback = empty + failed;
  if (ocrd || empty || failed) save();
  return {
    ok: true,
    total: segments.length,
    ocrd,
    empty,
    failed,
    fallback,   // = 需要 vision-fill 回退读字的段数
    midFrames,
    minScore,
    elapses,
    errors: errors.slice(0, 12),
    anchorsPath,
  };
}
