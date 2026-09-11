//! D08: snapshot chunk bytes are staged in the archive with their receipt, and a complete
//! upload becomes a snapshot file plus a snapshot row only after every byte is accounted for.

use archive_store::schema::MIGRATIONS;
use archive_store::*;
use sha2::{Digest, Sha256};

const CLIENT: &str = "client-a";
const SNAPSHOT: &str = "66666666-6666-4666-8666-666666666666";

fn config(root: &std::path::Path) -> ArchiveConfig {
    ArchiveConfig::new(root.join("archive"), root.join("current.json"))
}

fn app() -> NewApplication {
    NewApplication {
        company: "合成公司".into(),
        title: "研发".into(),
        source_url: None,
        location: None,
        notes: None,
        origin: ApplicationOrigin::Manual,
        occurred_at: Occurred::Unknown,
    }
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// A snapshot in the v1 format the plugin writes (link/snapshot.mjs), synthetic content.
fn snapshot_v1() -> Vec<u8> {
    let filler = "合成经历描述".repeat(40);
    let fields: Vec<String> = (0..60)
        .map(|i| format!(r#"{{"key":"项目{i}","value":"{filler}"}}"#))
        .collect();
    format!(
        r#"{{"capturedAt":"2026-09-12T08:00:00.000Z","format":"resume-pro.snapshot","formatVersion":1,"groups":[{{"fields":[{}],"name":"经历"}}],"omittedFieldCount":0,"templateName":"合成模板","templateVersion":"0123456789ab"}}"#,
        fields.join(",")
    )
    .into_bytes()
}

struct Upload {
    bytes: Vec<u8>,
    chunk_size: usize,
    total_sha: String,
}

impl Upload {
    fn new(bytes: Vec<u8>, chunk_size: usize) -> Self {
        let total_sha = sha(&bytes);
        Self { bytes, chunk_size, total_sha }
    }

    fn count(&self) -> i64 {
        self.bytes.len().div_ceil(self.chunk_size) as i64
    }

    fn piece(&self, index: i64) -> Vec<u8> {
        let start = index as usize * self.chunk_size;
        let end = (start + self.chunk_size).min(self.bytes.len());
        self.bytes[start..end].to_vec()
    }

    fn op(&self, app_id: &str, index: i64) -> PluginOp {
        let bytes = self.piece(index);
        PluginOp::SnapshotChunk(SnapshotChunkInput {
            application_id: Some(app_id.into()),
            snapshot_id: SNAPSHOT.into(),
            chunk_index: index,
            chunk_count: self.count(),
            total_sha256: self.total_sha.clone(),
            byte_size: self.bytes.len() as i64,
            chunk_sha256: sha(&bytes),
            template_name: None,
            template_version: None,
            bytes,
        })
    }

    fn send(&self, store: &ArchiveStore, app_id: &str, index: i64) -> Result<PluginWriteOutcome, StoreError> {
        let op = self.op(app_id, index);
        let ctx = PluginWriteContext {
            envelope_identity: Some(store.identity()),
            client_instance_id: CLIENT.into(),
            message_id: format!("chunk-message-{index}"),
            source_restore_epoch: store.identity().restore_epoch,
            payload_sha256: op.digest().unwrap(),
        };
        store.submit_plugin_message(&ctx, op)
    }
}

#[test]
fn a_complete_upload_becomes_one_snapshot_file_and_its_staging_is_cleared() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    let a = db.create_application(app()).unwrap();
    let upload = Upload::new(snapshot_v1(), 4096);
    assert!(upload.count() >= 3, "the synthetic snapshot must span several chunks");

    for index in 0..upload.count() {
        upload.send(&db, &a.id, index).unwrap();
    }
    let staged = db.snapshot_progress(CLIENT, SNAPSHOT).unwrap();
    assert_eq!(staged.chunk_cursor, upload.count());
    assert_eq!(staged.staged_bytes, upload.bytes.len() as i64);
    assert!(!staged.full_acked);

    let meta = match db.complete_snapshot_upload(CLIENT, SNAPSHOT).unwrap() {
        SnapshotCompletion::Completed(meta) => meta,
        other => panic!("expected a completed snapshot, got {other:?}"),
    };
    assert_eq!(meta.sha256, upload.total_sha);
    assert_eq!(meta.byte_size, upload.bytes.len() as i64);
    assert_eq!(meta.application_id, a.id);
    assert_eq!(meta.stored_rel_path, format!("snapshots/{SNAPSHOT}.json"));
    // The chunk envelope has no template name; it comes from the verified content.
    assert_eq!(meta.template_name, "合成模板");
    assert_eq!(meta.template_version.as_deref(), Some("0123456789ab"));
    assert_eq!(std::fs::read(cfg.archive_dir.join(&meta.stored_rel_path)).unwrap(), upload.bytes);

    let settled = db.snapshot_progress(CLIENT, SNAPSHOT).unwrap();
    assert!(settled.full_acked);
    assert_eq!(settled.staged_bytes, 0, "staged chunk bytes go once the file is the copy");
    assert_eq!(db.list_snapshots(&a.id).unwrap().len(), 1);

    // A second completion (the plugin resending after a lost complete ACK) is idempotent.
    match db.complete_snapshot_upload(CLIENT, SNAPSHOT).unwrap() {
        SnapshotCompletion::AlreadyComplete(again) => assert_eq!(again.sha256, meta.sha256),
        other => panic!("expected the finished snapshot again, got {other:?}"),
    }
    assert_eq!(db.list_snapshots(&a.id).unwrap().len(), 1);
}

#[test]
fn a_replayed_completion_is_refused_when_the_snapshot_file_is_gone_or_altered() {
    // The plugin deletes its only copy on a complete ACK, so a replay must not say "complete"
    // on the strength of the database row alone.
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    let a = db.create_application(app()).unwrap();
    let upload = Upload::new(snapshot_v1(), 4096);
    for index in 0..upload.count() {
        upload.send(&db, &a.id, index).unwrap();
    }
    let meta = match db.complete_snapshot_upload(CLIENT, SNAPSHOT).unwrap() {
        SnapshotCompletion::Completed(meta) => meta,
        other => panic!("expected a completed snapshot, got {other:?}"),
    };
    let file = cfg.archive_dir.join(&meta.stored_rel_path);

    std::fs::write(&file, b"altered").unwrap();
    assert!(db.complete_snapshot_upload(CLIENT, SNAPSHOT).is_err());

    std::fs::remove_file(&file).unwrap();
    assert!(db.complete_snapshot_upload(CLIENT, SNAPSHOT).is_err());

    std::fs::write(&file, &upload.bytes).unwrap();
    assert!(matches!(
        db.complete_snapshot_upload(CLIENT, SNAPSHOT).unwrap(),
        SnapshotCompletion::AlreadyComplete(_)
    ));
}

#[test]
fn chunk_bytes_that_do_not_match_their_digest_are_refused_and_nothing_is_staged() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let a = db.create_application(app()).unwrap();
    let upload = Upload::new(snapshot_v1(), 4096);
    let mut op = upload.op(&a.id, 0);
    if let PluginOp::SnapshotChunk(ref mut input) = op {
        input.bytes[0] ^= 0xff;
    }
    let ctx = PluginWriteContext {
        envelope_identity: Some(db.identity()),
        client_instance_id: CLIENT.into(),
        message_id: "chunk-message-0".into(),
        source_restore_epoch: db.identity().restore_epoch,
        payload_sha256: op.digest().unwrap(),
    };
    assert!(matches!(db.submit_plugin_message(&ctx, op), Err(StoreError::Validation(_))));
    assert!(matches!(db.snapshot_progress(CLIENT, SNAPSHOT), Err(StoreError::NotFound(_))));
}

#[test]
fn an_upload_resumes_across_a_restart_because_progress_lives_in_the_archive() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    let a = db.create_application(app()).unwrap();
    let upload = Upload::new(snapshot_v1(), 4096);
    upload.send(&db, &a.id, 0).unwrap();
    db.close().unwrap();

    let db = ArchiveStore::open(cfg).unwrap();
    for index in 1..upload.count() {
        upload.send(&db, &a.id, index).unwrap();
    }
    assert!(matches!(
        db.complete_snapshot_upload(CLIENT, SNAPSHOT).unwrap(),
        SnapshotCompletion::Completed(_)
    ));
}

