import { expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Invoke, ResumeOverview, ResumeTemplateView } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import type { DesktopEvent } from "./LegacyImport.tsx";
import { TemplateList } from "./TemplateList.tsx";

// #273：桌面模板详情里的字段编辑。数据全是虚构的。
const baseOverview: ResumeOverview = {
  templates: [
    { id: "t1", name: "校招简历", fieldCount: 3, updatedAt: "2026-10-01T00:00:00.000Z" },
    { id: "t2", name: "实习简历", fieldCount: 1, updatedAt: "2026-09-01T00:00:00.000Z" },
  ],
  activeTemplateId: "t1",
};

const original = (): ResumeTemplateView => ({
  id: "t1",
  name: "校招简历",
  updatedAt: "2026-10-01T00:00:00.000Z",
  contentSha256: "a".repeat(64),
  groups: [
    { name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }, { key: "电话", value: "13800000000" }] },
    { name: "教育经历", fields: [{ key: "学校", value: "示例大学" }] },
  ],
});

type Handler = (command: string, args?: Record<string, unknown>) => unknown;

// 每次都回新对象，和真实的 invoke 一样（同一个引用 React 会当作没变）。
let overview: ResumeOverview = structuredClone(baseOverview);

function mount(handler: Handler = () => undefined) {
  overview = structuredClone(baseOverview);
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const listeners = new Map<string, (event?: DesktopEvent) => void>();
  let template = original();
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    const answer = handler(command, args);
    if (answer instanceof Error) throw answer;
    if (answer !== undefined) return answer;
    if (command === "resume_overview_cmd") return structuredClone(overview);
    if (command === "get_resume_template_cmd") return args?.id === "t1" ? template : { ...original(), id: "t2", name: "实习简历" };
    if (command === "get_profile_cmd") return { profile: { values: {}, family: [], custom: [{ key: "电话", value: "13900000000" }] }, revision: 1 };
    if (command === "save_resume_template_fields_cmd") {
      template = { ...template, groups: args?.groups as ResumeTemplateView["groups"], contentSha256: "b".repeat(64), updatedAt: "2026-10-12T00:00:00.000Z" };
      return template;
    }
    return undefined;
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <TemplateList
        pickers={{ open: async () => null, save: async () => "/tmp/导出.xlsx" }}
        listen={(name, handler) => {
          listeners.set(name, handler);
          return () => listeners.delete(name);
        }}
      />
    </InvokeProvider>,
  );
  return { calls, listeners, setTemplate: (next: ResumeTemplateView) => { template = next; } };
}

const detail = () => screen.getByRole("region", { name: "模板详情" });
const row = (name: string) => within(detail()).getByRole("group", { name });

async function startEditing(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(within(detail()).getByText("示例大学")).toBeTruthy());
  await user.click(within(detail()).getByRole("button", { name: "编辑字段" }));
  await waitFor(() => expect(within(detail()).getByText("正在编辑这份模板 · 3 个字段")).toBeTruthy());
}

