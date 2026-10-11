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

const templateView = (id: string, value = "张三") => ({
  id,
  name: id === "t1" ? "校招简历" : "实习简历",
  updatedAt: "",
  groups: [{ name: "基本信息", fields: [{ key: "姓名", value }] }],
});

function mount(
  handler: (command: string, args?: Record<string, unknown>) => unknown,
  pickers: FilePickers | null,
  { strict = false }: { strict?: boolean } = {},
) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "get_resume_template_cmd") {
      const answer = handler(command, args);
      return answer && typeof answer === "object" && "groups" in answer ? answer : templateView(String(args?.id));
    }
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

const detail = () => screen.getByRole("region", { name: "模板详情" });

/** 在左边列表里选中一份模板，等右边的详情换成它。 */
async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
  const row = await screen.findByRole("listitem", { name });
  await user.click(within(row).getByRole("button"));
  await waitFor(() => expect(within(detail()).getByRole("heading", { name })).toBeTruthy());
  return row;
}

test("列出模板，标出当前模板和字段数", async () => {
  mount(() => overview, pickers(null, null));
  const current = await screen.findByRole("listitem", { name: /实习简历/ });
  expect(within(current).getByText("当前模板")).toBeTruthy();
  expect(within(current).getByText("8 个字段")).toBeTruthy();
  const other = screen.getByRole("listitem", { name: /校招简历/ });
  expect(within(other).queryByText("当前模板")).toBeNull();
});

test("默认预览当前模板；选中另一份只换预览，不改当前模板", async () => {
  const user = userEvent.setup();
  const calls = mount(() => overview, pickers(null, null));
  await waitFor(() => expect(within(detail()).getByRole("heading", { name: "实习简历" })).toBeTruthy());
  expect(within(detail()).getByText("填写时优先使用")).toBeTruthy();

  const row = await choose(user, "校招简历");
  expect(within(row).getByRole("button").getAttribute("aria-pressed")).toBe("true");
  expect(within(detail()).getByText("模板预览")).toBeTruthy();
  expect(within(detail()).getByRole("button", { name: "设为当前" })).toBeTruthy();
  expect(calls.some((c) => c.command === "set_active_resume_template_cmd")).toBe(false);
  // 当前徽标仍在原来那份上。
  expect(within(screen.getByRole("listitem", { name: "实习简历" })).getByText("当前模板")).toBeTruthy();
});

test("没有模板时引导导入", async () => {
  mount(() => ({ templates: [], activeTemplateId: null }), pickers(null, null));
  expect(await screen.findByText(/还没有简历模板/)).toBeTruthy();
  expect(screen.getByText("还没有可预览的模板")).toBeTruthy();
});

test("导入 Excel 用选中的文件新建模板，说出字段数并选中它", async () => {
  const user = userEvent.setup();
  let current = overview;
  const calls = mount((command) => {
    if (command === "import_resume_template_cmd") {
      current = { ...overview, templates: [...overview.templates, { id: "t3", name: "新", fieldCount: 5, updatedAt: "" }] };
      return { template: { id: "t3", name: "新", fieldCount: 5, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 0 };
    }
    return current;
  }, pickers("/tmp/新.xlsx", null));
  await screen.findByRole("listitem", { name: "实习简历" });
  await user.click(screen.getByRole("button", { name: "导入 Excel" }));
  await waitFor(() => expect(screen.getByText("简历模板导入成功，共 5 个字段。")).toBeTruthy());
  expect(calls.find((c) => c.command === "import_resume_template_cmd")?.args).toEqual({ path: "/tmp/新.xlsx", replaceId: null });
  await waitFor(() => expect(within(detail()).getByRole("heading", { name: "新" })).toBeTruthy());
});

test("导入时剔掉了像密码的字段要说出来", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "import_resume_template_cmd") {
      return { template: { id: "t3", name: "新", fieldCount: 5, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 2 };
    }
    return overview;
  }, pickers("/tmp/新.xlsx", null));
  await screen.findByRole("listitem", { name: "实习简历" });
  await user.click(screen.getByRole("button", { name: "导入 Excel" }));
  const note = await screen.findByText("简历模板导入成功，共 5 个字段。另有 2 个像密码或验证码的字段没有导入。");
  expect(note.className).toContain("warn");
});

