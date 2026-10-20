import { beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";

// #314：恢复、回滚换回、云端恢复都会把档案整个换掉。这里跑 main.ts 真实的接线，
// 证明这三条路都会让「申请」「招聘通知」「简历」重新读取，而不是只刷新备份区。
const views = vi.hoisted(() => ({
  reloadArchive: vi.fn(async () => {}),
  refreshList: vi.fn(async () => {}),
  inboxRefresh: vi.fn(async () => true),
  resumeRefresh: vi.fn(),
  localBackup: vi.fn(async () => {}),
  cloudBackup: vi.fn(async () => {}),
  onLocalRestored: null as null | (() => void),
  onCloudRestored: null as null | (() => void | Promise<void>),
}));

vi.mock("./feedback.ts", () => ({ installFrontendErrors: vi.fn() }));
vi.mock("./react/feedback-mount.tsx", () => ({ mountFeedbackSettings: vi.fn() }));
vi.mock("./react/usage-mount.tsx", () => ({ mountUsageSettings: vi.fn() }));
vi.mock("./usage-metrics.ts", () => ({ installUsageSignals: vi.fn() }));
vi.mock("./react/runtime-status-mount.tsx", () => ({ mountRuntimeStatus: () => ({ update: vi.fn(), fail: vi.fn() }) }));
vi.mock("./ai/mount.tsx", () => ({ mountAiSettings: vi.fn(), mountAiReview: vi.fn() }));
vi.mock("./applications-ui.ts", () => ({
  mountApplications: () => ({ refreshList: views.refreshList, reloadArchive: views.reloadArchive }),
}));
vi.mock("./inbox-ui.ts", () => ({ mountInbox: () => ({ refresh: views.inboxRefresh }) }));
vi.mock("./todos-ui.ts", () => ({ mountTodos: () => async () => {} }));
vi.mock("./resume/mount.tsx", () => ({
  mountResume: () => ({ refresh: views.resumeRefresh, confirmLeave: async () => true }),
}));
vi.mock("./backup-ui.ts", () => ({
  mountBackup: (_invoke: unknown, _pickers: unknown, _now: unknown, onRestored: () => void) => {
    views.onLocalRestored = onRestored;
    return views.localBackup;
  },
}));
vi.mock("./cloud-backup-ui.ts", () => ({
  mountCloudBackup: (_invoke: unknown, onRestored: () => void | Promise<void>) => {
    views.onCloudRestored = onRestored;
    return views.cloudBackup;
  },
}));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  delete window.__TAURI__;
  await import("./main.ts");
  for (let i = 0; i < 12; i++) await Promise.resolve();
  // 启动时那一轮读取不算，只看恢复之后。
  vi.clearAllMocks();
});

function expectEveryViewReloaded() {
  expect(views.reloadArchive).toHaveBeenCalledTimes(1);
  expect(views.inboxRefresh).toHaveBeenCalledTimes(1);
  expect(views.resumeRefresh).toHaveBeenCalledTimes(1);
}

test("a local restore or rollback reloads applications, inbox and resume, then the cloud backup panel", async () => {
  views.onLocalRestored!();
  await Promise.resolve();
  expectEveryViewReloaded();
  expect(views.cloudBackup).toHaveBeenCalledWith(true);
});

test("a cloud restore reloads applications, inbox and resume, then the local backup panel", async () => {
  await views.onCloudRestored!();
  expectEveryViewReloaded();
  expect(views.localBackup).toHaveBeenCalledTimes(1);
});

test("a failed applications reload is shown on the applications page instead of failing the cloud restore", async () => {
  views.reloadArchive.mockRejectedValueOnce(new Error("读不到申请"));
  await expect(views.onCloudRestored!()).resolves.toBeUndefined();
  expect(document.getElementById("apps-msg")!.textContent).toContain("读不到申请");
  expect(views.inboxRefresh).toHaveBeenCalledTimes(1);
});
