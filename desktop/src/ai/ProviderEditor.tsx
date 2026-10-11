import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AiProviderView, AiSettingsView, ModelListView, SaveProviderResult } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import {
  describeCommandError,
  describeModelsResult,
  describeProviderKey,
  describeTransportRisk,
  describeUrlSecrets,
  matchModels,
} from "./ai-settings.ts";
import type { Message, Preset } from "./ai-settings.ts";
import { ClearKeyDialog } from "./ProviderDialogs.tsx";

export interface ProviderEditorProps {
  /** 编辑已有的；新建时为 null。 */
  provider: AiProviderView | null;
  /** 新建时选的预设；编辑时为 null。 */
  preset: Preset | null;
  credentialError: string | null;
  onSaved(result: SaveProviderResult): void;
  onCancel(): void;
  /** 清除 Key 之后把新视图交回列表。 */
  onKeyCleared?(view: AiSettingsView): void;
  /**
   * 保存失败时调用。命令本身可能在校验通过之后才失败（比如 Key 存进凭据库那步），
   * 这时设置其实已经改了，编辑器这份 Key 状态却是保存前读到的、可能过时；上层借这个
   * 回调重新拉一次 `get_ai_settings_cmd`，界面上看到的 Key 状态才准。
   */
  onFailed?(): void;
}

