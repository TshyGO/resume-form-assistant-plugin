import { beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, waitFor, within } from "@testing-library/dom";
import type { Invoke } from "./api";
import { mailboxProvider, mountMailboxes } from "./mailbox-ui";
import type { MailboxView, MailCandidate } from "./mailbox-ui";

beforeEach(() => {
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  document.getElementById("settings-mailbox")!.hidden = false;
});
const candidate = (id: string, subject = "星河科技面试邀请"): MailCandidate => ({
  id, accountId: "account", email: "a@qq.com", header: { fromAddr: "hr@example.com", fromName: "星河科技", subject, sentAt: "2026-10-24T04:00:00Z" }, reasons: ["匹配申请公司：星河科技", "标题包含：面试"],
});
function setup(items = [candidate("one")]) {
  const view: MailboxView = { accounts: [{ id: "account", email: "a@qq.com", paused: false, failures: 0, lastError: null, lastChecked: null }], candidates: items, pendingCount: items.length };
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {};
  const invoke = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (handlers[name]) return handlers[name](args);
    if (name === "mailbox_view") return structuredClone(view);
    throw new Error(`Unexpected command: ${name}`);
  });
  const onImported = vi.fn(async () => {}), openSettings = vi.fn();
  const inboxBridge = { showPending: vi.fn(), showStored: vi.fn() };
  const ui = mountMailboxes(invoke as Invoke, onImported, openSettings, inboxBridge);
  const pending = within(document.getElementById("mailbox-discovery")!);
  return { view, handlers, invoke, ui, pending, onImported, openSettings, inboxBridge };
}
function el<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(id)! as T; }
const checked = { checkedAccounts: 1, succeededAccounts: 1, failedAccounts: [], skippedPaused: 0 };

test("only supported providers receive built-in servers and matching illustrated help", async () => {
  setup();
  fireEvent.input(el("mailbox-email"), { target: { value: "A@163.COM" } });
  expect(el("mailbox-server").textContent).toContain("imap.163.com");
  expect(el<HTMLImageElement>("mailbox-guide-image").src).toContain("mailbox-guide-163.svg");
  expect(el("mailbox-guide-steps").textContent).toContain("IMAP/SMTP");
  expect(mailboxProvider("a@qq.com.evil.test")).toBeNull();
  expect(mailboxProvider("a@gmail.com")).toBe("gmail");
  expect(mailboxProvider("a@foxmail.com")).toBe("qq");
});
test("discovery explains its reasons and does not download or import anything", async () => {
  const { ui, invoke, pending, openSettings, inboxBridge } = setup(); await ui.refresh();
  expect(el("mailbox-tab-stored").getAttribute("aria-selected")).toBe("true");
  expect(el("mailbox-discovery").hidden).toBe(true);
  fireEvent.click(el("mailbox-tab-pending"));
  expect(el("mailbox-tab-pending").getAttribute("aria-selected")).toBe("true");
  expect(el("mailbox-discovery").hidden).toBe(false);
  expect(el("inbox-stored-panel").hidden).toBe(true);
  expect(inboxBridge.showPending).toHaveBeenLastCalledWith(expect.objectContaining({ id: "one" }), expect.any(Object));
  expect(pending.getByText("入选原因：匹配申请公司：星河科技；标题包含：面试")).toBeTruthy();
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["mailbox_view"]);
  fireEvent.click(el("mailbox-connect-link")); expect(openSettings).toHaveBeenCalledOnce();
  fireEvent.click(el("mailbox-tab-stored"));
  expect(inboxBridge.showStored).toHaveBeenCalled();
});

