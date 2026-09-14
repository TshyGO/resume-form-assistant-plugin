const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const helpers = require("../ai-helpers.js");

const options = (texts) => texts.map((text) => ({ value: text, text }));

// 用真实的 ai-worker.js，桩掉 fetch，看它到底把哪些字段交给了 AI。
function loadWorker(onRequest) {
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: helpers, AbortController, TextEncoder, SyntaxError, performance,
    fetch: async (url, init) => {
      onRequest(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "[]" } }] }) };
    }
  });
  context.self = {};
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../ai-worker.js"), "utf8"), context);
  return context;
}

const AI_CONFIG = { apiUrl: "https://example.test/v1/chat/completions", model: "test", apiKey: "key" };

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

test("select validation accepts the same loose spellings the page fill accepts", () => {
  const filtered = helpers.filterValidMatches([
    { fieldId: "degree", label: "最高学历", inputType: "select", options: ["请选择", "大学本科", "硕士研究生"] }
  ], [{ fieldId: "degree", value: "本科" }]);

  assert.deepEqual(filtered, [{ fieldId: "degree", value: "本科" }]);
});

// 没被识别成联动组的下一级下拉框，刚出来时只有「请选择」。AI 给的值要留到页面上等选项加载后再选。
test("a select whose options have not loaded yet does not throw the value away", () => {
  const filtered = helpers.filterValidMatches([
    { fieldId: "city", label: "所在城市", inputType: "select", options: ["请选择"] },
    { fieldId: "empty", label: "所在区县", inputType: "select", options: [] }
  ], [{ fieldId: "city", value: "南阳市" }, { fieldId: "empty", value: "南召县" }]);

  assert.deepEqual(filtered, [{ fieldId: "city", value: "南阳市" }, { fieldId: "empty", value: "南召县" }]);
});

test("region: 户口性质 is filled from a field with exactly that name", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "a", label: "户口性质", inputType: "select", options: ["城镇", "农村"] }],
    [
      { group: "户籍与地区", key: "户口所在地省", value: "河南省" },
      { group: "户籍与地区", key: "户口性质", value: "农村" }
    ]
  );

  assert.deepEqual(matches, [{ fieldId: "a", value: "农村" }]);
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

test("findSelectOptionIndex: exact value or text", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["男", "女"]), "男"), 0);
  assert.equal(helpers.findSelectOptionIndex([{ value: "1", text: "身份证" }], "1"), 0);
  assert.equal(helpers.findSelectOptionIndex(["汉族", "回族"], "回族"), 1);
});

test("findSelectOptionIndex: 选择其他 is a real option, Select… is a placeholder, values compare loosely", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["选择", "选择其他", "本科"]), "选择其他"), 1);
  assert.equal(helpers.findSelectOptionIndex(options(["Select Degree", "Bachelor"]), "degree"), -1);
  assert.equal(helpers.findSelectOptionIndex([{ value: "MALE", text: "Man" }, { value: "FEMALE", text: "Woman" }], "male"), 0);
  assert.equal(helpers.isPlaceholderOption({ value: "", text: "Choose one" }), true);
});

test("person scope: English emergency contact and a 父母 group stay off the applicant", () => {
  const matches = helpers.buildRuleBasedMatches(
    [
      { fieldId: "emg", label: "Emergency Contact Name", inputType: "text", options: [] },
      { fieldId: "parents", label: "姓名", group: "父母情况", inputType: "text", options: [] },
      { fieldId: "own", label: "姓名", inputType: "text", options: [] }
    ],
    [{ group: "基本信息", key: "姓名", value: "张三" }]
  );

  assert.deepEqual(matches, [{ fieldId: "own", value: "张三" }]);
});

test("findSelectOptionIndex: ignores spacing, brackets and hyphens", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["中国(CHINA)", "美国(USA)"]), "中国（CHINA）"), 0);
  assert.equal(helpers.findSelectOptionIndex(options(["CET-6", "CET-4"]), "cet6"), 0);
});

test("findSelectOptionIndex: containment in either direction when it is unambiguous", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["请选择学位", "大学本科", "硕士研究生"]), "本科"), 1);
  assert.equal(helpers.findSelectOptionIndex(options(["学士", "硕士", "博士"]), "硕士学位"), 1);
});

test("findSelectOptionIndex: refuses to guess between several containing options", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["博士研究生", "博士后"]), "博士"), -1);
});

test("findSelectOptionIndex: negated options never stand in for the positive one, and back", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["全日制", "非全日制"]), "全日制"), 0);
  assert.equal(helpers.findSelectOptionIndex(options(["全日制", "非全日制"]), "非全日制"), 1);
  assert.equal(helpers.findSelectOptionIndex(options(["全日制（统招）", "在职"]), "全日制"), 0);
  assert.equal(helpers.findSelectOptionIndex(options(["全日制", "在职"]), "非全日制"), -1);
});

