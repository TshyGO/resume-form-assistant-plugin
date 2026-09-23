import { describe, expect, it } from "vitest";
import { extractText } from "./extract-text.ts";

// docx 分支用 DOMParser 把 mammoth 出的 HTML 转成纯文字（见 extract-text.ts 的 textFromHtml）。
// node --test 没有全局 DOMParser，这条用例挪到这里用 jsdom 跑；其余纯逻辑用例留在 extract-text.test.ts。
//
// jsdom 的 Blob/File 没有实现 arrayBuffer()（真实浏览器与 Tauri webview 都有），
// 只在这个测试文件里用 FileReader 垫一个，不改生产代码。
if (typeof File.prototype.arrayBuffer !== "function") {
  File.prototype.arrayBuffer = function (this: File) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

describe("extractText docx（jsdom）", () => {
  it("docx 走注入的抽取器，HTML 转成纯文字", async () => {
    const deps = {
      docxToHtml: async () => "<p>张三</p>\n<p>某大学</p>",
      pdfToText: async () => {
        throw new Error("not used");
      },
    };
    const file = new File(["x"], "r.docx");
    await expect(extractText(file, deps)).resolves.toMatch(/张三[\s\S]*某大学/);
  });
});
