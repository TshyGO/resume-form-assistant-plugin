const test = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("../ai-helpers.js");

const resumeFields = [
  { group: "基本信息", key: "姓名", value: "测试用户" },
  { group: "教育背景", key: "学校1", value: "大学甲" },
  { group: "教育背景", key: "毕业时间1", value: "2020" },
  { group: "教育背景", key: "学校2", value: "大学乙" },
  { group: "教育背景", key: "毕业时间2", value: "2024" },
  ...Array.from({ length: 60 }, (_, i) => ({ group: "工作经历", key: `工作${i}`, value: "完整工作描述".repeat(80) }))
];
const formFields = [{ fieldId: "name", label: "姓名" }, { fieldId: "school", label: "学校" }];

test("candidate pruning retains complete repeated education records and reduces long-resume bytes", () => {
  const selected = helpers.selectResumeCandidates([formFields[1]], resumeFields);
  assert.deepEqual(selected, resumeFields.slice(0, 5));
  assert.ok(Buffer.byteLength(JSON.stringify(selected)) < Buffer.byteLength(JSON.stringify(resumeFields)) * 0.1);
});

test("ambiguous, unknown and empty-candidate fields fall back; custom groups are retained", () => {
  for (const label of ["自我评价", "毕业后工作计划", "技能"]) {
    assert.equal(helpers.selectResumeCandidates([{ label }], resumeFields), resumeFields);
  }
  const custom = { group: "自定义", key: "说明", value: "不能排除" };
  assert.ok(helpers.selectResumeCandidates([{ label: "学校" }], [...resumeFields, custom]).includes(custom));
  assert.deepEqual(helpers.selectResumeCandidates([{ label: "学校" }], []), []);
  assert.deepEqual(helpers.selectResumeCandidates([], resumeFields), []);
});

test('work authorization and location do not discard basic-information candidates', () => {
  const data = [
    { group: '基本信息', key: '工作授权', value: 'Yes' },
    { group: '工作经历', key: '公司', value: 'Synthetic employer' }
  ];
  for (const label of ['Are you legally authorized to work?', 'Employment eligibility', '工作地点', 'Work location']) {
    assert.equal(helpers.selectResumeCandidates([{ label }], data), data);
  }
});

test('graduate school retains education rather than selecting research only', () => {
  const data = [
    { group: '教育背景', key: '研究生院', value: 'Synthetic university' },
    { group: '科研经历', key: '课题', value: 'Synthetic research' }
  ];
  assert.deepEqual(helpers.selectResumeCandidates([{ label: '研究生院' }], data), [data[0]]);
  assert.deepEqual(helpers.selectResumeCandidates([{ label: '研究生院', group: '科研经历' }], data), data);
});

test('current employer facts in basic information survive history candidate pruning', () => {
  const data = [
    { group: '基本信息', key: '当前工作单位', value: 'Current employer' },
    { group: '工作经历', key: '公司', value: 'Past employer' },
    { group: '教育背景', key: '学校', value: 'Synthetic university' }
  ];
  for (const label of ['当前工作单位', '现工作单位', 'Current company']) {
    assert.deepEqual(helpers.selectResumeCandidates([{ label }], data), data.slice(0, 2));
  }
});
