import { expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiSettingsView, Invoke } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { AiSettings } from "./AiSettings.tsx";

const view: AiSettingsView = {
  providers: [
    { id: "p1", name: "DeepSeek", apiUrl: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat", host: "api.deepseek.com", keyConfigured: true },
    { id: "p2", name: "通义千问", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-plus", host: "dashscope.aliyuncs.com", keyConfigured: false },
  ],
  activeProviderId: "p1",
  credentialError: null,
};

function mount(handler: (command: string, args?: Record<string, unknown>) => unknown) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <AiSettings />
    </InvokeProvider>,
  );
  return calls;
}

test("列出服务商，标出当前使用、主机、模型、Key 状态", async () => {
  mount(() => view);
  const current = await screen.findByRole("listitem", { name: /DeepSeek/ });
  expect(within(current).getByText("当前使用")).toBeTruthy();
  expect(within(current).getByText(/api\.deepseek\.com/)).toBeTruthy();
  const other = screen.getByRole("listitem", { name: /通义千问/ });
  expect(within(other).getByText(/没有 Key/)).toBeTruthy();
});

test("没有服务商时引导从预设添加", async () => {
  mount(() => ({ providers: [], activeProviderId: null, credentialError: null }));
  expect(await screen.findByText(/还没有配置 AI 服务商/)).toBeTruthy();
  expect(screen.getByLabelText("从预设添加")).toBeTruthy();
});

test("切换当前使用", async () => {
  const user = userEvent.setup();
  const calls = mount((command) => (command === "set_active_ai_provider_cmd" ? { ...view, activeProviderId: "p2" } : view));
  const other = await screen.findByRole("listitem", { name: /通义千问/ });
  await user.click(within(other).getByRole("button", { name: "设为当前" }));
  await waitFor(() => expect(within(other).getByText("当前使用")).toBeTruthy());
  expect(calls.find((c) => c.command === "set_active_ai_provider_cmd")?.args).toEqual({ id: "p2" });
});

test("从预设新建会打开编辑器并预填地址", async () => {
  const user = userEvent.setup();
  mount(() => view);
  await screen.findByRole("listitem", { name: /DeepSeek/ });
  await user.selectOptions(screen.getByLabelText("从预设添加"), "kimi");
  await user.click(screen.getByRole("button", { name: "添加" }));
  expect(screen.getByLabelText("接口地址")).toHaveProperty("value", "https://api.moonshot.cn/v1");
});

test("删除要确认，删掉的服务商连 Key 一起删", async () => {
  const user = userEvent.setup();
  const calls = mount((command) =>
    command === "delete_ai_provider_cmd" ? { ...view, providers: [view.providers[0]] } : view,
  );
  const other = await screen.findByRole("listitem", { name: /通义千问/ });
  await user.click(within(other).getByRole("button", { name: "删除" }));
  expect(calls.some((c) => c.command === "delete_ai_provider_cmd")).toBe(false);
  expect(within(other).getByText(/Key 也会一起删除/)).toBeTruthy();
  await user.click(within(other).getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(screen.queryByRole("listitem", { name: /通义千问/ })).toBeNull());
});

test("保存后主机变了、Key 被清掉，提醒重新填", async () => {
  const user = userEvent.setup();
  mount((command) =>
    command === "save_ai_provider_cmd" ? { view, providerId: "p1", keyCleared: true } : view,
  );
  const row = await screen.findByRole("listitem", { name: /DeepSeek/ });
  await user.click(within(row).getByRole("button", { name: "编辑" }));
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByText(/换了主机，原来的 Key 已清除/)).toBeTruthy();
});

test("清除 Key 后编辑器立即显示新的 Key 状态", async () => {
  const user = userEvent.setup();
  mount((command) => command === "clear_ai_key_cmd"
    ? { ...view, providers: [{ ...view.providers[0], keyConfigured: false }, view.providers[1]] }
    : view);
  const row = await screen.findByRole("listitem", { name: /DeepSeek/ });
  await user.click(within(row).getByRole("button", { name: "编辑" }));
  await user.click(screen.getByRole("button", { name: "清除 Key" }));
  await user.click(screen.getByRole("button", { name: "确认清除" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "清除 Key" })).toBeNull());
  expect(screen.getAllByText(/还没有 Key/).length).toBeGreaterThan(0);
});

test("没连上桌面宿主时如实说明", async () => {
  render(
    <InvokeProvider invoke={null}>
      <AiSettings />
    </InvokeProvider>,
  );
  expect(screen.getByText(/没连上桌面宿主/)).toBeTruthy();
});
