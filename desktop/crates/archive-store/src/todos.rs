//! 待办(§8.6)。提醒语义(系统调度/退出取消)归 D10;这里只持久化
//! 待办状态与到期精度(datetime / date / none 三态分列,不伪造时刻)。

use rusqlite::params;

use crate::error::StoreError;
use crate::model::*;
use crate::timeutil::{now_utc, Occurred};
use crate::tx::{new_uuid, StoreTx};

const TODO_COLUMNS: &str = "id, application_id, title, due_precision, due_at_utc, due_date, \
     time_zone, remind_at_utc, status, interview_round, source_event_id, created_at, updated_at, \
     reminder_scheduled_for_utc, reminder_handle, reminder_state, overdue_ack_at";

#[derive(Debug, Clone, Default)]
pub struct TodoPatch {
    pub title: Option<String>,
    pub due: Option<TodoDue>,
    pub time_zone: Option<Option<String>>,
    pub remind_at_utc: Option<Option<String>>,
    pub interview_round: Option<Option<i64>>,
}

fn normalize_reminder(value: Option<&str>) -> Result<Option<String>, StoreError> {
    value
        .map(|s| crate::timeutil::parse_rfc3339(s).map(crate::timeutil::format_timestamp))
        .transpose()
}
fn validate_round(value: Option<i64>) -> Result<(), StoreError> {
    if value.is_some_and(|n| n < 1) {
        return Err(StoreError::Validation(
            "interview round must be positive".into(),
        ));
    }
    Ok(())
}

