//! 时间处理:统一 UTC RFC3339(毫秒)存储;日期精度只存 `YYYY-MM-DD`,
//! 不把只有日期的通知伪造为具体时刻(产品需求 §8.3 时间语义)。

use crate::error::StoreError;
use time::format_description::FormatItem;
use time::macros::format_description;
use time::OffsetDateTime;

const TS_FORMAT: &[FormatItem] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");
const DATE_FORMAT: &[FormatItem] = format_description!("[year]-[month]-[day]");

/// 业务发生时间。`Unknown` 时持久化 occurredAt 为 NULL,禁止填午夜伪造。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "precision", content = "value", rename_all = "snake_case")]
pub enum Occurred {
    /// 精确时刻,持久化为 RFC3339 UTC(毫秒)。
    DateTime {
        /// RFC3339 输入(可带任意时区偏移),入库前归一为 UTC。
        rfc3339: String,
        /// 有意义时区提示(如 `Asia/Shanghai` 或 `+08:00`),未知为 None。
        time_zone: Option<String>,
    },
    /// 只有日历日(如邮件头只有日期)。持久化为 `YYYY-MM-DD`。
    Date {
        /// `YYYY-MM-DD`
        date: String,
        time_zone: Option<String>,
    },
    Unknown,
}

impl Occurred {
    /// (occurred_at 列值, occurred_precision 列值, time_zone 列值)
    pub fn to_columns(&self) -> Result<(Option<String>, &'static str, Option<String>), StoreError> {
        match self {
            Occurred::DateTime { rfc3339, time_zone } => {
                let utc = parse_rfc3339(rfc3339)?;
                Ok((Some(format_timestamp(utc)), "datetime", time_zone.clone()))
            }
            Occurred::Date { date, time_zone } => {
                time::Date::parse(date, &DATE_FORMAT)
                    .map_err(|_| StoreError::Validation(format!("invalid date `{date}`, expected YYYY-MM-DD")))?;
                Ok((Some(date.clone()), "date", time_zone.clone()))
            }
            Occurred::Unknown => Ok((None, "unknown", None)),
        }
    }

    pub fn from_columns(occurred_at: Option<&str>, precision: &str, tz: Option<&str>) -> Result<Self, StoreError> {
        match precision {
            "datetime" => {
                let raw = occurred_at
                    .ok_or_else(|| StoreError::Validation("datetime event without occurredAt".into()))?;
                // 库内统一为 UTC 毫秒;原样读回。
                Ok(Occurred::DateTime { rfc3339: raw.to_string(), time_zone: tz.map(str::to_string) })
            }
            "date" => {
                let raw = occurred_at
                    .ok_or_else(|| StoreError::Validation("date event without occurredAt".into()))?;
                Ok(Occurred::Date { date: raw.to_string(), time_zone: tz.map(str::to_string) })
            }
            "unknown" => Ok(Occurred::Unknown),
            other => Err(StoreError::Validation(format!("unknown occurredPrecision `{other}`"))),
        }
    }
}

pub fn now_utc() -> String {
    format_timestamp(OffsetDateTime::now_utc())
}

pub fn format_timestamp(t: OffsetDateTime) -> String {
    t.format(&TS_FORMAT).unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

pub fn parse_rfc3339(s: &str) -> Result<OffsetDateTime, StoreError> {
    OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
        .map_err(|_| StoreError::Validation(format!("invalid RFC3339 timestamp `{s}`")))
}

pub fn today_utc() -> String {
    OffsetDateTime::now_utc().date().format(&DATE_FORMAT).unwrap_or_default()
}

pub(crate) fn date_format() -> &'static [FormatItem] {
    DATE_FORMAT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn occurred_columns_roundtrip() {
        let (v, p, tz) = Occurred::DateTime {
            rfc3339: "2026-09-20T14:00:00+08:00".into(),
            time_zone: Some("+08:00".into()),
        }
        .to_columns()
        .unwrap();
        assert_eq!(p, "datetime");
        assert_eq!(v.as_deref(), Some("2026-09-20T06:00:00.000Z"));
        assert_eq!(tz.as_deref(), Some("+08:00"));

        let (v, p, _) = Occurred::Date { date: "2026-09-21".into(), time_zone: None }.to_columns().unwrap();
        assert_eq!(p, "date");
        assert_eq!(v.as_deref(), Some("2026-09-21"));

        let (v, p, _) = Occurred::Unknown.to_columns().unwrap();
        assert_eq!(p, "unknown");
        assert!(v.is_none());
    }

    #[test]
    fn rejects_fake_precision() {
        assert!(Occurred::Date { date: "2026-09-21T00:00:00Z".into(), time_zone: None }.to_columns().is_err());
        assert!(Occurred::DateTime { rfc3339: "not-a-time".into(), time_zone: None }.to_columns().is_err());
    }
}
