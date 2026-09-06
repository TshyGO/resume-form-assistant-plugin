use archive_store::schema::{Migration, MIGRATIONS};
use archive_store::*;
use serde_json::json;

fn config(root: &std::path::Path) -> ArchiveConfig {
    ArchiveConfig::new(root.join("archive"), root.join("current.json"))
}

#[test]
fn review_regressions_hashes_and_missing_resources() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    let a = db.create_application(app()).unwrap();
    let mut upper = evidence(Some(a.id.clone()));
    upper.blob.sha256 = "A".repeat(64);
    db.import_evidence(upper).unwrap();
    db.import_evidence(evidence(Some(a.id.clone()))).unwrap();
    let report = db.check_attachment_refs().unwrap();
    assert_eq!(report.total_blobs, 1);
    assert_eq!(report.total_evidence, 2);
    assert!(report.zero_ref_blobs.is_empty());
    assert!(matches!(
        db.finalize_snapshot_upload("client-a", "absent", "snapshots/x.json"),
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        db.reconcile_lookup(None, "client-a", &[]),
        Err(StoreError::IdentityMissing)
    ));
    let (context, operation) = chunk(&db, &a.id, 0, &"B".repeat(64));
    db.submit_plugin_message(&context, operation).unwrap();
    let (context, operation) = chunk(&db, &a.id, 1, &"b".repeat(64));
    db.submit_plugin_message(&context, operation).unwrap();
    assert_eq!(
        db.snapshot_progress("client-a", "synthetic-snapshot")
            .unwrap()
            .total_sha256,
        "b".repeat(64)
    );
    drop(db);
    let mut pointer: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&cfg.current_pointer).unwrap()).unwrap();
    // CurrentPointer uses snake_case serde field names.
    pointer["archive_dir"] = json!(dir.path().join("missing"));
    std::fs::write(&cfg.current_pointer, serde_json::to_vec(&pointer).unwrap()).unwrap();
    assert!(
        matches!(ArchiveStore::open(cfg), Err(StoreError::Validation(s)) if s.contains("missing archive directory"))
    );
}
fn app() -> NewApplication {
    NewApplication {
        company: "合成公司".into(),
        title: "研发".into(),
        source_url: Some("https://jobs.example/a?code=secret&role=42".into()),
        location: None,
        notes: None,
        origin: ApplicationOrigin::Manual,
        occurred_at: Occurred::Unknown,
    }
}
fn event(payload: EventPayload) -> EventDraft {
    EventDraft::new(payload, Occurred::Unknown, EventSource::Manual, Actor::User)
}
fn job() -> PluginOp {
    PluginOp::JobSave(JobSaveInput {
        target_application_id: None,
        company: "Synthetic".into(),
        title: "Engineer".into(),
        source_url: None,
        location: None,
        occurred: Occurred::Unknown,
    })
}
fn ctx(store: &ArchiveStore, op: &PluginOp, message: &str) -> PluginWriteContext {
    PluginWriteContext {
        envelope_identity: Some(store.identity()),
        client_instance_id: "client-a".into(),
        message_id: message.into(),
        source_restore_epoch: store.identity().restore_epoch,
        payload_sha256: op.digest().unwrap(),
    }
}
fn result_id(outcome: PluginWriteOutcome) -> String {
    match outcome {
        PluginWriteOutcome::Committed { result_id, .. }
        | PluginWriteOutcome::Replayed { result_id, .. } => result_id,
    }
}
fn evidence(id: Option<String>) -> NewEvidence {
    NewEvidence {
        application_id: id,
        kind: EvidenceKind::Eml,
        blob: AttachmentBlobMeta {
            sha256: "a".repeat(64),
            size_bytes: 10,
            stored_rel_path: "attachments/example.eml".into(),
            mime: None,
        },
        original_filename: Some("example.eml".into()),
        subject: None,
        from_addr: None,
        sent_at: None,
        body_extract: None,
        append_event: true,
    }
}

