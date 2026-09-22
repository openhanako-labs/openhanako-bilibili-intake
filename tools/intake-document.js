/**
 * intake-document.js — 本地文档摄取（P1，2026-09-22）
 *
 * 补上"文档也要可以"的本地方向：以前这个 App 只能从平台取内容，
 * 本地一个 Word / Markdown 进去，产物管道、锚点、记录、总结链路全都用不上。
 *
 * 现在它和平台采集共用同一套产物：text.txt + artifact.json + 一条记录，
 * 之后走同一条总结流程（总结写完用 POST /intake/record 回写 recordId）。
 *
 * 解析能力边界（刻意划清楚，不重复造轮子）：
 *   txt / md / csv / json / log / html / docx —— 本 App 用标准库自己解析；
 *   pdf —— 装了 pypdf 就解析，没装则明确报错；
 *   扫描件、.doc/.ppt/.xls、图片 —— 交给环境里的 doc-intake 插件转成 Markdown 再来。
 */
import { formatDocumentPayload, ingestLocalDocument } from "../lib/service.js";
import { submitBackground } from "../lib/tasks.js";
import { toToolError, toToolResult } from "../lib/tool-output.js";

export const name = "intake_document";

export const description =
  "本地文档摄取 —— 把本地文件（PDF / Office / 图片 / txt / md / html / csv / json）取成正文入库：" +
  "写 text.txt + artifact.json，并在「记录」里落一条（kind=document）。" +
  "默认优先复用环境里已装好的 doc-intake（PDF 版面提取 / 扫描件 OCR / 表格公式都在那边），" +
  "它缺席时自动回退到本 App 的标准库解析器（txt/md/html/docx/csv/json）。";

export const parameters = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "本地文件的绝对路径。",
    },
    title: {
      type: "string",
      description: "可选：覆盖识别出来的标题。",
    },
    extractor: {
      type: "string",
      enum: ["auto", "builtin"],
      description: "auto（默认）= 优先 doc-intake、失败回退内置；builtin =只用内置标准库解析器（不依赖任何外部插件）。",
      default: "auto",
    },
    docIntakePython: {
      type: "string",
      description: "可选：指定跑 doc-intake 的 python 解释器（需能 import fitz/PIL/requests）。留空则自动探测。",
    },
    background: {
      type: "boolean",
      description: "丢到后台执行，立刻返回 taskId，完成后结果自动回到对话。默认 true —— PDF / Office / 图片走 doc-intake（可能含 OCR），跑得比一次工具调用能等的时间长。要同步拿结果就传 false。",
      default: true,
    },
  },
  required: ["path"],
};

export async function execute(input = {}, ctx) {
  try {
    // ⚠️ 默认走后台：doc-intake 的 PDF/OCR 可能跑很久，抱着工具 RPC 等
    //   （2026-09-22 实测：长调用期间 App 进程会被判定失效，回“RPC peer closed”）
    //   不如把活丢给宿主任务通道，工具立刻返回 taskId，完成后结果自己回到对话。
    if (input.background !== false && ctx?.tasks?.create) {
      return await submitBackground(input, ctx, {
        ingest: ingestLocalDocument,
        formatAgentPayload: formatDocumentPayload,
        toToolError,
      });
    }
    const result = await ingestLocalDocument(input, ctx);
    return toToolResult(result, formatDocumentPayload(result));
  } catch (error) {
    return toToolError(error, {
      action: name,
      source: input.path || null,
      mode: "document",
    });
  }
}
