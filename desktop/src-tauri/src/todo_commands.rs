//! D10 命令层：待办的增删改查、统一列表、逾期汇总，以及提醒的登记与撤销。
//!
//! 提醒走 `reminders` crate 的接口，这一层**不认识 Toast、也不认识任何平台**
//! （拆分计划决策 1、2；issue #81）。它只做三件事：把待办的到期翻译成一个绝对
//! 时刻、请调度器登记、把结果记回 `todos` 行上。
//!
//! 登记失败不影响保存。用户改一条待办，数据落库就算成功；提醒能不能响是另一件
//! 事，如实记进 `reminder_state` 再由界面说出来（产品需求 §5.4）。

use archive_store::{
    ArchiveStore, ApplicationDetail, NewTodo, ReminderState, Todo, TodoDue, TodoPatch, TodoStatus,
};
use reminders::{
    plan, Capability, Due, ReminderError, ReminderRequest, ReminderScheduler, ScheduledHandle,
};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, Time, UtcOffset};

use crate::commands::CommandError;

/// 只有日历日的待办默认在当天早上九点提醒（拆分计划 Q3）。
pub const DEFAULT_REMIND_LOCAL_TIME: Time = time::macros::time!(09:00);

/// 一次逾期汇总最多带回多少条。多到这个数量说明用户很久没打开了，
/// 界面给个总数就够，不需要把几百条全列出来。
const MAX_DIGEST: u32 = 50;

// --- 给 WebView 的形状 ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodoView {
    pub id: String,
    pub application_id: String,
    pub title: String,
    /// `datetime` / `date` / `none`，和存储层的精度一一对应。
    pub due_precision: String,
    /// precision=datetime 时的 RFC3339 UTC。
    pub due_at_utc: Option<String>,
    /// precision=date 时的 `YYYY-MM-DD`。**没有时刻**，界面不许显示成 00:00。
    pub due_date: Option<String>,
    pub time_zone: Option<String>,
    pub remind_at_utc: Option<String>,
    pub status: String,
    pub interview_round: Option<i64>,
    pub source_event_id: Option<String>,
    /// 提醒现在处于什么状态：`none` / `scheduled` / `fired` / `missed` / `unsupported`。
    pub reminder_state: String,
    pub reminder_scheduled_for_utc: Option<String>,
    /// 这条待办属于哪家公司、哪个岗位。统一列表要显示关联申请（#26 范围）。
    pub company: Option<String>,
    pub position: Option<String>,
}

/// 提醒在这台机器上现在能不能响，以及为什么不能。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderCapability {
    pub available: bool,
    /// 不可用时给用户看的一句话。可用时为空。
    pub reason: Option<String>,
}

