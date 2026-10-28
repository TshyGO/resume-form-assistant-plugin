// #301：普通一键填写在网申页上扫到 0 个字段、页面又没有任何线索时，等表单出来再扫一次。
// content-harness 的定时器只记录不触发，MutationObserver 用替身：测试自己决定网页什么时候变、定时器什么时候到。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadHighlightHelpers, fakeFieldScan } = require("./helpers/content-harness.js");
const realProbe = require("../fill-probe.js");
const deep = require("../deep-analysis.js");

const STORE = { templates: [{ id: "one", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }] }] }], activeTemplateId: "one" };
const NO_CLUES = { host: "jobs.example.test", frames: { total: 0, crossOrigin: 0, frameInputs: 0 },
  custom: { total: 0, byLibrary: {} }, editButtons: 0, locked: 0, shadowHosts: 0, elements: 12 };
const APPLY = { href: "https://jobs.example.test/apply", pathname: "/apply" };
const LOADING_EMPTY = "没找到可填写的输入框。请等网页加载完，或先点开要填写的部分，再试一次。";
// 新加到网页上的节点：一个输入框，和一段不含输入控件的文字。
const CONTROL = { nodeType: 1, matches: () => true, closest: () => null };
const TEXT = { nodeType: 1, matches: () => false, querySelector: () => null, closest: () => null };
const tick = () => new Promise(resolve => setImmediate(resolve));
// 本该立即结束的填写如果去等了，假定时器永远不会到点：限时，失败而不是卡住。
const within = (promise, ms = 2000) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("the fill is still waiting")), ms).unref())]);

