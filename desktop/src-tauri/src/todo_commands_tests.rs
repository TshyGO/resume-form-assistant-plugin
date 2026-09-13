//! D10 命令层的回归测试。
//!
//! 调度器用一个记账用的假实现：真正要验的是「什么时候登记、什么时候撤销、
//! 登记不上时记成什么」，不是 Toast 长什么样。

use super::*;
use crate::commands::{create_application, open_store};
use reminders::{Capability, ScheduledHandle};
use serde_json::json;
use std::sync::Mutex;

/// 记下每一次登记与撤销，并且可以被设成「这台机器做不到」。
#[derive(Default)]
struct FakeScheduler {
    scheduled: Mutex<Vec<ReminderRequest>>,
    cancelled: Mutex<Vec<String>>,
    cancel_all_calls: Mutex<usize>,
    unavailable: Option<String>,
}

impl FakeScheduler {
    fn unavailable(reason: &str) -> Self {
        Self {
            unavailable: Some(reason.into()),
            ..Default::default()
        }
    }

    fn scheduled(&self) -> Vec<ReminderRequest> {
        self.scheduled.lock().unwrap().clone()
    }

    fn cancelled(&self) -> Vec<String> {
        self.cancelled.lock().unwrap().clone()
    }
}

impl ReminderScheduler for FakeScheduler {
    fn capability(&self) -> Capability {
        match &self.unavailable {
            Some(reason) => Capability::Unavailable {
                reason: reason.clone(),
            },
            None => Capability::Available,
        }
    }

    fn schedule(&self, request: &ReminderRequest) -> Result<ScheduledHandle, ReminderError> {
        if let Some(reason) = &self.unavailable {
            return Err(ReminderError::Unavailable(reason.clone()));
        }
        self.scheduled.lock().unwrap().push(request.clone());
        Ok(ScheduledHandle::new(format!(
            "fake:{}:{}",
            request.todo_id,
            plan::to_storage(&request.fire_at)
        )))
    }

    fn cancel(&self, handle: &ScheduledHandle) -> Result<(), ReminderError> {
        self.cancelled.lock().unwrap().push(handle.as_str().into());
        Ok(())
    }

    fn cancel_all(&self) -> Result<(), ReminderError> {
        *self.cancel_all_calls.lock().unwrap() += 1;
        Ok(())
    }
}

fn now() -> OffsetDateTime {
    time::macros::datetime!(2026-09-13 02:00 UTC)
}

fn archive() -> (tempfile::TempDir, ArchiveStore, String) {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(
        &dir.path().join("archive"),
        &dir.path().join("current.json"),
    )
    .unwrap();
    let app = create_application(
        &store,
        serde_json::from_value(json!({ "company": "合成公司", "title": "后端工程师" })).unwrap(),
    )
    .unwrap()
    .application
    .unwrap()
    .id
    .clone();
    (dir, store, app)
}

fn new_args(app: &str, precision: &str, at: Option<&str>, date: Option<&str>) -> NewTodoArgs {
    NewTodoArgs {
        application_id: app.into(),
        title: "一面".into(),
        due_precision: Some(precision.into()),
        due_at_utc: at.map(str::to_string),
        due_date: date.map(str::to_string),
        time_zone: Some("Asia/Shanghai".into()),
        remind_at_utc: None,
        interview_round: None,
        source_event_id: None,
    }
}

#[test]
fn a_todo_with_a_future_due_time_gets_a_reminder_registered() {
    let (_dir, store, app) = archive();
    let scheduler = FakeScheduler::default();

    let result = create_todo(
        &store,
        &scheduler,
        new_args(&app, "datetime", Some("2026-09-14T02:00:00Z"), None),
        now(),
    )
    .unwrap();

    assert!(result.reminder_problem.is_none());
    assert_eq!(result.todo.reminder_state, "scheduled");
    assert_eq!(
        result.todo.reminder_scheduled_for_utc.as_deref(),
        Some("2026-09-14T02:00:00.000Z")
    );
    // 通知里只有公司、岗位、待办标题。
    let requests = scheduler.scheduled();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].notification_title(), "合成公司 · 后端工程师");
    assert_eq!(requests[0].title, "一面");
}

#[test]
fn a_date_only_todo_keeps_its_precision_but_still_gets_a_morning_reminder() {
    let (_dir, store, app) = archive();
    let scheduler = FakeScheduler::default();

    let result = create_todo(
        &store,
        &scheduler,
        new_args(&app, "date", None, Some("2026-09-20")),
        now(),
    )
    .unwrap();

    assert_eq!(result.todo.due_precision, "date");
    assert_eq!(result.todo.due_date.as_deref(), Some("2026-09-20"));
    assert!(
        result.todo.due_at_utc.is_none(),
        "设了提醒不能把到期偷偷变成精确时刻"
    );
    // 上海早九点 = UTC 01:00。
    assert_eq!(
        result.todo.reminder_scheduled_for_utc.as_deref(),
        Some("2026-09-20T01:00:00.000Z")
    );
}

