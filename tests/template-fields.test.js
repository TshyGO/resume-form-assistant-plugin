const test = require('node:test');
const assert = require('node:assert/strict');

const fields = require('../template-fields.js');
const profileApi = require('../profile-fields.js');

const TEMPLATE = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  name: '校招简历',
  groups: [
    { name: '基本信息', fields: [{ key: '姓名', value: '张三' }, { key: '电话', value: '13800000000' }] },
    { name: '教育经历', fields: [{ key: '学校', value: '示例大学' }] }
  ]
};

test('a draft lists fields by category and starts clean', () => {
  const draft = fields.createDraft(TEMPLATE);
  assert.equal(draft.templateName, '校招简历');
  assert.deepEqual(draft.categories, ['基本信息', '教育经历']);
  assert.equal(draft.fields.length, 3);
  assert.deepEqual(fields.toGroups(draft), TEMPLATE.groups);
  assert.equal(fields.isDirty(draft), false);
  // The draft owns its copy: editing it never reaches the template it came from.
  const edited = fields.updateField(draft, draft.fields[0].id, { value: '李四' });
  assert.equal(TEMPLATE.groups[0].fields[0].value, '张三');
  assert.equal(draft.fields[0].value, '张三');
  assert.equal(edited.fields[0].value, '李四');
});

test('editing name, content and category, adding into a new category, and deleting', () => {
  let draft = fields.createDraft(TEMPLATE);
  const [name, phone, school] = draft.fields;
  draft = fields.updateField(draft, name.id, { key: ' 姓名（中文） ', value: '张三丰' });
  draft = fields.updateField(draft, school.id, { category: '求学经历' });
  const created = fields.addCategory(draft, '求职意向');
  draft = created.draft;
  const added = fields.addField(draft, { category: created.category, key: '期望城市', value: '上海' });
  draft = fields.removeField(added.draft, phone.id);
  assert.deepEqual(fields.toGroups(draft), [
    { name: '基本信息', fields: [{ key: '姓名（中文）', value: '张三丰' }] },
    { name: '求学经历', fields: [{ key: '学校', value: '示例大学' }] },
    { name: '求职意向', fields: [{ key: '期望城市', value: '上海' }] }
  ]);
  assert.equal(fields.isDirty(draft), true);
  assert.deepEqual(fields.summarizeChanges(draft), { added: 1, changed: 1, moved: 1, removed: 1 });
  assert.equal(fields.describeChanges(fields.summarizeChanges(draft)), '新增 1 个，修改 1 个，调整分类 1 个，删除 1 个');
  // 「教育经历」 lost its only field: it is not saved, and the editor says so.
  assert.deepEqual(fields.emptyCategories(draft), ['教育经历']);
  assert.ok(fields.validateDraft(draft).warnings.some(line => line.includes('「教育经历」')));
});

test('an empty category name is refused and blank categories fall back to 未分类', () => {
  const draft = fields.createDraft(TEMPLATE);
  assert.equal(fields.addCategory(draft, '   ').error, '分类名称不能为空。');
  assert.equal(fields.addCategory(draft, '基本信息').draft, draft, 'an existing category is reused, not duplicated');
  const { draft: next } = fields.addField(draft, { category: '' , key: 'k', value: 'v' });
  assert.ok(next.categories.includes('未分类'));
});

test('validation blocks empty names, secrets, an empty template and oversize content', () => {
  let draft = fields.createDraft(TEMPLATE);
  const [name, phone] = draft.fields;
  draft = fields.updateField(draft, name.id, { key: '  ' });
  draft = fields.updateField(draft, phone.id, { key: '邮箱密码' });
  let result = fields.validateDraft(draft);
  assert.equal(result.ok, false);
  assert.equal(result.fieldErrors[name.id], '字段名称不能为空。');
  assert.match(result.fieldErrors[phone.id], /密码或验证码/);
  draft = fields.updateField(fields.createDraft(TEMPLATE), phone.id, { value: '密码：abc123' });
  assert.match(fields.validateDraft(draft).fieldErrors[phone.id], /密码或验证码/);
  // Same label rule as the store: "Work Authorization" is fine.
  draft = fields.updateField(fields.createDraft(TEMPLATE), phone.id, { key: 'Work Authorization' });
  assert.equal(fields.validateDraft(draft).ok, true);

  let empty = fields.createDraft(TEMPLATE);
  for (const field of empty.fields) empty = fields.removeField(empty, field.id);
  result = fields.validateDraft(empty);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /至少要保留一个字段/);

  const big = fields.updateField(fields.createDraft(TEMPLATE), name.id, { value: '长'.repeat(fields.MAX_TEMPLATE_BYTES) });
  assert.match(fields.validateDraft(big).problems[0], /模板太大/);
});

