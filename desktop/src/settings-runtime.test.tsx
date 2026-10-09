import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent } from "@testing-library/dom";
import type { Invoke, RuntimeStatus } from "./api.ts";
import { formatCheckedAt, parseCheckedAt } from "./update-check.ts";

const runtime = vi.hoisted(() => ({ update: vi.fn(), fail: vi.fn() }));

// Exercise main.ts's actual event handlers, polling and DOM writes without mounting unrelated views.
vi.mock("./feedback.ts", () => ({ installFrontendErrors: vi.fn() }));
vi.mock("./react/feedback-mount.tsx", () => ({ mountFeedbackSettings: vi.fn() }));
vi.mock("./react/runtime-status-mount.tsx", () => ({ mountRuntimeStatus: () => runtime }));
vi.mock("./ai/mount.tsx", () => ({ mountAiSettings: vi.fn(), mountAiReview: vi.fn() }));
vi.mock("./applications-ui.ts", () => ({ mountApplications: () => ({ refreshList: async () => {} }) }));
vi.mock("./inbox-ui.ts", () => ({ mountInbox: () => ({ refresh: async () => {} }) }));
vi.mock("./todos-ui.ts", () => ({ mountTodos: () => async () => {} }));
vi.mock("./backup-ui.ts", () => ({ mountBackup: () => async () => {} }));
vi.mock("./resume/mount.tsx", () => ({ mountResume: () => ({ refresh: vi.fn(), confirmLeave: async () => true }) }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T15:00:00Z"));
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  delete window.__TAURI__;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  delete window.__TAURI__;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function status(version = "0.4.2"): RuntimeStatus {
  return { appVersion: version, nativeMessaging: [{ label: "Chrome", registered: true }] } as RuntimeStatus;
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function start(handler?: (command: string) => Promise<unknown>) {
  if (handler) window.__TAURI__ = { core: { invoke: handler as Invoke } };
  await import("./main.ts");
  await settle();
}

function pollHost(requests: ReturnType<typeof deferred<RuntimeStatus>>[]) {
  return async (command: string) => {
    if (command === "get_runtime_status") return requests.shift()!.promise;
    if (command === "get_update_preference_cmd") return { enabled: false };
    return {};
  };
}

test("a late startup failure cannot replace a newer poll's successful status or topbar", async () => {
  const old = deferred<RuntimeStatus>();
  const latest = deferred<RuntimeStatus>();
  await start(pollHost([old, latest]));
  await vi.advanceTimersByTimeAsync(4000);
  latest.resolve(status());
  await settle();
  old.reject(new Error("obsolete read failure"));
  await settle();
  expect(runtime.update).toHaveBeenCalledExactlyOnceWith(status());
  expect(runtime.fail).not.toHaveBeenCalled();
  expect(document.getElementById("runtime-pill")!.textContent).toBe("已注册 Chrome");
  expect(document.getElementById("link-state")!.textContent).not.toContain("obsolete");
});

test("an older success cannot clear the latest failure", async () => {
  const old = deferred<RuntimeStatus>();
  const latest = deferred<RuntimeStatus>();
  await start(pollHost([old, latest]));
  await vi.advanceTimersByTimeAsync(4000);
  latest.reject(new Error("latest read failure"));
  await settle();
  old.resolve(status("0.3.0"));
  await settle();
  expect(runtime.update).not.toHaveBeenCalled();
  expect(runtime.fail).toHaveBeenCalledExactlyOnceWith("latest read failure");
  expect(document.getElementById("link-state")!.textContent).toContain("latest read failure");
});

test("an older success cannot roll back the version and registration shown by a newer success", async () => {
  const old = deferred<RuntimeStatus>();
  const latest = deferred<RuntimeStatus>();
  await start(pollHost([old, latest]));
  await vi.advanceTimersByTimeAsync(4000);
  latest.resolve(status());
  await settle();
  old.resolve({ ...status("0.3.0"), nativeMessaging: [] });
  await settle();
  expect(runtime.update).toHaveBeenCalledExactlyOnceWith(status());
  expect(document.getElementById("app-version")!.textContent).toBe("v0.4.2");
  expect(document.getElementById("runtime-pill")!.textContent).toBe("已注册 Chrome");
});

test("registration retry without a desktop host explains why it cannot run", async () => {
  await start();
  const retry = document.getElementById("link-retry")!;
  expect(retry.hidden).toBe(false);
  fireEvent.click(retry);
  expect(document.getElementById("link-action-msg")!.textContent).toMatch(/未连接到桌面宿主.*Tauri/);
});

test.each([false, true])("update check uses the persisted timestamp even when the check fails: %s", async (fails) => {
  const saved = "2026-10-09T06:20:00Z";
  const calls: string[] = [];
  await start(async (command) => {
    calls.push(command);
    if (command === "get_runtime_status") return status();
    if (command === "get_update_preference_cmd") return { enabled: false, lastCheckedAt: saved };
    if (command === "check_update_cmd" && fails) throw { code: "UPDATE_OFFLINE" };
    return null;
  });
  fireEvent.click(document.getElementById("update-check")!);
  await settle();
  expect(calls.slice(-2)).toEqual(["check_update_cmd", "get_update_preference_cmd"]);
  expect(document.getElementById("update-checked-at")!.textContent)
    .toBe(`上次检查：${formatCheckedAt(parseCheckedAt(saved)!, new Date())}`);
  expect(document.getElementById("update-msg-text")!.textContent).toMatch(fails ? /连不上/ : /最新版/);
  expect(document.getElementById("update-check")!.getAttribute("aria-busy")).toBeNull();
});

test.each(["read error", "missing", "invalid"])("a timestamp that cannot be read is hidden without losing the update result: %s", async (reason) => {
  let reads = 0;
  await start(async (command) => {
    if (command === "get_runtime_status") return status();
    if (command === "get_update_preference_cmd") {
      if (++reads === 1) return { enabled: false, lastCheckedAt: "2026-10-09T06:20:00Z" };
      if (reason === "read error") throw new Error("cannot read preferences");
      return { enabled: false, lastCheckedAt: reason === "invalid" ? "not a date" : null };
    }
    return null;
  });
  expect(document.getElementById("update-checked-at")!.hidden).toBe(false);
  fireEvent.click(document.getElementById("update-check")!);
  await settle();
  expect(document.getElementById("update-checked-at")!.hidden).toBe(true);
  expect(document.getElementById("update-msg-text")!.textContent).toContain("最新版");
  expect(document.getElementById("update-check")!.getAttribute("aria-busy")).toBeNull();
});