#[test]
fn persistent_application_and_ordered_timeline() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    let identity = db.identity();
    let a = db.create_application(app()).unwrap();
    db.transaction(|tx| {
        tx.append_events(
            Some(&a.id),
            &[
                event(EventPayload::SubmitConfirmed {
                    via: "desktop".into(),
                    note: None,
                    stage_update_mode: StageUpdateMode::UpdateProgress,
                }),
                event(EventPayload::StageCorrected {
                    from: Stage::Submitted,
                    to: Stage::Interview,
                    reason: "confirmed".into(),
                    actor: Actor::User,
                }),
            ],
            "2026-09-06T10:00:00Z",
        )?;
        Ok(())
    })
    .unwrap();
    let events = db.list_events(&a.id).unwrap();
    assert_eq!(
        events.iter().map(|e| e.event_sequence).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    db.close().unwrap();
    let db = ArchiveStore::open(cfg).unwrap();
    assert_eq!(db.identity(), identity);
    assert_eq!(
        db.get_application(&a.id).unwrap().unwrap().current_stage,
        Stage::Interview
    );
    assert_eq!(db.list_events(&a.id).unwrap().len(), 3);
    assert!(!db
        .get_application(&a.id)
        .unwrap()
        .unwrap()
        .source_url
        .as_ref()
        .unwrap()
        .contains("secret"));
}

#[test]
fn transaction_failure_rolls_back_all_effects_and_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let a = db.create_application(app()).unwrap();
    let result: Result<(), StoreError> = db.transaction(|tx| {
        tx.create_application(app())?;
        tx.append_event(
            Some(&a.id),
            event(EventPayload::OfferRecorded {
                note: None,
                stage_update_mode: StageUpdateMode::UpdateProgress,
            }),
        )?;
        Err(StoreError::Validation("abort".into()))
    });
    assert!(result.is_err());
    assert_eq!(
        db.list_applications(&ApplicationFilter {
            limit: 100,
            ..Default::default()
        })
        .unwrap()
        .total,
        1
    );
    assert_eq!(
        db.get_application(&a.id)
            .unwrap()
            .unwrap()
            .last_event_sequence,
        1
    );
    assert_eq!(
        db.get_application(&a.id).unwrap().unwrap().current_stage,
        Stage::Saved
    );
}

#[test]
fn history_does_not_regress_and_corrections_require_reason() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let a = db.create_application(app()).unwrap();
    db.append_event(
        Some(&a.id),
        event(EventPayload::OfferRecorded {
            note: None,
            stage_update_mode: StageUpdateMode::UpdateProgress,
        }),
    )
    .unwrap();
    db.append_event(
        Some(&a.id),
        event(EventPayload::AssessmentRecorded {
            name: None,
            due: None,
            stage_update_mode: StageUpdateMode::HistoryOnly,
        }),
    )
    .unwrap();
    assert_eq!(
        db.get_application(&a.id).unwrap().unwrap().current_stage,
        Stage::Offer
    );
    assert!(db
        .append_event(
            Some(&a.id),
            event(EventPayload::StageCorrected {
                from: Stage::Offer,
                to: Stage::Interview,
                reason: "".into(),
                actor: Actor::User
            })
        )
        .is_err());
}

#[test]
fn duplicates_pagination_recycle_and_restore() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let a = db.create_application(app()).unwrap();
    let b = db.create_application(app()).unwrap();
    assert_ne!(a.id, b.id);
    let filter = ApplicationFilter {
        limit: 1,
        ..Default::default()
    };
    let page = db.list_applications(&filter).unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(page.items.len(), 1);
    db.set_recycle_state(&a.id, RecycleState::Recycled).unwrap();
    assert_eq!(db.list_events(&a.id).unwrap().len(), 2);
    db.set_recycle_state(&a.id, RecycleState::Active).unwrap();
    assert_eq!(
        db.get_application(&a.id).unwrap().unwrap().recycle_state,
        RecycleState::Active
    );
}

#[test]
fn replay_conflict_purge_and_profile_isolation() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let op = job();
    let context = ctx(&db, &op, "message-1");
    let id = result_id(db.submit_plugin_message(&context, op).unwrap());
    assert!(matches!(
        db.submit_plugin_message(&context, job()).unwrap(),
        PluginWriteOutcome::Replayed { .. }
    ));
    let different = PluginOp::JobSave(JobSaveInput {
        company: "Other".into(),
        ..match job() {
            PluginOp::JobSave(i) => i,
            _ => unreachable!(),
        }
    });
    let mut conflict = context.clone();
    conflict.payload_sha256 = different.digest().unwrap();
    assert!(matches!(
        db.submit_plugin_message(&conflict, different),
        Err(StoreError::Conflict(_))
    ));
    let mut other = context.clone();
    other.client_instance_id = "client-b".into();
    assert_ne!(
        result_id(db.submit_plugin_message(&other, job()).unwrap()),
        id
    );
    db.purge_application(&id).unwrap();
    assert!(matches!(
        db.submit_plugin_message(&context, job()),
        Err(StoreError::PreviouslyPurged { .. })
    ));
    assert!(db.get_application(&id).unwrap().is_none());
}

