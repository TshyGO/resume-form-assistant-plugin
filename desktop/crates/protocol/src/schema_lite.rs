use serde_json::Value;

use crate::error::{ErrorCode, Layer, ProtocolError};

pub fn envelope_schema() -> Value {
    serde_json::from_str(include_str!("../schemas/request-envelope.json")).expect("envelope schema")
}

pub fn response_schema() -> Value {
    serde_json::from_str(include_str!("../schemas/response-envelope.json")).expect("response schema")
}

pub fn payload_schema(message_type: &str) -> Option<Value> {
    let raw = match message_type {
        "health" => include_str!("../schemas/payloads/health.json"),
        "handshake" => include_str!("../schemas/payloads/handshake.json"),
        "application.queryCandidates" => include_str!("../schemas/payloads/query-candidates.json"),
        "job.save" => include_str!("../schemas/payloads/job-save.json"),
        "fill.submit" => include_str!("../schemas/payloads/fill-submit.json"),
        "snapshot.chunk" => include_str!("../schemas/payloads/snapshot-chunk.json"),
        "submit.confirm" => include_str!("../schemas/payloads/submit-confirm.json"),
        "outbox.reconcile" => include_str!("../schemas/payloads/outbox-reconcile.json"),
        _ => return None,
    };
    Some(serde_json::from_str(raw).expect("payload schema"))
}

pub fn validate_schema(instance: &Value, schema: &Value) -> Result<(), ProtocolError> {
    apply(instance, schema)
}

fn apply(instance: &Value, schema: &Value) -> Result<(), ProtocolError> {
    let schema_obj = schema.as_object().ok_or_else(|| invalid("schema must be an object"))?;
    if let Some(ty) = schema_obj.get("type").and_then(Value::as_str) {
        match ty {
            "object" => {
                let obj = instance.as_object().ok_or_else(|| invalid("value must be an object"))?;
                if instance.as_array().is_some() {
                    return Err(invalid("value must be an object"));
                }
                if schema_obj.get("additionalProperties") == Some(&Value::Bool(false)) {
                    let allowed = schema_obj
                        .get("properties")
                        .and_then(Value::as_object)
                        .map(|p| p.keys().cloned().collect::<Vec<_>>())
                        .unwrap_or_default();
                    for key in obj.keys() {
                        if !allowed.iter().any(|a| a == key) {
                            return Err(invalid(&format!("unexpected field {key}")));
                        }
                    }
                }
                if let Some(required) = schema_obj.get("required").and_then(Value::as_array) {
                    for key in required {
                        let name = key.as_str().unwrap_or("");
                        if !obj.contains_key(name) {
                            return Err(invalid(&format!("missing field {name}")));
                        }
                    }
                }
                if let Some(props) = schema_obj.get("properties").and_then(Value::as_object) {
                    for (key, sub) in props {
                        if let Some(value) = obj.get(key) {
                            apply(value, sub)?;
                        }
                    }
                }
            }
            "array" => {
                let arr = instance.as_array().ok_or_else(|| invalid("value must be an array"))?;
                if let Some(min) = schema_obj.get("minItems").and_then(Value::as_u64) {
                    if (arr.len() as u64) < min {
                        return Err(invalid("array too short"));
                    }
                }
                if let Some(max) = schema_obj.get("maxItems").and_then(Value::as_u64) {
                    if (arr.len() as u64) > max {
                        return Err(invalid("array too long"));
                    }
                }
                if let Some(items) = schema_obj.get("items") {
                    for item in arr {
                        apply(item, items)?;
                    }
                }
            }
            "string" => {
                let s = instance.as_str().ok_or_else(|| invalid("value must be a string"))?;
                if let Some(min) = schema_obj.get("minLength").and_then(Value::as_u64) {
                    if (s.chars().count() as u64) < min {
                        return Err(invalid("string too short"));
                    }
                }
                if let Some(max) = schema_obj.get("maxLength").and_then(Value::as_u64) {
                    if (s.chars().count() as u64) > max {
                        return Err(invalid("string too long"));
                    }
                }
                if let Some(pattern) = schema_obj.get("pattern").and_then(Value::as_str) {
                    match check_pattern(s, pattern) {
                        PatternCheck::Match => {}
                        PatternCheck::Mismatch => return Err(invalid("string does not match pattern")),
                        PatternCheck::Unsupported => {
                            return Err(invalid(&format!("unsupported schema pattern {pattern}")));
                        }
                    }
                }
            }
            "integer" => {
                let n = instance.as_i64().ok_or_else(|| invalid("value must be an integer"))?;
                if let Some(min) = schema_obj.get("minimum").and_then(Value::as_i64) {
                    if n < min {
                        return Err(invalid("integer below minimum"));
                    }
                }
                if let Some(max) = schema_obj.get("maximum").and_then(Value::as_i64) {
                    if n > max {
                        return Err(invalid("integer above maximum"));
                    }
                }
            }
            "boolean" => {
                if !instance.is_boolean() {
                    return Err(invalid("value must be a boolean"));
                }
            }
            other => return Err(invalid(&format!("unsupported schema type {other}"))),
        }
    }
    if let Some(values) = schema_obj.get("enum").and_then(Value::as_array) {
        if !values.iter().any(|v| v == instance) {
            return Err(invalid("value is not in enum"));
        }
    }
    Ok(())
}

fn invalid(message: &str) -> ProtocolError {
    ProtocolError::new(ErrorCode::InvalidPayload, Layer::Structure, message)
}

enum PatternCheck {
    Match,
    Mismatch,
    Unsupported,
}

fn check_pattern(value: &str, pattern: &str) -> PatternCheck {
    if pattern.contains("[0-9a-fA-F]{8}-") {
        return if is_uuid(value) {
            PatternCheck::Match
        } else {
            PatternCheck::Mismatch
        };
    }
    if pattern == "^[0-9a-f]{64}$" {
        return if value.len() == 64 && value.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
            PatternCheck::Match
        } else {
            PatternCheck::Mismatch
        };
    }
    if pattern.contains("T[0-9]{2}:[0-9]{2}:[0-9]{2}") {
        return if timestamp_matches_schema_pattern(value) {
            PatternCheck::Match
        } else {
            PatternCheck::Mismatch
        };
    }
    PatternCheck::Unsupported
}

fn syntactic_timestamp(value: &str) -> bool {
    let b = value.as_bytes();
    if !value.ends_with('Z') || !value.is_ascii() || b.len() < 20 {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| range.clone().all(|i| b.get(i).copied().map(|c| c.is_ascii_digit()).unwrap_or(false));
    digits(0..4)
        && b.get(4) == Some(&b'-')
        && digits(5..7)
        && b.get(7) == Some(&b'-')
        && digits(8..10)
        && b.get(10) == Some(&b'T')
        && digits(11..13)
        && b.get(13) == Some(&b':')
        && digits(14..16)
        && b.get(16) == Some(&b':')
        && digits(17..19)
        && (b.len() == 20 || (b.len() > 21 && b[19] == b'.' && b[20..b.len() - 1].iter().all(u8::is_ascii_digit)))
}

fn is_uuid(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 5
        && parts[0].len() == 8
        && parts[1].len() == 4
        && parts[2].len() == 4
        && parts[3].len() == 4
        && parts[4].len() == 12
        && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Schema pattern only. Calendar checking is a separate protocol rule.
pub fn timestamp_matches_schema_pattern(value: &str) -> bool {
    syntactic_timestamp(value)
}
