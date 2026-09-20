//! 校验模型返回。宁可降级成 unknown，也不把猜测当结论。
//!
//! 只有两种情况算失败、整条不入库：JSON 解析不了，或者候选编号不在给出的列表里
//! （后者说明模型在凭空指认一条申请，不能只当成一处小瑕疵）。其余都是降级：
//! 枚举外的值变 unknown，日期解析不了就丢掉那条待办，引用对不上就丢掉那条引用，
//! 每一次降级都记一条不确定点，界面上要让用户看见。

use serde_json::Value;

use crate::excerpt;
use crate::prompt::RequestContext;

pub const REPLY_CLASSES: [&str; 8] = [
    "auto_ack",
    "assessment_invite",
    "interview_invite",
    "action_required",
    "offer",
    "reject",
    "other",
    "unknown",
];

pub const SEND_MODES: [&str; 3] = ["human", "automated", "unknown"];

/// 建议里允许出现的阶段。`saved` / `filling` / `submitted` 是本地流程产生的，
/// 一封通知推不出这三个，所以不在这里。
pub const STAGES: [&str; 5] = ["assessment", "interview", "offer", "rejected", "closed"];

const MAX_TODOS: usize = 5;
const MAX_EXCERPTS: usize = 5;
const MAX_UNCERTAINTIES: usize = 10;
const MAX_TEXT_CHARS: usize = 200;
const MAX_TITLE_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Due {
    DateTime(String),
    Date(String),
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuggestedTodo {
    pub title: String,
    pub due: Due,
    pub time_zone: Option<String>,
    pub interview_round: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extraction {
    /// 已经映射回本地 id 的候选。空数组表示模型没能指认，界面必须让用户自己选。
    pub application_ids: Vec<String>,
    pub reply_class: String,
    pub send_mode: String,
    pub stage: Option<String>,
    pub round: Option<i64>,
    pub todos: Vec<SuggestedTodo>,
    pub excerpts: Vec<String>,
    pub uncertainties: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtractError {
    /// 返回的不是 JSON 对象。
    NotJson(String),
    /// 模型指了一个不存在的候选编号。
    UnknownCandidate(String),
}

impl ExtractError {
    pub fn code(&self) -> &'static str {
        match self {
            ExtractError::NotJson(_) => "AI_BAD_RESPONSE",
            ExtractError::UnknownCandidate(_) => "AI_CANDIDATE_OUT_OF_RANGE",
        }
    }

    /// 给用户看的一句话。不带模型原文，避免把注入内容原样贴到界面上。
    pub fn message(&self) -> String {
        match self {
            ExtractError::NotJson(_) => "AI 返回的不是能解析的 JSON，这次没有产生建议。".into(),
            ExtractError::UnknownCandidate(label) => {
                format!("AI 指认了一条不在候选里的申请（{label}），这次的建议已作废。")
            }
        }
    }
}

impl std::fmt::Display for ExtractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExtractError::NotJson(detail) => write!(f, "not json: {detail}"),
            ExtractError::UnknownCandidate(label) => write!(f, "unknown candidate: {label}"),
        }
    }
}

/// 去掉 markdown 代码块外壳。有的服务商即使要求只输出 JSON 也会包一层。
fn strip_fences(raw: &str) -> &str {
    let trimmed = raw.trim();
    let without_open = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```JSON"))
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed);
    without_open
        .strip_suffix("```")
        .unwrap_or(without_open)
        .trim()
}

fn clip(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect::<String>()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// 日期：RFC3339（必须带时区偏移）或 `YYYY-MM-DD`。没有偏移的裸时刻不收——
/// 那种值换一台机器就是另一个时刻。
fn parse_due(raw: &str) -> Option<Due> {
    let value = raw.trim();
    if value.is_empty() {
        return Some(Due::None);
    }
    if is_calendar_date(value) {
        return Some(Due::Date(value.to_string()));
    }
    if is_rfc3339(value) {
        return Some(Due::DateTime(value.to_string()));
    }
    None
}

fn is_calendar_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, b)| index == 4 || index == 7 || b.is_ascii_digit())
    {
        return false;
    }
    let year = value[0..4].parse::<u32>().ok();
    let month = value[5..7].parse::<u32>().ok();
    let day = value[8..10].parse::<u32>().ok();
    let (Some(year), Some(month), Some(day)) = (year, month, day) else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=days).contains(&day)
}