function zeroFieldPage({ probe = NO_CLUES, location = { ...APPLY }, observer = true, sendMessage, ...extra } = {}) {
  const formElements = [];
  const observers = [];
  class FakeObserver {
    constructor(callback) {
      this.callback = callback;
      this.options = null;
      this.disconnected = false;
      observers.push(this);
    }
    observe(root, options) { this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  const scan = fakeFieldScan();
  let scans = 0;
  const sent = [];
  let confirms = 0;
  const env = loadHighlightHelpers({
    formElements, location,
    fieldScan: { ...scan, scanPage: (doc, options) => { scans += 1; return scan.scanPage(doc, options); } },
    fillProbe: { ...realProbe, probePage: () => probe },
    MutationObserver: observer ? FakeObserver : undefined,
    confirm: () => { confirms += 1; return true; },
    sendMessage: sendMessage || (async message => {
      sent.push(message);
      return { success: true, matches: [{ fieldId: "field-0", value: "测试用户" }], diagnostics: { errorCode: "none" } };
    }),
    ...extra
  });
  env.document.documentElement.nodeType = 1;
  env.helpers.setCurrentStore(STORE);
  const button = { disabled: false };
  const timer = delay => env.timers.filter(entry => entry.delay === delay && !entry.cleared);
  return {
    ...env, formElements, observers, button, location, timer,
    scans: () => scans, sent, confirms: () => confirms,
    aiCalls: () => sent.filter(message => message.type === "AI_FILL").length,
    click: (assisted = null, deepFill = null) => env.helpers.handleAiFillClick({ currentTarget: button }, assisted, deepFill),
    async observing() {
      for (let i = 0; i < 50 && !observers.length; i += 1) await tick();
      return observers[0];
    }
  };
}

test("a form that renders after the click is found in the same click, with one AI request and the overwrite check", async () => {
  const page = zeroFieldPage();
  const pending = page.click();
  const observer = await page.observing();
  assert.ok(observer, "waits for the page");
  assert.equal(page.button.textContent, "正在等待网页加载...");
  assert.deepEqual({ ...observer.options }, { childList: true, subtree: true });
  // 先只有文字变化：还不算表单出来了。
  observer.callback([{ addedNodes: [TEXT] }]);
  assert.equal(page.timer(300).length, 0);
  // 表单出来了，里面已经有值：照样先问要不要覆盖。
  const input = new page.HTMLInputElement();
  input.value = "原来的值";
  page.formElements.push(input);
  observer.callback([{ addedNodes: [CONTROL] }]);
  // 还在增删节点：重新等 300ms。
  observer.callback([{ addedNodes: [TEXT] }]);
  assert.equal(page.timer(300).length, 1);
  page.timer(300)[0].callback();
  const result = await within(pending);
  assert.equal(result.filledCount, 1);
  assert.equal(input.value, "测试用户");
  assert.equal(page.aiCalls(), 1);
  assert.equal(page.confirms(), 1);
  assert.equal(page.scans(), 2);
  assert.equal(observer.disconnected, true);
  assert.equal(page.timer(2000).length, 0, "the cap is cleared");
});

test("a page that never shows a control is scanned once and ends at the 2-second cap with the loading hint", async () => {
  const page = zeroFieldPage();
  const pending = page.click();
  const observer = await page.observing();
  observer.callback([{ addedNodes: [TEXT] }]);
  assert.equal(page.timer(2000).length, 1);
  page.timer(2000)[0].callback();
  const result = await within(pending);
  assert.equal(result.error, LOADING_EMPTY);
  assert.equal(page.scans(), 1);
  assert.equal(page.aiCalls(), 0);
  assert.equal(observer.disconnected, true);
});

test("a control that is still settling when the cap is reached is scanned for once", async () => {
  const page = zeroFieldPage();
  const pending = page.click();
  const observer = await page.observing();
  page.formElements.push(new page.HTMLInputElement());
  observer.callback([{ addedNodes: [CONTROL] }]);
  page.timer(2000)[0].callback();
  const result = await within(pending);
  assert.equal(result.filledCount, 1);
  assert.equal(page.scans(), 2);
});

test("when the address changes during the wait, the fill stops without scanning again", async () => {
  for (const ending of ["mutation", "cap"]) {
    const page = zeroFieldPage();
    const pending = page.click();
    const observer = await page.observing();
    page.location.href = "https://jobs.example.test/login";
    page.formElements.push(new page.HTMLInputElement());
    if (ending === "mutation") observer.callback([{ addedNodes: [CONTROL] }]);
    else page.timer(2000)[0].callback();
    const result = await within(pending);
    assert.equal(result.error, LOADING_EMPTY, ending);
    assert.equal(page.scans(), 1, ending);
    assert.equal(page.aiCalls(), 0, ending);
    assert.equal(observer.disconnected, true, ending);
  }
});

test("without MutationObserver the zero-field fill ends at once", async () => {
  const page = zeroFieldPage({ observer: false });
  const result = await within(page.click());
  assert.equal(result.error, LOADING_EMPTY);
  assert.equal(page.scans(), 1);
  assert.equal(page.timer(2000).length, 0);
});

test("pages that are not application forms or that carry a clue are not waited for", async () => {
  const notForm = zeroFieldPage({ location: { href: "https://atsc.liepin.com/interview/room", pathname: "/interview/room" } });
  assert.equal((await within(notForm.click())).error, "没找到可填写的输入框。请打开申请表后再试。");
  for (const probe of [{ ...NO_CLUES, editButtons: 1 }, { ...NO_CLUES, custom: { total: 1, byLibrary: {} } },
    { ...NO_CLUES, frames: { total: 1, crossOrigin: 1, frameInputs: 0 } }, { ...NO_CLUES, locked: 1 }]) {
    const page = zeroFieldPage({ probe });
    await within(page.click());
    assert.equal(page.observers.length, 0, JSON.stringify(probe));
    assert.equal(page.scans(), 1);
  }
  assert.equal(notForm.observers.length, 0);
  // 探测出错：判断不了有没有线索，不等。
  const unprobed = zeroFieldPage({ fillProbe: { ...realProbe, probePage: () => { throw new Error("boom"); } } });
  await within(unprobed.click());
  assert.equal(unprobed.observers.length, 0);
});

test("assisted, deep and recipe fills are never held up by the wait", async () => {
  const assisted = zeroFieldPage();
  await within(assisted.click({ scopes: [{ isConnected: true, contains: () => true }] }));
  assert.equal(assisted.observers.length, 0);

  const deepFill = zeroFieldPage();
  await within(deepFill.click(null, { fields: [], fieldMap: new Map(), report: {} }));
  assert.equal(deepFill.observers.length, 0);

  // 本站有配方但这次没定位上（过期）：退回扫描，不等。
  const recipe = zeroFieldPage({
    storageData: {}, deepAnalysis: deep,
    pageOutline: { build: () => ({ parts: [], nodes: new Map(), titles: new Map(), clues: new Map(), stats: { chars: 0, parts: 0, controls: 0 } }) },
    pageRecipe: { STORAGE_KEY: "pageRecipes", pageKey: () => ({ ok: true, host: "jobs.example.test", path: "/apply" }),
      lookup: () => ({ fields: [{ ref: "e1" }] }),
      locateFields: () => ({ ok: false, total: 1, located: 0, missing: 1, ambiguous: 0, extra: 0, sameStructure: false }) }
  });
  const result = await within(recipe.click());
  assert.match(result.error, /^没找到可填写的输入框。/);
  assert.match(result.error, /本站配方可能已过期/);
  assert.equal(recipe.observers.length, 0);
});
