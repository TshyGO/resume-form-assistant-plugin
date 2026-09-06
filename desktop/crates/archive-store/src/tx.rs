//! 事务层:所有业务操作都在 [StoreTx] 上执行,由 [crate::ArchiveStore::transaction]
//! 或 `&self` 便捷方法包进单个 SQLite 事务。阶段投影与事件写入同事务,
//! 回滚不留半成品(事件没写 → 阶段不变;序号不空洞)。

use rusqlite::{params, Connection, Transaction};

use crate::error::StoreError;
use crate::model::*;
use crate::stage::{fold_stage, Fold, Stage, StageUpdateMode};
use crate::timeutil::{now_utc, Occurred};
use crate::identity::new_uuid;

pub struct StoreTx<'a> {
    pub(crate) tx: Transaction<'a>,
    pub(crate) archive_id: String,
}

impl<'a> StoreTx<'a> {
    pub(crate) fn new(tx: Transaction<'a>, archive_id: String) -> Self {
        Self { tx, archive_id }
    }

    pub(crate) fn commit(self) -> Result<(), StoreError> {
        self.tx.commit().map_err(StoreError::from)
    }

    pub(crate) fn rollback(self) -> Result<(), StoreError> {
        self.tx.rollback().map_err(StoreError::from)
    }

    pub(crate) fn conn(&mut self) -> &mut Connection {
        &mut self.tx
    }

    // ------------------------------------------------------------------
    // 事件追加:eventSequence 分配 + 阶段折叠 + replyEvidenceState 投影,
    // 全部在同一事务内。
    // ------------------------------------------------------------------

