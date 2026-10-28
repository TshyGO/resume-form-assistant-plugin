//! MIME attachments are read from the immutable .eml on demand; no new archive format.
use crate::safe_file_name;
use mail_parser::{Encoding, MessageParser, MimeHeaders, PartType};
use std::borrow::Cow;

#[derive(Debug, Clone)]
pub struct MailAttachment {
    /// Index in mail-parser's attachment list, not a filesystem path.
    pub index: u32,
    pub name: String,
    pub mime: String,
    pub preview_kind: &'static str,
    pub size_bytes: usize,
    pub readable: bool,
    pub can_open: bool,
}

fn exact_contents<'a>(
    part: &'a mail_parser::MessagePart<'_>,
    raw: &'a [u8],
) -> Option<Cow<'a, [u8]>> {
    // mail-parser converts text parts to UTF-8 for reading. Files must instead keep
    // their original charset bytes after transfer decoding (including .txt/.html).
    if matches!(part.body, PartType::Text(_) | PartType::Html(_)) {
        let encoded = raw.get(part.offset_body as usize..part.offset_end as usize)?;
        match part.encoding {
            Encoding::Base64 => {
                mail_parser::decoders::base64::base64_decode(encoded).map(Cow::Owned)
            }
            Encoding::QuotedPrintable => {
                mail_parser::decoders::quoted_printable::quoted_printable_decode(encoded)
                    .map(Cow::Owned)
            }
            Encoding::None => Some(Cow::Borrowed(encoded)),
        }
    } else {
        Some(Cow::Borrowed(part.contents()))
    }
}
fn describe(index: u32, part: &mail_parser::MessagePart<'_>, raw: &[u8]) -> Option<MailAttachment> {
    let mut name = part
        .attachment_name()
        .map(|n| safe_file_name(Some(n)))
        .unwrap_or_else(|| format!("附件-{}", index + 1));
    let content = exact_contents(part, raw);
    let bytes = content.as_deref().unwrap_or_default();
    let inferred = infer::get(bytes)
        .map(|k| k.mime_type())
        .unwrap_or("application/octet-stream");
    let mime = if bytes.starts_with(b"%PDF-") {
        "application/pdf"
    } else {
        inferred
    };
    let mime = if name.to_ascii_lowercase().ends_with(".xlsx") && bytes.starts_with(b"PK\x03\x04") {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    } else {
        mime
    };
    let kind = match mime {
        "application/pdf" => "pdf",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" => "image",
        _ => "file",
    };
    if part.attachment_name().is_none() {
        let ext = match mime {
            "application/pdf" => Some("pdf"),
            "image/png" => Some("png"),
            "image/jpeg" => Some("jpg"),
            "image/gif" => Some("gif"),
            "image/webp" => Some("webp"),
            _ => None,
        };
        if let Some(ext) = ext {
            name.push('.');
            name.push_str(ext);
        }
    }
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let can_open = ![
        "exe", "com", "bat", "cmd", "ps1", "sh", "command", "app", "lnk", "url", "webloc", "scpt",
        "jar", "msi", "dmg", "pkg", "js", "vbs", "hta", "desktop",
    ]
    .contains(&extension.as_str());
    Some(MailAttachment {
        index,
        name,
        mime: mime.into(),
        preview_kind: kind,
        size_bytes: bytes.len(),
        readable: !part.is_encoding_problem && content.is_some(),
        can_open,
    })
}

