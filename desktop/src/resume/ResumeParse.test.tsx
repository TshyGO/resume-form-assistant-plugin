import { StrictMode } from "react";
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

const emptyOverview = { templates: [], activeTemplateId: null };

function mount(handler: (command: string, args?: Record<string, unknown>) => unknown, strict = false) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  const onCreated = vi.fn();
  const tree = (
    <InvokeProvider invoke={invoke}>
      <ResumeParse onCreated={onCreated} extract={async () => "张三\n某大学"} />
    </InvokeProvider>
  );
  // 桌面程序用 StrictMode 挂载（react/mount.tsx）：开发构建里 effect 会先卸一次再装一次。
  const { unmount } = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { calls, onCreated, unmount };
}

const upload = async (user: ReturnType<typeof userEvent.setup>) =>
  user.upload(screen.getByLabelText(/上传简历/), new File(["x"], "张三简历.pdf"));

// 短暂让出宏任务队列：不依赖组件仍然挂载（unmount 之后 screen 查询会失败），
// 只用来确认「组件卸载后 promise 落地」这条分支已经跑完。
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("确认前说清楚发给谁、发多少字，确认后才发送", async () => {
  const user = userEvent.setup();
  const { calls, onCreated } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return '[{"group":"基本信息","key":"姓名","value":"张三"}]';
    if (command === "create_resume_template_cmd") {
      return { template: { id: "t1", name: "张三简历（AI 解析）", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 0 };
    }
    return null;
  });
  await upload(user);
  expect(await screen.findByText(/DeepSeek/)).toBeTruthy();
  expect(screen.getByText(/api\.deepseek\.com · deepseek-chat/)).toBeTruthy();
  expect(screen.getByText(/6 字/)).toBeTruthy();
  expect(screen.getByText(/解析结果会直接存成一个新模板并设为当前，可在下面的模板列表里查看或删除。/)).toBeTruthy();
  expect(calls.some((c) => c.command === "ai_complete_cmd")).toBe(false);
  await user.click(screen.getByRole("button", { name: "发送并解析" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(screen.getByText("已存为模板「张三简历（AI 解析）」并设为当前，共 1 个字段。")).toBeTruthy();
  const sent = calls.find((c) => c.command === "ai_complete_cmd")!;
  expect(sent.args?.providerId).toBe("p1");
  const created = calls.find((c) => c.command === "create_resume_template_cmd")!;
  expect(created.args).toEqual({ name: "张三简历（AI 解析）", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "张三" }] }] });
});

test("确认之后服务商变了：后端拒绝时如实提示，得重新确认一次", async () => {
  const user = userEvent.setup();
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") {
      throw { code: "AI_PROVIDER_CHANGED", message: "当前服务商在确认之后变了，请重新选择文件确认一次。" };
    }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  expect(await screen.findByText("当前服务商在确认之后变了，请重新选择文件确认一次。")).toBeTruthy();
  const sent = calls.find((c) => c.command === "ai_complete_cmd")!;
  expect(sent.args?.providerId).toBe("p1");
  expect(calls.some((c) => c.command === "create_resume_template_cmd")).toBe(false);
});

test("没有可用服务商时不让发送，并指向设置页", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "get_ai_settings_cmd") return { providers: [], activeProviderId: null, credentialError: null };
    if (command === "resume_overview_cmd") return emptyOverview;
    return null;
  });
  await upload(user);
  expect(await screen.findByText(/先在「设置 → AI」添加服务商/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "发送并解析" })).toBeNull();
});

test("模板已经有 25 个时不让发送，并提示先删掉", async () => {
  const user = userEvent.setup();
  const templates = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, name: `t${i}`, fieldCount: 1, updatedAt: "" }));
  mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return { templates, activeTemplateId: null };
    return null;
  });
  await upload(user);
  expect(await screen.findByText(/模板已经有 25 个，先删掉用不上的再解析/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "发送并解析" })).toBeNull();
});

test("等待中可以取消，取消后如实显示已取消", async () => {
  const user = userEvent.setup();
  let reject: (reason?: unknown) => void = () => {};
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return new Promise((_resolve, rej) => { reject = rej; });
    if (command === "cancel_analysis_cmd") {
      reject({ code: "AI_CANCELLED", message: "已取消。取消不保证对方停止计算或停止计费。" });
      return true;
    }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  await user.click(await screen.findByRole("button", { name: "取消" }));
  const cancel = calls.find((c) => c.command === "cancel_analysis_cmd")!;
  const sent = calls.find((c) => c.command === "ai_complete_cmd")!;
  expect(cancel.args?.requestId).toBe(sent.args?.requestId);
  expect(await screen.findByText("已取消。取消不保证对方停止计算或停止计费。")).toBeTruthy();
});

test("模型返回乱码时如实提示，不建模板", async () => {
  const user = userEvent.setup();
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
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
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return '[{"group":"g","key":"k","value":"v"}]';
    if (command === "create_resume_template_cmd") {
      return { template: { id: "t1", name: "n", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 2 };
    }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  expect(await screen.findByText(/另有 2 个像密码或验证码的字段没有存/)).toBeTruthy();
});

test("建模板失败时可以不重新调用 AI、直接重新保存", async () => {
  const user = userEvent.setup();
  let createCalls = 0;
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return '[{"group":"基本信息","key":"姓名","value":"张三"}]';
    if (command === "create_resume_template_cmd") {
      createCalls += 1;
      if (createCalls === 1) throw { code: "STORE_ERROR", message: "写不进去" };
      return { template: { id: "t1", name: "张三简历（AI 解析）", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 0 };
    }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  expect(await screen.findByText("写不进去")).toBeTruthy();
  const retry = await screen.findByRole("button", { name: "重新保存" });
  await user.click(retry);
  await waitFor(() => expect(screen.getByText(/已存为模板/)).toBeTruthy());
  expect(calls.filter((c) => c.command === "ai_complete_cmd")).toHaveLength(1);
  expect(calls.filter((c) => c.command === "create_resume_template_cmd")).toHaveLength(2);
});

test("解析中途离开页面：卸载时取消请求，回来的结果不再建模板或提示", async () => {
  const user = userEvent.setup();
  let resolveAi: (value: unknown) => void = () => {};
  const { calls, onCreated, unmount } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return new Promise((resolve) => { resolveAi = resolve; });
    if (command === "cancel_analysis_cmd") return true;
    if (command === "create_resume_template_cmd") {
      return { template: { id: "t1", name: "n", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 0 };
    }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  expect(calls.some((c) => c.command === "ai_complete_cmd")).toBe(true);

  unmount();
  expect(calls.some((c) => c.command === "cancel_analysis_cmd")).toBe(true);

  resolveAi('[{"group":"g","key":"k","value":"v"}]');
  await flush();

  expect(calls.some((c) => c.command === "create_resume_template_cmd")).toBe(false);
  expect(onCreated).not.toHaveBeenCalled();
});

test("StrictMode 下挂载后仍能进入确认外发这一步", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    return null;
  }, true);
  await upload(user);
  expect(await screen.findByRole("button", { name: "发送并解析" })).toBeTruthy();
});
