//! 时间语义。D10 真正的难点在这里，不在界面。

use reminders::plan::{fire_at, is_past, to_storage, Due, PlanError};
use reminders::{Capability, ReminderRequest, ReminderScheduler, ScheduledHandle, Unsupported};
use time::macros::{datetime, time};
use time::{OffsetDateTime, UtcOffset};

const NINE_AM: time::Time = time!(09:00);
const SHANGHAI: Option<&str> = Some("Asia/Shanghai");
/// 有夏令时的时区，用来验证换季前后不是恒定 24 小时。
const NEW_YORK: Option<&str> = Some("America/New_York");

fn plan(due: &Due, tz: Option<&str>, remind: Option<&str>) -> Option<reminders::FireAt> {
    fire_at(due, tz, remind, NINE_AM, UtcOffset::UTC).unwrap()
}

#[test]
fn a_todo_with_no_due_date_has_nothing_to_remind_about() {
    assert!(plan(&Due::None, SHANGHAI, None).is_none());
}

#[test]
fn a_todo_with_no_due_date_can_still_have_an_explicit_reminder() {
    // 「这件事没有截止日期，但周日早上提醒我看一眼」是成立的需求。
    let fire = plan(&Due::None, SHANGHAI, Some("2026-09-20T01:00:00Z")).unwrap();

    assert_eq!(fire.utc, datetime!(2026-09-20 01:00 UTC));
    assert_eq!(fire.wall_clock, datetime!(2026-09-20 09:00));
}

#[test]
fn an_exact_due_time_is_the_reminder_time() {
    let fire = plan(&Due::DateTime("2026-09-14T02:00:00Z".into()), SHANGHAI, None).unwrap();
    assert_eq!(fire.utc, datetime!(2026-09-14 02:00 UTC));
    // 上海是 UTC+8，墙钟应该是当天上午十点。
    assert_eq!(fire.wall_clock, datetime!(2026-09-14 10:00));
}

#[test]
fn a_date_only_todo_is_reminded_at_the_default_local_hour_not_at_midnight() {
    let fire = plan(&Due::Date("2026-09-20".into()), SHANGHAI, None).unwrap();

    assert_eq!(
        fire.wall_clock,
        datetime!(2026-09-20 09:00),
        "只有日历日时提醒落在当地默认时刻"
    );
    assert_eq!(
        fire.utc,
        datetime!(2026-09-20 01:00 UTC),
        "上海 09:00 是 UTC 01:00；把 date 当成当天零点会提前九个小时"
    );
}

#[test]
fn an_explicit_reminder_time_wins_over_the_due_date() {
    // 「不知道几点截止」和「早上七点提醒我」是两条独立信息。
    let fire = plan(
        &Due::Date("2026-09-20".into()),
        SHANGHAI,
        Some("2026-09-19T23:00:00Z"),
    )
    .unwrap();

    assert_eq!(fire.utc, datetime!(2026-09-19 23:00 UTC));
    assert_eq!(fire.wall_clock, datetime!(2026-09-20 07:00));
}

#[test]
fn an_explicit_reminder_time_also_wins_over_an_exact_due_time() {
    let fire = plan(
        &Due::DateTime("2026-09-14T02:00:00Z".into()),
        SHANGHAI,
        Some("2026-09-13T02:00:00Z"),
    )
    .unwrap();
    assert_eq!(fire.utc, datetime!(2026-09-13 02:00 UTC));
}

#[test]
fn the_same_local_hour_is_a_different_instant_across_a_daylight_saving_change() {
    // 纽约 2026-03-08 凌晨 02:00 往前跳到 03:00。换季前后的「早上九点」
    // 对应的 UTC 时刻差的不是 24 小时。
    let before = plan(&Due::Date("2026-03-07".into()), NEW_YORK, None).unwrap();
    let after = plan(&Due::Date("2026-03-09".into()), NEW_YORK, None).unwrap();

    assert_eq!(before.wall_clock, datetime!(2026-03-07 09:00));
    assert_eq!(after.wall_clock, datetime!(2026-03-09 09:00));
    assert_eq!(before.utc, datetime!(2026-03-07 14:00 UTC), "EST = UTC-5");
    assert_eq!(after.utc, datetime!(2026-03-09 13:00 UTC), "EDT = UTC-4");

    let gap = after.utc - before.utc;
    assert_ne!(
        gap,
        time::Duration::hours(48),
        "跨夏令时的两天之间不是恒定 48 小时；按固定偏移算会差一小时"
    );
    assert_eq!(gap, time::Duration::hours(47));
}

#[test]
fn a_local_hour_that_does_not_exist_is_refused_instead_of_guessed() {
    // 纽约 2026-03-08 的 02:30 被夏令时跳过，这一刻当地不存在。
    let err = fire_at(
        &Due::Date("2026-03-08".into()),
        NEW_YORK,
        None,
        time!(02:30),
        UtcOffset::UTC,
    )
    .unwrap_err();

    assert!(matches!(err, PlanError::SkippedByDaylightSaving(_)), "{err:?}");
    assert!(err.to_string().contains("夏令时"));
}

#[test]
fn the_repeated_hour_in_autumn_picks_the_earlier_one() {
    // 纽约 2026-11-01 的 01:30 出现两次。取第一次：宁可早一小时，不要晚。
    let fire = fire_at(
        &Due::Date("2026-11-01".into()),
        NEW_YORK,
        None,
        time!(01:30),
        UtcOffset::UTC,
    )
    .unwrap()
    .unwrap();

    assert_eq!(fire.utc, datetime!(2026-11-01 05:30 UTC), "EDT 那一次");
}

