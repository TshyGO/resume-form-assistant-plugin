// D10 待办视图：统一列表、新建/编辑、完成/取消/重开、逾期汇总。
//
// 这个视图**完全不依赖系统通知**。未授权、未启用、平台不支持时它照常可用，
// 只是每条待办旁边如实写着提醒不会响（产品需求 §5.4）。

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
import { input, must, select as selectEl, valueOf } from "./dom.ts";
import { localInputToUtc, utcToLocalInput } from "./zoned.ts";
import type { Message } from "./todos.ts";
import {
  BUCKET_LABEL,
  DELIVERY_WINDOW_NOTE,
  EMPTY_TODOS,
  STATUS_LABEL,
  describeCapability,
  describeDigest,
  describeDue,
  describeReminder,
  describeSave,
  describeStatusChange,
  groupTodos,
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

export function mountTodos(invoke: Invoke, now: () => Date = () => new Date()) {
  const list = must("todo-list");
  const status = must("todo-status");
  const digest = must("todo-digest");
  const reminderNote = must("todo-reminder-note");
  const form = must<HTMLFormElement>("todo-form");
  const applicationSelect = selectEl("todo-application");
  const precisionSelect = selectEl("todo-precision");
  const dateInput = input("todo-date");
  const datetimeInput = input("todo-datetime");
  const filterSelect = selectEl("todo-filter");

  let capability: ReminderCapability = { available: false, reason: null };
  let editing: string | null = null;
  /// 双击提交会建出两条待办、登记两条提醒。一次只让一个请求在飞。
  let saving = false;

  function say(message: Message | null) {
    if (!message) {
      status.textContent = "";
      status.className = "note";
      return;
    }
    status.textContent = message.text;
    status.className = `note ${message.tone}`;
  }

  /** 到期精度决定哪个输入框可用。三个精度互斥，不会同时填两个。 */
  function syncPrecision() {
    const precision = precisionSelect.value;
    dateInput.hidden = precision !== "date";
    datetimeInput.hidden = precision !== "datetime";
  }

  function renderCapability() {
    const message = describeCapability(capability);
    reminderNote.textContent = `${message.text} ${DELIVERY_WINDOW_NOTE}`;
    reminderNote.className = `note ${message.tone}`;
  }

  function card(todo: TodoView): string {
    const reminder = describeReminder(todo, capability);
    const where = [todo.company, todo.position].filter(Boolean).map(escapeHtml).join(" · ");
    const round = todo.interviewRound ? `<span class="chip">第 ${todo.interviewRound} 轮</span>` : "";
    const actions =
      todo.status === "open"
        ? `<button type="button" data-todo="${escapeHtml(todo.id)}" data-act="done">完成</button>
           <button type="button" data-todo="${escapeHtml(todo.id)}" data-act="cancelled">取消</button>
           <button type="button" data-todo="${escapeHtml(todo.id)}" data-act="edit">改期</button>`
        : `<button type="button" data-todo="${escapeHtml(todo.id)}" data-act="open">重新打开</button>`;

    return `
      <article class="todo" data-id="${escapeHtml(todo.id)}">
        <div class="todo-head">
          <strong>${escapeHtml(todo.title)}</strong>
          <span class="chip">${STATUS_LABEL[todo.status]}</span>
          ${round}
        </div>
        <p class="muted">${where || "（未关联申请信息）"}</p>
        <p class="due">${escapeHtml(describeDue(todo))}</p>
        <p class="note ${reminder.tone}">${escapeHtml(reminder.text)}</p>
        <div class="row">${actions}</div>
      </article>
    `;
  }

  function render(todos: TodoView[]) {
    if (!todos.length) {
      list.innerHTML = `<p class="muted">${EMPTY_TODOS}</p>`;
      return;
    }
    list.innerHTML = groupTodos(todos, now())
      .map(
        (group) => `
          <section class="todo-group">
            <h2>${BUCKET_LABEL[group.bucket]}<span class="chip">${group.todos.length}</span></h2>
            ${group.todos.map(card).join("")}
          </section>
        `,
      )
      .join("");
  }

  async function refresh() {
    try {
      const filter = filterSelect.value;
      const todos = await invoke<TodoView[]>("list_todos_cmd", {
        applicationId: null,
        status: filter || "all",
      });
      render(todos);
    } catch (error) {
      say({ tone: "warn", text: `读取待办失败：${invokeError(error)}` });
    }
  }

  async function loadApplications() {
    try {
      // 命令签名是 `args: ListApplicationsArgs`，Tauri 按参数名取值——直接传 {}
      // 在真的桌面端会失败，申请下拉是空的，于是新建待办必然报「缺 applicationId」。
      const page = await invoke<Page<ApplicationSummary>>("list_applications_cmd", {
        args: { limit: 200, offset: 0 },
      });
      applicationSelect.innerHTML = page.items
        .map(
          (app) =>
            `<option value="${escapeHtml(app.id)}">${escapeHtml(app.company)} · ${escapeHtml(app.title)}</option>`,
        )
        .join("");
    } catch (error) {
      say({ tone: "warn", text: `读取申请列表失败：${invokeError(error)}` });
    }
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
    } catch (error) {
      // 汇总拿不到不该挡住整个视图。
      digest.hidden = true;
    }
  }

  function argsFromForm() {
    const precision = precisionSelect.value;
    const zone = valueOf("todo-timezone").trim() || null;
    return {
      title: valueOf("todo-title").trim(),
      duePrecision: precision,
      dueDate: precision === "date" ? valueOf("todo-date") : null,
      // datetime-local 只是一串墙钟文字，没有时区。它属于**这条待办的时区**
      // （没填就按本机），不是无条件按本机解释——否则给上海的面试在纽约的机器上
      // 会存成差 12 小时的时刻。
      dueAtUtc:
        precision === "datetime" ? localInputToUtc(valueOf("todo-datetime"), zone) : null,
      timeZone: zone,
      remindAtUtc: localInputToUtc(valueOf("todo-remind"), zone),
      interviewRound: Number(valueOf("todo-round")) || null,
    };
  }

  function resetForm() {
    editing = null;
    form.reset();
    syncPrecision();
    must("todo-submit").textContent = "添加待办";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    const args = argsFromForm();
    if (!args.title) {
      say({ tone: "warn", text: "待办要有一个标题。" });
      return;
    }
    saving = true;
    const submit = must<HTMLButtonElement>("todo-submit");
    submit.disabled = true;
    try {
      // 编辑时每个可选字段都显式发出去：命令层把「没给」当成「别动」，
      // 只有显式的 null 才是「清空」。否则用户删掉提醒时刻会被悄悄保留。
      const result = editing
        ? await invoke<TodoWriteResult>("edit_todo_cmd", { args: { id: editing, ...args } })
        : await invoke<TodoWriteResult>("create_todo_cmd", {
            args: { applicationId: applicationSelect.value, ...args },
          });
      say(describeSave(editing ? "updated" : "created", result.reminderProblem));
      resetForm();
      await refresh();
    } catch (error) {
      say({ tone: "warn", text: `保存失败：${invokeError(error)}` });
    } finally {
      saving = false;
      submit.disabled = false;
    }
  });

  list.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("button[data-todo]");
    if (!button) return;
    const id = button.dataset.todo ?? "";
    const act = button.dataset.act ?? "";

    if (act === "edit") {
      const todos = await invoke<TodoView[]>("list_todos_cmd", { applicationId: null, status: "all" });
      const todo = todos.find((item) => item.id === id);
      if (!todo) return;
      editing = id;
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
      must("todo-submit").textContent = "保存修改";
      say({ tone: "info", text: "改完点「保存修改」。改期会撤掉原来登记的提醒。" });
      return;
    }

    try {
      const result = await invoke<TodoWriteResult>("set_todo_status_cmd", {
        id,
        status: act,
      });
      say(describeStatusChange(act as TodoStatus, result.reminderProblem));
      await refresh();
    } catch (error) {
      say({ tone: "warn", text: `操作失败：${invokeError(error)}` });
    }
  });

  precisionSelect.addEventListener("change", syncPrecision);
  filterSelect.addEventListener("change", refresh);

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
