// #224：content.js 里的「深度分析本页」。真实的 deep-analysis.js 编排 + 真实的一键填写主流程，
// 页面大纲用替身（大纲本身见 page-outline.test.js）。验证首次确认、强档与共享预算、覆盖确认、
// 用户编辑保护、停止、换页和迟到回包，以及普通一键填写不受影响。
const test = require("node:test");
const assert = require("node:assert/strict");

const deep = require("../deep-analysis.js");
const outlineApi = require("../page-outline.js");
const { loadHighlightHelpers } = require("./helpers/content-harness.js");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const TEMPLATE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const store = () => ({
  templates: [{ id: TEMPLATE, name: "模板", groups: [{ name: "基本信息", fields: [
    { key: "姓名", value: "测试用户" }, { key: "现居城市", value: "杭州" }] }] }],
  activeTemplateId: TEMPLATE
});

function deepPage({ consent = true, analyze, fill, confirm = () => true, existing = ["", ""], staleButton = false, labels = [], fillProbe } = {}) {
  const location = { href: "https://jobs.example.test/apply", pathname: "/apply" };
  const inputs = [];
  const sent = [];
  const storageData = consent ? { deepAnalysisConsent: { version: 1 } } : {};
  const outlineCalls = [];
  const diagnostics = { hidden: true, open: false };
  const diagnosticsText = { value: "" };
  diagnostics.querySelector = () => diagnosticsText;
  let confirms = 0;
  const harness = loadHighlightHelpers({
    formElements: inputs,
    location,
    storageData,
    randomUUID: (() => { let n = 0; return () => `req-${++n}`; })(),
    confirm: (message) => { confirms++; return confirm(message, inputs); },
    deepAnalysis: deep,
    fillProbe,
    pageOutline: {
      build(_doc, options) {
        outlineCalls.push(options);
        const nodes = new Map(inputs.map((input, index) => [`e${index + 1}`, { type: "control", domKind: "text", element: input,
          control: { elements: [input], root: input, disabled: false } }]));
        return { parts: [{ text: inputs.map((_, i) => `e${i + 1} input[text]`).join("\n"), refs: [...nodes.keys()] }], nodes,
          redact: outlineApi.createRedactor(options.resumeValues), stats: { chars: 40, parts: 1, controls: inputs.length, truncated: false } };
      }
    },
    sendMessage: async (message) => {
      sent.push(message);
      if (message.type === "AI_ANALYZE_PAGE") return analyze ? analyze(message) : {
        success: true, tierUsed: "strong",
        spec: { pageState: "editing", fields: [
          { ref: "e1", label: "姓名", group: "基本信息", control: "text" },
          { ref: "e2", label: "现居城市", group: "基本信息", control: "text" }] }
      };
      if (message.type === "AI_FILL") return fill ? fill(message, inputs) : {
        success: true, matches: message.formFields.map((field) => ({ fieldId: field.fieldId, value: `AI-${field.label}` })),
        diagnostics: { ruleMatches: 0, aiMatches: message.formFields.length, calls: 1, tierRequested: "strong", tierUsed: "strong", errorCode: "none" }
      };
      if (message.type === "CANCEL_AI_FILL") return { cancelled: true };
      return { status: "ok" };
    }
  });
  const { helpers, HTMLInputElement, timers } = harness;
  existing.forEach((value) => {
    const input = new HTMLInputElement();
    input.value = value;
    input.getClientRects = () => [1];
    if (labels[inputs.length]) input.setAttribute("data-label", labels[inputs.length]);
    inputs.push(input);
  });
  // staleButton：刷新后的页面还没读过桌面，网页里的填写按钮停在禁用状态，模板下拉也在。
  const fillButton = { disabled: staleButton, textContent: "一键 AI 填写" };
  const sidebar = staleButton ? {
    "#resume-pro-template-select": { innerHTML: "", disabled: true },
    "#resume-pro-groups": { innerHTML: "", querySelectorAll: () => [], querySelector: () => null }
  } : {};
  helpers.setShadowRoot({ querySelector: (selector) => ({ "#resume-pro-ai-fill": fillButton,
    "#resume-pro-diagnostics": diagnostics, "#resume-pro-diagnostics-text": diagnosticsText, ...sidebar })[selector] || null });
  helpers.setCurrentStore(store());
  const ask = (message) => harness.sendPanelMessage({ type: "RESUME_PANEL_DEEP", ...message });
  const status = () => harness.sendPanelMessage({ type: "RESUME_PANEL_STATUS" });
  const settle = async (done) => {
    for (let i = 0; i < 400; i++) {
      await tick();
      for (const timer of timers) {
        if (!timer.cleared && timer.delay < 1000) { timer.cleared = true; timer.callback(); }
      }
      if (done((await status()).deep)) return (await status()).deep;
    }
    throw new Error(`controller did not settle: ${JSON.stringify((await status()).deep)}`);
  };
  return { ...harness, helpers, location, inputs, sent, storageData, outlineCalls, diagnostics, diagnosticsText, ask, status, settle,
    confirms: () => confirms, aiCalls: (type) => sent.filter((message) => message.type === type) };
}

