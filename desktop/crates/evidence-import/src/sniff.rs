//! 按内容判断这是什么，扩展名只作为佐证（拆分计划决策 4）。
//!
//! 只接受 D09 的 MVP 输入：`.eml`、纯文本、PNG、JPEG、PDF。其余一律 `Unsupported`，
//! 由界面提示用户另存为 `.eml` 或粘贴正文——存进档案的东西必须是能预览的东西。

use crate::{EvidenceKind, ImportError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sniffed {
    pub kind: EvidenceKind,
    pub mime: Option<String>,
}

/// Outlook 的 `.msg` 是 OLE 复合文档，魔数与老 Office 文件相同。
const CFB_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

pub fn sniff(bytes: &[u8], original_filename: Option<&str>) -> Result<Sniffed, ImportError> {
    let ext =
        original_filename.and_then(|name| name.rsplit_once('.').map(|(_, ext)| ext.to_lowercase()));

    if bytes.starts_with(b"%PDF-") {
        return Ok(Sniffed {
            kind: EvidenceKind::Pdf,
            mime: Some("application/pdf".into()),
        });
    }
    if bytes.starts_with(&CFB_MAGIC) || ext.as_deref() == Some("msg") {
        return Err(ImportError::Unsupported {
            mime: Some("application/vnd.ms-outlook".into()),
        });
    }
    if let Some(kind) = infer::get(bytes) {
        return match kind.mime_type() {
            "image/png" | "image/jpeg" => Ok(Sniffed {
                kind: EvidenceKind::Screenshot,
                mime: Some(kind.mime_type().to_string()),
            }),
            "application/pdf" => Ok(Sniffed {
                kind: EvidenceKind::Pdf,
                mime: Some("application/pdf".into()),
            }),
            other => Err(ImportError::Unsupported {
                mime: Some(other.to_string()),
            }),
        };
    }

    // 剩下的只可能是文本。合法 UTF-8 还不够：全是 NUL 的文件也是合法 UTF-8，二进制
    // 内容不该以 text/plain 的名义落进档案。除换行、回车、制表符外的控制字符一律拒绝。
    let text = std::str::from_utf8(bytes).map_err(|_| ImportError::Unsupported { mime: None })?;
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(ImportError::Unsupported { mime: None });
    }
    if looks_like_email(text) {
        return Ok(Sniffed {
            kind: EvidenceKind::Eml,
            mime: Some("message/rfc822".into()),
        });
    }
    Ok(Sniffed {
        kind: EvidenceKind::Unknown,
        mime: Some("text/plain".into()),
    })
}

/// 头部像一封邮件：起手若干行里有 `Name: value` 形式的常见邮件头。
fn looks_like_email(text: &str) -> bool {
    const HEADERS: [&str; 6] = [
        "from:",
        "to:",
        "subject:",
        "date:",
        "message-id:",
        "received:",
    ];
    let mut seen = 0;
    for line in text.lines().take(40) {
        if line.trim().is_empty() {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if HEADERS.iter().any(|h| lower.starts_with(h)) {
            seen += 1;
        }
    }
    seen >= 2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magic_bytes_beat_the_extension() {
        let pdf = b"%PDF-1.7\n1 0 obj\n";
        let sniffed = sniff(pdf, Some("screenshot.png")).unwrap();
        assert_eq!(sniffed.kind, EvidenceKind::Pdf);
        assert_eq!(sniffed.mime.as_deref(), Some("application/pdf"));
    }

    #[test]
    fn png_and_jpeg_are_screenshots() {
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        assert_eq!(sniff(&png, None).unwrap().kind, EvidenceKind::Screenshot);
        let jpeg = [
            0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, b'J', b'F', b'I', b'F', 0, 1,
        ];
        assert_eq!(sniff(&jpeg, None).unwrap().kind, EvidenceKind::Screenshot);
    }

    #[test]
    fn an_outlook_msg_is_refused_with_something_the_ui_can_explain() {
        let msg = [CFB_MAGIC.as_slice(), &[0u8; 32]].concat();
        assert_eq!(
            sniff(&msg, Some("invite.msg")),
            Err(ImportError::Unsupported {
                mime: Some("application/vnd.ms-outlook".into())
            })
        );
        assert!(matches!(
            sniff(b"anything", Some("invite.msg")),
            Err(ImportError::Unsupported { .. })
        ));
    }

    #[test]
    fn headers_make_it_an_email_plain_text_does_not() {
        let eml = "From: a@example.test\r\nSubject: 面试邀请\r\nDate: Fri, 12 Sep 2026 08:00:00 +0000\r\n\r\n正文\r\n";
        assert_eq!(
            sniff(eml.as_bytes(), Some("x.eml")).unwrap().kind,
            EvidenceKind::Eml
        );
        let note = "他们说下周二面试，地点在望京。";
        let sniffed = sniff(note.as_bytes(), Some("note.txt")).unwrap();
        assert_eq!(sniffed.kind, EvidenceKind::Unknown);
        assert_eq!(sniffed.mime.as_deref(), Some("text/plain"));
    }

    #[test]
    fn binary_we_do_not_understand_is_refused_not_stored() {
        let noise = [0x00, 0x01, 0x02, 0xFF, 0xFE, 0x00, 0x99, 0x42];
        assert!(matches!(
            sniff(&noise, Some("x.bin")),
            Err(ImportError::Unsupported { .. })
        ));
    }

    #[test]
    fn valid_utf8_full_of_control_bytes_is_not_plain_text() {
        // 全 NUL 是合法 UTF-8。它不是文本，不该以 text/plain 落进档案。
        assert!(matches!(
            sniff(&[0u8; 64], Some("notes.txt")),
            Err(ImportError::Unsupported { .. })
        ));
        assert!(matches!(
            sniff(b"a\x07b\x1bc", Some("notes.txt")),
            Err(ImportError::Unsupported { .. })
        ));
        // 换行、回车、制表符是文本的一部分，照常收。
        assert_eq!(
            sniff(b"line one\r\n\tline two\n", Some("notes.txt"))
                .unwrap()
                .mime
                .as_deref(),
            Some("text/plain")
        );
    }
}
