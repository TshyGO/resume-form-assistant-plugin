// #224 页面大纲：用 jsdom 跑真实 DOM。重点是外发前的脱敏：输入值、密码、简历内容、联系方式、
// 凭据永远不进大纲；Shadow DOM、同源框架、长页面和编号只放内存这些边界也在这里验证。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const fieldScan = require("../field-scan.js");
const outline = require("../page-outline.js");

// jsdom 不排版：只把 hidden 和行内 display:none 当成看不见。
const isVisible = (el) => !el.closest("[hidden], [style*='display: none'], [style*='display:none']");

function load(html, url = "https://jobs.example.test/apply") {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url }).window.document;
}

function build(doc, options = {}) {
  return outline.build(doc, { isVisible, fieldScan, ...options });
}

const text = (result) => result.parts.map((part) => part.text).join("\n");

test("values typed into inputs, textareas and selects never reach the outline", () => {
  const doc = load(`
    <form>
      <label for="name">姓名</label><input id="name" value="王小明">
      <label for="school">毕业院校</label><input id="school">
      <label for="intro">自我评价</label><textarea id="intro">我热爱编程，曾获一等奖</textarea>
      <label for="degree">学历</label><select id="degree"><option>请选择</option><option selected>硕士研究生</option></select>
    </form>`);
  doc.getElementById("school").value = "清华大学";
  const result = build(doc);
  const all = text(result);
  for (const secret of ["王小明", "清华大学", "热爱编程", "一等奖", "硕士研究生"]) assert.ok(!all.includes(secret), secret);
  assert.match(all, /← 姓名/);
  assert.match(all, /← 毕业院校/);
  assert.match(all, /textarea ← 自我评价/);
  assert.match(all, /select ← 学历/);
});

test("password, captcha and one-time-code fields are skipped entirely, label included", () => {
  const doc = load(`
    <label for="u">用户名</label><input id="u">
    <label for="p">登录密码</label><input id="p" type="password" value="hunter2">
    <label for="c">图形验证码</label><input id="c">
    <label for="o">短信</label><input id="o" autocomplete="one-time-code">`);
  const result = build(doc);
  const all = text(result);
  assert.ok(!/密码|验证码|hunter2|短信/.test(all), all);
  assert.equal(result.stats.skippedSecret, 3);
  assert.equal(result.stats.controls, 1);
});

test("contact details, ID numbers, links and credentials in page text are replaced before sending", () => {
  const doc = load(`
    <h2>联系人：13812345678</h2>
    <label for="a">邮箱 hr@example.com 收简历</label><input id="a">
    <label for="b">身份证 11010519491231002X</label><input id="b">
    <label for="c">详见 https://example.com/x</label><input id="c">
    <label for="d">token: abcdef</label><input id="d">
    <label for="e">sk-abcdefghijklmnopqrstuvwxyz123456</label><input id="e">
    <dt>学号 2019 1234 56</dt>`);
  const all = text(build(doc));
  for (const leak of ["13812345678", "hr@example.com", "11010519491231002X", "https://", "abcdef", "sk-abc", "1234"]) {
    assert.ok(!all.includes(leak), `${leak} leaked:\n${all}`);
  }
  assert.ok(all.includes(outline.REDACTED));
});

test("a view-mode page that shows the saved resume as plain text redacts every overlap with resume values", () => {
  const doc = load(`
    <h2>王小明的简历</h2>
    <dl><dt>姓名</dt><dd>王小明</dd><dt>毕业院校</dt><dd>清华大学</dd></dl>
    <label>清华大学</label>
    <table><tr><th>北京市海淀区中关村大街1号</th></tr></table>
    <button type="button">编辑</button>`);
  const result = build(doc, { resumeValues: ["王小明", "清华大学", "北京市海淀区中关村大街1号"] });
  const all = text(result);
  assert.ok(!all.includes("王小明"), all);
  assert.ok(!all.includes("清华大学"), all);
  assert.ok(!all.includes("中关村"), all);
  assert.match(all, /文字 "姓名"/);
  assert.match(all, /button "编辑"/);
});

test("every text segment is at most 40 characters", () => {
  const long = "请详细描述你在校期间参与过的科研项目以及你在其中承担的具体职责和取得的成果，并说明对你的影响";
  const doc = load(`<label for="x">${long}</label><textarea id="x"></textarea><h3>${long}${long}</h3>`);
  const all = text(build(doc));
  const quoted = [...all.matchAll(/← (.+)$/gm)].map((m) => m[1]);
  assert.ok(quoted.length >= 1);
  for (const value of quoted) assert.ok(Array.from(value).length <= 40, value);
});

test("refs live only in memory: the page DOM is byte-for-byte unchanged", () => {
  const doc = load(`<label for="n">姓名</label><input id="n"><button type="button">编辑</button>`);
  const before = doc.documentElement.outerHTML;
  const result = build(doc);
  assert.equal(doc.documentElement.outerHTML, before);
  assert.ok(result.nodes.get("e1").element === doc.getElementById("n"));
  assert.equal(result.nodes.get("e2").type, "button");
  assert.ok(!doc.querySelector("[data-ref], [data-resume-pro-ref]"));
});

