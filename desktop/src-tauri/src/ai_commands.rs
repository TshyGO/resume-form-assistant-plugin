//! D11 命令层：从一份证据发起一次分析，把结果写成一条待确认的建议。
//!
//! 分成三段，**中间那段不碰数据库**：
//!
//! 1. [`gather`]：持锁读证据和候选。
//! 2. 发请求（在 `lib.rs` 的命令里 await，此时锁已经放了）。
//! 3. [`store_suggestion`]：再持锁写一条 `pending` 建议。
//!
//! 失败——超时、取消、HTTP 错、JSON 解析不了——**一律不写库**。证据和手动分类不受影响。

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use ai_extract::{
    build_request, Candidate, Due, EvidenceInput, Extraction, OutboundScope, MAX_CANDIDATES,
};
use archive_store::{
    Actor, AiSuggestion, ApplicationFilter, ArchiveStore, ConfirmSuggestionInput, EventDraft,
    EventPayload, EventSource, EvidenceKind, NewAiSuggestion, Occurred, ReplyClass, SendMode,
    Stage, StageUpdateMode, StoredEvent, SuggestedTodo, SuggestionStatus, TodoDue,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use serde_json::Value;

use crate::commands::CommandError;

/// 本地扫多少条申请来找公司名。超过这个数说明档案很大，也说明靠公司名匹配已经不够用，
/// 那就让用户自己选候选，而不是把更多申请送出去。
const MAX_SCANNED_APPLICATIONS: u32 = 200;
const MATCH_WINDOW_CHARS: usize = 2000;

/// 进行中的请求。同一条证据同时只允许一个：并发分析同一封通知，得到的是两条互相
/// 矛盾的建议和两份账单，没有任何好处。
#[derive(Default)]
pub struct InflightRegistry {
    entries: Mutex<HashMap<String, Entry>>,
}

struct Entry {
    evidence_id: String,
    cancel: tokio::sync::oneshot::Sender<()>,
}

impl InflightRegistry {
    /// 登记一次请求，拿到取消信号。已经有同证据的请求在跑就直接拒绝，不排队。
    pub fn begin(
        &self,
        evidence_id: &str,
        request_id: &str,
    ) -> Result<tokio::sync::oneshot::Receiver<()>, CommandError> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|e| invalid("STORE_ERROR", e.to_string()))?;
        if entries.contains_key(request_id)
            || entries.values().any(|e| e.evidence_id == evidence_id)
        {
            return Err(invalid(
                "AI_BUSY",
                "这条证据正在分析中。等它结束，或者先取消。",
            ));
        }
        let (cancel, signal) = tokio::sync::oneshot::channel();
        entries.insert(
            request_id.to_string(),
            Entry {
                evidence_id: evidence_id.to_string(),
                cancel,
            },
        );
        Ok(signal)
    }

    /// 请求结束（成功或失败都算）。注销失败不影响结果，所以这里不返回错误。
    pub fn finish(&self, request_id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(request_id);
        }
    }

    /// 取消一次请求。返回是否真的通知到了——早就跑完的请求取消不了，界面按这个来。
    pub fn cancel(&self, request_id: &str) -> bool {
        let entry = self
            .entries
            .lock()
            .ok()
            .and_then(|mut entries| entries.remove(request_id));
        match entry {
            Some(entry) => entry.cancel.send(()).is_ok(),
            None => false,
        }
    }
}

#[derive(Debug)]
pub struct Gathered {
    pub evidence_id: String,
    pub evidence: EvidenceInput,
    pub candidates: Vec<Candidate>,
}

/// 发送前预览要展示的东西。**不含 Key，不含申请 UUID。**
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundPreview {
    pub host: String,
    pub model: String,
    pub body_chars: usize,
    pub truncated: bool,
    pub has_subject: bool,
    pub has_from: bool,
    pub candidates: Vec<PreviewCandidate>,
    /// 正文开头，给用户扫一眼确认发的是哪一封。
    pub body_preview: String,
    pub summary: String,
    /// 界面照这两个数字显示「还在等」和放弃等待，不要自己另写一套。
    pub slow_hint_seconds: u64,
    pub timeout_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCandidate {
    pub label: String,
    pub company: String,
    pub title: String,
}

fn invalid(code: &str, message: impl Into<String>) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
    }
}

fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

/// 证据正文。邮件和粘贴文本在导入时就抽好了；纯文本文件这里补读一次。
/// PDF 和截图首发不支持——与其把一张图发出去，不如让用户把正文复制进来。
fn body_text(store: &ArchiveStore, archive_dir: &Path, evidence_id: &str) -> Result<EvidenceInput, CommandError> {
    let record = store
        .get_evidence(evidence_id)
        .map_err(CommandError::from)?
        .ok_or_else(|| invalid("NOT_FOUND", "找不到这条证据。"))?;

    let mut body = record.body_extract.clone().unwrap_or_default();
    if body.trim().is_empty() {
        let is_plain_text = matches!(record.kind, EvidenceKind::Unknown)
            && record
                .blob
                .meta
                .mime
                .as_deref()
                .map(|mime| mime.starts_with("text/"))
                .unwrap_or(false);
        match record.kind {
            EvidenceKind::Pdf | EvidenceKind::Screenshot => {
                return Err(invalid(
                    "AI_UNSUPPORTED_KIND",
                    "这类证据还不能 AI 整理。可以把正文复制出来，用「粘贴文本」再导入一次。",
                ));
            }
            _ if is_plain_text => {
                let path = archive_dir.join(&record.blob.meta.stored_rel_path);
                let text = std::fs::read_to_string(&path).map_err(|_| {
                    invalid("AI_NO_TEXT", "读不出这份文件的文字，本机副本可能已经不在了。")
                })?;
                body = text.chars().take(evidence_import::MAX_BODY_EXTRACT).collect();
            }
            _ => {
                return Err(invalid(
                    "AI_UNSUPPORTED_KIND",
                    "这类证据还不能 AI 整理。可以把正文复制出来，用「粘贴文本」再导入一次。",
                ));
            }
        }
    }

    if body.trim().is_empty() {
        return Err(invalid("AI_NO_TEXT", "这条证据没有可分析的文字。"));
    }

    Ok(EvidenceInput {
        subject: record.subject.clone(),
        from_addr: record.from_addr.clone(),
        sent_at: None,
        body,
    })
}

fn candidate_of(store: &ArchiveStore, application_id: &str) -> Result<Candidate, CommandError> {
    let detail = store
        .get_application(application_id)
        .map_err(CommandError::from)?
        .ok_or_else(|| invalid("NOT_FOUND", "找不到这条申请。"))?;
    Ok(Candidate {
        id: detail.summary.id,
        company: detail.summary.company,
        title: detail.summary.title,
        stage: detail.summary.current_stage.as_str().to_string(),
    })
}

/// 候选在本地挑：
///
/// - 用户手选了就用手选的；
/// - 证据已经关联了某条申请，只送那一条；
/// - 否则拿公司名在主题、发件人、正文开头里找。**一条都找不到时不把所有申请送出去**，
///   而是让用户先关联或手选。
fn pick(
    store: &ArchiveStore,
    evidence_id: &str,
    evidence: &EvidenceInput,
    selected: Option<&[String]>,
) -> Result<Vec<Candidate>, CommandError> {
    if let Some(ids) = selected {
        // 手选了个空清单：发出去也只会白花一次钱，模型没有任何候选可指。
        if ids.is_empty() {
            return Err(invalid(
                "AI_NEEDS_CANDIDATES",
                "一条候选都没选。先选几条，或者让桌面自己去认。",
            ));
        }
        if ids.len() > MAX_CANDIDATES {
            return Err(invalid(
                "VALIDATION",
                format!("一次最多送 {MAX_CANDIDATES} 条候选。"),
            ));
        }
        return ids.iter().map(|id| candidate_of(store, id)).collect();
    }

    let record = store
        .get_evidence(evidence_id)
        .map_err(CommandError::from)?
        .ok_or_else(|| invalid("NOT_FOUND", "找不到这条证据。"))?;
    if let Some(application_id) = record.application_id.as_deref() {
        return Ok(vec![candidate_of(store, application_id)?]);
    }

    let haystack = normalize(
        &[
            evidence.subject.clone().unwrap_or_default(),
            evidence.from_addr.clone().unwrap_or_default(),
            evidence.body.chars().take(MATCH_WINDOW_CHARS).collect(),
        ]
        .join(" "),
    );
    let page = store
        .list_applications(&ApplicationFilter {
            limit: MAX_SCANNED_APPLICATIONS,
            ..ApplicationFilter::default()
        })
        .map_err(CommandError::from)?;
    let mut picked: Vec<Candidate> = Vec::new();
    for item in page.items {
        let company = normalize(&item.company);
        if company.is_empty() || !haystack.contains(&company) {
            continue;
        }
        picked.push(Candidate {
            id: item.id,
            company: item.company,
            title: item.title,
            stage: item.current_stage.as_str().to_string(),
        });
        if picked.len() >= MAX_CANDIDATES {
            break;
        }
    }

    if picked.is_empty() {
        return Err(invalid(
            "AI_NEEDS_CANDIDATES",
            "这封通知里认不出是哪一条申请。先把它关联到某条申请，或者自己选几条候选再试。",
        ));
    }
    Ok(picked)
}

