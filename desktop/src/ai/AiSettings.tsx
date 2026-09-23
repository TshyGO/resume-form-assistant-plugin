import { useEffect, useState } from "react";
import type { AiProviderView, AiSettingsView, SaveProviderResult } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { describeCommandError, describeProviderKey, PRESETS } from "./ai-settings.ts";
import type { Message, Preset } from "./ai-settings.ts";
import { ProviderEditor } from "./ProviderEditor.tsx";

type Editing = { provider: AiProviderView | null; preset: Preset | null } | null;

/**
 * 设置页的 AI 一段：服务商列表 + 当前使用。Key 只往下走，不往上回。
 * 收件箱「AI 整理」和简历解析都用「当前使用」的那一个；不做失败后自动换服务商。
 */
export function AiSettings() {
  const invoke = useInvoke();
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!invoke) return;
    invoke<AiSettingsView>("get_ai_settings_cmd")
      .then(setView)
      .catch((error: unknown) => setMessage(describeCommandError(error)));
  }, [invoke]);

  if (!invoke) return <p className="note warn">没连上桌面宿主，AI 设置读不出来。</p>;

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

  const onSaved = (result: SaveProviderResult) => {
    setView(result.view);
    setEditing(null);
    setMessage(
      result.keyCleared
        ? { tone: "warn", text: "已保存。接口地址换了主机，原来的 Key 已清除，请重新填写这个服务商的 Key。" }
        : { tone: "ok", text: "已保存。" },
    );
  };

  return (
    <div className="stack">
      <p className="muted">收件箱的「AI 整理」和简历解析都用「当前使用」的服务商。发送前你可以预览并确认要交给服务商的内容。</p>
      <details className="settings-disclosure">
        <summary>Key 保存说明</summary>
        <p className="muted">每个服务商的 Key 分别保存在系统凭据库（Windows 凭据管理器 / macOS 钥匙串），不进入档案、备份或日志。</p>
      </details>

      {view && view.providers.length === 0 ? <p className="note warn">还没有配置 AI 服务商。从下面的预设添加一个。</p> : null}

      {view && view.providers.length > 0 ? (
        <ul className="provider-list">
          {view.providers.map((provider) => {
            const active = provider.id === view.activeProviderId;
            const keyState = describeProviderKey(provider, view.credentialError);
            return (
              <li key={provider.id} aria-label={provider.name} className={active ? "provider-item active" : "provider-item"}>
                <div className="row">
                  <strong>{provider.name}</strong>
                  {active ? <span className="pill">当前使用</span> : null}
                  <span className="muted">
                    {provider.host} · {provider.model}
                  </span>
                </div>
                <p className={`note ${keyState.tone}`}>{keyState.text}</p>
                <div className="row">
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
                  <button type="button" disabled={busy} onClick={() => setEditing({ provider, preset: null })}>
                    编辑
                  </button>
                  {confirmDelete === provider.id ? (
                    <>
                      <span className="muted">Key 也会一起删除。</span>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => invoke<AiSettingsView>("delete_ai_provider_cmd", { id: provider.id }),
                            { tone: "ok", text: `已删除「${provider.name}」。` },
                          ).then(() => setConfirmDelete(null))
                        }
                      >
                        确认删除
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => setConfirmDelete(provider.id)}>
                      删除
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {editing ? (
        <ProviderEditor
          key={editing.provider?.id ?? `new-${editing.preset?.id}`}
          provider={editing.provider
            ? (view?.providers.find((p) => p.id === editing.provider?.id) ?? editing.provider)
            : null}
          preset={editing.preset}
          credentialError={view?.credentialError ?? null}
          onSaved={onSaved}
          onCancel={() => setEditing(null)}
          onKeyCleared={setView}
        />
      ) : (
        <div className="row">
          <label>
            从预设添加
            <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
              {PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setEditing({ provider: null, preset: PRESETS.find((p) => p.id === presetId) ?? null })}
          >
            添加
          </button>
        </div>
      )}

      {message ? <p role="status" className={`note ${message.tone}`}>{message.text}</p> : null}
    </div>
  );
}
