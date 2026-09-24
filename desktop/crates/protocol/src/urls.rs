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

/// `aiConfig.apiUrl` (and its snake_case spelling) points at the plugin/desktop's own AI
/// provider, which is routinely a LAN or loopback proxy (Ollama and friends) with no TLS.
/// It gets its own, http-or-https check rather than `URL_FIELD_KEYS`'s https-only rule,
/// but still forbids userinfo and credential query parameters.
const API_URL_FIELD_KEYS: &[&str] = &["apiurl", "api_url"];

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
///
/// No `apiUrl` field is treated as http-allowed here; use `reject_sensitive_urls_except`
/// for the one exempt path (`legacy.import` kind `aiConfig`'s `body.apiUrl`).
pub fn reject_sensitive_urls(value: &Value, allowlist: &[UrlAllowRule]) -> Result<(), ProtocolError> {
    reject_sensitive_urls_except(value, allowlist, &[])
}

/// Same scan, but any `apiUrl`/`api_url` key at one of `api_url_paths` (exact paths
/// relative to `value`, the same shape as `secrets::reject_secrets_except`'s
/// `allowed_paths`) is checked with `check_api_url` (http or https) instead of the
/// generic `check_url` (https-only). An `apiUrl` key anywhere else — `profile.values`,
/// a template field's own value, a nested custom field, and so on — still gets the
/// generic https-only rule: the http exception is for the one wire shape PR 3b's import
/// path produces, not for the field name wherever it appears.
pub fn reject_sensitive_urls_except(
    value: &Value,
    allowlist: &[UrlAllowRule],
    api_url_paths: &[&[&str]],
) -> Result<(), ProtocolError> {
    walk(value, allowlist, api_url_paths, &mut Vec::new())
}

fn walk(
    value: &Value,
    allowlist: &[UrlAllowRule],
    api_url_paths: &[&[&str]],
    path: &mut Vec<String>,
) -> Result<(), ProtocolError> {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                path.push(k.clone());
                let key = k.to_ascii_lowercase().replace('-', "_");
                if URL_FIELD_KEYS.contains(&key.as_str()) {
                    if let Some(url) = v.as_str() {
                        check_url(url, allowlist)?;
                    }
                } else if API_URL_FIELD_KEYS.contains(&key.as_str()) {
                    if let Some(url) = v.as_str() {
                        let exempt = api_url_paths.iter().any(|allowed| {
                            path.iter().map(String::as_str).eq(allowed.iter().copied())
                        });
                        if exempt {
                            check_api_url(url, allowlist)?;
                        } else {
                            check_url(url, allowlist)?;
                        }
                    }
                }
                walk(v, allowlist, api_url_paths, path)?;
                path.pop();
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                path.push(index.to_string());
                walk(item, allowlist, api_url_paths, path)?;
                path.pop();
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
    check_url_rest(raw, rest, allowlist)
}

/// `apiUrl` allows http as well as https (LAN/loopback AI proxies such as Ollama have no
/// TLS), but a scheme other than either is a structural defect in the payload, not a
/// credential leak, so it is reported as `invalid_payload` rather than `secret_forbidden`.
fn check_api_url(raw: &str, allowlist: &[UrlAllowRule]) -> Result<(), ProtocolError> {
    if raw.is_empty() {
        return Ok(());
    }
    let rest = raw
        .strip_prefix("https://")
        .or_else(|| raw.strip_prefix("http://"))
        .ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                "apiUrl must use the http or https scheme",
            )
        })?;
    check_url_rest(raw, rest, allowlist)
}

/// Shared authority/query/fragment checks once the scheme prefix has already been
/// stripped and approved by the caller.
fn check_url_rest(raw: &str, rest: &str, allowlist: &[UrlAllowRule]) -> Result<(), ProtocolError> {
    // WHATWG parsing strips tab, LF and CR from anywhere in a URL, so
    // "?access_<TAB>token=" reaches the consumer as "access_token" while a literal
    // scan of the raw string sees a name that matches no sensitive key. Reject every
    // C0 control, space and DEL rather than trying to mirror that normalization.
    if rest.is_empty() || raw.chars().any(|c| c.is_ascii_control() || c == ' ') {
        return Err(forbidden(
            "URL must not carry control characters or credentials",
        ));
    }
    // Authority ends at the first literal path, query or fragment delimiter.
    let (authority, path_query_frag) = match rest.find(['/', '?', '#']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    // An empty authority means extra slashes shifted the userinfo into the path,
    // where the checks below never look. WHATWG parsing still normalizes such a
    // URL back to a credentialed one, so reject instead of inspecting the rest.
    if authority.is_empty() {
        return Err(forbidden("URL authority must not be empty"));
    }
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
        // A routed fragment such as "#/callback?access_token=..." carries its own
        // query string. Treating the whole fragment as one query makes the first key
        // "/callback?access_token", which matches no sensitive name, so also inspect
        // whatever follows the first '?'. Both halves are checked: a fragment may put
        // the credential before the '?' instead.
        let routed_query = frag.split_once('?').map(|(_, q)| q).unwrap_or("");
        if query_has_secret(frag, &host, path_only(path_query), allowlist)?
            || (!routed_query.is_empty()
                && query_has_secret(routed_query, &host, path_only(path_query), allowlist)?)
        {
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
    fn api_url_allows_http_for_lan_and_loopback_proxies() {
        let empty: [UrlAllowRule; 0] = [];
        assert!(check_api_url("http://localhost:11434/v1/chat/completions", &empty).is_ok());
        assert!(check_api_url("http://192.168.1.5:8000/v1/chat/completions", &empty).is_ok());
    }

    #[test]
    fn api_url_still_forbids_userinfo_and_secret_query_params() {
        let empty: [UrlAllowRule; 0] = [];
        let userinfo = check_api_url("http://u:p@host/v1", &empty).unwrap_err();
        assert_eq!(userinfo.code, ErrorCode::SecretForbidden);
        let secret_query = check_api_url("https://host/v1?api_key=x", &empty).unwrap_err();
        assert_eq!(secret_query.code, ErrorCode::SecretForbidden);
    }

    #[test]
    fn the_http_exception_only_applies_at_the_exempted_path() {
        // Only legacy.import's body.apiUrl gets the http exception; the same field name
        // anywhere else (a profile value here) must still go through the generic,
        // https-only check_url — exactly as it did before apiUrl had any exception.
        let empty: [UrlAllowRule; 0] = [];
        let exempt_path: &[&str] = &["body", "apiUrl"];

        let exempt_body = serde_json::json!({"body": {"apiUrl": "http://ollama.local/v1"}});
        assert!(reject_sensitive_urls_except(&exempt_body, &empty, &[exempt_path]).is_ok());

        let elsewhere = serde_json::json!({"profile": {"values": {"apiUrl": "http://example.com/"}}});
        let err = reject_sensitive_urls_except(&elsewhere, &empty, &[exempt_path]).unwrap_err();
        assert_eq!(err.code, ErrorCode::SecretForbidden);

        // The bare, no-exemption entry point must behave the same as passing no paths.
        let err2 = reject_sensitive_urls(&elsewhere, &empty).unwrap_err();
        assert_eq!(err2.code, ErrorCode::SecretForbidden);
    }

    #[test]
    fn api_url_rejects_non_http_schemes_as_invalid_payload_not_a_secret_leak() {
        let empty: [UrlAllowRule; 0] = [];
        let err = check_api_url("ftp://host", &empty).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidPayload);
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
