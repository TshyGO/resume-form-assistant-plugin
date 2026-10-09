import { beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, within, waitFor } from "@testing-library/dom";
import { mountApplications } from "./applications-ui";
import type { Invoke } from "./api";

beforeEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = readFileSync("index.html", "utf8")
    .split("<body>")[1].split("</body>")[0];
});

function setup() {
  const calls: string[] = [];
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push(name);
    const items = ["A", "B"].map((id) => ({ id, company: `公司${id}`, title: "工程师", current_stage: "saved" }));
    if (name === "list_applications_cmd") return { total: 2, items } as T;
    if (name === "get_application_cmd") return {
      application: items.find((item) => item.id === args?.id), events: [], evidence: [], snapshots: [],
    } as T;
    return {} as T;
  };
  return { ui: mountApplications(invoke), calls };
}

test("list selection exposes detail tabs; arrow keys change panels without writing", async () => {
  const { ui, calls } = setup();
  await ui.refreshList();
  const app = within(document.getElementById("view-applications")!);
  fireEvent.click(app.getByRole("button", { name: "公司A 工程师" }));
  await waitFor(() => expect(app.getByRole("tab", { name: "时间线 0" }).getAttribute("aria-selected")).toBe("true"));
  const evidence = app.getByRole("tab", { name: "回复证据 0" });
  fireEvent.click(evidence);
  expect(app.getByRole("tabpanel").getAttribute("id")).toBe("detail-panel-evidence");
  expect(app.getByText("这只表示还没有导入任何回复证据，不代表对方没有回复。")).toBeTruthy();
  fireEvent.keyDown(evidence, { key: "ArrowRight" });
  expect(document.activeElement).toBe(app.getByRole("tab", { name: "简历快照 0" }));
  expect(app.getByRole("tabpanel").id).toBe("detail-panel-snapshots");
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(app.getByRole("tabpanel").id).toBe("detail-panel-timeline");
  expect(calls.every((name) => ["list_applications_cmd", "get_application_cmd"].includes(name))).toBe(true);
});

test("same application refresh preserves selected tab; another application resets it", async () => {
  const { ui } = setup(); await ui.refreshList();
  const app = within(document.getElementById("view-applications")!);
  fireEvent.click(app.getByRole("button", { name: "公司A 工程师" }));
  await waitFor(() => expect(app.getByRole("tab", { name: "回复证据 0" })).toBeTruthy());
  fireEvent.click(app.getByRole("tab", { name: "回复证据 0" }));
  fireEvent.click(app.getByRole("button", { name: "公司A 工程师" }));
  await waitFor(() => expect(app.getByRole("tabpanel").id).toBe("detail-panel-evidence"));
  fireEvent.click(app.getByRole("button", { name: "公司B 工程师" }));
  await waitFor(() => expect(app.getByRole("tabpanel").id).toBe("detail-panel-timeline"));
  expect(app.getByRole("button", { name: "公司B 工程师" }).getAttribute("aria-current")).toBe("true");
});

test("all original actions remain available, and Escape closes the disclosure with focus restored", async () => {
  const { ui, calls } = setup(); await ui.refreshList();
  const app = within(document.getElementById("view-applications")!);
  fireEvent.click(app.getByRole("button", { name: "公司A 工程师" }));
  await waitFor(() => expect(document.querySelectorAll(".action-menu").length).toBe(2));
  expect(Array.from(document.querySelectorAll("[data-act]"), (node) => (node as HTMLElement).dataset.act).sort()).toEqual(
    ["submit", "interview", "assessment", "offer", "rejected", "withdrawn", "closed", "edit", "note", "correct", "recycle"].sort(),
  );
  const menu = document.querySelector<HTMLDetailsElement>(".action-menu")!;
  menu.open = true;
  const button = menu.querySelector<HTMLButtonElement>("button")!;
  button.focus(); fireEvent.keyDown(button, { key: "Escape" });
  expect(menu.open).toBe(false);
  expect(document.activeElement).toBe(menu.querySelector("summary"));
  expect(calls.filter((name) => !["list_applications_cmd", "get_application_cmd"].includes(name))).toEqual([]);
});

test("correct stage opens an in-page dialog and writes only after a new stage and reason are submitted", async () => {
  const writes: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const item = { id: "A", company: "公司A", title: "工程师", current_stage: "offer" };
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    if (name === "list_applications_cmd") return { total: 1, items: [item] } as T;
    if (name === "get_application_cmd") return { application: item, events: [], evidence: [], snapshots: [] } as T;
    writes.push({ name, args });
    return {} as T;
  };
  const ui = mountApplications(invoke);
  await ui.refreshList();
  const dialog = document.getElementById("correct-stage-dialog") as HTMLDialogElement;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  fireEvent.click(document.querySelector<HTMLButtonElement>(".app-select")!);
  await waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-act="correct"]')).toBeTruthy());
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-act="correct"]')!);
  expect(dialog.open).toBe(true);
  expect(document.getElementById("correct-stage-from")!.textContent).toBe("Offer");
  fireEvent.submit(document.getElementById("correct-stage-form")!);
  expect(document.getElementById("correct-stage-msg")!.textContent).toContain("不同");
  expect(writes).toHaveLength(0);
  fireEvent.change(document.getElementById("correct-stage-to")!, { target: { value: "interview" } });
  fireEvent.change(document.getElementById("correct-stage-reason")!, { target: { value: "录错阶段" } });
  fireEvent.submit(document.getElementById("correct-stage-form")!);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({ name: "correct_stage_cmd", args: { args: { id: "A", from: "offer", to: "interview", reason: "录错阶段" } } });
  await waitFor(() => expect(dialog.open).toBe(false));
});

