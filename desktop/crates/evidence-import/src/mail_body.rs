//! Only plain text and references to local MIME images leave this module, never HTML.
use crate::html_to_text;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodyFragment {
    Text(String),
    Cid(String),
}

// A small conservative tag scanner: quoted '>' and comments must not create image tags.
fn tag_end(input: &str) -> Option<usize> {
    let mut quote = None;
    for (i, c) in input.char_indices() {
        match (quote, c) {
            (Some(q), c) if q == c => quote = None,
            (None, '\'' | '"') => quote = Some(c),
            (None, '>') => return Some(i),
            _ => {}
        }
    }
    None
}
fn src_attribute(tag: &str) -> Option<String> {
    let mut rest = tag.trim_start();
    rest = &rest[rest.find(char::is_whitespace).unwrap_or(rest.len())..];
    while !rest.trim().is_empty() {
        rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '/');
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '=')
            .unwrap_or(rest.len());
        let name = &rest[..end];
        rest = rest[end..].trim_start();
        if !rest.starts_with('=') {
            continue;
        }
        rest = rest[1..].trim_start();
        let (value, tail) = match rest.chars().next()? {
            quote @ ('\'' | '"') => {
                let end = rest[1..].find(quote)? + 1;
                (&rest[1..end], &rest[end + 1..])
            }
            _ => {
                let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
                (&rest[..end], &rest[end..])
            }
        };
        if name.eq_ignore_ascii_case("src") {
            // Decode entities through the existing text conversion without treating values as markup.
            return Some(crate::eml::decode_entities(value));
        }
        rest = tail;
    }
    None
}
/// Preserve text/image order, ignore remote images and scripts. Bound work before reading images.
pub fn html_fragments(html: &str) -> Vec<BodyFragment> {
    let mut end = html.len().min(1024 * 1024);
    while !html.is_char_boundary(end) {
        end -= 1;
    }
    let input_truncated = end < html.len();
    let html = &html[..end];
    let lower_html = html.to_ascii_lowercase();
    let mut fragments = Vec::new();
    let mut markup = String::new();
    let mut rest = html;
    let mut image_count = 0;
    let mut text_left = crate::MAX_BODY_EXTRACT;
    let push_text = |markup: &mut String, fragments: &mut Vec<BodyFragment>, left: &mut usize| {
        let text = html_to_text(markup);
        markup.clear();
        let mut end = text.len().min(*left);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        if end > 0 {
            fragments.push(BodyFragment::Text(text[..end].to_string()));
        }
        *left -= end;
    };
    while let Some(at) = rest.find('<') {
        markup.push_str(&rest[..at]);
        rest = &rest[at..];
        if rest.starts_with("<!--") {
            let Some(end) = rest.find("-->") else {
                break;
            };
            rest = &rest[end + 3..];
            continue;
        }
        let Some(end) = tag_end(rest) else {
            break;
        };
        let tag = &rest[1..end];
        let name = tag
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("");
        if ["script", "style", "head", "template"]
            .iter()
            .any(|n| name.eq_ignore_ascii_case(n))
        {
            let closing = format!("</{}", name.to_ascii_lowercase());
            rest = &rest[end + 1..];
            let offset = html.len() - rest.len();
            let Some(close) = lower_html[offset..].find(&closing) else {
                break;
            };
            let Some(end) = tag_end(&rest[close..]) else {
                break;
            };
            rest = &rest[close + end + 1..];
            continue;
        }
        if name.eq_ignore_ascii_case("img") {
            if let Some(src) = src_attribute(tag) {
                if src.get(..4).is_some_and(|s| s.eq_ignore_ascii_case("cid:")) {
                    let cid = src[4..].trim().trim_matches(['<', '>']);
                    if !cid.is_empty() && cid.len() <= 998 && image_count < 16 {
                        push_text(&mut markup, &mut fragments, &mut text_left);
                        fragments.push(BodyFragment::Cid(cid.into()));
                        image_count += 1;
                    }
                }
            }
            // No remote URL, SVG, event handler, style or markup is ever returned.
        } else {
            markup.push_str(&rest[..end + 1]);
        }
        rest = &rest[end + 1..];
        if text_left == 0 {
            break;
        }
    }
    if text_left > 0 {
        markup.push_str(rest);
    }
    push_text(&mut markup, &mut fragments, &mut text_left);
    if text_left == 0 || input_truncated {
        fragments.push(BodyFragment::Text("（正文已截断）".into()));
    }
    fragments
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_real_cid_image_tags_become_local_references_in_order() {
        let html = "<div>Before</div><!-- <img src='cid:comment'> --><script><img src='cid:script'></script><img data-src='cid:wrong' title='a > b' SRC = 'CID:photo&#64;mail'><p>After</p><img src='https://remote.test/track'>";
        let blocks = html_fragments(html);
        assert_eq!(
            blocks
                .iter()
                .filter_map(|b| if let BodyFragment::Cid(s) = b {
                    Some(s.as_str())
                } else {
                    None
                })
                .collect::<Vec<_>>(),
            vec!["photo@mail"]
        );
        assert!(matches!(&blocks[0], BodyFragment::Text(s) if s.contains("Before")));
        assert!(matches!(&blocks[2], BodyFragment::Text(s) if s.contains("After")));
    }
}
