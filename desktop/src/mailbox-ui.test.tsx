import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, waitFor, within } from "@testing-library/dom";
import type { Invoke } from "./api";
import { mailboxProvider, mountMailboxes } from "./mailbox-ui";
import type { MailboxView, MailCandidate } from "./mailbox-ui";

const disposers: Array<() => void> = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); vi.useRealTimers(); });

beforeEach(() => {
  document.body.innerHTML = readFileSync("index.html", "utf8").split("<body>")[1].split("</body>")[0];
  document.getElementById("settings-mailbox")!.hidden = false;
});
const candidate = (id: string, subject = "星河科技面试邀请"): MailCandidate => ({
  id, accountId: "account", email: "a@qq.com", header: { fromAddr: "hr@example.com", fromName: "星河科技", subject, sentAt: "2026-10-24T04:00:00Z" }, reasons: ["匹配申请公司：星河科技", "标题包含：面试"],
});
function setup(items = [candidate("one")]) {
  const view: MailboxView = { accounts: [{ id: "account", email: "a@qq.com", paused: false, failures: 0, lastError: null, lastChecked: null, headerIssues: 0 }], candidates: items, pendingCount: items.length };
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {};
  const invoke = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (handlers[name]) return handlers[name](args);
    if (name === "mailbox_view") return structuredClone(view);
    throw new Error(`Unexpected command: ${name}`);
  });
  const onImported = vi.fn(async () => {}), openSettings = vi.fn();
  const inboxBridge = { showPending: vi.fn(), showStored: vi.fn() };
  const ui = mountMailboxes(invoke as Invoke, onImported, openSettings, inboxBridge);
  disposers.push(ui.dispose);
  const pending = within(document.getElementById("mailbox-discovery")!);
  return { view, handlers, invoke, ui, pending, onImported, openSettings, inboxBridge };
}
function el<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(id)! as T; }
const checked = { checkedAccounts: 1, succeededAccounts: 1, failedAccounts: [], skippedPaused: 0 };

