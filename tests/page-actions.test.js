// #225 前置动作：真实的页面大纲 + 说明书校验 + page-actions 执行器，在 jsdom 合成页面上验证：
// 预览不点击；确认后逐个点击、等页面安静、核对确实出现新的输入框；目标被替换、文字变成禁止词、
// 没有变化、一直在变、页面改掉已有内容、停止和换页都立即停下，后面的动作一律不做。
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const fieldScan = require("../field-scan.js");
const outline = require("../page-outline.js");
const deep = require("../deep-analysis.js");
const agent = require("../form-agent.js");
const actions = require("../page-actions.js");

const isVisible = (el) => el.isConnected && !el.closest("[hidden], [style*='display: none'], [style*='display:none']");
const FAST = { quietMs: 40, maxMs: 400, pollMs: 5 };

function viewPage() {
  const dom = new JSDOM(`<!doctype html><body>
    <section id="basic"><h2>基本信息</h2><button type="button" id="edit-basic">编辑</button>
      <dl id="basic-view"><dt>姓名</dt><dd>林测试</dd><dt>现居城市</dt><dd>杭州</dd></dl></section>
    <section id="intent"><h2>求职意向</h2><button type="button" id="edit-intent">编辑</button>
      <label>期望城市<input id="city" value="上海"></label></section>
    <section id="more"><h2>自我评价</h2><a href="#" id="expand">展开</a><div id="more-body" hidden><textarea id="about"></textarea></div></section>
    <footer><a href="/resume/edit" id="leave">修改</a><button type="button" id="save">保存</button><button type="submit" id="submit">提交</button></footer>
  </body>`, { url: "https://jobs.example.test/resume" });
  const doc = dom.window.document;
  const clicks = [];
  doc.addEventListener("click", (event) => clicks.push(event.target.id || event.target.textContent), true);
  // 点「编辑」：查看态的文字换成输入框（网页常见的做法：整块重画）。
  doc.getElementById("edit-basic").addEventListener("click", () => {
    setTimeout(() => {
      doc.getElementById("basic-view").outerHTML = `<div id="basic-form"><label>姓名<input id="name"></label><label>现居城市<input id="home"></label></div>`;
    }, 20);
  });
  doc.getElementById("expand").addEventListener("click", () => { doc.getElementById("more-body").hidden = false; });
  return { dom, doc, clicks };
}

function analyse(doc, spec) {
  const built = outline.build(doc, { isVisible, fieldScan, resumeValues: ["林测试", "杭州"] });
  const refOf = (el) => [...built.nodes.entries()].find(([, node]) => node.element === el)?.[0];
  const resolve = (value) => (typeof value === "string" ? value : refOf(value));
  const raw = {
    pageState: spec.pageState || "viewing",
    preActions: (spec.preActions || []).map((action) => ({ ...action, ref: resolve(action.ref) })),
    sections: (spec.sections || []).map((section) => ({ ...section, addRef: resolve(section.addRef), rowRefs: (section.rowRefs || []).map(resolve) })),
    fields: []
  };
  const checked = deep.validateSpec(raw, { nodes: built.nodes, refs: new Set(built.parts.flatMap((part) => part.refs)), redact: built.redact });
  return { built, checked, refOf };
}

function plan(doc, built, spec, templateFields = [], extra = {}) {
  return actions.buildPlan({ spec, nodes: built.nodes, titles: built.titles, redact: built.redact, templateFields, formAgent: agent,
    deep, describe: outline.describeButton, isVisible, doc, timing: { add: { maxMs: 400, settleMs: 40, pollMs: 5 } }, ...extra });
}

function run(doc, built, planned, { stopped = () => "", onProgress } = {}) {
  return actions.executePlan(planned, { doc, deep, describe: outline.describeButton, isVisible, formAgent: agent, stopped, onProgress, timing: FAST });
}

