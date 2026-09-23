import { StrictMode } from "react";
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

function mount(
  handler: (command: string, args?: Record<string, unknown>) => unknown,
  pickers: FilePickers | null,
  { strict = false }: { strict?: boolean } = {},
) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  const tree = (
    <InvokeProvider invoke={invoke}>
      <TemplateList pickers={pickers} />
    </InvokeProvider>
  );
  // 桌面程序里是 StrictMode 挂的（react/mount.tsx），会把状态更新函数跑两遍。
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
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
      return { template: { id: "t3", name: "新", fieldCount: 5, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 0 };
    }
    return overview;
  }, pickers("/tmp/新.xlsx", null));
  await user.click(await screen.findByRole("button", { name: "导入 Excel" }));
  await waitFor(() => expect(screen.getByText("简历模板导入成功，共 5 个字段。")).toBeTruthy());
  expect(calls.find((c) => c.command === "import_resume_template_cmd")?.args).toEqual({ path: "/tmp/新.xlsx", replaceId: null });
});

test("导入时剔掉了像密码的字段要说出来", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "import_resume_template_cmd") {
      return { template: { id: "t3", name: "新", fieldCount: 5, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 2 };
    }
    return overview;
  }, pickers("/tmp/新.xlsx", null));
  await user.click(await screen.findByRole("button", { name: "导入 Excel" }));
  const note = await screen.findByText("简历模板导入成功，共 5 个字段。另有 2 个像密码或验证码的字段没有导入。");
  expect(note.className).toContain("warn");
});

test("重新导入带上被覆盖的模板 id", async () => {
  const user = userEvent.setup();
  const calls = mount((command) => {
    if (command === "import_resume_template_cmd") {
      return { template: { id: "t1", name: "校招简历", fieldCount: 14, updatedAt: "" }, previousFieldCount: 12, skippedSecretFields: 0 };
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

test("首次读取模板失败时给出提示与重试按钮", async () => {
  const user = userEvent.setup();
  let attempts = 0;
  mount((command) => {
    if (command === "resume_overview_cmd") {
      attempts += 1;
      if (attempts === 1) throw { code: "IO", message: "读取模板失败，请重试。" };
      return overview;
    }
    return overview;
  }, pickers(null, null));

  expect(await screen.findByText("读取模板失败，请重试。")).toBeTruthy();
  const retry = screen.getByRole("button", { name: "重试" });
  expect(retry).toHaveProperty("type", "button");
  await user.click(retry);
  expect(await screen.findByRole("listitem", { name: /校招简历/ })).toBeTruthy();
});

test("新建（非覆盖）导入失败时补一句「本次导入未生效。」", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "import_resume_template_cmd") throw { code: "SHEET_INVALID", message: "第 3 行缺少「字段名」（第二列）。" };
    return overview;
  }, pickers("/tmp/a.xlsx", null));
  await user.click(await screen.findByRole("button", { name: "导入 Excel" }));
  expect(await screen.findByText("第 3 行缺少「字段名」（第二列）。本次导入未生效。")).toBeTruthy();
});

test("重新导入失败时补一句「本次导入未生效，原模板保持不变。」", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "import_resume_template_cmd") throw { code: "SHEET_INVALID", message: "第 3 行缺少「字段名」（第二列）。" };
    return overview;
  }, pickers("/tmp/改.xlsx", null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "重新导入" }));
  expect(await screen.findByText("第 3 行缺少「字段名」（第二列）。本次导入未生效，原模板保持不变。")).toBeTruthy();
});

test.each([false, true])("预览展开后重新导入，预览跟着刷新而不是留着旧内容（StrictMode: %s）", async (strict) => {
  const user = userEvent.setup();
  let previewCalls = 0;
  let currentOverview = overview;
  const calls = mount((command) => {
    if (command === "resume_overview_cmd") return currentOverview;
    if (command === "get_resume_template_cmd") {
      previewCalls += 1;
      return previewCalls === 1
        ? { id: "t1", name: "校招简历", updatedAt: "2026-09-22T00:00:00Z", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "旧内容" }] }] }
        : { id: "t1", name: "校招简历", updatedAt: "2026-09-23T01:00:00Z", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "新内容" }] }] };
    }
    if (command === "import_resume_template_cmd") {
      currentOverview = {
        templates: [overview.templates[0], { ...overview.templates[1], fieldCount: 14, updatedAt: "2026-09-23T01:00:00Z" }],
        activeTemplateId: currentOverview.activeTemplateId,
      };
      return { template: { id: "t1", name: "校招简历", fieldCount: 14, updatedAt: "2026-09-23T01:00:00Z" }, previousFieldCount: 12, skippedSecretFields: 0 };
    }
    return currentOverview;
  }, pickers("/tmp/改.xlsx", null), { strict });

  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "预览" }));
  expect(await within(row).findByText("旧内容")).toBeTruthy();

  await user.click(within(row).getByRole("button", { name: "重新导入" }));
  await waitFor(() => expect(within(row).getByText("新内容")).toBeTruthy());
  expect(within(row).queryByText("旧内容")).toBeNull();
  // 展开一次、重新导入后刷新一次；StrictMode 下也不能多拉。
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls.filter((c) => c.command === "get_resume_template_cmd")).toHaveLength(2);
});

test("改名被拒绝时表单留着、显示原因", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "rename_resume_template_cmd") throw { code: "VALIDATION", message: "模板名不能包含特殊字符。" };
    return overview;
  }, pickers(null, null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "重命名" }));
  const input = within(row).getByLabelText("新名称");
  expect(input).toHaveProperty("value", "校招简历");
  await user.clear(input);
  await user.type(input, "新名字*");
  await user.click(within(row).getByRole("button", { name: "保存名称" }));
  expect(await screen.findByText("模板名不能包含特殊字符。")).toBeTruthy();
  expect(within(row).getByLabelText("新名称")).toBeTruthy();
});

test("改名成功后表单收起", async () => {
  const user = userEvent.setup();
  mount((command) => (command === "rename_resume_template_cmd" ? { ok: true } : overview), pickers(null, null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "重命名" }));
  await user.click(within(row).getByRole("button", { name: "保存名称" }));
  await waitFor(() => expect(within(row).queryByLabelText("新名称")).toBeNull());
});

test("重命名的名称为空时不能提交", async () => {
  const user = userEvent.setup();
  mount(() => overview, pickers(null, null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "重命名" }));
  const input = within(row).getByLabelText("新名称");
  await user.clear(input);
  expect(within(row).getByRole("button", { name: "保存名称" })).toHaveProperty("disabled", true);
});

test("操作命令报 NOT_FOUND 时自动重新拉取列表", async () => {
  const user = userEvent.setup();
  let overviewCalls = 0;
  mount((command) => {
    if (command === "resume_overview_cmd") {
      overviewCalls += 1;
      return overview;
    }
    if (command === "set_active_resume_template_cmd") throw { code: "NOT_FOUND", message: "模板已被删除。" };
    return overview;
  }, pickers(null, null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "设为当前" }));
  await waitFor(() => expect(screen.getByText("模板已被删除。")).toBeTruthy());
  await waitFor(() => expect(overviewCalls).toBeGreaterThanOrEqual(2));
});

test("提示带 role=status", async () => {
  const user = userEvent.setup();
  mount((command) =>
    command === "set_active_resume_template_cmd" ? { ...overview, activeTemplateId: "t1" } : overview,
  pickers(null, null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "设为当前" }));
  expect(await screen.findByRole("status")).toBeTruthy();
});