test("取消选择文件时不调用导入命令", async () => {
  const user = userEvent.setup();
  const calls = mount(() => overview, pickers(null, null));
  await screen.findByRole("listitem", { name: "实习简历" });
  await user.click(screen.getByRole("button", { name: "导入 Excel" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls.some((c) => c.command === "import_resume_template_cmd")).toBe(false);
});

test("没有原生文件窗口时禁用导入、重新导入和导出，并说明原因；其他操作仍可用", async () => {
  const user = userEvent.setup();
  mount(() => overview, null);
  await choose(user, "校招简历");
  expect(screen.getByRole("button", { name: "导入 Excel" })).toHaveProperty("disabled", true);
  expect(within(detail()).getByRole("button", { name: "重新导入" })).toHaveProperty("disabled", true);
  expect(within(detail()).getByRole("button", { name: "导出 Excel" })).toHaveProperty("disabled", true);
  expect(within(detail()).getByRole("button", { name: "重命名" })).toHaveProperty("disabled", false);
  expect(within(detail()).getByRole("button", { name: "设为当前" })).toHaveProperty("disabled", false);
  expect(screen.getByText(/请在桌面程序里操作/)).toBeTruthy();
});

test("重新导入先确认覆盖，再带上被覆盖的模板 id", async () => {
  const user = userEvent.setup();
  let opened = 0;
  const calls = mount((command) => {
    if (command === "import_resume_template_cmd") {
      return { template: { id: "t1", name: "校招简历", fieldCount: 14, updatedAt: "" }, previousFieldCount: 12, skippedSecretFields: 0 };
    }
    return overview;
  }, { open: async () => { opened += 1; return "/tmp/改.xlsx"; }, save: async () => null });
  await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "重新导入" }));
  const dialog = screen.getByRole("dialog", { name: "覆盖这份模板？" });
  expect(within(dialog).getByText(/旧字段数：12/)).toBeTruthy();
  expect(opened).toBe(0);
  await user.click(within(dialog).getByRole("button", { name: "继续选文件" }));
  await waitFor(() => expect(screen.getByText("模板已覆盖，字段 12 → 14 个。")).toBeTruthy());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.find((c) => c.command === "import_resume_template_cmd")?.args).toEqual({ path: "/tmp/改.xlsx", replaceId: "t1" });
});

test("覆盖确认里取消，不打开文件窗口", async () => {
  const user = userEvent.setup();
  let opened = 0;
  mount(() => overview, { open: async () => { opened += 1; return "/tmp/改.xlsx"; }, save: async () => null });
  await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "重新导入" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(opened).toBe(0);
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
  await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "导出 Excel" }));
  expect(suggested).toBe("校招简历.xlsx");
  expect(calls.some((c) => c.command === "export_resume_template_cmd")).toBe(false);
});

test("导出成功说出字段数", async () => {
  const user = userEvent.setup();
  const calls = mount(() => overview, pickers(null, "/tmp/校招简历.xlsx"));
  await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "导出 Excel" }));
  expect(await screen.findByText("已导出 12 个字段。")).toBeTruthy();
  expect(calls.find((c) => c.command === "export_resume_template_cmd")?.args).toEqual({ id: "t1", path: "/tmp/校招简历.xlsx" });
});

