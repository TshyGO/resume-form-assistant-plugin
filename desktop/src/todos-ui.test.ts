import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TodoView } from './api.ts';
import { mountTodos } from './todos-ui.ts';

/** 与 inbox-ui.test.ts 同一套假 DOM：只有 id 查询、innerHTML 与监听器。 */
type InvokeHandler = (name: string, args?: Record<string, unknown>) => unknown;

class FakeNode {
  id: string;
  value = "";
  innerHTML = "";
  textContent = "";
  className = "";
  hidden = false;
  open = false;
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  querySelectorAll() { return []; }
  dataset: Record<string, string> = {};
  classes = new Set<string>();
  classList = {
    toggle: (name: string, on?: boolean) => {
      const next = on ?? !this.classes.has(name);
      if (next) this.classes.add(name);
      else this.classes.delete(name);
      return next;
    },
    contains: (name: string) => this.classes.has(name),
    add: (name: string) => void this.classes.add(name),
    remove: (name: string) => void this.classes.delete(name),
  };
  attributes: Record<string, string> = {};
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  querySelector() { return null; }
  insertAdjacentHTML(_where: string, html: string) { this.innerHTML += html; }
  disabled = false;
  readOnly = false;
  placeholder = "";
  listeners: Record<string, (event: unknown) => unknown> = {};

  constructor(id: string) {
    this.id = id;
  }

  addEventListener(type: string, fn: (event: unknown) => unknown) {
    this.listeners[type] = fn;
  }

  emit(type: string, event: Record<string, unknown> = {}) {
    return this.listeners[type]?.({ preventDefault() {}, ...event });
  }

  reset() {
    this.value = "";
  }

  /** 点状态筛选里的某一个按钮。 */
  clickFilter(filter: string) {
    const target = {
      closest: (selector: string) => (selector.includes("data-filter") ? { dataset: { filter } } : null),
    };
    return this.emit("click", { target });
  }

  /** 从 innerHTML 里挑一个按钮，模拟点击它。 */
  clickButton(todoId: string, act: string) {
    const target = {
      closest: (selector: string) =>
        selector.includes("[data-todo]")
          ? { dataset: { todo: todoId, act } }
          : null,
    };
    return this.emit("click", { target });
  }
}

function harness(handler?: InvokeHandler) {
  const nodes = new Map<string, FakeNode>();
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];

  function el(id: string): FakeNode {
    if (!nodes.has(id)) nodes.set(id, new FakeNode(id));
    return nodes.get(id) as FakeNode;
  }
  globalThis.document = { getElementById: el, addEventListener() {} } as unknown as Document;

  const invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ name, args });
    const custom = handler?.(name, args);
    if (custom !== undefined) return custom as T;
    if (name === "reminder_capability_cmd") return { available: true, reason: null } as T;
    if (name === "list_applications_cmd") {
      return { total: 1, items: [{ id: "a1", company: "合成公司", title: "后端工程师" }] } as T;
    }
    if (name === "overdue_digest_cmd") return { todos: [], more: 0 } as T;
    if (name === "list_todos_cmd") return [] as T;
    return {} as T;
  };

  const now = () => new Date(2026, 8, 13, 10, 0, 0);
  const show = mountTodos(invoke as never, now);
  return { el, calls, show, called: (name: string) => calls.filter((c) => c.name === name) };
}

function todo(overrides: Partial<TodoView> = {}): TodoView {
  return {
    id: "t1",
    applicationId: "a1",
    title: "一面",
    duePrecision: "date",
    dueDate: "2026-09-20",
    status: "open",
    reminderState: "scheduled",
    reminderScheduledForUtc: "2026-09-20T01:00:00Z",
    company: "合成公司",
    position: "后端工程师",
    ...overrides,
  };
}

test('进入视图会问能力、申请、逾期汇总和列表', async () => {
  const h = harness();
  await h.show();

  for (const name of [
    "reminder_capability_cmd",
    "list_applications_cmd",
    "overdue_digest_cmd",
    "list_todos_cmd",
  ]) {
    assert.equal(h.called(name).length, 1, `没有调用 ${name}`);
  }
});

