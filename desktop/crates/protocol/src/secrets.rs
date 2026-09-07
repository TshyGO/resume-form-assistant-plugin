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
            let api_key_like = lower
                .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                .any(|token| token.starts_with("sk-") && token.len() >= 20);
            if api_key_like || lower.contains("bearer ") || names_a_secret(&lower) {
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

/// True when a string carries a forbidden key that names a value, as in
/// `Cookie: sessionid=...` or `x-api-key: ...`.
///
/// The key list is already refused as an object key; a caller can otherwise smuggle the
/// same content inside an allowed free-text field. The key must not continue a longer
/// word, so `Secret Lab` and `Token Inc.` stay acceptable, and it must be followed by
/// `:` or `=` and a non-empty value.
fn names_a_secret(lower: &str) -> bool {
    for key in FORBIDDEN_KEYS {
        let mut from = 0;
        while let Some(offset) = lower[from..].find(key) {
            let start = from + offset;
            let end = start + key.len();
            let continues_a_word = lower[..start]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric());
            let rest = lower[end..].trim_start_matches(' ');
            let value = rest
                .strip_prefix(':')
                .or_else(|| rest.strip_prefix('='));
            if !continues_a_word && value.is_some_and(|v| !v.trim().is_empty()) {
                return true;
            }
            from = end;
        }
    }
    false
}
