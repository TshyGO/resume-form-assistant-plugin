use crate::error::{ErrorCode, Layer, ProtocolError};
use crate::types::{CurrentArchive, MessageType, Request};
use crate::validate::{payload_sha256, source_restore_epoch};

/// Structural identity presence is already checked. This layer compares the
/// envelope to the desktop current pointer. JSON Schema cannot do this.
pub fn check_current_identity(
    req: &Request,
    current: Option<&CurrentArchive>,
) -> Result<(), ProtocolError> {
    if req.message_type.identity_forbidden() {
        return Ok(());
    }
    let Some(current) = current else {
        return Err(ProtocolError::new(
            ErrorCode::Unavailable,
            Layer::Business,
            "desktop current archive pointer is not available",
        ));
    };
    let archive = req.archive_id.as_deref().ok_or_else(|| {
        ProtocolError::new(
            ErrorCode::IdentityMissing,
            Layer::IdentityPresence,
            "archiveId is required for this messageType",
        )
    })?;
    let epoch = req.restore_epoch.as_deref().ok_or_else(|| {
        ProtocolError::new(
            ErrorCode::IdentityMissing,
            Layer::IdentityPresence,
            "restoreEpoch is required for this messageType",
        )
    })?;
    if archive != current.archive_id || epoch != current.restore_epoch {
        return Err(ProtocolError::new(
            ErrorCode::RestoreEpochMismatch,
            Layer::Business,
            "envelope archiveId/restoreEpoch is not the current archive identity; the host must not rewrite it",
        ));
    }
    if req.message_type.needs_source_restore_epoch() {
        let source = source_restore_epoch(req).ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                "write payload requires sourceRestoreEpoch",
            )
        })?;
        if source != current.restore_epoch {
            return Err(ProtocolError::new(
                ErrorCode::RestoreEpochMismatch,
                Layer::Business,
                "sourceRestoreEpoch is not the current epoch; do not replay — use outbox.reconcile",
            ));
        }
    }
    let _ = payload_sha256(req);
    Ok(())
}

pub fn origin_allowed(origin: &str, allowed: &[String]) -> bool {
    if origin.is_empty() || origin.contains('*') {
        return false;
    }
    allowed.iter().any(|item| item == origin && !item.contains('*'))
}

pub fn handshake_response_payload(current: &CurrentArchive, app_version: &str) -> serde_json::Value {
    serde_json::json!({
        "appVersion": app_version,
        "minProtocolVersion": crate::types::MIN_PROTOCOL_VERSION,
        "maxProtocolVersion": crate::types::MAX_PROTOCOL_VERSION,
        "archiveId": current.archive_id,
        "restoreEpoch": current.restore_epoch,
        "capabilities": MessageType::all_capability_names(),
    })
}

impl MessageType {
    pub fn all_capability_names() -> &'static [&'static str] {
        &[
            "health",
            "handshake",
            "application.queryCandidates",
            "job.save",
            "fill.submit",
            "snapshot.chunk",
            "submit.confirm",
            "outbox.reconcile",
        ]
    }
}
