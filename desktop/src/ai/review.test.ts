import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiSuggestion } from "../api.ts";
import {
  confirmArgs,
  confirmBlocker,
  confirmLabel,
  describeFailure,
  highlight,
  initialDraft,
  isModified,
  waitingText,
} from "./review.ts";

const suggestion = (overrides: Partial<AiSuggestion> = {}): AiSuggestion => ({
  id: "sug-1",
  evidenceId: "ev-1",
  status: "pending",
  candidates: [{ id: "app-a", company: "合成科技", title: "后端实习", stage: "submitted" }],
  stage: "interview",
  round: 1,
  replyClass: "interview_invite",
  sendMode: "automated",
  todos: [
    {
      title: "一面",
      duePrecision: "datetime",
      dueAtUtc: "2026-09-22T02:00:00Z",
      dueDate: null,
      timeZone: "Asia/Shanghai",
      interviewRound: 1,
    },
  ],
  excerpts: ["下周二上午十点"],
  uncertainties: [],
  modelLabel: "fake-model",
  promptScope: "发往 api.example.test · 候选 1 条",
  createdAt: "2026-09-16T02:00:00Z",
  ...overrides,
});

test("只有一条候选就替用户填上，多于一条留空让他自己选", () => {
  assert.equal(initialDraft(suggestion()).applicationId, "app-a");
  const two = suggestion({
    candidates: [
      { id: "app-a", company: "合成科技", title: "后端实习", stage: "submitted" },
      { id: "app-b", company: "合成科技", title: "前端实习", stage: "submitted" },
    ],
  });
  assert.equal(initialDraft(two).applicationId, "");
});

test("「同时更新申请进度」默认不勾", () => {
  assert.equal(initialDraft(suggestion()).updateProgress, false);
});

test("多个候选没选就不能确认", () => {
  const two = suggestion({
    candidates: [
      { id: "app-a", company: "合成科技", title: "后端实习", stage: "submitted" },
      { id: "app-b", company: "合成科技", title: "前端实习", stage: "submitted" },
    ],
  });
  const draft = initialDraft(two);
  assert.match(confirmBlocker(draft, two) ?? "", /哪一条申请/);
  assert.equal(confirmBlocker({ ...draft, applicationId: "app-b" }, two), null);
});

test("没改过是「确认」，改过是「改完确认」", () => {
  const item = suggestion();
  const draft = initialDraft(item);
  assert.equal(isModified(draft, item), false);
  assert.equal(confirmLabel(draft, item), "确认");
  assert.equal(confirmLabel({ ...draft, sendMode: "unknown" }, item), "改完确认");
});

test("去掉一条待办也算改过", () => {
  const item = suggestion();
  const draft = initialDraft(item);
  const dropped = { ...draft, todos: [{ ...draft.todos[0]!, keep: false }] };
  assert.equal(isModified(dropped, item), true);
  assert.equal(confirmArgs(dropped, item).createTodos, false);
  assert.deepEqual(confirmArgs(dropped, item).todos, []);
});

test("确认入参带上改后的待办，不带没勾的那些", () => {
  const item = suggestion();
  const draft = initialDraft(item);
  const edited = {
    ...draft,
    updateProgress: true,
    todos: [{ ...draft.todos[0]!, title: "一面（改到周三）", dueAtUtc: "2026-09-23T02:00:00Z" }],
  };
  const args = confirmArgs(edited, item);
  assert.equal(args.suggestionId, "sug-1");
  assert.equal(args.applicationId, "app-a");
  assert.equal(args.updateProgress, true);
  assert.equal(args.createTodos, true);
  assert.equal(args.todos[0]!.title, "一面（改到周三）");
  assert.equal(args.todos[0]!.dueAtUtc, "2026-09-23T02:00:00Z");
  assert.equal(args.todos[0]!.dueDate, null);
  assert.equal(args.todos[0]!.timeZone, "Asia/Shanghai");
});

