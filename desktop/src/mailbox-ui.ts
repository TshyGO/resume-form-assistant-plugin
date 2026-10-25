import type { Invoke } from "./api.ts";

interface MailHeader { fromAddr: string | null; fromName: string | null; subject: string | null; sentAt: string | null }
export interface MailCandidate { id: string; accountId: string; email: string; header: MailHeader; reasons: string[] }
export interface MailAccount { id: string; email: string; paused: boolean; failures: number; lastError: string | null; lastChecked: number | null; headerIssues: number }
export interface MailboxView { accounts: MailAccount[]; candidates: MailCandidate[]; pendingCount: number }
interface ConfirmReport { imported: number; duplicates: number; failed: Array<{ id: string; message: string }> }
interface IgnoreReport { ignored: number; unchanged: number }
interface CheckReport {
  checkedAccounts: number;
  succeededAccounts: number;
  failedAccounts: Array<{ accountId: string; message: string; paused: boolean }>;
  partialAccounts?: Array<{ accountId: string; message: string; paused: boolean }>;
  skippedPaused: number;
}

export interface MailboxInboxBridge {
  showPending(candidate: MailCandidate | null, actions?: { save(): void; ignore(): void }): void;
  showStored(): void | Promise<void>;
}

const ERRORS: Record<string, string> = {
  Auth: "登录被拒绝：请开启 IMAP，并重新生成授权码后测试连接。",
  ImapDisabled: "邮箱未开启 IMAP，请按教程开启后重试。",
  Network: "连不上邮箱，请检查网络后重试。",
  Tls: "安全连接验证失败，请检查系统时间和网络。",
  Credentials: "系统凭据库不可用或缺少授权码，请解锁或更新授权码。",
  Protocol: "邮箱读取请求未完成，请重试；163 / 126 请核对 IMAP 授权设置。",
  TooLarge: "邮件信头过大，请改用手动导入并检查邮箱。",
  Storage: "扫描记录未保存，请检查本机磁盘后重试。",
};
function message(error: unknown): string { return (error as { message?: string } | null)?.message || "操作没有完成，请稍后重试。"; }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}
export function mailboxProvider(email: string): "qq" | "163" | "126" | null {
  const value = email.trim().toLowerCase();
  if (!/^[a-z0-9._+\-]+@(?:qq\.com|foxmail\.com|163\.com|126\.com)$/.test(value)) return null;
  return value.endsWith("@163.com") ? "163" : value.endsWith("@126.com") ? "126" : "qq";
}
function formattedTime(unix: number | null) { return unix ? new Date(unix * 1000).toLocaleString() : "尚未完成检查"; }

