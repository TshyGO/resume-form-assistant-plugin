import { useEffect, useId, useRef, useState } from "react";
import type { AiProviderView, AiSettingsView, SaveProviderResult } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { describeCommandError, PRESETS, providerKeyBadge } from "./ai-settings.ts";
import type { Message, Preset } from "./ai-settings.ts";
import { ProviderEditor } from "./ProviderEditor.tsx";
import { ClearKeyDialog, DeleteProviderDialog } from "./ProviderDialogs.tsx";

type Editing = { provider: AiProviderView | null; preset: Preset | null } | null;

/**
 * 设置页的 AI 一段：服务商列表 + 当前使用。Key 只往下走，不往上回。
 * 收件箱「AI 整理」和简历解析都用「当前使用」的那一个；不做失败后自动换服务商。
 * 配置表单只在添加或编辑时出现，一次只编辑一个。
 */
export function AiSettings() {
  const invoke = useInvoke();
  const ids = useId();
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [deleting, setDeleting] = useState<AiProviderView | null>(null);
  const [clearing, setClearing] = useState<AiProviderView | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  /** 关掉编辑器后焦点回到打开它的按钮。 */
  const editorTrigger = useRef<HTMLElement | null>(null);

  const reload = () => {
    if (!invoke) return;
    invoke<AiSettingsView>("get_ai_settings_cmd")
      .then((next) => {
        setView(next);
        setLoadError(null);
      })
      .catch((error: unknown) => setLoadError(describeCommandError(error).text));
  };

  useEffect(reload, [invoke]);

  if (!invoke) {
    return (
      <section className="settings-card">
        <header className="settings-card-head"><h2>AI 设置</h2></header>
        <p className="settings-callout" data-tone="warn">没连上桌面宿主，AI 设置读不出来。</p>
      </section>
    );
  }

  const run = async (work: () => Promise<AiSettingsView>, done: Message) => {
    if (busy) return;
    setBusy(true);
    try {
      setView(await work());
      setMessage(done);
    } catch (error) {
      setMessage(describeCommandError(error));
    } finally {
      setBusy(false);
    }
  };

  const openEditor = (next: NonNullable<Editing>) => {
    editorTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMessage(null);
    setEditing(next);
  };

  const closeEditor = () => {
    setEditing(null);
    const trigger = editorTrigger.current;
    editorTrigger.current = null;
    // 编辑器卸载之后再还焦点，免得焦点落在已经不存在的输入框上。
    setTimeout(() => {
      if (trigger?.isConnected && !(trigger as HTMLButtonElement).disabled) trigger.focus();
    }, 0);
  };

  const onSaved = (result: SaveProviderResult) => {
    setView(result.view);
    closeEditor();
    setMessage(
      result.keyError
        ? { tone: "warn", text: `服务商已保存，但 Key 没存进系统凭据库：${result.keyError}。请编辑后重新填写 Key。` }
        : result.keyCleared
          ? { tone: "warn", text: "已保存。接口地址换了协议或主机，原来的 Key 已清除，请重新填写这个服务商的 Key。" }
          : { tone: "ok", text: "已保存。" },
    );
  };

  const providers = view?.providers ?? [];
  const activeName = (next: AiSettingsView) => next.providers.find((p) => p.id === next.activeProviderId)?.name;

  return (
    <>
      <section className="settings-card">
        <header className="settings-card-head">
          <h2>AI 设置</h2>
          <p>「招聘通知」的「AI 整理」和简历解析都用「当前使用」的服务商。发送前你可以预览并确认要交给服务商的内容。</p>
        </header>
        <details className="settings-note-fold">
          <summary>Key 保存说明</summary>
          <p>每个服务商的 Key 分别保存在系统凭据库（Windows 凭据管理器 / macOS 钥匙串），不进入档案、备份或日志。保存后界面不会再显示它。</p>
        </details>
      </section>

      <section className="settings-card" aria-labelledby={`${ids}-list`}>
        <header className="settings-card-head has-aside">
          <div>
            <h2 id={`${ids}-list`}>已配置服务商</h2>
            <p>可以配置多个，指定一个为当前使用。调用失败不会自动换到别的服务商。</p>
          </div>
          <div className="provider-add">
            <label htmlFor={`${ids}-preset`}>从预设添加</label>
            <select id={`${ids}-preset`} value={presetId} onChange={(event) => setPresetId(event.target.value)} disabled={editing !== null}>
              {PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="primary"
              disabled={editing !== null}
              onClick={() => openEditor({ provider: null, preset: PRESETS.find((p) => p.id === presetId) ?? null })}
            >
              添加服务商
            </button>
          </div>
        </header>

        {loadError ? (
          <div className="settings-callout" data-tone="error" role="alert">
            <p>读取 AI 设置失败：{loadError}</p>
            <button type="button" onClick={reload}>重新读取</button>
          </div>
        ) : null}
        {view?.credentialError ? (
          <p className="settings-callout" data-tone="error">系统凭据库读取失败：{view.credentialError}</p>
        ) : null}
        {!view && !loadError ? <p className="settings-text">正在读取…</p> : null}
        {view && providers.length === 0 ? (
          <div className="settings-empty">
            <strong>还没有配置 AI 服务商</strong>
            <p>在右上角选一个预设（或「自定义」），点「添加服务商」。不配置 AI，手动操作照常可用。</p>
          </div>
        ) : null}

        {providers.length > 0 && view ? (
          <ul className="provider-list">
            {providers.map((provider) => {
              const active = provider.id === view.activeProviderId;
              const badge = providerKeyBadge(provider, view.credentialError);
              const isEditing = editing?.provider?.id === provider.id;
              return (
                <li key={provider.id} aria-label={provider.name} className={`provider-item${active ? " active" : ""}${isEditing ? " editing" : ""}`}>
                  <div className="provider-main">
                    <div className="provider-title">
                      <strong>{provider.name}</strong>
                      {active ? <span className="settings-badge">当前使用</span> : null}
                      {isEditing ? <span className="settings-badge is-muted">正在编辑</span> : null}
                    </div>
                    <div className="provider-meta">
                      <span>主机 <code>{provider.host || "—"}</code></span>
                      <span>模型 <code>{provider.model || "未填写"}</code></span>
                    </div>
                    <p className="provider-key" data-tone={badge.tone}>{badge.text}</p>
                  </div>
                  <div className="provider-actions">
                    {!active ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => invoke<AiSettingsView>("set_active_ai_provider_cmd", { id: provider.id }),
                            { tone: "ok", text: `已切换到「${provider.name}」。` },
                          )
                        }
                      >
                        设为当前
                      </button>
                    ) : null}
                    <button type="button" disabled={busy || editing !== null} onClick={() => openEditor({ provider, preset: null })}>
                      编辑
                    </button>
                    {provider.keyConfigured && !view.credentialError ? (
                      <button type="button" className="settings-warn" disabled={busy || isEditing} onClick={() => setClearing(provider)}>
                        清除 Key
                      </button>
                    ) : null}
                    <button type="button" className="settings-danger-text" disabled={busy || isEditing} onClick={() => setDeleting(provider)}>
                      删除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        {editing ? <p className="settings-text">正在编辑一个服务商。保存或取消之后才能再添加或编辑别的。</p> : null}
        {message ? <p role="status" className="settings-callout" data-tone={message.tone}>{message.text}</p> : null}
      </section>

      {editing ? (
        <ProviderEditor
          key={editing.provider?.id ?? `new-${editing.preset?.id}`}
          provider={editing.provider
            ? (view?.providers.find((p) => p.id === editing.provider?.id) ?? editing.provider)
            : null}
          preset={editing.preset}
          credentialError={view?.credentialError ?? null}
          onSaved={onSaved}
          onCancel={closeEditor}
          onKeyCleared={setView}
          onFailed={reload}
        />
      ) : null}

      <ClearKeyDialog
        provider={clearing}
        onCancel={() => setClearing(null)}
        onCleared={(next) => {
          const name = clearing?.name ?? "";
          setClearing(null);
          setView(next);
          setMessage({ tone: "ok", text: `已清除「${name}」的 Key。重新填写 Key 之前不能用它调用 AI。` });
        }}
      />
      <DeleteProviderDialog
        provider={deleting}
        active={deleting !== null && deleting.id === view?.activeProviderId}
        onCancel={() => setDeleting(null)}
        onDeleted={(next, removed) => {
          setDeleting(null);
          setView(next);
          const current = activeName(next);
          setMessage({
            tone: current ? "ok" : "warn",
            text: current
              ? `已删除「${removed.name}」。当前使用：${current}。`
              : `已删除「${removed.name}」。现在没有当前使用的服务商，需要 AI 时请先添加或设为当前。`,
          });
        }}
      />
    </>
  );
}
