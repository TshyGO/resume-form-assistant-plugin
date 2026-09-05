const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const helpers = require("../ai-helpers.js");

const resumeFields = [
  { group: "基本信息", key: "姓名", value: "测试用户" },
  { group: "教育背景", key: "学校1", value: "大学甲" },
  { group: "教育背景", key: "毕业时间1", value: "2020" },
  { group: "教育背景", key: "学校2", value: "大学乙" },
  { group: "教育背景", key: "毕业时间2", value: "2024" },
  ...Array.from({ length: 60 }, (_, i) => ({ group: "工作经历", key: `工作${i}`, value: "完整工作描述".repeat(80) }))
];
const formFields = [{ fieldId: "name", label: "姓名" }, { fieldId: "school", label: "学校" }];
const message = { aiConfig: { apiUrl: "https://example.test", apiKey: "private-key", model: "test" }, formFields, resumeFields };

function loadBackground(fetchImpl) {
  const timers = new Map();
  const requests = [];
  let clock = 0;
  let listener;
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: helpers, AbortController, TextEncoder, SyntaxError,
    performance: { now: () => clock },
    setTimeout(callback, delay) { const id = timers.size + 1; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: { action: { onClicked: { addListener() {} } }, runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    fetch: async (url, options) => { requests.push({ url, options }); return fetchImpl(options); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  return { run: (input = message, controller) => context.handleAiFill(input, controller),
    send: (input, sender = { tab: { id: 1 }, frameId: 0, documentId: "doc" }) => new Promise(resolve => listener(input, sender, resolve)),
    timers, requests, advance(ms) { clock += ms; } };
}
const ok = (matches = [{ fieldId: "school", value: "大学乙" }]) => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(matches) } }] }) });

test("candidate pruning retains complete repeated education records and reduces long-resume bytes", () => {
  const selected = helpers.selectResumeCandidates([formFields[1]], resumeFields);
  assert.deepEqual(selected, resumeFields.slice(1, 5));
  assert.ok(Buffer.byteLength(JSON.stringify(selected)) < Buffer.byteLength(JSON.stringify(resumeFields)) * 0.1);
});

test("ambiguous, unknown and empty-candidate fields fall back; custom groups are retained", () => {
  for (const label of ["自我评价", "毕业后工作计划", "技能"]) {
    assert.equal(helpers.selectResumeCandidates([{ label }], resumeFields), resumeFields);
  }
  const custom = { group: "自定义", key: "说明", value: "不能排除" };
  assert.ok(helpers.selectResumeCandidates([{ label: "学校" }], [...resumeFields, custom]).includes(custom));
  assert.deepEqual(helpers.selectResumeCandidates([{ label: "学校" }], []), []);
  assert.deepEqual(helpers.selectResumeCandidates([], resumeFields), []);
});

for (const delay of [1000, 10000, 60000, 120000]) {
  test(`successful ${delay / 1000}s simulated API has no automatic deadline`, async () => {
    const env = loadBackground(async () => {
      env.advance(delay / 2);
      return { ok: true, json: async () => { env.advance(delay / 2); return { choices: [{ message: { content: '[{"fieldId":"school","value":"大学乙"}]' } }] }; } };
    });
    const result = await env.run();
    assert.equal(result.success, true);
    assert.equal(result.matches.length, 2);
    assert.equal(result.diagnostics.apiMs, delay);
    assert.equal(result.diagnostics.candidateFields, 4);
    assert.equal(result.diagnostics.aiMatches, 1);
    assert.equal(env.timers.size, 0);
    const body = JSON.parse(env.requests[0].options.body);
    assert.ok(!body.messages[1].content.includes("完整工作描述"));
    assert.equal(result.diagnostics.promptBytes, Buffer.byteLength(body.messages[1].content));
    assert.ok(!JSON.stringify(result.diagnostics).includes("private-key"));
  });
}

test("all-local matches make no API request or timer", async () => {
  const env = loadBackground(() => { throw new Error("must not call"); });
  const result = await env.run({ ...message, formFields: [formFields[0]] });
  assert.equal(result.success, true);
  assert.equal(result.diagnostics.apiMs, 0);
  assert.equal(result.diagnostics.candidateFields, 0);
  assert.equal(env.requests.length, 0);
  assert.equal(env.timers.size, 0);
});