const finished = (state) => !deep.ACTIVE.includes(state.phase);

test("first use: nothing is analysed until the user agrees, and the agreement is remembered", async () => {
  const page = deepPage({ consent: false });
  assert.equal((await page.status()).deepConsent, false);
  assert.deepEqual(await page.ask({ action: "start" }), { ok: false, error: "consent_required" });
  await tick();
  assert.equal(page.aiCalls("AI_ANALYZE_PAGE").length, 0);
  assert.equal(page.outlineCalls.length, 0, "not even an outline is built");
  const started = await page.ask({ action: "consent" });
  assert.equal(started.ok, true);
  assert.equal(JSON.stringify(page.storageData.deepAnalysisConsent), JSON.stringify({ version: 1 }));
  await page.settle(finished);
  assert.equal(page.aiCalls("AI_ANALYZE_PAGE").length, 1);
  await tick();
  assert.equal((await page.status()).deepConsent, true);
});

test("analyse → strong-tier fill through the normal flow: spec fields go out with the budget that is left", async () => {
  const page = deepPage();
  assert.equal((await page.ask({ action: "start" })).ok, true);
  const done = await page.settle(finished);
  assert.equal(done.phase, "completed");
  const [analysis] = page.aiCalls("AI_ANALYZE_PAGE");
  assert.deepEqual(Object.keys(analysis).sort(), ["outline", "part", "parts", "requestId", "type"], "the analysis carries only the outline");
  const [fill] = page.aiCalls("AI_FILL");
  assert.equal(fill.tier, "strong");
  assert.equal(fill.maxCalls, 5);
  assert.deepEqual(Array.from(fill.formFields, (field) => [field.fieldId, field.label, field.group]),
    [["deep-e1", "姓名", "基本信息"], ["deep-e2", "现居城市", "基本信息"]]);
  assert.deepEqual(page.inputs.map((input) => input.value), ["AI-姓名", "AI-现居城市"]);
  assert.deepEqual(done.result, { fields: 2, filled: 2, unfilled: 0, unconfirmed: 0 });
  assert.deepEqual(done.budget, { used: 2, limit: 6 });
  // The resume values were handed to the outline for redaction, not sent anywhere.
  assert.ok(page.outlineCalls[0].resumeValues.includes("测试用户"));
  assert.ok(!JSON.stringify(analysis).includes("测试用户"));
});

test("the deep fill's diagnostics carry outline size, validation, calls and tier, never field values or labels from the model", async () => {
  const page = deepPage();
  await page.ask({ action: "start" });
  await page.settle(finished);
  const text = page.diagnosticsText.value;
  assert.match(text, /深度分析：大纲 40 字，分 1 次分析/);
  assert.match(text, /页面说明书：字段 2，可填写 2；校验：通过/);
  assert.match(text, /深度分析模型调用：2\/6；分析档位：强/);
  assert.match(text, /模型档位：强/);
  assert.ok(!text.includes("AI-姓名") && !text.includes("测试用户"));
});

