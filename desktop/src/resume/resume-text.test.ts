import { test } from "node:test";
import assert from "node:assert/strict";
import { exportFileName, importMessage, templateDates, templateNameProblem } from "./resume-text.ts";

test("新建与覆盖的导入提示和插件一致", () => {
  assert.deepEqual(importMessage(12, null), { tone: "ok", text: "简历模板导入成功，共 12 个字段。" });
  assert.deepEqual(importMessage(12, 10), { tone: "ok", text: "模板已覆盖，字段 10 → 12 个。" });
  const same = importMessage(12, 12);
  assert.equal(same.tone, "warn");
  assert.match(same.text, /仍是 12 个字段，数量没有变化/);
});

test("有字段因为像密码没导入时补一句，并改用提醒语气", () => {
  assert.deepEqual(importMessage(12, null, 0), { tone: "ok", text: "简历模板导入成功，共 12 个字段。" });
  assert.deepEqual(importMessage(12, null, 2), {
    tone: "warn",
    text: "简历模板导入成功，共 12 个字段。另有 2 个像密码或验证码的字段没有导入。",
  });
  assert.deepEqual(importMessage(12, 10, 1), {
    tone: "warn",
    text: "模板已覆盖，字段 10 → 12 个。另有 1 个像密码或验证码的字段没有导入。",
  });
  const same = importMessage(12, 12, 1);
  assert.equal(same.tone, "warn");
  assert.match(same.text, /数量没有变化.*另有 1 个像密码或验证码的字段没有导入。$/);
});

test("导出文件名去掉文件系统不收的字符", () => {
  assert.equal(exportFileName('a/b:c*?"<>|名'), "abc名.xlsx");
  assert.equal(exportFileName("  "), "简历模板.xlsx");
});

test("模板更新时间按本机日期显示，读不出来时不显示", () => {
  const local = new Date(2026, 9, 8, 12, 0, 0).toISOString();
  assert.deepEqual(templateDates(local), { short: "10 月 8 日", full: "2026-10-08" });
  assert.equal(templateDates(""), null);
  assert.equal(templateDates("not-a-date"), null);
});

test("模板名称不能为空、最多 100 字", () => {
  assert.equal(templateNameProblem("  "), "名称不能为空。");
  assert.equal(templateNameProblem("字".repeat(100)), null);
  assert.equal(templateNameProblem("字".repeat(101)), "名称最多 100 字。");
});
