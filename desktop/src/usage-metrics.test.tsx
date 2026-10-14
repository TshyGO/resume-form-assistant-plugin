import { expect, test, vi } from "vitest";
import type { Invoke } from "./api.ts";
import { installUsageSignals } from "./usage-metrics.ts";

test("synthetic/background DOM gestures do not call native telemetry", () => {
  const invoke = vi.fn(async () => {}) as Invoke;
  const stop = installUsageSignals(invoke);
  document.dispatchEvent(new Event("pointerdown"));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  expect(invoke).not.toHaveBeenCalled();
  stop();
});

test("trusted visible input sends no event fields, excludes settings and cleanup removes listeners", () => {
  // Browser-produced isTrusted cannot be assigned to a DOM event: exercise the registered
  // handler through a fake Document, while the native service is tested with real HTTP.
  const handlers = new Map<string, EventListener>();
  const target = { visibilityState: "visible", hasFocus: () => true,
    addEventListener: (name: string, handler: EventListener) => handlers.set(name, handler),
    removeEventListener: (name: string) => handlers.delete(name) } as unknown as Document;
  const fn = vi.fn(async () => {});
  const stop = installUsageSignals(fn as Invoke, target);
  const field = document.createElement("input"); field.value = "private resume field";
  handlers.get("pointerdown")!({ isTrusted: true, target: field } as unknown as Event);
  expect(fn).toHaveBeenCalledExactlyOnceWith("telemetry_touch");
  const settings = document.createElement("div"); settings.setAttribute("data-usage-settings", ""); settings.append(field);
  handlers.get("keydown")!({ isTrusted: true, target: field } as unknown as Event);
  expect(fn).toHaveBeenCalledTimes(1);
  Object.assign(target, { visibilityState: "hidden" });
  handlers.get("pointerdown")!({ isTrusted: true, target: null } as unknown as Event);
  expect(fn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(fn.mock.calls)).not.toContain("private resume field");
  stop(); expect(handlers.size).toBe(0);
});
