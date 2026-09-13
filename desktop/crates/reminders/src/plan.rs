//! 从「一条待办的到期信息」算出「什么时候该弹」。
//!
//! 这一层完全没有平台调用，也不认识数据库。它存在的理由是两个平台要的东西不一样：
//! Windows 的 `ScheduledToastNotification` 收的是**绝对时刻**，得我们自己把日历日
//! 加时区算成 UTC；macOS 的 `UNCalendarNotificationTrigger` 收的是**墙钟分量**，
//! 夏令时由系统处理。所以 [`FireAt`] 两样都给，两个实现各取所需，时间语义只有这一份。

use time::format_description::well_known::Rfc3339;
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset};
use time_tz::{timezones, OffsetDateTimeExt, OffsetResult, PrimitiveDateTimeExt};

/// 待办的到期，和 `archive-store` 的 `TodoDue` 一一对应。
///
/// 这里没有直接用那个类型：本 crate 不依赖 rusqlite，也就不该依赖档案库的模型。
/// 映射在命令层做，一行 `match` 而已，换来的是这一层可以用普通 `cargo test` 跑。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Due {
    /// RFC3339 的精确时刻。
    DateTime(String),
    /// 只有日历日，`YYYY-MM-DD`。**没有时刻**，不许在这里补一个。
    Date(String),
    /// 没有到期。
    None,
}

/// 算出来的提醒时刻。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FireAt {
    /// 绝对时刻，Windows 用这个。
    pub utc: OffsetDateTime,
    /// 用户当地的墙钟时间，macOS 用这个。
    pub wall_clock: PrimitiveDateTime,
    /// 算 `wall_clock` 时用的时区名；用兜底偏移算的就是 `None`。
    pub time_zone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    /// 到期或提醒时刻不是能解析的时间。
    Unparsable(String),
    /// 时区名不在 IANA 库里。
    UnknownTimeZone(String),
    /// 这个墙钟时间在这个时区不存在（夏令时往前跳的那一小时）。
    SkippedByDaylightSaving(String),
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::Unparsable(v) => write!(f, "无法解析的时间：{v}"),
            PlanError::UnknownTimeZone(v) => write!(f, "不认识的时区：{v}"),
            PlanError::SkippedByDaylightSaving(v) => {
                write!(f, "这个时刻在当地不存在（夏令时跳过）：{v}")
            }
        }
    }
}

impl std::error::Error for PlanError {}

/// 一条待办什么时候提醒。
///
/// 规则，按优先级：
///
/// 1. 用户显式设了提醒时刻（`remind_at_utc`）就用它，**不管到期是什么精度**。
///    「不知道几点截止」和「早上九点提醒我」是两条独立信息。
/// 2. 否则到期是精确时刻的话，就在那个时刻提醒。
/// 3. 否则到期只有日历日，用「那天的 `default_local_time`」算成绝对时刻。
///    这是唯一一处引入时刻的地方，而且它进的是提醒，**不会**把到期改成 datetime。
/// 4. 到期和提醒时刻都没有，才是没有提醒。「没有截止日期但周日提醒我一下」
///    是成立的需求，所以规则 1 的优先级高于这一条。
///
/// `fallback_offset` 是时区未知时用的偏移（命令层传本机当前偏移）。传进来而不是
/// 现场取，是为了测试能确定地跑。
pub fn fire_at(
    due: &Due,
    time_zone: Option<&str>,
    remind_at_utc: Option<&str>,
    default_local_time: Time,
    fallback_offset: UtcOffset,
) -> Result<Option<FireAt>, PlanError> {
    if let Some(explicit) = remind_at_utc.filter(|s| !s.trim().is_empty()) {
        let utc = OffsetDateTime::parse(explicit, &Rfc3339)
            .map_err(|_| PlanError::Unparsable(explicit.to_string()))?
            .to_offset(UtcOffset::UTC);
        return Ok(Some(local_view(utc, time_zone, fallback_offset)?));
    }

    match due {
        Due::DateTime(rfc3339) => {
            let utc = OffsetDateTime::parse(rfc3339, &Rfc3339)
                .map_err(|_| PlanError::Unparsable(rfc3339.clone()))?
                .to_offset(UtcOffset::UTC);
            Ok(Some(local_view(utc, time_zone, fallback_offset)?))
        }
        Due::Date(date) => {
            let day = Date::parse(date, &time::format_description::well_known::Iso8601::DATE)
                .map_err(|_| PlanError::Unparsable(date.clone()))?;
            let wall_clock = PrimitiveDateTime::new(day, default_local_time);
            let utc = to_utc(wall_clock, time_zone, fallback_offset)?;
            Ok(Some(FireAt {
                utc,
                wall_clock,
                time_zone: time_zone.map(str::to_string),
            }))
        }
        Due::None => Ok(None),
    }
}

/// 绝对时刻 → 当地墙钟。
fn local_view(
    utc: OffsetDateTime,
    time_zone: Option<&str>,
    fallback_offset: UtcOffset,
) -> Result<FireAt, PlanError> {
    let local = match time_zone {
        Some(name) => {
            let tz = timezones::get_by_name(name)
                .ok_or_else(|| PlanError::UnknownTimeZone(name.to_string()))?;
            utc.to_timezone(tz)
        }
        None => utc.to_offset(fallback_offset),
    };
    Ok(FireAt {
        utc,
        wall_clock: PrimitiveDateTime::new(local.date(), local.time()),
        time_zone: time_zone.map(str::to_string),
    })
}

/// 当地墙钟 → 绝对时刻。夏令时在这里出现：同一个「早上九点」在换季前后
/// 对应的 UTC 时刻不一样，差的不是恒定的 24 小时。
fn to_utc(
    wall_clock: PrimitiveDateTime,
    time_zone: Option<&str>,
    fallback_offset: UtcOffset,
) -> Result<OffsetDateTime, PlanError> {
    let Some(name) = time_zone else {
        return Ok(wall_clock.assume_offset(fallback_offset).to_offset(UtcOffset::UTC));
    };
    let tz =
        timezones::get_by_name(name).ok_or_else(|| PlanError::UnknownTimeZone(name.to_string()))?;
    match wall_clock.assume_timezone(tz) {
        OffsetResult::Some(dt) => Ok(dt.to_offset(UtcOffset::UTC)),
        // 秋天回拨的那一小时出现两次。取第一次：宁可早提醒一小时，也不要晚。
        OffsetResult::Ambiguous(first, _) => Ok(first.to_offset(UtcOffset::UTC)),
        // 春天跳过的那一小时根本不存在。不猜，报错让上层如实告诉用户换一个时刻。
        OffsetResult::None => Err(PlanError::SkippedByDaylightSaving(format!(
            "{wall_clock} {name}"
        ))),
    }
}

/// 这个时刻已经过去了吗。过去的不再登记——OS 调度器接受一个过去的时刻通常是
/// 立刻弹一次，那不是提醒，是骚扰；打开应用时的逾期汇总才是该走的路。
pub fn is_past(fire: &FireAt, now: OffsetDateTime) -> bool {
    fire.utc <= now
}

/// 写进 `reminder_scheduled_for_utc` 一列的形式，和档案库其它时刻列一致。
pub fn to_storage(fire: &FireAt) -> String {
    fire.utc
        .format(&Rfc3339)
        .unwrap_or_else(|_| fire.utc.to_string())
}
