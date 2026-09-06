//! 提交回执与插件写入幂等(产品需求 §8.10–§8.11、ADR §4 原则)。
//!
//! 普通写入两段校验:
//! 1. 信封 `(archiveId, restoreEpoch)` 必须等于 current 指针(缺失 →
//!    `identity_missing`;不符 → `restore_epoch_mismatch`);
//! 2. 仅在 1 通过后,且 `sourceRestoreEpoch` 也等于 current,才按
//!    `(clientInstanceId, messageId, sourceRestoreEpoch)` + `payloadSha256`
//!    判定重放。旧 epoch 只能走只读对账([StoreTx::reconcile_lookup]),
//!    不得当普通写入重放。
//!
//! 永久删除在同一事务保留最小幂等墓碑(purged 标记,无正文);
//! 重试命中墓碑返回 `previously_purged`,不得重建申请。

use rusqlite::{params, OptionalExtension};

use crate::error::StoreError;
use crate::identity::ArchiveIdentity;
use crate::model::*;
use crate::timeutil::now_utc;
use crate::tx::{new_uuid, validate_rel_path, StoreTx};

#[derive(Debug, Clone)]
pub struct PluginWriteContext {
    /// 请求信封携带的档案身份;None 对应协议 `identity_missing`。
    pub envelope_identity: Option<ArchiveIdentity>,
    pub client_instance_id: String,
    /// 该绑定消息(或 chunk)的幂等 id;块与父消息不得共用。
    pub message_id: String,
    /// 绑定/派发写入时盖章的来源 epoch,不可变。
    pub source_restore_epoch: String,
    /// 业务载荷 sha256(十六进制),由调用方对同一载荷重试保持一致。
    pub payload_sha256: String,
}

