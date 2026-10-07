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
  assert.deepEqual(profile.custom, [{ key: "是否有亲属在本行", value: "否" }], "the filled duplicate wins over the empty one");
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
    { group: "家庭主要成员", key: "父亲关系", value: "父亲" },
    { group: "家庭主要成员", key: "父亲姓名", value: "张父" },
    { group: "家庭主要成员", key: "父亲工作单位", value: "某公司" },
    { group: "家庭主要成员", key: "兄弟姐妹1关系", value: "兄弟姐妹" },
    { group: "家庭主要成员", key: "兄弟姐妹1姓名", value: "张一" },
    { group: "家庭主要成员", key: "兄弟姐妹2关系", value: "兄弟姐妹" },
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

  // #228：长题目整句保留，不再因为超过 30 字被静默丢掉。
  assert.deepEqual(labels, ["是否有亲属在本行工作", "这是一个非常非常非常非常非常非常非常非常非常长的说明文字字段标签内容", "职业规划"]);
  assert.equal(profileApi.pickUnansweredLabels(
    Array.from({ length: 30 }, (_, index) => ({ label: `字段${index}`, inputType: "text" })),
    new Set()
  ).length, 20);
});

test("unanswered labels never offer counters or bare placeholder prompts, and cap runaway text (#228)", () => {
  const long = "请说明".padEnd(120, "题");
  const labels = profileApi.pickUnansweredLabels([
    { label: "0/2000", inputType: "textarea" },
    { label: "0/4000", inputType: "textarea" },
    { label: "请选择", inputType: "text" },
    { label: "请输入", inputType: "text" },
    { label: long, inputType: "textarea" },
    { label: `${long}超出`, inputType: "textarea" }
  ], new Set());
  assert.deepEqual(labels, [long]);
});

