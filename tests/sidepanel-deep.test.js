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
    createElement: (tagName) => ({ tagName: tagName.toUpperCase(), textContent: "" })
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
  assert.match(consent, /不会点击网页上的按钮，不会提交、保存或投递/);
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
  ui.state.status = { ...ui.state.status, deepOffer: "none" };
  await ui.poll();
  assert.equal(ui.get("deep-offer").hidden, true, "auth, network or not-configured failures do not invite a deep analysis");
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
