//! No attachment paths cross the WebView boundary. Every read verifies the parent original.
use crate::commands::CommandError;
use crate::{archive_worker, with_store};
use archive_store::{ArchiveStore, EvidenceKind};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

fn fail(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSummary {
    pub index: u32,
    pub name: String,
    pub mime: String,
    pub size_bytes: usize,
    pub preview_kind: String,
    pub readable: bool,
    pub can_open: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentList {
    pub source_sha256: String,
    pub items: Vec<AttachmentSummary>,
    pub body_blocks: Vec<BodyBlock>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BodyBlock {
    Text { text: String },
    Image { attachment: AttachmentSummary },
}
fn summary(item: &evidence_import::MailAttachment) -> AttachmentSummary {
    AttachmentSummary {
        index: item.index,
        name: item.name.clone(),
        mime: item.mime.clone(),
        size_bytes: item.size_bytes,
        preview_kind: item.preview_kind.into(),
        readable: item.readable,
        can_open: item.can_open,
    }
}
fn original(
    store: &ArchiveStore,
    id: &str,
    expected: Option<&str>,
) -> Result<(String, Vec<u8>), CommandError> {
    let evidence = store
        .get_evidence(id)?
        .ok_or_else(|| fail("NOT_FOUND", "找不到这封邮件，请重新选择。"))?;
    if evidence.kind != EvidenceKind::Eml {
        return Err(fail("NOT_MAIL", "这条材料没有邮件附件。"));
    }
    let digest = evidence.blob.meta.sha256;
    if expected.is_some_and(|e| e != digest) {
        return Err(fail(
            "ATTACHMENT_CHANGED",
            "邮件原件已变化，请关闭附件窗口后重新打开。",
        ));
    }
    let path = crate::evidence_commands::stored_path(store, id)?;
    let (bytes, _) = evidence_import::read_source(&path)
        .map_err(|_| fail("ATTACHMENT_UNREADABLE", "读不到邮件原件，请检查本机文件。"))?;
    if format!("{:x}", Sha256::digest(&bytes)) != digest {
        return Err(fail(
            "ATTACHMENT_CHANGED",
            "邮件原件校验失败，无法读取附件。",
        ));
    }
    Ok((digest, bytes))
}
pub fn list(store: &ArchiveStore, id: &str) -> Result<AttachmentList, CommandError> {
    let (source_sha256, bytes) = original(store, id, None)?;
    let content = evidence_import::mail_content(&bytes)
        .ok_or_else(|| fail("MAIL_INVALID", "这封邮件的附件信息读不出来。"))?;
    Ok(AttachmentList {
        source_sha256,
        items: content.attachments.iter().map(summary).collect(),
        body_blocks: content
            .body
            .iter()
            .map(|b| match b {
                evidence_import::MailBodyBlock::Text(text) => {
                    BodyBlock::Text { text: text.clone() }
                }
                evidence_import::MailBodyBlock::Image(item) => BodyBlock::Image {
                    attachment: summary(item),
                },
            })
            .collect(),
    })
}
pub fn read(
    store: &ArchiveStore,
    id: &str,
    index: u32,
    digest: &str,
) -> Result<(AttachmentSummary, Vec<u8>), CommandError> {
    let (_, bytes) = original(store, id, Some(digest))?;
    let (item, content) =
        evidence_import::read_mail_attachment(&bytes, index).ok_or_else(|| {
            fail(
                "ATTACHMENT_UNREADABLE",
                "这份附件读不出来，请尝试用系统程序打开邮件原件。",
            )
        })?;
    Ok((summary(&item), content))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPreview {
    pub bytes_base64: String,
    pub mime: String,
}
pub fn preview(
    store: &ArchiveStore,
    id: &str,
    index: u32,
    digest: &str,
) -> Result<AttachmentPreview, CommandError> {
    let (item, bytes) = read(store, id, index, digest)?;
    if !["pdf", "image"].contains(&item.preview_kind.as_str()) {
        return Err(fail("NO_PREVIEW", "这种文件可另存为或用系统程序打开。"));
    }
    if item.preview_kind == "image" && bytes.len() > 8 * 1024 * 1024 {
        return Err(fail(
            "NO_PREVIEW",
            "图片超过预览大小上限，可另存为或用系统程序打开。",
        ));
    }
    Ok(AttachmentPreview {
        bytes_base64: crate::evidence_commands::base64(&bytes),
        mime: item.mime,
    })
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetPreview {
    pub sheet_names: Vec<String>,
    pub sheet_index: usize,
    pub cells: Vec<(u32, u32, String)>,
    pub row_count: u32,
    pub column_count: u32,
    pub truncated: bool,
}
pub fn spreadsheet(
    store: &ArchiveStore,
    id: &str,
    index: u32,
    digest: &str,
    sheet_index: usize,
) -> Result<SpreadsheetPreview, CommandError> {
    let (item, bytes) = read(store, id, index, digest)?;
    if item.preview_kind != "xlsx" {
        return Err(fail("NO_PREVIEW", "这份附件不是可预览的 XLSX 表格。"));
    }
    let view = resume_sheet::preview_xlsx(&bytes, sheet_index).map_err(|_| {
        fail(
            "NO_PREVIEW",
            "这份表格暂时无法预览，可能已加密、损坏或超过大小上限。可另存为或用系统程序打开。",
        )
    })?;
    Ok(SpreadsheetPreview {
        sheet_names: view.sheet_names,
        sheet_index: view.sheet_index,
        cells: view.cells,
        row_count: view.row_count,
        column_count: view.column_count,
        truncated: view.truncated,
    })
}
/// A unique private directory keeps duplicate names separate and never writes beside the original.
pub fn stage_open(
    cache: &Path,
    item: &AttachmentSummary,
    bytes: &[u8],
) -> Result<(tempfile::TempDir, PathBuf), CommandError> {
    if !item.can_open {
        return Err(fail("NO_EXTERNAL_OPEN", "这种附件请先另存为后处理。"));
    }
    std::fs::create_dir_all(cache)
        .map_err(|_| fail("ATTACHMENT_WRITE", "无法创建附件临时副本。"))?;
    let dir = tempfile::Builder::new()
        .prefix("mail-attachment-")
        .tempdir_in(cache)
        .map_err(|_| fail("ATTACHMENT_WRITE", "无法创建附件临时副本。"))?;
    let path = dir
        .path()
        .join(evidence_import::safe_file_name(Some(&item.name)));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|_| fail("ATTACHMENT_WRITE", "无法写入附件临时副本。"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| fail("ATTACHMENT_WRITE", "无法写入附件临时副本。"))?;
    Ok((dir, path))
}
pub fn save_copy(
    store: &ArchiveStore,
    destination: &Path,
    bytes: &[u8],
) -> Result<(), CommandError> {
    let parent = destination
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .ok_or_else(|| fail("ATTACHMENT_WRITE", "保存位置不可用，请重新选择。"))?;
    let root = store
        .archive_dir()
        .canonicalize()
        .map_err(|_| fail("ATTACHMENT_WRITE", "档案目录不可用。"))?;
    if parent.starts_with(root) {
        return Err(fail(
            "ATTACHMENT_WRITE",
            "请选择档案目录以外的位置保存附件副本。",
        ));
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| fail("ATTACHMENT_WRITE", "无法保存附件，请检查目标目录权限。"))?;
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| fail("ATTACHMENT_WRITE", "附件写入失败，请重试。"))?;
    temp.persist(destination)
        .map_err(|_| fail("ATTACHMENT_WRITE", "无法完成附件保存，请检查目标文件。"))?;
    Ok(())
}

#[tauri::command]
pub async fn list_evidence_attachments_cmd(
    app: tauri::AppHandle,
    evidence_id: String,
) -> Result<self::AttachmentList, CommandError> {
    archive_worker(app, move |state| {
        with_store(state, |store| self::list(store, &evidence_id))
    })
    .await
}
#[tauri::command]
pub async fn preview_evidence_attachment_cmd(
    app: tauri::AppHandle,
    evidence_id: String,
    index: u32,
    source_sha256: String,
) -> Result<self::AttachmentPreview, CommandError> {
    archive_worker(app, move |state| {
        with_store(state, |store| {
            self::preview(store, &evidence_id, index, &source_sha256)
        })
    })
    .await
}
#[tauri::command]
pub async fn preview_evidence_spreadsheet_cmd(
    app: tauri::AppHandle,
    evidence_id: String,
    index: u32,
    source_sha256: String,
    sheet_index: usize,
) -> Result<self::SpreadsheetPreview, CommandError> {
    archive_worker(app, move |state| {
        with_store(state, |store| {
            self::spreadsheet(store, &evidence_id, index, &source_sha256, sheet_index)
        })
    })
    .await
}
#[tauri::command]
pub async fn open_evidence_attachment_cmd(
    app: tauri::AppHandle,
    evidence_id: String,
    index: u32,
    source_sha256: String,
) -> Result<(), CommandError> {
    let opener = app.clone();
    archive_worker(app, move |state| {
        let (item, bytes) = with_store(state, |store| {
            self::read(store, &evidence_id, index, &source_sha256)
        })?;
        let cache = state
            .paths
            .lock()
            .ok()
            .and_then(|p| p.as_ref().map(|p| p.cache_dir.clone()))
            .ok_or_else(|| CommandError {
                code: "ATTACHMENT_WRITE".into(),
                message: "无法定位附件缓存目录。".into(),
            })?;
        let (dir, path) = self::stage_open(&cache.join("opened-mail-attachments"), &item, &bytes)?;
        tauri_plugin_opener::OpenerExt::opener(&opener)
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|_| CommandError {
                code: "OPEN_FAILED".into(),
                message: "系统未能打开这份附件，请另存为后选择合适的软件。".into(),
            })?;
        // The OS application loads asynchronously; keep this private cached copy.
        state
            .opened_attachments
            .lock()
            .map_err(|_| CommandError {
                code: "ATTACHMENT_WRITE".into(),
                message: "附件副本暂存失败。".into(),
            })?
            .push(dir);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn save_evidence_attachment_cmd(
    app: tauri::AppHandle,
    evidence_id: String,
    index: u32,
    source_sha256: String,
) -> Result<bool, CommandError> {
    let picker = app.clone();
    archive_worker(app, move |state| {
        let (item, _) = with_store(state, |store| {
            self::read(store, &evidence_id, index, &source_sha256)
        })?;
        use tauri_plugin_dialog::DialogExt;
        let Some(path) = picker
            .dialog()
            .file()
            .set_file_name(&item.name)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let destination = path.into_path().map_err(|_| CommandError {
            code: "ATTACHMENT_WRITE".into(),
            message: "请选择本机文件保存位置。".into(),
        })?;
        // The chooser does not hold the archive lock. Re-read after it returns so a
        // restore or another selection cannot save bytes under stale attachment metadata.
        with_store(state, |store| {
            let (_, bytes) = self::read(store, &evidence_id, index, &source_sha256)?;
            self::save_copy(store, &destination, &bytes)
        })?;
        Ok(true)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, ArchiveStore, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::commands::open_store(
            &dir.path().join("archive"),
            &dir.path().join("current.json"),
        )
        .unwrap();
        let bytes=b"From: hr@example.test\r\nSubject: Test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nBody\r\n--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"test.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--x--\r\n";
        let (e, _) = crate::evidence_commands::import_bytes(
            &store,
            store.archive_dir(),
            bytes,
            Some("sample.eml".into()),
            "2026/10",
            None,
        )
        .unwrap();
        (dir, store, e.id)
    }
    #[test]
    fn old_eml_attachments_are_read_on_demand_without_changing_the_archive() {
        let (_dir, store, id) = setup();
        let list = list(&store, &id).unwrap();
        assert_eq!(list.items.len(), 1);
        let (item, content) = read(&store, &id, 0, &list.source_sha256).unwrap();
        assert_eq!(item.name, "test.pdf");
        assert_eq!(content, b"%PDF-1.4\n");
        let view = preview(&store, &id, 0, &list.source_sha256).unwrap();
        assert_eq!(view.mime, "application/pdf");
        assert_eq!(view.bytes_base64, "JVBERi0xLjQK");
        assert_eq!(store.list_evidence(None).unwrap().len(), 1);
    }
    #[test]
    fn stale_digest_and_corrupt_parent_original_are_rejected() {
        let (_dir, store, id) = setup();
        let list = list(&store, &id).unwrap();
        assert_eq!(
            read(&store, &id, 0, &"a".repeat(64)).unwrap_err().code,
            "ATTACHMENT_CHANGED"
        );
        let path = crate::evidence_commands::stored_path(&store, &id).unwrap();
        std::fs::write(path, b"changed").unwrap();
        assert_eq!(
            read(&store, &id, 0, &list.source_sha256).unwrap_err().code,
            "ATTACHMENT_CHANGED"
        );
    }
    #[test]
    fn separate_system_open_copies_keep_names_and_content_without_colliding() {
        let (dir, store, id) = setup();
        let list = list(&store, &id).unwrap();
        let (item, bytes) = read(&store, &id, 0, &list.source_sha256).unwrap();
        let (first, p1) = stage_open(&dir.path().join("cache"), &item, &bytes).unwrap();
        let (_second, p2) = stage_open(&dir.path().join("cache"), &item, &bytes).unwrap();
        assert_ne!(p1, p2);
        assert_eq!(p1.file_name().unwrap(), "test.pdf");
        assert_eq!(std::fs::read(&p1).unwrap(), bytes);
        drop(first);
        assert!(!p1.exists());
        assert!(p2.exists());
    }
    #[test]
    fn save_as_is_an_exact_copy_and_cannot_overwrite_the_archive() {
        let (dir, store, id) = setup();
        let list = list(&store, &id).unwrap();
        let (_, bytes) = read(&store, &id, 0, &list.source_sha256).unwrap();
        let dest = dir.path().join("selected.pdf");
        save_copy(&store, &dest, &bytes).unwrap();
        assert_eq!(std::fs::read(dest).unwrap(), bytes);
        assert!(save_copy(&store, &store.archive_dir().join("archive.db"), &bytes).is_err());
    }
    #[test]
    fn part_index_is_checked_and_unknown_evidence_does_not_read_a_path() {
        let (_dir, store, id) = setup();
        let list = list(&store, &id).unwrap();
        assert!(read(&store, &id, 99, &list.source_sha256).is_err());
        assert!(super::list(&store, "../sample.eml").is_err());
    }
    #[test]
    fn body_photos_and_spreadsheet_preview_read_existing_original_without_reimport() {
        let (_dir, store, _) = setup();
        let xlsx = resume_sheet::write_xlsx(&[resume_sheet::Group {
            name: "Group".into(),
            fields: vec![resume_sheet::Field {
                key: "Field".into(),
                value: "Value".into(),
            }],
        }])
        .unwrap();
        let encoded = crate::evidence_commands::base64(&xlsx);
        let raw = format!("From: hr@example.test\r\nSubject: Inline and XLSX\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/html\r\n\r\n<p>Before</p><img src='cid:photo'><p>After</p>\r\n--x\r\nContent-Type: image/png; name=photo.png\r\nContent-ID: <photo>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--x\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=photo.png\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=schedule.xlsx\r\nContent-Transfer-Encoding: base64\r\n\r\n{encoded}\r\n--x--\r\n").into_bytes();
        let (e, _) = crate::evidence_commands::import_bytes(
            &store,
            store.archive_dir(),
            &raw,
            Some("inline.eml".into()),
            "2026/10",
            None,
        )
        .unwrap();
        let content = list(&store, &e.id).unwrap();
        assert_eq!(content.items.len(), 2);
        let body_images: Vec<_> = content
            .body_blocks
            .iter()
            .filter_map(|b| {
                if let BodyBlock::Image { attachment } = b {
                    Some(attachment)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(body_images.len(), 1);
        assert_eq!(
            preview(&store, &e.id, body_images[0].index, &content.source_sha256)
                .unwrap()
                .mime,
            "image/png"
        );
        let sheet = content
            .items
            .iter()
            .find(|i| i.preview_kind == "xlsx")
            .unwrap();
        let view = spreadsheet(&store, &e.id, sheet.index, &content.source_sha256, 0).unwrap();
        assert_eq!(view.sheet_names, ["简历模板"]);
        assert!(view.cells.iter().any(|(_, _, text)| text == "Value"));
        assert!(spreadsheet(&store, &e.id, sheet.index, &"0".repeat(64), 0).is_err());
        assert!(spreadsheet(&store, &e.id, sheet.index, &content.source_sha256, 99).is_err());
        assert_eq!(
            std::fs::read(crate::evidence_commands::stored_path(&store, &e.id).unwrap()).unwrap(),
            raw
        );
    }
}