test("pending candidates can switch the right-side preview", async () => {
  const { ui, inboxBridge, pending } = setup([candidate("one", "第一封面试邀请"), candidate("two", "第二封笔试通知")]);
  await ui.refresh();
  fireEvent.click(el("mailbox-tab-pending"));
  expect(inboxBridge.showPending).toHaveBeenLastCalledWith(expect.objectContaining({ id: "one" }), expect.any(Object));
  fireEvent.click(pending.getAllByRole("button", { name: "查看" })[1]!);
  expect(inboxBridge.showPending).toHaveBeenLastCalledWith(expect.objectContaining({ id: "two" }), expect.any(Object));
});
test("server-controlled subjects and reasons render as text", async () => {
  const item = candidate("one", '<img src=x onerror="steal()">'); item.reasons = ["<script>steal()</script>"];
  const { ui } = setup([item]); await ui.refresh();
  expect(el("mailbox-candidates").querySelector("img,script")).toBeNull();
  expect(el("mailbox-candidates").textContent).toContain('<img src=x onerror="steal()">');
});
test("testing failure saves no account, never checks mail and clears the secret field", async () => {
  const { handlers, invoke } = setup(); handlers.mailbox_connect = async () => { throw { message: "请开启 IMAP 并生成授权码。" }; };
  fireEvent.input(el("mailbox-email"), { target: { value: "a@qq.com" } });
  fireEvent.input(el("mailbox-secret"), { target: { value: "synthetic-secret" } });
  fireEvent.submit(el("mailbox-form"));
  await waitFor(() => expect(el("mailbox-settings-status").textContent).toContain("请开启 IMAP"));
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("");
  expect(invoke.mock.calls.some(([name]) => name === "mailbox_check")).toBe(false);
  expect(document.body.textContent).not.toContain("synthetic-secret");
});
test("successful connection is tested and saved by one host command before checking", async () => {
  const { handlers, invoke } = setup(); handlers.mailbox_connect = async () => {}; handlers.mailbox_check = async () => checked;
  fireEvent.input(el("mailbox-email"), { target: { value: "a@126.com" } });
  fireEvent.input(el("mailbox-secret"), { target: { value: "synthetic-secret" } });
  fireEvent.submit(el("mailbox-form"));
  await waitFor(() => expect(el<HTMLInputElement>("mailbox-secret").value).toBe(""));
  expect(invoke.mock.calls[0]).toEqual(["mailbox_connect", { email: "a@126.com", secret: "synthetic-secret", config: { host: "imap.126.com", port: 993, encryption: "tls", username: "a@126.com", sendId: true } }]);
  expect(invoke.mock.calls[1][0]).toBe("mailbox_check");
});
test("background updates preserve drafts and selected candidates", async () => {
  const { ui, view } = setup(); await ui.refresh();
  fireEvent.input(el("mailbox-email"), { target: { value: "draft@163.com" } });
  fireEvent.input(el("mailbox-secret"), { target: { value: "unsaved" } });
  fireEvent.click(el("mailbox-select-all"));
  expect(el("mailbox-candidates").querySelectorAll('input:checked')).toHaveLength(1);
  view.accounts[0].lastChecked = 100; await ui.refresh();
  expect(el<HTMLInputElement>("mailbox-email").value).toBe("draft@163.com");
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("unsaved");
  expect(el<HTMLInputElement>("mailbox-select-all").checked).toBe(true);
});
test("ignore acts on selected candidates and never downloads originals", async () => {
  const { ui, view, handlers, invoke } = setup([candidate("one"), candidate("two")]); await ui.refresh();
  handlers.mailbox_ignore = async (args) => { expect(args?.ids).toEqual(["one", "two"]); view.candidates = []; view.pendingCount = 0; return { ignored: 2, unchanged: 0 }; };
  fireEvent.click(el("mailbox-select-all")); fireEvent.click(el("mailbox-ignore-selected"));
  await waitFor(() => expect(el("mailbox-pending-count").textContent).toBe("0"));
  expect(invoke.mock.calls.some(([name]) => name === "mailbox_confirm")).toBe(false);
  expect(el("mailbox-inbox-status").textContent).toContain("不会再提示");
});
test("ignore reports the rows that actually changed", async () => {
  const { ui, view, handlers } = setup([candidate("one"), candidate("two")]); await ui.refresh();
  handlers.mailbox_ignore = async () => { view.candidates = []; view.pendingCount = 0; return { ignored: 1, unchanged: 1 }; };
  fireEvent.click(el("mailbox-select-all")); fireEvent.click(el("mailbox-ignore-selected"));
  await waitFor(() => expect(el("mailbox-inbox-status").textContent).toContain("已忽略 1 封"));
  expect(el("mailbox-inbox-status").textContent).toContain("另外 1 封已被其他操作处理");
});
test("partial import failures stay visible with per-message reasons and can be retried", async () => {
  const { ui, view, handlers, onImported } = setup([candidate("one"), candidate("two")]); await ui.refresh();
  fireEvent.click(el("mailbox-tab-pending"));
  handlers.mailbox_confirm = async () => { view.candidates = [candidate("two")]; view.pendingCount = 1; return { imported: 1, duplicates: 0, failed: [{ id: "two", message: "断网了，请重试。" }] }; };
  fireEvent.click(el("mailbox-select-all")); fireEvent.click(el("mailbox-save-selected"));
  await waitFor(() => expect(el("mailbox-candidates").textContent).toContain("断网了，请重试。"));
  expect(el("mailbox-inbox-status").textContent).toContain("失败 1 封");
  expect(onImported).toHaveBeenCalledOnce();
  expect(el("mailbox-tab-stored").getAttribute("aria-selected")).toBe("true");
  expect(el<HTMLButtonElement>("mailbox-save-selected").disabled).toBe(false);
});
test("a failed later batch still refreshes messages committed by an earlier batch", async () => {
  const { ui, view, handlers, onImported } = setup(Array.from({length: 101}, (_,i) => candidate(String(i)))); await ui.refresh();
  let batches = 0;
  handlers.mailbox_confirm = async () => {
    if (++batches > 1) throw { message: "第二批连接中断，请重试。" };
    view.candidates = [candidate("100")]; view.pendingCount = 1;
    return { imported: 100, duplicates: 0, failed: [] };
  };
  fireEvent.click(el("mailbox-select-all")); fireEvent.click(el("mailbox-save-selected"));
  await waitFor(() => expect(el("mailbox-inbox-status").textContent).toContain("第二批连接中断"));
  expect(onImported).toHaveBeenCalledOnce();
  expect(el("mailbox-candidates").querySelectorAll('input:checked')).toHaveLength(1);
});
test("a read failure retains candidates instead of showing an empty successful result", async () => {
  const { ui, handlers } = setup(); await ui.refresh();
  handlers.mailbox_view = async () => { throw { message: "本机磁盘不可用" }; }; await ui.refresh();
  expect(el("mailbox-pending-count").textContent).toBe("1");
  expect(el("mailbox-candidates").textContent).toContain("面试邀请");
  expect(el("mailbox-inbox-status").textContent).toContain("读不到邮箱候选");
});
test("repeated clicks share one in-flight operation and disable competing actions", async () => {
  const { ui, handlers, invoke } = setup(); await ui.refresh();
  let complete!: () => void; handlers.mailbox_check = () => new Promise<typeof checked>((resolve) => { complete = () => resolve(checked); });
  fireEvent.click(el("mailbox-inbox-check")); fireEvent.click(el("mailbox-settings-check"));
  expect(invoke.mock.calls.filter(([name]) => name === "mailbox_check")).toHaveLength(1);
  expect(el<HTMLButtonElement>("mailbox-save-selected").disabled).toBe(true);
  expect(el("mailbox-inbox-status").textContent).toBe("正在检查邮箱…");
  complete(); await waitFor(() => expect(el<HTMLButtonElement>("mailbox-settings-check").disabled).toBe(false));
});
test("failed accounts explain automatic pause and offer recovery without a popup", async () => {
  const { ui, view } = setup(); view.accounts[0] = { ...view.accounts[0], paused: true, failures: 3, lastError: "Auth" }; await ui.refresh();
  const accounts = within(el("mailbox-accounts"));
  expect(accounts.getByRole("button", { name: "恢复检查" })).toBeTruthy();
  expect(el("mailbox-accounts").textContent).toContain("重新生成授权码");
  expect(el("mailbox-discovery-note").textContent).toContain("1 个邮箱检查异常");
});