test("an invalid spec writes the analyze_invalid code to the diagnostics and touches nothing", async () => {
  const page = deepPage({ analyze: () => ({ success: true, spec: { pageState: "editing", fields: [{ ref: "e9", control: "text" }] } }) });
  await page.ask({ action: "start" });
  const done = await page.settle(finished);
  assert.equal(done.phase, "failed");
  assert.equal(page.aiCalls("AI_FILL").length, 0);
  assert.deepEqual(page.inputs.map((input) => input.value), ["", ""]);
  assert.match(page.diagnosticsText.value, /校验：analyze_invalid（unknown_ref）/);
  assert.equal(page.diagnostics.hidden, false);
});

test("overwrite confirmation still applies: declining leaves every existing value alone", async () => {
  const page = deepPage({ existing: ["用户自己填的", ""], confirm: () => false });
  await page.ask({ action: "start" });
  const done = await page.settle(finished);
  assert.equal(page.confirms(), 1);
  assert.deepEqual(page.inputs.map((input) => input.value), ["用户自己填的", ""]);
  assert.equal(done.phase, "stopped");
  assert.equal(done.message, "已按你的选择停止填写，网页现有内容没有改动。");
});

test("a value the user changes after approving is protected by the same write guard", async () => {
  const page = deepPage({ existing: ["旧值", ""], confirm: (_message, inputs) => { inputs[1].value = "我刚刚手动改的"; return true; } });
  await page.ask({ action: "start" });
  await page.settle(finished);
  assert.equal(page.inputs[1].value, "我刚刚手动改的", "the user's edit is never overwritten");
});

test("stop during the analysis cancels it; the late spec is ignored and nothing is filled", async () => {
  const reply = deferred();
  const page = deepPage({ analyze: () => reply.promise });
  const { requestId } = await page.ask({ action: "start" });
  await page.settle((state) => state.phase === "analyzing");
  assert.equal((await page.ask({ action: "stop", requestId })).ok, true);
  assert.deepEqual(page.aiCalls("CANCEL_AI_FILL").map((message) => message.requestId), [requestId]);
  reply.resolve({ success: true, spec: { pageState: "editing", fields: [{ ref: "e1", control: "text" }] } });
  await tick(); await tick();
  assert.equal((await page.status()).deep.phase, "stopped");
  assert.equal(page.aiCalls("AI_FILL").length, 0);
  assert.deepEqual(page.inputs.map((input) => input.value), ["", ""]);
});

test("stop while the fill waits for the AI: local matches that come back are not written", async () => {
  const reply = deferred();
  const page = deepPage({ fill: () => reply.promise });
  const { requestId } = await page.ask({ action: "start" });
  await page.settle((state) => state.phase === "filling" && page.aiCalls("AI_FILL").length === 1);
  assert.equal((await page.ask({ action: "stop", requestId })).ok, true);
  const fillRequest = page.aiCalls("AI_FILL")[0].requestId;
  assert.ok(page.aiCalls("CANCEL_AI_FILL").some((message) => message.requestId === fillRequest), "the fill's own request is cancelled");
  reply.resolve({ success: true, matches: [{ fieldId: "deep-e1", value: "本地规则" }], diagnostics: { errorCode: "cancelled", calls: 0 } });
  const done = await page.settle(finished);
  assert.equal(done.phase, "stopped");
  assert.deepEqual(page.inputs.map((input) => input.value), ["", ""]);
});

test("an address change during the analysis ends the run and the late reply is dropped", async () => {
  const reply = deferred();
  const page = deepPage({ analyze: () => reply.promise });
  await page.ask({ action: "start" });
  await page.settle((state) => state.phase === "analyzing");
  page.location.href = "https://jobs.example.test/apply/step-2";
  const state = (await page.status()).deep;
  assert.equal(state.phase, "stopped");
  reply.resolve({ success: true, spec: { pageState: "editing", fields: [{ ref: "e1", control: "text" }] } });
  await tick(); await tick();
  assert.equal(page.aiCalls("AI_FILL").length, 0);
});

test("while a deep analysis runs, 一键 AI 填写 and 辅助新增 wait; afterwards they work again", async () => {
  const reply = deferred();
  const page = deepPage({ analyze: () => reply.promise });
  await page.ask({ action: "start" });
  await page.settle((state) => state.phase === "analyzing");
  assert.equal((await page.sendPanelMessage({ type: "RESUME_PANEL_FILL" })).ok, false);
  assert.equal((await page.sendPanelMessage({ type: "RESUME_PANEL_REPEAT", action: "start" })).ok, false);
  assert.equal((await page.ask({ action: "start" })).ok, false, "one deep analysis at a time");
  reply.resolve({ success: false, errorCode: "network", error: "网络不通" });
  await page.settle(finished);
  assert.equal((await page.status()).busy, false, "the busy flag is released");
});

