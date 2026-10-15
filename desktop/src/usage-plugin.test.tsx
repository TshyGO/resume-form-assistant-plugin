import { expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fireEvent, screen, waitFor } from "@testing-library/dom";

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