test("fields inside experience sections stay out of 我的信息 unless they are like a profile field (#228)", () => {
  const stats = {};
  const labels = profileApi.pickUnansweredLabels([
    { label: "所在实验室名称", title: "所在实验室名称", section: "教育经历" },
    { label: "教育经历-开始时间", title: "开始时间", section: "教育经历" },
    { label: "班级排名", title: "班级排名", section: "教育经历" },
    { label: "教育背景-班级排名", title: "班级排名", section: "教育背景" },
    { label: "英语等级", title: "英语等级", section: "学术活动", sectionRepeatable: true },
    { label: "活动名称", title: "活动名称", section: "学术活动", sectionRepeatable: true },
    { label: "联系电话", title: "联系电话", section: "家庭成员" },
    { label: "外语等级说明", title: "外语等级说明", section: "家庭成员" },
    { label: "工作意向城市", title: "工作意向城市", section: "工作意向" },
    { label: "名称", title: "名称", section: "" },
    { label: "你为什么选择我们公司", title: "你为什么选择我们公司", section: "附加问题" },
    { label: "技能证书", title: "技能证书", section: "语言与技能" }
  ], new Set(), undefined, stats);
  assert.deepEqual(labels, ["班级排名", "英语等级", "工作意向城市", "你为什么选择我们公司", "技能证书"]);
  assert.equal(stats.entry, 6);
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

test("password-like custom fields and duplicates of presets never reach the AI field pool", () => {
  const fields = profileApi.profileToResumeFields({
    values: { phone: "13800000000" },
    custom: [
      { key: "网银登录密码", value: "hunter2" },
      { key: "备注", value: "网银密码：hunter3" },
      { key: "手机号码", value: "13900000000" },
      { key: "英语口语", value: "流利" }
    ]
  });

  assert.deepEqual(fields.map((field) => [field.key, field.value]), [["手机号码", "13800000000"], ["英语口语", "流利"]]);
});

test("known fields cover preset aliases and blank items of members already in the profile", () => {
  const known = profileApi.knownFieldKeys({ family: [{ relation: "父亲", name: "张父" }] }, []);
  const labels = profileApi.pickUnansweredLabels(
    ["手机号", "邮箱", "父亲联系电话", "父亲工作单位", "母亲工作单位"].map((label) => ({ label, inputType: "text" })),
    known
  );

  assert.deepEqual(labels, ["母亲工作单位"]);
});

test("adding pending fields skips password-like labels and says when the list is full", () => {
  assert.equal(profileApi.addPendingFields({}, ["查询密码"]).added, 0);

  const full = { custom: Array.from({ length: 200 }, (_, index) => ({ key: `字段${index}`, value: "" })) };
  const result = profileApi.addPendingFields(full, ["职业规划"]);
  assert.equal(result.added, 0);
  assert.equal(result.full, true);

  assert.equal(profileApi.addPendingFields({}, ["毕业院校"], [{ key: "毕业院校" }]).added, 0, "template fields count as known");
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
    {
      values: { name: "本机" },
      family: [{ relation: "父亲", name: "本机父亲" }, { relation: "兄弟姐妹", name: "张一" }],
      custom: [{ key: "英语口语", value: "" }]
    },
    {
      values: { name: "备份", ethnicity: "汉族" },
      family: [
        { relation: "父亲", name: "备份父亲", company: "某公司" },
        { relation: "母亲", name: "备份母亲" },
        { relation: "兄弟姐妹", name: "张一", phone: "13900000000" },
        { relation: "兄弟姐妹", name: "张二" }
      ],
      custom: [{ key: "英语口语", value: "流利" }, { key: "职业规划", value: "银行" }]
    }
  );

  assert.deepEqual(merged.values, { name: "本机", ethnicity: "汉族" });
  assert.deepEqual(
    merged.family.map((member) => [member.relation, member.name, member.company, member.phone]),
    [
      ["父亲", "本机父亲", "某公司", ""],
      ["兄弟姐妹", "张一", "", "13900000000"],
      ["母亲", "备份母亲", "", ""],
      ["兄弟姐妹", "张二", "", ""]
    ],
    "members are merged one by one, filling only what this machine left blank"
  );
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

test("stripProfileSecrets removes secret-looking items before migration and counts them", () => {
  const input = {
    values: { fullName: "测试用户", email: "邮箱密码：abc123", phone: "13800000000" },
    family: [
      { relation: "父亲", name: "测试父亲", phone: "口令=xyz" },
      { relation: "母亲", name: "token: t-1" }
    ],
    custom: [
      { key: "邮箱密码", value: "anything" },
      { key: "期望薪资", value: "面议" },
      { key: "备注", value: "验证码：1234" }
    ]
  };
  const frozen = JSON.stringify(input);
  const { profile, removed } = profileApi.stripProfileSecrets(input);
  assert.equal(JSON.stringify(input), frozen, "the input is not modified");
  assert.equal(removed, 5);
  assert.deepEqual(profile.values, { fullName: "测试用户", phone: "13800000000" });
  assert.equal(profile.family.length, 1, "a member left with nothing is dropped");
  assert.equal(profile.family[0].name, "测试父亲");
  assert.equal(profile.family[0].phone, "");
  assert.deepEqual(profile.custom, [{ key: "期望薪资", value: "面议" }]);
});

test("stripProfileSecrets leaves an ordinary profile unchanged", () => {
  const input = { values: { fullName: "测试用户" }, family: [], custom: [{ key: "期望薪资", value: "面议" }] };
  const { profile, removed } = profileApi.stripProfileSecrets(input);
  assert.equal(removed, 0);
  assert.deepEqual(profile, profileApi.normalizeProfile(input));
});

// ---- #189：连已填项一起收的候选规划，和写入时的校验 ----

const web = (label, value, extra = {}) => ({ label, inputType: "text", matched: false, state: "ready", value, ...extra });
const planOf = (candidates, profile = {}, templateFields = [], extra = {}) =>
  profileApi.planProfileOffer({ candidates, profile, templateFields, ...extra });
const saveAll = (profile, plan, kinds = {}) => {
  const items = [
    ...plan.filled.map((item) => ({ id: item.id, key: item.key, kind: "filled" })),
    ...plan.pending.map((item) => ({ id: item.id, key: item.key, kind: "pending" })),
    ...plan.conflicts.map((item) => ({ id: item.id, key: item.key, kind: "conflict", replaceOf: kinds.replace ? item.existing : undefined }))
  ];
  return profileApi.applyProfileSelection(profile, plan, items);
};

test("plan: already-filled and empty unmatched fields are both candidates, matched ones are not", () => {
  const plan = planOf([
    web("兴趣爱好", "摄影、徒步"),
    web("期望薪资", ""),
    web("姓名", "测试用户", { matched: true }),
    web("证件照", "x", { inputType: "file" })
  ]);
  assert.deepEqual(plan.filled.map((item) => [item.key, item.value, item.defaultSelected]), [["兴趣爱好", "摄影、徒步", true]]);
  assert.deepEqual(plan.pending.map((item) => item.key), ["期望薪资"]);
  assert.equal(profileApi.profileOfferSummary(plan), "可保存到我的信息：已填 1 项，待补 1 项");
});

test("plan: same-name controls collapse to one candidate and differing values are not guessed", () => {
  const same = planOf([web("兴趣爱好", ""), web("兴趣爱好：", "摄影"), web("兴趣 爱好", "摄影")]);
  assert.deepEqual(same.filled.map((item) => [item.key, item.value]), [["兴趣爱好", "摄影"]]);
  assert.equal(same.pending.length, 0, "the empty twin does not also become a pending row");

  const clash = planOf([web("兴趣爱好", "摄影"), web("兴趣爱好", "游泳")]);
  assert.deepEqual([clash.filled.length, clash.pending.length], [0, 0]);
  assert.equal(clash.notes[0].reason, "ambiguous");
});

test("plan: sensitive labels never appear; a secret-looking value is refused without being listed", () => {
  const plan = planOf([
    web("登录密码", "hunter2"),
    web("短信验证码", "123456"),
    web("补充信息", "密码：abc123"),
    web("身份核验", "123456", { autocomplete: "one-time-code" }),
    web("兴趣爱好", "摄影")
  ]);
  assert.deepEqual(plan.filled.map((item) => item.key), ["兴趣爱好"]);
  assert.deepEqual(plan.notes.map((note) => [note.key, note.reason]), [["补充信息", "secret"]]);
  assert.ok(!JSON.stringify(plan).includes("abc123"), "the secret value is not carried in the plan");
  assert.ok(!JSON.stringify(plan).includes("hunter2"));
});

test("plan: values that cannot be read are never guessed; a moved control is reported, not listed", () => {
  const plan = planOf([web("学历层次", "", { state: "unreadable" }), web("籍贯详情", "旧值", { state: "stale" })]);
  assert.deepEqual(plan.pending.map((item) => [item.key, item.unreadable]), [["学历层次", true]]);
  assert.deepEqual(plan.notes.map((note) => note.reason), ["stale"]);
  assert.equal(plan.filled.length, 0);
});

test("plan: a job-specific answer is listed but not ticked by default", () => {
  const plan = planOf([web("你为什么想加入我们", "因为热爱"), web("请简述你的项目优势", "x"), web("兴趣爱好", "摄影"), web("其他说明", "长".repeat(301))]);
  assert.deepEqual(plan.filled.map((item) => [item.key, item.defaultSelected]),
    [["你为什么想加入我们", false], ["请简述你的项目优势", false], ["兴趣爱好", true], ["其他说明", false]]);
  assert.deepEqual(profileApi.defaultProfileSelection(plan).map((item) => item.key), ["兴趣爱好"]);
});

test("plan: an existing pending field is completed, an equal one skipped, a different one is a conflict", () => {
  const profile = { custom: [{ key: "期望薪资", value: "" }, { key: "兴趣爱好", value: "摄影" }, { key: "特长", value: "钢琴" }] };
  const plan = planOf([web("期望薪资", "2 万"), web("兴趣爱好", "摄影"), web("特长", "绘画"), web("驾照", "")], profile);
  assert.deepEqual(plan.filled.map((item) => [item.key, item.completes]), [["期望薪资", true]]);
  assert.equal(plan.same, 1);
  assert.deepEqual(plan.conflicts.map((item) => [item.key, item.value, item.existing, item.defaultSelected]), [["特长", "绘画", "钢琴", undefined]]);
  assert.deepEqual(plan.pending.map((item) => item.key), ["驾照"]);

  const blank = planOf([web("期望薪资", "")], { custom: [{ key: "期望薪资", value: "" }] });
  assert.equal(profileApi.planHasOffer(blank), false, "a name that is already waiting on the desktop is not offered again");
});

test("plan: preset and template names are never saved as a second custom row", () => {
  const profile = { values: { ethnicity: "汉族" }, custom: [] };
  const template = [{ key: "毕业院校", value: "测试大学" }];
  const plan = planOf([web("民族", "汉族"), web("民族", "汉族"), web("毕业院校", "另一所大学"), web("政治面貌", "群众"), web("毕业院校", "")], profile, template);
  assert.equal(plan.same, 1);
  assert.deepEqual(plan.notes.map((note) => [note.key, note.reason]), [["毕业院校", "fixed-conflict"], ["政治面貌", "fixed-empty"]]);
  assert.equal(profileApi.planHasOffer(plan), false);
});

test("plan: candidates over the cap are counted, not silently dropped", () => {
  const many = Array.from({ length: 45 }, (_, index) => web(`补充信息${index + 10}`, `值${index}`));
  const plan = planOf(many);
  assert.equal(plan.filled.length, 40);
  assert.equal(plan.hidden, 5);
});

test("apply: writes only what was ticked, keeps the input untouched, and a repeat save adds no duplicate", () => {
  const profile = { values: {}, family: [], custom: [{ key: "旧字段", value: "旧值" }] };
  const frozen = JSON.stringify(profile);
  const candidates = [web("兴趣爱好", "摄影"), web("特长", "钢琴"), web("驾照", "")];
  const plan = planOf(candidates, profile);

  const first = profileApi.applyProfileSelection(profile, plan, [
    { id: "兴趣爱好", key: "兴趣爱好", kind: "filled" }, { id: "驾照", key: "驾照", kind: "pending" }
  ]);
  assert.equal(JSON.stringify(profile), frozen);
  assert.deepEqual(first.profile.custom, [{ key: "旧字段", value: "旧值" }, { key: "兴趣爱好", value: "摄影" }, { key: "驾照", value: "" }]);
  assert.deepEqual(first.saved.map((item) => [item.key, item.kind]), [["兴趣爱好", "filled"], ["驾照", "pending"]]);
  assert.equal(first.skipped.length, 0);

  // 同一批再点一次：桌面里已经有了，计划里这两项不再出现，也就不会写第二行。
  const again = planOf(candidates, first.profile);
  const second = profileApi.applyProfileSelection(first.profile, again, [
    { id: "兴趣爱好", key: "兴趣爱好", kind: "filled" }, { id: "驾照", key: "驾照", kind: "pending" }
  ]);
  assert.equal(second.saved.length, 0);
  assert.deepEqual(second.skipped.map((item) => item.reason), ["same", "same"]);
  assert.equal(second.profile.custom.length, 3);
});

test("apply: completing a pending field keeps its spelling and position", () => {
  const profile = { custom: [{ key: "期望薪资（元/月）", value: "" }, { key: "其他", value: "x" }] };
  const plan = planOf([web("期望薪资（元/月）", "2 万")], profile);
  const result = saveAll(profile, plan);
  assert.deepEqual(result.profile.custom, [{ key: "期望薪资（元/月）", value: "2 万" }, { key: "其他", value: "x" }]);
  assert.equal(result.saved[0].kind, "completed");
});

test("apply: a different desktop value is replaced only with an explicit, still-current confirmation", () => {
  const profile = { custom: [{ key: "特长", value: "钢琴" }] };
  const plan = planOf([web("特长", "绘画")], profile);

  const unconfirmed = saveAll(profile, plan);
  assert.equal(unconfirmed.saved.length, 0);
  assert.equal(unconfirmed.skipped[0].reason, "conflict-unconfirmed");
  assert.deepEqual(unconfirmed.profile.custom, [{ key: "特长", value: "钢琴" }]);

  const replaced = saveAll(profile, plan, { replace: true });
  assert.deepEqual(replaced.profile.custom, [{ key: "特长", value: "绘画" }]);
  assert.equal(replaced.saved[0].kind, "replaced");

  // 用户看到的旧值是「钢琴」，点击时桌面已经被改成「小提琴」：不覆盖，如实说明。
  const moved = profileApi.applyProfileSelection({ custom: [{ key: "特长", value: "小提琴" }] },
    planOf([web("特长", "绘画")], { custom: [{ key: "特长", value: "小提琴" }] }),
    [{ id: "特长", key: "特长", kind: "conflict", replaceOf: "钢琴" }]);
  assert.equal(moved.saved.length, 0);
  assert.equal(moved.skipped[0].reason, "existing-changed");
});

test("apply: what the user saw is checked against what is there now, never silently swapped", () => {
  // 勾选时有内容，点击时网页上已经清空。
  const cleared = profileApi.applyProfileSelection({}, planOf([web("兴趣爱好", "")]), [{ id: "兴趣爱好", key: "兴趣爱好", kind: "filled" }]);
  assert.deepEqual([cleared.saved.length, cleared.skipped[0].reason], [0, "cleared"]);

  // 勾选时空着，点击时用户已经填好：按此刻的值保存。
  const filledNow = profileApi.applyProfileSelection({}, planOf([web("兴趣爱好", "摄影")]), [{ id: "兴趣爱好", key: "兴趣爱好", kind: "pending" }]);
  assert.deepEqual(filledNow.profile.custom, [{ key: "兴趣爱好", value: "摄影" }]);

  // 勾选时是新字段，点击时桌面刚有了同名的不同内容。
  const raced = profileApi.applyProfileSelection({ custom: [{ key: "特长", value: "钢琴" }] },
    planOf([web("特长", "绘画")], { custom: [{ key: "特长", value: "钢琴" }] }), [{ id: "特长", key: "特长", kind: "filled" }]);
  assert.deepEqual([raced.saved.length, raced.skipped[0].reason], [0, "existing-changed"]);

  // 勾选的项这时变成了敏感内容或已消失：各报各的原因，不影响其它安全项。
  const mixed = profileApi.applyProfileSelection({}, planOf([web("补充信息", "口令：abc"), web("兴趣爱好", "摄影")]), [
    { id: "补充信息", key: "补充信息", kind: "filled" }, { id: "兴趣爱好", key: "兴趣爱好", kind: "filled" }, { id: "不存在", key: "不存在", kind: "filled" }
  ]);
  assert.deepEqual(mixed.saved.map((item) => item.key), ["兴趣爱好"]);
  assert.deepEqual(mixed.skipped.map((item) => item.reason), ["secret", "gone"]);
});

test("apply: the custom-field count and the desktop's 24 KB profile size are respected, and the rest still save", () => {
  const nearlyFull = { custom: Array.from({ length: 199 }, (_, index) => ({ key: `字段${index + 100}`, value: "" })) };
  const plan = planOf([web("新字段甲", "a"), web("新字段乙", "b")], nearlyFull);
  const count = saveAll(nearlyFull, plan);
  assert.deepEqual([count.saved.length, count.skipped.map((item) => item.reason), count.full], [1, ["full"], true]);
  assert.equal(count.profile.custom.length, 200);

  const heavy = { custom: [{ key: "占位", value: "字".repeat(7700) }] };
  const sizePlan = planOf([web("大段内容", "字".repeat(1500)), web("小段内容", "短")], heavy);
  const size = saveAll(heavy, sizePlan);
  assert.deepEqual(size.saved.map((item) => item.key), ["小段内容"]);
  assert.deepEqual(size.skipped.map((item) => item.reason), ["full"]);
  assert.ok(Buffer.byteLength(JSON.stringify(size.profile)) <= 24 * 1024);
});

test("describeProfileSave counts filled and pending items separately and never calls a partial save a success", () => {
  const saved = (kind) => ({ id: kind, key: kind, kind });
  assert.deepEqual(profileApi.describeProfileSave({ saved: [saved("filled"), saved("filled")] }),
    { kind: "success", text: "已保存 2 项，下次填写可用。", hint: "", details: [] });
  const mixed = profileApi.describeProfileSave({ saved: [saved("filled"), saved("pending")] });
  assert.equal(mixed.text, "已保存 2 项，下次填写可用。");
  assert.match(mixed.hint, /其中 1 项只存了字段名/);
  const pendingOnly = profileApi.describeProfileSave({ saved: [saved("pending")] });
  assert.match(pendingOnly.text, /已添加 1 项待补充字段/);
  assert.doesNotMatch(pendingOnly.text, /下次填写可用/);
  const partial = profileApi.describeProfileSave({ saved: [saved("filled")], skipped: [{ text: "「补充信息」的内容像密码或验证码，不会保存。" }] });
  assert.equal(partial.kind, "partial");
  assert.match(partial.text, /另有 1 项没保存/);
  assert.deepEqual(partial.details, ["「补充信息」的内容像密码或验证码，不会保存。"]);
  assert.deepEqual([profileApi.describeProfileSave({ skipped: [{ text: "x" }] }).kind, profileApi.describeProfileSave({}).text], ["info", "没有选中要保存的内容。"]);
});
