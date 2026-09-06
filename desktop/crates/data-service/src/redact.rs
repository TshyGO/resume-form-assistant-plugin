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

pub fn redact_path(value: &str, replacements: &[(String, &str)]) -> String {
    let mut s = value.to_string();
    let mut pairs = replacements.to_vec();
    pairs.sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));
    for (from, to) in &pairs {
        if !from.is_empty() && s.contains(from.as_str()) {
            s = s.replace(from, to);
        }
    }
    if let Some(home) = dirs::home_dir() {
        if let Some(name) = home.file_name() {
            let name = name.to_string_lossy();
            if name.len() >= 3 {
                s = s.replace(name.as_ref(), "<user>");
            }
        }
    }
    redact_value(&s)
}

pub fn path_replacements(paths: &crate::paths::HostPaths) -> Vec<(String, &'static str)> {
    let mut out = vec![
        (paths.data_root.display().to_string(), "<data-root>"),
        (paths.cache_dir.display().to_string(), "<cache-dir>"),
        (paths.logs_dir.display().to_string(), "<logs-dir>"),
        (paths.archive_dir.display().to_string(), "<archive-dir>"),
    ];
    if let Some(home) = dirs::home_dir() {
        out.push((home.display().to_string(), "<home>"));
    }
    if let Some(exe) = crate::paths::program_dir() {
        out.push((exe.display().to_string(), "<program-dir>"));
    }
    out
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

    #[test]
    fn path_redaction_strips_home_and_data_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("data");
        let paths = crate::paths::HostPaths::resolve_with(Some(root.clone()), None).unwrap();
        let raw = format!("{}\\archive\\file", root.display());
        let redacted = redact_path(&raw, &path_replacements(&paths));
        assert!(redacted.contains("<data-root>") || redacted.contains("<archive-dir>"));
        if let Some(home) = dirs::home_dir() {
            if let Some(name) = home.file_name() {
                let name = name.to_string_lossy();
                if name.len() >= 3 {
                    assert!(!redacted.contains(name.as_ref()), "{redacted}");
                }
            }
        }
    }
}