#[derive(Debug, Clone)]
pub enum MailBodyBlock {
    Text(String),
    Image(MailAttachment),
}
#[derive(Debug, Clone)]
pub struct MailContent {
    pub attachments: Vec<MailAttachment>,
    pub body: Vec<MailBodyBlock>,
}
pub fn mail_content(bytes: &[u8]) -> Option<MailContent> {
    let mail = MessageParser::default().parse(bytes)?;
    let parts: Vec<_> = mail.attachments().collect();
    // Only actual body HTML participates; an HTML file attachment never defines inline images.
    let html = mail.html_bodies().find_map(|p| match &p.body {
        PartType::Html(html) => Some(html.as_ref()),
        _ => None,
    });
    let mut referenced = std::collections::BTreeSet::new();
    let mut body = Vec::new();
    if let Some(html) = html {
        for fragment in crate::mail_body::html_fragments(html) {
            match fragment {
                crate::mail_body::BodyFragment::Text(text) => body.push(MailBodyBlock::Text(text)),
                crate::mail_body::BodyFragment::Cid(cid) => {
                    let matching: Vec<_> = parts
                        .iter()
                        .enumerate()
                        .filter(|(_, p)| {
                            p.content_id()
                                .is_some_and(|id| id.trim_matches(['<', '>']) == cid)
                        })
                        .collect();
                    if matching.len() == 1 {
                        let (index, part) = matching[0];
                        if let Some(info) = describe(index as u32, part, bytes)
                            .filter(|i| i.preview_kind == "image")
                        {
                            referenced.insert(index);
                            body.push(MailBodyBlock::Image(info));
                            continue;
                        }
                    }
                    body.push(MailBodyBlock::Text("（正文图片无法读取）".into()));
                }
            }
        }
    }
    // Keep the existing text view when there are no resolvable local body images.
    if !body.iter().any(|b| matches!(b, MailBodyBlock::Image(_))) {
        body.clear();
    }
    let attachments = parts
        .iter()
        .enumerate()
        .filter_map(|(index, part)| {
            let disposition = part.content_disposition();
            let explicit_attachment =
                disposition.is_some_and(|d| d.c_type.eq_ignore_ascii_case("attachment"));
            if referenced.contains(&index) && !explicit_attachment {
                return None;
            }
            if disposition.is_some_and(|d| d.c_type.eq_ignore_ascii_case("inline"))
                && part.attachment_name().is_none()
                && !explicit_attachment
            {
                return None;
            }
            describe(index as u32, part, bytes)
        })
        .collect();
    Some(MailContent { attachments, body })
}
pub fn list_mail_attachments(bytes: &[u8]) -> Option<Vec<MailAttachment>> {
    Some(mail_content(bytes)?.attachments)
}

