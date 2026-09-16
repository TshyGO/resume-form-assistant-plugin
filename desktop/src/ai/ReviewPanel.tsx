import { useState } from "react";
import type { AiSuggestion, ApplicationSummary, ReplyClass, SendMode, Stage } from "../api.ts";
import { REPLY_CLASS_OPTIONS, SEND_MODE_OPTIONS } from "../inbox.ts";
import { stageLabel } from "../applications.ts";
import { confirmBlocker, confirmLabel, highlight, isModified } from "./review.ts";
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
    <li className="stack">
      <label>
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
      <div className="row">
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
            时刻（UTC）
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
 * 审核面板。**这里改的全是草稿**：不按确认，档案里什么都不会变。
 */
export function ReviewPanel({
  suggestion,
  applications,
  body,
  draft,
  busy,
  onDraftChange,
  onConfirm,
  onReject,
  onDefer,
}: {
  suggestion: AiSuggestion;
  /** 模型一条都没指认时的兜底清单：让用户自己从在办申请里挑。 */
  applications: ApplicationSummary[];
  body: string;
  draft: Draft;
  busy: boolean;
  onDraftChange: (next: Draft) => void;
  onConfirm: () => void;
  onReject: () => void;
  onDefer: () => void;
}) {
  const [showScope, setShowScope] = useState(false);
  const blocker = confirmBlocker(draft, suggestion);
  // 候选之外永远还能挑别的申请：模型可能一条都没指认（它宁可空着也不猜）、
  // 可能指认错了、也可能指认的那条已经被删了。只给候选会让这些情况没法收场。
  const extra = applications
    .filter((application) => !suggestion.candidates.some((c) => c.id === application.id))
    .map((application) => ({
      id: application.id,
      company: application.company,
      title: application.title,
      stage: application.current_stage ?? "",
      missing: false,
    }));
  const choices = [...suggestion.candidates, ...extra];
  // 建议里的阶段理论上只会是上面那五个，真出了别的也得显示出来，
  // 不能让下拉框空着让人以为「不记阶段」。
  const stageOptions = STAGE_OPTIONS.some((option) => option.value === draft.stage)
    ? STAGE_OPTIONS
    : [...STAGE_OPTIONS, { value: draft.stage, label: `${draft.stage}（模型给的）` }];
  const patch = (next: Partial<Draft>) => onDraftChange({ ...draft, ...next });

  return (
    <div className="stack ai-review">
      <h4>AI 建议（还没生效）</h4>
      <p className="muted">
        下面每一项都可以改。按确认之前，这条证据的分类、申请的阶段和待办都不会变。
      </p>

      <h5>对应哪一条申请</h5>
      {suggestion.candidates.length > 1 ? (
        <p className="note warn">同一家公司有多条申请，模型没能唯一指认。请自己选一条。</p>
      ) : null}
      {suggestion.candidates.length === 0 ? (
        <p className="note warn">模型认不出这封信是哪一条申请（它宁可空着也不猜）。请自己选一条。</p>
      ) : null}
      <p className="muted">下拉里前几条是模型给的候选，后面是其余申请——它指错了也能改。</p>
      <label>
        申请
        <select
          value={draft.applicationId}
          onChange={(event) => patch({ applicationId: event.target.value })}
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

      <h5>分类</h5>
      <div className="row">
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

      <h5>进度</h5>
      <div className="row">
        <label>
          阶段
          <select
            value={draft.stage}
            onChange={(event) => patch({ stage: event.target.value as Stage | "" })}
          >
            {stageOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          轮次
          <input
            aria-label="轮次"
            value={draft.round ?? ""}
            onChange={(event) => {
              const value = Number(event.target.value);
              patch({ round: event.target.value.trim() === "" || Number.isNaN(value) ? null : value });
            }}
          />
        </label>
      </div>
      <label>
        <input
          type="checkbox"
          checked={draft.updateProgress}
          onChange={(event) => patch({ updateProgress: event.target.checked })}
        />
        同时更新申请进度
      </label>
      <p className="muted">不勾就只记进时间线，当前进度不动——补录旧通知时要的就是这个。</p>

      {draft.todos.length ? (
        <>
          <h5>待办</h5>
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
        </>
      ) : null}

      {suggestion.uncertainties.length ? (
        <>
          <h5>模型自己也不确定的地方</h5>
          <ul className="ai-uncertainties">
            {suggestion.uncertainties.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}

      <h5>原文依据</h5>
      <Excerpts body={body} excerpts={suggestion.excerpts} />

      <p className="muted">
        <button type="button" className="linkish" onClick={() => setShowScope((on) => !on)}>
          {showScope ? "收起这次发出去的范围" : "看看这次发出去了什么"}
        </button>
      </p>
      {showScope ? (
        <p className="muted">
          {suggestion.promptScope ?? "没有记录"}
          {suggestion.modelLabel ? ` · 模型 ${suggestion.modelLabel}` : ""}
        </p>
      ) : null}

      {blocker ? <p className="note warn">{blocker}</p> : null}
      <div className="row">
        <button type="button" onClick={onConfirm} disabled={busy || blocker !== null}>
          {confirmLabel(draft, suggestion)}
        </button>
        <button type="button" onClick={onReject} disabled={busy}>
          拒绝
        </button>
        <button type="button" onClick={onDefer} disabled={busy}>
          暂存
        </button>
      </div>
      {isModified(draft, suggestion) ? (
        <>
          <p className="muted">改过的地方会记成「修改后确认」，模型原本说的什么也留着。</p>
          <p className="note warn">暂存只存这条建议本身，不存你刚改的这些；下次打开还是模型原来那份。</p>
        </>
      ) : null}
    </div>
  );
}