/// 持锁那一段：读证据、挑候选。读完就可以放锁了。
pub fn gather(
    store: &ArchiveStore,
    archive_dir: &Path,
    evidence_id: &str,
    selected: Option<&[String]>,
) -> Result<Gathered, CommandError> {
    let evidence = body_text(store, archive_dir, evidence_id)?;
    let candidates = pick(store, evidence_id, &evidence, selected)?;
    Ok(Gathered {
        evidence_id: evidence_id.to_string(),
        evidence,
        candidates,
    })
}

pub fn preview(gathered: &Gathered, api_url: &str, model: &str) -> OutboundPreview {
    let built = build_request(api_url, model, &gathered.evidence, &gathered.candidates);
    let scope = built.scope;
    OutboundPreview {
        body_preview: gathered.evidence.body.chars().take(400).collect(),
        summary: scope.summary(),
        slow_hint_seconds: crate::ai_client::SLOW_HINT_SECONDS,
        timeout_seconds: crate::ai_client::TIMEOUT_SECONDS,
        host: scope.host,
        model: scope.model,
        body_chars: scope.body_chars,
        truncated: scope.truncated,
        has_subject: scope.has_subject,
        has_from: scope.has_from,
        candidates: scope
            .candidates
            .into_iter()
            .map(|candidate| PreviewCandidate {
                label: candidate.label,
                company: candidate.company,
                title: candidate.title,
            })
            .collect(),
    }
}

fn due_of(due: Due) -> TodoDue {
    match due {
        Due::DateTime(value) => TodoDue::DateTime(value),
        Due::Date(value) => TodoDue::Date(value),
        Due::None => TodoDue::None,
    }
}

fn json_list(values: &[String]) -> Option<Value> {
    if values.is_empty() {
        None
    } else {
        Some(Value::Array(
            values.iter().map(|item| Value::String(item.clone())).collect(),
        ))
    }
}

/// 再持锁那一段：写一条 `pending` 建议。**正式字段一个都不动。**
pub fn store_suggestion(
    store: &ArchiveStore,
    gathered: &Gathered,
    extraction: Extraction,
    scope: &OutboundScope,
) -> Result<AiSuggestion, CommandError> {
    let suggestion = NewAiSuggestion {
        evidence_id: gathered.evidence_id.clone(),
        candidate_application_ids: extraction.application_ids.clone(),
        suggested_stage: extraction.stage.as_deref().and_then(Stage::parse),
        suggested_round: extraction.round,
        suggested_reply_class: ReplyClass::parse(&extraction.reply_class)
            .unwrap_or(ReplyClass::Unknown),
        suggested_send_mode: SendMode::parse(&extraction.send_mode).unwrap_or(SendMode::Unknown),
        suggested_todos: extraction
            .todos
            .into_iter()
            .map(|todo| SuggestedTodo {
                title: todo.title,
                due: due_of(todo.due),
                time_zone: todo.time_zone,
                interview_round: todo.interview_round,
            })
            .collect(),
        excerpt_refs: json_list(&extraction.excerpts),
        uncertainties: json_list(&extraction.uncertainties),
        model_label: Some(scope.model.clone()),
        prompt_scope: Some(scope.summary()),
    };
    store.create_suggestion(suggestion).map_err(CommandError::from)
}

