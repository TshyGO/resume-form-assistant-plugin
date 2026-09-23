import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiProviderView, Invoke, SaveProviderResult } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { ProviderEditor } from "./ProviderEditor.tsx";

const existing: AiProviderView = {
  id: "p1", name: "DeepSeek", apiUrl: "https://api.deepseek.com/v1/chat/completions",
  model: "deepseek-chat", host: "api.deepseek.com", keyConfigured: true,
};

const saved = (over: Partial<SaveProviderResult> = {}): SaveProviderResult => ({
  view: { providers: [existing], activeProviderId: "p1", credentialError: null },
  providerId: "p1", keyCleared: false, keyError: null, ...over,
});

function mount(
  props: Partial<Parameters<typeof ProviderEditor>[0]>,
  handler: (command: string, args?: Record<string, unknown>) => unknown,
) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(
    <InvokeProvider invoke={invoke}>
      <ProviderEditor provider={null} preset={null} credentialError={null} onSaved={onSaved} onCancel={onCancel} {...props} />
    </InvokeProvider>,
  );
  return { calls, onSaved, onCancel };
}

test("从预设新建：填好地址，保存时连 Key 一起交出去", async () => {
  const user = userEvent.setup();
  const { calls, onSaved } = mount(
    { preset: { id: "deepseek", name: "DeepSeek", apiUrl: "https://api.deepseek.com/v1", keyPage: "https://platform.deepseek.com/api_keys", modelHint: "deepseek-chat" } },
    () => saved(),
  );
  expect(screen.getByLabelText("接口地址")).toHaveProperty("value", "https://api.deepseek.com/v1");
  expect(screen.getByText("https://platform.deepseek.com/api_keys")).toBeTruthy();
  await user.type(screen.getByLabelText("模型名称"), "deepseek-chat");
  await user.type(screen.getByLabelText("API Key"), "sk-x");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(calls[0]).toEqual({
    command: "save_ai_provider_cmd",
    args: { provider: { id: null, name: "DeepSeek", apiUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" }, key: "sk-x" },
  });
});

test("编辑已有服务商不填 Key 时不动原来的 Key", async () => {
  const user = userEvent.setup();
  const { calls } = mount({ provider: existing }, () => saved());
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0].args?.key).toBeNull();
});

test("主机变了、旧 Key 被清掉时要说出来", async () => {
  const user = userEvent.setup();
  const { onSaved } = mount({ provider: existing }, () => saved({ keyCleared: true }));
  const url = screen.getByLabelText("接口地址");
  await user.clear(url);
  await user.type(url, "https://api.moonshot.cn/v1");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(onSaved.mock.calls[0][0]).toMatchObject({ keyCleared: true });
});

test("获取模型：用刚填的 Key，点候选填进模型名", async () => {
  const user = userEvent.setup();
  const { calls } = mount({ provider: existing }, (command) =>
    command === "list_ai_models_cmd" ? { models: ["deepseek-chat", "deepseek-reasoner"], hiddenCount: 1, host: "api.deepseek.com" } : saved(),
  );
  await user.type(screen.getByLabelText("API Key"), "sk-new");
  await user.clear(screen.getByLabelText("模型名称"));
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  await user.click(await screen.findByRole("button", { name: "deepseek-reasoner" }));
  expect(screen.getByLabelText("模型名称")).toHaveProperty("value", "deepseek-reasoner");
  expect(calls[0]).toEqual({
    command: "list_ai_models_cmd",
    args: { providerId: "p1", apiUrl: existing.apiUrl, key: "sk-new" },
  });
  expect(screen.getByText(/另有 1 个非对话模型已隐藏/)).toBeTruthy();
});

