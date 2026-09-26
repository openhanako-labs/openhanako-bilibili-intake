/**
 * lib/shots/index.js — W2（2026-09-26）：帧分析的 Node 侧入口。
 *
 * 算法本体在 ./core.js（reelbench-skills 的 vendor，Apache-2.0，见 ./LICENSE）。
 * 这一层只做上游没做的三件事：
 *   1. **ffmpeg / ffprobe 的路径与 PATH 注入** —— AppHost 给子进程的环境变量是白名单，
 *      ffmpeg 未必在 PATH 里（这个坑本 App 已经踩过一次，见 BUG-018 那类）。
 *   2. **目录全部走调用方给的绝对路径** —— 上游默认 `frames/`、`sheets/` 是相对当前目录。
 *   3. **我们自己的产物**：shots.json / track.json / frames/ / sheets/ / visual_anchors.json。
 *
 * 两档（月曦夜 2026-09-26 定）：帧分析整体手动开；开了之后选 A 或 B。
 *   A 内容档：切点 + 每镜一张起手帧 + 视觉模型填「画面 / 情绪 / 屏幕文字」，服务总结锚点
 *   B 镜头语言档：加运动量曲线、首尾两帧、联系表、全套质量门
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildSeed, detectCuts, motionTrack, probe, recut, renderHtml, stats, validate,
} from "./core.js";

// 词表、阈值、门名、报告渲染等都透出去，调用方不必再 import ./core.js
export * from "./core.js";

/* ────────────────────────── 档位 ────────────────────────── */

export const PROFILE_A = Object.freeze({ threshold: 0.25, motion: false, single: true, sheet: false });
export const PROFILE_B = Object.freeze({ threshold: 0.3, motion: true, single: false, sheet: true });

/** 档 A 只跑这几道门（甲：门集白名单）。理由：录屏素材填「景别/运镜」是假信息。 */
export const GATES_PROFILE_A = Object.freeze(["timeline", "duration", "numbering", "frame-text", "dedup"]);

/* ────────────────────────── ffmpeg ────────────────────────── */

// 记住上一次解析用的「显式路径组合」。设置改了（或换了视频）就重新解析，
// 不能一次成型就永远不再看 —— 用户在设置里填了路径却要重启 App 才生效是很坏的体验。
let binsKey = null;

/**
 * 常见安装位置 —— “先设置后搜索”里那个“搜索”。
 * 设置里填了就以设置为准；没填（或填了但跑不起来）才来这里找。
 */
export function ffmpegCandidateDirs() {
  const home = process.env.USERPROFILE || "";
  const local = process.env.LOCALAPPDATA || "";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return [
    process.env.FFMPEG_HOME ? path.join(process.env.FFMPEG_HOME, "bin") : "",
    process.env.FFMPEG_HOME || "",
    "W:\\Games\\ffmpeg\\bin",
    "C:\\ffmpeg\\bin",
    path.join(pf, "ffmpeg", "bin"),
    path.join(pf86, "ffmpeg", "bin"),
    local ? path.join(local, "Microsoft", "WinGet", "Links") : "",
    local ? path.join(local, "Programs", "ffmpeg", "bin") : "",
    home ? path.join(home, "scoop", "shims") : "",
    "C:\\ProgramData\\chocolatey\\bin",
  ].filter(Boolean).filter((d) => existsSync(path.join(d, exe)));
}

/** 把目录塞进 PATH 最前面（core.js 内部是裸调 `ffmpeg`，只能靠 PATH 找到它）。 */
function prependPath(dirs) {
  if (!dirs.length) return;
  const sep = process.platform === "win32" ? ";" : ":";
  const cur = process.env.PATH || process.env.Path || "";
  const have = cur.toLowerCase().split(sep);
  const need = dirs.filter((d) => !have.includes(d.toLowerCase()));
  if (!need.length) return;
  const next = need.join(sep) + sep + cur;
  process.env.PATH = next;
  process.env.Path = next;   // Windows 上大小写不敏感，两个都写保险
}

