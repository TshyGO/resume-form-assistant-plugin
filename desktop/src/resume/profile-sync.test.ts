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
