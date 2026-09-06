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
        || has_secret_query(value)
    {
        return "[redacted]".to_string();
    }
    value.chars().take(500).collect()
}

// Detection only: never rewrite normal log values. Decode percent-encoded
// parameter names and delimiters, including nested encodings, before matching.
fn has_secret_query(value: &str) -> bool {
    let mut decoded = value.as_bytes().to_vec();
    for depth in 0..4 {
        let mut next = Vec::with_capacity(decoded.len());
        let mut i = 0;
        while i < decoded.len() {
            if decoded[i] == b'%' && i + 2 < decoded.len() {
                let hi = (decoded[i + 1] as char).to_digit(16);
                let lo = (decoded[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    next.push((hi * 16 + lo) as u8);
                    i += 3;
                    continue;
                }
            }
            next.push(decoded[i]);
            i += 1;
        }
        if next.len() == decoded.len() {
            break;
        }
        // Suspiciously nested encoding is not useful diagnostic text. Fail
        // closed instead of spending unbounded time decoding a log value.
        if depth == 3 {
            return true;
        }
        decoded = next;
    }
    decoded.make_ascii_lowercase();
    decoded
        .split(|b| matches!(b, b'?' | b'&' | b'#'))
        .skip(1)
        .any(|part| {
            let key = part.split(|b| *b == b'=').next().unwrap_or_default();
            part.contains(&b'=')
                && [
                    b"token".as_slice(),
                    b"access_token",
                    b"refresh_token",
                    b"id_token",
                    b"api_key",
                    b"api-key",
                    b"apikey",
                    b"key",
                ]
                .contains(&key)
        })
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
        assert_eq!(redact_value("Authorization: Bearer abc"), "[redacted]");
        assert_eq!(redact_value("sk-abcdefghijklmnopqrstuvwxyz"), "[redacted]");
        assert_eq!(redact_value("windows"), "windows");
    }

    #[test]
    fn query_secrets_and_encodings_are_redacted() {
        for key in [
            "token",
            "access_token",
            "api_key",
            "apikey",
            "key",
            "ToKeN",
            "api%5fkey",
        ] {
            for eq in ["=", "%3D", "%253d"] {
                let input = format!("https://example.test/?page=1&{key}{eq}SYNTHETIC_SECRET");
                assert_eq!(redact_value(&input), "[redacted]", "{input}");
                assert_eq!(sanitize_context(&[("endpoint", &input)])[0].1, "[redacted]");
            }
        }
        assert_eq!(
            redact_value("https%3a%2f%2fexample.test%2f%3ftoken%3dSYNTHETIC_SECRET"),
            "[redacted]"
        );
        for input in [
            "https://example.test/?page=1&sort=asc",
            "https://example.test/?monkey=value&tokenizer=fast",
            "普通文字%zz",
            "C:\\test\\file",
        ] {
            assert_eq!(redact_value(input), input);
        }
        assert_eq!(redact_value(&"x".repeat(600)).len(), 500);
        assert_eq!(
            redact_value(&format!("{}?token=secret", "x".repeat(600))),
            "[redacted]"
        );
        assert_eq!(
            redact_value(&format!("%{}41", "25".repeat(100_000))),
            "[redacted]"
        );
    }

    #[test]
    fn query_secrets_do_not_reach_logs_or_diagnostics() {
        let tmp = tempfile::tempdir().unwrap();
        let paths =
            crate::paths::HostPaths::resolve_with(Some(tmp.path().join("data")), None).unwrap();
        paths.ensure_layout().unwrap();
        let pairs = [
            (
                "endpoint",
                "https://example.test/?access%5Ftoken%3DSYNTHETIC_SECRET",
            ),
            ("platform", "windows"),
        ];
        crate::logging::write_log(&paths, "info", "TEST", &pairs).unwrap();
        let log = std::fs::read_to_string(crate::logging::log_path(&paths)).unwrap();
        let diagnostics = crate::host::diagnostics_from(&paths, false, &pairs).to_string();
        for text in [log, diagnostics] {
            assert!(!text.contains("SYNTHETIC_SECRET"));
            assert!(text.contains("windows"));
            assert!(text.contains("[redacted]"));
        }
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
