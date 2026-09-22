---
name: intake-document
description: 把本地文件纳入「摄取 → 记录 → 可回指总结 → 知识地图」管线——读本地 PDF / Word / Excel / PPT / 图片 / txt / md / html / csv / json，产物统一落 text.txt + artifact.json + 一条记录(kind=document)，之后用 intake_summary 写可回指的结构化总结。重解析（PDF 版面 / 扫描件 OCR / 老 Office）自动 delegate 给旧的 doc_intake 插件。⚠️ 如果只是"看看这个文件说了什么"、不想入库也不想总结 → 直接用 doc_intake（第一线读文件工具），不必走这里。触发词：把这个 PDF 入库、归档这个文档、本地文件摄取、总结这份文档并沉淀、纳入采集记录、把这份 Word 收进记录。
---

# Intake Document — 本地文件入库沉淀

它和旧插件 `doc_intake` 的分工，一句话：**`doc_intake` 提取，`intake_document` 沉淀。**

| 你想要 | 用哪个 |
|---|---|
| 随手"看看这个 PDF / 图片说了什么"，临时提取成文本 | `doc_intake`（旧插件，default-enabled，第一线读文件工具） |
| 把文件**纳入**记录 + 可回指总结 + 知识地图，产物统一管理 | `intake_document`（本 skill） |

`intake_document` 做的是：本地文件 → `text.txt` + `artifact.json` + 一条记录（`kind=document`）→ 之后走和平台内容完全相同的总结 / 知识地图链路。轻格式自己扛，重解析（PDF 版面 / 扫描件 OCR / 老 Office）delegate 给 `doc_intake`。

## 参数

```typescript
{
  path,             // 必填：本地文件绝对路径
  title,            // 可选：覆盖识别出的标题
  extractor,        // auto(默认)=优先 doc-intake、失败回退内置；builtin=只用内置标准库
  docIntakePython,  // 可选：指定跑 doc-intake 的 python（需能 import fitz / PIL / requests）
  background,       // 默认 true；PDF / OCR 慢，见下
}
```

## 谁能解析什么（边界）

| 格式 | 谁来解析 |
|---|---|
| txt / md / html / docx / csv / json / log | `intake_document` 内置标准库自己扛 |
| PDF（带版面、扫描件） | delegate `doc_intake`（MinerU / PaddleOCR / local 三档，PDF 默认 local 链） |
| 图片（jpg/png/webp/tiff/bmp/gif） | delegate `doc_intake`（PaddleOCR，自动长图分割） |
| .doc / .ppt / .xls（老 Office） | delegate `doc_intake`（转新格式后解析） |
| 公式 / 表格 / EMF | 靠 `doc_intake` 的公式→LaTeX、表格识别能力 |

## ⚠️ 依赖 doc-intake 的解释器——一个真坑

`intake_document` delegate `doc_intake` 时，要找一个**真能跑它的 python**（判据：`import fitz, PIL, requests` 都能过）。它靠 `docIntakePython` 参数或自动探测；**探测不到就回退 builtin，而 builtin 不解 PDF / 扫描件 / 图片**——于是 text.txt 是空的或半截，且不明显报错。

- 症状：传了 PDF / 扫描件 / 图片，结果提取不出正文，或内容残缺。
- 诊断：多半是 delegate 没找到可用 python，不是文件坏。
- 解法：用 `docIntakePython` 显式指定一个装了 `fitz(PyMuPDF)`/`PIL`/`requests` 的解释器（conda / venv 的 python.exe）。
- 附带：旧插件 `doc_intake` 自己还有个 `pythonPath` 设置，空着会让 `doc_intake` **单独被调**时报 `PYTHON_PATH_NOT_CONFIGURED`；但 `intake_document` 的 delegate 探测是独立的一条，别把两者混为一谈——真正影响这里的是 `docIntakePython` 能不能探到。

## 后台默认开

`background` 默认 **true**：PDF / Office / 图片走 doc-intake 可能含 OCR，跑得久，抱着工具 RPC 等会被判失效（`RPC peer closed`）。默认丢后台、拿 taskId、完成自动回对话。要同步拿结果显式传 `background: false`。

## 调用后你应该做什么

1. 读 `text.txt`（正文；被截断读产物目录里的完整文件）。
2. 拿到回执里的「记录ID / 工作目录」（recordId / outputDir）。
3. **写总结**用 `intake_summary`——文档类内容锚点是小节，要点出处写 `at: "§3"` / "第3节"。
4. 要学习路径（不是摘要）上 `generate_knowledge_map`。

## 产物

- `text.txt`：正文（唯一文本入口）
- `artifact.json`：`kind=document`、`anchorKind=section`、正文/锚点/附属资源统计
- 记录：`kind=document`、author/summary 等字段，卡片历史可见
- `summary.json` / `summary.md`：用 intake_summary 写总结后生成

锚点说明：PDF/Office 经 doc-intake 转出的 Markdown 有标题就按标题切小节，无标题按 ~800 字段落——这也是为什么文档类总结的出处是 `§小节号` 而不是时间。
