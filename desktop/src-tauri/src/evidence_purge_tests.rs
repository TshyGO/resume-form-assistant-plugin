use super::*;
use archive_store::{ArchiveConfig, AttachmentBlobMeta, EvidenceKind, NewEvidence};

fn setup() -> (tempfile::TempDir, ArchiveStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = ArchiveStore::open(ArchiveConfig::new(
        dir.path().join("archive"),
        dir.path().join("current.json"),
    ))
    .unwrap();
    (dir, store)
}
fn record(store: &ArchiveStore) -> archive_store::ReplyEvidence {
    store
        .import_evidence(NewEvidence {
            application_id: None,
            kind: EvidenceKind::Eml,
            blob: AttachmentBlobMeta {
                sha256: "a".repeat(64),
                size_bytes: 12,
                stored_rel_path: "attachments/2026/10/original.eml".into(),
                mime: Some("message/rfc822".into()),
            },
            original_filename: Some("original.eml".into()),
            subject: Some("Synthetic test notification".into()),
            from_addr: None,
            sent_at: None,
            body_extract: Some("synthetic body".into()),
            message_id: None,
            append_event: true,
        })
        .unwrap()
}
fn write_original(store: &ArchiveStore) -> std::path::PathBuf {
    let path = store.archive_dir().join("attachments/2026/10/original.eml");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"synthetic").unwrap();
    path
}

#[test]
fn deletion_removes_only_unshared_original_and_missing_files_are_idempotent_cleanup() {
    for file_present in [true, false] {
        let (_dir, store) = setup();
        let first = record(&store);
        let second = record(&store);
        let path = write_original(&store);
        store.set_evidence_recycled(&first.id, true).unwrap();
        let confirmation = preview(&store, &first.id).unwrap();
        assert!(confirmation.original_shared);
        let result = purge(&store, confirmation.target).unwrap();
        assert!(result.original_shared);
        assert!(path.exists());
        assert!(store.get_evidence(&second.id).unwrap().is_some());
        store.set_evidence_recycled(&second.id, true).unwrap();
        if !file_present {
            std::fs::remove_file(&path).unwrap();
        }
        let result = purge(&store, preview(&store, &second.id).unwrap().target).unwrap();
        assert!(!result.original_shared);
        assert!(!result.cleanup_pending);
        assert!(!path.exists());
        assert!(store.find_blob(&first.blob.meta.sha256).unwrap().is_none());
    }
}

#[test]
fn failed_file_cleanup_is_reported_and_remains_in_orphan_report() {
    let (_dir, store) = setup();
    let e = record(&store);
    let path = write_original(&store);
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap(); // deterministic unlink failure on all platforms
    store.set_evidence_recycled(&e.id, true).unwrap();
    let result = purge(&store, preview(&store, &e.id).unwrap().target).unwrap();
    assert!(result.cleanup_pending);
    assert!(store.get_evidence(&e.id).unwrap().is_none());
    assert_eq!(
        store.check_attachment_refs().unwrap().zero_ref_blobs,
        vec![e.blob.meta.sha256]
    );
}

#[test]
fn confirmation_cannot_cross_archive_epoch_or_delete_a_restored_notification() {
    let (_dir, store) = setup();
    let e = record(&store);
    let path = write_original(&store);
    assert!(preview(&store, &e.id).is_err());
    store.set_evidence_recycled(&e.id, true).unwrap();
    let original = preview(&store, &e.id).unwrap().target;
    for archive_changed in [true, false] {
        let mut stale = original.clone();
        if archive_changed {
            stale.archive_id = "other-archive".into();
        } else {
            stale.restore_epoch = "old-epoch".into();
        }
        assert!(purge(&store, stale).is_err());
        assert!(path.exists());
    }
    store.set_evidence_recycled(&e.id, false).unwrap();
    assert!(purge(&store, original).is_err());
    assert!(path.exists());
    assert!(store.get_evidence(&e.id).unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn attachment_parent_symlinks_cannot_delete_files_outside_archive() {
    let (dir, store) = setup();
    let e = record(&store);
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let secret = outside.join("original.eml");
    std::fs::write(&secret, b"keep").unwrap();
    std::fs::create_dir_all(store.archive_dir().join("attachments/2026")).unwrap();
    std::os::unix::fs::symlink(&outside, store.archive_dir().join("attachments/2026/10")).unwrap();
    store.set_evidence_recycled(&e.id, true).unwrap();
    let result = purge(&store, preview(&store, &e.id).unwrap().target).unwrap();
    assert!(result.cleanup_pending);
    assert_eq!(std::fs::read(secret).unwrap(), b"keep");
}
