import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { AiSettingsView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import {
  describeCommandError,
  describeKeyState,
  describeSaved,
  describeTransportRisk,
  describeUrlSecrets,
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
        桌面自己的一条 AI 配置，和浏览器插件里的互不相通。Key 存在系统凭据库（Windows 凭据管理器 /
        macOS 钥匙串），不进档案、不进备份、不进日志。
      </p>
      <p className="muted">
        用它整理通知时，证据正文和少量候选申请信息会发给你配的服务商，对方可能留存。发送前会让你先看一遍要发什么。
      </p>

      <form className="stack" onSubmit={saveSettings}>
        <label>
          接口地址
          <input
            id="ai-api-url"
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
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
        <button type="submit" disabled={busy || !invoke}>
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
          onChange={(event) => setKey(event.target.value)}
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
