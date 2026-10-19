import type { cloudBackupApi, CloudPlan, CloudScheduleStatus } from "./cloud-backup-api";
import { must } from "./dom";
import { openSettingsDialog, paragraph } from "./settings-dialog";

const mb = (n: number) => `${(n / 1_000_000).toFixed(2)} MB`;
const date = (n: number) => new Date(n * 1000).toLocaleString();
const zoneLabel = (n: number) => `UTC${n < 0 ? "−" : "+"}${String(Math.floor(Math.abs(n) / 60)).padStart(2, "0")}:${String(Math.abs(n) % 60).padStart(2, "0")}`;
const messages: Record<string, string> = {
  ENABLED: "计划已启用", CHECKING: "正在检查业务内容", SUCCEEDED: "最近一次自动备份已确认成功",
  UNCHANGED: "业务内容未变，已跳过上传", MISSED_MANUAL: "错过计划时间，未自动补传。需要时点击「立即备份到云端」",
  RETRY_WAIT: "网络或限流后等待有限重试；复用原候选包并先对账",
  ARCHIVE_CHANGED: "档案已切换，请先手动备份，再重新确认计划",
  SCOPE_MISMATCH: "候选包属于原账号、目录或加密设置，请恢复原配置后重试，或明确放弃",
  RETRY_REQUIRED: "请先手动重试或放弃现有候选包",
  UNKNOWN_FAILURE: "失败原因未记录，请检查配置与任务状态后手动处理",
  BUDGET_PAUSED: "本机估算预算不足，自动上传已暂停；请核对账户流量后调整预算并重新启用",
  CLOCK_CHANGED: "系统时钟回退，计划已暂停，请重新确认时间",
  INTERRUPTED_CONFIRM: "任务取消或重启中断，计划已暂停；请手动重试或放弃候选包后重新启用",
  MISSED_RETRY: "错过重试时间，已暂停自动重试；请手动处理候选包",
  RETRY_AFTER_TOO_LONG: "服务商要求的等待时间超出可用日期范围，已暂停；请核对服务商状态后手动处理",
  CLOUD_DAV_Authentication: "认证失败，请检查并重新保存第三方应用密码",
  CLOUD_DAV_Permission: "远端目录权限不足，请检查 WebDAV 授权",
  CLOUD_DAV_NoSpace: "云端空间不足，请释放空间或升级容量",
  CLOUD_DAV_TooLarge: "备份超过服务商大小限制，请减少附件后重新备份",
  CLOUD_MISSING_WEBDAV_PASSWORD: "未保存此连接的应用密码，请先保存",
  CLOUD_MISSING_PASSPHRASE: "未保存此连接的加密口令，请先保存",
  RETRIES_EXHAUSTED: "已用完 3 次自动重试，计划暂停；请检查网络后手动重试",
  JOB_CHANGED: "候选任务已改变，请核对并重新启用计划",
  MANUAL_TAKEOVER: "已改为手动处理候选包，请完成后重新启用计划",
  ARCHIVE_OR_CONFIG_CHANGED: "档案或配置已改变，请先手动备份，再重新确认计划",
};