#[test]
fn a_todo_without_a_due_date_schedules_nothing_and_that_is_not_a_problem() {
    let (_dir, store, app) = archive();
    let scheduler = FakeScheduler::default();

    let result = create_todo(&store, &scheduler, new_args(&app, "none", None, None), now()).unwrap();

    assert_eq!(result.todo.reminder_state, "none");
    assert!(result.reminder_problem.is_none(), "没有到期不是「出问题」");
    assert!(scheduler.scheduled().is_empty());
}

#[test]
fn a_due_time_already_in_the_past_is_left_to_the_overdue_digest() {
    let (_dir, store, app) = archive();
    let scheduler = FakeScheduler::default();

    let result = create_todo(
        &store,
        &scheduler,
        new_args(&app, "datetime", Some("2026-09-01T02:00:00Z"), None),
        now(),
    )
    .unwrap();

    assert_eq!(result.todo.reminder_state, "none");
    assert!(
        scheduler.scheduled().is_empty(),
        "把过去的时刻交给 OS 调度器通常是立刻弹一次，那不是提醒"
    );
}

#[test]
fn rescheduling_cancels_the_previous_plan_before_registering_the_new_one() {
    let (_dir, store, app) = archive();
    let scheduler = FakeScheduler::default();

    let created = create_todo(
        &store,
        &scheduler,
        new_args(&app, "datetime", Some("2026-09-14T02:00:00Z"), None),
        now(),
    )
    .unwrap();
    let first_handle = format!("fake:{}:2026-09-14T02:00:00Z", created.todo.id);

    let moved = edit_todo(
        &store,
        &scheduler,
        EditTodoArgs {
            id: created.todo.id.clone(),
            title: None,
            due_precision: Some("datetime".into()),
            due_at_utc: Some("2026-09-15T06:00:00Z".into()),
            due_date: None,
            time_zone: None,
            remind_at_utc: None,
            interview_round: None,
        },
        now(),
    )
    .unwrap();

    assert_eq!(
        scheduler.cancelled(),
        vec![first_handle],
        "改期不撤旧计划的话，旧时刻照样会弹一次"
    );
    assert_eq!(
        moved.todo.reminder_scheduled_for_utc.as_deref(),
        Some("2026-09-15T06:00:00.000Z")
    );
    assert_eq!(scheduler.scheduled().len(), 2);
}

#[test]
fn finishing_a_todo_cancels_its_reminder_and_reopening_registers_it_again() {
    let (_dir, store, app) = archive();
    let scheduler = FakeScheduler::default();
    let created = create_todo(
        &store,
        &scheduler,
        new_args(&app, "datetime", Some("2026-09-14T02:00:00Z"), None),
        now(),
    )
    .unwrap();

    let done = set_todo_status(&store, &scheduler, &created.todo.id, "done", now()).unwrap();
    assert_eq!(done.todo.status, "done");
    assert_eq!(done.todo.reminder_state, "none");
    assert_eq!(scheduler.cancelled().len(), 1, "做完就不该再弹");

    let reopened = set_todo_status(&store, &scheduler, &created.todo.id, "open", now()).unwrap();
    assert_eq!(reopened.todo.status, "open");
    assert_eq!(reopened.todo.reminder_state, "scheduled");
    assert_eq!(scheduler.scheduled().len(), 2);

    let cancelled = set_todo_status(&store, &scheduler, &created.todo.id, "cancelled", now()).unwrap();
    assert_eq!(cancelled.todo.reminder_state, "none");

    assert!(set_todo_status(&store, &scheduler, &created.todo.id, "无此状态", now()).is_err());
}

#[test]
fn saving_still_succeeds_when_the_reminder_cannot_be_registered() {
    let (_dir, store, app) = archive();
    let scheduler = FakeScheduler::unavailable("系统通知未授权。");

    let result = create_todo(
        &store,
        &scheduler,
        new_args(&app, "datetime", Some("2026-09-14T02:00:00Z"), None),
        now(),
    )
    .unwrap();

    assert_eq!(result.todo.title, "一面", "待办本身必须保存成功");
    assert_eq!(
        result.todo.reminder_state, "unsupported",
        "登记不上就不能记成 scheduled，否则界面会说提醒会响"
    );
    assert!(result.todo.reminder_scheduled_for_utc.is_none());
    assert_eq!(
        result.reminder_problem.as_deref(),
        Some("系统通知未授权。"),
        "界面要能同时说「已保存」和「提醒没登记上，因为 X」"
    );
    // 列表照常可用。
    assert_eq!(list_todos(&store, None, None).unwrap().len(), 1);
}

