import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ArchiveCounts, OrphanReport, RestorePreview } from './api.ts';
import {
  EXPORT_NOTE,
  PURGE_WARNING,
  RESTORE_NOTE,
  defaultBackupName,
  describeChange,
  describeExport,
  describeOrphans,
  describePreview,
  describePurgePreview,
  describeRemindersAfterRestore,
  describeRestore,
  formatSize,
} from './backup.ts';

function counts(overrides: Partial<ArchiveCounts> = {}): ArchiveCounts {
  return {
    applications: 5,
    events: 20,
    snapshots: 2,
    todos: 3,
    evidence: 4,
    attachments: 4,
    ...overrides,
  };
}

function preview(overrides: Partial<RestorePreview> = {}): RestorePreview {
  return {
    createdAt: "2026-09-13T02:00:00.000Z",
    archiveId: "a-1",
    schemaVersion: 3,
    incoming: counts(),
    current: counts(),
    existingRollbackPoints: 0,
    tooManyRollbackPoints: false,
    sameArchive: true,
    ...overrides,
  };
}

// data-privacy §6.3：导出 UI 必须说明文件不加密、含 PII、应放在用户控制的位置。
test('导出说明把三件事都说了，而且不吹加密', () => {
  assert.match(EXPORT_NOTE, /不加密/);
  assert.match(EXPORT_NOTE, /简历/);
  assert.match(EXPORT_NOTE, /自己控制的位置/);
  assert.match(EXPORT_NOTE, /API Key.*不会进备份/);
  assert.doesNotMatch(EXPORT_NOTE, /已加密|加密保护/, "我们没做加密，一个字都不能这么写");
});

test('恢复说明要讲清旧的那份去哪了', () => {
  assert.match(RESTORE_NOTE, /整个换成/);
  assert.match(RESTORE_NOTE, /不会删掉/);
  assert.match(RESTORE_NOTE, /回滚点/);
});

test('永久删除的警告要说不可撤销、也不进回收站', () => {
  assert.match(PURGE_WARNING, /不可撤销/);
  assert.match(PURGE_WARNING, /不会进回收站/);
  assert.match(PURGE_WARNING, /没有别的申请引用/, "附件的删除条件也要说清");
});

test('对比只列会变的那些', () => {
  const changed = describeChange(
    preview({ incoming: counts({ applications: 8, todos: 3 }) }),
  );
  assert.deepEqual(changed, ["申请 5 → 8"], "待办没变就不该出现在对比里");

  assert.deepEqual(describeChange(preview()), []);
});

test('数量完全一样的时候直说，不留空白', () => {
  const lines = describePreview(preview());
  assert.equal(lines.length, 1);
  assert.match(lines[0]?.text ?? "", /完全一样/);
});

test('备份来自另一个档案时要提醒，但不当成错误', () => {
  const lines = describePreview(preview({ sameArchive: false }));
  const warn = lines.find((line) => line.tone === "warn");
  assert.match(warn?.text ?? "", /另一个档案/);
  assert.doesNotMatch(warn?.text ?? "", /失败|错误/, "拿别人的档案恢复是合法操作，只是要知情");
});

test('回滚点太多只提示，并且说明不会自动删', () => {
  const lines = describePreview(preview({ existingRollbackPoints: 3, tooManyRollbackPoints: true }));
  const warn = lines.find((line) => line.text.includes("回滚点"));
  assert.match(warn?.text ?? "", /不会自动删/);
});

test('导出结果把没进包的东西说出来', () => {
  const quiet = describeExport("D:/backup.zip", 2048, []);
  assert.equal(quiet.tone, "success");
  assert.match(quiet.text, /2\.0 KB/);

  const noisy = describeExport("D:/backup.zip", 2048, ["mystery.bin（清单里没有这一项）"]);
  assert.match(noisy.text, /mystery\.bin/);
});

test('恢复之后要说提醒需要重新登记，而不是说它们没了', () => {
  assert.equal(describeRemindersAfterRestore(0), null);

  const message = describeRemindersAfterRestore(3);
  assert.match(message?.text ?? "", /重新登记/);
  assert.match(message?.text ?? "", /待办本身都在/, "别让用户以为待办丢了");
  assert.doesNotMatch(message?.text ?? "", /丢失|删除/);
});

test('恢复成功的提示要带上回滚点的名字', () => {
  const message = describeRestore(counts(), "2026-09-13-abc");
  assert.match(message.text, /5 条申请/);
  assert.match(message.text, /2026-09-13-abc/, "用户得知道换回去要点哪一个");
});

test('永久删除的预览把连带删掉的都列出来', () => {
  const text = describePurgePreview({
    applicationId: "a",
    company: "合成公司",
    title: "后端工程师",
    events: 9,
    todos: 2,
    evidence: 1,
    snapshots: 1,
  });
  assert.match(text, /合成公司 · 后端工程师/);
  assert.match(text, /9 条事件/);
  assert.match(text, /1 份证据/);
});

test('有悬空引用时先别删任何东西', () => {
  const report: OrphanReport = {
    totalBlobs: 5,
    totalEvidence: 4,
    zeroRefBlobs: ["abc"],
    danglingEvidence: ["ev-1"],
    invalidFiles: [],
  };
  const message = describeOrphans(report);
  assert.equal(message.tone, "warn");
  assert.match(message.text, /先别删/, "悬空引用说明档案里有别的问题");
});

test('没有孤立附件时说清楚，有的时候说要逐个确认', () => {
  const clean = describeOrphans({
    totalBlobs: 5,
    totalEvidence: 5,
    zeroRefBlobs: [],
    danglingEvidence: [],
    invalidFiles: [],
  });
  assert.equal(clean.tone, "success");

  const some = describeOrphans({
    totalBlobs: 5,
    totalEvidence: 3,
    zeroRefBlobs: ["a", "b"],
    danglingEvidence: [],
    invalidFiles: [],
  });
  assert.match(some.text, /2 份/);
  assert.match(some.text, /逐个确认/);
});

test('大小和默认文件名', () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.match(formatSize(5 * 1024 * 1024), /5\.0 MB/);
  assert.equal(formatSize(-1), "大小未知");

  assert.equal(
    defaultBackupName(new Date(2026, 8, 13, 9, 5)),
    "resume-pro-archive-20260913-0905.zip",
  );
});
