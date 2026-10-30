// #402：AI 慢的时候先填本地规则能确定的空字段，AI 请求同时在后台进行；AI 回来后只补剩下的字段。
// 按 manifest 的顺序在 jsdom 里加载全部 content script；AI_FILL 交给 vm 里真实的 ai-worker.js，
// 只有「桌面」是替身：测试自己决定 AI 什么时候回、回什么，或者超时。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_scripts[0].js;
const RESUME = [["基本信息", "姓名", "测试用户"], ["基本信息", "邮箱", "tester@example.com"], ["基本信息", "手机号码", "13800138000"],
  ["基本信息", "性别", "男"], ["教育经历", "毕业院校", "示例大学"], ["教育经历", "专业", "示例专业"], ["求职意向", "期望城市", "示例市"]];
// 本该很快结束的填写如果还在等 AI（main 上就是这样），限时失败而不是卡住。
const within = (promise, ms = 5000) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("the fill is still waiting")), ms).unref())]);
const lineOf = (report, key) => (report.match(new RegExp(`^${key}: (.*)$`, "m")) || [])[1];

// jsdom 不排版：可见的元素都给一个框，隐藏的没有。
function layout(w) {
  const rectOf = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const css = w.getComputedStyle(node);
      if (node.hidden || css.display === "none" || css.visibility === "hidden") return null;
    }
    return { top: 10, left: 10, width: 300, height: 30, right: 310, bottom: 40, x: 10, y: 10, toJSON() { return this; } };
  };
  const empty = { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() { return this; } };
  w.Element.prototype.getBoundingClientRect = function () { return rectOf(this) || empty; };
  w.Element.prototype.getClientRects = function () { const rect = rectOf(this); return rect ? [rect] : []; };
  w.Element.prototype.scrollIntoView = function () {};
  for (const side of ["Width", "Height"]) {
    Object.defineProperty(w.HTMLElement.prototype, `offset${side}`, { configurable: true,
      get() { return rectOf(this)?.[side.toLowerCase()] || 0; } });
  }
}

// 真实的 ai-worker.js；桌面替身把每次请求记下来，由测试决定怎么回。
function aiWorker(clock, resume = RESUME) {
  const calls = [];
  const cancels = [];
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: require("../ai-helpers.js"), ResumeProProfile: require("../profile-fields.js"),
    ResumeProFormAgent: require("../form-agent.js"), AbortController, TextEncoder, performance: { now: () => clock.now },
    crypto: { randomUUID: () => `call-${calls.length + cancels.length + 1}` }, console
  });
  context.self = {
    postMessage(message) {
      if (message.kind === "desktop-cancel") { cancels.push(message.callId); return; }
      if (message.kind !== "desktop-complete") return;
      const fields = JSON.parse(message.user.split("\n")[1]);
      const call = { fields, labels: fields.map((field) => field.label) };
      const answer = (reply) => context.self.onmessage({ data: { kind: "desktop-result", callId: message.callId, reply } });
      // 按题目名回答；不传就只回这几项里资料有的。
      call.reply = (values = null) => answer({ ok: true, text: JSON.stringify(fields
        .map((field) => ({ fieldId: field.fieldId, value: (values || Object.fromEntries(resume.map(([, key, value]) => [key, value])))[field.label] }))
        .filter((item) => item.value)) });
      call.fail = (reply) => answer({ ok: false, ...reply });
      calls.push(call);
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "ai-worker.js"), "utf8"), context);
  const sender = { tab: { id: 1 }, frameId: 0, documentId: "doc" };
  return {
    calls, cancels,
    dispatch: (message) => new Promise((resolve) => {
      const copy = JSON.parse(JSON.stringify(message));
      const keepOpen = context.dispatchAiMessage(copy, sender, (reply) => resolve(JSON.parse(JSON.stringify(reply ?? null))));
      if (!keepOpen && copy.type !== "CANCEL_AI_FILL") resolve(undefined);
    })
  };
}

