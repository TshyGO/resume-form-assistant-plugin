//! AI 建议(§8.7):建议与已确认事件/正式字段分离。
//!
//! - 提取结果只写 `suggestedReplyClass` / `suggestedSendMode`;暂存、关闭窗口、
//!   重启后仍能恢复,不借用 ReplyEvidence 正式字段。
//! - 确认事务把用户批准的 class/mode 与正式证据更新、事件、阶段/待办写入
//!   放入同一事务,并记录批准值;`modified_confirmed` 可追溯原建议与批准值。
//! - 重复确认幂等:第二次确认不重复写入。

use rusqlite::params;

use crate::error::StoreError;
use crate::model::*;
use crate::timeutil::{now_utc, Occurred};
use crate::tx::{new_uuid, StoreTx};

/// 确认输入。`stage_event` 是调用方(Д04/D11 UI)根据用户选择构造的
/// 阶段相关事件草稿(如 `interview_recorded`);确认事务会把它以
/// `source=ai_confirmed, actor=user` 追加并参与折叠。不提供则只分类不改阶段。
#[derive(Debug, Clone)]
pub struct ConfirmSuggestionInput {
    pub suggestion_id: String,
    /// 用户消歧选择的申请(候选列表之一或手动指定)。
    pub application_id: String,
    pub approved_reply_class: ReplyClass,
    pub approved_send_mode: SendMode,
    pub stage_event: Option<EventDraft>,
    /// 是否将建议待办转正。
    pub create_todos: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ConfirmOutcome {
    pub suggestion: AiSuggestion,
    pub events: Vec<StoredEvent>,
    pub todos: Vec<Todo>,
    /// 重复确认时为 true,且不产生任何新写入。
    pub already_confirmed: bool,
}

impl StoreTx<'_> {
    pub fn create_suggestion(
        &mut self,
        input: NewAiSuggestion,
    ) -> Result<AiSuggestion, StoreError> {
        for extra in [&input.excerpt_refs, &input.uncertainties] {
            if let Some(value) = extra {
                crate::tx::reject_secret_keys(value)?;
            }
        }
        if self.get_evidence(&input.evidence_id)?.is_none() {
            return Err(StoreError::NotFound(format!(
                "evidence {}",
                input.evidence_id
            )));
        }
        let now = now_utc();
        let id = new_uuid();
        self.conn().execute(
            "INSERT INTO ai_suggestions (id, evidence_id, status, candidate_application_ids, \
             suggested_stage, suggested_round, suggested_reply_class, suggested_send_mode, \
             suggested_todos, excerpt_refs, uncertainties, model_label, prompt_scope, created_at) \
             VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                id,
                input.evidence_id,
                serde_json::to_string(&input.candidate_application_ids)?,
                input.suggested_stage.map(|s| s.as_str().to_string()),
                input.suggested_round,
                input.suggested_reply_class.as_str(),
                input.suggested_send_mode.as_str(),
                serde_json::to_string(&input.suggested_todos)?,
                input
                    .excerpt_refs
                    .as_ref()
                    .map(serde_json::Value::to_string),
                input
                    .uncertainties
                    .as_ref()
                    .map(serde_json::Value::to_string),
                input.model_label,
                input.prompt_scope,
                now,
            ],
        )?;
        self.get_suggestion(&id)?
            .ok_or_else(|| StoreError::Internal("suggestion vanished in same transaction".into()))
    }

    pub fn get_suggestion(&self, id: &str) -> Result<Option<AiSuggestion>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT id, evidence_id, status, candidate_application_ids, suggested_stage, \
             suggested_round, suggested_reply_class, suggested_send_mode, suggested_todos, \
             excerpt_refs, uncertainties, model_label, prompt_scope, created_at, decided_at, \
             approved_reply_class, approved_send_mode, approved_stage \
             FROM ai_suggestions WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], map_suggestion_row)?;
        rows.next().transpose().map_err(StoreError::from)
    }

    pub fn list_suggestions(
        &self,
        evidence_id: Option<&str>,
        status: Option<SuggestionStatus>,
    ) -> Result<Vec<AiSuggestion>, StoreError> {
        let mut clauses: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(ev) = evidence_id {
            args.push(Box::new(ev.to_string()));
            clauses.push(format!("evidence_id = ?{}", args.len()));
        }
        if let Some(st) = status {
            args.push(Box::new(st.as_str().to_string()));
            clauses.push(format!("status = ?{}", args.len()));
        }
        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let sql = format!(
            "SELECT id, evidence_id, status, candidate_application_ids, suggested_stage, \
             suggested_round, suggested_reply_class, suggested_send_mode, suggested_todos, \
             excerpt_refs, uncertainties, model_label, prompt_scope, created_at, decided_at, \
             approved_reply_class, approved_send_mode, approved_stage \
             FROM ai_suggestions {where_sql} ORDER BY created_at ASC"
        );
        let map = args.iter().map(|b| b.as_ref()).collect::<Vec<_>>();
        let mut stmt = self.conn().prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(map.iter().copied()),
            map_suggestion_row,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// 确认事务:分类 + (可选)阶段事件 + (可选)待办,同一事务;重复确认幂等。
    pub fn confirm_suggestion(
        &mut self,
        input: ConfirmSuggestionInput,
    ) -> Result<ConfirmOutcome, StoreError> {
        let suggestion = self
            .get_suggestion(&input.suggestion_id)?
            .ok_or_else(|| StoreError::NotFound(format!("suggestion {}", input.suggestion_id)))?;
        let evidence = self
            .get_evidence(&suggestion.evidence_id)?
            .ok_or_else(|| StoreError::NotFound(format!("evidence {}", suggestion.evidence_id)))?;
        self.ensure_application(&input.application_id)?;
        use sha2::{Digest, Sha256};
        let decision = serde_json::json!({"applicationId":input.application_id,"class":input.approved_reply_class,
            "mode":input.approved_send_mode,"todos":input.create_todos,
            "stageEvent":input.stage_event.as_ref().map(|e| serde_json::json!({"payload":e.payload,"occurred":e.occurred}))});
        let decision_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(&decision)?));

        // 幂等:已确认(含 modified)不再产生任何写入。
        if matches!(
            suggestion.status,
            SuggestionStatus::Confirmed | SuggestionStatus::ModifiedConfirmed
        ) {
            use rusqlite::OptionalExtension;
            let recorded: Option<String> = self.conn().query_row("SELECT payload FROM events WHERE source_request_id=?1 AND event_type='evidence_classified' ORDER BY event_sequence DESC LIMIT 1", [&suggestion.id], |r| r.get(0)).optional()?;
            let recorded =
                recorded.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
            if recorded
                .as_ref()
                .and_then(|v| v.get("decision_sha256"))
                .and_then(|v| v.as_str())
                != Some(decision_sha256.as_str())
            {
                return Err(StoreError::Conflict(
                    "confirmation decision differs or old decision cannot be verified".into(),
                ));
            }
            if suggestion.approved_reply_class != Some(input.approved_reply_class)
                || suggestion.approved_send_mode != Some(input.approved_send_mode)
            {
                return Err(StoreError::Conflict(
                    "confirmation differs from the recorded decision".into(),
                ));
            }
            return Ok(ConfirmOutcome {
                suggestion,
                events: Vec::new(),
                todos: Vec::new(),
                already_confirmed: true,
            });
        }

        let now = now_utc();
        let mut events: Vec<StoredEvent> = Vec::new();
        let mut todos: Vec<Todo> = Vec::new();

        // 1. 证据若绑定在其他申请(或收件箱),先在同一事务内改关联。
        if evidence.application_id.as_deref() != Some(input.application_id.as_str()) {
            self.associate_evidence(&evidence.id, &input.application_id)?;
        }

        // 2. 批准值写正式证据字段,并记录到建议行。
        self.conn().execute(
            "UPDATE reply_evidence SET reply_class = ?1, send_mode = ?2 WHERE id = ?3",
            params![
                input.approved_reply_class.as_str(),
                input.approved_send_mode.as_str(),
                suggestion.evidence_id,
            ],
        )?;
        let status = if input.approved_reply_class == suggestion.suggested_reply_class
            && input.approved_send_mode == suggestion.suggested_send_mode
        {
            SuggestionStatus::Confirmed
        } else {
            SuggestionStatus::ModifiedConfirmed
        };
        self.conn().execute(
            "UPDATE ai_suggestions SET status = ?1, decided_at = ?2, approved_reply_class = ?3, \
             approved_send_mode = ?4, approved_stage = ?5 WHERE id = ?6",
            params![
                status.as_str(),
                now,
                input.approved_reply_class.as_str(),
                input.approved_send_mode.as_str(),
                input.stage_event.as_ref().map(stage_event_target),
                input.suggestion_id,
            ],
        )?;

        // 3. 分类事件(批准值;引用证据 id)。
        let classified = EventDraft {
            occurred: Occurred::DateTime {
                rfc3339: now.clone(),
                time_zone: None,
            },
            source: EventSource::AiConfirmed,
            source_request_id: Some(suggestion.id.clone()),
            actor: Actor::User,
            payload: EventPayload::EvidenceClassified {
                decision_sha256: Some(decision_sha256),
                evidence_id: suggestion.evidence_id.clone(),
                reply_class: input.approved_reply_class.as_str().into(),
                send_mode: input.approved_send_mode.as_str().into(),
            },
        };
        events.extend(self.append_events(Some(&input.application_id), &[classified], &now)?);

        // 4. 阶段事件:同一事务折叠(用户明确选择的 update_progress 语义)。
        if let Some(mut draft) = input.stage_event {
            draft.source = EventSource::AiConfirmed;
            draft.source_request_id = Some(suggestion.id.clone());
            draft.actor = Actor::User;
            events.extend(self.append_events(Some(&input.application_id), &[draft], &now)?);
        }

        // 5. 建议待办转正(引用分类事件)。
        if input.create_todos {
            let source_event_id = events.last().map(|e| e.id.clone());
            for st in &suggestion.suggested_todos {
                let todo = self.create_todo(NewTodo {
                    application_id: input.application_id.clone(),
                    title: st.title.clone(),
                    due: st.due.clone(),
                    time_zone: None,
                    remind_at_utc: None,
                    interview_round: st.interview_round,
                    source_event_id: source_event_id.clone(),
                })?;
                todos.push(todo);
            }
        }

        // 6. 投影刷新。
        self.recompute_reply_state(&input.application_id)?;

        let suggestion = self.get_suggestion(&input.suggestion_id)?.ok_or_else(|| {
            StoreError::Internal("suggestion vanished in same transaction".into())
        })?;
        Ok(ConfirmOutcome {
            suggestion,
            events,
            todos,
            already_confirmed: false,
        })
    }

    /// 拒绝/暂存建议(不做任何正式写入)。
    pub fn set_suggestion_status(
        &mut self,
        id: &str,
        status: SuggestionStatus,
    ) -> Result<AiSuggestion, StoreError> {
        if let Some(current) = self.get_suggestion(id)? {
            if matches!(
                current.status,
                SuggestionStatus::Confirmed | SuggestionStatus::ModifiedConfirmed
            ) {
                return Err(StoreError::Conflict(
                    "confirmed suggestions cannot be reopened".into(),
                ));
            }
        }
        if !matches!(
            status,
            SuggestionStatus::Rejected | SuggestionStatus::Deferred | SuggestionStatus::Pending
        ) {
            return Err(StoreError::Validation(
                "use confirm_suggestion for confirmations".into(),
            ));
        }
        let now = now_utc();
        let n = self.conn().execute(
            "UPDATE ai_suggestions SET status = ?1, decided_at = ?2 WHERE id = ?3",
            params![status.as_str(), now, id],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound(format!("suggestion {id}")));
        }
        self.get_suggestion(id)?
            .ok_or_else(|| StoreError::Internal("suggestion vanished in same transaction".into()))
    }
}

