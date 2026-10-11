#!/usr/bin/env node
// #224 评测语料：把一份已经保存到本机、只含虚构资料的网页 HTML 转成和插件一样的脱敏大纲。
// 用法：node scripts/capture-outline.mjs <page.html> [--resume-values 值1,值2] [--url https://host/path]
// 只在本机运行，不联网。输出的大纲仍要人工检查一遍再放进 tests/fixtures/sites/。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const fieldScan = require("../field-scan.js");
const outline = require("../page-outline.js");

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
if (!file) {
  console.error("用法：node scripts/capture-outline.mjs <page.html> [--resume-values 值1,值2] [--url https://host/path]");
  process.exit(2);
}
const doc = new JSDOM(readFileSync(file, "utf8"), { url: option("--url") || "https://jobs.example.test/apply" }).window.document;
// jsdom 不排版：hidden 和行内 display:none 当成看不见。
const isVisible = (el) => !el.closest("[hidden], [style*='display: none'], [style*='display:none']");
const resumeValues = option("--resume-values").split(",").map((value) => value.trim()).filter(Boolean);
const result = outline.build(doc, { isVisible, fieldScan, resumeValues });
process.stdout.write(`${result.parts.map((part) => part.text).join("\n")}\n`);
console.error(JSON.stringify(result.stats));
