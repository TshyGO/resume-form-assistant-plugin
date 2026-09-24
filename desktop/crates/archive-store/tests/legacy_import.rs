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

fn template_body(name: &str) -> serde_json::Value {
    json!({"name":name,"wasActive":false,"groups":[{"name":"Basic","fields":[{"key":"Name","value":"Alice"}]}]})
}

fn manifest_of(kinds: &[&str]) -> serde_json::Value {
    json!({
        "pluginVersion": "0.4.0", "total": kinds.len(),
        "parts": kinds.iter().enumerate().map(|(i, kind)| json!({
            "index": i + 1, "kind": kind, "sha256": HASH
        })).collect::<Vec<_>>()
    })
}

#[test]
fn manifest_limits_each_kind_to_what_the_desktop_can_hold() {
    let (_dir, _cfg, store) = open();
    let too_many_templates = vec!["template"; archive_store::MAX_TEMPLATES + 1];
    assert!(matches!(store.receive_legacy_manifest(IMPORT, manifest_of(&too_many_templates)), Err(StoreError::Validation(_))));
    assert!(matches!(store.receive_legacy_manifest(IMPORT, manifest_of(&["profile", "profile"])), Err(StoreError::Validation(_))));
    assert!(matches!(store.receive_legacy_manifest(IMPORT, manifest_of(&["aiConfig", "aiConfig"])), Err(StoreError::Validation(_))));
    let mut full = vec!["template"; archive_store::MAX_TEMPLATES];
    full.extend(["profile", "aiConfig"]);
    assert_eq!(store.receive_legacy_manifest(IMPORT, manifest_of(&full)).unwrap().total, 27);
}

#[test]
fn confirmation_refuses_to_overflow_the_template_limit_and_reports_both_counts() {
    let (_dir, _cfg, store) = open();
    for i in 0..archive_store::MAX_TEMPLATES - 1 {
        store.create_template(&format!("Existing {i}"), vec![archive_store::TemplateGroup {
            name: "Basic".into(), fields: vec![archive_store::TemplateField { key: "Name".into(), value: "Alice".into() }],
        }]).unwrap();
    }
    store.receive_legacy_manifest(IMPORT, manifest_of(&["template", "template"])).unwrap();
    store.receive_legacy_part(IMPORT, 1, "template", HASH, template_body("First")).unwrap();
    store.receive_legacy_part(IMPORT, 2, "template", HASH, template_body("Second")).unwrap();
    assert_eq!(store.legacy_template_overflow(IMPORT).unwrap(), Some((24, 2)));
    assert!(matches!(store.apply_legacy_confirmation(IMPORT), Err(StoreError::Validation(_))));
    assert_eq!(store.resume_overview().unwrap().templates.len(), 24);
    assert_eq!(store.legacy_import_status(IMPORT).unwrap().state, "awaiting_confirmation");

    let first = store.resume_overview().unwrap().templates[0].id.clone();
    store.delete_template(&first).unwrap();
    assert_eq!(store.legacy_template_overflow(IMPORT).unwrap(), None);
    assert_eq!(store.apply_legacy_confirmation(IMPORT).unwrap().status.state, "imported");
    // Once applied, its own templates are no longer "incoming".
    assert_eq!(store.legacy_template_overflow(IMPORT).unwrap(), None);
}

#[test]
fn only_an_incomplete_batch_expires() {
    let (_dir, _cfg, store) = open();
    store.receive_legacy_manifest(IMPORT, manifest_of(&["template"])).unwrap();
    store.receive_legacy_part(IMPORT, 1, "template", HASH, template_body("First")).unwrap();
    let later = (time::OffsetDateTime::now_utc() + time::Duration::hours(25))
        .format(&time::format_description::well_known::Rfc3339).unwrap();
    assert!(store.expire_legacy_imports(&later).unwrap().is_empty());
    assert_eq!(store.legacy_import_status(IMPORT).unwrap().state, "awaiting_confirmation");
}

#[test]
fn parts_are_checked_on_receipt_like_confirmation_would() {
    let (_dir, _cfg, store) = open();
    store.receive_legacy_manifest(IMPORT, manifest_of(&["template", "profile"])).unwrap();
    let bad = |index: i64, kind: &str, body: serde_json::Value| {
        assert!(matches!(store.receive_legacy_part(IMPORT, index, kind, HASH, body), Err(StoreError::Validation(_))), "{kind}");
    };
    bad(1, "template", json!({"groups":[{"name":"Basic","fields":[{"key":"Name","value":"Alice"}]}]}));
    bad(1, "template", json!({"name":"Blank","groups":[{"name":"Basic","fields":[{"key":"  ","value":"x"}]}]}));
    bad(1, "template", json!({"name":"Shape","groups":"not groups"}));
    bad(1, "template", json!({"name":"Huge","groups":[{"name":"Basic","fields":[
        {"key":"Name","value":"a".repeat(archive_store::MAX_TEMPLATE_BYTES)}
    ]}]}));
    bad(2, "profile", json!({"values":{"fullName":1},"family":[],"custom":[]}));
    bad(2, "profile", json!({"values":{},"family":[],"custom":[{"key":"邮箱密码","value":"hunter2"}]}));
    assert_eq!(store.legacy_import_status(IMPORT).unwrap().received, 0);
    store.receive_legacy_part(IMPORT, 1, "template", HASH, template_body("First")).unwrap();
    store.receive_legacy_part(IMPORT, 2, "profile", HASH, json!({"values":{},"family":[],"custom":[]})).unwrap();
    assert_eq!(store.legacy_import_status(IMPORT).unwrap().state, "awaiting_confirmation");
}

