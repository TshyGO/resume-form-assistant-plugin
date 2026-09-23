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

// 插件在 PR 5 删掉解析功能时，这条测试一起删，桌面成为唯一实现。
test("解析提示词与插件 ai-worker.js 的一致", async () => {
  const worker = readFileSync(new URL("../../../ai-worker.js", import.meta.url), "utf8");
  const { RESUME_PARSE_SYSTEM_PROMPT, RESUME_PARSE_USER_PREFIX } = await import("./parse-helpers.ts");
  for (const line of RESUME_PARSE_SYSTEM_PROMPT.split("\n")) {
    assert.ok(worker.includes(JSON.stringify(line).slice(1, -1)) || worker.includes(line), line);
  }
  assert.ok(worker.includes("请提取以下简历中的所有信息：\\n\\n"));
  assert.equal(RESUME_PARSE_USER_PREFIX, "请提取以下简历中的所有信息：\n\n");
});

test("解析辅助的类型化入口可用", async () => {
  const { parseHelpers } = await import("./parse-helpers.ts");
  const fields = parseHelpers.normalizeParsedFields([{ group: "基本信息", key: "姓名", value: "张三" }, { group: "", key: "x", value: "y" }]);
  assert.deepEqual(fields.map((f) => f.key), ["姓名"]);
  assert.equal(typeof parseHelpers.extractPdfText, "function");
});