test("编辑、调整分类、在新分类里添加、确认删除，保存只改这份模板，之后可直接导出 Excel", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await startEditing(user);
  expect(within(detail()).getByText(/修改只作用于「校招简历」/)).toBeTruthy();
  expect((within(detail()).getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled).toBe(true);
  // 编辑期间不能切到别的模板。
  expect((within(screen.getByRole("listitem", { name: "实习简历" })).getByRole("button") as HTMLButtonElement).disabled).toBe(true);

  const name = within(row("姓名")).getByLabelText("内容");
  await user.clear(name);
  await user.type(name, "测试用户乙");
  await user.selectOptions(within(row("学校")).getByLabelText("所属分类"), "基本信息");

  await user.click(within(detail()).getByRole("button", { name: "添加字段" }));
  const add = await screen.findByRole("dialog", { name: "添加字段到「校招简历」" });
  await user.selectOptions(within(add).getByLabelText("所属分类"), "＋ 新建分类…");
  await user.type(within(add).getByLabelText("新分类名称"), "求职意向");
  await user.type(within(add).getByLabelText("字段名称"), "期望城市");
  await user.type(within(add).getByLabelText("内容"), "示例城市");
  await user.click(within(add).getByRole("button", { name: "添加到草稿" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(within(detail()).getByRole("region", { name: "分类：求职意向" })).toBeTruthy();

  await user.click(within(row("电话")).getByRole("button", { name: "删除「电话」" }));
  const confirm = await screen.findByRole("dialog", { name: "删除「电话」？" });
  expect(within(confirm).getByText(/只从「校招简历」删除这个字段/)).toBeTruthy();
  expect(within(confirm).getByText(/「我的信息」里还有同名字段，一键填写时仍可能用它/)).toBeTruthy();
  await user.click(within(confirm).getByRole("button", { name: "从草稿中删除" }));
  await waitFor(() => expect(within(detail()).getByText(/已删除或改名的 「电话」 在「我的信息」里仍有同名内容/)).toBeTruthy());
  expect(within(detail()).getByText(/没有字段的分类不会保存：「教育经历」/)).toBeTruthy();

  await user.click(within(detail()).getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(within(detail()).getByRole("button", { name: "导出最新 Excel" })).toBeTruthy());
  const save = calls.find((call) => call.command === "save_resume_template_fields_cmd");
  expect(save?.args).toEqual({
    id: "t1",
    baseSha256: "a".repeat(64),
    groups: [
      { name: "基本信息", fields: [{ key: "姓名", value: "测试用户乙" }, { key: "学校", value: "示例大学" }] },
      { name: "求职意向", fields: [{ key: "期望城市", value: "示例城市" }] },
    ],
  });
  expect(screen.getByText(/已保存「校招简历」的字段修改。插件填写、搜索和复制会使用新内容/)).toBeTruthy();
  const saved = within(detail()).getByText(/之前下载或导入过的 Excel 不会自动更新/);
  expect(saved.textContent).toMatch(/不含「我的信息」/);
  // 预览已经是新内容。
  expect(within(detail()).getByText("期望城市")).toBeTruthy();
  await user.click(within(detail()).getByRole("button", { name: "导出最新 Excel" }));
  await waitFor(() => expect(calls.some((call) => call.command === "export_resume_template_cmd" && call.args?.id === "t1")).toBe(true));
  // 只保存了 t1，「我的信息」没有被写。
  expect(calls.filter((call) => call.command === "save_resume_template_fields_cmd").map((call) => call.args?.id)).toEqual(["t1"]);
  expect(calls.some((call) => call.command === "save_profile_cmd")).toBe(false);
});

test("有修改时取消要先确认；放弃后不保存，再进来是已保存的内容", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await startEditing(user);
  await user.type(within(row("姓名")).getByLabelText("字段名称"), "（中文）");
  await user.click(within(detail()).getByRole("button", { name: "取消" }));
  const ask = await screen.findByRole("dialog", { name: "放弃对「校招简历」的修改？" });
  await user.click(within(ask).getByRole("button", { name: "继续编辑" }));
  expect((within(row("姓名（中文）")).getByLabelText("字段名称") as HTMLInputElement).value).toBe("姓名（中文）");
  await user.click(within(detail()).getByRole("button", { name: "取消" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(within(detail()).getByRole("button", { name: "编辑字段" })).toBeTruthy());
  expect(calls.some((call) => call.command === "save_resume_template_fields_cmd")).toBe(false);
  await startEditing(user);
  expect(row("姓名")).toBeTruthy();
});

test("保存失败或被拒，草稿原样保留并说明原因", async () => {
  const user = userEvent.setup();
  let fail = true;
  const { calls } = mount((command) => {
    if (command === "save_resume_template_fields_cmd" && fail) {
      return Object.assign(new Error("「备注」看起来是密码或验证码，这类内容不存进模板（档案会随备份带走）。"), { code: "VALIDATION" });
    }
    return undefined;
  });
  await startEditing(user);
  const value = within(row("姓名")).getByLabelText("内容");
  await user.clear(value);
  await user.type(value, "失败也不丢");
  await user.click(within(detail()).getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(within(detail()).getByText(/看起来是密码或验证码.*修改还在/)).toBeTruthy());
  expect((within(row("姓名")).getByLabelText("内容") as HTMLTextAreaElement).value).toBe("失败也不丢");
  fail = false;
  await user.click(within(detail()).getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(within(detail()).getByRole("button", { name: "导出最新 Excel" })).toBeTruthy());
  expect(calls.filter((call) => call.command === "save_resume_template_fields_cmd")).toHaveLength(2);
});

test("本地校验拦住空字段名和密码类字段名，不发给存储层", async () => {
  const user = userEvent.setup();
  const { calls } = mount();
  await startEditing(user);
  await user.clear(within(row("电话")).getByLabelText("字段名称"));
  await user.type(within(row("未命名字段")).getByLabelText("字段名称"), "邮箱密码");
  await user.click(within(detail()).getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(within(row("邮箱密码")).getByText(/密码或验证码/)).toBeTruthy());
  expect(within(row("邮箱密码")).getByLabelText("字段名称").getAttribute("aria-invalid")).toBe("true");
  expect(calls.some((call) => call.command === "save_resume_template_fields_cmd")).toBe(false);
});

test("别处改过时不覆盖：可以明确选择用自己的修改覆盖（以最新版本为基准）", async () => {
  const user = userEvent.setup();
  let conflict = true;
  const { calls, setTemplate } = mount((command) => {
    if (command === "save_resume_template_fields_cmd" && conflict) {
      conflict = false;
      setTemplate({ ...original(), contentSha256: "c".repeat(64), groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "插件端改的" }] }] });
      return Object.assign(new Error("这份模板已在别处修改，请先查看最新内容再保存。"), { code: "CONFLICT" });
    }
    return undefined;
  });
  await startEditing(user);
  const value = within(row("姓名")).getByLabelText("内容");
  await user.clear(value);
  await user.type(value, "桌面端改的");
  await user.click(within(detail()).getByRole("button", { name: "保存修改" }));
  const dialog = await screen.findByRole("dialog", { name: "这份模板已在别处修改" });
  expect(within(dialog).getByText(/这次没有保存，你的修改还在/)).toBeTruthy();
  expect(within(dialog).getByText(/最新内容：1 个字段 · 你的草稿：3 个字段/)).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "用我的修改覆盖" }));
  await waitFor(() => expect(within(detail()).getByRole("button", { name: "导出最新 Excel" })).toBeTruthy());
  const saves = calls.filter((call) => call.command === "save_resume_template_fields_cmd");
  expect(saves.map((call) => call.args?.baseSha256)).toEqual(["a".repeat(64), "c".repeat(64)]);
  expect((saves[1].args?.groups as Array<{ fields: Array<{ value: string }> }>)[0].fields[0].value).toBe("桌面端改的");
});

