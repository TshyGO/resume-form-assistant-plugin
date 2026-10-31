const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
async function panel(capture = { status: 'original', bytesBase64: 'eA==', target: 'opaque-target' }, download = async () => ({ status: 'original', kind: 'eml', bytesBase64: 'eA==' })) {
  const dom = new JSDOM(fs.readFileSync('sidepanel.html', 'utf8'), { url: 'chrome-extension://own/sidepanel.html', runScripts: 'outside-only' });
  let tab = { id: 1, url: 'https://mail.google.com/mail/u/0/#inbox/thread' };
  let validation = { status: 'current' }, result = { status: 'saved' };
  const calls = [], handlers = {};
  dom.window.chrome = {
    tabs: { query: async () => [tab], sendMessage: async (id, msg) => {
      calls.push({ destination: 'page', id, msg });
      if (msg.type === 'WEBMAIL_DISCARD') return { status: 'discarded' };
      return ['WEBMAIL_VALIDATE', 'WEBMAIL_CHECK'].includes(msg.type) ? typeof validation === 'function' ? validation(msg) : validation : typeof capture === 'function' ? capture() : capture;
    }, onActivated: { addListener: fn => { handlers.activate = fn; } }, onUpdated: { addListener: fn => { handlers.update = fn; } } },
    runtime: { sendMessage: async msg => { calls.push({ destination: 'desktop', msg }); return typeof result === 'function' ? result(msg) : result; } }
  };
  vm.runInContext(fs.readFileSync('webmail.js', 'utf8'), dom.getInternalVMContext());
  const transport = require('../gmail-download.js');
  dom.window.ResumeProGmailDownload = { resolveSource: (source, validate) => transport.resolveSource(source, async url => {
    calls.push({ destination: 'download', url }); return download(url);
  }, validate) };
  vm.runInContext(fs.readFileSync('sidepanel-mail.js', 'utf8'), dom.getInternalVMContext());
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
  await flush();
  return { get: id => dom.window.document.getElementById(id), calls, flush,
    validation: next => { validation = next; }, result: next => { result = next; },
    change: async next => { tab = next; handlers.activate(); await flush(); },
    close: () => dom.window.close() };
}
const excerpt = { status: 'excerpt_offer', target: 'opaque-target', excerpt: { subject: '星河面试', from: 'hr@example.test', sentTime: '周五', body: '周四面试' } };
const source = { status: 'gmail_source', target: 'opaque-target', originals: ['https://mail.google.com/mail/u/0/?view=att&th=18abcdef12345678&attid=0&disp=comp'], fallback: 'excerpt_offer', excerpt: excerpt.excerpt };

test('Gmail source downloads between target checks, consumes only before archive transfer, and sends no private URL', async t => {
  const p = await panel(source); t.after(p.close);
  assert.equal(p.calls.length, 0);
  p.get('mail-save-button').click(); await p.flush();
  assert.deepEqual(p.calls.map(call => call.msg?.type || call.destination), ['WEBMAIL_CAPTURE', 'WEBMAIL_CHECK', 'download', 'WEBMAIL_CHECK', 'WEBMAIL_VALIDATE', 'DESKTOP_SAVE_MAIL']);
  const save = p.calls.at(-1).msg;
  assert.equal(save.bytesBase64, 'eA=='); assert.equal(save.originals, undefined); assert.equal(save.target, undefined);
  assert.match(p.get('mail-save-status').textContent, /已保存完整邮件/);
});
test('switching accounts during the Gmail download prevents archive writes', async t => {
  let finish;
  const p = await panel(source, () => new Promise(resolve => { finish = resolve; })); t.after(p.close);
  p.get('mail-save-button').click(); await p.flush();
  await p.change({ id: 1, url: 'https://mail.google.com/mail/u/1/#inbox/other' });
  finish({ status: 'original', bytesBase64: 'eA==' }); await p.flush();
  assert.equal(p.calls.filter(call => call.destination === 'desktop').length, 0);
  assert.match(p.get('mail-save-status').textContent, /邮件已切换/);
});
test('failed Gmail source offers an excerpt without consuming its target until explicit acceptance', async t => {
  const p = await panel(source, async () => ({ status: 'unavailable' })); t.after(p.close);
  p.get('mail-save-button').click(); await p.flush();
  assert.equal(p.get('mail-excerpt-offer').hidden, false);
  assert.equal(p.calls.some(call => call.msg?.type === 'WEBMAIL_VALIDATE'), false);
  p.get('mail-excerpt-accept').click(); await p.flush();
  assert.equal(p.calls.filter(call => call.destination === 'desktop').length, 1);
  assert.equal(p.calls.at(-2).msg.kind, 'excerpt');
});

