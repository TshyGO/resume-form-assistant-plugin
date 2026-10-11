import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ImportResultView, ResumeOverview, ResumeTemplateView, TemplateSummary } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { ResumeDialog } from "./ResumeDialog.tsx";
import type { ResumeParseControls } from "./ResumeParse.tsx";
import { MAX_TEMPLATE_NAME, exportFileName, importMessage, templateDates, templateNameProblem } from "./resume-text.ts";
import type { Notice } from "./resume-text.ts";

/** 原生文件对话框。浏览器里直接打开 index.html 时为 null，界面如实说明。 */
export interface FilePickers {
  open(): Promise<string | null>;
  save(suggested: string): Promise<string | null>;
}

/** 外层要求重新读列表（恢复备份、导入旧数据、AI 新建了模板）；select 是读完后要选中的模板。 */
export interface ReloadSignal {
  token: number;
  select?: string | null;
}

function describe(error: unknown): Notice {
  const err = error as { message?: string } | null;
  return { tone: "error", text: err?.message ?? "操作失败，请重试。" };
}

type Dialog =
  | { kind: "reimport"; template: TemplateSummary }
  | { kind: "rename"; template: TemplateSummary; draft: string; error: string | null }
  | { kind: "delete"; template: TemplateSummary; error: string | null };

type Preview = { id: string; view: ResumeTemplateView } | { id: string; error: string };

const NO_PICKERS = "导入、重新导入和导出要用系统的文件窗口，请在桌面程序里操作。";

/**
 * 「简历模板」工作区（#257）：左边列表，右边所选模板的字段预览。
 * 「选中」只决定右边看哪份；「当前」是插件填写时用的那份，只有点「设为当前」才会变。
 */
