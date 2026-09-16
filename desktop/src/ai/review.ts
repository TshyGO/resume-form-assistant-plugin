// 审核面板的纯逻辑：草稿怎么变、按钮什么时候能按、确认时提交什么、错误怎么说。
//
// 这里不碰 DOM 也不发命令，所以能用 `node --test` 跑。组件只负责画出来。

import type { AiSuggestion, ReplyClass, SendMode, Stage, SuggestedTodoView } from "../api.ts";

/** 面板当前在哪一步。 */
export type Phase = "idle" | "preview" | "sending" | "review" | "failed";

/**
 * 一次最多送几条候选。和 `ai-extract` 的 `MAX_CANDIDATES` 是同一个数：
 * 后端超了会直接报 VALIDATION，界面提前拦住，省得白跑一趟。
 */
export const MAX_CANDIDATES = 8;

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt]\d{2}:\d{2}:\d{2}([.,]\d+)?([Zz]|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 2026-02-31 这种日历上不存在的日子，正则拦不住，得真的算一遍。 */
function realDate(year: string, month: string, day: string): boolean {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

function validInstant(value: string): boolean {
  const match = RFC3339.exec(value);
  return !!match && realDate(match[1]!, match[2]!, match[3]!) && !Number.isNaN(Date.parse(value));
}

function validDate(value: string): boolean {
  const match = DATE_ONLY.exec(value);
  return !!match && realDate(match[1]!, match[2]!, match[3]!);
}

/** 时区得是 IANA 名字。填错了后端登记提醒时才会发现，那时候确认已经写进去了。 */
export function validTimeZone(name: string): boolean {
  if (name.trim() === "") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name.trim() });
    return true;
  } catch {
    return false;
  }
}

/** 轮次只能是 1–99 的整数。`Number("2.5")` 和 `Number("1e3")` 都得拦住。 */
export function validRound(round: number | null): boolean {
  return round === null || (Number.isInteger(round) && round >= 1 && round <= 99);
}

export interface TodoDraft {
  title: string;
  duePrecision: "datetime" | "date" | "none";
  dueAtUtc: string;
  dueDate: string;
  timeZone: string;
  interviewRound: number | null;
  /** 不勾就不转正。用户嫌这条待办没用，不必逼他先删。 */
  keep: boolean;
}

export interface Draft {
  applicationId: string;
  replyClass: ReplyClass;
  sendMode: SendMode;
  stage: Stage | "";
  round: number | null;
  /** 「同时更新申请进度」。默认不勾：导入一封旧通知不该把当前进度改掉。 */
  updateProgress: boolean;
  todos: TodoDraft[];
}

function todoDraft(todo: SuggestedTodoView): TodoDraft {
  return {
    title: todo.title,
    duePrecision: todo.duePrecision,
    dueAtUtc: todo.dueAtUtc ?? "",
    dueDate: todo.dueDate ?? "",
    timeZone: todo.timeZone ?? "",
    interviewRound: todo.interviewRound ?? null,
    keep: true,
  };
}

/**
 * 建议 → 草稿。候选只有一条时替用户填上；多于一条留空，**让他自己选**。
 */
export function initialDraft(suggestion: AiSuggestion): Draft {
  const only = suggestion.candidates.length === 1 ? suggestion.candidates[0]! : null;
  return {
    // 唯一那条候选已经不在了、或者这次没读出来，就不替用户填：
    // 填了他还得先发现填错了。
    applicationId: only && !only.missing && !only.unreadable ? only.id : "",
    replyClass: suggestion.replyClass,
    sendMode: suggestion.sendMode,
    stage: suggestion.stage ?? "",
    round: suggestion.round ?? null,
    updateProgress: false,
    todos: suggestion.todos.map(todoDraft),
  };
}

function sameTodo(draft: TodoDraft, todo: SuggestedTodoView) {
  return (
    draft.title === todo.title &&
    draft.duePrecision === todo.duePrecision &&
    draft.dueAtUtc === (todo.dueAtUtc ?? "") &&
    draft.dueDate === (todo.dueDate ?? "") &&
    draft.timeZone === (todo.timeZone ?? "") &&
    draft.interviewRound === (todo.interviewRound ?? null)
  );
}

