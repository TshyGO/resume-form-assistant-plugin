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
  expect(document.getElementById("cloud-password-state")!.textContent).toBe("已保存");
  expect(document.getElementById("cloud-passphrase-state")!.textContent).toBe("已保存");
  expect(document.getElementById("cloud-clear-password")!.hidden).toBe(false);
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
  expect(document.getElementById("cloud-message")!.textContent).toMatch(/预览已过期.*重新下载/);
  expect(query.getByRole("listitem").textContent).toMatch(/预览已过期.*重新下载/);
  expect(query.queryByText(/已取消恢复/)).toBeNull();
});

test("overview shows configuration, latest success and schedule before any settings are opened", async () => {
  const { refresh } = setup({
    cloud_backup_status: { job: { phase: "succeeded", metadata, warnings: [], errorCode: null }, latestPackage: "/local/backup.rpbak", latestMetadata: metadata, retryPackage: null },
    cloud_backup_schedule_status: { enabled: true, requiresConfirmation: false, recentSize: 1024, estimatedCycleBytes: null,
      state: { plan: { minute: 1260, everyDays: 1, utcOffsetMinutes: 480, budgetBytes: 1_000_000_000, pauseAtBudget: true }, nextAt: 1700000000, paused: null, message: null, retryAt: null, retries: 0, cycleStartedAt: null, uploadBytes: 0, budgetWarning: false } },
  });
  await refresh();
  const state = document.getElementById("cloud-state")!;
  expect(state.textContent).toBe("已配置"); expect(state.dataset.tone).toBe("ok");
  expect(document.getElementById("cloud-fact-connection")!.textContent).toBe("synthetic · Test · 加密");
  expect(document.getElementById("cloud-latest")!.textContent).toContain("0.00 MB");
  expect(document.getElementById("cloud-progress")!.textContent).toBe("");
  expect(document.getElementById("cloud-auto-summary")!.textContent).toMatch(/^每天 21:00（UTC\+08:00） · 下次 /);
  expect(document.getElementById("cloud-auto-hint")!.textContent).toBe("每天 21:00（UTC+08:00）");
  expect(document.getElementById("cloud-connection-hint")!.textContent).toBe("已保存 · Test · 加密");
  expect(document.getElementById("cloud-keep")!.closest(".settings-field")!.hasAttribute("hidden")).toBe(true);
  expect(document.getElementById("cloud-local-copy")!.textContent).toContain("/local/backup.rpbak");
  expect(document.getElementById("cloud-auto-disable")!.hidden).toBe(false);
  for (const id of ["cloud-connection", "cloud-auto"]) expect((document.getElementById(id) as HTMLDetailsElement).open).toBe(false);
  fireEvent.input(document.getElementById("cloud-root")!, { target: { value: "Other" } });
  expect(state.textContent).toBe("有未保存的修改");
  expect(document.getElementById("cloud-connection-hint")!.textContent).toBe("有未保存的修改");
});

test("an unconfigured card opens connection settings and keeps whole-card actions unavailable", async () => {
  const { refresh, calls } = setup({ cloud_backup_config: async () => null });
  await refresh();
  expect(document.getElementById("cloud-state")!.textContent).toBe("未配置");
  expect((document.getElementById("cloud-connection") as HTMLDetailsElement).open).toBe(true);
  expect((document.getElementById("cloud-start") as HTMLButtonElement).disabled).toBe(true);
  expect((document.getElementById("cloud-browse") as HTMLButtonElement).disabled).toBe(true);
  expect(document.getElementById("cloud-clear-password")!.hidden).toBe(true);
  expect((document.getElementById("cloud-password") as HTMLInputElement).placeholder).not.toContain("已保存");
  expect(document.getElementById("cloud-auto-disable")!.hidden).toBe(true);
  expect(calls.some((c) => c.name === "cloud_backup_credential_status")).toBe(false);
});

const missingFolder = (rootResult: unknown) => async (args?: Record<string, unknown>) => {
  const root = (args?.options as { root?: string[] }).root ?? [];
  if (root.length) throw { code: "CLOUD_DAV_NotFound" };
  if (rootResult) throw rootResult;
  return null;
};
test("a missing remote folder is a hint only after the WebDAV root itself is readable, and nothing is created", async () => {
  const { refresh, calls } = setup({ cloud_backup_test: missingFolder(null) });
  await refresh(); click("cloud-test");
  const message = document.getElementById("cloud-message")!;
  await waitFor(() => expect(message.textContent).toBe("账号验证通过。目录 Test 还不存在，第一次备份时会自动创建。"));
  expect(message.dataset.tone).toBe("info");
  expect(calls.filter((c) => c.name === "cloud_backup_test").map((c) => (c.args!.options as { root: string[] }).root)).toEqual([["Test"], []]);
  expect(calls.filter((c) => c.name.startsWith("cloud_backup_") && !["cloud_backup_config", "cloud_backup_status", "cloud_backup_schedule_status", "cloud_backup_credential_status", "cloud_backup_test"].includes(c.name))).toEqual([]);
  expect(cloudError({ code: "CLOUD_DAV_NotFound" })).toContain("远端目录或文件不存在");
});