test("only supported providers receive built-in servers and matching illustrated help", async () => {
  setup();
  fireEvent.input(el("mailbox-email"), { target: { value: "A@163.COM" } });
  fireEvent.click(el("mailbox-detect"));
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
  fireEvent.click(el("mailbox-detect"));
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
  fireEvent.click(el("mailbox-detect"));
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
  expect(el("mailbox-tab-pending").getAttribute("aria-selected")).toBe("true");
  expect(el<HTMLButtonElement>("mailbox-save-selected").disabled).toBe(false);
});
test("a fully successful confirmation switches to the stored list", async () => {
  const { ui, view, handlers } = setup([candidate("one")]); await ui.refresh();
  fireEvent.click(el("mailbox-tab-pending"));
  handlers.mailbox_confirm = async () => { view.candidates = []; view.pendingCount = 0; return { imported: 1, duplicates: 0, failed: [] }; };
  fireEvent.click(el("mailbox-select-all")); fireEvent.click(el("mailbox-save-selected"));
  await waitFor(() => expect(el("mailbox-tab-stored").getAttribute("aria-selected")).toBe("true"));
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
  expect(el("mailbox-tab-pending").getAttribute("aria-selected")).toBe("true");
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

test("a manually paused mailbox keeps its real connection error", async () => {
  const { ui, view } = setup();
  view.accounts[0] = { ...view.accounts[0], paused: true, failures: 0, lastError: "Network" };
  await ui.refresh();
  expect(el("mailbox-accounts").textContent).toContain("连不上邮箱");
  expect(el("mailbox-accounts").textContent).toContain("已暂停检查");
  expect(el("mailbox-accounts").textContent).not.toContain("自动暂停");
  expect(el("mailbox-accounts").textContent).not.toContain("部分文件夹或邮件未完成");
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
  await waitFor(() => expect(el("mailbox-inbox-status").textContent).toContain("1 个完成，1 个失败"));
  expect(el("mailbox-inbox-status").textContent).toContain("2 个邮箱已暂停");
  expect(el("mailbox-inbox-status").textContent).toContain("网络不可用");
});

test("partial folder checks stay visible without claiming the whole account failed", async () => {
  const { ui, view, handlers } = setup(); await ui.refresh();
  handlers.mailbox_check = async () => {
    view.accounts[0].lastError = "Protocol"; view.accounts[0].failures = 0;
    return { ...checked, succeededAccounts: 0, partialAccounts: [{ accountId: "account", message: "垃圾邮件文件夹未完成", paused: false }] };
  };
  fireEvent.click(el("mailbox-inbox-check"));
  await waitFor(() => expect(el("mailbox-inbox-status").textContent).toContain("1 个部分完成"));
  expect(el("mailbox-inbox-status").textContent).toContain("垃圾邮件文件夹未完成");
  await waitFor(() => expect(el("mailbox-accounts").textContent).toContain("部分文件夹或邮件未完成"));
});

test("headers abandoned after three retries point to manual import", async () => {
  const { ui, view } = setup();
  view.accounts[0].headerIssues = 2;
  await ui.refresh();
  expect(el("mailbox-accounts").textContent).toContain("2 封邮件连续三次读不到信头");
  expect(el("mailbox-accounts").textContent).toContain("手动导入");
});

test("connecting successfully cannot overwrite a subsequent scan failure", async () => {
  const { handlers } = setup();
  handlers.mailbox_connect = async () => {};
  handlers.mailbox_check = async () => ({ ...checked, succeededAccounts: 0, failedAccounts: [{ accountId: "account", message: "网络中断", paused: false }] });
  fireEvent.input(el("mailbox-email"), { target: { value: "a@qq.com" } });
  fireEvent.click(el("mailbox-detect"));
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
  fireEvent.click(el("mailbox-detect"));
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("imap.gmail.com");
  expect(el("mailbox-secret-label").textContent).toBe("应用专用密码");
  expect(el("mailbox-guide-steps").textContent).toContain("两步验证");
  fireEvent.input(el("mailbox-email"), { target: { value: "a@mails.tsinghua.edu.cn" } });
  fireEvent.click(el("mailbox-detect"));
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("mails.tsinghua.edu.cn");
  expect(el("mailbox-secret-hint").textContent).toContain("清华邮箱请生成客户端专用密码");
  fireEvent.input(el("mailbox-email"), { target: { value: "a@mail.tsinghua.edu.cn" } });
  fireEvent.click(el("mailbox-detect"));
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("mail.tsinghua.edu.cn");
});
test("unknown school DNS failure leaves a usable manual connection form", async () => {
  const { handlers, invoke } = setup();
  handlers.mailbox_discover = async () => ({ config: null, source: "manual", note: "未能自动识别，请手动填写。", helpUrl: null });
  handlers.mailbox_connect = async () => {}; handlers.mailbox_check = async () => checked;
  fireEvent.input(el("mailbox-email"), { target: { value: "a@school.example" } });
  fireEvent.click(el("mailbox-detect"));
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
  fireEvent.click(el("mailbox-detect"));
  fireEvent.input(el("mailbox-host"), { target: { value: "manual.school.example" } });
  complete({ config: { host: "late.example", port: 993, encryption: "tls", username: "a@school.example", sendId: false }, note: "late", helpUrl: null });
  await Promise.resolve();
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("manual.school.example");
  fireEvent.click(el("mailbox-detect"));
  fireEvent.input(el("mailbox-email"), { target: { value: "b@gmail.com" } });
  fireEvent.click(el("mailbox-detect"));
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
  fireEvent.click(el("mailbox-detect"));
  expect(el("mailbox-detection").textContent).toContain("需要微软登录授权");
  expect(invoke.mock.calls).toHaveLength(0);
});

test("discovery waits for confirmation even after a pause or blur, then shows search progress", async () => {
  vi.useFakeTimers();
  const { handlers, invoke } = setup();
  let complete!: (value: unknown) => void;
  handlers.mailbox_discover = () => new Promise((resolve) => { complete = resolve; });
  fireEvent.input(el("mailbox-email"), { target: { value: "a@sjtu.edu.cn" } });
  expect(el("mailbox-progress-title").textContent).toBe("邮箱地址待确认");
  await vi.advanceTimersByTimeAsync(1500);
  fireEvent.blur(el("mailbox-email"));
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(el("mailbox-detect"));
  expect(invoke).toHaveBeenCalledWith("mailbox_discover", { email: "a@sjtu.edu.cn" });
  expect(el("mailbox-detection").dataset.state).toBe("searching");
  expect(el("mailbox-detection").getAttribute("aria-busy")).toBe("true");
  complete({ config: null, note: "没有可用的自动配置。", helpUrl: null });
  await vi.advanceTimersByTimeAsync(0);
  expect(el("mailbox-detection").dataset.state).toBe("manual");
  expect(el("mailbox-progress-title").textContent).toBe("未找到配置，需要手动填写");
  expect(el("mailbox-detection").getAttribute("aria-busy")).toBe("false");
  expect(el<HTMLDetailsElement>("mailbox-configuration").open).toBe(true);
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("");
});
test("preset config success is distinct from a successful mailbox connection", async () => {
  const { handlers } = setup();
  let connected!: () => void, scanned!: () => void;
  handlers.mailbox_connect = () => new Promise<void>((resolve) => { connected = resolve; });
  handlers.mailbox_check = () => new Promise((resolve) => { scanned = () => resolve(checked); });
  fireEvent.input(el("mailbox-email"), { target: { value: "a@qq.com" } });
  fireEvent.click(el("mailbox-detect"));
  expect(el("mailbox-detection").dataset.state).toBe("found");
  expect(el("mailbox-progress-detail").textContent).toContain("尚未连接");
  expect(el("mailbox-step-2").getAttribute("aria-current")).toBe("step");
  fireEvent.input(el("mailbox-secret"), { target: { value: "synthetic-secret" } });
  fireEvent.submit(el("mailbox-form"));
  expect(el("mailbox-detection").dataset.state).toBe("connecting");
  connected();
  await waitFor(() => expect(el("mailbox-detection").dataset.state).toBe("checking"));
  expect(el("mailbox-step-3").getAttribute("aria-current")).toBe("step");
  scanned();
  await waitFor(() => expect(el("mailbox-detection").dataset.state).toBe("connected"));
  expect(el("mailbox-progress-title").textContent).toContain("来信检查已完成");
});
test("failed login has a visible error state and cannot claim that configuration was saved", async () => {
  const { handlers } = setup();
  handlers.mailbox_connect = async () => { throw { message: "认证失败，请核对密码。" }; };
  fireEvent.input(el("mailbox-email"), { target: { value: "a@qq.com" } });
  fireEvent.click(el("mailbox-detect"));
  fireEvent.input(el("mailbox-secret"), { target: { value: "synthetic-secret" } });
  fireEvent.submit(el("mailbox-form"));
  await waitFor(() => expect(el("mailbox-detection").dataset.state).toBe("error"));
  expect(el("mailbox-progress-title").textContent).toBe("连接失败，配置尚未保存");
  expect(el("mailbox-progress-detail").textContent).toContain("认证失败");
});

test("same-domain corrections preserve manual connection settings and explain why credentials need re-entry", async () => {
  const { handlers, invoke } = setup();
  handlers.mailbox_connect = async () => {};
  handlers.mailbox_check = async () => checked;
  fireEvent.input(el("mailbox-email"), { target: { value: "typo@school.example" } });
  fireEvent.input(el("mailbox-host"), { target: { value: "manual.school.example" } });
  fireEvent.input(el("mailbox-port"), { target: { value: "143" } });
  fireEvent.change(el("mailbox-encryption"), { target: { value: "starttls" } });
  fireEvent.change(el("mailbox-send-id"), { target: { checked: true } });
  fireEvent.input(el("mailbox-username"), { target: { value: "shortname" } });
  fireEvent.input(el("mailbox-secret"), { target: { value: "old-synthetic-secret" } });
  fireEvent.input(el("mailbox-email"), { target: { value: "correct@school.example" } });
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("manual.school.example");
  expect(el<HTMLInputElement>("mailbox-port").value).toBe("143");
  expect(el<HTMLSelectElement>("mailbox-encryption").value).toBe("starttls");
  expect(el<HTMLInputElement>("mailbox-send-id").checked).toBe(true);
  expect(el<HTMLInputElement>("mailbox-username").value).toBe("shortname");
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("");
  expect(el("mailbox-secret-hint").textContent).toContain("原凭据已清除，请重新填写");
  expect(el("mailbox-progress-title").textContent).toContain("服务器配置已保留");
  fireEvent.blur(el("mailbox-email"));
  expect(invoke.mock.calls.some(([name]) => name === "mailbox_discover")).toBe(false);
  fireEvent.input(el("mailbox-secret"), { target: { value: "new-synthetic-secret" } });
  expect(el("mailbox-secret-hint").textContent).not.toContain("原凭据已清除");
  fireEvent.submit(el("mailbox-form"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("mailbox_connect", {
    email: "correct@school.example", secret: "new-synthetic-secret",
    config: { host: "manual.school.example", port: 143, encryption: "starttls", username: "shortname", sendId: true },
  }));
});

test("case and whitespace-only edits retain credentials and manual settings", () => {
  setup();
  fireEvent.input(el("mailbox-email"), { target: { value: "a@gmail.com" } });
  fireEvent.click(el("mailbox-detect"));
  fireEvent.input(el("mailbox-host"), { target: { value: "custom.gmail.example" } });
  fireEvent.input(el("mailbox-secret"), { target: { value: "synthetic-secret" } });
  fireEvent.input(el("mailbox-email"), { target: { value: " A@GMAIL.COM " } });
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("synthetic-secret");
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("custom.gmail.example");
  expect(el("mailbox-secret-hint").textContent).not.toContain("原凭据已清除");
});

test("changing domains discards previous custom settings and uses the new providers configuration", () => {
  setup();
  fireEvent.input(el("mailbox-email"), { target: { value: "a@school.example" } });
  fireEvent.input(el("mailbox-host"), { target: { value: "manual.school.example" } });
  fireEvent.input(el("mailbox-username"), { target: { value: "shortname" } });
  fireEvent.input(el("mailbox-secret"), { target: { value: "synthetic-secret" } });
  fireEvent.input(el("mailbox-email"), { target: { value: "b@gmail.com" } });
  fireEvent.click(el("mailbox-detect"));
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("imap.gmail.com");
  expect(el<HTMLInputElement>("mailbox-username").value).toBe("b@gmail.com");
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("");
  expect(el("mailbox-secret-label").textContent).toBe("应用专用密码");
});

test("DNS settings survive same-domain address correction while the default login follows the email", async () => {
  const { handlers, invoke } = setup();
  handlers.mailbox_discover = async () => ({ config: { host: "dns.school.example", port: 993, encryption: "tls", username: "typo@school.example", sendId: false }, note: "DNS found", helpUrl: null });
  fireEvent.input(el("mailbox-email"), { target: { value: "typo@school.example" } });
  fireEvent.click(el("mailbox-detect"));
  await waitFor(() => expect(el<HTMLInputElement>("mailbox-host").value).toBe("dns.school.example"));
  fireEvent.input(el("mailbox-email"), { target: { value: "correct@school.example" } });
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("dns.school.example");
  expect(el<HTMLInputElement>("mailbox-username").value).toBe("correct@school.example");
  fireEvent.blur(el("mailbox-email"));
  expect(invoke.mock.calls.filter(([name]) => name === "mailbox_discover")).toHaveLength(1);
});

test.each(["mailbox-encryption", "mailbox-send-id"])("change-only %s edits stop late DNS results from overwriting the form", async (id) => {
  const { handlers } = setup();
  let complete!: (value: unknown) => void;
  handlers.mailbox_discover = () => new Promise((resolve) => { complete = resolve; });
  fireEvent.input(el("mailbox-email"), { target: { value: "a@school.example" } });
  fireEvent.click(el("mailbox-detect"));
  if (id === "mailbox-encryption") fireEvent.change(el(id), { target: { value: "starttls" } });
  else fireEvent.change(el(id), { target: { checked: true } });
  complete({ config: { host: "late.school.example", port: 993, encryption: "tls", username: "a@school.example", sendId: false }, note: "late", helpUrl: null });
  // Drain the async mock's promise adoption and the discovery continuation.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("");
  expect(el("mailbox-detection").dataset.state).toBe("edited");
  if (id === "mailbox-encryption") expect(el<HTMLSelectElement>(id).value).toBe("starttls");
  else expect(el<HTMLInputElement>(id).checked).toBe(true);
});

test("case-only editing while DNS is in flight still accepts the matching result", async () => {
  const { handlers } = setup();
  let complete!: (value: unknown) => void;
  handlers.mailbox_discover = () => new Promise((resolve) => { complete = resolve; });
  fireEvent.input(el("mailbox-email"), { target: { value: "a@school.example" } });
  fireEvent.click(el("mailbox-detect"));
  fireEvent.input(el("mailbox-email"), { target: { value: "A@SCHOOL.EXAMPLE" } });
  complete({ config: { host: "dns.school.example", port: 993, encryption: "tls", username: "a@school.example", sendId: false }, note: "DNS found", helpUrl: null });
  await waitFor(() => expect(el("mailbox-detection").dataset.state).toBe("found"));
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("dns.school.example");
});

test("Enter in the address field identifies without submitting the connection form", async () => {
  const { handlers, invoke } = setup();
  handlers.mailbox_discover = async () => ({ config: null, note: "需手动配置", helpUrl: null });
  fireEvent.input(el("mailbox-email"), { target: { value: "a@school.example" } });
  const preventDefault = !fireEvent.keyDown(el("mailbox-email"), { key: "Enter" });
  expect(preventDefault).toBe(true);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("mailbox_discover", { email: "a@school.example" }));
  expect(invoke.mock.calls.some(([name]) => name === "mailbox_connect")).toBe(false);
});

test("preset servers also wait for an explicit address confirmation", () => {
  const { invoke } = setup();
  fireEvent.input(el("mailbox-email"), { target: { value: "a@gmail.com" } });
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("");
  expect(el("mailbox-detection").dataset.state).toBe("typing");
  fireEvent.keyDown(el("mailbox-email"), { key: "Enter" });
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("imap.gmail.com");
  expect(el("mailbox-detection").dataset.state).toBe("found");
  expect(invoke).not.toHaveBeenCalled();
});

test("confirming an incomplete domain explains the address requirement without querying DNS", () => {
  const { invoke } = setup();
  fireEvent.input(el("mailbox-email"), { target: { value: "a@sjtu" } });
  fireEvent.keyDown(el("mailbox-email"), { key: "Enter" });
  expect(el("mailbox-progress-title").textContent).toBe("请填写完整邮箱地址");
  expect(invoke).not.toHaveBeenCalled();
});

test("IME confirmation and key repetition do not start discovery, and repeated confirm clicks share the request", () => {
  const { handlers, invoke } = setup();
  handlers.mailbox_discover = () => new Promise(() => {});
  fireEvent.input(el("mailbox-email"), { target: { value: "a@school.example" } });
  fireEvent.keyDown(el("mailbox-email"), { key: "Enter", isComposing: true });
  fireEvent.keyDown(el("mailbox-email"), { key: "Enter", repeat: true });
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(el("mailbox-detect"));
  fireEvent.click(el("mailbox-detect"));
  expect(invoke.mock.calls.filter(([name]) => name === "mailbox_discover")).toHaveLength(1);
});

const externalConfig = { host: "mail.external.example", port: 993, encryption: "tls" as const, username: "a@school.example", sendId: false };
async function discoverExternal() {
  const context = setup();
  context.handlers.mailbox_discover = async () => ({ config: externalConfig, source: "dns", note: "DNS returned a host", helpUrl: null });
  fireEvent.input(el("mailbox-email"), { target: { value: "a@school.example" } });
  fireEvent.click(el("mailbox-detect"));
  await waitFor(() => expect(el("mailbox-endpoint-review").hidden).toBe(false));
  return context;
}

test("unfamiliar DNS host stays pending, blocks secrets and cannot submit until explicitly accepted", async () => {
  const { handlers, invoke, ui } = await discoverExternal();
  expect(el("mailbox-progress-title").textContent).toBe("发现跨域服务器，待核对");
  expect(el("mailbox-endpoint-detail").textContent).toContain("school.example");
  expect(el("mailbox-endpoint-detail").textContent).toContain("mail.external.example");
  expect(el<HTMLInputElement>("mailbox-secret").disabled).toBe(true);
  expect(el<HTMLButtonElement>("mailbox-save").disabled).toBe(true);
  await ui.refresh();
  expect(el<HTMLButtonElement>("mailbox-save").disabled).toBe(true);
  fireEvent.input(el("mailbox-secret"), { target: { value: "synthetic-secret" } });
  fireEvent.submit(el("mailbox-form"));
  expect(invoke.mock.calls.some(([name]) => name === "mailbox_connect")).toBe(false);
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("");
  fireEvent.click(el("mailbox-confirm-endpoint"));
  expect(el("mailbox-endpoint-review").hidden).toBe(true);
  expect(el<HTMLInputElement>("mailbox-secret").disabled).toBe(false);
  expect(el<HTMLButtonElement>("mailbox-save").disabled).toBe(false);
  handlers.mailbox_connect = async () => {}; handlers.mailbox_check = async () => checked;
  fireEvent.input(el("mailbox-secret"), { target: { value: "synthetic-secret" } });
  fireEvent.submit(el("mailbox-form"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("mailbox_connect", {
    email: "a@school.example", secret: "synthetic-secret", config: { ...externalConfig, endpointConfirmation: { email: "a@school.example", ...externalConfig } },
  }));
});

test.each(["mailbox-host", "mailbox-port", "mailbox-encryption", "mailbox-username", "mailbox-send-id", "mailbox-email"])("editing %s invalidates prior endpoint acceptance", async (id) => {
  const { invoke } = await discoverExternal();
  fireEvent.click(el("mailbox-confirm-endpoint"));
  fireEvent.input(el("mailbox-secret"), { target: { value: "synthetic-secret" } });
  if (id === "mailbox-send-id") fireEvent.change(el(id), { target: { checked: true } });
  else if (id === "mailbox-encryption") fireEvent.change(el(id), { target: { value: "starttls" } });
  else fireEvent.input(el(id), { target: { value: id === "mailbox-host" ? "mail.changed.example" : id === "mailbox-port" ? "143" : id === "mailbox-email" ? "b@school.example" : "shortname" } });
  expect(el("mailbox-endpoint-review").hidden).toBe(false);
  expect(el<HTMLInputElement>("mailbox-secret").disabled).toBe(true);
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("");
  fireEvent.submit(el("mailbox-form"));
  expect(invoke.mock.calls.some(([name]) => name === "mailbox_connect")).toBe(false);
});

test.each(["mail.school.example", "imap.exmail.qq.com", "imap.qiye.163.com"])("same-domain or canonical provider host %s needs no extra acceptance", async (host) => {
  const { handlers } = setup();
  handlers.mailbox_discover = async () => ({ config: { ...externalConfig, host }, source: "dns", note: "DNS returned a host", helpUrl: null });
  fireEvent.input(el("mailbox-email"), { target: { value: "a@school.example" } });
  fireEvent.click(el("mailbox-detect"));
  await waitFor(() => expect(el("mailbox-detection").dataset.state).toBe("found"));
  expect(el("mailbox-endpoint-review").hidden).toBe(true);
  expect(el<HTMLInputElement>("mailbox-secret").disabled).toBe(false);
});

test("a discovery response cannot approve its own unrelated host", async () => {
  const { handlers } = setup();
  handlers.mailbox_discover = async () => ({ config: { ...externalConfig, endpointConfirmation: { email: "a@school.example", ...externalConfig } }, source: "preset", note: "forged trust claim", helpUrl: null });
  fireEvent.input(el("mailbox-email"), { target: { value: "a@school.example" } });
  fireEvent.click(el("mailbox-detect"));
  await waitFor(() => expect(el("mailbox-endpoint-review").hidden).toBe(false));
  expect(el<HTMLInputElement>("mailbox-secret").disabled).toBe(true);
});

test("legacy unfamiliar saved host remains editable but requires acceptance before new credentials", async () => {
  const { ui, view } = setup();
  view.accounts[0] = { ...view.accounts[0], email: "a@school.example", connection: externalConfig };
  await ui.refresh();
  fireEvent.click(within(el("mailbox-accounts")).getByRole("button", { name: "修改连接 / 更新凭据" }));
  expect(el<HTMLInputElement>("mailbox-host").value).toBe(externalConfig.host);
  expect(el("mailbox-endpoint-review").hidden).toBe(false);
});

test("NetEase endpoint acceptance includes the client ID required by native validation", async () => {
  const { handlers, invoke } = setup();
  handlers.mailbox_connect = async () => {}; handlers.mailbox_check = async () => checked;
  fireEvent.input(el("mailbox-email"), { target: { value: "a@163.com" } });
  fireEvent.click(el("mailbox-detect"));
  fireEvent.input(el("mailbox-host"), { target: { value: externalConfig.host } });
  fireEvent.change(el("mailbox-send-id"), { target: { checked: false } });
  expect(el<HTMLInputElement>("mailbox-send-id").checked).toBe(true);
  fireEvent.click(el("mailbox-confirm-endpoint"));
  fireEvent.input(el("mailbox-secret"), { target: { value: "synthetic-secret" } });
  fireEvent.submit(el("mailbox-form"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("mailbox_connect", {
    email: "a@163.com", secret: "synthetic-secret",
    config: { ...externalConfig, username: "a@163.com", sendId: true,
      endpointConfirmation: { email: "a@163.com", ...externalConfig, username: "a@163.com", sendId: true } },
  }));
});

test("saved acceptance is restored only for the same destination", async () => {
  const { ui, view } = setup();
  view.accounts[0] = { ...view.accounts[0], email: "a@school.example", connection: { ...externalConfig, endpointConfirmation: { email: "a@school.example", ...externalConfig } } };
  await ui.refresh();
  fireEvent.click(within(el("mailbox-accounts")).getByRole("button", { name: "修改连接 / 更新凭据" }));
  expect(el("mailbox-endpoint-review").hidden).toBe(true);
  expect(el<HTMLInputElement>("mailbox-secret").disabled).toBe(false);
  fireEvent.input(el("mailbox-email"), { target: { value: " A@SCHOOL.EXAMPLE " } });
  expect(el("mailbox-endpoint-review").hidden).toBe(true);
  fireEvent.input(el("mailbox-host"), { target: { value: "mail.changed.example" } });
  expect(el("mailbox-endpoint-review").hidden).toBe(false);
});

test("damaged candidate counts stay visible while healthy candidates can be processed", async () => {
  const { ui, view, handlers } = setup();
  view.candidateIssues = 2;
  await ui.refresh();
  fireEvent.click(el("mailbox-tab-pending"));
  expect(el("mailbox-discovery-note").textContent).toContain("2 条候选记录损坏");
  expect(el("mailbox-discovery-note").textContent).toContain("未删除");
  expect(el("mailbox-pending-count").textContent).toBe("1");
  expect(el("mailbox-load-more").hidden).toBe(true);
  handlers.mailbox_confirm = async () => {
    view.candidates = []; view.pendingCount = 0;
    return { imported: 1, duplicates: 0, failed: [] };
  };
  fireEvent.click(within(el("mailbox-candidates")).getByRole("button", { name: "存进档案" }));
  await waitFor(() => expect(el("mailbox-pending-count").textContent).toBe("0"));
  expect(el("mailbox-discovery-note").textContent).toContain("2 条候选记录损坏");
  expect(el("mailbox-load-more").hidden).toBe(true);
  view.candidateIssues = 0; await ui.refresh();
  expect(el("mailbox-discovery-note").textContent).not.toContain("候选记录损坏");
});

test("only damaged candidates produce a warning without fake pending actions or pagination", async () => {
  const { ui, view } = setup([]); view.candidateIssues = 3;
  await ui.refresh(); fireEvent.click(el("mailbox-tab-pending"));
  expect(el("mailbox-pending-count").textContent).toBe("0");
  expect(el("mailbox-discovery-note").textContent).toContain("3 条候选记录损坏");
  expect(el("mailbox-discovery-note").textContent).toContain("手动导入");
  expect(el("mailbox-pending-actions").hidden).toBe(true);
  expect(el("mailbox-load-more").hidden).toBe(true);
});

test("damaged account configuration shows repair guidance and keeps account controls available", async () => {
  const { ui, view } = setup();
  view.accounts[0].connection = null;
  view.accounts[0].paused = true;
  view.accounts[0].lastError = "Configuration";
  await ui.refresh();
  const accounts = within(el("mailbox-accounts"));
  expect(el("mailbox-accounts").textContent).toContain("本机邮箱连接配置无法读取或已失效");
  expect(accounts.getByRole("button", { name: "修改连接 / 更新凭据" })).toBeTruthy();
  expect(accounts.getByRole("button", { name: "断开并移除" })).toBeTruthy();
  expect(el("mailbox-candidates").textContent).toContain("星河科技面试邀请");
});

test("Microsoft login uses a dedicated command, supports immediate cancellation and never submits a password", async () => {
  const { handlers, invoke } = setup();
  let finish!: () => void;
  handlers.mailbox_microsoft_connect = (args) => { expect(args).toEqual({ accountId: null }); return new Promise<void>((resolve) => { finish = resolve; }); };
  handlers.mailbox_microsoft_cancel = () => { finish(); };
  fireEvent.input(el("mailbox-secret"), { target: { value: "draft-password" } });
  fireEvent.click(el("mailbox-microsoft-connect"));
  expect(el<HTMLInputElement>("mailbox-secret").value).toBe("");
  expect(el<HTMLButtonElement>("mailbox-microsoft-cancel").hidden).toBe(false);
  expect(el<HTMLButtonElement>("mailbox-microsoft-connect").disabled).toBe(true);
  fireEvent.click(el("mailbox-microsoft-cancel"));
  await waitFor(() => expect(el<HTMLButtonElement>("mailbox-microsoft-cancel").hidden).toBe(true));
  expect(invoke.mock.calls.some(([name]) => ["mailbox_connect", "mailbox_check", "mailbox_confirm"].includes(name))).toBe(false);
});

test("missing Microsoft release configuration and organization refusal show actionable fallback text", async () => {
  const { handlers } = setup();
  handlers.mailbox_microsoft_connect = () => { throw { message: "此版本尚未配置微软登录。无需自行注册开发者应用，可先手动导入。" }; };
  fireEvent.click(el("mailbox-microsoft-connect"));
  await waitFor(() => expect(el("mailbox-settings-status").textContent).toContain("无需自行注册"));
  expect(el<HTMLButtonElement>("mailbox-microsoft-cancel").hidden).toBe(true);
  handlers.mailbox_microsoft_connect = () => { throw { message: "学校管理员策略阻止了授权，请从网页保存邮件或手动导入。" }; };
  fireEvent.click(el("mailbox-microsoft-connect"));
  await waitFor(() => expect(el("mailbox-settings-status").textContent).toContain("管理员策略"));
  expect(el("mailbox-manual-import")).toBeTruthy();
});

test("Microsoft account controls reauthorize the exact local account and do not advertise mail scanning", async () => {
  const { handlers, view, ui, invoke } = setup();
  view.accounts[0].source = "microsoftGraph";
  view.accounts[0].email = "person@outlook.com";
  handlers.mailbox_microsoft_connect = () => {};
  await ui.refresh();
  const accounts = within(el("mailbox-accounts"));
  expect(accounts.queryByText("修改连接 / 更新凭据")).toBeNull();
  expect(accounts.queryByText("检查已启用")).toBeNull();
  expect(accounts.getByText(/此版本尚未启用自动收取/)).toBeTruthy();
  fireEvent.click(accounts.getByRole("button", { name: "重新授权" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("mailbox_microsoft_connect", { accountId: "account" }));
});

test("Microsoft disconnect explains local cleanup and Microsoft-side revocation separately", async () => {
  const { handlers, view, ui } = setup(); view.accounts[0].source = "microsoftGraph";
  handlers.mailbox_delete = () => { view.accounts = []; };
  await ui.refresh();
  fireEvent.click(within(el("mailbox-accounts")).getByRole("button", { name: "断开并移除" }));
  await waitFor(() => expect(el("mailbox-settings-status").textContent).toContain("微软侧授权"));
  expect(el("mailbox-settings-status").textContent).toContain("已入档邮件保留");
});

test("Microsoft-hosted school discovery routes to official login without guessing an IMAP address", async () => {
  const { handlers } = setup();
  handlers.mailbox_discover = () => ({ config: null, source: "microsoft", note: "微软托管，取决于组织策略", helpUrl: null });
  fireEvent.input(el("mailbox-email"), { target: { value: "person@school.example" } }); fireEvent.click(el("mailbox-detect"));
  await waitFor(() => expect(el("mailbox-detection").textContent).toContain("需要微软登录授权"));
  expect(el<HTMLInputElement>("mailbox-host").value).toBe("");
});
