import { mountCloudSchedule } from "./cloud-schedule-ui";
import type { Invoke } from "./api";
import { cloudBackupApi, type CloudConfig, type CloudJob, type CloudMetadata, type CloudNamespace } from "./cloud-backup-api";
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

export function mountCloudBackup(invoke: Invoke, onRestored: () => void | Promise<void> = () => {}) {
  const api = cloudBackupApi(invoke);
  const refreshSchedule = mountCloudSchedule(api, () => selectedConfig());
  const form = must<HTMLFormElement>("cloud-form");
  const field = (id: string) => must<HTMLInputElement>(`cloud-${id}`);
  const endpoint = field("endpoint"), username = field("username"), root = field("root");
  const password = field("password"), passphrase = field("passphrase"), encrypted = field("encrypted");
  const keep = must<HTMLSelectElement>("cloud-keep");
  const message = must("cloud-message"), progress = must("cloud-progress"), latest = must("cloud-latest");
  const namespace = must<HTMLSelectElement>("cloud-namespace"), list = must("cloud-list");
  let config: CloudConfig | null = null, dirty = false, loaded = false, busy = false, uploading = false;
  let namespaces: CloudNamespace[] = [], records: CloudMetadata[] = [], timer: ReturnType<typeof setTimeout> | undefined;
  let connectionId: string = crypto.randomUUID();

  function tell(text: string, tone = "info") { message.hidden = false; message.dataset.tone = tone; message.textContent = text; }
  function controls() {
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button")) control.disabled = busy || uploading;
    for (const id of ["start", "retry", "discard", "browse"]) must<HTMLButtonElement>(`cloud-${id}`).disabled = busy || uploading;
    must("cloud-cancel").hidden = !busy && !uploading;
    namespace.disabled = busy || uploading;
    for (const button of list.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy || uploading;
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
    const state = await api.credentialStatus(config.connection);
    must("cloud-secret-status").textContent = `此账号的应用密码：${state.hasWebdavPassword ? "已保存" : "未保存"}；加密口令：${state.hasBackupPassphrase ? "已保存" : "未保存"}。`;
  }
  let polling: Promise<void> | null = null;
  async function readStatus() {
    if (timer) clearTimeout(timer);
    try {
      const status = await api.status();
      if (status.cleanupWarning) tell("有过期预览的临时明文清理未确认，请重启应用后检查工作目录。备份状态仍可读取。", "warn");
      uploading = running(status.job);
      progress.textContent = status.job ? `${phaseNames[status.job.phase]}${status.job.metadata.sizeBytes ? ` · ${size(status.job.metadata.sizeBytes)}` : ""}` : "还没有创建云备份。";
      if (status.job?.errorCode) progress.textContent += `。${cloudError(status.job.errorCode)}`;
      if (status.job?.warnings.length) progress.textContent += "。清理警告：目录完整性、探测清理或本地清理未确认；保留已有文件，请检查后手动处理。";
      latest.textContent = status.latestMetadata
        ? `最近成功：${cloudTime(status.latestMetadata.createdAt)} · ${size(status.latestMetadata.sizeBytes)}。本机明文副本：${status.latestPackage}`
        : status.latestPackage ? `本机明文副本：${status.latestPackage}` : "暂无已确认成功的云备份；本机明文副本将在这里显示。";
      must("cloud-retry").hidden = !status.retryPackage;
      must("cloud-discard").hidden = !status.retryPackage;
      timer = setTimeout(() => void poll(), uploading ? 1500 : 30000);
    } catch (error) {
      tell(cloudError(error), "error");
      timer = setTimeout(() => void poll(), uploading ? 5000 : 30000);
    }
    controls();
  }
  function poll(): Promise<void> {
    if (polling) return polling;
    polling = readStatus().finally(() => { polling = null; });
    return polling;
  }
  for (const control of [endpoint, username, root, encrypted, keep, password, passphrase]) control.addEventListener("input", () => {
    dirty = true;
    must("cloud-secret-status").textContent = "有未保存的修改。变更账号或地址后，原凭据不会沿用。";
  });
  must("cloud-preset").addEventListener("click", () => { endpoint.value = "https://dav.jianguoyun.com/dav/"; dirty = true; });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
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
      records = []; namespaces = []; list.replaceChildren(); must("cloud-namespace-label").hidden = true;
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
    await api.test(c.connection, c.options);
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
  must("cloud-cancel").addEventListener("click", () => {
    void api.cancel().then(() => tell("已请求取消；正在完成安全收尾，加密密钥计算期间请稍候。"), (error) => tell(cloudError(error), "error"));
  });
  async function readNamespace() {
    const c = selectedConfig(), source = namespaces[Number(namespace.value)];
    if (!source) return;
    records = []; list.replaceChildren();
    progress.textContent = "正在读取轻量元数据（服务商限流时可能需要较长时间）…";
    const catalog = await api.list(c.connection, c.options, source.archiveId, source.deviceId);
    records = catalog.entries;
    must("cloud-list-note").textContent = "列表仅检查元数据和文件长度，尚未下载或校验内容。服务商目录可能不完整，自动清理保持关闭。";
    list.replaceChildren(...records.map((item, index) => {
      const li = document.createElement("li"), info = document.createElement("div"), title = document.createElement("strong"), detail = document.createElement("small"), button = document.createElement("button");
      title.textContent = cloudTime(item.createdAt);
      detail.textContent = `${size(item.sizeBytes)} · ${item.encryptionFormat === "none" ? "未加密" : "age 加密"} · 已上传，内容待下载校验`;
      info.append(title, detail); button.type = "button"; button.textContent = "下载校验并预览"; button.dataset.index = String(index);
      li.append(info, button); return li;
    }));
    controls();
    progress.textContent = records.length ? `找到 ${records.length} 份备份。` : "此来源设备暂无可用备份。";
  }
  must("cloud-browse").addEventListener("click", () => void guarded(async () => {
    const c = selectedConfig(); progress.textContent = "正在查找档案与来源设备，无需旧设备标识…";
    list.replaceChildren(); records = [];
    const discovery = await api.discover(c.connection, c.options);
    namespaces = discovery.sources;
    if (discovery.warnings.length) tell(`部分档案目录未能读取，下面只展示可用来源。${cloudError(discovery.warnings[0])}`, "warn");
    namespace.replaceChildren(...namespaces.map((source, index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = `档案 ${source.archiveId} / 设备 ${source.deviceId}`; return option; }));
    must("cloud-namespace-label").hidden = !namespaces.length;
    if (namespaces.length) await readNamespace(); else progress.textContent = "该根目录下尚未发现备份。请核对远端目录；目录可能不完整。";
  }));
  namespace.addEventListener("change", () => void guarded(readNamespace));
  list.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-index]");
    if (!button) return;
    const metadata = records[Number(button.dataset.index)];
    if (!metadata) return;
    void guarded(async () => {
      const c = selectedConfig();
      progress.textContent = "正在下载并校验传输哈希、加密认证和档案内部文件…";
      let restored = false, cleanupWarning = false, refreshWarning = false, restoreError: string | null = null;
      try {
        const result = await api.preview(c.connection, c.options, metadata);
        progress.textContent = "已完整下载并校验；等待你核对差异并确认恢复。";
        const confirmed = await openSettingsDialog({ title: "恢复云端备份并替换当前档案？", size: "lg", intro: "恢复是整个档案替换，不是合并。当前档案会保留为回滚点。", body: fragment(
          factList([["预览有效期", cloudTime(result.expiresAt)], ["云端文件", "传输与内部校验通过"]]),
          restoreBody(metadata.package, result.preview),
          paragraph("恢复后本机自动云备份会关闭；设备标识与删除权限不会从备份迁移。", "settings-dialog-warn")),
          confirmLabel: "确认替换当前档案", busyLabel: "正在恢复…", action: async () => {
            try { const outcome = await api.restore(result.token); restored = true; cleanupWarning = outcome.cleanupWarning; refreshWarning = outcome.refreshWarning; }
            catch (error) { restoreError = cloudError(error); tell(restoreError, "error"); throw error; }
          }, describeError: cloudError,
        });
        if (confirmed) {
          const summary = `恢复成功，旧档案已保存为回滚点。本机自动云备份已关闭，请重新确认配置。${cleanupWarning ? "临时明文清理未确认，请重启后检查工作目录。" : ""}${refreshWarning ? "路径显示刷新失败，请重启应用核对当前档案，不要重复恢复。" : ""}`;
          try { await onRestored(); loaded = false; await refresh(); tell(summary, cleanupWarning || refreshWarning ? "warn" : "success"); }
          catch { tell(`${summary}档案已恢复成功，但界面刷新失败。请重新打开页面核对；不要重复恢复。`, "warn"); }
        } else if (restoreError) tell(restoreError, "error");
        else tell("已取消恢复，当前档案没有改动。", "info");
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
        if (![...keep.options].some((o) => o.value === value)) keep.add(new Option(`${value} 份`, value));
        keep.value = value;
        if (config.requiresConfirmation) tell("档案恢复后，自动云备份已关闭。请核对账号、目录和口令后重新保存配置。", "warn");
        await secretStatus();
      }
      loaded = true; dirty = false;
    }
    await poll();
    await refreshSchedule();
  }
  return refresh;
}
