// D10 待办视图（#262 改版）：左侧按时间分组的列表，右侧选中待办的详情。
// 新建/编辑在弹窗里；完成、取消、重新打开直接执行并在状态行反馈。
//
// 这个视图**完全不依赖系统通知**。未授权、未启用、平台不支持时它照常可用，
// 只是每条待办的详情里如实写着提醒不会响（产品需求 §5.4）。

import type {
  ApplicationSummary,
  Invoke,
  OverdueDigest,
  Page,
  ReminderCapability,
  TodoStatus,
  TodoView,
  TodoWriteResult,
} from "./api.ts";
import { input, maybe, must, select as selectEl, valueOf } from "./dom.ts";
import { localInputToUtc, utcToLocalInput } from "./zoned.ts";
import type { Message, TodoFilter } from "./todos.ts";
import {
  BUCKET_LABEL,
  DELIVERY_WINDOW_NOTE,
  EMPTY_TODOS,
  FILTER_OPTIONS,
  NEEDS_APPLICATION,
  PRECISION_LABEL,
  STATUS_LABEL,
  bucketOf,
  describeCapability,
  describeDigest,
  describeDue,
  describeEmptyFilter,
  describeReminder,
  describeRemindAt,
  describeSave,
  describeStatusChange,
  groupTodos,
  shortDue,
} from "./todos.ts";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function invokeError(error: unknown) {
  const detail = error as { message?: string; code?: string } | null;
  return detail?.message || detail?.code || "未知错误";
}

/** 时区得是 IANA 名字。填错了 `datetime-local` 会被悄悄按本机解释，存进去的时刻就错了。 */
function knownTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

// 线条图标，只是装饰，读屏跳过。
const ICON = {
  plus: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  close: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  edit: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  reopen: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  bell: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
  building: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V5l8-2v18M12 8h8v13M8 8v.01M8 12v.01M8 16v.01M16 12v.01M16 16v.01M2 21h20"/></svg>',
  calendar: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="m9 15 2 2 4-4"/></svg>',
};

/** 宿主注入的事：没有申请时把人领去新增申请。测试里可以不给。 */
export interface TodosHost {
  createApplication?: (() => void) | null;
}

