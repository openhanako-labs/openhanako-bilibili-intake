/**
 * intake-shots.js — W2（2026-09-26）：画面分析（帧分析）的助手入口。
 *
 * 为什么要有它：帧分析以前藏在 Python 的视觉链路里，只能跟着采集一起跑。
 * 现在它是一段独立的 Node 能力（lib/shots），就该能被单独叫起来 ——
 * 对着一条已有记录说"看看这片子的画面结构"，不必重新采集一遍。
 *
 * 三件必须记住的事（都踩过）：
 *   1. **ffmpeg 未必在 PATH 里**（AppHost 给子进程的环境是白名单）。
 *      lib/shots 的策略是"先设置后搜索"：设置里填了就用，没填去常见目录找。
 *   2. **档 A 切出来的不是"镜头"，是语义段**（时间窗 + 场景切点 + 字幕行首吸附）。
 *      原因：录屏 / 口播素材本来就没几个镜头，纯场景检测会退化成"整条视频一段"。
 *   3. **门集是白名单（甲）**：档 A 只跑 5 道。没跑的 10 道必须如实列出来 ——
 *      上游的"跳过即通过"语义会让读的人把"没检查"当成"通过"。
 */
import fs from "node:fs";
import path from "node:path";
import { readTranscriptAnchors } from "../lib/anchors.js";
import { locateRecord, readRecords } from "../lib/records.js";
import { getSettings } from "../lib/settings.js";
import { analyzeFrames, GATES_PROFILE_A, shotValidate } from "../lib/shots/index.js";
// ⭐ 三格（画面 / 情绪 / 屏幕文字）的填充走宿主视觉模型，不需要 API key。
import { fillSegments } from "../lib/shots/vision-fill.js";
// ⭐ 原片下载：走采集同一条 python 子进程通道（yt-dlp 只在 venv 里）。
import { downloadVideoForShots } from "../lib/service.js";
import { toToolError, toToolResult } from "../lib/tool-output.js";

export const name = "intake_shots";

export const description =
  "对一条已采集的记录做画面分析（帧分析）：切出内容分段 / 镜头、抽关键帧、把每张帧挂到时间锚点上。" +
  "产物落在槽位的 shots/ 下（shots.json / frames/ / visual_anchors.json），档 B 还会出运动曲线与联系表。" +
  "用它回答『这片子的画面结构是什么』『第 3 段画面上有什么』。默认档 A（内容档，服务总结锚点）；档 B 是镜头语言档（更贵）。" +
  "需要本地有原片（visual_video.mp4）—— 没有就先在设置里打开「下载原片（帧分析用）」。" +
  "段里的 desc / emotion / onscreenText 由视觉模型填，本工具只负责切分与抽帧。" +
  "传 fill:true 就会接着调**宿主**的视觉模型把三格填上（不需要 API key，但每段一次调用）—— 填之前先用 fillLimit 控住花多少。";

export const parameters = {
  type: "object",
  properties: {
    recordId: {
      type: "string",
      description: "记录 id（采集回执里的『记录ID』）。与 source / videoPath 三选一。",
    },
    source: {
      type: "string",
      description: "也可以用 BV 号 / 链接 / 标题片段定位一条记录。",
    },
    videoPath: {
      type: "string",
      description: "直接给一个本地视频的绝对路径（跳过记录定位）。",
    },
    profile: {
      type: "string",
      enum: ["A", "B"],
      description: "A=内容档（默认，每段一张帧 + 语义分段）；B=镜头语言档（运动量曲线 + 首尾两帧 + 联系表 + 全套质量门）。",
    },
    maxSeconds: {
      type: "number",
      description: "档 A 的分段长度上限（秒），默认取设置里的值（20）。只影响档 A。",
    },
    maxSegments: {
      type: "number",
      description: "档 A 的段数上限（默认取设置里的值，60）。段数会超时自动把分段长度顶大—— 每段一次视觉模型调用，这是成本闸门。",
    },
    fill: {
      type: "boolean",
      description: "切分并抽帧之后，紧接着用宿主视觉模型把每段的 desc / 情绪 / 屏幕文字填上。默认 false（不花调用）。",
    },
    fillLimit: {
      type: "number",
      description: "fill 时最多填几段（不传 = 全部）。想先看两眼效果就传 2 或 3。",
    },
  },
  required: [],
};