#[test]
fn an_unknown_time_zone_is_an_error_not_a_silent_utc_fallback() {
    let err = fire_at(
        &Due::Date("2026-09-20".into()),
        Some("Mars/Olympus_Mons"),
        None,
        NINE_AM,
        UtcOffset::UTC,
    )
    .unwrap_err();

    assert!(matches!(err, PlanError::UnknownTimeZone(_)), "{err:?}");
}

#[test]
fn without_a_time_zone_the_caller_supplied_offset_is_used() {
    let plus_eight = UtcOffset::from_hms(8, 0, 0).unwrap();
    let fire = fire_at(&Due::Date("2026-09-20".into()), None, None, NINE_AM, plus_eight)
        .unwrap()
        .unwrap();

    assert_eq!(fire.utc, datetime!(2026-09-20 01:00 UTC));
    assert_eq!(fire.wall_clock, datetime!(2026-09-20 09:00));
    assert!(fire.time_zone.is_none(), "用兜底偏移算的就别谎称知道时区");
}

#[test]
fn garbage_times_are_reported_rather_than_silently_dropped() {
    for bad in ["", "not-a-date", "2026-02-30"] {
        assert!(
            fire_at(&Due::Date(bad.into()), SHANGHAI, None, NINE_AM, UtcOffset::UTC).is_err(),
            "{bad:?} 不该被当成一个日期"
        );
    }
    assert!(fire_at(
        &Due::DateTime("昨天".into()),
        SHANGHAI,
        None,
        NINE_AM,
        UtcOffset::UTC
    )
    .is_err());
}

#[test]
fn a_time_that_has_already_passed_is_recognised_as_past() {
    let now = datetime!(2026-09-13 02:00 UTC);
    let past = plan(&Due::DateTime("2026-09-01T00:00:00Z".into()), SHANGHAI, None).unwrap();
    let future = plan(&Due::DateTime("2026-09-30T00:00:00Z".into()), SHANGHAI, None).unwrap();

    assert!(is_past(&past, now));
    assert!(!is_past(&future, now));
    // 边界：正好现在算过去，OS 调度器收到一个此刻的时刻通常会立即弹。
    let exactly_now = plan(&Due::DateTime("2026-09-13T02:00:00Z".into()), SHANGHAI, None).unwrap();
    assert!(is_past(&exactly_now, now));
}

#[test]
fn the_stored_form_round_trips_through_rfc3339() {
    let fire = plan(&Due::DateTime("2026-09-14T02:00:00Z".into()), SHANGHAI, None).unwrap();
    let stored = to_storage(&fire);

    assert_eq!(
        OffsetDateTime::parse(&stored, &time::format_description::well_known::Rfc3339).unwrap(),
        fire.utc
    );
}

// --- 接口本身 -----------------------------------------------------------------------------

fn request() -> ReminderRequest {
    ReminderRequest {
        todo_id: "todo-1".into(),
        title: "一面".into(),
        company: Some("合成公司".into()),
        position: Some("后端工程师".into()),
        fire_at: plan(&Due::DateTime("2026-09-14T02:00:00Z".into()), SHANGHAI, None).unwrap(),
    }
}

#[test]
fn the_notification_title_is_the_company_and_role_and_nothing_else() {
    assert_eq!(request().notification_title(), "合成公司 · 后端工程师");

    let mut only_company = request();
    only_company.position = None;
    assert_eq!(only_company.notification_title(), "合成公司");

    let mut nothing = request();
    nothing.company = None;
    nothing.position = None;
    assert_eq!(nothing.notification_title(), "Resume Pro");
}

#[test]
fn an_unsupported_platform_says_why_instead_of_pretending_to_have_scheduled() {
    let scheduler = Unsupported::new("系统通知未授权。");

    assert_eq!(
        scheduler.capability(),
        Capability::Unavailable {
            reason: "系统通知未授权。".into()
        }
    );
    assert!(!scheduler.capability().is_available());
    assert_eq!(scheduler.capability().reason(), Some("系统通知未授权。"));

    let err = scheduler.schedule(&request()).unwrap_err();
    assert_eq!(err.to_string(), "系统通知未授权。");

    // 撤销「一条本来就不存在的计划」是成功的：调用方要的是「之后不会再弹」。
    assert!(scheduler.cancel(&ScheduledHandle::new("whatever")).is_ok());
    assert!(scheduler.cancel_all().is_ok());
}

#[test]
fn a_handle_is_carried_through_unchanged_so_the_old_plan_can_be_cancelled() {
    let handle = ScheduledHandle::new("toast:resume-pro:todo-1:2026-09-14T02:00:00Z");
    assert_eq!(
        handle.as_str(),
        "toast:resume-pro:todo-1:2026-09-14T02:00:00Z"
    );
    assert_eq!(
        ScheduledHandle::new(handle.clone().into_string()),
        handle,
        "存进 reminder_handle 再读回来必须还是同一个句柄"
    );
}

#[test]
fn the_default_scheduler_never_claims_more_than_it_can_do() {
    let scheduler = reminders::scheduler();
    match scheduler.capability() {
        Capability::Available => {
            // 平台实现落地之后走这条；登记成功必须给回一个非空句柄。
            let handle = scheduler.schedule(&request()).unwrap();
            assert!(!handle.as_str().is_empty());
            scheduler.cancel(&handle).unwrap();
        }
        Capability::Unavailable { reason } => {
            assert!(!reason.trim().is_empty(), "说不行就要说得出为什么");
            assert!(scheduler.schedule(&request()).is_err());
        }
    }
}
