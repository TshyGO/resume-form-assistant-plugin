import { expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fireEvent, screen, waitFor, within } from "@testing-library/dom";

type UsageStatus = {
  enabled: boolean;
  notice_required: boolean;
  available: boolean;
  outbound_enabled: boolean;
  deletion: "none" | "pending" | "deleted" | "unconfirmed";
  revision: number;
};

function mount(page: "popup" | "sidepanel", initial?: Partial<UsageStatus>, seen = false) {
  document.body.innerHTML = page === "popup"
    ? '<div id="usage-settings-root"></div>'
    : '<div id="usage-notice-root" hidden></div><div id="usage-compact-root"></div>';
  let status: UsageStatus = { enabled: true, notice_required: true, available: true,
    outbound_enabled: true, deletion: "none", revision: 0, ...initial };
  const calls: Record<string, unknown>[] = [];
  const storage: Record<string, unknown> = seen ? { usageNoticeSeenV1: true } : {};
  const chrome = {
    runtime: {
      sendMessage: vi.fn(async (message: Record<string, unknown>) => {
        calls.push(message);
        const action = message.action;
        if (action === "enable") status = { ...status, enabled: true, revision: status.revision + 1 };
        if (action === "disable") status = { ...status, enabled: false, notice_required: false, revision: status.revision + 1 };
        if (action === "acknowledge") status = { ...status, notice_required: false, revision: status.revision + 1 };
        return { ok: true, status };
      }),
      openOptionsPage: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(storage, value); }),
      },
      onChanged: { addListener: vi.fn() },
    },
  };
  vm.runInContext(readFileSync("../usage-ui.js", "utf8"), vm.createContext({ document, chrome }));
  return { calls, chrome, status: () => status, storage };
}

test("plugin status reads and changes the desktop-owned shared usage setting", async () => {
  const { calls } = mount("popup");
  const toggle = await screen.findByRole("checkbox", { name: "分享使用数量统计" }) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.checked).toBe(true);
  expect(screen.getByText("已开启：桌面和插件共用这一选择。")).toBeTruthy();
  fireEvent.click(toggle);
  await screen.findByText("已关闭：桌面和插件都不会发送使用信号。");
  expect(calls.map(call => call.action)).toEqual(["status", "disable"]);
});

test("plugin notice is short and acknowledging it keeps the shared setting on", async () => {
  const { calls, storage } = mount("sidepanel");
  const notice = await screen.findByRole("region", { name: "使用数量统计" });
  expect(notice.textContent).toContain("不含简历、网页或具体操作");
  expect(notice.textContent).not.toContain("Cloudflare");
  fireEvent.click(screen.getByRole("button", { name: "知道了，保持开启" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "使用数量统计" })).toBeNull());
  expect(storage.usageNoticeSeenV1).toBe(true);
  expect(calls.map(call => call.action)).toEqual(["status", "acknowledge"]);
});

test("plugin explains when an old or stopped desktop cannot manage the setting", async () => {
  document.body.innerHTML = '<div id="usage-settings-root"></div>';
  const chrome = {
    runtime: { sendMessage: vi.fn(async () => ({ ok: false, code: "unavailable" })), openOptionsPage: vi.fn() },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn() }, onChanged: { addListener: vi.fn() } },
  };
  vm.runInContext(readFileSync("../usage-ui.js", "utf8"), vm.createContext({ document, chrome }));
  expect(await screen.findByText("未连接桌面程序，启动或更新桌面后才能管理。")).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "分享使用数量统计" }) as HTMLInputElement).disabled).toBe(true);
});

test("a newer desktop disclosure overrides the plugin's old seen marker", async () => {
  mount("sidepanel", { notice_required: true }, true);
  expect(await screen.findByRole("region", { name: "使用数量统计" })).toBeTruthy();
});

test("compact status says stopped when desktop storage is unavailable", async () => {
  mount("sidepanel", { enabled: true, available: false, notice_required: false }, true);
  expect(await screen.findByText("使用统计：已停止")).toBeTruthy();
});

test("an unconfirmed cloud deletion is shown instead of a generic closed message", async () => {
  mount("popup", { enabled: false, notice_required: false, deletion: "unconfirmed" }, true);
  expect(await screen.findByText(/云端删除未确认，不会自动重试，明细最多保留 45 天/)).toBeTruthy();
});