const item = (id, label, control) => `<div class="form-item" id="${id}-item"><label for="${id}">${label}</label>${control}</div>`;
const input = (id, label, { type = "text", value = "" } = {}) => item(id, label, `<input id="${id}" name="${id}" type="${type}" value="${value}">`);

// body 是表单内容；confirm 返回 true/false；onGender：选了性别后页面要做的事（新出现字段之类）；resume 是简历资料。
function page(t, body, { confirm = () => true, onGender = null, resume = RESUME } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>网上申请</title></head><body><form id="apply">${body}</form></body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "https://jobs.example.test/apply/form" });
  const w = dom.window;
  t.after(() => w.close());
  layout(w);
  Object.defineProperty(w.document, "readyState", { get: () => "loading", configurable: true });
  const listen = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, ...rest) => (type === "DOMContentLoaded" ? undefined : listen(type, ...rest));
  w.__RESUME_PRO_TEST__ = true;
  const confirms = [];
  w.confirm = (text) => { confirms.push(text); return confirm(text); };
  const clock = { now: 0 };
  const worker = aiWorker(clock, resume);
  const groups = [...new Set(resume.map(([group]) => group))].map((name) => ({ name,
    fields: resume.filter(([group]) => group === name).map(([, key, value]) => ({ key, value })) }));
  const template = { id: "t", name: "虚构模板", groups };
  const data = { templates: [{ id: "t", name: "虚构模板", fieldCount: resume.length }], activeTemplate: template,
    profile: { values: {}, family: [], custom: [] }, profileRevision: 0 };
  const sent = [];
  w.chrome = {
    runtime: { id: "test-extension", getURL: (file) => `chrome-extension://test-extension/${file}`, getManifest: () => ({ version: "0.4.4" }),
      onMessage: { addListener(listener) { w.__panel = listener; } },
      sendMessage: async (message) => {
        sent.push(message.type);
        if (message.type === "DESKTOP_RESUME_READ") return { status: "ok", data };
        if (["ENSURE_AI_HOST", "AI_HOST_READY"].includes(message.type)) return { ready: true };
        if (message.type === "AI_FILL" || message.type === "CANCEL_AI_FILL") return worker.dispatch(message);
        return {};
      } },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} } }
  };
  for (const file of SCRIPTS) w.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
  const gender = w.document.getElementById("gender");
  if (gender && onGender) gender.addEventListener("change", () => onGender(w.document));
  const ui = { status: { textContent: "", className: "" }, diag: { value: "" }, cancel: { hidden: true, disabled: false, onclick: null },
    hint: { hidden: true, textContent: "" }, fill: { disabled: false, textContent: "" } };
  ui.status.classList = { contains: (name) => String(ui.status.className).split(/\s+/).includes(name) };
  const diagnostics = { hidden: true, open: false, querySelector: (selector) => (selector === "#resume-pro-diagnostics-text" ? ui.diag : null) };
  const parts = { "#resume-pro-status": ui.status, "#resume-pro-diagnostics": diagnostics,
    "#resume-pro-diagnostics-text": ui.diag, "#resume-pro-cancel-fill": ui.cancel, "#resume-pro-wait-hint": ui.hint, "#resume-pro-ai-fill": ui.fill };
  const helpers = w.ResumeProHighlightTest;
  helpers.setShadowRoot({ querySelectorAll: () => [], querySelector: (selector) => parts[selector] || null });
  const value = (id) => w.document.getElementById(id).value;
  return {
    w, ui, worker, clock, confirms, sent, value,
    run: () => within(helpers.handleAiFillClick({ currentTarget: ui.fill }), 15000),
    // 等到 check() 成立；最多等 ms 毫秒（main 上先填不会发生，限时失败而不是卡住）。
    async until(check, ms = 3000) {
      const end = Date.now() + ms;
      while (!check()) {
        if (Date.now() > end) return false;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return true;
    },
    async report() {
      return new Promise((resolve) => w.__panel({ type: "RESUME_PANEL_STATUS" }, { id: "test-extension" },
        (reply) => resolve(JSON.parse(JSON.stringify(reply)))));
    }
  };
}

