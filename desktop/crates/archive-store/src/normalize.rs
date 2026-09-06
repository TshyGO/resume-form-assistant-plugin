//! 去重规范化(产品需求 §7、隐私 §7.1):原始字符串始终保留;
//! 规范化值只用于候选查询,不是身份。秘密参数一律剥离,不存在
//! 已审核站点规则时 `code` / `key` 也删除。

/// 有限后缀词表(产品需求 §7:有限词表,折叠后再比)。
const COMPANY_SUFFIXES: &[&str] = &[
    "股份有限公司",
    "有限责任公司",
    "有限公司",
    "集团公司",
    "控股集团",
    "inc",
    "inc.",
    "llc",
    "ltd",
    "ltd.",
    "co., ltd",
    "co.,ltd",
    "co., ltd.",
    "co",
    "corporation",
    "corp",
    "corp.",
    "gmbh",
    "s.a.",
    "plc",
    "kg",
    "ag",
];

/// 始终剥离的查询参数(大小写不敏感)。
const SECRET_PARAMS: &[&str] = &[
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

/// 去重 URL 额外移除的跟踪参数前缀。
const TRACKING_PREFIXES: &[&str] = &["utm_"];

fn to_half_width(s: &str) -> String {
    s.chars()
        .map(|c| {
            let code = c as u32;
            if (0xFF01..=0xFF5E).contains(&code) {
                char::from_u32(code - 0xFEE0).unwrap_or(c)
            } else if c == '\u{3000}' {
                ' '
            } else {
                c
            }
        })
        .collect()
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 公司名规范化:全半角折叠、压缩空白、去常见后缀、小写拉丁。
pub fn normalize_company(raw: &str) -> String {
    let mut s = collapse_ws(&to_half_width(raw.trim())).to_lowercase();
    loop {
        let trimmed = s
            .trim_end_matches(|c: char| c.is_ascii_punctuation() || c.is_whitespace())
            .to_string();
        let mut hit = false;
        for suffix in COMPANY_SUFFIXES {
            if trimmed.len() > suffix.len() + 1 && trimmed.ends_with(suffix) {
                let head = &trimmed[..trimmed.len() - suffix.len()];
                if suffix.is_ascii()
                    && head
                        .chars()
                        .next_back()
                        .is_some_and(|c| c.is_alphanumeric())
                {
                    continue;
                }
                s = trimmed[..trimmed.len() - suffix.len()]
                    .trim_end()
                    .to_string();
                hit = true;
                break;
            }
        }
        if !hit {
            return trimmed;
        }
    }
}

/// 岗位名规范化:全半角折叠、压缩空白。
pub fn normalize_title(raw: &str) -> String {
    collapse_ws(&to_half_width(raw.trim())).to_lowercase()
}

/// URL parser handles encoded parameter names and preserves case-sensitive paths.
fn clean_url(raw: &str, tracking: bool) -> String {
    let Ok(mut url) = url::Url::parse(raw.trim()) else {
        return String::new();
    };
    if !matches!(url.scheme(), "http" | "https") {
        return String::new();
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| {
            let key = k.to_ascii_lowercase();
            !SECRET_PARAMS.contains(&key.as_str())
                && !(tracking && TRACKING_PREFIXES.iter().any(|p| key.starts_with(p)))
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.set_query(None);
    if !pairs.is_empty() {
        url.query_pairs_mut().extend_pairs(pairs);
    }
    url.to_string()
}
pub fn sanitize_source_url(raw: &str) -> String {
    clean_url(raw, false)
}
pub fn normalize_dedupe_url(raw: &str) -> String {
    clean_url(raw, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn company_suffix_and_width() {
        for name in ["Cisco", "Tesco", "Costco"] {
            assert_eq!(normalize_company(name), name.to_lowercase());
        }
        assert_eq!(normalize_company("星河科技 有限公司"), "星河科技");
        assert_eq!(normalize_company("StarRiver Tech Inc."), "starriver tech");
        assert_eq!(normalize_company("ＡＢＣ 公司"), "abc 公司");
        // 原始串始终保留在应用字段,规范化仅用于查询。
        assert_eq!(normalize_company("  米哈游  "), "米哈游");
    }

    #[test]
    fn url_secret_strip() {
        // 隐私 §7.1 合成例(无已审核站点规则)。
        assert_eq!(
            sanitize_source_url(
                "https://jobs.example.com/apply?code=REQ42&utm_source=mail&access_token=abc"
            ),
            "https://jobs.example.com/apply?utm_source=mail"
        );
        assert_eq!(
            normalize_dedupe_url(
                "https://jobs.example.com/apply?code=REQ42&utm_source=mail&access_token=abc"
            ),
            "https://jobs.example.com/apply"
        );
        assert_eq!(
            sanitize_source_url("https://auth.example.com/callback?code=ONE_TIME_SECRET"),
            "https://auth.example.com/callback"
        );
        assert_eq!(
            sanitize_source_url("https://portal.example.com/reset?key=RESET_SECRET"),
            "https://portal.example.com/reset"
        );
        // userinfo 剥离 + host 小写 + fragment 去除;秘密参数 code 一并剥离。
        assert_eq!(
            normalize_dedupe_url("https://User:P%40ss@Jobs.Example.com/req/42?code=SEC#top"),
            "https://jobs.example.com/req/42"
        );
    }
}
