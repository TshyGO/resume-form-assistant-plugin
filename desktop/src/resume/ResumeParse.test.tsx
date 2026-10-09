import { StrictMode } from "react";
import { expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  const dialog = await screen.findByRole("dialog", { name: "发送简历给 AI 解析？" });
  expect(within(dialog).getByText("DeepSeek")).toBeTruthy();
  expect(within(dialog).getByText("api.deepseek.com")).toBeTruthy();
  expect(within(dialog).getByText("deepseek-chat")).toBeTruthy();
  expect(within(dialog).getByText(/《张三简历\.pdf》的全文（6 字）/)).toBeTruthy();
  expect(within(dialog).getByText(/对方可能留存这些内容。解析成功后会直接新建模板并设为当前/)).toBeTruthy();
  // 外发不是默认动作：焦点先落在「不发送」上。
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "不发送" }));
  expect(calls.some((c) => c.command === "ai_complete_cmd")).toBe(false);
  await user.click(within(dialog).getByRole("button", { name: "发送并解析" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("t1"));
  expect(screen.getByText("已存为模板「张三简历（AI 解析）」并设为当前，共 1 个字段。")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
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
  expect(screen.getByRole("button", { name: "发送并解析" })).toHaveProperty("disabled", true);
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
  expect(screen.getByRole("button", { name: "发送并解析" })).toHaveProperty("disabled", true);
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
  await user.click(await screen.findByRole("button", { name: "取消解析" }));
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

test("文字超过 6 万字时不让发送", async () => {
  const user = userEvent.setup();
  const onCreated = vi.fn();
  const invoke = (async (command: string) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    return null;
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <ResumeParse onCreated={onCreated} extract={async () => "字".repeat(61_000)} />
    </InvokeProvider>,
  );
  await upload(user);
  expect(await screen.findByText(/超过 6 万字/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "发送并解析" })).toHaveProperty("disabled", true);
});

test("不发送就关掉确认，什么都不外发", async () => {
  const user = userEvent.setup();
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "不发送" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((c) => c.command === "ai_complete_cmd")).toBe(false);
});

test("文件读不出文字时如实提示，不进入外发确认", async () => {
  const user = userEvent.setup();
  const invoke = (async (command: string) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    return null;
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <ResumeParse onCreated={() => {}} extract={async () => { throw new Error("这份 PDF 没有可读取的文字，可能是扫描版。"); }} />
    </InvokeProvider>,
  );
  await upload(user);
  expect(await screen.findByText("这份 PDF 没有可读取的文字，可能是扫描版。")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("等待时可以在后台继续，工作区里仍能查看进度和取消", async () => {
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
  const waiting = await screen.findByRole("dialog", { name: "AI 正在解析" });
  expect(within(waiting).getByText(/不保证对方停止计算或计费/)).toBeTruthy();
  await user.click(within(waiting).getByRole("button", { name: "在后台继续" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const progress = screen.getByRole("group", { name: "AI 解析进度" });
  expect(within(progress).getByText(/AI 正在解析《张三简历\.pdf》/)).toBeTruthy();
  await user.click(within(progress).getByRole("button", { name: "查看进度" }));
  expect(screen.getByRole("dialog", { name: "AI 正在解析" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "在后台继续" }));
  await user.click(within(screen.getByRole("group", { name: "AI 解析进度" })).getByRole("button", { name: "取消解析" }));
  expect(calls.some((c) => c.command === "cancel_analysis_cmd")).toBe(true);
  expect(await screen.findByText("已取消。取消不保证对方停止计算或停止计费。")).toBeTruthy();
  expect(screen.queryByRole("group", { name: "AI 解析进度" })).toBeNull();
  expect(calls.some((c) => c.command === "create_resume_template_cmd")).toBe(false);
});

test("后台保存失败时不自己弹窗，工作区里可以重新保存", async () => {
  const user = userEvent.setup();
  let resolveAi: (value: unknown) => void = () => {};
  let createCalls = 0;
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return new Promise((resolve) => { resolveAi = resolve; });
    if (command === "create_resume_template_cmd") {
      createCalls += 1;
      if (createCalls === 1) throw { code: "STORE_ERROR", message: "写不进去" };
      return { template: { id: "t1", name: "n", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 0 };
    }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  await user.click(await screen.findByRole("button", { name: "在后台继续" }));
  resolveAi('[{"group":"g","key":"k","value":"v"}]');
  const progress = await screen.findByRole("group", { name: "AI 解析进度" });
  await waitFor(() => expect(within(progress).getByRole("button", { name: "重新保存" })).toBeTruthy());
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(within(progress).getByRole("button", { name: "重新保存" }));
  await waitFor(() => expect(screen.getByText(/已存为模板/)).toBeTruthy());
  expect(calls.filter((c) => c.command === "ai_complete_cmd")).toHaveLength(1);
});

test("读取文件时可以取消，晚到的读取结果作废", async () => {
  const user = userEvent.setup();
  let finish: (text: string) => void = () => {};
  const invoke = (async (command: string) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    return null;
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <ResumeParse onCreated={() => {}} extract={() => new Promise((resolve) => { finish = resolve; })} />
    </InvokeProvider>,
  );
  await upload(user);
  const reading = await screen.findByRole("dialog", { name: "正在读取简历" });
  await user.click(within(reading).getByRole("button", { name: "取消" }));
  finish("张三");
  await flush();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("点了取消后 AI 仍成功返回：不建模板，如实说明没有保存", async () => {
  const user = userEvent.setup();
  let resolveAi: (value: unknown) => void = () => {};
  const { calls, onCreated } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "resume_overview_cmd") return emptyOverview;
    if (command === "ai_complete_cmd") return new Promise((resolve) => { resolveAi = resolve; });
    // 取消命令没来得及让请求失败：回复照常到达。
    if (command === "cancel_analysis_cmd") return true;
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  await user.click(await screen.findByRole("button", { name: "取消解析" }));
  resolveAi('[{"group":"基本信息","key":"姓名","value":"张三"}]');
  expect(await screen.findByText(/已取消，AI 返回的结果没有保存/)).toBeTruthy();
  expect(calls.some((c) => c.command === "create_resume_template_cmd")).toBe(false);
  expect(onCreated).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});
