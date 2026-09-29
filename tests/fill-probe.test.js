// #206 填写诊断的页面探测：只读结构，不读字段值、正文或完整网址。
const test = require("node:test");
const assert = require("node:assert/strict");
const probe = require("../fill-probe.js");

// 只有探测会用到的那几个 DOM 接口。
function node({ tag = "div", text = "", attrs = {}, className = "", visible = true, parent = null,
  insideCustom = false, shadowRoot = null, contentDocument = null, readOnly = false,
  rect = { width: 300, height: 200 } } = {}) {
  return {
    tagName: tag.toUpperCase(), textContent: text, className, parentElement: parent, shadowRoot, contentDocument, readOnly,
    type: tag === "input" ? attrs.type || "text" : undefined,
    getAttribute: name => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    getClientRects: () => (visible ? [{}] : []),
    getBoundingClientRect: () => rect,
    closest: () => (insideCustom ? {} : null)
  };
}
// textNodes：{ data, parentElement } 列表，供 createTreeWalker 逐个返回，最后返回 null。
const page = (map = {}, textNodes = []) => ({
  querySelectorAll: selector => map[selector] || [],
  createTreeWalker: () => {
    let index = 0;
    return { nextNode: () => textNodes[index++] ?? null };
  }
});
const textNode = (data, parentElement) => ({ data, parentElement });

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

test("tags with digits survive the token filter, but tokens must still start with a letter", () => {
  const described = probe.describeControl({ kind: "element", element: node({ tag: "ui5-input", attrs: { role: "1combobox" } }) });
  assert.equal(described.tag, "ui5-input");
  assert.equal(described.role, "");
});

test("field names are trimmed, capped at 16 characters, and hidden when they look like contact data", () => {
  assert.equal(probe.safeLabel("  最高 \n 学历 "), "最高 学历");
  assert.equal(probe.safeLabel("邮箱 test@example.com"), "（字段名已隐藏）");
  assert.equal(probe.safeLabel("例如 13800000000"), "（字段名已隐藏）");
  assert.equal(probe.safeLabel("请填写你在校期间获得的全部奖项名称"), "请填写你在校期间获得的全部奖项名…");
  assert.equal(probe.safeLabel(""), "未命名字段");
});

test("phone numbers are hidden however they are punctuated or typed, but a year is not", () => {
  assert.equal(probe.safeLabel("手机 138-1234-5678"), "（字段名已隐藏）");
  assert.equal(probe.safeLabel("138 1234 5678"), "（字段名已隐藏）");
  assert.equal(probe.safeLabel("电话 (010) 8888.6666"), "（字段名已隐藏）");
  assert.equal(probe.safeLabel("手机 １３８００００００００"), "（字段名已隐藏）");
  assert.equal(probe.safeLabel("邮箱 a＠b.com"), "（字段名已隐藏）");
  assert.equal(probe.safeLabel("2023年毕业"), "2023年毕业");
});

test("the 16-character cap counts characters, not UTF-16 units, so an emoji is never split", () => {
  assert.equal(probe.safeLabel(`${"a".repeat(15)}😀bcd`), `${"a".repeat(15)}😀…`);
  assert.equal(probe.safeLabel("😀".repeat(10)), "😀".repeat(10));
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
      node({ tag: "iframe", visible: false, rect: { width: 0, height: 0 } }),
      // Chrome 里 0×0 的统计/单点登录 iframe 也会返回 1 个 client rect：不算内嵌表单。
      node({ tag: "iframe", rect: { width: 0, height: 0 } }),
      node({ tag: "iframe", rect: { width: 99, height: 200 } }),
      node({ tag: "iframe", rect: { width: 300, height: 49 } })
    ],
    [SELECTORS.custom]: [outer, inner, node({ attrs: { contenteditable: "true" } }), node({ className: "el-select", visible: false })],
    [SELECTORS.labelled]: [node({ tag: "button", attrs: { "aria-label": "修改简历" } }), node({ attrs: { title: "帮助" } })],
    [SELECTORS.locked]: [
      node({ tag: "input", attrs: { disabled: "" } }),
      // antd / Element 的下拉输入框本身就是 readonly：属于自定义控件，不算「只读或禁用」。
      node({ tag: "input", attrs: { readonly: "" }, insideCustom: true })
    ],
    [SELECTORS.all]: [
      node({ shadowRoot: { querySelector: () => ({}) } }),
      node({ shadowRoot: { querySelector: () => null } }),
      node()
    ]
  }, [
    textNode("编辑", node({ tag: "a" })),
    textNode("编辑器使用说明", node({ tag: "a" }))
  ]);
  assert.deepEqual(probe.probePage(doc, { href: "https://c.liepin.com/resume/edit?id=123#top" }), {
    host: "c.liepin.com",
    frames: { total: 2, crossOrigin: 1, frameInputs: 2 },
    custom: { total: 2, byLibrary: { antd: 1, 其他: 1 } },
    editButtons: 2, locked: 1, shadowHosts: 1
  });
});

test("a frame exactly at the minimum size (100×50) counts", () => {
  const doc = page({ [SELECTORS.frames]: [node({ tag: "iframe", rect: { width: 100, height: 50 } })] });
  assert.equal(probe.probePage(doc).frames.total, 1);
});

// 「编辑」按钮写法五花八门，按文字找：数文字正好是「编辑」一类的文本节点所在的元素。
const editCount = (textNodes, labelled = []) => probe.probePage(page({ [SELECTORS.labelled]: labelled }, textNodes)).editButtons;