test("删除要先确认，说明当前模板会怎么变", async () => {
  const user = userEvent.setup();
  const calls = mount((command) =>
    command === "delete_resume_template_cmd" ? { templates: [overview.templates[1]], activeTemplateId: "t1" } : overview,
  pickers(null, null));
  await waitFor(() => expect(within(detail()).getByRole("heading", { name: "实习简历" })).toBeTruthy());
  await user.click(within(detail()).getByRole("button", { name: "删除" }));
  const dialog = screen.getByRole("dialog", { name: "删除「实习简历」？" });
  expect(within(dialog).getByText(/删除后「校招简历」会成为当前模板/)).toBeTruthy();
  // 危险操作不是默认焦点。
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "取消" }));
  expect(calls.some((c) => c.command === "delete_resume_template_cmd")).toBe(false);
  await user.click(within(dialog).getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(screen.queryByRole("listitem", { name: /实习简历/ })).toBeNull());
  expect(screen.queryByRole("dialog")).toBeNull();
  // 删掉选中的那份后，预览换成剩下的当前模板。
  await waitFor(() => expect(within(detail()).getByRole("heading", { name: "校招简历" })).toBeTruthy());
  expect(within(screen.getByRole("listitem", { name: "校招简历" })).getByText("当前模板")).toBeTruthy();
});

test("删除最后一份当前模板时说明之后没有当前模板", async () => {
  const user = userEvent.setup();
  mount(() => ({ templates: [overview.templates[0]], activeTemplateId: "t2" }), pickers(null, null));
  await waitFor(() => expect(within(detail()).getByRole("heading", { name: "实习简历" })).toBeTruthy());
  await user.click(within(detail()).getByRole("button", { name: "删除" }));
  expect(within(screen.getByRole("dialog")).getByText(/删除后没有当前模板/)).toBeTruthy();
});

test("删除失败时弹窗留着说明原因，列表不变", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "delete_resume_template_cmd") throw { code: "IO", message: "写不进去。" };
    return overview;
  }, pickers(null, null));
  await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "删除" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认删除" }));
  expect(await within(screen.getByRole("dialog")).findByText("写不进去。")).toBeTruthy();
  expect(screen.getByRole("listitem", { name: "校招简历" })).toBeTruthy();
});

test("Escape 关掉弹窗，不执行操作", async () => {
  const user = userEvent.setup();
  const calls = mount(() => overview, pickers(null, null));
  await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "删除" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((c) => c.command === "delete_resume_template_cmd")).toBe(false);
});

test("设为当前", async () => {
  const user = userEvent.setup();
  const calls = mount((command) =>
    command === "set_active_resume_template_cmd" ? { ...overview, activeTemplateId: "t1" } : overview,
  pickers(null, null));
  const row = await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "设为当前" }));
  await waitFor(() => expect(within(row).getByText("当前模板")).toBeTruthy());
  expect(within(detail()).getByText("填写时优先使用")).toBeTruthy();
  expect(calls.find((c) => c.command === "set_active_resume_template_cmd")?.args).toEqual({ id: "t1" });
});

test("预览按原始分组显示字段", async () => {
  const user = userEvent.setup();
  mount(() => overview, pickers(null, null));
  await choose(user, "校招简历");
  expect(await within(detail()).findByText("张三")).toBeTruthy();
  expect(within(detail()).getByRole("heading", { name: "基本信息" })).toBeTruthy();
  expect(within(detail()).getByText("1 个字段")).toBeTruthy();
});

test("预览读取失败时在详情里显示错误和重试", async () => {
  const user = userEvent.setup();
  let attempts = 0;
  mount((command, args) => {
    if (command === "get_resume_template_cmd") {
      attempts += 1;
      if (attempts === 1) throw { code: "IO", message: "预览读不出来。" };
      return templateView(String(args?.id), "重试后的内容");
    }
    return overview;
  }, pickers(null, null));
  expect(await within(detail()).findByText("预览读不出来。")).toBeTruthy();
  await user.click(within(detail()).getByRole("button", { name: "重试" }));
  expect(await within(detail()).findByText("重试后的内容")).toBeTruthy();
});