#[test]
fn a_gap_leaves_the_upload_incomplete_and_the_cursor_short_of_it() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let a = db.create_application(app()).unwrap();
    let upload = Upload::new(snapshot_v1(), 4096);
    upload.send(&db, &a.id, 0).unwrap();
    upload.send(&db, &a.id, 2).unwrap();
    match db.complete_snapshot_upload(CLIENT, SNAPSHOT).unwrap() {
        SnapshotCompletion::Incomplete(progress) => {
            assert_eq!(progress.chunk_cursor, 1);
            assert_eq!(progress.received_chunks, vec![0, 2]);
        }
        other => panic!("expected an incomplete upload, got {other:?}"),
    }
    assert!(db.get_snapshot(SNAPSHOT).unwrap().is_none());
}

#[test]
fn a_wrong_total_digest_never_becomes_a_snapshot_and_keeps_the_chunks() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let a = db.create_application(app()).unwrap();
    let mut upload = Upload::new(snapshot_v1(), 4096);
    upload.total_sha = "0".repeat(64);
    for index in 0..upload.count() {
        upload.send(&db, &a.id, index).unwrap();
    }
    assert!(db.complete_snapshot_upload(CLIENT, SNAPSHOT).is_err());
    assert!(db.get_snapshot(SNAPSHOT).unwrap().is_none());
    assert_eq!(
        db.snapshot_progress(CLIENT, SNAPSHOT).unwrap().staged_bytes,
        upload.bytes.len() as i64
    );
}