test("别处改过时也可以放弃自己的修改，载入最新内容", async () => {
  const user = userEvent.setup();
  const { setTemplate } = mount((command) => {
    if (command === "save_resume_template_fields_cmd") {
      setTemplate({ ...original(), contentSha256: "c".repeat(64), groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "插件端改的" }] }] });
      return Object.assign(new Error("conflict"), { code: "CONFLICT" });
    }
    return undefined;
  });
  await startEditing(user);
  await user.type(within(row("姓名")).getByLabelText("内容"), "！");
  await user.click(within(detail()).getByRole("button", { name: "保存修改" }));
  const dialog = await screen.findByRole("dialog", { name: "这份模板已在别处修改" });
  await user.click(within(dialog).getByRole("button", { name: "放弃我的修改，载入最新内容" }));
  await waitFor(() => expect((within(row("姓名")).getByLabelText("内容") as HTMLTextAreaElement).value).toBe("插件端改的"));
  expect((within(detail()).getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled).toBe(true);
});

test("编辑期间被删除：说明无法保存，可以关闭编辑", async () => {
  const user = userEvent.setup();
  mount((command) => (command === "save_resume_template_fields_cmd" ? Object.assign(new Error("gone"), { code: "NOT_FOUND" }) : undefined));
  await startEditing(user);
  await user.type(within(row("姓名")).getByLabelText("内容"), "！");
  await user.click(within(detail()).getByRole("button", { name: "保存修改" }));
  const dialog = await screen.findByRole("dialog", { name: "这份模板已被删除" });
  expect(within(dialog).queryByRole("button", { name: "用我的修改覆盖" })).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "关闭编辑" }));
  await waitFor(() => expect(within(detail()).getByRole("button", { name: "编辑字段" })).toBeTruthy());
});

test("插件保存后列表和预览跟着更新；正在编辑时先提示，草稿不动", async () => {
  const user = userEvent.setup();
  const { calls, listeners, setTemplate } = mount();
  await waitFor(() => expect(listeners.has("resume-template-changed")).toBe(true));
  await waitFor(() => expect(within(detail()).getByText("示例大学")).toBeTruthy());
  // 没在编辑：插件一保存，预览就换成新内容。
  const before = calls.filter((call) => call.command === "resume_overview_cmd").length;
  setTemplate({ ...original(), contentSha256: "d".repeat(64), groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "插件端改的" }] }] });
  overview.templates[0] = { ...overview.templates[0], updatedAt: "2026-10-12T01:00:00.000Z", fieldCount: 1 };
  listeners.get("resume-template-changed")?.({ payload: { templateId: "t1", op: "saveTemplate", source: "plugin" } });
  await waitFor(() => expect(within(detail()).getByText("插件端改的")).toBeTruthy());
  expect(calls.filter((call) => call.command === "resume_overview_cmd").length).toBe(before + 1);

  await user.click(within(detail()).getByRole("button", { name: "编辑字段" }));
  await waitFor(() => expect(within(detail()).getByText(/正在编辑这份模板/)).toBeTruthy());
  await user.type(within(row("姓名")).getByLabelText("内容"), "（草稿）");
  setTemplate({ ...original(), contentSha256: "e".repeat(64), groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "插件端又改了" }] }] });
  overview.templates[0] = { ...overview.templates[0], updatedAt: "2026-10-12T02:00:00.000Z" };
  listeners.get("resume-template-changed")?.({ payload: { templateId: "t1", op: "saveTemplate", source: "plugin" } });
  await waitFor(() => expect(within(detail()).getByText(/这份模板刚在别处（例如插件侧边栏）更新过/)).toBeTruthy());
  expect((within(row("姓名")).getByLabelText("内容") as HTMLTextAreaElement).value).toBe("插件端改的（草稿）");
});
