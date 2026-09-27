import { test } from "node:test";
import assert from "node:assert/strict";
import { followRequestedViews, NAVIGATE_EVENT, targetForOpenView, type OpenViewTarget } from "./open-view.ts";

test("protocol views navigate to the existing desktop routes", () => {
  assert.deepEqual(targetForOpenView("resume"), { route: "resume" });
  assert.deepEqual(targetForOpenView("settings-ai"), { route: "settings", settingsTab: "ai" });
  assert.deepEqual(targetForOpenView("home"), { route: "applications" });
  assert.equal(targetForOpenView("unknown"), null);
  assert.equal(targetForOpenView({ view: "resume" }), null);
});

/** The desktop side: requests wait until taken, and listening finishes when the test says so. */
function desktop(...waiting: unknown[]) {
  let announce: (() => void) | null = null;
  let finishListening!: () => void;
  const listening = new Promise<void>((resolve) => { finishListening = resolve; });
  const shown: OpenViewTarget[] = [];
  let taken = 0;
  const follow = followRequestedViews({
    listen: async (event, handler) => {
      assert.equal(event, NAVIGATE_EVENT);
      announce = handler;
      await listening;
    },
    take: async () => {
      taken += 1;
      return waiting.length ? waiting.shift() : null;
    },
    show: (target) => shown.push(target),
  });
  return {
    follow,
    shown,
    taken: () => taken,
    finishListening,
    request(view: unknown) {
      waiting.splice(0, waiting.length, view);
      announce?.();
    },
    announce: () => announce?.(),
  };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

test("a view asked for before the page listens is shown once it does", async () => {
  const page = desktop("resume");
  await settled();
  assert.equal(page.taken(), 0, "taking before the listener is in place could miss a later request");
  page.finishListening();
  await page.follow;
  assert.deepEqual(page.shown, [{ route: "resume" }]);
});

test("a request made while the page listens is shown once, however often it is announced", async () => {
  const page = desktop();
  page.finishListening();
  await page.follow;
  assert.deepEqual(page.shown, []);
  page.request("settings-ai");
  await settled();
  page.announce();
  await settled();
  assert.deepEqual(page.shown, [{ route: "settings", settingsTab: "ai" }]);
});

test("an unknown view is not shown", async () => {
  const page = desktop("nowhere");
  page.finishListening();
  await page.follow;
  assert.deepEqual(page.shown, []);
});

test("a failed take does not stop later requests", async () => {
  let attempts = 0;
  let announce: () => void = () => {};
  const shown: OpenViewTarget[] = [];
  await followRequestedViews({
    listen: async (_event, handler) => { announce = handler; },
    take: async () => {
      attempts += 1;
      if (attempts === 1) throw { code: "NO_HOST", message: "gone" };
      return "home";
    },
    show: (target) => shown.push(target),
  });
  assert.deepEqual(shown, []);
  announce();
  await settled();
  assert.deepEqual(shown, [{ route: "applications" }]);
});
