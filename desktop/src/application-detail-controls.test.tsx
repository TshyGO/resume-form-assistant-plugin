import { beforeEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, within, waitFor } from "@testing-library/dom";
import { mountApplications } from "./applications-ui";
import type { Invoke } from "./api";

beforeEach(() => {
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
  await waitFor(() => expect(app.getByRole("tab", { name: "时间线" }).getAttribute("aria-selected")).toBe("true"));
  const evidence = app.getByRole("tab", { name: "证据 0" });
  fireEvent.click(evidence);
  expect(app.getByRole("tabpanel").getAttribute("id")).toBe("detail-panel-evidence");
  expect(app.getByText("这只表示还没有导入任何回复证据，不代表对方没有回复。")).toBeTruthy();
  fireEvent.keyDown(evidence, { key: "ArrowRight" });
  expect(document.activeElement).toBe(app.getByRole("tab", { name: "快照 0" }));
  expect(app.getByRole("tabpanel").id).toBe("detail-panel-snapshots");
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(app.getByRole("tabpanel").id).toBe("detail-panel-timeline");
  expect(calls.every((name) => ["list_applications_cmd", "get_application_cmd"].includes(name))).toBe(true);
});

test("same application refresh preserves selected tab; another application resets it", async () => {
  const { ui } = setup(); await ui.refreshList();
  const app = within(document.getElementById("view-applications")!);
  fireEvent.click(app.getByRole("button", { name: "公司A 工程师" }));
  await waitFor(() => expect(app.getByRole("tab", { name: "证据 0" })).toBeTruthy());
  fireEvent.click(app.getByRole("tab", { name: "证据 0" }));
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
