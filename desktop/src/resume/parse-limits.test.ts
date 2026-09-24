import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// `parse-limits.ts` 里的两个数字，其实是 Rust 那边同一条规则的复制品：前端提前拦，
// 免得白花一次 AI 调用或一次建模板请求，但复制品早晚会跟原件走岔——这条测试直接
// 读 Rust 源码文本，把真正的数字抠出来，跟前端这份比对，不指望人记得两边一起改。
test("前端锁死的上限数字和后端源码里写的一致", async () => {
  const { MAX_USER_CHARS, MAX_TEMPLATES } = await import("./parse-limits.ts");

  const aiComplete = readFileSync(new URL("../../src-tauri/src/ai_complete.rs", import.meta.url), "utf8");
  const userCharsMatch = aiComplete.match(/pub const MAX_USER_CHARS: usize = ([\d_]+);/);
  assert.ok(userCharsMatch, "在 ai_complete.rs 里没找到 MAX_USER_CHARS 的定义");
  assert.equal(MAX_USER_CHARS, Number(userCharsMatch![1].replace(/_/g, "")));

  const resumeStore = readFileSync(new URL("../../crates/archive-store/src/resume.rs", import.meta.url), "utf8");
  const maxTemplatesMatch = resumeStore.match(/pub const MAX_TEMPLATES: usize = ([\d_]+);/);
  assert.ok(maxTemplatesMatch, "在 archive-store/src/resume.rs 里没找到 MAX_TEMPLATES 的定义");
  assert.equal(MAX_TEMPLATES, Number(maxTemplatesMatch![1].replace(/_/g, "")));
});
