use serde_json::{Map, Value};

use crate::error::{ErrorCode, Layer, ProtocolError};
use crate::secrets::reject_secrets;
use crate::types::{
    MessageType, Request, MAX_ENVELOPE_BYTES, MAX_PROTOCOL_VERSION, MAX_RECONCILE_ITEMS,
    MAX_SNAPSHOT_BYTES, MIN_PROTOCOL_VERSION,
};

const UUID: &str = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const SHA256: &str = r"^[0-9a-f]{64}$";
const TIME: &str = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$";

pub fn utf8_json_len(value: &Value) -> usize {
    serde_json::to_vec(value).map(|b| b.len()).unwrap_or(usize::MAX)
}

pub fn validate_request_bytes(bytes: &[u8]) -> Result<Request, ProtocolError> {
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(ProtocolError::new(
            ErrorCode::PayloadTooLarge,
            Layer::Size,
            format!(
                "envelope is {} UTF-8 bytes; max is {MAX_ENVELOPE_BYTES} (complete JSON, not raw chunk)",
                bytes.len()
            ),
        ));
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|e| {
        ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, format!("invalid JSON: {e}"))
    })?;
    if utf8_json_len(&value) > MAX_ENVELOPE_BYTES {
        return Err(ProtocolError::new(
            ErrorCode::PayloadTooLarge,
            Layer::Size,
            "re-serialized envelope exceeds 65536 UTF-8 bytes",
        ));
    }
    validate_request_value(&value)
}

pub fn validate_request_value(value: &Value) -> Result<Request, ProtocolError> {
    let obj = value.as_object().ok_or_else(|| {
        ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, "request must be an object")
    })?;
    reject_unknown_keys(
        obj,
        &[
            "protocolVersion",
            "messageId",
            "clientInstanceId",
            "messageType",
            "occurredAt",
            "archiveId",
            "restoreEpoch",
            "payload",
        ],
    )?;
    let protocol_version = int_field(obj, "protocolVersion")?;
    if protocol_version < MIN_PROTOCOL_VERSION as i64 || protocol_version > MAX_PROTOCOL_VERSION as i64
    {
        return Err(ProtocolError::new(
            ErrorCode::ProtocolIncompatible,
            Layer::Structure,
            format!("protocolVersion {protocol_version} is outside {MIN_PROTOCOL_VERSION}..{MAX_PROTOCOL_VERSION}"),
        ));
    }
    let message_type = MessageType::parse(&string_field(obj, "messageType")?)?;
    let message_id = uuid_field(obj, "messageId")?;
    let client_instance_id = uuid_field(obj, "clientInstanceId")?;
    let occurred_at = string_field(obj, "occurredAt")?;
    if !matches_pattern(&occurred_at, TIME) {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "occurredAt must be UTC RFC3339 (...Z)",
        ));
    }
    let archive_id = optional_uuid(obj, "archiveId")?;
    let restore_epoch = optional_uuid(obj, "restoreEpoch")?;
    enforce_identity(message_type, archive_id.is_some(), restore_epoch.is_some())?;
    let payload = obj.get("payload").and_then(Value::as_object).ok_or_else(|| {
        ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, "payload must be an object")
    })?;
    reject_secrets(&Value::Object(payload.clone()))?;
    validate_payload(message_type, payload)?;
    if message_type == MessageType::OutboxReconcile {
        let items = payload.get("items").and_then(Value::as_array).unwrap();
        for item in items {
            let cid = item
                .get("clientInstanceId")
                .and_then(Value::as_str)
                .unwrap_or("");
            if cid != client_instance_id {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    Layer::Structure,
                    "outbox.reconcile items must use the caller clientInstanceId",
                ));
            }
        }
    }
    if message_type == MessageType::Handshake {
        let min = payload.get("minProtocolVersion").and_then(Value::as_i64).unwrap();
        let max = payload.get("maxProtocolVersion").and_then(Value::as_i64).unwrap();
        if max < MIN_PROTOCOL_VERSION as i64 || min > MAX_PROTOCOL_VERSION as i64 || min > max {
            return Err(ProtocolError::new(
                ErrorCode::ProtocolIncompatible,
                Layer::Structure,
                "handshake protocol ranges do not overlap",
            ));
        }
    }
    Ok(Request {
        protocol_version: protocol_version as u32,
        message_id,
        client_instance_id,
        message_type,
        occurred_at,
        archive_id,
        restore_epoch,
        payload: Value::Object(payload.clone()),
        raw: value.clone(),
    })
}

fn enforce_identity(ty: MessageType, has_archive: bool, has_epoch: bool) -> Result<(), ProtocolError> {
    if ty.identity_forbidden() && (has_archive || has_epoch) {
        return Err(ProtocolError::new(
            ErrorCode::IdentityNotAllowed,
            Layer::IdentityPresence,
            format!("{} must not carry archiveId/restoreEpoch", ty.as_str()),
        ));
    }
    if ty.identity_required() && (!has_archive || !has_epoch) {
        return Err(ProtocolError::new(
            ErrorCode::IdentityMissing,
            Layer::IdentityPresence,
            format!("{} requires archiveId and restoreEpoch", ty.as_str()),
        ));
    }
    Ok(())
}