test("edit controls are found by their text, whatever the markup", () => {
  // <a><i class="iconfont">&#xE601;</i>编辑</a>：图标字形在自己的 <i> 里，文字在 <a> 里。
  const anchor = node({ tag: "a" });
  assert.equal(editCount([textNode("\uE601", node({ tag: "i", parent: anchor })), textNode("编辑", anchor)]), 1);
  // 图标字形和文字挤在同一个文本节点里，也要认出来。
  assert.equal(editCount([textNode("\uE601 编辑 ", node({ tag: "a" }))]), 1);
  // <span class="btn">编辑</span>
  assert.equal(editCount([textNode("编辑", node({ tag: "span", className: "btn" }))]), 1);
  // 悬停才出现的按钮：display:none 也算，且新的说法也认得出来。
  assert.equal(editCount([textNode("完善简历", node({ tag: "button", visible: false }))]), 1);
  assert.equal(editCount([textNode("去编辑", node({ tag: "span" }))]), 1);
  assert.equal(editCount([textNode("「编辑」", node({ tag: "span" }))]), 1);
});

test("edit controls are counted once per element and never from longer sentences or non-text elements", () => {
  const same = node({ tag: "a" });
  assert.equal(editCount([textNode("编辑", same), textNode("编辑", same)]), 1);
  assert.equal(editCount([textNode("编辑", node({ tag: "a" })), textNode("编辑", node({ tag: "a" }))]), 2);
  assert.equal(editCount([textNode("编辑器使用说明", node({ tag: "a" }))]), 0);
  assert.equal(editCount([textNode("编辑", node({ tag: "script" })), textNode("编辑", node({ tag: "textarea" })),
    textNode("编辑", node({ tag: "style" })), textNode("编辑", node({ tag: "noscript" })), textNode("编辑", node({ tag: "template" }))]), 0);
  assert.equal(editCount([textNode("编辑", null)]), 0);
});

test("icon-only buttons are found through aria-label or title, without double counting the same element", () => {
  assert.equal(editCount([], [node({ tag: "button", attrs: { "aria-label": "修改简历" } })]), 1);
  assert.equal(editCount([], [node({ tag: "i", attrs: { title: "编辑" } })]), 1);
  assert.equal(editCount([], [node({ tag: "i", attrs: { title: "帮助" } })]), 0);
  const both = node({ tag: "a", attrs: { title: "编辑" } });
  assert.equal(editCount([textNode("编辑", both)], [both]), 1);
});

test("the text-node walk stops at a fixed number of nodes", () => {
  const many = Array.from({ length: 20001 }, () => textNode("编辑", node({ tag: "a" })));
  assert.equal(editCount(many), 20000);
});

test("the custom-control selector matches every contenteditable except contenteditable=false", () => {
  assert.ok(SELECTORS.custom.includes("[contenteditable]:not([contenteditable=false])"));
  assert.ok(!SELECTORS.custom.includes("[contenteditable='']"));
  assert.ok(!SELECTORS.custom.includes("[contenteditable=true]"));
  assert.equal(SELECTORS.buttons, undefined);
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
  assert.match(probe.emptyPageHint({ ...EMPTY, custom: { total: 2, byLibrary: {} } }), /暂时识别不了/);
  assert.match(probe.emptyPageHint({ ...EMPTY, frames: { total: 1, crossOrigin: 0, frameInputs: 2 } }), /内嵌框架/);
  assert.equal(probe.emptyPageHint(EMPTY), "");
  assert.equal(probe.emptyPageHint(null), "");
});

test("the report lists page clues and the structure of unfilled controls, never their values", () => {
  const lines = probe.formatReport({
    host: "c.liepin.com", frames: { total: 1, crossOrigin: 1, frameInputs: 0 },
    custom: { total: 3, byLibrary: { antd: 2, 其他: 1 } }, editButtons: 4, locked: 0, shadowHosts: 0
  }, [{
    label: "最高学历", reason: "值被页面退回",
    control: { tag: "input", type: "text", role: "combobox", popup: "listbox", readOnly: true, picker: "", library: "antd" }
  }]);
  assert.deepEqual(lines, [
    "页面：c.liepin.com",
    "页面线索：内嵌框架 1（跨域 1，同源框架内输入框 0）；自定义控件 3（antd 2、其他 1）；只读或禁用输入框 0；「编辑」按钮 4；含输入框的 Shadow DOM 0",
    "没填上的字段（控件结构）：",
    "- 最高学历：input[text] role=combobox 弹出=listbox 只读 组件库=antd｜值被页面退回"
  ]);
});

test("the report lists at most ten fields and hides contact-like field names", () => {
  const unfilled = Array.from({ length: 12 }, (_, index) => ({ label: `字段${index + 1}`, reason: "", control: null }));
  unfilled[0].label = "邮箱 a@b.com";
  const lines = probe.formatReport(null, unfilled);
  assert.equal(lines.length, 12);
  assert.equal(lines[0], "没填上的字段（控件结构）：");
  assert.equal(lines[1], "- （字段名已隐藏）：结构未知");
  assert.equal(lines[2], "- 字段2：结构未知");
  assert.equal(lines[11], "- 还有 2 个未列出");
  assert.deepEqual(probe.formatReport(null, []), []);
});

test("the manifest loads the probe before the content script", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts.find(entry => entry.js?.includes("content.js"))?.js ?? [];
  assert.ok(scripts.includes("fill-probe.js"));
  assert.ok(scripts.indexOf("fill-probe.js") < scripts.indexOf("content.js"));
});