test("the preview names each target as 区块：按钮 and clicks nothing; cross-page edits are only offered as manual steps", () => {
  const { doc, clicks } = viewPage();
  const { built, checked } = analyse(doc, { preActions: [
    { ref: doc.getElementById("edit-basic"), kind: "edit" },
    { ref: doc.getElementById("leave"), kind: "edit" }] });
  assert.equal(checked.ok, true, "a cross-page 修改 does not void the spec (#224 rule)");
  const planned = plan(doc, built, checked.spec);
  assert.deepEqual(planned.items.map((item) => item.label), ["基本信息：编辑"]);
  assert.equal(planned.manual.length, 1);
  assert.match(planned.manual[0], /可能会打开新页面，请手动点击/);
  assert.deepEqual(clicks, [], "building the preview never clicks");
});

test("forbidden words, submit buttons and cross-site links never reach a plan", () => {
  const { doc } = viewPage();
  doc.body.insertAdjacentHTML("beforeend", `<a href="https://elsewhere.example/edit" id="far">编辑</a>`);
  for (const id of ["save", "submit", "far"]) {
    const { checked } = analyse(doc, { preActions: [{ ref: doc.getElementById(id), kind: "edit" }] });
    assert.equal(checked.ok, false, id);
    assert.equal(checked.reason, "forbidden_action", id);
  }
});

test("the live check refuses targets that became unsafe: disabled, hidden, new window, forbidden text, submit", () => {
  const { doc } = viewPage();
  const ctx = { deep, describe: outline.describeButton, isVisible, doc };
  const edit = doc.getElementById("edit-basic");
  assert.equal(actions.targetAllowed(edit, "edit", ctx), true);
  edit.disabled = true;
  assert.equal(actions.targetAllowed(edit, "edit", ctx), false);
  edit.disabled = false;
  edit.setAttribute("aria-disabled", "true");
  assert.equal(actions.targetAllowed(edit, "edit", ctx), false);
  edit.removeAttribute("aria-disabled");
  edit.textContent = "删除";
  assert.equal(actions.targetAllowed(edit, "edit", ctx), false);
  edit.textContent = "编辑";
  edit.setAttribute("type", "submit");
  doc.getElementById("basic").insertAdjacentHTML("afterbegin", "<form id='f'></form>");
  doc.getElementById("f").append(edit);
  assert.equal(actions.targetAllowed(edit, "edit", ctx), false);
  const expand = doc.getElementById("expand");
  expand.setAttribute("target", "_blank");
  assert.equal(actions.targetAllowed(expand, "expand", ctx), false);
  expand.removeAttribute("target");
  doc.getElementById("more").hidden = true;
  assert.equal(actions.targetAllowed(expand, "expand", ctx), false);
  assert.equal(actions.targetAllowed(edit.cloneNode(true), "edit", ctx), false, "a detached copy is not the target");
});

test("confirmed edit: one click, wait until the page settles and new inputs exist, keep existing values", async () => {
  const { doc, clicks } = viewPage();
  const { built, checked } = analyse(doc, { preActions: [{ ref: doc.getElementById("edit-basic"), kind: "edit" }] });
  const planned = plan(doc, built, checked.spec);
  const progress = [];
  const result = await run(doc, built, planned, { onProgress: (step) => progress.push(step) });
  assert.equal(result.ok, true, result.code);
  assert.deepEqual(result.done, { edit: 1, expand: 0, add: 0 });
  assert.deepEqual(clicks, ["edit-basic"]);
  assert.ok(doc.getElementById("name"), "the edit form is there");
  assert.equal(doc.getElementById("city").value, "上海", "an existing value is untouched");
  assert.deepEqual(progress.map((step) => [step.index, step.total, step.label]), [[1, 1, "基本信息：编辑"]]);
});

test("expand reveals hidden inputs; a 「#」 link never changes the address", async () => {
  const { dom, doc } = viewPage();
  const { built, checked } = analyse(doc, { preActions: [{ ref: doc.getElementById("expand"), kind: "expand" }] });
  const planned = plan(doc, built, checked.spec);
  let prevented = null;
  doc.getElementById("expand").addEventListener("click", (event) => { prevented = event.defaultPrevented; });
  const result = await run(doc, built, planned);
  assert.equal(result.ok, true, result.code);
  assert.equal(prevented, true);
  assert.equal(dom.window.location.href, "https://jobs.example.test/resume");
});