#[test]
fn epoch_rotation_preserves_read_only_receipts_and_rejects_old_writes() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let op = job();
    let context = ctx(&db, &op, "old");
    db.submit_plugin_message(&context, op).unwrap();
    let old = db.identity();
    let next = db.rotate_restore_epoch().unwrap();
    assert_ne!(old.restore_epoch, next.restore_epoch);
    assert_ne!(
        db.rotate_restore_epoch().unwrap().restore_epoch,
        next.restore_epoch
    );
    assert!(matches!(
        db.submit_plugin_message(&context, job()),
        Err(StoreError::RestoreEpochMismatch { .. })
    ));
    let item = ReconcileQueryItem {
        client_instance_id: context.client_instance_id.clone(),
        message_id: context.message_id.clone(),
        source_restore_epoch: context.source_restore_epoch.clone(),
        payload_sha256: context.payload_sha256.clone(),
        snapshot_id: None,
        chunk_index: None,
    };
    let reply = db
        .reconcile_lookup(Some(&db.identity()), "client-a", &[item.clone()])
        .unwrap();
    assert!(matches!(reply[0].outcome, ReconcileOutcome::Applied { .. }));
    assert!(db
        .reconcile_lookup(Some(&db.identity()), "wrong-client", &[item])
        .is_err());
}

#[test]
fn no_second_store_and_no_pointer_change_on_failed_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    assert!(ArchiveStore::open(cfg.clone()).is_err());
    let before = db.identity();
    std::fs::remove_file(&cfg.current_pointer).unwrap();
    std::fs::create_dir(&cfg.current_pointer).unwrap();
    assert!(db.rotate_restore_epoch().is_err());
    assert_eq!(db.identity(), before);
}

#[test]
fn migration_atomicity_and_recovery_backup() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    let id = db.create_application(app()).unwrap().id.clone();
    db.close().unwrap();
    let mut chain = MIGRATIONS.to_vec();
    chain.push(Migration {
        to_version: 2,
        description: "valid",
        sql: "CREATE TABLE v2 (id INTEGER);",
    });
    chain.push(Migration {
        to_version: 3,
        description: "bad",
        sql: "CREATE TABLE temp_v3 (id INTEGER); BROKEN SQL;",
    });
    let result = ArchiveStore::open_with_migrations(cfg.clone(), &chain);
    let backup = match result {
        Err(StoreError::MigrationFailed {
            backup: Some(p), ..
        }) => p,
        _ => panic!("expected failed migration"),
    };
    assert!(backup.is_file());
    let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
    assert_eq!(
        raw.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        raw.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('v2','temp_v3')",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(raw);
    let db = ArchiveStore::open(cfg).unwrap();
    assert!(db.get_application(&id).unwrap().is_some());
}

