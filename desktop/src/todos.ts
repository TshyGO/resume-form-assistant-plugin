// D10 待办的文案与纯函数。界面只负责拼 DOM，说什么由这里决定。
//
// 两件事在这里守着：
//
// 1. **只有日历日的待办不许显示成 00:00。**「9 月 20 日截止」和「9 月 20 日
//    00:00 截止」是两句不同的话，后者是我们编的。
// 2. **提醒会不会响，界面必须说得出。** 产品需求 §5.4 列了五种状态，五种都要
//    有一句自己的话，不能用一句「已设置提醒」糊过去。

import type { ReminderCapability, TodoStatus, TodoView } from "./api.ts";

export interface Message {
  tone: "info" | "success" | "warn" | "pending";
  text: string;
}

export const EMPTY_TODOS =
  "还没有待办。可以在申请详情里给它加一条，比如测评截止或者面试时间。";

/** 分组。顺序就是显示顺序：先看已经误了的，再看今天。 */
export type Bucket = "overdue" | "today" | "week" | "later" | "someday" | "closed";

export const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: "已逾期",
  today: "今天",
  week: "七天内",
  later: "以后",
  someday: "没有到期",
  closed: "已完成 / 已取消",
};

export const BUCKET_ORDER: Bucket[] = ["overdue", "today", "week", "later", "someday", "closed"];

export const STATUS_LABEL: Record<TodoStatus, string> = {
  open: "待办",
  done: "已完成",
  cancelled: "已取消",
};

/** 当地日历日，`YYYY-MM-DD`。用来判断「今天」，不引入任何时刻。 */
export function localDay(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(day: string, count: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const shifted = new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + count);
  return localDay(shifted);
}

/**
 * 这条待办归到哪一组。
 *
 * 精确时刻按时刻比；只有日历日的按日历日比——**不**把它当成当天零点，否则
 * 「今天截止」的待办在今天一早就被算成逾期。
 */
export function bucketOf(todo: TodoView, now: Date): Bucket {
  if (todo.status !== "open") return "closed";

  const today = localDay(now);

  if (todo.duePrecision === "datetime" && todo.dueAtUtc) {
    const at = new Date(todo.dueAtUtc);
    if (Number.isNaN(at.getTime())) return "someday";
    if (at.getTime() < now.getTime()) return "overdue";
    const day = localDay(at);
    if (day === today) return "today";
    return day <= addDays(today, 7) ? "week" : "later";
  }

  if (todo.duePrecision === "date" && todo.dueDate) {
    if (todo.dueDate < today) return "overdue";
    if (todo.dueDate === today) return "today";
    return todo.dueDate <= addDays(today, 7) ? "week" : "later";
  }

  return "someday";
}

export function groupTodos(todos: TodoView[], now: Date): Array<{ bucket: Bucket; todos: TodoView[] }> {
  const groups = new Map<Bucket, TodoView[]>();
  for (const todo of todos) {
    const bucket = bucketOf(todo, now);
    const list = groups.get(bucket) ?? [];
    list.push(todo);
    groups.set(bucket, list);
  }
  return BUCKET_ORDER.filter((bucket) => groups.get(bucket)?.length).map((bucket) => ({
    bucket,
    todos: groups.get(bucket) ?? [],
  }));
}

/**
 * 到期怎么写。三种精度三种写法，**只有日历日的绝不带时刻**。
 */
export function describeDue(todo: TodoView): string {
  if (todo.duePrecision === "datetime" && todo.dueAtUtc) {
    const at = new Date(todo.dueAtUtc);
    if (Number.isNaN(at.getTime())) return "到期时间读不出来";
    const shown = at.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return todo.timeZone ? `${shown}（${todo.timeZone}）` : shown;
  }
  if (todo.duePrecision === "date" && todo.dueDate) {
    // 没有时刻就是没有时刻。
    return `${todo.dueDate}（未定时间）`;
  }
  return "未设到期";
}

/**
 * 这条待办的提醒会不会响，为什么。
 *
 * `capability` 是整台机器的能力，`todo.reminderState` 是这一条的登记结果。
 * 两者都要看：机器能弹但这一条没登记上（时区不认识之类），也得说出来。
 */
