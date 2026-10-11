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
function todos({ failSave = false, items = [task] as unknown[], applications = apps } = {}) {
  const root = document.getElementById("view-todos")!;
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  let current = items;
  const createApplication = vi.fn();
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ name, args });
    if (name === "list_applications_cmd") return { items: applications } as T;
    if (name === "list_todos_cmd") return current as T;
    if (name === "reminder_capability_cmd") return { available: false, reason: "系统通知不可用。" } as T;
    if (name === "overdue_digest_cmd") return { todos: [], more: 0 } as T;
    if (failSave && name === "create_todo_cmd") throw new Error("模拟保存失败");
    if (name === "set_todo_status_cmd") {
      current = current.map((item) => ((item as { id: string }).id === args?.id ? { ...(item as object), status: args?.status } : item));
      return { todo: current[0], reminderProblem: null } as T;
    }
    return {} as T;
  };
  return {
    root, calls, createApplication, query: within(root),
    show: mountTodos(invoke, () => new Date(2026, 8, 20, 10, 0, 0), { createApplication }),
    dialog: document.getElementById("todo-dialog") as HTMLDialogElement,
  };
}

test("new todo is a dialog; cancel and Escape never write, filters survive successful form reset", async () => {
  const h = todos(); await h.show();
  expect(h.dialog.open).toBe(false);
  const opener = h.query.getByRole("button", { name: "新增待办" });
  opener.focus();
  fireEvent.click(opener);
  expect(h.dialog.open).toBe(true);
  fireEvent.input(h.query.getByLabelText("做什么"), { target: { value: "draft" } });
  fireEvent.click(within(h.dialog).getByRole("button", { name: "取消" }));
  expect(h.dialog.open).toBe(false);
  expect(document.activeElement).toBe(opener);
  fireEvent.click(opener);
  expect((h.query.getByLabelText("做什么") as HTMLInputElement).value).toBe("");
  fireEvent(h.dialog, new Event("cancel", { cancelable: true }));
  expect(h.dialog.open).toBe(false);
  expect(h.calls.some((call) => call.name === "create_todo_cmd")).toBe(false);
  fireEvent.click(within(h.query.getByRole("group", { name: "任务状态" })).getByRole("button", { name: /全部/ }));
  fireEvent.click(opener);
  fireEvent.change(h.query.getByLabelText("属于哪条申请"), { target: { value: "a1" } });
  fireEvent.input(h.query.getByLabelText("做什么"), { target: { value: "新任务" } });
  fireEvent.submit(document.getElementById("todo-form")!);
  await waitFor(() => expect(h.dialog.open).toBe(false));
  expect(h.calls.find((call) => call.name === "create_todo_cmd")?.args).toMatchObject({ args: { applicationId: "a1", title: "新任务" } });
  expect(within(h.query.getByRole("group", { name: "任务状态" })).getByRole("button", { name: /全部/ }).getAttribute("aria-pressed")).toBe("true");
});

test("edit opens the correct application, while failed creation retains input in the dialog", async () => {
  const h = todos({ failSave: true }); await h.show();
  fireEvent.click(h.query.getByRole("button", { name: "编辑 / 改期" }));
  await waitFor(() => expect(h.dialog.open).toBe(true));
  const application = h.query.getByLabelText("属于哪条申请") as HTMLSelectElement;
  expect(application.value).toBe("a2"); expect(application.disabled).toBe(true);
  expect(within(h.dialog).getByText(/撤掉原来登记的提醒/)).toBeTruthy();
  fireEvent.click(within(h.dialog).getByRole("button", { name: "取消" }));
  fireEvent.click(h.query.getByRole("button", { name: "新增待办" }));
  fireEvent.change(application, { target: { value: "a1" } });
  fireEvent.input(h.query.getByLabelText("做什么"), { target: { value: "不要丢掉" } });
  fireEvent.submit(document.getElementById("todo-form")!);
  await waitFor(() => expect(document.getElementById("todo-form-status")!.textContent).toContain("保存失败"));
  expect(h.dialog.open).toBe(true);
  expect((h.query.getByLabelText("做什么") as HTMLInputElement).value).toBe("不要丢掉");
  expect(application.disabled).toBe(false);
  expect(application.value).toBe("a1");
});

test("todo list and detail: selecting shows details, complete is direct and can be reopened in place", async () => {
  const h = todos({ items: [task, { ...task, id: "t2", title: "跟进结果", company: "星河", position: "工程师", duePrecision: "none", dueDate: null }] });
  await h.show();
  const detail = within(document.getElementById("todo-detail")!);
  expect(detail.getByRole("heading", { name: "准备面试" })).toBeTruthy();
  expect(detail.getByText("系统通知不可用。")).toBeTruthy();
  fireEvent.click(h.query.getByRole("button", { name: /^跟进结果/ }));
  expect(detail.getByRole("heading", { name: "跟进结果" })).toBeTruthy();
  fireEvent.click(detail.getByRole("button", { name: "标记为已完成" }));
  await waitFor(() => expect(detail.getByRole("button", { name: "重新打开" })).toBeTruthy());
  expect(h.calls.find((call) => call.name === "set_todo_status_cmd")?.args).toEqual({ id: "t2", status: "done" });
  expect(document.getElementById("todo-status")!.textContent).toContain("已标记完成");
  // 已完成的那条不在「未完成」列表里了，但详情还停在它上面，可以直接重新打开。
  expect(h.query.queryByRole("button", { name: /^跟进结果/ })).toBeNull();
  fireEvent.click(detail.getByRole("button", { name: "重新打开" }));
  await waitFor(() => expect(detail.getByRole("button", { name: "标记为已完成" })).toBeTruthy());
});