test("a click that changes nothing stops the run; later actions are not clicked", async () => {
  const { doc, clicks } = viewPage();
  const { built, checked } = analyse(doc, { preActions: [
    { ref: doc.getElementById("edit-intent"), kind: "edit" },
    { ref: doc.getElementById("edit-basic"), kind: "edit" }] });
  const result = await run(doc, built, plan(doc, built, checked.spec));
  assert.equal(result.ok, false);
  assert.equal(result.code, "no_change");
  assert.deepEqual(clicks, ["edit-intent"], "no second click after a click that did nothing");
});

test("a page that keeps changing without new inputs times out and stops", async () => {
  const { doc, dom, clicks } = viewPage();
  const button = doc.getElementById("edit-intent");
  let timer = null;
  button.addEventListener("click", () => { timer = dom.window.setInterval(() => doc.body.toggleAttribute("data-busy"), 10); });
  const { built, checked } = analyse(doc, { preActions: [{ ref: button, kind: "edit" }, { ref: doc.getElementById("edit-basic"), kind: "edit" }] });
  const result = await run(doc, built, plan(doc, built, checked.spec));
  dom.window.clearInterval(timer);
  assert.equal(result.code, "timeout");
  assert.deepEqual(clicks, ["edit-intent"]);
});

test("a confirmed plan does not act on a replaced button or one whose text became a forbidden word", async () => {
  for (const change of ["replace", "rename"]) {
    const { doc, clicks } = viewPage();
    const button = doc.getElementById("edit-basic");
    const { built, checked } = analyse(doc, { preActions: [{ ref: button, kind: "edit" }] });
    const planned = plan(doc, built, checked.spec);
    if (change === "replace") button.replaceWith(button.cloneNode(true));
    else button.textContent = "删除";
    const result = await run(doc, built, planned);
    assert.equal(result.code, "target_changed", change);
    assert.deepEqual(clicks, [], `${change}: nothing is clicked`);
  }
});

test("a later target that changes after the first click stops before it is clicked", async () => {
  const { doc, clicks } = viewPage();
  const second = doc.getElementById("expand");
  doc.getElementById("edit-basic").addEventListener("click", () => setTimeout(() => { second.textContent = "提交"; }, 5));
  const { built, checked } = analyse(doc, { preActions: [{ ref: doc.getElementById("edit-basic"), kind: "edit" }, { ref: second, kind: "expand" }] });
  const result = await run(doc, built, plan(doc, built, checked.spec));
  assert.equal(result.code, "target_changed");
  assert.deepEqual(result.done, { edit: 1, expand: 0, add: 0 });
  assert.deepEqual(clicks, ["edit-basic"]);
});

test("stop and address changes end the run at once: during the wait and before the next click", async () => {
  for (const reason of ["stopped", "navigated"]) {
    const { doc, clicks } = viewPage();
    const { built, checked } = analyse(doc, { preActions: [{ ref: doc.getElementById("edit-basic"), kind: "edit" }, { ref: doc.getElementById("expand"), kind: "expand" }] });
    let flag = "";
    doc.getElementById("edit-basic").addEventListener("click", () => { flag = reason; });
    const result = await run(doc, built, plan(doc, built, checked.spec), { stopped: () => flag });
    assert.equal(result.code, reason);
    assert.deepEqual(clicks, ["edit-basic"], `${reason}: the second action is never clicked`);
  }
});

test("a click that rewrites a field the page already had stops the run", async () => {
  const { doc } = viewPage();
  doc.getElementById("edit-intent").addEventListener("click", () => {
    doc.getElementById("city").value = "北京";
    doc.getElementById("intent").insertAdjacentHTML("beforeend", "<input id='extra'>");
  });
  const { built, checked } = analyse(doc, { preActions: [{ ref: doc.getElementById("edit-intent"), kind: "edit" }] });
  const result = await run(doc, built, plan(doc, built, checked.spec));
  assert.equal(result.code, "values_changed");
});

