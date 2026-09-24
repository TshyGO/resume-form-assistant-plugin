const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPopup } = require("./helpers/popup-harness.js");

test("manager preview follows the active template and escapes imported content", () => {
  const popup = loadPopup();
  const templates = [
    { id: "one", name: "研发版", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "张三" }] }] },
    { id: "two", name: "产品版", groups: [{ name: "<script>经历", fields: [{ key: "学校", value: "<img src=x>" }] }] }
  ];

  popup.api.renderTemplates({ templates, activeTemplateId: "two" });
  assert.equal(popup.lastStatusFrom("template-count"), "2 套");
  assert.match(popup.lastStatusFrom("template-preview-meta"), /产品版 · 1 个分组 · 1 个字段/);
  assert.match(popup.element("template-preview-groups").innerHTML, /&lt;script&gt;经历/);
  assert.match(popup.element("template-preview-groups").innerHTML, /&lt;img src=x&gt;/);
  assert.doesNotMatch(popup.element("template-preview-groups").innerHTML, /张三/);
  assert.equal(popup.element("template-preview").hidden, false);

  popup.api.renderTemplates({ templates: [], activeTemplateId: "" });
  assert.equal(popup.element("template-preview").hidden, true);
  assert.equal(popup.element("template-preview-groups").innerHTML, "");
});

test("manager preview search shows only matching rows and groups", () => {
  const popup = loadPopup();
  const school = { dataset: { previewSearch: "学校 xx大学" }, hidden: false };
  const major = { dataset: { previewSearch: "专业 材料" }, hidden: false };
  const phone = { dataset: { previewSearch: "手机号 138" }, hidden: false };
  const education = {
    hidden: false, open: false,
    querySelector: () => ({ textContent: "教育背景 2 项" }),
    querySelectorAll: () => [school, major]
  };
  const basic = {
    hidden: false, open: false,
    querySelector: () => ({ textContent: "基本信息 1 项" }),
    querySelectorAll: () => [phone]
  };
  popup.element("template-preview-groups").querySelectorAll = () => [basic, education];
  popup.element("template-preview-search").value = "学校";

  popup.api.filterTemplatePreview();
  assert.equal(basic.hidden, true);
  assert.equal(education.hidden, false);
  assert.equal(education.open, true);
  assert.equal(school.hidden, false);
  assert.equal(major.hidden, true);
  assert.equal(phone.hidden, true);

  popup.element("template-preview-search").value = "不存在";
  popup.api.filterTemplatePreview();
  assert.equal(popup.element("template-preview-empty").hidden, false);
});