/// 一次写操作的结果：待办本身，加上这次提醒登记发生了什么。
///
/// 两者分开是有意的：**保存成功、提醒失败**是完全可能的，界面要能同时说出
/// 「已保存」和「提醒没登记上，因为 X」。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodoWriteResult {
    pub todo: TodoView,
    /// 提醒没能登记时的原因；登记成功或本来就不需要提醒时为空。
    pub reminder_problem: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverdueDigest {
    pub todos: Vec<TodoView>,
    /// 还有多少条没列出来（超过一次汇总的上限）。
    pub more: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTodoArgs {
    pub application_id: String,
    pub title: String,
    #[serde(default)]
    pub due_precision: Option<String>,
    #[serde(default)]
    pub due_at_utc: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub remind_at_utc: Option<String>,
    #[serde(default)]
    pub interview_round: Option<i64>,
    /// 由哪个事件创建。D11 确认 AI 建议之后走的就是这个入口，
    /// **不会**另写一套调度（#26 验收第 5 条）。
    #[serde(default)]
    pub source_event_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTodoArgs {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    /// 给了就换到期；不给就不动。
    #[serde(default)]
    pub due_precision: Option<String>,
    #[serde(default)]
    pub due_at_utc: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    /// 显式给空字符串表示清空，不给表示不动。
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub remind_at_utc: Option<String>,
    #[serde(default)]
    pub interview_round: Option<i64>,
}

// --- 到期的解析与回填 -----------------------------------------------------------------------

fn parse_due(
    precision: Option<&str>,
    at_utc: Option<&str>,
    date: Option<&str>,
) -> Result<TodoDue, CommandError> {
    match precision.unwrap_or("none") {
        "datetime" => at_utc
            .filter(|s| !s.trim().is_empty())
            .map(|s| TodoDue::DateTime(s.to_string()))
            .ok_or_else(|| bad("精确到期需要一个时刻。")),
        "date" => date
            .filter(|s| !s.trim().is_empty())
            .map(|s| TodoDue::Date(s.to_string()))
            .ok_or_else(|| bad("按日期到期需要一个日期。")),
        "none" => Ok(TodoDue::None),
        other => Err(bad(&format!("不认识的到期精度 `{other}`。"))),
    }
}

fn bad(message: &str) -> CommandError {
    CommandError {
        code: "VALIDATION".into(),
        message: message.into(),
    }
}

fn store_error(e: impl std::fmt::Display) -> CommandError {
    CommandError {
        code: "STORE_ERROR".into(),
        message: e.to_string(),
    }
}

/// 存储层的到期 → `reminders` 的到期。一行 `match`，换来 reminders crate
/// 不依赖 archive-store。
fn to_plan_due(due: &TodoDue) -> Due {
    match due {
        TodoDue::DateTime(v) => Due::DateTime(v.clone()),
        TodoDue::Date(v) => Due::Date(v.clone()),
        TodoDue::None => Due::None,
    }
}

fn view(todo: &Todo, app: Option<&ApplicationDetail>) -> TodoView {
    let (precision, at_utc, date) = match &todo.due {
        TodoDue::DateTime(v) => ("datetime", Some(v.clone()), None),
        TodoDue::Date(v) => ("date", None, Some(v.clone())),
        TodoDue::None => ("none", None, None),
    };
    TodoView {
        id: todo.id.clone(),
        application_id: todo.application_id.clone(),
        title: todo.title.clone(),
        due_precision: precision.into(),
        due_at_utc: at_utc,
        due_date: date,
        time_zone: todo.time_zone.clone(),
        remind_at_utc: todo.remind_at_utc.clone(),
        status: todo.status.as_str().into(),
        interview_round: todo.interview_round,
        source_event_id: todo.source_event_id.clone(),
        reminder_state: todo.reminder_state.as_str().into(),
        reminder_scheduled_for_utc: todo.reminder_scheduled_for_utc.clone(),
        company: app.map(|a| a.company.clone()),
        position: app.map(|a| a.title.clone()),
    }
}

fn with_application(store: &ArchiveStore, todo: &Todo) -> TodoView {
    let app = store.get_application(&todo.application_id).ok().flatten();
    view(todo, app.as_ref())
}

// --- 提醒的登记与撤销 -----------------------------------------------------------------------

/// 本机当前的 UTC 偏移。时区未知的待办用它兜底。
///
/// `current_local_offset` 在多线程进程里可能拿不到（这是 `time` crate 有意为之的
/// 安全限制），拿不到就退回 UTC —— 宁可算错时区也不要 panic，而且界面本来就
/// 建议用户给待办填时区。
fn local_offset() -> UtcOffset {
    UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC)
}

/// 撤销这条待办上一次登记的计划（如果有）。
///
/// 改期、完成、取消都要先走这一步，否则旧计划照样会弹（#26 验收第 3 条）。
fn cancel_existing(scheduler: &dyn ReminderScheduler, todo: &Todo) {
    if let Some(handle) = todo.reminder_handle.as_deref() {
        // 撤销失败不该挡住用户的操作：句柄可能早就被系统清掉了。
        let _ = scheduler.cancel(&ScheduledHandle::new(handle));
    }
}

/// 按待办当前的样子重新登记提醒，并把结果写回行上。
///
/// 返回「提醒出了什么问题」。返回 `None` 不代表登记成功——也可能是这条待办
/// 本来就不需要提醒（没有到期、已经完成、时刻已过）。
fn reschedule(
    store: &ArchiveStore,
    scheduler: &dyn ReminderScheduler,
    todo: &Todo,
    now: OffsetDateTime,
) -> Result<(Todo, Option<String>), CommandError> {
    cancel_existing(scheduler, todo);

    // 做完或取消的待办不再提醒。
    if todo.status != TodoStatus::Open {
        let cleared = store
            .set_todo_reminder(&todo.id, ReminderState::None, None, None)
            .map_err(store_error)?;
        return Ok((cleared, None));
    }

    let fire = match plan::fire_at(
        &to_plan_due(&todo.due),
        todo.time_zone.as_deref(),
        todo.remind_at_utc.as_deref(),
        DEFAULT_REMIND_LOCAL_TIME,
        local_offset(),
    ) {
        Ok(Some(fire)) => fire,
        // 没有到期也没有提醒时刻，本来就不需要提醒。
        Ok(None) => {
            let cleared = store
                .set_todo_reminder(&todo.id, ReminderState::None, None, None)
                .map_err(store_error)?;
            return Ok((cleared, None));
        }
        // 算不出时刻（时区不认识、被夏令时跳过）——保存已经成功了，如实说。
        Err(e) => {
            let marked = store
                .set_todo_reminder(&todo.id, ReminderState::Unsupported, None, None)
                .map_err(store_error)?;
            return Ok((marked, Some(e.to_string())));
        }
    };

    // 已经过去的时刻不登记：OS 调度器收到过去的时刻通常立刻弹一次，那不是提醒。
    // 它会走打开应用时的逾期汇总。
    if plan::is_past(&fire, now) {
        let cleared = store
            .set_todo_reminder(&todo.id, ReminderState::None, None, None)
            .map_err(store_error)?;
        return Ok((cleared, None));
    }

    let app = store.get_application(&todo.application_id).ok().flatten();
    let request = ReminderRequest {
        todo_id: todo.id.clone(),
        title: todo.title.clone(),
        company: app.as_ref().map(|a| a.company.clone()),
        position: app.as_ref().map(|a| a.title.clone()),
        fire_at: fire.clone(),
    };

    match scheduler.schedule(&request) {
        Ok(handle) => {
            let scheduled = store
                .set_todo_reminder(
                    &todo.id,
                    ReminderState::Scheduled,
                    Some(&plan::to_storage(&fire)),
                    Some(handle.as_str()),
                )
                .map_err(store_error)?;
            Ok((scheduled, None))
        }
        // 登记不上就记成 unsupported，**不是** scheduled。界面据此说明提醒不会响。
        Err(e) => {
            let reason = match &e {
                ReminderError::Unavailable(r) => r.clone(),
                other => other.to_string(),
            };
            let marked = store
                .set_todo_reminder(&todo.id, ReminderState::Unsupported, None, None)
                .map_err(store_error)?;
            Ok((marked, Some(reason)))
        }
    }
}

// --- 命令 ---------------------------------------------------------------------------------

pub fn reminder_capability(scheduler: &dyn ReminderScheduler) -> ReminderCapability {
    match scheduler.capability() {
        Capability::Available => ReminderCapability {
            available: true,
            reason: None,
        },
        Capability::Unavailable { reason } => ReminderCapability {
            available: false,
            reason: Some(reason),
        },
    }
}

pub fn create_todo(
    store: &ArchiveStore,
    scheduler: &dyn ReminderScheduler,
    args: NewTodoArgs,
    now: OffsetDateTime,
) -> Result<TodoWriteResult, CommandError> {
    let due = parse_due(
        args.due_precision.as_deref(),
        args.due_at_utc.as_deref(),
        args.due_date.as_deref(),
    )?;
    let created = store
        .create_todo(NewTodo {
            application_id: args.application_id,
            title: args.title,
            due,
            time_zone: blank_to_none(args.time_zone),
            remind_at_utc: blank_to_none(args.remind_at_utc),
            interview_round: args.interview_round,
            source_event_id: args.source_event_id,
        })
        .map_err(store_error)?;

    let (todo, problem) = reschedule(store, scheduler, &created, now)?;
    Ok(TodoWriteResult {
        todo: with_application(store, &todo),
        reminder_problem: problem,
    })
}

pub fn edit_todo(
    store: &ArchiveStore,
    scheduler: &dyn ReminderScheduler,
    args: EditTodoArgs,
    now: OffsetDateTime,
) -> Result<TodoWriteResult, CommandError> {
    let due = match args.due_precision.as_deref() {
        Some(_) => Some(parse_due(
            args.due_precision.as_deref(),
            args.due_at_utc.as_deref(),
            args.due_date.as_deref(),
        )?),
        None => None,
    };
    let patch = TodoPatch {
        title: args.title,
        due,
        time_zone: args.time_zone.map(blank_to_none_str),
        remind_at_utc: args.remind_at_utc.map(blank_to_none_str),
        interview_round: args.interview_round.map(Some),
    };
    let updated = store.update_todo(&args.id, patch).map_err(store_error)?;

    // 改期之后必须按新的时刻重新登记，旧计划在 reschedule 里先撤掉。
    let (todo, problem) = reschedule(store, scheduler, &updated, now)?;
    Ok(TodoWriteResult {
        todo: with_application(store, &todo),
        reminder_problem: problem,
    })
}

fn blank_to_none(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.trim().is_empty())
}