test("没选申请时发 null，不发空串——两种情况后端报的错不一样", () => {
  const item = suggestion();
  const draft = { ...initialDraft(item), applicationId: "" };
  assert.equal(confirmArgs(draft, item).applicationId, null);
});

test("时区要填 IANA 名字", () => {
  const item = suggestion();
  const draft = initialDraft(item);
  const withZone = (timeZone: string) => ({
    ...draft,
    todos: [{ ...draft.todos[0]!, timeZone }],
  });
  assert.match(confirmBlocker(withZone("北京时间"), item) ?? "", /时区名/);
  assert.equal(confirmBlocker(withZone("Asia/Shanghai"), item), null);
  assert.equal(confirmBlocker(withZone(""), item), null);
});

test("阶段留空就不发阶段事件", () => {
  const item = suggestion();
  const draft = { ...initialDraft(item), stage: "" as const };
  assert.equal(confirmArgs(draft, item).stage, null);
});

test("待办说是精确到时刻却没有时刻，确认按钮就按不下去", () => {
  const item = suggestion();
  const draft = initialDraft(item);
  const broken = { ...draft, todos: [{ ...draft.todos[0]!, dueAtUtc: "" }] };
  assert.match(confirmBlocker(broken, item) ?? "", /没有时刻/);
});

test("原文依据在正文里能切出高亮段", () => {
  const parts = highlight("您好，时间定在下周二上午十点，地点望京。", "下周二上午十点");
  assert.deepEqual(
    parts.map((part) => part.hit),
    [false, true, false],
  );
  // 找不到就整段不高亮，不做模糊匹配——宁可不高亮，也不高亮错地方。
  assert.deepEqual(highlight("正文", "对不上的引用"), [{ text: "正文", hit: false }]);
});

test("每一种失败都说清楚接下来做什么，并且一条不落地提到手动分类还在", () => {
  const cases = [
    ["AI_NOT_CONFIGURED", /设置页/],
    ["AI_NEEDS_CANDIDATES", /关联|候选/],
    ["AI_UNSUPPORTED_KIND", /粘贴文本/],
    ["AI_NO_TEXT", /手动分类/],
    ["AI_TIMEOUT", /再试一次|更快/],
    ["AI_NETWORK", /网络|接口地址/],
    ["AI_BUSY", /等它结束/],
    ["AI_CANCELLED", /计费/],
    ["AI_BAD_RESPONSE", /换一个模型/],
    ["AI_CANDIDATE_OUT_OF_RANGE", /换一个模型/],
    ["AI_NEEDS_DISAMBIGUATION", /选一条/],
    ["AI_CLIENT_INIT_FAILED", /手动分类/],
    ["AI_HTTP_400", /模型名|接口地址/],
    ["AI_HTTP_401", /换一条 Key/],
    ["AI_HTTP_403", /换一条 Key/],
    ["AI_HTTP_404", /接口地址和模型名/],
    ["AI_HTTP_429", /限流/],
    ["AI_HTTP_500", /服务商/],
    ["AI_HTTP_502", /服务商/],
    ["WHATEVER", /手动分类/],
  ] as const;
  for (const [code, pattern] of cases) {
    const failure = describeFailure({ code, message: "出事了。" });
    assert.match(failure.next, pattern, code);
    assert.match(failure.next, /手动分类/, code);
  }
});

test("Key 或地址不对时不给「再试一次」——再点一次必然还是这个结果", () => {
  for (const code of ["AI_HTTP_401", "AI_HTTP_403", "AI_HTTP_404", "AI_NOT_CONFIGURED"]) {
    assert.equal(describeFailure({ code, message: "不行。" }).retryable, false, code);
  }
  for (const code of ["AI_TIMEOUT", "AI_NETWORK", "AI_HTTP_429", "AI_HTTP_500"]) {
    assert.equal(describeFailure({ code, message: "不行。" }).retryable, true, code);
  }
});

