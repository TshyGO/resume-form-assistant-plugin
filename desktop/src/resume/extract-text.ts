import { parseHelpers } from "./parse-helpers.ts";

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
export type ResumeExtension = "pdf" | "docx" | "txt";

export function extensionOf(name: string): ResumeExtension | null {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return ext === "pdf" || ext === "docx" || ext === "txt" ? ext : null;
}

export interface Extractors {
  docxToHtml(data: ArrayBuffer): Promise<string>;
  pdfToText(data: ArrayBuffer): Promise<string>;
}

// 与插件 popup.js extractTextFromHtml 基本一致，多了下面这一步块级换行补丁。
//
// mammoth 出的真实 HTML 块级标签之间不带换行（"<p>张三</p><p>某大学</p>"），
// textContent 会把段落、表格单元格粘成一整行。插件那份就有这个问题——PR 5 删掉插件的
// 解析功能后才会消失，这里不改插件代码，只在桌面这份复本里补：解析前先在块级收尾标签
// 后面插入换行，让每个块各占一行。
function textFromHtml(html: string): string {
  const withBreaks = (html || "")
    .replace(/<\/(p|h[1-6]|li|tr|td|th|div|br)>/gi, "$&\n")
    .replace(/<br\s*\/?>/gi, "$&\n");
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  return (doc.body?.textContent || "").replace(/\s+\n/g, "\n").trim();
}

// 插件版的提示是「请在扩展管理页重新加载后重试」，桌面没有扩展管理页，改成重启应用。
// getPdfExtractionErrorMessage 是与插件一字不差锁死的副本，不能改；只在这里把这一条
// 换成桌面的话术，其余错误原样透传。
const PLUGIN_PDF_COMPONENT_ERROR = "PDF 解析组件加载失败，请在扩展管理页重新加载后重试。";
const DESKTOP_PDF_COMPONENT_ERROR = "PDF 解析组件加载失败，请重启应用后重试。";

function pdfErrorMessageFor(error: unknown): string {
  const message = parseHelpers.getPdfExtractionErrorMessage(error);
  return message === PLUGIN_PDF_COMPONENT_ERROR ? DESKTOP_PDF_COMPONENT_ERROR : message;
}

// mammoth 走动态 import（见下面的 browserExtractors.docxToHtml）：打包产物缺文件、或者
// 应用更新到一半时，浏览器对这类失败的措辞五花八门（Chromium 说
// "Failed to fetch dynamically imported module"，WebKit 说
// "Importing a module script failed"），但都不是"这份 .docx 文件本身有问题"，
// 说「Word 文件读取失败，确认它能正常打开」只会让用户去修一份根本没坏的文件。
const MODULE_LOAD_ERROR = /dynamically imported module|Failed to fetch|Importing a module script failed/i;
const DOCX_GENERIC_ERROR = "Word 文件读取失败，确认它能正常打开，或另存为 PDF / TXT 再试。";
const DOCX_COMPONENT_ERROR = "Word 解析组件加载失败，请重启应用后重试。";

function docxErrorMessageFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return MODULE_LOAD_ERROR.test(message) ? DOCX_COMPONENT_ERROR : DOCX_GENERIC_ERROR;
}

/**
 * 真正的库只在需要时加载：pdf.js 与 mammoth 都不小，打开「简历」页不该就下载它们。
 *
 * pdf.js 走 `legacy/build`（而不是默认的 `build`）：默认构建假设运行时有较新的
 * JS 引擎 API（`Map.prototype.getOrInsertComputed`、`Math.sumPrecise`、
 * `Promise.withResolvers`、`Uint8Array.fromBase64`），桌面最低支持到 macOS 11 的
 * WKWebView 没有这些，legacy 构建自带对应 polyfill，版本仍是同一个 6.3.289。
 */
export const browserExtractors: Extractors = {
  async docxToHtml(data) {
    const mammoth = await import("mammoth");
    const result = await (mammoth.default ?? mammoth).convertToHtml({ arrayBuffer: data });
    return result.value;
  },
  async pdfToText(data) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return parseHelpers.extractPdfText(pdfjs as never, data, {
      cMapPacked: true,
      cMapUrl: `${import.meta.env?.BASE_URL ?? "/"}pdfjs/cmaps/`,
    });
  },
};

export async function extractText(file: File, deps: Extractors = browserExtractors): Promise<string> {
  const ext = extensionOf(file.name);
  if (!ext) throw new Error("只支持 PDF、Word（.docx）或 TXT 简历。");
  if (file.size > MAX_RESUME_BYTES) throw new Error("文件超过 10 MB，不像是简历，确认选对了文件。");
  let text: string;
  if (ext === "txt") {
    text = (await file.text()).trim();
  } else if (ext === "docx") {
    try {
      text = textFromHtml(await deps.docxToHtml(await file.arrayBuffer()));
    } catch (error) {
      throw new Error(docxErrorMessageFor(error));
    }
  } else {
    try {
      text = (await deps.pdfToText(await file.arrayBuffer())).trim();
    } catch (error) {
      throw new Error(pdfErrorMessageFor(error));
    }
    if (!text) {
      throw new Error("PDF 未检测到可提取文字，可能是扫描版。请改用 Word / TXT，或先用 OCR 转成文字。");
    }
  }
  if (!text) throw new Error("简历中没有可发送给 AI 的文字。");
  return text;
}
