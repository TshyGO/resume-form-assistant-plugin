// #228 网页字段扫描：用 jsdom 跑真实 DOM。北森夹具和各类布局都不含任何输入值或个人资料。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const scanner = require("../field-scan.js");
const helpers = require("../ai-helpers.js");
const profileApi = require("../profile-fields.js");

// jsdom 不排版：没有尺寸，也不算样式。这里只把 hidden 和行内 display:none 当成看不见。
const isVisible = (el) => !el.closest("[hidden], [style*='display: none'], [style*='display:none']");

function load(html) {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

function scan(doc) {
  return scanner.scanPage(doc, { isVisible });
}

function labels(result) {
  return result.controls.map((control) => control.label);
}

const BEISEN = fs.readFileSync(path.join(__dirname, "fixtures", "field-scan", "beisen-application.html"), "utf8");

test("Beisen form: header search is not taken for 面试站点, and each dropdown is one field with its own title", () => {
  const doc = new JSDOM(BEISEN).window.document;
  const result = scan(doc);
  const search = doc.querySelector(".search-input");

  assert.equal(result.controls.some((control) => control.elements.includes(search)), false, "页头搜索不进字段");
  assert.equal(result.skipped.pageChrome, 1);
  assert.deepEqual(result.controls.filter((control) => control.label === "面试站点").map((control) => control.controlKind), ["custom-select"]);
  assert.deepEqual(result.controls.filter((control) => control.label === "意向工作地点").map((control) => control.controlKind), ["custom-select"]);
  // 下拉弹层里的搜索框属于面试站点那个下拉，不另算字段。
  const filter = doc.querySelector(".bs-select-filter");
  assert.equal(result.controls.some((control) => control.elements.includes(filter)), false);
});

test("Beisen form: every scanned field's binding holds right after the scan", () => {
  const doc = new JSDOM(BEISEN).window.document;
  const result = scan(doc);
  assert.ok(result.controls.length > 0);
  for (const control of result.controls) {
    assert.equal(scanner.isBindingCurrent(control, doc, { isVisible }), true, control.label);
  }
});

test("Beisen form: description boxes keep their real questions instead of 0/2000 and 0/4000", () => {
  const result = scan(new JSDOM(BEISEN).window.document);
  const textareas = result.controls.filter((control) => control.controlKind === "textarea");

  assert.deepEqual(textareas.map((control) => control.label), [
    "获奖/专利描述",
    "实践描述",
    "在校期间是否有补考、重修情况？如有，请列出具体科目、次数以及当时的原因说明",
    "请简要描述你的个人优缺点"
  ]);
  for (const control of result.controls) {
    assert.doesNotMatch(control.label, /^\d+\/\d+$|^请选择$|^请输入$|必填/, `不是字段名：${control.label}`);
  }
  // 两个附加问题不会因为同名被合并成一条。
  const offers = result.controls.map((control) => control.offerLabel);
  assert.equal(new Set(offers).size, offers.length);
});

test("Beisen form: section titles with generated class names are found, so repeated 名称 / 获得时间 are told apart", () => {
  const result = scan(new JSDOM(BEISEN).window.document);
  const byLabel = (label) => result.controls.filter((control) => control.label === label);

  assert.deepEqual(byLabel("名称").map((control) => control.offerLabel), ["论文/专著-名称", "学生工作经历-名称"]);
  assert.deepEqual(byLabel("获得时间").map((control) => control.offerLabel), ["获奖/专利-获得时间", "证书-获得时间"]);
  assert.deepEqual(byLabel("开始时间").map((control) => control.group), ["教育经历", "学生工作经历"]);
  // 结束时间外面多包了两层、旁边还有「至今」：仍归学生工作经历。
  assert.deepEqual(byLabel("结束时间").map((control) => control.group), ["教育经历", "学生工作经历"]);
  // 没有 input 的「是否为海外留学经历」只是一行文字，不能被当成后面字段的区块标题。
  assert.equal(result.controls.some((control) => control.group === "是否为海外留学经历"), false);
  const long = result.controls.find((control) => control.label.startsWith("在校期间"));
  assert.equal(long.offerLabel, long.label);
  assert.ok(long.label.length > 30);
});

test("Beisen form: 加到我的信息 offers only single-value questions, never fields inside experience sections", () => {
  const result = scan(new JSDOM(BEISEN).window.document);
  const stats = {};
  const candidates = result.controls.filter((control) => control.offerable).map((control) => ({
    label: control.offerLabel, title: control.label, section: control.section, sectionRepeatable: control.sectionRepeatable,
    inputType: control.controlKind === "checkbox" ? "checkbox" : "text"
  }));
  assert.deepEqual(profileApi.pickUnansweredLabels(candidates, profileApi.knownFieldKeys({}, []), undefined, stats), [
    "面试站点",
    "意向工作地点",
    "班级排名",
    "在校期间是否有补考、重修情况？如有，请列出具体科目、次数以及当时的原因说明",
    "请简要描述你的个人优缺点"
  ]);
  assert.equal(stats.entry, 18);
});

test("an unclassed section title is the top line before a group of fields, not the description under it", () => {
  const doc = load(`
    <div class="a1"><div class="x9">项目经历</div><div class="y7">最多填写三段</div>
      <div class="z3"><div class="row"><span class="t">项目名称</span><input></div><div class="row"><span class="t">项目描述</span><textarea></textarea></div></div></div>
    <div class="a1"><div class="x9">其他信息</div>
      <div class="z3"><div class="row"><span class="t">项目名称</span><input></div><div class="row"><span class="t">期望薪资</span><input></div></div></div>`);
  const result = scan(doc);
  assert.deepEqual(result.controls.map((control) => control.group), ["项目经历", "项目经历", "其他信息", "其他信息"]);
  assert.deepEqual(result.controls.map((control) => control.offerLabel), ["项目经历-项目名称", "项目描述", "其他信息-项目名称", "期望薪资"]);
});

test("a section with an 添加 button, or the same title twice, is a repeatable list", () => {
  const doc = load(`
    <div class="sec"><div class="x9">学术活动</div>
      <div class="body"><div class="row"><span class="t">活动名称</span><input></div><div class="row"><span class="t">举办单位</span><input></div></div>
      <span class="add">+ 添加</span></div>
    <div class="sec"><div class="x9">志愿服务</div>
      <div class="body"><div class="entry"><div class="row"><span class="t">服务内容</span><input></div><div class="row"><span class="t">时长</span><input></div></div>
        <div class="entry"><div class="row"><span class="t">服务内容</span><input></div><div class="row"><span class="t">时长</span><input></div></div></div></div>
    <div class="sec"><div class="x9">补充信息</div>
      <div class="body"><div class="row"><span class="t">期望薪资</span><input></div><div class="row"><span class="t">到岗时间</span><input></div></div></div>`);
  const result = scan(doc);
  assert.deepEqual(result.controls.map((control) => [control.group.replace(/ \d$/, ""), control.sectionRepeatable]), [
    ["学术活动", true], ["学术活动", true],
    ["志愿服务", true], ["志愿服务", true], ["志愿服务", true], ["志愿服务", true],
    ["补充信息", false], ["补充信息", false]
  ]);
});

test("a header search without recognisable page-chrome markup is still left out", () => {
  const doc = load(`
    <div class="top"><div class="box"><input type="text" placeholder="搜索职位"><span>搜索</span></div></div>
    <div class="form">
      <div class="row"><label>姓名</label><input type="text"></div>
      <div class="row"><label>邮箱</label><input type="text"></div>
      <div class="row"><label>毕业院校</label><input type="text"></div>
    </div>`);
  const result = scan(doc);
  assert.deepEqual(labels(result), ["姓名", "邮箱", "毕业院校"]);
  assert.equal(result.skipped.siteSearch + result.skipped.outsideForm, 1);
});

test("a search-styled input that is part of a dropdown is kept as that dropdown, not dropped as site search", () => {
  const doc = load(`
    <div class="item"><div class="item-label">毕业院校</div>
      <div class="ant-select"><div class="ant-select-selector">
        <span class="ant-select-selection-search"><input type="search" role="combobox" aria-haspopup="listbox" aria-controls="list-1"></span>
        <span class="ant-select-selection-placeholder">请选择</span></div></div></div>
    <div class="item"><div class="item-label">专业</div><input type="text"></div>
    <div class="ant-select-dropdown" id="list-1"><input type="text" placeholder="搜索"><div role="option">示例选项</div></div>`);
  const result = scan(doc);
  assert.deepEqual(result.controls.map((control) => [control.label, control.controlKind]), [["毕业院校", "custom-select"], ["专业", "text"]]);
  assert.equal(result.skipped.popup, 1);
});

test("a dropdown's inline filter input merges into the dropdown even without popup markup", () => {
  const doc = load(`
    <div class="field"><span class="field-title">意向城市</span>
      <div class="city-select"><input type="text" readonly placeholder="请选择"><div class="panel"><input type="text" placeholder="输入城市名"></div></div></div>
    <div class="field"><span class="field-title">期望薪资</span><input type="text"></div>`);
  const result = scan(doc);
  assert.deepEqual(labels(result), ["意向城市", "期望薪资"]);
  assert.equal(result.controls[0].elements.length, 2);
  assert.equal(result.skipped.merged, 1);
});

test("same-titled fields whose section cannot be found are not offered with a bare number", () => {
  const doc = load(`
    <div class="blk"><div class="blk-hd">x</div>
      <div class="row"><div class="label">名称</div><input></div>
      <div class="row"><div class="label">开始时间</div><input></div></div>
    <div class="blk">
      <div class="row"><div class="label">名称</div><input></div>
      <div class="row"><div class="label">开始时间</div><input></div>
      <div class="row"><div class="label">证书种类</div><input></div></div>`);
  const result = scan(doc);
  assert.deepEqual(result.controls.map((control) => [control.label, control.offerable, control.offerLabel]), [
    ["名称", false, ""], ["开始时间", false, ""], ["名称", false, ""], ["开始时间", false, ""], ["证书种类", true, "证书种类"]
  ]);
  assert.equal(result.skipped.ambiguous, 4);
  // 仍可一键填写：只是不进「加到我的信息」。
  assert.equal(result.controls.length, 5);
});

test("explicit associations win: label[for], wrapping label, aria-labelledby and aria-label", () => {
  const doc = load(`
    <div><label for="a">手机号码</label><span>0/11</span><input id="a"></div>
    <div><label>电子邮箱 <input id="b"></label></div>
    <div><span id="t">家庭住址</span><span class="hint">请填写详细地址</span><input aria-labelledby="t"></div>
    <div><span>无关前文</span><input aria-label="紧急联系人"></div>
    <div><span>籍贯</span><input aria-label="请选择"></div>`);
  const result = scan(doc);
  assert.deepEqual(result.controls.map((control) => [control.label, control.labelSource]), [
    ["手机号码", "explicit"], ["电子邮箱", "explicit"], ["家庭住址", "explicit"], ["紧急联系人", "explicit"], ["籍贯", "item-text"]
  ]);
});

test("table layouts: the cell before the control, or the column header for repeated rows", () => {
  const doc = load(`
    <table><tr><th>姓名</th><td><input></td><th>性别</th><td><select><option>男</option><option>女</option></select></td></tr></table>
    <h3>家庭成员</h3>
    <table>
      <thead><tr><th>称谓</th><th>工作单位</th></tr></thead>
      <tbody><tr><td><input></td><td><input></td></tr><tr><td><input></td><td><input></td></tr></tbody>
    </table>`);
  const result = scan(doc);
  assert.deepEqual(labels(result), ["姓名", "性别", "称谓", "工作单位", "称谓", "工作单位"]);
  assert.deepEqual(result.controls.slice(2).map((control) => control.offerLabel),
    ["家庭成员-称谓", "家庭成员-工作单位", "家庭成员-称谓", "家庭成员-工作单位"]);
  assert.deepEqual(result.controls.slice(2).map((control) => control.group), ["家庭成员 1", "家庭成员 1", "家庭成员 2", "家庭成员 2"]);
});

test("inline sibling text only labels the next control and never crosses another control", () => {
  const doc = load(`<div>姓名：<input> <span>0/20</span> 性别：<select><option>男</option></select><input></div>`);
  const result = scan(doc);
  // 第三个框前面紧挨着的是另一个控件：没有自己的题目，跳过。
  assert.deepEqual(labels(result), ["姓名", "性别"]);
  assert.equal(result.skipped.noLabel, 1);
});

test("controls without a reliable title are skipped; a descriptive placeholder can be filled but is never offered", () => {
  const doc = load(`
    <div class="grid"><input placeholder="请选择"><input placeholder="请输入手机号码"></div>
    <div class="grid"><div class="title">兴趣爱好</div><input></div>`);
  const result = scan(doc);
  assert.deepEqual(result.controls.map((control) => [control.label, control.labelSource, control.offerable]), [
    ["", "placeholder", false], ["兴趣爱好", "item", true]
  ]);
  assert.equal(result.skipped.noLabel, 1);
});

test("help text, counters and validation errors are never field names", () => {
  const doc = load(`
    <div class="q"><div class="q-title">自我评价</div><div class="q-desc">不超过 500 字</div>
      <textarea placeholder="请输入"></textarea><span>还可输入500字</span><div class="el-form-item__error">自我评价不能为空</div></div>
    <div class="q"><textarea></textarea><span class="word-count">0/500</span><div role="alert">请填写此项</div></div>`);
  const result = scan(doc);
  assert.deepEqual(labels(result), ["自我评价"]);
});

test("disabled controls bound their own row but are not filled, and editable text is never read as a title", () => {
  const doc = load(`
    <div class="row"><div class="label">证件类型</div><select disabled><option>身份证</option></select></div>
    <div class="row"><div contenteditable="true">用户自己写的一段话</div><input></div>
    <div class="row"><div class="label">备注</div><input></div>`);
  const result = scan(doc);
  assert.deepEqual(labels(result), ["备注"]);
});

test("radio groups take the question, not an option, and same-named groups in repeated entries stay apart", () => {
  const doc = load(`
    <fieldset><legend>政治面貌</legend><label><input type="radio" name="p" value="1">党员</label><label><input type="radio" name="p" value="2">群众</label></fieldset>
    <div class="entry"><div class="label">是否在读</div><label><input type="radio" name="s" value="y">是</label><label><input type="radio" name="s" value="n">否</label><input placeholder="学校名称"></div>
    <div class="entry"><div class="label">是否在读</div><label><input type="radio" name="s" value="y">是</label><label><input type="radio" name="s" value="n">否</label><input placeholder="学校名称"></div>`);
  const result = scan(doc);
  const radios = result.controls.filter((control) => control.kind === "radio");
  assert.deepEqual(radios.map((control) => [control.label, control.elements.length]), [["政治面貌", 2], ["是否在读", 2], ["是否在读", 2]]);
  assert.ok(radios.every((control) => scanner.isBindingCurrent(control, doc, { isVisible })), "刚扫描完的对应关系应当成立");
});

test("a range date picker yields a start and an end field under one title", () => {
  const doc = load(`
    <div class="row"><label class="row-label">在校时间</label>
      <div class="el-date-editor el-range-editor"><input placeholder="开始日期"><span>至</span><input placeholder="结束日期"></div></div>`);
  const result = scan(doc);
  assert.deepEqual(result.controls.map((control) => [control.label, control.controlKind, control.pickerType]), [
    ["在校时间（开始）", "date-picker", "element"], ["在校时间（结束）", "date-picker", "element"]
  ]);
});

test("a binding goes stale when the page re-renders, moves the control, adds a control or changes the title", () => {
  const doc = load(`
    <div class="row" id="r1"><div class="label">期望薪资</div><input id="i1"></div>
    <div class="row" id="r2"><div class="label">到岗时间</div><input id="i2"></div>
    <div class="row" id="r3"><div class="label">职业规划</div><textarea id="i3"></textarea></div>
    <div class="row" id="r4"><div class="label">兴趣爱好</div><input id="i4"></div>`);
  const [salary, start, plan, hobby] = scan(doc).controls;
  assert.ok([salary, start, plan, hobby].every((control) => scanner.isBindingCurrent(control, doc, { isVisible })));
  const current = (control) => scanner.isBindingCurrent(control, doc, { isVisible });
  assert.equal(current(salary), true);

  doc.getElementById("r1").replaceWith(doc.getElementById("r1").cloneNode(true));
  assert.equal(current(salary), false, "重渲染后的新节点不是原来那个控件");

  doc.getElementById("r4").appendChild(doc.getElementById("i2"));
  assert.equal(current(start), false, "控件被挪到了别的题目下");
  assert.equal(current(hobby), false, "原来的表单项混进了别的控件");

  doc.querySelector("#r3 .label").textContent = "实习经历";
  assert.equal(current(plan), false, "题目变了");
});

test("a dynamically expanded entry is picked up by a fresh scan and labelled on its own", () => {
  const doc = load(`
    <div class="module"><div class="module-title">实习经历</div>
      <div class="entry"><div class="label">公司名称</div><input></div>
      <div class="entry" hidden><div class="label">公司名称</div><input></div></div>`);
  assert.deepEqual(scan(doc).controls.map((control) => control.offerLabel), ["公司名称"]);
  doc.querySelector("[hidden]").removeAttribute("hidden");
  assert.deepEqual(scan(doc).controls.map((control) => control.offerLabel), ["实习经历-公司名称", "实习经历-公司名称"]);
});

test("a selected custom dropdown reports that it has a value without exposing it", () => {
  const doc = load(`
    <div class="row"><div class="label">面试站点</div><div class="bs-select"><span class="bs-select-placeholder">请选择</span><input readonly></div></div>
    <div class="row"><div class="label">意向城市</div><div class="bs-select"><span class="bs-select-value">示例城市</span><input readonly></div></div>`);
  const [empty, chosen] = scan(doc).controls;
  assert.equal(scanner.hasDisplayedValue(empty, { isVisible }), false);
  assert.equal(scanner.hasDisplayedValue(chosen, { isVisible }), true);
});

test("labelForElement gives a single control its title for sensitive-field checks", () => {
  const doc = load(`<div class="row"><div class="label">短信验证码</div><input id="otp"><span>0/6</span></div><div class="row"><input id="bare"></div>`);
  assert.equal(scanner.labelForElement(doc.getElementById("otp")), "短信验证码");
  assert.equal(scanner.labelForElement(doc.getElementById("bare")), "");
});

test("a section title does not turn 地址 or QQ into a phone field for local rules", () => {
  const formFields = [
    { fieldId: "a", label: "家庭住址", group: "联系方式", inputType: "text", options: [] },
    { fieldId: "b", label: "QQ", group: "联系方式", inputType: "text", options: [] },
    { fieldId: "c", label: "手机号码", group: "联系方式", inputType: "text", options: [] }
  ];
  const matches = helpers.buildRuleBasedMatches(formFields, [{ group: "基本信息", key: "手机", value: "13800000000" }]);
  assert.deepEqual(matches.map((match) => match.fieldId), ["c"]);
});

test("the content script loads the scanner before content.js", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.includes("field-scan.js"));
  assert.ok(scripts.indexOf("field-scan.js") < scripts.indexOf("content.js"));
});
