use archive_store::{ArchiveConfig, ArchiveStore, StoreError};
use serde_json::json;

const IMPORT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn open() -> (tempfile::TempDir, ArchiveConfig, ArchiveStore) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = ArchiveConfig::new(dir.path().join("archive"), dir.path().join("current.json"));
    let store = ArchiveStore::open(cfg.clone()).unwrap();
    (dir, cfg, store)
}

fn manifest(total: i64) -> serde_json::Value {
    json!({
        "pluginVersion": "0.4.0", "total": total,
        "parts": (1..=total).map(|index| json!({
            "index": index,
            "kind": if index == 1 { "template" } else { "profile" },
            "sha256": HASH
        })).collect::<Vec<_>>()
    })
}

#[test]
fn manifest_parts_and_retries_are_durable_and_conflicts_do_not_overwrite() {
    let (_dir, _cfg, store) = open();
    let status = store.receive_legacy_manifest(IMPORT, manifest(2)).unwrap();
    assert_eq!((status.state.as_str(), status.received, status.total), ("receiving", 0, 2));
    assert_eq!(store.receive_legacy_manifest(IMPORT, manifest(2)).unwrap().received, 0);
    assert!(matches!(store.receive_legacy_manifest(OTHER, manifest(1)), Err(StoreError::Conflict(_))));

    let template = json!({"name":"First","wasActive":true,"groups":[{"name":"Basic","fields":[{"key":"Name","value":"Alice"}]}]});
    let status = store.receive_legacy_part(IMPORT, 1, "template", HASH, template.clone()).unwrap();
    assert_eq!((status.state.as_str(), status.received), ("receiving", 1));
    assert_eq!(store.receive_legacy_part(IMPORT, 1, "template", HASH, template).unwrap().received, 1);
    assert!(matches!(
        store.receive_legacy_part(IMPORT, 1, "template", &"b".repeat(64), json!({})),
        Err(StoreError::Conflict(_))
    ));
    let profile = json!({"values":{},"family":[],"custom":[]});
    let status = store.receive_legacy_part(IMPORT, 2, "profile", HASH, profile).unwrap();
    assert_eq!((status.state.as_str(), status.received), ("awaiting_confirmation", 2));
    assert_eq!(store.legacy_import_status(IMPORT).unwrap().received, 2);
}

#[test]
fn ai_config_key_is_never_written_to_sqlite() {
    let (_dir, cfg, store) = open();
    let manifest = json!({"pluginVersion":"0.4.0","total":1,"parts":[{"index":1,"kind":"aiConfig","sha256":HASH}]});
    store.receive_legacy_manifest(IMPORT, manifest).unwrap();
    let raw = json!({"apiUrl":"https://api.example.com/v1","model":"m","apiKey":"sk-synthetic-secret"});
    assert!(matches!(store.receive_legacy_part(IMPORT, 1, "aiConfig", HASH, raw), Err(StoreError::Validation(_))));
    let safe = json!({"apiUrl":"https://api.example.com/v1","model":"m","hasKey":true});
    store.receive_legacy_part(IMPORT, 1, "aiConfig", HASH, safe).unwrap();
    let conn = rusqlite::Connection::open(cfg.db_path()).unwrap();
    let stored: String = conn.query_row("SELECT body_json FROM legacy_import_parts WHERE import_id = ?1", [IMPORT], |row| row.get(0)).unwrap();
    assert!(!stored.contains("sk-synthetic-secret"));
    assert!(!stored.contains("apiKey"));
    assert!(stored.contains("hasKey"));
}

