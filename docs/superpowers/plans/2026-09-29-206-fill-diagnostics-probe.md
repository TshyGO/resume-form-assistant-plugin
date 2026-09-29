# #206 填写诊断：页面线索与没填上字段的控件结构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每一次“填不上”的反馈都能变成可排查的案例：诊断里附上页面结构线索和没填上字段的控件结构；扫描到 0 个字段时直接提示用户怎么做（如猎聘“先点编辑”）。

**Architecture:** 新增纯函数模块 `fill-probe.js`（加载方式与 `form-agent.js` 相同：content script 里挂到 `self.ResumeProFillProbe`，Node 测试里 `require`）。它只读结构：标签名、type、role、组件库 class 前缀、计数，从不读字段值、页面正文或完整 URL。`content.js` 通过一个 `withFillProbe()` 包装调用它；模块缺席或抛错时退回原来的诊断，不影响填写。侧栏加「复制诊断」按钮，仓库加一个“网站填不上”的 issue 模板。

**Tech Stack:** 原生 JS（无构建步骤），`node --test`，现有 `tests/helpers/content-harness.js` 与 `tests/helpers/sidepanel-harness.js` 两个 VM 测试工具。

**Issue:** https://github.com/TshyGO/resume-form-assistant-plugin/issues/206

---

## 背景（执行前必读）

- 一键填写入口是 `content.js` 的 `handleAiFillClick`（约第 1674 行）。点击时调用 `scanFillableFields()`（约第 2002 行），它只收集**可见**的 `input / textarea / select` 和几类日期控件。
- 扫描到 0 个字段时抛出 `当前页面没有可填写的表单字段。`（第 1737 行）。猎聘在线简历默认是查看状态，要先点「编辑」才有输入框，所以会走到这里。
- AI 匹配到了但写不进去的字段，会进入 `unfilledLabels`（第 1891–1895 行），失败原因来自 `TEXT_FILL_FAILURE_LABELS`（第 58 行，固定文案）。
- `finally` 里组装 `summaryInput`（第 1946 行），调用 `writeFillDiagnostics` → `formatFillDiagnostics`（第 1973 行）生成诊断文本。侧栏通过 `RESUME_PANEL_STATUS` 取回这段文本（`content.js` 第 123 行），显示在 `sidepanel.html` 的 `#fill-diagnostics-text` 里。
- 内容脚本不带 `all_frames`，只在顶层页面运行；iframe 里的字段本来就扫不到。本次只统计，不改变这一点。
- 发包白名单：新文件必须同时加进 `manifest.json`、`desktop/scripts/pack-plugin.js` 的 `PLUGIN_ARCHIVE_OPERANDS`、`desktop/scripts/check-plugin-release-allowlist.js` 的 `allowed` 集合。`check-plugin-release-allowlist.js` 用 `git ls-tree HEAD` 核对，**文件必须先提交**再运行它。
- 基线：`npm test` 962/962 通过。

## 隐私边界（每个任务都要守住）

- 诊断里不得出现：字段值、简历内容、完整 URL（只要 hostname）、接口地址、Key、页面正文、原始 class 名。
- 字段名最多 16 个字；含 `@`/`＠` 或连续 5 位以上数字时整体替换为 `（字段名已隐藏）`。
- role / type / aria-haspopup 等属性值只接受 `^[a-z][a-z-]{0,23}$`，否则丢弃。
- 组件库只输出固定名称（antd / element / arco / iview / semi / vant / layui / mui / 其他）。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `fill-probe.js` | 新建 | 页面结构探测、控件描述、空页面提示、诊断行格式化（纯函数） |
| `tests/fill-probe.test.js` | 新建 | `fill-probe.js` 单元测试 + manifest 加载顺序 |
| `tests/fill-probe-content.test.js` | 新建 | `content.js` 接入后的行为（空页面提示、探测出错不影响填写、诊断内容） |
| `tests/helpers/content-harness.js` | 修改 | 支持注入 `options.fillProbe` |
| `content.js` | 修改 | `withFillProbe`、扫描后探测、空页面提示、记录没填上字段的结构、诊断追加行 |
| `manifest.json` | 修改 | content_scripts 里在 `content.js` 前加载 `fill-probe.js` |
| `desktop/scripts/pack-plugin.js` | 修改 | 打包清单加 `fill-probe.js` |
| `desktop/scripts/check-plugin-release-allowlist.js` | 修改 | 白名单加 `fill-probe.js` |
| `.github/workflows/test.yml`、`.github/workflows/release.yml` | 修改 | `node --check fill-probe.js` |
| `sidepanel.html` / `sidepanel.css` / `sidepanel.js` | 修改 | 「复制诊断」按钮 |
| `tests/helpers/sidepanel-harness.js` | 修改 | 记录剪贴板写入 |
| `tests/sidepanel-diagnostics.test.js` | 新建 | 复制按钮测试 |
| `.github/ISSUE_TEMPLATE/site-not-filling.yml` | 新建 | 网站填不上反馈表单 |
| `docs/user-guide.md`、`docs/desktop-mvp/data-privacy.md`、`docs/extension-development.md` | 修改 | 诊断说明、常见问题、文件清单 |

