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

// --- binding ---------------------------------------------------------------

test('a persisted write is the only thing allowed to say the desktop has it', async () => {
  const { describeBindResult } = await load();

  const copy = describeBindResult({ status: 'saved', applicationId: '77777777-7777-4777-8777-777777777777' });

  assert.match(copy.text, /桌面已保存/);
  assert.equal(copy.tone, 'success');
});

test('a desktop save says it is saved, not submitted', async () => {
  const { describeBindResult } = await load();
  // §5.2 rule 5 and walkthrough note: saving a posting is not applying to it. The stage is
  // `saved` until the user says otherwise.
  const copy = describeBindResult({ status: 'saved', applicationId: '77777777-7777-4777-8777-777777777777' });

  assert.match(copy.text, /已收藏|不是已投递/);
});

test('a bind that could not reach the desktop is pending, not saved', async () => {
  const { describeBindResult } = await load();

  const copy = describeBindResult({ status: 'pending', mode: 'unavailable' });

  assert.match(copy.text, /待同步/);
  assert.equal(copy.text.includes('桌面已保存'), false);
});

test('a refused write names the reason without echoing the protocol', async () => {
  const { describeBindResult } = await load();

  const purged = describeBindResult({ status: 'failed', code: 'previously_purged' });
  const conflict = describeBindResult({ status: 'failed', code: 'conflict' });

  assert.equal(purged.tone, 'warn');
  assert.notEqual(purged.text, conflict.text, 'different refusals need different explanations');
  assert.equal(purged.text.includes('previously_purged'), false);
});

test('a full bound queue explains itself and promises filling still works', async () => {
  const { describeBindResult } = await load();
  const { MAX_OUTBOX } = await import('../link/limits.mjs');

  const copy = describeBindResult({ status: 'rejected', reason: 'queue_full' });

  assert.match(copy.text, new RegExp(String(MAX_OUTBOX)));
  assert.match(copy.text, /填表/);
});

test('a second bind for the same posting says it is already queued', async () => {
  const { describeBindResult } = await load();

  const copy = describeBindResult({ status: 'duplicate', reason: 'already_queued' });

  assert.match(copy.text, /已经|队列/);
  assert.equal(copy.text.includes('没能'), false, 'the first click did work');
});

// --- reconciliation --------------------------------------------------------

test('every reconcile verdict has its own explanation and none offers a plain retry', async () => {
  const { describeReconcileStatus } = await load();

  for (const status of ['purged', 'not_found', 'conflict', 'unverifiable']) {
    const copy = describeReconcileStatus(status);
    assert.equal(typeof copy.text, 'string');
    assert.notEqual(copy.text, '');
    // The only ways out are associate, discard and save-again. A plain "retry" would send an
    // envelope stamped with an epoch the desktop has already replaced.
    assert.deepEqual(copy.choices.sort(), ['associate', 'discard', 'resave']);
  }
});

test('not_found says a receipt is missing and says that is not proof', async () => {
  const { describeReconcileStatus } = await load();

  const copy = describeReconcileStatus('not_found');

  // §8.11: "not_found" means this archive holds no receipt, never "this never happened".
  // The disclaimer has to be in the sentence the user reads, not only in the spec.
  assert.match(copy.text, /没有找到|无法证明|凭据/);
  assert.match(copy.text, /不等于|不代表|不能据此/);
});

test('a retry refused because the archive changed says so', async () => {
  const { describeBindResult } = await load();
  // Not "try later": this entry is waiting on a decision the user has to make, and telling
  // them to retry sends them round a loop that cannot succeed.
  const copy = describeBindResult({ status: 'rejected', reason: 'awaiting_reconcile' });

  assert.match(copy.text, /档案库|对账/);
  assert.equal(copy.text.includes('稍后再试'), false);
});
