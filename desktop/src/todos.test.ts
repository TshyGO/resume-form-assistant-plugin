import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReminderCapability, TodoView } from './api.ts';
import {
  bucketOf,
  describeCapability,
  describeDigest,
  describeDue,
  describeReminder,
  describeSave,
  describeStatusChange,
  groupTodos,
  localDay,
} from './todos.ts';

const AVAILABLE: ReminderCapability = { available: true, reason: null };
const BLOCKED: ReminderCapability = { available: false, reason: "系统通知未授权。" };

function todo(overrides: Partial<TodoView> = {}): TodoView {
  return {
    id: "t1",
    applicationId: "a1",
    title: "一面",
    duePrecision: "none",
    status: "open",
    reminderState: "none",
    company: "合成公司",
    position: "后端工程师",
    ...overrides,
  };
}

// 本地时区跑测试，用当天算相对日期，避免夏令时和跨日把断言弄脆。
const NOW = new Date(2026, 8, 13, 10, 0, 0); // 2026-09-13 10:00 本地
const TODAY = localDay(NOW);

function daysFromToday(count: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() + count);
  return localDay(d);
}

test('只有日历日的待办永远不显示成 00:00', () => {
  const text = describeDue(todo({ duePrecision: "date", dueDate: "2026-09-20" }));

  assert.match(text, /2026-09-20/);
  assert.doesNotMatch(text, /00:00/, "「9 月 20 日截止」和「9 月 20 日 00:00 截止」是两句话");
  assert.match(text, /未定时间/);
});

test('精确到期显示到分钟，有时区就带上', () => {
  const withZone = describeDue(
    todo({ duePrecision: "datetime", dueAtUtc: "2026-09-14T02:00:00Z", timeZone: "Asia/Shanghai" }),
  );
  assert.match(withZone, /Asia\/Shanghai/);

  const broken = describeDue(todo({ duePrecision: "datetime", dueAtUtc: "不是时间" }));
  assert.match(broken, /读不出来/, "读不出来就说读不出来，不要显示 Invalid Date");
});

test('没有到期就说没有到期', () => {
  assert.equal(describeDue(todo()), "未设到期");
});

test('今天到期的日历日待办不算逾期', () => {
  assert.equal(bucketOf(todo({ duePrecision: "date", dueDate: TODAY }), NOW), "today");
  assert.equal(
    bucketOf(todo({ duePrecision: "date", dueDate: daysFromToday(-1) }), NOW),
    "overdue",
    "昨天才算逾期",
  );
});

test('分组按到期远近，没有到期的单独一组，结束的归到最后', () => {
  assert.equal(bucketOf(todo({ duePrecision: "date", dueDate: daysFromToday(3) }), NOW), "week");
  assert.equal(bucketOf(todo({ duePrecision: "date", dueDate: daysFromToday(30) }), NOW), "later");
  assert.equal(bucketOf(todo(), NOW), "someday");
  assert.equal(bucketOf(todo({ status: "done", duePrecision: "date", dueDate: daysFromToday(-9) }), NOW), "closed");

  const groups = groupTodos(
    [
      todo({ id: "later", duePrecision: "date", dueDate: daysFromToday(30) }),
      todo({ id: "overdue", duePrecision: "date", dueDate: daysFromToday(-2) }),
      todo({ id: "today", duePrecision: "date", dueDate: TODAY }),
    ],
    NOW,
  );
  assert.deepEqual(
    groups.map((g) => g.bucket),
    ["overdue", "today", "later"],
    "先看已经误了的",
  );
  assert.equal(groups.length, 3, "空的分组不出现");
});

test('精确时刻按时刻比，不按日历日', () => {
  const earlierToday = new Date(NOW);
  earlierToday.setHours(8, 0, 0, 0);
  const laterToday = new Date(NOW);
  laterToday.setHours(23, 0, 0, 0);

  assert.equal(
    bucketOf(todo({ duePrecision: "datetime", dueAtUtc: earlierToday.toISOString() }), NOW),
    "overdue",
    "今天早上八点已经过去了",
  );
  assert.equal(
    bucketOf(todo({ duePrecision: "datetime", dueAtUtc: laterToday.toISOString() }), NOW),
    "today",
  );
});

test('五种提醒状态各有各的说法', () => {
  const scheduled = describeReminder(
    todo({ reminderState: "scheduled", reminderScheduledForUtc: "2026-09-14T02:00:00Z" }),
    AVAILABLE,
  );
  assert.equal(scheduled.tone, "success");
  assert.match(scheduled.text, /将在/);

  assert.match(describeReminder(todo({ reminderState: "fired" }), AVAILABLE).text, /已经提醒过/);
  assert.equal(describeReminder(todo({ reminderState: "missed" }), AVAILABLE).tone, "warn");

  // 这一条没登记上，原因跟着机器的能力走。
  const blocked = describeReminder(todo({ reminderState: "unsupported" }), BLOCKED);
  assert.equal(blocked.tone, "warn");
  assert.match(blocked.text, /未授权/);

  assert.match(describeReminder(todo({ status: "done" }), AVAILABLE).text, /不会再提醒/);
  assert.match(describeReminder(todo(), AVAILABLE).text, /没有到期/);
});

test('机器能弹但这一条没登记上，也要说得出来', () => {
  const message = describeReminder(todo({ reminderState: "unsupported" }), AVAILABLE);
  assert.equal(message.tone, "warn");
  assert.match(message.text, /没能登记/);
});

test('保存成功和提醒失败要同时说出来', () => {
  assert.deepEqual(describeSave("created"), { tone: "success", text: "已添加。" });

  const partial = describeSave("updated", "系统通知未授权。");
  assert.equal(partial.tone, "warn");
  assert.match(partial.text, /已保存/, "保存是成功了的，不能只说失败");
  assert.match(partial.text, /未授权/);

  assert.match(describeStatusChange("done").text, /已标记完成/);
  assert.match(describeStatusChange("open", "时区不认识").text, /重新打开/);
});

test('逾期汇总说的是「过了时间」，不是「提醒过了」', () => {
  assert.equal(describeDigest(0, 0), null);

  const some = describeDigest(3, 0);
  assert.match(some?.text ?? "", /3 条/);
  assert.doesNotMatch(
    some?.text ?? "",
    /提醒过|通知过/,
    "很可能一次都没弹过（电脑关着、未授权），别替系统吹牛",
  );
  assert.match(describeDigest(50, 1)?.text ?? "", /还有更多/);
});

test('设置页要说清关窗会响、退出不会响', () => {
  const on = describeCapability(AVAILABLE);
  assert.match(on.text, /窗口关着也会响/);
  assert.match(on.text, /退出应用.*不会响/);

  const off = describeCapability(BLOCKED);
  assert.equal(off.tone, "warn");
  assert.match(off.text, /未授权/);
  assert.match(off.text, /待办列表和逾期汇总照常可用/, "提醒没了不等于功能没了");
});