---

### Task 0: 分支

- [ ] **Step 1: 从最新 main 开分支**

```bash
git fetch origin
git switch -c feat/206-fill-diagnostics-probe origin/main
npm test 2>&1 | tail -6
```

Expected: `pass 962`、`fail 0`（数字可能随 main 增长，关键是 `fail 0`）。

---

### Task 1: `fill-probe.js` — 控件描述与字段名脱敏

**Files:**
- Create: `fill-probe.js`
- Create: `tests/fill-probe.test.js`

- [ ] **Step 1: 写失败的测试**

`tests/fill-probe.test.js`：

```js
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/fill-probe.test.js`
Expected: FAIL，`Cannot find module '../fill-probe.js'`

- [ ] **Step 3: 写最小实现**

`fill-probe.js`：

```js
// #206 填写诊断用的只读页面探测。只看结构：标签名、type、role、组件库 class 前缀和计数；
// 从不读取字段值、页面正文或完整网址。content.js 经 withFillProbe() 调用，
// 这里缺席或出错时诊断退回原样，填写不受影响。
(function (root) {
  const LIBRARIES = [
    ["antd", /^ant-/], ["element", /^el-/], ["arco", /^arco-/], ["iview", /^ivu-/],
    ["semi", /^semi-/], ["vant", /^van-/], ["layui", /^layui-/], ["mui", /^Mui/]
  ];
  const TOKEN = /^[a-z][a-z-]{0,23}$/;
  const MAX_ANCESTORS = 4;
  const MAX_LABEL = 16;

  const token = value => {
    const text = String(value ?? "").trim().toLowerCase();
    return TOKEN.test(text) ? text : "";
  };
  const classTokens = el => (typeof el?.className === "string" ? el.className.split(/\s+/).filter(Boolean) : []);

  // 控件本身和往上几层祖先里，第一个认得出的组件库前缀。只返回库名，不返回原始 class。
  function libraryOf(el) {
    for (let current = el, depth = 0; current && depth <= MAX_ANCESTORS; current = current.parentElement, depth += 1) {
      for (const name of classTokens(current)) {
        const hit = LIBRARIES.find(([, pattern]) => pattern.test(name));
        if (hit) return hit[0];
      }
    }
    return "";
  }

  // entry 与 content.js 的 fieldMap 条目同形：{ kind: "element", element, pickerType } 或 { kind: "radio", elements }。
  function describeControl(entry) {
    const el = entry?.kind === "radio" ? entry.elements?.[0] : entry?.element;
    if (!el) return null;
    const attr = name => el.getAttribute?.(name);
    const tag = token(el.tagName);
    return {
      tag,
      type: tag === "input" ? token(el.type || attr("type")) || "text" : "",
      role: token(attr("role")),
      popup: token(attr("aria-haspopup")),
      readOnly: el.readOnly === true || attr("readonly") != null,
      picker: token(entry.pickerType),
      library: libraryOf(el)
    };
  }

  // 字段名来自网页，但兜底规则可能把旁边的文字当成字段名：长的截断，像联系方式的整体隐藏。
  function safeLabel(label) {
    const text = String(label ?? "").replace(/\s+/g, " ").trim();
    if (!text) return "未命名字段";
    if (/[@＠]|\d{5,}/.test(text)) return "（字段名已隐藏）";
    return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL)}…` : text;
  }

  const api = { describeControl, safeLabel };
  root.ResumeProFillProbe = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test tests/fill-probe.test.js`
Expected: 4 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
git add fill-probe.js tests/fill-probe.test.js
git commit -m "feat(fill): 新增填写诊断的控件结构描述 (#206)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `fill-probe.js` — 页面线索与空页面提示

**Files:**
- Modify: `fill-probe.js`
- Modify: `tests/fill-probe.test.js`

- [ ] **Step 1: 写失败的测试**

追加到 `tests/fill-probe.test.js`：

```js
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/fill-probe.test.js`
Expected: FAIL，`probe.probePage is not a function`（`SELECTORS` 为 undefined 时先报 `Cannot read properties of undefined`，同样算预期失败）

- [ ] **Step 3: 实现**

在 `fill-probe.js` 顶部常量区（`LIBRARIES` 之前）加：

```js
  const SELECTORS = {
    frames: "iframe, frame",
    inputs: "input:not([type=hidden]), textarea, select",
    custom: "[role=combobox], [role=listbox], [aria-haspopup=listbox], [contenteditable=''], [contenteditable=true], "
      + ".ant-select, .ant-cascader, .el-select, .el-cascader, .arco-select, .arco-cascader, "
      + ".ivu-select, .ivu-cascader, .semi-select, .layui-form-select",
    buttons: "button, a, [role=button], [class*=edit]",
    locked: "input[readonly]:not([type=hidden]), input[disabled]:not([type=hidden]), textarea[readonly], textarea[disabled], select[disabled]",
    all: "*"
  };
  const EDIT_TEXT = /^(?:编辑|修改|完善|去完善|立即完善|编辑简历|修改简历|编辑信息|修改信息|编辑资料)$/;
  const MAX_WALK = 3000;