test("actions run one at a time: the second click waits for the first one's inputs to settle", async () => {
  const { doc, clicks } = viewPage();
  const log = [];
  doc.getElementById("edit-basic").addEventListener("click", () => log.push("click basic"));
  const observer = new doc.defaultView.MutationObserver(() => { if (doc.getElementById("name") && !log.includes("form")) log.push("form"); });
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.getElementById("expand").addEventListener("click", () => log.push("click expand"));
  const { built, checked } = analyse(doc, { preActions: [{ ref: doc.getElementById("edit-basic"), kind: "edit" }, { ref: doc.getElementById("expand"), kind: "expand" }] });
  const result = await run(doc, built, plan(doc, built, checked.spec));
  observer.disconnect();
  assert.equal(result.ok, true, result.code);
  assert.deepEqual(log, ["click basic", "form", "click expand"]);
  assert.deepEqual(clicks, ["edit-basic", "expand"]);
});

test("more than five pre-actions void the spec, so nothing beyond five can ever be planned", () => {
  const { doc } = viewPage();
  for (let i = 0; i < 6; i++) doc.body.insertAdjacentHTML("beforeend", `<button type="button" id="e${i}">编辑</button>`);
  const { checked } = analyse(doc, { preActions: [0, 1, 2, 3, 4, 5].map((i) => ({ ref: doc.getElementById(`e${i}`), kind: "edit" })) });
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, "too_many_actions");
});

test("the hover highlight restores the element's own inline outline, even an !important one", () => {
  const { doc } = viewPage();
  const button = doc.getElementById("edit-basic");
  button.style.setProperty("outline", "1px dotted red", "important");
  const light = actions.createHighlighter();
  light.show(button);
  assert.match(button.style.getPropertyValue("outline"), /3px solid/);
  light.clear();
  assert.equal(button.style.getPropertyValue("outline"), "1px dotted red");
  assert.equal(button.style.getPropertyPriority("outline"), "important");
  assert.equal(button.style.getPropertyValue("outline-offset"), "");
  assert.equal(light.active(), false);
});

// --- 北森类经历分组（#195）：div 布局，条目不用 fieldset，「＋ 添加」是带手形光标的 div ----------------------

const ROW = (title, n) => `<div class="sc-entry kQx"><div class="sc-entry-head">${title} ${n}<span class="sc-del" style="cursor:pointer">删除</span></div>
  <div class="ux-standard-form"><div class="fields-col"><div class="form-item"><label class="form-item__text">名称</label><input type="text" placeholder="请输入"></div></div>
  <div class="fields-col"><div class="form-item"><label class="form-item__text">开始时间</label><div class="bs-date-picker"><input type="text" readonly placeholder="请选择日期"></div></div></div>
  <div class="fields-col"><div class="form-item"><label class="form-item__text">描述</label><textarea placeholder="请输入"></textarea></div></div></div></div>`;

function beisenPage({ education = 1, work = 2, papers = 0 } = {}) {
  const section = (id, title, count) => `<div class="sc-sec eSN" id="${id}"><div class="sc-sec-title">${title}</div>
    <div class="sc-sec-body"><div class="sc-list">${Array.from({ length: count }, (_, i) => ROW(title, i + 1)).join("")}</div>
    <div class="sc-add" style="cursor:pointer" id="${id}-add"><i class="icon-plus"></i><span>＋ 添加</span></div></div></div>`;
  const dom = new JSDOM(`<!doctype html><body><div id="app">
    ${section("edu", "教育经历", education)}${section("work", "实习经历", work)}${section("papers", "论文/专著", papers)}
    <button type="button" id="save">保存</button></div></body>`, { url: "https://example.zhiye.test/apply" });
  const doc = dom.window.document;
  const clicks = [];
  const behaviour = { edu: "add", work: "add", papers: "add" };
  for (const id of ["edu", "work", "papers"]) {
    const title = doc.querySelector(`#${id} .sc-sec-title`).textContent;
    doc.getElementById(`${id}-add`).addEventListener("click", () => {
      clicks.push(id);
      const list = doc.querySelector(`#${id} .sc-list`);
      const mode = behaviour[id];
      setTimeout(() => {
        if (mode === "add" || mode === "change") list.insertAdjacentHTML("beforeend", ROW(title, list.children.length + 1));
        if (mode === "many") list.insertAdjacentHTML("beforeend", ROW(title, 8) + ROW(title, 9));
        if (mode === "change") list.querySelector("input").value = "网页改写";
        if (mode === "outside") doc.body.insertAdjacentHTML("beforeend", ROW(title, 1));
      }, 10);
    });
  }
  return { dom, doc, clicks, behaviour };
}

