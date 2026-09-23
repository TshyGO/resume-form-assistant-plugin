use archive_store::*;

fn config(root: &std::path::Path) -> ArchiveConfig {
    ArchiveConfig::new(root.join("archive"), root.join("current.json"))
}

fn open(root: &std::path::Path) -> ArchiveStore {
    ArchiveStore::open(config(root)).unwrap()
}

#[test]
fn a_new_archive_is_on_schema_v4() {
    let dir = tempfile::tempdir().unwrap();
    let _db = open(dir.path());
    assert_eq!(current_schema_version(), 4);
    let raw = rusqlite::Connection::open(config(dir.path()).db_path()).unwrap();
    let tables: Vec<String> = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'resume_%' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    // `resume_snapshots` predates #130 (v1 schema, resume snapshot metadata unrelated to
    // templates/profile); the plan's assertion assumed no other `resume_%` table existed.
    assert_eq!(tables, vec!["resume_snapshots", "resume_state", "resume_templates"]);
}