```

在 `safeLabel` 之后加：

```js
  const visible = el => Boolean(el?.getClientRects?.().length);
  const shown = list => Array.from(list || []).filter(visible);
  const compact = value => String(value ?? "").replace(/\s+/g, "");

  function hostOf(href) {
    try {
      return new URL(href).hostname;
    } catch {
      return "";
    }
  }

  function isEditButton(el) {
    return EDIT_TEXT.test(compact(el.textContent))
      || EDIT_TEXT.test(compact(el.getAttribute?.("aria-label") || el.getAttribute?.("title")));
  }

  // 页面层面的线索：只数数，不读内容。
  function probePage(doc, { href = "" } = {}) {
    const frames = shown(doc.querySelectorAll(SELECTORS.frames));
    let crossOrigin = 0;
    let frameInputs = 0;
    for (const frame of frames) {
      let inner = null;
      try {
        inner = frame.contentDocument;
      } catch {
        inner = null;
      }
      if (inner) frameInputs += Array.from(inner.querySelectorAll(SELECTORS.inputs)).length;
      else crossOrigin += 1;
    }

    const byLibrary = {};
    let customTotal = 0;
    for (const control of shown(doc.querySelectorAll(SELECTORS.custom))) {
      // antd 下拉外壳里还套着 role=combobox 的输入框：只数最外层。
      if (control.parentElement?.closest?.(SELECTORS.custom)) continue;
      customTotal += 1;
      const library = libraryOf(control) || "其他";
      byLibrary[library] = (byLibrary[library] || 0) + 1;
    }

    const all = doc.querySelectorAll(SELECTORS.all);
    const limit = Math.min(all.length || 0, MAX_WALK);
    let shadowHosts = 0;
    for (let index = 0; index < limit; index += 1) {
      if (all[index]?.shadowRoot?.querySelector?.(SELECTORS.inputs)) shadowHosts += 1;
    }

    return {
      host: hostOf(href),
      frames: { total: frames.length, crossOrigin, frameInputs },
      custom: { total: customTotal, byLibrary },
      editButtons: shown(doc.querySelectorAll(SELECTORS.buttons)).filter(isEditButton).length,
      locked: shown(doc.querySelectorAll(SELECTORS.locked)).length,
      shadowHosts
    };
  }

  // 扫描到 0 个字段时，按最可能的原因告诉用户下一步怎么做。
  function emptyPageHint(probe) {
    if (!probe) return "";
    if (probe.editButtons > 0) return "这个页面可能还在查看状态：请先点网页上的「编辑」，等输入框出现后再一键填写。";
    if (probe.locked > 0) return "网页上的输入框目前是只读或禁用的：请先点「编辑」或完成网页要求的上一步，再一键填写。";
    if (probe.frames.crossOrigin > 0 || probe.frames.frameInputs > 0) {
      return "表单可能在网页的内嵌框架里，插件暂时读不到。可以把侧栏的「填写诊断」复制给我们。";
    }
    if (probe.custom.total > 0 || probe.shadowHosts > 0) {
      return "这个网页用的输入控件插件暂时识别不了。可以把侧栏的「填写诊断」复制给我们。";
    }
    return "";
  }
```

把导出改为：

```js
  const api = { SELECTORS, describeControl, safeLabel, probePage, emptyPageHint };
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test tests/fill-probe.test.js`
Expected: 8 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
git add fill-probe.js tests/fill-probe.test.js
git commit -m "feat(fill): 探测页面结构线索并给出空页面提示 (#206)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `fill-probe.js` — 诊断行格式化

**Files:**
- Modify: `fill-probe.js`
- Modify: `tests/fill-probe.test.js`

- [ ] **Step 1: 写失败的测试**

追加到 `tests/fill-probe.test.js`：

```js
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/fill-probe.test.js`
Expected: FAIL，`probe.formatReport is not a function`

- [ ] **Step 3: 实现**

常量区加：

```js
  const MAX_LISTED = 10;
