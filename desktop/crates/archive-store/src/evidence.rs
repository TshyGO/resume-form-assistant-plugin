//! 回复证据与附件 blob 元数据(§8.4)。
//!
//! 字节在库外:D03 只登记 sha256、大小与受控相对路径,不写文件、不做导入
//! (D09)。`replyClass` / `sendMode` 确认前可空;AI 建议走
//! [crate::model::AiSuggestion],不借用正式字段暂存。

use rusqlite::params;

use crate::error::StoreError;
use crate::model::*;
use crate::timeutil::now_utc;
use crate::tx::{new_uuid, validate_rel_path, StoreTx};

#[derive(Debug, Clone, serde::Serialize)]
pub struct AttachmentRefReport {
    pub total_blobs: usize,
    pub total_evidence: usize,
    /// ref_count = 0 的 blob 行已可由 D09/D12 安全清理(文件同样)。
    pub zero_ref_blobs: Vec<String>,
    /// 证据指向缺失 blob 行的悬空引用(正常应为空;FK 防线之外的对账检查)。
    pub dangling_evidence: Vec<String>,
    pub invalid_files: Vec<String>,
}

impl StoreTx<'_> {
    /// 导入证据并登记 blob 元数据。`application_id` 为 None 时进收件箱,
    /// 事件使用档案级 `inbox_event_sequence`。
    pub fn import_evidence(&mut self, input: NewEvidence) -> Result<ReplyEvidence, StoreError> {
        validate_rel_path(&input.blob.stored_rel_path)?;
        if input.blob.sha256.len() != 64
            || !input.blob.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(StoreError::Validation(
                "blob sha256 must be 64 hex chars".into(),
            ));
        }
        if input.blob.size_bytes < 0 {
            return Err(StoreError::Validation("blob size must be >= 0".into()));
        }
        if let Some(app) = &input.application_id {
            self.ensure_application(app)?;
        }

        let now = now_utc();
        let id = new_uuid();

        // blob 元数据 upsert(同一字节被多条申请引用时不复制文件)。
        self.conn().execute(
            "INSERT INTO attachment_blobs (sha256, size_bytes, stored_rel_path, ref_count, mime) \
             VALUES (?1, ?2, ?3, 0, ?4) \
             ON CONFLICT(sha256) DO NOTHING",
            params![
                input.blob.sha256,
                input.blob.size_bytes,
                input.blob.stored_rel_path,
                input.blob.mime
            ],
        )?;
        let recorded: (i64, String) = self.conn().query_row(
            "SELECT size_bytes, stored_rel_path FROM attachment_blobs WHERE sha256=?1",
            [&input.blob.sha256],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if recorded != (input.blob.size_bytes, input.blob.stored_rel_path.clone()) {
            return Err(StoreError::Conflict(
                "blob metadata differs from existing immutable blob".into(),
            ));
        }
        let (sent_at, sent_precision, sent_tz) = input
            .sent_at
            .as_ref()
            .map(|o| o.to_columns())
            .transpose()?
            .unwrap_or((None, "unknown", None));
        self.conn().execute(
            "INSERT INTO reply_evidence (id, application_id, kind, reply_class, send_mode, \
             blob_sha256, original_filename, imported_at, subject, from_addr, sent_at, \
             sent_precision, sent_tz, body_extract) \
             VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id,
                input.application_id,
                input.kind.as_str(),
                input.blob.sha256,
                input.original_filename,
                now,
                input.subject,
                input.from_addr,
                sent_at,
                sent_precision,
                sent_tz,
                input.body_extract,
            ],
        )?;
        self.conn().execute(
            "UPDATE attachment_blobs SET ref_count = (SELECT COUNT(*) FROM reply_evidence WHERE blob_sha256 = ?1) WHERE sha256 = ?1",
            params![input.blob.sha256],
        )?;

        if input.append_event {
            match input.application_id.as_deref() {
                Some(app) => {
                    let imported = EventDraft {
                        occurred: Occurred::DateTime {
                            rfc3339: now.clone(),
                            time_zone: None,
                        },
                        source: EventSource::Import,
                        source_request_id: None,
                        actor: Actor::User,
                        payload: EventPayload::EvidenceImported {
                            evidence_id: id.clone(),
                        },
                    };
                    let associated = EventDraft {
                        occurred: Occurred::DateTime {
                            rfc3339: now.clone(),
                            time_zone: None,
                        },
                        source: EventSource::Import,
                        source_request_id: None,
                        actor: Actor::User,
                        payload: EventPayload::EvidenceAssociated {
                            evidence_id: id.clone(),
                            application_id: app.to_string(),
                        },
                    };
                    self.append_events(Some(app), &[imported, associated], &now)?;
                }
                None => {
                    let imported = EventDraft {
                        occurred: Occurred::DateTime {
                            rfc3339: now.clone(),
                            time_zone: None,
                        },
                        source: EventSource::Import,
                        source_request_id: None,
                        actor: Actor::User,
                        payload: EventPayload::EvidenceImported {
                            evidence_id: id.clone(),
                        },
                    };
                    // 收件箱事件:档案级序号,不参与阶段折叠。
                    self.append_events(None, &[imported], &now)?;
                }
            }
        }

        self.get_evidence(&id)?
            .ok_or_else(|| StoreError::Internal("evidence vanished in same transaction".into()))
    }

    /// 改关联(§7 规则 6):保留原始 blob;从收件箱绑定记 evidence_associated,
    /// 在申请间移动记 association_changed(from/to)。
    pub fn associate_evidence(
        &mut self,
        evidence_id: &str,
        to_application: &str,
    ) -> Result<ReplyEvidence, StoreError> {
        let ev = self
            .get_evidence(evidence_id)?
            .ok_or_else(|| StoreError::NotFound(format!("evidence {evidence_id}")))?;
        self.ensure_application(to_application)?;
        if ev.application_id.as_deref() == Some(to_application) {
            return Ok(ev);
        }
        let now = now_utc();
        self.conn().execute(
            "UPDATE reply_evidence SET application_id = ?1 WHERE id = ?2",
            params![to_application, evidence_id],
        )?;

        let draft = EventDraft {
            occurred: Occurred::DateTime {
                rfc3339: now.clone(),
                time_zone: None,
            },
            source: EventSource::Manual,
            source_request_id: None,
            actor: Actor::User,
            payload: match ev.application_id.clone() {
                None => EventPayload::EvidenceAssociated {
                    evidence_id: evidence_id.to_string(),
                    application_id: to_application.to_string(),
                },
                Some(from) => EventPayload::AssociationChanged {
                    evidence_id: evidence_id.to_string(),
                    from_application_id: Some(from),
                    to_application_id: to_application.to_string(),
                },
            },
        };
        self.append_events(Some(to_application), &[draft], &now)?;
        // 取消关联后旧申请的投影不再计入(§6.3)。
        if let Some(old) = &ev.application_id {
            self.recompute_reply_state(old)?;
        }
        self.get_evidence(evidence_id)?
            .ok_or_else(|| StoreError::Internal("evidence vanished in same transaction".into()))
    }

    /// 手动/确认后分类(确认前的建议走 AiSuggestion)。
    /// 事件 `evidence_classified` 为 no-op 折叠;只影响 replyEvidenceState 投影。
    pub fn classify_evidence(
        &mut self,
        evidence_id: &str,
        reply_class: ReplyClass,
        send_mode: SendMode,
    ) -> Result<ReplyEvidence, StoreError> {
        let ev = self
            .get_evidence(evidence_id)?
            .ok_or_else(|| StoreError::NotFound(format!("evidence {evidence_id}")))?;
        let now = now_utc();
        self.conn().execute(
            "UPDATE reply_evidence SET reply_class = ?1, send_mode = ?2 WHERE id = ?3",
            params![reply_class.as_str(), send_mode.as_str(), evidence_id],
        )?;
        let draft = EventDraft {
            occurred: Occurred::DateTime {
                rfc3339: now.clone(),
                time_zone: None,
            },
            source: EventSource::Manual,
            source_request_id: None,
            actor: Actor::User,
            payload: EventPayload::EvidenceClassified {
                evidence_id: evidence_id.to_string(),
                reply_class: reply_class.as_str().into(),
                send_mode: send_mode.as_str().into(),
            },
        };
        match ev.application_id.as_deref() {
            Some(app) => {
                self.append_events(Some(app), &[draft], &now)?;
            }
            None => {
                self.append_events(None, &[draft], &now)?;
            }
        }
        self.get_evidence(evidence_id)?
            .ok_or_else(|| StoreError::Internal("evidence vanished in same transaction".into()))
    }

    pub fn get_evidence(&self, id: &str) -> Result<Option<ReplyEvidence>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT e.id, e.application_id, e.kind, e.reply_class, e.send_mode, \
             b.sha256, b.size_bytes, b.stored_rel_path, b.ref_count, b.mime, \
             e.original_filename, e.imported_at, e.subject, e.from_addr, e.sent_at, \
             e.sent_precision, e.sent_tz, e.body_extract \
             FROM reply_evidence e JOIN attachment_blobs b ON b.sha256 = e.blob_sha256 \
             WHERE e.id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], map_evidence_row)?;
        rows.next().transpose().map_err(StoreError::from)
    }

    /// `application_id = None` 表示收件箱(未关联)证据。
    pub fn list_evidence(
        &self,
        application_id: Option<&str>,
    ) -> Result<Vec<ReplyEvidence>, StoreError> {
        let sql = "SELECT e.id, e.application_id, e.kind, e.reply_class, e.send_mode, \
                   b.sha256, b.size_bytes, b.stored_rel_path, b.ref_count, b.mime, \
                   e.original_filename, e.imported_at, e.subject, e.from_addr, e.sent_at, \
                   e.sent_precision, e.sent_tz, e.body_extract \
                   FROM reply_evidence e JOIN attachment_blobs b ON b.sha256 = e.blob_sha256 \
                   WHERE e.application_id IS ?1 ORDER BY e.imported_at ASC";
        let mut stmt = self.conn().prepare(sql)?;
        let rows = stmt.query_map(params![application_id], map_evidence_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// 维护检查(不自动删除):零引用 blob 与悬空证据引用。
    pub fn check_attachment_refs(&self) -> Result<AttachmentRefReport, StoreError> {
        let total_blobs: usize =
            self.conn()
                .query_row("SELECT COUNT(*) FROM attachment_blobs", [], |r| {
                    r.get::<_, i64>(0)
                })? as usize;
        let total_evidence: usize =
            self.conn()
                .query_row("SELECT COUNT(*) FROM reply_evidence", [], |r| {
                    r.get::<_, i64>(0)
                })? as usize;
        let mut zero_ref_blobs = Vec::new();
        {
            let mut stmt = self
                .conn()
                .prepare("SELECT sha256 FROM attachment_blobs WHERE ref_count = 0")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            for row in rows {
                zero_ref_blobs.push(row?);
            }
        }
        let mut dangling_evidence = Vec::new();
        {
            let mut stmt = self.conn().prepare(
                "SELECT e.id FROM reply_evidence e LEFT JOIN attachment_blobs b \
                 ON b.sha256 = e.blob_sha256 WHERE b.sha256 IS NULL",
            )?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            for row in rows {
                dangling_evidence.push(row?);
            }
        }
        let mut invalid_files = Vec::new();
        let mut stmt = self.conn().prepare("SELECT stored_rel_path, size_bytes, sha256 FROM attachment_blobs UNION ALL SELECT stored_rel_path, byte_size, sha256 FROM resume_snapshots")?;
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (rel, size, sha) = row?;
            if crate::tx::verify_file(&self.archive_dir, &rel, size, &sha).is_err() {
                invalid_files.push(rel);
            }
        }
        Ok(AttachmentRefReport {
            total_blobs,
            total_evidence,
            zero_ref_blobs,
            dangling_evidence,
            invalid_files,
        })
    }
}

