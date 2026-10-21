import { mountCloudSchedule } from "./cloud-schedule-ui";
import type { Invoke } from "./api";
import { cloudBackupApi, type CloudConfig, type CloudJob, type CloudListed, type CloudNamespace } from "./cloud-backup-api";
import { restoreBody } from "./backup-ui";
import { factList, fragment, openSettingsDialog, paragraph } from "./settings-dialog";
import { must } from "./dom";

export function cloudError(error: unknown): string {
  const code = typeof error === "string" ? error : (error as { code?: string } | null)?.code ?? "";
  const hints: Array<[string, string]> = [
    ["Authentication", "认证失败：请检查账号和坚果云第三方应用密码，重新保存后再试。"],
    ["Permission", "没有目录读写权限：请检查 WebDAV 授权和远端目录。"],
    ["NotFound", "远端目录或文件不存在：请检查配置的目录，或重新读取列表。"],
    ["RateLimited", "服务商限流：请稍后再试，避免连续点击。"],
    ["NoSpace", "云端空间不足：请释放空间或升级容量，再重试原候选包。"],
    ["INSUFFICIENT_DISK_SPACE", "本机空间不足：请腾出空间后重试，当前档案未替换。"],
    ["TooLarge", "文件超过服务商上限（坚果云为 500 MB）：请减少附件后重新备份。"],
    ["TOO_LARGE", "备份超过大小限制：请减少附件后重新备份。"],
    ["PREVIEW_", "预览已过期、失效或文件已改变：请重新下载并预览后再确认。"],
    ["InvalidCiphertext", "解密失败：请核对这份备份使用的加密口令；文件损坏也可能导致此错误。"],
    ["InvalidPassphrase", "解密失败：请核对这份备份使用的加密口令。"],
    ["CRYPT_Limit", "加密包超过资源限制，未尝试高成本解密，请检查备份来源。"],
    ["HASH_MISMATCH", "下载文件不完整或已损坏：请重新下载，当前档案未替换。"],
    ["INVALID_PACKAGE", "备份内部校验失败：请换用其他备份，当前档案未替换。"],
    ["REMOTE_CONFLICT", "远端文件与记录不一致：没有覆盖，请重新读取列表或检查云端文件。"],
    ["MISSING_WEBDAV_PASSWORD", "尚未保存此账号和地址的应用密码，请先填写并保存。"],
    ["MISSING_PASSPHRASE", "尚未保存解密口令：请填写这份备份使用的口令后保存。"],
    ["CREDENTIAL_STORE_UNAVAILABLE", "系统凭据库不可用：请解锁系统凭据库后重试；密码不会保存到文件。"],
    ["CANCELLED", "任务已取消，当前档案未替换。完整上传候选包可以重试或明确放弃。"],
    ["MANUAL_BACKUP_REQUIRED", "请先按当前账号、目录和加密设置完成一次手动云备份，再启用自动计划。"],
    ["BUDGET_PAUSED", "已达到本机估算预算。自动计划已暂停；可核对实际账户流量后调整预算并重新启用，或手动重试。"],
    ["BUSY", "另一项云备份任务正在进行，请等待或取消。"],
    ["INVALID_SETTINGS", "本机 settings.json 损坏或云备份配置不合法，恢复未执行；请保留原文件并修复配置后重试。"],
    ["SETTINGS_IO", "无法读写本机 settings.json，恢复未执行；请检查文件权限和本机可用空间后重试。"],
    ["RETRY_REQUIRED", "有未完成的候选包：请重试，或明确放弃后创建新备份。"],
    ["SCOPE_MISMATCH", "候选包属于原账号、目录或加密设置：请恢复原配置后重试，或放弃候选包。"],
    ["Network", "网络连接失败：请检查网络；上传结果不明确时请重试原候选包完成对账。"],
    ["Timeout", "网络超时：请检查网络；上传结果不明确时请重试原候选包完成对账。"],
    ["CATALOG_LIMIT", "云端目录数量超过安全读取上限：请使用更精确的远端根目录。"],
  ];
  const hint = hints.find(([match]) => code.includes(match))?.[1]
    ?? `操作未完成（${code || "未知错误"}），请检查配置或重试。当前档案及上一份有效备份会保留。`;
  return hint + (code.includes("CLEANUP_UNCONFIRMED") ? "临时明文清理未确认，请重启后检查工作目录。" : "");
}
const phaseNames: Record<CloudJob["phase"], string> = {
  packing: "正在生成本地备份", encrypting: "正在加密（密钥计算期间取消会稍后生效）",
  uploading: "正在上传", confirming: "正在确认云端文件",
  succeeded: "已上传并确认", cleanupWarning: "已上传并确认；旧备份清理未完成",
  skipped: "业务内容没有变化，已跳过上传",
  failed: "上次备份失败", cancelled: "上次备份已取消", interrupted: "上次备份中断，可重试或放弃候选包",
};
const running = (job: CloudJob | null) => !!job && ["packing", "encrypting", "uploading", "confirming"].includes(job.phase);
const size = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`;
export const cloudTime = (utc: string) => `${new Date(utc).toLocaleString()}（本地） / ${utc}（UTC）`;
const shortTime = (utc: string) => new Date(utc).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const errorCode = (error: unknown) => typeof error === "string" ? error : (error as { code?: string } | null)?.code ?? "";
type Tone = "ok" | "warn" | "error" | "";
const PAGE = 10;

export function mountCloudBackup(invoke: Invoke, onRestored: () => void | Promise<void> = () => {}) {
  const api = cloudBackupApi(invoke);
  const refreshSchedule = mountCloudSchedule(api, () => selectedConfig(), (attention) => { scheduleAttention = attention; render(); });
  const form = must<HTMLFormElement>("cloud-form");
  const field = (id: string) => must<HTMLInputElement>(`cloud-${id}`);
  const endpoint = field("endpoint"), username = field("username"), root = field("root");
  const password = field("password"), passphrase = field("passphrase"), encrypted = field("encrypted");
  const keep = must<HTMLSelectElement>("cloud-keep");
  const message = must("cloud-message"), progress = must("cloud-progress"), latest = must("cloud-latest");
  const namespace = must<HTMLSelectElement>("cloud-namespace"), list = must("cloud-list");
  let config: CloudConfig | null = null, dirty = false, loaded = false, busy = false, uploading = false, previewing = false;
  let secrets: { hasWebdavPassword: boolean; hasBackupPassphrase: boolean } | null = null;
  let jobState: "failed" | "candidate" | null = null, scheduleAttention = false;
  let namespaces: CloudNamespace[] = [], records: CloudListed[] = [], timer: ReturnType<typeof setTimeout> | undefined;
  // records 是已读到的整月备份，next 是还没读的更早月份的游标。
  let shown = 0, next: string | null = null;
  let connectionId: string = crypto.randomUUID();

  function tell(text: string, tone = "info") { message.hidden = false; message.dataset.tone = tone; message.textContent = text; }
  function controls() {
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button")) control.disabled = busy || uploading;
    if (!encrypted.checked) passphrase.disabled = true;
    // 下载校验时不能收起，否则行内的「取消」也跟着藏起来。
    must<HTMLButtonElement>("cloud-found-close").disabled = busy || uploading;
    must<HTMLButtonElement>("cloud-list-more").disabled = busy || uploading;
    for (const id of ["start", "retry", "discard", "browse"]) must<HTMLButtonElement>(`cloud-${id}`).disabled = busy || uploading || !config;
    // 下载预览时「取消」在被点的那一行里，顶部不再重复。
    must("cloud-cancel").hidden = (!busy && !uploading) || previewing;
    namespace.disabled = busy || uploading;
    for (const button of list.querySelectorAll<HTMLButtonElement>("button[data-index]")) button.disabled = busy || uploading;
  }
  // 卡片顶部的一句话状态 + 各分组折叠栏右侧的当前取值，都从这里统一刷新。
  function render() {
    const encrypt = config ? config.options.encrypted !== false : encrypted.checked;
    const [tone, text]: [Tone, string] = !config ? ["", "未配置"]
      : uploading ? ["", "正在备份"]
      : dirty ? ["warn", "有未保存的修改"]
      : jobState === "failed" ? ["error", "上次备份失败"]
      : jobState === "candidate" ? ["warn", "有未完成的候选包"]
      : secrets && !secrets.hasWebdavPassword ? ["warn", "缺少应用密码"]
      : secrets && encrypt && !secrets.hasBackupPassphrase ? ["warn", "缺少加密口令"]
      : scheduleAttention ? ["warn", "自动备份需要处理"]
      : ["ok", "已配置"];
    const state = must("cloud-state");
    state.textContent = text;
    if (tone) state.dataset.tone = tone; else delete state.dataset.tone;
    const folder = config?.options.root?.join("/") || "根目录";
    must("cloud-fact-connection").textContent = config
      ? `${config.connection.username} · ${folder} · ${encrypt ? "加密" : "不加密"}`
      : "尚未配置，请在下方「坚果云账号与加密」填写并保存";
    must("cloud-connection-hint").textContent = !config ? "未配置" : dirty ? "有未保存的修改" : `已保存 · ${folder} · ${encrypt ? "加密" : "不加密"}`;
    const sameAccount = accountUnchanged();
    for (const [id, stored] of [["password", secrets?.hasWebdavPassword], ["passphrase", secrets?.hasBackupPassphrase]] as const) {
      // 改了账号或地址还没保存时，旧账号的凭据不会沿用，也不能从这里移除。
      const saved = sameAccount ? stored : false;
      must(`cloud-${id}-state`).textContent = !config ? "" : !sameAccount ? "新账号未保存" : saved === undefined ? "保存状态未知" : saved ? "已保存" : "未保存";
      field(id).placeholder = saved === false || !config ? (id === "password" ? "粘贴坚果云第三方应用密码" : "设置备份加密口令") : (id === "password" ? "留空保留已保存的密码" : "留空保留已保存的口令");
      // 读不到凭据状态时仍允许移除（与 #312 后端修复一致）。
      must(`cloud-clear-${id}`).hidden = !config || saved === false;
    }
    for (const note of form.querySelectorAll<HTMLElement>(".cloud-form-msg")) {
      note.textContent = dirty ? "有未保存的修改。变更账号或地址后，原凭据不会沿用。" : "";
      note.dataset.tone = dirty ? "warn" : "";
    }
  }
  function selectedConfig(): CloudConfig {
    if (!config || dirty) throw new Error("请先保存配置和凭据，再执行云端操作。");
    return config;
  }
  async function guarded(work: () => Promise<void>) {
    if (busy || uploading) return;
    busy = true; controls();
    try { await work(); }
    catch (error) {
      tell(error instanceof Error ? error.message : cloudError(error), "error");
      if (!uploading) progress.textContent = "任务未完成，请根据提示处理后重试。";
    }
    finally { busy = false; controls(); }
  }
  async function secretStatus() {
    if (!config) return;
    secrets = null;
    try { secrets = await api.credentialStatus(config.connection); }
    finally { render(); }
  }
  let polling: Promise<void> | null = null;
  async function readStatus() {
    if (timer) clearTimeout(timer);
    try {
      const status = await api.status();
      if (status.cleanupWarning) tell("有过期预览的临时明文清理未确认，请重启应用后检查工作目录。备份状态仍可读取。", "warn");
      uploading = running(status.job);
      const job = status.job;
      // 成功且无警告时由「最近成功」一行说明，不再重复。
      let text = job && !(job.phase === "succeeded" && !job.warnings.length)
        ? `${phaseNames[job.phase]}${job.metadata.sizeBytes ? ` · ${size(job.metadata.sizeBytes)}` : ""}` : "";
      if (job?.errorCode) text += `。${cloudError(job.errorCode)}`;
      if (job?.warnings.length) text += "。清理未完成：旧备份、探测文件或本机临时文件没有删干净，已有文件都保留，下次备份会再试。";
      progress.textContent = text;
      jobState = status.retryPackage ? "candidate" : job && ["failed", "interrupted"].includes(job.phase) ? "failed" : null;
      latest.textContent = status.latestMetadata ? `${shortTime(status.latestMetadata.createdAt)} · ${size(status.latestMetadata.sizeBytes)}` : "暂无";
      latest.title = status.latestMetadata ? cloudTime(status.latestMetadata.createdAt) : "";
      must("cloud-local-copy").textContent = status.latestPackage ? `本机明文副本：${status.latestPackage}` : "";
      must("cloud-retry").hidden = !status.retryPackage;
      must("cloud-discard").hidden = !status.retryPackage;
      timer = setTimeout(() => void poll(), uploading ? 1500 : 30000);
    } catch (error) {
      tell(cloudError(error), "error");
      timer = setTimeout(() => void poll(), uploading ? 5000 : 30000);
    }
    controls();
    render();
  }
  function poll(): Promise<void> {
    if (polling) return polling;
    polling = readStatus().finally(() => { polling = null; });
    return polling;
  }
  for (const control of [endpoint, username, root, encrypted, keep, password, passphrase]) control.addEventListener("input", () => {
    dirty = true;
    password.setCustomValidity(""); passphrase.setCustomValidity("");
    controls();
    render();
  });
  // 已保存的凭据只对同一账号和地址有效；读不到凭据状态时不拦截，交给后端判断。
  function accountUnchanged() {
    return !!config && config.connection.endpoint === endpoint.value.trim() && config.connection.username === username.value.trim();
  }
  function savedSecret(kind: "hasWebdavPassword" | "hasBackupPassphrase") {
    if (!accountUnchanged()) return false;
    return secrets ? secrets[kind] : true;
  }
  // 第一次备份必需的秘密在保存时就近提示，不等到点「立即备份」才报错。
  function missingSecret(): boolean {
    const [input, text] = !password.value && !savedSecret("hasWebdavPassword") ? [password, "请填写坚果云第三方应用密码。"]
      : encrypted.checked && !passphrase.value && !savedSecret("hasBackupPassphrase") ? [passphrase, "请设置备份加密口令，或取消勾选「上传前加密」。"]
      : [null, ""];
    if (!input) return false;
    input.setCustomValidity(text); input.reportValidity();
    return true;
  }
  must("cloud-preset").addEventListener("click", () => { endpoint.value = "https://dav.jianguoyun.com/dav/"; dirty = true; render(); });
  // 收起后重新读一次任务状态，进度行恢复显示失败原因等，而不是留空。
  must("cloud-found-close").addEventListener("click", () => { if (!busy && !uploading) { clearFound(); void poll(); } });
  function clearFound() {
    records = []; namespaces = []; shown = 0; next = null; list.replaceChildren(); must("cloud-list-more").hidden = true;
    must("cloud-namespace-label").hidden = true; must("cloud-found").hidden = true;
    must("cloud-list-note").textContent = "";
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity() || missingSecret()) return;
    void guarded(async () => {
      if (!encrypted.checked) {
        const ok = await openSettingsDialog({ title: "允许上传未加密备份？", body: paragraph("明文包含简历、申请和邮件证据。可访问云目录的人能读取这些内容，请只使用自己控制的存储。"), confirmLabel: "允许明文上传", action: async () => {} });
        if (!ok) return;
      }
      const next: CloudConfig = {
        connection: { connectionId, endpoint: endpoint.value.trim(), username: username.value.trim() },
        options: { root: root.value.split("/").filter(Boolean), encrypted: encrypted.checked, keepLast: keep.value ? Number(keep.value) : null },
        automaticEnabled: false, requiresConfirmation: false,
      };
      // Save only nonsecret config; write-only credential commands never echo values.
      await api.saveConfig(next);
      await refreshSchedule();
      config = next;
      try {
        if (password.value) await api.setCredential(next.connection, "webdavPassword", password.value);
        if (passphrase.value) await api.setCredential(next.connection, "backupPassphrase", passphrase.value);
      } catch (error) {
        await secretStatus();
        throw new Error(`非秘密配置已保存，但凭据未完整保存。${cloudError(error)}请重新填写未保存的秘密后保存。`);
      } finally { password.value = ""; passphrase.value = ""; }
      dirty = false;
      clearFound();
      await api.clearPreview();
      await secretStatus();
      tell("配置已保存在本机；密码仅保存在系统凭据库。如需自动备份，请另外启用下方计划。", "success");
    });
  });
  for (const [id, kind] of [["password", "webdavPassword"], ["passphrase", "backupPassphrase"]] as const) {
    must(`cloud-clear-${id}`).addEventListener("click", () => void guarded(async () => {
      const c = selectedConfig();
      const ok = await openSettingsDialog({ title: "移除此账号的已保存凭据？", body: paragraph(kind === "backupPassphrase" ? "请确认已在别处保管加密口令。移除后需要重新输入，才能恢复加密备份。" : "移除后需要重新保存应用密码，才能连接云端。"), confirmLabel: "移除凭据", action: () => api.clearCredential(c.connection, kind) });
      if (ok) { await secretStatus(); tell("已从系统凭据库移除。", "success"); }
    }));
  }
  must("cloud-test").addEventListener("click", () => void guarded(async () => {
    const c = selectedConfig(); progress.textContent = "正在连接并检查远端目录…";
    try { await api.test(c.connection, c.options); }
    catch (error) {
      // 测试连接只读不建目录：所填目录不存在时认证已通过，首次备份会逐级创建。
      if (!errorCode(error).includes("NotFound") || !c.options.root?.length) throw error;
      // 地址写错也会 NotFound：再只读检查一次 WebDAV 根目录，能读到才说明账号和地址都没问题。
      try { await api.test(c.connection, { ...c.options, root: [] }); }
      catch (rootError) {
        if (errorCode(rootError).includes("NotFound")) throw new Error("找不到 WebDAV 地址：请检查地址是否正确。");
        throw rootError;
      }
      tell(`账号验证通过。目录 ${c.options.root.join("/")} 还不存在，第一次备份时会自动创建。`, "info");
      progress.textContent = "连接测试完成。";
      return;
    }
    tell("连接成功，远端目录可读取。上传权限将在实际上传时检查；未上传档案。", "success");
    progress.textContent = "连接测试完成。";
  }));
  for (const [id, retry] of [["start", false], ["retry", true]] as const) must(`cloud-${id}`).addEventListener("click", () => void guarded(async () => {
    const c = selectedConfig();
    await (retry ? api.retry(c.connection, c.options) : api.start(c.connection, c.options));
    tell("云备份已开始，可继续使用其他页面。", "info");
    await poll();
  }));
  must("cloud-discard").addEventListener("click", () => void guarded(async () => {
    const ok = await openSettingsDialog({ title: "放弃上次候选包？", body: paragraph("本机候选包会删除；上一份成功备份保留。未确认的远端对象不会被强行删除，可能需要手动对账。"), confirmLabel: "放弃候选包", action: () => api.discard() });
    if (ok) { tell("已放弃候选包。", "success"); await poll(); }
  }));
  const cancel = () => api.cancel().then(
    () => { tell("已请求取消；正在完成安全收尾，加密密钥计算期间请稍候。"); return true; },
    (error) => { tell(cloudError(error), "error"); return false; },
  );
  must("cloud-cancel").addEventListener("click", () => void cancel());
  async function readNamespace() {
    const c = selectedConfig(), source = namespaces[Number(namespace.value)];
    if (!source) return;
    records = []; shown = 0; next = null; list.replaceChildren(); must("cloud-list-more").hidden = true;
    progress.textContent = "正在读取最新的备份，可随时取消。";
    const page = await api.list(c.connection, c.options, source.archiveId, source.deviceId);
    records = page.entries; next = page.next;
    must("cloud-list-note").textContent = "列表只读取了云端目录，尚未下载或校验内容；预览时才会核对。";
    showMore();
    controls();
    progress.textContent = !records.length ? "此来源设备暂无可用备份。"
      : records.length > shown || next ? `先显示最新 ${shown} 份，可继续查看更早的备份。` : `找到 ${records.length} 份备份。`;
  }
  // 后端按整月读取（#322）。已读到的先分批显示，不够一批时再读更早的月份。
  async function loadMore() {
    const c = selectedConfig(), source = namespaces[Number(namespace.value)];
    if (next && source && records.length - shown < PAGE) {
      progress.textContent = "正在读取更早的备份，可随时取消。";
      const page = await api.list(c.connection, c.options, source.archiveId, source.deviceId, next);
      records.push(...page.entries); next = page.next;
    }
    const before = shown;
    showMore();
    progress.textContent = shown > before ? `已显示 ${shown} 份。` : "没有更早的备份了。";
  }
  function showMore() {
    const batch = records.slice(shown, shown + PAGE);
    list.append(...batch.map((item, offset) => {
      const index = shown + offset;
      const li = document.createElement("li"), info = document.createElement("div"), title = document.createElement("strong"), detail = document.createElement("span");
      const note = document.createElement("p"), actions = document.createElement("div"), button = document.createElement("button"), stop = document.createElement("button");
      title.textContent = shortTime(item.createdAt); title.title = cloudTime(item.createdAt);
      detail.textContent = `${size(item.sizeBytes)} · ${item.encryptionFormat === "none" ? "未加密" : "age 加密"} · 已上传，内容待下载校验`;
      note.className = "settings-inline-msg"; note.setAttribute("role", "status");
      info.append(title, detail, note); actions.className = "settings-list-actions";
      button.type = "button"; button.textContent = "下载校验并预览"; button.dataset.index = String(index);
      stop.type = "button"; stop.textContent = "取消"; stop.dataset.cancel = ""; stop.hidden = true;
      actions.append(button, stop); li.append(info, actions); return li;
    }));
    shown += batch.length;
    const more = must<HTMLButtonElement>("cloud-list-more"), rest = records.length - shown;
    more.hidden = rest <= 0 && !next;
    // 云端还有没读的月份时总数未知，只说再显示一批。
    more.textContent = next ? "再显示 10 份" : `再显示 ${Math.min(PAGE, rest)} 份（还有 ${rest} 份）`;
  }
  must("cloud-list-more").addEventListener("click", () => void guarded(loadMore));
  must("cloud-browse").addEventListener("click", () => void guarded(async () => {
    const c = selectedConfig(); progress.textContent = "正在查找档案与来源设备，无需旧设备标识…";
    list.replaceChildren(); records = []; shown = 0; next = null; must("cloud-list-more").hidden = true; must("cloud-list-note").textContent = "";
    must("cloud-found").hidden = false;
    const discovery = await api.discover(c.connection, c.options);
    namespaces = discovery.sources;
    if (discovery.warnings.length) tell(`部分档案目录未能读取，下面只展示可用来源。${cloudError(discovery.warnings[0])}`, "warn");
    namespace.replaceChildren(...namespaces.map((source, index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = `档案 ${source.archiveId} / 设备 ${source.deviceId}`; return option; }));
    must("cloud-namespace-label").hidden = !namespaces.length;
    if (namespaces.length) await readNamespace();
    else { progress.textContent = ""; must("cloud-list-note").textContent = "该根目录下尚未发现备份。请核对远端目录；目录可能不完整。"; }
  }));
  namespace.addEventListener("change", () => void guarded(readNamespace));
  list.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const stop = target.closest<HTMLButtonElement>("button[data-cancel]");
    if (stop) {
      stop.disabled = true;
      const note = stop.closest("li")?.querySelector(".settings-inline-msg"), before = note?.textContent ?? "";
      if (note) note.textContent = "正在取消…";
      // 取消请求失败且下载仍在进行时，恢复这一行，让用户可以再次取消。
      void cancel().then((ok) => {
        if (ok || stop.hidden) return;
        stop.disabled = false;
        if (note) note.textContent = before;
      });
      return;
    }
    const button = target.closest<HTMLButtonElement>("button[data-index]");
    if (!button) return;
    const entry = records[Number(button.dataset.index)];
    if (!entry) return;
    // 进度、取消和失败原因都显示在被点的这一行，不依赖卡片顶部的文案。
    const row = button.closest("li")!, note = row.querySelector<HTMLElement>(".settings-inline-msg")!, rowStop = row.querySelector<HTMLButtonElement>("button[data-cancel]")!;
    const rowState = (text: string, tone: Tone = "") => { note.textContent = text; note.dataset.tone = tone; };
    void guarded(async () => {
      const c = selectedConfig();
      button.textContent = "正在下载并校验…"; button.setAttribute("aria-busy", "true");
      rowStop.hidden = false; rowStop.disabled = false; previewing = true; controls();
      rowState(`正在下载 ${size(entry.sizeBytes)} 并校验传输哈希、加密认证和档案内部文件；文件较大或服务商限流时可能需要几分钟。`);
      let restored = false, cleanupWarning = false, refreshWarning = false, restoreError: string | null = null;
      try {
        let result: Awaited<ReturnType<typeof api.preview>>;
        try { result = await api.preview(c.connection, c.options, entry); }
        catch (error) {
          const cancelled = errorCode(error).includes("CANCELLED");
          rowState(cancelled ? "已取消下载，当前档案未替换。" : cloudError(error), cancelled ? "" : "error");
          return;
        } finally {
          button.textContent = "下载校验并预览"; button.removeAttribute("aria-busy"); rowStop.hidden = true; previewing = false; controls();
        }
        rowState("已完整下载并校验，请在弹窗中核对差异后决定是否恢复。", "ok");
        const confirmed = await openSettingsDialog({ title: "恢复云端备份并替换当前档案？", size: "lg", intro: "恢复是整个档案替换，不是合并。当前档案会保留为回滚点。", body: fragment(
          factList([["预览有效期", cloudTime(result.expiresAt)], ["云端文件", "传输与内部校验通过"]]),
          restoreBody(entry.package, result.preview),
          paragraph("恢复后本机自动云备份会关闭；设备标识与删除权限不会从备份迁移。", "settings-dialog-warn")),
          confirmLabel: "确认替换当前档案", busyLabel: "正在恢复…", action: async () => {
            try { const outcome = await api.restore(result.token); restored = true; cleanupWarning = outcome.cleanupWarning; refreshWarning = outcome.refreshWarning; }
            catch (error) { restoreError = cloudError(error); tell(restoreError, "error"); throw error; }
          }, describeError: cloudError,
        });
        if (confirmed) {
          rowState("");
          const summary = `恢复成功，旧档案已保存为回滚点。本机自动云备份已关闭，请重新确认配置。${cleanupWarning ? "临时明文清理未确认，请重启后检查工作目录。" : ""}${refreshWarning ? "路径显示刷新失败，请重启应用核对当前档案，不要重复恢复。" : ""}`;
          try { await onRestored(); loaded = false; await refresh(); tell(summary, cleanupWarning || refreshWarning ? "warn" : "success"); }
          catch { tell(`${summary}档案已恢复成功，但界面刷新失败。请重新打开页面核对；不要重复恢复。`, "warn"); }
        } else if (restoreError) { rowState(restoreError, "error"); tell(restoreError, "error"); }
        else { rowState(""); tell("已取消恢复，当前档案没有改动。", "info"); }
      } finally {
        try {
          await api.clearPreview();
          progress.textContent = cleanupWarning ? "档案已恢复；临时明文清理未确认。" : "云端恢复任务已结束，临时明文清理已完成。";
        } catch (error) {
          const code = (error as { code?: string } | null)?.code ?? "CLEANUP_UNCONFIRMED";
          tell(`${restored ? "档案已恢复成功；" : "恢复任务已结束；"}临时明文清理未确认，请重启应用后检查工作目录。（${code}）`, "warn");
        }
      }
    });
  });
  async function refresh(force = false) {
    if (force) { loaded = false; password.value = ""; passphrase.value = ""; }
    if (!loaded) {
      try { config = await api.config(); }
      catch (error) { tell(`读取云备份配置失败。${cloudError(error)}`, "error"); throw error; }
      if (config) {
        connectionId = config.connection.connectionId;
        endpoint.value = config.connection.endpoint; username.value = config.connection.username;
        root.value = config.options.root?.join("/") ?? ""; encrypted.checked = config.options.encrypted !== false;
        const value = config.options.keepLast?.toString() ?? "";
        if (![...keep.options].some((o) => o.value === value)) keep.add(new Option(`最近 ${value} 份`, value));
        keep.value = value;
        if (config.requiresConfirmation) tell("档案或凭据变更后，自动云备份已关闭，请核对后重新确认计划。恢复档案或更换加密口令后，须先完成一次新手动备份。", "warn");
        await secretStatus();
      } else {
        // 还没配置时直接展开账号与加密设置，用户不用找入口。
        must<HTMLDetailsElement>("cloud-connection").open = true;
      }
      loaded = true; dirty = false;
      render();
    }
    await poll();
    await refreshSchedule();
  }
  return refresh;
}
