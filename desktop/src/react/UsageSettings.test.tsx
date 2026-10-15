import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { Invoke } from "../api.ts";
import type { UsageStatus } from "../usage-metrics.ts";
import { UsageSettings } from "./UsageSettings.tsx";

function initial(overrides: Partial<UsageStatus> = {}): UsageStatus {
  return { enabled: true, notice_required: true, available: true, outbound_enabled: false,
    deletion: "none", revision: 0, ...overrides };
}
function api(start = initial()) {
  let status = start;
  const fn = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "telemetry_enabled") status = { ...status, enabled: args?.enabled === true,
      notice_required: args?.enabled === true && status.notice_required, revision: status.revision + 1 };
    if (command === "telemetry_notice") status = { ...status, notice_required: false, revision: status.revision + 1 };
    return status;
  });
  return { invoke: fn as Invoke, fn };
}

test("default ON uses a short first-run notice outside the hidden privacy panel", async () => {
  const portal = document.createElement("div"); document.body.append(portal);
  const { invoke, fn } = api();
  const { unmount } = render(<div hidden><UsageSettings invoke={invoke} noticeContainer={portal} /></div>);
  const notice = await within(portal).findByRole("region", { name: "使用数量统计默认开启" });
  for (const text of ["默认开启", "随机编号", "不含简历", "桌面和插件共用", "关闭不影响功能", "此前活动不会补发"])
    expect(notice.textContent).toContain(text);
  expect(notice.textContent).not.toContain("Cloudflare");
  expect(fn.mock.calls.every(([command]) => command === "telemetry_status")).toBe(true);
  fireEvent.click(within(notice).getByRole("button", { name: "知道了，保持开启" }));
  await waitFor(() => expect(portal.childElementCount).toBe(0));
  expect(fn).toHaveBeenCalledWith("telemetry_notice", undefined);
  expect(fn.mock.calls.some(([command]) => command === "telemetry_touch" || command.startsWith("feedback_"))).toBe(false);
  unmount(); portal.remove();
});

test("first disclosure can opt out directly without acknowledging or sending activity", async () => {
  const { invoke, fn } = api(); render(<UsageSettings invoke={invoke} />);
  const toggle = await screen.findByRole("checkbox", { name: "分享使用数量统计" }) as HTMLInputElement;
  await waitFor(() => expect(toggle.checked).toBe(true));
  fireEvent.click(await screen.findByRole("button", { name: "关闭使用统计" }));
  await waitFor(() => expect(toggle.checked).toBe(false));
  expect(screen.queryByRole("region", { name: "使用数量统计默认开启" })).toBeNull();
  expect(fn).toHaveBeenCalledWith("telemetry_enabled", { enabled: false });
  expect(fn.mock.calls.some(([command]) => command === "telemetry_notice" || command === "telemetry_touch")).toBe(false);
});

test("existing OFF never gets a first-launch prompt and reenable does not submit activity", async () => {
  const { invoke, fn } = api(initial({ enabled: false, notice_required: false })); render(<UsageSettings invoke={invoke} />);
  const toggle = await screen.findByRole("checkbox", { name: "分享使用数量统计" }) as HTMLInputElement;
  await screen.findByText("使用统计已关闭，不发送活动信号。");
  expect(toggle.checked).toBe(false);
  expect(screen.queryByRole("region", { name: "使用数量统计默认开启" })).toBeNull();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.checked).toBe(true));
  expect(fn).toHaveBeenCalledWith("telemetry_enabled", { enabled: true });
  expect(fn.mock.calls.some(([command]) => command === "telemetry_touch")).toBe(false);
});

test("off returns immediately with pending deletion, then an event reports an unconfirmed deletion honestly", async () => {
  let status = initial({ notice_required: false, outbound_enabled: true });
  let notify = () => {};
  const stop = vi.fn();
  const invoke = vi.fn(async (command: string) => {
    if (command === "telemetry_enabled") status = { ...status, enabled: false, deletion: "pending", revision: 1 };
    return status;
  }) as Invoke;
  const subscribe = async (changed: () => void) => { notify = changed; return stop; };
  const { unmount } = render(<UsageSettings invoke={invoke} subscribe={subscribe} />);
  const toggle = await screen.findByRole("checkbox", { name: "分享使用数量统计" }) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  fireEvent.click(toggle);
  await screen.findByText(/关闭操作不等待删除结果/);
  expect(toggle.checked).toBe(false);
  status = { ...status, deletion: "unconfirmed", revision: 2 };
  await act(async () => notify());
  await screen.findByText(/云端删除未获确认，不会自动重试/);
  unmount(); expect(stop).toHaveBeenCalledOnce();
});

test("save failure refreshes the actual stopped state and keeps the persistence warning", async () => {
  const failure = "本次运行已停止使用统计，但关闭设置无法保存。请在重启前检查磁盘权限并重试。";
  let status = initial({ notice_required: false });
  const invoke = vi.fn(async (command: string) => {
    if (command === "telemetry_enabled") {
      status = { ...status, enabled: false, available: false, deletion: "unconfirmed", revision: 1 };
      throw failure;
    }
    return status;
  }) as Invoke;
  render(<UsageSettings invoke={invoke} />);
  const toggle = await screen.findByRole("checkbox", { name: "分享使用数量统计" }) as HTMLInputElement;
  await waitFor(() => expect(toggle.checked).toBe(true));
  fireEvent.click(toggle);
  expect((await screen.findByRole("alert")).textContent).toBe(failure);
  await waitFor(() => expect(toggle.checked).toBe(false));
  expect(screen.getByText(/无法确认本机编号已清除/)).toBeTruthy();
});

test("late status cannot roll back a newer choice and duplicate gestures cannot submit twice", async () => {
  let finish!: (value: UsageStatus) => void;
  let notify = () => {};
  let reads = 0;
  const fn = vi.fn((command: string) => {
    if (command === "telemetry_status" && ++reads === 2) return new Promise<UsageStatus>(resolve => { finish = resolve; });
    if (command === "telemetry_enabled") return Promise.resolve(initial({ enabled: false, notice_required: false, revision: 2 }));
    return Promise.resolve(initial({ notice_required: false }));
  });
  render(<UsageSettings invoke={fn as Invoke} subscribe={async changed => { notify = changed; return () => {}; }} />);
  const toggle = await screen.findByRole("checkbox", { name: "分享使用数量统计" }) as HTMLInputElement;
  await waitFor(() => expect(toggle.checked).toBe(true));
  await act(async () => notify());
  fireEvent.click(toggle); fireEvent.click(toggle);
  await waitFor(() => expect(toggle.checked).toBe(false));
  await act(async () => finish(initial({ notice_required: false, revision: 0 })));
  expect(toggle.checked).toBe(false);
  expect(fn.mock.calls.filter(([name]) => name === "telemetry_enabled")).toHaveLength(1);
});

test("preview has no outgoing commands or interactive settings", () => {
  render(<UsageSettings invoke={null} />);
  expect((screen.getByRole("checkbox", { name: "分享使用数量统计" }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText("浏览器预览不会保存设置或发送使用统计。")).toBeTruthy();
});