test("findSelectOptionIndex: placeholders and misses return -1", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["请选择学历", "大学本科"]), "学历"), -1);
  assert.equal(helpers.findSelectOptionIndex(options(["男", "女"]), "保密"), -1);
  assert.equal(helpers.findSelectOptionIndex(options(["汉族"]), ""), -1);
  assert.equal(helpers.findSelectOptionIndex(null, "男"), -1);
});

test("findSelectOptionIndex: a placeholder or disabled option is never a match, even exactly", () => {
  assert.equal(helpers.findSelectOptionIndex(options(["请选择", "男", "女"]), "请选择"), -1);
  assert.equal(helpers.findSelectOptionIndex(options(["Please select", "Yes", "No"]), "Please select"), -1);
  assert.equal(helpers.findSelectOptionIndex([{ value: "x", text: "已停招", disabled: true }, { value: "y", text: "在招" }], "已停招"), -1);
  assert.equal(helpers.findSelectOptionIndex([{ value: " 1 ", text: "身份证" }], "1"), 0);
});

test("rules: an invalid first candidate does not block a valid later one", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "a", label: "籍贯", inputType: "select", options: ["河南省"] }],
    [
      { group: "户籍与地区", key: "籍贯县", value: "南召县" },
      { group: "户籍与地区", key: "籍贯省", value: "河南省" }
    ]
  );

  assert.deepEqual(matches, [{ fieldId: "a", value: "河南省" }]);
});

test("region: a form field's own label decides its topic before its group name", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "a", label: "籍贯", group: "户籍与地区", inputType: "select", options: ["河南省"] }],
    [{ group: "基本信息", key: "籍贯", value: "河南省" }]
  );

  assert.deepEqual(matches, [{ fieldId: "a", value: "河南省" }]);
});

test("region: 户口性质 is not a place and never takes 户口所在地", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "a", label: "户口性质", inputType: "text", options: [] }],
    [{ group: "户籍与地区", key: "户口所在地省", value: "河南省" }]
  );

  assert.deepEqual(matches, []);
});

test("person scope: shortened emergency labels and a generic 家庭主要成员 name stay off the applicant", () => {
  const byId = new Map(helpers.buildRuleBasedMatches(
    [
      { fieldId: "own-name", label: "姓名", inputType: "text", options: [] },
      { fieldId: "emg", label: "紧急联系电话", inputType: "text", options: [] }
    ],
    [
      { group: "家庭主要成员", key: "姓名", value: "张父" },
      { group: "基本信息", key: "手机", value: "13800000000" },
      { group: "基本信息", key: "姓名", value: "张三" }
    ]
  ).map((match) => [match.fieldId, match.value]));

  assert.equal(byId.get("own-name"), "张三");
  assert.equal(byId.has("emg"), false, "the applicant's own mobile is not an emergency contact number");
});

test("region: exam origin is never filled from native place", () => {
  const matches = helpers.buildRuleBasedMatches(
    [
      { fieldId: "a", label: "籍贯", inputType: "select", options: ["河南省"] },
      { fieldId: "b", label: "高考生源地", inputType: "select", options: ["河南省"] }
    ],
    [
      { group: "户籍与地区", key: "籍贯省", value: "河南省" },
      { group: "户籍与地区", key: "籍贯市", value: "南阳市" },
      { group: "户籍与地区", key: "高考生源地省", value: "河南省" }
    ]
  );

  const byId = new Map(matches.map((m) => [m.fieldId, m.value]));
  assert.equal(byId.get("a"), "河南省");
  assert.equal(byId.get("b"), "河南省");
  assert.ok(!matches.some((m) => m.value === "南阳市"));
});

test("region: a 户籍 group name does not turn 籍贯 into hukou", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "a", label: "籍贯", inputType: "select", options: ["河南省"] }],
    [{ group: "户籍与地区", key: "籍贯省", value: "河南省" }]
  );

  assert.deepEqual(matches, [{ fieldId: "a", value: "河南省" }]);
});

test("region: province, city and county each take their own level", () => {
  const matches = helpers.buildRuleBasedMatches(
    [
      { fieldId: "p", label: "户口所在地", placeholder: "请选择省", inputType: "select", options: ["河南省"] },
      { fieldId: "c", label: "户口所在地", placeholder: "请选择市", inputType: "select", options: ["南阳市"] },
      { fieldId: "d", label: "户口所在地", placeholder: "请选择区县", inputType: "select", options: ["南召县"] }
    ],
    [
      { group: "户籍与地区", key: "户口所在地省", value: "河南省" },
      { group: "户籍与地区", key: "户口所在地市", value: "南阳市" },
      { group: "户籍与地区", key: "户口所在地区县", value: "南召县" }
    ]
  );

  const byId = new Map(matches.map((m) => [m.fieldId, m.value]));
  assert.equal(byId.get("p"), "河南省");
  assert.equal(byId.get("c"), "南阳市");
  assert.equal(byId.get("d"), "南召县");
});