#[test]
fn a_failed_file_write_keeps_the_chunks_for_the_next_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    let a = db.create_application(app()).unwrap();
    let upload = Upload::new(snapshot_v1(), 4096);
    for index in 0..upload.count() {
        upload.send(&db, &a.id, index).unwrap();
    }
    // A file where the snapshots directory should be: the write cannot happen.
    let snapshots = cfg.archive_dir.join("snapshots");
    let _ = std::fs::remove_dir_all(&snapshots);
    std::fs::write(&snapshots, b"not a directory").unwrap();
    assert!(db.complete_snapshot_upload(CLIENT, SNAPSHOT).is_err());
    assert!(db.get_snapshot(SNAPSHOT).unwrap().is_none());
    assert!(!db.snapshot_progress(CLIENT, SNAPSHOT).unwrap().full_acked);

    std::fs::remove_file(&snapshots).unwrap();
    assert!(matches!(
        db.complete_snapshot_upload(CLIENT, SNAPSHOT).unwrap(),
        SnapshotCompletion::Completed(_)
    ));
}

#[test]
fn content_in_an_unknown_format_is_stored_under_an_unknown_template_name() {
    let dir = tempfile::tempdir().unwrap();
    let db = ArchiveStore::open(config(dir.path())).unwrap();
    let a = db.create_application(app()).unwrap();
    let upload = Upload::new(b"not a snapshot document, but every byte was acknowledged".to_vec(), 16);
    for index in 0..upload.count() {
        upload.send(&db, &a.id, index).unwrap();
    }
    match db.complete_snapshot_upload(CLIENT, SNAPSHOT).unwrap() {
        SnapshotCompletion::Completed(meta) => {
            assert_eq!(meta.template_name, "unknown");
            assert_eq!(meta.template_version, None);
        }
        other => panic!("expected a completed snapshot, got {other:?}"),
    }
}

#[test]
fn purging_the_application_also_drops_staged_chunk_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let db = ArchiveStore::open(cfg.clone()).unwrap();
    let a = db.create_application(app()).unwrap();
    let upload = Upload::new(snapshot_v1(), 4096);
    upload.send(&db, &a.id, 0).unwrap();
    db.purge_application(&a.id).unwrap();
    db.close().unwrap();
    let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
    let staged: i64 = raw
        .query_row("SELECT COUNT(*) FROM snapshot_chunk_bytes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(staged, 0);
}

#[test]
fn a_version_one_archive_is_upgraded_with_a_backup() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let v1 = &MIGRATIONS[..1];
    let db = ArchiveStore::open_with_migrations(cfg.clone(), v1).unwrap();
    let id = db.create_application(app()).unwrap().id.clone();
    db.close().unwrap();

    let db = ArchiveStore::open(cfg.clone()).unwrap();
    assert_eq!(db.schema_version(), 2);
    assert!(db.migration_backup.as_ref().unwrap().exists());
    assert!(db.get_application(&id).unwrap().is_some());
    db.close().unwrap();

    let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
    let tables: i64 = raw
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='snapshot_chunk_bytes'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tables, 1);
}
