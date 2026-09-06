use crate::error::{ErrorCode, Layer, ProtocolError};
use crate::identity::check_current_identity;
use crate::types::{
    CurrentArchive, MessageKey, ReceiptStore, ReconcileItemResult, ReconcileStatusKind, Request,
    StoredOutcome, WriteDecision,
};
use crate::validate::{payload_sha256, source_restore_epoch};

pub fn evaluate_write(
    req: &Request,
    current: Option<&CurrentArchive>,
    store: &dyn ReceiptStore,
) -> Result<WriteDecision, ProtocolError> {
    check_current_identity(req, current)?;
    if !req.message_type.is_write() {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Business,
            "evaluate_write is only for write message types",
        ));
    }
    let key = write_key(req)?;
    let hash = payload_sha256(req).ok_or_else(|| {
        ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "write payload requires payloadSha256 or chunkSha256",
        )
    })?;
    match store.get(&key) {
        None => Ok(WriteDecision::Accept),
        Some(StoredOutcome::Applied {
            result_id,
            payload_sha256,
        }) if payload_sha256 == hash => Ok(WriteDecision::Replay { result_id }),
        Some(StoredOutcome::Applied { .. }) => Ok(WriteDecision::Conflict),
        Some(StoredOutcome::Purged { payload_sha256 }) if payload_sha256 == hash => {
            Ok(WriteDecision::PreviouslyPurged)
        }
        Some(StoredOutcome::Purged { .. }) => Ok(WriteDecision::Conflict),
        Some(StoredOutcome::Unverifiable) => Err(ProtocolError::new(
            ErrorCode::Unavailable,
            Layer::Business,
            "receipt exists but cannot be verified",
        )),
    }
}

pub fn write_key(req: &Request) -> Result<MessageKey, ProtocolError> {
    Ok(MessageKey {
        client_instance_id: req.client_instance_id.clone(),
        message_id: req.message_id.clone(),
        source_restore_epoch: source_restore_epoch(req).ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                "missing sourceRestoreEpoch",
            )
        })?,
    })
}

pub fn reconcile(
    req: &Request,
    current: Option<&CurrentArchive>,
    store: &dyn ReceiptStore,
) -> Result<Vec<ReconcileItemResult>, ProtocolError> {
    if req.message_type != crate::types::MessageType::OutboxReconcile {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "reconcile() requires outbox.reconcile",
        ));
    }
    check_current_identity(req, current)?;
    let items = req
        .payload
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                "outbox.reconcile requires items",
            )
        })?;
    let mut out = Vec::new();
    for item in items {
        let client_instance_id = item
            .get("clientInstanceId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    Layer::Structure,
                    "reconcile item missing clientInstanceId",
                )
            })?
            .to_string();
        let message_id = item
            .get("messageId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    Layer::Structure,
                    "reconcile item missing messageId",
                )
            })?
            .to_string();
        let source_restore_epoch = item
            .get("sourceRestoreEpoch")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    Layer::Structure,
                    "reconcile item missing sourceRestoreEpoch",
                )
            })?
            .to_string();
        let payload_sha256 = item
            .get("payloadSha256")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    Layer::Structure,
                    "reconcile item missing payloadSha256",
                )
            })?
            .to_string();
        let key = MessageKey {
            client_instance_id: client_instance_id.clone(),
            message_id: message_id.clone(),
            source_restore_epoch: source_restore_epoch.clone(),
        };
        let (status, result_id) = match store.get(&key) {
            Some(StoredOutcome::Applied {
                result_id,
                payload_sha256: stored,
            }) if stored == payload_sha256 => (ReconcileStatusKind::Applied, Some(result_id)),
            Some(StoredOutcome::Applied { .. }) => (ReconcileStatusKind::Conflict, None),
            Some(StoredOutcome::Purged { payload_sha256: stored }) if stored == payload_sha256 => {
                (ReconcileStatusKind::Purged, None)
            }
            Some(StoredOutcome::Purged { .. }) => (ReconcileStatusKind::Conflict, None),
            Some(StoredOutcome::Unverifiable) => (ReconcileStatusKind::Unverifiable, None),
            None => (ReconcileStatusKind::NotFound, None),
        };
        out.push(ReconcileItemResult {
            client_instance_id,
            message_id,
            source_restore_epoch,
            payload_sha256,
            status,
            result_id,
            snapshot_id: item
                .get("snapshotId")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            chunk_index: item.get("chunkIndex").and_then(|v| v.as_u64()).map(|n| n as u32),
        });
    }
    Ok(out)
}

/// Reconcile never authorizes turning an old envelope into a current write.
pub fn reconcile_grants_replay(_item: &ReconcileItemResult) -> bool {
    false
}
