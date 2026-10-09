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
  for (const [mode, kind] of [['not_installed', 'download'], ['not_paired', 'pair'], ['incompatible', 'download'], ['unavailable', 'home']]) {
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
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]), ['feedback-core.js', 'feedback-ui.js', 'resume-data.js', 'popup.js']);
  // Deleting data and the old key are behind the page's own confirmation box (#261).
  assert.match(source, /"drop-key": async \(\) => \{\s*if \(!await confirmDanger\(/);
  assert.match(source, /discard: async \(\) => \{\s*if \(!await confirmDanger\(/);
  assert.doesNotMatch(source, /\bconfirm\(/, 'no browser confirm() popup');
});

test('the confirmation box focuses 取消, never the dangerous button, and only 主动作 confirms', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  const dialog = html.slice(html.indexOf('<dialog id="confirm-dialog"'), html.indexOf('</dialog>'));
  assert.match(dialog, /<form method="dialog"/, 'Escape and 取消 close it without submitting anything');
  assert.match(dialog, /<button type="submit" value="cancel" id="confirm-cancel" autofocus>取消<\/button>/);
  assert.match(dialog, /<button type="submit" value="confirm" id="confirm-ok" class="danger-solid"><\/button>/);
  assert.doesNotMatch(dialog.slice(dialog.indexOf('id="confirm-ok"')), /autofocus/);
  // The decision is read from the button that closed it; anything else is a cancel.
  assert.match(source, /settle\(event\.submitter\?\.value === "confirm"\)/);
  assert.match(source, /settle\(dialog\.returnValue === "confirm"\)/);
  assert.match(source, /dialog\.returnValue = "";/);
  for (const text of ['删除插件中的旧 API Key？', '删除旧 Key', '删除插件里的旧数据？', '删除旧数据', '桌面里已有的数据不受影响']) {
    assert.ok(source.includes(text), text);
  }
});

test('removed manager files are gone from the package', () => {
  for (const file of ['xlsx.full.min.js', 'mammoth.browser.min.js', 'ai-models.js', 'vendor/pdfjs']) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', file)), false, file);
  }
});

test('a migration action is reported from the status it returns, never from the mere answer', () => {
  const { describeLegacyResult } = page();
  const view = (action, result) => JSON.parse(JSON.stringify(describeLegacyResult(action, result)));
  // 删除旧 Key: done only when the key is really gone.
  assert.equal(view('drop-key', { phase: 'imported_ai_dropped', hasOldKey: false }).tone, 'ok');
  assert.equal(view('drop-key', { phase: 'imported_ai_dropped', hasOldKey: true }).tone, 'warn');
  // A refusal from the worker, or no answer, is never "done".
  assert.equal(view('drop-key', { error: true, code: 'forbidden' }).tone, 'warn');
  assert.equal(view('drop-key', null).tone, 'warn');
  // 删除插件里的旧数据: done only when the phase says so.
  assert.equal(view('discard', { phase: 'discarded' }).tone, 'ok');
  assert.equal(view('discard', { phase: 'rejected' }).tone, 'warn');
  assert.equal(view('discard', { error: true, code: 'forbidden' }).tone, 'warn');
  // 重新发送: sent, still sending, refused by the desktop, or nothing was sent.
  assert.deepEqual(view('resend', { phase: 'waiting' }), { tone: 'ok', text: '已重新发送到桌面，请到桌面「简历」页确认导入。' });
  assert.equal(view('resend', { phase: 'sending' }).tone, 'info');
  assert.doesNotMatch(view('resend', { phase: 'sending' }).text, /已重新发送/);
  assert.deepEqual(view('resend', { phase: 'failed', error: '模板太大' }), { tone: 'warn', text: '桌面没有接受这批数据：模板太大' });
  assert.match(view('resend', { phase: 'rejected' }).text, /^没有重新发送/);
  assert.match(view('resend', null).text, /^没有重新发送/);
});