fn stage_event_target(draft: &EventDraft) -> Option<String> {
    match &draft.payload {
        EventPayload::StageCorrected { to, .. } => Some(to.as_str().to_string()),
        other => other.stage_update_mode().map(|_| {
            // 记录该事件期望的目标阶段,便于诊断;折叠仍以事件表为准。
            match other {
                EventPayload::AssessmentRecorded { .. } => Stage::Assessment.as_str().to_string(),
                EventPayload::InterviewRecorded { .. } => Stage::Interview.as_str().to_string(),
                EventPayload::InterviewRescheduled { .. } => Stage::Interview.as_str().to_string(),
                EventPayload::OfferRecorded { .. } => Stage::Offer.as_str().to_string(),
                EventPayload::Rejected { .. } => Stage::Rejected.as_str().to_string(),
                EventPayload::Withdrawn { .. } => Stage::Withdrawn.as_str().to_string(),
                EventPayload::Closed { .. } => Stage::Closed.as_str().to_string(),
                EventPayload::SubmitConfirmed { .. } => Stage::Submitted.as_str().to_string(),
                _ => Stage::Saved.as_str().to_string(),
            }
        }),
    }
}

pub(crate) fn map_suggestion_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AiSuggestion> {
    let status_raw: String = r.get(2)?;
    let candidates_json: String = r.get(3)?;
    let stage_raw: Option<String> = r.get(4)?;
    let class_raw: String = r.get(6)?;
    let mode_raw: String = r.get(7)?;
    let todos_json: String = r.get(8)?;
    let excerpt: Option<String> = r.get(9)?;
    let uncertainties: Option<String> = r.get(10)?;
    let approved_class: Option<String> = r.get(15)?;
    let approved_mode: Option<String> = r.get(16)?;
    let approved_stage: Option<String> = r.get(17)?;
    Ok(AiSuggestion {
        id: r.get(0)?,
        evidence_id: r.get(1)?,
        status: SuggestionStatus::parse(&status_raw).unwrap_or(SuggestionStatus::Pending),
        candidate_application_ids: serde_json::from_str(&candidates_json).unwrap_or_default(),
        suggested_stage: stage_raw.as_deref().and_then(Stage::parse),
        suggested_round: r.get(5)?,
        suggested_reply_class: ReplyClass::parse(&class_raw).unwrap_or(ReplyClass::Unknown),
        suggested_send_mode: SendMode::parse(&mode_raw).unwrap_or(SendMode::Unknown),
        suggested_todos: serde_json::from_str(&todos_json).unwrap_or_default(),
        excerpt_refs: excerpt.and_then(|s| serde_json::from_str(&s).ok()),
        uncertainties: uncertainties.and_then(|s| serde_json::from_str(&s).ok()),
        model_label: r.get(11)?,
        prompt_scope: r.get(12)?,
        created_at: r.get(13)?,
        decided_at: r.get(14)?,
        approved_reply_class: approved_class.as_deref().and_then(ReplyClass::parse),
        approved_send_mode: approved_mode.as_deref().and_then(SendMode::parse),
        approved_stage: approved_stage.as_deref().and_then(Stage::parse),
    })
}