test("first-time empty and filter-without-results are different states; no application leads to creating one", async () => {
  const none = todos({ items: [], applications: [] }); await none.show();
  expect(document.getElementById("todo-shell")!.classList.contains("is-empty")).toBe(true);
  expect(none.query.getByRole("heading", { name: "还没有待办" })).toBeTruthy();
  fireEvent.click(none.query.getByRole("button", { name: "去新增申请" }));
  expect(none.createApplication).toHaveBeenCalledTimes(1);
  fireEvent.click(none.query.getByRole("button", { name: "新增待办" }));
  expect((document.getElementById("todo-submit") as HTMLButtonElement).disabled).toBe(true);
  expect(document.getElementById("todo-no-apps")!.hidden).toBe(false);
  fireEvent.click(within(none.dialog).getByRole("button", { name: "去新增申请" }));
  expect(none.dialog.open).toBe(false);
  expect(none.createApplication).toHaveBeenCalledTimes(2);

  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  const filtered = todos(); await filtered.show();
  fireEvent.click(within(filtered.query.getByRole("group", { name: "任务状态" })).getByRole("button", { name: /已取消/ }));
  expect(document.getElementById("todo-shell")!.classList.contains("is-empty")).toBe(false);
  expect(filtered.query.getByText("没有已取消的待办")).toBeTruthy();
});

test("paste import is a dialog: empty text is refused inline, success closes and clears", async () => {
  const calls = vi.fn();
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls(name, args);
    if (name === "list_inbox_cmd") return [] as T;
    if (name === "import_evidence_cmd") return { imported: [], duplicates: [{ id: "x" }], failed: [{ name: "a.msg", code: "unsupported" }] } as T;
    return {} as T;
  };
  const h = mountInbox(invoke); await h.refresh();
  const view = within(document.getElementById("view-inbox")!);
  expect(view.getByRole("heading", { name: "没有待整理的招聘通知" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "粘贴文本" }));
  const dialog = document.getElementById("inbox-paste-dialog") as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  expect(document.activeElement).toBe(document.getElementById("inbox-paste"));
  fireEvent.click(within(dialog).getByRole("button", { name: "导入这段文本" }));
  await waitFor(() => expect(document.getElementById("inbox-paste-status")!.textContent).toContain("先粘贴"));
  expect(calls.mock.calls.some(([name]) => name === "import_evidence_cmd")).toBe(false);
  fireEvent.input(document.getElementById("inbox-paste")!, { target: { value: "下周二面试" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "导入这段文本" }));
  await waitFor(() => expect(dialog.open).toBe(false));
  expect((document.getElementById("inbox-paste") as HTMLTextAreaElement).value).toBe("");
  const said = document.getElementById("inbox-status")!.textContent ?? "";
  expect(said).toContain("完全相同");
  expect(said).toContain("a.msg");
});