test("a failed disable explains the current stop and uncertain restart persistence", async () => {
  document.body.innerHTML = '<div id="usage-settings-root"></div>';
  const on: UsageStatus = { enabled: true, notice_required: false, available: true,
    outbound_enabled: true, deletion: "none", revision: 0 };
  const stopped: UsageStatus = { ...on, enabled: false, available: false,
    deletion: "unconfirmed", revision: 1 };
  const chrome = {
    runtime: { sendMessage: vi.fn(async (message: { action: string }) => ({ ok: true,
      status: message.action === "disable" ? stopped : on })), openOptionsPage: vi.fn() },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn() } },
  };
  vm.runInContext(readFileSync("../usage-ui.js", "utf8"), vm.createContext({ document, chrome }));
  const toggle = await screen.findByRole("checkbox", { name: "分享使用数量统计" }) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  fireEvent.click(toggle);
  expect(await screen.findByText(/本次运行已停止使用统计，但关闭选择可能没有保存/)).toBeTruthy();
  expect(toggle.disabled).toBe(true);
});

test("an older focus refresh cannot overwrite a completed disable", async () => {
  document.body.innerHTML = '<div id="usage-settings-root"></div>';
  const on: UsageStatus = { enabled: true, notice_required: false, available: true,
    outbound_enabled: true, deletion: "none", revision: 0 };
  const off: UsageStatus = { ...on, enabled: false, deletion: "pending", revision: 1 };
  let statusCalls = 0;
  let resolveOld: (value: unknown) => void = () => {};
  let focus: () => void = () => {};
  const chrome = {
    runtime: { sendMessage: vi.fn((message: { action: string }) => {
      if (message.action === "disable") return Promise.resolve({ ok: true, status: off });
      statusCalls++;
      if (statusCalls === 1) return Promise.resolve({ ok: true, status: on });
      return new Promise(resolve => { resolveOld = resolve; });
    }), openOptionsPage: vi.fn() },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn() } },
  };
  const context = vm.createContext({ document, chrome,
    addEventListener: (name: string, listener: () => void) => { if (name === "focus") focus = listener; } });
  vm.runInContext(readFileSync("../usage-ui.js", "utf8"), context);
  const toggle = await screen.findByRole("checkbox", { name: "分享使用数量统计" }) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  focus();
  await waitFor(() => expect(statusCalls).toBe(2));
  fireEvent.click(toggle);
  await screen.findByText("已关闭：桌面和插件都不会发送使用信号。");
  resolveOld({ ok: true, status: on });
  await Promise.resolve();
  expect(toggle.checked).toBe(false);
});

test("storage failures keep the notice usable and explain that it may reappear", async () => {
  document.body.innerHTML = '<div id="usage-notice-root" hidden></div><div id="usage-compact-root"></div>';
  const on: UsageStatus = { enabled: true, notice_required: true, available: true,
    outbound_enabled: true, deletion: "none", revision: 0 };
  const acknowledged = { ...on, notice_required: false, revision: 1 };
  const chrome = {
    runtime: { sendMessage: vi.fn(async (message: { action: string }) => ({ ok: true,
      status: message.action === "acknowledge" ? acknowledged : on })), openOptionsPage: vi.fn() },
    storage: { local: {
      get: vi.fn(async () => { throw new Error("storage unavailable"); }),
      set: vi.fn(async () => { throw new Error("storage unavailable"); }),
    }, onChanged: { addListener: vi.fn() } },
  };
  vm.runInContext(readFileSync("../usage-ui.js", "utf8"), vm.createContext({ document, chrome }));
  const notice = await screen.findByRole("region", { name: "使用数量统计" });
  expect(within(notice).getByText(/无法读取公告状态/)).toBeTruthy();
  const acknowledge = within(notice).getByRole("button", { name: "知道了，保持开启" }) as HTMLButtonElement;
  expect(acknowledge.disabled).toBe(false);
  fireEvent.click(acknowledge);
  await waitFor(() => expect(within(notice).getByText(/设置已保存，但插件无法保存公告已读状态/)).toBeTruthy());
  await Promise.resolve();
  expect(within(notice).getByText(/设置已保存，但插件无法保存公告已读状态/)).toBeTruthy();
});
