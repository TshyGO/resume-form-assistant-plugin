import { test } from "node:test";
import assert from "node:assert/strict";
import { extensionOf, extractText, MAX_RESUME_BYTES } from "./extract-text.ts";

const file = (name: string, text: string) => new File([text], name);

test("只收 pdf / docx / txt", () => {
  assert.equal(extensionOf("a.PDF"), "pdf");
  assert.equal(extensionOf("a.docx"), "docx");
  assert.equal(extensionOf("a.doc"), null);
  assert.equal(extensionOf("noext"), null);
});

test("txt 直接读文字并去掉首尾空白", async () => {
  assert.equal(await extractText(file("r.txt", "  张三\n邮箱 a@b.c \n")), "张三\n邮箱 a@b.c");
});

test("不支持的类型、空文件、超大文件都说清楚", async () => {
  await assert.rejects(extractText(file("r.doc", "x")), /PDF、Word（.docx）或 TXT/);
  await assert.rejects(extractText(file("r.txt", "   ")), /没有可发送给 AI 的文字/);
  await assert.rejects(extractText(new File([new Uint8Array(MAX_RESUME_BYTES + 1)], "big.txt")), /超过 10 MB/);
});

// docx 的分支要走 DOMParser（见 textFromHtml），node --test 下没有全局 DOMParser；
// 这个用例移到 extract-text.dom.test.tsx，用 Vitest + jsdom 跑（同一份 extractText 实现）。
test("pdf 走注入的抽取器", async () => {
  const deps = {
    docxToHtml: async () => {
      throw new Error("not used");
    },
    pdfToText: async () => "第一页\n第二页",
  };
  assert.equal(await extractText(file("r.pdf", "x"), deps), "第一页\n第二页");
});

test("pdf 解析组件加载失败时说桌面版的重启话术，不是插件的扩展管理页话术", async () => {
  const deps = {
    docxToHtml: async () => {
      throw new Error("not used");
    },
    pdfToText: async () => {
      throw new Error("Failed to fetch dynamically imported module");
    },
  };
  await assert.rejects(extractText(file("r.pdf", "x"), deps), /PDF 解析组件加载失败，请重启应用后重试。/);
});
