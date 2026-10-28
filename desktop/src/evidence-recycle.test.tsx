import { beforeEach, test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, within, waitFor } from "@testing-library/dom";
import { mountInbox } from "./inbox-ui.ts";
import { mountMailboxes } from "./mailbox-ui.ts";
import type { Invoke, EvidencePreview } from "./api.ts";
beforeEach(() => { document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0]; });
function fixture(id = "one"): EvidencePreview { return { id, applicationId: null, kind: "paste", mime: "text/plain", sizeBytes: 10, originalFilename: null,
  importedAt: "2026-10-28T00:00:00Z", subject: `功能验证通知 ${id}`, fromAddr: null, sentAt: null, replyClass: null, sendMode: null,
  sameBytesAs: [], bodyExtract: "原正文始终保留", imageDataUrl: null, note: null, recycled: false }; }
function setup() {
  const row = fixture(); const rows = [row];
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {};
  const invoke = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (handlers[name]) return handlers[name](args);
    if (name === "list_inbox_cmd") return rows.filter(r => !r.recycled && !r.applicationId).map(r => ({...r}));
    if (name === "list_recycled_evidence_cmd") return rows.filter(r => r.recycled).map(r => ({...r}));
    if (name === "get_evidence_preview_cmd") return {...rows.find(r => r.id === args?.evidenceId)!};
    if (name === "list_applications_cmd") return { items: [] };
    if (name === "mailbox_view") return { accounts: [], candidates: [], pendingCount: 0 };
    if (name === "set_evidence_recycled_cmd") { const target = rows.find(r => r.id === args?.evidenceId)!; target.recycled = Boolean(args?.recycled); return {...target}; }
    if (name === "import_evidence_cmd") { const fresh = fixture("imported"); rows.push(fresh); return { imported:[fresh],duplicates:[],failed:[] }; }
    throw new Error(`unexpected ${name}`);
  });
  const mountAi = vi.fn(() => ({unmount:vi.fn()}));
  const inbox = mountInbox(invoke as Invoke, {mountAi});
  const mailboxes = mountMailboxes(invoke as Invoke, inbox.refresh, () => {}, inbox);
  const preview = within(document.getElementById("inbox-preview")!);
  return { row, rows, inbox, mailboxes, invoke, handlers, preview, mountAi };
}
const el = (id: string) => document.getElementById(id)!;
test("move and restore are direct, lock duplicate clicks, retain body and have a dedicated recycle tab", async () => {
  const h = setup(); await h.inbox.refresh();
  fireEvent.click(within(el("inbox-list")).getByRole("button", {name:/功能验证通知/}));
  fireEvent.click(await h.preview.findByRole("button", {name:"移到回收站"}));
  await waitFor(() => expect(h.row.recycled).toBe(true));
  await waitFor(() => expect(within(el("inbox-list")).queryByRole("button", {name:/功能验证通知/})).toBeNull());
  fireEvent.click(el("mailbox-tab-recycled"));
  const item = await within(el("inbox-recycled-list")).findByRole("button", {name:/功能验证通知/}); fireEvent.click(item);
  const restore = await h.preview.findByRole("button", {name:"恢复通知"});
  expect(h.preview.getByText("原正文始终保留")).toBeTruthy();
  expect(h.preview.queryByRole("button", {name:"整理与关联"})).toBeNull();
  const aiCalls = h.mountAi.mock.calls.length;
  fireEvent.click(restore); fireEvent.click(restore);
  await waitFor(() => expect(h.row.recycled).toBe(false));
  expect(h.invoke.mock.calls.filter(([name,args]) => name === "set_evidence_recycled_cmd" && args?.recycled === false)).toHaveLength(1);
  expect(h.mountAi.mock.calls.length).toBe(aiCalls);
  fireEvent.click(el("mailbox-tab-stored"));
  await within(el("inbox-list")).findByRole("button", {name:/功能验证通知/});
});
test("failed recycle preserves the notification and provides a retryable error", async () => {
  const h = setup(); await h.inbox.refresh();
  h.handlers.set_evidence_recycled_cmd = () => { throw {message:"磁盘暂时不可写"}; };
  fireEvent.click(within(el("inbox-list")).getByRole("button", {name:/功能验证通知/}));
  const button = await h.preview.findByRole("button", {name:"移到回收站"}); fireEvent.click(button);
  await waitFor(() => expect(el("inbox-status").textContent).toContain("磁盘暂时不可写"));
  expect(h.row.recycled).toBe(false); expect(button.hasAttribute("disabled")).toBe(false);
  expect(within(el("inbox-list")).getByRole("button", {name:/功能验证通知/})).toBeTruthy();
});
test("late active-list responses cannot overwrite the recycle list or its selected preview", async () => {
  const h = setup(); await h.inbox.refresh(); const old = {...h.row};
  let release!: (data: unknown) => void;
  h.handlers.list_inbox_cmd = () => new Promise(resolve => {release = resolve;});
  const oldRefresh = h.inbox.refresh(); h.row.recycled = true;
  fireEvent.click(el("mailbox-tab-recycled"));
  const item = await within(el("inbox-recycled-list")).findByRole("button", {name:/功能验证通知/}); fireEvent.click(item);
  await h.preview.findByRole("button", {name:"恢复通知"});
  release([old]); await oldRefresh;
  expect(h.preview.getByRole("button", {name:"恢复通知"})).toBeTruthy();
  expect(el("mailbox-tab-recycled").getAttribute("aria-selected")).toBe("true");
});
test("importing from the recycle view returns to the active list and reveals the imported notification", async () => {
  const h = setup(); h.row.recycled = true; await h.inbox.refresh();
  fireEvent.click(el("mailbox-tab-recycled")); await within(el("inbox-recycled-list")).findByRole("button", {name:/功能验证通知/});
  await h.inbox.importPaths(["synthetic.txt"]);
  expect(el("mailbox-tab-stored").getAttribute("aria-selected")).toBe("true");
  expect(h.preview.getByRole("heading", {name:"功能验证通知 imported"})).toBeTruthy();
  expect(h.row.recycled).toBe(true);
});
test("the three status tabs preserve accessible keyboard navigation", async () => {
  const h = setup(); await h.inbox.refresh();
  fireEvent.keyDown(el("mailbox-tab-stored"), {key:"End"});
  expect(el("mailbox-tab-recycled").getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(el("mailbox-tab-recycled"));
  fireEvent.keyDown(el("mailbox-tab-recycled"), {key:"ArrowRight"});
  expect(el("mailbox-tab-pending").getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(el("mailbox-tab-pending"));
});
test("a failed recycle-list read reports failure instead of claiming the bin is empty, and retries locally", async () => {
  const h = setup(); h.row.recycled = true;
  h.handlers.list_recycled_evidence_cmd = () => { throw {message:"暂时读不到档案"}; };
  fireEvent.click(el("mailbox-tab-recycled"));
  const retry = await within(el("inbox-recycled-list")).findByRole("button", {name:"重新读取"});
  expect(h.preview.queryByText("回收站为空")).toBeNull();
  expect(h.preview.getByText("暂时无法读取通知")).toBeTruthy();
  delete h.handlers.list_recycled_evidence_cmd;
  fireEvent.click(retry);
  await within(el("inbox-recycled-list")).findByRole("button", {name:/功能验证通知/});
  expect(h.preview.queryByText("暂时无法读取通知")).toBeNull();
  expect(h.invoke.mock.calls.some(([name]) => name.startsWith("mailbox_check"))).toBe(false);
});
