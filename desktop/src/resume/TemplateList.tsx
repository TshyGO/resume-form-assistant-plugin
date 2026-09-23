import { useCallback, useEffect, useState } from "react";
import type { ImportResultView, ResumeOverview, ResumeTemplateView, TemplateSummary } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { exportFileName, importMessage } from "./resume-text.ts";
import type { Notice } from "./resume-text.ts";

/** 原生文件对话框。浏览器里直接打开 index.html 时为 null，界面如实说明。 */
export interface FilePickers {
  open(): Promise<string | null>;
  save(suggested: string): Promise<string | null>;
}

function describe(error: unknown): Notice {
  const err = error as { message?: string } | null;
  return { tone: "error", text: err?.message ?? "操作失败，请重试。" };
}

export function TemplateList({ pickers }: { pickers: FilePickers | null }) {
  const invoke = useInvoke();
  const [overview, setOverview] = useState<ResumeOverview | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!invoke) return;
    try {
      setOverview(await invoke<ResumeOverview>("resume_overview_cmd"));
    } catch (error) {
      setNotice(describe(error));
    }
  }, [invoke]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      setNotice(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const importFile = (replaceId: string | null) =>
    run(async () => {
      if (!invoke || !pickers) return;
      const path = await pickers.open();
      if (!path) return;
      const result = await invoke<ImportResultView>("import_resume_template_cmd", { path, replaceId });
      setNotice(importMessage(result.template.fieldCount, result.previousFieldCount));
      await reload();
    });

  const exportTemplate = (template: TemplateSummary) =>
    run(async () => {
      if (!invoke || !pickers) return;
      const path = await pickers.save(exportFileName(template.name));
      if (!path) return;
      await invoke("export_resume_template_cmd", { id: template.id, path });
      setNotice({ tone: "ok", text: `已导出 ${template.fieldCount} 个字段。` });
    });

  if (!invoke) return <p className="muted">没有连上桌面程序，模板要在桌面程序里管理。</p>;
  if (!overview) return <p className="muted">正在读取模板…</p>;

  return (
    <div className="stack">
      <div className="row">
        <button type="button" className="primary" disabled={busy || !pickers} onClick={() => void importFile(null)}>
          导入 Excel
        </button>
        {!pickers ? <span className="muted">请在桌面程序里导入。</span> : null}
      </div>
      <p className="muted">支持 .xlsx 和 UTF-8 编码的 .csv，三列：一级分类、字段名、值。</p>
      {notice ? <p className={`note ${notice.tone}`}>{notice.text}</p> : null}
      {overview.templates.length === 0 ? (
        <p className="muted">还没有简历模板。导入一份 Excel，或在插件旧版里导出后再导入。</p>
      ) : (
        <ul className="template-list">
          {overview.templates.map((template) => (
            <TemplateRow
              key={template.id}
              template={template}
              active={template.id === overview.activeTemplateId}
              busy={busy}
              canUseFiles={Boolean(pickers)}
              onActivate={() =>
                run(async () => {
                  setOverview(await invoke<ResumeOverview>("set_active_resume_template_cmd", { id: template.id }));
                  setNotice({ tone: "ok", text: "已切换当前模板。" });
                })
              }
              onReimport={() => void importFile(template.id)}
              onExport={() => void exportTemplate(template)}
              onRename={(name) =>
                run(async () => {
                  await invoke("rename_resume_template_cmd", { id: template.id, name });
                  setNotice({ tone: "ok", text: "已改名。" });
                  await reload();
                })
              }
              onDelete={() =>
                run(async () => {
                  setOverview(await invoke<ResumeOverview>("delete_resume_template_cmd", { id: template.id }));
                  setNotice({ tone: "ok", text: `已删除「${template.name}」。` });
                })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TemplateRow(props: {
  template: TemplateSummary;
  active: boolean;
  busy: boolean;
  canUseFiles: boolean;
  onActivate(): void;
  onReimport(): void;
  onExport(): void;
  onRename(name: string): void;
  onDelete(): void;
}) {
  const invoke = useInvoke();
  const { template } = props;
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(template.name);
  const [preview, setPreview] = useState<ResumeTemplateView | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // 父组件改完名会重新拉整份 overview，template.name 跟着变；重新打开表单时要看到最新的名字。
  useEffect(() => {
    setDraftName(template.name);
  }, [template.name]);

  const togglePreview = async () => {
    if (preview) {
      setPreview(null);
      return;
    }
    try {
      setPreview(await invoke!<ResumeTemplateView>("get_resume_template_cmd", { id: template.id }));
      setPreviewError(null);
    } catch (error) {
      setPreviewError(describe(error).text);
    }
  };

  return (
    <li aria-label={template.name} className={props.active ? "template-item active" : "template-item"}>
      <div className="row">
        <strong>{template.name}</strong>
        {props.active ? <span className="pill">当前</span> : null}
        <span className="muted">{template.fieldCount} 个字段</span>
      </div>
      <div className="row">
        {!props.active ? (
          <button type="button" disabled={props.busy} onClick={props.onActivate}>
            设为当前
          </button>
        ) : null}
        <button type="button" onClick={() => void togglePreview()}>
          {preview ? "收起" : "预览"}
        </button>
        <button type="button" disabled={props.busy || !props.canUseFiles} onClick={props.onReimport}>
          重新导入
        </button>
        <button type="button" disabled={props.busy || !props.canUseFiles} onClick={props.onExport}>
          导出 Excel
        </button>
        <button type="button" disabled={props.busy} onClick={() => setRenaming((v) => !v)}>
          重命名
        </button>
        {confirming ? (
          <>
            <button type="button" className="danger" disabled={props.busy} onClick={props.onDelete}>
              确认删除
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              取消
            </button>
          </>
        ) : (
          <button type="button" disabled={props.busy} onClick={() => setConfirming(true)}>
            删除
          </button>
        )}
      </div>
      {renaming ? (
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            props.onRename(draftName);
            setRenaming(false);
          }}
        >
          <label>
            新名称
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
          </label>
          <button type="submit">保存名称</button>
        </form>
      ) : null}
      {previewError ? <p className="note error">{previewError}</p> : null}
      {preview ? (
        <div className="template-preview">
          {preview.groups.map((group) => (
            <section key={group.name}>
              <h4>{group.name}</h4>
              <dl>
                {group.fields.map((field, index) => (
                  <div key={`${field.key}-${index}`} className="row">
                    <dt>{field.key}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      ) : null}
    </li>
  );
}