test("取消的文案说明不保证对方停止计费", () => {
  const failure = describeFailure({ code: "AI_CANCELLED", message: "已取消。" });
  assert.match(failure.next, /计费/);
  assert.equal(failure.retryable, true);
});

test("同一条证据正在跑时不建议再发一次", () => {
  const failure = describeFailure({ code: "AI_BUSY", message: "这条证据正在分析中。" });
  assert.equal(failure.retryable, false);
});

test("不认识的错误码也要原样带出来，方便对日志", () => {
  const failure = describeFailure({ code: "WEIRD", message: "说不清。" });
  assert.match(failure.text, /WEIRD/);
});

test("等久了换成「还在等」", () => {
  assert.equal(waitingText(3, 15), "正在发送…");
  assert.match(waitingText(16, 15), /还在等（已经 16 秒）/);
});

test("轮次只收 1–99 的整数，小数和科学计数法都拦下来", () => {
  const item = suggestion();
  const draft = initialDraft(item);
  for (const round of [0, -1, 1.5, 100, 1000]) {
    assert.match(confirmBlocker({ ...draft, round }, item) ?? "", /轮次/, String(round));
  }
  assert.equal(confirmBlocker({ ...draft, round: 2 }, item), null);
  assert.equal(confirmBlocker({ ...draft, round: null }, item), null);
});

test("待办的时刻和日期要能被后端认，格式不对当场说", () => {
  const item = suggestion();
  const draft = initialDraft(item);
  const withTodo = (patch: Partial<(typeof draft.todos)[number]>) => ({
    ...draft,
    todos: [{ ...draft.todos[0]!, ...patch }],
  });
  assert.match(confirmBlocker(withTodo({ dueAtUtc: "下周二" }), item) ?? "", /时刻要写成/);
  // 秒不能省，日历上不存在的日子也得拦住。
  assert.match(confirmBlocker(withTodo({ dueAtUtc: "2026-09-22T10:00Z" }), item) ?? "", /时刻要写成/);
  assert.match(confirmBlocker(withTodo({ dueAtUtc: "2026-02-31T10:00:00Z" }), item) ?? "", /时刻要写成/);
  // 24:00 在 JS 里会被当成次日零点，但存储层的 RFC3339 解析不认。
  assert.match(confirmBlocker(withTodo({ dueAtUtc: "2026-09-22T24:00:00Z" }), item) ?? "", /时刻要写成/);
  assert.match(confirmBlocker(withTodo({ dueAtUtc: "2026-09-22T10:61:00Z" }), item) ?? "", /时刻要写成/);
  assert.equal(confirmBlocker(withTodo({ dueAtUtc: "2026-09-22T10:00:00+08:00" }), item), null);
  assert.match(
    confirmBlocker(withTodo({ duePrecision: "date", dueDate: "" }), item) ?? "",
    /没有日期/,
  );
  assert.match(
    confirmBlocker(withTodo({ duePrecision: "date", dueDate: "2026/09/22" }), item) ?? "",
    /日期要写成/,
  );
  assert.match(
    confirmBlocker(withTodo({ duePrecision: "date", dueDate: "2026-02-31" }), item) ?? "",
    /真实存在/,
  );
  assert.equal(confirmBlocker(withTodo({ duePrecision: "date", dueDate: "2026-09-22" }), item), null);
  assert.equal(confirmBlocker(withTodo({ duePrecision: "none" }), item), null);
  // 不转正的那条不参与校验：用户已经说了不要它。
  assert.equal(confirmBlocker(withTodo({ keep: false, dueAtUtc: "乱写" }), item), null);
});

test("提交时把时刻和日期的空白去掉", () => {
  const item = suggestion();
  const draft = initialDraft(item);
  const args = confirmArgs(
    { ...draft, todos: [{ ...draft.todos[0]!, dueAtUtc: " 2026-09-22T02:00:00Z " }] },
    item,
  );
  assert.equal(args.todos[0]!.dueAtUtc, "2026-09-22T02:00:00Z");
});

