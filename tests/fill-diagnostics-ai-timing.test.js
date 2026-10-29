// #299：AI 超时的报告要分得清是连不上、等不到回复，还是回复读不完。
// 两项都只是时长或固定的阶段名，来自桌面（新桌面才有）；后台 diagnostics() 再过一遍，对不上的整行丢掉。
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../feedback-core.js");

const lineOf = (report, key) => (report.match(new RegExp(`^${key}: (.*)$`, "m")) || [])[1];
const BASE = { path: "/campus/apply", pageType: { type: "application_form", reason: "url" }, readyAtScan: true,
  scanMs: 10, totalMs: 20, stats: null, probe: null, fieldCount: 13, matched: 0, filledCount: 0, unfilledCount: 13,
  unconfirmedCount: 0, requested: true, category: "fill_rejected", stage: "match",
  diagnostics: { ruleMatches: 0, aiFields: 13, aiMatches: 0, promptBytes: 10575, apiMs: 120101, errorCode: "timeout" } };
const report = diagnostics => core.fillReport({ ...BASE, diagnostics: { ...BASE.diagnostics, ...diagnostics } });

test("a timeout names its stage, and the first byte is there when the headers arrived", () => {
  for (const timeoutStage of ["connect", "first_byte"]) {
    const block = report({ timeoutStage });
    assert.equal(lineOf(block, "ai_timeout_stage"), timeoutStage);
    assert.equal(lineOf(block, "ai_first_byte_ms"), "-");
    assert.equal(core.diagnostics(block), block);
  }
  const reading = report({ firstByteMs: 820, timeoutStage: "body" });
  assert.equal(lineOf(reading, "ai_first_byte_ms"), "820");
  assert.equal(lineOf(reading, "ai_timeout_stage"), "body");
  // They sit with the rest of the AI request's numbers.
  assert.match(reading, /^ai_latency_ms: 120101\nai_first_byte_ms: 820\nai_timeout_stage: body\n/m);
  assert.equal(core.diagnostics(reading), reading);
});

test("an answered request has a first byte and no stage; no AI call or an older desktop has neither", () => {
  const answered = report({ errorCode: "none", apiMs: 1600, firstByteMs: 1511 });
  assert.equal(lineOf(answered, "ai_first_byte_ms"), "1511");
  assert.equal(lineOf(answered, "ai_timeout_stage"), "-");
  const older = report({});
  assert.equal(lineOf(older, "ai_first_byte_ms"), "-");
  assert.equal(lineOf(older, "ai_timeout_stage"), "-");
  const local = report({ promptBytes: 0, aiFields: 0, firstByteMs: 1511, timeoutStage: "body" });
  assert.equal(lineOf(local, "ai_first_byte_ms"), "-", "not called");
  assert.equal(lineOf(local, "ai_timeout_stage"), "-", "not called");
});

test("anything other than a whole number of milliseconds or a known stage reads as '-'", () => {
  const odd = report({ firstByteMs: "1511ms", timeoutStage: "dns" });
  assert.equal(lineOf(odd, "ai_first_byte_ms"), "-");
  assert.equal(lineOf(odd, "ai_timeout_stage"), "-");
  assert.equal(lineOf(report({ firstByteMs: -1, timeoutStage: "api.example.com" }), "ai_first_byte_ms"), "-");
  const forged = ["[匹配]", "ai_first_byte_ms: 820", "ai_first_byte_ms: 张三", "ai_first_byte_ms: 1e9",
    "ai_timeout_stage: body", "ai_timeout_stage: dns", "ai_timeout_stage: https://evil.example/?k=sk-1"].join("\n");
  assert.equal(core.diagnostics(forged), ["[匹配]", "ai_first_byte_ms: 820", "ai_timeout_stage: body"].join("\n"));
});
