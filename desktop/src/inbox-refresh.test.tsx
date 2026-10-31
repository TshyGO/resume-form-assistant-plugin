// @vitest-environment node
import { test, expect, vi } from "vitest";
import { followInboxChanges } from "./inbox-refresh.ts";
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  const host = { window: new EventTarget(), document: Object.assign(new EventTarget(), { visibilityState: "visible" }) };
  const handlers = new Map<string, () => void>();
  const unlisten = vi.fn();
  const listen = vi.fn(async (name: string, handler: () => void) => { handlers.set(name, handler); return unlisten; });
  return {host, handlers, listen, unlisten};
}
test("native commits, native focus, DOM focus and visibility restoration re-read notifications without polling", async () => {
  const h = fixture(), refresh = vi.fn(async () => {});
  const dispose = followInboxChanges(refresh, h.listen, h.host); await flush();
  for (const action of [() => h.handlers.get("evidence-changed")!(), () => h.handlers.get("tauri://focus")!(),
    () => h.host.window.dispatchEvent(new Event("focus")), () => h.host.document.dispatchEvent(new Event("visibilitychange"))]) {
    const before = refresh.mock.calls.length; action(); await flush();
    expect(refresh.mock.calls.length).toBeGreaterThan(before);
  }
  const before = refresh.mock.calls.length;
  h.host.document.visibilityState = "hidden"; h.host.document.dispatchEvent(new Event("visibilitychange")); await flush();
  expect(refresh).toHaveBeenCalledTimes(before);
  dispose(); h.host.window.dispatchEvent(new Event("focus")); h.handlers.get("evidence-changed")!(); await flush();
  expect(refresh).toHaveBeenCalledTimes(before); expect(h.unlisten).toHaveBeenCalledTimes(2);
});
test("a commit during an in-flight read queues a fresh read instead of losing the update", async () => {
  const h = fixture(); let source = 0, release!: () => void;
  const seen: number[] = [];
  const refresh = vi.fn(async () => {
    const snapshot = source;
    if (!seen.length) await new Promise<void>(resolve => {release = resolve;});
    seen.push(snapshot);
  });
  const dispose = followInboxChanges(refresh, h.listen, h.host); await flush();
  source = 1; h.handlers.get("evidence-changed")!(); h.handlers.get("evidence-changed")!();
  release(); await flush();
  expect(seen).toEqual([0, 1]); dispose();
});
test("subscription readiness closes the cold-start gap and failed subscriptions retain foreground recovery", async () => {
  const h = fixture(); let source = 0;
  const seen: number[] = [], ready: Array<(stop: () => void) => void> = [];
  const listen = () => new Promise<() => void>(resolve => ready.push(resolve));
  const dispose = followInboxChanges(async () => { seen.push(source); }, listen, h.host); await flush();
  source = 1; for (const resolve of ready) resolve(() => {}); await flush();
  expect(seen).toEqual([0, 1]); dispose();
  let calls = 0;
  const stop = followInboxChanges(async () => { calls++; throw new Error("read unavailable"); }, async () => { throw new Error("listen unavailable"); }, h.host);
  await flush(); const previous = calls;
  h.host.window.dispatchEvent(new Event("focus")); await flush();
  expect(calls).toBeGreaterThan(previous); stop();
});
