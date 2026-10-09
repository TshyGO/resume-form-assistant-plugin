import { afterEach, expect, test } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiSettingsView, Invoke, ProfileRecordView, ResumeOverview } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { mountResume } from "./mount.tsx";
import { ResumeView } from "./ResumeView.tsx";
import type { ResumeLeaveGate } from "./ResumeView.tsx";

const overviewOf = (name: string): ResumeOverview => ({
  templates: [{ id: "t1", name, fieldCount: 1, updatedAt: "2026-09-23T00:00:00Z" }],
  activeTemplateId: "t1",
});

const profileOf = (name: string, revision: number): ProfileRecordView => ({
  profile: { values: { name }, family: [], custom: [] },
  revision,
});

const templateOf = (id: string) => ({ id, name: "模板", updatedAt: "", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "张三" }] }] });

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function mountHandle(invoke: Invoke) {
  const container = document.createElement("div");
  document.body.append(container);
  let handle!: ReturnType<typeof mountResume>;
  act(() => {
    handle = mountResume(container, invoke, null);
  });
  cleanup = () => {
    act(() => handle.unmount());
    container.remove();
  };
  return { handle, view: within(container as HTMLElement) };
}

// 恢复备份会整库换掉档案；简历页只挂载一次的话会留着旧的列表和旧的「我的信息」版本号，
// 接着保存就可能盖掉刚恢复回来的内容。refresh() 要让两块都重新读一遍。
test("refresh 让模板列表与「我的信息」都重新读取", async () => {
  let restored = false;
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    if (command === "resume_overview_cmd") return overviewOf(restored ? "恢复后的模板" : "旧模板");
    if (command === "get_profile_cmd") return restored ? profileOf("恢复后", 7) : profileOf("旧名字", 3);
    if (command === "get_resume_template_cmd") return templateOf(String(args?.id));
    if (command === "list_legacy_imports_cmd") return [];
    throw { code: "UNEXPECTED", message: command };
  }) as Invoke;
  const { handle, view } = mountHandle(invoke);
  expect(await view.findByRole("listitem", { name: "旧模板" })).toBeTruthy();
  expect(await view.findByDisplayValue("旧名字")).toBeTruthy();

  restored = true;
  act(() => handle.refresh());

  expect(await view.findByRole("listitem", { name: "恢复后的模板" })).toBeTruthy();
  await waitFor(() => expect(view.getByDisplayValue("恢复后")).toBeTruthy());
  expect(view.queryByRole("listitem", { name: "旧模板" })).toBeNull();
});

function baseInvoke(extra: (command: string, args?: Record<string, unknown>) => unknown = () => undefined) {
  const calls: string[] = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push(command);
    const answer = extra(command, args);
    if (answer !== undefined) return answer;
    if (command === "resume_overview_cmd") return overviewOf("校招简历");
    if (command === "get_profile_cmd") return profileOf("张三", 3);
    if (command === "get_resume_template_cmd") return templateOf(String(args?.id));
    if (command === "list_legacy_imports_cmd") return [];
    throw { code: "UNEXPECTED", message: command };
  }) as Invoke;
  return { invoke, calls };
}

function renderView(invoke: Invoke, gate?: { current: ResumeLeaveGate }, extract?: (file: File) => Promise<string>) {
  return render(
    <InvokeProvider invoke={invoke}>
      <ResumeView pickers={null} gate={gate} extract={extract} />
    </InvokeProvider>,
  );
}

test("两个视图共用页眉；切换只换工作区，不清空「我的信息」草稿", async () => {
  const user = userEvent.setup();
  const { invoke, calls } = baseInvoke();
  renderView(invoke);
  expect(screen.getByRole("heading", { name: "简历资料", level: 1 })).toBeTruthy();
  const templatesTab = screen.getByRole("tab", { name: "简历模板" });
  expect(templatesTab.getAttribute("aria-selected")).toBe("true");
  expect(await screen.findByRole("listitem", { name: "校招简历" })).toBeTruthy();

  await user.click(screen.getByRole("tab", { name: "我的信息" }));
  expect(screen.queryByRole("listitem", { name: "校招简历" })).toBeNull();
  const name = await screen.findByRole("textbox", { name: "姓名" });
  await user.type(name, "五");
  const profileReads = calls.filter((c) => c === "get_profile_cmd").length;

  await user.click(templatesTab);
  expect(screen.getByRole("listitem", { name: "校招简历" })).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "我的信息" }));
  expect(screen.getByRole("textbox", { name: "姓名" })).toHaveProperty("value", "张三五");
  expect(calls.filter((c) => c === "get_profile_cmd").length).toBe(profileReads);
});