#[test]
fn evidence_and_suggestions_are_separate_and_confirmation_is_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    let a = db.create_application(app()).unwrap();
    let e = db.import_evidence(evidence(Some(a.id.clone()))).unwrap();
    assert_eq!(
        db.get_application(&a.id)
            .unwrap()
            .unwrap()
            .reply_evidence_state,
        ReplyEvidenceState::ImportedUnclassified
    );
    let s = db
        .create_suggestion(NewAiSuggestion {
            evidence_id: e.id.clone(),
            candidate_application_ids: vec![a.id.clone()],
            suggested_stage: Some(Stage::Interview),
            suggested_round: Some(1),
            suggested_reply_class: ReplyClass::InterviewInvite,
            suggested_send_mode: SendMode::Automated,
            suggested_todos: vec![],
            excerpt_refs: Some(json!(["synthetic excerpt"])),
            uncertainties: None,
            model_label: None,
            prompt_scope: None,
        })
        .unwrap();
    db.close().unwrap();
    let db = ArchiveStore::open(cfg).unwrap();
    assert_eq!(
        db.get_suggestion(&s.id)
            .unwrap()
            .unwrap()
            .suggested_send_mode,
        SendMode::Automated
    );
    assert!(db
        .get_evidence(&e.id)
        .unwrap()
        .unwrap()
        .reply_class
        .is_none());
    let mut input = ConfirmSuggestionInput {
        suggestion_id: s.id.clone(),
        application_id: a.id.clone(),
        approved_reply_class: ReplyClass::InterviewInvite,
        approved_send_mode: SendMode::Unknown,
        stage_event: Some(event(EventPayload::StageCorrected {
            from: Stage::Saved,
            to: Stage::Interview,
            reason: "".into(),
            actor: Actor::User,
        })),
        create_todos: false,
    };
    assert!(db.confirm_suggestion(input.clone()).is_err());
    assert!(db
        .get_evidence(&e.id)
        .unwrap()
        .unwrap()
        .reply_class
        .is_none());
    input.stage_event = Some(event(EventPayload::InterviewRecorded {
        round: Some(1),
        label: None,
        stage_update_mode: StageUpdateMode::UpdateProgress,
    }));
    assert!(
        !db.confirm_suggestion(input.clone())
            .unwrap()
            .already_confirmed
    );
    assert!(db.confirm_suggestion(input).unwrap().already_confirmed);
    assert_eq!(
        db.get_application(&a.id).unwrap().unwrap().current_stage,
        Stage::Interview
    );
}

#[test]
fn safe_paths_and_encoded_url_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let mut e = evidence(None);
    e.blob.stored_rel_path = "../outside".into();
    assert!(db.import_evidence(e).is_err());
    let url = archive_store::normalize::sanitize_source_url(
        "https://u:p@jobs.example/CaseSensitive?%63ode=SECRET&role=AbC#secret",
    );
    assert_eq!(url, "https://jobs.example/CaseSensitive?role=AbC");
}

#[test]
fn migration_success_survives_reopen_and_metadata_agrees() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    let id = db.create_application(app()).unwrap().id.clone();
    db.close().unwrap();
    let mut chain = MIGRATIONS.to_vec();
    chain.push(Migration {
        to_version: 2,
        description: "add test field",
        sql: "ALTER TABLE archive_meta ADD COLUMN extra TEXT;",
    });
    let db = ArchiveStore::open_with_migrations(cfg.clone(), &chain).unwrap();
    assert_eq!(db.schema_version(), 2);
    assert!(db.migration_backup.as_ref().unwrap().exists());
    db.close().unwrap();
    let db = ArchiveStore::open_with_migrations(cfg.clone(), &chain).unwrap();
    assert!(db.migration_backup.is_none());
    assert!(db.get_application(&id).unwrap().is_some());
    let meta: serde_json::Value =
        serde_json::from_slice(&std::fs::read(cfg.meta_path()).unwrap()).unwrap();
    assert_eq!(meta["schema_version"], 2);
}

#[test]
fn shared_blobs_survive_other_app_purge_and_missing_files_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let a = db.create_application(app()).unwrap();
    let b = db.create_application(app()).unwrap();
    db.import_evidence(evidence(Some(a.id.clone()))).unwrap();
    db.import_evidence(evidence(Some(a.id.clone()))).unwrap();
    db.import_evidence(evidence(Some(b.id.clone()))).unwrap();
    assert_eq!(db.check_attachment_refs().unwrap().invalid_files.len(), 1);
    db.purge_application(&a.id).unwrap();
    assert_eq!(
        db.get_evidence(&db.list_evidence(Some(&b.id)).unwrap()[0].id)
            .unwrap()
            .unwrap()
            .blob
            .ref_count,
        1
    );
    db.purge_application(&b.id).unwrap();
    assert_eq!(db.check_attachment_refs().unwrap().total_blobs, 0);
}

fn chunk(
    store: &ArchiveStore,
    app_id: &str,
    index: i64,
    total_sha: &str,
) -> (PluginWriteContext, PluginOp) {
    let op = PluginOp::SnapshotChunk(SnapshotChunkInput {
        application_id: Some(app_id.into()),
        snapshot_id: "synthetic-snapshot".into(),
        chunk_index: index,
        chunk_count: 2,
        total_sha256: total_sha.into(),
        byte_size: 6,
        chunk_sha256: "a".repeat(64),
        template_name: Some("synthetic".into()),
        template_version: None,
    });
    (ctx(store, &op, &format!("chunk-{index}")), op)
}