test.each(["inbox", "settings"])("network failures appear beside the %s check button even when IPC succeeds", async (where) => {
  const { ui, view, handlers } = setup(); await ui.refresh();
  handlers.mailbox_check = async () => {
    view.accounts[0].lastError = "Network"; view.accounts[0].failures = 1;
    return { ...checked, succeededAccounts: 0, failedAccounts: [{ accountId: "account", message: "暂时连不上邮箱服务器，请检查网络后再试。", paused: false }] };
  };
  fireEvent.click(el(`mailbox-${where}-check`));
  await waitFor(() => expect(el(`mailbox-${where}-status`).textContent).toContain("请检查网络后再试"));
  expect(el(`mailbox-${where}-status`).dataset.tone).toBe("error");
  expect(el("mailbox-candidates").textContent).toContain("面试邀请");
});

test("a paused-only check explains that nothing ran and directs the user to resume", async () => {
  const { ui, view, handlers } = setup();
  view.accounts[0].paused = true; view.accounts[0].lastError = "Network"; view.accounts[0].failures = 3;
  await ui.refresh();
  handlers.mailbox_check = async () => ({ checkedAccounts: 0, succeededAccounts: 0, failedAccounts: [], skippedPaused: 1 });
  fireEvent.click(el("mailbox-inbox-check"));
  await waitFor(() => expect(el("mailbox-inbox-status").textContent).toContain("本次未检查邮箱"));
  expect(el("mailbox-inbox-status").textContent).toContain("恢复检查");
  expect(el("mailbox-inbox-status").dataset.tone).toBe("error");
});