export function TemplateList({
  pickers,
  reloadSignal,
  parse,
}: {
  pickers: FilePickers | null;
  reloadSignal?: ReloadSignal;
  parse?: ResumeParseControls;
}) {
  const invoke = useInvoke();
  const [overview, setOverview] = useState<ResumeOverview | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const busyRef = useRef(false);
  const renameFormId = useId();

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

  // 外层的刷新请求：首次挂载时不重复读（上面那次已经在读）。
  const lastToken = useRef(reloadSignal?.token ?? 0);
  useEffect(() => {
    if (!reloadSignal || reloadSignal.token === lastToken.current) return;
    lastToken.current = reloadSignal.token;
    if (reloadSignal.select) setSelected(reloadSignal.select);
    // 不是为了选中新模板的刷新（重新进入简历页、恢复备份、导入旧数据）：上一次操作的结果提示已经过时。
    else setNotice(null);
    void reload();
  }, [reloadSignal, reload]);

  const templates = overview?.templates ?? [];
  // 选中的那份不在了（被删、被恢复备份换掉）时退回当前模板，再退回第一份。
  const selectedTemplate =
    templates.find((t) => t.id === selected) ??
    templates.find((t) => t.id === overview?.activeTemplateId) ??
    templates[0] ??
    null;
  const selectedId = selectedTemplate?.id ?? null;

  // 预览按需读。重新导入会原地覆盖同一个模板 id，所以 updatedAt / fieldCount 变了要再读一次，
  // 不能留着旧内容。
  useEffect(() => {
    if (!invoke || !selectedTemplate) return undefined;
    let cancelled = false;
    const id = selectedTemplate.id;
    invoke<ResumeTemplateView>("get_resume_template_cmd", { id }).then(
      (view) => {
        if (!cancelled) setPreview({ id, view });
      },
      (error: unknown) => {
        if (!cancelled) setPreview({ id, error: describe(error).text });
      },
    );
    return () => {
      cancelled = true;
    };
    // selectedTemplate 每次渲染都是新对象，只看会让内容变化的几个字段。
  }, [invoke, selectedId, selectedTemplate?.updatedAt, selectedTemplate?.fieldCount, previewAttempt]);

  // 返回是否成功，给弹窗这类「失败要留着」的调用方用。onError 让弹窗把错误留在自己里面显示。
  const run = async (
    work: () => Promise<void>,
    { describeError = describe, onError }: { describeError?: (error: unknown) => Notice; onError?: (notice: Notice) => void } = {},
  ): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
      return true;
    } catch (error) {
      const failure = describeError(error);
      if (onError) onError(failure);
      else setNotice(failure);
      const err = error as { code?: string } | null;
      // 命令报「这条模板已经不在了」时，列表多半也跟着过时了，顺手刷新一次。
      if (err?.code === "NOT_FOUND") void reload();
      return false;
    } finally {
      busyRef.current = false;
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
        if (!replaceId) setSelected(result.template.id);
        await reload();
      },
      {
        // 对齐插件 popup.js handleTemplateImport：导入失败按是否在覆盖一份已有模板给出不同的收尾提示。
        describeError: (error) => {
          const hint = replaceId ? "本次导入未生效，原模板保持不变。" : "本次导入未生效。";
          return { tone: "error", text: `${describe(error).text}${hint}` };
        },
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

  const activate = (template: TemplateSummary) =>
    run(async () => {
      if (!invoke) return;
      setOverview(await invoke<ResumeOverview>("set_active_resume_template_cmd", { id: template.id }));
      setNotice({ tone: "ok", text: `已把「${template.name}」设为当前模板，插件填写时优先使用它。` });
    });

  const rename = async (template: TemplateSummary, name: string) => {
    const ok = await run(
      async () => {
        if (!invoke) return;
        await invoke("rename_resume_template_cmd", { id: template.id, name });
        setNotice({ tone: "ok", text: "已改名。" });
        await reload();
      },
      // 被拒绝（重名、校验不通过）时弹窗和输入都留着，原因写在弹窗里。
      { onError: (failure) => setDialog((current) => (current?.kind === "rename" ? { ...current, error: failure.text } : current)) },
    );
    if (ok) setDialog(null);
  };

  const remove = async (template: TemplateSummary) => {
    const ok = await run(
      async () => {
        if (!invoke) return;
        setOverview(await invoke<ResumeOverview>("delete_resume_template_cmd", { id: template.id }));
        setNotice({ tone: "ok", text: `已删除「${template.name}」。` });
      },
      { onError: (failure) => setDialog((current) => (current?.kind === "delete" ? { ...current, error: failure.text } : current)) },
    );
    if (ok) {
      setDialog(null);
      setShowDetail(false);
    }
  };

  const noticeRow = (
    <div className="resume-notices">
      {parse?.panel}
      {notice ? (
        <p className={`note ${notice.tone}`} role="status">
          {notice.text}
        </p>
      ) : null}
    </div>
  );

  if (!invoke) return <p className="muted resume-offline">没有连上桌面程序，模板要在桌面程序里管理。</p>;

  const activeId = overview?.activeTemplateId ?? null;
  const listBody = !overview ? (
    notice ? (
      <div className="template-list-state">
        <button
          type="button"
          onClick={() => {
            // 在这里清空，不放进 reload：importFile 会在调用 reload 之前先设一条
            // 导入提示，reload 里清掉会把那条提示也带没了。
            setNotice(null);
            void reload();
          }}
        >
          重试
        </button>
      </div>
    ) : (
      <p className="muted template-list-state">正在读取模板…</p>
    )
  ) : templates.length === 0 ? (
    <div className="template-empty">
      <p>还没有简历模板。</p>
      <p className="muted">用上方「上传简历，AI 解析」从现有简历生成，或「导入 Excel」导入一份整理好的表格。</p>
    </div>
  ) : (
    <ul className="template-list" aria-label="模板列表">
      {templates.map((template) => {
        const isSelected = template.id === selectedId;
        const isActive = template.id === activeId;
        const dates = templateDates(template.updatedAt);
        return (
          <li key={template.id} aria-label={template.name}>
            <button
              type="button"
              className={`template-card${isSelected ? " is-selected" : ""}${isActive ? " is-active" : ""}`}
              aria-pressed={isSelected}
              onClick={() => {
                setSelected(template.id);
                setShowDetail(true);
              }}
            >
              <span className="template-card-head">
                <strong>{template.name}</strong>
                {isActive ? <span className="template-badge">当前模板</span> : null}
              </span>
              <span className="template-card-meta">
                <span>{template.fieldCount} 个字段</span>
                {dates ? <span>{dates.short}更新</span> : null}
              </span>
              <span className="template-card-hint" aria-hidden="true">
                {isActive ? "预览字段 →" : "预览 · 可设为当前 →"}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="template-workspace-wrap">
      {noticeRow}
      <div className={`template-workspace${showDetail ? " show-detail" : ""}`}>
        <section className="resume-card template-list-card" aria-label="我的模板">
          <div className="template-list-head">
            <div className="resume-card-title">
              <h2>我的模板</h2>
              {overview ? <span className="muted">共 {templates.length} 份</span> : null}
            </div>
            <div className="template-create">
              {parse?.trigger}
              <button type="button" disabled={busy || !pickers || !overview} onClick={() => void importFile(null)}>
                导入 Excel
              </button>
            </div>
            <p className="resume-hint">
              AI 解析支持 PDF、DOCX、TXT（扫描版 PDF 抽不出文字），发送全文前会先请你确认。Excel 支持 .xlsx 和 UTF-8 编码的 .csv，三列：一级分类、字段名、值。
            </p>
            {!pickers ? <p className="resume-hint warn">{NO_PICKERS}</p> : null}
          </div>
          <div className="template-list-scroll">{listBody}</div>
          <p className="resume-card-foot">选择模板查看字段；设为「当前」后，插件填写时优先使用它。</p>
        </section>
        <section className="resume-card template-detail-card" aria-label="模板详情">
          {selectedTemplate ? (
            <TemplateDetail
              template={selectedTemplate}
              active={selectedTemplate.id === activeId}
              busy={busy}
              canUseFiles={Boolean(pickers)}
              preview={preview?.id === selectedTemplate.id ? preview : null}
              onBack={() => setShowDetail(false)}
              onActivate={() => void activate(selectedTemplate)}
              onReimport={() => setDialog({ kind: "reimport", template: selectedTemplate })}
              onExport={() => void exportTemplate(selectedTemplate)}
              onRename={() => setDialog({ kind: "rename", template: selectedTemplate, draft: selectedTemplate.name, error: null })}
              onDelete={() => setDialog({ kind: "delete", template: selectedTemplate, error: null })}
              onRetryPreview={() => {
                setPreview(null);
                setPreviewAttempt((n) => n + 1);
              }}
            />
          ) : (
            <div className="template-detail-empty">
              <h2>{overview ? "还没有可预览的模板" : "模板预览"}</h2>
              <p className="muted">{overview ? "导入或解析出第一份模板后，字段会按分类显示在这里。" : "读取模板后在这里查看字段。"}</p>
            </div>
          )}
        </section>
      </div>
      {parse?.dialog}
      <ResumeDialog
        open={dialog?.kind === "reimport"}
        title="覆盖这份模板？"
        onCancel={() => setDialog(null)}
        footer={
          <>
            <button type="button" data-autofocus onClick={() => setDialog(null)}>取消</button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const target = dialog?.template;
                setDialog(null);
                if (target) void importFile(target.id);
              }}
            >
              继续选文件
            </button>
          </>
        }
      >
        {dialog?.kind === "reimport" ? (
          <>
            <p>下一步将选择 Excel 或 CSV 文件，更新「{dialog.template.name}」的字段。只有导入成功才会替换原内容；选择文件时取消，模板不变。</p>
            <p className="resume-dialog-fact">旧字段数：{dialog.template.fieldCount} · {dialog.template.id === activeId ? "仍是当前模板" : "当前模板不受影响"}</p>
          </>
        ) : null}
      </ResumeDialog>
      <ResumeDialog
        open={dialog?.kind === "rename"}
        title="重命名模板"
        onCancel={() => setDialog(null)}
        cancelDisabled={busy}
        footer={
          <>
            <button type="button" disabled={busy} onClick={() => setDialog(null)}>取消</button>
            <button
              type="submit"
              form={renameFormId}
              className="primary"
              disabled={busy || dialog?.kind !== "rename" || Boolean(templateNameProblem(dialog.draft))}
            >
              保存名称
            </button>
          </>
        }
      >
        {dialog?.kind === "rename" ? (
          <form
            id={renameFormId}
            className="resume-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (templateNameProblem(dialog.draft)) return;
              void rename(dialog.template, dialog.draft);
            }}
          >
            <label>
              模板名称
              <input
                data-autofocus
                value={dialog.draft}
                maxLength={MAX_TEMPLATE_NAME * 2}
                onChange={(event) => setDialog({ ...dialog, draft: event.target.value, error: null })}
              />
            </label>
            <p className="resume-hint">{templateNameProblem(dialog.draft) ?? `名称不能为空，最多 ${MAX_TEMPLATE_NAME} 字。`}</p>
            {dialog.error ? <p className="note error" role="alert">{dialog.error}</p> : null}
          </form>
        ) : null}
      </ResumeDialog>
      <ResumeDialog
        open={dialog?.kind === "delete"}
        tone="danger"
        title={dialog?.kind === "delete" ? `删除「${dialog.template.name}」？` : "删除模板？"}
        onCancel={() => setDialog(null)}
        cancelDisabled={busy}
        footer={
          <>
            <button type="button" data-autofocus disabled={busy} onClick={() => setDialog(null)}>取消</button>
            <button type="button" className="danger-solid" disabled={busy} onClick={() => dialog?.kind === "delete" && void remove(dialog.template)}>
              确认删除
            </button>
          </>
        }
      >
        {dialog?.kind === "delete" ? (
          <>
            <p>这份模板及其 {dialog.template.fieldCount} 个字段将被删除。{deleteEffect(dialog.template, templates, activeId)}</p>
            {dialog.error ? <p className="note error" role="alert">{dialog.error}</p> : null}
          </>
        ) : null}
      </ResumeDialog>
    </div>
  );
}