export function mountTodos(
  invoke: Invoke,
  now: () => Date = () => new Date(),
  { createApplication = null }: TodosHost = {},
) {
  const shell = must("todo-shell");
  const list = must("todo-list");
  const detail = must("todo-detail");
  const status = must("todo-status");
  const digest = must("todo-digest");
  const filterGroup = must("todo-filter");
  const reminderNote = must("todo-reminder-note");
  const form = must<HTMLFormElement>("todo-form");
  const applicationSelect = selectEl("todo-application");
  const precisionSelect = selectEl("todo-precision");
  const dateInput = input("todo-date");
  const datetimeInput = input("todo-datetime");
  const dialog = must<HTMLDialogElement>("todo-dialog");
  const formStatus = must("todo-form-status");

  let capability: ReminderCapability = { available: false, reason: null };
  let applications: ApplicationSummary[] = [];
  let applicationsLoaded = false;
  /** 一次取回全部状态，筛选在本地做：计数和「一条都没有」才分得清。 */
  let todos: TodoView[] = [];
  let loaded = false;
  let filter: TodoFilter = "open";
  let selectedId: string | null = null;
  let editing: string | null = null;
  /// 双击提交会建出两条待办、登记两条提醒。一次只让一个请求在飞。
  let saving = false;
  let editLoading = false;
  /** 完成 / 取消 / 重新打开正在路上：同一条连点两次只发一次。 */
  let acting = false;
  let opener: HTMLElement | null = null;

  function say(message: Message | null) {
    status.textContent = message?.text ?? "";
    status.className = message ? `note ${message.tone}` : "note";
  }

  function sayInForm(message: Message | null) {
    formStatus.textContent = message?.text ?? "";
    formStatus.className = message ? `note ${message.tone}` : "note";
  }

  /** 到期精度决定哪个输入框可用。三个精度互斥，不会同时填两个。 */
  function syncPrecision() {
    const precision = precisionSelect.value;
    dateInput.hidden = precision !== "date";
    datetimeInput.hidden = precision !== "datetime";
    const dateField = maybe("todo-date-field");
    const datetimeField = maybe("todo-datetime-field");
    if (dateField) dateField.hidden = precision !== "date";
    if (datetimeField) datetimeField.hidden = precision !== "datetime";
  }

  function renderCapability() {
    const message = describeCapability(capability);
    reminderNote.textContent = `${message.text} ${DELIVERY_WINDOW_NOTE}`;
    reminderNote.className = `note ${message.tone}`;
  }

  function visibleTodos(): TodoView[] {
    return filter === "all" ? todos : todos.filter((todo) => todo.status === filter);
  }

  /** 列表里排第一的那条（按分组顺序：先逾期、再今天……）。 */
  function firstShown(): string | null {
    return groupTodos(visibleTodos(), now())[0]?.todos[0]?.id ?? null;
  }

  function renderFilter() {
    const counts: Record<TodoFilter, number> = {
      open: todos.filter((todo) => todo.status === "open").length,
      done: todos.filter((todo) => todo.status === "done").length,
      cancelled: todos.filter((todo) => todo.status === "cancelled").length,
      all: todos.length,
    };
    filterGroup.innerHTML = FILTER_OPTIONS.map(
      (option) =>
        `<button type="button" data-filter="${option.value}" aria-pressed="${option.value === filter}">${escapeHtml(option.label)}<span class="segment-count">${loaded ? counts[option.value] : ""}</span></button>`,
    ).join("");
  }

  function item(todo: TodoView): string {
    const id = escapeHtml(todo.id);
    const active = todo.id === selectedId;
    const due = shortDue(todo, now());
    const where = [todo.company, todo.position].filter(Boolean).map(escapeHtml).join(" · ");
    const round = todo.interviewRound ? `<span class="todo-round">第 ${todo.interviewRound} 轮</span>` : "";
    // 圆圈是真按钮：未完成的点一下就完成（可以在详情里重新打开）；已结束的只是标记。
    const check =
      todo.status === "open"
        ? `<button type="button" class="todo-check" data-todo="${id}" data-act="done" aria-label="完成「${escapeHtml(todo.title)}」" title="标记为已完成"></button>`
        : `<span class="todo-check" data-status="${escapeHtml(todo.status)}" aria-hidden="true">${todo.status === "done" ? ICON.check : ICON.close}</span>`;
    return `
      <li class="todo-item${active ? " active" : ""}" data-id="${id}" data-status="${escapeHtml(todo.status)}">
        ${check}
        <button type="button" class="todo-select" data-todo="${id}" data-act="select" aria-current="${active}">
          <strong>${escapeHtml(todo.title)}</strong>
          <span class="todo-where">${ICON.building}<span>${where || "未关联申请信息"}</span>${round}</span>
        </button>
        <span class="due-badge" data-tone="${due.tone}">${escapeHtml(due.text)}</span>
      </li>`;
  }

  function renderList() {
    renderFilter();
    shell.classList.toggle("is-empty", loaded && todos.length === 0);
    if (!loaded) {
      list.innerHTML = '<p class="todo-list-note muted">正在读取待办…</p>';
      return;
    }
    if (!todos.length) {
      const blocked = applicationsLoaded && !applications.length;
      list.innerHTML = `
        <div class="workspace-empty">
          <span class="workspace-empty-icon">${ICON.calendar}</span>
          <h2>还没有待办</h2>
          <p>${escapeHtml(EMPTY_TODOS)}</p>
          ${blocked ? `<p class="workspace-empty-warn">${escapeHtml(NEEDS_APPLICATION)}</p>` : ""}
          <div class="workspace-empty-actions">
            ${
              blocked
                ? '<button type="button" class="primary" data-empty-act="application">去新增申请</button>'
                : `<button type="button" class="primary" data-empty-act="todo">${ICON.plus}新增待办</button>`
            }
          </div>
        </div>`;
      return;
    }
    const shown = visibleTodos();
    if (!shown.length) {
      const empty = describeEmptyFilter(filter);
      list.innerHTML = `<div class="todo-filter-empty" role="status"><p>${escapeHtml(empty.title)}</p><p class="muted">${escapeHtml(empty.text)}</p></div>`;
      return;
    }
    list.innerHTML = groupTodos(shown, now())
      .map(
        (group) => `
          <section class="todo-group" data-bucket="${group.bucket}">
            <h2>${BUCKET_LABEL[group.bucket]}<span class="chip">${group.todos.length}</span></h2>
            <ul class="todo-items">${group.todos.map(item).join("")}</ul>
          </section>`,
      )
      .join("");
  }

  function fact(label: string, value: string, extra = "") {
    return `<div${extra}><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
  }

  function renderDetail() {
    const todo = todos.find((entry) => entry.id === selectedId);
    if (!todo) {
      detail.innerHTML = loaded && todos.length
        ? '<div class="todo-detail-empty"><p>选择一条待办</p><p class="muted">查看到期时间、提醒状态和关联申请。</p></div>'
        : "";
      return;
    }
    const id = escapeHtml(todo.id);
    const reminder = describeReminder(todo, capability);
    const bucket = bucketOf(todo, now());
    const where = [todo.company, todo.position].filter(Boolean).map(escapeHtml).join(" · ");
    const actions =
      todo.status === "open"
        ? `<button type="button" class="primary" data-todo="${id}" data-act="done">${ICON.check}标记为已完成</button>
           <button type="button" data-todo="${id}" data-act="edit">${ICON.edit}编辑 / 改期</button>
           <button type="button" class="todo-cancel-action" data-todo="${id}" data-act="cancelled">${ICON.close}取消待办</button>`
        : `<button type="button" class="primary" data-todo="${id}" data-act="open">${ICON.reopen}重新打开</button>`;
    const timing =
      todo.status === "open" && (bucket === "overdue" || bucket === "today")
        ? `<span class="due-badge" data-tone="${bucket}">${BUCKET_LABEL[bucket]}</span>`
        : "";
    const zone = todo.timeZone
      ? escapeHtml(todo.timeZone)
      : `本机时区${localTimeZone() ? `（${escapeHtml(localTimeZone())}）` : ""}`;
    detail.innerHTML = `
      <article class="todo-detail" data-status="${escapeHtml(todo.status)}">
        <div class="todo-detail-actions">${actions}</div>
        <div class="todo-detail-head">
          <p class="todo-detail-kicker"><span class="todo-status-chip" data-status="${escapeHtml(todo.status)}">${todo.status === "open" ? "未完成" : STATUS_LABEL[todo.status]}</span>${timing}</p>
          <h2>${escapeHtml(todo.title)}</h2>
        </div>
        <dl class="detail-facts todo-facts">
          ${fact("关联申请", where || "未关联申请信息", ' class="is-wide"')}
          ${fact("到期", escapeHtml(describeDue(todo)), ' class="is-wide"')}
          ${fact("到期方式", escapeHtml(PRECISION_LABEL[todo.duePrecision] ?? todo.duePrecision))}
          ${fact("时区", zone)}
          ${fact("提醒时刻", escapeHtml(describeRemindAt(todo)))}
          ${fact("面试轮次", todo.interviewRound ? `第 ${todo.interviewRound} 轮` : "未设")}
        </dl>
        <div class="todo-reminder" data-tone="${reminder.tone}">${ICON.bell}<div><strong>系统提醒</strong><p>${escapeHtml(reminder.text)}</p></div></div>
      </article>`;
  }

  function render() {
    renderList();
    renderDetail();
  }

  async function refresh() {
    try {
      // 取全部状态，筛选在本地做：这样筛选按钮上能写数量，也分得清「一条都没有」
      // 和「这个状态下没有」。
      todos = await invoke<TodoView[]>("list_todos_cmd", { applicationId: null, status: "all" });
      loaded = true;
    } catch (error) {
      say({ tone: "warn", text: `读取待办失败：${invokeError(error)}` });
      loaded = true;
      todos = [];
    }
    if (selectedId && !todos.some((todo) => todo.id === selectedId)) selectedId = null;
    if (!selectedId) selectedId = firstShown();
    render();
  }

  async function loadApplications() {
    try {
      // 命令签名是 `args: ListApplicationsArgs`，Tauri 按参数名取值——直接传 {}
      // 在真的桌面端会失败，申请下拉是空的，于是新建待办必然报「缺 applicationId」。
      const page = await invoke<Page<ApplicationSummary>>("list_applications_cmd", {
        args: { limit: 200, offset: 0 },
      });
      applications = page?.items ?? [];
      applicationsLoaded = true;
    } catch (error) {
      applications = [];
      applicationsLoaded = false;
      say({ tone: "warn", text: `读取申请列表失败：${invokeError(error)}` });
    }
    fillApplications();
  }

  function fillApplications(keep?: string) {
    const options = applications
      .map(
        (app) =>
          `<option value="${escapeHtml(app.id)}">${escapeHtml(app.company)} · ${escapeHtml(app.title)}</option>`,
      )
      .join("");
    applicationSelect.innerHTML = `<option value="">请选择一条申请…</option>${options}`;
    if (keep !== undefined) applicationSelect.value = keep;
  }

  async function loadDigest() {
    try {
      const result = await invoke<OverdueDigest>("overdue_digest_cmd", {});
      const message = describeDigest(result.todos.length, result.more);
      digest.hidden = !message;
      if (message) {
        digest.textContent = message.text;
        digest.className = `note ${message.tone}`;
      }
    } catch {
      // 汇总拿不到不该挡住整个视图。
      digest.hidden = true;
    }
  }

  function argsFromForm() {
    const precision = precisionSelect.value;
    const zone = valueOf("todo-timezone").trim() || null;
    const round = valueOf("todo-round").trim();
    return {
      title: valueOf("todo-title").trim(),
      duePrecision: precision,
      dueDate: precision === "date" ? valueOf("todo-date") || null : null,
      // datetime-local 只是一串墙钟文字，没有时区。它属于**这条待办的时区**
      // （没填就按本机），不是无条件按本机解释——否则给上海的面试在纽约的机器上
      // 会存成差 12 小时的时刻。
      dueAtUtc:
        precision === "datetime" ? localInputToUtc(valueOf("todo-datetime"), zone) : null,
      // 编辑时这几项都显式发出去：命令层把「没给」当成「别动」，显式的 null 才是
      // 「清空」。否则用户删掉提醒时刻、时区或轮次会被悄悄保留。
      timeZone: zone,
      remindAtUtc: localInputToUtc(valueOf("todo-remind"), zone),
      interviewRound: round === "" ? null : Number(round),
    };
  }

  /** 提交前先在本地拦一遍，错误就近说，输入一个字都不丢。 */
  function formProblem(args: ReturnType<typeof argsFromForm>): { text: string; field: string } | null {
    if (!editing && !applicationSelect.value) {
      return { text: "请选择这条待办属于哪条申请。", field: "todo-application" };
    }
    if (!args.title) return { text: "待办要有一个标题。", field: "todo-title" };
    if (args.duePrecision === "date" && !args.dueDate) {
      return { text: "选了「只有日期」，请填上日期。", field: "todo-date" };
    }
    if (args.duePrecision === "datetime" && !args.dueAtUtc) {
      return { text: "选了「具体到几点」，请填上完整的日期和时刻。", field: "todo-datetime" };
    }
    if (args.timeZone && !knownTimeZone(args.timeZone)) {
      return { text: "认不出这个时区。请写成 IANA 名称，例如 Asia/Shanghai；留空按本机时区。", field: "todo-timezone" };
    }
    if (valueOf("todo-remind") && !args.remindAtUtc) {
      return { text: "提醒时刻不完整，请补全或清空。", field: "todo-remind" };
    }
    if (args.interviewRound !== null && !(Number.isInteger(args.interviewRound) && args.interviewRound >= 1 && args.interviewRound <= 99)) {
      return { text: "面试轮次是 1 到 99 的整数，不需要就留空。", field: "todo-round" };
    }
    return null;
  }

  function setFormBusy(busy: boolean) {
    form
      .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button")
      .forEach((field) => {
        field.disabled = busy;
      });
    const submit = must<HTMLButtonElement>("todo-submit");
    submit.disabled = busy || (!editing && applicationsLoaded && !applications.length);
    applicationSelect.disabled = busy || editing !== null;
    submit.textContent = busy ? "正在保存…" : editing ? "保存修改" : "添加待办";
    form.setAttribute("aria-busy", String(busy));
  }

  function resetForm() {
    editing = null;
    form.reset();
    fillApplications("");
    syncPrecision();
    sayInForm(null);
    must("todo-form-heading").textContent = "新增待办";
    must("todo-form-intro").textContent = "关联一条申请，写清楚做什么、什么时候。";
    const noApps = applicationsLoaded && !applications.length;
    must("todo-no-apps").hidden = !noApps;
    must("todo-application-hint").hidden = true;
    must("todo-edit-note").hidden = true;
    input("todo-timezone").placeholder = localTimeZone()
      ? `留空按本机时区（${localTimeZone()}）`
      : "留空按本机时区，例如 Asia/Shanghai";
    setFormBusy(false);
  }

  function openDialog() {
    const active = document.activeElement;
    opener = active && "focus" in active ? (active as HTMLElement) : null;
    if (!dialog.open) dialog.showModal();
  }

  function closeDialog() {
    dialog.close();
    resetForm();
    if (opener?.isConnected) opener.focus();
    opener = null;
  }

  function openCreate() {
    if (saving || editLoading) return;
    resetForm();
    openDialog();
    if (applicationsLoaded && !applications.length) maybe("todo-go-applications")?.focus();
    else applicationSelect.focus();
  }

  async function openEdit(id: string) {
    editLoading = true;
    try {
      const fresh = await invoke<TodoView[]>("list_todos_cmd", { applicationId: null, status: "all" });
      const todo = fresh.find((entry) => entry.id === id);
      if (!todo) {
        say({ tone: "warn", text: "这条待办已经不在了，列表已刷新。" });
        todos = fresh;
        render();
        return;
      }
      resetForm();
      editing = id;
      // 编辑时关联申请只读：命令层不支持把待办挪到另一条申请。下拉里可能没有这条
      // 申请（已进回收站或超出前 200 条），那就临时补一个选项，免得显示成空白。
      if (!applications.some((app) => app.id === todo.applicationId)) {
        const label = [todo.company, todo.position].filter(Boolean).join(" · ") || "原关联申请";
        applicationSelect.insertAdjacentHTML(
          "beforeend",
          `<option value="${escapeHtml(todo.applicationId)}">${escapeHtml(label)}</option>`,
        );
      }
      applicationSelect.value = todo.applicationId;
      input("todo-title").value = todo.title;
      precisionSelect.value = todo.duePrecision;
      dateInput.value = todo.dueDate ?? "";
      // 存的是 UTC，控件要的是墙钟。直接把 ISO 串切前 16 位塞进去，保存时又被
      // 按本机重新解释一遍，到期时间会平移一个时区偏移。
      datetimeInput.value = todo.dueAtUtc ? utcToLocalInput(todo.dueAtUtc, todo.timeZone) : "";
      input("todo-timezone").value = todo.timeZone ?? "";
      // 提醒时刻也要回填，否则用户看不到现在设的是几点，一保存还会被当成「清空」。
      input("todo-remind").value = todo.remindAtUtc
        ? utcToLocalInput(todo.remindAtUtc, todo.timeZone)
        : "";
      input("todo-round").value = todo.interviewRound ? String(todo.interviewRound) : "";
      syncPrecision();
      must("todo-form-heading").textContent = "编辑待办";
      must("todo-form-intro").textContent = "修改标题、到期时间或提醒。";
      must("todo-no-apps").hidden = true;
      must("todo-application-hint").hidden = false;
      must("todo-edit-note").hidden = false;
      setFormBusy(false);
      openDialog();
      input("todo-title").focus();
    } catch (error) {
      say({ tone: "warn", text: `读取待办失败：${invokeError(error)}` });
    } finally {
      editLoading = false;
    }
  }

  async function changeStatus(id: string, next: TodoStatus) {
    if (acting) return;
    acting = true;
    detail.setAttribute("aria-busy", "true");
    detail.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((button) => {
      button.disabled = true;
    });
    let result: TodoWriteResult;
    try {
      result = await invoke<TodoWriteResult>("set_todo_status_cmd", { id, status: next });
    } catch (error) {
      say({ tone: "warn", text: `操作失败：${invokeError(error)}` });
      acting = false;
      detail.removeAttribute("aria-busy");
      renderDetail();
      return;
    }
    // 写完就放开：接下来重画出来的按钮（比如「重新打开」）必须马上能点，
    // 不能等逾期汇总也读完才响应。
    acting = false;
    detail.removeAttribute("aria-busy");
    say(describeStatusChange(next, result?.reminderProblem));
    // 状态改完仍然停在这一条上：完成的那条从「未完成」里消失了，详情还在，
    // 点错了可以直接在这里重新打开。
    selectedId = id;
    await refresh();
    await loadDigest();
  }

  async function onAction(event: Event) {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("button[data-todo]");
    if (!button) return;
    const id = button.dataset.todo ?? "";
    const act = button.dataset.act ?? "";
    if (act === "select") {
      selectedId = id;
      render();
      return;
    }
    if (saving || editLoading) return;
    if (act === "edit") {
      await openEdit(id);
      return;
    }
    if (act === "done" || act === "cancelled" || act === "open") {
      selectedId = id;
      await changeStatus(id, act);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    const args = argsFromForm();
    const problem = formProblem(args);
    if (problem) {
      sayInForm({ tone: "warn", text: problem.text });
      maybe(problem.field)?.focus();
      return;
    }
    sayInForm(null);
    saving = true;
    setFormBusy(true);
    const wasEditing = editing;
    try {
      const result = wasEditing
        ? await invoke<TodoWriteResult>("edit_todo_cmd", { args: { id: wasEditing, ...args } })
        : await invoke<TodoWriteResult>("create_todo_cmd", {
            args: { applicationId: applicationSelect.value, ...args },
          });
      say(describeSave(wasEditing ? "updated" : "created", result?.reminderProblem));
      saving = false;
      closeDialog();
      selectedId = result?.todo?.id ?? wasEditing ?? selectedId;
      await refresh();
      await loadDigest();
    } catch (error) {
      // 失败时弹窗不关、输入一个字不丢，错误就写在按钮上方。
      sayInForm({ tone: "warn", text: `保存失败：${invokeError(error)}` });
    } finally {
      saving = false;
      if (dialog.open) setFormBusy(false);
    }
  });

  function cancel(event: Event) {
    event.preventDefault();
    if (saving) return;
    closeDialog();
  }
  must("todo-cancel").addEventListener("click", cancel);
  dialog.addEventListener("cancel", cancel);
  must("todo-new").addEventListener("click", openCreate);
  maybe("todo-go-applications")?.addEventListener("click", () => {
    if (saving) return;
    closeDialog();
    createApplication?.();
  });

  list.addEventListener("click", (event) => {
    const empty = (event.target as HTMLElement | null)?.closest<HTMLElement>("button[data-empty-act]");
    if (empty) {
      if (empty.dataset.emptyAct === "application") createApplication?.();
      else openCreate();
      return;
    }
    void onAction(event);
  });
  detail.addEventListener("click", (event) => void onAction(event));
  filterGroup.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("button[data-filter]");
    const next = button?.dataset.filter as TodoFilter | undefined;
    if (!next || next === filter) return;
    filter = next;
    // 切了筛选，原来选中的那条不在新列表里了就换成新列表的第一条。
    if (!visibleTodos().some((todo) => todo.id === selectedId)) selectedId = firstShown();
    render();
  });
  precisionSelect.addEventListener("change", syncPrecision);

  renderList();

  return async function show() {
    try {
      capability = await invoke<ReminderCapability>("reminder_capability_cmd", {});
    } catch {
      capability = { available: false, reason: "读不到系统通知的状态。" };
    }
    renderCapability();
    syncPrecision();
    await loadApplications();
    await loadDigest();
    await refresh();
  };
}