fn is_rfc3339(value: &str) -> bool {
    let bytes = value.as_bytes();
    // All separators and digits in this wire format are ASCII. Reject first so the byte
    // slices below can never split a multibyte model response and panic the command.
    if !value.is_ascii() || bytes.len() < 20 || !is_calendar_date(&value[..10]) {
        return false;
    }
    if bytes[10] != b'T' && bytes[10] != b't' {
        return false;
    }
    let time = &value[11..];
    let time_bytes = time.as_bytes();
    if time_bytes.len() < 9
        || time_bytes[2] != b':'
        || time_bytes[5] != b':'
        || !time_bytes[..8]
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 2 || index == 5 || byte.is_ascii_digit())
    {
        return false;
    }
    let hour = time[0..2].parse::<u32>().unwrap_or(24);
    let minute = time[3..5].parse::<u32>().unwrap_or(60);
    let second = time[6..8].parse::<u32>().unwrap_or(60);
    if hour > 23 || minute > 59 || second > 59 {
        return false;
    }

    let mut rest = &time[8..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        rest = &fraction[digits..];
    }
    // RFC 3339 explicitly permits lower-case `t`/`z`; accept both spellings deliberately.
    if rest == "Z" || rest == "z" {
        return true;
    }
    let zone = rest.as_bytes();
    if zone.len() != 6 || !matches!(zone[0], b'+' | b'-') || zone[3] != b':' {
        return false;
    }
    if !zone[1..3].iter().chain(&zone[4..6]).all(u8::is_ascii_digit) {
        return false;
    }
    let offset_hour = rest[1..3].parse::<u32>().unwrap_or(24);
    let offset_minute = rest[4..6].parse::<u32>().unwrap_or(60);
    offset_hour <= 23 && offset_minute <= 59
}

fn positive_round(value: Option<&Value>) -> Option<i64> {
    let round = value.and_then(Value::as_i64)?;
    if (1..=20).contains(&round) {
        Some(round)
    } else {
        None
    }
}

