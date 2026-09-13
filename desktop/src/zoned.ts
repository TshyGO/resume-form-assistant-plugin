// 时区与 `datetime-local` 之间的换算。
//
// 为什么需要这个：HTML 的 `datetime-local` 控件没有时区概念，它给出的是一串墙钟
// 文字。如果直接 `new Date(那串文字)`，浏览器按**本机时区**解释；而待办自己带着
// 一个时区字段。两者不一致时，存进去的时刻就会差掉一个偏移——面试时间会错几个
// 小时，而且界面还理直气壮地标着「Asia/Shanghai」。
//
// 所以这里把两个方向都写清楚：输入框里的墙钟属于**待办自己的时区**（没设就用
// 本机时区），存储里永远是 UTC 绝对时刻。

/** 某个时区在某一瞬间相对 UTC 的偏移（毫秒）。 */
function offsetMsAt(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asIfUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour") % 24,
    value("minute"),
    value("second"),
  );
  return asIfUtc - at.getTime();
}

/** `datetime-local` 控件产出的形状，多一个字符少一个字符都不收。 */
const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * UTC 时刻 → `datetime-local` 能接受的墙钟文字（`YYYY-MM-DDTHH:mm`）。
 *
 * 时区给空就按本机算。时区名不认识时也退回本机，**不抛异常**——编辑框读不出来
 * 比整个视图崩掉要好。
 */
export function utcToLocalInput(utcIso: string, timeZone?: string | null): string {
  const at = new Date(utcIso);
  if (Number.isNaN(at.getTime())) return "";
  if (!timeZone) {
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }
  try {
    const shifted = new Date(at.getTime() + offsetMsAt(at, timeZone));
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  } catch {
    return utcToLocalInput(utcIso, null);
  }
}

/**
 * `datetime-local` 的墙钟文字 → UTC 时刻（RFC3339）。
 *
 * 换算要迭代一次：先按目标时区在「把这串文字当成 UTC」那一刻的偏移猜一个绝对
 * 时刻，再用猜出来的时刻重算一次偏移。跨夏令时切换的那几个小时里，两次偏移会
 * 不一样，第二次才是对的。
 */
export function localInputToUtc(wallClock: string, timeZone?: string | null): string | null {
  // 先卡形状再解析。`new Date` 的解析太宽松，`new Date("不是时间:00Z")` 会被它
  // 读成 2000 年 1 月 1 日——靠 Number.isNaN 兜底是兜不住的。
  if (!DATETIME_LOCAL.test(wallClock)) return null;
  if (!timeZone) {
    const local = new Date(wallClock);
    return Number.isNaN(local.getTime()) ? null : local.toISOString();
  }
  const asIfUtc = new Date(`${wallClock}:00Z`);
  if (Number.isNaN(asIfUtc.getTime())) return null;
  try {
    const first = offsetMsAt(asIfUtc, timeZone);
    let guess = new Date(asIfUtc.getTime() - first);
    const second = offsetMsAt(guess, timeZone);
    if (second !== first) guess = new Date(asIfUtc.getTime() - second);
    return guess.toISOString();
  } catch {
    return localInputToUtc(wallClock, null);
  }
}

/**
 * 按待办自己的时区显示一个时刻。
 *
 * 之前是拿本机时区格式化、再把 `timeZone` 当字符串拼在后面——机器在纽约、待办
 * 标着上海时，显示的是纽约的钟点却写着 Asia/Shanghai。那不是显示不准，是说谎。
 */
export function formatInZone(utcIso: string, timeZone?: string | null): string | null {
  const at = new Date(utcIso);
  if (Number.isNaN(at.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  try {
    return at.toLocaleString("zh-CN", timeZone ? { ...options, timeZone } : options);
  } catch {
    // 时区名不认识：退回本机，并且**不再声称**这是那个时区的时间（调用方负责）。
    return at.toLocaleString("zh-CN", options);
  }
}
