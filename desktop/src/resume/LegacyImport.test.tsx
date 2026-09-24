import { expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Invoke, LegacyImportPending, LegacyImportPreview } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { LegacyImport } from "./LegacyImport.tsx";

const IMPORT = "77777777-7777-4777-8777-777777777777";

const pending = (over: Partial<LegacyImportPending> = {}): LegacyImportPending => ({
  importId: IMPORT, state: "awaiting_confirmation", received: 3, total: 3, pluginVersion: "0.4.1", applied: false, ...over,
});

const preview = (over: Partial<LegacyImportPreview> = {}): LegacyImportPreview => ({
  importId: IMPORT, state: "awaiting_confirmation", applied: false,
  templates: [{ name: "研发岗", fieldCount: 12, wasActive: true }],
  profileItemCount: 5, ai: { host: "api.example.com", model: "m-1" },
  desktopTemplateCount: 2, desktopProfileEmpty: true, ...over,
});

function mount(
  handler: (command: string, args?: Record<string, unknown>) => unknown,
  { listen, onImported = () => {} }: { listen?: (name: string, handler: () => void) => () => void; onImported?: () => void } = {},
) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <LegacyImport listen={listen} onImported={onImported} />
    </InvokeProvider>,
  );
  return calls;
}

test("没有待导入的批次时什么都不显示", async () => {
  const calls = mount(() => []);
  await waitFor(() => expect(calls.some((c) => c.command === "list_legacy_imports_cmd")).toBe(true));
  expect(screen.queryByRole("region", { name: "插件旧数据导入" })).toBeNull();
});

test("接收中显示进度", async () => {
  mount((command) => (command === "list_legacy_imports_cmd" ? [pending({ state: "receiving", received: 1 })] : null));
  expect(await screen.findByText(/已收 1 \/ 共 3/)).toBeTruthy();
});

test("待确认时列出模板、我的信息与 AI 主机，确认后通知刷新", async () => {
  let imported = 0;
  let list: LegacyImportPending[] = [pending()];
  const calls = mount((command) => {
    if (command === "list_legacy_imports_cmd") return list;
    if (command === "legacy_import_preview_cmd") return preview();
    if (command === "confirm_legacy_import_cmd") { list = []; return { state: "imported", received: 3, total: 3 }; }
    return null;
  }, { onImported: () => { imported += 1; } });
  expect(await screen.findByText(/模板「研发岗」：12 个字段（插件里的当前模板）/)).toBeTruthy();
  expect(screen.getByText("「我的信息」：5 项")).toBeTruthy();
  expect(screen.getByText(/api\.example\.com，模型 m-1/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "导入到桌面" }));
  await screen.findByText(/已导入桌面/);
  const confirm = calls.find((c) => c.command === "confirm_legacy_import_cmd");
  expect(confirm?.args).toEqual({ importId: IMPORT, profileChoice: null });
  expect(imported).toBe(1);
});

test("桌面已有我的信息时必须先选保留哪份", async () => {
  const calls = mount((command) => {
    if (command === "list_legacy_imports_cmd") return [pending()];
    if (command === "legacy_import_preview_cmd") return preview({ desktopProfileEmpty: false });
    if (command === "confirm_legacy_import_cmd") return { state: "imported", received: 3, total: 3 };
    return null;
  });
  const button = await screen.findByRole("button", { name: "导入到桌面" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(screen.getByLabelText(/保留桌面的/));
  expect((button as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(button);
  await waitFor(() => expect(calls.find((c) => c.command === "confirm_legacy_import_cmd")?.args)
    .toEqual({ importId: IMPORT, profileChoice: "keep_desktop" }));
});

test("模板超额时显示桌面给的两个数字", async () => {
  mount((command) => {
    if (command === "list_legacy_imports_cmd") return [pending()];
    if (command === "legacy_import_preview_cmd") return preview();
    if (command === "confirm_legacy_import_cmd") {
      throw { code: "template_limit", message: "桌面已有 24 个模板，再导入 3 个会超过 25 个上限，请先在桌面删掉一些再确认。" };
    }
    return null;
  });
  await userEvent.click(await screen.findByRole("button", { name: "导入到桌面" }));
  expect(await screen.findByText(/桌面已有 24 个模板，再导入 3 个/)).toBeTruthy();
});

test("不导入要再确认一次", async () => {
  const calls = mount((command) => {
    if (command === "list_legacy_imports_cmd") return [pending()];
    if (command === "legacy_import_preview_cmd") return preview();
    if (command === "reject_legacy_import_cmd") return { state: "rejected", received: 3, total: 3 };
    return null;
  });
  await userEvent.click(await screen.findByRole("button", { name: "不导入" }));
  expect(calls.some((c) => c.command === "reject_legacy_import_cmd")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "确定不导入" }));
  expect(await screen.findByText(/插件里的数据原样保留/)).toBeTruthy();
});

test("AI 步骤没成功时可以重试或放弃 AI 配置", async () => {
  const calls = mount((command) => {
    if (command === "list_legacy_imports_cmd") return [pending({ applied: true })];
    if (command === "reject_legacy_import_cmd") return { state: "imported", received: 3, total: 3, aiConfigDropped: true };
    return null;
  });
  expect(await screen.findByRole("button", { name: "重试导入 AI 配置" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "不导入 AI 配置" }));
  expect(calls.some((c) => c.command === "reject_legacy_import_cmd")).toBe(false);
  expect(screen.getByText(/已经导入的模板和「我的信息」会保留/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "确定不导入 AI 配置" }));
  expect(await screen.findByText(/AI 配置没有导入/)).toBeTruthy();
  expect(calls.some((c) => c.command === "reject_legacy_import_cmd")).toBe(true);
});

test("收到到达事件会重新读取", async () => {
  let fire: () => void = () => {};
  let list: LegacyImportPending[] = [];
  mount((command) => {
    if (command === "list_legacy_imports_cmd") return list;
    if (command === "legacy_import_preview_cmd") return preview();
    return null;
  }, { listen: (_name, handler) => { fire = handler; return () => {}; } });
  await waitFor(() => expect(screen.queryByRole("button", { name: "导入到桌面" })).toBeNull());
  list = [pending()];
  fire();
  expect(await screen.findByRole("button", { name: "导入到桌面" })).toBeTruthy();
});