pub fn read_mail_attachment(bytes: &[u8], index: u32) -> Option<(MailAttachment, Vec<u8>)> {
    let mail = MessageParser::default().parse(bytes)?;
    let part = mail.attachment(index)?;
    let info = describe(index, part, bytes)?;
    if !info.readable {
        return None;
    }
    Some((info, exact_contents(part, bytes)?.into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn mail(parts: &str) -> Vec<u8> {
        format!("From: hr@example.test\r\nSubject: Attachments\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nBody\r\n{parts}--x--\r\n").into_bytes()
    }
    fn pdf(name: &str) -> String {
        format!("--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"{name}\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n")
    }
    #[test]
    fn decodes_exact_bytes_and_preserves_two_attachments_with_the_same_name() {
        let bytes = mail(&(pdf("same.pdf") + &pdf("same.pdf")));
        let list = list_mail_attachments(&bytes).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].index, 0);
        assert_eq!(list[1].index, 1);
        assert_eq!(list[0].name, list[1].name);
        let (item, content) = read_mail_attachment(&bytes, 1).unwrap();
        assert_eq!(content, b"%PDF-1.4\n");
        assert_eq!(item.preview_kind, "pdf");
    }
    #[test]
    fn unsafe_paths_cannot_become_extraction_paths() {
        let bytes = mail(&pdf("../../secret.pdf"));
        let list = list_mail_attachments(&bytes).unwrap();
        assert_eq!(list[0].name, "secret.pdf");
        assert!(!list[0].name.contains('/'));
    }
    #[test]
    fn filename_does_not_decide_preview_type() {
        let bytes=mail("--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"fake.pdf\"\r\n\r\n<html>active content</html>\r\n");
        assert_eq!(
            list_mail_attachments(&bytes).unwrap()[0].preview_kind,
            "file"
        );
    }
    #[test]
    fn inline_signature_without_a_filename_is_not_a_file_attachment() {
        let bytes=mail("--x\r\nContent-Type: image/png\r\nContent-ID: <signature>\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n");
        assert!(list_mail_attachments(&bytes).unwrap().is_empty());
    }
    #[test]
    fn dangerous_external_launch_types_are_saved_as_files_without_automatic_open() {
        let bytes = mail(&pdf("invoice.pdf.exe"));
        let item = &list_mail_attachments(&bytes).unwrap()[0];
        assert!(!item.can_open);
    }
    #[test]
    fn missing_part_index_never_falls_back_to_another_attachment() {
        assert!(read_mail_attachment(&mail(&pdf("one.pdf")), 9).is_none());
    }
    #[test]
    fn exported_text_files_keep_original_charset_bytes_instead_of_utf8_conversion() {
        for (encoding, encoded, expected) in [
            ("quoted-printable", "=E9", 0xe9u8),
            ("base64", "/w==", 0xffu8),
        ] {
            let bytes = mail(&format!("--x\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Disposition: attachment; filename=\"notes.txt\"\r\nContent-Transfer-Encoding: {encoding}\r\n\r\n{encoded}\r\n"));
            let (item, decoded) = read_mail_attachment(&bytes, 0).unwrap();
            assert_eq!(decoded, vec![expected]);
            assert_eq!(item.size_bytes, 1);
        }
    }
    #[test]
    fn referenced_named_body_photo_is_separate_from_an_identical_explicit_attachment() {
        let bytes = mail("--x\r\nContent-Type: text/html\r\n\r\n<div>Before</div><img src='cid:photo'><p>After</p>\r\n--x\r\nContent-Type: image/png; name=photo.png\r\nContent-ID: <photo>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--x\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=photo.png\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n");
        let content = mail_content(&bytes).unwrap();
        assert_eq!(content.attachments.len(), 1);
        let images: Vec<_> = content
            .body
            .iter()
            .filter_map(|b| {
                if let MailBodyBlock::Image(i) = b {
                    Some(i)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(images.len(), 1);
        assert_ne!(images[0].index, content.attachments[0].index);
        let (_, body_bytes) = read_mail_attachment(&bytes, images[0].index).unwrap();
        let (_, file_bytes) = read_mail_attachment(&bytes, content.attachments[0].index).unwrap();
        assert_eq!(body_bytes, file_bytes);
        assert!(matches!(&content.body[0], MailBodyBlock::Text(t) if t.contains("Before")));
        assert!(matches!(&content.body[2], MailBodyBlock::Text(t) if t.contains("After")));
    }
    #[test]
    fn cid_alone_does_not_hide_a_real_attachment_and_remote_images_are_not_fetched() {
        let bytes = mail("--x\r\nContent-Type: text/html\r\n\r\n<img src='https://remote.test/track'>\r\n--x\r\nContent-Type: image/png; name=photo.png\r\nContent-ID: <photo>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n");
        let content = mail_content(&bytes).unwrap();
        assert!(content.body.is_empty());
        assert_eq!(content.attachments.len(), 1);
    }
    #[test]
    fn a_referenced_inline_image_without_a_filename_can_still_be_read_in_the_body() {
        let bytes = mail("--x\r\nContent-Type: text/html\r\n\r\n<img src='cid:photo'>\r\n--x\r\nContent-Type: image/png\r\nContent-ID: <photo>\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n");
        let content = mail_content(&bytes).unwrap();
        assert!(content.attachments.is_empty());
        let MailBodyBlock::Image(i) = &content.body[0] else {
            panic!("missing image");
        };
        assert!(read_mail_attachment(&bytes, i.index).is_some());
    }
}
