import { test } from "node:test";
import assert from "node:assert/strict";
import { exportFileName, importMessage } from "./resume-text.ts";

test("新建与覆盖的导入提示和插件一致", () => {
  assert.deepEqual(importMessage(12, null), { tone: "ok", text: "简历模板导入成功，共 12 个字段。" });
  assert.deepEqual(importMessage(12, 10), { tone: "ok", text: "模板已覆盖，字段 10 → 12 个。" });
  const same = importMessage(12, 12);
  assert.equal(same.tone, "warn");
  assert.match(same.text, /仍是 12 个字段，数量没有变化/);
});

test("导出文件名去掉文件系统不收的字符", () => {
  assert.equal(exportFileName('a/b:c*?"<>|名'), "abc名.xlsx");
  assert.equal(exportFileName("  "), "简历模板.xlsx");
});
