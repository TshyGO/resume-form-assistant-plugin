import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldsToGroups, parseModelReply, templateNameFor } from "./parse-resume.ts";

test("去掉 ```json 围栏后解析，并按插件规则整理", () => {
  const fields = parseModelReply('```json\n[{"group":"基本信息","key":"姓名","value":"张三"}]\n```');
  assert.deepEqual(fields, [{ group: "基本信息", key: "姓名", value: "张三" }]);
});

test("返回不是 JSON 数组时给出插件同款提示", () => {
  assert.throws(() => parseModelReply("抱歉，我无法处理"), /AI 返回格式异常，无法解析/);
  assert.throws(() => parseModelReply("[]"), /AI 未能提取到有效信息/);
});

test("按分组首次出现的顺序合并", () => {
  const groups = fieldsToGroups([
    { group: "基本信息", key: "姓名", value: "张三" },
    { group: "教育背景", key: "学校", value: "某大学" },
    { group: "基本信息", key: "邮箱", value: "a@b.c" },
  ]);
  assert.deepEqual(groups.map((g) => [g.name, g.fields.map((f) => f.key)]), [
    ["基本信息", ["姓名", "邮箱"]],
    ["教育背景", ["学校"]],
  ]);
});

test("模板名取文件名并注明 AI 解析", () => {
  assert.equal(templateNameFor("张三-简历.pdf"), "张三-简历（AI 解析）");
  assert.equal(templateNameFor(".pdf"), "简历（AI 解析）");
});
