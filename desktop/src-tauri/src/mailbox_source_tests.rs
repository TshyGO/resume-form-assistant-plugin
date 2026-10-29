//! End-to-end source-contract tests without live OAuth or a real mailbox.
use super::*;
use std::sync::Arc;

struct FakeApi {
    kind: SourceKind,
    account_id: String,
    messages: Vec<Metadata>,
    pages: Option<Vec<Vec<Metadata>>>,
    pending_read: Option<tokio::sync::oneshot::Sender<()>>,
    pending_download: Option<tokio::sync::oneshot::Sender<()>>,
    raw: Vec<u8>,
    requests: Vec<Option<String>>,
    downloads: usize,
    fail_read: bool,
    fail_download: bool,
    ignore_size_limit: bool,
    cancel_read: Option<Arc<Cancellation>>,
    cancel_download: Option<Arc<Cancellation>>,
}
fn raw(id: &str, subject: &str) -> Vec<u8> {
    format!("From: hr@example.com\r\nSubject: {subject}\r\nDate: Sat, 24 Oct 2026 12:00:00 +0800\r\nMessage-ID: <{id}>\r\n\r\nPrivate body and attachment bytes.").into_bytes()
}
impl FakeApi {
    fn new(kind: SourceKind) -> Self {
        let raw = raw("mail@example.com", "Interview");
        Self {
            kind,
            account_id: "api".into(),
            messages: vec![Metadata {
                locator: MessageLocator::Api {
                    source: kind,
                    message_id: "provider-id-1".into(),
                },
                header: Header::parse(&raw),
            }],
            pages: None,
            pending_read: None,
            pending_download: None,
            raw,
            requests: vec![],
            downloads: 0,
            fail_read: false,
            fail_download: false,
            ignore_size_limit: false,
            cancel_read: None,
            cancel_download: None,
        }
    }
}
impl MimeSource for FakeApi {
    fn account_id(&self) -> &str {
        &self.account_id
    }
    fn kind(&self) -> SourceKind {
        self.kind
    }
    async fn download_mime(
        &mut self,
        _: &Candidate,
        max_bytes: usize,
    ) -> mailbox_sync::Result<Vec<u8>> {
        self.downloads += 1;
        if let Some(started) = self.pending_download.take() {
            let _ = started.send(());
            std::future::pending::<()>().await;
        }
        if std::mem::take(&mut self.fail_download) {
            return Err(Error::Network);
        }
        if let Some(cancel) = &self.cancel_download {
            cancel.cancel();
        }
        if !self.ignore_size_limit && self.raw.len() > max_bytes {
            return Err(Error::TooLarge);
        }
        Ok(self.raw.clone())
    }
}
impl PagedSource for FakeApi {
    async fn read_metadata(
        &mut self,
        _: &str,
        position: Option<&Position>,
    ) -> mailbox_sync::Result<MetadataPage> {
        self.requests.push(position.map(|position| match position {
            Position::Api { cursor, .. } => cursor.clone(),
            Position::Imap(_) => panic!("API must never receive an IMAP UID"),
        }));
        if let Some(started) = self.pending_read.take() {
            let _ = started.send(());
            std::future::pending::<()>().await;
        }
        if std::mem::take(&mut self.fail_read) {
            return Err(Error::Network);
        }
        if let Some(cancel) = &self.cancel_read {
            cancel.cancel();
        }
        if let Some(pages) = &self.pages {
            let index = match position {
                None => 0,
                Some(Position::Api { cursor, .. }) => cursor
                    .strip_prefix("page:")
                    .and_then(|value| value.parse::<usize>().ok())
                    .ok_or(Error::Protocol)?,
                Some(Position::Imap(_)) => return Err(Error::Changed),
            };
            return Ok(MetadataPage {
                messages: pages.get(index).ok_or(Error::Missing)?.clone(),
                next: Position::Api {
                    source: self.kind,
                    cursor: format!("page:{}", index + 1),
                },
                has_more: index + 1 < pages.len(),
            });
        }
        Ok(MetadataPage {
            messages: self.messages.clone(),
            next: Position::Api {
                source: self.kind,
                cursor: "opaque-next-page-or-delta".into(),
            },
            has_more: false,
        })
    }
}
fn fixture(
    kind: SourceKind,
) -> (
    tempfile::TempDir,
    Database,
    archive_store::ArchiveStore,
    Account,
) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path()).unwrap();
    let account = db
        .save_api_account("api", "person@example.com", kind, "tenant:person")
        .unwrap();
    let store = crate::commands::open_store(
        &dir.path().join("archive"),
        &dir.path().join("current.json"),
    )
    .unwrap();
    (dir, db, store, account)
}
async fn scan(
    source: &mut FakeApi,
    db: &mut Database,
    store: &archive_store::ArchiveStore,
    expected: &ArchiveIdentity,
    account: &Account,
    cancel: &Cancellation,
) -> Result<bool> {
    if source.kind() != account.source || source.account_id() != account.id {
        return Err(fail(Error::Changed));
    }
    let saved = mapped(db.source_position(&expected.archive_id, &account.id, "inbox"))?;
    source::scan_page(source, "inbox", saved.as_ref(), cancel, |page| {
        persist_source_page(store, db, expected, account, "inbox", page, &[])
    })
    .await
}
async fn confirm(
    source: &mut FakeApi,
    db: &Database,
    store: &archive_store::ArchiveStore,
    expected: &ArchiveIdentity,
    account: &Account,
    id: &str,
    cancel: &Cancellation,
) -> Result<bool> {
    let Some(item) = prepare_candidate(store, db, expected, id)? else {
        return Ok(true);
    };
    confirm_from_source(source, &item, cancel, |bytes| {
        mapped(cancel.check())?;
        check_connection(db, account)?;
        persist_confirmed(store, db, expected, id, bytes)
    })
    .await
}