    /// 追加一批事件。`application_id` 为 None 时使用档案级收件箱序号
    /// (`inbox_event_sequence`),不参与任何申请的阶段折叠。
    ///
    /// 序号从 `last_event_sequence + 1` 起连续分配;回滚后下一笔仍从
    /// 失败前的值继续(无空洞)。`recordedAt` 只表示时间,不做折叠键。
    pub fn append_events(
        &mut self,
        application_id: Option<&str>,
        drafts: &[EventDraft],
        recorded_at: &str,
    ) -> Result<Vec<StoredEvent>, StoreError> {
        let mut stored = Vec::with_capacity(drafts.len());
        for draft in drafts {
            let (occurred_at, precision, tz) = draft.occurred.to_columns()?;
            let event_type = draft.payload.event_type();
            let payload_json = draft.payload.to_json()?;

            let event_id = new_uuid();
            let (sequence, prior_stage) = match application_id {
                Some(app_id) => {
                    let (stage, last) = self.stage_and_sequence(app_id)?;
                    (last + 1, Some(stage))
                }
                None => (self.next_inbox_sequence()?, None),
            };

            // 阶段折叠:history_only 事件保留序号但阶段效应全部 no-op(§6.2)。
            if let Some(prior) = prior_stage {
                let app_id = application_id.expect("checked");
                let mode = draft
                    .payload
                    .stage_update_mode()
                    .unwrap_or(StageUpdateMode::UpdateProgress);
                let target = match &draft.payload {
                    EventPayload::StageCorrected { to, .. } => Some(*to),
                    _ => None,
                };
                let new_stage = match fold_stage(prior, &event_type, mode, target) {
                    Fold::To(s) => s,
                    Fold::NoOp => prior,
                };
                self.tx.execute(
                    "UPDATE applications SET current_stage = ?1, last_event_sequence = ?2, updated_at = ?3 WHERE id = ?4",
                    params![new_stage.as_str(), sequence, recorded_at, app_id],
                )?;
                if matches!(
                    event_type.as_str(),
                    "evidence_imported" | "evidence_associated" | "association_changed" | "evidence_classified"
                ) {
                    self.recompute_reply_state(app_id)?;
                }
            }

            self.tx.execute(
                "INSERT INTO events (id, application_id, event_sequence, event_type, occurred_at, \
                 occurred_precision, recorded_at, time_zone, source, source_request_id, \
                 payload_version, payload, actor) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    event_id,
                    application_id,
                    sequence,
                    event_type,
                    occurred_at,
                    precision,
                    recorded_at,
                    tz,
                    draft.source.as_str(),
                    draft.source_request_id,
                    PAYLOAD_VERSION_V1,
                    payload_json,
                    draft.actor.as_str(),
                ],
            )?;

            stored.push(StoredEvent {
                id: event_id,
                application_id: application_id.map(str::to_string),
                event_sequence: sequence,
                event_type,
                occurred: draft.occurred.clone(),
                recorded_at: recorded_at.to_string(),
                source: draft.source,
                source_request_id: draft.source_request_id.clone(),
                payload_version: PAYLOAD_VERSION_V1,
                payload: draft.payload.clone(),
                actor: draft.actor,
            });
        }
        Ok(stored)
    }

    /// 单事件的便捷封装。
    pub fn append_event(
        &mut self,
        application_id: Option<&str>,
        draft: EventDraft,
    ) -> Result<StoredEvent, StoreError> {
        let now = now_utc();
        Ok(self.append_events(application_id, &[draft], &now)?.remove(0))
    }

    /// 读取申请的当前阶段与已提交最大序号。
    pub(crate) fn stage_and_sequence(&self, application_id: &str) -> Result<(Stage, i64), StoreError> {
        self.tx
            .query_row(
                "SELECT current_stage, last_event_sequence FROM applications WHERE id = ?1",
                params![application_id],
                |r| {
                    let stage_raw: String = r.get(0)?;
                    let seq: i64 = r.get(1)?;
                    Ok((Stage::parse(&stage_raw).ok_or_else(|| {
                        StoreError::Validation(format!("corrupt stage `{stage_raw}`"))
                    })?, seq))
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    StoreError::NotFound(format!("application {application_id}"))
                }
                other => other.into(),
            })
    }

    /// 申请存在性校验(供外键前置错误信息更友好)。
    pub(crate) fn ensure_application(&self, application_id: &str) -> Result<(), StoreError> {
        self.stage_and_sequence(application_id).map(|_| ())
    }

    /// 档案级收件箱序号:单调递增,与申请序号相互独立。
    pub(crate) fn next_inbox_sequence(&self) -> Result<i64, StoreError> {
        let next: i64 = self
            .tx
            .query_row(
                "SELECT value FROM counters WHERE name = 'inbox_event_sequence'",
                [],
                |r| r.get(0),
            )
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(0),
                other => Err(other),
            })?
            + 1;
        self.tx.execute(
            "INSERT INTO counters (name, value) VALUES ('inbox_event_sequence', ?1) \
             ON CONFLICT(name) DO UPDATE SET value = ?1",
            params![next],
        )?;
        Ok(next)
    }

    /// replyEvidenceState 投影(§6.3):只看当前仍关联到该申请的证据;
    /// 已确认分类集合 C 由 reply_class 非空且非 unknown 组成。
    pub(crate) fn recompute_reply_state(
        &mut self,
        application_id: &str,
    ) -> Result<ReplyEvidenceState, StoreError> {
        let mut stmt = self.tx.prepare(
            "SELECT reply_class FROM reply_evidence WHERE application_id = ?1",
        )?;
        let rows = stmt.query_map(params![application_id], |r| r.get::<_, Option<String>>(0))?;
        let mut has_evidence = false;
        let mut classes: Vec<ReplyClass> = Vec::new();
        for row in rows {
            has_evidence = true;
            if let Some(raw) = row? {
                if let Some(cls) = ReplyClass::parse(&raw) {
                    if cls != ReplyClass::Unknown && !classes.contains(&cls) {
                        classes.push(cls);
                    }
                }
            }
        }
        drop(stmt);

        let state = if !has_evidence {
            ReplyEvidenceState::NoneImported
        } else if classes.is_empty() {
            ReplyEvidenceState::ImportedUnclassified
        } else {
            let has_ack = classes.contains(&ReplyClass::AutoAck);
            let has_business = classes
                .iter()
                .any(|c| !matches!(c, ReplyClass::AutoAck | ReplyClass::Unknown));
            match (has_ack, has_business) {
                (true, true) => ReplyEvidenceState::Mixed,
                (true, false) => ReplyEvidenceState::AutoAck,
                (false, true) => ReplyEvidenceState::Classified,
                (false, false) => unreachable!("non-empty C must contain a non-unknown class"),
            }
        };
        self.tx.execute(
            "UPDATE applications SET reply_evidence_state = ?1 WHERE id = ?2",
            params![state.as_str(), application_id],
        )?;
        Ok(state)
    }

    // ------------------------------------------------------------------
    // 事件查询:按持久化 eventSequence 排序(不做 recordedAt 排序)。
    // ------------------------------------------------------------------

    pub fn list_events(&self, application_id: &str) -> Result<Vec<StoredEvent>, StoreError> {
        let mut stmt = self.tx.prepare(
            "SELECT id, application_id, event_sequence, occurred_at, occurred_precision, \
             recorded_at, time_zone, source, source_request_id, payload_version, payload, actor, \
             event_type FROM events WHERE application_id = ?1 ORDER BY event_sequence ASC",
        )?;
        let rows = stmt.query_map(params![application_id], map_event_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    /// 收件箱事件(未关联申请),档案级序号排序。
    pub fn list_inbox_events(&self) -> Result<Vec<StoredEvent>, StoreError> {
        let mut stmt = self.tx.prepare(
            "SELECT id, application_id, event_sequence, occurred_at, occurred_precision, \
             recorded_at, time_zone, source, source_request_id, payload_version, payload, actor, \
             event_type FROM events WHERE application_id IS NULL ORDER BY event_sequence ASC",
        )?;
        let rows = stmt.query_map([], map_event_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    pub fn get_event(&self, event_id: &str) -> Result<StoredEvent, StoreError> {
        self.tx
            .query_row(
                "SELECT id, application_id, event_sequence, occurred_at, occurred_precision, \
                 recorded_at, time_zone, source, source_request_id, payload_version, payload, actor, \
                 event_type FROM events WHERE id = ?1",
                params![event_id],
                map_event_row,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => StoreError::NotFound(format!("event {event_id}")),
                other => other.into(),
            })
    }
}

pub(crate) fn map_event_row(
    r: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredEvent> {
    let application_id: Option<String> = r.get(1)?;
    let occurred_at: Option<String> = r.get(3)?;
    let precision: String = r.get(4)?;
    let tz: Option<String> = r.get(6)?;
    let source_raw: String = r.get(7)?;
    let actor_raw: String = r.get(11)?;
    let payload_json: String = r.get(10)?;
    let payload: EventPayload = serde_json::from_str(&payload_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let occurred = Occurred::from_columns(occurred_at.as_deref(), &precision, tz.as_deref())
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
        })?;
    Ok(StoredEvent {
        id: r.get(0)?,
        application_id,
        event_sequence: r.get(2)?,
        occurred,
        recorded_at: r.get(5)?,
        source: EventSource::parse(&source_raw).unwrap_or(EventSource::Manual),
        source_request_id: r.get(8)?,
        payload_version: r.get(9)?,
        payload,
        actor: Actor::parse(&actor_raw).unwrap_or(Actor::System),
        // event_type 以 payload 为准(列值冗余仅供 SQL 检查约束/索引)。
        event_type: payload.event_type(),
    })
}

/// 附件/快照受控相对路径校验(隐私 §3):拒绝绝对路径、`..`、盘符、UNC、反斜杠。
pub(crate) fn validate_rel_path(rel: &str) -> Result<(), StoreError> {
    let invalid = |why: &str| StoreError::PathInvalid(format!("`{rel}`: {why}"));
    if rel.is_empty() {
        return Err(invalid("empty path"));
    }
    if rel.contains('\\') {
        return Err(invalid("backslash is not allowed; use '/'"));
    }
    if rel.starts_with('/') || rel.starts_with(':') {
        return Err(invalid("absolute path"));
    }
    if rel.contains(':') {
        return Err(invalid("drive letter / colon"));
    }
    if rel.starts_with("//") {
        return Err(invalid("UNC path"));
    }
    for comp in rel.split('/') {
        if comp == ".." || comp == "." {
            return Err(invalid("path traversal component"));
        }
    }
    Ok(())
}
