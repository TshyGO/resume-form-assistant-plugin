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
    // Inline tracking/signature images without filenames do not become file attachments.
    if part
        .content_disposition()
        .is_some_and(|d| d.c_type.eq_ignore_ascii_case("inline"))
        && part.attachment_name().is_none()
    {
        return None;
    }
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
    let kind = match mime {
        "application/pdf" => "pdf",
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

pub fn list_mail_attachments(bytes: &[u8]) -> Option<Vec<MailAttachment>> {
    let mail = MessageParser::default().parse(bytes)?;
    Some(
        mail.attachments()
            .enumerate()
            .filter_map(|(i, p)| describe(i as u32, p, bytes))
            .collect(),
    )
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
}