const firstInputs = (doc, id) => Array.from(doc.querySelectorAll(`#${id} .sc-entry`)).map((row) => row.querySelector("input"));
const records = (group, count, col = "名称") => Array.from({ length: count }, (_, i) => ({ group, key: `${group}${i + 1}${col}`, value: `虚构${group}${i + 1}` }));

function beisenSpec(doc, ids = ["edu", "work", "papers"]) {
  const domainOf = { edu: "education", work: "work", papers: "papers" };
  return { pageState: "editing", sections: ids.map((id) => ({ domain: domainOf[id], addRef: doc.getElementById(`${id}-add`), rowRefs: firstInputs(doc, id) })) };
}

test("the outline lists a Beisen-style 「＋ 添加」 div as a button; plain text with the same word is not a button", () => {
  const { doc } = beisenPage();
  doc.body.insertAdjacentHTML("beforeend", "<p>添加</p>");
  const built = outline.build(doc, { isVisible, fieldScan });
  const buttons = [...built.nodes.values()].filter((node) => node.type === "button");
  assert.deepEqual(buttons.filter((node) => /添加/.test(node.text)).map((node) => node.element.id), ["edu-add", "work-add", "papers-add"]);
  assert.ok(buttons.every((node) => node.element.tagName !== "P"));
  assert.match(built.parts[0].text, /button "＋ 添加"/);
});

test("Beisen-style groups: the plugin counts rows itself and previews 教育经历：添加 ×1 without clicking", () => {
  const { doc, clicks } = beisenPage();
  const { built, checked } = analyse(doc, beisenSpec(doc));
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const template = [...records("教育经历", 2), ...records("实习经历", 2), ...records("论文", 1, "标题")];
  const planned = plan(doc, built, checked.spec, template);
  assert.deepEqual(planned.items.map((item) => item.label), ["论文：添加 ×1", "教育经历：添加 ×1"]);
  assert.deepEqual(planned.blocked, []);
  assert.deepEqual(clicks, []);
});

test("one click adds exactly one row per step; existing rows keep their values; new rows become the fill scopes", async () => {
  const { doc, clicks } = beisenPage();
  firstInputs(doc, "edu")[0].value = "虚构大学";
  const { built, checked } = analyse(doc, beisenSpec(doc));
  const planned = plan(doc, built, checked.spec, [...records("教育经历", 2), ...records("论文", 2, "标题")]);
  assert.deepEqual(planned.items.map((item) => item.label), ["论文：添加 ×2", "教育经历：添加 ×1"]);
  const result = await run(doc, built, planned);
  assert.equal(result.ok, true, `${result.code} ${result.message}`);
  assert.deepEqual(result.done, { edit: 0, expand: 0, add: 3 });
  assert.deepEqual(clicks, ["papers", "papers", "edu"]);
  assert.equal(doc.querySelectorAll("#papers .sc-entry").length, 2);
  assert.equal(doc.querySelectorAll("#edu .sc-entry").length, 2);
  assert.equal(firstInputs(doc, "edu")[0].value, "虚构大学");
  assert.equal(result.scopes.length, 3);
  // 填写范围只含新条目：原有的输入框不在任何一个范围里。
  const original = firstInputs(doc, "edu")[0];
  assert.ok(result.scopes.every((scope) => scope.querySelector("input") && !scope.contains(original)));
});

test("a group that already has two rows is counted from its sibling rows", async () => {
  const { doc, clicks } = beisenPage({ work: 2 });
  const { built, checked } = analyse(doc, beisenSpec(doc, ["work"]));
  const planned = plan(doc, built, checked.spec, records("实习经历", 3));
  assert.deepEqual(planned.items.map((item) => item.label), ["工作经历：添加 ×1"]);
  const result = await run(doc, built, planned);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(clicks, ["work"]);
});

test("rows the model left out make the group uncountable: no add, the user is told", () => {
  const { doc, clicks } = beisenPage({ work: 2 });
  const spec = beisenSpec(doc, ["work"]);
  spec.sections[0].rowRefs = spec.sections[0].rowRefs.slice(0, 1);
  const { built, checked } = analyse(doc, spec);
  const planned = plan(doc, built, checked.spec, records("实习经历", 3));
  assert.deepEqual(planned.items, []);
  assert.match(planned.blocked.join(), /工作经历在网页上的已有条目无法可靠计数/);
  assert.deepEqual(clicks, []);
});