fn blank_to_none_str(value: String) -> Option<String> {
    Some(value).filter(|s| !s.trim().is_empty())
}

pub fn set_todo_status(
    store: &ArchiveStore,
    scheduler: &dyn ReminderScheduler,
    id: &str,
    status: &str,
    now: OffsetDateTime,
) -> Result<TodoWriteResult, CommandError> {
    let changed = match status {
        "done" => store.complete_todo(id),
        "cancelled" => store.cancel_todo(id),
        "open" => store.reopen_todo(id),
        other => return Err(bad(&format!("不认识的待办状态 `{other}`。"))),
    }
    .map_err(store_error)?;

    let (todo, problem) = reschedule(store, scheduler, &changed, now)?;
    Ok(TodoWriteResult {
        todo: with_application(store, &todo),
        reminder_problem: problem,
    })
}

/// 统一待办列表。`application_id` 为空就是全部申请的。
pub fn list_todos(
    store: &ArchiveStore,
    application_id: Option<&str>,
    status: Option<&str>,
) -> Result<Vec<TodoView>, CommandError> {
    let status = match status {
        None | Some("") | Some("all") => None,
        Some(s) => Some(TodoStatus::parse(s).ok_or_else(|| bad("不认识的待办状态。"))?),
    };
    let todos = store
        .list_todos(application_id, status, None, 1000, 0)
        .map_err(store_error)?;
    Ok(todos
        .iter()
        .map(|t| with_application(store, t))
        .collect())
}