#[tokio::test]
async fn both_api_kinds_share_pending_ignore_confirm_and_network_retry_without_early_mime() {
    for kind in [SourceKind::MicrosoftGraph, SourceKind::GmailApi] {
        let (_dir, mut db, store, account) = fixture(kind);
        let expected = store.identity();
        let cancel = Cancellation::default();
        let mut api = FakeApi::new(kind);
        for (id, subject) in [
            ("ignore@example.com", "Assessment"),
            ("unmatched@example.com", "Parcel delivered"),
        ] {
            api.messages.push(Metadata {
                locator: MessageLocator::Api {
                    source: kind,
                    message_id: id.into(),
                },
                header: Header::parse(&raw(id, subject)),
            });
        }
        scan(&mut api, &mut db, &store, &expected, &account, &cancel)
            .await
            .unwrap();
        assert_eq!(api.downloads, 0);
        let candidates = db.pending(&expected.archive_id, 100).unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(candidates.iter().all(|item| !item.reasons.is_empty()));
        assert!(store.list_evidence(None).unwrap().is_empty());
        let ignored = candidates
            .iter()
            .find(|item| item.header.subject.as_deref() == Some("Assessment"))
            .unwrap();
        db.finish(&expected.archive_id, &[ignored.id.clone()], true)
            .unwrap();
        scan(&mut api, &mut db, &store, &expected, &account, &cancel)
            .await
            .unwrap();
        assert_eq!(api.downloads, 0);
        let item = db.pending(&expected.archive_id, 100).unwrap().remove(0);
        api.fail_download = true;
        assert_eq!(
            confirm(&mut api, &db, &store, &expected, &account, &item.id, &cancel)
                .await
                .unwrap_err()
                .code,
            fail(Error::Network).code
        );
        assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 1);
        assert!(
            !confirm(&mut api, &db, &store, &expected, &account, &item.id, &cancel)
                .await
                .unwrap()
        );
        assert_eq!(store.list_evidence(None).unwrap().len(), 1);
        assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 0);
        assert_eq!(api.downloads, 2);
    }
}

