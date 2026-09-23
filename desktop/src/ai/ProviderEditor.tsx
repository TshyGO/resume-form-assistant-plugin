import { useEffect, useRef, useState } from "react";
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
  const [confirmClear, setConfirmClear] = useState(false);
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

  const clearKey = async () => {
    if (!invoke || !provider || busy) return;
    setBusy(true);
    try {
      const view = await invoke<AiSettingsView>("clear_ai_key_cmd", { providerId: provider.id });
      setConfirmClear(false);
      setMessage({ tone: "ok", text: "Key 已从系统凭据库删除。" });
      onKeyCleared?.(view);
    } catch (error) {
      setMessage(describeCommandError(error));
    } finally {
      setBusy(false);
    }
  };

  const risk = describeTransportRisk(apiUrl);
  const secrets = describeUrlSecrets(apiUrl);
  const keyState = provider ? describeProviderKey(provider, credentialError) : null;
  const candidates = models ? matchModels(models, model).slice(0, 30) : [];

  return (
    <form className="stack ai-config-form" onSubmit={save}>
      <label>
        名称
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoComplete="off" />
      </label>
      <label>
        接口地址
        <input
          value={apiUrl}
          onChange={(event) => {
            setApiUrl(event.target.value);
            invalidateModels();
          }}
          placeholder="https://api.deepseek.com/v1"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <p className="muted">填 Base URL 就行，保存时补全成 /chat/completions；自定义代理路径保持原样。</p>
      {risk ? <p role="status" className={`note ${risk.tone}`}>{risk.text}</p> : null}
      {secrets ? <p role="status" className={`note ${secrets.tone}`}>{secrets.text}</p> : null}
      {preset?.keyPage ? (
        <p className="muted">
          去这里申请 Key：<code>{preset.keyPage}</code>
        </p>
      ) : null}
      <label>
        模型名称
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder={preset?.modelHint || "deepseek-chat"}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="row">
        <button type="button" onClick={fetchModels} disabled={modelsBusy || !invoke || apiUrl.trim() === ""}>
          {modelsBusy ? "正在获取…" : "获取模型"}
        </button>
        <span className="muted">只发 Key，不发简历；失败不影响保存，永远可以手填。</span>
      </div>
      {candidates.length ? (
        <ul className="model-candidates">
          {candidates.map((id) => (
            <li key={id}>
              <button type="button" onClick={() => setModel(id)}>
                {id}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {modelsNote ? <p role="status" className={`note ${modelsNote.tone}`}>{modelsNote.text}</p> : null}
      {keyState ? <p className={`note ${keyState.tone}`}>{keyState.text}</p> : null}
      <label>
        API Key
        <input
          type="password"
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
            invalidateModels();
          }}
          placeholder={provider?.keyConfigured ? "不改就留空" : "粘贴后点保存，界面不会再显示它"}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {provider?.keyConfigured ? (
        confirmClear ? (
          <div className="row">
            <button type="button" className="danger" onClick={() => void clearKey()} disabled={busy}>
              确认清除
            </button>
            <button type="button" onClick={() => setConfirmClear(false)}>
              取消
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmClear(true)} disabled={busy}>
            清除 Key
          </button>
        )
      ) : null}
      {message ? <p role="status" className={`note ${message.tone}`}>{message.text}</p> : null}
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !invoke}>
          保存
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
