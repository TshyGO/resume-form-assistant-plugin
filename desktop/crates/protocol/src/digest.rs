use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::error::{ErrorCode, Layer, ProtocolError};

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Compact JSON with lexicographically sorted object keys and UTF-8 (no extra `\uXXXX` escaping).
pub fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                out.insert(key.clone(), canonical_json(&map[key]));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_json).collect()),
        other => other.clone(),
    }
}

pub fn payload_body_sha256(payload: &Value) -> Result<String, ProtocolError> {
    let obj = payload.as_object().ok_or_else(|| {
        ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "payload must be an object",
        )
    })?;
    let mut copy = obj.clone();
    copy.remove("payloadSha256");
    let bytes = serde_json::to_vec(&canonical_json(&Value::Object(copy))).map_err(|e| {
        ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            format!("cannot serialize payload: {e}"),
        )
    })?;
    Ok(sha256_hex(&bytes))
}

pub fn decode_standard_base64(text: &str) -> Result<Vec<u8>, ProtocolError> {
    if text.as_bytes().iter().any(|b| b.is_ascii_whitespace()) {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "bytesBase64 must not contain whitespace",
        ));
    }
    STANDARD.decode(text.as_bytes()).map_err(|_| {
        ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "bytesBase64 is not strict standard Base64",
        )
    })
}