#[tokio::test]
async fn interrupted_page_rolls_back_candidates_and_resumes_from_durable_position() {
    let (dir, mut db, store, account) = fixture(SourceKind::MicrosoftGraph);
    let expected = store.identity();
    let cancel = Cancellation::default();
    let mut api = FakeApi::new(account.source);
    let previous = Position::Api {
        source: account.source,
        cursor: "previous-page".into(),
    };
    db.commit_metadata(&expected.archive_id, &account.id, "inbox", &previous, &[])
        .unwrap();
    let sql = rusqlite::Connection::open(dir.path().join("mailboxes.sqlite")).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_page BEFORE UPDATE ON source_positions BEGIN SELECT RAISE(ABORT,'disk'); END;").unwrap();
    assert_eq!(
        scan(&mut api, &mut db, &store, &expected, &account, &cancel)
            .await
            .unwrap_err()
            .code,
        fail(Error::Storage).code
    );
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 0);
    assert!(
        db.source_position(&expected.archive_id, &account.id, "inbox")
            .unwrap()
            == Some(previous)
    );
    sql.execute_batch("DROP TRIGGER fail_page;").unwrap();
    drop(db);
    let mut db = Database::open(dir.path()).unwrap();
    api.fail_read = true;
    assert!(
        scan(&mut api, &mut db, &store, &expected, &account, &cancel)
            .await
            .is_err()
    );
    scan(&mut api, &mut db, &store, &expected, &account, &cancel)
        .await
        .unwrap();
    assert_eq!(api.requests, vec![Some("previous-page".into()); 3]);
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 1);
    assert_eq!(api.downloads, 0);
}

#[tokio::test]
async fn api_confirmation_retries_idempotently_after_archive_write_but_local_finish_failure() {
    let (dir, mut db, store, account) = fixture(SourceKind::GmailApi);
    let expected = store.identity();
    let cancel = Cancellation::default();
    let mut api = FakeApi::new(account.source);
    // Exercise the existing digest fallback as well as Message-ID deduplication.
    api.raw = b"From: hr@example.com\r\nSubject: Interview\r\n\r\nPrivate body".to_vec();
    api.messages[0].header = Header::parse(&api.raw);
    scan(&mut api, &mut db, &store, &expected, &account, &cancel)
        .await
        .unwrap();
    let id = db.pending(&expected.archive_id, 100).unwrap().remove(0).id;
    let sql = rusqlite::Connection::open(dir.path().join("mailboxes.sqlite")).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_finish BEFORE UPDATE OF state ON candidates BEGIN SELECT RAISE(ABORT,'disk'); END;").unwrap();
    assert!(
        confirm(&mut api, &db, &store, &expected, &account, &id, &cancel)
            .await
            .is_err()
    );
    assert_eq!(store.list_evidence(None).unwrap().len(), 1);
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 1);
    sql.execute_batch("DROP TRIGGER fail_finish;").unwrap();
    assert!(
        confirm(&mut api, &db, &store, &expected, &account, &id, &cancel)
            .await
            .unwrap()
    );
    assert_eq!(store.list_evidence(None).unwrap().len(), 1);
    assert_eq!(store.list_inbox_events().unwrap().len(), 1);
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 0);
}

#[tokio::test]
async fn manual_import_between_api_discovery_and_confirmation_skips_the_download() {
    let (_dir, mut db, store, account) = fixture(SourceKind::MicrosoftGraph);
    let expected = store.identity();
    let cancel = Cancellation::default();
    let mut api = FakeApi::new(account.source);
    scan(&mut api, &mut db, &store, &expected, &account, &cancel)
        .await
        .unwrap();
    let id = db.pending(&expected.archive_id, 100).unwrap().remove(0).id;
    evidence_commands::import_bytes(
        &store,
        store.archive_dir(),
        &api.raw,
        Some("manual.eml".into()),
        &evidence_commands::bucket_now(),
        None,
    )
    .unwrap();
    assert!(
        confirm(&mut api, &db, &store, &expected, &account, &id, &cancel)
            .await
            .unwrap()
    );
    assert_eq!(api.downloads, 0);
    scan(&mut api, &mut db, &store, &expected, &account, &cancel)
        .await
        .unwrap();
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 0);
    assert_eq!(store.list_evidence(None).unwrap().len(), 1);
}