test("姗姗来迟的获取模型结果被丢弃：地址在它回来之前已经改了", async () => {
  const user = userEvent.setup();
  let resolveStale: ((value: unknown) => void) | null = null;
  const stale = new Promise((resolve) => {
    resolveStale = resolve;
  });
  let requestCount = 0;
  mount({ provider: existing }, (command) => {
    if (command === "list_ai_models_cmd") {
      requestCount += 1;
      return requestCount === 1 ? stale : { models: ["fresh-model"], hiddenCount: 0, host: "api.moonshot.cn" };
    }
    return saved();
  });
  await user.clear(screen.getByLabelText("模型名称"));
  // 第一次点「获取模型」：请求还挂着，还没回来。
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  // 回来之前先把地址改了：这一步应该让第一个请求的序号作废。
  await user.clear(screen.getByLabelText("接口地址"));
  await user.type(screen.getByLabelText("接口地址"), "https://api.moonshot.cn/v1");
  // 现在第一个请求的结果才姗姗来迟——它不该再把候选画出来。
  resolveStale!({ models: ["stale-model"], hiddenCount: 0, host: "api.deepseek.com" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByRole("button", { name: "stale-model" })).toBeNull();
  expect(screen.queryByText(/stale-model|api\.deepseek\.com/)).toBeNull();
  // 新请求正常还能发起、正常展示。
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  expect(await screen.findByRole("button", { name: "fresh-model" })).toBeTruthy();
});

test("改地址后旧候选作废", async () => {
  const user = userEvent.setup();
  mount({ provider: existing }, () => ({ models: ["deepseek-chat"], hiddenCount: 0, host: "api.deepseek.com" }));
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  expect(await screen.findByRole("button", { name: "deepseek-chat" })).toBeTruthy();
  await user.type(screen.getByLabelText("接口地址"), "x");
  expect(screen.queryByRole("button", { name: "deepseek-chat" })).toBeNull();
});

test("获取失败只提示，不拦保存", async () => {
  const user = userEvent.setup();
  const { calls } = mount({ provider: existing }, (command) => {
    if (command === "list_ai_models_cmd") throw { code: "AI_MODELS_AUTH", message: "api.deepseek.com 拒绝了这个 Key（HTTP 401）" };
    return saved();
  });
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  expect(await screen.findByText(/拒绝了这个 Key/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(calls.some((c) => c.command === "save_ai_provider_cmd")).toBe(true));
});

test("保存失败时调用 onFailed，让上层刷新 Key 状态", async () => {
  const user = userEvent.setup();
  const onFailed = vi.fn();
  const { calls } = mount({ provider: existing, onFailed }, (command) => {
    if (command === "save_ai_provider_cmd") throw { code: "AI_SETTINGS_INVALID", message: "模型名称不能为空" };
    return saved();
  });
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(calls.some((c) => c.command === "save_ai_provider_cmd")).toBe(true));
  expect(onFailed).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(/模型名称不能为空/)).toBeTruthy();
});

test("获取模型失败不调用 onFailed：那是保存失败专用的", async () => {
  const user = userEvent.setup();
  const onFailed = vi.fn();
  mount({ provider: existing, onFailed }, (command) => {
    if (command === "list_ai_models_cmd") throw { code: "AI_MODELS_AUTH", message: "拒绝了这个 Key" };
    return saved();
  });
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  await screen.findByText(/拒绝了这个 Key/);
  expect(onFailed).not.toHaveBeenCalled();
});

test("清除 Key 要确认", async () => {
  const user = userEvent.setup();
  const { calls } = mount({ provider: existing }, () => ({ providers: [{ ...existing, keyConfigured: false }], activeProviderId: "p1", credentialError: null }));
  await user.click(screen.getByRole("button", { name: "清除 Key" }));
  expect(calls).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "确认清除" }));
  await waitFor(() => expect(calls[0]).toEqual({ command: "clear_ai_key_cmd", args: { providerId: "p1" } }));
});

test("明文 http 与地址里夹带凭据会提示", async () => {
  const user = userEvent.setup();
  mount({}, () => saved());
  await user.type(screen.getByLabelText("接口地址"), "http://relay.example.com/v1?api_key=abc");
  expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(1);
});