#[test]
fn snapshot_metadata_never_finalizes_a_missing_or_corrupt_file() {
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    let a = db.create_application(app()).unwrap();
    let sha = format!("{:x}", Sha256::digest(b"abcdef"));
    let (c1, o1) = chunk(&db, &a.id, 1, &sha);
    db.submit_plugin_message(&c1, o1).unwrap();
    assert_eq!(
        db.snapshot_progress("client-a", "synthetic-snapshot")
            .unwrap()
            .chunk_cursor,
        0
    );
    assert!(db
        .finalize_snapshot_upload("client-a", "synthetic-snapshot", "snapshots/s.json")
        .is_err());
    let (c0, o0) = chunk(&db, &a.id, 0, &sha);
    db.submit_plugin_message(&c0, o0).unwrap();
    assert_eq!(
        db.snapshot_progress("client-a", "synthetic-snapshot")
            .unwrap()
            .chunk_cursor,
        2
    );
    assert!(db
        .finalize_snapshot_upload("client-a", "synthetic-snapshot", "snapshots/s.json")
        .is_err());
    std::fs::create_dir_all(cfg.archive_dir.join("snapshots")).unwrap();
    std::fs::write(cfg.archive_dir.join("snapshots/s.json"), b"broken").unwrap();
    assert!(db
        .finalize_snapshot_upload("client-a", "synthetic-snapshot", "snapshots/s.json")
        .is_err());
    assert!(
        !db.snapshot_progress("client-a", "synthetic-snapshot")
            .unwrap()
            .full_acked
    );
    std::fs::write(cfg.archive_dir.join("snapshots/s.json"), b"abcdef").unwrap();
    let s = db
        .finalize_snapshot_upload("client-a", "synthetic-snapshot", "snapshots/s.json")
        .unwrap();
    assert_eq!(s.sha256, sha);
    db.close().unwrap();
    let db = ArchiveStore::open(cfg).unwrap();
    assert!(
        db.snapshot_progress("client-a", "synthetic-snapshot")
            .unwrap()
            .full_acked
    );
    db.purge_application(&a.id).unwrap();
    assert!(matches!(
        db.submit_plugin_message(&c0, chunk(&db, &a.id, 0, &sha).1),
        Err(StoreError::PreviouslyPurged { .. })
    ));
}

#[test]
fn pending_snapshot_is_purged_with_its_application() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let a = db.create_application(app()).unwrap();
    let (ctx, op) = chunk(&db, &a.id, 0, &"a".repeat(64));
    db.submit_plugin_message(&ctx, op).unwrap();
    db.purge_application(&a.id).unwrap();
    assert!(matches!(
        db.submit_plugin_message(&ctx, chunk(&db, &a.id, 0, &"a".repeat(64)).1),
        Err(StoreError::PreviouslyPurged { .. })
    ));
}

#[test]
fn event_secrets_and_reserved_custom_events_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let a = db.create_application(app()).unwrap();
    for (kind, data) in [
        ("custom.note", json!({"api_key":"secret"})),
        ("application_created", json!({})),
    ] {
        assert!(db
            .append_event(
                Some(&a.id),
                event(EventPayload::Custom {
                    event_type: kind.into(),
                    data,
                    stage_update_mode: StageUpdateMode::UpdateProgress
                })
            )
            .is_err());
    }
    assert_eq!(db.list_events(&a.id).unwrap().len(), 1);
}

#[test]
fn todo_date_precision_and_nullable_patch_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    let a = db.create_application(app()).unwrap();
    let todo = db
        .create_todo(NewTodo {
            application_id: a.id.clone(),
            title: "测评".into(),
            due: TodoDue::Date("2026-09-10".into()),
            time_zone: Some("Asia/Taipei".into()),
            remind_at_utc: None,
            interview_round: Some(1),
            source_event_id: None,
        })
        .unwrap();
    let updated = db
        .update_todo(
            &todo.id,
            TodoPatch {
                time_zone: Some(None),
                interview_round: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(updated.time_zone.is_none());
    assert!(updated.interview_round.is_none());
    db.close().unwrap();
    let db = ArchiveStore::open(cfg).unwrap();
    assert_eq!(
        db.get_todo(&todo.id).unwrap().unwrap().due,
        TodoDue::Date("2026-09-10".into())
    );
}

#[test]
fn concurrent_events_allocate_one_monotonic_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let db = std::sync::Arc::new(ArchiveStore::open(config(dir.path())).unwrap());
    let id = db.create_application(app()).unwrap().id.clone();
    let tasks: Vec<_> = (0..8)
        .map(|n| {
            let db = db.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                db.append_event(
                    Some(&id),
                    event(EventPayload::NoteAdded {
                        text: format!("synthetic-{n}"),
                    }),
                )
                .unwrap()
            })
        })
        .collect();
    for task in tasks {
        task.join().unwrap();
    }
    let events = db.list_events(&id).unwrap();
    assert_eq!(
        events.iter().map(|e| e.event_sequence).collect::<Vec<_>>(),
        (1..=9).collect::<Vec<_>>()
    );
}