pub(crate) fn map_evidence_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ReplyEvidence> {
    let kind_raw: String = r.get(2)?;
    let reply_raw: Option<String> = r.get(3)?;
    let send_raw: Option<String> = r.get(4)?;
    let sent_at: Option<String> = r.get(14)?;
    let sent_precision: String = r.get(15)?;
    let sent_tz: Option<String> = r.get(16)?;
    let sent_occurred =
        Occurred::from_columns(sent_at.as_deref(), &sent_precision, sent_tz.as_deref()).ok();
    Ok(ReplyEvidence {
        id: r.get(0)?,
        application_id: r.get(1)?,
        kind: EvidenceKind::parse(&kind_raw).unwrap_or(EvidenceKind::Unknown),
        reply_class: reply_raw.as_deref().and_then(ReplyClass::parse),
        send_mode: send_raw.as_deref().and_then(SendMode::parse),
        blob: AttachmentBlob {
            meta: AttachmentBlobMeta {
                sha256: r.get(5)?,
                size_bytes: r.get(6)?,
                stored_rel_path: r.get(7)?,
                mime: r.get(9)?,
            },
            ref_count: r.get(8)?,
        },
        original_filename: r.get(10)?,
        imported_at: r.get(11)?,
        subject: r.get(12)?,
        from_addr: r.get(13)?,
        sent_at: sent_occurred,
        body_extract: r.get(17)?,
    })
}
