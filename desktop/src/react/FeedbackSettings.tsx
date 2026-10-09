import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Invoke } from "../api.ts";
import { SettingsDialog } from "./SettingsDialog.tsx";

// `consent: null` means the user has not chosen; nothing automatic is sent until they do.
type Status = { consent: boolean | null };
type Preview = { token: string; payload: Record<string, unknown> };
type Receipt = { ok: boolean; id?: string; reason?: string };
type Tone = "ok" | "warn" | "error" | "info" | "pending";

const COOLDOWN_MS = 60000;

/** 自动错误报告现在是什么状态。未决定不等于开启。 */
function consentState(consent: boolean | null | undefined, saving: boolean, readFailed: boolean): { tone: Tone; text: string } {
  if (saving) return { tone: "pending", text: "正在保存你的选择…" };
  if (readFailed) return { tone: "error", text: "无法读取反馈设置，请重新打开此页。" };
  if (consent === undefined) return { tone: "pending", text: "正在读取…" };
  if (consent === null) return { tone: "warn", text: "你还没有选择。选择之前不会自动发送任何报告。" };
  return consent
    ? { tone: "ok", text: "已开启自动错误报告。程序出错时会发送脱敏的技术信息。" }
    : { tone: "info", text: "自动错误报告没有开启，不会自动发送任何报告。" };
}

