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

/// The desktop store's own label rule (`archive-store::resume_secrets::is_secret_label`,
/// mirrored in the plugin's `profile-fields.js` `SECRET_LABEL`). It is a different, and
/// narrower, word list than `FORBIDDEN_KEYS` above: no bare `otp`/`cookie`/`authorization`,
/// but the Chinese secret-label terms the store also strips. Anything the store accepts
/// under a dynamic `{key, value}` label must reach the wire, and anything the store
/// strips must not — so this list, not `FORBIDDEN_KEYS`, is what governs the `key` string
/// of a template field or profile custom entry. Real JSON object keys still go through
/// `forbidden_name` / `FORBIDDEN_KEYS` unchanged.
const STORE_LABEL_KEYS: &[&str] = &[
    "密码",
    "口令",
    "验证码",
    "校验码",
    "授权码",
    "密钥",
    "私钥",
    "令牌",
    "password",
    "passwd",
    "captcha",
    "token",
    "secret",
];

pub fn reject_secrets(value: &Value) -> Result<(), ProtocolError> {
    reject_secrets_except(value, &[])
}

/// Exempt only exact paths relative to the scanned value. Callers must still validate
/// the exempt value's schema; this is reserved for legacy.import body.apiKey.
pub fn reject_secrets_except(value: &Value, allowed_paths: &[&[&str]]) -> Result<(), ProtocolError> {
    walk(value, &mut Vec::new(), allowed_paths)
}

fn walk(value: &Value, path: &mut Vec<String>, allowed_paths: &[&[&str]]) -> Result<(), ProtocolError> {
    match value {
        Value::Object(map) => {
            if map.get("value").is_some()
                && map.get("key").and_then(Value::as_str).is_some_and(store_label_forbidden)
            {
                return Err(ProtocolError::new(
                    ErrorCode::SecretForbidden,
                    Layer::Secrets,
                    "forbidden dynamic field label",
                ));
            }
            for (k, v) in map {
                path.push(k.clone());
                if allowed_paths.iter().any(|allowed| path.iter().map(String::as_str).eq(allowed.iter().copied())) {
                    path.pop();
                    continue;
                }
                if forbidden_name(k) {
                    return Err(ProtocolError::new(
                        ErrorCode::SecretForbidden,
                        Layer::Secrets,
                        format!("forbidden key {k}"),
                    ));
                }
                walk(v, path, allowed_paths)?;
                path.pop();
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                path.push(index.to_string());
                walk(item, path, allowed_paths)?;
                path.pop();
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

fn forbidden_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    FORBIDDEN_KEYS.iter().any(|forbidden| lower.contains(forbidden))
}

/// Same substring-scan shape as `forbidden_name`, but against the store's own, narrower
/// word list. Used only for the `key` string of a dynamic `{key, value}` label.
fn store_label_forbidden(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    STORE_LABEL_KEYS.iter().any(|forbidden| lower.contains(forbidden))
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

#[cfg(test)]
mod store_label_tests {
    use super::store_label_forbidden;

    // Same word list as archive-store::resume_secrets::is_secret_label /
    // profile-fields.js SECRET_LABEL. FORBIDDEN_KEYS's bare "otp"/"cookie"/"authorization"
    // substrings used to reject these; the store's own list does not carry them.
    #[test]
    fn accepts_labels_the_store_accepts() {
        for label in [
            "Work Authorization",
            "Carbon Footprint 项目", // contains "otp" (Fo-otp-rint)
            "Hotpot 爱好",           // contains "otp" (H-otp-ot)
            "Cookie 研究方向",
        ] {
            assert!(!store_label_forbidden(label), "expected {label:?} to be accepted");
        }
    }

    #[test]
    fn rejects_labels_the_store_rejects() {
        // "密码学课程" (a course ABOUT cryptography) contains the substring 密码 ("password"),
        // and the store's own is_secret_label does a plain substring search with no word
        // boundary, so archive-store rejects this label too. The wire matches that exactly,
        // even though a human would read this as an innocuous course name.
        for label in ["密码学课程", "网银密码", "GitHub Token"] {
            assert!(store_label_forbidden(label), "expected {label:?} to be rejected");
        }
    }
}
