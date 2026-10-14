// #226 站点配方：网址归类、插件生成的定位信息、唯一定位与过期判定、动作复用、保存条件和本机存储。
// 页面用 jsdom 合成，大纲和字段扫描都是真实模块（page-outline.js、field-scan.js），不是替身。
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const fieldScan = require("../field-scan.js");
const outline = require("../page-outline.js");
const deep = require("../deep-analysis.js");
const agent = require("../form-agent.js");
const actions = require("../page-actions.js");
const recipes = require("../page-recipe.js");

const RESUME = ["林测试", "13800138000", "lin@example.test", "杭州", "浙江测试大学"];
const isVisible = (el) => el.isConnected && !el.closest("[hidden]");
const FAST = { quietMs: 40, maxMs: 400, pollMs: 5 };

function page(body, url = "https://jobs.example.test/apply/123456?from=mail#top") {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { url });
  return { dom, doc: dom.window.document };
}
const build = (doc, resumeValues = RESUME) => outline.build(doc, { isVisible, fieldScan, resumeValues });
const refOf = (built, el) => [...built.nodes.entries()].find(([, node]) => node.element === el)?.[0];
// 「深度分析」的说明书：给哪些控件，就按大纲里它们的题目当作模型给的 label（测试不调用模型）。
function specFor(built, elements, extra = {}) {
  return elements.map((el) => {
    const ref = refOf(built, el);
    const node = built.nodes.get(ref);
    return { ref, label: extra.label?.(el) || node.control.label || "题目", group: built.titles.get(ref) || "", groupIndex: null,
      control: node.domKind, hints: {} };
  });
}
function saveFrom(doc, elements, options = {}) {
  const built = build(doc);
  const result = recipes.buildRecipe({ fields: specFor(built, elements, options), outline: built, tier: "strong", now: 1000, ...options.more });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.recipe;
}
const elementsOf = (built, entries) => entries.map((entry) => built.nodes.get(entry.ref).element);

const BASIC = `<form>
  <section><h2>基本信息</h2>
    <div class="row"><span>姓名</span><input id="name" name="name"></div>
    <div class="row"><label for="phone-8812733">手机号码</label><input id="phone-8812733" placeholder="请输入"></div>
    <div class="row"><label>邮箱<input id="mail" name="email"></label></div>
    <div class="row"><label>现居城市<select id="city"><option>请选择</option><option>杭州</option></select></label></div>
  </section>
  <section><h2>教育经历</h2>
    <div class="edu"><label>学校名称<input class="school"></label><label>专业<input class="major"></label></div>
    <div class="edu"><label>学校名称<input class="school"></label><label>专业<input class="major"></label></div>
  </section>
  <section><h2>工作经历</h2>
    <div class="job"><label>学校名称<input class="trap"></label><label>公司<input class="company"></label></div>
  </section>
</form>`;
const all = (doc) => Array.from(doc.querySelectorAll("input, select"));

// ---- 网页归类 ----------------------------------------------------------------

test("page key: hostname + normalised path; long numbers, UUIDs and hex ids become *, query and hash are dropped", () => {
  const key = recipes.pageKey("https://Jobs.Example.test/apply/2024123/9f1c2b3a-1111-4222-8333-444455556666/0123456789abcdef01/step?token=abc#me");
  assert.deepEqual(key, { ok: true, host: "jobs.example.test", path: "/apply/*/*/*/step" });
  assert.deepEqual(recipes.pageKey("https://jobs.example.test/apply/12/form/"), { ok: true, host: "jobs.example.test", path: "/apply/12/form" });
  assert.equal(recipes.pageKey("https://jobs.example.test/").path, "/");
  // 两个网站不会因为路径一样就算同一类。
  assert.notEqual(recipes.pageKey("https://a.example.test/apply").host, recipes.pageKey("https://b.example.test/apply").host);
  for (const href of ["file:///tmp/a.html", "chrome-extension://abc/popup.html", "about:blank", "not a url", "https://user:pw@x.example.test/a"]) {
    assert.equal(recipes.pageKey(href).ok, false, href);
  }
});

test("page key: a path that may carry personal data is not classified, so nothing is saved for it", () => {
  for (const href of [
    "https://jobs.example.test/u/lin@example.test/apply",
    "https://jobs.example.test/u/u13800138000/apply",
    "https://jobs.example.test/resume/abcDEF123ghiJKL456mnoPQR789/edit",
    "https://jobs.example.test/apply/%E0%A4%A",
    "https://jobs.example.test/a/b/c/d/e/f/g/h/i/j/k/l/m"
  ]) assert.deepEqual(recipes.pageKey(href), { ok: false, reason: "path_unsafe" }, href);
  // 和简历内容重叠的路径段：带上同一套脱敏时不归类。
  const redact = outline.createRedactor(["linceshi"]);
  assert.equal(recipes.pageKey("https://jobs.example.test/p/linceshi/apply").ok, true);
  assert.equal(recipes.pageKey("https://jobs.example.test/p/linceshi/apply", { redact }).reason, "path_unsafe");
});