const BASIC = input("name", "姓名") + input("email", "邮箱", { type: "email" }) + input("phone", "手机号码", { type: "tel" })
  + input("school", "毕业院校") + input("major", "专业");

test("the fields local rules can fill are on the page before the AI answers; the AI's are filled after it does", async (t) => {
  const p = page(t, BASIC);
  const running = p.run();
  const early = await p.until(() => p.value("name") && p.value("email") && p.value("phone") && p.worker.calls.length === 1);
  assert.ok(early, `local fields wait for the AI: ${JSON.stringify(["name", "email", "phone"].map(p.value))}`);
  assert.deepEqual(["name", "email", "phone"].map(p.value), ["测试用户", "tester@example.com", "13800138000"]);
  assert.deepEqual(["school", "major"].map(p.value), ["", ""], "the AI's fields wait for the AI");
  // 送 AI 的只有本地规则匹配不上的；先填完以后按钮说已经先填了几项。
  assert.deepEqual(p.worker.calls[0].labels, ["毕业院校", "专业"]);
  await p.until(() => /已先填 3 项，AI 匹配中/.test(p.ui.fill.textContent));
  assert.match(p.ui.fill.textContent, /^已先填 3 项，AI 匹配中\.\.\. \d+s$/);
  assert.equal(p.ui.cancel.hidden, false, "the AI wait can still be cancelled");
  p.worker.calls[0].reply();
  const result = await running;
  assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
    ["测试用户", "tester@example.com", "13800138000", "示例大学", "示例专业"]);
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 5);
  assert.equal(p.ui.status.textContent, "已填写 5 个字段。");
  assert.equal(p.confirms.length, 0);
  // 首轮的口径不变：本地 3、AI 2，匹配 5、填上 5。
  const report = (await p.report()).diagnosticsReport;
  assert.equal(lineOf(report, "candidates"), "5");
  assert.equal(lineOf(report, "matched"), "5");
  assert.equal(lineOf(report, "filled"), "5");
  assert.equal(lineOf(report, "local_matches"), "3");
  assert.equal(lineOf(report, "ai_matches"), "2");
  assert.equal(lineOf(report, "drop_reasons"), "-");
  assert.match(p.ui.diag.value, /AI 返回前先填：3 项/);
});

for (const [stage, message] of [
  ["first_byte", "日常模型等了 120 秒没有回复，服务商可能太忙或模型太慢，可以稍后重试，或在桌面设置换模型。"],
  ["connect", "日常模型等了 120 秒还没连上服务商（api.example.com），请检查网络或代理。"],
  ["body", "日常模型的服务商已经响应，但等了 120 秒还没收到完整结果，可能是模型太慢或网络慢，可以稍后重试，或在桌面设置换模型。"]
]) {
  test(`an AI timeout (${stage}) leaves the early local fill in place and says where the request stopped`, async (t) => {
    const p = page(t, BASIC);
    const running = p.run();
    assert.ok(await p.until(() => p.value("phone") && p.worker.calls.length === 1), "filled before the timeout");
    p.clock.now = 120_000;
    p.worker.calls[0].fail({ reason: "timeout", host: "api.example.com", timeoutStage: stage });
    const result = await running;
    assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
      ["测试用户", "tester@example.com", "13800138000", "", ""]);
    assert.equal(result.outcome, "partial");
    assert.equal(result.filledCount, 3);
    assert.equal(p.ui.status.textContent, `本地已填写 3 项；${message}`);
    const report = (await p.report()).diagnosticsReport;
    assert.equal(lineOf(report, "error_code"), "timeout");
    assert.equal(lineOf(report, "ai_timeout_stage"), stage);
    assert.equal(lineOf(report, "matched"), "3");
    assert.equal(lineOf(report, "drop_reasons"), "no_result=2");
  });
}

