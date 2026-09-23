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

// 与插件 popup.js extractTextFromHtml 一致。
function textFromHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  return (doc.body?.textContent || "").replace(/\s+\n/g, "\n").trim();
}

/** 真正的库只在需要时加载：pdf.js 与 mammoth 都不小，打开「简历」页不该就下载它们。 */
export const browserExtractors: Extractors = {
  async docxToHtml(data) {
    const mammoth = await import("mammoth");
    const result = await (mammoth.default ?? mammoth).convertToHtml({ arrayBuffer: data });
    return result.value;
  },
  async pdfToText(data) {
    const pdfjs = await import("pdfjs-dist");
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return parseHelpers.extractPdfText(pdfjs as never, data, {
      cMapPacked: true,
      cMapUrl: `${import.meta.env?.BASE_URL ?? "/"}pdfjs/cmaps/`,
      isEvalSupported: false,
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
    } catch {
      throw new Error("Word 文件读取失败，确认它能正常打开，或另存为 PDF / TXT 再试。");
    }
  } else {
    try {
      text = (await deps.pdfToText(await file.arrayBuffer())).trim();
    } catch (error) {
      throw new Error(parseHelpers.getPdfExtractionErrorMessage(error));
    }
    if (!text) {
      throw new Error("PDF 未检测到可提取文字，可能是扫描版。请改用 Word / TXT，或先用 OCR 转成文字。");
    }
  }
  if (!text) throw new Error("简历中没有可发送给 AI 的文字。");
  return text;
}