test("random-looking ids and names are never used as anchors", () => {
  for (const token of ["phone-8812733", "rc_select_3", "el-id-12-34", ":r1:", "react-select-2-input", "a3f9c2d17b", "field_9f86d081884c",
    "x1y2z3abcdef", "mui-12", "ember412"]) assert.equal(recipes.stableToken(token), "", token);
  for (const token of ["name", "email", "edu_school_1", "form[education][0][school]", "address2line"]) assert.equal(recipes.stableToken(token), token, token);
});

// ---- 生成与定位 --------------------------------------------------------------

test("a recipe keeps structure only: no values, no resume text, no URL, no selectors", () => {
  const { doc } = page(BASIC);
  doc.getElementById("name").value = "林测试";
  doc.getElementById("mail").value = "lin@example.test";
  const recipe = saveFrom(doc, all(doc));
  const text = JSON.stringify(recipe);
  for (const secret of [...RESUME, "jobs.example.test", "token", "from=mail", "#top", "querySelector", "8812733"]) {
    assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
  }
  assert.deepEqual(Object.keys(recipe).sort(), ["created", "fields", "fp", "tier", "updated", "used", "v"]);
  assert.match(recipe.fp, /^[0-9a-f]{16}$/);
  assert.ok(recipes.encodedBytes(recipe) < recipes.MAX_RECIPE_BYTES);
  // 标签和简历内容重叠时不进配方（这一题只能靠别的稳定特征找）。
  const { doc: doc2 } = page(`<form><h2>基本信息</h2><label>林测试的手机<input name="mobile"></label><label>邮箱<input name="email"></label></form>`);
  const recipe2 = saveFrom(doc2, all(doc2), { label: (el) => (el.name === "mobile" ? "手机" : "") });
  assert.ok(!JSON.stringify(recipe2).includes("林测试"));
  assert.equal(recipe2.fields[0].loc.n, "mobile");
});

test("the same page locates every field uniquely; repeated rows are told apart by their order inside the group", () => {
  const { doc } = page(BASIC);
  const recipe = saveFrom(doc, all(doc));
  const built = build(doc);
  const found = recipes.locateFields(recipe, built);
  assert.equal(found.ok, true);
  assert.equal(found.located, all(doc).length);
  assert.deepEqual(elementsOf(built, found.entries), all(doc));
  assert.equal(found.sameStructure, true);
  // 交给填写流程的字段和说明书同形，题目、分组、控件类型都在。
  const spec = recipes.toSpecFields(found.entries);
  assert.deepEqual(Object.keys(spec[0]).sort(), ["control", "group", "groupIndex", "hints", "label", "ref"]);
  assert.equal(spec.find((field) => field.label === "现居城市").control, "native-select");
});

test("a re-render with new random ids still finds the fields by label; a same-named field in another group is never borrowed", () => {
  const { doc } = page(BASIC);
  const recipe = saveFrom(doc, all(doc));
  const { doc: next } = page(BASIC.replace(/phone-8812733/g, "phone-5521907"));
  const built = build(next);
  const found = recipes.locateFields(recipe, built);
  assert.equal(found.ok, true);
  assert.ok(elementsOf(built, found.entries).includes(next.getElementById("phone-5521907")));
  // 「工作经历」里也有一题叫「学校名称」：教育经历的两题只落在教育经历里。
  const schools = found.entries.filter((entry) => entry.field.loc.t === "学校名称" && entry.field.loc.sec === "教育经历");
  assert.deepEqual(elementsOf(built, schools), Array.from(next.querySelectorAll(".school")));
  const trap = found.entries.find((entry) => built.nodes.get(entry.ref).element === next.querySelector(".trap"));
  assert.equal(trap.field.loc.sec, "工作经历");
});

test("a similar URL with a different form is judged stale and not filled from the recipe", () => {
  const { doc } = page(BASIC);
  const recipe = saveFrom(doc, all(doc));
  const { doc: other } = page(`<form><h2>投递问卷</h2><label>期望薪资<input name="salary"></label><label>到岗时间<input name="start"></label></form>`);
  const found = recipes.locateFields(recipe, build(other));
  assert.equal(found.ok, false);
  assert.equal(found.located, 0);
});

test("ties are never guessed: equal-scoring different controls are ambiguous, and two recipe fields on one control both fail", () => {
  const { doc } = page(`<form><h2>补充信息</h2>
    <label>备注<input name="note"></label><label>说明<input name="memo"></label></form>`);
  const recipe = saveFrom(doc, all(doc));
  // 下次网页上两题都叫「备注」，而且 name 都不见了：保存时只有一个「备注」，现在出现同名的两个，不猜。
  const { doc: next } = page(`<form><h2>补充信息</h2><label>备注<input class="a"></label><label>备注<input class="b"></label></form>`);
  const found = recipes.locateFields({ ...recipe, fields: [recipe.fields[0]] }, build(next));
  assert.equal(found.located, 0);
  assert.equal(found.ambiguous, 1);
  // 两条配方字段（手工改出来的）指向同一个控件：两条都不算找到。
  const twin = { ...recipe, fields: [recipe.fields[0], { ...recipe.fields[0], label: "另一题" }] };
  const found2 = recipes.locateFields(twin, build(doc));
  assert.equal(found2.located, 0);
  assert.equal(found2.ambiguous, 2);
});