test("cancelling the AI wait keeps what was filled early and writes nothing more", async (t) => {
  const p = page(t, BASIC);
  const running = p.run();
  assert.ok(await p.until(() => p.value("phone") && p.worker.calls.length === 1 && /AI 匹配中/.test(p.ui.fill.textContent)),
    "filled before the cancel");
  await p.ui.cancel.onclick();
  const result = await running;
  assert.equal(p.worker.cancels.length, 1, "the desktop call was cancelled");
  assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
    ["测试用户", "tester@example.com", "13800138000", "", ""]);
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledCount, 3);
  assert.equal(p.ui.status.textContent, "本地已填写 3 项；已按你的操作取消 AI 等待。取消不保证上游停止计算或停止计费。");
  assert.equal(p.ui.cancel.hidden, true);
});

test("cancelling while the early fill is still writing only cancels the AI wait; the local fields are still written", async (t) => {
  // 按钮写的是「取消 AI 等待（保留本地匹配）」：第二个字段正在写时按，本地匹配照常写完，只是不再等 AI。
  const p = page(t, BASIC);
  p.w.document.getElementById("email").addEventListener("input", () => p.ui.cancel.onclick(), { once: true });
  const result = await within(p.run());
  assert.equal(p.worker.cancels.length, 1, "the AI request is cancelled");
  assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
    ["测试用户", "tester@example.com", "13800138000", "", ""]);
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledCount, 3);
  assert.equal(p.ui.status.textContent, "本地已填写 3 项；已按你的操作取消 AI 等待。取消不保证上游停止计算或停止计费。");
  await p.until(() => false, 50);
  assert.equal(p.worker.calls.length, 1);
});

// AI 回来、填完它自己的字段以后：先填的字段被上面 AI 选的题目清空了，按原值再填一次，和原来从上往下填的结果一样。
test("a local field the page clears when the AI's choice above it changes is filled again after that choice", async (t) => {
  const resume = [["基本信息", "证件类型", "身份证"], ["基本信息", "身份证号", "110101199001011234"], ...RESUME];
  const TYPE = item("idType", "证件类型", `<select id="idType" name="idType"><option value="">请选择</option><option value="1">身份证</option><option value="2">护照</option></select>`);
  const p = page(t, input("name", "姓名") + TYPE + input("idNo", "证件号码"), { resume });
  // 常见的 Vue watch：证件类型一变，证件号码清空。
  p.w.document.getElementById("idType").addEventListener("change", () => {
    const number = p.w.document.getElementById("idNo");
    number.value = "";
    number.dispatchEvent(new p.w.Event("input", { bubbles: true }));
  });
  const running = p.run();
  assert.ok(await p.until(() => p.value("idNo") && p.worker.calls.length === 1 && /AI 匹配中/.test(p.ui.fill.textContent)),
    "the number is filled before the AI answers");
  assert.deepEqual(p.worker.calls[0].labels, ["证件类型"]);
  p.worker.calls[0].reply();
  const result = await running;
  assert.deepEqual(["name", "idType", "idNo"].map(p.value), ["测试用户", "1", "110101199001011234"]);
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 3);
  assert.equal(p.ui.status.textContent, "已填写 3 个字段。");
  const report = (await p.report()).diagnosticsReport;
  assert.equal(lineOf(report, "filled"), "3");
  assert.equal(lineOf(report, "drop_reasons"), "-");
  assert.equal(p.sent.filter((type) => type === "FEEDBACK_AUTO").length, 0);
});

// #269 智联那类：先填时选了某项，页面把后面还空着的字段整块换成新节点。AI 回来时它们不是「已有内容」。
test("an early choice that makes the page rebuild the AI's empty fields asks no overwrite question", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const p = page(t, input("name", "姓名") + GENDER + input("school", "毕业院校") + input("major", "专业"), {
    confirm: () => false,
    onGender: (doc) => {
      for (const [id, label] of [["school", "毕业院校"], ["major", "专业"]]) {
        const holder = doc.createElement("div");
        holder.innerHTML = input(id, label);
        doc.getElementById(`${id}-item`).replaceWith(holder.firstChild);
      }
    }
  });
  const running = p.run();
  assert.ok(await p.until(() => p.value("gender") === "m" && p.worker.calls.length === 1 && /AI 匹配中/.test(p.ui.fill.textContent)),
    "the select is chosen before the AI answers");
  p.worker.calls[0].reply();
  const result = await running;
  assert.deepEqual(p.confirms, []);
  assert.deepEqual(["name", "gender", "school", "major"].map(p.value), ["测试用户", "m", "示例大学", "示例专业"]);
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 4);
});

