// #226：content.js 里的本站配方接线。真实的 page-recipe.js（定位、保存条件、存储）+ deep-analysis.js（编排）
// + 真实的一键填写主流程；网页用 content-harness 的假 DOM，大纲用替身（真实大纲上的定位见 page-recipe.test.js），
// 后台写入用同一份 createStore 模拟（只认发送方网页自己的那一条）。验证：命中不做页面分析、匹配仍用日常模型、
// 过期退回扫描并提示、补漏去重、深度分析效果更好才保存、迟到结果不保存、存储失败如实说明、动作再次确认、删除。
const test = require("node:test");
const assert = require("node:assert/strict");

const deep = require("../deep-analysis.js");
const outlineApi = require("../page-outline.js");
const recipes = require("../page-recipe.js");
const { loadHighlightHelpers, fakeFieldScan } = require("./helpers/content-harness.js");

// 假扫描：查看状态下还没出现的输入框（isConnected 为 false）不算。
function scanVisibleOnly() {
  const base = fakeFieldScan();
  return { ...base, scanPage(doc, options) {
    const result = base.scanPage(doc, options);
    return { ...result, controls: result.controls.filter((control) => control.element.isConnected !== false) };
  } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
// 内容脚本跑在 vm 里，它造的数组和这里的不是同一个 realm：比较前先转成普通 JSON。
const plain = (value) => JSON.parse(JSON.stringify(value));
const TEMPLATE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const URL = "https://jobs.example.test/apply/2024001?from=mail";
const store = () => ({
  templates: [{ id: TEMPLATE, name: "模板", groups: [{ name: "基本信息", fields: [
    { key: "姓名", value: "测试用户" }, { key: "现居城市", value: "杭州" }, { key: "邮箱", value: "user@example.test" }] }] }],
  activeTemplateId: TEMPLATE
});

// 假大纲：看得见的输入框按顺序编号（题目来自 data-label），按钮接在后面；分组都是「基本信息」。
function fakeOutline(inputs, buttons, calls) {
  return {
    build(_doc, options) {
      calls.push(options);
      const nodes = new Map();
      const titles = new Map();
      inputs.filter((input) => input.isConnected).forEach((input) => {
        const ref = `e${nodes.size + 1}`;
        nodes.set(ref, { type: "control", domKind: "text", element: input, root: input,
          control: { elements: [input], root: input, disabled: false, label: input.getAttribute("data-label") || "" } });
        titles.set(ref, "基本信息");
      });
      buttons.filter((button) => button.element.isConnected !== false).forEach((button) => {
        const ref = `e${nodes.size + 1}`;
        nodes.set(ref, { type: "button", submit: false, leaves: false, crossSite: false, ...button });
        titles.set(ref, "基本信息");
      });
      return { parts: [{ text: [...nodes.keys()].join("\n"), refs: [...nodes.keys()] }], nodes, titles, clues: new Map(),
        redact: outlineApi.createRedactor(options.resumeValues), stats: { chars: 40, parts: 1, controls: inputs.length, truncated: false } };
    }
  };
}

function recipePage({ labels = ["姓名", "现居城市"], analyze, fill, buttons = [], pageActions, failStorage = false, confirm = () => true, fillProbe } = {}) {
  const location = { href: URL, pathname: "/apply/2024001" };
  const inputs = [];
  const sent = [];
  const outlineCalls = [];
  const storageData = { deepAnalysisConsent: { version: 1 } };
  const area = {
    get: async (keys) => Object.fromEntries(keys.filter((key) => key in storageData).map((key) => [key, JSON.parse(JSON.stringify(storageData[key]))])),
    set: async (values) => {
      if (failStorage) throw new Error("QUOTA_BYTES quota exceeded");
      Object.assign(storageData, JSON.parse(JSON.stringify(values)));
    }
  };
  const background = recipes.createStore(area);
  const diagnostics = { hidden: true, open: false };
  const diagnosticsText = { value: "" };
  diagnostics.querySelector = () => diagnosticsText;
  const harness = loadHighlightHelpers({
    formElements: inputs,
    location,
    storageData,
    confirm: () => confirm(),
    randomUUID: (() => { let n = 0; return () => `req-${++n}`; })(),
    deepAnalysis: deep,
    pageRecipe: recipes,
    fillProbe,
    fieldScan: scanVisibleOnly(),
    pageActions,
    formAgent: require("../form-agent.js"),
    pageOutline: { ...outlineApi, ...fakeOutline(inputs, buttons, outlineCalls) },
    sendMessage: async (message) => {
      sent.push(message);
      // 后台：只认发送方网页自己的那一条（这里发送方就是 location.href）。
      if (message.type?.startsWith("RECIPE_")) {
        const key = recipes.pageKey(location.href);
        if (!key.ok || key.host !== message.host || key.path !== message.path) return { ok: false, error: "forbidden" };
        if (message.type === "RECIPE_SAVE") {
          const replaced = Boolean(recipes.findRecipe((await background.read()).store, key));
          const result = await background.save(key.host, key.path, message.recipe);
          return { ok: result.ok, error: result.error, replaced };
        }
        const result = message.type === "RECIPE_DELETE" ? await background.remove(key.host, key.path) : await background.touch(key.host, key.path);
        return { ok: result.ok };
      }
      if (message.type === "AI_ANALYZE_PAGE") return analyze ? analyze(message, inputs) : {
        success: true, tierUsed: "strong",
        spec: { pageState: "editing", fields: inputs.filter((input) => input.isConnected).map((input, index) => ({
          ref: `e${index + 1}`, label: input.getAttribute("data-label") || `题目${index + 1}`, group: "基本信息", control: "text" })) }
      };
      if (message.type === "AI_FILL") return fill ? fill(message, inputs) : {
        success: true, matches: message.formFields.map((field) => ({ fieldId: field.fieldId, value: `AI-${field.label}` })),
        diagnostics: { ruleMatches: 0, aiMatches: message.formFields.length, calls: 1, errorCode: "none",
          ...(message.tier ? { tierRequested: message.tier, tierUsed: message.tier } : {}) }
      };
      if (message.type === "CANCEL_AI_FILL") return { cancelled: true };
      return { status: "ok" };
    }
  });
  const { helpers, HTMLInputElement, timers } = harness;
  const addInput = (label) => {
    const input = new HTMLInputElement();
    input.getClientRects = () => [1];
    if (label) input.setAttribute("data-label", label);
    inputs.push(input);
    return input;
  };
  labels.forEach(addInput);
  const fillButton = { disabled: false, textContent: "一键 AI 填写", click() { helpers.handleAiFillClick({ currentTarget: fillButton }); } };
  const statusLine = { textContent: "", className: "", classList: { contains(name) { return statusLine.className.split(/\s+/).includes(name); } } };
  helpers.setShadowRoot({ querySelector: (selector) => ({ "#resume-pro-ai-fill": fillButton, "#resume-pro-status": statusLine,
    "#resume-pro-diagnostics": diagnostics, "#resume-pro-diagnostics-text": diagnosticsText })[selector] || null });
  helpers.setCurrentStore(store());
  const status = () => harness.sendPanelMessage({ type: "RESUME_PANEL_STATUS" });
  const ask = (message) => harness.sendPanelMessage({ type: "RESUME_PANEL_DEEP", ...message });
  const run = async (done) => {
    for (let i = 0; i < 400; i++) {
      await tick();
      for (const timer of timers) {
        if (!timer.cleared && timer.delay < 1000) { timer.cleared = true; timer.callback(); }
      }
      if (await done()) return;
    }
    throw new Error(`did not settle: ${JSON.stringify((await status()).deep)}`);
  };
  const finished = async () => !deep.ACTIVE.includes((await status()).deep.phase);
  const idle = async () => !(await status()).busy;
  return { ...harness, helpers, location, inputs, sent, storageData, outlineCalls, diagnosticsText, addInput, status, ask, run, finished, idle,
    fillButton, aiCalls: (type) => sent.filter((message) => message.type === type) };
}

// 用当前的假大纲直接生成一份配方存进 storage（相当于以前在这个页面深度分析后保存的）。
function seedRecipe(page, extra = {}) {
  const built = page.helpers && fakeOutline(page.inputs, extra.buttons || [], []).build(null, { resumeValues: [] });
  const fields = [...built.nodes].filter(([, node]) => node.type === "control")
    .map(([ref, node]) => ({ ref, label: node.control.label, group: "基本信息", groupIndex: null, control: "text", hints: {} }));
  const result = recipes.buildRecipe({ fields, outline: built, tier: "strong", now: 1000,
    actions: extra.actions ? recipes.actionLocators(extra.actions(built).items, built) : null, sections: extra.sections?.(built) || [] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const key = recipes.pageKey(page.location.href);
  page.storageData[recipes.STORAGE_KEY] = { v: 1, sites: { [key.host]: { [key.path]: result.recipe } } };
  return result.recipe;
}

async function plainFill(page) {
  const started = await page.sendPanelMessage({ type: "RESUME_PANEL_FILL" });
  assert.equal(started.ok, true, JSON.stringify(started));
  await page.run(page.idle);
  return page.status();
}

test("a saved recipe is used by the one-click fill: fields come from the recipe, no page analysis, the daily model matches", async () => {
  const page = recipePage();
  seedRecipe(page);
  const status = await plainFill(page);
  assert.equal(page.aiCalls("AI_ANALYZE_PAGE").length, 0, "no strong page analysis on a recipe hit");
  const [fill] = page.aiCalls("AI_FILL");
  assert.equal(fill.tier, undefined, "matching follows the daily model setting");
  assert.equal(fill.maxCalls, undefined);
  assert.deepEqual(plain(fill.formFields.map((field) => [field.fieldId, field.label])), [["deep-e1", "姓名"], ["deep-e2", "现居城市"]]);
  assert.deepEqual(page.inputs.map((input) => input.value), ["AI-姓名", "AI-现居城市"]);
  assert.match(status.status, /已按本站配方定位字段/);
  assert.match(page.diagnosticsText.value, /本站配方：命中（定位 2\/2，规则扫描补充 0；结构一致）；没有做页面分析；匹配简历调用模型 1 次/);
  assert.deepEqual(status.recipe, { saved: true, stale: false });
  // 命中会更新最近使用（交给后台排队写入）。
  assert.equal(page.sent.filter((message) => message.type === "RECIPE_TOUCH").length, 1);
});

test("the rule scan fills what the recipe lacks, and a control both found is filled only once", async () => {
  const page = recipePage({ labels: ["姓名"] });
  seedRecipe(page);
  page.addInput("邮箱");
  await plainFill(page);
  const [fill] = page.aiCalls("AI_FILL");
  assert.deepEqual(plain(fill.formFields.map((field) => [field.fieldId, field.label])), [["deep-e1", "姓名"], ["field-1", "邮箱"]],
    "the scan's copy of 姓名 (field-0) is dropped; 邮箱 comes from the scan");
  assert.deepEqual(page.inputs.map((input) => input.value), ["AI-姓名", "AI-邮箱"]);
  assert.match(page.diagnosticsText.value, /规则扫描补充 1/);
});

test("a changed page makes the recipe stale: the fill falls back to the scan, says so, and suggests re-analysis — no strong request", async () => {
  const page = recipePage({ labels: ["姓名", "现居城市"] });
  seedRecipe(page);
  page.inputs.forEach((input, index) => input.setAttribute("data-label", ["期望薪资", "到岗时间"][index]));
  const status = await plainFill(page);
  assert.equal(page.aiCalls("AI_ANALYZE_PAGE").length, 0, "never silently upgraded to a page analysis");
  const [fill] = page.aiCalls("AI_FILL");
  assert.equal(fill.tier, undefined);
  assert.deepEqual(plain(fill.formFields.map((field) => field.fieldId)), ["field-0", "field-1"]);
  assert.match(status.status, /本站配方可能已过期，可以重新深度分析/);
  assert.match(page.diagnosticsText.value, /本站配方：过期（定位 0\/2，找不到 2，有歧义 0），已退回普通扫描/);
  assert.equal(status.deepOffer, "prominent");
  assert.deepEqual(status.recipe, { saved: true, stale: true });
});

test("no recipe: the one-click fill is unchanged apart from a diagnostics line", async () => {
  const page = recipePage();
  const status = await plainFill(page);
  assert.deepEqual(plain(page.aiCalls("AI_FILL")[0].formFields.map((field) => field.fieldId)), ["field-0", "field-1"]);
  assert.match(page.diagnosticsText.value, /本站配方：未使用/);
  assert.equal(status.recipe?.saved || false, false);
});

test("deep analysis that fills more than the plain fill on this page saves a recipe; the next one-click fill uses it", async () => {
  const page = recipePage({ fill: (message) => ({
    success: true,
    // 普通填写只匹配上一题；深度分析两题都填上。
    matches: (message.tier ? message.formFields : message.formFields.slice(0, 1)).map((field) => ({ fieldId: field.fieldId, value: `AI-${field.label}` })),
    diagnostics: { ruleMatches: 0, aiMatches: 1, calls: 1, errorCode: "none" }
  }) });
  await plainFill(page);
  assert.deepEqual(page.inputs.map((input) => input.value), ["AI-姓名", ""]);
  page.inputs[0].value = "";
  assert.equal((await page.ask({ action: "start" })).ok, true);
  await page.run(page.finished);
  const done = (await page.status()).deep;
  assert.equal(done.phase, "completed", done.message);
  assert.ok(done.notes.some((note) => /已保存为本站配方/.test(note)), JSON.stringify(done.notes));
  const saved = page.storageData[recipes.STORAGE_KEY];
  assert.deepEqual(Object.keys(saved.sites), ["jobs.example.test"]);
  assert.deepEqual(Object.keys(saved.sites["jobs.example.test"]), ["/apply/*"]);
  const text = JSON.stringify(saved);
  for (const secret of ["AI-姓名", "测试用户", "杭州", "from=mail", "2024001"]) assert.ok(!text.includes(secret), secret);
  assert.match(page.diagnosticsText.value, /本站配方：新保存（2 个字段）/);
  assert.deepEqual((await page.status()).recipe, { saved: true, stale: false });
  // 再来一次一键填写：命中配方，不分析。
  page.inputs.forEach((input) => { input.value = ""; });
  const analyses = page.aiCalls("AI_ANALYZE_PAGE").length;
  await page.sendPanelMessage({ type: "RESUME_PANEL_DEEP", action: "dismiss" });
  await plainFill(page);
  assert.equal(page.aiCalls("AI_ANALYZE_PAGE").length, analyses);
  const last = page.aiCalls("AI_FILL").at(-1);
  assert.equal(last.tier, undefined);
  assert.deepEqual(plain(last.formFields.map((field) => field.fieldId)), ["deep-e1", "deep-e2"]);
  assert.match(page.diagnosticsText.value, /本站配方：命中/);
});

test("no improvement, no comparable plain fill, or a storage failure: nothing is saved, the user is told why, and the fill stands", async () => {
  const same = recipePage();
  await plainFill(same);
  same.inputs.forEach((input) => { input.value = ""; });
  await same.ask({ action: "start" });
  await same.run(same.finished);
  assert.ok((await same.status()).deep.notes.some((note) => /没有比普通填写多/.test(note)));
  assert.equal(same.storageData[recipes.STORAGE_KEY], undefined);
  assert.match(same.diagnosticsText.value, /本站配方：未保存（没有比普通填写更好）/);

  const fresh = recipePage();
  await fresh.ask({ action: "start" });
  await fresh.run(fresh.finished);
  assert.ok((await fresh.status()).deep.notes.some((note) => /没有可以对比的普通填写结果/.test(note)));
  assert.equal(fresh.storageData[recipes.STORAGE_KEY], undefined);

  const broken = recipePage({ failStorage: true, fill: (message) => ({ success: true,
    matches: (message.tier ? message.formFields : []).map((field) => ({ fieldId: field.fieldId, value: "x" })),
    diagnostics: { calls: 1, errorCode: message.tier ? "none" : "none" } }) });
  await plainFill(broken);
  await broken.ask({ action: "start" });
  await broken.run(broken.finished);
  const state = (await broken.status()).deep;
  assert.equal(state.phase, "completed");
  assert.ok(state.notes.some((note) => /没能保存/.test(note)));
  assert.ok(!state.notes.some((note) => /已保存/.test(note)));
  assert.match(broken.diagnosticsText.value, /本站配方：保存失败/);
  assert.deepEqual(broken.inputs.map((input) => input.value), ["x", "x"], "the fill itself is kept");
});

test("a page with zero scanned fields compares against 0, and an analysis that fills nothing never saves an empty recipe", async () => {
  const empty = recipePage({ labels: ["", ""], fill: () => ({ success: true, matches: [], diagnostics: { calls: 1, errorCode: "none" } }) });
  // 假扫描只认有题目的框：一个字段都扫不到。
  await empty.ask({ action: "start" });
  await empty.run(empty.finished);
  assert.equal(empty.storageData[recipes.STORAGE_KEY], undefined);
  assert.ok((await empty.status()).deep.notes.every((note) => !/已保存/.test(note)));
});

test("a result that lands after the user stopped or the page navigated is not saved", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const page = recipePage({ fill: async (message) => {
    if (message.tier) await gate;
    return { success: true, matches: message.tier ? message.formFields.map((field) => ({ fieldId: field.fieldId, value: "v" })) : [],
      diagnostics: { calls: 1, errorCode: "none" } };
  } });
  await plainFill(page);
  await page.ask({ action: "start" });
  await page.run(async () => page.aiCalls("AI_FILL").length === 2);
  page.location.href = "https://jobs.example.test/apply/2024002";
  release();
  await page.run(page.finished);
  assert.equal(page.storageData[recipes.STORAGE_KEY], undefined);
  assert.equal(page.sent.filter((message) => message.type === "RECIPE_SAVE").length, 0);
});

// ---- 配方里的前置动作 -------------------------------------------------------

function actionRecipePage() {
  const calls = { built: [], executed: [] };
  const editButton = { isConnected: true, tag: "edit", getAttribute: () => null, closest: () => null };
  let page;
  const pageActions = {
    buildPlan(args) {
      calls.built.push(args);
      const ref = args.spec.preActions[0]?.ref;
      return ref ? { items: [{ kind: "edit", ref, element: args.nodes.get(ref).element, label: "基本信息：编辑" }], manual: [], blocked: [], adds: null }
        : { items: [], manual: [], blocked: [], adds: null };
    },
    async executePlan(plan, ctx) {
      calls.executed.push({ plan, ctx });
      // 点「编辑」后输入框出现。
      page.inputs.forEach((input) => { input.isConnected = true; });
      return { ok: true, done: { edit: 1, expand: 0, add: 0 }, scopes: [] };
    },
    createHighlighter: () => ({ show() {}, clear() {} })
  };
  page = recipePage({ buttons: [{ text: "编辑", element: editButton }], pageActions });
  seedRecipe(page, { buttons: [{ text: "编辑", element: editButton }],
    actions: (built) => ({ items: [{ kind: "edit", ref: [...built.nodes].find(([, node]) => node.type === "button")[0] }], outline: built }) });
  // 查看状态：输入框还没出现。
  page.inputs.forEach((input) => { input.isConnected = false; });
  return { ...page, calls, editButton };
}

test("a recipe with 编辑 asks again every time: preview in the side panel, nothing clicked before 确认, then fields are located after the click", async () => {
  const page = actionRecipePage();
  assert.equal((await page.sendPanelMessage({ type: "RESUME_PANEL_FILL" })).ok, true);
  await page.run(async () => (await page.status()).deep.phase === "preview");
  const preview = (await page.status()).deep;
  assert.equal(preview.mode, "recipe");
  assert.deepEqual(preview.plan, [{ text: "基本信息：编辑" }]);
  assert.equal(page.calls.executed.length, 0, "nothing is clicked before the user confirms");
  assert.equal(page.aiCalls("AI_ANALYZE_PAGE").length, 0);
  assert.equal(page.aiCalls("AI_FILL").length, 0);
  assert.equal((await page.ask({ action: "confirm", requestId: preview.requestId, planId: preview.planId })).ok, true);
  await page.run(page.finished);
  const done = (await page.status()).deep;
  assert.equal(done.phase, "completed", done.message);
  assert.match(done.message, /按本站配方填写/);
  assert.equal(page.calls.executed.length, 1);
  assert.equal(page.aiCalls("AI_ANALYZE_PAGE").length, 0, "no page analysis in recipe mode");
  const [fill] = page.aiCalls("AI_FILL");
  assert.equal(fill.tier, undefined);
  assert.deepEqual(plain(fill.formFields.map((field) => field.label)), ["姓名", "现居城市"]);
  assert.match(page.diagnosticsText.value, /按本站配方填写：没有做页面分析；模型调用 1 次（只用于匹配简历）/);
  assert.match(page.diagnosticsText.value, /前置动作：计划 编辑 1、展开 0、新增 0；已完成 编辑 1/);
  // 第二次：同样要重新确认，不因为上次确认过就直接点。
  page.inputs.forEach((input) => { input.isConnected = false; input.value = ""; });
  await page.ask({ action: "dismiss" });
  await page.sendPanelMessage({ type: "RESUME_PANEL_FILL" });
  await page.run(async () => (await page.status()).deep.phase === "preview");
  assert.equal(page.calls.executed.length, 1);
  const again = (await page.status()).deep;
  assert.equal((await page.ask({ action: "cancel", requestId: again.requestId })).ok, true);
  assert.equal(page.calls.executed.length, 1, "cancel clicks nothing");
});

test("when the page is already in edit mode the recipe's 编辑 is not clicked; the fields are used directly", async () => {
  const page = actionRecipePage();
  page.inputs.forEach((input) => { input.isConnected = true; });
  await plainFill(page);
  assert.equal(page.calls.executed.length, 0);
  assert.equal((await page.status()).deep.phase, "idle");
  assert.deepEqual(plain(page.aiCalls("AI_FILL")[0].formFields.map((field) => field.fieldId)), ["deep-e1", "deep-e2"]);
});

test("a recipe whose button is gone does not preview anything; the one-click fill scans the page and reports the recipe stale", async () => {
  const page = actionRecipePage();
  page.editButton.isConnected = false;
  page.inputs.forEach((input) => { input.isConnected = true; input.setAttribute("data-label", "别的题目"); });
  const status = await plainFill(page);
  assert.equal(page.calls.executed.length, 0);
  assert.equal(page.aiCalls("AI_ANALYZE_PAGE").length, 0);
  assert.match(status.status, /本站配方可能已过期/);
});

test("delete removes only this page's recipe and the panel stops showing it; other sites are untouched", async () => {
  const page = recipePage();
  seedRecipe(page);
  page.storageData[recipes.STORAGE_KEY].sites["other.example.test"] = page.storageData[recipes.STORAGE_KEY].sites["jobs.example.test"];
  await page.status();
  await tick();
  assert.deepEqual((await page.status()).recipe, { saved: true, stale: false });
  const result = await page.sendPanelMessage({ type: "RESUME_PANEL_RECIPE", action: "delete" });
  assert.equal(result.ok, true);
  assert.equal(result.recipe.saved, false);
  assert.deepEqual(Object.keys(page.storageData[recipes.STORAGE_KEY].sites), ["other.example.test"]);
  assert.deepEqual(page.sent.filter((message) => message.type === "RECIPE_DELETE").map(({ host, path }) => [host, path]),
    [["jobs.example.test", "/apply/*"]]);
});

test("deep analysis with a confirmed 编辑 saves the button with the recipe; the next one-click fill previews it again instead of analysing", async () => {
  const editButton = { isConnected: true, tag: "edit", getAttribute: () => null, closest: () => null };
  let page;
  let round = 0;
  const pageActions = {
    buildPlan(args) {
      const ref = args.spec.preActions[0]?.ref;
      return ref ? { items: [{ kind: "edit", ref, element: args.nodes.get(ref).element, label: "基本信息：编辑" }], manual: [], blocked: [], adds: null }
        : { items: [], manual: [], blocked: [], adds: null };
    },
    async executePlan() {
      // 点「编辑」后输入框出现，按钮换成了别的（很多网站点完编辑就没有这个按钮了）。
      page.inputs.forEach((input) => { input.isConnected = true; });
      editButton.isConnected = false;
      return { ok: true, done: { edit: 1, expand: 0, add: 0 }, scopes: [] };
    },
    createHighlighter: () => ({ show() {}, clear() {} })
  };
  page = recipePage({ buttons: [{ text: "编辑", element: editButton }], pageActions, analyze: (message, inputs) => (++round === 1
    ? { success: true, tierUsed: "strong", spec: { pageState: "viewing", preActions: [{ ref: "e1", kind: "edit" }], fields: [] } }
    : { success: true, tierUsed: "strong", spec: { pageState: "editing", fields: inputs.map((input, index) => ({
      ref: `e${index + 1}`, label: input.getAttribute("data-label"), group: "基本信息", control: "text" })) } }) });
  page.inputs.forEach((input) => { input.isConnected = false; });
  // 查看状态下普通填写一个字段都扫不到：基线是 0。
  await plainFill(page);
  assert.equal(page.aiCalls("AI_FILL").length, 0);
  const { requestId } = await page.ask({ action: "start" });
  await page.run(async () => (await page.status()).deep.phase === "preview");
  const preview = (await page.status()).deep;
  assert.equal((await page.ask({ action: "confirm", requestId, planId: preview.planId })).ok, true);
  await page.run(page.finished);
  const done = (await page.status()).deep;
  assert.equal(done.phase, "completed", done.message);
  assert.ok(done.notes.some((note) => /已保存为本站配方/.test(note)), JSON.stringify(done.notes));
  const saved = page.storageData[recipes.STORAGE_KEY].sites["jobs.example.test"]["/apply/*"];
  assert.deepEqual(plain(saved.actions), [{ kind: "edit", btn: { s: "", sec: "基本信息", t: "编辑", n: 1 } }]);
  assert.equal(saved.fields.length, 2);
  // 刷新后又是查看状态：一键填写转到配方模式，先预览「编辑」，不做页面分析。
  const analyses = page.aiCalls("AI_ANALYZE_PAGE").length;
  page.inputs.forEach((input) => { input.isConnected = false; input.value = ""; });
  editButton.isConnected = true;
  await page.ask({ action: "dismiss" });
  await page.sendPanelMessage({ type: "RESUME_PANEL_FILL" });
  await page.run(async () => (await page.status()).deep.phase === "preview");
  const again = (await page.status()).deep;
  assert.equal(again.mode, "recipe");
  assert.equal(page.aiCalls("AI_ANALYZE_PAGE").length, analyses);
});

test("after a full recipe hit the deep-analysis offer is not pushed just because the page has shadow DOM inputs; without the recipe it is", async () => {
  // 探测说网页上有含输入框的 Shadow DOM（规则扫描看不到）。
  const fillProbe = { probePage: () => ({ shadowHosts: 1, custom: { total: 0 }, frames: { crossOrigin: 0, frameInputs: 0 }, editButtons: 0 }),
    pageType: () => ({ type: "application_form", reason: "url" }), emptyPageHint: () => "", describeControl: () => null, formatReport: () => [] };
  const plainPage = recipePage({ fillProbe });
  await plainFill(plainPage);
  assert.equal((await plainPage.status()).deepOffer, "prominent");
  const page = recipePage({ fillProbe });
  seedRecipe(page);
  await plainFill(page);
  assert.equal((await page.status()).deepOffer, "secondary", "the recipe already covered what the scan cannot see");
});

test("PR #284: a recipe with only 添加 still previews the add when the rows on the page match last time but the template has one more", async () => {
  const addButton = { isConnected: true, tag: "add", getAttribute: () => null, closest: () => null };
  const built = [];
  const pageActions = {
    buildPlan(args) {
      built.push(args);
      return args.spec.sections.length
        ? { items: [{ kind: "add", domain: "education", count: 1, element: addButton, label: "教育经历：添加 ×1" }], manual: [], blocked: [], adds: {} }
        : { items: [], manual: [], blocked: [], adds: null };
    },
    async executePlan() { return { ok: true, done: { edit: 0, expand: 0, add: 1 }, scopes: [] }; },
    createHighlighter: () => ({ show() {}, clear() {} })
  };
  const page = recipePage({ labels: ["学校名称", "专业"], buttons: [{ text: "添加", element: addButton }], pageActions });
  const recipe = seedRecipe(page, { buttons: [{ text: "添加", element: addButton }],
    sections: (outline) => [{ domain: "education", addRef: [...outline.nodes].find(([, node]) => node.type === "button")[0], rowRefs: ["e1"] }] });
  assert.equal(recipe.sections.length, 1);
  // 网页上的条目和保存时一样（字段全都找得到），但模板多一条：按当前模板算出要新增，进入配方模式预览。
  assert.equal((await page.sendPanelMessage({ type: "RESUME_PANEL_FILL" })).ok, true);
  await page.run(async () => (await page.status()).deep.phase === "preview");
  const preview = (await page.status()).deep;
  assert.equal(preview.mode, "recipe");
  assert.deepEqual(plain(preview.plan), [{ text: "教育经历：添加 ×1" }]);
  assert.equal(page.aiCalls("AI_FILL").length, 0, "nothing filled before the user confirms");
});
