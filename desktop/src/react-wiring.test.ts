import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// D10 踩过一次：test:ui 没写成 glob，29 个前端测试压根没在 CI 跑（#90）。
// 现在测试分成两套（.ts 走 node --test，.tsx 走 vitest），这条守卫盯着两套都真的会被跑到。
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

test("vitest 按 glob 收组件测试，新加的 .test.tsx 自动进", () => {
  const config = read("../vitest.config.ts");
  assert.match(config, /include:\s*\["src\/\*\*\/\*\.test\.tsx"\]/);
  assert.match(config, /environment:\s*"jsdom"/);
});

test("两套测试都挂在 npm test 上", () => {
  const pkg = JSON.parse(read("../package.json"));
  assert.match(pkg.scripts["test:react"], /vitest run/);
  assert.match(pkg.scripts["test:ui"], /node --test/);
  for (const script of ["test:ui", "test:react"]) {
    assert.ok(pkg.scripts.test.includes(`npm run ${script}`), `npm test 少了 ${script}`);
  }
});

test("CI 两套都跑", () => {
  const workflow = read("../../.github/workflows/desktop.yml");
  assert.ok(workflow.includes("npm run test:ui"), "CI 没跑 .ts 的测试");
  assert.ok(workflow.includes("npm run test:react"), "CI 没跑 .tsx 的组件测试");
});
