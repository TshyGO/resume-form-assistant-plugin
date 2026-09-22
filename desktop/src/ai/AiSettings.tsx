import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AiSettingsView, ModelListView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import {
  describeCommandError,
  describeKeyState,
  describeModelsResult,
  describeSaved,
  describeTransportRisk,
  describeUrlSecrets,
  matchModels,
} from "./ai-settings.ts";
import type { Message } from "./ai-settings.ts";

/**
 * 设置页的 AI 一段。Key 只往下走，不往上回：保存之后界面只知道「配过了」。
 */
export function AiSettings() {
  const invoke = useInvoke();
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [apiUrl, setApiUrl] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  // 拉回来的候选：只管点选，不管校验。输入框永远可以手填，拉失败也不拦保存。
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsNote, setModelsNote] = useState<Message | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  // 地址或 Key 一改，旧候选立刻作废；回包对不上号就扔掉。
  const modelsRequest = useRef(0);

  const apply = (next: AiSettingsView) => {
    setView(next);
    setApiUrl(next.apiUrl);
    setModel(next.model);
  };

  useEffect(() => {
    if (!invoke) {
      setMessage({ tone: "warn", text: "没连上桌面宿主，AI 设置读不出来。" });
      return;
    }
    invoke<AiSettingsView>("get_ai_settings_cmd")
      .then(apply)
      .catch((error: unknown) => setMessage(describeCommandError(error)));
  }, [invoke]);

  const clearModels = () => {
    modelsRequest.current += 1;
    setModels(null);
    setModelsNote(null);
    // 旧请求回包会被序号守卫丢掉，但忙状态要在这里复位，不然按钮永久卡死。
    setModelsBusy(false);
  };

  const fetchModels = () => {
    if (!invoke || modelsBusy) return;
    const request = modelsRequest.current + 1;
    modelsRequest.current = request;
    setModelsBusy(true);
    invoke<ModelListView>("list_ai_models_cmd", {
      apiUrl,
      key: key.trim() === "" ? null : key,
    })
      .then((result) => {
        if (modelsRequest.current !== request) return;
        setModels(result.models);
        setModelsNote(describeModelsResult(result));
      })
      .catch((error: unknown) => {
        if (modelsRequest.current !== request) return;
        // 拉不到只说一声：手填永远可以，保存也不拦。
        setModelsNote(describeCommandError(error));
      })
      .finally(() => {
        if (modelsRequest.current === request) setModelsBusy(false);
      });
  };
  const run = async (work: () => Promise<AiSettingsView>, done: (next: AiSettingsView) => Message) => {
    if (!invoke || busy) return;
    setBusy(true);
    try {
      const next = await work();
      apply(next);
      setMessage(done(next));
    } catch (error) {
      setMessage(describeCommandError(error));
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = (event: FormEvent) => {
    event.preventDefault();
    const typed = apiUrl;
    void run(
      () => invoke!<AiSettingsView>("save_ai_settings_cmd", { apiUrl: typed, model }),
      (next) => describeSaved(typed, next),
    );
  };

  const saveKey = () => {
    const typed = key;
    void run(
      () => invoke!<AiSettingsView>("set_ai_key_cmd", { key: typed }),
      () => {
        setKey("");
        return { tone: "ok", text: "Key 已存进系统凭据库。" };
      },
    );
  };

  const clearKey = () => {
    void run(
      () => invoke!<AiSettingsView>("clear_ai_key_cmd"),
      () => ({ tone: "ok", text: "Key 已从系统凭据库删除。" }),
    );
  };

  const keyState = describeKeyState(view);
  const risk = describeTransportRisk(apiUrl);
  const secrets = describeUrlSecrets(apiUrl);

  return (
    <div className="stack">
      <p className="muted">
        桌面 AI 配置独立于浏览器插件。发送前，你可以预览并确认要交给服务商的内容。
      </p>
      <p className="muted">证据正文和少量候选申请信息会发给你配置的服务商，对方可能留存。</p>
      <details className="settings-disclosure">
        <summary>Key 保存说明</summary>
        <p className="muted">Key 保存在系统凭据库（Windows 凭据管理器 / macOS 钥匙串），不进入档案、备份或日志。</p>
      </details>

      <form className="stack ai-config-form" onSubmit={saveSettings}>
        <label>
          接口地址
          <input
            id="ai-api-url"
            value={apiUrl}
            onChange={(event) => {
              setApiUrl(event.target.value);
              clearModels();
            }}
            placeholder="https://api.deepseek.com"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="muted">填服务商给的 Base URL 就行，保存时会补全成 /chat/completions。</p>
        {risk ? <p className={`note ${risk.tone}`}>{risk.text}</p> : null}
        {secrets ? <p className={`note ${secrets.tone}`}>{secrets.text}</p> : null}
        <label>
          模型名称
          <input
            id="ai-model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="deepseek-chat"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="row">
          <button
            type="button"
            onClick={fetchModels}
            disabled={modelsBusy || !invoke}
          >
            {modelsBusy ? "正在获取…" : "获取模型"}
          </button>
        </div>
        <p className="muted">点一次问一次所配服务的模型列表，只发 Key 不发简历；失败不影响保存，永远可以直接手填。</p>
        {models !== null ? <ModelCandidates models={models} query={model} onPick={setModel} /> : null}
        {modelsNote ? <p className={`note ${modelsNote.tone}`}>{modelsNote.text}</p> : null}
        <button type="submit" className="primary" disabled={busy || !invoke}>
          保存设置
        </button>
      </form>

      <p className={`note ${keyState.tone}`}>{keyState.text}</p>
      <label>
        API Key
        <input
          id="ai-key"
          type="password"
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
            clearModels();
          }}
          placeholder="粘贴后点保存，界面不会再显示它"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="row">
        <button type="button" onClick={saveKey} disabled={busy || !invoke || key.trim() === ""}>
          保存 Key
        </button>
        <button
          type="button"
          onClick={clearKey}
          disabled={busy || !invoke || !view?.keyConfigured}
        >
          删除 Key
        </button>
      </div>

      {message ? <p className={`note ${message.tone}`}>{message.text}</p> : null}
    </div>
  );
}

/**
 * 拉回来的候选：按已敲的字过滤，点一个填进输入框。只是快捷填入，
 * 不校验——输错了分析那次会按正常报错走。
 */
function ModelCandidates({
  models,
  query,
  onPick,
}: {
  models: string[];
  query: string;
  onPick: (name: string) => void;
}) {
  const matches = matchModels(models, query);
  const shown = matches.slice(0, 30);
  if (matches.length === 0) {
    return <p className="muted">没有对上已敲字的候选，直接手填就行。</p>;
  }
  return (
    <div className="stack">
      <ul className="model-candidates">
        {shown.map((name) => (
          <li key={name}>
            <button type="button" onClick={() => onPick(name)}>
              {name}
            </button>
          </li>
        ))}
      </ul>
      {matches.length > shown.length ? (
        <p className="muted">还有 {matches.length - shown.length} 个，继续敲字可筛。</p>
      ) : null}
    </div>
  );
}