test("a partial check reports failures and skips without masking successful accounts", async () => {
  const { handlers } = setup();
  handlers.mailbox_check = async () => ({ checkedAccounts: 2, succeededAccounts: 1, failedAccounts: [{ accountId: "account", message: "网络不可用", paused: true }], skippedPaused: 1 });
  fireEvent.click(el("mailbox-inbox-check"));
  await waitFor(() => expect(el("mailbox-inbox-status").textContent).toContain("1 个成功，1 个失败"));
  expect(el("mailbox-inbox-status").textContent).toContain("2 个邮箱已暂停");
  expect(el("mailbox-inbox-status").textContent).toContain("网络不可用");
});

test("connecting successfully cannot overwrite a subsequent scan failure", async () => {
  const { handlers } = setup();
  handlers.mailbox_connect = async () => {};
  handlers.mailbox_check = async () => ({ ...checked, succeededAccounts: 0, failedAccounts: [{ accountId: "account", message: "网络中断", paused: false }] });
  fireEvent.input(el("mailbox-email"), { target: { value: "a@qq.com" } });
  fireEvent.input(el("mailbox-secret"), { target: { value: "synthetic-secret" } });
  fireEvent.submit(el("mailbox-form"));
  await waitFor(() => expect(el("mailbox-settings-status").textContent).toContain("网络中断"));
  expect(el("mailbox-settings-status").textContent).toContain("连接已保存");
  expect(el("mailbox-settings-status").dataset.tone).toBe("error");
});

test("resuming a paused account shows the new check outcome", async () => {
  const { ui, view, handlers } = setup(); view.accounts[0].paused = true; await ui.refresh();
  handlers.mailbox_pause = async () => { view.accounts[0].paused = false; };
  handlers.mailbox_check = async () => ({ ...checked, succeededAccounts: 0, failedAccounts: [{ accountId: "account", message: "网络仍未恢复", paused: false }] });
  fireEvent.click(within(el("mailbox-accounts")).getByRole("button", { name: "恢复检查" }));
  await waitFor(() => expect(el("mailbox-settings-status").textContent).toContain("网络仍未恢复"));
  expect(el("mailbox-settings-status").dataset.tone).toBe("error");
});

test("a successful check and an empty account list have distinct outcomes", async () => {
  const { handlers } = setup(); handlers.mailbox_check = async () => checked;
  fireEvent.click(el("mailbox-inbox-check"));
  await waitFor(() => expect(el("mailbox-inbox-status").textContent).toContain("已成功检查 1 个邮箱"));
  await waitFor(() => expect(el<HTMLButtonElement>("mailbox-inbox-check").disabled).toBe(false));
  handlers.mailbox_check = async () => ({ checkedAccounts: 0, succeededAccounts: 0, failedAccounts: [], skippedPaused: 0 });
  fireEvent.click(el("mailbox-inbox-check"));
  await waitFor(() => expect(el("mailbox-inbox-status").textContent).toContain("还没有连接邮箱"));
});