// AI 比先填先回来：诊断里的匹配往返是 AI 回来的时间，不含等先填写完的时间。
test("the match time is the AI's round trip even when the early fill takes longer", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const p = page(t, input("name", "姓名") + GENDER + input("school", "毕业院校"), {
    // 选完以后页面还要变一阵（校验、重画），先填要等页面安静。
    onGender: (doc) => {
      let n = 0;
      const tick = () => { if (n++ < 30) { doc.getElementById("apply").setAttribute("class", `v${n}`); setTimeout(tick, 40); } };
      tick();
    }
  });
  const running = p.run();
  assert.ok(await p.until(() => p.worker.calls.length === 1));
  p.worker.calls[0].reply();
  const result = await running;
  assert.equal(result.filledCount, 3);
  const timings = lineOf((await p.report()).diagnosticsReport, "timings_ms");
  const [match, fill] = ["match", "fill"].map((key) => Number(new RegExp(`${key}=(\\d+)`).exec(timings)?.[1]));
  assert.ok(fill > 1000, timings);
  assert.ok(match < 500, timings);
  assert.match(p.ui.diag.value, /AI 返回前先填：2 项/);
});

test("when the AI request itself fails after the early fill, the early text fields still get their final sync", async (t) => {
  const p = page(t, BASIC);
  // AI 请求通道断开：sendMessage 被拒绝，不是桌面回了失败。
  let fail;
  const send = p.w.chrome.runtime.sendMessage;
  p.w.chrome.runtime.sendMessage = (message) => message.type === "AI_FILL"
    ? new Promise((_, reject) => { fail = reject; }) : send(message);
  const running = p.run();
  assert.ok(await p.until(() => p.value("phone") && fail && /AI 匹配中/.test(p.ui.fill.textContent)), "filled before the failure");
  let synced = 0;
  for (const id of ["name", "email", "phone"]) p.w.document.getElementById(id).addEventListener("blur", () => { synced += 1; });
  fail(new Error("AI 请求通道已断开。"));
  const result = await running;
  assert.equal(synced, 3, "each early text field is focused and blurred once more");
  assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
    ["测试用户", "tester@example.com", "13800138000", "", ""]);
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledCount, 3);
  assert.equal(p.ui.status.textContent, "AI 请求通道已断开。已先填写 3 项，请核对网页。");
});

const OCCUPIED = input("name", "姓名") + input("email", "邮箱", { type: "email", value: "old@example.com" }) + input("phone", "手机号码", { type: "tel" })
  + input("school", "毕业院校") + input("major", "专业", { value: "原来的专业" });

test("a field the user changes while the AI works is kept; fields with content from the start are asked about once, after the AI", async (t) => {
  const p = page(t, OCCUPIED);
  const running = p.run();
  assert.ok(await p.until(() => p.value("name") && p.value("phone") && p.worker.calls.length === 1), "empty local fields go first");
  assert.equal(p.value("email"), "old@example.com", "a local field with content waits for the question");
  assert.equal(p.confirms.length, 0, "nothing asked before the AI answers");
  p.w.document.getElementById("school").value = "自己填的学校";
  p.worker.calls[0].reply();
  const result = await running;
  assert.equal(p.confirms.length, 1);
  assert.match(p.confirms[0], /本次将重新填写 2 个已有内容的字段/);
  assert.match(p.confirms[0], /剩下的字段也不再填写，已经先填的不受影响/);
  assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
    ["测试用户", "tester@example.com", "13800138000", "自己填的学校", "示例专业"]);
  assert.equal(result.filledCount, 4);
  assert.equal(result.outcome, "partial");
  assert.equal(p.ui.status.textContent, "已填写 4 个字段。等 AI 时有改动的 1 项没有覆盖：毕业院校，请核对。");
});