test('系统通知不可用时待办照常显示，并写明原因', async () => {
  const h = harness((name) => {
    if (name === "reminder_capability_cmd") {
      return { available: false, reason: "系统通知未授权。" };
    }
    if (name === "list_todos_cmd") return [todo({ reminderState: "unsupported" })];
    return undefined;
  });

  await h.show();

  assert.match(h.el("todo-list").innerHTML, /一面/, "提醒没了不等于待办列表没了");
  assert.match(h.el("todo-reminder-note").textContent, /未授权/);
  assert.match(h.el("todo-reminder-note").textContent, /投递窗口/, "投递窗口要写清楚");
  assert.match(h.el("todo-detail").innerHTML, /未授权/, "这一条为什么不会响也要写出来");
});

test('只有日历日的待办在列表里不带时刻', async () => {
  const h = harness((name) => (name === "list_todos_cmd" ? [todo()] : undefined));
  await h.show();

  const html = h.el("todo-list").innerHTML;
  assert.match(html, /9月20日/);
  assert.doesNotMatch(html, /00:00/);
  assert.match(html, /合成公司/, "统一列表要显示关联申请");
  const detail = h.el("todo-detail").innerHTML;
  assert.match(detail, /2026-09-20（未定时间）/, "详情里写完整日期");
  assert.doesNotMatch(detail, /00:00/);
});

test('新建待办把当地时刻换算成 UTC 再交给命令层', async () => {
  const h = harness();
  await h.show();

  h.el("todo-title").value = "二面";
  h.el("todo-precision").value = "datetime";
  h.el("todo-datetime").value = "2026-09-14T10:00";
  h.el("todo-application").value = "a1";
  await h.el("todo-form").emit("submit");

  const created = h.called("create_todo_cmd").at(0);
  const args = created?.args?.args as Record<string, unknown>;
  assert.equal(args.duePrecision, "datetime");
  assert.equal(args.dueAtUtc, new Date("2026-09-14T10:00").toISOString());
  assert.equal(args.dueDate, null, "精确到期不该同时带一个日期");
  assert.match(h.el("todo-status").textContent, /已添加/);
});

test('保存成功但提醒没登记上，两件事都要说', async () => {
  const h = harness((name) =>
    name === "create_todo_cmd"
      ? { todo: todo({ reminderState: "unsupported" }), reminderProblem: "不认识的时区：Mars/Olympus_Mons" }
      : undefined,
  );
  await h.show();

  h.el("todo-title").value = "二面";
  h.el("todo-application").value = "a1";
  await h.el("todo-form").emit("submit");

  const said = h.el("todo-status").textContent;
  assert.match(said, /已添加/, "保存确实成功了");
  assert.match(said, /Mars/, "提醒为什么没登记上也要说");
  assert.equal(h.el("todo-status").className, "note warn");
});

test('没有标题不发请求', async () => {
  const h = harness();
  await h.show();

  h.el("todo-title").value = "   ";
  await h.el("todo-form").emit("submit");

  h.el("todo-application").value = "a1";
  await h.el("todo-form").emit("submit");

  assert.equal(h.called("create_todo_cmd").length, 0);
  assert.match(h.el("todo-form-status").textContent, /标题/, "错误写在弹窗里，就近显示");
});

test('完成一条之后会重新拉列表', async () => {
  const h = harness((name) =>
    name === "set_todo_status_cmd" ? { todo: todo({ status: "done" }), reminderProblem: null } : undefined,
  );
  await h.show();
  const before = h.called("list_todos_cmd").length;

  await h.el("todo-list").clickButton("t1", "done");

  const call = h.called("set_todo_status_cmd").at(0);
  assert.deepEqual(call?.args, { id: "t1", status: "done" });
  assert.ok(h.called("list_todos_cmd").length > before, "改完状态要刷新列表");
  assert.match(h.el("todo-status").textContent, /已标记完成/);
});

test('已完成的待办给的是「重新打开」', async () => {
  const h = harness((name) =>
    name === "list_todos_cmd" ? [todo({ status: "done" })] : undefined,
  );
  await h.show();

  assert.match(h.el("todo-list").innerHTML, /没有未完成的待办/, "筛选没结果和一条都没有是两回事");
  await h.el("todo-filter").clickFilter("done");
  await h.el("todo-list").clickButton("t1", "select");

  const html = h.el("todo-detail").innerHTML;
  assert.match(html, /重新打开/);
  assert.doesNotMatch(html, /data-act="done"/, "已经完成的不再给「完成」");
  assert.doesNotMatch(h.el("todo-list").innerHTML, /data-act="done"/);
});