export function mountMailboxes(
  invoke: Invoke,
  onImported: () => Promise<unknown>,
  openSettings: () => void,
  inboxBridge?: MailboxInboxBridge,
) {
  const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
  const form = get<HTMLFormElement>("mailbox-form");
  const email = get<HTMLInputElement>("mailbox-email");
  const secret = get<HTMLInputElement>("mailbox-secret");
  const guide = get<HTMLSelectElement>("mailbox-guide-provider");
  const selected = new Set<string>();
  const failures = new Map<string, string>();
  let current: MailboxView = { accounts: [], candidates: [], pendingCount: 0 };
  let busy = false;
  let limit = 100;
  let refreshToken = 0;
  let signature = "";
  let inboxState: "pending" | "stored" = "stored";
  let activeCandidateId: string | null = null;
  const actionIds = ["mailbox-save", "mailbox-settings-check", "mailbox-inbox-check", "mailbox-save-selected", "mailbox-ignore-selected", "mailbox-load-more"];
  function say(where: "settings" | "inbox", text: string, error = false) {
    const el = get(`mailbox-${where}-status`);
    el.textContent = text;
    el.dataset.tone = error ? "error" : "info";
  }
  function syncButtons() {
    actionIds.forEach((id) => { get<HTMLButtonElement>(id).disabled = busy || ((id === "mailbox-save-selected" || id === "mailbox-ignore-selected") && !selected.size); });
    email.readOnly = busy; secret.readOnly = busy;
    document.querySelectorAll<HTMLInputElement | HTMLButtonElement>("#mailbox-accounts button, #mailbox-candidates input, #mailbox-candidates button, #mailbox-select-all, #inbox-preview [data-pending-action]").forEach((el) => { el.disabled = busy; });
    document.querySelectorAll<HTMLInputElement>("#mailbox-candidates input[type=checkbox]").forEach((el) => { el.checked = selected.has(el.dataset.mailboxCandidateId!); });
    const all = get<HTMLInputElement>("mailbox-select-all");
    all.checked = current.candidates.length > 0 && current.candidates.every((item) => selected.has(item.id));
    all.indeterminate = selected.size > 0 && !all.checked;
  }
  async function action(where: "settings" | "inbox", progress: string, run: () => Promise<void>) {
    if (busy) return;
    busy = true; ++refreshToken; syncButtons(); say(where, progress);
    try { await run(); }
    catch (error) { say(where, message(error), true); }
    finally { busy = false; signature = ""; syncButtons(); await refresh(); }
  }
  function button(text: string, click: () => void) {
    const el = node("button", text); el.type = "button"; el.addEventListener("click", click); return el;
  }
  function selectInboxState(state: "pending" | "stored") {
    inboxState = state;
    const pending = state === "pending";
    const pendingTab = get<HTMLButtonElement>("mailbox-tab-pending");
    const storedTab = get<HTMLButtonElement>("mailbox-tab-stored");
    pendingTab.setAttribute("aria-selected", String(pending));
    storedTab.setAttribute("aria-selected", String(!pending));
    get("mailbox-discovery").hidden = !pending;
    get("inbox-stored-panel").hidden = pending;
    if (pending) showActiveCandidate();
    else if (typeof inboxBridge?.showStored === "function") void inboxBridge.showStored();
  }
  function showActiveCandidate() {
    const candidate = current.candidates.find((item) => item.id === activeCandidateId) ?? current.candidates[0] ?? null;
    activeCandidateId = candidate?.id ?? null;
    get("mailbox-candidates").querySelectorAll<HTMLElement>("li[data-candidate]").forEach((item) => {
      const active = item.dataset.candidate === activeCandidateId;
      item.classList.toggle("active", active);
      item.querySelector("button[data-candidate-open]")?.setAttribute("aria-current", String(active));
    });
    if (typeof inboxBridge?.showPending === "function") {
      inboxBridge.showPending(candidate, candidate ? {
        save: () => void saveCandidates([candidate.id]),
        ignore: () => void ignore([candidate.id]),
      } : undefined);
    }
    syncButtons();
  }
  function selectCandidate(candidate: MailCandidate) {
    activeCandidateId = candidate.id;
    showActiveCandidate();
  }
  async function checkNow(where: "settings" | "inbox", prefix = "") {
    const report = await invoke<CheckReport>("mailbox_check");
    if (!report || !Array.isArray(report.failedAccounts)) {
      throw { message: `${prefix}没有取得检查结果，请等待桌面更新完成后重试。` };
    }
    const paused = report.skippedPaused + report.failedAccounts.filter((account) => account.paused).length;
    const partial = report.partialAccounts ?? [];
    const recovery = paused ? ` ${paused} 个邮箱已暂停，请到「设置 → 邮箱」处理后点「恢复检查」。` : "";
    if (!report.checkedAccounts) {
      say(where, prefix + (paused ? `本次未检查邮箱。${recovery}` : "还没有连接邮箱，请先到「设置 → 邮箱」连接。"), true);
    } else if (report.failedAccounts.length || partial.length) {
      const reasons = [...new Set([...report.failedAccounts, ...partial].map((account) => account.message))].join("；");
      const result = [`${report.succeededAccounts} 个完成`];
      if (partial.length) result.push(`${partial.length} 个部分完成`);
      if (report.failedAccounts.length) result.push(`${report.failedAccounts.length} 个失败`);
      say(where, `${prefix}已检查 ${report.checkedAccounts} 个邮箱：${result.join("，")}。${reasons}${recovery}`, true);
    } else {
      say(where, `${prefix}已成功检查 ${report.succeededAccounts} 个邮箱，请查看待确认邮件。${recovery}`, paused > 0);
    }
  }
  function render() {
    const valid = new Set(current.candidates.map((item) => item.id));
    for (const id of selected) if (!valid.has(id)) selected.delete(id);
    if (activeCandidateId && !valid.has(activeCandidateId)) activeCandidateId = null;
    const accounts = get("mailbox-accounts"); accounts.replaceChildren();
    if (!current.accounts.length) accounts.append(node("p", "还没有连接邮箱。按上方教程获取授权码后，即可连接。", "settings-caption"));
    current.accounts.forEach((account) => {
      const card = node("article", undefined, "mailbox-account");
      card.append(node("h3", account.email));
      card.append(node("p", `${account.paused ? "已暂停" : "检查已启用"} · 最近成功检查：${formattedTime(account.lastChecked)}`, "settings-caption"));
      if (account.lastError) {
        const detail = account.failures === 0
          ? "部分文件夹或邮件未完成，其他邮件已继续扫描；程序会稍后重试。"
          : `${ERRORS[account.lastError] || "检查失败，请重新测试连接。"}${account.paused ? " 连续失败已自动暂停，处理后恢复检查。" : ` 已连续失败 ${account.failures} 次。`}`;
        card.append(node("p", detail, "mailbox-error"));
      }
      if (account.headerIssues) card.append(node("p", `${account.headerIssues} 封邮件连续三次读不到信头，已停止自动重试；需要时请从邮箱下载后手动导入。`, "mailbox-error"));
      const controls = node("div", undefined, "settings-actions");
      controls.append(button("更新授权码", () => { email.value = account.email; updateProvider(); secret.focus(); }));
      controls.append(button(account.paused ? "恢复检查" : "暂停检查", () => void action("settings", "正在更新检查状态…", async () => {
        await invoke("mailbox_pause", { id: account.id, paused: !account.paused });
        if (account.paused) await checkNow("settings");
        else say("settings", "已暂停此邮箱。");
      })));
      controls.append(button("断开并移除", () => void action("settings", "正在断开邮箱…", async () => {
        await invoke("mailbox_delete", { id: account.id });
        say("settings", "已断开邮箱并清除本机候选、扫描与忽略记录，已入档邮件保留。");
      })));
      card.append(controls); accounts.append(card);
    });
    get("mailbox-pending-count").textContent = String(current.pendingCount);
    const broken = current.accounts.filter((account) => account.lastError).length;
    get("mailbox-discovery-note").textContent = broken
      ? `${broken} 个邮箱检查异常，请到邮箱设置查看原因。已发现的邮件仍可确认或忽略。`
      : current.accounts.length ? "只显示信头和入选原因，存进档案时才下载原文。筛选可能漏信，仍可手动导入。" : "连接邮箱后，招聘相关来信会先出现在这里，确认才下载原文并存进档案。";
    get("mailbox-connect-link").textContent = current.accounts.length ? "邮箱设置" : "连接邮箱";
    get("mailbox-pending-actions").hidden = !current.candidates.length;
    get("mailbox-load-more").hidden = current.candidates.length >= current.pendingCount || limit >= 2000;
    const list = get("mailbox-candidates"); list.replaceChildren();
    current.candidates.forEach((item) => {
      const li = node("li");
      li.dataset.candidate = item.id;
      li.classList.toggle("active", item.id === activeCandidateId);
      const label = node("label", undefined, "mailbox-candidate-title");
      const check = node("input"); check.type = "checkbox"; check.checked = selected.has(item.id);
      check.dataset.mailboxCandidateId = item.id;
      check.setAttribute("aria-label", `选择 ${item.header.subject || "无主题邮件"}`);
      check.addEventListener("change", () => { if (check.checked) selected.add(item.id); else selected.delete(item.id); syncButtons(); });
      label.append(check, node("strong", item.header.subject || "无主题邮件")); li.append(label);
      li.append(node("p", `${item.header.fromName || ""} ${item.header.fromAddr || "未知发件人"} · ${item.header.sentAt ? new Date(item.header.sentAt).toLocaleString() : "发送时间未知"}`, "settings-caption"));
      li.append(node("p", `发现于 ${item.email}`, "settings-caption"));
      li.append(node("p", `入选原因：${item.reasons.join("；")}`, "mailbox-reasons"));
      if (failures.has(item.id)) li.append(node("p", failures.get(item.id), "mailbox-error"));
      const controls = node("div", undefined, "settings-actions");
      const inspect = button("查看", () => selectCandidate(item));
      inspect.dataset.candidateOpen = item.id;
      inspect.setAttribute("aria-current", String(item.id === activeCandidateId));
      controls.append(inspect);
      controls.append(button("存进档案", () => void saveCandidates([item.id])));
      controls.append(button("忽略", () => void ignore([item.id])));
      li.append(controls); list.append(li);
    });
    if (limit >= 2000 && current.pendingCount > current.candidates.length) list.append(node("li", "先处理当前显示的邮件，后续候选会继续补入。"));
    if (inboxState === "pending") showActiveCandidate();
    syncButtons();
  }
  async function refresh() {
    if (busy) return;
    const token = ++refreshToken;
    try {
      const view = await invoke<MailboxView>("mailbox_view", { limit });
      if (token !== refreshToken || busy) return;
      const next = JSON.stringify(view);
      current = view;
      if (next !== signature) { signature = next; render(); }
    } catch (error) {
      if (token !== refreshToken) return;
      say("settings", `读不到邮箱状态：${message(error)}`, true);
      say("inbox", `读不到邮箱候选：${message(error)}`, true);
    }
  }
  async function saveCandidates(ids: string[]) {
    await action("inbox", "正在下载并存进档案…", async () => {
      let imported = 0, duplicates = 0, failed = 0;
      // Host bounds each batch; partial failures keep their candidates and reasons.
      try {
        for (let start = 0; start < ids.length; start += 100) {
          const report = await invoke<ConfirmReport>("mailbox_confirm", { ids: ids.slice(start, start + 100) });
          imported += report.imported; duplicates += report.duplicates; failed += report.failed.length;
          const bad = new Set(report.failed.map((item) => item.id));
          report.failed.forEach((item) => failures.set(item.id, item.message));
          ids.slice(start, start + 100).filter((id) => !bad.has(id)).forEach((id) => { selected.delete(id); failures.delete(id); });
        }
        say("inbox", `已存进档案 ${imported} 封，已有 ${duplicates} 封${failed ? `，失败 ${failed} 封，请查看对应原因后重试` : ""}。`, failed > 0);
      } finally {
        // Refresh committed chunks even if a later chunk's IPC request fails.
        if (imported + duplicates > 0) {
          try { await onImported(); } catch { say("inbox", "邮件已处理，档案列表刷新失败，请刷新列表查看，无需重复导入。", true); }
          selectInboxState("stored");
        }
      }
    });
  }
  async function ignore(ids: string[]) {
    await action("inbox", "正在忽略…", async () => {
      const report = await invoke<IgnoreReport>("mailbox_ignore", { ids });
      ids.forEach((id) => { selected.delete(id); failures.delete(id); });
      const changed = report?.ignored ?? 0;
      const unchanged = report?.unchanged ?? ids.length - changed;
      say("inbox", changed
        ? `已忽略 ${changed} 封，不会再提示；邮箱原件保持原样。${unchanged ? ` 另外 ${unchanged} 封已被其他操作处理。` : ""}`
        : "这些邮件已被其他操作处理，列表已刷新。", unchanged > 0);
    });
  }
  function updateGuide() {
    const provider = ["qq", "163", "126"].includes(guide.value) ? guide.value : "qq";
    const label = provider === "qq" ? "QQ 邮箱" : `${provider} 邮箱`;
    const image = get<HTMLImageElement>("mailbox-guide-image");
    image.src = `/mailbox-guide-${provider}.svg`; image.alt = `${label}：进入设置，开启 IMAP，完成验证后生成授权码`;
    const steps = provider === "qq"
      ? ["登录 QQ 邮箱网页版，在设置中找到账号与安全 → 安全设置；旧版可在账号页找到服务设置。", "找到 IMAP/SMTP 服务并开启，按页面要求完成安全验证。", "点击生成授权码，复制后回到这里粘贴，点击测试连接并保存。"]
      : [`登录 ${provider} 邮箱网页版，进入设置 → POP3/SMTP/IMAP；部分界面位于常规设置中。`, "开启 IMAP/SMTP 服务，按页面要求使用绑定手机完成验证。", "生成并复制客户端授权码，回到这里粘贴，点击测试连接并保存。"];
    get("mailbox-guide-steps").replaceChildren(...steps.map((step) => node("li", step)));
  }
  function updateProvider() {
    const provider = mailboxProvider(email.value);
    get("mailbox-server").textContent = provider ? `IMAP：imap.${provider === "qq" ? "qq" : provider}.com · 993 · TLS` : "支持 QQ（含 foxmail.com）、163、126 邮箱，填写后自动识别服务器。";
    if (provider) { guide.value = provider; updateGuide(); }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!mailboxProvider(email.value) || !secret.value.trim()) { say("settings", "请填写支持的邮箱地址和授权码。", true); return; }
    void action("settings", "正在测试连接，通过后才保存…", async () => {
      try {
        await invoke("mailbox_connect", { email: email.value.trim(), secret: secret.value });
        say("settings", "连接已保存，正在检查最近 30 天的邮件…");
        await checkNow("settings", "连接已保存。");
      } finally { secret.value = ""; }
    });
  });
  email.addEventListener("input", updateProvider); guide.addEventListener("change", updateGuide);
  ["mailbox-settings-check", "mailbox-inbox-check"].forEach((id) => get(id).addEventListener("click", () => {
    const where = id.includes("settings") ? "settings" : "inbox";
    void action(where, "正在检查邮箱…", () => checkNow(where));
  }));
  get("mailbox-connect-link").addEventListener("click", openSettings);
  get("mailbox-tab-pending").addEventListener("click", () => selectInboxState("pending"));
  get("mailbox-tab-stored").addEventListener("click", () => selectInboxState("stored"));
  get<HTMLInputElement>("mailbox-select-all").addEventListener("change", (event) => {
    current.candidates.forEach((item) => { if ((event.target as HTMLInputElement).checked) selected.add(item.id); else selected.delete(item.id); }); syncButtons();
  });
  get("mailbox-save-selected").addEventListener("click", () => void saveCandidates([...selected]));
  get("mailbox-ignore-selected").addEventListener("click", () => void ignore([...selected]));
  get("mailbox-load-more").addEventListener("click", () => { limit += 100; void refresh(); });
  updateGuide(); updateProvider(); selectInboxState("stored");
  return { refresh };
}