test("region: the 区 in 地区 is not a county level", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "p", label: "籍贯地区", inputType: "select", options: ["河南省"] }],
    [
      { group: "户籍与地区", key: "籍贯省", value: "河南省" },
      { group: "户籍与地区", key: "籍贯县", value: "南召县" }
    ]
  );

  assert.deepEqual(matches, [{ fieldId: "p", value: "河南省" }]);
});

// 工行把紧急联系人放在「个人基本信息」分组下，紧急联系人的姓名和电话曾被填成本人的。
test("person scope: emergency contact and parents never take the applicant's own values", () => {
  const resumeFields = [
    { group: "基本信息", key: "姓名", value: "张三" },
    { group: "基本信息", key: "手机", value: "13800000000" },
    { group: "联系方式", key: "紧急联系人姓名", value: "张父" },
    { group: "联系方式", key: "紧急联系人电话", value: "13700000000" },
    { group: "家庭主要成员", key: "父亲姓名", value: "张父" }
  ];
  const formFields = [
    { fieldId: "own-name", label: "真实姓名", inputType: "text", options: [] },
    { fieldId: "own-phone", label: "移动电话", inputType: "text", options: [] },
    { fieldId: "emg-name", label: "紧急联系人", placeholder: "请输入姓名", inputType: "text", options: [], group: "个人基本信息" },
    { fieldId: "emg-phone", label: "紧急联系人电话", inputType: "text", options: [], group: "个人基本信息" },
    { fieldId: "father-name", label: "请输入姓名", inputType: "text", options: [], group: "父亲" },
    { fieldId: "mother-name", label: "请输入姓名", inputType: "text", options: [], group: "母亲" }
  ];

  const byId = new Map(helpers.buildRuleBasedMatches(formFields, resumeFields).map((m) => [m.fieldId, m.value]));

  assert.equal(byId.get("own-name"), "张三");
  assert.equal(byId.get("own-phone"), "13800000000");
  assert.equal(byId.get("emg-name"), "张父");
  assert.equal(byId.get("emg-phone"), "13700000000");
  assert.equal(byId.get("father-name"), "张父");
  assert.equal(byId.has("mother-name"), false, "no mother data, so nothing, and certainly not the applicant or father");
});

test("person scope: an unspecified family member row gets neither the applicant nor a guessed relative", () => {
  const matches = helpers.buildRuleBasedMatches(
    [{ fieldId: "member", label: "姓名", inputType: "text", options: [], group: "家庭成员" }],
    [
      { group: "基本信息", key: "姓名", value: "张三" },
      { group: "家庭主要成员", key: "父亲姓名", value: "张父" }
    ]
  );

  assert.deepEqual(matches, []);
});

// 以前证件类型、学历、学位、年月这类下拉框被挡在 AI 外面，本地规则又不处理，永远填不上。
test("worker: choice fields the rules cannot fill are sent to AI with their options", async () => {
  let body = null;
  const worker = loadWorker((request) => { body = request; });

  const result = await worker.handleAiFill({
    aiConfig: AI_CONFIG,
    formFields: [
      { fieldId: "f1", label: "证件类型", inputType: "select", tagName: "select", options: ["身份证", "护照"] },
      { fieldId: "f2", label: "最高学历", inputType: "select", tagName: "select", options: ["大学本科", "硕士研究生"] },
      { fieldId: "f3", label: "出生年份", inputType: "select", tagName: "select", options: ["2005", "2006"] }
    ],
    resumeFields: [
      { group: "基本信息", key: "证件类型", value: "身份证" },
      { group: "教育背景", key: "最高学历", value: "大学本科" },
      { group: "基本信息", key: "出生年月", value: "2005-09" }
    ]
  });

  assert.equal(result.diagnostics.aiFields, 3);
  const prompt = body.messages[1].content;
  for (const text of ["证件类型", "最高学历", "出生年份", "身份证"]) {
    assert.ok(prompt.includes(text), `${text} should reach the prompt`);
  }
});

test("worker: a rule value the field cannot accept does not count as matched", async () => {
  let body = null;
  const worker = loadWorker((request) => { body = request; });

  const result = await worker.handleAiFill({
    aiConfig: AI_CONFIG,
    formFields: [{ fieldId: "g", label: "Gender", inputType: "select", tagName: "select", options: ["M", "F"] }],
    resumeFields: [{ group: "基本信息", key: "性别", value: "男" }]
  });

  assert.equal(result.diagnostics.ruleMatches, 0);
  assert.equal(result.diagnostics.aiFields, 1);
  assert.ok(body.messages[1].content.includes("Gender"));
});