test("open Shadow DOM is walked in place; a closed one is not", () => {
  const doc = load(`<label for="top">手机号码</label><input id="top"><div id="host"></div><div id="closed"></div>`);
  const shadow = doc.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = `<label for="inner">紧急联系人</label><input id="inner">`;
  const closed = doc.getElementById("closed").attachShadow({ mode: "closed" });
  closed.innerHTML = `<label for="hidden">私密字段</label><input id="hidden">`;
  const result = build(doc);
  const all = text(result);
  assert.match(all, /← 紧急联系人/);
  assert.ok(!all.includes("私密字段"));
  assert.equal(result.stats.shadowRoots, 1);
  const inner = [...result.nodes.values()].find((node) => node.element === shadow.getElementById("inner"));
  assert.ok(inner, "the shadow input is a ref target");
});

test("same-origin iframes are walked; cross-origin ones are counted, never read", () => {
  const doc = load(`<label for="a">姓名</label><input id="a"><iframe id="same"></iframe><iframe id="other"></iframe>`);
  const same = doc.getElementById("same").contentDocument;
  same.body.innerHTML = `<label for="b">现居城市</label><input id="b">`;
  Object.defineProperty(doc.getElementById("other"), "contentDocument", { get() { throw new Error("SecurityError"); } });
  const result = build(doc);
  const all = text(result);
  assert.match(all, /\[区块\] 同源框架 1/);
  assert.match(all, /← 现居城市/);
  assert.equal(result.stats.frames, 1);
  assert.equal(result.stats.crossOriginFrames, 1);
});

test("submit buttons and links that leave the page are marked so a spec can never use them", () => {
  const doc = load(`<form>
    <input id="n" aria-label="姓名">
    <button>保存</button>
    <button type="button">添加</button>
    <a href="/other">去完善</a>
    <a href="#more">展开</a>
  </form>`);
  const all = text(build(doc));
  assert.match(all, /button\[submit\] "保存"/);
  assert.match(all, /button "添加"/);
  assert.match(all, /link "去完善" 跨页/);
  assert.match(all, /link "展开"(?! 跨页)/);
});

test("one logical control is one line: an antd select's inner input is not listed again", () => {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", "field-scan", "beisen-application.html"), "utf8");
  const doc = new JSDOM(html, { url: "https://jobs.example.test/apply" }).window.document;
  const scanned = fieldScan.scanPage(doc, { isVisible }).controls.length;
  const result = build(doc);
  const comboLines = text(result).split("\n").filter((line) => /← 面试站点$/.test(line));
  assert.equal(comboLines.length, 1);
  assert.ok(result.stats.controls >= scanned, "everything the scan found is in the outline");
});

test("repeated entry blocks collapse first when the page is over budget", () => {
  // 包在 label 里而不是 for=id：jsdom 对每个不同的 id 都要现编译一次选择器，几千个会把测试拖到分钟级。
  const block = (n) => `<section><h3>教育经历 ${n}</h3>${Array.from({ length: 30 }, (_, i) =>
    `<div><label>学校名称${i}<input placeholder="请输入学校名称"></label></div>`).join("")}</section>`;
  const doc = load(Array.from({ length: 20 }, (_, n) => block(n)).join(""));
  const result = build(doc, { maxChars: 4000 });
  assert.equal(result.parts.length, 1);
  assert.match(result.parts[0].text, /…同结构 19 组/);
  assert.ok(result.parts[0].text.length <= 4000);
  assert.ok(result.stats.collapsed > 0);
});

test("long pages split by block into at most three parts, each under the limit, with a clear truncation flag", () => {
  const block = (n) => `<section><h3>分组 ${n}</h3>${Array.from({ length: 30 }, (_, i) =>
    `<div><label>问题${n}之${i}<input placeholder="请输入"></label></div>`).join("")}</section>`;
  const doc = load(Array.from({ length: 30 }, (_, n) => block(n)).join(""));
  const result = build(doc, { maxChars: 4000 });
  assert.equal(result.parts.length, 3);
  for (const part of result.parts) assert.ok(part.text.length <= 4000, `part is ${part.text.length}`);
  assert.equal(result.stats.truncated, true);
  assert.ok(result.stats.droppedParts > 0);
  // Every ref in a part is a real candidate, and no ref is in two parts.
  const seen = new Set();
  for (const part of result.parts) for (const ref of part.refs) {
    assert.ok(result.nodes.has(ref));
    assert.ok(!seen.has(ref));
    seen.add(ref);
  }
});

test("the default budget is 40,000 characters per analysis and three analyses", () => {
  assert.equal(outline.MAX_CHARS, 40000);
  assert.equal(outline.MAX_PARTS, 3);
  assert.equal(outline.MAX_SEGMENT, 40);
});

test("a page that fits is one part and keeps every candidate", () => {
  const doc = load(`<h2>基本信息</h2><label for="a">姓名</label><input id="a"><label for="b">性别</label>
    <span role="radiogroup" aria-label="性别"><label><input type="radio" name="g">男</label><label><input type="radio" name="g">女</label></span>`);
  const result = build(doc);
  assert.equal(result.parts.length, 1);
  assert.equal(result.stats.truncated, false);
  assert.deepEqual(result.parts[0].refs, [...result.nodes.keys()]);
  assert.match(result.parts[0].text, /radio-group 选项="男\/女" ← 性别/);
});

test("the redactor used for spec labels follows the same rules", () => {
  const redact = outline.createRedactor(["王小明"]);
  assert.equal(redact("王小明"), outline.REDACTED);
  assert.equal(redact("联系电话 138 1234 5678"), outline.REDACTED);
  assert.equal(redact("最高学历"), "最高学历");
  assert.equal(Array.from(redact("一".repeat(80), 30)).length, 30);
});
