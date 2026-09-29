// #206：侧栏「填写诊断」一键复制，方便用户贴到反馈里。
const test = require("node:test");
const assert = require("node:assert/strict");
const { openPanel, read } = require("./helpers/sidepanel-harness.js");

test("the copy button copies the diagnostics text and confirms with a toast", async () => {
  const panel = await openPanel();
  panel.get("fill-diagnostics-text").value = "网申快填 v0.4.1\n页面：c.liepin.com";
  await panel.click("copy-diagnostics");
  assert.deepEqual(panel.clipboardWrites, ["网申快填 v0.4.1\n页面：c.liepin.com"]);
  assert.equal(panel.toast(), "填写诊断已复制，可以粘贴到反馈里。");
});

test("the copy button is a plain button inside the collapsible diagnostics block", () => {
  // 测试用的假页面会凭空造出任何 id，所以按钮真的在 HTML 里，要单独检查。
  const html = read("sidepanel.html");
  const start = html.indexOf('<details id="fill-diagnostics"');
  assert.notEqual(start, -1);
  const block = html.slice(start, html.indexOf("</details>", start));
  assert.equal(html.split('id="copy-diagnostics"').length, 2, "exactly one copy button");
  const button = block.match(/<button[^>]*id="copy-diagnostics"[^>]*>复制诊断<\/button>/);
  assert.ok(button, "the button sits inside #fill-diagnostics");
  assert.match(button[0], /type="button"/);
  assert.ok(block.indexOf('id="fill-diagnostics-text"') < block.indexOf('id="copy-diagnostics"'), "after the text it copies");
});

test("a clipboard that refuses ends in a manual-copy toast, never a success one", async () => {
  const panel = await openPanel({ clipboardRejects: true });
  panel.get("fill-diagnostics-text").value = "网申快填 v0.4.1\n页面：c.liepin.com";
  await panel.click("copy-diagnostics");
  assert.deepEqual(panel.clipboardWrites, []);
  assert.equal(panel.toast(), "复制失败，请手动选中诊断文字复制。");
});