test("the entry: prominent after a fill that found nothing, quiet after an auth failure", async () => {
  const empty = deepPage({ existing: [] });
  await empty.helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  assert.equal((await empty.status()).deepOffer, "prominent");

  const auth = deepPage({ fill: () => ({ success: false, error: "Key 无效", diagnostics: { errorCode: "auth" } }) });
  await auth.helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  assert.equal((await auth.status()).deepOffer, "none");

  const fresh = deepPage();
  assert.equal((await fresh.status()).deepOffer, "secondary", "before any fill there is only the quiet entry");
});

test("an ordinary one-click fill is unchanged: no tier, no budget, no deep diagnostics", async () => {
  const page = deepPage();
  await page.helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  const [fill] = page.aiCalls("AI_FILL");
  assert.equal("tier" in fill, false);
  assert.equal("maxCalls" in fill, false);
  assert.ok(!page.diagnosticsText.value.includes("深度分析"));
});

test("a freshly loaded page whose own fill button still waits for the desktop read can run the deep fill", async () => {
  // 真机发现：刷新后网页里的按钮仍是禁用的，交给填写流程前要按刚读到的桌面状态重画，否则被当成「忙」。
  const page = deepPage({ staleButton: true });
  await page.ask({ action: "start" });
  const done = await page.settle(finished);
  assert.equal(done.phase, "completed", done.message);
  assert.deepEqual(page.inputs.map((input) => input.value), ["AI-姓名", "AI-现居城市"]);
});

test("after a deep fill, fields the normal scan also knows are offered to 我的信息 like after a normal fill", async () => {
  const page = deepPage({
    labels: ["姓名", "期望到岗时间"],
    analyze: () => ({ success: true, spec: { pageState: "editing", fields: [
      { ref: "e1", label: "姓名", control: "text" }, { ref: "e2", label: "期望到岗时间", control: "text" }] } }),
    fill: (message) => ({ success: true, matches: [{ fieldId: message.formFields[0].fieldId, value: "测试用户" }],
      diagnostics: { ruleMatches: 1, aiMatches: 0, calls: 1, errorCode: "none" } })
  });
  await page.ask({ action: "start" });
  await page.settle(finished);
  const offer = (await page.status()).profileOffer;
  assert.ok(offer, "the 加到我的信息 card is offered");
  assert.match(JSON.stringify(offer), /期望到岗时间/);
});

test("the deep fill's diagnostics name the control kinds the fill used", async () => {
  const page = deepPage({
    analyze: () => ({ success: true, spec: { pageState: "editing", fields: [
      { ref: "e1", label: "姓名", control: "text" }, { ref: "e2", label: "现居城市", control: "radio" }] } })
  });
  await page.ask({ action: "start" });
  await page.settle(finished);
  // 普通输入框不能当单选：按 DOM 改回 text，计数按改正后的类型。
  assert.match(page.diagnosticsText.value, /控件类型按网页改正 1/);
  assert.match(page.diagnosticsText.value, /说明书控件类型：text 2/);
});

test("an unfilled deep field says in the diagnostics which control kind it was operated as", async () => {
  // AI 审查两次认为 operated 不会写出：noteControlFailure 收到的是 fieldMap 条目（带 deepRef、controlKind），不是 DOM 元素。
  const page = deepPage({ fillProbe: require("../fill-probe.js"),
    fill: (message) => ({ success: true, matches: message.formFields.map((field) => ({ fieldId: field.fieldId, value: "x" })),
      diagnostics: { ruleMatches: 0, aiMatches: 2, calls: 1, errorCode: "none" } }) });
  page.inputs.forEach((input) => { input.disabled = true; });
  await page.ask({ action: "start" });
  await page.settle(finished);
  assert.match(page.diagnosticsText.value, /：.*｜按 text 操作｜/, page.diagnosticsText.value);
});
