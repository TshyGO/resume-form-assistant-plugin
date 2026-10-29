//! #330：同一封信从不同渠道进来（字节不同、Message-ID 相同）只存一份。

use archive_store::{
    ApplicationOrigin, ArchiveConfig, ArchiveStore, AttachmentBlobMeta, EvidenceImportOutcome,
    EvidenceKind, MailKey, NewApplication, NewEvidence, Occurred, RecycleState,
};

const MESSAGE_ID: &str = "AbC.123@mail.example.test";

fn open(dir: &std::path::Path) -> ArchiveStore {
    ArchiveStore::open(config(dir)).unwrap()
}

fn config(dir: &std::path::Path) -> ArchiveConfig {
    ArchiveConfig::new(dir.join("archive"), dir.join("current.json"))
}

fn mail(digit: char, message_id: Option<&str>, application_id: Option<String>) -> NewEvidence {
    NewEvidence {
        application_id,
        kind: EvidenceKind::Eml,
        blob: AttachmentBlobMeta {
            sha256: digit.to_string().repeat(64),
            size_bytes: 10,
            stored_rel_path: format!("attachments/2026/10/{digit}.eml"),
            mime: Some("message/rfc822".into()),
        },
        original_filename: Some(format!("{digit}.eml")),
        subject: Some("面试邀请".into()),
        from_addr: Some("hr@example.test".into()),
        sent_at: None,
        body_extract: None,
        message_id: message_id.map(str::to_string),
        append_event: true,
    }
}

/// 旧档案里手写的行没有发件人和发送时间。
fn key(message_id: &str) -> MailKey {
    MailKey {
        message_id: message_id.into(),
        from_addr: None,
        sent_at: None,
    }
}

fn application(store: &ArchiveStore, company: &str) -> String {
    store
        .create_application(NewApplication {
            company: company.into(),
            title: "后端工程师".into(),
            source_url: None,
            location: None,
            notes: None,
            origin: ApplicationOrigin::Manual,
            occurred_at: Occurred::Unknown,
        })
        .unwrap()
        .summary
        .id
}

fn imported(outcome: EvidenceImportOutcome) -> archive_store::ReplyEvidence {
    match outcome {
        EvidenceImportOutcome::Imported(evidence) => evidence,
        EvidenceImportOutcome::AlreadyStored(evidence) => {
            panic!("expected a new record, matched {}", evidence.id)
        }
    }
}

fn matched(outcome: EvidenceImportOutcome) -> archive_store::ReplyEvidence {
    match outcome {
        EvidenceImportOutcome::AlreadyStored(evidence) => evidence,
        EvidenceImportOutcome::Imported(evidence) => {
            panic!("expected a match, got new record {}", evidence.id)
        }
    }
}

#[test]
fn the_same_message_id_with_different_bytes_is_stored_once() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    let first = imported(
        store
            .import_or_match_evidence(mail('a', Some(MESSAGE_ID), None))
            .unwrap(),
    );
    let again = matched(
        store
            .import_or_match_evidence(mail('b', Some(MESSAGE_ID), None))
            .unwrap(),
    );
    assert_eq!(again.id, first.id);
    assert_eq!(store.list_evidence(None).unwrap().len(), 1);
    assert!(store.find_blob(&"b".repeat(64)).unwrap().is_none());
}

#[test]
fn a_reused_message_id_from_another_sender_or_time_is_a_different_mail() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    let first = imported(
        store
            .import_or_match_evidence(mail('a', Some(MESSAGE_ID), None))
            .unwrap(),
    );

    let mut other_sender = mail('b', Some(MESSAGE_ID), None);
    other_sender.from_addr = Some("someone-else@example.test".into());
    assert_ne!(
        imported(store.import_or_match_evidence(other_sender).unwrap()).id,
        first.id
    );

    let mut other_time = mail('c', Some(MESSAGE_ID), None);
    other_time.sent_at = Some(Occurred::DateTime {
        rfc3339: "2026-10-01T08:00:00Z".into(),
        time_zone: None,
    });
    assert_ne!(
        imported(store.import_or_match_evidence(other_time).unwrap()).id,
        first.id
    );
    assert_eq!(store.list_evidence(None).unwrap().len(), 3);
}

#[test]
fn mail_without_message_id_keeps_importing_as_before() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    imported(
        store
            .import_or_match_evidence(mail('a', None, None))
            .unwrap(),
    );
    imported(
        store
            .import_or_match_evidence(mail('a', None, None))
            .unwrap(),
    );
    imported(
        store
            .import_or_match_evidence(mail('b', Some(""), None))
            .unwrap(),
    );
    assert_eq!(store.list_evidence(None).unwrap().len(), 3);
}