export function FeedbackSettings({ invoke, consentContainer }: { invoke: Invoke | null; consentContainer?: Element }) {
  const [consent, setConsent] = useState<boolean | null | undefined>(undefined);
  const [readFailed, setReadFailed] = useState(false);
  const [consentError, setConsentError] = useState("");
  const [consentNote, setConsentNote] = useState<{ tone: Tone; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const preparingRef = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [status, setStatus] = useState<{ tone: Tone; text: string } | null>(null);
  const [lastReceipt, setLastReceipt] = useState("");
  const revision = useRef(0);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Undecided: the choice pops up over the window on launch, so nobody has to look for it.
  const choiceRef = useRef<HTMLDialogElement>(null);
  const choiceBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = choiceRef.current;
    if (consent === null && dialog && !dialog.open) {
      dialog.showModal();
      // 焦点先落在说明正文上：两个按钮都是明确的选择，不让回车替用户选。
      choiceBodyRef.current?.focus();
    }
  }, [consent]);
  useEffect(() => {
    mounted.current = true;
    if (invoke) void invoke<Status>("feedback_status").then(result => { if (mounted.current) { setConsent(result.consent); } }).catch(() => { if (mounted.current) setReadFailed(true); });
    return () => { mounted.current = false; revision.current++; clearTimeout(timer.current); };
  }, [invoke]);
  async function changeConsent(enabled: boolean) {
    if (!invoke || saving) return;
    setSaving(true); setConsentError(""); setConsentNote(null);
    try {
      const result = await invoke<Status>("feedback_consent", { enabled });
      setConsent(result.consent); setReadFailed(false);
      setConsentNote(result.consent ? { tone: "ok", text: "已开启自动错误报告，谢谢。" } : { tone: "info", text: "自动错误报告没有开启，不会自动发送任何报告。" });
    }
    catch (error) {
      // 开关会按真实状态画（consent 没变），这里只把失败原因说出来。
      const message = typeof error === "string" && error.startsWith("本次运行已停止自动上报") ? error : "设置未能保存，请重试。";
      setConsentError(message); setConsentNote({ tone: "error", text: message });
    }
    finally { setSaving(false); }
  }
  function invalidate() { revision.current++; setPreview(null); }
  async function prepare() {
    if (!invoke || busy || preparingRef.current) return;
    preparingRef.current = true; setPreparing(true);
    invalidate(); const current = revision.current;
    setStatus({ tone: "pending", text: "正在准备预览…" });
    try {
      const result = await invoke<Preview>("feedback_preview", { description });
      if (mounted.current && revision.current === current) { setPreview(result); setStatus({ tone: "info", text: "请核对下面的全部内容，确认后发送。" }); }
    } catch { if (revision.current === current) setStatus({ tone: "error", text: "无法准备反馈，请重试。" }); }
    finally { preparingRef.current = false; if (mounted.current) setPreparing(false); }
  }
  async function send() {
    if (!invoke || !preview || busy || cooling) return;
    const token = preview.token; setPreview(null); setBusy(true); setCooling(true); setStatus({ tone: "pending", text: "正在发送…" });
    timer.current = setTimeout(() => setCooling(false), COOLDOWN_MS);
    try {
      const result = await invoke<Receipt>("feedback_send", { token });
      if (result.ok) {
        setStatus({ tone: "ok", text: `发送成功，编号：${result.id}` });
        setLastReceipt(result.id ?? "");
      } else {
        setStatus(result.reason === "cooldown"
          ? { tone: "warn", text: "两次反馈请至少间隔 60 秒。" }
          : { tone: "error", text: "发送失败，没有自动重试。请稍后重新预览并发送。" });
      }
    } catch { setStatus({ tone: "error", text: "发送失败，没有自动重试。请稍后重试。" }); }
    finally { setBusy(false); }
  }
  function closeFeedback() {
    if (busy) return;
    setOpen(false); invalidate(); setStatus(null);
  }

  const choice = consent === null ? <dialog ref={choiceRef} className="settings-dialog size-lg feedback-choice" aria-labelledby="feedback-choice-title"
    // Esc is not an answer. If the webview closes it anyway, it stays on the page as a card.
    onCancel={event => event.preventDefault()} onClose={event => event.currentTarget.show()}>
    <div className="settings-dialog-head">
      <h2 id="feedback-choice-title">帮我们改进网申快填</h2>
      <p>是否开启自动错误报告？请选择一项，之后可以在“设置 → 隐私”里更改。</p>
    </div>
    <div className="settings-dialog-body" ref={choiceBodyRef} tabIndex={-1}>
      <p>我们在用户群和社交平台上收到过不少反馈，但很多只有一句「用不了」，看不出卡在哪一步，很难找到原因。开启自动错误报告后，程序出错时会把当时的技术情况发给我们，帮我们更快找到问题、把它修好。</p>
      <p>报告里只有技术信息：错误类型、出错的代码位置、程序版本、系统、发送时间和一个随机生成的安装编号。不包含你的简历、个人资料、填写的内容、Cookie 或密钥。发送前会先去掉可能的个人信息。报告最多保存 90 天；部分内容可能会公开在网申快填的 GitHub 项目里，方便复现问题，公开的内容会长期保留；安装编号不会公开。</p>
      <p>你同意后才开始发送，同意前出的错不会补发。以后可以在“设置 → 隐私”里关闭，关闭后删除安装编号，不影响正常使用。桌面程序和插件分开设置。</p>
      {consentError && <p className="settings-dialog-error" role="alert">{consentError}</p>}
    </div>
    <div className="settings-dialog-actions">
      <button type="button" disabled={saving} onClick={() => void changeConsent(false)}>暂不开启</button>
      <button type="button" className="primary" disabled={saving} onClick={() => void changeConsent(true)}>{saving ? "正在保存…" : "同意并开启"}</button>
    </div>
  </dialog> : null;

  const state = consentNote ?? consentState(consent, saving, readFailed);
  return <>
    {consentContainer ? createPortal(choice, consentContainer) : choice}
    <section className="settings-card">
      <header className="settings-card-head"><h2>隐私</h2><p>选择是否分享脱敏的问题报告。</p></header>
      <div className="setting-row">
        <div><label htmlFor="feedback-auto" className="setting-label">自动发送错误报告</label><p>你同意后才会开启。程序出错时自动发送错误类型、代码位置、版本和系统等技术信息，帮我们找到问题，不含简历和个人资料。可随时关闭，关闭后删除安装编号。桌面程序和插件分开设置。</p></div>
        <input id="feedback-auto" type="checkbox" className="setting-toggle" checked={consent === true} disabled={!invoke || consent === undefined || saving} onChange={event => void changeConsent(event.target.checked)} />
      </div>
      {invoke ? <p className="settings-callout" data-tone={state.tone} role="status">{state.text}</p> : <p className="settings-callout" data-tone="warn">没连上桌面宿主，读不到反馈设置。</p>}
    </section>
    <section className="settings-card settings-card-row">
      <div><h2>反馈问题</h2><p>预览确认后才发送。报告最多保存 90 天；可能会公开在网申快填的 GitHub 项目里，公开的内容会长期保留。不开启自动报告也能使用。</p>
        {lastReceipt ? <p className="settings-inline-msg" data-tone="ok">上一次反馈已发送，编号：{lastReceipt}</p> : null}
      </div>
      <button type="button" disabled={!invoke} onClick={() => setOpen(true)}>反馈问题</button>
    </section>
    <SettingsDialog
      open={open}
      size="lg"
      title="反馈问题"
      intro="描述遇到的问题，先预览将要发送的完整内容，确认后再发送。"
      onCancel={closeFeedback}
      cancelDisabled={busy}
      className="feedback-dialog"
      footer={<>
        <button type="button" disabled={busy} onClick={closeFeedback}>{status?.tone === "ok" ? "关闭" : "取消"}</button>
        <button type="button" className="primary" disabled={!preview || busy || cooling} onClick={() => void send()}>{busy ? "正在发送…" : "确认发送"}</button>
      </>}
    >
      <form className="settings-form" onSubmit={event => { event.preventDefault(); void send(); }}>
        <div className="settings-field">
          <label htmlFor="feedback-description">问题描述（请勿填写姓名、简历、账号或密钥）</label>
          <textarea id="feedback-description" rows={5} maxLength={1400} value={description} disabled={busy} data-autofocus onChange={event => { setDescription(event.target.value); invalidate(); setStatus(null); }} />
          <p className="field-hint">最多 1400 字。自动附上版本和系统。请核对预览，删除可能包含的个人信息。改动描述后需要重新预览。</p>
        </div>
        <div className="settings-actions">
          <button type="button" disabled={busy || preparing} onClick={() => void prepare()}>{preparing ? "正在准备…" : preview ? "重新预览" : "预览将发送的内容"}</button>
          {cooling && !busy ? <span className="field-hint">两次发送至少间隔 60 秒。</span> : null}
        </div>
        {preview && <pre className="feedback-preview" tabIndex={0} aria-label="将发送的内容（只读）">{JSON.stringify(preview.payload, null, 2)}</pre>}
        {status ? <p className="settings-callout" data-tone={status.tone} role="status" aria-live="polite">{status.text}</p> : null}
      </form>
    </SettingsDialog>
  </>;
}
