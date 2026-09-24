const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
function page() {
  const context = vm.createContext({ self: { __RESUME_PRO_TEST__: true } });
  vm.runInContext(source, context);
  return context.self.ResumeProStatusPage;
}
const { modeCopy } = require('../resume-data.js');

test('the desktop card mirrors the side panel downgrade states', () => {
  const { describeDesktop } = page();
  assert.deepEqual(JSON.parse(JSON.stringify(describeDesktop('ready', modeCopy))), { text: '已连接桌面程序。', action: null, canOpen: true });
  for (const [mode, kind] of [['not_installed', 'download'], ['not_paired', 'pair'], ['incompatible', 'download'], ['unavailable', 'retry']]) {
    const view = describeDesktop(mode, modeCopy);
    assert.equal(view.action.kind, kind, mode);
    assert.equal(view.canOpen, false);
    assert.equal(view.text, modeCopy(mode).message);
  }
});

test('each migration phase explains itself and offers only its own actions', () => {
  const { describeMigration } = page();
  const ids = status => JSON.parse(JSON.stringify(describeMigration(status).actions.map(action => action.id)));
  assert.equal(describeMigration({ phase: 'none' }).show, false);
  assert.deepEqual(ids({ phase: 'waiting' }), ['open-resume']);
  assert.match(describeMigration({ phase: 'waiting' }).text, /确认之前，插件里的数据不会删除/);
  assert.deepEqual(ids({ phase: 'imported' }), []);
  assert.deepEqual(ids({ phase: 'imported_ai_dropped', hasOldKey: true }), ['copy-key', 'drop-key']);
  assert.deepEqual(ids({ phase: 'imported_ai_dropped', hasOldKey: false }), []);
  assert.deepEqual(ids({ phase: 'rejected' }), ['resend', 'discard']);
  assert.match(describeMigration({ phase: 'failed', error: '模板太大' }).text, /模板太大/);
  assert.deepEqual(ids({ phase: 'expired' }), ['resend', 'discard']);
  assert.deepEqual(ids({ phase: 'discarded' }), []);
});

test('what did not migrate is named and can be downloaded', () => {
  const { describeMigration } = page();
  const view = describeMigration({
    phase: 'imported', unmigratedTemplates: 2,
    skipped: { profileSecrets: 3, profileTooLarge: false, templates: [{ name: 'a', reason: 'too_large' }, { name: 'b', reason: 'over_limit' }] }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(view.actions.map(action => action.id))), ['csv']);
  assert.ok(view.notes.some(note => note.includes('3 项像密码或验证码')));
  assert.ok(view.notes.some(note => note.includes('2 个模板没能迁移（超过 24 KB、超过 25 个）')));
  // Oversized templates with nothing else to send still get a way out.
  assert.deepEqual(JSON.parse(JSON.stringify(describeMigration({ phase: 'none', unmigratedTemplates: 1 }).actions.map(action => action.id))), ['csv']);
});

test('the status page manages nothing locally and loads no parsing or spreadsheet code', () => {
  for (const pattern of [/xlsx/i, /mammoth/i, /pdfjs/i, /\bfetch\s*\(/, /storage\.local\.set/, /storage\.local\.remove/, /ai-models/]) {
    assert.doesNotMatch(source, pattern);
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]), ['resume-data.js', 'popup.js']);
  // Deleting data and copying the old key are behind an explicit confirm.
  assert.match(source, /"drop-key": async \(\) => \{\s*if \(!confirm\(/);
  assert.match(source, /discard: async \(\) => \{\s*if \(!confirm\(/);
});

test('removed manager files are gone from the package', () => {
  for (const file of ['xlsx.full.min.js', 'mammoth.browser.min.js', 'ai-models.js', 'vendor/pdfjs']) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', file)), false, file);
  }
});
