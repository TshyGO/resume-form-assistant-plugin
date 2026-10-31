//! 回复证据与附件 blob 元数据(§8.4)。
//!
//! 字节在库外:D03 只登记 sha256、大小与受控相对路径,不写文件、不做导入
//! (D09)。`replyClass` / `sendMode` 确认前可空;AI 建议走
//! [crate::model::AiSuggestion],不借用正式字段暂存。

use rusqlite::{params, OptionalExtension};

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
        let mut input = input;
        input.blob.sha256.make_ascii_lowercase();
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
        let message_id = input.message_id.as_deref().filter(|id| !id.is_empty());
        self.conn().execute(
            "INSERT INTO reply_evidence (id, application_id, kind, reply_class, send_mode, \
             blob_sha256, original_filename, imported_at, subject, from_addr, sent_at, \
             sent_precision, sent_tz, body_extract, message_id) \
             VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
                message_id,
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

        if let Some(app) = &input.application_id {
            self.recompute_reply_state(app)?;
        }
        self.get_evidence(&id)?
            .ok_or_else(|| StoreError::Internal("evidence vanished in same transaction".into()))
    }

    /// 带 Message-ID 的邮件先查重:已在档案里就不新建记录。
    pub fn import_or_match_evidence(
        &mut self,
        input: NewEvidence,
    ) -> Result<EvidenceImportOutcome, StoreError> {
        if let Some(key) = input.mail_key() {
            if let Some(existing) = self.match_known_mail(&key, input.application_id.as_deref())? {
                return Ok(EvidenceImportOutcome::AlreadyStored(existing));
            }
        }
        self.import_evidence(input)
            .map(EvidenceImportOutcome::Imported)
    }

    /// 这封信已经在档案里时返回那条证据。命中的是收件箱里还没关联的那条、而这次
    /// 导入指定了申请时,顺手关联过去;已属另一条申请则不动它。
    pub fn match_known_mail(
        &mut self,
        key: &MailKey,
        application_id: Option<&str>,
    ) -> Result<Option<ReplyEvidence>, StoreError> {
        let Some(existing) = self.find_known_mail(key)? else {
            return Ok(None);
        };
        // Dedup and in-flight import retries must not undo a later user recycle action.
        // Restore is explicit; keep the original association while the mail is recycled.
        if self.is_evidence_recycled(&existing.id)? {
            return Ok(Some(existing));
        }
        match (&existing.application_id, application_id) {
            (None, Some(app)) => self.associate_evidence(&existing.id, app).map(Some),
            _ => Ok(Some(existing)),
        }
    }

    /// 按 Message-ID、发件人、发送时间找已有的证据(最早导入的那条)。回收站里申请下的
    /// 证据不算:用户看不到它,说「已存在」只会让人找不着。
    pub fn find_known_mail(&self, key: &MailKey) -> Result<Option<ReplyEvidence>, StoreError> {
        // 空串是「查过、没有编号」的标记，不是编号。
        if key.message_id.is_empty() {
            return Ok(None);
        }
        // 发送时间按入库时的同一套规则规范化，才能和库里的列逐字比较。
        let sent_at = match &key.sent_at {
            Some(occurred) => occurred.to_columns()?.0,
            None => None,
        };
        // `message_id <> ''` 要写出来：局部索引带着这个条件，查询不写 SQLite 就不用它。
        let id: Option<String> = self
            .conn()
            .query_row(
                "SELECT e.id FROM reply_evidence e \
                 LEFT JOIN applications a ON a.id = e.application_id \
                 WHERE e.message_id = ?1 AND e.message_id <> '' \
                   AND e.from_addr IS ?2 AND e.sent_at IS ?3 \
                   AND (e.application_id IS NULL OR a.recycle_state = 'active') \
                 ORDER BY e.imported_at ASC, e.id ASC LIMIT 1",
                params![key.message_id, key.from_addr, sent_at],
                |r| r.get(0),
            )
            .optional()?;
        match id {
            Some(id) => self.get_evidence(&id),
            None => Ok(None),
        }
    }

    /// 升级前导入、还没补 Message-ID 的 eml 证据。
    pub fn evidence_missing_message_id(&self) -> Result<Vec<MessageIdBackfill>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT e.id, b.stored_rel_path FROM reply_evidence e \
             JOIN attachment_blobs b ON b.sha256 = e.blob_sha256 \
             WHERE e.kind = 'eml' AND e.message_id IS NULL ORDER BY e.imported_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(MessageIdBackfill {
                evidence_id: r.get(0)?,
                stored_rel_path: r.get(1)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// 写回补算结果。`None` 记成空串:查过了、没有编号,下次不再解析。
    /// 只填还空着的行,不覆盖已有的值。
    pub fn record_message_ids(
        &mut self,
        found: &[(String, Option<String>)],
    ) -> Result<usize, StoreError> {
        let mut updated = 0;
        for (evidence_id, message_id) in found {
            updated += self.conn().execute(
                "UPDATE reply_evidence SET message_id = ?1 WHERE id = ?2 AND message_id IS NULL",
                params![message_id.as_deref().unwrap_or(""), evidence_id],
            )?;
        }
        Ok(updated)
    }

    /// 改关联(§7 规则 6):保留原始 blob;从收件箱绑定记 evidence_associated,
    /// 在申请间移动记 association_changed(from/to)。
    pub fn associate_evidence(
        &mut self,
        evidence_id: &str,
        to_application: &str,
    ) -> Result<ReplyEvidence, StoreError> {
        self.ensure_active_evidence(evidence_id)?;
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
                    to_application_id: Some(to_application.to_string()),
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

    /// 取消关联:证据回到收件箱,原申请的投影按 §6.3 重算(可能回到 none_imported)。
    /// 原始 blob 与分类保持不变——用户只是说「这封信不属于那条申请」。
    pub fn unassociate_evidence(&mut self, evidence_id: &str) -> Result<ReplyEvidence, StoreError> {
        self.ensure_active_evidence(evidence_id)?;
        let ev = self
            .get_evidence(evidence_id)?
            .ok_or_else(|| StoreError::NotFound(format!("evidence {evidence_id}")))?;
        let Some(from) = ev.application_id.clone() else {
            return Ok(ev);
        };
        let now = now_utc();
        self.conn().execute(
            "UPDATE reply_evidence SET application_id = NULL WHERE id = ?1",
            params![evidence_id],
        )?;
        let draft = EventDraft {
            occurred: Occurred::DateTime {
                rfc3339: now.clone(),
                time_zone: None,
            },
            source: EventSource::Manual,
            source_request_id: None,
            actor: Actor::User,
            payload: EventPayload::AssociationChanged {
                evidence_id: evidence_id.to_string(),
                from_application_id: Some(from.clone()),
                to_application_id: None,
            },
        };
        // 事件留在原申请的时间线上:那条申请确实发生过「证据被取走」。
        self.append_events(Some(&from), &[draft], &now)?;
        self.recompute_reply_state(&from)?;
        self.get_evidence(evidence_id)?
            .ok_or_else(|| StoreError::Internal("evidence vanished in same transaction".into()))
    }

    /// 按 sha256 找已经登记的字节。导入管线用它去重,界面用它提示重复导入。
    pub fn find_blob(&self, sha256: &str) -> Result<Option<AttachmentBlob>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT sha256, size_bytes, stored_rel_path, ref_count, mime FROM attachment_blobs \
             WHERE sha256 = ?1",
        )?;
        let mut rows = stmt.query_map(params![sha256.to_lowercase()], |r| {
            Ok(AttachmentBlob {
                meta: AttachmentBlobMeta {
                    sha256: r.get(0)?,
                    size_bytes: r.get(1)?,
                    stored_rel_path: r.get(2)?,
                    mime: r.get(4)?,
                },
                ref_count: r.get(3)?,
            })
        })?;
        rows.next().transpose().map_err(StoreError::from)
    }

    /// 引用同一份字节的证据 id。同哈希不等于同一次导入,也不撤销用户有意的不同关联。
    pub fn evidence_for_blob(&self, sha256: &str) -> Result<Vec<String>, StoreError> {
        let mut stmt = self
            .conn()
            .prepare("SELECT id FROM reply_evidence WHERE blob_sha256 = ?1 ORDER BY imported_at ASC")?;
        let rows = stmt.query_map(params![sha256.to_lowercase()], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    /// 手动/确认后分类(确认前的建议走 AiSuggestion)。
    /// 事件 `evidence_classified` 为 no-op 折叠;只影响 replyEvidenceState 投影。
    pub fn classify_evidence(
        &mut self,
        evidence_id: &str,
        reply_class: ReplyClass,
        send_mode: SendMode,
    ) -> Result<ReplyEvidence, StoreError> {
        self.ensure_active_evidence(evidence_id)?;
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
                decision_sha256: None,
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
                   WHERE e.application_id IS ?1 AND NOT EXISTS \
                   (SELECT 1 FROM evidence_recycle r WHERE r.evidence_id=e.id) ORDER BY e.imported_at ASC";
        let mut stmt = self.conn().prepare(sql)?;
        let rows = stmt.query_map(params![application_id], map_evidence_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn is_evidence_recycled(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM evidence_recycle WHERE evidence_id=?1)",
            [id],
            |r| r.get(0),
        )?)
    }

    pub(crate) fn ensure_active_evidence(&self, id: &str) -> Result<(), StoreError> {
        if self.is_evidence_recycled(id)? {
            return Err(StoreError::Validation(
                "通知已在回收站，请先恢复后再操作。".into(),
            ));
        }
        Ok(())
    }

    pub fn list_recycled_evidence(&self) -> Result<Vec<ReplyEvidence>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT evidence_id FROM evidence_recycle ORDER BY recycled_at DESC, evidence_id",
        )?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| {
                self.get_evidence(&id)?
                    .ok_or_else(|| StoreError::NotFound(id))
            })
            .collect()
    }

    pub fn set_evidence_recycled(
        &mut self,
        id: &str,
        recycled: bool,
    ) -> Result<ReplyEvidence, StoreError> {
        let evidence = self
            .get_evidence(id)?
            .ok_or_else(|| StoreError::NotFound(format!("evidence {id}")))?;
        if self.is_evidence_recycled(id)? == recycled {
            return Ok(evidence);
        }
        if !recycled {
            if let Some(app) = evidence.application_id.as_deref() {
                if self
                    .get_application(app)?
                    .is_some_and(|a| a.recycle_state != RecycleState::Active)
                {
                    return Err(StoreError::Validation(
                        "原申请在回收站，请先恢复申请，再恢复这条通知。".into(),
                    ));
                }
            }
        }
        let now = now_utc();
        if recycled {
            self.conn().execute(
                "INSERT INTO evidence_recycle(evidence_id,recycled_at) VALUES (?1,?2)",
                params![id, now],
            )?;
        } else {
            self.conn()
                .execute("DELETE FROM evidence_recycle WHERE evidence_id=?1", [id])?;
        }
        let event = EventDraft {
            occurred: Occurred::DateTime {
                rfc3339: now.clone(),
                time_zone: None,
            },
            source: EventSource::Manual,
            source_request_id: None,
            actor: Actor::User,
            payload: EventPayload::Custom {
                event_type: if recycled {
                    "custom.evidence_recycled"
                } else {
                    "custom.evidence_restored"
                }
                .into(),
                data: serde_json::json!({"evidence_id": id}),
                stage_update_mode: StageUpdateMode::HistoryOnly,
            },
        };
        self.append_events(evidence.application_id.as_deref(), &[event], &now)?;
        if let Some(app) = evidence.application_id.as_deref() {
            self.recompute_reply_state(app)?;
        }
        Ok(evidence)
    }

    /// Delete only an explicitly recycled notification. Keep zero-reference blob
    /// metadata until the host removes its file, so failed cleanup stays repairable.
    pub fn purge_recycled_evidence(
        &mut self,
        id: &str,
        expected_blob: &str,
    ) -> Result<ReplyEvidence, StoreError> {
        let mut evidence = self.get_evidence(id)?
            .ok_or_else(|| StoreError::NotFound(format!("evidence {id}")))?;
        if !self.is_evidence_recycled(id)? {
            return Err(StoreError::Validation("通知不在回收站，未执行永久删除。".into()));
        }
        if evidence.blob.meta.sha256 != expected_blob {
            return Err(StoreError::Conflict("通知内容已改变，请重新确认删除。".into()));
        }
        self.conn().execute(
            "UPDATE message_receipts SET purged=1 WHERE result_id=?1", [id],
        )?;
        self.conn().execute("DELETE FROM ai_suggestions WHERE evidence_id=?1", [id])?;
        self.conn().execute("DELETE FROM reply_evidence WHERE id=?1", [id])?;
        // Recount actual references, including other recycled notifications.
        self.conn().execute(
            "UPDATE attachment_blobs SET ref_count=(SELECT COUNT(*) FROM reply_evidence WHERE blob_sha256=?1) WHERE sha256=?1",
            [&evidence.blob.meta.sha256],
        )?;
        evidence.blob.ref_count = self.find_blob(&evidence.blob.meta.sha256)?
            .ok_or_else(|| StoreError::NotFound("original blob".into()))?.ref_count;
        let now = now_utc();
        self.append_events(evidence.application_id.as_deref(), &[EventDraft {
            occurred: Occurred::DateTime { rfc3339: now.clone(), time_zone: None },
            source: EventSource::Manual, source_request_id: None, actor: Actor::User,
            payload: EventPayload::Custom {
                event_type: "custom.evidence_purged".into(),
                data: serde_json::json!({"evidence_id": id}),
                stage_update_mode: StageUpdateMode::HistoryOnly,
            },
        }], &now)?;
        if let Some(app) = evidence.application_id.as_deref() {
            self.recompute_reply_state(app)?;
        }
        Ok(evidence)
    }

    /// 维护检查(不自动删除):零引用 blob 与悬空证据引用。
    /// 删掉一条**零引用**的 blob 记录（D12 清理孤儿附件时用）。
    ///
    /// 只删 `ref_count = 0` 的行：还有人引用就什么都不做并返回 false，让调用方
    /// 知道这份附件不该动。文件由调用方删——这一层不碰文件系统。
    pub fn remove_unreferenced_blob(&mut self, sha256: &str) -> Result<bool, StoreError> {
        let removed = self.conn().execute(
            "DELETE FROM attachment_blobs WHERE sha256 = ?1 AND ref_count = 0",
            params![sha256],
        )?;
        Ok(removed > 0)
    }

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
