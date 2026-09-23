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

fn field(key: &str, value: &str) -> TemplateField {
    TemplateField { key: key.into(), value: value.into() }
}

fn group(name: &str, fields: Vec<TemplateField>) -> TemplateGroup {
    TemplateGroup { name: name.into(), fields }
}

#[test]
fn a_new_archive_has_no_templates() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let overview = db.resume_overview().unwrap();
    assert!(overview.templates.is_empty());
    assert_eq!(overview.active_template_id, None);
}

#[test]
fn creating_normalizes_like_the_plugin_and_becomes_current() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let created = db
        .create_template(
            "  校招简历 ",
            vec![
                group("  ", vec![field(" 姓名 ", "张三 "), field("  ", "丢掉")]),
                group("空组", vec![field("", "x")]),
                group("教育经历", vec![field("学校", "某大学")]),
            ],
        )
        .unwrap();
    assert_eq!(created.name, "校招简历");
    assert_eq!(
        created.groups,
        vec![
            group("未分类", vec![field("姓名", "张三 ")]),
            group("教育经历", vec![field("学校", "某大学")]),
        ]
    );
    let overview = db.resume_overview().unwrap();
    assert_eq!(overview.active_template_id.as_deref(), Some(created.id.as_str()));
    assert_eq!(overview.templates[0].field_count, 2);
}

#[test]
fn a_template_without_fields_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let err = db.create_template("空", vec![group("组", vec![field(" ", "x")])]).unwrap_err();
    assert!(matches!(err, StoreError::Validation(m) if m.contains("未解析到任何字段")));
}

#[test]
fn duplicate_names_are_numbered_and_the_newest_is_listed_first() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let one = vec![group("g", vec![field("k", "v")])];
    let a = db.create_template("简历", one.clone()).unwrap();
    let b = db.create_template("简历", one.clone()).unwrap();
    let c = db.create_template("简历", one).unwrap();
    assert_eq!((a.name.as_str(), b.name.as_str(), c.name.as_str()), ("简历", "简历 (2)", "简历 (3)"));
    let names: Vec<String> = db.resume_overview().unwrap().templates.into_iter().map(|t| t.name).collect();
    assert_eq!(names, vec!["简历 (3)", "简历 (2)", "简历"]);
}

#[test]
fn an_empty_name_becomes_unnamed() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let t = db.create_template("   ", vec![group("g", vec![field("k", "v")])]).unwrap();
    assert_eq!(t.name, "未命名模板");
}

#[test]
fn an_oversized_template_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let big = "字".repeat(MAX_TEMPLATE_BYTES);
    let err = db.create_template("大", vec![group("g", vec![field("k", &big)])]).unwrap_err();
    assert!(matches!(err, StoreError::Validation(m) if m.contains("模板太大")));
}

#[test]
fn a_template_reads_back_whole() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let t = db.create_template("t", vec![group("g", vec![field("k", "v")])]).unwrap();
    assert_eq!(db.get_template(&t.id).unwrap(), Some(t));
    assert_eq!(db.get_template("missing").unwrap(), None);
}
