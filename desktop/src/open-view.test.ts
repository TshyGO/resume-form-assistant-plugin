import { test } from "node:test";
import assert from "node:assert/strict";
import { targetForOpenView } from "./open-view.ts";

test("protocol views navigate to the existing desktop routes", () => {
  assert.deepEqual(targetForOpenView("resume"), { route: "resume" });
  assert.deepEqual(targetForOpenView("settings-ai"), { route: "settings", settingsTab: "ai" });
  assert.deepEqual(targetForOpenView("home"), { route: "applications" });
  assert.equal(targetForOpenView("unknown"), null);
  assert.equal(targetForOpenView({ view: "resume" }), null);
});