const VIDEO_NAMES = ["source_video.mp4", "visual_video.mp4", "video.mp4", "source.mp4", "raw.mp4"];
const IMG_RE = /\.(jpe?g|png|webp)$/i;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

/** 槽位里找原片：只认白名单文件名，不去递归扫（槽位里还有一堆 json）。 */
export function findVideo(slotDir) {
  for (const n of VIDEO_NAMES) {
    const p = path.join(slotDir, n);
    if (fs.existsSync(p)) return p;
  }
  return "";
}

const fmtLen = (s) => {
  const n = Math.floor(Number(s) || 0);
  return n >= 3600
    ? `${Math.floor(n / 3600)}:${String(Math.floor((n % 3600) / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`
    : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

export async function execute(input = {}, ctx) {
  try {
    const settings = await getSettings(ctx);

    // ⭐ 总开关（默认关）。画面分析会抽帧、切分、并可能调视觉模型 —— 这些都不该在
    //   用户没开的时候自己跑起来。开关位置写在拒绝信息里。
    if (settings.visionEnabled !== true) {
      return toToolResult(
        { ok: false, reason: "vision-disabled" },
        [
          "画面分析的总开关现在是关着的（设置里的「启用视觉帧分析」，默认关）。",
          "开它在：设置 → 内容摄取 →「启用视觉帧分析」。",
          "开了之后还可以配：帧分析档位（A 内容档 / B 镜头语言档）、分段长度上限、段数上限、ffmpeg 路径。",
        ].join("\n"),
      );
    }
    const profile = String(input.profile || settings.shotsProfile || "A").toUpperCase() === "B" ? "B" : "A";
    const maxSeconds = Number(input.maxSeconds) > 0
      ? Number(input.maxSeconds)
      : (Number(settings.shotsMaxSeconds) || 20);
    // 段数上限优先于秒数：长视频按 20 秒切会切出上百段，每段一次调用。
    const maxSegments = Number(input.maxSegments) > 0
      ? Number(input.maxSegments)
      : (Number(settings.shotsMaxSegments) || 60);

    // ── 1) 定位视频 ──
    let videoPath = String(input.videoPath || "").trim();
    let slotDir = "";
    let rec = null;
    let downloaded = "";

    if (videoPath) {
      if (!fs.existsSync(videoPath)) {
        return toToolError(new Error(`视频不存在：${videoPath}`), { action: name, videoPath });
      }
      slotDir = path.dirname(videoPath);
    } else {
      const key = String(input.recordId || input.source || "").trim();
      if (!key) {
        return toToolError(
          new Error("要指定目标：recordId（记录 id）或 source（BV 号 / 链接 / 标题片段）；也可以直接给 videoPath。"),
          { action: name },
        );
      }
      rec = locateRecord(readRecords(ctx), key);
      if (!rec) {
        return toToolError(new Error(`没找到记录：${key}。可以在卡片「记录」里核对 id / 标题。`), { action: name, source: key });
      }
      slotDir = String(rec.artifactDir || "").trim();
      if (!slotDir || !fs.existsSync(slotDir)) {
        return toToolError(new Error(`记录「${rec.title || rec.id}」没有本地产物目录，做不了帧分析。`), { action: name, source: key });
      }
      const found = findVideo(slotDir);
      if (!found) {
        // 原片下载是独立开关（默认关）。开关关着时**不去偷偷下载**，直接说清楚。
        if (!settings.shotsDownloadVideo) {
          const lines = [
            `「${rec.title || rec.id}」的槽位里没有原片（找过：${VIDEO_NAMES.join(" / ")}）。`,
            "原片下载是独立开关、现在关着。开它在：设置 → 内容摄取 →「下载原片（帧分析用）」。",
            `槽位：${slotDir}`,
          ];
          return toToolResult({ ok: false, reason: "no-video", slotDir, looked: VIDEO_NAMES }, lines.join("\n"));
        }
        // 开关开着 → 真的下一份。这是一个明确的落盘动作，所以把路径回报出来。
        // 开关开着 → 先确认这确实是个能下的东西。
        //   本地文档（doc-* 槽位）之类没有“原片”可言，拿 yt-dlp 去试一个本地路径
        //   只会换来一句难懂的退出码 1。
        const src = String(rec.source || "").trim();
        if (!/^https?:\/\//i.test(src) && !/^(BV|av)[0-9A-Za-z]+/i.test(src)) {
          return toToolResult(
            { ok: false, reason: "not-a-video", slotDir, source: src },
            `「${rec.title || rec.id}」不是视频链接（source=${src.slice(0, 80)}），没有原片可下 —— 这条不是帧分析的对象。`,
          );
        }
        const dl = await downloadVideoForShots(ctx, { source: src, outputDir: slotDir });
        if (!dl?.ok || !dl?.videoPath) {
          return toToolError(new Error(`原片下载失败：${dl?.error || "未知原因"}`), { action: name, slotDir });
        }
        videoPath = dl.videoPath;
        downloaded = dl.videoPath;
      } else {
        videoPath = found;
      }
    }

    // ── 2) 字幕时间轴（档 A 的分段会往字幕行首吸附；没有也能跑） ──
    let subtitleSegments = [];
    let subtitleSource = "无（只用时间窗兜底）";
    const meta = readJson(path.join(slotDir, "result.json")) || {};
    const subFiles = [].concat(meta.subtitleFiles || meta.subtitles || [])
      .map((f) => (path.isAbsolute(String(f)) ? String(f) : path.join(slotDir, String(f))));
    try {
      const anchors = readTranscriptAnchors(slotDir, subFiles);
      if (anchors && anchors.segments?.length) {
        subtitleSegments = anchors.segments;
        subtitleSource = `${anchors.source}，${anchors.totalSegments} 段`;
      }
    } catch { /* 字幕读不出来不影响切分 */ }

    // ── 3) 跑 ──
    const outDir = path.join(slotDir, "shots");
    const res = analyzeFrames({
      videoPath,
      outDir,
      profile,
      title: rec?.title || path.basename(videoPath),
      source: rec?.source || videoPath,
      subtitleSegments,
      segmentMaxSeconds: profile === "B" ? 0 : maxSeconds,
      segmentMaxCount: profile === "B" ? 0 : maxSegments,
    });

    const framesDir = path.join(outDir, "frames");
    const frames = fs.existsSync(framesDir) ? fs.readdirSync(framesDir).filter((f) => IMG_RE.test(f)) : [];
    const sheets = res.sheets?.a?.made?.length ? res.sheets : null;

    // ── 4) 质量门（档 A 走白名单子集，没跑的必须列出来） ──
    let gateText = "";
    try {
      const v = shotValidate(
        res.doc,
        { track: profile === "B" ? res.trackPath : null, frameDir: framesDir, frameExists: (f) => fs.existsSync(f) },
        { gates: profile === "A" ? GATES_PROFILE_A : null },
      );
      const allFailed = (v.gates || []).filter((g) => !g.ok);
      // ⭐ frame-text 门查的是「每段有没有画面描述」—— 那三格要等视觉模型填。
      //   刚切完就报“没通过”是误导，单列成“待填”。
      const needVlm = new Set(["frame-text"]);
      const pending = allFailed.filter((g) => needVlm.has(g.id)).map((g) => g.id);
      const failed = allFailed.filter((g) => !needVlm.has(g.id));
      const kept = (v.gates || []).length;
      gateText = [
        `质量门：跑了 ${kept} 道，${kept - allFailed.length} 通过${failed.length ? "，" + failed.length + " 没通过" : ""}。`,
        ...failed.slice(0, 6).map((g) => `   · ${g.id}：${(g.issues || []).slice(0, 2).join("；")}`),
        pending.length
          ? `待视觉模型填：${pending.join("、")}（那三格还是空的，不算失败）。`
          : "",
        v.dropped?.length
          ? `没检查的 ${v.dropped.length} 道：${v.dropped.join("、")} —— 没检查 ≠ 通过。`
          : "",
        // 上游的 v.note 和上面这行说的是同一件事，不再重复输出。
      ].filter(Boolean).join("\n");
    } catch (e) {
      gateText = `质量门没跑成：${e.message}`;
    }

    // ── 5) 交付（fill 就先填三格） ──
    let fillText = "";
    if (input.fill) {
      const f = await fillSegments({
        anchorsPath: res.anchorsPath,
        subtitleSegments,
        limit: Number(input.fillLimit) > 0 ? Number(input.fillLimit) : 0,
      });
      fillText = f.ok
        ? `三格填充：${f.filled} 段已填${f.failed ? `，${f.failed} 段失败` : ""}${f.skipped ? `，${f.skipped} 段跳过（已有内容）` : ""}｜模型 ${f.provider}/${f.model}`
          + (f.errors?.length ? `\n   · ${f.errors.join("\n   · ")}` : "")
        : `三格填充没跑成：${f.error}`;
    }
    const seg = res.doc.contentSegments || res.doc.shots.map((s) => ({ start: s.start, end: s.end, seconds: s.seconds }));
    const lines = [
      `画面分析完成（档 ${profile}${profile === "A" ? " · 内容档" : " · 镜头语言档"}）`,
      `视频：${path.basename(videoPath)}  ${fmtLen(res.meta.durationSeconds)}  ${res.meta.width}x${res.meta.height}${downloaded ? "　（本次下载）" : ""}`,
      profile === "A"
        ? `分段：${seg.length} 段（窗 ≤ ${Math.max(...seg.map((s) => s.seconds)).toFixed(0)}s，上限 ${maxSegments} 段）｜依据：${res.doc.segmentation?.strategy || "?"}｜场景切点 ${res.doc.segmentation?.sceneCuts ?? 0} 处｜字幕 ${subtitleSource}`
        : `镜头：${seg.length} 个（场景检测 threshold ${res.doc.threshold}）｜运动曲线 ${profile === "B" && res.trackPath ? "已出" : "无"}`,
      "",
      ...seg.slice(0, 12).map((s, i) => `  S${String(i + 1).padStart(2, "0")}  ${fmtLen(s.start)}–${fmtLen(s.end)}  ${Number(s.seconds).toFixed(1)}s`),
      seg.length > 12 ? `  …… 还有 ${seg.length - 12} 段（见 shots.json）` : "",
      "",
      `产物：${outDir}`,
      `  shots.json（切段底稿）｜frames/（${frames.length} 张）｜visual_anchors.json（${seg.length} 段，desc/emotion/onscreenText 待视觉模型填）`,
      res.reportPath ? "  report.html（单文件报告，卡片可预览）" : "",
      sheets ? `  sheets/（联系表 ${sheets.a.made.length} 张）｜track.json（运动曲线）` : "",
      "",
      gateText,
      "",
      fillText || "下一步：三格描述（画面 / 情绪 / 屏幕文字）还是空的。传 fill:true 就调宿主的视觉模型填上（不需要 API key）—— 先用 fillLimit 试两段。",
    ].filter((x) => x !== "");

    return toToolResult({
      ok: true,
      profile,
      video: videoPath,
      slotDir,
      outDir,
      segments: seg.length,
      frames: frames.length,
      anchors: res.anchorsPath,
      report: res.reportPath || null,
      shots: res.shotsPath,
      track: res.trackPath || null,
      segmentation: res.doc.segmentation || null,
      subtitleSource,
    }, lines.join("\n"));
  } catch (error) {
    return toToolError(error, {
      action: name,
      source: input.recordId || input.source || input.videoPath || null,
      profile: input.profile || null,
    });
  }
}