export function ProviderEditor({ provider, preset, credentialError, onSaved, onCancel, onKeyCleared, onFailed }: ProviderEditorProps) {
  const invoke = useInvoke();
  const [name, setName] = useState(provider?.name ?? preset?.name ?? "");
  const [apiUrl, setApiUrl] = useState(provider?.apiUrl ?? preset?.apiUrl ?? "");
  const [model, setModel] = useState(provider?.model ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [clearing, setClearing] = useState(false);
  const ids = useId();
  const field = (part: string) => `${ids}-${part}`;
  const rootRef = useRef<HTMLElement>(null);
  // 候选只对拉取那一刻的地址与 Key 有效；改了就作废，迟到的回包按序号丢掉。
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsNote, setModelsNote] = useState<Message | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const request = useRef(0);

  const invalidateModels = () => {
    request.current += 1;
    setModels(null);
    setModelsNote(null);
    setModelsBusy(false);
  };

  useEffect(() => invalidateModels, []);

  const fetchModels = () => {
    if (!invoke || modelsBusy) return;
    const mine = ++request.current;
    setModelsBusy(true);
    invoke<ModelListView>("list_ai_models_cmd", {
      providerId: provider?.id ?? null,
      apiUrl,
      key: key.trim() === "" ? null : key,
    })
      .then((result) => {
        if (request.current !== mine) return;
        setModels(result.models);
        setModelsNote(describeModelsResult(result));
      })
      .catch((error: unknown) => {
        if (request.current !== mine) return;
        setModelsNote(describeCommandError(error));
      })
      .finally(() => {
        if (request.current === mine) setModelsBusy(false);
      });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!invoke || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await invoke<SaveProviderResult>("save_ai_provider_cmd", {
        provider: { id: provider?.id ?? null, name, apiUrl, model },
        key: key.trim() === "" ? null : key,
      });
      setKey("");
      onSaved(result);
    } catch (error) {
      setMessage(describeCommandError(error));
      onFailed?.();
    } finally {
      setBusy(false);
    }
  };

  // 打开编辑器时把它滚进视野，焦点落到第一个输入框，键盘用户不用再找。
  useEffect(() => {
    rootRef.current?.scrollIntoView?.({ block: "nearest" });
    rootRef.current?.querySelector<HTMLInputElement>("[data-autofocus]")?.focus();
  }, []);

  const risk = describeTransportRisk(apiUrl);
  const secrets = describeUrlSecrets(apiUrl);
  const keyState = provider ? describeProviderKey(provider, credentialError) : null;
  const candidates = models ? matchModels(models, model).slice(0, 30) : [];

  return (
    <section ref={rootRef} className="settings-card provider-editor" aria-labelledby={field("title")}>
      <header className="settings-card-head has-aside">
        <div>
          <h2 id={field("title")}>{provider ? "编辑服务商配置" : `添加服务商${preset && preset.id !== "custom" ? `：${preset.name}` : ""}`}</h2>
          <p>配置 OpenAI 兼容格式的 Chat Completions 接口，只保存在这台电脑上。</p>
        </div>
        <span className="settings-chip">OpenAI 兼容</span>
      </header>
      <form className="settings-form ai-config-form" onSubmit={save}>
        <div className="settings-field">
          <label htmlFor={field("name")}>服务商名称</label>
          <input id={field("name")} value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoComplete="off" data-autofocus />
          <p className="field-hint">只用来在本机界面区分，如「DeepSeek 官方」或「公司中转」。</p>
        </div>
        <div className="settings-field">
          <label htmlFor={field("url")}>接口地址</label>
          <input
            id={field("url")}
            value={apiUrl}
            onChange={(event) => {
              setApiUrl(event.target.value);
              invalidateModels();
            }}
            placeholder="https://api.deepseek.com/v1"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="field-hint">填 Base URL 就行，保存时补全成 /chat/completions；自定义代理路径保持原样。</p>
          {risk ? <p role="status" className="settings-inline-msg" data-tone={risk.tone}>{risk.text}</p> : null}
          {secrets ? <p role="status" className="settings-inline-msg" data-tone={secrets.tone}>{secrets.text}</p> : null}
          {preset?.keyPage ? (
            <p className="field-hint">
              去这里申请 Key：<code className="selectable">{preset.keyPage}</code>
            </p>
          ) : null}
          {preset?.note ? <p className="settings-inline-msg" data-tone="warn">{preset.note}</p> : null}
        </div>
        <div className="settings-field">
          <div className="settings-field-label">
            <label htmlFor={field("key")}>API Key</label>
            {provider?.keyConfigured ? (
              <button type="button" className="settings-link-danger" onClick={() => setClearing(true)} disabled={busy}>
                清除已保存的 Key
              </button>
            ) : null}
          </div>
          <input
            id={field("key")}
            type="password"
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              invalidateModels();
            }}
            placeholder={provider?.keyConfigured ? "留空表示不修改" : "粘贴后点保存，界面不会再显示它"}
            autoComplete="off"
            spellCheck={false}
          />
          {keyState ? <p className="settings-inline-msg" data-tone={keyState.tone}>{keyState.text}</p> : null}
          {provider?.keyConfigured ? <p className="field-hint">留空表示继续使用系统凭据库里已保存的 Key；输入新值会直接替换它。</p> : null}
        </div>
        <div className="settings-field">
          <label htmlFor={field("model")}>模型名称</label>
          <div className="settings-input-row">
            <input
              id={field("model")}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={preset?.modelHint || "deepseek-chat"}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="button" onClick={fetchModels} disabled={modelsBusy || !invoke || apiUrl.trim() === ""}>
              {modelsBusy ? "正在获取…" : "获取模型"}
            </button>
          </div>
          <p className="field-hint">获取模型只发 Key，不发简历；失败不影响保存，随时可以手填。</p>
          {candidates.length ? (
            <ul className="model-candidates" aria-label="可选模型">
              {candidates.map((id) => (
                <li key={id}>
                  <button type="button" aria-pressed={id === model} onClick={() => setModel(id)}>
                    {id}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {modelsNote ? <p role="status" className="settings-inline-msg" data-tone={modelsNote.tone}>{modelsNote.text}</p> : null}
        </div>
        {message ? <p role="status" className="settings-callout" data-tone={message.tone}>{message.text}</p> : null}
        <div className="settings-form-actions">
          <p className="field-hint">删除服务商会同时从系统凭据库删除它的 Key。</p>
          <button type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy || !invoke}>
            {busy ? "正在保存…" : "保存配置"}
          </button>
        </div>
      </form>
      <ClearKeyDialog
        provider={clearing && provider ? provider : null}
        onCancel={() => setClearing(false)}
        onCleared={(view) => {
          setClearing(false);
          setMessage({ tone: "ok", text: "Key 已从系统凭据库删除。" });
          onKeyCleared?.(view);
        }}
      />
    </section>
  );
}