fn validate_payload(ty: MessageType, payload: &Map<String, Value>) -> Result<(), ProtocolError> {
    match ty {
        MessageType::Health => reject_unknown_keys(payload, &[])?,
        MessageType::Handshake => {
            require_keys(payload, &["pluginVersion", "minProtocolVersion", "maxProtocolVersion"])?;
            reject_unknown_keys(
                payload,
                &["pluginVersion", "minProtocolVersion", "maxProtocolVersion"],
            )?;
            string_min(payload, "pluginVersion", 1)?;
            int_field(payload, "minProtocolVersion")?;
            int_field(payload, "maxProtocolVersion")?;
        }
        MessageType::QueryCandidates => {
            require_keys(payload, &["company"])?;
            reject_unknown_keys(payload, &["company", "title", "sourceUrl"])?;
            string_min(payload, "company", 1)?;
        }
        MessageType::JobSave => {
            require_keys(payload, &["sourceRestoreEpoch", "payloadSha256", "company", "title"])?;
            reject_unknown_keys(
                payload,
                &[
                    "sourceRestoreEpoch",
                    "payloadSha256",
                    "company",
                    "title",
                    "sourceUrl",
                    "location",
                    "applicationId",
                ],
            )?;
            uuid_field(payload, "sourceRestoreEpoch")?;
            sha_field(payload, "payloadSha256")?;
            string_min(payload, "company", 1)?;
            string_min(payload, "title", 1)?;
            optional_uuid(payload, "applicationId")?;
        }
        MessageType::FillSubmit | MessageType::SubmitConfirm => {
            require_keys(payload, &["sourceRestoreEpoch", "payloadSha256", "applicationId"])?;
            let allowed = if ty == MessageType::FillSubmit {
                &[
                    "sourceRestoreEpoch",
                    "payloadSha256",
                    "applicationId",
                    "snapshotId",
                    "sha256",
                ][..]
            } else {
                &["sourceRestoreEpoch", "payloadSha256", "applicationId"][..]
            };
            reject_unknown_keys(payload, allowed)?;
            uuid_field(payload, "sourceRestoreEpoch")?;
            sha_field(payload, "payloadSha256")?;
            uuid_field(payload, "applicationId")?;
            if ty == MessageType::FillSubmit {
                optional_uuid(payload, "snapshotId")?;
                if payload.contains_key("sha256") {
                    sha_field(payload, "sha256")?;
                }
            }
        }
        MessageType::SnapshotChunk => {
            require_keys(
                payload,
                &[
                    "sourceRestoreEpoch",
                    "snapshotId",
                    "applicationId",
                    "chunkIndex",
                    "chunkCount",
                    "chunkSha256",
                    "snapshotSha256",
                    "byteSize",
                    "bytesBase64",
                ],
            )?;
            reject_unknown_keys(
                payload,
                &[
                    "sourceRestoreEpoch",
                    "snapshotId",
                    "applicationId",
                    "chunkIndex",
                    "chunkCount",
                    "chunkSha256",
                    "snapshotSha256",
                    "byteSize",
                    "bytesBase64",
                ],
            )?;
            uuid_field(payload, "sourceRestoreEpoch")?;
            uuid_field(payload, "snapshotId")?;
            uuid_field(payload, "applicationId")?;
            sha_field(payload, "chunkSha256")?;
            sha_field(payload, "snapshotSha256")?;
            string_min(payload, "bytesBase64", 1)?;
            let index = int_field(payload, "chunkIndex")?;
            let count = int_field(payload, "chunkCount")?;
            let byte_size = int_field(payload, "byteSize")?;
            if index < 0 || count < 1 || index >= count {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    Layer::Structure,
                    "chunkIndex must be in 0..chunkCount",
                ));
            }
            if byte_size < 1 || byte_size as usize > MAX_SNAPSHOT_BYTES {
                return Err(ProtocolError::new(
                    ErrorCode::PayloadTooLarge,
                    Layer::Size,
                    "snapshot byteSize exceeds 2 MiB",
                ));
            }
        }
        MessageType::OutboxReconcile => {
            require_keys(payload, &["items"])?;
            reject_unknown_keys(payload, &["items"])?;
            let items = payload.get("items").and_then(Value::as_array).ok_or_else(|| {
                ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, "items must be an array")
            })?;
            if items.is_empty() || items.len() > MAX_RECONCILE_ITEMS {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    Layer::Structure,
                    format!("outbox.reconcile items must be 1..{MAX_RECONCILE_ITEMS}"),
                ));
            }
            for item in items {
                let obj = item.as_object().ok_or_else(|| {
                    ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, "reconcile item must be object")
                })?;
                require_keys(
                    obj,
                    &["clientInstanceId", "messageId", "sourceRestoreEpoch", "payloadSha256"],
                )?;
                reject_unknown_keys(
                    obj,
                    &[
                        "clientInstanceId",
                        "messageId",
                        "sourceRestoreEpoch",
                        "payloadSha256",
                        "snapshotId",
                        "chunkIndex",
                    ],
                )?;
                uuid_field(obj, "clientInstanceId")?;
                uuid_field(obj, "messageId")?;
                uuid_field(obj, "sourceRestoreEpoch")?;
                sha_field(obj, "payloadSha256")?;
                optional_uuid(obj, "snapshotId")?;
            }
        }
    }
    Ok(())
}

