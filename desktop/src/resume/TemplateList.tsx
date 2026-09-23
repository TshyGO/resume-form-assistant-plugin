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

  // 返回是否成功，给重命名这类「失败要留着表单」的调用方用；describeError 让个别调用方
  // （比如导入）在通用错误文案后面再补一句。
  const run = async (work: () => Promise<void>, describeError: (error: unknown) => Notice = describe): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      await work();
      return true;
    } catch (error) {
      setNotice(describeError(error));
      const err = error as { code?: string } | null;
      // 命令报「这条模板已经不在了」时，列表多半也跟着过时了，顺手刷新一次。
      if (err?.code === "NOT_FOUND") void reload();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const importFile = (replaceId: string | null) =>
    run(
      async () => {
        if (!invoke || !pickers) return;
        const path = await pickers.open();
        if (!path) return;
        const result = await invoke<ImportResultView>("import_resume_template_cmd", { path, replaceId });
        setNotice(importMessage(result.template.fieldCount, result.previousFieldCount, result.skippedSecretFields));
        await reload();
      },
      // 对齐插件 popup.js handleTemplateImport：导入失败按是否在覆盖一份已有模板给出不同的收尾提示。
      (error) => {
        const hint = replaceId ? "本次导入未生效，原模板保持不变。" : "本次导入未生效。";
        return { tone: "error", text: `${describe(error).text}${hint}` };
      },
    );

  const exportTemplate = (template: TemplateSummary) =>
    run(async () => {
      if (!invoke || !pickers) return;
      const path = await pickers.save(exportFileName(template.name));
      if (!path) return;
      await invoke("export_resume_template_cmd", { id: template.id, path });
      setNotice({ tone: "ok", text: `已导出 ${template.fieldCount} 个字段。` });
    });

  if (!invoke) return <p className="muted">没有连上桌面程序，模板要在桌面程序里管理。</p>;
  if (!overview) {
    if (notice) {
      return (
        <div className="stack">
          <p className={`note ${notice.tone}`} role="status">
            {notice.text}
          </p>
          <button type="button" onClick={() => void reload()}>
            重试
          </button>
        </div>
      );
    }
    return <p className="muted">正在读取模板…</p>;
  }

  return (
    <div className="stack">
      <div className="row">
        <button type="button" className="primary" disabled={busy || !pickers} onClick={() => void importFile(null)}>
          导入 Excel
        </button>
        {!pickers ? <span className="muted">请在桌面程序里导入。</span> : null}
      </div>
      <p className="muted">支持 .xlsx 和 UTF-8 编码的 .csv，三列：一级分类、字段名、值。</p>
      {notice ? (
        <p className={`note ${notice.tone}`} role="status">
          {notice.text}
        </p>
      ) : null}
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
  onRename(name: string): Promise<boolean>;
  onDelete(): void;
}) {
  const invoke = useInvoke();
  const { template } = props;
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(template.name);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<ResumeTemplateView | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // 展开时拉一次内容。重新导入会原地覆盖同一个模板 id，这一行不会重新挂载，所以
  // 展开着的预览要跟着 updatedAt / fieldCount 的变化再拉一次，不能留着旧内容；收起时不拉。
  useEffect(() => {
    if (!previewOpen || !invoke) return;
    let cancelled = false;
    invoke<ResumeTemplateView>("get_resume_template_cmd", { id: template.id }).then(
      (loaded) => {
        if (cancelled) return;
        setPreview(loaded);
        setPreviewError(null);
      },
      (error: unknown) => {
        if (!cancelled) setPreviewError(describe(error).text);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [previewOpen, invoke, template.id, template.updatedAt, template.fieldCount]);

  const togglePreview = () => {
    if (previewOpen) {
      setPreviewOpen(false);
      setPreview(null);
      setPreviewError(null);
      return;
    }
    setPreviewOpen(true);
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
        <button type="button" onClick={togglePreview}>
          {previewOpen ? "收起" : "预览"}
        </button>
        <button type="button" disabled={props.busy || !props.canUseFiles} onClick={props.onReimport}>
          重新导入
        </button>
        <button type="button" disabled={props.busy || !props.canUseFiles} onClick={props.onExport}>
          导出 Excel
        </button>
        <button
          type="button"
          disabled={props.busy}
          onClick={() =>
            setRenaming((open) => {
              // 打开表单时才把草稿名同步成当前名字：正打开着改的时候不该被外部刷新打断。
              if (!open) setDraftName(template.name);
              return !open;
            })
          }
        >
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
          onSubmit={async (event) => {
            event.preventDefault();
            // 只有真的改成了才收起表单；被拒绝（比如校验不通过）要留着让用户改。
            const ok = await props.onRename(draftName);
            if (ok) setRenaming(false);
          }}
        >
          <label>
            新名称
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
          </label>
          <button type="submit" disabled={props.busy || !draftName.trim()}>
            保存名称
          </button>
        </form>
      ) : null}
      {previewError ? <p className="note error">{previewError}</p> : null}
      {previewOpen && preview ? (
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