impl StoreTx<'_> {
    pub fn create_todo(&mut self, input: NewTodo) -> Result<Todo, StoreError> {
        if input.title.trim().is_empty() {
            return Err(StoreError::Validation("todo title is required".into()));
        }
        self.ensure_application(&input.application_id)?;
        if let Some(id) = &input.source_event_id {
            if self.get_event(id)?.application_id.as_deref() != Some(input.application_id.as_str())
            {
                return Err(StoreError::Validation(
                    "todo source event belongs to another application".into(),
                ));
            }
        }
        let remind_at = normalize_reminder(input.remind_at_utc.as_deref())?;
        validate_round(input.interview_round)?;
        let (precision, due_at, due_date) = todo_due_columns(&input.due)?;
        let now = now_utc();
        let id = new_uuid();
        self.conn().execute(
            "INSERT INTO todos (id, application_id, title, due_precision, due_at_utc, due_date, \
             time_zone, remind_at_utc, status, interview_round, source_event_id, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9, ?10, ?11, ?11)",
            params![
                id,
                input.application_id,
                input.title.trim(),
                precision,
                due_at,
                due_date,
                input.time_zone,
                remind_at,
                input.interview_round,
                input.source_event_id,
                now,
            ],
        )?;
        let draft = EventDraft {
            occurred: Occurred::DateTime {
                rfc3339: now.clone(),
                time_zone: None,
            },
            source: EventSource::Manual,
            source_request_id: None,
            actor: Actor::User,
            payload: EventPayload::TodoCreated {
                todo_id: id.clone(),
                title: input.title.trim().to_string(),
            },
        };
        self.append_events(Some(&input.application_id), &[draft], &now)?;
        self.get_todo(&id)?
            .ok_or_else(|| StoreError::Internal("todo vanished in same transaction".into()))
    }

    pub fn get_todo(&self, id: &str) -> Result<Option<Todo>, StoreError> {
        let mut stmt = self.conn().prepare(
            &format!("SELECT {TODO_COLUMNS} FROM todos WHERE id = ?1"),
        )?;
        let mut rows = stmt.query_map(params![id], map_todo_row)?;
        rows.next().transpose().map_err(StoreError::from)
    }

    /// 更新字段(改期/补提醒时间等);不发阶段事件。改期确认事务由调用方
    /// (D04/D11)在同一个事务里自行追加 `interview_rescheduled` 事件。
    pub fn update_todo(&mut self, id: &str, patch: TodoPatch) -> Result<Todo, StoreError> {
        let current = self
            .get_todo(id)?
            .ok_or_else(|| StoreError::NotFound(format!("todo {id}")))?;
        let (precision, due_at, due_date) = match &patch.due {
            Some(due) => todo_due_columns(due)?,
            None => todo_due_columns(&current.due)?,
        };
        let title = patch
            .title
            .as_ref()
            .map(|t| t.trim().to_string())
            .unwrap_or(current.title.clone());
        if title.is_empty() {
            return Err(StoreError::Validation("todo title is required".into()));
        }
        let tz = patch.time_zone.unwrap_or(current.time_zone.clone());
        let remind = patch.remind_at_utc.unwrap_or(current.remind_at_utc.clone());
        let round = patch.interview_round.unwrap_or(current.interview_round);
        let remind = normalize_reminder(remind.as_deref())?;
        validate_round(round)?;
        let now = now_utc();
        self.conn().execute(
            "UPDATE todos SET title = ?1, due_precision = ?2, due_at_utc = ?3, due_date = ?4, \
             time_zone = ?5, remind_at_utc = ?6, interview_round = ?7, updated_at = ?8 WHERE id = ?9",
            params![title, precision, due_at, due_date, tz, remind, round, now, id],
        )?;
        self.get_todo(id)?
            .ok_or_else(|| StoreError::Internal("todo vanished in same transaction".into()))
    }

    pub fn complete_todo(&mut self, id: &str) -> Result<Todo, StoreError> {
        self.set_todo_status(id, TodoStatus::Done, "todo_completed")
    }

    pub fn cancel_todo(&mut self, id: &str) -> Result<Todo, StoreError> {
        self.set_todo_status(id, TodoStatus::Cancelled, "todo_cancelled")
    }

    /// 重新打开一条已完成或已取消的待办(#26 范围)。重开只改状态，**不**恢复
    /// 提醒登记：原来的 OS 计划在完成时就撤销了，要不要再登记由 D10 的命令层
    /// 按当前的到期时刻重新决定。
    pub fn reopen_todo(&mut self, id: &str) -> Result<Todo, StoreError> {
        self.set_todo_status(id, TodoStatus::Open, "todo_reopened")
    }

    fn set_todo_status(
        &mut self,
        id: &str,
        status: TodoStatus,
        event_type: &str,
    ) -> Result<Todo, StoreError> {
        let todo = self
            .get_todo(id)?
            .ok_or_else(|| StoreError::NotFound(format!("todo {id}")))?;
        if todo.status == status {
            return Ok(todo);
        }
        let now = now_utc();
        self.conn().execute(
            "UPDATE todos SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status.as_str(), now, id],
        )?;
        let payload = match status {
            TodoStatus::Done => EventPayload::TodoCompleted {
                todo_id: id.to_string(),
            },
            TodoStatus::Cancelled => EventPayload::TodoCancelled {
                todo_id: id.to_string(),
            },
            TodoStatus::Open => EventPayload::TodoReopened {
                todo_id: id.to_string(),
            },
        };
        let draft = EventDraft {
            occurred: Occurred::DateTime {
                rfc3339: now.clone(),
                time_zone: None,
            },
            source: EventSource::Manual,
            source_request_id: None,
            actor: Actor::User,
            payload,
        };
        let _ = event_type;
        self.append_events(Some(&todo.application_id), &[draft], &now)?;
        self.get_todo(id)?
            .ok_or_else(|| StoreError::Internal("todo vanished in same transaction".into()))
    }

    /// 记下一条待办的提醒登记结果(D10)。这是本机投递状态，不发事件。
    pub fn set_todo_reminder(
        &mut self,
        id: &str,
        state: ReminderState,
        scheduled_for_utc: Option<&str>,
        handle: Option<&str>,
    ) -> Result<Todo, StoreError> {
        let scheduled = normalize_reminder(scheduled_for_utc)?;
        let changed = self.conn().execute(
            "UPDATE todos SET reminder_state = ?1, reminder_scheduled_for_utc = ?2, \
             reminder_handle = ?3, updated_at = ?4 WHERE id = ?5",
            params![state.as_str(), scheduled, handle, now_utc(), id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!("todo {id}")));
        }
        self.get_todo(id)?
            .ok_or_else(|| StoreError::Internal("todo vanished in same transaction".into()))
    }

    /// 逾期汇总报过一次之后打上标记，下次打开应用不再重复报同一批。
    ///
    /// 条件和 `overdue_unacked` 完全一致，不是只按 id 盖章：拿到列表之后用户可能
    /// 把某条改期到将来或者标记完成，这时候再盖上「已汇总」，它以后真逾期了就
    /// 永远不会再被报出来了。
    pub fn ack_overdue(&mut self, ids: &[String], now: &str) -> Result<usize, StoreError> {
        let day = now.get(..10).unwrap_or(now).to_string();
        let mut acked = 0;
        for id in ids {
            acked += self.conn().execute(
                "UPDATE todos SET overdue_ack_at = ?1 \
                 WHERE id = ?2 AND overdue_ack_at IS NULL AND status = 'open' \
                   AND ((due_precision = 'datetime' AND due_at_utc IS NOT NULL AND due_at_utc < ?1) \
                     OR (due_precision = 'date' AND due_date IS NOT NULL AND due_date < ?3))",
                params![now, id, day],
            )?;
        }
        Ok(acked)
    }

    /// 清空所有待办的提醒记账（D12 恢复后调用）。
    ///
    /// 这三列是**本机投递状态**：句柄指向的是原来那台机器上的 OS 计划。带着它们
    /// 恢复到别处，界面会说「将在 X 点提醒」而其实什么都没登记，撤销时还拿着一个
    /// 不存在的句柄。清零之后由命令层按每条待办当前的到期重新登记一遍。
    ///
    /// `overdue_ack_at` **不清**：它记的是「这条已经跟用户说过了」，换台机器也
    /// 仍然说过了，再报一遍只会变成 #28 说的那种「瞬间重复轰炸」。
    pub fn clear_todo_reminders(&mut self) -> Result<usize, StoreError> {
        let changed = self.conn().execute(
            "UPDATE todos SET reminder_state = 'none', reminder_scheduled_for_utc = NULL, \
             reminder_handle = NULL WHERE reminder_state != 'none' OR reminder_handle IS NOT NULL",
            [],
        )?;
        Ok(changed)
    }

    /// 已经到期、还没做完、也还没报过的待办——逾期汇总要的就是这一批。
    pub fn overdue_unacked(&self, now_utc_str: &str, limit: u32) -> Result<Vec<Todo>, StoreError> {
        let day = now_utc_str.get(..10).unwrap_or(now_utc_str).to_string();
        let limit = limit.clamp(1, 1000);
        let sql = format!(
            "SELECT {TODO_COLUMNS} FROM todos \
             WHERE status = 'open' AND overdue_ack_at IS NULL \
               AND ((due_precision = 'datetime' AND due_at_utc IS NOT NULL AND due_at_utc < ?1) \
                 OR (due_precision = 'date' AND due_date IS NOT NULL AND due_date < ?2)) \
             ORDER BY COALESCE(due_at_utc, due_date) ASC LIMIT {limit}"
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let rows = stmt.query_map(params![now_utc_str, day], map_todo_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// 待办列表(供 D04/D10):可按申请、状态、到期过滤;SQL 层分页。
    pub fn list_todos(
        &self,
        application_id: Option<&str>,
        status: Option<TodoStatus>,
        due_before_utc: Option<&str>,
        limit: u32,
        offset: u64,
    ) -> Result<Vec<Todo>, StoreError> {
        let mut clauses: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(app) = application_id {
            args.push(Box::new(app.to_string()));
            clauses.push(format!("application_id = ?{}", args.len()));
        }
        if let Some(st) = status {
            args.push(Box::new(st.as_str().to_string()));
            clauses.push(format!("status = ?{}", args.len()));
        }
        // 到期过滤必须把 date 精度也算进来，否则「周五截止」这类待办永远进不了
        // 逾期汇总。date 精度比的是日历日，**不**把 due_date 当成当天零点去和时刻比。
        //
        // 两种精度都用严格小于，和 `overdue_unacked` 一致：只有日历日的待办在
        // 当天还没到期(那一天还没过完)，把今天的算进「已到期」会提前报警。要
        // 「今天及之前」就传明天零点。
        if let Some(before) = due_before_utc {
            let day = before.get(..10).unwrap_or(before).to_string();
            args.push(Box::new(before.to_string()));
            let at = args.len();
            args.push(Box::new(day));
            let date = args.len();
            clauses.push(format!(
                "((due_precision = 'datetime' AND due_at_utc IS NOT NULL AND due_at_utc < ?{at}) \
                  OR (due_precision = 'date' AND due_date IS NOT NULL AND due_date < ?{date}))"
            ));
        }
        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let limit = limit.clamp(1, 1000);
        // 待办列表按「什么时候要做」排，不是按什么时候建的。没有到期的排在最后
        // (COALESCE 出来的排序键为空)，同批次内再按创建时间稳定排序。
        let sql = format!(
            "SELECT {TODO_COLUMNS} FROM todos {where_sql} \
             ORDER BY (due_precision = 'none') ASC, \
                      COALESCE(due_at_utc, due_date) ASC, \
                      created_at ASC \
             LIMIT {limit} OFFSET {offset}"
        );
        let map = args.iter().map(|b| b.as_ref()).collect::<Vec<_>>();
        let mut stmt = self.conn().prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(map.iter().copied()),
            map_todo_row,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }
}

/// TodoDue → (precision, due_at_utc, due_date)。
fn todo_due_columns(
    due: &TodoDue,
) -> Result<(&'static str, Option<String>, Option<String>), StoreError> {
    match due {
        TodoDue::DateTime(rfc3339) => {
            let utc = crate::timeutil::parse_rfc3339(rfc3339)?;
            Ok((
                "datetime",
                Some(crate::timeutil::format_timestamp(utc)),
                None,
            ))
        }
        TodoDue::Date(date) => {
            time::Date::parse(date, crate::timeutil::date_format())
                .map_err(|_| StoreError::Validation(format!("invalid date `{date}`")))?;
            Ok(("date", None, Some(date.clone())))
        }
        TodoDue::None => Ok(("none", None, None)),
    }
}

pub(crate) fn map_todo_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Todo> {
    let precision: String = r.get(3)?;
    let due_at: Option<String> = r.get(4)?;
    let due_date: Option<String> = r.get(5)?;
    let status_raw: String = r.get(8)?;
    let due = match precision.as_str() {
        "datetime" => TodoDue::DateTime(due_at.unwrap_or_default()),
        "date" => TodoDue::Date(due_date.unwrap_or_default()),
        _ => TodoDue::None,
    };
    Ok(Todo {
        id: r.get(0)?,
        application_id: r.get(1)?,
        title: r.get(2)?,
        due,
        time_zone: r.get(6)?,
        remind_at_utc: r.get(7)?,
        status: TodoStatus::parse(&status_raw).unwrap_or(TodoStatus::Open),
        interview_round: r.get(9)?,
        source_event_id: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
        reminder_scheduled_for_utc: r.get(13)?,
        reminder_handle: r.get(14)?,
        reminder_state: ReminderState::from_str(&r.get::<_, String>(15)?),
        overdue_ack_at: r.get(16)?,
    })
}