test("connection test at the WebDAV root keeps NotFound as an error", async () => {
  const { refresh } = setup({ cloud_backup_config: { ...config, options: { ...config.options, root: [] } }, cloud_backup_test: async () => { throw { code: "CLOUD_DAV_NotFound" }; } });
  await refresh(); click("cloud-test");
  const message = document.getElementById("cloud-message")!;
  await waitFor(() => expect(message.dataset.tone).toBe("error"));
  expect(message.textContent).toContain("远端目录或文件不存在");
});

test("download preview shows progress, size and cancel in the clicked row, and a failure stays next to it", async () => {
  let fail: (error: unknown) => void = () => {};
  const { refresh, calls, query } = setup({ cloud_backup_preview: () => new Promise((_, reject) => { fail = reject; }) });
  await refresh(); click("cloud-browse");
  await waitFor(() => expect((query.getByRole("button", { name: "下载校验并预览" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(query.getByRole("button", { name: "下载校验并预览" }));
  const row = query.getByRole("listitem");
  await waitFor(() => expect(within(row).getByRole("button", { name: "正在下载并校验…" }).getAttribute("aria-busy")).toBe("true"));
  expect(row.textContent).toContain("0.00 MB");
  expect(row.textContent).toContain("可能需要几分钟");
  expect(document.getElementById("cloud-cancel")!.hidden).toBe(true);
  fireEvent.click(within(row).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(calls.some((c) => c.name === "cloud_backup_cancel")).toBe(true));
  fail({ code: "CLOUD_CANCELLED" });
  await waitFor(() => expect(within(row).getByRole("button", { name: "下载校验并预览" })).toBeTruthy());
  expect(row.textContent).toContain("已取消下载，当前档案未替换。");
  expect(within(row).queryByRole("button", { name: "取消" })).toBeNull();
  expect(document.getElementById("cloud-message")!.dataset.tone).not.toBe("error");
  expect(calls.some((c) => c.name === "cloud_backup_clear_preview")).toBe(true);
});

test("first-time save asks for the app password and the backup passphrase next to their fields", async () => {
  const { refresh, calls } = setup({ cloud_backup_config: async () => null });
  await refresh();
  fireEvent.input(document.getElementById("cloud-username")!, { target: { value: "synthetic" } });
  const pass = document.getElementById("cloud-password") as HTMLInputElement;
  const phrase = document.getElementById("cloud-passphrase") as HTMLInputElement;
  fireEvent.submit(document.getElementById("cloud-form")!);
  expect(pass.validationMessage).toContain("第三方应用密码");
  fireEvent.input(pass, { target: { value: "synthetic-password" } });
  fireEvent.submit(document.getElementById("cloud-form")!);
  expect(phrase.validationMessage).toContain("备份加密口令");
  expect(calls.some((c) => c.name === "cloud_backup_save_config")).toBe(false);
  const encrypted = document.getElementById("cloud-encrypted") as HTMLInputElement;
  encrypted.checked = false; fireEvent.input(encrypted);
  expect(phrase.disabled).toBe(true); expect(phrase.validationMessage).toBe("");
  encrypted.checked = true; fireEvent.input(encrypted);
  expect(phrase.disabled).toBe(false);
  fireEvent.input(phrase, { target: { value: "synthetic-phrase" } });
  fireEvent.submit(document.getElementById("cloud-form")!);
  await waitFor(() => expect(calls.filter((c) => c.name === "set_cloud_backup_credential")).toHaveLength(2));
});

test("changing the account does not reuse the old account's saved secrets", async () => {
  const { refresh, calls } = setup(); await refresh();
  fireEvent.input(document.getElementById("cloud-username")!, { target: { value: "other-account" } });
  fireEvent.submit(document.getElementById("cloud-form")!);
  expect((document.getElementById("cloud-password") as HTMLInputElement).validationMessage).toContain("第三方应用密码");
  expect(calls.some((c) => c.name === "cloud_backup_save_config")).toBe(false);
});

test("found backups can be collapsed, but not while a download is in progress", async () => {
  let finish: (value: unknown) => void = () => {};
  const { refresh, query } = setup({ cloud_backup_preview: () => new Promise((_, reject) => { finish = reject; }) });
  await refresh(); click("cloud-browse");
  await waitFor(() => expect((query.getByRole("button", { name: "下载校验并预览" }) as HTMLButtonElement).disabled).toBe(false));
  const close = document.getElementById("cloud-found-close") as HTMLButtonElement;
  fireEvent.click(query.getByRole("button", { name: "下载校验并预览" }));
  await waitFor(() => expect(close.disabled).toBe(true));
  finish({ code: "CLOUD_CANCELLED" });
  await waitFor(() => expect(close.disabled).toBe(false));
  click("cloud-found-close");
  expect(document.getElementById("cloud-found")!.hidden).toBe(true);
  expect(document.getElementById("cloud-list")!.children).toHaveLength(0);
});

test("a missing folder under a wrong address or bad credentials is reported as that error, not as verified", async () => {
  const wrongAddress = setup({ cloud_backup_test: missingFolder({ code: "CLOUD_DAV_NotFound" }) });
  await wrongAddress.refresh(); click("cloud-test");
  const message = document.getElementById("cloud-message")!;
  await waitFor(() => expect(message.dataset.tone).toBe("error"));
  expect(message.textContent).toContain("找不到 WebDAV 地址");
  expect(message.textContent).not.toContain("账号验证通过");
});
test("bad credentials found by the root check keep the authentication error", async () => {
  const { refresh } = setup({ cloud_backup_test: missingFolder({ code: "CLOUD_DAV_Authentication" }) });
  await refresh(); click("cloud-test");
  const message = document.getElementById("cloud-message")!;
  await waitFor(() => expect(message.dataset.tone).toBe("error"));
  expect(message.textContent).toContain("认证失败");
});

test("editing the account shows the old account's secrets as not saved and hides removal", async () => {
  const { refresh } = setup(); await refresh();
  expect(document.getElementById("cloud-password-state")!.textContent).toBe("已保存");
  fireEvent.input(document.getElementById("cloud-username")!, { target: { value: "other-account" } });
  expect(document.getElementById("cloud-password-state")!.textContent).toBe("新账号未保存");
  expect(document.getElementById("cloud-passphrase-state")!.textContent).toBe("新账号未保存");
  expect(document.getElementById("cloud-clear-password")!.hidden).toBe(true);
  expect((document.getElementById("cloud-password") as HTMLInputElement).placeholder).not.toContain("已保存");
  fireEvent.input(document.getElementById("cloud-username")!, { target: { value: "synthetic" } });
  expect(document.getElementById("cloud-password-state")!.textContent).toBe("已保存");
});

test("long backup lists show the newest ten first and reveal more in batches", async () => {
  const many = Array.from({ length: 23 }, (_, i) => ({ ...metadata, backupId: `b${i}`, createdAt: new Date(Date.UTC(2026, 9, 19) - i * 86_400_000).toISOString() }));
  const { refresh, query } = setup({ cloud_backup_list: { entries: many, cleanupSafe: false, contentHashVerified: false } });
  await refresh(); click("cloud-browse");
  const more = document.getElementById("cloud-list-more") as HTMLButtonElement;
  await waitFor(() => expect(query.getAllByRole("listitem")).toHaveLength(10));
  await waitFor(() => expect(more.disabled).toBe(false));
  expect(document.getElementById("cloud-progress")!.textContent).toBe("找到 23 份备份，先显示最新 10 份。");
  expect(more.hidden).toBe(false); expect(more.textContent).toBe("再显示 10 份（还有 13 份）");
  fireEvent.click(more);
  expect(query.getAllByRole("listitem")).toHaveLength(20);
  expect(more.textContent).toBe("再显示 3 份（还有 3 份）");
  fireEvent.click(more);
  expect(query.getAllByRole("listitem")).toHaveLength(23);
  expect(more.hidden).toBe(true);
  // 后面批次的行仍指向正确的备份。
  const last = query.getAllByRole("listitem")[22];
  expect(within(last).getByRole("button", { name: "下载校验并预览" }).dataset.index).toBe("22");
});

test("collapsing found backups restores the job status line instead of leaving it blank", async () => {
  const failed = { job: { phase: "failed", metadata, warnings: [], errorCode: "CLOUD_DAV_Network" }, latestPackage: null, latestMetadata: null, retryPackage: null };
  const { refresh, calls } = setup({ cloud_backup_status: failed });
  await refresh();
  const progress = document.getElementById("cloud-progress")!;
  expect(progress.textContent).toContain("上次备份失败");
  click("cloud-browse");
  await waitFor(() => expect(progress.textContent).toContain("找到 1 份备份"));
  await waitFor(() => expect((document.getElementById("cloud-found-close") as HTMLButtonElement).disabled).toBe(false));
  const reads = calls.filter((c) => c.name === "cloud_backup_status").length;
  click("cloud-found-close");
  expect(document.getElementById("cloud-found")!.hidden).toBe(true);
  await waitFor(() => expect(progress.textContent).toContain("上次备份失败"));
  expect(calls.filter((c) => c.name === "cloud_backup_status").length).toBe(reads + 1);
});

test("the hidden retention value is kept when saving", async () => {
  const { refresh, calls } = setup({ cloud_backup_config: { ...config, options: { ...config.options, keepLast: 10 } } });
  await refresh();
  fireEvent.submit(document.getElementById("cloud-form")!);
  await waitFor(() => expect(calls.some((c) => c.name === "cloud_backup_save_config")).toBe(true));
  expect((calls.find((c) => c.name === "cloud_backup_save_config")!.args!.config as { options: { keepLast: number } }).options.keepLast).toBe(10);
});
