use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub message_id: Option<String>,
    pub from_addr: Option<String>,
    pub from_name: Option<String>,
    pub subject: Option<String>,
    pub sent_at: Option<String>,
}
impl Header {
    pub fn parse(raw: &[u8]) -> Self {
        let mail = evidence_import::parse_eml(raw);
        Self {
            message_id: mail.as_ref().and_then(|m| m.message_id.clone()),
            from_addr: mail.as_ref().and_then(|m| m.from_addr.clone()),
            from_name: mail_parser::MessageParser::default()
                .parse(raw)
                .and_then(|m| {
                    m.from()
                        .and_then(|a| a.first())
                        .and_then(|a| a.name())
                        .map(str::to_string)
                }),
            subject: mail.as_ref().and_then(|m| m.subject.clone()),
            sent_at: mail.as_ref().and_then(|m| m.sent_at.clone()),
        }
    }
    /// Same safeguards as #330: Message-ID alone can be reused by broken senders.
    /// A header fingerprint keeps ignores stable across UIDVALIDITY changes even
    /// for messages without an ID. Such malformed identical headers are ambiguous.
    pub fn fingerprint(&self) -> String {
        let key = if self.message_id.is_some() {
            serde_json::json!([self.message_id, self.from_addr, self.sent_at])
        } else {
            serde_json::json!([self.from_addr, self.from_name, self.subject, self.sent_at])
        };
        format!("{:x}", Sha256::digest(key.to_string().as_bytes()))
    }
}

// Actual sender domains, never display-name substring matches. Keep this
// versioned list small; an unknown sender can still match a company or keyword.
const RECRUITERS: &[(&str, &str)] = &[
    ("beisen.com", "北森"),
    ("italent.cn", "北森"),
    ("mokahr.com", "Moka"),
    ("zhaopin.com", "智联招聘"),
    ("51job.com", "前程无忧"),
];
const KEYWORDS: &[&str] = &[
    "面试",
    "笔试",
    "测评",
    "录用",
    "offer",
    "interview",
    "assessment",
];
fn folded(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn ascii_token_contains(haystack: &str, needle: &str) -> bool {
    let haystack = haystack.to_ascii_lowercase();
    let needle = needle.to_ascii_lowercase();
    haystack.match_indices(&needle).any(|(start, value)| {
        let before = haystack[..start].chars().next_back();
        let after = haystack[start + value.len()..].chars().next();
        before.map_or(true, |c| !c.is_ascii_alphanumeric())
            && after.map_or(true, |c| !c.is_ascii_alphanumeric())
    })
}

fn ascii_words(value: &str) -> Vec<String> {
    value
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

fn ascii_phrase_contains(haystack: &str, needle: &str) -> bool {
    let words = ascii_words(needle);
    if words.iter().map(String::len).sum::<usize>() < 2 {
        return false;
    }
    ascii_words(haystack)
        .windows(words.len())
        .any(|candidate| candidate == words)
}

pub fn classify(header: &Header, companies: &[String]) -> Vec<String> {
    let mut reasons = Vec::new();
    if let Some(domain) = header
        .from_addr
        .as_deref()
        .and_then(|a| a.rsplit_once('@').map(|(_, d)| d.to_ascii_lowercase()))
    {
        if let Some((_, name)) = RECRUITERS
            .iter()
            .find(|(d, _)| domain == *d || domain.ends_with(&format!(".{d}")))
        {
            reasons.push(format!("招聘系统来信：{name}"));
        }
        // Feishu also sends non-recruiting notifications. Restrict its owned
        // domain to recruitment sender features, not every Feishu message.
        let from = header
            .from_addr
            .as_deref()
            .unwrap_or("")
            .to_ascii_lowercase();
        let local = from.split('@').next().unwrap_or("");
        if (domain == "feishu.cn" || domain.ends_with(".feishu.cn"))
            && (local.contains("recruit")
                || local.contains("hire")
                || header
                    .from_name
                    .as_deref()
                    .unwrap_or("")
                    .contains("飞书招聘"))
        {
            reasons.push("招聘系统来信：飞书招聘（发件人特征）".into());
        }
    }
    let subject = folded(header.subject.as_deref().unwrap_or(""));
    let subject_raw = header.subject.as_deref().unwrap_or("");
    let sender_name = folded(header.from_name.as_deref().unwrap_or(""));
    let sender_name_raw = header.from_name.as_deref().unwrap_or("");
    for company in companies {
        let needle = folded(company);
        let ascii = company.is_ascii() && company.chars().any(|c| c.is_ascii_alphanumeric());
        let matches = if ascii {
            ascii_phrase_contains(subject_raw, company)
                || ascii_phrase_contains(sender_name_raw, company)
        } else {
            needle.chars().count() >= 2
                && (subject.contains(&needle) || sender_name.contains(&needle))
        };
        if matches {
            let reason = format!("匹配申请公司：{company}");
            if !reasons.contains(&reason) {
                reasons.push(reason);
            }
        }
    }
    for keyword in KEYWORDS {
        let matches = if keyword.is_ascii() {
            ascii_token_contains(subject_raw, keyword)
        } else {
            subject.contains(keyword)
        };
        if matches {
            reasons.push(format!("标题包含：{keyword}"));
        }
    }
    reasons
}