pub fn validate_response_value(value: &Value, request_type: MessageType) -> Result<(), ProtocolError> {
    let obj = value.as_object().ok_or_else(|| {
        ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, "response must be an object")
    })?;
    reject_unknown_keys(
        obj,
        &["protocolVersion", "correlationId", "resultId", "ok", "error", "payload"],
    )?;
    int_field(obj, "protocolVersion")?;
    uuid_field(obj, "correlationId")?;
    let ok = obj.get("ok").and_then(Value::as_bool).ok_or_else(|| {
        ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, "ok must be boolean")
    })?;
    obj.get("payload").and_then(Value::as_object).ok_or_else(|| {
        ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, "payload must be an object")
    })?;
    if ok {
        if obj.contains_key("error") {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                "ok:true response must not include error",
            ));
        }
        if request_type.is_write() && optional_uuid(obj, "resultId")?.is_none() {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                "ok:true write response requires resultId",
            ));
        }
        if request_type == MessageType::SnapshotChunk {
            let kind = obj
                .get("payload")
                .and_then(|p| p.get("ackKind"))
                .and_then(Value::as_str);
            if !matches!(kind, Some("chunk") | Some("snapshot")) {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    Layer::Structure,
                    "snapshot.chunk ACK must set payload.ackKind to chunk or snapshot",
                ));
            }
        }
    } else {
        if obj.contains_key("resultId") {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                "ok:false response must not include resultId",
            ));
        }
        let error = obj.get("error").and_then(Value::as_object).ok_or_else(|| {
            ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, "ok:false requires error")
        })?;
        require_keys(error, &["code", "retryable"])?;
        string_field(error, "code")?;
        error.get("retryable").and_then(Value::as_bool).ok_or_else(|| {
            ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, "error.retryable must be boolean")
        })?;
    }
    Ok(())
}

fn reject_unknown_keys(obj: &Map<String, Value>, allowed: &[&str]) -> Result<(), ProtocolError> {
    for key in obj.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                format!("unexpected field {key}"),
            ));
        }
    }
    Ok(())
}

fn require_keys(obj: &Map<String, Value>, keys: &[&str]) -> Result<(), ProtocolError> {
    for key in keys {
        if !obj.contains_key(*key) {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                format!("missing field {key}"),
            ));
        }
    }
    Ok(())
}

fn string_field(obj: &Map<String, Value>, key: &str) -> Result<String, ProtocolError> {
    obj.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, format!("{key} must be a string"))
        })
}

fn string_min(obj: &Map<String, Value>, key: &str, min: usize) -> Result<String, ProtocolError> {
    let s = string_field(obj, key)?;
    if s.chars().count() < min {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            format!("{key} is too short"),
        ));
    }
    Ok(s)
}

fn int_field(obj: &Map<String, Value>, key: &str) -> Result<i64, ProtocolError> {
    obj.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, format!("{key} must be an integer"))
        })
}

fn uuid_field(obj: &Map<String, Value>, key: &str) -> Result<String, ProtocolError> {
    let s = string_field(obj, key)?;
    if !matches_pattern(&s, UUID) {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            format!("{key} must be a UUID"),
        ));
    }
    Ok(s)
}

fn optional_uuid(obj: &Map<String, Value>, key: &str) -> Result<Option<String>, ProtocolError> {
    if !obj.contains_key(key) {
        return Ok(None);
    }
    Ok(Some(uuid_field(obj, key)?))
}

fn sha_field(obj: &Map<String, Value>, key: &str) -> Result<String, ProtocolError> {
    let s = string_field(obj, key)?;
    if !matches_pattern(&s, SHA256) {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            format!("{key} must be lowercase hex SHA-256"),
        ));
    }
    Ok(s)
}

fn matches_pattern(value: &str, pattern: &str) -> bool {
    regex_lite(value, pattern)
}

fn regex_lite(value: &str, pattern: &str) -> bool {
    match pattern {
        p if p == UUID => {
            let parts: Vec<&str> = value.split('-').collect();
            parts.len() == 5
                && parts[0].len() == 8
                && parts[1].len() == 4
                && parts[2].len() == 4
                && parts[3].len() == 4
                && parts[4].len() == 12
                && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        }
        p if p == SHA256 => value.len() == 64 && value.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
        p if p == TIME => {
            value.ends_with('Z')
                && value.len() >= 20
                && value.as_bytes().get(4) == Some(&b'-')
                && value.as_bytes().get(10) == Some(&b'T')
        }
        _ => false,
    }
}

pub fn source_restore_epoch(req: &Request) -> Option<String> {
    req.payload
        .get("sourceRestoreEpoch")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub fn payload_sha256(req: &Request) -> Option<String> {
    req.payload
        .get("payloadSha256")
        .or_else(|| req.payload.get("chunkSha256"))
        .and_then(Value::as_str)
        .map(str::to_string)
}
