import { useState } from "react";
import type { ReactNode } from "react";
import type { AiSuggestion, ApplicationSummary, ReplyClass, SendMode, Stage } from "../api.ts";
import { REPLY_CLASS_OPTIONS, SEND_MODE_OPTIONS } from "../inbox.ts";
import { stageLabel } from "../applications.ts";
import { ResumeDialog } from "../resume/ResumeDialog.tsx";
import { confirmBlocker, confirmLabel, highlight, isModified, STAGES } from "./review.ts";
import type { Draft, TodoDraft } from "./review.ts";

/** 能从一封通知里推出来的阶段。投递、填写是用户自己的动作，这里不给选。 */
const STAGE_OPTIONS: Array<{ value: Stage | ""; label: string }> = [
  { value: "", label: "不记阶段" },
  { value: "assessment", label: "测评" },
  { value: "interview", label: "面试" },
  { value: "offer", label: "Offer" },
  { value: "rejected", label: "未通过" },
  { value: "closed", label: "已结束" },
];

function Excerpts({ body, excerpts }: { body: string; excerpts: string[] }) {
  if (!excerpts.length) {
    return <p className="muted">这条建议没有给出原文依据。</p>;
  }
  return (
    <ul className="ai-excerpts">
      {excerpts.map((excerpt, index) => (
        <li key={index}>
          <details>
            <summary>{excerpt}</summary>
            {body.includes(excerpt.trim()) ? null : (
              <p className="note warn">这句话在证据原文里找不到原样的句子，别把它当作依据。</p>
            )}
            <pre className="evidence-body">
              {highlight(body, excerpt).map((part, index) =>
                part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
              )}
            </pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

function TodoRow({
  todo,
  index,
  onChange,
}: {
  todo: TodoDraft;
  index: number;
  onChange: (next: TodoDraft) => void;
}) {
  return (
    <li className={`ai-todo${todo.keep ? "" : " is-skipped"}`}>
      <label className="ai-check">
        <input
          type="checkbox"
          checked={todo.keep}
          onChange={(event) => onChange({ ...todo, keep: event.target.checked })}
        />
        转成待办
      </label>
      <label>
        标题
        <input
          aria-label={`待办 ${index + 1} 标题`}
          value={todo.title}
          onChange={(event) => onChange({ ...todo, title: event.target.value })}
        />
      </label>
      <div className="ai-field-grid">
        <label>
          到期
          <select
            aria-label={`待办 ${index + 1} 到期方式`}
            value={todo.duePrecision}
            onChange={(event) =>
              onChange({ ...todo, duePrecision: event.target.value as TodoDraft["duePrecision"] })
            }
          >
            <option value="datetime">精确到时刻</option>
            <option value="date">只有日期</option>
            <option value="none">没有到期</option>
          </select>
        </label>
        {todo.duePrecision === "datetime" ? (
          <label>
            时刻（可带时区偏移）
            <input
              aria-label={`待办 ${index + 1} 时刻`}
              value={todo.dueAtUtc}
              onChange={(event) => onChange({ ...todo, dueAtUtc: event.target.value })}
            />
          </label>
        ) : null}
        {todo.duePrecision === "date" ? (
          <label>
            日期
            <input
              aria-label={`待办 ${index + 1} 日期`}
              value={todo.dueDate}
              onChange={(event) => onChange({ ...todo, dueDate: event.target.value })}
            />
          </label>
        ) : null}
        <label>
          轮次
          <input
            aria-label={`待办 ${index + 1} 轮次`}
            value={todo.interviewRound ?? ""}
            onChange={(event) => {
              const value = Number(event.target.value);
              onChange({
                ...todo,
                interviewRound:
                  event.target.value.trim() === "" || Number.isNaN(value) ? null : value,
              });
            }}
          />
        </label>
        <label>
          时区
          <input
            aria-label={`待办 ${index + 1} 时区`}
            value={todo.timeZone}
            placeholder="Asia/Shanghai"
            onChange={(event) => onChange({ ...todo, timeZone: event.target.value })}
          />
        </label>
      </div>
    </li>
  );
}

/**
 * 审核面板（#262 起是一个宽弹窗）。**这里改的全是草稿**：不按确认，档案里什么都不会变。
 */
export function ReviewPanel({
  suggestion,
  applications,
  body,
  draft,
  busy,
  alreadyConfirmed,
  onDraftChange,
  onConfirm,
  onReject,
  onDefer,
  onClose,
  extra,
}: {
  suggestion: AiSuggestion;
  /** 模型一条都没指认时的兜底清单：让用户自己从在办申请里挑。 */
  applications: ApplicationSummary[];
  body: string;
  draft: Draft;
  busy: boolean;
  /** 这条证据已经按另一条建议确认过了。再确认一次只会被命令层拒绝。 */
  alreadyConfirmed: boolean;
  onDraftChange: (next: Draft) => void;
  onConfirm: () => void;
  onReject: () => void;
  onDefer: () => void;
  /** 先不决定、关掉弹窗。建议保持原状态，之后还能从「打开待确认的建议」回来。 */
  onClose?: () => void;
  /** 弹窗里就近显示的错误与提示（确认失败之类），由宿主给。 */
  extra?: ReactNode;
}) {
  const [showScope, setShowScope] = useState(false);
  const blocker = alreadyConfirmed
    ? "这条通知已经按另一条建议确认过了。要改结论就直接改申请里的记录。"
    : confirmBlocker(draft, suggestion);
  // 候选之外永远还能挑别的申请：模型可能一条都没指认（它宁可空着也不猜）、
  // 可能指认错了、也可能指认的那条已经被删了。只给候选会让这些情况没法收场。
  const extraChoices = applications
    .filter((application) => !suggestion.candidates.some((c) => c.id === application.id))
    .map((application) => ({
      id: application.id,
      company: application.company,
      title: application.title,
      stage: application.current_stage ?? "",
      missing: false,
    }));
  const choices = [...suggestion.candidates, ...extraChoices];
  // 模型给了这五个之外的阶段时，草稿里已经回落成「不记阶段」；这里说一声，
  // 免得用户以为是自己没选。
  const unusableStage = suggestion.stage && !STAGES.includes(suggestion.stage as never);
  const patch = (next: Partial<Draft>) => onDraftChange({ ...draft, ...next });
  const modified = isModified(draft, suggestion);

  return (
    <ResumeDialog
      open
      wide
      className="ai-dialog ai-review-dialog"
      title="核对 AI 建议"
      onCancel={() => onClose?.()}
      cancelDisabled={busy || !onClose}
      footer={
        <>
          {blocker ? <p className="dialog-foot-note warn">{blocker}</p> : null}
          {modified && !blocker ? (
            <p className="dialog-foot-note">改过的地方会记成「修改后确认」，模型原本说的什么也留着。</p>
          ) : null}
          {onClose ? (
            <button type="button" className="dialog-foot-start" onClick={onClose} disabled={busy}>
              稍后再看
            </button>
          ) : null}
          <button type="button" onClick={onDefer} disabled={busy}>
            暂存
          </button>
          <button type="button" className="danger" onClick={onReject} disabled={busy}>
            拒绝
          </button>
          <button type="button" className="primary" onClick={onConfirm} disabled={busy || blocker !== null}>
            {confirmLabel(draft, suggestion)}
          </button>
        </>
      }
    >
      <div className="ai-review">
        <p className="dialog-intro">
          下面每一项都可以改。按确认之前，这条通知的分类、申请的阶段和待办都不会变。
        </p>
        <p className="ai-model-line">
          模型 {suggestion.modelLabel ?? "未知"} · 生成于 {suggestion.createdAt.slice(0, 16).replace("T", " ")} UTC ·{" "}
          <button type="button" className="linkish" onClick={() => setShowScope((on) => !on)}>
            {showScope ? "收起这次发出去的范围" : "看看这次发出去了什么"}
          </button>
        </p>
        {showScope ? (
          <p className="ai-scope">
            {suggestion.promptScope ?? "没有记录"}
            {suggestion.modelLabel ? ` · 模型 ${suggestion.modelLabel}` : ""}
          </p>
        ) : null}

        <section className="ai-review-section">
          <h3>对应哪一条申请</h3>
          {suggestion.candidates.length > 1 ? (
            <p className="note warn">同一家公司有多条申请，模型没能唯一指认。请自己选一条。</p>
          ) : null}
          {suggestion.candidates.length === 0 ? (
            <p className="note warn">模型认不出这封信是哪一条申请（它宁可空着也不猜）。请自己选一条。</p>
          ) : null}
          <label>
            申请
            <select
              value={draft.applicationId}
              onChange={(event) => patch({ applicationId: event.target.value })}
              data-autofocus
            >
              <option value="">请选择…</option>
              {choices.map((candidate) => (
                <option key={candidate.id} value={candidate.id} disabled={candidate.missing}>
                  {candidate.company}
                  {candidate.title ? ` · ${candidate.title}` : ""}
                  {candidate.stage ? `（${stageLabel(candidate.stage)}）` : ""}
                </option>
              ))}
            </select>
          </label>
          <p className="field-hint">下拉里前几条是模型给的候选，后面是其余申请——它指错了也能改。</p>
        </section>

        <section className="ai-review-section">
          <h3>分类</h3>
          <div className="ai-field-grid">
            <label>
              通知类型
              <select
                value={draft.replyClass}
                onChange={(event) => patch({ replyClass: event.target.value as ReplyClass })}
              >
                {REPLY_CLASS_OPTIONS.filter((option) => option.value !== "").map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              发送方式
              <select
                value={draft.sendMode}
                onChange={(event) => patch({ sendMode: event.target.value as SendMode })}
              >
                {SEND_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="ai-review-section">
          <h3>阶段建议</h3>
          {unusableStage ? (
            <p className="note warn">
              模型给的阶段（{stageLabel(suggestion.stage!)}）不能从一封通知里推出来，已经忽略。
              需要记阶段就自己选一个。
            </p>
          ) : null}
          <div className="ai-field-grid">
            <label>
              阶段
              <select
                value={draft.stage}
                onChange={(event) => patch({ stage: event.target.value as Stage | "" })}
              >
                {STAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              面试轮次
              <input
                aria-label="轮次"
                inputMode="numeric"
                value={draft.round ?? ""}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  patch({ round: event.target.value.trim() === "" || Number.isNaN(value) ? null : value });
                }}
              />
            </label>
          </div>
          <label className="ai-check">
            <input
              type="checkbox"
              checked={draft.updateProgress}
              onChange={(event) => patch({ updateProgress: event.target.checked })}
            />
            同时更新申请进度
          </label>
          <p className="field-hint">不勾就只记进时间线，当前进度不动——补录旧通知时要的就是这个。</p>
        </section>

        {draft.todos.length ? (
          <section className="ai-review-section">
            <h3>待办草稿</h3>
            <p className="field-hint">时刻写成带时区偏移的格式，例如 2026-10-11T14:30:00+08:00。</p>
            <ul className="ai-todos">
              {draft.todos.map((todo, index) => (
                <TodoRow
                  key={index}
                  todo={todo}
                  index={index}
                  onChange={(next) =>
                    patch({ todos: draft.todos.map((item, at) => (at === index ? next : item)) })
                  }
                />
              ))}
            </ul>
          </section>
        ) : null}

        {suggestion.uncertainties.length ? (
          <section className="ai-review-section">
            <h3>模型自己也不确定的地方</h3>
            <ul className="ai-uncertainties">
              {suggestion.uncertainties.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="ai-review-section">
          <h3>原文依据</h3>
          <Excerpts body={body} excerpts={suggestion.excerpts} />
        </section>

        {modified ? (
          <p className="note warn">暂存只存这条建议本身，不存你刚改的这些；下次打开还是模型原来那份。</p>
        ) : (
          <p className="field-hint">暂存会保存模型的这份建议，下次打开这条通知还能接着看。</p>
        )}
        {extra}
      </div>
    </ResumeDialog>
  );
}
