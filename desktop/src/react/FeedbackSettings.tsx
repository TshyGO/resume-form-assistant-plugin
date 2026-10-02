import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Invoke } from "../api.ts";

type Status = { consent: boolean | null };
type Preview = { token: string; payload: Record<string, unknown> };
type Receipt = { ok: boolean; id?: string; reason?: string };
export function FeedbackSettings({ invoke, consentContainer }: { invoke: Invoke | null; consentContainer?: Element }) {
  const [consent, setConsent] = useState<boolean | null | undefined>(undefined);
  const [consentError, setConsentError] = useState("");
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [status, setStatus] = useState("");
  const revision = useRef(0);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    if (invoke) void invoke<Status>("feedback_status").then(result => { if (mounted.current) setConsent(result.consent); }).catch(() => { if (mounted.current) setStatus("无法读取反馈设置，请重新打开此页。"); });
    return () => { mounted.current = false; revision.current++; clearTimeout(timer.current); };
  }, [invoke]);
  async function changeConsent(enabled: boolean) {
    if (!invoke || saving) return;
    setSaving(true); setConsentError("");
    try { const result = await invoke<Status>("feedback_consent", { enabled }); setConsent(result.consent); setStatus(enabled ? "已开启匿名错误报告。" : "已关闭自动上报，安装标识已删除。"); }
    catch { setConsentError("设置未能保存，请重试。"); setStatus("设置未能保存，请重试。"); }
    finally { setSaving(false); }
  }
  function invalidate() { revision.current++; setPreview(null); }
  async function prepare() {
    if (!invoke || busy) return;
    invalidate(); const current = revision.current;
    try {
      const result = await invoke<Preview>("feedback_preview", { description });
      if (mounted.current && revision.current === current) { setPreview(result); setStatus("请核对下面的全部内容，确认后发送。"); }
    } catch { if (revision.current === current) setStatus("无法准备反馈，请重试。"); }
  }
  async function send() {
    if (!invoke || !preview || busy || cooling) return;
    const token = preview.token; setPreview(null); setBusy(true); setCooling(true); setStatus("正在发送…");
    timer.current = setTimeout(() => setCooling(false), 60000);
    try {
      const result = await invoke<Receipt>("feedback_send", { token });
      setStatus(result.ok ? `发送成功，编号：${result.id}` : result.reason === "cooldown" ? "两次反馈请至少间隔 60 秒。" : "发送失败，没有自动重试。请稍后重新预览并发送。");
    } catch { setStatus("发送失败，没有自动重试。请稍后重试。"); }
    finally { setBusy(false); }
  }
  const choice = consent === null ? <section className="feedback-choice" aria-label="错误报告选择">
    <h2>帮助改进网申快填</h2><p>出错时自动发送匿名错误报告？包含错误类型、代码位置、版本和系统。不含简历、填写内容和完整网址。</p>
    <button type="button" disabled={saving} onClick={() => void changeConsent(true)}>开启</button>{" "}<button type="button" disabled={saving} onClick={() => void changeConsent(false)}>暂不</button>
    {consentError && <p role="alert">{consentError}</p>}
  </section> : null;
  return <>
    {consentContainer ? createPortal(choice, consentContainer) : choice}
    <div className="setting-row"><div><label htmlFor="feedback-auto" className="setting-label">自动发送匿名错误报告</label><p>默认不发送；关闭删除随机安装标识。桌面和插件分别设置。</p></div>
      <input id="feedback-auto" type="checkbox" className="setting-toggle" checked={consent === true} disabled={!invoke || consent === undefined || saving} onChange={event => void changeConsent(event.target.checked)} /></div>
    <div className="settings-group"><h3>反馈问题</h3><p>预览后发送至 Cloudflare 中转，Muse 脱敏整理为 GitHub issue。报告最长暂存 90 天；不开启自动报告也能使用。</p>
      {!open && <button type="button" disabled={!invoke} onClick={() => setOpen(true)}>反馈问题</button>}
      {open && <form onSubmit={event => { event.preventDefault(); void send(); }}>
        <label htmlFor="feedback-description">问题描述（请勿填写姓名、简历、账号或密钥）</label>
        <textarea id="feedback-description" rows={5} maxLength={1400} value={description} disabled={busy} onChange={event => { setDescription(event.target.value); invalidate(); }} />
        <p className="muted">自动附上版本和系统。请核对预览，删除可能包含的个人信息。</p>
        <button type="button" disabled={busy} onClick={() => void prepare()}>预览将发送的内容</button>
        {preview && <pre className="feedback-preview" tabIndex={0}>{JSON.stringify(preview.payload, null, 2)}</pre>}
        <div className="actions"><button type="submit" disabled={!preview || busy || cooling}>确认发送</button><button type="button" disabled={busy} onClick={() => { setOpen(false); invalidate(); }}>取消</button></div>
      </form>}
      <p role="status" aria-live="polite">{status}</p>
    </div>
  </>;
}