// 与 archive-store delete_template 同一口径：删掉当前模板时改指向剩下的第一份，删光了就没有当前模板。
function deleteEffect(template: TemplateSummary, templates: TemplateSummary[], activeId: string | null): string {
  if (template.id !== activeId) return "当前模板不受影响。";
  const next = templates.find((t) => t.id !== template.id);
  return next
    ? `它是当前模板；删除后「${next.name}」会成为当前模板。`
    : "它是当前模板，也是最后一份；删除后没有当前模板，插件只能用「我的信息」填写。";
}

// 长内容（简历里的经历描述）占满一整行，短字段两列排。
function isWideValue(value: string): boolean {
  return value.includes("\n") || [...value].length > 36;
}

function TemplateDetail(props: {
  template: TemplateSummary;
  active: boolean;
  busy: boolean;
  canUseFiles: boolean;
  preview: Preview | null;
  onBack(): void;
  onActivate(): void;
  onReimport(): void;
  onExport(): void;
  onRename(): void;
  onDelete(): void;
  onRetryPreview(): void;
}) {
  const { template, active, busy, canUseFiles, preview } = props;
  const dates = templateDates(template.updatedAt);
  return (
    <>
      <div className="template-detail-head">
        <button type="button" className="resume-back" onClick={props.onBack}>
          ← 返回列表
        </button>
        <div className="template-detail-title">
          <div>
            <p className="resume-kicker">{active ? "当前模板 · 字段预览" : "模板预览"}</p>
            <h2>{template.name}</h2>
            <span className="muted">
              {template.fieldCount} 个字段{dates ? ` · 最近更新 ${dates.full}` : ""}
            </span>
          </div>
          {active ? (
            <span className="template-use-badge">填写时优先使用</span>
          ) : (
            <button type="button" className="primary" disabled={busy} onClick={props.onActivate}>
              设为当前
            </button>
          )}
        </div>
        <div className="template-actions">
          <button type="button" disabled={busy || !canUseFiles} onClick={props.onReimport}>重新导入</button>
          <button type="button" disabled={busy || !canUseFiles} onClick={props.onExport}>导出 Excel</button>
          <button type="button" disabled={busy} onClick={props.onRename}>重命名</button>
          <button type="button" className="danger" disabled={busy} onClick={props.onDelete}>删除</button>
        </div>
      </div>
      <div className="template-detail-body">
        <p className="resume-panel-note">
          {active
            ? "插件填写时优先用这份模板里的字段，模板里没有的再用「我的信息」补上。"
            : "这份模板不是当前模板，插件填写时不会用它；需要时点「设为当前」。"}
        </p>
        {!preview ? (
          <p className="muted">正在读取字段…</p>
        ) : "error" in preview ? (
          <div className="template-preview-error">
            <p className="note error">{preview.error}</p>
            <button type="button" onClick={props.onRetryPreview}>重试</button>
          </div>
        ) : preview.view.groups.length === 0 ? (
          <p className="muted">这份模板还没有字段。</p>
        ) : (
          <div className="template-preview">
            {preview.view.groups.map((group, groupIndex) => (
              <section key={`${group.name}-${groupIndex}`}>
                <div className="template-group-head">
                  <h3>{group.name}</h3>
                  <span className="muted">{group.fields.length} 个字段</span>
                </div>
                <dl>
                  {group.fields.map((field, index) => (
                    <div key={`${field.key}-${index}`} className={isWideValue(field.value) ? "is-wide" : undefined}>
                      <dt>{field.key}</dt>
                      <dd>{field.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
