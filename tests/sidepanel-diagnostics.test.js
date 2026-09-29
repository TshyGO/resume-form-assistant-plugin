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
