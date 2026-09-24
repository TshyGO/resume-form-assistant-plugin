import { beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, within, waitFor } from "@testing-library/dom";
import { mountSettingsNavigation } from "./settings-navigation";
import { mountBackup } from "./backup-ui";
import type { Invoke } from "./api";

beforeEach(() => {
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
});

function setup() {
  const root = document.getElementById("view-settings")!;
  root.classList.remove("hidden");
  const onSelect = vi.fn();
  return { root, query: within(root), onSelect, nav: mountSettingsNavigation(root, onSelect) };
}

test("general is the default, diagnostics remain folded and each settings control appears once", () => {
  const { query, root, onSelect } = setup();
  expect(query.getByRole("tabpanel").id).toBe("settings-general");
  expect(query.getByRole("checkbox", { name: "自动检查更新" })).toBeTruthy();
  expect(root.querySelector<HTMLDetailsElement>(".technical-details")!.open).toBe(false);
  expect(root.querySelector("#facts")!.closest("[data-settings-panel]")!.id).toBe("settings-about");
  const ids = Array.from(root.querySelectorAll("[id]"), (node) => node.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(onSelect).not.toHaveBeenCalled();
});

test("keyboard changes category with one focus stop and a single visible panel", () => {
  const { query, onSelect } = setup();
  const general = query.getByRole("tab", { name: "通用" });
  fireEvent.keyDown(general, { key: "ArrowDown" });
  expect(query.getByRole("tabpanel").id).toBe("settings-browser");
  expect(document.activeElement).toBe(query.getByRole("tab", { name: "浏览器连接" }));
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(query.getByRole("tabpanel").id).toBe("settings-about");
  expect(query.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
  expect(onSelect.mock.calls).toEqual([["browser"], ["about"]]);
});

test("direct browser navigation and category switching preserve unsaved fields and restore preview", () => {
  const { query, nav, root } = setup();
  nav.select("browser");
  const id = query.getByLabelText("Chrome 扩展 ID") as HTMLInputElement;
  id.value = "unsaved-extension-id";
  fireEvent.click(query.getByRole("tab", { name: "数据与备份" }));
  const preview = root.querySelector<HTMLElement>("#backup-preview")!;
  preview.hidden = false;
  root.querySelector("#backup-preview-text")!.textContent = "等待确认的恢复预览";
  nav.select("browser"); expect(id.value).toBe("unsaved-extension-id");
  nav.select("data"); expect(preview.hidden).toBe(false);
  expect(query.getByText("等待确认的恢复预览")).toBeTruthy();
  nav.select("unknown"); expect(query.getByRole("tabpanel").id).toBe("settings-data");
});

test("backup category refresh retains the real pending restore, and only confirmation dispatches it", async () => {
  const root = document.getElementById("view-settings")!;
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const counts = { applications: 1, events: 2, todos: 0, evidence: 0, snapshots: 0, attachments: 0 };
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ name, args });
    if (name === "preview_restore_cmd") return { current: counts, incoming: counts, sameArchive: true, createdAt: "2026-09-22" } as T;
    if (name === "restore_archive_cmd") return { counts, rollbackPoint: "rollback-example", remindersCleared: 0 } as T;
    return [] as T;
  };
  const show = mountBackup(invoke, { open: async () => "example-backup.zip", save: null });
  const nav = mountSettingsNavigation(root, (name) => { if (name === "data") void show(true); });
  nav.select("data");
  fireEvent.click(document.getElementById("backup-choose-restore")!);
  const preview = document.getElementById("backup-preview")!;
  await waitFor(() => expect(preview.hidden).toBe(false));
  nav.select("general"); nav.select("data");
  await waitFor(() => expect(calls.filter((call) => call.name === "list_recycled_cmd")).toHaveLength(2));
  expect(preview.hidden).toBe(false);
  expect(calls.some((call) => call.name === "restore_archive_cmd")).toBe(false);
  fireEvent.click(document.getElementById("backup-confirm-restore")!);
  await waitFor(() => expect(calls.filter((call) => call.name === "restore_archive_cmd")).toEqual([
    { name: "restore_archive_cmd", args: { package: "example-backup.zip" } },
  ]));
});

test("restore and rollback tell the host the archive was replaced; a failed restore does not", async () => {
  const counts = { applications: 1, events: 2, todos: 0, evidence: 0, snapshots: 0, attachments: 0 };
  let failRestore = true;
  const invoke: Invoke = async <T,>(name: string): Promise<T> => {
    if (name === "preview_restore_cmd") return { current: counts, incoming: counts, sameArchive: true, createdAt: "2026-09-22" } as T;
    if (name === "restore_archive_cmd") {
      if (failRestore) throw { code: "IO", message: "磁盘满了" };
      return { counts, rollbackPoint: "rollback-example", remindersCleared: 0 } as T;
    }
    if (name === "rollback_to_cmd") return { counts, rollbackPoint: "rollback-2" } as T;
    if (name === "list_rollback_points_cmd") return [{ id: "rp-1", retiredAt: "2026-09-21" }] as T;
    return [] as T;
  };
  const onRestored = vi.fn();
  const show = mountBackup(invoke, { open: async () => "example-backup.zip", save: null }, undefined, onRestored);
  await show();
  const status = document.getElementById("backup-status")!;
  const restoreOnce = async () => {
    fireEvent.click(document.getElementById("backup-choose-restore")!);
    await waitFor(() => expect(document.getElementById("backup-preview")!.hidden).toBe(false));
    fireEvent.click(document.getElementById("backup-confirm-restore")!);
  };

  await restoreOnce();
  await waitFor(() => expect(status.textContent).toContain("恢复失败"));
  expect(onRestored).not.toHaveBeenCalled();

  failRestore = false;
  await restoreOnce();
  await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));

  // 等恢复那一轮（含刷新换回列表）走完，按钮才可点，也才是新画出来的那个。
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.click(document.querySelector<HTMLElement>("button[data-rollback='rp-1']")!);
  await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(2));
});