function mountWith(view: Record<string, unknown>, total = 1) {
  const listArgs: Array<Record<string, unknown>> = [];
  const invoke: Invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    if (name === "list_applications_cmd") {
      listArgs.push(args?.args as Record<string, unknown>);
      return { total, items: total ? [view.application] : [] } as T;
    }
    if (name === "get_application_cmd") return view as T;
    return {} as T;
  };
  return { ui: mountApplications(invoke), listArgs };
}

test("stage chips are shortcuts for the full stage filter and stay in sync with it", async () => {
  const { ui, listArgs } = mountWith({ application: { id: "A", company: "公司A", title: "工程师", current_stage: "saved" } });
  await ui.refreshList();
  const stage = document.getElementById("app-stage") as HTMLSelectElement;
  expect(Array.from(stage.options, (option) => option.value)).toEqual(
    ["all", "saved", "filling", "submitted", "assessment", "interview", "offer", "rejected", "withdrawn", "closed"],
  );
  const chip = (value: string) => document.querySelector<HTMLButtonElement>(`[data-stage-chip="${value}"]`)!;
  expect(chip("all").getAttribute("aria-pressed")).toBe("true");
  ui.ctl.setOffset(ui.ctl.limit);
  fireEvent.click(chip("interview"));
  await waitFor(() => expect(listArgs.at(-1)?.stage).toBe("interview"));
  expect(listArgs.at(-1)?.offset).toBe(0);
  expect(stage.value).toBe("interview");
  expect(chip("interview").getAttribute("aria-pressed")).toBe("true");
  expect(chip("all").getAttribute("aria-pressed")).toBe("false");
  fireEvent.change(stage, { target: { value: "assessment" } });
  await waitFor(() => expect(listArgs.at(-1)?.stage).toBe("assessment"));
  expect(document.querySelectorAll('[data-stage-chip][aria-pressed="true"]').length).toBe(0);
});

test("shortcut settings persist chosen stages and offer the recycle bin as a separate view", async () => {
  const { ui, listArgs } = mountWith({ application: { id: "A", company: "公司A", title: "工程师", current_stage: "saved" } });
  await ui.refreshList();
  fireEvent.click(document.querySelector<HTMLInputElement>('#app-shortcut-options input[value="assessment"]')!);
  fireEvent.click(document.querySelector<HTMLInputElement>('#app-shortcut-options input[value="recycled"]')!);
  expect(JSON.parse(window.localStorage.getItem("applications-shortcuts-v1") || "[]")).toContain("assessment");
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-stage-chip="assessment"]')!);
  await waitFor(() => expect(listArgs.at(-1)?.stage).toBe("assessment"));
  expect(listArgs.at(-1)?.recycle).toBe("active");
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-stage-chip="recycled"]')!);
  await waitFor(() => expect(listArgs.at(-1)?.recycle).toBe("recycled"));
  expect(listArgs.at(-1)?.stage).toBe("all");
  fireEvent.click(document.querySelector<HTMLButtonElement>('[data-stage-chip="all"]')!);
  await waitFor(() => expect(listArgs.at(-1)?.recycle).toBe("active"));
});

test("detail summary has four compact facts and narrow view can return to the list", async () => {
  const application = { id: "A", company: "公司A", title: "工程师", current_stage: "saved", source_url: "https://jobs.example.test/1", notes: "面试后跟进" };
  const { ui } = mountWith({ application, events: [], evidence: [], snapshots: [] });
  await ui.refreshList();
  fireEvent.click(document.querySelector<HTMLButtonElement>(".app-select")!);
  await waitFor(() => expect(document.querySelector(".detail-facts")).toBeTruthy());
  expect(Array.from(document.querySelectorAll(".detail-facts dt"), (node) => node.textContent)).toEqual(["工作地点", "最近更新", "来源网址", "备注"]);
  expect(document.getElementById("apps-shell")!.classList.contains("show-detail")).toBe(true);
  fireEvent.click(document.querySelector<HTMLButtonElement>("[data-detail-back]")!);
  expect(document.getElementById("apps-shell")!.classList.contains("show-detail")).toBe(false);
});