/// 打开应用时的逾期汇总：已经到期、还开着、还没报过的那些，报一次就打上标记。
///
/// #26 范围：「休眠错过则打开应用后一次汇总，不连续弹出大量旧提醒。」
pub fn overdue_digest(
    store: &ArchiveStore,
    now: OffsetDateTime,
) -> Result<OverdueDigest, CommandError> {
    let now_str = plan::to_storage(&reminders::FireAt {
        utc: now,
        wall_clock: time::PrimitiveDateTime::new(now.date(), now.time()),
        time_zone: None,
    });
    // 多取一条，用来判断还有没有更多。
    let mut found = store
        .overdue_unacked(&now_str, MAX_DIGEST + 1)
        .map_err(store_error)?;
    let more = if found.len() as u32 > MAX_DIGEST {
        found.truncate(MAX_DIGEST as usize);
        1
    } else {
        0
    };

    let ids: Vec<String> = found.iter().map(|t| t.id.clone()).collect();
    store.ack_overdue(&ids, &now_str).map_err(store_error)?;

    Ok(OverdueDigest {
        todos: found.iter().map(|t| with_application(store, t)).collect(),
        more,
    })
}

/// 主动退出时撤销所有未触发的计划（产品需求 §5.4）。
pub fn cancel_all_reminders(scheduler: &dyn ReminderScheduler) -> Result<(), CommandError> {
    scheduler.cancel_all().map_err(|e| CommandError {
        code: "REMINDER_ERROR".into(),
        message: e.to_string(),
    })
}

#[cfg(test)]
#[path = "todo_commands_tests.rs"]
mod tests;