#[test]
fn unchanged_wire_digest_cannot_hide_a_changed_typed_operation() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let context = ctx(&db, &job(), "same");
    db.submit_plugin_message(&context, job()).unwrap();
    let op = PluginOp::JobSave(JobSaveInput {
        title: "different".into(),
        ..match job() {
            PluginOp::JobSave(i) => i,
            _ => unreachable!(),
        }
    });
    assert!(matches!(
        db.submit_plugin_message(&context, op),
        Err(StoreError::Conflict(_))
    ));
}

#[test]
fn missing_metadata_is_not_replaced_with_a_new_archive_identity() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    db.create_application(app()).unwrap();
    db.close().unwrap();
    std::fs::remove_file(cfg.meta_path()).unwrap();
    assert!(ArchiveStore::open(cfg.clone()).is_err());
    assert!(!cfg.meta_path().exists());
}

#[test]
fn eventless_evidence_updates_projection_and_archive_filter_is_sql_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let a = db.create_application(app()).unwrap();
    let mut e = evidence(Some(a.id.clone()));
    e.append_event = false;
    db.import_evidence(e).unwrap();
    assert_eq!(
        db.get_application(&a.id)
            .unwrap()
            .unwrap()
            .reply_evidence_state,
        ReplyEvidenceState::ImportedUnclassified
    );
    assert_eq!(db.list_events(&a.id).unwrap().len(), 1);
    db.update_application(
        &a.id,
        UpdateApplicationInput {
            archived: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        db.list_applications(&ApplicationFilter::default())
            .unwrap()
            .total,
        0
    );
    assert_eq!(
        db.list_applications(&ApplicationFilter {
            archived: Some(true),
            ..Default::default()
        })
        .unwrap()
        .total,
        1
    );
}

#[test]
fn confirmed_suggestion_replay_cannot_change_any_approved_decision() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let a = db.create_application(app()).unwrap();
    let b = db.create_application(app()).unwrap();
    let e = db.import_evidence(evidence(Some(a.id.clone()))).unwrap();
    let s = db
        .create_suggestion(NewAiSuggestion {
            evidence_id: e.id,
            candidate_application_ids: vec![a.id.clone()],
            suggested_stage: Some(Stage::Interview),
            suggested_round: Some(1),
            suggested_reply_class: ReplyClass::InterviewInvite,
            suggested_send_mode: SendMode::Unknown,
            suggested_todos: vec![],
            excerpt_refs: None,
            uncertainties: None,
            model_label: None,
            prompt_scope: None,
        })
        .unwrap();
    let input = ConfirmSuggestionInput {
        suggestion_id: s.id,
        application_id: a.id.clone(),
        approved_reply_class: ReplyClass::InterviewInvite,
        approved_send_mode: SendMode::Unknown,
        stage_event: Some(event(EventPayload::InterviewRecorded {
            round: Some(1),
            label: None,
            stage_update_mode: StageUpdateMode::HistoryOnly,
        })),
        create_todos: false,
    };
    db.confirm_suggestion(input.clone()).unwrap();
    assert!(
        db.confirm_suggestion(input.clone())
            .unwrap()
            .already_confirmed
    );
    let mut changed = input.clone();
    changed.application_id = b.id.clone();
    assert!(matches!(
        db.confirm_suggestion(changed),
        Err(StoreError::Conflict(_))
    ));
    let mut changed = input.clone();
    changed.stage_event = None;
    assert!(matches!(
        db.confirm_suggestion(changed),
        Err(StoreError::Conflict(_))
    ));
    let mut changed = input;
    changed.create_todos = true;
    assert!(matches!(
        db.confirm_suggestion(changed),
        Err(StoreError::Conflict(_))
    ));
}