/// 解析并校验一次返回。`context` 提供编号映射和原文，用来核对引用。
pub fn parse_response(raw: &str, context: &RequestContext) -> Result<Extraction, ExtractError> {
    let parsed: Value = serde_json::from_str(strip_fences(raw))
        .map_err(|err| ExtractError::NotJson(err.to_string()))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| ExtractError::NotJson("返回的顶层不是对象".into()))?;

    let mut uncertainties: Vec<String> = Vec::new();

    let mut application_ids: Vec<String> = Vec::new();
    for label in string_array(object.get("candidates")) {
        let id = context
            .application_id(&label)
            .ok_or_else(|| ExtractError::UnknownCandidate(clip(&label, 40)))?;
        if !application_ids.iter().any(|existing| existing == id) {
            application_ids.push(id.to_string());
        }
    }

    let reply_class = match object.get("replyClass").and_then(Value::as_str) {
        Some(value) if REPLY_CLASSES.contains(&value) => value.to_string(),
        _ => {
            uncertainties.push("模型给的通知类型无法识别，已记为未知。".into());
            "unknown".to_string()
        }
    };

    let send_mode = match object.get("sendMode").and_then(Value::as_str) {
        Some(value) if SEND_MODES.contains(&value) => value.to_string(),
        _ => {
            uncertainties.push("模型没给出可用的发送方式，已记为未知。".into());
            "unknown".to_string()
        }
    };

    // 回执永远不带阶段建议：一封「我们收到了」推不出任何进度。
    let mut stage = if reply_class == "auto_ack" {
        None
    } else {
        match object.get("stage").and_then(Value::as_str) {
            Some(value) if STAGES.contains(&value) => Some(value.to_string()),
            Some(_) => {
                uncertainties.push("模型建议的阶段不在允许范围里，已忽略。".into());
                None
            }
            None => None,
        }
    };

    let round = positive_round(object.get("round"));

    let mut todos: Vec<SuggestedTodo> = Vec::new();
    if let Some(items) = object.get("todos").and_then(Value::as_array) {
        for item in items.iter().take(MAX_TODOS) {
            let Some(entry) = item.as_object() else {
                continue;
            };
            let title = entry
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if title.is_empty() {
                continue;
            }
            let due_raw = entry.get("due").and_then(Value::as_str).unwrap_or("");
            let Some(due) = parse_due(due_raw) else {
                uncertainties.push(format!(
                    "待办「{}」的时间没法确定，已丢掉这条待办。",
                    clip(title, 30)
                ));
                continue;
            };
            let time_zone = entry
                .get("timeZone")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| clip(s, 60));
            if matches!(due, Due::DateTime(_)) && time_zone.is_none() {
                uncertainties.push("待办只有时刻没有时区名，按给出的偏移记。".into());
            }
            todos.push(SuggestedTodo {
                title: clip(title, MAX_TITLE_CHARS),
                due,
                time_zone,
                interview_round: positive_round(entry.get("round")),
            });
        }
    }

    let mut excerpts: Vec<String> = Vec::new();
    let mut dropped_excerpt = false;
    for candidate in string_array(object.get("excerpts")) {
        if excerpts.len() >= MAX_EXCERPTS {
            break;
        }
        if excerpt::appears_in(&context.body, &candidate) {
            excerpts.push(clip(&candidate, MAX_TEXT_CHARS));
        } else {
            dropped_excerpt = true;
        }
    }
    if dropped_excerpt {
        uncertainties.push("模型给出的引用在原文里找不到，已丢掉。".into());
    }

    for note in string_array(object.get("uncertainties")) {
        uncertainties.push(clip(&note, MAX_TEXT_CHARS));
    }

    // 信息冲突：不替用户选一个，阶段和待办都交回给人。
    let conflicts = string_array(object.get("conflicts"));
    if !conflicts.is_empty() {
        stage = None;
        todos.clear();
        for conflict in conflicts {
            uncertainties.push(format!("信息冲突：{}", clip(&conflict, MAX_TEXT_CHARS)));
        }
    }

    uncertainties.dedup();
    uncertainties.truncate(MAX_UNCERTAINTIES);

    Ok(Extraction {
        application_ids,
        reply_class,
        send_mode,
        stage,
        round,
        todos,
        excerpts,
        uncertainties,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::candidates::Candidate;
    use crate::prompt::{build_request, EvidenceInput};

    fn context(body: &str, ids: &[&str]) -> RequestContext {
        let candidates: Vec<Candidate> = ids
            .iter()
            .map(|id| Candidate {
                id: (*id).into(),
                company: "合成公司".into(),
                title: "后端实习".into(),
                stage: "submitted".into(),
            })
            .collect();
        build_request(
            "https://api.example.test/v1/chat/completions",
            "m",
            &EvidenceInput {
                body: body.into(),
                ..EvidenceInput::default()
            },
            &candidates,
        )
        .context
    }

    #[test]
    fn a_calendar_date_and_an_offset_time_are_both_accepted() {
        assert_eq!(
            parse_due("2026-09-20"),
            Some(Due::Date("2026-09-20".into()))
        );
        assert_eq!(
            parse_due("2026-09-20T02:00:00Z"),
            Some(Due::DateTime("2026-09-20T02:00:00Z".into()))
        );
        assert_eq!(
            parse_due("2026-09-20T10:00:00+08:00"),
            Some(Due::DateTime("2026-09-20T10:00:00+08:00".into()))
        );
        // 没有时区偏移的裸时刻不收：换台机器就是另一个时刻。
        assert_eq!(parse_due("2026-09-20T10:00:00"), None);
        assert_eq!(parse_due("下周二"), None);
        assert_eq!(parse_due(""), Some(Due::None));
    }

    #[test]
    fn calendar_and_clock_values_must_exist_not_only_match_the_shape() {
        for invalid in [
            "2026-02-30",
            "2027-02-29",
            "0000-01-01",
            "2026-13-01",
            "2026-02-30T10:00:00Z",
            "2027-02-29T10:00:00Z",
            "0000-01-01T00:00:00Z",
            "2026-13-01T10:00:00Z",
            "2026-09-2中T10:00:00Z",
            "2026-09-20T24:00:00Z",
            "2026-09-20T10:60:00Z",
            "2026-09-20T10:00:60Z",
            "2026-09-20T10:00:00+24:00",
            "2026-09-20T10:00:00+08:60",
        ] {
            assert_eq!(parse_due(invalid), None, "{invalid} must be rejected");
        }
        assert_eq!(
            parse_due("2028-02-29T10:00:00.123+08:00"),
            Some(Due::DateTime("2028-02-29T10:00:00.123+08:00".into()))
        );
    }

    #[test]
    fn markdown_fences_are_tolerated() {
        let ctx = context("正文", &["app-a"]);
        let parsed = parse_response("```json\n{\"replyClass\":\"offer\"}\n```", &ctx).unwrap();
        assert_eq!(parsed.reply_class, "offer");
    }

    #[test]
    fn junk_is_a_failure_and_an_unknown_label_voids_the_whole_suggestion() {
        let ctx = context("正文", &["app-a"]);
        assert_eq!(
            parse_response("not json at all", &ctx).unwrap_err().code(),
            "AI_BAD_RESPONSE"
        );
        let err = parse_response("{\"candidates\":[\"c9\"]}", &ctx).unwrap_err();
        assert_eq!(err.code(), "AI_CANDIDATE_OUT_OF_RANGE");
        assert!(err.message().contains("c9"));
    }

    #[test]
    fn unknown_enums_degrade_instead_of_failing() {
        let ctx = context("正文", &["app-a"]);
        let parsed = parse_response(
            "{\"replyClass\":\"maybe_interview\",\"sendMode\":\"robot\",\"stage\":\"hired\"}",
            &ctx,
        )
        .unwrap();
        assert_eq!(parsed.reply_class, "unknown");
        assert_eq!(parsed.send_mode, "unknown");
        assert_eq!(parsed.stage, None);
        assert_eq!(parsed.uncertainties.len(), 3);
    }
}
