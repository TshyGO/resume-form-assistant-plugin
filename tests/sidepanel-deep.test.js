// #224：原生侧栏里的「深度分析本页」。入口、首次说明、进度、停止和结果只在侧栏里；
// 侧栏自己不读写 storage，确认状态由页面上报，页面传来的状态按固定形状裁剪后才显示。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Compose = require("../sidepanel-compose.js");

const root = path.join(__dirname, "..");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const TEMPLATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function element() {
  const listeners = {};
  const classes = new Set();
  return {
    listeners, classes, dataset: {}, hidden: false, disabled: false, value: "", textContent: "", innerHTML: "", children: [],
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, add(name) { classes.add(name); }, remove(name) { classes.delete(name); } },
    addEventListener(type, listener) { listeners[type] = listener; },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return []; },
    querySelector() { return { textContent: "" }; }
  };
}

async function sidePanel() {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const calls = [];
  const state = { tabId: 9, status: { ready: true, deep: { phase: "idle" }, deepOffer: "secondary", deepConsent: false }, deepReply: null };
  let poll;
  const chrome = {
    runtime: {
      id: "diagjmploldedipjdenmecmjokckelkl",
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        calls.push(message);
        return message.type === "DESKTOP_RESUME_READ" ? { status: "ok", data: {
          templates: [{ id: TEMPLATE, name: "桌面模板", fieldCount: 1 }],
          activeTemplate: { id: TEMPLATE, name: "桌面模板", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }] }] },
          profile: { values: {}, family: [], custom: [] }, profileRevision: 1
        } } : { status: "ok" };
      }
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    tabs: {
      query: async () => [{ id: state.tabId }],
      sendMessage: async (id, message) => {
        calls.push(JSON.parse(JSON.stringify({ tabId: id, ...message })));
        if (message.type === "RESUME_PANEL_STATUS") return state.status;
        if (message.type === "RESUME_PANEL_DEEP") return state.deepReply ? state.deepReply(message) : { ok: true, requestId: "deep-1" };
        if (message.type === "RESUME_PANEL_TARGET") return { ok: true, targetAvailable: false };
        return { ok: true };
      },
      create: async () => {},
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} }
    }
  };
  const documentStub = {
    hidden: false, getElementById: get, querySelectorAll: () => [],
    querySelector: () => ({ click() {}, open: false }), addEventListener() {},
    createElement: (tagName) => {
      const listeners = {};
      return { tagName: tagName.toUpperCase(), textContent: "", listeners, addEventListener(type, listener) { listeners[type] = listener; } };
    }
  };
  const context = vm.createContext({
    document: documentStub, chrome,
    navigator: { clipboard: { writeText: async () => {} } },
    self: { ResumeProProfile: require("../profile-fields.js"), ResumeProResumeData: require("../resume-data.js"), ResumeProCompose: Compose },
    setTimeout: () => 1, clearTimeout() {}, setInterval: (listener) => { poll = listener; }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "sidepanel.js"), "utf8"), context);
  await tick();
  await poll();
  await tick();
  const deepCalls = () => calls.filter((call) => call.type === "RESUME_PANEL_DEEP");
  const click = async (id) => { get(id).listeners.click(); await tick(); await tick(); await tick(); };
  return { get, calls, state, deepCalls, click, poll: async () => { await poll(); await tick(); } };
}

const view = (phase, extra = {}) => ({ phase, requestId: "deep-1", message: "", notes: [], progress: null, result: null, budget: null,
  canStop: ["outlining", "analyzing", "filling"].includes(phase), ...extra });

test("the entry is a quiet button on the 填写 page under 一键 AI 填写, plus an offer that only shows after a poor fill", () => {
  const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
  const fillView = html.slice(html.indexOf('id="fill-view"'), html.indexOf('id="fields-view"'));
  assert.ok(fillView.indexOf('id="deep-button"') > fillView.indexOf('id="repeat-button"'));
  assert.match(fillView, /id="deep-offer"[^>]*hidden/);
  const consent = html.slice(html.indexOf('id="deep-consent"'), html.indexOf('id="deep-card"'));
  assert.match(consent, /不发送输入框里已有的内容/);
  assert.match(consent, /和「一键 AI 填写」一样/);
  assert.match(consent, /你确认后才点；不会提交、保存、删除或投递/);
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  assert.ok(!/resume-pro-deep|深度分析本页<\/button>/.test(content), "the page's old overlay gets no deep-analysis entry");
});

