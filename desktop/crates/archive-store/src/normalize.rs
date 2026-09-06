//! 去重规范化(产品需求 §7、隐私 §7.1):原始字符串始终保留;
//! 规范化值只用于候选查询,不是身份。秘密参数一律剥离,不存在
//! 已审核站点规则时 `code` / `key` 也删除。

/// 有限后缀词表(产品需求 §7:有限词表,折叠后再比)。
const COMPANY_SUFFIXES: &[&str] = &[
    "股份有限公司", "有限责任公司", "有限公司", "集团公司", "控股集团",
    "inc", "inc.", "llc", "ltd", "ltd.", "co., ltd", "co.,ltd", "co., ltd.", "co",
    "corporation", "corp", "corp.", "gmbh", "s.a.", "plc", "kg", "ag",
];

/// 始终剥离的查询参数(大小写不敏感)。
const SECRET_PARAMS: &[&str] = &[
    "token", "access_token", "refresh_token", "id_token", "session", "sessionid",
    "sid", "auth", "authorization", "api_key", "apikey", "password", "pwd",
    "secret", "signature", "sig", "code", "key",
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
                s = trimmed[..trimmed.len() - suffix.len()].trim_end().to_string();
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

/// 去掉 `scheme://user:pass@host/` 的 userinfo 与 fragment;host 之前的部分按
/// authority 解析,取最后一个 `@` 之后作为 host。无 scheme 时原样(仅去 fragment)。
fn strip_userinfo_and_fragment(raw: &str) -> String {
    let (before_frag, _) = raw.split_once('#').unwrap_or((raw, ""));
    match before_frag.split_once("://") {
        Some((scheme, rest)) => {
            let authority_end = rest.find('/').unwrap_or(rest.len());
            let (authority, path) = rest.split_at(authority_end);
            let authority = match authority.rsplit_once('@') {
                Some((_userinfo, host)) => host,
                None => authority,
            };
            format!("{scheme}://{authority}{path}")
        }
        None => before_frag.to_string(),
    }
}

/// 保留名字不在剥离名单内的查询参数。`strip_tracking` 额外移除 utm_*。
fn filter_query(query: &str, strip_tracking: bool) -> Vec<String> {
    let mut kept = Vec::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let name = pair.split('=').next().unwrap_or("").to_lowercase();
        if SECRET_PARAMS.iter().any(|p| *p == name) {
            continue;
        }
        if strip_tracking && TRACKING_PREFIXES.iter().any(|p| name.starts_with(p)) {
            continue;
        }
        kept.push(pair.to_string());
    }
    kept
}

/// 展示/存储用 sourceUrl:与 dedupeUrl 同一秘密剥离策略,但保留跟踪参数。
/// 清洗必须在入库前完成,不保留秘密参数的原始副本。
pub fn sanitize_source_url(raw: &str) -> String {
    let s = strip_userinfo_and_fragment(raw.trim());
    match s.split_once('?') {
        Some((base, q)) => {
            let kept = filter_query(q, false);
            if kept.is_empty() {
                base.to_string()
            } else {
                format!("{base}?{}", kept.join("&"))
            }
        }
        None => s,
    }
}

/// 候选查询用 dedupeUrl:同一秘密剥离,再移除 utm_* 跟踪参数并规范化。
/// URL 只能用于提示,不成为自动合并的身份。
pub fn normalize_dedupe_url(raw: &str) -> String {
    let s = strip_userinfo_and_fragment(raw.trim()).to_lowercase();
    match s.split_once('?') {
        Some((base, q)) => {
            let kept = filter_query(q, true);
            if kept.is_empty() {
                base.to_string()
            } else {
                format!("{base}?{}", kept.join("&"))
            }
        }
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn company_suffix_and_width() {
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
            sanitize_source_url("https://jobs.example.com/apply?code=REQ42&utm_source=mail&access_token=abc"),
            "https://jobs.example.com/apply?utm_source=mail"
        );
        assert_eq!(
            normalize_dedupe_url("https://jobs.example.com/apply?code=REQ42&utm_source=mail&access_token=abc"),
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
