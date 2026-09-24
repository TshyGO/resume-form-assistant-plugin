import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiSettingsView, Invoke } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { ResumeParse } from "./ResumeParse.tsx";

const settings: AiSettingsView = {
  providers: [{ id: "p1", name: "DeepSeek", apiUrl: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat", host: "api.deepseek.com", keyConfigured: true }],
  activeProviderId: "p1",
  credentialError: null,
};

function mount(handler: (command: string, args?: Record<string, unknown>) => unknown) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  const onCreated = vi.fn();
  render(
    <InvokeProvider invoke={invoke}>
      <ResumeParse onCreated={onCreated} extract={async () => "张三\n某大学"} />
    </InvokeProvider>,
  );
  return { calls, onCreated };
}

const upload = async (user: ReturnType<typeof userEvent.setup>) =>
  user.upload(screen.getByLabelText("选择简历文件"), new File(["x"], "张三简历.pdf"));

test("确认前说清楚发给谁、发多少字，确认后才发送", async () => {
  const user = userEvent.setup();
  const { calls, onCreated } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "ai_complete_cmd") return '[{"group":"基本信息","key":"姓名","value":"张三"}]';
    return { template: { id: "t1", name: "张三简历（AI 解析）", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 0 };
  });
  await upload(user);
  expect(await screen.findByText(/DeepSeek/)).toBeTruthy();
  expect(screen.getByText(/api\.deepseek\.com · deepseek-chat/)).toBeTruthy();
  expect(screen.getByText(/6 字/)).toBeTruthy();
  expect(calls.some((c) => c.command === "ai_complete_cmd")).toBe(false);
  await user.click(screen.getByRole("button", { name: "发送并解析" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(screen.getByText("已存为模板「张三简历（AI 解析）」并设为当前，共 1 个字段。")).toBeTruthy();
  const created = calls.find((c) => c.command === "create_resume_template_cmd")!;
  expect(created.args).toEqual({ name: "张三简历（AI 解析）", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "张三" }] }] });
});

test("没有可用服务商时不让发送，并指向设置页", async () => {
  const user = userEvent.setup();
  mount((command) => (command === "get_ai_settings_cmd" ? { providers: [], activeProviderId: null, credentialError: null } : null));
  await upload(user);
  expect(await screen.findByText(/先在「设置 → AI」添加服务商/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "发送并解析" })).toBeNull();
});

test("等待中可以取消", async () => {
  const user = userEvent.setup();
  let release: (value: unknown) => void = () => {};
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "ai_complete_cmd") return new Promise((resolve) => { release = resolve; });
    if (command === "cancel_analysis_cmd") { release('[]'); return true; }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  await user.click(await screen.findByRole("button", { name: "取消" }));
  const cancel = calls.find((c) => c.command === "cancel_analysis_cmd")!;
  const sent = calls.find((c) => c.command === "ai_complete_cmd")!;
  expect(cancel.args?.requestId).toBe(sent.args?.requestId);
});

test("模型返回乱码时如实提示，不建模板", async () => {
  const user = userEvent.setup();
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "ai_complete_cmd") return "抱歉";
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  expect(await screen.findByText(/AI 返回格式异常/)).toBeTruthy();
  expect(calls.some((c) => c.command === "create_resume_template_cmd")).toBe(false);
});

test("剔掉的密码类字段要说出来", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "ai_complete_cmd") return '[{"group":"g","key":"k","value":"v"}]';
    return { template: { id: "t1", name: "n", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 2 };
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  expect(await screen.findByText(/另有 2 个像密码或验证码的字段没有存/)).toBeTruthy();
});
