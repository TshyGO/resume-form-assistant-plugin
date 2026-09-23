import { expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Invoke, ResumeOverview } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { TemplateList } from "./TemplateList.tsx";
import type { FilePickers } from "./TemplateList.tsx";

const overview: ResumeOverview = {
  templates: [
    { id: "t2", name: "实习简历", fieldCount: 8, updatedAt: "2026-09-23T00:00:00Z" },
    { id: "t1", name: "校招简历", fieldCount: 12, updatedAt: "2026-09-22T00:00:00Z" },
  ],
  activeTemplateId: "t2",
};

function mount(handler: (command: string, args?: Record<string, unknown>) => unknown, pickers: FilePickers | null) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <TemplateList pickers={pickers} />
    </InvokeProvider>,
  );
  return calls;
}

const pickers = (open: string | null, save: string | null): FilePickers => ({
  open: async () => open,
  save: async () => save,
});

test("列出模板，标出当前模板和字段数", async () => {
  mount(() => overview, pickers(null, null));
  const current = await screen.findByRole("listitem", { name: /实习简历/ });
  expect(within(current).getByText("当前")).toBeTruthy();
  expect(within(current).getByText("8 个字段")).toBeTruthy();
});

test("没有模板时引导导入", async () => {
  mount(() => ({ templates: [], activeTemplateId: null }), pickers(null, null));
  expect(await screen.findByText(/还没有简历模板/)).toBeTruthy();
});

test("导入 Excel 用选中的文件新建模板，并说出字段数", async () => {
  const user = userEvent.setup();
  const calls = mount((command) => {
    if (command === "import_resume_template_cmd") {
      return { template: { id: "t3", name: "新", fieldCount: 5, updatedAt: "" }, previousFieldCount: null };
    }
    return overview;
  }, pickers("/tmp/新.xlsx", null));
  await user.click(await screen.findByRole("button", { name: "导入 Excel" }));
  await waitFor(() => expect(screen.getByText("简历模板导入成功，共 5 个字段。")).toBeTruthy());
  expect(calls.find((c) => c.command === "import_resume_template_cmd")?.args).toEqual({ path: "/tmp/新.xlsx", replaceId: null });
});

test("重新导入带上被覆盖的模板 id", async () => {
  const user = userEvent.setup();
  const calls = mount((command) => {
    if (command === "import_resume_template_cmd") {
      return { template: { id: "t1", name: "校招简历", fieldCount: 14, updatedAt: "" }, previousFieldCount: 12 };
    }
    return overview;
  }, pickers("/tmp/改.xlsx", null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "重新导入" }));
  await waitFor(() => expect(screen.getByText("模板已覆盖，字段 12 → 14 个。")).toBeTruthy());
  expect(calls.find((c) => c.command === "import_resume_template_cmd")?.args).toEqual({ path: "/tmp/改.xlsx", replaceId: "t1" });
});

test("导出用模板名作默认文件名，取消保存不调命令", async () => {
  const user = userEvent.setup();
  let suggested = "";
  const calls = mount(() => overview, {
    open: async () => null,
    save: async (name) => {
      suggested = name;
      return null;
    },
  });
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "导出 Excel" }));
  expect(suggested).toBe("校招简历.xlsx");
  expect(calls.some((c) => c.command === "export_resume_template_cmd")).toBe(false);
});

test("删除要先确认", async () => {
  const user = userEvent.setup();
  const calls = mount((command) =>
    command === "delete_resume_template_cmd" ? { templates: [overview.templates[0]], activeTemplateId: "t2" } : overview,
  pickers(null, null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "删除" }));
  expect(calls.some((c) => c.command === "delete_resume_template_cmd")).toBe(false);
  await user.click(within(row).getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(screen.queryByRole("listitem", { name: /校招简历/ })).toBeNull());
});

test("设为当前", async () => {
  const user = userEvent.setup();
  const calls = mount((command) =>
    command === "set_active_resume_template_cmd" ? { ...overview, activeTemplateId: "t1" } : overview,
  pickers(null, null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "设为当前" }));
  await waitFor(() => expect(within(row).getByText("当前")).toBeTruthy());
  expect(calls.find((c) => c.command === "set_active_resume_template_cmd")?.args).toEqual({ id: "t1" });
});

test("预览展开分组与字段", async () => {
  const user = userEvent.setup();
  mount((command) =>
    command === "get_resume_template_cmd"
      ? { id: "t1", name: "校招简历", updatedAt: "", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "张三" }] }] }
      : overview,
  pickers(null, null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "预览" }));
  expect(await within(row).findByText("张三")).toBeTruthy();
  expect(within(row).getByText("基本信息")).toBeTruthy();
});

test("命令报错时如实显示", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "import_resume_template_cmd") throw { code: "SHEET_INVALID", message: "第 3 行缺少「字段名」（第二列）。" };
    return overview;
  }, pickers("/tmp/a.xlsx", null));
  await user.click(await screen.findByRole("button", { name: "导入 Excel" }));
  expect(await screen.findByText(/第 3 行缺少「字段名」/)).toBeTruthy();
});