#[test]
fn a_time_zone_we_do_not_know_is_reported_instead_of_guessed() {
    let (_dir, store, app) = archive();
    let scheduler = FakeScheduler::default();
    let mut args = new_args(&app, "date", None, Some("2026-09-20"));
    args.time_zone = Some("Mars/Olympus_Mons".into());

    let result = create_todo(&store, &scheduler, args, now()).unwrap();

    assert_eq!(result.todo.reminder_state, "unsupported");
    assert!(result.reminder_problem.unwrap().contains("时区"));
    assert!(scheduler.scheduled().is_empty());
}

#[test]
fn the_unified_list_carries_the_company_and_role_of_each_todo() {
    let (_dir, store, app) = archive();
    let scheduler = FakeScheduler::default();
    create_todo(
        &store,
        &scheduler,
        new_args(&app, "date", None, Some("2026-09-20")),
        now(),
    )
    .unwrap();

    let all = list_todos(&store, None, None).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].company.as_deref(), Some("合成公司"));
    assert_eq!(all[0].position.as_deref(), Some("后端工程师"));

    assert_eq!(list_todos(&store, Some(&app), Some("open")).unwrap().len(), 1);
    assert!(list_todos(&store, Some(&app), Some("done")).unwrap().is_empty());
    assert!(list_todos(&store, Some("no-such-app"), None).unwrap().is_empty());
    assert!(list_todos(&store, None, Some("无此状态")).is_err());
}

#[test]
fn the_overdue_digest_reports_each_todo_once() {
    let (_dir, store, app) = archive();
    let scheduler = FakeScheduler::default();
    create_todo(
        &store,
        &scheduler,
        new_args(&app, "datetime", Some("2026-09-01T02:00:00Z"), None),
        now(),
    )
    .unwrap();
    create_todo(
        &store,
        &scheduler,
        new_args(&app, "date", None, Some("2026-09-02")),
        now(),
    )
    .unwrap();

    let first = overdue_digest(&store, now()).unwrap();
    assert_eq!(first.todos.len(), 2, "两种精度都要进汇总");
    assert_eq!(first.more, 0);

    let second = overdue_digest(&store, now()).unwrap();
    assert!(
        second.todos.is_empty(),
        "报过一次就不能每次打开应用再报一遍"
    );
}

#[test]
fn quitting_cancels_every_pending_plan() {
    let scheduler = FakeScheduler::default();
    cancel_all_reminders(&scheduler).unwrap();
    assert_eq!(*scheduler.cancel_all_calls.lock().unwrap(), 1);
}

#[test]
fn the_capability_is_reported_with_its_reason() {
    assert_eq!(
        reminder_capability(&FakeScheduler::default()),
        ReminderCapability {
            available: true,
            reason: None
        }
    );
    assert_eq!(
        reminder_capability(&FakeScheduler::unavailable("这个系统上还没有接入定时通知。")),
        ReminderCapability {
            available: false,
            reason: Some("这个系统上还没有接入定时通知。".into())
        }
    );
}

#[test]
fn a_due_precision_without_its_value_is_refused() {
    let (_dir, store, app) = archive();
    let scheduler = FakeScheduler::default();

    assert!(create_todo(&store, &scheduler, new_args(&app, "datetime", None, None), now()).is_err());
    assert!(create_todo(&store, &scheduler, new_args(&app, "date", None, None), now()).is_err());
    assert!(create_todo(&store, &scheduler, new_args(&app, "每周三", None, None), now()).is_err());
}

#[test]
fn the_json_keys_the_todo_view_exposes_are_pinned() {
    let (_dir, store, app) = archive();
    let scheduler = FakeScheduler::default();
    let created = create_todo(
        &store,
        &scheduler,
        new_args(&app, "date", None, Some("2026-09-20")),
        now(),
    )
    .unwrap();

    let json = serde_json::to_value(&created).unwrap();
    for key in [
        "duePrecision",
        "dueDate",
        "dueAtUtc",
        "remindAtUtc",
        "reminderState",
        "reminderScheduledForUtc",
        "company",
        "position",
    ] {
        assert!(json["todo"].get(key).is_some(), "缺少 {key}：{json}");
    }
    assert!(json.get("reminderProblem").is_some());
    // 前端读不到任何存储路径或句柄。
    let dumped = json.to_string();
    assert!(!dumped.contains("reminderHandle"), "{dumped}");
    assert!(!dumped.contains("archive"), "{dumped}");
}