test("first click shows the explanation and sends nothing; agreeing asks the page to remember and start", async () => {
  const ui = await sidePanel();
  assert.equal(ui.get("deep-button").disabled, false);
  await ui.click("deep-button");
  assert.equal(ui.get("deep-consent").hidden, false);
  assert.equal(ui.deepCalls().length, 0, "nothing goes to the page before the user agrees");
  assert.equal(ui.get("task-title").textContent, "深度分析本页");
  await ui.click("deep-consent-cancel");
  assert.equal(ui.get("deep-consent").hidden, true);
  assert.equal(ui.deepCalls().length, 0);
  await ui.click("deep-button");
  await ui.click("deep-consent-confirm");
  assert.deepEqual(ui.deepCalls().map(({ action }) => action), ["consent"]);
});

test("once agreed, the entry starts directly", async () => {
  const ui = await sidePanel();
  ui.state.status = { ...ui.state.status, deepConsent: true };
  await ui.poll();
  await ui.click("deep-button");
  assert.equal(ui.get("deep-consent").hidden, true);
  assert.deepEqual(ui.deepCalls().map(({ action }) => action), ["start"]);
});

test("the prominent offer follows the page's verdict and only shows next to a fill result", async () => {
  const ui = await sidePanel();
  ui.state.status = { ...ui.state.status, status: "已填写 2 个字段。3 项没填上", statusKind: "error", deepOffer: "prominent" };
  await ui.poll();
  assert.equal(ui.get("deep-offer").hidden, false);
  assert.equal(ui.get("deep-button").hidden, true, "only one entry at a time: the quiet one steps back while the offer shows");
  ui.state.status = { ...ui.state.status, deepOffer: "none" };
  await ui.poll();
  assert.equal(ui.get("deep-offer").hidden, true, "auth, network or not-configured failures do not invite a deep analysis");
  assert.equal(ui.get("deep-button").hidden, false, "the quiet entry is back");
  ui.state.status = { ...ui.state.status, deepOffer: "bogus" };
  await ui.poll();
  assert.equal(ui.get("deep-offer").hidden, true);
});

test("progress shows 停止 with the run's requestId; buttons lock while a run goes", async () => {
  const ui = await sidePanel();
  ui.state.status = { ...ui.state.status, busy: true, deep: view("analyzing", { message: "AI 正在分析页面结构…", progress: { part: 2, parts: 3 } }) };
  await ui.poll();
  assert.equal(ui.get("deep-card").hidden, false);
  assert.equal(ui.get("deep-message").textContent, "AI 正在分析页面结构…");
  assert.equal(ui.get("task-desc").textContent, "AI 正在分析页面结构（第 2/3 部分）");
  assert.equal(ui.get("deep-stop").hidden, false);
  assert.equal(ui.get("fill-button").disabled, true);
  assert.equal(ui.get("repeat-button").disabled, true);
  assert.equal(ui.get("deep-button").disabled, true);
  await ui.click("deep-stop");
  assert.deepEqual(ui.deepCalls().map(({ action, requestId }) => [action, requestId]), [["stop", "deep-1"]]);
});

test("finished runs show the result, notes and calls used, and can be dismissed or retried", async () => {
  const ui = await sidePanel();
  ui.state.status = { ...ui.state.status, deep: view("needs_action", { message: "需要先在网页上手动点击「编辑」", notes: ["页面太长"],
    budget: { used: 1, limit: 6 } }) };
  await ui.poll();
  assert.equal(ui.get("deep-stop").hidden, true);
  assert.equal(ui.get("deep-retry").hidden, false);
  assert.equal(ui.get("deep-dismiss").hidden, false);
  assert.equal(ui.get("deep-notes").hidden, false);
  assert.equal(ui.get("deep-meta").textContent, "本次共调用模型 1 次。");
  assert.equal(ui.get("deep-card").dataset.phase, "needs_action");
  await ui.click("deep-dismiss");
  assert.deepEqual(ui.deepCalls().map(({ action }) => action), ["dismiss"]);
});

test("page data is cut to the fixed shape: unknown phases, long texts and stray keys never render", async () => {
  const ui = await sidePanel();
  ui.state.status = { ...ui.state.status, deep: { phase: "hacking", message: "x" } };
  await ui.poll();
  assert.equal(ui.get("deep-card").hidden, true);
  ui.state.status = { ...ui.state.status, deep: { ...view("failed"), message: "长".repeat(1000), notes: ["a", "b", "c", "d", 5],
    requestId: "<img src=x>", canStop: true, html: "<b>x</b>" } };
  await ui.poll();
  assert.equal(ui.get("deep-message").textContent.length, 300);
  assert.equal(ui.get("deep-notes").children.length, 3);
  assert.equal(ui.get("deep-stop").hidden, true, "a finished run cannot be stopped whatever the page says");
});

test("the panel reads and writes no storage for the consent", () => {
  const source = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
  assert.doesNotMatch(source, /deepAnalysisConsent/);
});

// --- #225：预览与确认 -------------------------------------------------------------------------------

const preview = (extra = {}) => view("preview", { message: "确认后会依次点击下面的按钮", planId: "plan-7",
  plan: [{ text: "基本信息：编辑" }, { text: "教育经历：添加 ×1" }], canConfirm: true, canCancel: true, canStop: false, ...extra });