export function mountCloudSchedule(api: ReturnType<typeof cloudBackupApi>, selected: () => unknown) {
  const form = must<HTMLFormElement>("cloud-auto-form");
  const time = must<HTMLInputElement>("cloud-auto-time"), days = must<HTMLSelectElement>("cloud-auto-days");
  const zone = must<HTMLSelectElement>("cloud-auto-zone"), budget = must<HTMLInputElement>("cloud-auto-budget");
  const pause = must<HTMLInputElement>("cloud-auto-pause"), status = must("cloud-auto-status");
  let current: CloudScheduleStatus | undefined, initialized = false, busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loading: Promise<void> | null = null;
  const localOffset = -new Date().getTimezoneOffset();
  for (let n = -720; n <= 840; n += 15) zone.add(new Option(zoneLabel(n), String(n)));
  zone.value = String(localOffset);
  function plan(): CloudPlan {
    const [h, m] = time.value.split(":").map(Number);
    return { minute: h * 60 + m, everyDays: Number(days.value), utcOffsetMinutes: Number(zone.value), budgetBytes: Number(budget.value) * 1_000_000, pauseAtBudget: pause.checked };
  }
  function estimate() {
    const size = current?.recentSize;
    must("cloud-auto-estimate").textContent = size == null
      ? "暂无可用大小估算：请先完成一次当前配置的手动云备份，再启用自动计划。"
      : `最近备份 ${mb(size)} × 每 30 天最多 ${Math.ceil(30 / Number(days.value))} 次 ≈ ${mb(size * Math.ceil(30 / Number(days.value)))} 上传。内容未变会跳过，包变大及重试会增加流量。`;
  }
  function describeError(error: unknown) {
    const code = (error as { code?: string })?.code ?? "UNKNOWN";
    if (code.includes("MANUAL_BACKUP_REQUIRED")) return "请先完成当前账号、目录和加密设置的手动云备份，再启用计划。";
    if (code.includes("BUSY")) return "任务正在进行，请等待完成后重新启用计划。";
    if (code.includes("RETRY_REQUIRED")) return "请先手动重试或放弃未完成候选包。";
    return `自动计划未更新（${code}）。请检查配置、凭据与本机空间后重试。`;
  }
  async function load() {
    clearTimeout(timer);
    try {
      current = await api.scheduleStatus();
      if (!initialized && current.state.plan) {
        const p = current.state.plan;
        time.value = `${String(Math.floor(p.minute / 60)).padStart(2, "0")}:${String(p.minute % 60).padStart(2, "0")}`;
        if (![...days.options].some(o => o.value === String(p.everyDays))) days.add(new Option(`每 ${p.everyDays} 天`, String(p.everyDays)));
        days.value = String(p.everyDays); zone.value = String(p.utcOffsetMinutes);
        budget.value = String(p.budgetBytes / 1_000_000); pause.checked = p.pauseAtBudget;
      }
      initialized = true;
      const s = current.state;
      status.textContent = !current.enabled ? `自动计划关闭。${current.requiresConfirmation ? "恢复后需重新确认；请先手动备份。" : ""}`
        : !s.plan ? "计划信息缺失，未执行自动备份；请重新确认计划。"
        : s.paused ? `计划已暂停：${messages[s.paused] ?? messages[s.paused.replace(/^CLOUD_/, "")] ?? s.paused}。可手动重试；需重新确认才能恢复自动计划。`
          : `${s.message ? messages[s.message] ?? s.message : "计划已启用"}。${s.nextAt != null && s.plan ? `下次：${date(s.nextAt)}（设备本地显示；执行采用 ${zoneLabel(s.plan.utcOffsetMinutes)}）` : ""}${s.retryAt != null ? `；最早重试：${date(s.retryAt)}` : ""}`;
      const needsAttention = current.enabled && (!s.plan || s.paused || s.message === "MISSED_MANUAL" || s.budgetWarning);
      must("cloud-auto-notice").hidden = !needsAttention;
      must("cloud-auto-notice-text").textContent = needsAttention ? `云备份需要处理。${status.textContent}` : "";
      must("cloud-auto-traffic").textContent = `本机当前 30 天周期${s.cycleStartedAt != null ? `始于 ${date(s.cycleStartedAt)}` : "尚未开始"}，尝试上传 ${mb(s.uploadBytes)}。${s.budgetWarning ? "当前或下一次上传估算达到预算的 80% 警戒线，请核对账户实际流量。" : ""}`;
      estimate();
    } catch (error) { status.textContent = describeError(error); }
    timer = setTimeout(() => void refresh(), 30000);
  }
  function refresh(): Promise<void> {
    if (loading) return loading;
    loading = load().finally(() => { loading = null; });
    return loading;
  }
  form.addEventListener("input", estimate);
  form.addEventListener("submit", event => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    busy = true;
    void (async () => {
      try {
        selected(); const p = plan();
        const confirmed = await openSettingsDialog({ title: "启用自动云备份？", body: paragraph(`每 ${p.everyDays} 天 ${time.value}（${zoneLabel(p.utcOffsetMinutes)}，固定偏移）检查。${must("cloud-auto-estimate").textContent} 仅程序运行时执行；恢复后关闭；失败最多自动重试 3 次，超预算${p.pauseAtBudget ? "暂停" : "仅提醒"}。`), confirmLabel: "确认启用", action: () => api.configureSchedule(p), describeError });
        if (confirmed) await refresh();
      } catch (error) { status.textContent = error instanceof Error ? error.message : describeError(error); }
      finally { busy = false; }
    })();
  });
  must("cloud-auto-disable").addEventListener("click", () => {
    if (busy) return; busy = true;
    void api.configureSchedule(null).then(refresh, error => { status.textContent = describeError(error); }).finally(() => { busy = false; });
  });
  void refresh(); // App-wide missed/paused notice, even before visiting settings.
  return refresh;
}
