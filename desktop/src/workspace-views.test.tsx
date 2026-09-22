import { beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, within, waitFor } from "@testing-library/dom";
import { mountTodos } from "./todos-ui";
import { mountInbox } from "./inbox-ui";
import type { Invoke } from "./api";

beforeEach(() => {
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});

const apps = [{ id: "a1", company: "星河", title: "工程师" }, { id: "a2", company: "远山", title: "设计师" }];
const task = { id: "t1", applicationId: "a2", title: "准备面试", company: "远山", position: "设计师", status: "open", duePrecision: "date", dueDate: "2026-09-25", reminderState: "unsupported" };
function todos(failSave = false) {
  const root = document.getElementById("view-todos")!;
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ name, args });
    if (name === "list_applications_cmd") return { items: apps } as T;
    if (name === "list_todos_cmd") return [task] as T;
    if (name === "reminder_capability_cmd") return { available: false, reason: "系统通知不可用。" } as T;
    if (name === "overdue_digest_cmd") return { todos: [], more: 0 } as T;
    if (failSave && name === "create_todo_cmd") throw new Error("模拟保存失败");
    return {} as T;
  };
  return { root, calls, query: within(root), show: mountTodos(invoke), dialog: document.getElementById("todo-dialog") as HTMLDialogElement };
}

test("new todo is a dialog; cancel and Escape never write, filters survive successful form reset", async () => {
  const h = todos(); await h.show();
  expect(h.dialog.open).toBe(false);
  fireEvent.click(h.query.getByRole("button", { name: "新增待办" }));
  expect(h.dialog.open).toBe(true);
  fireEvent.input(h.query.getByLabelText("做什么"), { target: { value: "draft" } });
  fireEvent.click(within(h.dialog).getByRole("button", { name: "取消" }));
  expect(h.dialog.open).toBe(false);
  fireEvent.click(h.query.getByRole("button", { name: "新增待办" }));
  fireEvent(h.dialog, new Event("cancel", { cancelable: true }));
  expect(h.calls.some((call) => call.name === "create_todo_cmd")).toBe(false);
  fireEvent.change(h.query.getByLabelText("任务状态"), { target: { value: "all" } });
  fireEvent.click(h.query.getByRole("button", { name: "新增待办" }));
  fireEvent.input(h.query.getByLabelText("做什么"), { target: { value: "新任务" } });
  fireEvent.submit(document.getElementById("todo-form")!);
  await waitFor(() => expect(h.dialog.open).toBe(false));
  expect((h.query.getByLabelText("任务状态") as HTMLSelectElement).value).toBe("all");
});

test("edit opens the correct application, while failed creation retains input in the dialog", async () => {
  const h = todos(true); await h.show();
  fireEvent.click(h.query.getByRole("button", { name: "改期" }));
  await waitFor(() => expect(h.dialog.open).toBe(true));
  const application = h.query.getByLabelText("属于哪条申请") as HTMLSelectElement;
  expect(application.value).toBe("a2"); expect(application.disabled).toBe(true);
  fireEvent.click(within(h.dialog).getByRole("button", { name: "取消" }));
  fireEvent.click(h.query.getByRole("button", { name: "新增待办" }));
  fireEvent.input(h.query.getByLabelText("做什么"), { target: { value: "不要丢掉" } });
  fireEvent.submit(document.getElementById("todo-form")!);
  await waitFor(() => expect(document.getElementById("todo-form-status")!.textContent).toContain("保存失败"));
  expect(h.dialog.open).toBe(true);
  expect((h.query.getByLabelText("做什么") as HTMLInputElement).value).toBe("不要丢掉");
  expect(application.disabled).toBe(false);
});

test("evidence preview escapes original text and requires an explicit association", async () => {
  const item = { id: "e1", kind: "eml", subject: "面试邀请", importedAt: "2026-09-22", sameBytesAs: [], bodyExtract: "<img src=x onerror=alert(1)> 原文", sizeBytes: 20 };
  const calls = vi.fn();
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls(name, args);
    if (name === "list_inbox_cmd") return [item] as T;
    if (name === "get_evidence_preview_cmd") return item as T;
    if (name === "list_applications_cmd") return { items: apps } as T;
    return {} as T;
  };
  const h = mountInbox(invoke); await h.refresh();
  fireEvent.click(document.querySelector("[data-evidence]")!);
  await waitFor(() => expect(document.getElementById("inbox-application")).toBeTruthy());
  expect(document.querySelector(".evidence-body img")).toBeNull();
  expect(document.querySelector(".evidence-body")!.textContent).toContain("<img");
  fireEvent.click(document.querySelector('[data-act="associate"]')!);
  expect(calls.mock.calls.some(([name]) => name === "associate_evidence_cmd")).toBe(false);
  fireEvent.change(document.getElementById("inbox-application")!, { target: { value: "a2" } });
  fireEvent.click(document.querySelector('[data-act="associate"]')!);
  await waitFor(() => expect(calls).toHaveBeenCalledWith("associate_evidence_cmd", { evidenceId: "e1", applicationId: "a2" }));
});