export function describeReminder(todo: TodoView, capability: ReminderCapability): Message {
  if (todo.status !== "open") {
    return { tone: "info", text: "已结束，不会再提醒" };
  }
  if (todo.reminderState === "scheduled" && todo.reminderScheduledForUtc) {
    const at = new Date(todo.reminderScheduledForUtc);
    const shown = Number.isNaN(at.getTime())
      ? todo.reminderScheduledForUtc
      : at.toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
    return { tone: "success", text: `将在 ${shown} 提醒` };
  }
  if (todo.reminderState === "fired") {
    return { tone: "info", text: "已经提醒过" };
  }
  if (todo.reminderState === "missed") {
    return { tone: "warn", text: "到点时没能提醒，已列进逾期" };
  }
  if (todo.reminderState === "unsupported") {
    return { tone: "warn", text: capability.reason ?? "这条没能登记提醒" };
  }
  if (todo.duePrecision === "none" && !todo.remindAtUtc) {
    return { tone: "info", text: "没有到期，不提醒" };
  }
  if (!capability.available) {
    return { tone: "warn", text: capability.reason ?? "提醒不会响" };
  }
  return { tone: "info", text: "到期已过，不再提醒" };
}

/** 保存之后说什么。保存成功和提醒失败是两件事，都要说。 */
export function describeSave(action: "created" | "updated", problem?: string | null): Message {
  const saved = action === "created" ? "已添加。" : "已保存。";
  if (!problem) return { tone: "success", text: saved };
  return { tone: "warn", text: `${saved}提醒没有登记上：${problem}` };
}

export function describeStatusChange(status: TodoStatus, problem?: string | null): Message {
  const base =
    status === "done" ? "已标记完成。" : status === "cancelled" ? "已取消。" : "已重新打开。";
  if (!problem) return { tone: "success", text: base };
  return { tone: "warn", text: `${base}提醒没有登记上：${problem}` };
}

/**
 * 逾期汇总那一条横幅。
 *
 * 说的是「这些到期了还没做」，**不是**「这些提醒过了」——很可能一次都没弹过
 * （电脑关着、未授权），把两件事混在一起说就是在替系统吹牛。
 */
export function describeDigest(count: number, more: number): Message | null {
  if (count <= 0) return null;
  const tail = more > 0 ? "，还有更多" : "";
  return {
    tone: "warn",
    text: `有 ${count} 条待办已经过了时间${tail}。处理完点一下完成，它就不再出现在这里。`,
  };
}

/**
 * 设置页上「后台提醒」现在是什么状态。
 *
 * 五种状态的措辞对照产品需求 §5.4 与走查 10.11：关窗会响、退出不会响、
 * 未授权不会响但待办还在、系统调度有投递窗口。
 */
export function describeCapability(capability: ReminderCapability): Message {
  if (capability.available) {
    return {
      tone: "success",
      text: "提醒由系统发送，窗口关着也会响。点「退出应用」之后不会响。",
    };
  }
  return {
    tone: "warn",
    text: `${capability.reason ?? "这台机器上弹不出定时提醒。"}待办列表和逾期汇总照常可用。`,
  };
}

/** Windows 计划通知的投递窗口。不写清楚就等于承诺「一定送到」。 */
export const DELIVERY_WINDOW_NOTE =
  "系统的定时通知有几分钟的投递窗口；关机时间较长时这条提醒可能不会送达，下次打开应用会补一次汇总。";

/**
 * 产品需求 §5.4 列的五种状态，一处说清楚。
 *
 * 这张表是设置页照着渲染的。之所以要五条而不是一句「已开启提醒」，是因为
 * 「关窗」和「退出」在用户眼里差不多，实际结果完全相反 —— 前者照响，后者不响。
 */
export const LIFECYCLE_STATES: Array<{ when: string; what: string }> = [
  { when: "关闭窗口", what: "照常提醒。窗口只是隐藏到托盘，计划已经交给系统了。" },
  { when: "点「退出应用」", what: "不再提醒。退出时会撤销所有还没到点的提醒。" },
  { when: "没给系统通知权限", what: "不弹提醒。待办列表和逾期汇总照常可用。" },
  { when: "休眠 / 重启 / 关机", what: "由系统决定。错过的会在下次打开应用时汇总一次，不会连着补弹。" },
  { when: "电脑一直开着", what: "到点由系统发出，应用没在跑也不影响。" },
];

/** 退出前必须说的那句话。托盘和设置页两个入口都用它。 */
export const QUIT_WARNING =
  "退出后不会弹出提醒 —— 还没到点的提醒会被撤销，待办本身都还在。确定退出？";