test('duplicate names inside one category are a warning, not an error', () => {
  const { draft } = fields.addField(fields.createDraft(TEMPLATE), { category: '基本信息', key: '电话', value: '010' });
  const result = fields.validateDraft(draft);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(line => line.includes('「基本信息」里有多个「电话」')));
});

test('deleted template fields that 我的信息 still has are named, using the fill merge rules', () => {
  const profile = { values: {}, family: [], custom: [
    { key: '电话', value: '13900000000' },
    { key: '学校', value: '' },
    { key: '邮箱密码', value: 'x' }
  ] };
  const profileFields = profileApi.profileToResumeFields(profile);
  let draft = fields.createDraft(TEMPLATE);
  const [, phone, school] = draft.fields;
  draft = fields.removeField(fields.removeField(draft, phone.id), school.id);
  // 「电话」 will still be filled from 我的信息; an empty 「学校」 will not.
  assert.deepEqual(fields.profileFallbacks(draft, profileFields, profileApi.normalizeKey), ['电话']);
  // Renaming away counts too; keeping the name (even with new content) does not.
  draft = fields.updateField(fields.createDraft(TEMPLATE), phone.id, { value: '010-1234' });
  assert.deepEqual(fields.profileFallbacks(draft, profileFields, profileApi.normalizeKey), []);
  draft = fields.updateField(fields.createDraft(TEMPLATE), phone.id, { key: '手机号' });
  assert.deepEqual(fields.profileFallbacks(draft, profileFields, profileApi.normalizeKey), ['电话']);
});

test('the saved template, not 我的信息, wins for a shared name and an emptied field is not a candidate', () => {
  let draft = fields.createDraft(TEMPLATE);
  draft = fields.updateField(draft, draft.fields[1].id, { value: '010-1234' });
  const templateFields = fields.toGroups(draft).flatMap(group => group.fields);
  const profileFields = profileApi.profileToResumeFields({ values: {}, family: [], custom: [{ key: '电话', value: '139' }, { key: '微信', value: '' }] });
  const merged = profileApi.mergeResumeFields(templateFields, profileFields);
  assert.deepEqual(merged.filter(field => field.key === '电话').map(field => field.value), ['010-1234']);
  assert.ok(!merged.some(field => field.key === '微信'), 'an empty 我的信息 field never joins the candidates');
});

test('contentSha256 matches the store vector byte for byte', async () => {
  // Same input and digest as archive-store tests/resume.rs the_content_digest_matches_the_shared_vector.
  const groups = [
    { name: '基本信息', fields: [{ key: '姓名', value: '张三' }, { key: '自我评价', value: '第一行\n第二行 "引号" \\ 斜杠' }] },
    { name: '教育经历', fields: [{ key: '学校', value: '示例大学' }] }
  ];
  assert.equal(await fields.contentSha256(groups), 'd2d71fabd5d084928e23d31a3e0e429705266391b0737b35cb12cb06d5c7a34d');
  // Key order inside the input does not matter; content does.
  const reordered = groups.map(group => ({ fields: group.fields.map(f => ({ value: f.value, key: f.key })), name: group.name }));
  assert.equal(await fields.contentSha256(reordered), await fields.contentSha256(groups));
  assert.notEqual(await fields.contentSha256([{ name: '基本信息', fields: [{ key: '姓名', value: '张三 ' }] }]), await fields.contentSha256(groups));
});
