import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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

  // 直接把 ai-worker.js 里 `const SYSTEM_PROMPT = [ ... ].join("\n");` 的数组字面量
  // 抠出来，用 vm 当真正的 JS 求值，再逐字比较——比「每行是不是在文件里出现过」严格，
  // 不会因为某行文字恰好在别处出现就误判通过。
  const match = worker.match(/const SYSTEM_PROMPT = (\[[\s\S]*?\])\s*\.join\("\\n"\);/);
  assert.ok(match, "在 ai-worker.js 里没找到 SYSTEM_PROMPT 数组定义");
  const promptLines = vm.runInNewContext(`(${match![1]})`);
  assert.equal(promptLines.join("\n"), RESUME_PARSE_SYSTEM_PROMPT);

  assert.ok(worker.includes("请提取以下简历中的所有信息：\\n\\n"));
  assert.equal(RESUME_PARSE_USER_PREFIX, "请提取以下简历中的所有信息：\n\n");
});

test("解析辅助的类型化入口可用", async () => {
  const { parseHelpers } = await import("./parse-helpers.ts");
  const fields = parseHelpers.normalizeParsedFields([{ group: "基本信息", key: "姓名", value: "张三" }, { group: "", key: "x", value: "y" }]);
  assert.deepEqual(fields.map((f) => f.key), ["姓名"]);
  assert.equal(typeof parseHelpers.extractPdfText, "function");
});