test("换成模型没指名的申请，也算改过", () => {
  const item = suggestion();
  const draft = initialDraft(item);
  assert.equal(isModified(draft, item), false);
  assert.equal(isModified({ ...draft, applicationId: "app-z" }, item), true);
});

test("候选这一次没读出来：不替用户填，但也不拦着他选", () => {
  const flaky = suggestion({
    candidates: [
      { id: "app-a", company: "（这条申请暂时读不出来）", title: "", stage: "", unreadable: true },
    ],
  });
  const draft = initialDraft(flaky);
  assert.equal(draft.applicationId, "");
  assert.equal(confirmBlocker({ ...draft, applicationId: "app-a" }, flaky), null);
});

test("唯一候选已经不在了就不替用户填，也不让确认", () => {
  const gone = suggestion({
    candidates: [{ id: "gone", company: "（这条申请已经不在了）", title: "", stage: "", missing: true }],
  });
  const draft = initialDraft(gone);
  assert.equal(draft.applicationId, "");
  assert.match(confirmBlocker({ ...draft, applicationId: "gone" }, gone) ?? "", /已经不在了/);
});

test("失败对象自带错误码和重试语义，调用方不必自己补", () => {
  const timeout = describeFailure({ code: "AI_TIMEOUT", message: "等太久了。" });
  assert.equal(timeout.code, "AI_TIMEOUT");
  assert.equal(timeout.retry, "analyze");

  const needs = describeFailure({ code: "AI_NEEDS_CANDIDATES", message: "认不出来。" });
  assert.equal(needs.retry, "none");
  assert.match(needs.next, /选几条候选/);

  // 同一封通知确认过第二次会 CONFLICT，文案要说清楚该去哪儿改。
  const conflict = describeFailure({ code: "CONFLICT", message: "已经确认过了。" });
  assert.equal(conflict.retryable, false);
  assert.match(conflict.next, /改申请里的记录/);
});

test("时区、日期、时刻的边界：闰年、无冒号偏移、Etc/GMT", () => {
  const item = suggestion();
  const draft = initialDraft(item);
  const withTodo = (patch: Partial<(typeof draft.todos)[number]>) => ({
    ...draft,
    todos: [{ ...draft.todos[0]!, ...patch }],
  });
  // 2028 是闰年，2027 不是。
  assert.equal(
    confirmBlocker(withTodo({ duePrecision: "date", dueDate: "2028-02-29" }), item),
    null,
  );
  assert.match(
    confirmBlocker(withTodo({ duePrecision: "date", dueDate: "2027-02-29" }), item) ?? "",
    /真实存在/,
  );
  // 偏移可以不带冒号。
  assert.equal(confirmBlocker(withTodo({ dueAtUtc: "2026-09-22T10:00:00+0800" }), item), null);
  assert.equal(confirmBlocker(withTodo({ timeZone: "Etc/GMT+8" }), item), null);
});

test("只多打了个空格不算改过", () => {
  const item = suggestion();
  const draft = initialDraft(item);
  const padded = { ...draft, todos: [{ ...draft.todos[0]!, title: " 一面 " }] };
  assert.equal(isModified(padded, item), false);
});

test("推不出来的阶段在草稿里直接回落成「不记阶段」", () => {
  const odd = suggestion({ stage: "submitted" });
  assert.equal(initialDraft(odd).stage, "");
  assert.equal(confirmArgs(initialDraft(odd), odd).stage, null);
});

test("地址里夹带凭据的错误码有自己的指引", () => {
  const failure = describeFailure({
    code: "AI_URL_HAS_CREDENTIAL",
    message: "接口地址里的 `api-key` 看着像一把 Key。",
  });
  assert.equal(failure.retryable, false);
  assert.match(failure.next, /设置页/);
});