/** 裸调一次 `bin -version`，能跑就算找到了。 */
function binRuns(bin) {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

/**
 * 绑定 ffmpeg / ffprobe。顺序：**先设置，后搜索**。
 *   ① 设置里填了绝对路径 → 注入 PATH，能用就用
 *   ② 没填（或填了仍不可用）→ 去常见安装位置找一遍（见 ffmpegCandidateDirs）
 *   ③ 都不行 → 报一个能照着做的错
 * @param {{ffmpegPath?: string, ffprobePath?: string, search?: boolean}} opts
 * @returns {{ffmpeg: string, ffprobe: string, pathInjected: string[], foundBy: string}}
 */
export function resolveFfmpeg({ ffmpegPath = "", ffprobePath = "", search = true } = {}) {
  const explicit = [];
  for (const p of [ffmpegPath, ffprobePath]) {
    const s = String(p || "").trim();
    if (!s || !path.isAbsolute(s)) continue;
    const dir = path.dirname(s);
    if (!explicit.some((d) => d.toLowerCase() === dir.toLowerCase())) explicit.push(dir);
  }

  const key = explicit.join(";").toLowerCase() + "|" + (search ? "s" : "-");
  if (binsKey === key) {
    return { ffmpeg: ffmpegPath || "ffmpeg", ffprobe: ffprobePath || "ffprobe", pathInjected: explicit, foundBy: explicit.length ? "setting" : "path" };
  }

  prependPath(explicit);
  let foundBy = explicit.length ? "setting" : "path";
  let injected = [...explicit];

  if (!binRuns("ffmpeg") || !binRuns("ffprobe")) {
    if (!search) {
      throw new Error(
        `找不到 ffmpeg / ffprobe。AppHost 给子进程的环境变量是白名单，ffmpeg 未必在 PATH 里。`
        + `请在设置里填「ffmpeg 路径」（例如 W:\\Games\\ffmpeg\\bin\\ffmpeg.exe），或把该目录加进 PATH。`,
      );
    }
    let solved = "";
    for (const dir of ffmpegCandidateDirs()) {
      if (injected.some((d) => d.toLowerCase() === dir.toLowerCase())) continue;
      prependPath([dir]);
      if (binRuns("ffmpeg") && binRuns("ffprobe")) { solved = dir; injected.push(dir); break; }
    }
    if (solved) {
      foundBy = "searched";
      if (process.env.SHOTS_DEBUG) console.error("[shots] ffmpeg 是搜出来的：" + solved);
    } else {
      throw new Error(
        `找不到 ffmpeg / ffprobe。AppHost 给子进程的环境变量是白名单，ffmpeg 未必在 PATH 里。`
        + `请在设置里填「ffmpeg 路径」（例如 W:\\Games\\ffmpeg\\bin\\ffmpeg.exe），或把该目录加进 PATH。`,
      );
    }
  }

  binsKey = key;
  return { ffmpeg: ffmpegPath || "ffmpeg", ffprobe: ffprobePath || "ffprobe", pathInjected: injected, foundBy };
}

/** 错误信息里别丢 stderr —— ffmpeg 的抱怨都写在那儿。 */
function ffmpeg(args, { silent = true } = {}) {
  // SHOTS_DEBUG=1 时把实际传出去的参数原样打一遍（排查滤镜串一类的问题靠它）。
  if (process.env.SHOTS_DEBUG) console.error("[shots] ffmpeg " + JSON.stringify(args));
  try {
    return execFileSync("ffmpeg", args, { encoding: "utf8", maxBuffer: 1 << 26, stdio: silent ? ["ignore", "ignore", "pipe"] : ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const tail = String(e?.stderr || e?.message || "").trim().split("\n").slice(-6).join(" / ");
    throw new Error(`ffmpeg 执行失败：${tail || "未知原因"}`);
  }
}

const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

function writeJson(file, obj) {
  writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  return file;
}

/**
 * 档 A 的分段策略（月曦夜 2026-09-26 定）。
 *
 * 为什么不能只用场景检测：录屏、口播这类素材本来就没几个镜头 ——
 * 实测一条 94 秒视频在 threshold 0.15 / 0.25 / 0.4 下都只切出 1 个镜头，
 * 等于“整条视频一个锚点”，锚点表就废了。
 *
 * 三条路一起用：
 *   1. **时间窗兜底**：任何一段不超过 maxSeconds（默认 20s）—— 保住粒度。
 *   2. **场景切点**：真有镜头变化就切在那儿 —— 不跨镜头。
 *   3. **字幕段边界吸附**：把切点往最近的字幕行首靠（挪动幅度不超过半个时间窗）
 *      —— 让段边界落在句子开头，而不是句子中间。
 *   4. **同一句里不重复切**：挪完以后按 minSeconds 去重，避免切出一堆两秒碎片。
 *
 * 三个输入都可能是空的（没字幕、没镜头变化），但时间窗兜底永远在，
 * 所以**任何素材都能切出可用的段**。
 *
 * @returns {Array<{start:number,end:number,seconds:number}>}
 */
export function segmentContent({ durationSeconds, cuts = [], subtitleSegments = [], maxSeconds = 20, minSeconds = 2, maxSegments = 0 } = {}) {
  const dur = Number(durationSeconds) || 0;
  const maxS = Math.max(3, Number(maxSeconds) || 20);
  const minS = Math.max(0, Number(minSeconds) || 2);
  if (!(dur > 0)) return [];

  // ⭐ 段数上限（设置里的 shotsMaxSegments）：长视频按 20 秒切会切出上百段，
  //   而档 A 每段要调一次视觉模型 —— 成本会失控。上限一旦会超，
  //   就把时间窗自动放大到“刚好不超”。**上限优先于秒数**：宁可段大一点，
  //   也不要一次几百回调用。
  const cap = Number(maxSegments) > 0 ? Math.floor(Number(maxSegments)) : 0;
  const win = cap > 0 ? Math.max(maxS, dur / cap) : maxS;

  const clean = (arr, pick) => [...new Set((Array.isArray(arr) ? arr : [])
    .map((x) => Number(pick ? x?.[pick] : x))
    .filter((n) => Number.isFinite(n) && n > 0.05 && n < dur - 0.05)
    .map((n) => r2(n)))].sort((a, b) => a - b);

  const scenes = clean(cuts);
  const subs = clean(subtitleSegments, "start");

  // 1) 时间窗兜底 + 2) 场景切点，合成候选切点
  const candidates = [];
  for (let t = win; t < dur - 0.05; t += win) candidates.push(r2(t));
  for (const c of scenes) if (!candidates.some((p) => Math.abs(p - c) < 0.35)) candidates.push(c);
  candidates.sort((a, b) => a - b);

  // 3) 字幕吸附：每个候选点找最近的字幕行首，但挪动不超过半个时间窗
  const snapped = candidates.map((p) => {
    if (!subs.length) return p;
    let best = null;
    for (const s of subs) {
      if (Math.abs(s - p) > win / 2) continue;
      if (s <= minS || s >= dur - minS) continue;
      if (best === null || Math.abs(s - p) < Math.abs(best - p)) best = s;
    }
    return best === null ? p : best;
  });

  // 4) 去重：离上一个保留点太近就丢掉
  const kept = [];
  for (const t of snapped.slice().sort((a, b) => a - b)) {
    if (t <= minS || t >= dur - minS) continue;
    if (kept.length && t - kept[kept.length - 1] < minS) continue;
    kept.push(t);
  }

  // 吸附可能把点往前挪、留下超长的尾巴 —— 超过 1.5 倍时间窗就补中点
  const bounds = [0, ...kept, dur];
  const final = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    let a = bounds[i];
    const b = bounds[i + 1];
    let guard = 0;
    while (b - a > win * 1.5 && guard++ < 64) {
      final.push(a);
      a = r2(a + (b - a) / Math.ceil((b - a) / win));
    }
    final.push(a);
  }
  final.push(dur);

  const segments = [];
  for (let i = 0; i < final.length - 1; i++) {
    const start = final[i];
    const end = final[i + 1];
    if (end - start < 0.3) continue;
    segments.push({ start: r2(start), end: r2(end), seconds: r2(end - start) });
  }

  // ⭐ 段数上限要**最终**够住。前面那个“把时间窗顶大”只拦得住网格，拦不住场景切点 ——
  //   实测一条 17:50 的视频切出 150 处场景切点，上限 60 却切了 128 段。
  //   所以这里再按等间隔并一次：合并掉的段并进前一段，保证总数 ≤ cap。
  if (cap > 0 && segments.length > cap) {
    const stride = segments.length / cap;
    const starts = [];
    // 最多放 cap - 1 个切点：两头还要各留 0 与片尾，否则会多出一段（实测 cap=30 会切出 31）。
    for (let i = 0; i < segments.length && starts.length < cap - 1; i += stride) {
      const s = segments[Math.floor(i)].start;
      if (s > 0.3) starts.push(s);
    }
    const bounds2 = [0, ...starts, dur];
    const out2 = [];
    for (let i = 0; i < bounds2.length - 1; i++) {
      const start = bounds2[i];
      const end = bounds2[i + 1];
      if (end - start < 0.3) continue;
      out2.push({ start: r2(start), end: r2(end), seconds: r2(end - start) });
    }
    return out2;
  }
  return segments;
}

/* ────────────────────────── 子步骤 ────────────────────────── */

/**
 * seed：探元信息 + 场景检测（+ 可选运动曲线）→ 镜头表底稿。
 * 切点与时长在这一步定死，后面模型只填字段。
 */
export function shotSeed({ videoPath, outDir, title = "", source = "", threshold, motion, hz = 5, subtitleSegments = [], segmentMaxSeconds = 0, segmentMaxCount = 0 } = {}) {
  if (!videoPath || !existsSync(videoPath)) throw new Error(`视频不存在：${videoPath}`);
  if (!outDir) throw new Error("outDir 不能为空");
  mkdirSync(outDir, { recursive: true });

  const meta = probe(videoPath);
  const sceneCuts = detectCuts(videoPath, threshold);

  // ⭐ segmentMaxSeconds > 0 = 走内容档的分段（时间窗 + 场景 + 字幕吸附），
  //   而不是拿场景切点当段边界。原因见 segmentContent 的注释。
  let cuts = sceneCuts;
  let contentSegments = null;
  if (Number(segmentMaxSeconds) > 0) {
    contentSegments = segmentContent({
      durationSeconds: meta.durationSeconds,
      cuts: sceneCuts,
      subtitleSegments,
      maxSeconds: Number(segmentMaxSeconds),
      maxSegments: Number(segmentMaxCount) || 0,
    });
    cuts = contentSegments.slice(1).map((s) => s.start);
  }

  const track = motion ? motionTrack(videoPath, hz) : null;
  const doc = buildSeed(meta, cuts, track, { title, source: source || videoPath });
  doc.profile = motion ? "B" : "A";
  doc.threshold = threshold;
  doc.generatedAt = new Date().toISOString();
  // 分段依据落进产物：以后看着这张表能答“这段凭什么这么切”。
  doc.segmentation = Number(segmentMaxSeconds) > 0
    ? {
      strategy: "content:window+scene+subtitle",
      maxSeconds: Number(segmentMaxSeconds),
      // 实际用的时间窗（段数上限会把 maxSeconds 顶大）—— 以后看着这张表能答"为什么只有这么多段"。
      windowSeconds: contentSegments && contentSegments.length
        ? r2(Math.max(...contentSegments.map((s) => s.seconds)))
        : Number(segmentMaxSeconds),
      maxSegments: Number(segmentMaxCount) || 0,
      // 段数刚好顶到上限 = 上限确实起了作用（场景切点太多时也会走这条路）。
      capHit: Number(segmentMaxCount) > 0 && contentSegments
        ? contentSegments.length >= Number(segmentMaxCount)
        : false,
      sceneCuts: sceneCuts.length,
      subtitleSegments: Array.isArray(subtitleSegments) ? subtitleSegments.length : 0,
    }
    : { strategy: "scene-only", sceneCuts: sceneCuts.length, subtitleSegments: 0 };
  if (contentSegments) doc.contentSegments = contentSegments;

  const shotsPath = writeJson(path.join(outDir, "shots.json"), doc);
  const trackPath = track ? writeJson(path.join(outDir, "track.json"), track) : "";
  return { doc, meta, cuts, sceneCuts, contentSegments, shotsPath, trackPath };
}

/** 每镜抽关键帧：起手 15% 处；single=false 时另抽收尾 85% 处（首尾对照就是运镜）。 */
export function shotFrames({ doc, videoPath, outDir, width = 480, single = true } = {}) {
  if (!videoPath || !existsSync(videoPath)) throw new Error(`视频不存在：${videoPath}`);
  if (!outDir) throw new Error("outDir 不能为空");
  mkdirSync(outDir, { recursive: true });

  const made = [];
  const failed = [];
  for (const s of doc?.shots ?? []) {
    const start = Number(s.start) || 0;
    const span = Math.max(0, (Number(s.end) || start) - start);
    const picks = single ? [["a", start + span * 0.15]] : [["a", start + span * 0.15], ["b", start + span * 0.85]];
    for (const [suffix, at] of picks) {
      const out = path.join(outDir, `${s.id}${suffix}.jpg`);
      try {
        ffmpeg(["-v", "error", "-y", "-ss", String(r2(at)), "-i", videoPath,
          "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", out]);
        made.push(path.basename(out));
      } catch {
        failed.push(`${s.id}${suffix}`);
      }
    }
  }
  return { dir: outDir, made, failed };
}

/** 联系表：把每镜某一帧拼成大图（一屏二十几镜，看片不烧额度）。 */
export function shotSheet({ doc, framesDir, outDir, cols = 5, rows = 5, pick = "a", width = 320 } = {}) {
  if (!framesDir) throw new Error("framesDir 不能为空");
  if (!outDir) throw new Error("outDir 不能为空");
  mkdirSync(outDir, { recursive: true });

  const ids = (doc?.shots ?? []).map((s) => s.id).filter((id) => existsSync(path.join(framesDir, `${id}${pick}.jpg`)));
  const per = cols * rows;
  const made = [];
  const failed = [];
  const filter = `scale=${width}:-2,tile=layout=${cols}x${rows}:padding=4:margin=4:color=white`;
  const two = (n) => String(n).padStart(2, "0");

  for (let i = 0; i < ids.length; i += per) {
    const batch = ids.slice(i, i + per);
    const out = path.join(outDir, `sheet-${pick}${two(Math.floor(i / per) + 1)}.jpg`);
    const firstNo = Number(String(batch[0]).replace(/^S/, "")) || 1;
    const lastNo = Number(String(batch[batch.length - 1]).replace(/^S/, "")) || firstNo;
    const contiguous = batch.length === lastNo - firstNo + 1;

    try {
      if (contiguous) {
        // ⭐ 走 image2 序列：S%02da.jpg 直接把连续帧喂给 tile。
        //   比 concat + 临时清单少一个中间文件，也免了 Windows 路径在清单里的转义问题。
        ffmpeg(["-v", "error", "-y", "-framerate", "1", "-start_number", String(firstNo),
          "-i", path.join(framesDir, `S%02d${pick}.jpg`),
          "-vf", filter, "-frames:v", "1", "-q:v", "3", out]);
      } else {
        // 有帧缺失（编号不连续）→ 退回 concat 清单
        const listFile = path.join(outDir, `.sheet-${pick}-${i}.txt`);
        writeFileSync(listFile, batch.map((id) => `file '${path.resolve(framesDir, `${id}${pick}.jpg`).replace(/\\/g, "/")}'`).join("\n"), "utf8");
        try {
          ffmpeg(["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
            "-vf", filter, "-frames:v", "1", "-q:v", "3", out]);
        } finally {
          rmSync(listFile, { force: true });
        }
      }
      made.push(path.basename(out));
    } catch (e) {
      // 失败要带上原因 —— 上游只写一句“联系表生成失败”，排起错来全靠猜。
      failed.push(`${path.basename(out)}: ${e?.message || e}`);
    }
  }
  return { dir: outDir, made, failed, frames: ids.length };
}

/** 补刀 / 并刀（确定性操作，别手改 start/end）。返回新 doc，由调用方决定是否落盘。 */
export function shotRecut({ doc, track = null, splits = [], merges = [] } = {}) {
  return recut(doc, { splits: splits.map(Number), merges: merges.map(Number), track });
}

/**
 * 质量门。allow 给了就只跑那几道（甲：门集白名单），并如实回报被丢掉的门 ——
 * 「跳过即通过」是上游的语义（`ok: skipped ? true : issues.length === 0`），
 * 我们只跑子集时如果不把丢掉的门列出来，读的人会当成"全过了"。
 */
export function shotValidate(doc, ctx = {}, { gates: allow = null } = {}) {
  const v = validate(doc, {
    lang: ctx.lang ?? doc?.lang ?? "zh",
    track: ctx.track ?? null,
    frameDir: ctx.frameDir ?? null,
    frameExists: ctx.frameExists ?? null,
  });
  if (!Array.isArray(allow) || !allow.length) return v;

  const kept = v.gates.filter((g) => allow.includes(g.id));
  const dropped = v.gates.filter((g) => !allow.includes(g.id)).map((g) => g.id);
  const failed = kept.filter((g) => !g.ok);
  return {
    ...v,
    gates: kept,
    dropped,
    ok: failed.length === 0,
    failed,
    note: `只跑了 ${kept.length}/${v.gates.length} 道门；未跑：${dropped.join(", ")}（不是通过，是没检查）`,
  };
}

/**
 * 画面锚点表（档 A 的关键产出）。
 *
 * 为什么要有它：现在 `intake_summary` 的回指只能锚到字幕时间轴或文档小节。
 * 有了这份表，锚点就能落到**画面事件**上（"这一句说的是第 7 镜那个界面"）。
 * desc / emotion / onscreenText 三格留给视觉模型填 —— 这一步不调模型，只铺好架子。
 */
export function writeVisualAnchors({ doc, outDir, framesDir } = {}) {
  if (!outDir) throw new Error("outDir 不能为空");
  mkdirSync(outDir, { recursive: true });
  const segments = (doc?.shots ?? []).map((s) => {
    const frames = [path.join(framesDir || "", `${s.id}a.jpg`)];
    const b = path.join(framesDir || "", `${s.id}b.jpg`);
    if (framesDir && existsSync(b)) frames.push(b);
    return {
      shotId: s.id,
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      seconds: Number(s.seconds) || 0,
      motion: s.motion ?? null,
      frames,
      desc: "",          // ← 视觉模型填
      emotion: "",       // ← 视觉模型填（reelbench 没有这一格，是我们加的）
      onscreenText: "",  // ← 视觉模型填
    };
  });
  const file = path.join(outDir, "visual_anchors.json");
  writeJson(file, {
    spec: "1.0",
    kind: "visual",
    profile: doc?.profile || "A",
    title: doc?.title || "",
    source: doc?.source || "",
    generatedAt: new Date().toISOString(),
    count: segments.length,
    filled: 0,
    segments,
  });
  return file;
}

/* ────────────────────────── 一条龙 ────────────────────────── */

/**
 * 档 A / 档 B 的完整跑法（不含视觉模型调用 —— 那一步在 Python 侧）。
 * @returns {{doc, meta, cuts, shotsPath, trackPath, framesDir, frames, sheets, anchorsPath, stats}}
 */
export function analyzeFrames({
  videoPath, outDir, profile = "A", title = "", source = "",
  threshold, motion, single, sheet, width = 480, hz = 5,
  subtitleSegments = [], segmentMaxSeconds, segmentMaxCount,
} = {}) {
  const P = profile === "B" ? PROFILE_B : PROFILE_A;
  // 档 A 默认走内容分段（时间窗 20s + 场景 + 字幕吸附）；档 B 保持场景切点。
  const segMax = Number.isFinite(segmentMaxSeconds)
    ? Number(segmentMaxSeconds)
    : (profile === "B" ? 0 : 20);
  const seed = shotSeed({
    videoPath, outDir, title, source,
    threshold: threshold ?? P.threshold,
    motion: motion ?? P.motion,
    hz,
    subtitleSegments,
    segmentMaxSeconds: segMax,
    segmentMaxCount: Number(segmentMaxCount) || 0,
  });

  const framesDir = path.join(outDir, "frames");
  const frames = shotFrames({ doc: seed.doc, videoPath, outDir: framesDir, width, single: single ?? P.single });

  let sheets = null;
  if (sheet ?? P.sheet) {
    const sheetsDir = path.join(outDir, "sheets");
    const a = shotSheet({ doc: seed.doc, framesDir, outDir: sheetsDir, pick: "a" });
    const b = shotSheet({ doc: seed.doc, framesDir, outDir: sheetsDir, pick: "b" });
    sheets = { a, b, dir: sheetsDir };
  }

  const anchorsPath = writeVisualAnchors({ doc: seed.doc, outDir, framesDir });

  // ⭐ 2026-09-26：顺手把单文件报告也写出来（renderHtml 早就有，之前没人调）。
  //   卡片「预览」弹窗要的就是这个文件 —— 没有它那件事无从谈起。
  //   失败不阻断：切分/抽帧/锚点表才是主体，报告只是门面。
  let reportPath = "";
  try {
    reportPath = path.join(outDir, "report.html");
    writeFileSync(reportPath, renderHtml(seed.doc, { frameDir: framesDir }), "utf8");
  } catch (e) {
    reportPath = "";
    if (process.env.SHOTS_DEBUG) console.error("[shots] 报告渲染失败：" + (e?.message || e));
  }

  return {
    doc: seed.doc,
    meta: seed.meta,
    cuts: seed.cuts,
    shotsPath: seed.shotsPath,
    trackPath: seed.trackPath,
    framesDir,
    reportPath,
    frames,
    sheets,
    anchorsPath,
    stats: stats(seed.doc),
  };
}