#[tokio::test]
async fn cancelling_metadata_or_confirmation_leaves_progress_and_evidence_untouched() {
    let (_dir, mut db, store, account) = fixture(SourceKind::MicrosoftGraph);
    let expected = store.identity();
    let cancel = Arc::new(Cancellation::default());
    let mut api = FakeApi::new(account.source);
    api.cancel_read = Some(cancel.clone());
    assert_eq!(
        scan(&mut api, &mut db, &store, &expected, &account, &cancel)
            .await
            .unwrap_err()
            .code,
        fail(Error::Cancelled).code
    );
    assert!(db
        .source_position(&expected.archive_id, &account.id, "inbox")
        .unwrap()
        .is_none());
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 0);
    api.cancel_read = None;
    let cancel = Arc::new(Cancellation::default());
    scan(&mut api, &mut db, &store, &expected, &account, &cancel)
        .await
        .unwrap();
    let id = db.pending(&expected.archive_id, 100).unwrap().remove(0).id;
    api.cancel_download = Some(cancel.clone());
    assert_eq!(
        confirm(&mut api, &db, &store, &expected, &account, &id, &cancel)
            .await
            .unwrap_err()
            .code,
        fail(Error::Cancelled).code
    );
    assert!(store.list_evidence(None).unwrap().is_empty());
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 1);
}

#[tokio::test]
async fn a_restore_or_account_change_rejects_inflight_api_results() {
    let (_dir, mut db, store, account) = fixture(SourceKind::MicrosoftGraph);
    let mut before_restore = store.identity();
    before_restore.restore_epoch = uuid::Uuid::new_v4().to_string();
    let cancel = Cancellation::default();
    let mut api = FakeApi::new(account.source);
    assert_eq!(
        scan(
            &mut api,
            &mut db,
            &store,
            &before_restore,
            &account,
            &cancel
        )
        .await
        .unwrap_err()
        .code,
        fail(Error::Changed).code
    );
    assert_eq!(db.pending_count(&before_restore.archive_id).unwrap(), 0);
    assert!(db
        .source_position(&before_restore.archive_id, &account.id, "inbox")
        .unwrap()
        .is_none());
    let expected = store.identity();
    scan(&mut api, &mut db, &store, &expected, &account, &cancel)
        .await
        .unwrap();
    let item = db.pending(&expected.archive_id, 100).unwrap().remove(0);
    // Same archive ID, different restore epoch: reject after MIME download.
    let error = confirm_from_source(&mut api, &item, &cancel, |bytes| {
        persist_confirmed(&store, &db, &before_restore, &item.id, bytes)
    })
    .await
    .unwrap_err();
    assert_eq!(error.code, fail(Error::Changed).code);
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 1);
    assert!(store.list_evidence(None).unwrap().is_empty());
    db.delete_account(&account.id).unwrap();
    assert!(
        scan(&mut api, &mut db, &store, &expected, &account, &cancel)
            .await
            .is_err()
    );
    assert!(store.list_evidence(None).unwrap().is_empty());
}

#[tokio::test]
async fn api_download_checks_size_and_header_identity_before_importing() {
    let (_dir, mut db, store, account) = fixture(SourceKind::GmailApi);
    let expected = store.identity();
    let cancel = Cancellation::default();
    let mut api = FakeApi::new(account.source);
    scan(&mut api, &mut db, &store, &expected, &account, &cancel)
        .await
        .unwrap();
    let id = db.pending(&expected.archive_id, 100).unwrap().remove(0).id;
    api.raw = raw("another@example.com", "Interview");
    assert_eq!(
        confirm(&mut api, &db, &store, &expected, &account, &id, &cancel)
            .await
            .unwrap_err()
            .code,
        fail(Error::Changed).code
    );
    // Deliberately violate the adapter contract to test the shared size guard.
    api.ignore_size_limit = true;
    api.raw = vec![b'a'; evidence_import::MAX_ATTACHMENT_BYTES as usize + 1];
    assert_eq!(
        confirm(&mut api, &db, &store, &expected, &account, &id, &cancel)
            .await
            .unwrap_err()
            .code,
        fail(Error::TooLarge).code
    );
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 1);
    assert!(store.list_evidence(None).unwrap().is_empty());
}