test("Gmail and school presets show their own credential guidance", () => {
  setup();
  fireEvent.input(el("mailbox-email"), { target: { value: "a@gmail.com" } });
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("imap.gmail.com");
  expect(el("mailbox-secret-label").textContent).toBe("应用专用密码");
  expect(el("mailbox-guide-steps").textContent).toContain("两步验证");
  fireEvent.input(el("mailbox-email"), { target: { value: "a@mails.tsinghua.edu.cn" } });
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("mails.tsinghua.edu.cn");
  expect(el("mailbox-secret-hint").textContent).toContain("清华邮箱请生成客户端专用密码");
  fireEvent.input(el("mailbox-email"), { target: { value: "a@mail.tsinghua.edu.cn" } });
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("mail.tsinghua.edu.cn");
});
test("unknown school DNS failure leaves a usable manual connection form", async () => {
  const { handlers, invoke } = setup();
  handlers.mailbox_discover = async () => ({ config: null, source: "manual", note: "未能自动识别，请手动填写。", helpUrl: null });
  handlers.mailbox_connect = async () => {}; handlers.mailbox_check = async () => checked;
  fireEvent.input(el("mailbox-email"), { target: { value: "a@school.example" } });
  fireEvent.blur(el("mailbox-email"));
  await waitFor(() => expect(el("mailbox-detection").textContent).toContain("未能自动识别"));
  expect(el<HTMLDetailsElement>("mailbox-configuration").open).toBe(true);
  fireEvent.input(el("mailbox-host"), { target: { value: "mail.school.example" } });
  fireEvent.input(el("mailbox-username"), { target: { value: "shortname" } });
  fireEvent.input(el("mailbox-secret"), { target: { value: "synthetic-secret" } });
  fireEvent.submit(el("mailbox-form"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("mailbox_connect", { email: "a@school.example", secret: "synthetic-secret", config: { host: "mail.school.example", port: 993, encryption: "tls", username: "shortname", sendId: false } }));
});
test("late discovery cannot overwrite a different email or manual edits", async () => {
  const { handlers } = setup();
  let complete!: (value: unknown) => void;
  handlers.mailbox_discover = () => new Promise((resolve) => { complete = resolve; });
  fireEvent.input(el("mailbox-email"), { target: { value: "a@school.example" } });
  fireEvent.blur(el("mailbox-email"));
  fireEvent.input(el("mailbox-host"), { target: { value: "manual.school.example" } });
  complete({ config: { host: "late.example", port: 993, encryption: "tls", username: "a@school.example", sendId: false }, note: "late", helpUrl: null });
  await Promise.resolve();
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("manual.school.example");
  fireEvent.click(el("mailbox-detect"));
  fireEvent.input(el("mailbox-email"), { target: { value: "b@gmail.com" } });
  complete({ config: { host: "late.example", port: 993, encryption: "tls", username: "a@school.example", sendId: false }, note: "late", helpUrl: null });
  await Promise.resolve();
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("imap.gmail.com");
});
test("editing a saved school mailbox restores custom settings without exposing its password", async () => {
  const { ui, view, invoke } = setup();
  view.accounts[0] = { ...view.accounts[0], email: "a@school.example", connection: { host: "custom.school.example", port: 143, encryption: "starttls", username: "shortname", sendId: true } };
  await ui.refresh();
  fireEvent.click(within(el("mailbox-accounts")).getByRole("button", { name: "修改连接 / 更新凭据" }));
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("custom.school.example");
  expect(el<HTMLInputElement>("mailbox-username").value).toBe("shortname");
  expect(el<HTMLSelectElement>("mailbox-encryption").value).toBe("starttls");
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("");
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["mailbox_view"]);
});
test("Outlook gives the OAuth boundary instead of attempting DNS discovery", () => {
  const { invoke } = setup();
  fireEvent.input(el("mailbox-email"), { target: { value: "a@outlook.com" } });
  fireEvent.blur(el("mailbox-email"));
  expect(el("mailbox-detection").textContent).toContain("需要微软登录授权");
  expect(invoke.mock.calls).toHaveLength(0);
});
