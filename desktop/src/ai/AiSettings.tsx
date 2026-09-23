import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { AiProfileView, AiSettingsView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import {
  describeCommandError,
  describeKeyState,
  describeSaved,
  describeTransportRisk,
  describeUrlSecrets,
} from "./ai-settings.ts";
import type { Message } from "./ai-settings.ts";
import { interpretFetchedModels } from "./model-fetch.ts";
import type { ModelFetchRaw, ModelFetchResult } from "./model-fetch.ts";

/**
 * 设置页的 AI 一段。Key 只往下走，不往上回：保存之后界面只知道「这一份配过了」。
 * 字段顺序是接口地址 → API Key → 模型。获取模型失败也不改已填的模型名。
 */
export function AiSettings() {
  const invoke = useInvoke();
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  const [modelMessage, setModelMessage] = useState<Message | null>(null);
  const [modelResult, setModelResult] = useState<ModelFetchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AiProfileView | null>(null);
  const [deleteNext, setDeleteNext] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const apply = (next: AiSettingsView) => {
    setView(next);
  };

  useEffect(() => {
    if (!invoke) {
      setMessage({ tone: "warn", text: "没连上桌面宿主，AI 设置读不出来。" });
      return;
    }
    invoke<AiSettingsView>("get_ai_settings_cmd")
      .then((next) => {
        apply(next);
        const active = next.profiles.find((profile) => profile.id === next.activeId);
        if (active) {
          startEdit(active);
        }
      })
      .catch((error: unknown) => setMessage(describeCommandError(error)));
  }, [invoke]);

  const startNew = () => {
    setMode("new");
    setEditingId(null);
    setName("");
    setApiUrl("");
    setModel("");
    setKey("");
    setModelResult(null);
    setModelMessage(null);
    setPendingDelete(null);
  };

  const startEdit = (profile: AiProfileView) => {
    setMode("edit");
    setEditingId(profile.id);
    setName(profile.name);
    setApiUrl(profile.apiUrl);
    setModel(profile.model);
    setKey("");
    setModelResult(null);
    setModelMessage(null);
    setPendingDelete(null);
  };

  const run = async (work: () => Promise<AiSettingsView>, done: (next: AiSettingsView) => Message) => {
    if (!invoke || busy) return;
    setBusy(true);
    try {
      const next = await work();
      apply(next);
      setMessage(done(next));
      return next;
    } catch (error) {
      setMessage(describeCommandError(error));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const editing = view?.profiles.find((profile) => profile.id === editingId) ?? null;
  const canKeepKey = mode === "edit" && Boolean(editing?.keyConfigured);

  const saveProfile = (event: FormEvent) => {
    event.preventDefault();
    if (!apiUrl.trim() || !model.trim() || (!key.trim() && !canKeepKey)) {
      setMessage({
        tone: "error",
        text: "请把接口地址、API Key 和模型名称都填完。未完成的配置不会启用。",
      });
      return;
    }
    const typed = apiUrl;
    const typedKey = key.trim();
    void run(
      () =>
        invoke!<AiSettingsView>("save_ai_profile_cmd", {
          id: mode === "edit" ? editingId : null,
          name,
          apiUrl: typed,
          model,
          key: typedKey ? typedKey : null,
        }),
      (next) => {
        setKey("");
        const active = next.profiles.find((profile) => profile.id === next.activeId);
        if (active) startEdit(active);
        return describeSaved(typed, next);
      },
    );
  };

  const fetchModels = () => {
    if (!invoke || busy) return;
    const typedModel = model;
    setBusy(true);
    setModelMessage({ tone: "ok", text: "正在获取模型列表…" });
    void invoke<ModelFetchRaw>(
      "fetch_ai_models_cmd",
      {
        apiUrl,
        apiKey: key,
        profileId: mode === "edit" ? editingId : null,
      },
    )
      .then((raw) => {
        const result = interpretFetchedModels(raw);
        setModel(typedModel);
        if (!result.ok) {
          setModelResult(null);
          setModelMessage({ tone: "error", text: result.message ?? "获取模型失败。仍可以直接填写模型名称。" });
          return;
        }
        setModelResult(result);
        const hidden = result.hiddenCount
          ? `（另隐藏 ${result.hiddenCount} 个向量、语音、图像等非对话模型）`
          : "";
        const summary = `已获取 ${result.models?.length ?? 0} 个模型${hidden}。可从列表选择，也可直接输入任意名称。`;
        const known = result.allModels ?? [];
        if (typedModel.trim() && known.length && !known.includes(typedModel.trim())) {
          setModelMessage({
            tone: "warn",
            text: `${summary}当前填写的「${typedModel.trim()}」不在列表中，请确认拼写。`,
          });
          return;
        }
        setModelMessage({ tone: "ok", text: summary });
      })
      .catch((error: unknown) => setModelMessage(describeCommandError(error)))
      .finally(() => setBusy(false));
  };

  const useProfile = (id: string) => {
    void run(
      () => invoke!<AiSettingsView>("activate_ai_profile_cmd", { id }),
      (next) => {
        const active = next.profiles.find((profile) => profile.id === next.activeId);
        if (active) startEdit(active);
        return { tone: "ok", text: active ? `已改用「${active.name}」。` : "已切换。" };
      },
    );
  };

  const commitRename = () => {
    if (!renamingId || !renameValue.trim()) return;
    void run(
      () => invoke!<AiSettingsView>("rename_ai_profile_cmd", { id: renamingId, name: renameValue.trim() }),
      () => {
        setRenamingId(null);
        return { tone: "ok", text: "名称已更新。" };
      },
    );
  };

  const askDelete = (profile: AiProfileView) => {
    if (profile.id !== view?.activeId) {
      void run(
        () => invoke!<AiSettingsView>("delete_ai_profile_cmd", { id: profile.id }),
        () => ({ tone: "ok", text: `已删除「${profile.name}」。当前配置没有变。` }),
      );
      return;
    }
    const others = view.profiles.filter((item) => item.id !== profile.id);
    setPendingDelete(profile);
    setDeleteNext(others[0]?.id ?? "");
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    const nextId = deleteNext;
    setPendingDelete(null);
    void run(
      () => invoke!<AiSettingsView>("delete_ai_profile_cmd", { id, nextId }),
      (next) => {
        const active = next.profiles.find((profile) => profile.id === next.activeId);
        if (active) startEdit(active);
        else startNew();
        return {
          tone: "ok",
          text: nextId ? "已删除当前配置，并改用所选的那一份。" : "已删除当前配置，现在是未配置状态。",
        };
      },
    );
  };

  const clearKey = () => {
    if (!editingId) return;
    void run(
      () => invoke!<AiSettingsView>("clear_ai_profile_key_cmd", { id: editingId }),
      () => ({ tone: "ok", text: "这一份配置的 Key 已从系统凭据库删除。" }),
    );
  };

  const keyState = describeKeyState(view);
  const risk = describeTransportRisk(apiUrl);
  const secrets = describeUrlSecrets(apiUrl);
  const current = view?.profiles.find((profile) => profile.id === view.activeId) ?? null;

  return (
    <div className="stack">
      <p className="muted">
        桌面 AI 配置独立于浏览器插件。可以保存多份，每份 Key 单独放在系统凭据库里。发送前，你可以预览并确认要交给服务商的内容。
      </p>
      <p className="muted">证据正文和少量候选申请信息会发给你配置的服务商，对方可能留存。</p>
      <p className="ai-current">{current ? `当前使用的配置：${current.name}` : "当前使用的配置：未配置"}</p>
      <div className="ai-profile-list">
        {view?.profiles.length ? (
          view.profiles.map((profile) => (
            <div className={profile.id === view.activeId ? "ai-profile is-active" : "ai-profile"} key={profile.id}>
              <div>
                <strong>{profile.name}</strong>
                <p className="muted">
                  {profile.model} · {profile.keyConfigured ? "Key 已配置" : "Key 未配置"}
                </p>
              </div>
              <div className="row">
                {profile.id === view.activeId ? null : (
                  <button type="button" onClick={() => useProfile(profile.id)} disabled={busy || !invoke}>
                    使用 {profile.name}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setRenamingId(profile.id);
                    setRenameValue(profile.name);
                  }}
                  disabled={busy || !invoke}
                >
                  重命名 {profile.name}
                </button>
                <button type="button" onClick={() => startEdit(profile)} disabled={busy || !invoke}>
                  编辑 {profile.name}
                </button>
                <button type="button" onClick={() => askDelete(profile)} disabled={busy || !invoke}>
                  删除 {profile.name}
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="muted">还没有已保存的配置。</p>
        )}
      </div>
      {renamingId ? (
        <div className="row">
          <label>
            配置名称
            <input
              aria-label="新的配置名称"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
          </label>
          <button type="button" onClick={commitRename} disabled={busy || !invoke}>
            保存名称
          </button>
        </div>
      ) : null}
      {pendingDelete ? (
        <fieldset className="stack">
          <legend>删除当前配置「{pendingDelete.name}」后改用</legend>
          <p className="muted">不会自动改用其他配置的 Key。</p>
          {view?.profiles
            .filter((profile) => profile.id !== pendingDelete.id)
            .map((profile) => (
              <label key={profile.id}>
                <input
                  type="radio"
                  name="ai-delete-next"
                  value={profile.id}
                  checked={deleteNext === profile.id}
                  onChange={() => setDeleteNext(profile.id)}
                />
                {profile.name}
              </label>
            ))}
          <label>
            <input
              type="radio"
              name="ai-delete-next"
              value=""
              checked={deleteNext === ""}
              onChange={() => setDeleteNext("")}
            />
            进入未配置状态
          </label>
          <div className="row">
            <button type="button" onClick={confirmDelete} disabled={busy || !invoke}>
              确认删除
            </button>
            <button type="button" onClick={() => setPendingDelete(null)}>
              取消
            </button>
          </div>
        </fieldset>
      ) : null}

      <div className="row">
        <button type="button" onClick={startNew} disabled={busy || !invoke}>
          新建配置
        </button>
      </div>

      <form className="stack ai-config-form" onSubmit={saveProfile}>
        <label>
          配置名称
          <input
            id="ai-profile-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 DeepSeek、公司中转"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          接口地址
          <input
            id="ai-api-url"
            value={apiUrl}
            onChange={(event) => {
              setApiUrl(event.target.value);
              setModelResult(null);
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
          API Key
          <input
            id="ai-key"
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={canKeepKey ? "留空则继续使用这一份已保存的 Key" : "粘贴后点保存并使用，界面不会再显示它"}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="muted">新建不会带上其他配置的 Key。编辑时留空表示这一份的 Key 不变；换了地址又没填新 Key，保存后这一份会用原来的 Key 访问新地址。</p>
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
          <button type="button" onClick={fetchModels} disabled={busy || !invoke}>
            获取模型
          </button>
          {editing?.keyConfigured ? (
            <button type="button" onClick={clearKey} disabled={busy || !invoke}>
              删除这一份的 Key
            </button>
          ) : null}
        </div>
        {modelResult?.ok && modelResult.models?.length ? (
          <label>
            从列表选择
            <select
              aria-label="从列表选择模型"
              value=""
              onChange={(event) => {
                if (event.target.value) setModel(event.target.value);
              }}
            >
              <option value="">手输或从列表选择</option>
              {modelResult.models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {modelMessage ? <p className={`note ${modelMessage.tone}`}>{modelMessage.text}</p> : null}
        <button type="submit" className="primary" disabled={busy || !invoke}>
          保存并使用
        </button>
      </form>

      <details className="settings-disclosure">
        <summary>Key 保存说明</summary>
        <p className="muted">
          每份配置的 Key 单独保存在系统凭据库（Windows 凭据管理器 / macOS 钥匙串），不进入档案、备份、日志或设置文件。界面只显示配过没有。
        </p>
      </details>
      <p className={`note ${keyState.tone}`}>{keyState.text}</p>
      {message ? <p className={`note ${message.tone}`}>{message.text}</p> : null}
    </div>
  );
}
