import { test } from "node:test";
import assert from "node:assert/strict";
import { createPairingController } from "./pairing-form.js";

test("typed values survive multiple status refreshes", () => {
  const form = createPairingController();
  const first = form.beginRefresh();
  const applied = form.applyStatus(first, {
    chromeExtensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    edgeExtensionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  assert.equal(applied.chrome, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  form.markChromeDirty();
  form.markEdgeDirty();
  const typed = { chrome: "typed-chrome", edge: "typed-edge" };
  for (let i = 0; i < 5; i += 1) {
    const token = form.beginRefresh();
    const next = form.applyStatus(token, {
      chromeExtensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      edgeExtensionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    assert.equal(next.applied, true);
    assert.equal(next.chrome, undefined);
    assert.equal(next.edge, undefined);
  }
  assert.equal(typed.chrome, "typed-chrome");
  assert.equal(form.snapshot().chromeDirty, true);
});

test("stale refresh cannot overwrite a newer response or typed input", () => {
  const form = createPairingController();
  const older = form.beginRefresh();
  const newer = form.beginRefresh();
  const latest = form.applyStatus(newer, {
    chromeExtensionId: "newvalue",
    edgeExtensionId: "",
  });
  assert.equal(latest.chrome, "newvalue");

  form.markChromeDirty();
  const stale = form.applyStatus(older, {
    chromeExtensionId: "oldvalue",
    edgeExtensionId: "old-edge",
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "stale");
});

test("save success applies stored draft and ignores in-flight refresh", () => {
  const form = createPairingController();
  const inflight = form.beginRefresh();
  form.markChromeDirty();
  const saved = form.onSaveSuccess({
    chromeExtensionId: "saved-chrome",
    edgeExtensionId: "saved-edge",
  });
  assert.equal(saved.chrome, "saved-chrome");
  assert.equal(form.snapshot().chromeDirty, false);

  const stale = form.applyStatus(inflight, {
    chromeExtensionId: "should-not-win",
    edgeExtensionId: "",
  });
  assert.equal(stale.applied, false);

  const token = form.beginRefresh();
  const next = form.applyStatus(token, {
    chromeExtensionId: "saved-chrome",
    edgeExtensionId: "saved-edge",
  });
  assert.equal(next.chrome, "saved-chrome");
});

test("save failure keeps dirty user input", () => {
  const form = createPairingController();
  form.markChromeDirty();
  form.markEdgeDirty();
  const result = form.onSaveFailure();
  assert.equal(result.keepInput, true);
  assert.equal(result.chromeDirty, true);
  assert.equal(result.edgeDirty, true);
  const token = form.beginRefresh();
  const next = form.applyStatus(token, {
    chromeExtensionId: "from-disk",
    edgeExtensionId: "from-disk-edge",
  });
  assert.equal(next.chrome, undefined);
  assert.equal(next.edge, undefined);
});