/** 用户改过没有。改过按钮就变成「改完确认」，存下来的状态也会是 modified_confirmed。 */
export function isModified(draft: Draft, suggestion: AiSuggestion): boolean {
  // 确认到模型没指名的申请上，和改分类一样是人工修正（命令层同一口径）。
  if (draft.applicationId && !suggestion.candidates.some((c) => c.id === draft.applicationId)) {
    return true;
  }
  if (draft.replyClass !== suggestion.replyClass) return true;
  if (draft.sendMode !== suggestion.sendMode) return true;
  if (draft.stage !== (suggestion.stage ?? "")) return true;
  if (draft.round !== (suggestion.round ?? null)) return true;
  const kept = draft.todos.filter((todo) => todo.keep);
  if (kept.length !== suggestion.todos.length) return true;
  return kept.some((todo, index) => !sameTodo(todo, suggestion.todos[index]!));
}

export function confirmLabel(draft: Draft, suggestion: AiSuggestion): string {
  return isModified(draft, suggestion) ? "改完确认" : "确认";
}

/**
 * 能不能按确认。候选多于一条又没选，就不能——这条界面不替用户做主。
 *
 * 剩下的都是「送到后端只会报错」的输入：与其让用户看一句 serde 的错，不如当场说清楚。
 */
export function confirmBlocker(draft: Draft, suggestion: AiSuggestion): string | null {
  if (!draft.applicationId) {
    return suggestion.candidates.length > 1
      ? "这封通知对应哪一条申请还没选。"
      : "先选一条申请再确认。";
  }
  if (suggestion.candidates.some((c) => c.id === draft.applicationId && c.missing)) {
    return "选中的这条申请已经不在了，请换一条。";
  }
  if (!validRound(draft.round)) {
    return "轮次要填 1–99 的整数。";
  }
  for (const todo of draft.todos) {
    if (!todo.keep) continue;
    if (todo.title.trim() === "") {
      return "有一条待办没有标题。";
    }
    if (!validRound(todo.interviewRound)) {
      return "待办的轮次要填 1–99 的整数。";
    }
    if (!validTimeZone(todo.timeZone)) {
      return "待办的时区要填 Asia/Shanghai 这样的时区名。";
    }
    if (todo.duePrecision === "datetime") {
      if (!todo.dueAtUtc.trim()) {
        return "有一条待办说是精确到时刻，却没有时刻。";
      }
      if (!validInstant(todo.dueAtUtc.trim())) {
        return "待办的时刻要写成 2026-09-22T10:00:00+08:00 这样的格式（秒不能省，日期要真实存在）。";
      }
    }
    if (todo.duePrecision === "date") {
      if (!todo.dueDate.trim()) {
        return "有一条待办说是按日期到期，却没有日期。";
      }
      if (!validDate(todo.dueDate.trim())) {
        return "待办的日期要写成 2026-09-22 这样的格式，而且得是真实存在的日子。";
      }
    }
  }
  return null;
}

/** 确认命令的入参。留空的字段一律不发，让后端用它自己的默认。 */
export function confirmArgs(draft: Draft, suggestion: AiSuggestion) {
  const kept = draft.todos.filter((todo) => todo.keep);
  return {
    suggestionId: suggestion.id,
    // 空串和「没选」是两回事：后端把 null 映射成 AI_NEEDS_DISAMBIGUATION，
    // 把 "" 当成一条查不到的申请，报出来的错完全不同。
    applicationId: draft.applicationId === "" ? null : draft.applicationId,
    replyClass: draft.replyClass,
    sendMode: draft.sendMode,
    stage: draft.stage === "" ? null : draft.stage,
    round: draft.round,
    updateProgress: draft.updateProgress,
    createTodos: kept.length > 0,
    todos: kept.map((todo) => ({
      title: todo.title.trim(),
      duePrecision: todo.duePrecision,
      dueAtUtc: todo.duePrecision === "datetime" ? todo.dueAtUtc.trim() : null,
      dueDate: todo.duePrecision === "date" ? todo.dueDate.trim() : null,
      timeZone: todo.timeZone.trim() === "" ? null : todo.timeZone.trim(),
      interviewRound: todo.interviewRound,
    })),
  };
}

