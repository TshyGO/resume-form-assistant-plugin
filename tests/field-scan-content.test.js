// #228：content.js 接入扫描结果后的行为——一键填写和「加到我的信息」共用同一份扫描，
// 用之前都要确认题目和控件的对应关系还成立。扫描本身见 field-scan.test.js。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadHighlightHelpers, fakeFieldScan } = require("./helpers/content-harness");

function shadow() {
  const parts = {
    "#resume-pro-status": { textContent: "", className: "" },
    "#resume-pro-profile-offer": { hidden: true, querySelector: () => parts.offerText },
    offerText: { textContent: "" }
  };
  return { parts, root: { querySelector: (selector) => parts[selector] || null, querySelectorAll: () => [] } };
}

// 扫描替身：controls 由测试给定，staleness 由 stale 集合决定。
function scanWith(controls, stale = new Set()) {
  return {
    ...fakeFieldScan(),
    scanPage: () => ({ controls, skipped: { pageChrome: 1, popup: 0, merged: 2, siteSearch: 0, outsideForm: 0, noLabel: 3 },
      sources: { item: controls.length } }),
    isBindingCurrent: (binding) => !stale.has(binding.element)
  };
}

// 扫描替身在元素建好之后才定下来：content.js 加载时拿到的是这个转发对象。
function lateScanner() {
  const holder = { current: fakeFieldScan() };
  const proxy = Object.fromEntries(["scanPage", "isBindingCurrent", "hasDisplayedValue", "labelForElement"]
    .map((name) => [name, (...args) => holder.current[name](...args)]));
  return { holder, proxy };
}

function control(element, overrides = {}) {
  return { kind: "element", controlKind: "text", element, elements: [element], root: element, item: element,
    label: "", labelSource: "item", section: "", group: "", repeatIndex: 0, offerable: true, offerLabel: "",
    pickerType: "", rangePart: "", placeholder: "", ...overrides };
}

const store = {
  templates: [{ id: "t", name: "模板", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }] }] }],
  activeTemplateId: "t"
};

test("the profile offer lists only reliably titled fields, by their section-qualified names", async () => {
  const late = lateScanner();
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy,
    sendMessage: async () => ({ success: true, matches: [] }) });
  const [award, practice, placeholderOnly] = [0, 1, 2].map(() => new ctx.HTMLInputElement());
  late.holder.current = scanWith([
    control(award, { label: "名称", offerLabel: "获奖情况-名称" }),
    control(practice, { label: "名称", offerLabel: "学生工作经历-名称" }),
    control(placeholderOnly, { label: "", labelSource: "placeholder", offerable: false, placeholder: "请输入手机号码" })
  ]);
  const ui = shadow();
  ctx.helpers.setShadowRoot(ui.root);
  ctx.helpers.setCurrentStore(store);

  await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } });

  assert.equal(ui.parts["#resume-pro-profile-offer"].hidden, false);
  assert.match(ui.parts.offerText.textContent, /还有 2 个字段空着：获奖情况-名称、学生工作经历-名称。/);
  assert.doesNotMatch(ui.parts.offerText.textContent, /手机号码|请输入/);
});

test("a field whose title binding went stale during matching is not written", async () => {
  const late = lateScanner();
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy,
    sendMessage: async () => ({ success: true, matches: [{ fieldId: "field-0", value: "测试用户" }, { fieldId: "field-1", value: "测试用户" }] }) });
  const [moved, kept] = [0, 1].map(() => new ctx.HTMLInputElement());
  late.holder.current = scanWith([control(moved, { label: "姓名" }), control(kept, { label: "姓名拼音" })], new Set([moved]));
  const ui = shadow();
  ctx.helpers.setShadowRoot(ui.root);
  ctx.helpers.setCurrentStore(store);

  await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } });

  assert.equal(moved.value, "");
  assert.equal(kept.value, "测试用户");
  assert.match(ui.parts["#resume-pro-status"].textContent, /1 项没填上：姓名（页面已变化）/);
});

test("adding to 我的信息 re-checks the binding and adds nothing that moved since the scan", async () => {
  const late = lateScanner();
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy });
  const element = new ctx.HTMLInputElement();
  late.holder.current = scanWith([], new Set([element]));
  const ui = shadow();
  ctx.helpers.setShadowRoot(ui.root);
  ctx.helpers.setProfileOffer({
    labels: ["期望薪资"], fields: [],
    candidates: [{ label: "期望薪资", entry: { kind: "element", element, binding: { element } } }]
  });

  await ctx.helpers.addUnansweredToProfile();

  assert.equal(ctx.desktopMessages.some((message) => message.type === "DESKTOP_RESUME_UPDATE"), false);
  assert.match(ui.parts["#resume-pro-status"].textContent, /网页内容已经变化/);
});

test("diagnostics carry scan counts and label sources, and survive the feedback allowlist", async () => {
  const feedback = require("../feedback-core.js");
  const ctx = loadHighlightHelpers({ formElements: [] });
  const text = ctx.helpers.formatFillDiagnostics({
    fieldCount: 3, filledCount: 1, unfilledCount: 0, outcome: "partial", diagnostics: {},
    scanStats: { skipped: { pageChrome: 1, popup: 1, merged: 2, siteSearch: 0, outsideForm: 0, noLabel: 4 },
      sources: { explicit: 1, item: 2, "item-text": 1, "table-header": 2, sibling: 1, placeholder: 1 } }
  });
  const lines = [
    "扫描跳过：页头导航 1；下拉内部输入 1；并入同一控件 2；站内搜索 0；表单外 0；对不上题目 4",
    "字段名来源：明确关联 1；表单项 3；表格 2；相邻文字 1；仅占位文字 1"
  ];
  lines.forEach((line) => assert.ok(text.split("\n").includes(line), line));
  const safe = feedback.diagnostics(text).split("\n");
  lines.forEach((line) => assert.ok(safe.includes(line), `allowlisted: ${line}`));
});
