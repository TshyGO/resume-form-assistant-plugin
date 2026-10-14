import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Invoke } from "../api.ts";
import type { UsageStatus, UsageSubscription } from "../usage-metrics.ts";

export function UsageSettings({ invoke, noticeContainer, subscribe }: {
  invoke: Invoke | null; noticeContainer?: Element; subscribe?: UsageSubscription;
}) {
  const [status, setStatus] = useState<UsageStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const latest = useRef(-1);
  const saving = useRef(false);
  const mounted = useRef(false);
  const accept = (next: UsageStatus) => {
    if (!mounted.current || next.revision < latest.current) return;
    latest.current = next.revision;
    setStatus(next);
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let unlisten: (() => void) | undefined;
    const refresh = () => {
      if (invoke) void invoke<UsageStatus>("telemetry_status").then(next => {
        if (active) accept(next);
      }).catch(() => { if (active) setError("无法读取使用统计设置，请重新打开此页。"); });
    };
    // Subscribe before reading, so a quick delete receipt cannot be lost on mount.
    if (subscribe) void subscribe(refresh).then(stop => {
      if (!active) { stop(); return; }
      unlisten = stop; refresh();
    }).catch(refresh);
    else refresh();
    return () => { active = false; mounted.current = false; unlisten?.(); };
  }, [invoke, subscribe]);

  async function change(command: "telemetry_enabled" | "telemetry_notice", enabled?: boolean) {
    if (!invoke || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      accept(await invoke<UsageStatus>(command, command === "telemetry_enabled" ? { enabled } : undefined));
    } catch (failure) {
      if (!mounted.current) return;
      setError(typeof failure === "string" && failure.startsWith("本次运行已停止使用统计")
        ? failure : "设置未能保存，请重试。");
      // Off may already have taken effect in memory even when persistence failed.
      try { accept(await invoke<UsageStatus>("telemetry_status")); } catch { /* retain the visible error */ }
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  const details = <>
    <p>使用数量统计默认开启，帮助我们了解网申快填的使用情况。关闭不影响任何功能，与自动错误报告分开设置。</p>
    <p>主动使用可见的桌面窗口时，每个 UTC 日每种来源最多尝试发送一次。发送内容只有随机安装编号、桌面版本、Windows／macOS 系统类型和桌面来源，以及协议版本；不发送简历、申请记录、网页或具体操作内容。插件在可见界面主动操作时，也会通过本机桌面发送插件来源信号；同机桌面、Chrome 和 Edge 合计只算一个活跃安装。</p>
    <p>数据发送到我们的 Cloudflare 统计服务。随机编号用于去重，属于假名化标识；明细保留 45 天，无安装标识的汇总保留 365 天。统计编号不进入档案备份或导出。</p>
    <p>关闭立即停发并清除本机统计编号，尝试删除云端对应明细；离线时无法保证即时删除，已生成的无标识汇总仍保留。短期撤销记录和平台备份可能暂留，详见隐私政策。再次开启使用新编号，不补发关闭期间活动。</p>
  </>;
  const notice = status?.notice_required ? <section className="settings-card usage-notice" data-usage-settings aria-labelledby="usage-notice-title">
    <h2 id="usage-notice-title">使用数量统计默认开启</h2>
    {details}
    <p>在你看完这份说明并点击“知道了，保持开启”前，不发送使用统计；此前活动不会补发。你可以现在关闭，也可以以后在“设置 → 隐私”关闭。</p>
    <div className="settings-dialog-actions">
      <button type="button" disabled={busy || !invoke} onClick={() => void change("telemetry_enabled", false)}>关闭使用统计</button>
      <button type="button" disabled={busy || !invoke} onClick={() => void change("telemetry_notice")}>知道了，保持开启</button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
  </section> : null;
  return <>
    {noticeContainer && notice ? createPortal(notice, noticeContainer) : notice}
    <section className="settings-card" data-usage-settings aria-labelledby="usage-settings-title">
      <header className="settings-card-head"><h2 id="usage-settings-title">使用数量统计</h2><p>帮助我们了解实际使用情况，关闭不影响功能。</p></header>
      <div className="setting-row"><div><label className="setting-label" htmlFor="usage-enabled">分享使用数量统计</label><p>默认开启，与错误报告分开。仅发送去重编号、版本、系统类型和来源。</p></div>
        <input id="usage-enabled" type="checkbox" className="setting-toggle" checked={status?.enabled ?? false} disabled={busy || !invoke || !status}
          onChange={event => void change("telemetry_enabled", event.target.checked)} />
      </div>
      <details className="settings-fold"><summary>发送内容、保留和关闭后的处理</summary>{details}</details>
      {!invoke ? <p>浏览器预览不会保存设置或发送使用统计。</p> : !status ? <p>正在读取使用统计设置…</p> : <>
        {!status.available ? <p role="status">状态无法可靠读写，已停止发送。检查磁盘权限后可手动重新选择。</p> : null}
        {!status.outbound_enabled ? <p>当前构建未启用统计外发；保存开关和查看说明不会发送数据。</p> : null}
        {status.notice_required ? <p>首次发送前，请查看主窗口上方的统计说明。</p> : null}
        {status.deletion === "pending" ? <p role="status">已关闭。正在尝试删除云端明细，关闭操作不等待删除结果。</p>
          : status.deletion === "deleted" ? <p role="status">{status.available ? "已关闭，" : "本次运行已停发，"}云端接口已确认删除对应明细；历史无标识汇总及备份留存按隐私政策处理。</p>
          : status.deletion === "unconfirmed" ? <p role="status">{status.available ? "已关闭，本机编号已清除。" : "本次运行已停发，无法确认本机编号已清除。"}云端删除未获确认，不会自动重试；明细按保留期限清理。</p>
          : !status.enabled && status.available ? <p role="status">使用统计已关闭，不发送活动信号。</p> : null}
      </>}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  </>;
}
