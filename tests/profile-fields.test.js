const test = require("node:test");
const assert = require("node:assert/strict");

const profileApi = require("../profile-fields.js");
const helpers = require("../ai-helpers.js");

test("normalizeProfile drops blanks and empty members, keeps pending custom fields once", () => {
  const profile = profileApi.normalizeProfile({
    values: { name: " 张三 ", usedName: "   " },
    family: [
      { relation: "父亲", name: "张父" },
      { relation: "表哥", name: "张表" },
      { relation: "母亲", name: "" }
    ],
    custom: [
      { key: "是否有亲属在本行", value: "" },
      { key: "是否有亲属在本行 ", value: "否" },
      { key: "  ", value: "x" }
    ]
  });

  assert.deepEqual(profile.values, { name: "张三" });
  assert.deepEqual(profile.family.map((member) => [member.relation, member.name]), [["父亲", "张父"], ["其他亲属", "张表"]]);
  assert.deepEqual(profile.custom, [{ key: "是否有亲属在本行", value: "" }]);
  assert.deepEqual(profileApi.normalizeProfile(null), profileApi.emptyProfile());
});

test("profile fields: presets, numbered repeat relations, filled custom fields only", () => {
  const fields = profileApi.profileToResumeFields({
    values: { name: "张三", nativeProvince: "河南省" },
    family: [
      { relation: "父亲", name: "张父", company: "某公司" },
      { relation: "兄弟姐妹", name: "张一" },
      { relation: "兄弟姐妹", name: "张二" }
    ],
    custom: [{ key: "英语口语", value: "流利" }, { key: "待补字段", value: "" }]
  });

  assert.deepEqual(fields, [
    { group: "基本信息", key: "姓名", value: "张三" },
    { group: "户籍与地区", key: "籍贯省", value: "河南省" },
    { group: "家庭主要成员", key: "父亲姓名", value: "张父" },
    { group: "家庭主要成员", key: "父亲工作单位", value: "某公司" },
    { group: "家庭主要成员", key: "兄弟姐妹1姓名", value: "张一" },
    { group: "家庭主要成员", key: "兄弟姐妹2姓名", value: "张二" },
    { group: "补充字段", key: "英语口语", value: "流利" }
  ]);
  assert.equal(profileApi.countPendingFields({ custom: [{ key: "待补字段", value: "" }] }), 1);
});

test("template fields win over profile fields with the same name", () => {
  const merged = profileApi.mergeResumeFields(
    [{ group: "基本信息", key: "姓名", value: "模板里的名字" }],
    [{ group: "基本信息", key: "姓名", value: "档案里的名字" }, { group: "基本信息", key: "民族", value: "汉族" }]
  );

  assert.deepEqual(merged.map((field) => field.value), ["模板里的名字", "汉族"]);
});

test("unanswered labels skip matched, filled, secret, file and known fields", () => {
  const known = profileApi.knownFieldKeys({ custom: [{ key: "已加过的字段", value: "" }] }, [{ key: "毕业院校" }]);
  const labels = profileApi.pickUnansweredLabels([
    { label: "是否有亲属在本行工作", inputType: "select" },
    { label: "是否有亲属在本行工作", inputType: "select" },
    { label: "姓名", inputType: "text", matched: true },
    { label: "兴趣爱好", inputType: "text", hasValue: true },
    { label: "登录密码", inputType: "text" },
    { label: "短信验证码", inputType: "text" },
    { label: "本人照片", inputType: "file" },
    { label: "我已阅读并同意", inputType: "checkbox" },
    { label: "身高（厘米）", inputType: "text" },
    { label: "已加过的字段", inputType: "text" },
    { label: "毕业院校", inputType: "text" },
    { label: "问", inputType: "text" },
    { label: "这是一个非常非常非常非常非常非常非常非常非常长的说明文字字段标签内容", inputType: "textarea" },
    { label: "职业规划", inputType: "textarea" }
  ], known);

  assert.deepEqual(labels, ["是否有亲属在本行工作", "职业规划"]);
  assert.equal(profileApi.pickUnansweredLabels(
    Array.from({ length: 30 }, (_, index) => ({ label: `字段${index}`, inputType: "text" })),
    new Set()
  ).length, 20);
});