test('逾期汇总有内容时才显示那条横幅', async () => {
  const quiet = harness();
  await quiet.show();
  assert.equal(quiet.el("todo-digest").hidden, true);

  const loud = harness((name) =>
    name === "overdue_digest_cmd" ? { todos: [todo(), todo({ id: "t2" })], more: 0 } : undefined,
  );
  await loud.show();
  assert.equal(loud.el("todo-digest").hidden, false);
  assert.match(loud.el("todo-digest").textContent, /2 条/);
});

test('读列表失败时说出来，不是留一片空白', async () => {
  const h = harness((name) => {
    if (name === "list_todos_cmd") throw { code: "STORE_ERROR", message: "数据库打不开" };
    return undefined;
  });
  await h.show();

  assert.match(h.el("todo-status").textContent, /数据库打不开/);
});

test('编辑时清空提醒、时区和轮次，会显式发 null 让命令层清空', async () => {
  const h = harness((name) =>
    name === "list_todos_cmd"
      ? [todo({ duePrecision: "datetime", dueDate: null, dueAtUtc: "2026-09-20T06:00:00Z", timeZone: "Asia/Shanghai", remindAtUtc: "2026-09-20T05:00:00Z", interviewRound: 2 })]
      : undefined,
  );
  await h.show();
  await h.el("todo-detail").clickButton("t1", "edit");

  assert.equal(h.el("todo-dialog").open, true);
  assert.equal(h.el("todo-datetime").value, "2026-09-20T14:00", "按待办自己的时区回填墙钟");
  assert.equal(h.el("todo-remind").value, "2026-09-20T13:00");
  assert.equal(h.el("todo-round").value, "2");
  assert.equal(h.el("todo-application").disabled, true, "编辑时关联申请只读");

  h.el("todo-timezone").value = "";
  h.el("todo-remind").value = "";
  h.el("todo-round").value = "";
  await h.el("todo-form").emit("submit");

  const args = h.called("edit_todo_cmd").at(0)?.args?.args as Record<string, unknown>;
  assert.equal(args.id, "t1");
  assert.ok("timeZone" in args && args.timeZone === null);
  assert.ok("remindAtUtc" in args && args.remindAtUtc === null);
  assert.ok("interviewRound" in args && args.interviewRound === null);
  assert.equal(args.applicationId, undefined, "编辑不换申请");
});

test('具体到几点却没填时刻、时区写错、轮次不是整数，都不发请求并就近说明', async () => {
  const h = harness();
  await h.show();
  h.el("todo-title").value = "测评";
  h.el("todo-application").value = "a1";

  h.el("todo-precision").value = "datetime";
  await h.el("todo-form").emit("submit");
  assert.match(h.el("todo-form-status").textContent, /日期和时刻/);

  h.el("todo-datetime").value = "2026-09-14T10:00";
  h.el("todo-timezone").value = "Mars/Olympus";
  await h.el("todo-form").emit("submit");
  assert.match(h.el("todo-form-status").textContent, /时区/);

  h.el("todo-timezone").value = "";
  h.el("todo-round").value = "1.5";
  await h.el("todo-form").emit("submit");
  assert.match(h.el("todo-form-status").textContent, /轮次/);
  assert.equal(h.called("create_todo_cmd").length, 0);
});

test('一条申请都没有时，新增待办先领去建申请，不让提交', async () => {
  const nodes = harness((name) => (name === "list_applications_cmd" ? { total: 0, items: [] } : undefined));
  await nodes.show();
  assert.match(nodes.el("todo-list").innerHTML, /去新增申请/, "空状态直接给入口");
  await nodes.el("todo-new").emit("click");
  assert.equal(nodes.el("todo-no-apps").hidden, false);
  assert.equal(nodes.el("todo-submit").disabled, true);
});

test('筛选在本地做，按钮上带着各状态的数量', async () => {
  const h = harness((name) =>
    name === "list_todos_cmd"
      ? [todo(), todo({ id: "t2", status: "done" }), todo({ id: "t3", status: "cancelled" })]
      : undefined,
  );
  await h.show();
  assert.deepEqual(h.called("list_todos_cmd").at(-1)?.args, { applicationId: null, status: "all" });
  const filters = h.el("todo-filter").innerHTML;
  assert.match(filters, /未完成<span class="segment-count">1</);
  assert.match(filters, /全部<span class="segment-count">3</);
  await h.el("todo-filter").clickFilter("cancelled");
  assert.match(h.el("todo-list").innerHTML, /data-id="t3"/);
  assert.doesNotMatch(h.el("todo-list").innerHTML, /data-id="t1"/);
});
