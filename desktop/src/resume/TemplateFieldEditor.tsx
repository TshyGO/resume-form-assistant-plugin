import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent, MutableRefObject } from "react";
import type { ProfileRecordView, ResumeTemplateView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { profileApi } from "./profile.ts";
import { ResumeDialog } from "./ResumeDialog.tsx";
import { templateFields } from "./template-fields.ts";
import type { TemplateDraft } from "./template-fields.ts";

const NEW_CATEGORY = "__new__";

type Dialog =
  | { kind: "add"; category: string; newCategory: string; key: string; value: string; error: string | null }
  | { kind: "category"; name: string; error: string | null }
  | { kind: "remove"; id: string }
  | { kind: "discard" }
  | { kind: "conflict"; latest: ResumeTemplateView | null };

type Message = { tone: "error" | "warn"; text: string };

/** 编辑器向外报告的状态：有没有未保存的修改（离开简历页、切换模板前要问）。 */
export interface TemplateEditorProbe {
  dirty(): boolean;
}

async function baseOf(view: ResumeTemplateView): Promise<string> {
  // 旧宿主或测试替身没带 contentSha256 时自己算：两边是同一套规范 JSON（profile-sync.test.ts 锁住）。
  return view.contentSha256 || templateFields.contentSha256(view.groups);
}

function errorCode(error: unknown): string {
  return (error as { code?: string } | null)?.code ?? "";
}

function errorText(error: unknown): string {
  return (error as { message?: string } | null)?.message ?? "保存失败，请重试。";
}

/**
 * 模板字段编辑（#273）：按分类改字段名称、内容、所属分类，添加、删除，保存或取消。
 * 编辑期间只改草稿；保存时整份替换这份模板的字段，并用开始编辑时的内容版本检查，
 * 别处（插件、重新导入）改过就停下来让人选，不静默覆盖。保存失败草稿原样留着。
 */
export function TemplateFieldEditor({
  template,
  latest,
  active,
  probe,
  onSaved,
  onClose,
}: {
  /** 开始编辑时读到的模板。 */
  template: ResumeTemplateView;
  /** 外面最近一次读到的同一份模板（插件保存后会刷新），用来提示「别处改过」。 */
  latest: ResumeTemplateView | null;
  active: boolean;
  probe?: MutableRefObject<TemplateEditorProbe | null>;
  onSaved(view: ResumeTemplateView): void;
  onClose(): void;
}) {
  const invoke = useInvoke();
  const [draft, setDraft] = useState<TemplateDraft>(() => templateFields.createDraft(template));
  const [base, setBase] = useState<string>(template.contentSha256 ?? "");
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [profileFields, setProfileFields] = useState<Array<{ key: string; value: string }>>([]);
  const savingRef = useRef(false);
  const addFormId = useId();
  const categoryFormId = useId();

  const dirty = templateFields.isDirty(draft);
  const check = templateFields.validateDraft(draft);
  const summary = templateFields.summarizeChanges(draft);
  const changes = templateFields.describeChanges(summary);
  const fallbacks = useMemo(
    () => templateFields.profileFallbacks(draft, profileFields, profileApi.normalizeKey),
    [draft, profileFields],
  );

  useEffect(() => {
    if (!template.contentSha256) void baseOf(template).then(setBase);
  }, [template]);

  // 「我的信息」只用来提示：删掉的模板字段在那里还有同名内容时，填写仍可能用到它。
  useEffect(() => {
    if (!invoke) return;
    let cancelled = false;
    invoke<ProfileRecordView>("get_profile_cmd").then(
      (record) => {
        if (!cancelled) setProfileFields(profileApi.profileToResumeFields(record.profile));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [invoke]);

  useEffect(() => {
    if (!probe) return undefined;
    probe.current = { dirty: () => templateFields.isDirty(draft) };
    return () => {
      probe.current = null;
    };
  }, [probe, draft]);

  // 外面读到的版本变了（插件刚保存过、重新导入了）：草稿不动，先说出来。
  useEffect(() => {
    if (!latest || latest.id !== template.id || savingRef.current) return;
    let cancelled = false;
    void baseOf(latest).then((sha) => {
      if (!cancelled && base) setRemoteChanged(sha !== base);
    });
    return () => {
      cancelled = true;
    };
  }, [latest, template.id, base]);

  const inProfile = (key: string) => {
    const wanted = profileApi.normalizeKey(key);
    return Boolean(wanted) && profileFields.some((field) => profileApi.normalizeKey(field.key) === wanted && field.value);
  };

  const update = (next: TemplateDraft) => {
    setDraft(next);
    setMessage(null);
  };

  const loadLatest = (view: ResumeTemplateView) => {
    setDraft(templateFields.createDraft(view));
    void baseOf(view).then(setBase);
    setRemoteChanged(false);
    setShowErrors(false);
    setMessage(null);
    setDialog(null);
  };

  const fetchLatest = async (): Promise<ResumeTemplateView | null> => {
    if (!invoke) return null;
    try {
      return await invoke<ResumeTemplateView>("get_resume_template_cmd", { id: template.id });
    } catch {
      return null;
    }
  };

  const save = async (againstBase = base) => {
    if (!invoke || savingRef.current) return;
    if (!check.ok) {
      setShowErrors(true);
      setMessage({ tone: "error", text: check.problems[0] ?? "有字段需要修改，见标红的输入框。" });
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const saved = await invoke<ResumeTemplateView>("save_resume_template_fields_cmd", {
        id: template.id,
        groups: templateFields.toGroups(draft),
        baseSha256: againstBase,
      });
      setDialog(null);
      onSaved(saved);
    } catch (error) {
      const code = errorCode(error);
      if (code === "CONFLICT" || code === "NOT_FOUND") {
        setDialog({ kind: "conflict", latest: code === "NOT_FOUND" ? null : await fetchLatest() });
      } else {
        setDialog(null);
        setMessage({ tone: "error", text: `${errorText(error)} 修改还在，可以改好后再保存。` });
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (saving) return;
    if (dirty) setDialog({ kind: "discard" });
    else onClose();
  };

  const submitAdd = (event: FormEvent) => {
    event.preventDefault();
    if (dialog?.kind !== "add") return;
    let next = draft;
    let category = dialog.category;
    if (category === NEW_CATEGORY) {
      const created = templateFields.addCategory(next, dialog.newCategory);
      if (created.error || !created.category) {
        setDialog({ ...dialog, error: created.error ?? "分类名称不能为空。" });
        return;
      }
      next = created.draft;
      category = created.category;
    }
    if (!dialog.key.trim()) {
      setDialog({ ...dialog, error: "字段名称不能为空。" });
      return;
    }
    update(templateFields.addField(next, { category, key: dialog.key, value: dialog.value }).draft);
    setDialog(null);
  };

  const submitCategory = (event: FormEvent) => {
    event.preventDefault();
    if (dialog?.kind !== "category") return;
    const created = templateFields.addCategory(draft, dialog.name);
    if (created.error) {
      setDialog({ ...dialog, error: created.error });
      return;
    }
    update(created.draft);
    setDialog(null);
  };

  const removing = dialog?.kind === "remove" ? draft.fields.find((field) => field.id === dialog.id) : undefined;
  const fieldCount = draft.fields.length;
  const footText = message?.text
    ?? (dirty ? `修改尚未保存（${changes}）；插件仍使用上次保存的内容。` : "还没有修改。");

  return (
    // 不用 <form> 包整块：下面的弹窗里各有自己的表单，表单不能嵌套。
    <div className="template-edit-form">
      <div className="template-detail-head">
        <div className="template-detail-title">
          <div>
            <p className="resume-kicker">编辑字段</p>
            <h2>{draft.templateName}</h2>
            <span className="muted">正在编辑这份模板 · {fieldCount} 个字段</span>
          </div>
          {active ? <span className="template-use-badge">填写时优先使用</span> : null}
        </div>
        <div className="template-actions">
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              setDialog({ kind: "add", category: draft.categories[0] ?? NEW_CATEGORY, newCategory: "", key: "", value: "", error: null })
            }
          >
            添加字段
          </button>
          <button type="button" disabled={saving} onClick={() => setDialog({ kind: "category", name: "", error: null })}>
            新建分类
          </button>
        </div>
      </div>
      <div className="template-detail-body">
        {remoteChanged ? (
          <div className="note warn template-edit-alert" role="status">
            <span>这份模板刚在别处（例如插件侧边栏）更新过。你的修改还在；保存时会请你选择如何处理。</span>
            {latest ? (
              <button type="button" className="linkish" onClick={() => setDialog({ kind: "conflict", latest })}>
                查看处理方式
              </button>
            ) : null}
          </div>
        ) : null}
        <p className="resume-panel-note">
          修改只作用于「{draft.templateName}」，点「保存修改」后才生效；不会改动其他模板或「我的信息」。一键填写时先用模板字段，模板里没有的字段名再用「我的信息」的补充字段补上；同名字段以模板为准，空内容和像密码、验证码的内容不参与填写。
        </p>
        {fallbacks.length ? (
          <p className="note warn template-edit-fallback" role="status">
            已删除或改名的 {fallbacks.map((key) => `「${key}」`).join("、")} 在「我的信息」里仍有同名内容，一键填写时仍可能使用。要彻底停用，请到「我的信息」里修改。
          </p>
        ) : null}
        <div className="template-preview template-edit-groups">
          {draft.categories.map((category) => {
            const rows = draft.fields.filter((field) => field.category === category);
            return (
              <section key={category} aria-label={`分类：${category}`}>
                <div className="template-group-head">
                  <h3>{category}</h3>
                  <span className="muted">{rows.length} 个字段</span>
                </div>
                <div className="template-edit-list">
                  {rows.length ? (
                    <div className="template-edit-head" aria-hidden="true">
                      <span>字段名称</span>
                      <span>内容</span>
                      <span>所属分类</span>
                      <span />
                    </div>
                  ) : (
                    <p className="muted template-edit-empty">这个分类还没有字段，没有字段的分类不会保存。</p>
                  )}
                  {rows.map((field) => {
                    const error = showErrors ? check.fieldErrors[field.id] : undefined;
                    const label = field.key.trim() || "未命名字段";
                    return (
                      <div key={field.id} role="group" aria-label={label} className="template-edit-row">
                        <label>
                          <span className="sr-only">字段名称</span>
                          <input
                            value={field.key}
                            aria-invalid={error ? true : undefined}
                            onChange={(event) => update(templateFields.updateField(draft, field.id, { key: event.target.value }))}
                          />
                        </label>
                        <label>
                          <span className="sr-only">内容</span>
                          <textarea
                            rows={Math.min(6, Math.max(1, field.value.split("\n").length))}
                            value={field.value}
                            onChange={(event) => update(templateFields.updateField(draft, field.id, { value: event.target.value }))}
                          />
                        </label>
                        <label>
                          <span className="sr-only">所属分类</span>
                          <select
                            value={field.category}
                            onChange={(event) => update(templateFields.updateField(draft, field.id, { category: event.target.value }))}
                          >
                            {draft.categories.map((name) => (
                              <option key={name} value={name}>{name}</option>
                            ))}
                          </select>
                        </label>
                        <button type="button" className="danger" aria-label={`删除「${label}」`} onClick={() => setDialog({ kind: "remove", id: field.id })}>
                          删除
                        </button>
                        {error ? <p className="note error template-edit-error">{error}</p> : null}
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="linkish template-edit-add"
                  disabled={saving}
                  onClick={() => update(templateFields.addField(draft, { category }).draft)}
                >
                  在「{category}」添加字段
                </button>
              </section>
            );
          })}
        </div>
        {check.warnings.length ? <p className="resume-hint warn">{check.warnings.join(" ")}</p> : null}
      </div>
      <div className="profile-form-foot">
        <p className={message ? `note ${message.tone}` : "muted"} role="status">{footText}</p>
        <div className="profile-form-actions">
          <button type="button" disabled={saving} onClick={requestClose}>取消</button>
          <button type="button" className="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "正在保存…" : "保存修改"}
          </button>
        </div>
      </div>

      <ResumeDialog
        open={dialog?.kind === "add"}
        title={`添加字段到「${draft.templateName}」`}
        onCancel={() => setDialog(null)}
        footer={
          <>
            <button type="button" onClick={() => setDialog(null)}>取消</button>
            <button type="submit" form={addFormId} className="primary">添加到草稿</button>
          </>
        }
      >
        {dialog?.kind === "add" ? (
          <form id={addFormId} className="resume-dialog-form" onSubmit={submitAdd} noValidate>
            <label>
              所属分类
              <select value={dialog.category} onChange={(event) => setDialog({ ...dialog, category: event.target.value, error: null })}>
                {draft.categories.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
                <option value={NEW_CATEGORY}>＋ 新建分类…</option>
              </select>
            </label>
            {dialog.category === NEW_CATEGORY ? (
              <label>
                新分类名称
                <input value={dialog.newCategory} onChange={(event) => setDialog({ ...dialog, newCategory: event.target.value, error: null })} />
              </label>
            ) : null}
            <label>
              字段名称
              <input data-autofocus value={dialog.key} onChange={(event) => setDialog({ ...dialog, key: event.target.value, error: null })} />
            </label>
            <label>
              内容
              <textarea rows={3} value={dialog.value} onChange={(event) => setDialog({ ...dialog, value: event.target.value })} />
            </label>
            <p className="resume-hint">添加后在草稿里显示，点「保存修改」才写入模板。</p>
            {dialog.error ? <p className="note error" role="alert">{dialog.error}</p> : null}
          </form>
        ) : null}
      </ResumeDialog>

      <ResumeDialog
        open={dialog?.kind === "category"}
        title="新建分类"
        onCancel={() => setDialog(null)}
        footer={
          <>
            <button type="button" onClick={() => setDialog(null)}>取消</button>
            <button type="submit" form={categoryFormId} className="primary">新建分类</button>
          </>
        }
      >
        {dialog?.kind === "category" ? (
          <form id={categoryFormId} className="resume-dialog-form" onSubmit={submitCategory} noValidate>
            <label>
              分类名称
              <input data-autofocus value={dialog.name} onChange={(event) => setDialog({ ...dialog, name: event.target.value, error: null })} />
            </label>
            <p className="resume-hint">新分类出现在列表末尾；没有字段的分类不会保存。</p>
            {dialog.error ? <p className="note error" role="alert">{dialog.error}</p> : null}
          </form>
        ) : null}
      </ResumeDialog>

      <ResumeDialog
        open={dialog?.kind === "remove"}
        tone="danger"
        title={removing ? `删除「${removing.key.trim() || "未命名字段"}」？` : "删除字段？"}
        onCancel={() => setDialog(null)}
        footer={
          <>
            <button type="button" data-autofocus onClick={() => setDialog(null)}>保留</button>
            <button
              type="button"
              className="danger-solid"
              onClick={() => {
                if (removing) update(templateFields.removeField(draft, removing.id));
                setDialog(null);
              }}
            >
              从草稿中删除
            </button>
          </>
        }
      >
        {removing ? (
          <>
            <p>只从「{draft.templateName}」删除这个字段，点「保存修改」后生效；其他模板和「我的信息」不受影响。</p>
            {inProfile(removing.key) ? (
              <p className="note warn">「我的信息」里还有同名字段，一键填写时仍可能用它。删除模板字段不会删除「我的信息」。</p>
            ) : null}
          </>
        ) : null}
      </ResumeDialog>

      <ResumeDialog
        open={dialog?.kind === "discard"}
        tone="warn"
        title={`放弃对「${draft.templateName}」的修改？`}
        onCancel={() => setDialog(null)}
        footer={
          <>
            <button type="button" data-autofocus onClick={() => setDialog(null)}>继续编辑</button>
            <button type="button" className="danger" onClick={onClose}>放弃修改</button>
          </>
        }
      >
        <p>还没有保存的修改（{changes || "无"}）会丢失，模板保持上次保存的内容。</p>
      </ResumeDialog>

      <ResumeDialog
        open={dialog?.kind === "conflict"}
        tone="warn"
        title={dialog?.kind === "conflict" && !dialog.latest ? "这份模板已被删除" : "这份模板已在别处修改"}
        onCancel={() => setDialog(null)}
        cancelDisabled={saving}
        footer={
          dialog?.kind === "conflict" && dialog.latest ? (
            <>
              <button type="button" data-autofocus disabled={saving} onClick={() => setDialog(null)}>继续编辑</button>
              <button type="button" disabled={saving} onClick={() => dialog.latest && loadLatest(dialog.latest)}>
                放弃我的修改，载入最新内容
              </button>
              <button
                type="button"
                className="danger"
                disabled={saving}
                onClick={() => {
                  const target = dialog.latest;
                  if (target) void baseOf(target).then((sha) => save(sha));
                }}
              >
                用我的修改覆盖
              </button>
            </>
          ) : (
            <>
              <button type="button" data-autofocus onClick={() => setDialog(null)}>继续查看</button>
              <button type="button" className="danger" onClick={onClose}>关闭编辑</button>
            </>
          )
        }
      >
        {dialog?.kind === "conflict" && dialog.latest ? (
          <>
            <p>开始编辑之后，这份模板在别处（例如插件侧边栏，或重新导入）被修改过。为避免覆盖，这次没有保存，你的修改还在。</p>
            <p className="resume-dialog-fact">
              最新内容：{templateFields.toGroups(templateFields.createDraft(dialog.latest)).reduce((sum, group) => sum + group.fields.length, 0)} 个字段 · 你的草稿：{fieldCount} 个字段
            </p>
            <p className="muted">「用我的修改覆盖」会以你的草稿替换最新内容；「载入最新内容」会丢掉你的修改。</p>
          </>
        ) : (
          <p>这份模板已在别处删除，修改无法保存。关闭编辑后修改会丢失；需要的话先复制要保留的内容。</p>
        )}
      </ResumeDialog>
    </div>
  );
}