#[tokio::test]
async fn wrong_account_or_cursor_kind_is_rejected_before_network_access() {
    let (_dir, mut db, store, account) = fixture(SourceKind::MicrosoftGraph);
    let expected = store.identity();
    let cancel = Cancellation::default();
    let mut api = FakeApi::new(account.source);
    scan(&mut api, &mut db, &store, &expected, &account, &cancel)
        .await
        .unwrap();
    let id = db.pending(&expected.archive_id, 100).unwrap().remove(0).id;
    api.account_id = "another-local-account".into();
    assert_eq!(
        scan(&mut api, &mut db, &store, &expected, &account, &cancel)
            .await
            .unwrap_err()
            .code,
        fail(Error::Changed).code
    );
    assert_eq!(
        confirm(&mut api, &db, &store, &expected, &account, &id, &cancel)
            .await
            .unwrap_err()
            .code,
        fail(Error::Changed).code
    );
    assert_eq!(api.requests.len(), 1);
    assert_eq!(api.downloads, 0);
    api.account_id = account.id.clone();
    let invalid = Position::Imap(Cursor {
        validity: 7,
        uid: 9,
    });
    let result: mailbox_sync::Result<bool> =
        source::scan_page(&mut api, "inbox", Some(&invalid), &cancel, |_| {
            panic!("must not commit")
        })
        .await;
    assert_eq!(result, Err(Error::Changed));
    assert_eq!(api.requests.len(), 1);
    assert!(store.list_evidence(None).unwrap().is_empty());
}

#[tokio::test]
async fn oversized_metadata_does_not_save_candidates_or_advance_progress() {
    let (_dir, mut db, store, account) = fixture(SourceKind::GmailApi);
    let expected = store.identity();
    let cancel = Cancellation::default();
    let mut api = FakeApi::new(account.source);
    api.messages = vec![api.messages[0].clone(); imap::BATCH_SIZE + 1];
    assert_eq!(
        scan(&mut api, &mut db, &store, &expected, &account, &cancel)
            .await
            .unwrap_err()
            .code,
        fail(Error::TooLarge).code
    );
    api.messages.truncate(1);
    api.messages[0].header.subject = Some("x".repeat(65537));
    assert_eq!(
        scan(&mut api, &mut db, &store, &expected, &account, &cancel)
            .await
            .unwrap_err()
            .code,
        fail(Error::TooLarge).code
    );
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 0);
    assert!(db
        .source_position(&expected.archive_id, &account.id, "inbox")
        .unwrap()
        .is_none());
    assert_eq!(api.downloads, 0);
}

#[tokio::test]
async fn an_empty_api_page_can_advance_without_retaining_unmatched_headers_or_bodies() {
    let (dir, mut db, store, account) = fixture(SourceKind::GmailApi);
    let expected = store.identity();
    let cancel = Cancellation::default();
    let mut api = FakeApi::new(account.source);
    api.messages[0].header.subject = Some("Unmatched parcel notification".into());
    scan(&mut api, &mut db, &store, &expected, &account, &cancel)
        .await
        .unwrap();
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 0);
    assert!(db
        .source_position(&expected.archive_id, &account.id, "inbox")
        .unwrap()
        .is_some());
    let sql = rusqlite::Connection::open(dir.path().join("mailboxes.sqlite")).unwrap();
    let count: u32 = sql
        .query_row("SELECT COUNT(*) FROM candidates", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    api.messages.clear();
    scan(&mut api, &mut db, &store, &expected, &account, &cancel)
        .await
        .unwrap();
    assert_eq!(
        api.requests,
        vec![None, Some("opaque-next-page-or-delta".into())]
    );
    assert_eq!(api.downloads, 0);
}

