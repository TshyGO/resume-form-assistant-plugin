const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const utils = require("../resume-utils.js");

function buildPdf(objects) {
  let source = "%PDF-1.4\n";
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source, "latin1"));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(source, "latin1");
  source += `xref\n0 ${objects.length + 1}\n`;
  source += "0000000000 65535 f \n";
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(source, "binary"));
}



test("semantic versions compare numerically and support a leading v", () => {
  assert.equal(utils.compareVersions("v0.2.10", "0.2.9"), 1);
  assert.equal(utils.compareVersions("0.2.1", "v0.2.1"), 0);
  assert.equal(utils.compareVersions("0.2.1-beta.2", "0.2.1"), -1);
  assert.throws(() => utils.compareVersions("latest", "0.2.1"), /版本号格式无效/u);
});

test("release metadata must be stable and point to this repository", () => {
  const release = utils.normalizeRelease({
    tag_name: "v0.2.2",
    html_url: "https://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/v0.2.2",
    body: "## 修复 PDF 解析\n\n其他内容",
    draft: false,
    prerelease: false
  });

  assert.deepEqual(release, {
    version: "v0.2.2",
    url: "https://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/v0.2.2",
    summary: "修复 PDF 解析"
  });
  assert.equal(utils.normalizeRelease({
    tag_name: "v9.9.9",
    html_url: "https://example.com/malicious.zip"
  }), null);
  assert.equal(utils.normalizeRelease({
    tag_name: "v0.2.2-beta.1",
    html_url: "https://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/v0.2.2-beta.1",
    prerelease: true
  }), null);
});

test("plugin update check ignores newer desktop releases and chooses the newest plugin version", () => {
  const release = (tag_name, extras = {}) => ({
    tag_name,
    html_url: `https://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/${tag_name}`,
    draft: false,
    prerelease: false,
    ...extras
  });
  assert.deepEqual(utils.latestPluginRelease([
    release("desktop-v9.0.0"),
    release("v0.4.1", { prerelease: true }),
    release("v0.3.1"),
    release("v0.4.0"),
    release("v0.4.2", { html_url: "https://example.com/other" })
  ]), {
    version: "v0.4.0",
    url: "https://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/v0.4.0",
    summary: "包含功能改进和问题修复。"
  });
  assert.equal(utils.latestPluginRelease([release("desktop-v9.0.0")]), null);
  assert.throws(() => utils.latestPluginRelease({ tag_name: "v0.4.0" }), /列表无效/u);
});

test("update checks use a bounded daily cache", () => {
  const now = Date.UTC(2026, 8, 1, 12, 0, 0);
  assert.equal(utils.shouldUseUpdateCache(now - 60_000, now), true);
  assert.equal(utils.shouldUseUpdateCache(now - 24 * 60 * 60 * 1000, now), false);
  assert.equal(utils.shouldUseUpdateCache(now + 60_000, now), false);
});

test("AI status errors remain distinct instead of blaming every failure on PDF", () => {
  assert.match(utils.formatAiError(400, "This model does not support image"), /请求格式或模型配置无效/u);
  assert.match(utils.formatAiError(401, "Unauthorized"), /API Key/u);
  assert.match(utils.formatAiError(402, "Insufficient balance"), /余额不足/u);
  assert.match(utils.formatAiError(404, "Not Found"), /API URL、模型名称或中转服务路由/u);
  assert.match(utils.formatAiError(429, "Rate limit"), /过于频繁/u);
  assert.match(utils.formatAiError(503, "Unavailable"), /暂时不可用/u);
});

test("PDF extraction reports encrypted, invalid and generic failures clearly", () => {
  assert.match(utils.getPdfExtractionErrorMessage({ name: "PasswordException" }), /已加密/u);
  assert.match(utils.getPdfExtractionErrorMessage({ name: "InvalidPDFException" }), /无效或已损坏/u);
  assert.match(utils.getPdfExtractionErrorMessage(new Error("Setting up fake worker failed")), /组件加载失败/u);
  assert.match(utils.getPdfExtractionErrorMessage(new Error("boom")), /PDF 解析失败/u);
});

test("PDF text extraction preserves page and line boundaries with a mocked document", async () => {
  let destroyed = false;
  let receivedOptions = null;
  const pdfjs = {
    getDocument(options) {
      receivedOptions = options;
      return {
        promise: Promise.resolve({
          numPages: 2,
          async getPage(pageNumber) {
            return {
              async getTextContent() {
                return pageNumber === 1
                  ? { items: [
                      { str: "John", transform: [1, 0, 0, 12, 0, 100], width: 24, height: 12 },
                      { str: "Doe", transform: [1, 0, 0, 12, 30, 100], width: 18, height: 12, hasEOL: true },
                      { str: "Email", transform: [1, 0, 0, 12, 0, 80], width: 30, height: 12, hasEOL: true }
                    ] }
                  : { items: [
                      { str: "Skills", transform: [1, 0, 0, 12, 0, 100], width: 30, height: 12 },
                      { str: "JavaScript", transform: [1, 0, 0, 12, 36, 100], width: 56, height: 12 }
                    ] };
              },
              cleanup() {}
            };
          },
          cleanup() {}
        }),
        async destroy() {
          destroyed = true;
        }
      };
    }
  };

  const result = await utils.extractPdfText(pdfjs, new Uint8Array([1, 2, 3]));
  assert.equal(result, "John Doe\nEmail\n\nSkills JavaScript");
  assert.equal(destroyed, true);
  assert.equal("disableFontFace" in receivedOptions, false);
  assert.equal("useSystemFonts" in receivedOptions, false);
});
