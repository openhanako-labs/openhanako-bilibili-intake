/**
 * tests/test-receipt.mjs — 采集回执（formatAgentPayload）的离线回归。
 *
 *     node tests/test-receipt.mjs
 *
 * 为什么要有它：回执是用户唯一会读到的东西，而且它「写错」的形态和写对了一模一样 ——
 * 少一行不该少的提示、或者该说清的时候沉默，都不会报错。2026-10-04 修的那两个 bug
 * （评论恒 3 条 / 自动总结全灭）恰好都属于「失败得和成功一样安静」，回执就是对着
 * 这个形态下的第一道反制。这里把它钉住：正文缺席必须出声、评论必须报数、
 * 总结四种状态各有说法。
 *
 * 纯函数测试，不碰宿主、不碰网络、不启动 App —— 所以 App 重载把工具 RPC 弄断之后
 * （见纪律库 BUG-084），这条依然能跑。
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const { formatAgentPayload } = await import(
  pathToFileURL(path.join(here, "..", "lib", "service.js")).href
);

let pass = 0, fail = 0;
function check(name, condition, detail = "") {
  if (condition) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " :: " + detail : ""}`); }
}
function has(text, needle) { return text.includes(needle); }

const base = {
  ok: true, platform: "bilibili", title: "测试视频", uploader: "UP主", duration: 35.9,
  transcriptSource: "none", outputDir: "W:\\captures\\x", recordId: "rec_bilibili_TEST",
};

// ① noAudio + 无字幕：正文缺席必须当场说清，评论要报数，总结跳过要有原因
{
  const text = formatAgentPayload({
    ...base,
    comments: [
      { rpid: 1, replies: [] }, { rpid: 2, replies: [{ rpid: 11 }] }, { rpid: 3, replies: [] },
      { rpid: 4, replies: [] }, { rpid: 5, replies: [{ rpid: 21 }, { rpid: 22 }] },
    ],
    autoSummary: { ok: false, skipped: true, noText: true, reason: "没有可用正文（既没锚点也没 text.txt）" },
  });
  check("无正文时警告出现", has(text, "没有可用正文"));
  check("无正文时点明不会有总结", has(text, "不会有自动总结"));
  check("无正文时给出补救路径（去掉 noAudio）", has(text, "去掉 noAudio"));
  check("评论报一级条数", has(text, "评论: 一级 5 条"));
  check("评论报二级条数", has(text, "二级 3 条"));
  check("评论指向 result.json", has(text, "comments[]"));
  check("总结跳过硬带原因", has(text, "自动总结: 跳过 —— 没有可用正文"));
}

// ② 转写失败：与「本来没字幕」分开说，且提示音频是否已下载
{
  const text = formatAgentPayload({
    ...base, audioDownloaded: true, transcriptionError: "RuntimeError: Whisper 挂了",
    comments: [],
  });
  check("转写失败单独成行", has(text, "转写失败: RuntimeError: Whisper 挂了"));
  check("转写失败标注音频已下载", has(text, "（音频已下载）"));
  check("转写失败给出补写入口", has(text, "补写总结"));
  check("评论为 0 时也有交代", has(text, "评论: 0 条"));
}

// ③ 前台采集、总结成功：点数与回指数必须在
{
  const text = formatAgentPayload({
    ...base, transcriptSource: "platform_subtitle", transcriptTextPath: "W:\\captures\\x\\text.txt",
    comments: [{ rpid: 1, replies: [] }],
    autoSummary: { ok: true, counts: { total: 8, grounded: 8, ungrounded: 0 }, brief: "一句话摘要示例。" },
  });
  check("总结完成报要点与回指", has(text, "自动总结: 已完成（要点 8 · 回指 8）"));
  check("总结完成带一句话", has(text, "一句话摘要示例"));
}

// ④ 后台采集、总结排队：要能看到任务号，且不能说成完成
{
  const text = formatAgentPayload({
    ...base, transcriptSource: "whisper", transcriptTextPath: "W:\\captures\\x\\text.txt",
    autoSummary: { pending: true, taskId: "app:bilibili-intake-v2:abc123" },
  });
  check("排队态带任务号", has(text, "任务 app:bilibili-intake-v2:abc123"));
  check("排队态不说成完成", !has(text, "自动总结: 已完成"));
}

// ⑤ 总结失败：原因与重试入口都要有
{
  const text = formatAgentPayload({
    ...base, transcriptSource: "whisper", transcriptTextPath: "W:\\captures\\x\\text.txt",
    autoSummary: { ok: false, error: "模型 180s 内没有响应" },
  });
  check("失败态报原因", has(text, "自动总结未完成: 模型 180s 内没有响应"));
  check("失败态给重试入口", has(text, "补写总结"));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
