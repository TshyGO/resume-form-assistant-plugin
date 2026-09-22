import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiSettingsView, Invoke } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { AiSettings } from "./AiSettings.tsx";

const base: AiSettingsView = {
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

test("读出设置后填进表单，并说明 Key 还没配", async () => {
  mount(() => base);
  await waitFor(() => expect(screen.getByLabelText("接口地址")).toHaveProperty("value", base.apiUrl));
  expect(screen.getByLabelText("模型名称")).toHaveProperty("value", "deepseek-chat");
  expect(screen.getByText(/还没有 Key/)).toBeTruthy();
});

test("保存时把补全后的地址告诉用户", async () => {
  const user = userEvent.setup();
  const calls = mount((command) =>
    command === "save_ai_settings_cmd" ? base : { ...base, apiUrl: "https://api.deepseek.com" },
  );
  await waitFor(() => expect(screen.getByLabelText("接口地址")).toHaveProperty("value", "https://api.deepseek.com"));
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(screen.getByText(/补全为/)).toBeTruthy());
  expect(calls.some((call) => call.command === "save_ai_settings_cmd")).toBe(true);
});

test("Key 保存后输入框清空，界面不回显它", async () => {
  const user = userEvent.setup();
  const calls = mount((command) => (command === "set_ai_key_cmd" ? { ...base, keyConfigured: true } : base));
  const input = await screen.findByLabelText("API Key");
  await user.type(input, "sk-synthetic-value");
  await user.click(screen.getByRole("button", { name: "保存 Key" }));

  await waitFor(() => expect(screen.getByText(/已存进系统凭据库/)).toBeTruthy());
  expect(input).toHaveProperty("value", "");
  expect(document.body.textContent).not.toContain("sk-synthetic-value");
  const sent = calls.find((call) => call.command === "set_ai_key_cmd");
  expect(sent?.args).toEqual({ key: "sk-synthetic-value" });
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
  expect(screen.getByRole("button", { name: "保存设置" })).toHaveProperty("disabled", false);
});

test("没连上宿主时如实说，不画一个能点的表单", async () => {
  render(
    <InvokeProvider invoke={null}>
      <AiSettings />
    </InvokeProvider>,
  );
  await waitFor(() => expect(screen.getByText(/没连上桌面宿主/)).toBeTruthy());
  expect(screen.getByRole("button", { name: "保存设置" })).toHaveProperty("disabled", true);
  vi.restoreAllMocks();
});

test("获取模型成功后列出候选，点一个填进输入框", async () => {
  const user = userEvent.setup();
  const calls = mount((command) =>
    command === "list_ai_models_cmd"
      ? { models: ["b-chat", "a-chat"], hiddenCount: 2, host: "relay.example" }
      : base,
  );
  await screen.findByLabelText("模型名称");
  await user.clear(screen.getByLabelText("模型名称"));
  await user.click(screen.getByRole("button", { name: "获取模型" }));

  await waitFor(() => expect(screen.getByText("a-chat")).toBeTruthy());
  expect(screen.getByText(/拿到 2 个模型/)).toBeTruthy();
  expect(screen.getByText(/2 个非对话模型/)).toBeTruthy();

  const sent = calls.find((call) => call.command === "list_ai_models_cmd");
  expect(sent?.args).toEqual({ apiUrl: base.apiUrl, key: null });

  await user.click(screen.getByText("a-chat"));
  expect(screen.getByLabelText("模型名称")).toHaveProperty("value", "a-chat");
});

test("拉回空列表就直说没有能填的，也不画候选按钮", async () => {
  const user = userEvent.setup();
  mount((command) =>
    command === "list_ai_models_cmd"
      ? { models: [], hiddenCount: 2, host: "relay.example" }
      : base,
  );
  await screen.findByLabelText("模型名称");
  await user.clear(screen.getByLabelText("模型名称"));
  await user.click(screen.getByRole("button", { name: "获取模型" }));

  await waitFor(() => expect(screen.getByText(/没有能填的对话模型/)).toBeTruthy());
  expect(screen.queryByRole("list")).toBeNull();
  expect(screen.getByRole("button", { name: "保存设置" })).toHaveProperty("disabled", false);
});

test("获取模型失败只说一声，保存设置不拦着", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "list_ai_models_cmd") {
      throw { code: "AI_MODELS_AUTH", message: "拒绝了这个 Key" };
    }
    return base;
  });
  await screen.findByLabelText("模型名称");
  await user.click(screen.getByRole("button", { name: "获取模型" }));

  await waitFor(() => expect(screen.getByText(/AI_MODELS_AUTH/)).toBeTruthy());
  expect(screen.getByRole("button", { name: "保存设置" })).toHaveProperty("disabled", false);
  expect(screen.getByLabelText("模型名称")).toHaveProperty("value", "deepseek-chat");
});

test("获取中改地址，按钮不会永久卡死", async () => {
  const user = userEvent.setup();
  let release!: (value: unknown) => void;
  mount((command) =>
    command === "list_ai_models_cmd"
      ? new Promise((resolve) => {
          release = resolve;
        })
      : base,
  );
  await screen.findByLabelText("模型名称");
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "正在获取…" })).toBeTruthy());

  const url = screen.getByLabelText("接口地址");
  await user.clear(url);
  await user.type(url, "https://other.example/v1");

  // 旧请求还没回来，按钮已经可以再点了；旧回包回来也不会污染新状态。
  const fetchButton = screen.getByRole("button", { name: "获取模型" });
  expect(fetchButton).toHaveProperty("disabled", false);
  release({ models: ["stale-chat"], hiddenCount: 0, host: "relay.example" });
  await Promise.resolve();
  expect(screen.queryByText("stale-chat")).toBeNull();
  expect(screen.getByRole("button", { name: "获取模型" })).toHaveProperty("disabled", false);
});

test("改地址或 Key 后旧候选作废", async () => {
  const user = userEvent.setup();
  mount((command) =>
    command === "list_ai_models_cmd"
      ? { models: ["a-chat"], hiddenCount: 0, host: "relay.example" }
      : base,
  );
  await screen.findByLabelText("模型名称");
  await user.clear(screen.getByLabelText("模型名称"));
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  await waitFor(() => expect(screen.getByText("a-chat")).toBeTruthy());

  const url = screen.getByLabelText("接口地址");
  await user.clear(url);
  await user.type(url, "https://other.example/v1");
  expect(screen.queryByText("a-chat")).toBeNull();
});
