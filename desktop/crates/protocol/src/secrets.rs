use serde_json::Value;

use crate::error::{ErrorCode, Layer, ProtocolError};

const FORBIDDEN_KEYS: &[&str] = &[
    "apikey",
    "api_key",
    "api-key",
    "authorization",
    "cookie",
    "set-cookie",
    "password",
    "otp",
    "token",
    "secret",
];

pub fn reject_secrets(value: &Value) -> Result<(), ProtocolError> {
    walk(value)
}

fn walk(value: &Value) -> Result<(), ProtocolError> {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let key = k.to_ascii_lowercase();
                if FORBIDDEN_KEYS.iter().any(|f| key == *f || key.contains(f)) {
                    return Err(ProtocolError::new(
                        ErrorCode::SecretForbidden,
                        Layer::Secrets,
                        format!("forbidden key {k}"),
                    ));
                }
                walk(v)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                walk(item)?;
            }
        }
        Value::String(s) => {
            let lower = s.to_ascii_lowercase();
            if s.contains("sk-") || lower.contains("bearer ") {
                return Err(ProtocolError::new(
                    ErrorCode::SecretForbidden,
                    Layer::Secrets,
                    "payload looks like a secret",
                ));
            }
        }
        _ => {}
    }
    Ok(())
}