```

在 `emptyPageHint` 之后加：

```js
  function formatControl(control) {
    if (!control) return "结构未知";
    const parts = [`${control.tag || "?"}${control.type ? `[${control.type}]` : ""}`];
    if (control.role) parts.push(`role=${control.role}`);
    if (control.popup) parts.push(`弹出=${control.popup}`);
    if (control.readOnly) parts.push("只读");
    if (control.picker) parts.push(`日期控件=${control.picker}`);
    if (control.library) parts.push(`组件库=${control.library}`);
    return parts.join(" ");
  }

  // 追加到填写诊断末尾的几行。unfilled 的 reason 只能是 content.js 里固定的失败原因文案。
  function formatReport(probe, unfilled = []) {
    const lines = [];
    if (probe) {
      const libraries = Object.entries(probe.custom.byLibrary).map(([name, count]) => `${name} ${count}`).join("、");
      lines.push(`页面：${probe.host || "未知"}`);
      lines.push(`页面线索：内嵌框架 ${probe.frames.total}（跨域 ${probe.frames.crossOrigin}，同源框架内输入框 ${probe.frames.frameInputs}）；`
        + `自定义控件 ${probe.custom.total}${libraries ? `（${libraries}）` : ""}；只读或禁用输入框 ${probe.locked}；`
        + `「编辑」按钮 ${probe.editButtons}；含输入框的 Shadow DOM ${probe.shadowHosts}`);
    }
    if (unfilled.length) {
      lines.push("没填上的字段（控件结构）：");
      for (const item of unfilled.slice(0, MAX_LISTED)) {
        lines.push(`- ${safeLabel(item.label)}：${formatControl(item.control)}${item.reason ? `｜${item.reason}` : ""}`);
      }
      if (unfilled.length > MAX_LISTED) lines.push(`- 还有 ${unfilled.length - MAX_LISTED} 个未列出`);
    }
    return lines;
  }