test("a control whose label changed is a conflict, not a weaker match", () => {
  const { doc } = page(`<form><h2>基本信息</h2><label>姓名<input name="name"></label></form>`);
  const recipe = saveFrom(doc, all(doc));
  const { doc: next } = page(`<form><h2>基本信息</h2><label>英文名<input name="name"></label></form>`);
  assert.equal(recipes.locateFields(recipe, build(next)).located, 0);
});

test("thresholds: at least 80% located and at most 5 failures", () => {
  const rows = (n, prefix = "题") => Array.from({ length: n }, (_, i) => `<label>${prefix}${String.fromCharCode(0x4e00 + i)}<input name="f${i}"></label>`).join("");
  const make = (n) => page(`<form><h2>问卷</h2>${rows(n)}</form>`).doc;
  const drop = (doc, count) => { for (const input of all(doc).slice(0, count)) input.closest("label").remove(); return doc; };
  const ten = make(10);
  const recipe10 = saveFrom(ten, all(ten));
  assert.equal(recipes.locateFields(recipe10, build(drop(make(10), 2))).ok, true, "8/10 = 80% is enough");
  assert.equal(recipes.locateFields(recipe10, build(drop(make(10), 3))).ok, false, "7/10 is not");
  const thirty = make(30);
  const recipe30 = saveFrom(thirty, all(thirty));
  assert.equal(recipes.locateFields(recipe30, build(drop(make(30), 5))).ok, true, "5 failures out of 30 is allowed");
  const six = recipes.locateFields(recipe30, build(drop(make(30), 6)));
  assert.equal(six.located / six.total >= 0.8, true);
  assert.equal(six.ok, false, "6 failures is too many even at 80%");
});

