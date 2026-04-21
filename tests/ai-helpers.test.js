const test = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("../ai-helpers.js");

test("rule-based matching keeps strong basic info and ignores unsupported pinyin derivation", () => {
  const formFields = [
    { fieldId: "field-name", label: "姓名", placeholder: "", name: "", idAttr: "", ariaLabel: "" },
    { fieldId: "field-pinyin", label: "姓拼音", placeholder: "", name: "", idAttr: "", ariaLabel: "" },
    { fieldId: "field-email", label: "邮箱", placeholder: "", name: "", idAttr: "", ariaLabel: "" },
    { fieldId: "field-phone", label: "手机号码", placeholder: "", name: "", idAttr: "", ariaLabel: "" }
  ];

  const resumeFields = [
    { group: "基本信息", key: "姓名", value: "测试用户" },
    { group: "基本信息", key: "邮箱", value: "demo.user@example.com" },
    { group: "基本信息", key: "手机号码", value: "13800138000" }
  ];

  const matches = helpers.buildRuleBasedMatches(formFields, resumeFields);

  assert.deepEqual(matches, [
    { fieldId: "field-name", value: "测试用户" },
    { fieldId: "field-email", value: "demo.user@example.com" },
    { fieldId: "field-phone", value: "13800138000" }
  ]);
});

test("value validation rejects obviously wrong AI matches", () => {
  const formFields = [
    { fieldId: "pinyin", label: "姓拼音", placeholder: "", name: "", idAttr: "", ariaLabel: "" },
    { fieldId: "birth", label: "出生日期", placeholder: "", name: "", idAttr: "", ariaLabel: "" },
    { fieldId: "email", label: "邮箱", placeholder: "", name: "", idAttr: "", ariaLabel: "" }
  ];

  const filtered = helpers.filterValidMatches(formFields, [
    { fieldId: "pinyin", value: "demo.user@example.com" },
    { fieldId: "birth", value: "博士研究生" },
    { fieldId: "email", value: "化学工程与技术" }
  ]);

  assert.deepEqual(filtered, []);
});

test("high-risk basic info fields are held back from AI guessing", () => {
  assert.equal(
    helpers.shouldSkipAIForField({ fieldId: "pinyin", label: "姓拼音", inputType: "text", options: [] }),
    true
  );
  assert.equal(
    helpers.shouldSkipAIForField({ fieldId: "email", label: "邮箱", inputType: "text", options: [] }),
    true
  );
  assert.equal(
    helpers.shouldSkipAIForField({ fieldId: "summary", label: "个人概述", inputType: "textarea", options: [] }),
    false
  );
});

test("select and radio matches must hit actual options", () => {
  const filtered = helpers.filterValidMatches([
    { fieldId: "gender", label: "性别", inputType: "radio", options: ["男", "女"] },
    { fieldId: "degree", label: "学历", inputType: "select", options: ["本科", "硕士", "博士"] }
  ], [
    { fieldId: "gender", value: "男" },
    { fieldId: "degree", value: "华东理工大学" }
  ]);

  assert.deepEqual(filtered, [
    { fieldId: "gender", value: "男" }
  ]);
});

test("parsed fields get semantic names from anchor values", () => {
  const normalized = helpers.normalizeParsedFields([
    { group: "实习经历", key: "实习1公司", value: "陶氏" },
    { group: "实习经历", key: "实习1岗位", value: "研发实习生" },
    { group: "实习经历", key: "实习1起止时间", value: "2023.06-2023.08" },
    { group: "教育背景", key: "教育1学校", value: "华东理工大学" },
    { group: "教育背景", key: "教育1专业", value: "化学工程与技术" }
  ]);

  assert.deepEqual(normalized, [
    { group: "实习经历", key: "陶氏实习经历-公司", value: "陶氏" },
    { group: "实习经历", key: "陶氏实习经历-岗位", value: "研发实习生" },
    { group: "实习经历", key: "陶氏实习经历-起止时间", value: "2023.06-2023.08" },
    { group: "教育背景", key: "华东理工大学教育经历-学校", value: "华东理工大学" },
    { group: "教育背景", key: "华东理工大学教育经历-专业", value: "化学工程与技术" }
  ]);
});