#[test]
fn confirmation_imports_templates_and_profile_once() {
    let (_dir, cfg, store) = open();
    store.receive_legacy_manifest(IMPORT, manifest(2)).unwrap();
    let template = json!({"name":"First","wasActive":true,"groups":[{"name":"Basic","fields":[{"key":"Name","value":"Alice"}]}]});
    store.receive_legacy_part(IMPORT, 1, "template", HASH, template).unwrap();
    let profile = json!({"values":{"fullName":"Alice"},"family":[],"custom":[]});
    store.receive_legacy_part(IMPORT, 2, "profile", HASH, profile.clone()).unwrap();
    let applied = store.apply_legacy_confirmation(IMPORT).unwrap();
    assert_eq!(applied.status.state, "imported");
    assert!(applied.ai_config.is_none());
    assert_eq!(store.resume_overview().unwrap().templates.len(), 1);
    assert_eq!(store.get_profile().unwrap().profile, profile);
    assert_eq!(store.apply_legacy_confirmation(IMPORT).unwrap().status.state, "imported");
    assert_eq!(store.resume_overview().unwrap().templates.len(), 1);
    let db = rusqlite::Connection::open(cfg.db_path()).unwrap();
    let bodies: Vec<String> = db.prepare("SELECT body_json FROM legacy_import_parts WHERE import_id = ?1")
        .unwrap().query_map([IMPORT], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(bodies, vec!["{}", "{}"]);
}

#[test]
fn existing_profile_conflict_rolls_back_all_imported_templates() {
    let (_dir, _cfg, store) = open();
    store.save_profile(json!({"values":{"fullName":"Existing"},"family":[],"custom":[]}), 0).unwrap();
    store.receive_legacy_manifest(IMPORT, manifest(2)).unwrap();
    store.receive_legacy_part(IMPORT, 1, "template", HASH,
        json!({"name":"First","wasActive":true,"groups":[{"name":"Basic","fields":[{"key":"Name","value":"Alice"}]}]})).unwrap();
    store.receive_legacy_part(IMPORT, 2, "profile", HASH,
        json!({"values":{"fullName":"Alice"},"family":[],"custom":[]})).unwrap();
    assert!(matches!(store.apply_legacy_confirmation(IMPORT), Err(StoreError::Conflict(_))));
    assert!(store.resume_overview().unwrap().templates.is_empty());
    assert_eq!(store.legacy_import_status(IMPORT).unwrap().state, "awaiting_confirmation");
}

#[test]
fn ai_confirmation_can_retry_after_credentials_fail_without_copying_templates_again() {
    let (_dir, cfg, store) = open();
    let manifest = json!({"pluginVersion":"0.4.0","total":2,"parts":[
        {"index":1,"kind":"template","sha256":HASH}, {"index":2,"kind":"aiConfig","sha256":HASH}
    ]});
    store.receive_legacy_manifest(IMPORT, manifest).unwrap();
    store.receive_legacy_part(IMPORT, 1, "template", HASH,
        json!({"name":"First","wasActive":true,"groups":[{"name":"Basic","fields":[{"key":"Name","value":"Alice"}]}]})).unwrap();
    let ai = json!({"apiUrl":"https://api.example.com/v1","model":"m","hasKey":true});
    store.receive_legacy_part(IMPORT, 2, "aiConfig", HASH, ai.clone()).unwrap();
    let first = store.apply_legacy_confirmation(IMPORT).unwrap();
    assert_eq!(first.status.state, "awaiting_confirmation");
    assert_eq!(first.ai_config, Some(ai.clone()));
    assert_eq!(store.resume_overview().unwrap().templates.len(), 1);
    let second = store.apply_legacy_confirmation(IMPORT).unwrap();
    assert_eq!(second.ai_config, Some(ai));
    assert_eq!(store.resume_overview().unwrap().templates.len(), 1);
    assert_eq!(store.finish_legacy_confirmation(IMPORT).unwrap().state, "imported");
    let db = rusqlite::Connection::open(cfg.db_path()).unwrap();
    let bodies: Vec<String> = db.prepare("SELECT body_json FROM legacy_import_parts WHERE import_id = ?1")
        .unwrap().query_map([IMPORT], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(bodies, vec!["{}", "{}"]);
}

#[test]
fn stale_incomplete_import_expires_and_releases_the_single_active_slot() {
    let (_dir, _cfg, store) = open();
    store.receive_legacy_manifest(IMPORT, manifest(2)).unwrap();
    let now = (time::OffsetDateTime::now_utc() + time::Duration::hours(25))
        .format(&time::format_description::well_known::Rfc3339).unwrap();
    assert_eq!(store.expire_legacy_imports(&now).unwrap(), vec![IMPORT.to_string()]);
    assert_eq!(store.legacy_import_status(IMPORT).unwrap().state, "expired");
    assert_eq!(store.receive_legacy_manifest(OTHER, manifest(1)).unwrap().state, "receiving");
}

#[test]
fn a_v4_archive_migrates_to_v5_without_losing_resume_data() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = ArchiveConfig::new(dir.path().join("archive"), dir.path().join("current.json"));
    let old = ArchiveStore::open_with_migrations(cfg.clone(), &archive_store::migration::MIGRATIONS[..4]).unwrap();
    old.create_template("Before migration", vec![archive_store::TemplateGroup {
        name: "Basic".into(), fields: vec![archive_store::TemplateField { key: "Name".into(), value: "Alice".into() }],
    }]).unwrap();
    old.close().unwrap();
    let upgraded = ArchiveStore::open(cfg.clone()).unwrap();
    assert_eq!(archive_store::current_schema_version(), 5);
    assert!(upgraded.migration_backup.as_ref().is_some_and(|path| path.is_file()));
    assert_eq!(upgraded.resume_overview().unwrap().templates.len(), 1);
    upgraded.receive_legacy_manifest(IMPORT, manifest(1)).unwrap();
    let raw = rusqlite::Connection::open(cfg.db_path()).unwrap();
    let version: i64 = raw.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
    assert_eq!(version, 5);
}
