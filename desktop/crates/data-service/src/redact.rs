/// Keys that must never appear in log context or diagnostic extras.
const FORBIDDEN_KEYS: &[&str] = &[
    "resume",
    "email",
    "body",
    "content",
    "snapshot",
    "cookie",
    "set-cookie",
    "authorization",
    "api_key",
    "apikey",
    "api-key",
    "password",
    "secret",
    "token",
    "otp",
    "cookie_header",
];

pub fn is_forbidden_key(key: &str) -> bool {
    let k = key.trim().to_ascii_lowercase().replace('_', "-");
    FORBIDDEN_KEYS.iter().any(|f| k == *f || k.contains(f))
}

pub fn redact_value(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if lower.contains("api_key")
        || lower.contains("api-key")
        || lower.contains("authorization")
        || lower.contains("bearer ")
        || lower.contains("cookie")
        || lower.contains("set-cookie")
        || lower.contains("password=")
        || value.contains("sk-")
    {
        return "[redacted]".to_string();
    }
    value.chars().take(500).collect()
}

pub fn sanitize_context(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .filter(|(k, _)| !is_forbidden_key(k))
        .map(|(k, v)| (k.to_string(), redact_value(v)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_forbidden_keys() {
        let out = sanitize_context(&[
            ("code", "HOST_STARTED"),
            ("api_key", "sk-secret"),
            ("cookie", "sid=1"),
            ("resume", "full cv text"),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "code");
    }

    #[test]
    fn redacts_embedded_secrets() {
        assert_eq!(
            redact_value("Authorization: Bearer abc"),
            "[redacted]"
        );
        assert_eq!(redact_value("sk-abcdefghijklmnopqrstuvwxyz"), "[redacted]");
        assert_eq!(redact_value("windows"), "windows");
    }
}
