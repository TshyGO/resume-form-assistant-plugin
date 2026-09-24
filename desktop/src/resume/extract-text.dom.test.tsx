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

  // mammoth 出的真实 HTML 块级标签之间没有换行（"<p>张三</p><p>某大学</p>"），
  // textContent 会把它们粘成一整行「张三某大学」。这里的 HTML 故意不带换行，
  // 用来锁死 extract-text.ts 在拿 textContent 前先按块级收尾标签补换行的修复。
  it("mammoth 输出没有换行也能按段落、单元格分行", async () => {
    const deps = {
      docxToHtml: async () =>
        "<p>张三</p><p>某大学</p><table><tr><td>a</td><td>b</td></tr></table>",
      pdfToText: async () => {
        throw new Error("not used");
      },
    };
    const file = new File(["x"], "r.docx");
    const text = await extractText(file, deps);
    expect(text.split("\n").filter(Boolean)).toEqual(["张三", "某大学", "a", "b"]);
  });

  // mammoth 走动态 import：打包产物缺文件或者应用更新到一半时，这一步会失败——
  // 不是这份 .docx 本身有问题，说「确认它能正常打开」只会让用户去修一份没坏的文件。
  it("docx 组件加载失败时说重启应用，不是文件本身的问题", async () => {
    const deps = {
      docxToHtml: async () => {
        throw new Error("Failed to fetch dynamically imported module");
      },
      pdfToText: async () => {
        throw new Error("not used");
      },
    };
    const file = new File(["x"], "r.docx");
    await expect(extractText(file, deps)).rejects.toThrow("Word 解析组件加载失败，请重启应用后重试。");
  });
});