test("name sorting uses ascending order without adding an explanation to the toolbar", async () => {
  const { ui, listArgs } = mountWith({ application: { id: "A", company: "公司A", title: "工程师", current_stage: "saved" } });
  await ui.refreshList();
  fireEvent.change(document.getElementById("app-sort")!, { target: { value: "company" } });
  await waitFor(() => expect(listArgs.at(-1)?.sort).toBe("company"));
  expect(listArgs.at(-1)?.desc).toBe(false);
  expect(document.querySelectorAll(".apps-list-tools select").length).toBe(1);
  fireEvent.click(document.getElementById("app-sort-direction")!);
  await waitFor(() => expect(listArgs.at(-1)?.desc).toBe(true));
});

test("detail counts come from the data, and todos are shown apart from the history", async () => {
  const application = { id: "A", company: "星河", title: "工程师", current_stage: "interview", recycle_state: "recycled", source_url: "https://jobs.example.test/1" };
  const { ui } = mountWith({
    application,
    events: [
      { id: "e1", event_type: "application_created", event_sequence: 1, occurred: { precision: "unknown" }, payload: {} },
      { id: "e2", event_type: "interview_recorded", event_sequence: 2, occurred: { precision: "date", value: { date: "2026-10-01" } }, payload: { round: 2, note: "一面" } },
    ],
    evidence: [], snapshots: [], snapshotStates: {},
    todos: [{ id: "t1", applicationId: "A", title: "准备二面", status: "open", duePrecision: "date", dueDate: "2026-10-09", reminderState: "unsupported" }],
  });
  await ui.refreshList();
  const app = within(document.getElementById("view-applications")!);
  fireEvent.click(app.getByRole("button", { name: "星河 工程师" }));
  await waitFor(() => expect(app.getByRole("tab", { name: "时间线 2" })).toBeTruthy());
  expect(app.getByRole("tab", { name: "回复证据 0" })).toBeTruthy();
  expect(app.getByRole("tab", { name: "简历快照 0" })).toBeTruthy();
  const items = document.querySelectorAll(".timeline-item");
  expect(items[0].textContent).toContain("记录面试 · 第 2 轮");
  expect(items[1].textContent).toContain("创建申请");
  const todos = app.getByRole("region", { name: "关联待办" });
  expect(todos.textContent).toContain("准备二面");
  expect(todos.textContent).toContain("2026-10-09（未定时间）");
  expect(todos.closest(".timeline")).toBeNull();
  expect(document.querySelector('[data-act="recycle"]')!.textContent).toBe("从回收站恢复");
  expect(document.getElementById("app-detail")!.textContent).toContain("在回收站");
  // 设计稿里没有数据来源的东西不能出现。
  const text = document.getElementById("view-applications")!.textContent ?? "";
  for (const fake of ["薪", "Calendar", "会议", "推荐", "已连接", "HR 终面", "导入邮件"]) expect(text).not.toContain(fake);
});

test("an empty archive gives the whole page to the empty state", async () => {
  const { ui } = mountWith({ application: { id: "A", company: "x", title: "y" } }, 0);
  await ui.refreshList();
  expect(document.getElementById("apps-shell")!.classList.contains("is-empty")).toBe(true);
  expect(document.getElementById("apps-empty")!.classList.contains("hidden")).toBe(false);
  expect(document.getElementById("apps-msg")!.textContent).toBe("");
});

test("the top bar keeps every route and the install entry, without a fixed version or avatar", () => {
  const routes = Array.from(document.querySelectorAll<HTMLElement>(".topbar [data-route]"), (node) => node.textContent);
  expect(routes).toEqual(["申请", "简历", "证据收件箱", "待办", "设置"]);
  expect(document.getElementById("nav-install-extension")).toBeTruthy();
  const version = document.getElementById("app-version")!;
  expect(version.hidden).toBe(true);
  expect(version.textContent).toBe("");
  expect(document.querySelector(".topbar")!.textContent).not.toMatch(/已连接|v\d/);
});

test("the recycle filter only offers the active list and the recycle bin", () => {
  const options = Array.from((document.getElementById("app-recycle") as HTMLSelectElement).options, (option) => option.value);
  expect(options).toEqual(["active", "recycled"]);
});

test("recycling says where the application went, and restoring says it is back", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const cases: Array<[string, string[] | null, string]> = [
    ["active", null, "已移到回收站。可在快捷筛选设置中显示「回收站」查看或恢复。"],
    ["active", ["submitted", "recycled"], "已移到回收站。可点「回收站」查看或恢复。"],
    ["recycled", null, "已从回收站恢复。"],
  ];
  for (const [recycleState, shortcuts, message] of cases) {
    window.localStorage.clear();
    if (shortcuts) window.localStorage.setItem("applications-shortcuts-v1", JSON.stringify(shortcuts));
    document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
    const { ui } = mountWith({ application: { id: "A", company: "公司A", title: "工程师", current_stage: "saved", recycle_state: recycleState } });
    await ui.refreshList();
    fireEvent.click(within(document.getElementById("view-applications")!).getByRole("button", { name: "公司A 工程师" }));
    await waitFor(() => expect(document.querySelector('[data-act="recycle"]')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-act="recycle"]')!);
    await waitFor(() => expect(document.getElementById("apps-msg")!.textContent).toBe(message));
  }
  confirm.mockRestore();
});
