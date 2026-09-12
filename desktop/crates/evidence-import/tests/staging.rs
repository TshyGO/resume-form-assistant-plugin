//! D09 PR 1：一个本机文件变成档案里一份受控副本，或者干脆不变成任何东西。

use std::fs;
use std::path::{Path, PathBuf};

use evidence_import::{stage_file, stage_text, EvidenceKind, ImportError, MAX_ATTACHMENT_BYTES};

const BUCKET: &str = "2026/09";

fn archive() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("archive");
    fs::create_dir_all(archive.join("attachments")).unwrap();
    (dir, archive)
}

fn nothing_staged(_sha: &str) -> Option<String> {
    None
}

fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).unwrap();
    path
}

fn eml(subject: &str) -> Vec<u8> {
    format!("From: hr@example.test\r\nSubject: {subject}\r\nDate: Fri, 12 Sep 2026 08:00:00 +0000\r\n\r\n正文\r\n")
        .into_bytes()
}

#[test]
fn a_file_lands_inside_attachments_with_its_digest_and_size() {
    let (dir, archive) = archive();
    let source = write(dir.path(), "面试邀请.eml", &eml("面试邀请"));

    let staged = stage_file(&archive, &source, BUCKET, &nothing_staged).unwrap();

    assert_eq!(staged.kind, EvidenceKind::Eml);
    assert_eq!(staged.mime.as_deref(), Some("message/rfc822"));
    assert_eq!(staged.original_filename.as_deref(), Some("面试邀请.eml"));
    assert!(!staged.deduplicated);
    assert!(staged.stored_rel_path.starts_with("attachments/2026/09/"));
    assert!(!staged.stored_rel_path.contains('\\'));

    let file = archive.join(&staged.stored_rel_path);
    assert_eq!(fs::read(&file).unwrap(), eml("面试邀请"));
    assert_eq!(staged.size_bytes as usize, eml("面试邀请").len());
    assert_eq!(staged.sha256.len(), 64);
    assert!(staged
        .sha256
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));

    // 没有临时文件留下。
    let leftovers: Vec<_> = fs::read_dir(archive.join("attachments").join("2026").join("09"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn a_hostile_name_cannot_escape_the_attachments_directory() {
    let (dir, archive) = archive();
    for (name, bytes) in [
        ("evil.eml", eml("a")),
        ("also-evil.eml", eml("b")),
        ("third.eml", eml("c")),
    ] {
        let source = write(dir.path(), name, &bytes);
        // 原始文件名由调用方给，可能来自任何地方，这里直接喂敌意的。
        let staged = stage_file(&archive, &source, BUCKET, &nothing_staged).unwrap();
        let file = archive
            .join(&staged.stored_rel_path)
            .canonicalize()
            .unwrap();
        let root = archive.join("attachments").canonicalize().unwrap();
        assert!(file.starts_with(&root), "{file:?}");
    }
}

#[test]
fn the_same_name_twice_does_not_overwrite_the_first_copy() {
    let (dir, archive) = archive();
    let first = write(dir.path(), "reply.eml", &eml("first"));
    let a = stage_file(&archive, &first, BUCKET, &nothing_staged).unwrap();

    let second = write(dir.path(), "reply.eml", &eml("second"));
    let b = stage_file(&archive, &second, BUCKET, &nothing_staged).unwrap();

    assert_ne!(a.stored_rel_path, b.stored_rel_path);
    assert_eq!(
        fs::read(archive.join(&a.stored_rel_path)).unwrap(),
        eml("first")
    );
    assert_eq!(
        fs::read(archive.join(&b.stored_rel_path)).unwrap(),
        eml("second")
    );
}

#[test]
fn the_same_bytes_twice_reuse_the_first_file() {
    let (dir, archive) = archive();
    let source = write(dir.path(), "reply.eml", &eml("same"));
    let first = stage_file(&archive, &source, BUCKET, &nothing_staged).unwrap();

    let known = first.stored_rel_path.clone();
    let sha = first.sha256.clone();
    let existing = move |candidate: &str| (candidate == sha).then(|| known.clone());
    let again = stage_file(&archive, &source, BUCKET, &existing).unwrap();

    assert!(again.deduplicated);
    assert_eq!(again.stored_rel_path, first.stored_rel_path);
    let files: Vec<_> = fs::read_dir(archive.join("attachments").join("2026").join("09"))
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(files.len(), 1, "the bytes are stored once");
}

#[test]
fn pasted_text_becomes_a_text_file_of_its_own() {
    let (_dir, archive) = archive();
    let staged = stage_text(&archive, "他们说下周二面试。", BUCKET, &nothing_staged).unwrap();
    assert_eq!(staged.kind, EvidenceKind::Paste);
    assert_eq!(staged.mime.as_deref(), Some("text/plain"));
    assert!(staged.stored_rel_path.ends_with(".txt"));
    assert_eq!(
        fs::read_to_string(archive.join(&staged.stored_rel_path)).unwrap(),
        "他们说下周二面试。"
    );
}

#[test]
fn a_file_over_the_cap_is_refused_before_anything_is_written() {
    let (dir, archive) = archive();
    let big = vec![b'a'; (MAX_ATTACHMENT_BYTES + 1) as usize];
    let source = write(dir.path(), "huge.txt", &big);

    let err = stage_file(&archive, &source, BUCKET, &nothing_staged).unwrap_err();
    assert!(matches!(err, ImportError::TooLarge { .. }), "{err:?}");
    assert_eq!(err.code(), "too_large");
    assert!(!archive.join("attachments").join("2026").exists());
}

#[test]
fn a_source_that_is_not_there_is_reported_without_naming_the_path() {
    let (dir, archive) = archive();
    let missing = dir.path().join("secret-folder").join("gone.eml");
    let err = stage_file(&archive, &missing, BUCKET, &nothing_staged).unwrap_err();
    assert_eq!(err, ImportError::SourceUnreadable);
    assert!(!format!("{err:?}").contains("secret-folder"));
}

#[test]
fn an_unsupported_file_is_refused_and_leaves_nothing_behind() {
    let (dir, archive) = archive();
    let source = write(
        dir.path(),
        "invite.msg",
        b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1 padding",
    );
    let err = stage_file(&archive, &source, BUCKET, &nothing_staged).unwrap_err();
    assert!(matches!(err, ImportError::Unsupported { .. }), "{err:?}");
    assert!(!archive.join("attachments").join("2026").exists());
}

#[test]
fn a_directory_that_cannot_be_created_is_a_storage_error_not_a_panic() {
    let (dir, archive) = archive();
    let source = write(dir.path(), "reply.eml", &eml("x"));
    // 用一个文件占住 attachments/2026 的位置：目录建不出来。
    fs::write(archive.join("attachments").join("2026"), b"not a directory").unwrap();

    let err = stage_file(&archive, &source, BUCKET, &nothing_staged).unwrap_err();
    assert_eq!(err.code(), "storage");
}
