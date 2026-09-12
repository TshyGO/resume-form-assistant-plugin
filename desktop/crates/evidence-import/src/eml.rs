//! `.eml` 解析：头部与**纯文本**正文。
//!
//! 正文永远以纯文本交出去（拆分计划 Q4）：HTML 在这里被压平，标签、脚本、样式和远程
//! 资源引用都不会留下，链接以 `文字 <URL>` 的形式变成可读的文本。界面因此不需要任何
//! HTML 清洗器，也不需要相信邮件里的东西。

use mail_parser::MessageParser;

/// `bodyExtract` 的上限。超过就截断并说明——档案里留的是原件，摘要只是给人看的。
pub const MAX_BODY_EXTRACT: usize = 64 * 1024;

const TRUNCATED: &str = "（正文已截断）";

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedMail {
    pub subject: Option<String>,
    pub from_addr: Option<String>,
    /// UTC 的 RFC3339；解析不出就是 None，**不拿导入时间冒充发送时间**。
    pub sent_at: Option<String>,
    pub body_extract: Option<String>,
    /// 这封信有 HTML 部件（正文仍然是压平后的文本）。
    pub had_html: bool,
}

/// 解析一封邮件。`None` 表示「这不是邮件」——调用方照常把原件存下来，只是当成别的格式。
pub fn parse_eml(bytes: &[u8]) -> Option<ParsedMail> {
    let message = MessageParser::default().parse(bytes)?;

    let subject = message
        .subject()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let from_addr = message.from().and_then(|from| {
        from.first()
            .and_then(|addr| addr.address())
            .map(|a| a.trim().to_lowercase())
    });
    let sent_at = message.date().map(|date| rfc3339_utc(date.to_timestamp()));
    // `html_body_count` 把纯文本部件也算进去（它是 HTML 视图的回退），所以看真实的部件类型。
    let had_html = message
        .parts
        .iter()
        .any(|part| matches!(&part.body, mail_parser::PartType::Html(_)));

    // 这不是一封信，只是一段文字：让调用方按普通文本处理。
    if subject.is_none() && from_addr.is_none() && sent_at.is_none() {
        return None;
    }

    // 取真实的部件，不用 `body_text`：那个方法在只有 HTML 时会用它自己的转换填坑，
    // 于是链接地址就被吃掉了，而我们要把链接当作文本留给用户看。
    let plain = message
        .parts
        .iter()
        .find_map(|part| match &part.body {
            mail_parser::PartType::Text(text) => Some(text.trim().to_string()),
            _ => None,
        })
        .filter(|text| !text.is_empty());
    let text = plain.or_else(|| {
        message
            .parts
            .iter()
            .find_map(|part| match &part.body {
                mail_parser::PartType::Html(html) => Some(html_to_text(html).trim().to_string()),
                _ => None,
            })
            .filter(|text| !text.is_empty())
    });

    Some(ParsedMail {
        subject,
        from_addr,
        sent_at,
        body_extract: text.map(truncate),
        had_html,
    })
}

fn truncate(text: String) -> String {
    if text.len() <= MAX_BODY_EXTRACT {
        return text;
    }
    let mut end = MAX_BODY_EXTRACT;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{TRUNCATED}", &text[..end])
}

/// 把 HTML 压平成文本：脚本与样式整块丢掉，块级标签变换行，链接变成 `文字 <URL>`。
pub fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;

    while let Some(open) = rest.find('<') {
        out.push_str(&decode_entities(&rest[..open]));
        rest = &rest[open..];
        let Some(close) = rest.find('>') else {
            // 没有闭合的尖括号：剩下的当纯文本，绝不原样吐出标签。
            rest = "";
            break;
        };
        let tag = &rest[1..close];
        let lower = tag.to_ascii_lowercase();
        let name = lower
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '/' || c == '>')
            .next()
            .unwrap_or("")
            .to_string();
        rest = &rest[close + 1..];

        match name.as_str() {
            "script" | "style" | "head" if !lower.starts_with('/') => {
                let end = format!("</{name}");
                match rest.to_ascii_lowercase().find(&end) {
                    Some(at) => {
                        rest = &rest[at..];
                        if let Some(gt) = rest.find('>') {
                            rest = &rest[gt + 1..];
                        }
                    }
                    None => rest = "",
                }
            }
            "br" => out.push('\n'),
            "p" | "div" | "tr" | "li" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "table"
            | "ul" | "ol" | "blockquote" => {
                if lower.starts_with('/') {
                    out.push_str("\n\n");
                } else if !out.ends_with('\n') && !out.is_empty() {
                    out.push('\n');
                }
            }
            "a" if !lower.starts_with('/') => {
                if let Some(href) = attribute(tag, "href") {
                    // 链接地址跟在文字后面，作为文本；界面不会把它变成可点的东西。
                    let (text, remainder) = until_closing_anchor(rest);
                    out.push_str(&decode_entities(&text));
                    out.push_str(&format!(" <{href}>"));
                    rest = remainder;
                }
            }
            _ => {}
        }
    }
    out.push_str(&decode_entities(rest));

    let mut collapsed = String::with_capacity(out.len());
    let mut blank = 0;
    for line in out.lines() {
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        collapsed.push_str(line.trim_end());
        collapsed.push('\n');
    }
    collapsed
}

/// `<a>` 与 `</a>` 之间的文字（连同标签一起去掉）。
fn until_closing_anchor(rest: &str) -> (String, &str) {
    match rest.to_ascii_lowercase().find("</a") {
        Some(at) => {
            let text = strip_tags(&rest[..at]);
            let remainder = &rest[at..];
            match remainder.find('>') {
                Some(gt) => (text, &remainder[gt + 1..]),
                None => (text, ""),
            }
        }
        None => (strip_tags(rest), ""),
    }
}

fn strip_tags(fragment: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for c in fragment.chars() {
        match c {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let at = lower.find(&format!("{name}="))?;
    let after = &tag[at + name.len() + 1..];
    let value = match after.chars().next()? {
        quote @ ('"' | '\'') => after[1..].split(quote).next()?,
        _ => after.split_whitespace().next()?,
    };
    let value = decode_entities(value);
    (!value.is_empty()).then_some(value)
}

fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity.to_ascii_lowercase().as_str() {
            "amp" => Some("&".to_string()),
            "lt" => Some("<".to_string()),
            "gt" => Some(">".to_string()),
            "quot" => Some("\"".to_string()),
            "apos" | "#39" => Some("'".to_string()),
            "nbsp" => Some(" ".to_string()),
            other => other
                .strip_prefix('#')
                .and_then(|digits| digits.parse::<u32>().ok())
                .and_then(char::from_u32)
                .map(|c| c.to_string()),
        };
        match decoded {
            Some(text) => {
                out.push_str(&text);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// UTC 秒 → `YYYY-MM-DDTHH:MM:SSZ`（Howard Hinnant 的 civil_from_days，不引第三方时间库）。
fn rfc3339_utc(timestamp: i64) -> String {
    let days = timestamp.div_euclid(86_400);
    let secs = timestamp.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{year:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3_600,
        (secs % 3_600) / 60,
        secs % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_become_utc_rfc3339() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(1_789_200_000), "2026-09-12T08:00:00Z");
    }

    #[test]
    fn an_unclosed_tag_never_leaks_markup() {
        assert!(!html_to_text("<p>ok<script>evil").contains('<'));
    }
}