#[test]
fn a_match_in_the_inbox_moves_to_the_application_being_imported_into() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    let app = application(&store, "示例科技");
    let first = imported(
        store
            .import_or_match_evidence(mail('a', Some(MESSAGE_ID), None))
            .unwrap(),
    );
    let again = matched(
        store
            .import_or_match_evidence(mail('b', Some(MESSAGE_ID), Some(app.clone())))
            .unwrap(),
    );
    assert_eq!(again.id, first.id);
    assert_eq!(again.application_id.as_deref(), Some(app.as_str()));
    assert!(store.list_evidence(None).unwrap().is_empty());
}

#[test]
fn a_match_on_another_application_stays_where_it_is() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    let owner = application(&store, "甲公司");
    let other = application(&store, "乙公司");
    imported(
        store
            .import_or_match_evidence(mail('a', Some(MESSAGE_ID), Some(owner.clone())))
            .unwrap(),
    );
    let again = matched(
        store
            .import_or_match_evidence(mail('b', Some(MESSAGE_ID), Some(other.clone())))
            .unwrap(),
    );
    assert_eq!(again.application_id.as_deref(), Some(owner.as_str()));
    assert!(store.list_evidence(Some(&other)).unwrap().is_empty());
}

#[test]
fn a_copy_on_a_recycled_application_does_not_count() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    let app = application(&store, "示例科技");
    let old = imported(
        store
            .import_or_match_evidence(mail('a', Some(MESSAGE_ID), Some(app.clone())))
            .unwrap(),
    );
    store
        .set_recycle_state(&app, RecycleState::Recycled)
        .unwrap();
    let fresh = imported(
        store
            .import_or_match_evidence(mail('b', Some(MESSAGE_ID), None))
            .unwrap(),
    );
    assert_ne!(fresh.id, old.id);
    // 回收站里那条原样留着。
    assert!(store.get_evidence(&old.id).unwrap().is_some());
}

#[test]
fn a_v5_archive_gains_the_column_and_lists_old_mail_for_backfill() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let old =
        ArchiveStore::open_with_migrations(cfg.clone(), &archive_store::migration::MIGRATIONS[..5])
            .unwrap();
    let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
    raw.execute_batch(&format!(
        "INSERT INTO attachment_blobs (sha256, size_bytes, stored_rel_path, ref_count, mime) VALUES \
           ('{a}', 10, 'attachments/2026/09/a.eml', 1, NULL), \
           ('{b}', 10, 'attachments/2026/09/b.eml', 1, NULL), \
           ('{c}', 10, 'attachments/2026/09/c.png', 1, NULL); \
         INSERT INTO reply_evidence (id, kind, blob_sha256, imported_at) VALUES \
           ('ev-a', 'eml', '{a}', '2026-09-01T00:00:00Z'), \
           ('ev-b', 'eml', '{b}', '2026-09-02T00:00:00Z'), \
           ('ev-c', 'screenshot', '{c}', '2026-09-03T00:00:00Z');",
        a = "a".repeat(64),
        b = "b".repeat(64),
        c = "c".repeat(64),
    ))
    .unwrap();
    drop(raw);
    old.close().unwrap();

    let store = open(dir.path());
    assert_eq!(store.schema_version(), 7);
    let pending = store.evidence_missing_message_id().unwrap();
    let ids: Vec<&str> = pending.iter().map(|p| p.evidence_id.as_str()).collect();
    assert_eq!(ids, ["ev-a", "ev-b"]);
    assert_eq!(pending[0].stored_rel_path, "attachments/2026/09/a.eml");

    let written = store
        .record_message_ids(&[
            ("ev-a".into(), Some(MESSAGE_ID.into())),
            ("ev-b".into(), None),
        ])
        .unwrap();
    assert_eq!(written, 2);
    assert!(store.evidence_missing_message_id().unwrap().is_empty());
    assert_eq!(
        store.find_known_mail(&key(MESSAGE_ID)).unwrap().unwrap().id,
        "ev-a"
    );
    // 「查过、没有编号」的空串不会被当成编号命中。
    assert!(store.find_known_mail(&key("")).unwrap().is_none());
    // 补算只填空着的行。
    assert_eq!(
        store
            .record_message_ids(&[("ev-a".into(), Some("other@x".into()))])
            .unwrap(),
        0
    );
}

#[test]
fn a_v6_archive_is_refused_by_a_build_that_only_knows_v5() {
    // 0.4.3 恢复备份前会先这样打开一次；版本比自己新就停下，不碰当前档案。
    let dir = tempfile::tempdir().unwrap();
    open(dir.path()).close().unwrap();
    let older = ArchiveStore::open_with_migrations(
        config(dir.path()),
        &archive_store::migration::MIGRATIONS[..5],
    );
    let error = older
        .err()
        .expect("a v5 build cannot open a v6 archive")
        .to_string();
    assert!(error.contains("unsupported newer database"), "{error}");
}