test("adding pending fields skips what the profile already has", () => {
  const { profile, added } = profileApi.addPendingFields(
    { values: { name: "张三" }, custom: [{ key: "英语口语", value: "流利" }] },
    ["是否服从调剂", "英语口语", "职业规划", "职业规划"]
  );

  assert.equal(added, 1, "是否服从调剂 is a preset, 英语口语 exists, 职业规划 once");
  assert.deepEqual(profile.custom, [{ key: "英语口语", value: "流利" }, { key: "职业规划", value: "" }]);
  assert.equal(profile.values.name, "张三");
});

test("form entries round-trip into a profile", () => {
  const profile = profileApi.profileFromEntries([
    { kind: "value", field: "name", value: "张三" },
    { kind: "family", row: "3", field: "relation", value: "母亲" },
    { kind: "family", row: "3", field: "name", value: "李母" },
    { kind: "family", row: "4", field: "relation", value: "父亲" },
    { kind: "custom", row: "7", field: "key", value: "英语口语" },
    { kind: "custom", row: "7", field: "value", value: "流利" }
  ]);

  assert.deepEqual(profile.values, { name: "张三" });
  assert.deepEqual(profile.family.map((member) => [member.relation, member.name]), [["母亲", "李母"]]);
  assert.deepEqual(profile.custom, [{ key: "英语口语", value: "流利" }]);
});

test("merging a backup keeps what this machine already filled in", () => {
  const merged = profileApi.mergeProfiles(
    { values: { name: "本机" }, family: [{ relation: "父亲", name: "本机父亲" }], custom: [{ key: "英语口语", value: "" }] },
    {
      values: { name: "备份", ethnicity: "汉族" },
      family: [{ relation: "母亲", name: "备份母亲" }],
      custom: [{ key: "英语口语", value: "流利" }, { key: "职业规划", value: "银行" }]
    }
  );

  assert.deepEqual(merged.values, { name: "本机", ethnicity: "汉族" });
  assert.deepEqual(merged.family.map((member) => member.name), ["本机父亲"]);
  assert.deepEqual(merged.custom, [{ key: "英语口语", value: "流利" }, { key: "职业规划", value: "银行" }]);
});

test("rules: profile region keys fill the right level and topic", () => {
  const resumeFields = profileApi.profileToResumeFields({
    values: { nativeProvince: "河南省", nativeCity: "南阳市", hukouCounty: "南召县", examProvince: "湖北省" }
  });
  const byId = new Map(helpers.buildRuleBasedMatches([
    { fieldId: "np", label: "籍贯", placeholder: "请选择省", inputType: "select", options: ["河南省"] },
    { fieldId: "nc", label: "籍贯", placeholder: "请选择市", inputType: "select", options: ["南阳市"] },
    { fieldId: "hk", label: "户口所在地", placeholder: "请选择区县", inputType: "select", options: ["南召县"] },
    { fieldId: "ex", label: "生源地", placeholder: "请选择省", inputType: "select", options: ["湖北省"] }
  ], resumeFields).map((match) => [match.fieldId, match.value]));

  assert.equal(byId.get("np"), "河南省");
  assert.equal(byId.get("nc"), "南阳市");
  assert.equal(byId.get("hk"), "南召县");
  assert.equal(byId.get("ex"), "湖北省");
});

test("rules: family and emergency contact data never fill the applicant's own fields", () => {
  const resumeFields = profileApi.profileToResumeFields({
    values: { emergencyName: "王五", emergencyPhone: "13700000000" },
    family: [{ relation: "兄弟姐妹", name: "张一", phone: "13900000000" }, { relation: "父亲", name: "张父" }]
  });
  const byId = new Map(helpers.buildRuleBasedMatches([
    { fieldId: "own-name", label: "姓名", inputType: "text", options: [] },
    { fieldId: "own-phone", label: "手机号码", inputType: "text", options: [] },
    { fieldId: "father", label: "姓名", group: "父亲", inputType: "text", options: [] },
    { fieldId: "emg-phone", label: "紧急联系人电话", inputType: "text", options: [] }
  ], resumeFields).map((match) => [match.fieldId, match.value]));

  assert.equal(byId.has("own-name"), false);
  assert.equal(byId.has("own-phone"), false);
  assert.equal(byId.get("father"), "张父");
  assert.equal(byId.get("emg-phone"), "13700000000");
});