test("the notification page names itself and promises nothing it cannot do", () => {
  const text = document.getElementById("view-inbox")!.textContent ?? "";
  expect(text).toContain("集中保存招聘邮件、聊天截图和文件，关联到对应申请。");
  expect(text).toContain("文本（.txt）");
  for (const fake of ["证据收件箱", "导出原文", "删除材料", "匹配度", "置信度", "快捷待认领", "已整理", "搜索"]) expect(text).not.toContain(fake);
  const todosText = document.getElementById("view-todos")!.textContent ?? "";
  for (const fake of ["任务备注", "自动保存", "任务类型", "自查清单", "分享", "快捷模板", "岗位编号"]) expect(todosText).not.toContain(fake);
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

test.each(["storage", "too_large"])("paste failure report (%s) keeps the dialog and text for retry", async (code) => {
  let fail = true;
  const invoke: Invoke = async <T,>(name: string): Promise<T> => {
    if (name === "list_inbox_cmd") return [] as T;
    if (name === "import_evidence_cmd") return (fail
      ? { imported: [], duplicates: [], failed: [{ name: "粘贴文本", code }] }
      : { imported: [{ id: "e1" }], duplicates: [], failed: [] }) as T;
    return {} as T;
  };
  const h = mountInbox(invoke); await h.refresh();
  fireEvent.click(document.getElementById("inbox-paste-open")!);
  const dialog = document.getElementById("inbox-paste-dialog") as HTMLDialogElement;
  const text = document.getElementById("inbox-paste") as HTMLTextAreaElement;
  text.value = "重要面试邀请，请保留";
  await h.submitPaste();
  expect(dialog.open).toBe(true);
  expect(text.value).toBe("重要面试邀请，请保留");
  expect(document.getElementById("inbox-paste-status")!.textContent).toContain(code === "storage" ? "写入档案目录失败" : "超过 25 MiB");
  expect(text.readOnly).toBe(false);
  expect((document.getElementById("inbox-paste-save") as HTMLButtonElement).disabled).toBe(false);
  fail = false;
  await h.submitPaste();
  expect(dialog.open).toBe(false);
  expect(text.value).toBe("");
});

test("saved paste closes even when refreshing fails, and says it was saved", async () => {
  let imported = false;
  const invoke: Invoke = async <T,>(name: string): Promise<T> => {
    if (name === "list_inbox_cmd") {
      if (imported) throw new Error("读取失败");
      return [] as T;
    }
    if (name === "import_evidence_cmd") {
      imported = true;
      return { imported: [{ id: "e1" }], duplicates: [], failed: [] } as T;
    }
    return {} as T;
  };
  const h = mountInbox(invoke); await h.refresh();
  fireEvent.click(document.getElementById("inbox-paste-open")!);
  (document.getElementById("inbox-paste") as HTMLTextAreaElement).value = "已经保存";
  await h.submitPaste();
  expect((document.getElementById("inbox-paste-dialog") as HTMLDialogElement).open).toBe(false);
  expect(document.getElementById("inbox-status")!.textContent).toContain("材料已保存，无需重复导入");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test.each([false, true])("classification stays locked during refresh; selection changed=%s", async (switchSelection) => {
  const items = [
    { id: "e1", kind: "paste", subject: "第一封", importedAt: "2026-10-09", bodyExtract: "第一封正文" },
    { id: "e2", kind: "paste", subject: "第二封", importedAt: "2026-10-09", bodyExtract: "第二封正文" },
  ];
  const refresh = deferred<typeof items>();
  let reads = 0;
  const calls = vi.fn();
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls(name, args);
    if (name === "list_inbox_cmd") return (++reads === 2 ? refresh.promise : items) as T;
    if (name === "get_evidence_preview_cmd" || name === "classify_evidence_cmd") return items.find((item) => item.id === args?.evidenceId) as T;
    if (name === "list_applications_cmd") return { items: apps } as T;
    return {} as T;
  };
  const h = mountInbox(invoke); await h.refresh();
  fireEvent.click(document.querySelector('[data-evidence="e1"]')!);
  await waitFor(() => expect(document.querySelector('[data-act="classify"]')).toBeTruthy());
  fireEvent.click(document.querySelector('[data-act="classify"]')!);
  await waitFor(() => expect(reads).toBe(2));
  if (switchSelection) {
    fireEvent.click(document.querySelector('[data-evidence="e2"]')!);
    await waitFor(() => expect(document.querySelector(".evidence-body")!.textContent).toBe("第二封正文"));
  }
  const button = document.querySelector('[data-act="classify"]') as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(calls.mock.calls.filter(([name]) => name === "classify_evidence_cmd")).toHaveLength(1);
  refresh.resolve(items);
  await waitFor(() => expect((document.querySelector('[data-act="classify"]') as HTMLButtonElement).disabled).toBe(false));
  expect(document.querySelector(".evidence-body")!.textContent).toBe(switchSelection ? "第二封正文" : "第一封正文");
  fireEvent.click(document.querySelector('[data-act="classify"]')!);
  await waitFor(() => expect(calls.mock.calls.filter(([name]) => name === "classify_evidence_cmd")).toHaveLength(2));
});

test.each([false, true])("todo read failure has retry and keeps previously loaded data=%s", async (previouslyLoaded) => {
  let fail = !previouslyLoaded;
  const invoke: Invoke = async <T,>(name: string): Promise<T> => {
    if (name === "list_todos_cmd") {
      if (fail) throw new Error("数据库打不开");
      return [task, { ...task, id: "t2", title: "保留选中任务" }] as T;
    }
    if (name === "list_applications_cmd") return { items: apps } as T;
    if (name === "overdue_digest_cmd") return { todos: [], more: 0 } as T;
    if (name === "reminder_capability_cmd") return { available: false } as T;
    return {} as T;
  };
  const show = mountTodos(invoke);
  await show();
  if (previouslyLoaded) {
    fireEvent.click(document.querySelector('[data-todo="t2"][data-act="select"]')!);
    fail = true;
    await show();
    expect(document.querySelector('[data-todo="t2"][data-act="select"]')!.getAttribute("aria-current")).toBe("true");
    expect(document.querySelector("#todo-detail h2")!.textContent).toBe("保留选中任务");
    expect(document.querySelector('[data-filter="open"]')!.textContent).toContain("2");
    expect(document.getElementById("todo-status")!.textContent).toContain("当前显示上次读取的结果");
  }
  expect(document.getElementById("todo-list")!.textContent).toContain("数据库打不开");
  expect(document.getElementById("todo-list")!.textContent).not.toContain("还没有待办");
  fail = false;
  fireEvent.click(document.querySelector('[data-todo-retry]')!);
  await waitFor(() => expect(document.querySelector('[data-todo-retry]')).toBeNull());
  expect(document.getElementById("todo-status")!.textContent).toBe("已刷新待办。");
});
