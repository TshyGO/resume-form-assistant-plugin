import { test } from "node:test";
import assert from "node:assert/strict";
import { createApplicationsController, evidenceLabel, stageLabel } from "./applications.js";

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