test("切换控件支持方向键", async () => {
  const user = userEvent.setup();
  const { invoke } = baseInvoke();
  renderView(invoke);
  const templatesTab = screen.getByRole("tab", { name: "简历模板" });
  templatesTab.focus();
  await user.keyboard("{ArrowRight}");
  const profileTab = screen.getByRole("tab", { name: "我的信息" });
  expect(profileTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(profileTab);
});

test("「我的信息」没有修改时直接允许离开", async () => {
  const { invoke } = baseInvoke();
  const gate = { current: {} as ResumeLeaveGate };
  renderView(invoke, gate);
  await screen.findByDisplayValue("张三");
  await expect(gate.current.confirmLeave!()).resolves.toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("有未保存修改时离开要确认：继续编辑保留草稿，放弃并离开才放行", async () => {
  const user = userEvent.setup();
  const { invoke } = baseInvoke();
  const gate = { current: {} as ResumeLeaveGate };
  renderView(invoke, gate);
  await user.click(screen.getByRole("tab", { name: "我的信息" }));
  await user.type(await screen.findByRole("textbox", { name: "姓名" }), "五");

  let first!: Promise<boolean>;
  act(() => {
    first = gate.current.confirmLeave!();
  });
  const dialog = await screen.findByRole("dialog", { name: "放弃当前草稿？" });
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "继续编辑" }));
  await user.click(within(dialog).getByRole("button", { name: "继续编辑" }));
  await expect(first).resolves.toBe(false);
  expect(screen.getByRole("textbox", { name: "姓名" })).toHaveProperty("value", "张三五");

  let second!: Promise<boolean>;
  act(() => {
    second = gate.current.confirmLeave!();
  });
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "放弃并离开" }));
  await expect(second).resolves.toBe(true);
});

test("AI 解析在后台进行时，在「我的信息」里仍能看到进行中的提示", async () => {
  const user = userEvent.setup();
  const settings: AiSettingsView = {
    providers: [{ id: "p1", name: "示例", apiUrl: "https://api.example.com", model: "m", host: "api.example.com", keyConfigured: true }],
    activeProviderId: "p1",
    credentialError: null,
  };
  const { invoke } = baseInvoke((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "ai_complete_cmd") return new Promise(() => {});
    return undefined;
  });
  renderView(invoke, undefined, async () => "张三");
  await screen.findByRole("listitem", { name: "校招简历" });
  await user.upload(screen.getByLabelText(/上传简历/), new File(["x"], "简历.pdf"));
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  await user.click(await screen.findByRole("button", { name: "在后台继续" }));
  await user.click(screen.getByRole("tab", { name: "我的信息" }));
  expect(screen.getByRole("tab", { name: /简历模板.*AI 解析进行中/ })).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: /简历模板/ }));
  expect(screen.getByRole("group", { name: "AI 解析进度" })).toBeTruthy();
});

test("同一时间只显示一个弹窗：后打开的排在后面", async () => {
  const user = userEvent.setup();
  const { invoke } = baseInvoke();
  const gate = { current: {} as ResumeLeaveGate };
  renderView(invoke, gate);
  await user.click(screen.getByRole("tab", { name: "我的信息" }));
  await user.type(await screen.findByRole("textbox", { name: "姓名" }), "五");
  await user.click(screen.getByRole("tab", { name: "简历模板" }));
  await screen.findByRole("heading", { name: "校招简历", level: 2 });
  await user.click(screen.getByRole("button", { name: "删除" }));
  expect(screen.getByRole("dialog", { name: "删除「校招简历」？" })).toBeTruthy();
  let leave!: Promise<boolean>;
  act(() => {
    leave = gate.current.confirmLeave!();
  });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(await screen.findByRole("dialog", { name: "放弃当前草稿？" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "继续编辑" }));
  await expect(leave).resolves.toBe(false);
});