test("命令报错时如实显示", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "import_resume_template_cmd") throw { code: "SHEET_INVALID", message: "第 3 行缺少「字段名」（第二列）。" };
    return overview;
  }, pickers("/tmp/a.xlsx", null));
  await screen.findByRole("listitem", { name: "实习简历" });
  await user.click(screen.getByRole("button", { name: "导入 Excel" }));
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
  expect(screen.queryByText("读取模板失败，请重试。")).toBeNull();
});

test("新建（非覆盖）导入失败时补一句「本次导入未生效。」", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "import_resume_template_cmd") throw { code: "SHEET_INVALID", message: "第 3 行缺少「字段名」（第二列）。" };
    return overview;
  }, pickers("/tmp/a.xlsx", null));
  await screen.findByRole("listitem", { name: "实习简历" });
  await user.click(screen.getByRole("button", { name: "导入 Excel" }));
  expect(await screen.findByText("第 3 行缺少「字段名」（第二列）。本次导入未生效。")).toBeTruthy();
});

test("重新导入失败时补一句「本次导入未生效，原模板保持不变。」", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "import_resume_template_cmd") throw { code: "SHEET_INVALID", message: "第 3 行缺少「字段名」（第二列）。" };
    return overview;
  }, pickers("/tmp/改.xlsx", null));
  await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "重新导入" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "继续选文件" }));
  expect(await screen.findByText("第 3 行缺少「字段名」（第二列）。本次导入未生效，原模板保持不变。")).toBeTruthy();
});

test.each([false, true])("预览打开时重新导入，预览跟着刷新而不是留着旧内容（StrictMode: %s）", async (strict) => {
  const user = userEvent.setup();
  let reimported = false;
  let currentOverview = overview;
  const calls = mount((command, args) => {
    if (command === "resume_overview_cmd") return currentOverview;
    if (command === "get_resume_template_cmd") return templateView(String(args?.id), reimported && args?.id === "t1" ? "新内容" : "旧内容");
    if (command === "import_resume_template_cmd") {
      reimported = true;
      currentOverview = {
        templates: [overview.templates[0], { ...overview.templates[1], fieldCount: 14, updatedAt: "2026-09-23T01:00:00Z" }],
        activeTemplateId: currentOverview.activeTemplateId,
      };
      return { template: { id: "t1", name: "校招简历", fieldCount: 14, updatedAt: "2026-09-23T01:00:00Z" }, previousFieldCount: 12, skippedSecretFields: 0 };
    }
    return currentOverview;
  }, pickers("/tmp/改.xlsx", null), { strict });

  await choose(user, "校招简历");
  expect(await within(detail()).findByText("旧内容")).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = calls.filter((c) => c.command === "get_resume_template_cmd" && c.args?.id === "t1").length;

  await user.click(within(detail()).getByRole("button", { name: "重新导入" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "继续选文件" }));
  await waitFor(() => expect(within(detail()).getByText("新内容")).toBeTruthy());
  expect(within(detail()).queryByText("旧内容")).toBeNull();
  // 重新导入后只多读一次；StrictMode 下也不能多拉。
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls.filter((c) => c.command === "get_resume_template_cmd" && c.args?.id === "t1")).toHaveLength(before + 1);
});

test("改名被拒绝时弹窗和输入都留着、显示原因", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "rename_resume_template_cmd") throw { code: "VALIDATION", message: "已有同名模板「实习简历」，换个名字吧。" };
    return overview;
  }, pickers(null, null));
  await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "重命名" }));
  const dialog = screen.getByRole("dialog", { name: "重命名模板" });
  const input = within(dialog).getByLabelText("模板名称");
  expect(input).toHaveProperty("value", "校招简历");
  expect(document.activeElement).toBe(input);
  await user.clear(input);
  await user.type(input, "实习简历");
  await user.click(within(dialog).getByRole("button", { name: "保存名称" }));
  expect(await within(dialog).findByText("已有同名模板「实习简历」，换个名字吧。")).toBeTruthy();
  expect(within(screen.getByRole("dialog")).getByLabelText("模板名称")).toHaveProperty("value", "实习简历");
});