test("#225 the preview lists each step; 确认 carries the run and the plan it showed, 取消 the run", async () => {
  const ui = await sidePanel();
  ui.state.status = { ...ui.state.status, busy: true, deep: preview() };
  await ui.poll();
  assert.equal(ui.get("deep-plan").hidden, false);
  assert.deepEqual(ui.get("deep-plan").children.map((row) => row.textContent), ["基本信息：编辑", "教育经历：添加 ×1"]);
  assert.equal(ui.get("deep-confirm").hidden, false);
  assert.equal(ui.get("deep-confirm").textContent, "确认执行");
  assert.equal(ui.get("deep-cancel").hidden, false);
  assert.equal(ui.get("deep-stop").hidden, true);
  assert.equal(ui.get("task-exit").textContent, "取消");
  assert.equal(ui.get("fill-button").disabled, true, "the page is held while the plan waits");
  assert.match(ui.get("task-steps").innerHTML, /确认操作<\/li>/);
  await ui.click("deep-confirm");
  assert.deepEqual(ui.deepCalls().map(({ action, requestId, planId }) => [action, requestId, planId]), [["confirm", "deep-1", "plan-7"]]);
  await ui.click("deep-cancel");
  assert.deepEqual(ui.deepCalls().at(-1), { tabId: 9, type: "RESUME_PANEL_DEEP", action: "cancel", requestId: "deep-1" });
});

test("#225 hovering a step asks the page to outline it; leaving clears it; polling does not rebuild the list under the pointer", async () => {
  const ui = await sidePanel();
  ui.state.status = { ...ui.state.status, busy: true, deep: preview() };
  await ui.poll();
  const rows = ui.get("deep-plan").children;
  rows[1].listeners.mouseenter();
  rows[1].listeners.mouseleave();
  rows[0].listeners.focus();
  await tick();
  assert.deepEqual(ui.deepCalls().map(({ action, planId, index }) => [action, planId, index]),
    [["highlight", "plan-7", 1], ["highlight", "plan-7", -1], ["highlight", "plan-7", 0]]);
  await ui.poll();
  assert.equal(ui.get("deep-plan").children, rows, "the same rows stay while the same plan shows");
  ui.state.status = { ...ui.state.status, deep: preview({ planId: "plan-8" }) };
  await ui.poll();
  assert.notEqual(ui.get("deep-plan").children, rows, "a new plan gets new rows");
});

test("#225 only blocked adds: the button says 继续填写 and the notes explain why", async () => {
  const ui = await sidePanel();
  ui.state.status = { ...ui.state.status, busy: true, deep: preview({ plan: [], notes: ["教育经历需要新增 7 条，超过每次 5 条的上限"] }) };
  await ui.poll();
  assert.equal(ui.get("deep-plan").hidden, true);
  assert.equal(ui.get("deep-confirm").textContent, "继续填写");
  assert.equal(ui.get("deep-notes").hidden, false);
});

test("#225 acting shows the step and 停止; re-analysis says the actions are done", async () => {
  const ui = await sidePanel();
  ui.state.status = { ...ui.state.status, busy: true, deep: view("acting", { message: "正在执行 1/2：基本信息：编辑…", progress: { step: 1, steps: 2 }, canStop: true }) };
  await ui.poll();
  assert.equal(ui.get("task-desc").textContent, "正在执行第 1/2 步，每一步都核对网页变化");
  assert.equal(ui.get("deep-stop").hidden, false);
  assert.equal(ui.get("deep-confirm").hidden, true);
  ui.state.status = { ...ui.state.status, deep: view("analyzing", { progress: { part: 1, parts: 1, round: 2 } }) };
  await ui.poll();
  assert.equal(ui.get("task-desc").textContent, "操作已完成，AI 正在重新分析页面");
});

test("#225 a malformed plan never renders and cannot be confirmed", async () => {
  const ui = await sidePanel();
  ui.state.status = { ...ui.state.status, busy: true, deep: preview({ planId: "<b>", plan: [{ text: "x" }] }) };
  await ui.poll();
  assert.equal(ui.get("deep-confirm").hidden, true, "no valid plan id, no 确认");
  assert.equal(ui.get("deep-plan").hidden, true);
  ui.state.status = { ...ui.state.status, deep: preview({ plan: Array.from({ length: 12 }, () => ({ text: "编辑" })) }) };
  await ui.poll();
  assert.equal(ui.get("deep-plan").hidden, true, "more steps than a plan can hold");
  ui.state.status = { ...ui.state.status, deep: view("filling", { planId: "plan-7", plan: [{ text: "编辑" }], canConfirm: true }) };
  await ui.poll();
  assert.equal(ui.get("deep-confirm").hidden, true, "only a preview can be confirmed");
});
