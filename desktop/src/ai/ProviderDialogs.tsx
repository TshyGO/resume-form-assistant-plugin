import { useState } from "react";
import type { AiProviderView, AiSettingsView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { SettingsDialog } from "../react/SettingsDialog.tsx";
import { describeCommandError } from "./ai-settings.ts";

/**
 * 清除 Key 的确认。列表和编辑器两个入口都用这一个：动作一样，说法也一样。
 * 失败时弹窗不关，原因写在弹窗里。
 */
export function ClearKeyDialog({
  provider,
  onCancel,
  onCleared,
}: {
  provider: AiProviderView | null;
  onCancel(): void;
  onCleared(view: AiSettingsView): void;
}) {
  const invoke = useInvoke();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = () => {
    setError("");
    onCancel();
  };
  const confirm = async () => {
    if (!invoke || !provider || busy) return;
    setBusy(true);
    setError("");
    try {
      const view = await invoke<AiSettingsView>("clear_ai_key_cmd", { providerId: provider.id });
      onCleared(view);
    } catch (problem) {
      setError(describeCommandError(problem).text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsDialog
      open={provider !== null}
      title="清除这个服务商的 Key？"
      intro={provider ? `服务商：${provider.name}` : undefined}
      tone="danger"
      onCancel={close}
      cancelDisabled={busy}
      footer={
        <>
          <button type="button" onClick={close} disabled={busy} data-autofocus>
            取消
          </button>
          <button type="button" className="settings-danger-solid" onClick={() => void confirm()} disabled={busy}>
            {busy ? "正在清除…" : "清除 Key"}
          </button>
        </>
      }
    >
      <p>Key 会从系统凭据库删除。服务商配置保留，但在重新填写 Key 之前不能用它调用 AI。</p>
      {error ? <p className="settings-dialog-error" role="alert">{error}</p> : null}
    </SettingsDialog>
  );
}

/**
 * 删除服务商的确认。删掉的是配置和它在系统凭据库里的 Key；删的是当前使用的那个时，
 * 不预测之后会用哪个，删完按真实结果告诉用户。
 */
export function DeleteProviderDialog({
  provider,
  active,
  onCancel,
  onDeleted,
}: {
  provider: AiProviderView | null;
  active: boolean;
  onCancel(): void;
  onDeleted(view: AiSettingsView, removed: AiProviderView): void;
}) {
  const invoke = useInvoke();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = () => {
    setError("");
    onCancel();
  };
  const confirm = async () => {
    if (!invoke || !provider || busy) return;
    setBusy(true);
    setError("");
    try {
      const view = await invoke<AiSettingsView>("delete_ai_provider_cmd", { id: provider.id });
      onDeleted(view, provider);
    } catch (problem) {
      setError(describeCommandError(problem).text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsDialog
      open={provider !== null}
      title="删除这个服务商？"
      intro={provider ? `服务商：${provider.name}` : undefined}
      tone="danger"
      onCancel={close}
      cancelDisabled={busy}
      footer={
        <>
          <button type="button" onClick={close} disabled={busy} data-autofocus>
            取消
          </button>
          <button type="button" className="settings-danger-solid" onClick={() => void confirm()} disabled={busy}>
            {busy ? "正在删除…" : "删除服务商"}
          </button>
        </>
      }
    >
      <p>这个服务商的配置会被删除，它保存在系统凭据库里的 Key 也会一起删除。</p>
      {active ? <p className="settings-dialog-warn">它是当前使用的服务商。删除后请在列表里确认当前使用哪一个；没有可用的服务商时，收件箱 AI 整理和简历解析暂时用不了。</p> : null}
      {error ? <p className="settings-dialog-error" role="alert">{error}</p> : null}
    </SettingsDialog>
  );
}