#[tokio::test]
async fn cancelling_a_pending_metadata_request_stops_without_waiting_for_network_timeout() {
    let (_dir, mut db, store, account) = fixture(SourceKind::MicrosoftGraph);
    let expected = store.identity();
    let cancel = Cancellation::default();
    let mut api = FakeApi::new(account.source);
    let (started, request_started) = tokio::sync::oneshot::channel();
    api.pending_read = Some(started);
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        tokio::join!(
            scan(&mut api, &mut db, &store, &expected, &account, &cancel),
            async {
                request_started.await.unwrap();
                cancel.cancel();
            },
        )
    })
    .await
    .expect("cancellation must stop the pending request");
    assert_eq!(result.unwrap_err().code, fail(Error::Cancelled).code);
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 0);
    assert!(db
        .source_position(&expected.archive_id, &account.id, "inbox")
        .unwrap()
        .is_none());
    assert_eq!(api.downloads, 0);
}

#[tokio::test]
async fn cancelling_a_pending_mime_download_keeps_the_candidate_available_for_retry() {
    let (_dir, mut db, store, account) = fixture(SourceKind::GmailApi);
    let expected = store.identity();
    let cancel = Cancellation::default();
    let mut api = FakeApi::new(account.source);
    scan(&mut api, &mut db, &store, &expected, &account, &cancel)
        .await
        .unwrap();
    let id = db.pending(&expected.archive_id, 100).unwrap().remove(0).id;
    let (started, request_started) = tokio::sync::oneshot::channel();
    api.pending_download = Some(started);
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        tokio::join!(
            confirm(&mut api, &db, &store, &expected, &account, &id, &cancel),
            async {
                request_started.await.unwrap();
                cancel.cancel();
            },
        )
    })
    .await
    .expect("cancellation must stop the pending download");
    assert_eq!(result.unwrap_err().code, fail(Error::Cancelled).code);
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 1);
    assert!(store.list_evidence(None).unwrap().is_empty());
    assert!(!confirm(
        &mut api,
        &db,
        &store,
        &expected,
        &account,
        &id,
        &Cancellation::default()
    )
    .await
    .unwrap());
    assert_eq!(store.list_evidence(None).unwrap().len(), 1);
}

#[tokio::test]
async fn api_pagination_resumes_after_restart_from_the_last_committed_page() {
    let (dir, mut db, store, account) = fixture(SourceKind::MicrosoftGraph);
    let expected = store.identity();
    let cancel = Cancellation::default();
    let mut api = FakeApi::new(account.source);
    let second = Metadata {
        locator: MessageLocator::Api {
            source: account.source,
            message_id: "second-page-message".into(),
        },
        header: Header::parse(&raw("second@example.com", "Assessment")),
    };
    api.pages = Some(vec![api.messages.clone(), vec![second], vec![]]);
    assert!(
        scan(&mut api, &mut db, &store, &expected, &account, &cancel)
            .await
            .unwrap()
    );
    api.fail_read = true;
    assert_eq!(
        scan(&mut api, &mut db, &store, &expected, &account, &cancel)
            .await
            .unwrap_err()
            .code,
        fail(Error::Network).code
    );
    drop(db);
    let mut db = Database::open(dir.path()).unwrap();
    assert!(
        scan(&mut api, &mut db, &store, &expected, &account, &cancel)
            .await
            .unwrap()
    );
    assert!(
        !scan(&mut api, &mut db, &store, &expected, &account, &cancel)
            .await
            .unwrap()
    );
    assert_eq!(
        api.requests,
        vec![
            None,
            Some("page:1".into()),
            Some("page:1".into()),
            Some("page:2".into())
        ]
    );
    assert_eq!(db.pending_count(&expected.archive_id).unwrap(), 2);
    assert!(
        db.source_position(&expected.archive_id, &account.id, "inbox")
            .unwrap()
            == Some(Position::Api {
                source: account.source,
                cursor: "page:3".into()
            })
    );
    assert_eq!(api.downloads, 0);
}
