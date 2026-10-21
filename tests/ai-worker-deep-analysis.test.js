// #224：worker 里的分析请求和带预算的填写匹配。分析只发大纲，用 analyze（不带 tier 即强档）；
// 匹配带 maxCalls 时最多发这么多次并如实上报，深度分析的 6 次预算靠它在分析和匹配之间共享。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "ai-worker.js"), "utf8");
const helpers = require("../ai-helpers.js");
const deep = require("../deep-analysis.js");

function worker(respond) {
  const sent = [];
  let sequence = 0;
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: helpers,
    ResumeProProfile: require("../profile-fields.js"),
    ResumeProFormAgent: require("../form-agent.js"),
    AbortController, TextEncoder, performance: { now: () => 0 },
    crypto: { randomUUID: () => `synthetic-${++sequence}` }
  });
  context.self = {
    ResumeProDeepAnalysis: deep,
    postMessage(message) {
      sent.push(message);
      if (message.kind === "desktop-complete") {
        Promise.resolve(respond(message)).then((reply) => {
          context.self.onmessage({ data: { kind: "desktop-result", callId: message.callId, reply } });
        });
      }
    }
  };
  vm.runInContext(source, context);
  const ask = (message) => new Promise((resolve) => {
    context.self.onmessage({ data: { id: 1, message, sender: { tab: { id: 3 }, frameId: 0, documentId: "doc" } } });
    const poll = () => {
      const reply = sent.find((item) => item.id === 1 && item.reply);
      if (reply) resolve(reply.reply); else setImmediate(poll);
    };
    poll();
  });
  return { context, sent, ask, desktop: () => sent.filter((item) => item.kind === "desktop-complete") };
}

const SPEC = '{"pageState":"editing","fields":[{"ref":"e1","label":"姓名","control":"text"}]}';

test("the analysis sends only the outline, as purpose analyze with no tier, and returns the parsed spec", async () => {
  const env = worker(() => ({ ok: true, text: `\`\`\`json\n${SPEC}\n\`\`\``, tier: "strong" }));
  const reply = await env.ask({ type: "AI_ANALYZE_PAGE", requestId: "r1", outline: "[区块] 基本信息\n  e1 input[text] ← 姓名", part: 1, parts: 1,
    resumeFields: [{ key: "姓名", value: "王小明" }] });
  assert.equal(reply.success, true);
  assert.deepEqual(reply.spec, JSON.parse(SPEC));
  assert.equal(reply.tierUsed, "strong");
  const [call] = env.desktop();
  assert.equal(call.purpose, "analyze");
  assert.equal(call.tier, undefined, "analyze without a tier is the strong tier on the desktop");
  assert.equal(call.system, deep.ANALYZE_SYSTEM_PROMPT);
  assert.match(call.user, /e1 input\[text\] ← 姓名/);
  assert.ok(!JSON.stringify(env.sent).includes("王小明"), "nothing but the outline goes out");
  assert.equal("text" in reply, false, "the model's raw text never comes back");
});

test("text that is not a JSON object is analyze_invalid, not a crash", async () => {
  const env = worker(() => ({ ok: true, text: "好的，下面是分析：页面有姓名字段。" }));
  const reply = await env.ask({ type: "AI_ANALYZE_PAGE", requestId: "r1", outline: "e1 input", part: 1, parts: 1 });
  assert.equal(reply.success, false);
  assert.equal(reply.errorCode, "analyze_invalid");
  assert.ok(!reply.error.includes("好的"), "the reply never echoes model text");
});

test("an old desktop and a strong provider without a key get their own messages", async () => {
  const old = await worker(() => ({ ok: false, reason: "incompatible" })).ask({ type: "AI_ANALYZE_PAGE", requestId: "r", outline: "e1", part: 1, parts: 1 });
  assert.equal(old.errorCode, "incompatible");
  assert.match(old.error, /深度分析需要更新桌面程序/);
  const keyless = await worker(() => ({ ok: false, reason: "not_configured", tier: "strong" })).ask({ type: "AI_ANALYZE_PAGE", requestId: "r", outline: "e1", part: 1, parts: 1 });
  assert.match(keyless.error, /强模型那条服务商还没有 Key/);
  assert.equal(keyless.openView, "settings-ai");
});