test("open Shadow DOM and same-origin iframes are separate scopes: no field is matched across them", () => {
  const { dom, doc } = page(`<form><h2>基本信息</h2><label>姓名<input id="top-name" name="name"></label></form><x-card id="card"></x-card><iframe id="frame"></iframe>`);
  const host = doc.getElementById("card");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<h2>附加信息</h2><label>姓名<input id="shadow-name" name="name"></label>`;
  const frameDoc = doc.getElementById("frame").contentDocument;
  frameDoc.body.innerHTML = `<h2>基本信息</h2><label>姓名<input id="frame-name" name="name"></label>`;
  const targets = [doc.getElementById("top-name"), shadow.getElementById("shadow-name"), frameDoc.getElementById("frame-name")];
  const recipe = saveFrom(doc, targets);
  assert.deepEqual(recipe.fields.map((field) => field.loc.s), ["", "s:x-card#card", "f:iframe#frame:0"]);
  const built = build(doc);
  const found = recipes.locateFields(recipe, built);
  assert.deepEqual(elementsOf(built, found.entries), targets);
  // 只剩主文档那一题：框架和 Shadow DOM 的字段不会跑到主文档去找。
  const lone = { ...recipe, fields: recipe.fields.slice(1) };
  shadow.innerHTML = "";
  frameDoc.body.innerHTML = "";
  const after = build(doc);
  assert.equal(recipes.locateFields(lone, after).located, 0);
  dom.window.close();
});

test("fields with no reliable clue (only a generic placeholder) are not saved; too few re-findable fields means no recipe", () => {
  const { doc } = page(`<form><h2>补充</h2><input placeholder="请输入"><input placeholder="请输入"><label>邮箱<input name="email"></label></form>`);
  const built = build(doc);
  const result = recipes.buildRecipe({ fields: specFor(built, all(doc), { label: () => "模型起的题目" }), outline: built, now: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_locatable_fields");
});

test("rows added this time are picked up as the next group index of the same question", () => {
  const { doc } = page(`<form><section><h2>教育经历</h2><div id="rows"><div class="edu"><label>学校名称<input class="school"></label></div></div></section></form>`);
  const built0 = build(doc);
  const recipe = recipes.buildRecipe({ fields: specFor(built0, all(doc)).map((field) => ({ ...field, groupIndex: 1 })), outline: built0, now: 1 }).recipe;
  doc.getElementById("rows").insertAdjacentHTML("beforeend", `<div class="edu" id="new"><label>学校名称<input class="school"></label></div>`);
  const built = build(doc);
  const without = recipes.locateFields(recipe, built);
  assert.equal(without.entries.length, 0, "a second identical row the recipe never saw is not guessed");
  assert.equal(without.ambiguous, 1);
  const found = recipes.locateFields(recipe, built, { extraScopes: [doc.getElementById("new")] });
  assert.equal(found.entries.length, 2);
  assert.deepEqual(recipes.toSpecFields(found.entries).map((field) => field.groupIndex), [1, 2]);
});

// ---- 前置动作 ----------------------------------------------------------------

function viewPage() {
  const { dom, doc } = page(`<section id="basic"><h2>基本信息</h2><button type="button" id="edit-basic">编辑</button>
      <dl id="basic-view"><dt>姓名</dt><dd>林测试</dd><dt>现居城市</dt><dd>杭州</dd></dl></section>
    <section id="intent"><h2>求职意向</h2><button type="button" id="save">保存</button></section>`, "https://jobs.example.test/resume/view");
  doc.getElementById("edit-basic").addEventListener("click", () => {
    setTimeout(() => {
      doc.getElementById("basic-view").outerHTML = `<div id="basic-form"><label>姓名<input id="name" name="realname"></label><label>现居城市<input id="home" name="home"></label></div>`;
    }, 10);
  });
  return { dom, doc };
}

async function editAndSave() {
  const { doc } = viewPage();
  // 很多网页点完「编辑」按钮就换成「保存 / 取消」：按钮的定位要在点之前记下。
  doc.getElementById("edit-basic").addEventListener("click", (event) => setTimeout(() => event.target.replaceWith(doc.createElement("span")), 5));
  const first = build(doc);
  const editRef = refOf(first, doc.getElementById("edit-basic"));
  const planned = actions.buildPlan({ spec: { preActions: [{ ref: editRef, kind: "edit" }], sections: [] }, nodes: first.nodes, titles: first.titles,
    redact: first.redact, templateFields: [], formAgent: agent, deep, describe: outline.describeButton, isVisible, doc });
  const locators = recipes.actionLocators(planned.items, first);
  const done = await actions.executePlan(planned, { doc, deep, describe: outline.describeButton, isVisible, formAgent: agent, stopped: () => "", timing: FAST });
  assert.equal(done.ok, true);
  assert.equal(doc.getElementById("edit-basic"), null, "the button is gone after the click");
  assert.equal(recipes.actionLocators(planned.items, first), null, "described after the click it could not be found any more");
  const second = build(doc);
  const result = recipes.buildRecipe({ fields: specFor(second, all(doc)), outline: second, now: 1, actions: locators });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.recipe;
}

test("a recipe remembers the confirmed 编辑 by structure; reuse locates it again, still needs a fresh plan, and fields are checked only after the click", async () => {
  const recipe = await editAndSave();
  assert.deepEqual(recipe.actions, [{ kind: "edit", btn: { s: "", sec: "基本信息", t: "编辑", n: 1 } }]);
  const { doc } = viewPage();
  const built = build(doc);
  // 动作之前：字段还不在，定位不到（不能拿还没出现的字段算成功）。
  assert.equal(recipes.locateFields(recipe, built).located, 0);
  const found = recipes.locateActions(recipe, built);
  assert.equal(found.ok, true);
  assert.equal(built.nodes.get(found.preActions[0].ref).element, doc.getElementById("edit-basic"));
  // 复用 #225 的计划和执行：同样要预览、确认后才点。
  const planned = actions.buildPlan({ spec: { preActions: found.preActions, sections: [] }, nodes: built.nodes, titles: built.titles, redact: built.redact,
    templateFields: [], formAgent: agent, deep, describe: outline.describeButton, isVisible, doc });
  assert.deepEqual(planned.items.map((item) => item.label), ["基本信息：编辑"]);
  const done = await actions.executePlan(planned, { doc, deep, describe: outline.describeButton, isVisible, formAgent: agent, stopped: () => "", timing: FAST });
  assert.equal(done.ok, true);
  const after = build(doc);
  const fields = recipes.locateFields(recipe, after);
  assert.equal(fields.ok, true);
  assert.deepEqual(elementsOf(after, fields.entries), [doc.getElementById("name"), doc.getElementById("home")]);
});

test("the remembered button is not used when its text turns forbidden, when it disappears, or when the count of same buttons changed", async () => {
  const recipe = await editAndSave();
  const changed = viewPage().doc;
  changed.getElementById("edit-basic").textContent = "保存";
  assert.equal(recipes.locateActions(recipe, build(changed)).ok, false);
  const gone = viewPage().doc;
  gone.getElementById("edit-basic").remove();
  assert.equal(recipes.locateActions(recipe, build(gone)).ok, false);
  const twice = viewPage().doc;
  twice.getElementById("edit-basic").insertAdjacentHTML("afterend", `<button type="button">编辑</button>`);
  assert.equal(recipes.locateActions(recipe, build(twice)).ok, false, "two 编辑 where there was one: not guessed");
});

test("add sections are recounted on the current page: the number to add comes from the template and the rows there now", () => {
  const html = (rows) => `<section><h2>教育经历</h2><div class="list">${Array.from({ length: rows }, () => `<div class="item"><label>学校名称<input class="school"></label><label>专业<input class="major"></label></div>`).join("")}</div>
    <button type="button" id="add">添加</button></section>`;
  const { doc } = page(html(1));
  const built = build(doc);
  const fields = specFor(built, all(doc));
  const result = recipes.buildRecipe({ fields, outline: built, now: 1,
    sections: [{ domain: "education", addRef: refOf(built, doc.getElementById("add")), rowRefs: [refOf(built, doc.querySelector(".school"))] }] });
  assert.equal(result.ok, true);
  assert.equal(result.recipe.sections[0].add.t, "添加");
  const template = (n) => Array.from({ length: n }, (_, i) => ({ group: "教育经历", key: `学校${i + 1}`, value: `测试大学${i + 1}` }));
  for (const [rows, records, expected] of [[1, 3, 2], [2, 3, 1], [3, 3, 0]]) {
    const { doc: now } = page(html(rows));
    const current = build(now);
    const found = recipes.locateActions(result.recipe, current);
    assert.equal(found.sections[0].rowRefs.length, rows);
    const planned = actions.buildPlan({ spec: { preActions: [], sections: found.sections }, nodes: current.nodes, titles: current.titles, redact: current.redact,
      templateFields: template(records), formAgent: agent, deep, describe: outline.describeButton, isVisible, doc: now });
    assert.deepEqual(planned.items.map((item) => item.count), expected ? [expected] : [], `${rows} rows, ${records} records`);
  }
});

// ---- 保存条件 ----------------------------------------------------------------

test("save only after a validated, uncancelled analysis that verifiably filled more than the plain fill on this page", () => {
  const ok = { outcome: "partial", filledCount: 5 };
  assert.deepEqual(recipes.saveDecision({ validation: "通过", result: ok, baseline: { filled: 2 } }), { save: true, reason: "" });
  assert.equal(recipes.saveDecision({ validation: "通过", result: ok, baseline: { filled: 0 } }).save, true, "a zero-field page counts as 0");
  assert.equal(recipes.saveDecision({ validation: "analyze_invalid（unknown_ref）", result: ok, baseline: { filled: 0 } }).reason, "invalid");
  assert.equal(recipes.saveDecision({ validation: "通过", result: ok, baseline: { filled: 5 } }).reason, "not_better");
  assert.equal(recipes.saveDecision({ validation: "通过", result: ok, baseline: null }).reason, "no_baseline");
  assert.equal(recipes.saveDecision({ validation: "通过", result: { outcome: "success", filledCount: 0 }, baseline: { filled: 0 } }).reason, "nothing_filled");
  assert.equal(recipes.saveDecision({ validation: "通过", result: { ...ok, overwriteDeclined: true }, baseline: { filled: 0 } }).reason, "cancelled");
  assert.equal(recipes.saveDecision({ validation: "通过", result: ok, baseline: { filled: 0 }, stopped: true }).reason, "cancelled");
  assert.equal(recipes.saveDecision({ validation: "通过", result: { outcome: "failed", filledCount: 3 }, baseline: { filled: 0 } }).reason, "failed");
});

// ---- 存储 --------------------------------------------------------------------

function memoryArea({ failSet = false, initial } = {}) {
  const data = initial === undefined ? {} : { [recipes.STORAGE_KEY]: initial };
  return {
    data,
    writes: 0,
    async get(keys) { await new Promise((resolve) => setImmediate(resolve)); return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, JSON.parse(JSON.stringify(data[key]))])); },
    async set(values) {
      await new Promise((resolve) => setImmediate(resolve));
      if (failSet) throw new Error("QUOTA_BYTES quota exceeded");
      this.writes += 1;
      Object.assign(data, JSON.parse(JSON.stringify(values)));
    }
  };
}
function sampleRecipe(extra = {}) {
  const { doc } = page(BASIC);
  return { ...saveFrom(doc, all(doc)), ...extra };
}

test("corrupt data, unknown versions and broken entries are handled without crashing or overwriting newer data", async () => {
  assert.equal(recipes.readStore(undefined).status, "empty");
  assert.equal(recipes.readStore("oops").status, "corrupt");
  assert.equal(recipes.readStore({ v: 0, sites: {} }).status, "corrupt");
  assert.equal(recipes.readStore({ v: 2, sites: {} }).status, "unsupported");
  const good = sampleRecipe();
  const mixed = recipes.readStore({ v: 1, sites: {
    "a.example.test": { "/apply": good, "/bad": { ...good, fields: [{ loc: { k: "text", t: "姓名" }, control: "code", label: "x" }] } },
    "b.example.test": { "/apply": { ...good, v: 9 } },
    "Bad Host": { "/apply": good }
  } });
  assert.equal(mixed.status, "partial");
  assert.deepEqual(Object.keys(mixed.store.sites), ["a.example.test"]);
  assert.deepEqual(Object.keys(mixed.store.sites["a.example.test"]), ["/apply"]);
  // 新版本写的配方：读不懂，也不覆盖。
  const area = memoryArea({ initial: { v: 2, sites: { "x.example.test": {} } } });
  const store = recipes.createStore(area);
  assert.deepEqual(await store.save("a.example.test", "/apply", good), { ok: false, error: "unsupported_version" });
  assert.equal(area.data[recipes.STORAGE_KEY].v, 2);
});

test("unknown keys and executable-looking content are dropped; a recipe cannot smuggle selectors or code", () => {
  const good = sampleRecipe();
  const dirty = { ...good, selector: "#name", code: "alert(1)", fields: good.fields.map((field) => ({ ...field, selector: "input[name=x]", value: "林测试",
    loc: { ...field.loc, css: ".x" } })) };
  const clean = recipes.sanitizeRecipe(dirty);
  const text = JSON.stringify(clean);
  for (const word of ["selector", "alert", "林测试", "css"]) assert.ok(!text.includes(word), word);
  assert.equal(recipes.sanitizeRecipe({ ...good, fields: [{ ...good.fields[0], label: "13800138000" }] }), null, "phone-like text is refused");
  assert.equal(recipes.sanitizeRecipe({ ...good, fields: [{ ...good.fields[0], label: "https://evil.example/x" }] }), null);
  assert.equal(recipes.sanitizeRecipe({ ...good, actions: [{ kind: "edit", btn: { s: "", t: "提交", n: 1 } }] }), null, "a forbidden button is refused");
});

test("save, replace, delete and touch go through one queue; parallel saves for different sites both survive", async () => {
  let clock = 1000;
  const area = memoryArea();
  const store = recipes.createStore(area, { now: () => clock });
  const recipe = sampleRecipe();
  const [a, b] = await Promise.all([store.save("a.example.test", "/apply", recipe), store.save("b.example.test", "/form/*", recipe)]);
  assert.equal(a.ok && b.ok, true);
  const saved = area.data[recipes.STORAGE_KEY];
  assert.deepEqual(Object.keys(saved.sites).sort(), ["a.example.test", "b.example.test"]);
  // 同一网站不同路径各是一条；删除只影响那一条。
  await store.save("a.example.test", "/other", recipe);
  assert.deepEqual(Object.keys(area.data[recipes.STORAGE_KEY].sites["a.example.test"]).sort(), ["/apply", "/other"]);
  assert.equal((await store.remove("a.example.test", "/apply")).ok, true);
  assert.deepEqual(Object.keys(area.data[recipes.STORAGE_KEY].sites["a.example.test"]), ["/other"]);
  assert.ok(area.data[recipes.STORAGE_KEY].sites["b.example.test"]["/form/*"]);
  // 最近使用：一小时内只写一次。
  const writes = area.writes;
  clock += 1000;
  await store.touch("b.example.test", "/form/*");
  assert.equal(area.writes, writes);
  clock += recipes.TOUCH_INTERVAL_MS;
  await store.touch("b.example.test", "/form/*");
  assert.equal(area.data[recipes.STORAGE_KEY].sites["b.example.test"]["/form/*"].used, clock);
  // 存储失败：如实返回失败，原来的配方不受影响。
  const before = JSON.stringify(area.data);
  const broken = recipes.createStore({ get: area.get.bind(area), set: async () => { throw new Error("quota"); } });
  assert.deepEqual(await broken.save("c.example.test", "/x", recipe), { ok: false, error: "storage_failed" });
  assert.equal(JSON.stringify(area.data), before);
  const unreadable = recipes.createStore({ get: async () => { throw new Error("gone"); }, set: async () => {} });
  assert.deepEqual(await unreadable.remove("a.example.test", "/other"), { ok: false, error: "storage_failed" });
});

test("limits are in encoded bytes: one recipe over 32 KB is refused, even when its character count is under the limit", () => {
  const recipe = sampleRecipe();
  const field = recipe.fields[0];
  // 中文每个字 3 个字节：字符数在 32K 以内，字节数超过。
  const wide = { ...recipe, fields: Array.from({ length: 170 }, (_, i) => ({ ...field, label: `很长的中文题目名称第${String.fromCharCode(0x4e00 + i)}题再加一些字凑到四十字左右为止`,
    group: "很长的中文分组名称再加一些字凑到四十字左右为止好吧", loc: { ...field.loc, t: `很长的题目文字${String.fromCharCode(0x4e00 + i)}再加一些字凑满凑满凑满凑满` } })) };
  const chars = JSON.stringify(wide).length;
  const bytes = recipes.encodedBytes(wide);
  assert.ok(chars < recipes.MAX_RECIPE_BYTES && bytes > recipes.MAX_RECIPE_BYTES, `${chars} chars, ${bytes} bytes`);
  assert.deepEqual(recipes.upsert({ v: 1, sites: {} }, "a.example.test", "/apply", wide, 5), { ok: false, error: "too_large" });
});

test("eviction: least recently used first — 10 recipes per site, 200 sites, 2 MB in total; the one being saved always stays", () => {
  const recipe = sampleRecipe();
  let store = { v: 1, sites: {} };
  for (let i = 0; i < 205; i += 1) {
    const result = recipes.upsert(store, `site${i}.example.test`, "/apply", recipe, 1000 + i);
    assert.equal(result.ok, true);
    store = result.store;
  }
  const hosts = Object.keys(store.sites);
  assert.equal(hosts.length, recipes.MAX_SITES);
  for (let i = 0; i < 5; i += 1) assert.ok(!hosts.includes(`site${i}.example.test`), `site${i} is the oldest`);
  // 刚用过的老网站不会被淘汰。
  store = recipes.touchRecipe(store, "site5.example.test", "/apply", 1000 + 205 + recipes.TOUCH_INTERVAL_MS).store;
  store = recipes.upsert(store, "new.example.test", "/apply", recipe, 1000 + 206 + recipes.TOUCH_INTERVAL_MS).store;
  assert.ok(store.sites["site5.example.test"]);
  assert.ok(!store.sites["site6.example.test"]);
  let site = { v: 1, sites: {} };
  for (let i = 0; i < 12; i += 1) site = recipes.upsert(site, "one.example.test", `/p${i}`, recipe, 10 + i).store;
  assert.deepEqual(Object.keys(site.sites["one.example.test"]).sort(), ["/p10", "/p11", "/p2", "/p3", "/p4", "/p5", "/p6", "/p7", "/p8", "/p9"]);
  assert.ok(recipes.encodedBytes(store) <= recipes.MAX_TOTAL_BYTES);
});

test("lookup reads only the one recipe for this page and ignores anything malformed", () => {
  const recipe = sampleRecipe();
  const raw = { v: 1, sites: { "jobs.example.test": { "/apply/*": recipe, "/broken": { v: 1 } } } };
  const key = recipes.pageKey("https://jobs.example.test/apply/778899?x=1");
  assert.deepEqual(recipes.lookup(raw, key), recipes.sanitizeRecipe(recipe));
  assert.equal(recipes.lookup(raw, recipes.pageKey("https://jobs.example.test/broken")), null);
  assert.equal(recipes.lookup(raw, recipes.pageKey("https://other.example.test/apply/1")), null);
  assert.equal(recipes.lookup({ v: 2, sites: raw.sites }, key), null);
  assert.equal(recipes.lookup({ v: 1, sites: Object.create(null) }, recipes.pageKey("https://__proto__.example.test/")), null);
});

test("recipes stay out of the legacy migration, feedback and desktop link: nothing there reads the whole storage or the recipe key", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const legacy = fs.readFileSync(path.join(__dirname, "..", "link", "legacy.mjs"), "utf8");
  assert.match(legacy, /export const OLD_KEYS = \['templates', 'activeTemplateId', 'profile', 'aiConfig'\];/);
  for (const file of fs.readdirSync(path.join(__dirname, "..", "link")).filter((name) => name.endsWith(".mjs"))) {
    const source = fs.readFileSync(path.join(__dirname, "..", "link", file), "utf8");
    assert.ok(!source.includes("fillRecipes"), `${file} must not touch recipes`);
    assert.ok(!/storage\.local\.get\(\s*(?:null)?\s*\)|\.get\(\s*null\s*\)/.test(source), `${file} must not read the whole storage`);
  }
  for (const file of ["feedback-core.js", "feedback-ui.js", "ai-worker.js", "popup.js", "sidepanel.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.ok(!source.includes("fillRecipes"), `${file} must not read recipes`);
  }
});

test("after the plugin adds rows: a question repeated when saved maps by order across old and new rows; one saved in a then-new row is found in the new row", () => {
  const row = (n) => `<div class="edu" id="row${n}"><label>学校名称<input class="school"></label><label>专业<input class="major"></label></div>`;
  const { doc } = page(`<form><section><h2>教育经历</h2><div id="rows">${row(1)}${row(2)}${row(3)}</div></section>
    <section><h2>论文</h2><div id="papers"><div class="paper" id="p1"><label>论文标题<input class="title"></label></div></div></section></form>`);
  const built0 = build(doc);
  const specFields = specFor(built0, all(doc)).map((field, index) => ({ ...field, groupIndex: index < 6 ? Math.floor(index / 2) + 1 : 1 }));
  const recipe = recipes.buildRecipe({ fields: specFields, outline: built0, now: 1 }).recipe;
  assert.deepEqual(recipe.fields.map((field) => [field.loc.o || 0, field.loc.m || 1]), [[0, 3], [0, 3], [1, 3], [1, 3], [2, 3], [2, 3], [0, 1]]);
  // 下一次：教育经历只有 1 条、论文 0 条；插件按模板新增了教育 2 条、论文 1 条。
  const { doc: next } = page(`<form><section><h2>教育经历</h2><div id="rows">${row(1)}</div></section><section><h2>论文</h2><div id="papers"></div></section></form>`);
  next.getElementById("rows").insertAdjacentHTML("beforeend", row(2) + row(3));
  next.getElementById("papers").insertAdjacentHTML("beforeend", `<div class="paper" id="p1"><label>论文标题<input class="title"></label></div>`);
  const scopes = ["row2", "row3", "p1"].map((id) => next.getElementById(id));
  const built = build(next);
  const found = recipes.locateFields(recipe, built, { extraScopes: scopes });
  assert.equal(found.ok, true);
  assert.equal(found.located, 7);
  assert.deepEqual(elementsOf(built, found.entries), all(next));
  assert.deepEqual(recipes.toSpecFields(found.entries).map((field) => field.groupIndex), [1, 1, 2, 2, 3, 3, 1]);
  // 不知道哪些是新增的（普通一键填写）时，按网页上现有的条目同样都能找到。
  assert.equal(recipes.locateFields(recipe, built).located, 7);
});

test("records whose header sits outside the first question (北森-like) still group as one section, so the rows can be counted next time", () => {
  const entry = (n) => `<div class="sc-entry"><div class="sc-entry-head"><span>教育经历 ${n}</span><span class="sc-del">删除</span></div>
    <div class="form"><div class="form-item"><label class="form-item__text">学校名称</label><input type="text" placeholder="请输入"></div>
    <div class="form-item"><label class="form-item__text">专业</label><input type="text" placeholder="请输入"></div></div></div>`;
  const html = (rows) => `<div class="sc-sec"><div class="sc-sec-title" role="heading">教育经历</div><div class="sc-list">${Array.from({ length: rows }, (_, i) => entry(i + 1)).join("")}</div>
    <button type="button" id="add">添加</button></div>`;
  const { doc } = page(html(3));
  const built = build(doc);
  // 大纲把第一条记录的第一题放在上一级标题下面，其余题目在「教育经历 1删除」下面：分组不能用大纲区块标题。
  const schools = Array.from(doc.querySelectorAll(".sc-entry")).map((row) => row.querySelector("input"));
  assert.notEqual(built.titles.get(refOf(built, schools[0])), built.titles.get(refOf(built, schools[1])));
  const result = recipes.buildRecipe({ fields: specFor(built, all(doc)), outline: built, now: 1,
    sections: [{ domain: "education", addRef: refOf(built, doc.getElementById("add")), rowRefs: schools.map((el) => refOf(built, el)) }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.recipe.sections?.[0]?.row, "the row locator is kept");
  assert.deepEqual(result.recipe.fields.map((field) => `${field.loc.o || 0}/${field.loc.m || 1}`), ["0/3", "0/3", "1/3", "1/3", "2/3", "2/3"]);
  const { doc: next } = page(html(1));
  const found = recipes.locateActions(result.recipe, build(next));
  assert.equal(found.sections[0].rowRefs.length, 1, "one row counted on the new page");
});

test("PR #284: the add section is captured from the first outline before clicking; a second round without it still saves the group", () => {
  // 金发式：「添加教育经历」在最后一条记录里，点完后挪到新的最后一条。
  const entry = (n, last) => `<div class="item" id="edu${n}"><label>学校名称<input class="school"></label><label>专业<input class="major"></label>${
    last ? `<button type="button" id="add">添加教育经历</button>` : ""}</div>`;
  const { doc } = page(`<form><section><h2>教育经历</h2><div id="list">${entry(1, true)}</div></section></form>`);
  const first = build(doc);
  const before = recipes.sectionLocators([{ domain: "education", addRef: refOf(first, doc.getElementById("add")),
    rowRefs: [refOf(first, doc.querySelector(".school"))] }], first);
  assert.deepEqual(before.missing, []);
  assert.equal(before.list[0].add.t, "添加教育经历");
  // 点两次「添加」：按钮挪到新的最后一条。
  doc.getElementById("add").remove();
  doc.getElementById("list").insertAdjacentHTML("beforeend", entry(2, false) + entry(3, true));
  const second = build(doc);
  const result = recipes.buildRecipe({ fields: specFor(second, all(doc)), outline: second, sections: [], sectionsBefore: before, now: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.recipe.sections.map((section) => section.domain), ["education"]);
  assert.deepEqual(result.missingSections, []);
  // 下一个页面只有 1 条：数得出 1 条，按钮也找得到。
  const { doc: next } = page(`<form><section><h2>教育经历</h2><div id="list">${entry(1, true)}</div></section></form>`);
  const found = recipes.locateActions(result.recipe, build(next));
  assert.deepEqual(found.sections.map((section) => [section.domain, section.rowRefs.length]), [["education", 1]]);
  assert.deepEqual(found.missingSections, []);
});

test("PR #284: a group whose rows cannot be counted is reported as not remembered; a missing 添加 on a new page is reported, not hidden", () => {
  const { doc } = page(`<form><section><h2>教育经历</h2><div class="item"><label>学校名称<input name="a"></label></div>
    <div class="item"><label>学校全称<input name="b"></label></div><button type="button" id="add">添加</button></section>
    <section><h2>论文</h2><button type="button" id="add-paper">添加论文</button></section></form>`);
  const built = build(doc);
  // 模型给的「每条一个输入框」题目不一样：数不清。
  const sections = [{ domain: "education", addRef: refOf(built, doc.getElementById("add")), rowRefs: Array.from(doc.querySelectorAll("input"), (el) => refOf(built, el)) },
    { domain: "papers", addRef: refOf(built, doc.getElementById("add-paper")), rowRefs: [] }];
  const result = recipes.buildRecipe({ fields: specFor(built, all(doc)), outline: built, sections, now: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.recipe.sections.map((section) => section.domain), ["papers"]);
  assert.deepEqual(result.missingSections, ["education"]);
  // 另一个职位的表单没有论文分组：这次不新增论文，并且报出来。
  const { doc: next } = page(`<form><section><h2>教育经历</h2><div class="item"><label>学校名称<input name="a"></label></div>
    <div class="item"><label>学校全称<input name="b"></label></div><button type="button" id="add">添加</button></section></form>`);
  const found = recipes.locateActions(result.recipe, build(next));
  assert.equal(found.ok, true);
  assert.deepEqual(found.sections, []);
  assert.deepEqual(found.missingSections, ["papers"]);
});
