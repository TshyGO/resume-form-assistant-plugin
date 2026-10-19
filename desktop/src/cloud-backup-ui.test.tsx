import { beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, waitFor, within } from "@testing-library/dom";
import { mountCloudBackup, cloudError } from "./cloud-backup-ui";
import type { Invoke } from "./api";

const config = { connection: { connectionId: "11111111-1111-4111-8111-111111111111", endpoint: "https://dav.jianguoyun.com/dav/", username: "synthetic" }, options: { encrypted: true, root: ["Test"], keepLast: 5 }, automaticEnabled: false, requiresConfirmation: false };
const counts = { applications: 1, events: 2, todos: 0, evidence: 0, snapshots: 0, attachments: 0 };
const metadata = { backupId: "synthetic-backup", createdAt: "2026-10-19T00:00:00Z", package: "backup.rpbak.age", archiveId: "synthetic-archive", deviceId: "synthetic-device", sizeBytes: 1024, encryptionFormat: "ageV1Scrypt" };
beforeEach(() => {
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  document.getElementById("view-settings")!.classList.remove("hidden");
  document.getElementById("settings-data")!.hidden = false;
});
function setup(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const onRestored = vi.fn();
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ name, args });
    const override = overrides[name];
    if (typeof override === "function") return await override(args) as T;
    if (overrides[name] instanceof Error) throw overrides[name];
    return (overrides[name] ?? ({
      cloud_backup_schedule_status: { enabled: false, requiresConfirmation: false, recentSize: null, estimatedCycleBytes: null, state: { plan: null, nextAt: null, paused: null, message: null, retryAt: null, retries: 0, cycleStartedAt: null, uploadBytes: 0, budgetWarning: false } },
      cloud_backup_config: config,
      cloud_backup_status: { job: null, latestPackage: null, latestMetadata: null, retryPackage: null },
      cloud_backup_credential_status: { hasWebdavPassword: true, hasBackupPassphrase: true },
      cloud_backup_discover: { sources: [{ archiveId: metadata.archiveId, deviceId: metadata.deviceId }], warnings: [] },
      cloud_backup_list: { entries: [metadata], cleanupSafe: false, contentHashVerified: false },
      cloud_backup_preview: { token: "bound-token", backupId: metadata.backupId, expiresAt: "2026-10-19T00:10:00Z", preview: { incoming: counts, current: { ...counts, applications: 2 }, createdAt: metadata.createdAt, sameArchive: false, currentAvailable: true, existingRollbackPoints: 0 } },
      cloud_backup_restore: { report: {}, cleanupWarning: false },
    } as Record<string, unknown>)[name]) as T;
  };
  const refresh = mountCloudBackup(invoke, onRestored);
  return { calls, refresh, onRestored, query: within(document.getElementById("cloud-backup")!) };
}
const click = (id: string) => fireEvent.click(document.getElementById(id)!);
const dialog = () => document.querySelector<HTMLDialogElement>("dialog.settings-dialog");

test("automatic plan is opt in, estimates from a prior package and sends only a confirmed nonsecret plan", async () => {
  const { refresh, calls } = setup({ cloud_backup_schedule_status: {
    enabled: false, requiresConfirmation: false, recentSize: 2_000_000, estimatedCycleBytes: null,
    state: { plan: null, nextAt: null, paused: null, message: null, retryAt: null, retries: 0, cycleStartedAt: null, uploadBytes: 0, budgetWarning: false },
  } });
  await refresh();
  expect(calls.some(c => c.name === "cloud_backup_schedule_configure")).toBe(false);
  expect(document.getElementById("cloud-auto-estimate")!.textContent).toContain("60.00 MB");
  fireEvent.change(document.getElementById("cloud-auto-days")!, { target: { value: "7" } });
  fireEvent.input(document.getElementById("cloud-auto-days")!);
  expect(document.getElementById("cloud-auto-estimate")!.textContent).toContain("10.00 MB");
  fireEvent.submit(document.getElementById("cloud-auto-form")!);
  await waitFor(() => expect(dialog()).toBeTruthy());
  expect(calls.some(c => c.name === "cloud_backup_schedule_configure")).toBe(false);
  fireEvent.click(within(dialog()!).getByRole("button", { name: "确认启用" }));
  await waitFor(() => expect(calls.some(c => c.name === "cloud_backup_schedule_configure")).toBe(true));
  const args = calls.find(c => c.name === "cloud_backup_schedule_configure")!.args!;
  expect(args).toEqual({ plan: { minute: 1260, everyDays: 7, utcOffsetMinutes: 0 - new Date().getTimezoneOffset(), budgetBytes: 1_000_000_000, pauseAtBudget: true } });
  expect(JSON.stringify(args)).not.toMatch(/password|passphrase/i);
});

