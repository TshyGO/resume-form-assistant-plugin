use serde_json::{Map, Value};

use crate::digest::{decode_standard_base64, payload_body_sha256, sha256_hex};
use crate::error::{ErrorCode, Layer, ProtocolError};
use crate::schema_lite::{envelope_schema, payload_schema, response_schema, validate_schema};
use crate::secrets::reject_secrets;
use crate::time::is_utc_timestamp;
use crate::types::{
    MessageType, Request, MAX_ENVELOPE_BYTES, MAX_PROTOCOL_VERSION, MAX_RECONCILE_ITEMS,
    MAX_SNAPSHOT_BYTES, MIN_PROTOCOL_VERSION,
};

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
    if let Some(Value::String(message_type)) = obj.get("messageType") {
        MessageType::parse(message_type)?;
    }
    if let Some(version) = obj.get("protocolVersion") {
        if !version.is_i64() {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                "protocolVersion must be an integer",
            ));
        }
        let protocol_version = version.as_i64().unwrap();
        if protocol_version < MIN_PROTOCOL_VERSION as i64 || protocol_version > MAX_PROTOCOL_VERSION as i64
        {
            return Err(ProtocolError::new(
                ErrorCode::ProtocolIncompatible,
                Layer::Structure,
                format!("protocolVersion {protocol_version} is outside {MIN_PROTOCOL_VERSION}..{MAX_PROTOCOL_VERSION}"),
            ));
        }
    }
    validate_schema(value, &envelope_schema())?;
    let protocol_version = obj.get("protocolVersion").and_then(Value::as_i64).unwrap();
    let message_type = MessageType::parse(obj.get("messageType").and_then(Value::as_str).unwrap())?;
    let message_id = obj.get("messageId").and_then(Value::as_str).unwrap().to_string();
    let client_instance_id = obj
        .get("clientInstanceId")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    let occurred_at = obj.get("occurredAt").and_then(Value::as_str).unwrap().to_string();
    if !is_utc_timestamp(&occurred_at) {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "occurredAt must be a real UTC RFC3339 timestamp (...Z)",
        ));
    }
    let archive_id = obj.get("archiveId").and_then(Value::as_str).map(str::to_string);
    let restore_epoch = obj.get("restoreEpoch").and_then(Value::as_str).map(str::to_string);
    enforce_identity(message_type, archive_id.is_some(), restore_epoch.is_some())?;
    let payload_value = obj.get("payload").ok_or_else(|| {
        ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, "payload must be an object")
    })?;
    if payload_value.as_array().is_some() || !payload_value.is_object() {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "payload must be an object",
        ));
    }
    let payload = payload_value.as_object().unwrap();
    reject_secrets(payload_value)?;
    if let Some(schema) = payload_schema(message_type.as_str()) {
        validate_schema(payload_value, &schema)?;
    }
    validate_payload_extras(message_type, payload)?;
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

fn validate_payload_extras(ty: MessageType, payload: &Map<String, Value>) -> Result<(), ProtocolError> {
    match ty {
        MessageType::Handshake => {
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
        MessageType::JobSave | MessageType::FillSubmit | MessageType::SubmitConfirm => {
            let declared = payload
                .get("payloadSha256")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, "missing payloadSha256")
                })?;
            let actual = payload_body_sha256(&Value::Object(payload.clone()))?;
            if declared != actual {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    Layer::Structure,
                    "payloadSha256 does not match the payload body",
                ));
            }
        }
        MessageType::SnapshotChunk => {
            let index = payload.get("chunkIndex").and_then(Value::as_i64).unwrap();
            let count = payload.get("chunkCount").and_then(Value::as_i64).unwrap();
            if index >= count {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    Layer::Structure,
                    "chunkIndex must be in 0..chunkCount",
                ));
            }
            let byte_size = payload.get("byteSize").and_then(Value::as_i64).unwrap() as usize;
            if byte_size > MAX_SNAPSHOT_BYTES {
                return Err(ProtocolError::new(
                    ErrorCode::PayloadTooLarge,
                    Layer::Size,
                    "snapshot byteSize exceeds 2 MiB",
                ));
            }
            let b64 = payload.get("bytesBase64").and_then(Value::as_str).unwrap();
            let decoded = decode_standard_base64(b64)?;
            if decoded.is_empty() || decoded.len() > byte_size {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    Layer::Structure,
                    "decoded chunk length is empty or exceeds snapshot byteSize",
                ));
            }
            let declared = payload.get("chunkSha256").and_then(Value::as_str).unwrap();
            if sha256_hex(&decoded) != declared {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    Layer::Structure,
                    "chunkSha256 does not match decoded bytes",
                ));
            }
            if count == 1 {
                let snap = payload.get("snapshotSha256").and_then(Value::as_str).unwrap();
                if decoded.len() != byte_size || sha256_hex(&decoded) != snap {
                    return Err(ProtocolError::new(
                        ErrorCode::InvalidPayload,
                        Layer::Structure,
                        "single-chunk snapshot hash or length mismatch",
                    ));
                }
            }
        }
        MessageType::OutboxReconcile => {
            let items = payload.get("items").and_then(Value::as_array).unwrap();
            if items.len() > MAX_RECONCILE_ITEMS {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    Layer::Structure,
                    format!("outbox.reconcile items must be 1..{MAX_RECONCILE_ITEMS}"),
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn validate_response_value(value: &Value, request_type: MessageType) -> Result<(), ProtocolError> {
    if value.as_array().is_some() || !value.is_object() {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "response must be an object",
        ));
    }
    validate_schema(value, &response_schema())?;
    let obj = value.as_object().unwrap();
    let ok = obj.get("ok").and_then(Value::as_bool).unwrap();
    if obj.get("payload").map(Value::is_array).unwrap_or(false) {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "payload must be an object",
        ));
    }
    if ok {
        if obj.contains_key("error") {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                "ok:true response must not include error",
            ));
        }
        if request_type.is_write() && obj.get("resultId").and_then(Value::as_str).is_none() {
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
    } else if obj.contains_key("resultId") {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "ok:false response must not include resultId",
        ));
    }
    Ok(())
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
