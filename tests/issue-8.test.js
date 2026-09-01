const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const utils = require("../resume-utils.js");

function buildMinimalPdf(text) {
  const escapedText = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escapedText}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(source);
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
  assert.match(utils.getPdfExtractionErrorMessage(new Error("boom")), /PDF 解析失败/u);
});

test("PDF text extraction preserves page and line boundaries with a mocked document", async () => {
  let destroyed = false;
  const pdfjs = {
    getDocument() {
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
});

test("bundled PDF.js extracts text from a real text PDF", async () => {
  const pdfjs = await import("../vendor/pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(__dirname, "..", "vendor", "pdfjs", "pdf.worker.min.mjs")
  ).href;
  const result = await utils.extractPdfText(pdfjs, buildMinimalPdf("Resume PDF Test"));
  assert.match(result, /Resume PDF Test/u);
});

test("bundled PDF.js returns no text for an image-only equivalent PDF", async () => {
  const pdfjs = await import("../vendor/pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(__dirname, "..", "vendor", "pdfjs", "pdf.worker.min.mjs")
  ).href;
  const result = await utils.extractPdfText(pdfjs, buildMinimalPdf(""));
  assert.equal(result, "");
});

test("runtime source sends extracted text and contains no PDF-as-image path", () => {
  const popupSource = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
  const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");

  assert.doesNotMatch(popupSource, /readAsDataURL/u);
  assert.doesNotMatch(popupSource, /cdn\.jsdelivr|cdnjs|unpkg/u);
  assert.doesNotMatch(backgroundSource, /image_url|application\/pdf/u);
  assert.match(popupSource, /fileType:\s*"text"/u);
  assert.match(popupSource, /vendor\/pdfjs\/cmaps\//u);
  assert.match(htmlSource, /check-update-button/u);
  assert.match(htmlSource, /download-update-button/u);
});