test("missed and paused schedules warn outside settings; missing size stays unknown and disable is explicit", async () => {
  const { refresh, calls } = setup({ cloud_backup_schedule_status: {
    enabled: true, requiresConfirmation: false, recentSize: null, estimatedCycleBytes: null,
    state: { plan: { minute: 1260, everyDays: 1, utcOffsetMinutes: 480, budgetBytes: 1_000_000_000, pauseAtBudget: true }, nextAt: 1700000000, paused: null, message: "MISSED_MANUAL", retryAt: null, retries: 0, cycleStartedAt: null, uploadBytes: 0, budgetWarning: false },
  } });
  await refresh();
  expect(document.getElementById("cloud-auto-notice")!.hidden).toBe(false);
  expect(document.getElementById("cloud-auto-notice-text")!.textContent).toContain("未自动补传");
  expect(document.getElementById("cloud-auto-estimate")!.textContent).toContain("暂无可用大小估算");
  expect(calls.some(c => c.name === "cloud_backup_start")).toBe(false);
  click("cloud-auto-disable");
  await waitFor(() => expect(calls.find(c => c.name === "cloud_backup_schedule_configure")?.args).toEqual({ plan: null }));
});

test("saved credentials never echo; nonsecret settings and write-only credentials use separate commands", async () => {
  const { refresh, calls, query } = setup(); await refresh();
  expect(query.getByText("此账号的应用密码：已保存；加密口令：已保存。")).toBeTruthy();
  const pass = document.getElementById("cloud-password") as HTMLInputElement;
  const phrase = document.getElementById("cloud-passphrase") as HTMLInputElement;
  expect(pass.value).toBe(""); expect(phrase.value).toBe("");
  fireEvent.input(pass, { target: { value: "synthetic-password" } });
  fireEvent.input(phrase, { target: { value: " synthetic-phrase " } });
  fireEvent.submit(document.getElementById("cloud-form")!);
  await waitFor(() => expect(query.getByText(/配置已保存在本机/)).toBeTruthy());
  const saved = calls.find((c) => c.name === "cloud_backup_save_config")!;
  expect(JSON.stringify(saved)).not.toContain("synthetic-password");
  expect(JSON.stringify(saved)).not.toContain("synthetic-phrase");
  expect(calls.filter((c) => c.name === "set_cloud_backup_credential")).toHaveLength(2);
  expect(calls.find((c) => c.args?.kind === "backupPassphrase")?.args?.value).toBe(" synthetic-phrase ");
  expect(pass.value).toBe(""); expect(phrase.value).toBe("");
});
test("plaintext opt-out requires explicit confirmation and cancellation does not save", async () => {
  const { refresh, calls } = setup(); await refresh();
  const encrypted = document.getElementById("cloud-encrypted") as HTMLInputElement;
  encrypted.checked = false; fireEvent.input(encrypted);
  fireEvent.submit(document.getElementById("cloud-form")!);
  await waitFor(() => expect(dialog()).toBeTruthy());
  expect(calls.some((c) => c.name === "cloud_backup_save_config")).toBe(false);
  fireEvent.click(within(dialog()!).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(dialog()).toBeNull());
  expect(calls.some((c) => c.name === "cloud_backup_save_config")).toBe(false);
});
test("new machine discovers IDs and shows no counts before a verified preview; confirmation sends only bound token", async () => {
  const { refresh, calls, onRestored, query } = setup(); await refresh(); click("cloud-browse");
  await waitFor(() => expect((query.getByRole("button", { name: "下载校验并预览" }) as HTMLButtonElement).disabled).toBe(false));
  expect(calls.find((c) => c.name === "cloud_backup_discover")?.args).not.toHaveProperty("deviceId");
  expect(query.queryByText("申请")).toBeNull();
  fireEvent.click(query.getByRole("button", { name: "下载校验并预览" }));
  await waitFor(() => expect(dialog()).toBeTruthy());
  expect(calls.some((c) => c.name === "cloud_backup_restore")).toBe(false);
  expect(within(dialog()!).getByText("申请")).toBeTruthy();
  fireEvent.click(within(dialog()!).getByRole("button", { name: "确认替换当前档案" }));
  await waitFor(() => expect(onRestored).toHaveBeenCalledOnce());
  expect(calls.find((c) => c.name === "cloud_backup_restore")?.args).toEqual({ token: "bound-token" });
  await waitFor(() => expect(calls.some((c) => c.name === "cloud_backup_clear_preview")).toBe(true));
});
test("cancelled confirmation releases verified plaintext and does not restore", async () => {
  const { refresh, calls, query } = setup(); await refresh(); click("cloud-browse");
  await waitFor(() => expect((query.getByRole("button", { name: "下载校验并预览" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(query.getByRole("button", { name: "下载校验并预览" }));
  await waitFor(() => expect(dialog()).toBeTruthy());
  fireEvent.click(within(dialog()!).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(calls.some((c) => c.name === "cloud_backup_clear_preview")).toBe(true));
  expect(calls.some((c) => c.name === "cloud_backup_restore")).toBe(false);
});
test("unsaved account edits prevent remote actions; error messages suggest a concrete next action", async () => {
  const { refresh, calls, query } = setup(); await refresh();
  fireEvent.input(document.getElementById("cloud-username")!, { target: { value: "different" } }); click("cloud-test");
  await waitFor(() => expect(query.getByText(/请先保存配置和凭据/)).toBeTruthy());
  expect(calls.some((c) => c.name === "cloud_backup_test")).toBe(false);
  expect(cloudError({ code: "CLOUD_CRYPT_InvalidCiphertext" })).toContain("加密口令");
  expect(cloudError({ code: "CLOUD_PREVIEW_EXPIRED" })).toContain("重新下载");
  expect(cloudError({ code: "CLOUD_DAV_Authentication" })).toContain("第三方应用密码");
});
test("a cleanup error after successful restore preserves the result and tells the user to check plaintext", async () => {
  const { refresh, query, onRestored } = setup({ cloud_backup_clear_preview: new Error("cleanup unavailable") });
  await refresh(); click("cloud-browse");
  await waitFor(() => expect((query.getByRole("button", { name: "下载校验并预览" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(query.getByRole("button", { name: "下载校验并预览" }));
  await waitFor(() => expect(dialog()).toBeTruthy());
  fireEvent.click(within(dialog()!).getByRole("button", { name: "确认替换当前档案" }));
  await waitFor(() => expect(query.getByText(/档案已恢复成功；临时明文清理未确认/)).toBeTruthy());
  expect(onRestored).toHaveBeenCalledOnce();
  expect(query.queryByText(/操作未完成.*当前档案/)).toBeNull();
});
test("one transient status failure does not leave controls permanently disabled", async () => {
  vi.useFakeTimers();
  try {
    let reads = 0;
    const { refresh } = setup({ cloud_backup_status: async () => {
      reads++;
      if (reads === 2) throw { code: "CLOUD_LOCAL_IO" };
      return { job: { phase: reads === 1 ? "uploading" : "succeeded", metadata, warnings: [], errorCode: null }, latestPackage: null, latestMetadata: null, retryPackage: null };
    } });
    await refresh();
    const start = document.getElementById("cloud-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(reads).toBe(2); expect(start.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(3); expect(start.disabled).toBe(false);
  } finally { vi.useRealTimers(); }
});
test("forced configuration reload clears uncommitted secrets before restoring the saved account", async () => {
  const { refresh, calls } = setup(); await refresh();
  fireEvent.input(document.getElementById("cloud-username")!, { target: { value: "other-account" } });
  fireEvent.input(document.getElementById("cloud-password")!, { target: { value: "other-password" } });
  fireEvent.input(document.getElementById("cloud-passphrase")!, { target: { value: "other-passphrase" } });
  await refresh(true);
  expect((document.getElementById("cloud-username") as HTMLInputElement).value).toBe("synthetic");
  expect((document.getElementById("cloud-password") as HTMLInputElement).value).toBe("");
  expect((document.getElementById("cloud-passphrase") as HTMLInputElement).value).toBe("");
  fireEvent.submit(document.getElementById("cloud-form")!);
  await waitFor(() => expect(calls.some((c) => c.name === "cloud_backup_save_config")).toBe(true));
  expect(calls.some((c) => c.name === "set_cloud_backup_credential")).toBe(false);
});
test("failed confirmation remains actionable after the user closes the dialog", async () => {
  const { refresh, query } = setup({ cloud_backup_restore: async () => { throw { code: "CLOUD_PREVIEW_EXPIRED" }; } });
  await refresh(); click("cloud-browse");
  await waitFor(() => expect((query.getByRole("button", { name: "下载校验并预览" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(query.getByRole("button", { name: "下载校验并预览" }));
  await waitFor(() => expect(dialog()).toBeTruthy());
  fireEvent.click(within(dialog()!).getByRole("button", { name: "确认替换当前档案" }));
  await waitFor(() => expect(within(dialog()!).getByRole("alert").textContent).toContain("重新下载"));
  fireEvent.click(within(dialog()!).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(dialog()).toBeNull());
  expect(query.getByText(/预览已过期.*重新下载/)).toBeTruthy();
  expect(query.queryByText(/已取消恢复/)).toBeNull();
});
