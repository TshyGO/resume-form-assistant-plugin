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
