use serde_json::Value;

use crate::error::{ErrorCode, Layer, ProtocolError};

const URL_FIELD_KEYS: &[&str] = &[
    "sourceurl",
    "source_url",
    "urlredacted",
    "url_redacted",
    "dedupeurl",
    "dedupe_url",
    "url",
];

const SECRET_QUERY_KEYS: &[&str] = &[
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "session",
    "sessionid",
    "sid",
    "auth",
    "authorization",
    "api_key",
    "apikey",
    "password",
    "pwd",
    "secret",
    "signature",
    "sig",
    "code",
    "key",
];

#[derive(Debug, Clone)]
pub struct UrlAllowRule {
    pub host: String,
    pub path_prefix: String,
    pub param: String,
    pub value_pattern: String,
}

/// Reject unsanitized URLs. The validator never rewrites the payload.
pub fn reject_sensitive_urls(value: &Value, allowlist: &[UrlAllowRule]) -> Result<(), ProtocolError> {
    walk(value, allowlist)
}

fn walk(value: &Value, allowlist: &[UrlAllowRule]) -> Result<(), ProtocolError> {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let key = k.to_ascii_lowercase().replace('-', "_");
                if URL_FIELD_KEYS.contains(&key.as_str()) {
                    if let Some(url) = v.as_str() {
                        check_url(url, allowlist)?;
                    }
                }
                walk(v, allowlist)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                walk(item, allowlist)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn check_url(raw: &str, allowlist: &[UrlAllowRule]) -> Result<(), ProtocolError> {
    if raw.is_empty() {
        return Ok(());
    }
    let Some(rest) = raw.strip_prefix("https://") else {
        return Err(forbidden("URL must be https without credentials"));
    };
    if rest.contains(' ') || rest.is_empty() {
        return Err(forbidden("URL must be https without credentials"));
    }
    let (authority, path_query_frag) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if authority.contains('@') {
        return Err(forbidden("URL userinfo is not allowed"));
    }
    let host = authority
        .split_once(':')
        .map(|(h, _)| h)
        .unwrap_or(authority)
        .to_ascii_lowercase();
    let (path_query, fragment) = match path_query_frag.split_once('#') {
        Some((pq, frag)) => (pq, Some(frag)),
        None => (path_query_frag, None),
    };
    if let Some(frag) = fragment {
        if query_has_secret(frag, &host, path_only(path_query), allowlist)? {
            return Err(forbidden("URL fragment contains a credential parameter"));
        }
    }
    let (path, query) = match path_query.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path_query, None),
    };
    if let Some(query) = query {
        if query_has_secret(query, &host, path, allowlist)? {
            return Err(forbidden("URL query contains a credential parameter"));
        }
    }
    Ok(())
}

fn path_only(path_query: &str) -> &str {
    path_query.split_once('?').map(|(p, _)| p).unwrap_or(path_query)
}

fn query_has_secret(
    query: &str,
    host: &str,
    path: &str,
    allowlist: &[UrlAllowRule],
) -> Result<bool, ProtocolError> {
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (raw_name, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        let name = normalize_param_name(raw_name);
        let value = percent_decode_times(raw_value, 3);
        if !SECRET_QUERY_KEYS.contains(&name.as_str()) {
            continue;
        }
        if is_allowlisted(host, path, &name, &value, allowlist) {
            continue;
        }
        return Ok(true);
    }
    Ok(false)
}

fn normalize_param_name(raw: &str) -> String {
    percent_decode_times(raw, 3)
        .to_ascii_lowercase()
        .replace('-', "_")
}

fn percent_decode_times(input: &str, times: usize) -> String {
    let mut current = input.replace('+', " ");
    for _ in 0..times {
        let next = percent_decode_once(&current);
        if next == current {
            break;
        }
        current = next;
    }
    current
}

fn percent_decode_once(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn is_allowlisted(host: &str, path: &str, param: &str, value: &str, allowlist: &[UrlAllowRule]) -> bool {
    allowlist.iter().any(|rule| {
        rule.host.eq_ignore_ascii_case(host)
            && path.starts_with(&rule.path_prefix)
            && rule.param.eq_ignore_ascii_case(param)
            && value_matches(value, &rule.value_pattern)
    })
}

fn value_matches(value: &str, pattern: &str) -> bool {
    if let Some(body) = pattern.strip_prefix("^REQ[0-9]{") {
        if let Some(range) = body.strip_suffix("}$") {
            let mut parts = range.split(',');
            let min: usize = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let max: usize = parts.next().and_then(|s| s.parse().ok()).unwrap_or(min);
            return value.starts_with("REQ")
                && value.len() >= 3 + min
                && value.len() <= 3 + max
                && value.as_bytes()[3..].iter().all(u8::is_ascii_digit);
        }
    }
    false
}

fn forbidden(message: &str) -> ProtocolError {
    ProtocolError::new(ErrorCode::SecretForbidden, Layer::Secrets, message)
}

pub fn allowlist_from_rules(rules: &Value) -> Vec<UrlAllowRule> {
    rules
        .get("urlAllowlist")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some(UrlAllowRule {
                host: item.get("host")?.as_str()?.to_string(),
                path_prefix: item.get("pathPrefix")?.as_str()?.to_string(),
                param: item.get("param")?.as_str()?.to_string(),
                value_pattern: item.get("valuePattern")?.as_str()?.to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_access_token_and_userinfo() {
        let empty: [UrlAllowRule; 0] = [];
        assert!(check_url("https://jobs.example.com/apply?access_token=abc", &empty).is_err());
        assert!(check_url("https://user:pass@jobs.example.com/apply", &empty).is_err());
        assert!(check_url(
            "https://jobs.example.com/apply?%61ccess_token=abc",
            &empty
        )
        .is_err());
        assert!(check_url("https://jobs.example.com/apply?utm_source=mail", &empty).is_ok());
    }

    #[test]
    fn allowlist_only_keeps_reviewed_job_number() {
        let rules = [UrlAllowRule {
            host: "jobs.example.test".into(),
            path_prefix: "/jobs/".into(),
            param: "code".into(),
            value_pattern: "^REQ[0-9]{2,8}$".into(),
        }];
        assert!(check_url("https://jobs.example.test/jobs/x?code=REQ42", &rules).is_ok());
        assert!(check_url("https://jobs.example.test/jobs/x?code=SECRET", &rules).is_err());
        assert!(check_url("https://jobs.example.test/login?code=REQ42", &rules).is_err());
        assert!(check_url("https://jobs.example.test/jobs/x?key=REQ42", &rules).is_err());
    }
}