pub fn list_suggestions(
    store: &ArchiveStore,
    evidence_id: &str,
) -> Result<Vec<AiSuggestion>, CommandError> {
    store
        .list_suggestions(Some(evidence_id), None)
        .map_err(CommandError::from)
}

// --- 确认、拒绝、暂存 ---------------------------------------------------------------------

/// 用户在审核面板里按下「确认」时提交的东西。
///
/// 每一项都是**用户批准的值**，不是模型建议的值：面板允许逐项改，改完提交的是改完的。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmArgs {
    pub suggestion_id: String,
    /// 候选多于一条时必填。缺了不替用户选第一个。
    #[serde(default)]
    pub application_id: Option<String>,
    pub reply_class: String,
    pub send_mode: String,
    /// 要记的阶段事件。不给就不记，只留一条分类事件。
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub round: Option<i64>,
    /// 事件发生的时刻（多半是邮件的发信时间）。不给就记为「时间未知」。
    #[serde(default)]
    pub occurred_at: Option<String>,
    /// 「同时更新申请进度」。默认 false：导入一封旧通知不该把当前进度改掉。
    #[serde(default)]
    pub update_progress: bool,
    #[serde(default)]
    pub create_todos: bool,
    /// 用户改过的待办清单。不给就照建议原样转正。
    #[serde(default)]
    pub todos: Option<Vec<TodoEdit>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoEdit {
    pub title: String,
    /// `datetime` / `date` / `none`，和 D10 的待办命令一个口径。
    #[serde(default)]
    pub due_precision: Option<String>,
    #[serde(default)]
    pub due_at_utc: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub interview_round: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmResult {
    pub suggestion: AiSuggestion,
    /// 重复确认同一个决定：什么都没有再写一遍。
    pub already_confirmed: bool,
    pub events: Vec<StoredEvent>,
    pub todos: Vec<crate::todo_commands::TodoView>,
    /// 提醒没登记上的原因，逐条列。确认本身已经成功了，这里只是提醒那一半没成。
    pub reminder_problems: Vec<String>,
}

fn round_in_range(round: Option<i64>) -> Result<(), CommandError> {
    match round {
        Some(n) if !(1..=99).contains(&n) => Err(invalid("VALIDATION", "面试轮次须为 1–99。")),
        _ => Ok(()),
    }
}

fn occurred_of(occurred_at: Option<&str>) -> Result<Occurred, CommandError> {
    let occurred = match occurred_at.map(str::trim).filter(|s| !s.is_empty()) {
        Some(value) => Occurred::DateTime {
            rfc3339: value.to_string(),
            time_zone: None,
        },
        None => Occurred::Unknown,
    };
    occurred.to_columns().map_err(CommandError::from)?;
    Ok(occurred)
}

/// 阶段 → 事件。只有 ai-extract 允许的那五个阶段能从通知里推出来；
/// `saved` / `filling` / `submitted` 是用户自己的动作，AI 不该代劳。
fn stage_event(
    stage: &str,
    round: Option<i64>,
    update_progress: bool,
    occurred: Occurred,
) -> Result<EventDraft, CommandError> {
    let mode = if update_progress {
        StageUpdateMode::UpdateProgress
    } else {
        StageUpdateMode::HistoryOnly
    };
    let payload = match stage {
        "assessment" => EventPayload::AssessmentRecorded {
            name: None,
            due: None,
            stage_update_mode: mode,
        },
        "interview" => EventPayload::InterviewRecorded {
            round,
            label: None,
            stage_update_mode: mode,
        },
        "offer" => EventPayload::OfferRecorded {
            note: None,
            stage_update_mode: mode,
        },
        "rejected" => EventPayload::Rejected {
            reason: None,
            stage_update_mode: mode,
        },
        "closed" => EventPayload::Closed {
            note: None,
            stage_update_mode: mode,
        },
        other => {
            return Err(invalid(
                "VALIDATION",
                format!("不能从一封通知里推出 `{other}` 这个阶段。"),
            ))
        }
    };
    Ok(EventDraft {
        occurred,
        // 这三项确认事务里会覆盖，这里给的值不作数。
        source: EventSource::AiConfirmed,
        source_request_id: None,
        actor: Actor::User,
        payload,
    })
}

fn todo_of(edit: TodoEdit) -> Result<SuggestedTodo, CommandError> {
    let title = edit.title.trim();
    if title.is_empty() {
        return Err(invalid("VALIDATION", "待办得有个标题。"));
    }
    round_in_range(edit.interview_round)?;
    Ok(SuggestedTodo {
        title: title.to_string(),
        due: crate::todo_commands::parse_due(
            edit.due_precision.as_deref(),
            edit.due_at_utc.as_deref(),
            edit.due_date.as_deref(),
        )?,
        time_zone: edit
            .time_zone
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        interview_round: edit.interview_round,
    })
}

/// 确认一条建议：事务里一次写完分类、阶段事件和待办，然后给新待办登记提醒。
///
/// 候选多于一条而用户没选，返回 `AI_NEEDS_DISAMBIGUATION`——**不替他选第一个**。
pub fn confirm(
    store: &ArchiveStore,
    scheduler: &dyn reminders::ReminderScheduler,
    args: ConfirmArgs,
    now: OffsetDateTime,
) -> Result<ConfirmResult, CommandError> {
    let suggestion = store
        .get_suggestion(&args.suggestion_id)
        .map_err(CommandError::from)?
        .ok_or_else(|| invalid("NOT_FOUND", "找不到这条建议。"))?;

    let application_id = match args
        .application_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(id) => id.to_string(),
        None => match suggestion.candidate_application_ids.as_slice() {
            [only] => only.clone(),
            _ => {
                return Err(invalid(
                    "AI_NEEDS_DISAMBIGUATION",
                    "这条通知对应哪一份申请还没定，先选一条再确认。",
                ))
            }
        },
    };

    round_in_range(args.round)?;
    let reply_class = ReplyClass::parse(&args.reply_class)
        .ok_or_else(|| invalid("VALIDATION", "不认识的通知类型。"))?;
    let send_mode = SendMode::parse(&args.send_mode)
        .ok_or_else(|| invalid("VALIDATION", "不认识的发送方式。"))?;
    let stage_event = match args.stage.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(stage) => Some(stage_event(
            stage,
            args.round,
            args.update_progress,
            occurred_of(args.occurred_at.as_deref())?,
        )?),
        None => None,
    };
    let approved_todos = match args.todos {
        Some(list) => Some(
            list.into_iter()
                .map(todo_of)
                .collect::<Result<Vec<_>, CommandError>>()?,
        ),
        None => None,
    };

    let outcome = store
        .confirm_suggestion(ConfirmSuggestionInput {
            suggestion_id: args.suggestion_id.clone(),
            application_id,
            approved_reply_class: reply_class,
            approved_send_mode: send_mode,
            stage_event,
            create_todos: args.create_todos,
            approved_todos,
        })
        .map_err(CommandError::from)?;

    // 提醒登记在事务外：登记不上不该把已经确认的东西回滚掉，只是照实说一声。
    let mut todos = Vec::new();
    let mut reminder_problems = Vec::new();
    for created in &outcome.todos {
        let (todo, problem) = crate::todo_commands::reschedule(store, scheduler, created, now)?;
        if let Some(problem) = problem {
            reminder_problems.push(problem);
        }
        todos.push(crate::todo_commands::with_application(store, &todo));
    }

    Ok(ConfirmResult {
        suggestion: outcome.suggestion,
        already_confirmed: outcome.already_confirmed,
        events: outcome.events,
        todos,
        reminder_problems,
    })
}

/// 拒绝或暂存。两者都**不碰任何正式字段**，只把建议行的状态改掉。
pub fn set_status(
    store: &ArchiveStore,
    suggestion_id: &str,
    status: SuggestionStatus,
) -> Result<AiSuggestion, CommandError> {
    store
        .set_suggestion_status(suggestion_id, status)
        .map_err(CommandError::from)
}