#[test]
fn part_check_reports_whether_the_part_is_new_and_the_import_state() {
    let (_dir, _cfg, store) = open();
    store.receive_legacy_manifest(IMPORT, manifest_of(&["template"])).unwrap();
    let fresh = store.check_legacy_part(IMPORT, 1, "template", HASH).unwrap();
    assert_eq!((fresh.is_new, fresh.state.as_str()), (true, "receiving"));
    store.receive_legacy_part(IMPORT, 1, "template", HASH, template_body("First")).unwrap();
    let again = store.check_legacy_part(IMPORT, 1, "template", HASH).unwrap();
    assert_eq!((again.is_new, again.state.as_str()), (false, "awaiting_confirmation"));
    store.apply_legacy_confirmation(IMPORT).unwrap();
    let done = store.check_legacy_part(IMPORT, 1, "template", HASH).unwrap();
    assert_eq!((done.is_new, done.state.as_str()), (false, "imported"));
}

#[test]
fn rejecting_an_applied_import_finishes_it_without_the_ai_config_and_frees_the_slot() {
    let (_dir, cfg, store) = open();
    store.receive_legacy_manifest(IMPORT, manifest_of(&["template", "aiConfig"])).unwrap();
    store.receive_legacy_part(IMPORT, 1, "template", HASH, template_body("First")).unwrap();
    store.receive_legacy_part(IMPORT, 2, "aiConfig", HASH,
        json!({"apiUrl":"https://api.example.com/v1","model":"m","hasKey":true})).unwrap();
    assert_eq!(store.apply_legacy_confirmation(IMPORT).unwrap().status.state, "awaiting_confirmation");
    assert!(matches!(store.receive_legacy_manifest(OTHER, manifest_of(&["template"])), Err(StoreError::Conflict(_))));

    assert_eq!(store.reject_legacy_import(IMPORT).unwrap().state, "imported");
    assert_eq!(store.reject_legacy_import(IMPORT).unwrap().state, "imported");
    assert_eq!(store.resume_overview().unwrap().templates.len(), 1);
    let db = rusqlite::Connection::open(cfg.db_path()).unwrap();
    let bodies: Vec<String> = db.prepare("SELECT body_json FROM legacy_import_parts WHERE import_id = ?1")
        .unwrap().query_map([IMPORT], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(bodies, vec!["{}", "{}"]);
    let dropped: i64 = db.query_row("SELECT ai_config_dropped FROM legacy_imports WHERE import_id = ?1", [IMPORT], |row| row.get(0)).unwrap();
    assert_eq!(dropped, 1);
    assert_eq!(store.receive_legacy_manifest(OTHER, manifest_of(&["template"])).unwrap().state, "receiving");
}

#[test]
fn rejecting_an_unapplied_import_still_discards_it() {
    let (_dir, _cfg, store) = open();
    store.receive_legacy_manifest(IMPORT, manifest_of(&["template"])).unwrap();
    store.receive_legacy_part(IMPORT, 1, "template", HASH, template_body("First")).unwrap();
    assert_eq!(store.reject_legacy_import(IMPORT).unwrap().state, "rejected");
    assert!(store.resume_overview().unwrap().templates.is_empty());
}

#[test]
fn startup_cleanup_lists_each_finished_ai_import_until_its_key_is_cleaned() {
    let (_dir, cfg, store) = open();
    store.receive_legacy_manifest(IMPORT, manifest_of(&["aiConfig"])).unwrap();
    store.reject_legacy_import(IMPORT).unwrap();
    store.receive_legacy_manifest(OTHER, manifest_of(&["template"])).unwrap();
    store.reject_legacy_import(OTHER).unwrap();
    // A row this build cannot read is skipped rather than blocking every other cleanup.
    let db = rusqlite::Connection::open(cfg.db_path()).unwrap();
    db.execute(
        "INSERT INTO legacy_imports (import_id, state, total, manifest_json, plugin_version, created_at, updated_at) \
         VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'expired', 1, 'not json', '0.4.0', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        [],
    ).unwrap();
    let pending = store.legacy_import_cleanup_ids().unwrap();
    assert_eq!(pending.ids, vec![IMPORT.to_string()]);
    assert_eq!(pending.skipped, 1);
    store.mark_legacy_key_cleaned(IMPORT).unwrap();
    assert!(store.legacy_import_cleanup_ids().unwrap().ids.is_empty());
}