test("an analysis timeout names the strong model's host, the seconds waited and what to try", async () => {
  const env = worker(() => ({ ok: false, reason: "timeout", tier: "strong", host: "api.deepseek.com" }));
  let clock = 0;
  env.context.performance.now = () => (clock += 90_000);
  const reply = await env.ask({ type: "AI_ANALYZE_PAGE", requestId: "r1", outline: "[区块] 基本信息\n  e1 input[text] ← 姓名", part: 1, parts: 1 });
  assert.equal(reply.success, false);
  assert.equal(reply.errorCode, "timeout");
  assert.match(reply.error, /^强模型（api\.deepseek\.com）等了 \d+ 秒没有完成页面分析。/);
  assert.match(reply.error, /稍后重试/);
  assert.match(reply.error, /不带深度思考的模型/);
});

test("an empty or oversized outline is refused before anything is sent", async () => {
  const env = worker(() => ({ ok: true, text: SPEC }));
  assert.equal((await env.ask({ type: "AI_ANALYZE_PAGE", requestId: "a", outline: "", part: 1, parts: 1 })).errorCode, "input_too_large");
  assert.equal((await env.ask({ type: "AI_ANALYZE_PAGE", requestId: "b", outline: "x".repeat(50000), part: 1, parts: 1 })).errorCode, "input_too_large");
  assert.equal(env.desktop().length, 0);
});

test("the analysis can be cancelled through the same channel as a fill", async () => {
  let release;
  const env = worker(() => new Promise((resolve) => { release = resolve; }));
  const pending = env.ask({ type: "AI_ANALYZE_PAGE", requestId: "r9", outline: "e1", part: 1, parts: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  env.context.self.onmessage({ data: { id: 2, message: { type: "CANCEL_AI_FILL", requestId: "r9" }, sender: { tab: { id: 3 }, frameId: 0, documentId: "doc" } } });
  const reply = await pending;
  assert.equal(reply.success, false);
  assert.equal(reply.errorCode, "cancelled");
  assert.ok(env.sent.some((item) => item.kind === "desktop-cancel"));
  release?.({ ok: true, text: SPEC });
});

function bigFill(count) {
  // 每个字段带一大段候选资料，迫使 worker 分成多批，每批一次模型调用。
  const formFields = Array.from({ length: count }, (_, i) => ({ fieldId: `f${i}`, label: `问题${i}说明` }));
  const resumeFields = Array.from({ length: count }, (_, i) => ({ group: "补充", key: `问题${i}说明`, value: `${"很长的回答".repeat(2600)}${i}` }));
  return { formFields, resumeFields };
}

test("a fill with maxCalls stops at the budget, says so, and reports the calls it really made", async () => {
  const env = worker(() => ({ ok: true, text: "[]", tier: "strong" }));
  const result = await env.context.handleAiFill({ ...bigFill(5), tier: "strong", maxCalls: 2 });
  assert.equal(env.desktop().length, 2);
  assert.equal(result.diagnostics.calls, 2);
  assert.equal(result.diagnostics.budgetExhausted, true);
  assert.match(result.warning, /调用上限/);
  assert.ok(env.desktop().every((call) => call.tier === "strong" && call.purpose === "fill"));
});

test("maxCalls 0 sends nothing but still returns the local rule matches", async () => {
  const env = worker(() => ({ ok: true, text: "[]" }));
  const result = await env.context.handleAiFill({
    formFields: [{ fieldId: "name", label: "姓名" }, { fieldId: "x", label: "其他说明" }],
    resumeFields: [{ group: "基本信息", key: "姓名", value: "测试用户" }, { group: "补充", key: "其他说明", value: "有" }],
    tier: "strong", maxCalls: 0
  });
  assert.equal(env.desktop().length, 0);
  assert.deepEqual(Array.from(result.matches, (match) => match.fieldId), ["name"]);
  assert.equal(result.diagnostics.calls, 0);
});

test("an ordinary fill has no budget and its diagnostics have no call count", async () => {
  const env = worker(() => ({ ok: true, text: "[]" }));
  const result = await env.context.handleAiFill(bigFill(3));
  assert.equal(env.desktop().length >= 3, true);
  assert.equal("calls" in result.diagnostics, false);
  assert.equal("budgetExhausted" in result.diagnostics, false);
});

test("the AI host forwards the analysis message to the worker", () => {
  const host = fs.readFileSync(path.join(__dirname, "..", "ai-host.js"), "utf8");
  assert.match(host, /"AI_ANALYZE_PAGE"/);
  assert.match(source, /importScripts\([^)]*"deep-analysis\.js"/);
});
