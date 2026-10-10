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

test("direct browser navigation and category switching preserve unsaved fields and page feedback", () => {
  const { query, nav, root } = setup();
  nav.select("browser");
  const id = query.getByLabelText("Chrome 扩展 ID") as HTMLInputElement;
  id.value = "unsaved-extension-id";
  fireEvent.click(query.getByRole("tab", { name: "数据与备份" }));
  const status = root.querySelector<HTMLElement>("#backup-status")!;
  status.hidden = false;
  status.textContent = "已选择备份 example.zip，等待确认。";
  nav.select("browser"); expect(id.value).toBe("unsaved-extension-id");
  nav.select("data"); expect(status.hidden).toBe(false);
  expect(query.getByText("已选择备份 example.zip，等待确认。")).toBeTruthy();
  nav.select("unknown"); expect(query.getByRole("tabpanel").id).toBe("settings-data");
});

test("every category starts with a card, so their first cards line up", () => {
  const { root } = setup();
  for (const panel of root.querySelectorAll<HTMLElement>("[data-settings-panel]")) {
    const first = panel.firstElementChild!;
    // AI 与隐私由 React 挂进容器，容器本身不占位（display: contents）。
    expect(first.classList.contains("settings-card") || ["ai-settings", "desktop-feedback"].includes(first.id)).toBe(true);
  }
});

const counts = { applications: 1, events: 2, todos: 0, evidence: 0, snapshots: 0, attachments: 0 };
const preview = {
  current: counts,
  incoming: { ...counts, applications: 3, attachments: 4 },
  sameArchive: false,
  createdAt: "2026-09-22T02:00:00Z",
  existingRollbackPoints: 0,
  tooManyRollbackPoints: false,
};

function dialog() {
  return document.querySelector<HTMLDialogElement>("dialog.settings-dialog");
}

test("restore preview is one dialog with six counts; refreshing the category keeps it; only its confirm dispatches", async () => {
  const root = document.getElementById("view-settings")!;
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ name, args });
    if (name === "preview_restore_cmd") return preview as T;
    if (name === "restore_archive_cmd") return { counts, rollbackPoint: "rollback-example", remindersCleared: 2 } as T;
    return [] as T;
  };
  const show = mountBackup(invoke, { open: async () => "/tmp/备份/example-backup.zip", save: null });
  const nav = mountSettingsNavigation(root, (name) => { if (name === "data") void show(); });
  nav.select("data");
  fireEvent.click(document.getElementById("backup-choose-restore")!);
  await waitFor(() => expect(dialog()).toBeTruthy());
  const box = within(dialog()!);
  expect(box.getByText("example-backup.zip")).toBeTruthy();
  expect(box.getByText(/来自另一个档案/)).toBeTruthy();
  const rows = Array.from(dialog()!.querySelectorAll("tbody tr"), (tr) => Array.from(tr.children, (cell) => cell.textContent));
  expect(rows.map((row) => row[0])).toEqual(["申请", "事件", "待办", "回复证据", "简历快照", "附件"]);
  expect(rows[0].slice(1)).toEqual(["1", "3"]);
  expect(box.getByText(/整个换成/)).toBeTruthy();
  expect(document.getElementById("backup-status")!.textContent).toContain("等待确认");
  nav.select("general"); nav.select("data");
  await waitFor(() => expect(calls.filter((call) => call.name === "list_recycled_cmd")).toHaveLength(2));
  expect(dialog()).toBeTruthy();
  expect(calls.some((call) => call.name === "restore_archive_cmd")).toBe(false);
  fireEvent.click(box.getByRole("button", { name: "恢复并替换当前档案" }));
  await waitFor(() => expect(dialog()).toBeNull());
  expect(calls.filter((call) => call.name === "restore_archive_cmd")).toEqual([
    { name: "restore_archive_cmd", args: { package: "/tmp/备份/example-backup.zip" } },
  ]);
  const status = document.getElementById("backup-status")!;
  expect(status.dataset.tone).toBe("success");
  expect(status.textContent).toMatch(/已恢复.*2 条待办的提醒需要重新登记/);
});

test("cancelling the restore preview writes nothing and says so", async () => {
  const calls: string[] = [];
  const invoke: Invoke = async <T,>(name: string): Promise<T> => {
    calls.push(name);
    return (name === "preview_restore_cmd" ? preview : []) as T;
  };
  mountBackup(invoke, { open: async () => "example.zip", save: null });
  const trigger = document.getElementById("backup-choose-restore")!;
  trigger.focus();
  fireEvent.click(trigger);
  await waitFor(() => expect(dialog()).toBeTruthy());
  fireEvent.keyDown(dialog()!, { key: "Escape" });
  await waitFor(() => expect(dialog()).toBeNull());
  expect(calls).not.toContain("restore_archive_cmd");
  expect(document.getElementById("backup-status")!.textContent).toContain("已取消恢复");
  expect(document.activeElement).toBe(trigger);
});