for (const status of [400, 401, 429, 500, 503]) {
  test(`HTTP ${status} retains local results without reflecting provider secrets`, async () => {
    const env = loadBackground(() => ({ ok: false, status, json: async () => { throw new Error("private-key"); } }));
    const result = await env.run();
    assert.equal(result.success, true);
    assert.equal(result.matches.length, 1);
    assert.equal(result.diagnostics.errorCode, `http_${status}`);
    assert.match(result.warning, new RegExp(String(status)));
    assert.ok(!JSON.stringify(result).includes("private-key"));
    assert.equal(env.timers.size, 0);
  });
}

for (const stage of ["headers", "body"]) {
  test(`manual cancel during ${stage} aborts request and retains local results`, async () => {
    const env = loadBackground((options) => {
      const pending = () => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
      return stage === "headers" ? pending() : { ok: true, json: pending };
    });
    const controller = new AbortController();
    const pending = env.run(message, controller);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(env.timers.size, 0);
    env.advance(120000);
    assert.equal(env.requests[0].options.signal.aborted, false);
    controller.abort();
    const result = await pending;
    assert.equal(env.requests[0].options.signal.aborted, true);
    assert.equal(result.diagnostics.errorCode, "cancelled");
    assert.equal(result.diagnostics.apiMs, 120000);
    assert.equal(result.matches.length, 1);
    assert.equal(env.timers.size, 0);
  });
}

test("network failure without local matches returns explicit failure", async () => {
  const env = loadBackground(() => { throw new TypeError("private-key"); });
  const result = await env.run({ ...message, formFields: [formFields[1]] });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics.errorCode, "network");
  assert.ok(!result.error.includes("private-key"));
  assert.equal(env.timers.size, 0);
});

test("cancel routing is isolated by request, tab, frame and document, and cleaned after completion", async () => {
  const env = loadBackground(options => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  const pending = env.send({ ...message, type: "AI_FILL", requestId: "one" });
  const cancel = { type: "CANCEL_AI_FILL", requestId: "one" };
  for (const sender of [
    { tab: { id: 2 }, frameId: 0, documentId: "doc" },
    { tab: { id: 1 }, frameId: 1, documentId: "doc" },
    { tab: { id: 1 }, frameId: 0, documentId: "other" }
  ]) assert.equal((await env.send(cancel, sender)).cancelled, false);
  assert.equal((await env.send({ ...cancel, requestId: "other" })).cancelled, false);
  assert.equal(env.requests[0].options.signal.aborted, false);
  assert.equal((await env.send(cancel)).cancelled, true);
  assert.equal((await pending).diagnostics.errorCode, "cancelled");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await env.send(cancel)).cancelled, false);
});

test("cancelled late response is discarded rather than filled", async () => {
  const controller = new AbortController();
  const env = loadBackground(() => ({ ok: true, json: async () => {
    controller.abort();
    return { choices: [{ message: { content: '[{"fieldId":"school","value":"late"}]' } }] };
  } }));
  const result = await env.run(message, controller);
  assert.equal(result.diagnostics.errorCode, "cancelled");
  assert.equal(result.matches.length, 1);
});

for (const response of [
  { ok: true, json: async () => { throw new SyntaxError("invalid JSON private-key"); } },
  { ok: true, json: async () => ({}) },
  { ok: true, json: async () => ({ choices: [{ message: { content: "invalid private-key" } }] }) }
]) {
  test("invalid API content retains local results and classifies format errors", async () => {
    const env = loadBackground(() => response);
    const result = await env.run();
    assert.equal(result.diagnostics.errorCode, "format");
    assert.equal(result.matches.length, 1);
    assert.ok(!result.warning.includes("private-key"));
    assert.equal(env.timers.size, 0);
  });
}

test("AI cannot overwrite local matches or fill IDs outside its requested subset", async () => {
  const env = loadBackground(() => ok([{ fieldId: "name", value: "错误姓名" }, { fieldId: "missing", value: "错误" }, { fieldId: "school", value: "大学乙" }]));
  const result = await env.run();
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].value, "测试用户");
});
