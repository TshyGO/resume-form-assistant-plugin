import { test } from "node:test";
import assert from "node:assert/strict";
import { createApplicationsController, evidenceLabel, stageLabel, occurredLabel } from "./applications.js";

test("stale list responses do not replace a newer token", () => {
  const ctl = createApplicationsController();
  const older = ctl.beginList();
  const newer = ctl.beginList();
  assert.equal(ctl.isCurrent(newer), true);
  assert.equal(ctl.isCurrent(older), false);
});

test("dirty form flag survives list refresh tokens", () => {
  const ctl = createApplicationsController();
  ctl.markFormDirty();
  ctl.beginList();
  assert.equal(ctl.formDirty, true);
  ctl.clearFormDirty();
  assert.equal(ctl.formDirty, false);
});

test("saving flag blocks overlapping submits in controller state", () => {
  const ctl = createApplicationsController();
  assert.equal(ctl.saving, false);
  ctl.setSaving(true);
  assert.equal(ctl.saving, true);
  ctl.setSaving(false);
  assert.equal(ctl.snapshot().saving, false);
});

test("evidence copy never claims the employer did not reply", () => {
  assert.equal(evidenceLabel("none_imported"), "尚未导入回复证据");
  assert.equal(evidenceLabel("imported_unclassified"), "已导入，待分类");
  assert.equal(stageLabel("submitted"), "已投递");
});

test('occurrence displays date or unknown without substituting recorded time',()=>{
  assert.equal(occurredLabel({precision:'unknown'}),'发生时间未知');
  assert.equal(occurredLabel({precision:'date',value:{date:'2026-08-21'}}),'2026-08-21');
  assert.equal(occurredLabel({precision:'date_time',value:{rfc3339:'2026-08-21T10:00:00Z'}}),'2026-08-21T10:00:00Z');
});

test('a fill event says what was written into the page, never that it was submitted', async () => {
  const { fillSummary } = await import('./applications.js');
  const text = fillSummary({ kind: 'fill_event', outcome: 'partial', field_count: 12, filled_count: 9, unconfirmed_count: 3, template_name: '合成模板', template_version: '0123456789ab' });
  assert.match(text, /部分完成/);
  assert.match(text, /已写入网页 9\/12 项/);
  assert.match(text, /3 项未确认/);
  assert.match(text, /合成模板/);
  assert.doesNotMatch(text, /投递|提交|已接受/);
  assert.equal(fillSummary({ kind: 'note_added', text: 'x' }), '');
});

test('a snapshot that is not stored is never offered as if it were', async () => {
  const { snapshotStateLabel, SNAPSHOT_DISCLAIMER } = await import('./applications.js');
  assert.equal(snapshotStateLabel('stored'), null);
  assert.match(snapshotStateLabel('uploading'), /上传中/);
  assert.match(snapshotStateLabel('missing'), /不可用/);
  assert.match(snapshotStateLabel(undefined), /不可用/);
  assert.match(SNAPSHOT_DISCLAIMER, /不能/);
  assert.match(SNAPSHOT_DISCLAIMER, /网站/);
});

test('a fill line shows how long it took and which revision of the template it used', async () => {
  const { fillSummary } = await import('./applications.js');
  const text = fillSummary({ kind: 'fill_event', outcome: 'completed', field_count: 5, filled_count: 5,
    durations_ms: { scan: 40, match: 900, fill: 1480, total: 2420 }, template_name: '合成模板', template_version: '0123456789ab' });
  assert.match(text, /用时 2\.4 秒/);
  assert.match(text, /合成模板（0123456789ab）/);
  const long = fillSummary({ kind: 'fill_event', outcome: 'completed', durations_ms: { total: 125000 } });
  assert.match(long, /用时 2 分 5 秒/);
  assert.doesNotMatch(fillSummary({ kind: 'fill_event', outcome: 'failed', durations_ms: {} }), /用时/);
});

test('a missing snapshot points at the list where a re-uploaded copy would be', async () => {
  const { snapshotStateLabel } = await import('./applications.js');
  assert.match(snapshotStateLabel('missing'), /快照列表/);
});

test('a fill line does not invent a count the plugin did not send', async () => {
  const { fillSummary } = await import('./applications.js');
  const text = fillSummary({ kind: 'fill_event', outcome: 'completed', field_count: 12 });
  assert.doesNotMatch(text, /0\/12/);
  assert.match(text, /共 12 项/);
});

test('an application with no evidence never implies nobody replied', async () => {
  const { evidenceLabel, evidenceNote } = await import('./applications.js');
  assert.equal(evidenceLabel('none_imported'), '尚未导入回复证据');
  assert.match(evidenceNote('none_imported'), /不代表对方没有回复/);
  assert.match(evidenceNote('imported_unclassified'), /还没有确认/);
  assert.equal(evidenceNote('classified'), '');
});

test('an evidence line keeps class and send mode apart', async () => {
  const { evidenceLine } = await import('./applications.js');
  const line = evidenceLine({ kind: 'eml', fromAddr: 'hr@example.test', sentAt: '2026-09-12T08:00:00.000Z', replyClass: 'interview_invite', sendMode: 'automated' });
  assert.match(line, /邮件/);
  assert.match(line, /面试邀请/);
  assert.match(line, /发送方式：系统自动发送/);
  assert.doesNotMatch(line, /人工/);
  assert.match(evidenceLine({ kind: 'paste' }), /待分类 · 发送方式：未知/);
});
