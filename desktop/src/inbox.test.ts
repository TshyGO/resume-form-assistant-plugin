import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHOOSE_APPLICATION_HINT,
  EMPTY_INBOX,
  PRIVACY_NOTE,
  describeAssociation,
  describeClassification,
  describeEvidenceMeta,
  describeImport,
  describeUnassociation,
  duplicateNote,
  evidenceTitle,
  importErrorText,
  importedAtLabel,
  replyClassLabel,
  sendModeLabel,
  sizeLabel,
} from './inbox.ts';

test('an import is reported per outcome, and a duplicate is not an error', () => {
  const ok = describeImport({ imported: [{ id: 'a' }], duplicates: [], failed: [] });
  assert.equal(ok.tone, 'success');
  assert.match(ok.text, /已导入 1 条，待分类/);

  const mixed = describeImport({
    imported: [{ id: 'a' }],
    duplicates: [{ id: 'b' }],
    failed: [{ name: 'invite.msg', code: 'unsupported' }],
  });
  assert.equal(mixed.tone, 'warn');
  assert.match(mixed.text, /invite\.msg/);
  assert.match(mixed.text, /另存为 \.eml/);
  assert.match(mixed.text, /没有重复保存/);

  assert.equal(describeImport({ imported: [], duplicates: [], failed: [] }).tone, 'info');
});

test('every import failure has a sentence, including the ones we did not enumerate', () => {
  assert.match(importErrorText('too_large'), /25 MiB/);
  assert.match(importErrorText('source_unreadable'), /读不到/);
  assert.match(importErrorText('storage'), /什么都没有留下/);
  assert.match(importErrorText('too_many_files'), /20 个/);
  assert.match(importErrorText('something-new'), /没能导入/);
});

test('classification words never claim a human sent it', () => {
  assert.equal(replyClassLabel('interview_invite'), '面试邀请');
  assert.equal(sendModeLabel(undefined), '未知');
  assert.equal(sendModeLabel('automated'), '系统自动发送');
  const said = describeClassification({ replyClass: 'interview_invite', sendMode: 'automated' }).text;
  assert.match(said, /面试邀请/);
  assert.match(said, /系统自动发送/);
  assert.doesNotMatch(said, /人工/);
  assert.match(said, /不改变申请阶段/);
});

test('associating says what it did and what it did not do', () => {
  const said = describeAssociation({ id: 'e1' }, '星河科技').text;
  assert.match(said, /星河科技/);
  assert.match(said, /已导入，待分类/);
  assert.doesNotMatch(said, /投递|回复了/);
  assert.match(describeUnassociation().text, /已取消关联.*招聘通知.*待整理/);
  assert.doesNotMatch(describeUnassociation().text, /回复证据|尚未导入/, '不推断申请是否还有其他材料');
  assert.match(said, /申请详情的「招聘通知」/, '关联之后材料去了哪儿要说出来');
});

test('a title falls back from subject to filename to kind', () => {
  assert.equal(evidenceTitle({ subject: '面试邀请', originalFilename: 'x.eml' }), '面试邀请');
  assert.equal(evidenceTitle({ subject: '   ', originalFilename: 'x.eml' }), 'x.eml');
  assert.equal(evidenceTitle({ kind: 'paste' }), '粘贴文本');
});

test('the meta line carries the sender and both times, and sizes read as sizes', () => {
  const meta = describeEvidenceMeta({
    kind: 'eml',
    fromAddr: 'hr@example.test',
    sentAt: '2026-09-12T08:00:00.000Z',
    importedAt: '2026-09-12T09:00:00.000Z',
    sizeBytes: 2048,
  });
  assert.match(meta, /邮件/);
  assert.match(meta, /hr@example\.test/);
  // 时间按本机时区写成「年-月-日 时:分」，不把 UTC 的 ISO 串直接丢给用户。
  assert.match(meta, new RegExp(`发送于 ${importedAtLabel('2026-09-12T08:00:00.000Z')}`));
  assert.match(meta, new RegExp(`导入于 ${importedAtLabel('2026-09-12T09:00:00.000Z')}`));
  assert.doesNotMatch(meta, /T08:00/);
  assert.match(meta, /2\.0 KiB/);
  assert.equal(sizeLabel(999), '999 B');
  assert.equal(sizeLabel(5 * 1024 * 1024), '5.0 MiB');
});

test('the duplicate hint counts the others and explains the single copy', () => {
  assert.equal(duplicateNote({ sameBytesAs: [] }), '');
  assert.match(duplicateNote({ sameBytesAs: ['a', 'b'] }), /另外 2 条/);
  assert.match(duplicateNote({ sameBytesAs: ['a'] }), /只存了一次/);
});

test('the empty inbox and the application hint say the honest thing', () => {
  assert.match(EMPTY_INBOX, /申请详情/, '关联过的材料去了哪儿要说清楚');
  assert.match(PRIVACY_NOTE, /本机/);
  assert.match(PRIVACY_NOTE, /确认/);
  assert.doesNotMatch(PRIVACY_NOTE, /同步邮箱|自动收信/);
  assert.doesNotMatch(EMPTY_INBOX, /没有回复|未回复/);
  assert.match(CHOOSE_APPLICATION_HINT, /不会替你猜/);
});
