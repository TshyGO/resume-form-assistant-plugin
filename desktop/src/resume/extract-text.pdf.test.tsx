// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { browserExtractors } from "./extract-text.ts";

// 走生产入口 browserExtractors.pdfToText（真实 pdf.js + Vite 的 `?url` 导入，所以放在 Vitest 而不是 node --test），
// 在 Node 里删掉 ReadableStream[Symbol.asyncIterator] 模拟 macOS WKWebView：
// pdfToText 自己不补的话，pdf.js 的 getTextContent 就会抛 TypeError。
//
// Node 下 pdf.js 不起真 Worker，会按 workerSrc 动态 import 一份「假 Worker」；Vite 给的 `?url`
// 是站点路径，Node 里 import 不到。预先挂上 globalThis.pdfjsWorker，pdf.js 会直接用它。
beforeAll(async () => {
  // @ts-expect-error pdfjs-dist 没有给 worker 模块发类型声明
  (globalThis as Record<string, unknown>).pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
});

const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
const native = Object.getOwnPropertyDescriptor(proto, Symbol.asyncIterator);

afterEach(() => {
  if (native) Object.defineProperty(proto, Symbol.asyncIterator, native);
});

// 最小 PDF：一页、Helvetica、一行文字（xref 偏移不精确，pdf.js 会自行重建）。
const MINIMAL_PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 18 Tf 20 100 Td (Resume Pro) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`;

const pdfBytes = () => new TextEncoder().encode(MINIMAL_PDF).buffer as ArrayBuffer;

describe("browserExtractors.pdfToText（真实 pdf.js）", () => {
  it("运行时缺 ReadableStream 异步迭代（WKWebView）时仍能抽出文字", async () => {
    expect(native).toBeDefined();
    delete proto[Symbol.asyncIterator];
    await expect(browserExtractors.pdfToText(pdfBytes())).resolves.toBe("Resume Pro");
  });
});