test("two rows at once, no row, a row outside the group, or a rewritten field: stop, never click again, report what was added", async () => {
  const cases = [
    ["many", /一次新增了多个条目/, 2],
    ["none", /未确认出现新条目/, 0],
    ["outside", /未确认出现新条目/, 0],
    ["change", /改变了已有字段/, 1]
  ];
  for (const [mode, message, added] of cases) {
    const { doc, clicks, behaviour } = beisenPage({ education: 1 });
    behaviour.edu = mode;
    const { built, checked } = analyse(doc, beisenSpec(doc, ["edu"]));
    const planned = plan(doc, built, checked.spec, records("教育经历", 3));
    const result = await run(doc, built, planned);
    assert.equal(result.ok, false, mode);
    assert.equal(result.code, "add_failed", mode);
    assert.match(result.message, message, mode);
    assert.equal(result.done.add, added, mode);
    assert.deepEqual(clicks, ["edu"], `${mode}: only one click`);
  }
});

test("more than five rows in total: nothing is added and nothing is silently cut", () => {
  const { doc, clicks } = beisenPage({ education: 1, papers: 0 });
  const { built, checked } = analyse(doc, beisenSpec(doc, ["edu", "papers"]));
  const planned = plan(doc, built, checked.spec, [...records("教育经历", 4), ...records("论文", 3, "标题")]);
  assert.deepEqual(planned.items, []);
  assert.match(planned.blocked.join(), /需要新增 6 条，超过每次 5 条的上限/);
  assert.deepEqual(clicks, []);
});

test("two groups claiming the same experience type are ambiguous; with an edit in the same round, adds wait for the next analysis", () => {
  const { doc } = beisenPage();
  const spec = beisenSpec(doc, ["edu", "work"]);
  spec.sections[1].domain = "education";
  const { built, checked } = analyse(doc, spec);
  const planned = plan(doc, built, checked.spec, records("教育经历", 4));
  assert.deepEqual(planned.items, []);
  assert.match(planned.blocked.join(), /教育经历在网页上对应不止一个分组/);

  const view = beisenPage();
  view.doc.body.insertAdjacentHTML("afterbegin", `<section><h2>基本信息</h2><button type="button" id="edit">编辑</button></section>`);
  const both = { ...beisenSpec(view.doc, ["edu"]), preActions: [{ ref: view.doc.getElementById("edit"), kind: "edit" }] };
  const analysed = analyse(view.doc, both);
  const deferred = plan(view.doc, analysed.built, analysed.checked.spec, records("教育经历", 2));
  assert.deepEqual(deferred.items.map((item) => item.kind), ["edit"]);
  assert.match(deferred.blocked.join(), /完成后再点一次「深度分析本页」来新增/);
});

test("a spec that reuses one add button for two groups, or one row for two groups, is void", () => {
  const { doc } = beisenPage();
  const shared = beisenSpec(doc, ["edu", "work"]);
  shared.sections[1].addRef = shared.sections[0].addRef;
  assert.equal(analyse(doc, shared).checked.reason, "duplicate_ref");
  const rows = beisenSpec(doc, ["edu", "work"]);
  rows.sections[1].rowRefs = [...rows.sections[1].rowRefs, rows.sections[0].rowRefs[0]];
  assert.equal(analyse(doc, rows).checked.reason, "duplicate_ref");
});

test("a stop right after an add click still reports the row the page added", async () => {
  const { doc, clicks } = beisenPage({ education: 1 });
  const { built, checked } = analyse(doc, beisenSpec(doc, ["edu"]));
  const planned = plan(doc, built, checked.spec, records("教育经历", 3));
  let flag = "";
  doc.getElementById("edu-add").addEventListener("click", () => setTimeout(() => { flag = "stopped"; }, 25));
  const result = await run(doc, built, planned, { stopped: () => flag });
  assert.equal(result.code, "stopped");
  assert.equal(result.done.add, 1, "the row that appeared is counted, not hidden");
  assert.deepEqual(clicks, ["edu"]);
});