test('Gmail URL enables saving without reading mail; explicit save validates the target before desktop transfer', async t => {
  const p = await panel(); t.after(p.close);
  assert.equal(p.calls.length, 0);
  assert.equal(p.get('mail-save-button').disabled, false);
  assert.equal(p.get('mail-context-title').textContent, 'Gmail');
  assert.match(p.get('mail-context-hint').textContent, /只展开/);
  p.get('mail-save-button').click(); await p.flush();
  assert.deepEqual(p.calls.map(call => call.msg.type), ['WEBMAIL_CAPTURE', 'WEBMAIL_VALIDATE', 'DESKTOP_SAVE_MAIL']);
  assert.equal(p.calls[2].msg.target, undefined, 'temporary binding is never transmitted to the archive');
  assert.match(p.get('mail-save-status').textContent, /已保存完整邮件/);
});
test('ambiguous Gmail conversations stop with an instruction to expand just one mail', async t => {
  const p = await panel({ status: 'multiple_messages' }); t.after(p.close);
  p.get('mail-save-button').click(); await p.flush();
  assert.match(p.get('mail-save-status').textContent, /只展开要保存的一封/);
  assert.equal(p.calls.filter(call => call.destination === 'desktop').length, 0);
});
test('Gmail excerpt acceptance revalidates same-URL message/account changes and clears stale content', async t => {
  const p = await panel(excerpt); t.after(p.close);
  p.get('mail-save-button').click(); await p.flush();
  assert.equal(p.get('mail-excerpt-offer').hidden, false);
  assert.equal(p.calls.filter(call => call.destination === 'desktop').length, 0);
  p.validation({ status: 'changed' });
  p.get('mail-excerpt-accept').click(); await p.flush();
  assert.equal(p.calls.filter(call => call.destination === 'desktop').length, 0);
  assert.equal(p.get('mail-excerpt-offer').hidden, true);
  assert.match(p.get('mail-save-status').textContent, /邮件已切换/);
});
test('valid Gmail excerpts require a second explicit click and report missing originals and attachments', async t => {
  const p = await panel(excerpt); t.after(p.close);
  p.get('mail-save-button').click(); await p.flush();
  assert.match(p.get('mail-save-status').textContent, /显示原始邮件/);
  p.get('mail-excerpt-accept').click(); await p.flush();
  const saves = p.calls.filter(call => call.destination === 'desktop');
  assert.equal(saves.length, 1); assert.equal(saves[0].msg.kind, 'excerpt');
  assert.match(p.get('mail-save-status').textContent, /未保存邮件原件及附件/);
  assert.equal(p.get('mail-excerpt-offer').hidden, true);
  p.get('mail-excerpt-accept').click(); await p.flush();
  assert.equal(p.calls.filter(call => call.destination === 'desktop').length, 1);
});
test('desktop rejection and transport exceptions clear spent excerpt targets and allow a fresh confirmed retry', async t => {
  for (const failure of [{ status: 'unavailable' }, () => { throw new Error('desktop disconnected'); }]) {
    let generation = 0;
    const consumed = new Set();
    const p = await panel(() => ({ ...excerpt, target: `target-${++generation}` })); t.after(p.close);
    p.validation(msg => {
      if (consumed.has(msg.target)) return { status: 'changed' };
      if (msg.type === 'WEBMAIL_VALIDATE') consumed.add(msg.target);
      return { status: 'current' };
    });
    p.result(failure);
    p.get('mail-save-button').click(); await p.flush();
    p.get('mail-excerpt-accept').click(); await p.flush();
    assert.equal(p.get('mail-excerpt-offer').hidden, true);
    assert.match(p.get('mail-save-status').textContent, /检查桌面连接.*重新读取邮件后重试/);
    assert.doesNotMatch(p.get('mail-save-status').textContent, /邮件已切换/);
    p.get('mail-excerpt-accept').click(); await p.flush();
    assert.equal(p.calls.filter(call => call.destination === 'desktop').length, 1);
    p.result({ status: 'saved' });
    p.get('mail-save-button').click(); await p.flush();
    assert.equal(p.calls.filter(call => call.destination === 'desktop').length, 1, 'fresh proposal still requires explicit acceptance');
    p.get('mail-excerpt-accept').click(); await p.flush();
    assert.equal(generation, 2); assert.equal(consumed.size, 2);
    assert.equal(p.calls.filter(call => call.destination === 'desktop').length, 2);
    assert.match(p.get('mail-save-status').textContent, /已保存网页摘录/);
  }
});
test('switching tabs during Gmail target validation prevents either kind of archive write', async t => {
  const p = await panel(); t.after(p.close);
  let finish;
  p.validation(() => new Promise(resolve => { finish = resolve; }));
  p.get('mail-save-button').click(); await p.flush();
  await p.change({ id: 2, url: 'https://mail.google.com/mail/u/1/#inbox/other' });
  finish({ status: 'current' }); await p.flush();
  assert.equal(p.calls.filter(call => call.destination === 'desktop').length, 0);
  assert.match(p.get('mail-save-status').textContent, /邮件已切换/);
});
test('missing Gmail binding and desktop failures are not presented as saved', async t => {
  const p = await panel({ status: 'original', bytesBase64: 'eA==' }); t.after(p.close);
  p.get('mail-save-button').click(); await p.flush();
  assert.equal(p.calls.filter(call => call.destination === 'desktop').length, 0);
  const q = await panel(); t.after(q.close); q.result({ status: 'unavailable' });
  q.get('mail-save-button').click(); await q.flush();
  assert.doesNotMatch(q.get('mail-save-status').textContent, /已保存完整邮件/);
  assert.match(q.get('mail-save-status').textContent, /尚未确认保存成功/);
});
test('cancelling Gmail excerpts discards the proposal without validating or archiving mail', async t => {
  const p = await panel(excerpt); t.after(p.close);
  p.get('mail-save-button').click(); await p.flush();
  p.get('mail-excerpt-cancel').click(); await p.flush();
  assert.deepEqual(p.calls.map(call => call.msg.type), ['WEBMAIL_CAPTURE', 'WEBMAIL_DISCARD']);
  assert.equal(p.get('mail-excerpt-offer').hidden, true);
});
