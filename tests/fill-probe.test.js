// #206 填写诊断的页面探测：只读结构，不读字段值、正文或完整网址。
const test = require("node:test");
const assert = require("node:assert/strict");
const probe = require("../fill-probe.js");

// 只有探测会用到的那几个 DOM 接口。
function node({ tag = "div", text = "", attrs = {}, className = "", visible = true, parent = null,
  insideCustom = false, shadowRoot = null, contentDocument = null, readOnly = false } = {}) {
  return {
    tagName: tag.toUpperCase(), textContent: text, className, parentElement: parent, shadowRoot, contentDocument, readOnly,
    type: tag === "input" ? attrs.type || "text" : undefined,
    getAttribute: name => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    getClientRects: () => (visible ? [{}] : []),
    closest: () => (insideCustom ? {} : null)
  };
}
const page = (map = {}) => ({ querySelectorAll: selector => map[selector] || [] });

test("describes a control by structure only, including the component library above it", () => {
  const wrapper = node({ className: "ant-select ant-select-single" });
  const selector = node({ className: "ant-select-selector", parent: wrapper });
  const input = node({ tag: "input", attrs: { role: "combobox", "aria-haspopup": "listbox", readonly: "" }, parent: selector });
  input.value = "本科";
  assert.deepEqual(probe.describeControl({ kind: "element", element: input }), {
    tag: "input", type: "text", role: "combobox", popup: "listbox", readOnly: true, picker: "", library: "antd"
  });
});

test("radio groups use their first input; date pickers keep their picker type", () => {
  assert.deepEqual(probe.describeControl({ kind: "radio", elements: [node({ tag: "input", attrs: { type: "radio" } })] }), {
    tag: "input", type: "radio", role: "", popup: "", readOnly: false, picker: "", library: ""
  });
  const editor = node({ className: "el-date-editor el-input" });
  const picker = probe.describeControl({ kind: "element", element: node({ tag: "input", parent: editor }), pickerType: "element" });
  assert.equal(picker.picker, "element");
  assert.equal(picker.library, "element");
});

test("attribute values that are not plain tokens are dropped, and missing entries describe nothing", () => {
  const described = probe.describeControl({ kind: "element", element: node({ attrs: { role: "button onclick=steal()" } }) });
  assert.equal(described.role, "");
  assert.equal(described.tag, "div");
  assert.equal(described.type, "");
  assert.equal(probe.describeControl(null), null);
  assert.equal(probe.describeControl({ kind: "element" }), null);
});

test("field names are trimmed, capped at 16 characters, and hidden when they look like contact data", () => {
  assert.equal(probe.safeLabel("  最高 \n 学历 "), "最高 学历");
  assert.equal(probe.safeLabel("邮箱 test@example.com"), "（字段名已隐藏）");
  assert.equal(probe.safeLabel("例如 13800000000"), "（字段名已隐藏）");
  assert.equal(probe.safeLabel("请填写你在校期间获得的全部奖项名称"), "请填写你在校期间获得的全部奖项名…");
  assert.equal(probe.safeLabel(""), "未命名字段");
});

const { SELECTORS } = probe;
const EMPTY = { host: "", frames: { total: 0, crossOrigin: 0, frameInputs: 0 },
  custom: { total: 0, byLibrary: {} }, editButtons: 0, locked: 0, shadowHosts: 0 };

test("page clues count frames, custom controls, edit buttons, locked inputs and shadow roots", () => {
  const outer = node({ className: "ant-select", parent: node() });
  const inner = node({ attrs: { role: "combobox" }, parent: node({ insideCustom: true }) });
  const doc = page({
    [SELECTORS.frames]: [
      node({ tag: "iframe", contentDocument: null }),
      node({ tag: "iframe", contentDocument: page({ [SELECTORS.inputs]: [node({ tag: "input" }), node({ tag: "input" })] }) }),
      node({ tag: "iframe", visible: false })
    ],
    [SELECTORS.custom]: [outer, inner, node({ attrs: { contenteditable: "true" } }), node({ className: "el-select", visible: false })],
    [SELECTORS.buttons]: [
      node({ tag: "a", text: "  编辑 " }),
      node({ tag: "button", attrs: { "aria-label": "修改简历" } }),
      node({ tag: "a", text: "编辑器使用说明" }),
      node({ tag: "button", text: "编辑", visible: false })
    ],
    [SELECTORS.locked]: [node({ tag: "input", attrs: { disabled: "" } })],
    [SELECTORS.all]: [
      node({ shadowRoot: { querySelector: () => ({}) } }),
      node({ shadowRoot: { querySelector: () => null } }),
      node()
    ]
  });
  assert.deepEqual(probe.probePage(doc, { href: "https://c.liepin.com/resume/edit?id=123#top" }), {
    host: "c.liepin.com",
    frames: { total: 2, crossOrigin: 1, frameInputs: 2 },
    custom: { total: 2, byLibrary: { antd: 1, 其他: 1 } },
    editButtons: 2, locked: 1, shadowHosts: 1
  });
});

test("a frame that throws on access counts as cross-origin, and a bad address gives no host", () => {
  const frame = node({ tag: "iframe" });
  Object.defineProperty(frame, "contentDocument", { get() { throw new Error("blocked"); } });
  const result = probe.probePage(page({ [SELECTORS.frames]: [frame] }), { href: "not a url" });
  assert.equal(result.frames.crossOrigin, 1);
  assert.equal(result.host, "");
});

test("the shadow-root walk stops at a fixed number of elements", () => {
  const hosts = Array.from({ length: 3001 }, () => node({ shadowRoot: { querySelector: () => ({}) } }));
  assert.equal(probe.probePage(page({ [SELECTORS.all]: hosts })).shadowHosts, 3000);
});

test("the empty-page hint prefers the edit button, then locked inputs, frames and unknown controls", () => {
  assert.match(probe.emptyPageHint({ ...EMPTY, editButtons: 1, custom: { total: 3, byLibrary: {} } }), /先点网页上的「编辑」/);
  assert.match(probe.emptyPageHint({ ...EMPTY, locked: 1 }), /只读或禁用/);
  assert.match(probe.emptyPageHint({ ...EMPTY, frames: { total: 1, crossOrigin: 1, frameInputs: 0 } }), /内嵌框架/);
  assert.match(probe.emptyPageHint({ ...EMPTY, shadowHosts: 1 }), /暂时识别不了/);
  assert.equal(probe.emptyPageHint(EMPTY), "");
  assert.equal(probe.emptyPageHint(null), "");
});
