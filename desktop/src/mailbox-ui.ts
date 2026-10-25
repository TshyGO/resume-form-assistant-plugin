import type { Invoke } from "./api.ts";
import { MAIL_GUIDES, mailboxProvider, localMailConnection } from "./mailbox-providers.ts";
import type { MailConnection, MailProvider } from "./mailbox-providers.ts";
export { mailboxProvider } from "./mailbox-providers.ts";

interface MailHeader { fromAddr: string | null; fromName: string | null; subject: string | null; sentAt: string | null }
export interface MailCandidate { id: string; accountId: string; email: string; header: MailHeader; reasons: string[] }
export interface MailAccount { id: string; email: string; paused: boolean; failures: number; lastError: string | null; lastChecked: number | null; connection?: MailConnection }
export interface MailboxView { accounts: MailAccount[]; candidates: MailCandidate[]; pendingCount: number }
interface ConfirmReport { imported: number; duplicates: number; failed: Array<{ id: string; message: string }> }
interface IgnoreReport { ignored: number; unchanged: number }
interface CheckReport {
  checkedAccounts: number;
  succeededAccounts: number;
  failedAccounts: Array<{ accountId: string; message: string; paused: boolean }>;
  skippedPaused: number;
}

export interface MailboxInboxBridge {
  showPending(candidate: MailCandidate | null, actions?: { save(): void; ignore(): void }): void;
  showStored(): void | Promise<void>;
}

