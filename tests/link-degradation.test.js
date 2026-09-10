const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../link/copy.mjs');
const ID = 'abcdefghijklmnopabcdefghijklmnop';

// The §9 degradation matrix, as a table. Each row states what the user must be told and what
// they must not be told. The rows are contractual: several of them exist because the wrong
// message sends someone off to reinstall software they already have, or leaves them
// believing a job was filed when it is sitting in a queue.
const MATRIX = [
  {
    row: '未安装 / 从未配对',
    result: { status: 'not_queued', mode: 'not_installed', extensionId: ID },
    mustSay: [/桌面程序/, /填表/],
    mustNotSay: [/配对/, /已保存/]
  },
  {
    row: '从未配对（装了但没配过）',
    result: { status: 'not_queued', mode: 'never_paired', extensionId: ID },
    mustSay: [/扩展 ID/, /没有保存/],
    mustNotSay: [/未安装/, /已保存到桌面/]
  },
  {
    row: '已安装但未配对',
    result: { status: 'not_queued', mode: 'not_paired', extensionId: ID },
    mustSay: [/配对/, /扩展 ID/],
    mustNotSay: [/未安装/, /没有找到桌面程序/]
  },
  {
    row: '曾经配对，桌面暂不可用',
    result: { status: 'queued', mode: 'unavailable', intent: { status: 'pending_desktop' } },
    mustSay: [/待同步/, /尚未绑定申请/],
    mustNotSay: [/已保存/, /未安装/]
  },
  {
    row: '离线（无互联网）：与桌面不可用同路',
    result: { status: 'queued', mode: 'unavailable', intent: { status: 'pending_desktop' } },
    mustSay: [/待同步/],
    mustNotSay: [/已保存/]
  },
  {
    row: '协议不兼容',
    result: { status: 'queued', mode: 'incompatible', intent: { status: 'pending_desktop' } },
    mustSay: [/升级/, /待同步/],
    mustNotSay: [/已保存/, /未安装/]
  },
  {
    row: '队列已满',
    result: { status: 'rejected', reason: 'queue_full', mode: 'unavailable' },
    mustSay: [/已满/, /填表/],
    mustNotSay: [/已保存/]
  }
];

for (const entry of MATRIX) {
  test(`§9 ${entry.row}`, async () => {
    const { describeSaveResult } = await load();

    const copy = describeSaveResult(entry.result);
    const text = `${copy.text} ${copy.hint ?? ''}`;

    for (const pattern of entry.mustSay) assert.match(text, pattern, entry.row);
    for (const pattern of entry.mustNotSay) assert.doesNotMatch(text, pattern, entry.row);
  });
}

test('every mode has copy, including one nobody thought of', async () => {
  const { describeSaveResult } = await load();

  for (const mode of ['ready', 'unavailable', 'incompatible', 'not_installed', 'not_paired', 'never_paired', 'something_new']) {
    const copy = describeSaveResult({ status: 'not_queued', mode, extensionId: ID });
    assert.equal(typeof copy.text, 'string');
    assert.notEqual(copy.text.trim(), '');
  }
});

test('only a persisted write is ever described as saved on the desktop', async () => {
  const { describeSaveResult, describeBindResult, describeReconcileStatus } = await load();
  const claims = [];

  for (const entry of MATRIX) claims.push(describeSaveResult(entry.result).text);
  for (const status of ['pending', 'failed', 'rejected']) claims.push(describeBindResult({ status }).text);
  for (const status of ['purged', 'not_found', 'conflict', 'unverifiable']) {
    claims.push(describeReconcileStatus(status).text);
  }

  for (const claim of claims) assert.equal(claim.includes('桌面已保存'), false, claim);
  assert.match(describeBindResult({ status: 'saved' }).text, /桌面已保存/);
});

test('a desktop save is never described as a submission', async () => {
  const { describeBindResult } = await load();
  // Walkthrough rule 5: saving a posting leaves the stage at `saved`. Only the user pressing
  // "confirm submitted" moves it on.
  const copy = describeBindResult({ status: 'saved' });

  assert.equal(copy.text.includes('已投递（'), false);
  assert.match(copy.text, /不是已投递/);
});

test('a confirmed submission says so and nothing more', async () => {
  const { describeConfirmResult } = await load();

  const saved = describeConfirmResult({ status: 'saved' });
  const pending = describeConfirmResult({ status: 'pending' });

  assert.match(saved.text, /已投递/);
  assert.match(pending.text, /待同步/);
  assert.equal(pending.text.includes('已投递'), false);
});
