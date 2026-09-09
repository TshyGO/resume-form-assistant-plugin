const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../link/copy.mjs');
const ID = 'abcdefghijklmnopabcdefghijklmnop';

test('a queued intent is described as pending, never as saved', async () => {
  const { describeSaveResult } = await load();

  const copy = describeSaveResult({ status: 'queued', mode: 'unavailable', intent: { status: 'pending_desktop' } });

  assert.match(copy.text, /待同步/);
  assert.equal(copy.text.includes('已保存'), false);
  assert.equal(copy.tone, 'pending');
});

test('an uninstalled desktop is not described as unpaired', async () => {
  const { describeSaveResult } = await load();

  const copy = describeSaveResult({ status: 'not_queued', mode: 'not_installed', extensionId: ID });

  assert.match(copy.text, /桌面程序/);
  assert.equal(copy.text.includes('配对'), false);
  assert.equal(copy.text.includes(ID), false, 'there is nowhere to paste an id yet');
});

test('an unpaired desktop is not described as missing, and shows the id to paste', async () => {
  const { describeSaveResult } = await load();

  const copy = describeSaveResult({ status: 'not_queued', mode: 'not_paired', extensionId: ID });

  assert.match(copy.text, /配对/);
  assert.equal(copy.text.includes('未安装'), false);
  assert.equal(copy.extensionId, ID);
});

test('a profile that never paired is told where to paste the id', async () => {
  const { describeSaveResult } = await load();

  const copy = describeSaveResult({ status: 'not_queued', mode: 'never_paired', extensionId: ID });

  assert.equal(copy.extensionId, ID);
  assert.match(copy.text, /扩展 ID/);
});

test('pairing instructions say the extension has to be reloaded afterwards', async () => {
  const { describeSaveResult } = await load();
  // Risk V3: a manifest written after the browser started is not picked up until the
  // extension is reloaded, and the user is otherwise left pairing over and over.
  const copy = describeSaveResult({ status: 'not_queued', mode: 'never_paired', extensionId: ID });

  assert.match(copy.hint, /重新加载|重启/);
});

test('an incompatible desktop keeps the intent and asks for an upgrade', async () => {
  const { describeSaveResult } = await load();

  const copy = describeSaveResult({ status: 'queued', mode: 'incompatible', intent: { status: 'pending_desktop' } });

  assert.match(copy.text, /升级/);
  assert.match(copy.text, /待同步/);
});

test('a duplicate offers saving again rather than silently doing nothing', async () => {
  const { describeSaveResult } = await load();

  const copy = describeSaveResult({ status: 'duplicate', recent: true, mode: 'unavailable' });

  assert.equal(copy.offerForce, true);
  assert.match(copy.text, /已经/);
});

test('a full queue says how full and promises filling still works', async () => {
  const { describeSaveResult } = await load();
  const { MAX_INTENTS } = await import('../link/limits.mjs');

  const copy = describeSaveResult({ status: 'rejected', reason: 'queue_full', mode: 'unavailable' });

  assert.match(copy.text, new RegExp(String(MAX_INTENTS)));
  assert.match(copy.text, /填表/);
});

test('missing fields are named rather than blamed on the desktop', async () => {
  const { describeSaveResult } = await load();

  const copy = describeSaveResult({ status: 'rejected', reason: 'missing_fields', mode: 'ready' });

  assert.match(copy.text, /公司/);
  assert.match(copy.text, /岗位/);
});

test('no copy in the whole table claims a desktop save', async () => {
  const { describeSaveResult } = await load();
  const cases = [
    { status: 'queued', mode: 'unavailable', intent: { status: 'pending_desktop' } },
    { status: 'queued', mode: 'incompatible', intent: { status: 'pending_desktop' } },
    { status: 'queued', mode: 'ready', intent: { status: 'pending_bind' } },
    { status: 'not_queued', mode: 'not_installed' },
    { status: 'not_queued', mode: 'not_paired' },
    { status: 'not_queued', mode: 'never_paired' },
    { status: 'duplicate', mode: 'unavailable' },
    { status: 'rejected', reason: 'queue_full', mode: 'unavailable' },
    { status: 'rejected', reason: 'missing_fields', mode: 'ready' },
    { status: 'error', mode: 'unavailable' }
  ];

  for (const input of cases) {
    const copy = describeSaveResult({ ...input, extensionId: ID });
    assert.equal(typeof copy.text, 'string');
    assert.notEqual(copy.text, '');
    assert.equal(copy.text.includes('桌面已保存'), false, JSON.stringify(input));
  }
});