#[derive(serde::Serialize)]
pub enum PluginOp {
    /// `job.save`:绑定已有申请(追加 job_saved)或新建申请。
    JobSave(JobSaveInput),
    /// `fill.submit`:填写事件元数据(不含快照字节)。
    FillSubmit(FillSubmitInput),
    /// `submit.confirm`:用户明确确认已投递。
    SubmitConfirm(SubmitConfirmInput),
    /// `snapshot.chunk`:块级回执(每块独立 messageId)。
    SnapshotChunk(SnapshotChunkInput),
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct JobSaveInput {
    /// None = 新建申请(桌面在 job.save 成功时返回新 UUID);
    /// Some(id) = 使用已有申请,追加 job_saved(never-regress)。
    pub target_application_id: Option<String>,
    pub company: String,
    pub title: String,
    pub source_url: Option<String>,
    pub location: Option<String>,
    pub occurred: Occurred,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FillSubmitInput {
    pub application_id: String,
    pub outcome: FillOutcome,
    pub field_count: Option<i64>,
    pub filled_count: Option<i64>,
    pub unconfirmed_count: Option<i64>,
    pub durations_ms: Option<serde_json::Value>,
    /// 已脱敏 URL。
    pub url_redacted: Option<String>,
    pub template_name: Option<String>,
    pub template_version: Option<String>,
    pub snapshot_id: Option<String>,
    pub plugin_version: Option<String>,
    pub occurred: Occurred,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SubmitConfirmInput {
    pub application_id: String,
    /// `desktop` 或 `plugin`。
    pub via: String,
    pub note: Option<String>,
    pub occurred: Occurred,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SnapshotChunkInput {
    pub application_id: Option<String>,
    pub snapshot_id: String,
    pub chunk_index: i64,
    pub chunk_count: i64,
    pub total_sha256: String,
    pub byte_size: i64,
    pub chunk_sha256: String,
    pub template_name: Option<String>,
    pub template_version: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PluginWriteOutcome {
    /// 首次提交成功。
    Committed {
        result_id: String,
        result_kind: String,
    },
    /// 幂等重放命中已提交回执;返回原 resultId,不新增业务事件。
    Replayed {
        result_id: String,
        result_kind: String,
    },
}

impl PluginOp {
    /// Digest of the typed D03 operation, not of a D05 wire envelope.
    pub fn digest(&self) -> Result<String, StoreError> {
        use sha2::{Digest, Sha256};
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(self)?)))
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ReceiptRow {
    pub payload_sha256: String,
    pub operation_sha256: String,
    pub result_id: Option<String>,
    pub result_kind: Option<String>,
    pub purged: bool,
    pub snapshot_id: Option<String>,
    pub chunk_index: Option<i64>,
    pub archive_id: String,
    pub _operation_type: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SnapshotProgress {
    pub client_instance_id: String,
    pub snapshot_id: String,
    pub chunk_count: i64,
    pub total_sha256: String,
    pub full_acked: bool,
    /// 从 0 起连续 ACK 的下一块下标;不得因较后块 ACK 前移(§8.5)。
    pub chunk_cursor: i64,
    pub received_chunks: Vec<i64>,
}

/// 对账查询单项:完整旧身份 + 摘要;快照块另带 snapshotId/chunkIndex。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReconcileQueryItem {
    pub client_instance_id: String,
    pub message_id: String,
    pub source_restore_epoch: String,
    pub payload_sha256: String,
    #[serde(default)]
    pub snapshot_id: Option<String>,
    #[serde(default)]
    pub chunk_index: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ReconcileOutcome {
    /// 完整身份与摘要命中,且对应结果仍有效;不新增业务事件。
    Applied { result_id: String },
    /// 命中墓碑:该消息的对象已被永久删除,不得重建。
    Purged,
    /// 当前库/备份没有该回执;不代表从未执行,不得自动重写(§10.17)。
    NotFound,
    /// 同身份但摘要(或块身份)不符;拒绝自动处理。
    Conflict { reason: String },
    /// 回执存在但引用的结果对象无法核实。
    Unverifiable { reason: String },
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ReconcileReply {
    /// 完整回显请求身份(§8.11:响应逐项回显完整身份)。
    pub item: ReconcileQueryItem,
    pub outcome: ReconcileOutcome,
}

impl StoreTx<'_> {
    // ------------------------------------------------------------------
    // 回执基础操作
    // ------------------------------------------------------------------

    pub(crate) fn find_receipt(
        &self,
        client_instance_id: &str,
        message_id: &str,
        source_restore_epoch: &str,
    ) -> Result<Option<ReceiptRow>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT payload_sha256, result_id, result_kind, purged, snapshot_id, chunk_index, \
             archive_id, operation_type, operation_sha256 FROM message_receipts \
             WHERE client_instance_id = ?1 AND message_id = ?2 AND source_restore_epoch = ?3",
        )?;
        let mut rows = stmt.query_map(
            params![client_instance_id, message_id, source_restore_epoch],
            |r| {
                Ok(ReceiptRow {
                    payload_sha256: r.get(0)?,
                    result_id: r.get(1)?,
                    result_kind: r.get(2)?,
                    purged: r.get::<_, i64>(3)? != 0,
                    snapshot_id: r.get(4)?,
                    chunk_index: r.get(5)?,
                    archive_id: r.get(6)?,
                    _operation_type: r.get(7)?,
                    operation_sha256: r.get(8)?,
                })
            },
        )?;
        match rows.next() {
            Some(row) => row.map(Some).map_err(StoreError::from),
            None => Ok(None),
        }
    }

    pub(crate) fn insert_receipt(&mut self, receipt: ReceiptInsert) -> Result<(), StoreError> {
        self.conn().execute(
            "INSERT INTO message_receipts (archive_id, client_instance_id, message_id, \
             source_restore_epoch, payload_sha256, result_id, result_kind, operation_type, \
             snapshot_id, chunk_index, committed_at, operation_sha256, purged) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0)",
            params![
                receipt.archive_id,
                receipt.client_instance_id,
                receipt.message_id,
                receipt.source_restore_epoch,
                receipt.payload_sha256,
                receipt.result_id,
                receipt.result_kind,
                receipt.operation_type,
                receipt.snapshot_id,
                receipt.chunk_index,
                receipt.committed_at,
                receipt.operation_sha256,
            ],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // 插件操作实现(在两段校验通过后、与回执同事务调用)
    // ------------------------------------------------------------------

    pub(crate) fn op_job_save(
        &mut self,
        input: &JobSaveInput,
        message_id: &str,
        recorded_at: &str,
    ) -> Result<(String, String), StoreError> {
        match &input.target_application_id {
            Some(app_id) => {
                self.ensure_application(app_id)?;
                let draft = EventDraft {
                    occurred: input.occurred.clone(),
                    source: EventSource::Plugin,
                    source_request_id: Some(message_id.into()),
                    actor: Actor::Plugin,
                    payload: EventPayload::JobSaved {
                        company: input.company.clone(),
                        title: input.title.clone(),
                        source_url: input.source_url.clone(),
                        location: input.location.clone(),
                        dedupe_url: None,
                        stage_update_mode: StageUpdateMode::UpdateProgress,
                    },
                };
                self.append_events(Some(app_id), &[draft], recorded_at)?;
                Ok((app_id.clone(), "application".into()))
            }
            None => {
                let app = self.create_application_with_request(
                    NewApplication {
                        company: input.company.clone(),
                        title: input.title.clone(),
                        source_url: input.source_url.clone(),
                        location: input.location.clone(),
                        notes: None,
                        origin: ApplicationOrigin::Plugin,
                        occurred_at: input.occurred.clone(),
                    },
                    Some(message_id.into()),
                )?;
                let draft = EventDraft {
                    occurred: input.occurred.clone(),
                    source: EventSource::Plugin,
                    source_request_id: Some(message_id.into()),
                    actor: Actor::Plugin,
                    payload: EventPayload::JobSaved {
                        company: input.company.clone(),
                        title: input.title.clone(),
                        source_url: input.source_url.clone(),
                        location: input.location.clone(),
                        dedupe_url: None,
                        stage_update_mode: StageUpdateMode::UpdateProgress,
                    },
                };
                self.append_events(Some(&app.summary.id), &[draft], recorded_at)?;
                Ok((app.summary.id, "application".into()))
            }
        }
    }

    pub(crate) fn op_fill_submit(
        &mut self,
        input: &FillSubmitInput,
        message_id: &str,
        recorded_at: &str,
    ) -> Result<(String, String), StoreError> {
        self.ensure_application(&input.application_id)?;
        let draft = EventDraft {
            occurred: input.occurred.clone(),
            source: EventSource::Plugin,
            source_request_id: Some(message_id.into()),
            actor: Actor::Plugin,
            payload: EventPayload::FillEvent {
                outcome: input.outcome,
                field_count: input.field_count,
                filled_count: input.filled_count,
                unconfirmed_count: input.unconfirmed_count,
                durations_ms: input.durations_ms.clone(),
                url_redacted: input.url_redacted.clone(),
                template_name: input.template_name.clone(),
                template_version: input.template_version.clone(),
                snapshot_id: input.snapshot_id.clone(),
                plugin_version: input.plugin_version.clone(),
                // 填写完成/部分完成把 saved 推进到 filling(§6.2);其余 no-op。
                stage_update_mode: StageUpdateMode::UpdateProgress,
            },
        };
        let events = self.append_events(Some(&input.application_id), &[draft], recorded_at)?;
        Ok((events[0].id.clone(), "event".into()))
    }

    pub(crate) fn op_submit_confirm(
        &mut self,
        input: &SubmitConfirmInput,
        message_id: &str,
        recorded_at: &str,
    ) -> Result<(String, String), StoreError> {
        self.ensure_application(&input.application_id)?;
        let draft = EventDraft {
            occurred: input.occurred.clone(),
            source: EventSource::Plugin,
            source_request_id: Some(message_id.into()),
            actor: Actor::User,
            payload: EventPayload::SubmitConfirmed {
                via: input.via.clone(),
                note: input.note.clone(),
                stage_update_mode: StageUpdateMode::UpdateProgress,
            },
        };
        let events = self.append_events(Some(&input.application_id), &[draft], recorded_at)?;
        Ok((events[0].id.clone(), "event".into()))
    }

    pub(crate) fn op_snapshot_chunk(
        &mut self,
        ctx: &PluginWriteContext,
        input: &SnapshotChunkInput,
        recorded_at: &str,
    ) -> Result<(String, String), StoreError> {
        if input.chunk_count < 1
            || input.chunk_count > 128
            || input.byte_size < 0
            || input.byte_size > 2 * 1024 * 1024
            || [&input.chunk_sha256, &input.total_sha256]
                .iter()
                .any(|v| v.len() != 64 || !v.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(StoreError::Validation(
                "invalid bounded snapshot metadata".into(),
            ));
        }
        let mut input = input.clone();
        input.chunk_sha256.make_ascii_lowercase();
        input.total_sha256.make_ascii_lowercase();
        if input.chunk_index < 0 || input.chunk_index >= input.chunk_count {
            return Err(StoreError::Validation(format!(
                "chunk_index {} out of range (0..{})",
                input.chunk_index, input.chunk_count
            )));
        }
        // 父记录 upsert;chunk_count / total_sha 不一致 → conflict。
        let existing: Option<(i64, String)> = self
            .conn()
            .query_row(
                "SELECT chunk_count, total_sha256 FROM snapshot_uploads \
                 WHERE client_instance_id = ?1 AND snapshot_id = ?2",
                params![ctx.client_instance_id, input.snapshot_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        if let Some((count, sha)) = &existing {
            let same: bool = self.conn().query_row("SELECT source_restore_epoch=?3 AND application_id IS ?4 AND byte_size=?5 AND template_name IS ?6 AND template_version IS ?7 FROM snapshot_uploads WHERE client_instance_id=?1 AND snapshot_id=?2",
                params![ctx.client_instance_id,input.snapshot_id,ctx.source_restore_epoch,input.application_id,input.byte_size,input.template_name,input.template_version], |r| r.get(0))?;
            if !same {
                return Err(StoreError::Conflict(
                    "snapshot parent identity/metadata changed".into(),
                ));
            }
            if *count != input.chunk_count || *sha != input.total_sha256 {
                return Err(StoreError::Conflict(format!(
                    "snapshot {} already registered with chunk_count={count}, total_sha={}…",
                    input.snapshot_id,
                    &input.total_sha256[..16.min(input.total_sha256.len())]
                )));
            }
        } else {
            if let Some(app) = &input.application_id {
                self.ensure_application(app)?;
            }
            self.conn().execute(
                "INSERT INTO snapshot_uploads (client_instance_id, snapshot_id, application_id, \
                 chunk_count, total_sha256, byte_size, template_name, template_version, \
                 source_restore_epoch, created_at, full_acked) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)",
                params![
                    ctx.client_instance_id,
                    input.snapshot_id,
                    input.application_id,
                    input.chunk_count,
                    input.total_sha256,
                    input.byte_size,
                    input.template_name,
                    input.template_version,
                    ctx.source_restore_epoch,
                    recorded_at,
                ],
            )?;
        }

        // 业务等价键:(client, snapshot, chunkIndex) 必须指向同一块。
        // 同身份不同 chunkSha256 → conflict;同一块换新 messageId(重启后重铸)→ conflict。
        let prior: Option<(String, String)> = self
            .conn()
            .query_row(
                "SELECT chunk_message_id, chunk_sha256 FROM snapshot_chunks \
                 WHERE client_instance_id = ?1 AND snapshot_id = ?2 AND chunk_index = ?3",
                params![ctx.client_instance_id, input.snapshot_id, input.chunk_index],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        if let Some((prior_msg, prior_sha)) = &prior {
            if prior_sha != &input.chunk_sha256 {
                return Err(StoreError::Conflict(format!(
                    "chunk {}#{} committed with different chunkSha256",
                    input.snapshot_id, input.chunk_index
                )));
            }
            if prior_msg != &ctx.message_id {
                return Err(StoreError::Conflict(format!(
                    "chunk {}#{} already persisted under a different messageId (re-minting forbidden)",
                    input.snapshot_id, input.chunk_index
                )));
            }
            // 同块同摘要同 messageId:落在回执重放路径(幂等),不重复登记。
            return Ok((ctx.message_id.clone(), "snapshot_chunk".into()));
        }

        self.conn().execute(
            "INSERT INTO snapshot_chunks (client_instance_id, snapshot_id, chunk_index, \
             chunk_message_id, chunk_sha256, source_restore_epoch, received_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                ctx.client_instance_id,
                input.snapshot_id,
                input.chunk_index,
                ctx.message_id,
                input.chunk_sha256,
                ctx.source_restore_epoch,
                recorded_at,
            ],
        )?;
        Ok((ctx.message_id.clone(), "snapshot_chunk".into()))
    }

    /// 快照进度:块 ACK 状态与连续游标(§8.5 chunkCursor 语义)。
    pub fn snapshot_progress(
        &self,
        client_instance_id: &str,
        snapshot_id: &str,
    ) -> Result<SnapshotProgress, StoreError> {
        let (chunk_count, total_sha, full_acked): (i64, String, i64) = self
            .conn()
            .query_row(
                "SELECT chunk_count, total_sha256, full_acked FROM snapshot_uploads \
                 WHERE client_instance_id = ?1 AND snapshot_id = ?2",
                params![client_instance_id, snapshot_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    StoreError::NotFound(format!("snapshot upload {snapshot_id}"))
                }
                other => other.into(),
            })?;
        let mut received = Vec::new();
        {
            let mut stmt = self.conn().prepare(
                "SELECT chunk_index FROM snapshot_chunks WHERE client_instance_id = ?1 AND snapshot_id = ?2 ORDER BY chunk_index ASC",
            )?;
            let rows = stmt.query_map(params![client_instance_id, snapshot_id], |r| r.get(0))?;
            for row in rows {
                received.push(row?);
            }
        }
        let mut cursor = 0i64;
        for idx in &received {
            if *idx == cursor {
                cursor += 1;
            } else if *idx > cursor {
                break;
            }
        }
        Ok(SnapshotProgress {
            client_instance_id: client_instance_id.to_string(),
            snapshot_id: snapshot_id.to_string(),
            chunk_count,
            total_sha256: total_sha,
            full_acked: full_acked != 0,
            chunk_cursor: cursor,
            received_chunks: received,
        })
    }

    /// 完整快照 ACK:调用方(D06/D08 适配层)已拼装字节并核对总哈希后调用。
    /// 幂等:重复调用且 sha 一致返回已有行;不一致 conflict。
    /// 不做块序校验的绕过:必须全部块已持久化(乱序块允许暂存)。
    pub fn finalize_snapshot_upload(
        &mut self,
        client_instance_id: &str,
        snapshot_id: &str,
        stored_rel_path: &str,
    ) -> Result<ResumeSnapshotMeta, StoreError> {
        validate_rel_path(stored_rel_path)?;
        let (epoch, size): (String, i64) = self.conn().query_row("SELECT source_restore_epoch, byte_size FROM snapshot_uploads WHERE client_instance_id=?1 AND snapshot_id=?2", params![client_instance_id,snapshot_id], |r| Ok((r.get(0)?,r.get(1)?)))
            .optional()?.ok_or_else(|| StoreError::NotFound(format!("snapshot upload {snapshot_id}")))?;
        if epoch != self.identity.restore_epoch {
            return Err(StoreError::Validation(
                "old snapshot epoch cannot finalize".into(),
            ));
        }
        let (app_id, total_sha, chunk_count, template_name, template_version): (
            Option<String>,
            String,
            i64,
            Option<String>,
            Option<String>,
        ) = self
            .conn()
            .query_row(
                "SELECT application_id, total_sha256, chunk_count, template_name, template_version \
                 FROM snapshot_uploads WHERE client_instance_id = ?1 AND snapshot_id = ?2",
                params![client_instance_id, snapshot_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => StoreError::NotFound(format!("snapshot upload {snapshot_id}")),
                other => other.into(),
            })?;
        if let Some(existing) = self.get_snapshot(snapshot_id)? {
            if existing.sha256 == total_sha
                && existing.stored_rel_path == stored_rel_path
                && existing.byte_size == size
            {
                crate::tx::verify_file(&self.archive_dir, stored_rel_path, size, &total_sha)?;
                return Ok(existing);
            }
            return Err(StoreError::Conflict(
                "snapshot id already committed with different total sha256".into(),
            ));
        }
        let received: i64 = self.conn().query_row(
            "SELECT COUNT(*) FROM snapshot_chunks WHERE client_instance_id = ?1 AND snapshot_id = ?2",
            params![client_instance_id, snapshot_id],
            |r| r.get(0),
        )?;
        if received != chunk_count {
            return Err(StoreError::Validation(format!(
                "cannot finalize snapshot {snapshot_id}: {received}/{chunk_count} chunks persisted"
            )));
        }
        let app_id = app_id.ok_or_else(|| {
            StoreError::Validation(
                "snapshot upload has no bound application; associate before finalize".into(),
            )
        })?;
        let byte_size: i64 = self.conn().query_row(
            "SELECT byte_size FROM snapshot_uploads WHERE client_instance_id = ?1 AND snapshot_id = ?2",
            params![client_instance_id, snapshot_id],
            |r| r.get(0),
        )?;
        let now = now_utc();
        crate::tx::verify_file(&self.archive_dir, stored_rel_path, byte_size, &total_sha)?;
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(self.archive_dir.join(stored_rel_path))?
            .sync_all()?;
        self.conn().execute(
            "INSERT INTO resume_snapshots (snapshot_id, application_id, template_name, \
             template_version, sha256, stored_rel_path, created_at, byte_size) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                snapshot_id,
                app_id,
                template_name.clone().unwrap_or_else(|| "unknown".into()),
                template_version,
                total_sha,
                stored_rel_path,
                now,
                byte_size,
            ],
        )?;
        self.conn().execute(
            "UPDATE snapshot_uploads SET full_acked = 1 WHERE client_instance_id = ?1 AND snapshot_id = ?2",
            params![client_instance_id, snapshot_id],
        )?;
        Ok(ResumeSnapshotMeta {
            snapshot_id: snapshot_id.to_string(),
            application_id: app_id,
            template_name: template_name.clone().unwrap_or_else(|| "unknown".into()),
            template_version,
            sha256: total_sha,
            stored_rel_path: stored_rel_path.to_string(),
            created_at: now,
            byte_size,
        })
    }

    pub fn get_snapshot(
        &self,
        snapshot_id: &str,
    ) -> Result<Option<ResumeSnapshotMeta>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT snapshot_id, application_id, template_name, template_version, sha256, \
             stored_rel_path, created_at, byte_size FROM resume_snapshots WHERE snapshot_id = ?1",
        )?;
        let mut rows = stmt.query_map(params![snapshot_id], |r| {
            Ok(ResumeSnapshotMeta {
                snapshot_id: r.get(0)?,
                application_id: r.get(1)?,
                template_name: r.get(2)?,
                template_version: r.get(3)?,
                sha256: r.get(4)?,
                stored_rel_path: r.get(5)?,
                created_at: r.get(6)?,
                byte_size: r.get(7)?,
            })
        })?;
        rows.next().transpose().map_err(StoreError::from)
    }

    pub fn list_snapshots(
        &self,
        application_id: &str,
    ) -> Result<Vec<ResumeSnapshotMeta>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT snapshot_id, application_id, template_name, template_version, sha256, \
             stored_rel_path, created_at, byte_size FROM resume_snapshots \
             WHERE application_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![application_id], |r| {
            Ok(ResumeSnapshotMeta {
                snapshot_id: r.get(0)?,
                application_id: r.get(1)?,
                template_name: r.get(2)?,
                template_version: r.get(3)?,
                sha256: r.get(4)?,
                stored_rel_path: r.get(5)?,
                created_at: r.get(6)?,
                byte_size: r.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    // ------------------------------------------------------------------
    // 恢复对账(只读):不按当前 epoch 过滤历史行;外层身份已由入口校验。
    // ------------------------------------------------------------------

    pub fn reconcile_lookup(
        &mut self,
        archive_id: &str,
        items: &[ReconcileQueryItem],
    ) -> Result<Vec<ReconcileReply>, StoreError> {
        let mut replies = Vec::with_capacity(items.len());
        for item in items {
            let outcome = self.reconcile_one(archive_id, item)?;
            replies.push(ReconcileReply {
                item: item.clone(),
                outcome,
            });
        }
        Ok(replies)
    }

    fn reconcile_one(
        &mut self,
        archive_id: &str,
        item: &ReconcileQueryItem,
    ) -> Result<ReconcileOutcome, StoreError> {
        let row = self.find_receipt(
            &item.client_instance_id,
            &item.message_id,
            &item.source_restore_epoch,
        )?;
        let row = match row {
            Some(r) if r.archive_id == archive_id => r,
            // 当前库没有这份回执:仅说明该备份未包含证明。
            _ => return Ok(ReconcileOutcome::NotFound),
        };
        if row.purged {
            return Ok(ReconcileOutcome::Purged);
        }
        if row.payload_sha256 != item.payload_sha256 {
            return Ok(ReconcileOutcome::Conflict {
                reason: "payloadSha256 differs from committed receipt".into(),
            });
        }
        // 块项:snapshotId/chunkIndex 必须与回执一致。
        if item.snapshot_id.is_some() || item.chunk_index.is_some() {
            if row.snapshot_id != item.snapshot_id || row.chunk_index != item.chunk_index {
                return Ok(ReconcileOutcome::Conflict {
                    reason: "snapshot/chunk identity differs from committed receipt".into(),
                });
            }
        }
        // 结果仍有效才 applied(§8.11)。
        let result_id = row
            .result_id
            .clone()
            .ok_or_else(|| StoreError::Internal("non-purged receipt without result_id".into()))?;
        let valid: bool = match row.result_kind.as_deref() {
            Some("application") => self
                .conn()
                .query_row("SELECT COUNT(*) FROM applications WHERE id = ?1", params![result_id], |r| r.get::<_, i64>(0))?
                > 0,
            Some("event") => self
                .conn()
                .query_row("SELECT COUNT(*) FROM events WHERE id = ?1", params![result_id], |r| r.get::<_, i64>(0))?
                > 0,
            Some("snapshot_chunk") => self
                .conn()
                .query_row(
                    "SELECT COUNT(*) FROM snapshot_chunks WHERE client_instance_id = ?1 AND snapshot_id = ?2 AND chunk_index = ?3",
                    params![item.client_instance_id, item.snapshot_id.clone().unwrap_or_default(), item.chunk_index.unwrap_or(-1)],
                    |r| r.get::<_, i64>(0),
                )?
                > 0,
            _ => false,
        };
        if valid {
            Ok(ReconcileOutcome::Applied { result_id })
        } else {
            Ok(ReconcileOutcome::Unverifiable {
                reason: "receipt exists but referenced object is missing".into(),
            })
        }
    }
}

pub(crate) struct ReceiptInsert {
    pub operation_sha256: String,
    pub archive_id: String,
    pub client_instance_id: String,
    pub message_id: String,
    pub source_restore_epoch: String,
    pub payload_sha256: String,
    pub result_id: String,
    pub result_kind: String,
    pub operation_type: String,
    pub snapshot_id: Option<String>,
    pub chunk_index: Option<i64>,
    pub committed_at: String,
}

/// 便捷:为 chunk 消息生成稳定的 chunkMessageId 由调用方(插件/适配层)完成;
/// 数据层只登记。此处提供 new helper 仅为内部测试。
#[allow(dead_code)]
pub(crate) fn new_chunk_message_id() -> String {
    new_uuid()
}
