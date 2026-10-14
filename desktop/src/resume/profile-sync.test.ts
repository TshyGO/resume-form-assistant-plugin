import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 插件与桌面必须用同一份「我的信息」字段定义：字段 id 是存储键，两边一改一不改就会丢数据。
// 改字段时只改仓库根的 profile-fields.js，再把它原样复制到这里。
test("桌面的 profile-fields.js 与插件的一字不差", () => {
  const plugin = readFileSync(new URL("../../../profile-fields.js", import.meta.url), "utf8");
  const desktop = readFileSync(new URL("./profile-fields.js", import.meta.url), "utf8");
  assert.equal(desktop, plugin);
});

test("类型化入口拿得到字段定义与规范化", async () => {
  const { profileApi } = await import("./profile.ts");
  assert.ok(profileApi.PROFILE_SCHEMA.some((group) => group.name === "基本信息"));
  assert.deepEqual(profileApi.normalizeProfile(null), { values: {}, family: [], custom: [] });
});

test("解析用的 resume-utils.js、ai-helpers.js 与插件一字不差", () => {
  for (const name of ["resume-utils.js", "ai-helpers.js"]) {
    const plugin = readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8");
    const desktop = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    assert.equal(desktop, plugin, name);
  }
});

test("解析辅助的类型化入口可用", async () => {
  const { parseHelpers } = await import("./parse-helpers.ts");
  const fields = parseHelpers.normalizeParsedFields([{ group: "基本信息", key: "姓名", value: "张三" }, { group: "", key: "x", value: "y" }]);
  assert.deepEqual(fields.map((f) => f.key), ["姓名"]);
  assert.equal(typeof parseHelpers.extractPdfText, "function");
});

// #273：模板字段编辑的草稿与校验规则两端共用，改规则只改仓库根的 template-fields.js 再复制过来。
test("桌面的 template-fields.js 与插件的一字不差", () => {
  const plugin = readFileSync(new URL("../../../template-fields.js", import.meta.url), "utf8");
  const desktop = readFileSync(new URL("./template-fields.js", import.meta.url), "utf8");
  assert.equal(desktop, plugin);
});

test("模板字段编辑的类型化入口可用，内容摘要与存储层同一向量", async () => {
  const { templateFields } = await import("./template-fields.ts");
  const draft = templateFields.createDraft({ id: "t", name: "模板", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "张三" }] }] });
  assert.equal(templateFields.isDirty(draft), false);
  const groups = [
    { name: "基本信息", fields: [{ key: "姓名", value: "张三" }, { key: "自我评价", value: '第一行\n第二行 "引号" \\ 斜杠' }] },
    { name: "教育经历", fields: [{ key: "学校", value: "示例大学" }] },
  ];
  assert.equal(await templateFields.contentSha256(groups), "d2d71fabd5d084928e23d31a3e0e429705266391b0737b35cb12cb06d5c7a34d");
});