```

导出改为：

```js
  const api = { SELECTORS, describeControl, safeLabel, probePage, emptyPageHint, formatReport };
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test tests/fill-probe.test.js`
Expected: 10 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
git add fill-probe.js tests/fill-probe.test.js
git commit -m "feat(fill): 格式化页面线索与没填上字段的诊断行 (#206)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 加载与发包接线

**Files:**
- Modify: `manifest.json`（content_scripts `js` 数组）
- Modify: `desktop/scripts/pack-plugin.js:22`
- Modify: `desktop/scripts/check-plugin-release-allowlist.js:40`
- Modify: `.github/workflows/test.yml:34`、`.github/workflows/release.yml:89`
- Modify: `tests/fill-probe.test.js`

- [ ] **Step 1: 写失败的测试**

追加到 `tests/fill-probe.test.js`：

```js
test("the manifest loads the probe before the content script", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts.find(entry => entry.js?.includes("content.js"))?.js ?? [];
  assert.ok(scripts.includes("fill-probe.js"));
  assert.ok(scripts.indexOf("fill-probe.js") < scripts.indexOf("content.js"));
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/fill-probe.test.js`
Expected: FAIL，`scripts.includes("fill-probe.js")` 断言失败

- [ ] **Step 3: 接线**

`manifest.json` 的 content_scripts `js` 改为：

```json
      "js": [
        "ai-client.js",
        "ai-helpers.js",
        "profile-fields.js",
        "resume-data.js",
        "form-agent.js",
        "fill-probe.js",
        "sidebar-state.js",
        "content.js"
      ],
```

`desktop/scripts/pack-plugin.js` 的 `PLUGIN_ARCHIVE_OPERANDS`，在 `"form-agent.js",` 下一行加：

```js
  "fill-probe.js",
```

`desktop/scripts/check-plugin-release-allowlist.js` 第 40 行，把 `"form-agent.js",` 改成 `"form-agent.js","fill-probe.js",`：

```js
  const allowed = new Set(["manifest.json","background.js","content.js","content.css","sidebar-state.js","ai-helpers.js","form-agent.js","fill-probe.js",
```

`.github/workflows/test.yml` 和 `.github/workflows/release.yml` 的 “Check JavaScript syntax” 步骤里，在 `node --check form-agent.js` 下一行加：

```yaml
          node --check fill-probe.js
```

- [ ] **Step 4: 运行，确认通过**

```bash
node --test tests/fill-probe.test.js
node --check fill-probe.js
```

Expected: 11 个测试 PASS；`node --check` 无输出

- [ ] **Step 5: 提交后核对发包清单**

```bash
git add manifest.json desktop/scripts/pack-plugin.js desktop/scripts/check-plugin-release-allowlist.js .github/workflows/test.yml .github/workflows/release.yml tests/fill-probe.test.js
git commit -m "build(plugin): 打包并加载 fill-probe.js (#206)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
node desktop/scripts/check-plugin-release-allowlist.js
node --test desktop/scripts/pack-plugin.test.js desktop/scripts/check-plugin-release-allowlist.test.js 2>&1 | tail -6
```

Expected: 第一条输出 `release.yml packs plugin runtime files only, and all 58 runtime files are present`（原来是 57）；第二条 `fail 0`

---

### Task 5: `content.js` 接入

**Files:**
- Modify: `tests/helpers/content-harness.js`（`self` 对象，约第 213 行）
- Create: `tests/fill-probe-content.test.js`
- Modify: `content.js:1716`、`content.js:1729-1737`、`content.js:1891-1895`、`content.js:1946-1947`、`content.js:1973-2000`

- [ ] **Step 1: 让测试工具能注入探测模块**

`tests/helpers/content-harness.js` 里 `self: { __RESUME_PRO_TEST__: true, ResumeProFormAgent: options.formAgent, ResumeProAIHelpers: options.aiHelpers,` 这一行改为：

```js
    self: { __RESUME_PRO_TEST__: true, ResumeProFormAgent: options.formAgent, ResumeProAIHelpers: options.aiHelpers,
      ResumeProFillProbe: options.fillProbe,
```

（其余字段不动。不传 `fillProbe` 的现有测试行为不变。）

- [ ] **Step 2: 写失败的测试**

`tests/fill-probe-content.test.js`：

```js
// #206：content.js 接入页面探测后的行为。探测模块本身见 fill-probe.test.js。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadHighlightHelpers } = require("./helpers/content-harness.js");
const realProbe = require("../fill-probe.js");

const STORE = { templates: [{ id: "one", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }] }] }], activeTemplateId: "one" };
const LIEPIN_VIEW = { host: "c.liepin.com", frames: { total: 0, crossOrigin: 0, frameInputs: 0 },
  custom: { total: 0, byLibrary: {} }, editButtons: 3, locked: 0, shadowHosts: 0 };

test("an empty page with an edit button tells the user to click 编辑 first and sends nothing to AI", async () => {
  const sent = [];
  const { helpers } = loadHighlightHelpers({
    formElements: [],
    fillProbe: { ...realProbe, probePage: () => LIEPIN_VIEW },
    sendMessage: async message => { sent.push(message); return { success: true, matches: [] }; }
  });
  helpers.setCurrentStore(STORE);
  const result = await helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  assert.equal(result.error, "当前页面没有可填写的表单字段。这个页面可能还在查看状态：请先点网页上的「编辑」，等输入框出现后再一键填写。");
  assert.equal(sent.filter(message => message.type === "AI_FILL").length, 0);
});

test("a probe that throws never blocks filling", async () => {
  const formElements = [];
  const boom = () => { throw new Error("boom"); };
  const { helpers, HTMLInputElement } = loadHighlightHelpers({
    formElements,
    fillProbe: { ...realProbe, probePage: boom, describeControl: boom, formatReport: boom },
    sendMessage: async () => ({ success: true, matches: [{ fieldId: "field-0", value: "测试用户" }] })
  });
  const input = new HTMLInputElement();
  formElements.push(input);
  helpers.setCurrentStore(STORE);
  const result = await helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  assert.equal(input.value, "测试用户");
  assert.equal(result.filledCount, 1);
});

test("diagnostics list the host and the structure of a field the page refused, never its value or path", async () => {
  const formElements = [];
  const { helpers, HTMLInputElement } = loadHighlightHelpers({
    formElements, fillProbe: realProbe,
    sendMessage: async () => ({ success: true, matches: [{ fieldId: "field-0", value: "本科" }] })
  });
  const input = new HTMLInputElement();
  input.name = "degree";
  // 页面不接受写入：值始终是空的。
  Object.defineProperty(input, "value", { get: () => "", set: () => {}, configurable: true });
  formElements.push(input);
  const text = { value: "" };
  const fill = { disabled: false };
  helpers.setShadowRoot({
    querySelectorAll: () => [],
    querySelector: selector => ({
      "#resume-pro-diagnostics": { hidden: true, open: false },
      "#resume-pro-diagnostics-text": text,
      "#resume-pro-ai-fill": fill
    })[selector] || null
  });
  helpers.setCurrentStore({ templates: [{ id: "one", groups: [{ name: "教育", fields: [{ key: "学历", value: "本科" }] }] }], activeTemplateId: "one" });
  await helpers.handleAiFillClick({ currentTarget: fill });
  assert.match(text.value, /页面：jobs\.example\.test/);
  assert.match(text.value, /没填上的字段（控件结构）：\n- degree：input\[text\]/);
  assert.ok(!text.value.includes("本科"));
  assert.ok(!text.value.includes("/apply"));
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `node --test tests/fill-probe-content.test.js`
Expected: 第 1、3 个测试 FAIL（错误信息里没有「编辑」提示；诊断里没有「页面：」行）。第 2 个此时应已 PASS（还没接入探测，不受影响）

- [ ] **Step 4: 实现**

1）`content.js` 第 1716 行 `const unfilledLabels = [];` 之后加两行：

```js
    const unfilledControls = [];
    let probe = null;
```

2）第 1729–1737 行，扫描之后立即探测，空页面时带上提示。改成：

```js
    try {
      const scanned = scanFillableFields();
      probe = withFillProbe(api => api.probePage(document, { href: location.href }), null);
      const fieldMap = scanned.fieldMap;
      const fields = assisted ? scanned.fields.filter(field => {
        const entry = fieldMap.get(field.fieldId);
        return entry?.kind === "element" && isAssistedTextField(entry) && assisted.scopes.some(scope => scope.contains(entry.element)) && !hasExistingValue(entry);
      }) : scanned.fields;
      fieldCount = fields.length;
      timing.scanMs = performance.now() - phaseStart;
      phase = null;
      if (!fields.length) {
        // 辅助新增只是过滤后为空，页面本身有字段：不给「先点编辑」这类提示。
        const hint = scanned.fields.length ? "" : withFillProbe(api => api.emptyPageHint(probe), "");
        throw new Error(`当前页面没有可填写的表单字段。${hint}`);
      }
```

3）第 1891–1895 行，没填上的字段同时记下控件结构：

```js
        } else {
          const label = fieldMeta?.label || fieldMeta?.placeholder || fieldMeta?.name || "未命名字段";
          const why = textFillFailureLabel(element);
          unfilledLabels.push(why ? `${label}（${why}）` : label);
          unfilledControls.push({ label, reason: why, control: withFillProbe(api => api.describeControl(element), null) });
        }
```

4）第 1946–1947 行：

```js
      const summaryInput = { ...timing, totalMs,
        fieldCount, filledCount, unfilledCount: unfilledLabels.length, outcome, diagnostics, probe, unfilledControls };
```

5）`formatFillDiagnostics` 返回数组的最后一项之后追加探测行：

```js
      `填写：${seconds(result.fillMs)}；总计：${seconds(result.totalMs)}`,
      ...withFillProbe(api => api.formatReport(result.probe || null, result.unfilledControls || []), [])
    ].join("\n");
  }
```

6）紧挨在 `function formatFillDiagnostics(result) {` 之前加：

```js
  // fill-probe.js 只读页面结构，给诊断和空页面提示用；它缺席或出错都不能影响填写。
  function withFillProbe(use, fallback) {
    try {
      const api = self.ResumeProFillProbe;
      return api ? use(api) ?? fallback : fallback;
    } catch {
      return fallback;
    }
  }
```

- [ ] **Step 5: 运行，确认通过**

```bash
node --test tests/fill-probe-content.test.js
npm test 2>&1 | tail -6
```

Expected: 3 个测试 PASS；全量 `fail 0`

- [ ] **Step 6: 提交**

```bash
git add content.js tests/helpers/content-harness.js tests/fill-probe-content.test.js
git commit -m "feat(fill): 填写诊断附上页面线索，空页面提示先点编辑 (#206)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 侧栏「复制诊断」按钮

**Files:**
- Modify: `sidepanel.html:175-178`
- Modify: `sidepanel.css:152`
- Modify: `sidepanel.js:42`、`sidepanel.js`（事件绑定区，约第 1302 行 `elements.fillButton.addEventListener` 附近）
- Modify: `tests/helpers/sidepanel-harness.js`（`openPanel`）
- Create: `tests/sidepanel-diagnostics.test.js`

- [ ] **Step 1: 让侧栏测试工具记录剪贴板写入**

`tests/helpers/sidepanel-harness.js` 的 `openPanel` 里：

在 `const toasts = [];` 下一行加：

```js
  const clipboardWrites = [];
```

把 `vm.createContext({` 里那行

```js
    navigator: { userAgent: USER_AGENTS[browser], clipboard: { writeText: async () => {} } },
```

改为：

```js
    navigator: { userAgent: USER_AGENTS[browser], clipboard: { writeText: async value => { clipboardWrites.push(value); } } },
```

在返回的 `panel` 对象里 `page, get, pageMessages, toasts,` 改为：

```js
    page, get, pageMessages, toasts, clipboardWrites,
```

- [ ] **Step 2: 写失败的测试**

`tests/sidepanel-diagnostics.test.js`：

```js
// #206：侧栏「填写诊断」一键复制，方便用户贴到反馈里。
const test = require("node:test");
const assert = require("node:assert/strict");
const { openPanel } = require("./helpers/sidepanel-harness.js");

test("the copy button copies the diagnostics text and confirms with a toast", async () => {
  const panel = await openPanel();
  panel.get("fill-diagnostics-text").value = "网申快填 v0.4.1\n页面：c.liepin.com";
  await panel.click("copy-diagnostics");
  assert.deepEqual(panel.clipboardWrites, ["网申快填 v0.4.1\n页面：c.liepin.com"]);
  assert.equal(panel.toast(), "填写诊断已复制，可以粘贴到反馈里。");
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `node --test tests/sidepanel-diagnostics.test.js`
Expected: FAIL，`get(id).listeners.click is not a function`（按钮还没绑定事件）

- [ ] **Step 4: 实现**

`sidepanel.html`：

```html
          <details id="fill-diagnostics" class="dock-diagnostics" hidden>
            <summary>填写诊断（不含简历内容）</summary>
            <textarea id="fill-diagnostics-text" readonly rows="9" aria-label="填写诊断摘要"></textarea>
            <button id="copy-diagnostics" class="dock-diagnostics-copy" type="button">复制诊断</button>
          </details>
```

`sidepanel.css` 第 152 行之后加：

```css
.dock-diagnostics-copy { margin-top: 6px; }
```

`sidepanel.js` 的 `elements` 里，`diagnosticsText` 下一行加：

```js
    copyDiagnostics: document.getElementById("copy-diagnostics"),
```

在 `elements.fillButton.addEventListener("click", ...)` 这段之前加：

```js
  elements.copyDiagnostics.addEventListener("click", async () => {
    toast(await copyFieldValue(elements.diagnosticsText.value)
      ? "填写诊断已复制，可以粘贴到反馈里。"
      : "复制失败，请手动选中诊断文字复制。");
  });
```

- [ ] **Step 5: 运行，确认通过**

```bash
node --test tests/sidepanel-diagnostics.test.js
npm test 2>&1 | tail -6
```

Expected: PASS；全量 `fail 0`

- [ ] **Step 6: 提交**

```bash
git add sidepanel.html sidepanel.css sidepanel.js tests/helpers/sidepanel-harness.js tests/sidepanel-diagnostics.test.js
git commit -m "feat(sidepanel): 填写诊断增加一键复制 (#206)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: “网站填不上”反馈模板

**Files:**
- Create: `.github/ISSUE_TEMPLATE/site-not-filling.yml`

- [ ] **Step 1: 新建模板**

```yaml
name: 网站填不上 / 填错
description: 某个网申网站一键填写失败、部分字段没填上或填错
title: "[网站兼容] "
body:
  - type: markdown
    attributes:
      value: |
        感谢反馈！提交前请遮住截图里的姓名、电话、邮箱等个人信息。「填写诊断」不含简历内容和完整网址，可以直接粘贴。
  - type: input
    id: site
    attributes:
      label: 网站域名
      description: 只填域名，例如 c.liepin.com、xxx.zhiye.com
    validations:
      required: true
  - type: dropdown
    id: symptom
    attributes:
      label: 遇到的情况
      options:
        - 提示“当前页面没有可填写的表单字段”
        - 部分字段没填上
        - 填上了但内容不对
        - 填上了但提交时网站仍提示必填或无效
        - AI 辅助新增条目失败
        - 其他
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: 卡在哪一步
      description: 例如：打开在线简历 → 点一键填写 → 提示没有可填写字段
    validations:
      required: true
  - type: textarea
    id: diagnostics
    attributes:
      label: 填写诊断
      description: 侧栏「填写诊断（不含简历内容）」里点「复制诊断」，粘贴到这里
      render: text
  - type: textarea
    id: screenshots
    attributes:
      label: 截图
      description: 直接拖进来，记得先遮住个人信息
  - type: input
    id: browser
    attributes:
      label: 浏览器与版本
      placeholder: Chrome 140 / Edge 140
```

- [ ] **Step 2: 校验 YAML 能解析**

Run: `node -e "const y=require('node:fs').readFileSync('.github/ISSUE_TEMPLATE/site-not-filling.yml','utf8'); if(!/^name: /m.test(y)||!/^body:/m.test(y)) process.exit(1); console.log('ok')"`
Expected: `ok`（合并后可在 GitHub “New issue” 页面确认模板出现）

- [ ] **Step 3: 提交**

```bash
git add .github/ISSUE_TEMPLATE/site-not-filling.yml
git commit -m "chore(github): 新增网站填不上的反馈模板 (#206)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 文档

**Files:**
- Modify: `docs/user-guide.md:147`、`docs/user-guide.md:202-206`
- Modify: `docs/desktop-mvp/data-privacy.md:370`
- Modify: `docs/extension-development.md:20`

- [ ] **Step 1: `docs/user-guide.md` 诊断说明**

把第 147 行：

```markdown
诊断摘要只包含版本、计数、字节数、耗时和标准错误类别，不包含接口地址、API Key、简历正文或上游错误原文。截图前仍需检查周围网页和模板中的个人信息。
```

替换为：

```markdown
诊断摘要包含版本、计数、字节数、耗时和标准错误类别，另附网站域名（不含路径和参数）、页面结构线索（内嵌框架、自定义控件、「编辑」按钮等的数量），以及没填上字段的字段名和控件结构（标签、类型、组件库）。字段名最多保留 16 个字，含 @ 或长串数字时隐藏。诊断不包含字段值、接口地址、API Key、简历正文或上游错误原文，只在本机显示；点「复制诊断」后由你决定发给谁。截图前仍需检查周围网页和模板中的个人信息。
```

- [ ] **Step 2: `docs/user-guide.md` 常见问题**

在 `### 字段填错或网站显示仍未填写` 这一节**之前**插入：

```markdown
### 提示“当前页面没有可填写的表单字段”

猎聘等网站的在线简历默认是查看状态，要先点网页上的「编辑」，等输入框出现后再一键填写。这类网站通常每块单独编辑、单独保存，需要一块一块填。插件检测到「编辑」按钮时会直接这样提示。表单在内嵌框架里或用了暂不支持的控件时，请按下一节的方式反馈。

```

并把该节最后一段：

```markdown
兼容性反馈请提供网站名称、页面类型、失败字段、错误提示、桌面与扩展版本，以及打码后的截图。可复现问题提交到 [GitHub Issues](https://github.com/TshyGO/resume-form-assistant-plugin/issues)，也可以先到[QQ 交流群](../README.md#-qq-交流群)交流。
```

替换为：

```markdown
兼容性反馈请提供网站域名、卡在哪一步、打码后的截图，以及侧栏「填写诊断」里点「复制诊断」得到的文字。可复现问题用 [GitHub Issues](https://github.com/TshyGO/resume-form-assistant-plugin/issues/new/choose) 的「网站填不上 / 填错」模板提交，也可以先到[QQ 交流群](../README.md#-qq-交流群)交流。
```

- [ ] **Step 3: `docs/desktop-mvp/data-privacy.md` §9**

把第 370 行：

```markdown
现有插件诊断 [`formatFillDiagnostics`](../../content.js) 已用错误类别 allowlist；桌面应对齐该纪律。
```

替换为：

```markdown
现有插件诊断 [`formatFillDiagnostics`](../../content.js) 已用错误类别 allowlist；桌面应对齐该纪律。插件诊断另附 [`fill-probe.js`](../../fill-probe.js) 的页面结构线索：只含 hostname、计数、标签名 / type / role / 组件库名，以及脱敏后的字段名（≤16 字，含 @ 或 5 位以上数字时隐藏），不含字段值、路径和参数、原始 class。
```

- [ ] **Step 4: `docs/extension-development.md` 文件清单**

在 `form-agent.js          受限新增计划、分组识别与执行检查` 下一行加：

```text
fill-probe.js          填写诊断的页面结构探测（只读结构，不读字段值）
```

- [ ] **Step 5: 跑全量，确认文档断言没被打破**

Run: `npm test 2>&1 | tail -6`
Expected: `fail 0`（仓库里有测试检查 README / 文档链接）

- [ ] **Step 6: 提交**

```bash
git add docs/user-guide.md docs/desktop-mvp/data-privacy.md docs/extension-development.md
git commit -m "docs: 说明填写诊断的新内容与“没有可填写字段”的处理 (#206)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 全量验证与 PR

- [ ] **Step 1: 全量自动检查**

```bash
npm test 2>&1 | tail -6
npm run typecheck
node desktop/scripts/check-plugin-release-allowlist.js
node --check fill-probe.js && node --check content.js && node --check sidepanel.js
git diff --check origin/main...HEAD
```

Expected: `fail 0`；typecheck 无输出；allowlist 输出 58 个运行文件；其余无输出

- [ ] **Step 2: 真机核对（维护者，5 分钟）**

在 Chrome 里「加载已解压的扩展程序」选中本分支目录（或重新加载已加载的开发版），打开猎聘在线简历页，**不点编辑**直接一键填写：
- 侧栏状态显示“……请先点网页上的「编辑」……”；
- 「填写诊断」里有 `页面：c.liepin.com` 和「编辑」按钮数量；
- 点「复制诊断」，粘贴出来的文字里没有姓名、电话等个人信息和完整网址。

再点某一块的「编辑」后一键填写，确认正常填写不受影响。

- [ ] **Step 3: 推送并开 PR**

```bash
git push -u origin feat/206-fill-diagnostics-probe
gh pr create --title "feat(fill): 填写诊断附上页面线索与控件结构，空页面提示先点编辑 (#206)" --body "$(cat <<'EOF'
## 概要

- 新增 `fill-probe.js`：只读页面结构（域名、内嵌框架、自定义控件及组件库、「编辑」按钮、只读输入框、Shadow DOM 计数），描述没填上字段的控件结构。
- 扫描到 0 个字段时按线索提示；猎聘在线简历会提示先点「编辑」。
- 侧栏「填写诊断」增加「复制诊断」。
- 新增“网站填不上 / 填错”issue 模板；更新用户指南、数据与隐私说明、开发文档。

## 隐私

诊断不含字段值、简历内容、完整网址、接口地址、Key、原始 class；字段名 ≤16 字，含 @ 或 5 位以上数字时隐藏。仍只在本机显示，由用户自己复制。

## 测试

- `npm test` 全部通过；新增 `tests/fill-probe.test.js`、`tests/fill-probe-content.test.js`、`tests/sidepanel-diagnostics.test.js`
- `npm run typecheck`、`node desktop/scripts/check-plugin-release-allowlist.js` 通过
- 猎聘在线简历真机核对：（填写结果）

Closes #206

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: 合并后在 QQ 群置顶反馈格式**

> 遇到网站填不上或填错，请发：① 网站域名 ② 卡在哪一步 ③ 截图（遮住个人信息）④ 侧栏「填写诊断」里点「复制诊断」后粘贴过来。