/** 正文按原文依据切段，命中的段落 `hit` 为真，组件拿它去高亮。 */
export function highlight(body: string, excerpt: string): Array<{ text: string; hit: boolean }> {
  const needle = excerpt.trim();
  if (!needle || !body.includes(needle)) {
    return [{ text: body, hit: false }];
  }
  const parts: Array<{ text: string; hit: boolean }> = [];
  let rest = body;
  while (true) {
    const at = rest.indexOf(needle);
    if (at < 0) break;
    if (at > 0) parts.push({ text: rest.slice(0, at), hit: false });
    parts.push({ text: needle, hit: true });
    rest = rest.slice(at + needle.length);
  }
  if (rest) parts.push({ text: rest, hit: false });
  return parts;
}

export interface Failure {
  /** 出了什么事。 */
  text: string;
  /** 接下来能做什么。空字符串表示没有别的建议。 */
  next: string;
  /** 这次失败之后还能不能原样再来一次。 */
  retryable: boolean;
  /**
   * 重试指的是哪一步。`analyze` 才给「再试一次」；确认/拒绝失败给的是 `none`——
   * 那个按钮回到的是外发预览，再点发送等于又付一次钱。
   */
  retry?: "analyze" | "none";
}

const MANUAL = "这条证据的手动分类照常可用。";

/**
 * 错误码 → 用户能照着做的一句话。
 *
 * 口径：先说发生了什么，再说接下来能做什么；**任何失败都要提醒手动分类还在**。
 */
export function describeFailure(error: unknown): Failure {
  const detail = error as { code?: string; message?: string } | null;
  const code = detail?.code ?? "UNKNOWN";
  const message = detail?.message ?? "没有更多信息。";
  const http = /^AI_HTTP_(\d{3})$/.exec(code);
  if (http) {
    const status = Number(http[1]);
    // 401/403/404 再点一次必然还是这个结果：不给「再试一次」，给去设置页的指引。
    const authOrAddress = status === 401 || status === 403 || status === 404;
    const next =
      status === 401 || status === 403
        ? "去设置页换一条 Key。"
        : status === 404
          ? "去设置页核对接口地址和模型名。"
          : status === 400
            ? "多半是模型名或接口地址不对，去设置页核对一下。"
            : status === 429
              ? "服务商限流了，过一会儿再试。"
              : "这是服务商那边的错，过一会儿再试。";
    return { text: message, next: `${next}${MANUAL}`, retryable: !authOrAddress };
  }
  switch (code) {
    case "AI_NOT_CONFIGURED":
      return { text: "还没有配置 AI Key。", next: `去设置页填接口地址、模型和 Key。${MANUAL}`, retryable: false };
    case "AI_NEEDS_CANDIDATES":
      return { text: message, next: `先把这条证据关联到某条申请，或者自己选几条候选。${MANUAL}`, retryable: false };
    case "AI_UNSUPPORTED_KIND":
      return { text: message, next: `把正文复制出来，用「粘贴文本」再导入一次。${MANUAL}`, retryable: false };
    case "AI_NO_TEXT":
      return { text: message, next: MANUAL, retryable: false };
    case "AI_TIMEOUT":
      return {
        text: message,
        next: `可以回到预览再发一次，或者换一个更快的模型。${MANUAL}`,
        retryable: true,
      };
    case "AI_NETWORK":
      return {
        text: message,
        next: `检查一下网络或接口地址，回到预览再发一次。${MANUAL}`,
        retryable: true,
      };
    case "AI_BUSY":
      return {
        text: message,
        next: `等它结束，或者先取消正在跑的那一次。${MANUAL}`,
        retryable: false,
      };
    case "AI_CANCELLED":
      return {
        text: "已取消，这次没有产生建议。",
        next: `取消不保证对方停止计算或停止计费。${MANUAL}`,
        retryable: true,
      };
    case "AI_BAD_RESPONSE":
    case "AI_CANDIDATE_OUT_OF_RANGE":
      return { text: message, next: `可以再试一次；老是这样就换一个模型。${MANUAL}`, retryable: true };
    case "AI_NEEDS_DISAMBIGUATION":
      return { text: message, next: `在候选里选一条再确认。${MANUAL}`, retryable: false };
    default:
      return { text: `${message}（${code}）`, next: MANUAL, retryable: true };
  }
}

/** 等待时的一句话。超过慢提示的秒数就换成「还在等」。 */
export function waitingText(elapsedSeconds: number, slowHintSeconds: number): string {
  return elapsedSeconds >= slowHintSeconds
    ? `还在等（已经 ${Math.floor(elapsedSeconds)} 秒）。可以随时取消。`
    : "正在发送…";
}
