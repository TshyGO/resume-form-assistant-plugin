use archive_store::{
    ApplicationOrigin, ArchiveConfig, ArchiveStore, AttachmentBlobMeta, EvidenceKind, MailKey,
    NewApplication, NewEvidence, Occurred, RecycleState, ReplyClass, ReplyEvidenceState, SendMode,
};
fn open(d: &std::path::Path) -> ArchiveStore {
    ArchiveStore::open(ArchiveConfig::new(
        d.join("archive"),
        d.join("current.json"),
    ))
    .unwrap()
}
fn evidence(store: &ArchiveStore, app: Option<String>) -> archive_store::ReplyEvidence {
    store
        .import_evidence(NewEvidence {
            application_id: app,
            kind: EvidenceKind::Eml,
            blob: AttachmentBlobMeta {
                sha256: "a".repeat(64),
                size_bytes: 12,
                stored_rel_path: "attachments/2026/10/test.eml".into(),
                mime: Some("message/rfc822".into()),
            },
            original_filename: Some("test.eml".into()),
            subject: Some("test".into()),
            from_addr: Some("hr@example.test".into()),
            sent_at: None,
            body_extract: Some("Body".into()),
            message_id: Some("test@example.test".into()),
            append_event: true,
        })
        .unwrap()
}
fn app(store: &ArchiveStore) -> String {
    store
        .create_application(NewApplication {
            company: "Example".into(),
            title: "Engineer".into(),
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
#[test]
fn recycling_is_persistent_idempotent_and_keeps_blob_and_association() {
    let d = tempfile::tempdir().unwrap();
    let store = open(d.path());
    let application = app(&store);
    let e = evidence(&store, Some(application.clone()));
    store
        .classify_evidence(&e.id, ReplyClass::InterviewInvite, SendMode::Human)
        .unwrap();
    let before = store
        .get_application(&application)
        .unwrap()
        .unwrap()
        .current_stage;
    store.set_evidence_recycled(&e.id, true).unwrap();
    let events = store.list_events(&application).unwrap().len();
    store.set_evidence_recycled(&e.id, true).unwrap();
    assert_eq!(store.list_events(&application).unwrap().len(), events);
    assert!(store.list_evidence(Some(&application)).unwrap().is_empty());
    assert_eq!(store.list_recycled_evidence().unwrap()[0].id, e.id);
    assert_eq!(
        store.find_blob(&"a".repeat(64)).unwrap().unwrap().ref_count,
        1
    );
    assert_eq!(
        store.get_evidence(&e.id).unwrap().unwrap().application_id,
        Some(application.clone())
    );
    assert_eq!(
        store
            .get_application(&application)
            .unwrap()
            .unwrap()
            .reply_evidence_state,
        ReplyEvidenceState::NoneImported
    );
    assert_eq!(
        store
            .get_application(&application)
            .unwrap()
            .unwrap()
            .current_stage,
        before
    );
    assert!(store.associate_evidence(&e.id, &application).is_err());
    assert!(store.unassociate_evidence(&e.id).is_err());
    assert!(store
        .classify_evidence(&e.id, ReplyClass::Other, SendMode::Unknown)
        .is_err());
    drop(store);
    let store = open(d.path());
    assert!(store.is_evidence_recycled(&e.id).unwrap());
    store.set_evidence_recycled(&e.id, false).unwrap();
    assert_eq!(store.list_evidence(Some(&application)).unwrap()[0].id, e.id);
    assert!(store.list_recycled_evidence().unwrap().is_empty());
    assert_ne!(
        store
            .get_application(&application)
            .unwrap()
            .unwrap()
            .reply_evidence_state,
        ReplyEvidenceState::NoneImported
    );
}
#[test]
fn recycling_survives_read_checks_and_import_retries_until_explicit_restore() {
    let d = tempfile::tempdir().unwrap();
    let store = open(d.path());
    let e = evidence(&store, None);
    store.set_evidence_recycled(&e.id, true).unwrap();
    assert!(store.list_evidence(None).unwrap().is_empty());
    let key = MailKey {
        message_id: "test@example.test".into(),
        from_addr: Some("hr@example.test".into()),
        sent_at: None,
    };
    assert_eq!(store.find_known_mail(&key).unwrap().unwrap().id, e.id);
    assert!(store.is_evidence_recycled(&e.id).unwrap());
    assert_eq!(
        store.match_known_mail(&key, None).unwrap().unwrap().id,
        e.id
    );
    assert!(store.is_evidence_recycled(&e.id).unwrap());
    let application = app(&store);
    assert!(store
        .match_known_mail(&key, Some(&application))
        .unwrap()
        .unwrap()
        .application_id
        .is_none());
    assert!(store.list_evidence(None).unwrap().is_empty());
    store.set_evidence_recycled(&e.id, false).unwrap();
    assert_eq!(store.list_evidence(None).unwrap().len(), 1);
}
#[test]
fn restore_requires_the_original_application_to_be_active_and_purge_cascades_the_recycle_marker() {
    let d = tempfile::tempdir().unwrap();
    let store = open(d.path());
    let application = app(&store);
    let e = evidence(&store, Some(application.clone()));
    store.set_evidence_recycled(&e.id, true).unwrap();
    store
        .set_recycle_state(&application, RecycleState::Recycled)
        .unwrap();
    assert!(store.set_evidence_recycled(&e.id, false).is_err());
    assert!(store.is_evidence_recycled(&e.id).unwrap());
    store
        .set_recycle_state(&application, RecycleState::Active)
        .unwrap();
    store.set_evidence_recycled(&e.id, false).unwrap();
    assert_eq!(store.list_evidence(Some(&application)).unwrap().len(), 1);
    store.set_evidence_recycled(&e.id, true).unwrap();
    store
        .set_recycle_state(&application, RecycleState::Recycled)
        .unwrap();
    store.purge_application(&application).unwrap();
    assert!(store.list_recycled_evidence().unwrap().is_empty());
    assert!(!store.is_evidence_recycled(&e.id).unwrap());
}
#[test]
fn opening_a_v6_archive_creates_a_backup_and_preserves_existing_notification_metadata() {
    let d = tempfile::tempdir().unwrap();
    let store = open(d.path());
    let e = evidence(&store, None);
    drop(store);
    let path = d.path().join("archive/archive.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP TABLE evidence_recycle; DELETE FROM schema_migrations WHERE version=7; PRAGMA user_version=6; UPDATE archive_meta SET schema_version=6 WHERE id=1;").unwrap();
    drop(conn);
    let store = open(d.path());
    assert_eq!(store.schema_version(), 7);
    assert_eq!(store.list_evidence(None).unwrap()[0].id, e.id);
    assert!(!store.is_evidence_recycled(&e.id).unwrap());
    assert!(std::fs::read_dir(d.path().join("archive/backups"))
        .unwrap()
        .any(|f| f
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("pre-migration-v6")));
}
#[test]
fn a_stale_ai_confirmation_cannot_modify_a_recycled_notification() {
    let d = tempfile::tempdir().unwrap();
    let store = open(d.path());
    let application = app(&store);
    let e = evidence(&store, Some(application.clone()));
    let proposal = store
        .create_suggestion(archive_store::NewAiSuggestion {
            evidence_id: e.id.clone(),
            candidate_application_ids: vec![application.clone()],
            suggested_stage: Some(archive_store::Stage::Interview),
            suggested_round: None,
            suggested_reply_class: ReplyClass::InterviewInvite,
            suggested_send_mode: SendMode::Human,
            suggested_todos: vec![],
            excerpt_refs: None,
            uncertainties: None,
            model_label: None,
            prompt_scope: None,
        })
        .unwrap();
    store.set_evidence_recycled(&e.id, true).unwrap();
    let events = store.list_events(&application).unwrap().len();
    assert!(store
        .confirm_suggestion(archive_store::ConfirmSuggestionInput {
            suggestion_id: proposal.id,
            application_id: application.clone(),
            approved_reply_class: ReplyClass::InterviewInvite,
            approved_send_mode: SendMode::Human,
            stage_event: None,
            create_todos: false,
            approved_todos: None
        })
        .is_err());
    assert_eq!(store.list_events(&application).unwrap().len(), events);
    assert!(store
        .get_evidence(&e.id)
        .unwrap()
        .unwrap()
        .reply_class
        .is_none());
}

#[test]
fn permanent_notification_delete_requires_recycling_and_matching_original() {
    let d = tempfile::tempdir().unwrap();
    let store = open(d.path());
    let e = evidence(&store, None);
    assert!(store.purge_recycled_evidence(&e.id, &e.blob.meta.sha256).is_err());
    store.set_evidence_recycled(&e.id, true).unwrap();
    assert!(store.purge_recycled_evidence(&e.id, &"b".repeat(64)).is_err());
    assert!(store.get_evidence(&e.id).unwrap().is_some());
    assert!(store.is_evidence_recycled(&e.id).unwrap());
    store.set_evidence_recycled(&e.id, false).unwrap();
    assert!(store.purge_recycled_evidence(&e.id, &e.blob.meta.sha256).is_err());
}

#[test]
fn permanent_delete_preserves_shared_blobs_and_application_history_and_removes_suggestions() {
    let d = tempfile::tempdir().unwrap();
    let store = open(d.path());
    let application = app(&store);
    let first = evidence(&store, Some(application.clone()));
    let other = evidence(&store, None);
    let suggestion = store.create_suggestion(archive_store::NewAiSuggestion {
        evidence_id: first.id.clone(), candidate_application_ids: vec![application.clone()],
        suggested_stage: None, suggested_round: None, suggested_reply_class: ReplyClass::Other,
        suggested_send_mode: SendMode::Unknown, suggested_todos: vec![], excerpt_refs: None,
        uncertainties: None, model_label: None, prompt_scope: None,
    }).unwrap();
    store.set_evidence_recycled(&first.id, true).unwrap();
    store.set_evidence_recycled(&other.id, true).unwrap();
    let before = store.get_application(&application).unwrap().unwrap();
    let removed = store.purge_recycled_evidence(&first.id, &first.blob.meta.sha256).unwrap();
    assert_eq!(removed.blob.ref_count, 1);
    assert!(store.get_evidence(&first.id).unwrap().is_none());
    assert!(!store.is_evidence_recycled(&first.id).unwrap());
    assert!(store.get_suggestion(&suggestion.id).unwrap().is_none());
    assert!(store.get_evidence(&other.id).unwrap().is_some());
    assert!(store.is_evidence_recycled(&other.id).unwrap());
    let after = store.get_application(&application).unwrap().unwrap();
    assert_eq!(before.current_stage, after.current_stage);
    assert!(store.list_events(&application).unwrap().len() >= 3);
    let last = store.purge_recycled_evidence(&other.id, &other.blob.meta.sha256).unwrap();
    assert_eq!(last.blob.ref_count, 0);
    assert_eq!(store.check_attachment_refs().unwrap().zero_ref_blobs, vec![first.blob.meta.sha256.clone()]);
    assert!(store.remove_unreferenced_blob(&first.blob.meta.sha256).unwrap());
    assert!(store.find_blob(&first.blob.meta.sha256).unwrap().is_none());
    assert!(store.purge_recycled_evidence(&other.id, &other.blob.meta.sha256).is_err());
    drop(store);
    let store = open(d.path());
    assert!(store.list_recycled_evidence().unwrap().is_empty());
}

#[test]
fn permanent_delete_keeps_a_minimal_purged_receipt() {
    let d = tempfile::tempdir().unwrap(); let store = open(d.path());
    let e = evidence(&store, None); store.set_evidence_recycled(&e.id, true).unwrap();
    let identity = store.identity(); drop(store);
    let conn = rusqlite::Connection::open(d.path().join("archive/archive.db")).unwrap();
    conn.execute("INSERT INTO message_receipts(archive_id,client_instance_id,message_id,source_restore_epoch,payload_sha256,operation_sha256,result_id,result_kind,operation_type,committed_at) VALUES (?1,'client','request',?2,?3,?3,?4,'evidence','mail.import','2026-10-31T00:00:00Z')",
        rusqlite::params![identity.archive_id, identity.restore_epoch, "b".repeat(64), e.id]).unwrap();
    drop(conn);
    let store = open(d.path()); store.purge_recycled_evidence(&e.id, &e.blob.meta.sha256).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(d.path().join("archive/archive.db")).unwrap();
    assert_eq!(conn.query_row("SELECT purged FROM message_receipts WHERE message_id='request'", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM reply_evidence", [], |r| r.get::<_,i64>(0)).unwrap(), 0);
}