const ERRORS: Record<string, string> = {
  Auth: "登录被拒绝：请核对登录账号，按邮箱或学校要求填写密码、授权码或客户端专用密码；授权码失效时请重新生成授权码。",
  ImapDisabled: "邮箱未开启 IMAP，请按教程开启后重试。",
  Network: "连不上邮箱，请核对服务器和网络；学校可能要求校园网或没有开放 IMAP，可改用手动导入。",
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
function formattedTime(unix: number | null) { return unix ? new Date(unix * 1000).toLocaleString() : "尚未完成检查"; }

export function mountMailboxes(
  invoke: Invoke,
  onImported: () => Promise<unknown>,
  openSettings: () => void,
  inboxBridge?: MailboxInboxBridge,
  onManualImport?: () => void,
) {
  const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
  const form = get<HTMLFormElement>("mailbox-form");
  const email = get<HTMLInputElement>("mailbox-email");
  const secret = get<HTMLInputElement>("mailbox-secret");
  const guide = get<HTMLSelectElement>("mailbox-guide-provider");
  const host = get<HTMLInputElement>("mailbox-host"), port = get<HTMLInputElement>("mailbox-port");
  const encryption = get<HTMLSelectElement>("mailbox-encryption"), username = get<HTMLInputElement>("mailbox-username");
  const sendId = get<HTMLInputElement>("mailbox-send-id");
  const configuration = get<HTMLDetailsElement>("mailbox-configuration");
  const detection = get("mailbox-detection");
  let discoveryToken = 0, discoveryRequested = "";
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
  type ProgressState = "empty" | "typing" | "searching" | "found" | "manual" | "edited" | "unsupported" | "connecting" | "checking" | "connected" | "error";
  function showProgress(state: ProgressState, title: string, detail: string, step = 1) {
    detection.dataset.state = state;
    detection.setAttribute("aria-busy", String(["searching", "connecting", "checking"].includes(state)));
    get("mailbox-progress-title").textContent = title;
    get("mailbox-progress-detail").textContent = detail;
    get("mailbox-progress-icon").textContent = ["found", "connected"].includes(state) ? "✓" : ["manual", "error", "unsupported"].includes(state) ? "!" : String(step);
    for (let index = 1; index <= 3; index++) {
      const item = get(`mailbox-step-${index}`);
      if (index === step) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
      item.dataset.complete = String(index < step || state === "connected");
    }
  }
  let schoolHelpUrl: string | null = null;
  const selected = new Set<string>();
  const failures = new Map<string, string>();
  let current: MailboxView = { accounts: [], candidates: [], pendingCount: 0 };
  let busy = false;
  let limit = 100;
  let refreshToken = 0;
  let signature = "";
  let inboxState: "pending" | "stored" = "stored";
  let activeCandidateId: string | null = null;
  const actionIds = ["mailbox-save", "mailbox-settings-check", "mailbox-inbox-check", "mailbox-save-selected", "mailbox-ignore-selected", "mailbox-load-more", "mailbox-detect"];
  function say(where: "settings" | "inbox", text: string, error = false) {
    const el = get(`mailbox-${where}-status`);
    el.textContent = text;
    el.dataset.tone = error ? "error" : "info";
  }
  function syncButtons() {
    actionIds.forEach((id) => { get<HTMLButtonElement>(id).disabled = busy || ((id === "mailbox-save-selected" || id === "mailbox-ignore-selected") && !selected.size); });
    email.readOnly = busy; secret.readOnly = busy;
    host.readOnly = busy; port.readOnly = busy; username.readOnly = busy;
    encryption.disabled = busy; sendId.disabled = busy;
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
    const recovery = paused ? ` ${paused} 个邮箱已暂停，请到「设置 → 邮箱」处理后点「恢复检查」。` : "";
    if (!report.checkedAccounts) {
      say(where, prefix + (paused ? `本次未检查邮箱。${recovery}` : "还没有连接邮箱，请先到「设置 → 邮箱」连接。"), true);
    } else if (report.failedAccounts.length) {
      const reasons = [...new Set(report.failedAccounts.map((account) => account.message))].join("；");
      say(where, `${prefix}已检查 ${report.checkedAccounts} 个邮箱：${report.succeededAccounts} 个成功，${report.failedAccounts.length} 个失败。${reasons}${recovery}`, true);
    } else {
      say(where, `${prefix}已成功检查 ${report.succeededAccounts} 个邮箱，请查看待确认邮件。${recovery}`, paused > 0);
    }
    return report;
  }
  function render() {
    const valid = new Set(current.candidates.map((item) => item.id));
    for (const id of selected) if (!valid.has(id)) selected.delete(id);
    if (activeCandidateId && !valid.has(activeCandidateId)) activeCandidateId = null;
    const accounts = get("mailbox-accounts"); accounts.replaceChildren();
    if (!current.accounts.length) accounts.append(node("p", "还没有连接邮箱。填写邮箱，按对应教程准备凭据后即可连接。", "settings-caption"));
    current.accounts.forEach((account) => {
      const card = node("article", undefined, "mailbox-account");
      card.append(node("h3", account.email));
      card.append(node("p", `${account.paused ? "已暂停" : "检查已启用"} · 最近成功检查：${formattedTime(account.lastChecked)}`, "settings-caption"));
      if (account.lastError) card.append(node("p", `${ERRORS[account.lastError] || "检查失败，请重新测试连接。"}${account.paused ? " 连续失败已自动暂停，处理后恢复检查。" : ` 已连续失败 ${account.failures} 次。`}`, "mailbox-error"));
      const controls = node("div", undefined, "settings-actions");
      controls.append(button("修改连接 / 更新凭据", () => {
        email.value = account.email; secret.value = ""; updateProvider();
        if (account.connection) fillConnection(account.connection);
        updateServerLabel();
        configuration.open = true;
        showProgress("edited", "已载入保存的配置，等待重新测试", "下一步：填写新的凭据，点击“测试连接并保存”。修改服务器或登录账号会清空该连接的候选与扫描记录。", 2);
        secret.focus();
      }));
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
    const provider: MailProvider = Object.hasOwn(MAIL_GUIDES, guide.value) ? guide.value as MailProvider : "school";
    const help = MAIL_GUIDES[provider];
    const image = get<HTMLImageElement>("mailbox-guide-image");
    image.src = `/mailbox-guide-${provider}.svg`; image.alt = `${help.label}：${help.steps.join(" ")}`;
    get("mailbox-guide-steps").replaceChildren(...help.steps.map((step) => node("li", step)));
    const link = get<HTMLAnchorElement>("mailbox-guide-link");
    const url = provider === "school" ? schoolHelpUrl : help.url;
    link.hidden = !url; link.href = url ?? "#";
  }
  function fillConnection(config: MailConnection) {
    host.value = config.host; port.value = String(config.port); encryption.value = config.encryption;
    username.value = config.username; sendId.checked = config.sendId;
  }
  function readConnection(): MailConnection {
    return { host: host.value.trim(), port: Number(port.value), encryption: encryption.value as "tls" | "starttls", username: username.value.trim(), sendId: sendId.checked };
  }
  function updateServerLabel() {
    get("mailbox-server").textContent = host.value.trim()
      ? `IMAP：${host.value.trim()} · ${port.value} · ${encryption.value === "tls" ? "TLS" : "STARTTLS"}`
      : "未确定服务器，可自动查询或手动填写。";
  }
  function updateProvider() {
    clearTimeout(discoveryTimer);
    ++discoveryToken; discoveryRequested = ""; schoolHelpUrl = null;
    const provider = mailboxProvider(email.value), config = localMailConnection(email.value);
    fillConnection(config ?? { host: "", port: 993, encryption: "tls", username: email.value.trim(), sendId: false });
    if (provider === "school") schoolHelpUrl = "https://mails.tsinghua.edu.cn/coremail/help/notice.html";
    guide.value = provider ?? "school"; updateGuide();
    const help = MAIL_GUIDES[provider ?? "school"];
    get("mailbox-secret-label").textContent = help.secret;
    get("mailbox-secret-hint").textContent = `${provider === "school" ? "清华邮箱请生成客户端专用密码。" : ""}${help.hint} 只存系统凭据库，保存后不回显。`;
    configuration.open = !config && !!email.value;
    const microsoft = /@(outlook\.com|hotmail\.com|live\.com|msn\.com)$/i.test(email.value.trim());
    if (microsoft) showProgress("unsupported", "此邮箱暂不支持直接连接", "需要微软登录授权。请点击“改用导入邮件文件”。");
    else if (config) showProgress("found", `已找到配置 · ${help.label}`, `服务器：${config.host}。配置已填好，尚未连接。下一步：填写${help.secret}，点击“测试连接并保存”。${provider === "school" ? "清华邮箱需要客户端专用密码。" : ""}`, 2);
    else if (email.value.trim()) showProgress("typing", "等待识别邮箱配置", "请填写完整邮箱地址，程序会自动查找；也可直接手动填写下方配置。");
    else showProgress("empty", "先填写邮箱地址", "第 1 步：填写完整邮箱地址，程序会自动查找配置。");
    updateServerLabel();
  }
  async function discover(force = false) {
    const address = email.value.trim();
    if (busy || !email.validity.valid || !address || (!force && (localMailConnection(address) || discoveryRequested === address))) return;
    if (/@(outlook\.com|hotmail\.com|live\.com|msn\.com)$/i.test(address)) return;
    const token = ++discoveryToken; discoveryRequested = address;
    clearTimeout(discoveryTimer);
    showProgress("searching", "正在识别邮箱配置…", "最多等待 3 秒。查到后会自动填写；也可以直接填写下方配置。");
    try {
      const result = await invoke<{ config: MailConnection | null; source: string; note: string; helpUrl: string | null }>("mailbox_discover", { email: address });
      if (token !== discoveryToken || email.value.trim() !== address) return;
      if (result.config) fillConnection(result.config);
      configuration.open = !result.config;
      if (result.config) showProgress("found", "已找到邮箱配置", `${result.note} 配置已填好，尚未连接。下一步：按学校要求填写密码，点击“测试连接并保存”。`, 2);
      else showProgress("manual", "未找到配置，需要手动填写", `${result.note} 下一步：展开下方配置，按学校官方教程填写服务器和登录账号；也可改用导入邮件文件。`);
      schoolHelpUrl = result.helpUrl; updateGuide(); updateServerLabel();
    } catch (error) {
      if (token !== discoveryToken) return;
      configuration.open = true;
      showProgress("manual", "识别未完成，需要手动填写", `未能自动识别，请按学校或邮箱官方教程手动填写。${message(error)}`);
    }
  }
  [host, port, username, encryption, sendId].forEach((input) => input.addEventListener("input", () => {
    clearTimeout(discoveryTimer);
    ++discoveryToken; updateServerLabel(); showProgress("edited", "已切换为手动配置，等待测试", "下一步：核对服务器、端口和账号，填写所需密码，再点击“测试连接并保存”。", 2);
  }));
  get("mailbox-detect").addEventListener("click", () => { void discover(true); });
  email.addEventListener("blur", () => { void discover(); });
  get("mailbox-manual-import").addEventListener("click", () => {
    selectInboxState("stored");
    if (onManualImport) onManualImport();
    else say("settings", "请到招聘通知页点击导入文件，选择从邮箱下载的 .eml 文件。");
  });
  get("mailbox-guide-link").addEventListener("click", (event) => {
    event.preventDefault();
    const url = get<HTMLAnchorElement>("mailbox-guide-link").getAttribute("href");
    if (url && url !== "#") void invoke("mailbox_open_help", { url }).catch((error) => say("settings", message(error), true));
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const config = readConnection();
    if (!email.validity.valid || !email.value.trim() || !secret.value.trim() || !config.host || !config.username || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      configuration.open = true;
      showProgress("error", "连接信息还没填完整", "请补充邮箱、IMAP 服务器、有效端口、登录账号和所需密码，再测试连接。", 2);
      say("settings", "请填写邮箱、IMAP 服务器、有效端口、登录账号和所需密码。", true); return;
    }
    clearTimeout(discoveryTimer);
    ++discoveryToken;
    showProgress("connecting", "正在测试连接…", "正在验证服务器和登录凭据，通过后才保存。", 2);
    void action("settings", "正在测试连接，通过后才保存…", async () => {
      try {
        await invoke("mailbox_connect", { email: email.value.trim(), secret: secret.value, config });
        showProgress("checking", "邮箱已连接，正在检查来信…", "连接已保存。正在检查最近 30 天的邮件，请稍候。", 3);
        say("settings", "连接已保存，正在检查最近 30 天的邮件…");
        const report = await checkNow("settings", "连接已保存。");
        if (report.failedAccounts.length || !report.checkedAccounts) {
          showProgress("error", "邮箱已连接，来信检查尚未完成", get("mailbox-settings-status").textContent ?? "请核对网络后点击立即检查。", 3);
        } else showProgress("connected", "连接成功，来信检查已完成", "下一步：到“招聘通知 → 待确认”查看发现的邮件，没有候选时也可以手动导入。", 3);
      } catch (error) {
        const saved = detection.dataset.state === "checking";
        showProgress("error", saved ? "邮箱已连接，来信检查未完成" : "连接失败，配置尚未保存", message(error), saved ? 3 : 2);
        throw error;
      } finally { secret.value = ""; }
    });
  });
  email.addEventListener("input", () => {
    secret.value = ""; updateProvider();
    if (email.value.trim() && email.validity.valid && !localMailConnection(email.value)) {
      discoveryTimer = setTimeout(() => { void discover(); }, 500);
    }
  }); guide.addEventListener("change", updateGuide);
  ["mailbox-settings-check", "mailbox-inbox-check"].forEach((id) => get(id).addEventListener("click", () => {
    const where = id.includes("settings") ? "settings" : "inbox";
    void action(where, "正在检查邮箱…", async () => { await checkNow(where); });
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
  return { refresh, dispose: () => { clearTimeout(discoveryTimer); ++discoveryToken; } };
}
