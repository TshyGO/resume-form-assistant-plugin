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
    AiSuggestion, ApplicationFilter, ArchiveStore, EvidenceKind, NewAiSuggestion, ReplyClass,
    SendMode, Stage, SuggestedTodo, TodoDue,
};
use serde::Serialize;
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
