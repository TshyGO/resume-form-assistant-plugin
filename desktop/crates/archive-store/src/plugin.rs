//! 插件消息写入入口:普通写入两段校验 + 回执同事务持久化。
//! D06 NM host 适配层把协议信封映射到 [PluginWriteContext] + [PluginOp]。

use crate::error::{EpochMismatch, StoreError};
use crate::identity::ArchiveIdentity;
use crate::receipts::{
    PluginOp, PluginWriteContext, PluginWriteOutcome, ReceiptInsert,
};
use crate::store::ArchiveStore;
use crate::timeutil::now_utc;

impl ArchiveStore {
    /// 普通写入入口(job.save / fill.submit / submit.confirm / snapshot.chunk)。
    ///
    /// 校验顺序(冻结):
    /// 1. 信封身份缺失 → `identity_missing`;
    /// 2. 信封 archiveId 或 restoreEpoch ≠ current → `restore_epoch_mismatch`;
    /// 3. `sourceRestoreEpoch` ≠ current → `restore_epoch_mismatch`
    ///    (不是成功重放;旧 epoch 只能 `reconcile_lookup`);
    /// 4. 回执查找:purged → `previously_purged`;摘要不符 → `conflict`;
    ///    完整命中 → 返回原 resultId(不新增业务事件);
    /// 5. 执行业务写入并持久化回执,同一事务提交。
    pub fn submit_plugin_message(
        &self,
        ctx: &PluginWriteContext,
        op: PluginOp,
    ) -> Result<PluginWriteOutcome, StoreError> {
        let current = self.identity();
        let envelope = ctx.envelope_identity.as_ref().ok_or(StoreError::IdentityMissing)?;
        if envelope.archive_id != current.archive_id {
            return Err(StoreError::RestoreEpochMismatch {
                detail: format!(
                    "envelope archiveId does not match current archive (expected category: current pointer)"
                ),
                source: Some(EpochMismatch::EnvelopeArchiveId { expected: current.archive_id.clone() }),
            });
        }
        if envelope.restore_epoch != current.restore_epoch {
            return Err(StoreError::RestoreEpochMismatch {
                detail: "envelope restoreEpoch does not match current pointer; ordinary write forbidden"
                    .into(),
                source: Some(EpochMismatch::EnvelopeRestoreEpoch {
                    expected: current.restore_epoch.clone(),
                }),
            });
        }
        if ctx.source_restore_epoch != current.restore_epoch {
            return Err(StoreError::RestoreEpochMismatch {
                detail: "sourceRestoreEpoch is not current; use outbox.reconcile instead of ordinary write"
                    .into(),
                source: Some(EpochMismatch::SourceRestoreEpoch {
                    expected: current.restore_epoch.clone(),
                }),
            });
        }

        self.transaction(move |tx| {
            if let Some(row) = tx.find_receipt(&ctx.client_instance_id, &ctx.message_id, &ctx.source_restore_epoch)? {
                if row.purged {
                    return Err(StoreError::PreviouslyPurged { former_result_id: row.result_id });
                }
                if row.payload_sha256 != ctx.payload_sha256 {
                    return Err(StoreError::Conflict(format!(
                        "message {} committed with a different payload digest",
                        ctx.message_id
                    )));
                }
                let result_id = row.result_id.clone().ok_or_else(|| {
                    StoreError::Internal("committed receipt lost result_id".into())
                })?;
                return Ok(PluginWriteOutcome::Replayed {
                    result_id,
                    result_kind: row.result_kind.unwrap_or_else(|| "unknown".into()),
                });
            }

            let now = now_utc();
            let operation_type;
            let (result_id, result_kind, snapshot_id, chunk_index);
            match op {
                PluginOp::JobSave(ref input) => {
                    operation_type = "job.save";
                    let (rid, kind) = tx.op_job_save(input, &now)?;
                    result_id = rid;
                    result_kind = kind;
                    snapshot_id = None;
                    chunk_index = None;
                }
                PluginOp::FillSubmit(ref input) => {
                    operation_type = "fill.submit";
                    let (rid, kind) = tx.op_fill_submit(input, &now)?;
                    result_id = rid;
                    result_kind = kind;
                    snapshot_id = None;
                    chunk_index = None;
                }
                PluginOp::SubmitConfirm(ref input) => {
                    operation_type = "submit.confirm";
                    let (rid, kind) = tx.op_submit_confirm(input, &now)?;
                    result_id = rid;
                    result_kind = kind;
                    snapshot_id = None;
                    chunk_index = None;
                }
                PluginOp::SnapshotChunk(ref input) => {
                    operation_type = "snapshot.chunk";
                    let (rid, kind) = tx.op_snapshot_chunk(ctx, input, &now)?;
                    result_id = rid;
                    result_kind = kind;
                    snapshot_id = Some(input.snapshot_id.clone());
                    chunk_index = Some(input.chunk_index);
                }
            }

            tx.insert_receipt(ReceiptInsert {
                archive_id: current.archive_id.clone(),
                client_instance_id: ctx.client_instance_id.clone(),
                message_id: ctx.message_id.clone(),
                source_restore_epoch: ctx.source_restore_epoch.clone(),
                payload_sha256: ctx.payload_sha256.clone(),
                result_id,
                result_kind: result_kind.clone(),
                operation_type: operation_type.into(),
                snapshot_id,
                chunk_index,
                committed_at: now,
            })?;

            Ok(PluginWriteOutcome::Committed { result_id, result_kind })
        })
    }

    /// `outbox.reconcile` 只读对账。外层信封必须等于 current(缺失或不符整批拒绝);
    /// 历史回执不按当前 epoch 过滤;`not_found` 不代表从未执行。
    pub fn reconcile_lookup(
        &self,
        envelope_identity: Option<&ArchiveIdentity>,
        items: &[crate::receipts::ReconcileQueryItem],
    ) -> Result<Vec<crate::receipts::ReconcileReply>, StoreError> {
        let current = self.identity();
        let envelope = envelope_identity.ok_or(StoreError::IdentityMissing)?;
        if envelope.archive_id != current.archive_id {
            return Err(StoreError::RestoreEpochMismatch {
                detail: "reconcile envelope archiveId does not match current".into(),
                source: Some(EpochMismatch::EnvelopeArchiveId { expected: current.archive_id.clone() }),
            });
        }
        if envelope.restore_epoch != current.restore_epoch {
            return Err(StoreError::RestoreEpochMismatch {
                detail: "reconcile envelope restoreEpoch does not match current".into(),
                source: Some(EpochMismatch::EnvelopeRestoreEpoch {
                    expected: current.restore_epoch.clone(),
                }),
            });
        }
        let archive_id = current.archive_id.clone();
        self.transaction(|tx| tx.reconcile_lookup(&archive_id, items))
    }
}