test("改名成功后弹窗关闭，按回车也能提交", async () => {
  const user = userEvent.setup();
  const calls = mount((command) => (command === "rename_resume_template_cmd" ? { ok: true } : overview), pickers(null, null));
  await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "重命名" }));
  const input = within(screen.getByRole("dialog")).getByLabelText("模板名称");
  await user.clear(input);
  await user.type(input, "新名字{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls.find((c) => c.command === "rename_resume_template_cmd")?.args).toEqual({ id: "t1", name: "新名字" });
  expect(screen.getByText("已改名。")).toBeTruthy();
});

test("重命名的名称为空或超过 100 字时不能提交", async () => {
  const user = userEvent.setup();
  mount(() => overview, pickers(null, null));
  await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "重命名" }));
  const dialog = screen.getByRole("dialog");
  const input = within(dialog).getByLabelText("模板名称");
  await user.clear(input);
  expect(within(dialog).getByRole("button", { name: "保存名称" })).toHaveProperty("disabled", true);
  await user.click(input);
  await user.paste("字".repeat(101));
  expect(within(dialog).getByText("名称最多 100 字。")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "保存名称" })).toHaveProperty("disabled", true);
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
  await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "设为当前" }));
  await waitFor(() => expect(screen.getByText("模板已被删除。")).toBeTruthy());
  await waitFor(() => expect(overviewCalls).toBeGreaterThanOrEqual(2));
});

test("提示带 role=status", async () => {
  const user = userEvent.setup();
  mount((command) =>
    command === "set_active_resume_template_cmd" ? { ...overview, activeTemplateId: "t1" } : overview,
  pickers(null, null));
  await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "设为当前" }));
  expect(await screen.findByRole("status")).toBeTruthy();
});

test("外层要求刷新时重读列表并选中指定模板", async () => {
  let current = overview;
  const calls: string[] = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push(command);
    if (command === "get_resume_template_cmd") return templateView(String(args?.id));
    return current;
  }) as Invoke;
  const view = (token: number, select?: string) => (
    <InvokeProvider invoke={invoke}>
      <TemplateList pickers={null} reloadSignal={{ token, select }} />
    </InvokeProvider>
  );
  const { rerender } = render(view(0));
  await screen.findByRole("listitem", { name: "实习简历" });
  current = { templates: [...overview.templates, { id: "t9", name: "AI 解析", fieldCount: 3, updatedAt: "" }], activeTemplateId: "t9" };
  rerender(view(1, "t9"));
  await waitFor(() => expect(within(detail()).getByRole("heading", { name: "AI 解析" })).toBeTruthy());
  expect(calls.filter((c) => c === "resume_overview_cmd")).toHaveLength(2);
});

test("重新进入页面的刷新清掉上一次的操作提示；为选中新模板的刷新不清", async () => {
  const user = userEvent.setup();
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    if (command === "get_resume_template_cmd") return templateView(String(args?.id));
    if (command === "set_active_resume_template_cmd") return { ...overview, activeTemplateId: "t1" };
    return overview;
  }) as Invoke;
  const view = (token: number, select?: string) => (
    <InvokeProvider invoke={invoke}>
      <TemplateList pickers={null} reloadSignal={{ token, select }} />
    </InvokeProvider>
  );
  const { rerender } = render(view(0));
  await choose(user, "校招简历");
  await user.click(within(detail()).getByRole("button", { name: "设为当前" }));
  expect(await screen.findByText(/已把「校招简历」设为当前模板/)).toBeTruthy();
  rerender(view(1, "t2"));
  await waitFor(() => expect(within(detail()).getByRole("heading", { name: "实习简历" })).toBeTruthy());
  expect(screen.getByText(/已把「校招简历」设为当前模板/)).toBeTruthy();
  rerender(view(2));
  await waitFor(() => expect(screen.queryByText(/已把「校招简历」设为当前模板/)).toBeNull());
});
