import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Invoke } from "../api.ts";

// `consent: null` means the user has not chosen; nothing automatic is sent until they do.
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
  const preparingRef = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [status, setStatus] = useState("");
  const revision = useRef(0);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    if (invoke) void invoke<Status>("feedback_status").then(result => { if (mounted.current) { setConsent(result.consent); } }).catch(() => { if (mounted.current) setStatus("无法读取反馈设置，请重新打开此页。"); });
    return () => { mounted.current = false; revision.current++; clearTimeout(timer.current); };
  }, [invoke]);
  async function changeConsent(enabled: boolean) {
    if (!invoke || saving) return;
    setSaving(true); setConsentError("");
    try { const result = await invoke<Status>("feedback_consent", { enabled }); setConsent(result.consent); setStatus(result.consent ? "已开启自动错误报告，谢谢。" : "自动错误报告没有开启，不会自动发送任何报告。"); }
    catch (error) {
      const message = typeof error === "string" && error.startsWith("本次运行已停止自动上报") ? error : "设置未能保存，请重试。";
      setConsentError(message); setStatus(message);
    }
    finally { setSaving(false); }
  }
  function invalidate() { revision.current++; setPreview(null); }
  async function prepare() {
    if (!invoke || busy || preparingRef.current) return;
    preparingRef.current = true; setPreparing(true);
    invalidate(); const current = revision.current;
    try {
      const result = await invoke<Preview>("feedback_preview", { description });
      if (mounted.current && revision.current === current) { setPreview(result); setStatus("请核对下面的全部内容，确认后发送。"); }
    } catch { if (revision.current === current) setStatus("无法准备反馈，请重试。"); }
    finally { preparingRef.current = false; if (mounted.current) setPreparing(false); }
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
  const choice = consent === null ? <section className="feedback-choice" aria-label="帮我们改进网申快填">
    <h2>帮我们改进网申快填</h2>
    <p>我们在用户群和社交平台上收到过不少反馈，但很多只有一句「用不了」，看不出卡在哪一步，很难找到原因。开启自动错误报告后，程序出错时会把当时的技术情况发给我们，帮我们更快找到问题、把它修好。</p>
    <p>报告里只有技术信息：错误类型、出错的代码位置、程序版本、系统、发送时间和一个随机生成的安装编号。不包含你的简历、个人资料、填写的内容、Cookie 或密钥。发送前会先去掉可能的个人信息。报告最多保存 90 天，部分内容可能会公开在网申快填的 GitHub 项目里，方便复现问题；安装编号不会公开。</p>
    <p>你同意后才开始发送，同意前出的错不会补发。以后可以在“设置 → 隐私”里关闭，关闭后删除安装编号，不影响正常使用。桌面程序和插件分开设置。</p>
    <button type="button" disabled={saving} onClick={() => void changeConsent(true)}>同意并开启</button>{" "}<button type="button" disabled={saving} onClick={() => void changeConsent(false)}>暂不开启</button>
    {consentError && <p role="alert">{consentError}</p>}
  </section> : null;
  return <>
    {consentContainer ? createPortal(choice, consentContainer) : choice}
    <div className="setting-row"><div><label htmlFor="feedback-auto" className="setting-label">自动发送错误报告</label><p>你同意后才会开启。程序出错时自动发送错误类型、代码位置、版本和系统等技术信息，帮我们找到问题，不含简历和个人资料。可随时关闭，关闭后删除安装编号。桌面程序和插件分开设置。</p></div>
      <input id="feedback-auto" type="checkbox" className="setting-toggle" checked={consent === true} disabled={!invoke || consent === undefined || saving} onChange={event => void changeConsent(event.target.checked)} /></div>
    <div className="settings-group"><h3>反馈问题</h3><p>预览确认后才发送。报告最多保存 90 天，可能会公开在网申快填的 GitHub 项目里；不开启自动报告也能使用。</p>
      {!open && <button type="button" disabled={!invoke} onClick={() => setOpen(true)}>反馈问题</button>}
      {open && <form onSubmit={event => { event.preventDefault(); void send(); }}>
        <label htmlFor="feedback-description">问题描述（请勿填写姓名、简历、账号或密钥）</label>
        <textarea id="feedback-description" rows={5} maxLength={1400} value={description} disabled={busy} onChange={event => { setDescription(event.target.value); invalidate(); }} />
        <p className="muted">自动附上版本和系统。请核对预览，删除可能包含的个人信息。</p>
        <button type="button" disabled={busy || preparing} onClick={() => void prepare()}>预览将发送的内容</button>
        {preview && <pre className="feedback-preview" tabIndex={0}>{JSON.stringify(preview.payload, null, 2)}</pre>}
        <div className="actions"><button type="submit" disabled={!preview || busy || cooling}>确认发送</button><button type="button" disabled={busy} onClick={() => { setOpen(false); invalidate(); }}>取消</button></div>
      </form>}
      <p role="status" aria-live="polite">{status}</p>
    </div>
  </>;
}