test("restore and rollback tell the host the archive was replaced; a failed restore keeps the dialog and does not", async () => {
  let failRestore = true;
  const invoke: Invoke = async <T,>(name: string): Promise<T> => {
    if (name === "preview_restore_cmd") return preview as T;
    if (name === "restore_archive_cmd") {
      if (failRestore) throw { code: "IO", message: "磁盘满了" };
      return { counts, rollbackPoint: "rollback-example", remindersCleared: 0 } as T;
    }
    if (name === "rollback_to_cmd") return { counts, rollbackPoint: "rollback-2", remindersCleared: 0 } as T;
    if (name === "list_rollback_points_cmd") return [{ id: "2026-09-21T08-30-00Z-abc", retiredAt: "2026-09-21" }] as T;
    return [] as T;
  };
  const onRestored = vi.fn();
  const show = mountBackup(invoke, { open: async () => "example-backup.zip", save: null }, undefined, onRestored);
  await show();
  expect(document.getElementById("backup-rollback-count")!.textContent).toBe("（1 个）");
  const status = document.getElementById("backup-status")!;
  fireEvent.click(document.getElementById("backup-choose-restore")!);
  await waitFor(() => expect(dialog()).toBeTruthy());
  const confirm = within(dialog()!).getByRole("button", { name: "恢复并替换当前档案" });
  fireEvent.click(confirm);
  await waitFor(() => expect(within(dialog()!).getByRole("alert").textContent).toContain("磁盘满了"));
  expect(status.textContent).toContain("恢复失败");
  expect(onRestored).not.toHaveBeenCalled();

  // 弹窗还在：同一份预览可以直接重试，不用重新选文件。
  failRestore = false;
  fireEvent.click(confirm);
  await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(dialog()).toBeNull());

  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.click(document.querySelector<HTMLElement>("button[data-rollback]")!);
  await waitFor(() => expect(dialog()).toBeTruthy());
  expect(within(dialog()!).getByText("2026-09-21T08-30-00Z-abc")).toBeTruthy();
  expect(onRestored).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog()!).getByRole("button", { name: "换回这一份" }));
  await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(2));
  expect(document.getElementById("rollback-status")!.textContent).toContain("rollback-2");
});

test("permanent delete lists what goes with it and needs the dialog's red confirm", async () => {
  const calls: string[] = [];
  let recycled = [{ id: "a1", company: "星河", title: "工程师" }];
  const invoke: Invoke = async <T,>(name: string): Promise<T> => {
    calls.push(name);
    if (name === "list_recycled_cmd") return recycled as T;
    if (name === "purge_preview_cmd") return { applicationId: "a1", company: "星河", title: "工程师", events: 3, todos: 1, evidence: 2, snapshots: 0 } as T;
    if (name === "purge_application_cmd") { recycled = []; return { attachmentFilesRemoved: 1, attachmentFilesLeft: [] } as T; }
    return [] as T;
  };
  const show = mountBackup(invoke, { open: null, save: null });
  await show();
  expect(document.getElementById("recycle-count")!.textContent).toBe("（1 条）");
  fireEvent.click(document.querySelector<HTMLElement>("button[data-purge='a1']")!);
  await waitFor(() => expect(dialog()).toBeTruthy());
  const box = within(dialog()!);
  expect(box.getByText("星河 · 工程师")).toBeTruthy();
  expect(box.getByText("3 条")).toBeTruthy();
  expect(box.getByText(/不可撤销/)).toBeTruthy();
  expect(dialog()!.classList.contains("tone-danger")).toBe(true);
  fireEvent.click(box.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(dialog()).toBeNull());
  expect(calls).not.toContain("purge_application_cmd");
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.click(document.querySelector<HTMLElement>("button[data-purge='a1']")!);
  await waitFor(() => expect(dialog()).toBeTruthy());
  fireEvent.click(within(dialog()!).getByRole("button", { name: "永久删除" }));
  await waitFor(() => expect(document.getElementById("recycle-status")!.textContent).toContain("已永久删除「星河 · 工程师」"));
  expect(document.getElementById("recycle-list")!.textContent).toContain("回收站是空的");
});

test("unreferenced attachments are deleted one by one after a dialog; dangling references offer no delete", async () => {
  let report = { totalBlobs: 3, totalEvidence: 1, zeroRefBlobs: ["a".repeat(64), "b".repeat(64)], danglingEvidence: [] as string[], invalidFiles: [] };
  const removed: unknown[] = [];
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    if (name === "orphan_report_cmd") return report as T;
    if (name === "remove_orphan_cmd") { removed.push(args?.sha256); return undefined as T; }
    return [] as T;
  };
  mountBackup(invoke, { open: null, save: null });
  fireEvent.click(document.getElementById("orphan-check")!);
  await waitFor(() => expect(document.querySelectorAll("button[data-orphan]")).toHaveLength(2));
  fireEvent.click(document.querySelector<HTMLElement>(`button[data-orphan='${"a".repeat(64)}']`)!);
  await waitFor(() => expect(dialog()).toBeTruthy());
  expect(within(dialog()!).getByText("a".repeat(64))).toBeTruthy();
  fireEvent.click(within(dialog()!).getByRole("button", { name: "删除这份附件" }));
  await waitFor(() => expect(document.querySelectorAll("button[data-orphan]")).toHaveLength(1));
  expect(removed).toEqual(["a".repeat(64)]);
  expect(document.getElementById("orphan-report")!.textContent).toContain("还剩 1 份");

  report = { ...report, danglingEvidence: ["e1"] };
  fireEvent.click(document.getElementById("orphan-check")!);
  await waitFor(() => expect(document.getElementById("orphan-report")!.textContent).toContain("指向不存在的附件记录"));
  expect(document.querySelectorAll("button[data-orphan]")).toHaveLength(0);
});
