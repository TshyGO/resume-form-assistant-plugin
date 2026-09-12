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

// --- D08: archiving a fill -----------------------------------------------------------

test('only a persisted fill.submit is described as archived on the desktop', async () => {
  const { describeFillRecordResult } = await load();
  const saved = describeFillRecordResult({ status: 'saved' });
  assert.match(saved.text, /已留档到桌面/);

  for (const result of [
    { status: 'recorded', mode: 'unavailable' },
    { status: 'recorded', mode: 'incompatible' },
    { status: 'pending' },
    { status: 'duplicate' },
    { status: 'rejected', reason: 'queue_full' },
    { status: 'rejected', reason: 'unknown_record' },
    { status: 'not_recorded', reason: 'never_paired' },
    { status: 'failed', code: 'invalid_payload' },
    { status: 'something_new' }
  ]) {
    const copy = describeFillRecordResult(result);
    assert.equal(typeof copy.text, 'string');
    assert.equal(copy.text.includes('已留档到桌面'), false, JSON.stringify(result));
  }
});

test('no fill wording ever says the application was submitted', async () => {
  // Rule 1: a completed fill is not a submission. Not even "not yet submitted" is said here,
  // so the word cannot drift into a claim.
  const { describeFillRecordResult, describeFillSummary, describeFillOffer } = await load();
  const texts = [
    describeFillOffer({ outcome: 'completed', fieldCount: 3, filledCount: 3, unconfirmedCount: 0 }),
    describeFillRecordResult({ status: 'saved' }).text,
    describeFillRecordResult({ status: 'recorded', mode: 'unavailable' }).text,
    describeFillRecordResult({ status: 'pending' }).text
  ];
  for (const outcome of ['completed', 'partial', 'failed', 'cancelled']) {
    texts.push(describeFillSummary({ outcome, fieldCount: 12, filledCount: 9, unconfirmedCount: 3 }));
  }
  for (const text of texts) {
    assert.equal(/投递|提交/.test(text), false, text);
  }
});

test('the fill summary counts what was written into the page, not what the site accepted', async () => {
  const { describeFillSummary } = await load();
  const text = describeFillSummary({ outcome: 'partial', fieldCount: 12, filledCount: 9, unconfirmedCount: 3 });
  assert.match(text, /部分完成/);
  assert.match(text, /已写入网页 9\/12 项/);
  assert.match(text, /3 项未确认/);
  assert.equal(/已保存|已接受/.test(text), false);
  assert.doesNotMatch(describeFillSummary({ outcome: 'completed', fieldCount: 5, filledCount: 5, unconfirmedCount: 0 }), /未确认/);
});

test('a full fill-record queue is refused in words, with filling unaffected', async () => {
  const { describeFillRecordResult } = await load();
  const copy = describeFillRecordResult({ status: 'rejected', reason: 'queue_full' });
  assert.match(copy.text, /已满/);
  assert.match(copy.text, /100/);
  assert.match(copy.text, /填表/);
});

test('a refused fill names the likely cause: the application is gone', async () => {
  const { describeFillRecordResult } = await load();
  const copy = describeFillRecordResult({ status: 'failed', code: 'invalid_payload' });
  assert.match(copy.text, /找不到所选的申请/);
  assert.doesNotMatch(copy.text, /公司和岗位/);
});

test('a fill archived without its snapshot says why, and still counts as archived', async () => {
  const { describeFillRecordResult } = await load();
  const reasons = {
    too_large: /2 MiB/,
    empty: /没有可以保存的字段/,
    staging_full: /已满/,
    staging_unavailable: /浏览器存储/,
    bytes_lost: /丢失/,
    queue_full: /已满/
  };
  for (const [issue, pattern] of Object.entries(reasons)) {
    const saved = describeFillRecordResult({ status: 'saved', snapshotIssue: issue });
    assert.match(saved.text, /已留档到桌面/, issue);
    assert.match(saved.text, pattern, issue);
    const waiting = describeFillRecordResult({ status: 'recorded', mode: 'unavailable', snapshotIssue: issue });
    assert.match(waiting.text, pattern, issue);
  }
  assert.match(describeFillRecordResult({ status: 'saved', uploadQueued: true }).text, /后台上传/);
});

test('the offer does not claim nothing is kept when a snapshot may be attached', async () => {
  const { describeFillOffer } = await load();
  const text = describeFillOffer({ outcome: 'completed', fieldCount: 3, filledCount: 3, unconfirmedCount: 0 });
  assert.doesNotMatch(text, /不记填写的内容/);
  assert.match(text, /不记网页上填了什么/);
});

test('an upload in progress is described by chunks, and a lost copy is never "retry"', async () => {
  const { describeSnapshotUpload } = await load();
  const chunks = [true, true, false, false].map((acked, chunkIndex) => ({ chunkIndex, acked }));
  assert.match(describeSnapshotUpload({ status: 'pending', chunkCount: 4, chunks }).text, /2\/4/);
  const lost = describeSnapshotUpload({ status: 'bytes_lost', chunkCount: 4, chunks });
  assert.match(lost.text, /暂存丢失/);
  assert.match(lost.text, /重新留档|桌面导入/);
  assert.equal(lost.retry, false);
  assert.match(describeSnapshotUpload({ status: 'paused', chunkCount: 4, chunks }).text, /换过档案库/);
  assert.match(describeSnapshotUpload({ status: 'pending', chunkCount: 4, chunks }, { expired: true }).text, /30 天/);
  for (const status of ['pending', 'stalled', 'failed', 'bytes_lost', 'paused', 'needs_user', 'completed']) {
    assert.doesNotMatch(describeSnapshotUpload({ status, chunkCount: 4, chunks }).text, /投递/, status);
  }
});
