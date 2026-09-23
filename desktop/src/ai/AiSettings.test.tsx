import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiProfileView, AiSettingsView, Invoke } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { AiSettings } from "./AiSettings.tsx";

const profile = (overrides: Partial<AiProfileView> = {}): AiProfileView => ({
  id: "a",
  name: "DeepSeek",
  apiUrl: "https://api.deepseek.com/v1/chat/completions",
  model: "deepseek-chat",
  keyConfigured: false,
  ...overrides,
});

const base: AiSettingsView = {
  activeId: "a",
  profiles: [profile()],
  apiUrl: "https://api.deepseek.com/v1/chat/completions",
  model: "deepseek-chat",
  host: "api.deepseek.com",
  keyConfigured: false,
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

test("读出当前配置后填进表单，Key 不回显", async () => {
  mount(() => ({ ...base, profiles: [profile({ keyConfigured: true })], keyConfigured: true }));
  await waitFor(() => expect(screen.getByLabelText("接口地址")).toHaveProperty("value", base.apiUrl));
  expect(screen.getByLabelText("模型名称")).toHaveProperty("value", "deepseek-chat");
  expect(screen.getByLabelText("API Key")).toHaveProperty("value", "");
  expect(screen.getByText("当前使用的配置：DeepSeek")).toBeTruthy();
  expect(screen.getByText(/不会显示/)).toBeTruthy();
});

test("保存并使用时带上刚输入的 Key，保存后输入框清空", async () => {
  const user = userEvent.setup();
  const typed = "https://api.deepseek.com";
  const saved: AiSettingsView = {
    ...base,
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
    profiles: [profile({ keyConfigured: true })],
    keyConfigured: true,
  };
  const calls = mount((command) =>
    command === "save_ai_profile_cmd"
      ? saved
      : { ...base, apiUrl: typed, profiles: [profile({ apiUrl: typed })] },
  );
  await waitFor(() => expect(screen.getByLabelText("接口地址")).toHaveProperty("value", "https://api.deepseek.com"));
  const input = screen.getByLabelText("API Key");
  await user.type(input, "sk-synthetic-value");
  await user.click(screen.getByRole("button", { name: "保存并使用" }));
  await waitFor(() => expect(screen.getByText(/补全为/)).toBeTruthy());
  expect(input).toHaveProperty("value", "");
  expect(document.body.textContent).not.toContain("sk-synthetic-value");
  const sent = calls.find((call) => call.command === "save_ai_profile_cmd");
  expect(sent?.args).toMatchObject({ apiUrl: "https://api.deepseek.com", key: "sk-synthetic-value", id: "a" });
});

test("新建配置不会把当前 Key 留在输入框里", async () => {
  const user = userEvent.setup();
  mount(() => base);
  const input = await screen.findByLabelText("API Key");
  await user.type(input, "sk-should-not-carry");
  await user.click(screen.getByRole("button", { name: "新建配置" }));
  expect(screen.getByLabelText("API Key")).toHaveProperty("value", "");
  expect(screen.getByLabelText("接口地址")).toHaveProperty("value", "");
});

test("获取模型失败时保留已填的模型，成功时要等用户选择才写入", async () => {
  const user = userEvent.setup();
  const calls = mount((command) => {
    if (command === "fetch_ai_models_cmd") {
      const args = calls.at(-1)?.args;
      if (args?.apiUrl === "https://slow.example/v1") {
        return { reason: "timeout", status: null, body: "", timeoutMs: 15000 };
      }
      return {
        reason: "http",
        status: 200,
        body: JSON.stringify({ data: [{ id: "gpt-4o-mini" }, { id: "text-embedding-3-small" }] }),
        timeoutMs: 15000,
      };
    }
    return base;
  });
  const model = await screen.findByLabelText("模型名称");
  expect(model).toHaveProperty("value", "deepseek-chat");
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  await waitFor(() => expect(screen.getByLabelText("从列表选择模型")).toBeTruthy());
  expect(model).toHaveProperty("value", "deepseek-chat");
  await user.selectOptions(screen.getByLabelText("从列表选择模型"), "gpt-4o-mini");
  expect(model).toHaveProperty("value", "gpt-4o-mini");

  const url = screen.getByLabelText("接口地址");
  await user.clear(url);
  await user.type(url, "https://slow.example/v1");
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  await waitFor(() => expect(screen.getByText(/超时/)).toBeTruthy());
  expect(model).toHaveProperty("value", "gpt-4o-mini");
  const fetched = calls.filter((call) => call.command === "fetch_ai_models_cmd");
  expect(fetched[0]?.args).toMatchObject({ profileId: "a" });
  expect(fetched[1]?.args).toMatchObject({ apiUrl: "https://slow.example/v1", profileId: "a" });
});

test("删除当前配置前要明确选择，确认后才把选择交给命令", async () => {
  const user = userEvent.setup();
  const other = profile({ id: "b", name: "OpenAI", apiUrl: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" });
  const withTwo: AiSettingsView = { ...base, profiles: [profile(), other] };
  const calls = mount(() => withTwo);
  await screen.findByRole("button", { name: "删除 DeepSeek" });
  await user.click(screen.getByRole("button", { name: "删除 DeepSeek" }));
  expect(screen.getByText(/不会自动改用/)).toBeTruthy();
  expect(calls.some((call) => call.command === "delete_ai_profile_cmd")).toBe(false);
  await user.click(screen.getByLabelText("进入未配置状态"));
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(calls.some((call) => call.command === "delete_ai_profile_cmd")).toBe(true));
  const sent = calls.find((call) => call.command === "delete_ai_profile_cmd");
  expect(sent?.args).toEqual({ id: "a", nextId: "" });
});

test("凭据库用不了时如实报错，不说成没配过", async () => {
  mount(() => ({ ...base, credentialError: "系统凭据库用不了，Key 没有保存：被策略禁用" }));
  await waitFor(() => expect(screen.getByText(/系统凭据库用不了/)).toBeTruthy());
});

test("填明文 http 的公网地址时给出警告，但不拦着", async () => {
  const user = userEvent.setup();
  mount(() => base);
  const input = await screen.findByLabelText("接口地址");
  await user.clear(input);
  await user.type(input, "http://relay.example/v1");
  expect(screen.getByText(/明文 http 的公网地址/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "保存并使用" })).toHaveProperty("disabled", false);
});

test("没连上宿主时如实说，不画一个能点的表单", async () => {
  render(
    <InvokeProvider invoke={null}>
      <AiSettings />
    </InvokeProvider>,
  );
  await waitFor(() => expect(screen.getByText(/没连上桌面宿主/)).toBeTruthy());
  expect(screen.getByRole("button", { name: "保存并使用" })).toHaveProperty("disabled", true);
  vi.restoreAllMocks();
});
