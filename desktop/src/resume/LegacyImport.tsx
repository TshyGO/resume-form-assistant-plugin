import { useCallback, useEffect, useState } from "react";
import type { LegacyImportPending, LegacyImportPreview, LegacyImportStatus } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import type { Notice } from "./resume-text.ts";

/** 订阅宿主事件，返回取消订阅。测试里注入假的；浏览器里直接打开时为 undefined。 */
export type Listen = (name: string, handler: () => void) => Promise<() => void> | (() => void) | void;

type ProfileChoice = "keep_desktop" | "use_imported";

function describe(error: unknown): Notice {
  const err = error as { message?: string } | null;
  return { tone: "error", text: err?.message ?? "操作失败，请重试。" };
}

function doneMessage(status: LegacyImportStatus): Notice {
  if (status.state === "imported" && status.aiConfigDropped) {
    return { tone: "warn", text: "简历和「我的信息」已导入，AI 配置没有导入。请到「设置 → AI」里添加服务商和 Key；插件里的旧 Key 会保留，可以在插件里复制。" };
  }
  if (status.state === "imported") return { tone: "ok", text: "插件里的旧数据已导入桌面。插件会自动清掉它那一份。" };
  return { tone: "ok", text: "已不导入。插件里的数据原样保留，之后可以从插件重新发送。" };
}

/**
 * 插件升级后把旧数据发到桌面，在这里确认（#130 PR 5）。确认放在桌面而不是插件里：
 * 插件界面是网页，容易被冒充点掉。这里只显示名称与计数，不显示字段内容或 Key。
 */
export function LegacyImport({ listen, onImported }: { listen?: Listen; onImported: () => void }) {
  const invoke = useInvoke();
  const [pending, setPending] = useState<LegacyImportPending | null>(null);
  const [preview, setPreview] = useState<LegacyImportPreview | null>(null);
  const [choice, setChoice] = useState<ProfileChoice | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [askReject, setAskReject] = useState(false);
  const [askDropAi, setAskDropAi] = useState(false);

  const load = useCallback(async () => {
    if (!invoke) return;
    try {
      const list = await invoke<LegacyImportPending[]>("list_legacy_imports_cmd");
      const next = list[0] ?? null;
      setPending(next);
      setPreview(next?.state === "awaiting_confirmation"
        ? await invoke<LegacyImportPreview>("legacy_import_preview_cmd", { importId: next.importId })
        : null);
    } catch (error) {
      setNotice(describe(error));
    }
  }, [invoke]);

  useEffect(() => {
    void load();
    if (!listen) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void Promise.resolve(listen("legacy-import-changed", () => { if (active) void load(); })).then((stop) => {
      if (!stop) return;
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [listen, load]);

  const run = async (work: () => Promise<LegacyImportStatus>) => {
    if (busy || !pending) return;
    setBusy(true);
    try {
      const status = await work();
      setNotice(doneMessage(status));
      setAskReject(false);
      setAskDropAi(false);
      setChoice(null);
      if (status.state === "imported") onImported();
    } catch (error) {
      setNotice(describe(error));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const confirm = () => run(() => invoke!<LegacyImportStatus>("confirm_legacy_import_cmd", {
    importId: pending!.importId,
    profileChoice: choice,
  }));
  const reject = () => run(() => invoke!<LegacyImportStatus>("reject_legacy_import_cmd", { importId: pending!.importId }));

  if (!invoke) return null;
  const noticeView = notice ? <p className={`note ${notice.tone}`} role="status">{notice.text}</p> : null;
  if (!pending) return noticeView;

  if (pending.state === "receiving") {
    return (
      <section className="panel stack" aria-label="插件旧数据导入">
        <p>正在接收插件里的旧数据（已收 {pending.received} / 共 {pending.total}）。收齐后会在这里请你确认。</p>
        {noticeView}
      </section>
    );
  }

  if (pending.applied) {
    return (
      <section className="panel stack" aria-label="插件旧数据导入">
        <p>模板和「我的信息」已按你的选择导入，AI 配置没导入成功（比如系统凭据库暂时不可用，或服务商已满）。</p>
        {noticeView}
        {askDropAi ? (
          <div className="stack">
            <p>确定不导入 AI 配置吗？已经导入的模板和「我的信息」会保留；插件里的旧 API Key 也会保留，之后可以在插件状态页复制，再到「设置 → AI 设置」里填入。</p>
            <div className="row">
              <button type="button" className="danger" disabled={busy} onClick={() => void reject()}>确定不导入 AI 配置</button>
              <button type="button" disabled={busy} onClick={() => setAskDropAi(false)}>返回</button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void confirm()}>重试导入 AI 配置</button>
            <button type="button" disabled={busy} onClick={() => setAskDropAi(true)}>不导入 AI 配置</button>
          </div>
        )}
      </section>
    );
  }

  const needsChoice = Boolean(preview && preview.profileItemCount !== null && !preview.desktopProfileEmpty);
  return (
    <section className="panel stack" aria-label="插件旧数据导入">
      <p><strong>插件里有旧数据要导入桌面</strong>（插件 {pending.pluginVersion}）。确认前不会写入。</p>
      {preview ? (
        <ul>
          {preview.templates.map((template, index) => (
            <li key={index}>
              模板「{template.name}」：{template.fieldCount} 个字段{template.wasActive ? "（插件里的当前模板）" : ""}
            </li>
          ))}
          {preview.profileItemCount !== null ? <li>「我的信息」：{preview.profileItemCount} 项</li> : null}
          <li>{preview.ai ? `AI 配置：${preview.ai.host}，模型 ${preview.ai.model}（含 API Key，存进系统凭据库）` : "不含 AI 配置"}</li>
        </ul>
      ) : null}
      {preview && preview.templates.length ? (
        <p className="muted">桌面现有 {preview.desktopTemplateCount} 个模板，导入的会追加在后面，同名的自动编号。</p>
      ) : null}
      {needsChoice ? (
        <fieldset className="stack">
          <legend>桌面已经有「我的信息」，保留哪一份？</legend>
          <label>
            <input type="radio" name="legacy-profile" checked={choice === "keep_desktop"} onChange={() => setChoice("keep_desktop")} />
            保留桌面的（插件里那份不导入，导入完成后会从插件删除）
          </label>
          <label>
            <input type="radio" name="legacy-profile" checked={choice === "use_imported"} onChange={() => setChoice("use_imported")} />
            用插件里的覆盖
          </label>
        </fieldset>
      ) : null}
      {noticeView}
      {askReject ? (
        <div className="stack">
          <p>确定不导入吗？插件里的数据会原样保留，之后可以在插件里重新发送。</p>
          <div className="row">
            <button type="button" className="danger" disabled={busy} onClick={() => void reject()}>确定不导入</button>
            <button type="button" disabled={busy} onClick={() => setAskReject(false)}>返回</button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button type="button" className="primary" disabled={busy || (needsChoice && !choice)} onClick={() => void confirm()}>
            导入到桌面
          </button>
          <button type="button" disabled={busy} onClick={() => setAskReject(true)}>不导入</button>
        </div>
      )}
    </section>
  );
}