test("declining the overwrite after the early fill keeps the early fields and writes nothing else", async (t) => {
  const p = page(t, OCCUPIED, { confirm: () => false });
  const running = p.run();
  assert.ok(await p.until(() => p.value("phone") && p.worker.calls.length === 1), "empty local fields go first");
  p.worker.calls[0].reply();
  const result = await running;
  assert.equal(p.confirms.length, 1);
  assert.deepEqual(["name", "email", "phone", "school", "major"].map(p.value),
    ["测试用户", "old@example.com", "13800138000", "", "原来的专业"]);
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledCount, 2);
  assert.equal(p.ui.status.textContent, "已取消后续填写，已有内容的字段没有改动。此前已填写 2 项，请核对网页。");
  const auto = p.sent.filter((type) => type === "FEEDBACK_AUTO");
  assert.equal(auto.length, 0, "the user's own choice is not reported");
});

test("a choice made in the early fill that reveals a new field: the new field is caught up after the AI's own fields", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const p = page(t, input("name", "姓名") + GENDER + input("school", "毕业院校"), {
    onGender: (doc) => {
      if (doc.getElementById("city")) return;
      const holder = doc.createElement("div");
      // 题目名和资料里的名称不一样：本地对不上，要交给 AI 补填。
      holder.innerHTML = input("city", "意向工作城市");
      doc.getElementById("apply").append(holder.firstChild);
    }
  });
  const running = p.run();
  assert.ok(await p.until(() => p.value("name") && p.value("gender") === "m" && p.worker.calls.length === 1),
    "the select is chosen before the AI answers");
  assert.equal(p.value("school"), "");
  p.worker.calls[0].reply();
  assert.ok(await p.until(() => p.worker.calls.length === 2), "the new field goes to the AI after the first answer");
  assert.deepEqual(p.worker.calls[0].labels, ["毕业院校"]);
  assert.deepEqual(p.worker.calls[1].labels, ["意向工作城市"]);
  assert.equal(p.value("school"), "示例大学", "the AI's own fields are written before the catch-up");
  p.worker.calls[1].reply({ 意向工作城市: "示例市" });
  const result = await running;
  assert.equal(p.value("city"), "示例市");
  assert.equal(result.outcome, "success", p.ui.diag.value);
  assert.equal(result.filledCount, 4);
  assert.equal(result.fieldCount, 4);
  assert.equal(p.ui.status.textContent, "已填写 4 个字段（其中新出现的字段补填 1 项）。");
});

test("after the user cancels the AI wait, a field revealed by an early choice is not sent to the AI again", async (t) => {
  const GENDER = item("gender", "性别", `<select id="gender" name="gender"><option value="">请选择</option><option value="m">男</option><option value="f">女</option></select>`);
  const p = page(t, input("name", "姓名") + GENDER + input("school", "毕业院校"), {
    onGender: (doc) => {
      if (doc.getElementById("city")) return;
      const holder = doc.createElement("div");
      holder.innerHTML = input("city", "意向工作城市");
      doc.getElementById("apply").append(holder.firstChild);
    }
  });
  const running = p.run();
  assert.ok(await p.until(() => p.value("gender") === "m" && p.w.document.getElementById("city") && /AI 匹配中/.test(p.ui.fill.textContent)),
    "the early fill is done and the new field is there");
  await p.ui.cancel.onclick();
  const result = await running;
  assert.equal(p.worker.calls.length, 1, "no catch-up request after the cancel");
  assert.equal(p.value("city"), "");
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledCount, 2);
  assert.equal(result.fieldCount, 4);
  assert.equal(p.ui.status.textContent,
    "本地已填写 2 项；新出现的 1 项没有补填：意向工作城市，请手动补上。已按你的操作取消 AI 等待。取消不保证上游停止计算或停止计费。");
  const report = (await p.report()).diagnosticsReport;
  assert.equal(lineOf(report, "error_code"), "cancelled");
  assert.match(lineOf(report, "drop_reasons"), /not_sent=1/);
});

