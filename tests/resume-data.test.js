const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, modeCopy } = require('../resume-data.js');

test('desktop read becomes the same view model in both sidebars', () => {
  const template = { id: 'template-id', name: '简历', groups: [{ name: '基本信息', fields: [{ key: '姓名', value: '测试' }] }] };
  const payload = {
    templates: [{ id: 'template-id', name: '简历', fieldCount: 1 }],
    activeTemplate: template,
    profile: { values: { email: 'synthetic@example.com' }, family: [], custom: [] },
    profileRevision: 3
  };
  assert.deepEqual(normalize(payload), {
    templates: payload.templates, activeTemplateId: 'template-id', activeTemplate: template,
    profile: payload.profile, profileRevision: 3
  });
});

test('each desktop downgrade has an action and keeps data unavailable', () => {
  for (const mode of ['not_installed', 'not_paired', 'never_paired', 'incompatible', 'unavailable', 'empty']) {
    assert.ok(modeCopy(mode).message);
    assert.ok(modeCopy(mode).action);
  }
  assert.equal(modeCopy('not_installed').kind, 'download');
  assert.equal(modeCopy('empty').kind, 'resume');
});