test("a page with no local match fills exactly as before: one AI request, then everything", async (t) => {
  const p = page(t, input("school", "毕业院校") + input("major", "专业"));
  const running = p.run();
  assert.ok(await p.until(() => p.worker.calls.length === 1));
  assert.match(p.ui.fill.textContent, /^AI 匹配中\.\.\. \d+s$/);
  p.worker.calls[0].reply();
  const result = await running;
  assert.deepEqual(["school", "major"].map(p.value), ["示例大学", "示例专业"]);
  assert.equal(result.outcome, "success");
  assert.doesNotMatch(p.ui.diag.value, /AI 返回前先填/);
});

// 等 AI 的提示（#402）：30 秒就出现，先填过的说已经填了几项；网页里的旧侧栏是隐藏的，提示经状态交给侧栏显示。
test("after 30 seconds the wait hint says how many fields are already filled, and the side panel gets it", async () => {
  const { loadHighlightHelpers } = require("./helpers/content-harness.js");
  let clock = 0;
  let finish;
  const formElements = [];
  const messages = [];
  const ctx = loadHighlightHelpers({ formElements, aiHelpers: require("../ai-helpers.js"), performance: { now: () => clock },
    sendMessage: (message) => {
      messages.push(message);
      if (message.type === "CANCEL_AI_FILL") {
        finish({ success: true, warning: "已按你的操作取消 AI 等待。", matches: [{ fieldId: "field-0", value: "测试用户" }],
          diagnostics: { errorCode: "cancelled", ruleMatches: 1, aiFields: 1 } });
        return Promise.resolve({ cancelled: true });
      }
      return new Promise((resolve) => { finish = resolve; });
    } });
  for (const label of ["姓名", "学校"]) {
    const field = new ctx.HTMLInputElement();
    field.setAttribute("data-label", label);
    formElements.push(field);
  }
  const cancel = { hidden: true }, hint = { hidden: true, textContent: "" }, button = { disabled: false, textContent: "" };
  ctx.helpers.setShadowRoot({ querySelector: (selector) => ({ "#resume-pro-cancel-fill": cancel, "#resume-pro-wait-hint": hint })[selector] || null,
    querySelectorAll: () => [] });
  ctx.helpers.setCurrentStore({ templates: [{ id: "one", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }, { key: "学校", value: "大学乙" }] }] }],
    activeTemplateId: "one" });
  const pending = ctx.helpers.handleAiFillClick({ currentTarget: button });
  for (let i = 0; i < 50 && !/已先填/.test(button.textContent); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(formElements[0].value, "测试用户", "filled before the AI answers");
  assert.equal(button.textContent, "已先填 1 项，AI 匹配中... 0s");
  const timer = ctx.timers.find((item) => item.delay === 1000);
  clock = 29_000;
  timer.callback();
  assert.equal(hint.hidden, true);
  assert.equal((await ctx.sendPanelMessage({ type: "RESUME_PANEL_STATUS" })).waitHint, "");
  clock = 30_000;
  timer.callback();
  assert.equal(button.textContent, "已先填 1 项，AI 匹配中... 30s");
  assert.equal(hint.hidden, false);
  assert.equal(hint.textContent, "已经先填了 1 项，剩下的还在等 AI。可以接着等，也可以点取消，已填的会保留。");
  assert.equal((await ctx.sendPanelMessage({ type: "RESUME_PANEL_STATUS" })).waitHint, hint.textContent);
  await cancel.onclick();
  const result = await within(pending);
  assert.equal(messages.filter((message) => message.type === "CANCEL_AI_FILL").length, 1);
  assert.equal(formElements[1].value, "");
  assert.equal(result.filledCount, 1);
  assert.equal(hint.hidden, true);
  assert.equal((await ctx.sendPanelMessage({ type: "RESUME_PANEL_STATUS" })).waitHint, "", "nothing left over once the fill ends");
});
