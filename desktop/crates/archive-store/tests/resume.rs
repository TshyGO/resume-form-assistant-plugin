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

#[test]
fn reimport_replaces_groups_reports_the_old_count_and_becomes_current() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let a = db.create_template("a", vec![group("g", vec![field("k1", "v"), field("k2", "v")])]).unwrap();
    let b = db.create_template("b", vec![group("g", vec![field("k", "v")])]).unwrap();
    assert_eq!(db.resume_overview().unwrap().active_template_id.as_deref(), Some(b.id.as_str()));
    let (updated, previous) = db
        .replace_template_groups(&a.id, vec![group("新", vec![field("x", "1"), field("y", "2"), field("z", "3")])])
        .unwrap();
    assert_eq!(previous, 2);
    assert_eq!(updated.name, "a");
    assert_eq!(updated.groups[0].name, "新");
    let overview = db.resume_overview().unwrap();
    assert_eq!(overview.active_template_id.as_deref(), Some(a.id.as_str()));
    assert_eq!(overview.templates.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["b", "a"]);
}

#[test]
fn a_failed_reimport_leaves_the_template_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let a = db.create_template("a", vec![group("g", vec![field("k", "v")])]).unwrap();
    assert!(db.replace_template_groups(&a.id, vec![]).is_err());
    assert_eq!(db.get_template(&a.id).unwrap().unwrap().groups, a.groups);
}

#[test]
fn renaming_refuses_a_name_already_in_use() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let one = vec![group("g", vec![field("k", "v")])];
    let a = db.create_template("a", one.clone()).unwrap();
    db.create_template("b", one).unwrap();
    let err = db.rename_template(&a.id, " b ").unwrap_err();
    assert!(matches!(err, StoreError::Validation(m) if m.contains("已有同名模板「b」")));
    assert_eq!(db.rename_template(&a.id, "a").unwrap().name, "a");
    assert_eq!(db.rename_template(&a.id, "新名").unwrap().name, "新名");
}

#[test]
fn deleting_the_current_template_falls_back_to_the_first_remaining() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let one = vec![group("g", vec![field("k", "v")])];
    let a = db.create_template("a", one.clone()).unwrap();
    let b = db.create_template("b", one.clone()).unwrap();
    let c = db.create_template("c", one).unwrap();
    db.set_active_template(&b.id).unwrap();
    db.delete_template(&b.id).unwrap();
    assert_eq!(db.resume_overview().unwrap().active_template_id.as_deref(), Some(c.id.as_str()));
    db.delete_template(&c.id).unwrap();
    db.delete_template(&a.id).unwrap();
    assert_eq!(db.resume_overview().unwrap().active_template_id, None);
    assert!(matches!(db.delete_template(&a.id), Err(StoreError::NotFound(_))));
}

#[test]
fn switching_to_a_missing_template_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    assert!(matches!(db.set_active_template("nope"), Err(StoreError::NotFound(_))));
}

#[test]
fn the_profile_starts_empty_and_saves_with_a_revision_check() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    let first = db.get_profile().unwrap();
    assert_eq!(first.revision, 0);
    assert_eq!(first.profile, empty_profile());
    let profile = serde_json::json!({
        "values": { "name": "张三" },
        "family": [{ "relation": "父亲", "name": "张大" }],
        "custom": [{ "key": "户籍派出所", "value": "" }]
    });
    let saved = db.save_profile(profile.clone(), 0).unwrap();
    assert_eq!(saved.revision, 1);
    assert_eq!(db.get_profile().unwrap().profile, profile);
    let err = db.save_profile(empty_profile(), 0).unwrap_err();
    assert!(matches!(err, StoreError::Conflict(_)));
    assert_eq!(db.get_profile().unwrap().profile, profile);
}

#[test]
fn a_malformed_profile_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path());
    for bad in [
        serde_json::json!([]),
        serde_json::json!({ "values": { "name": 1 }, "family": [], "custom": [] }),
        serde_json::json!({ "values": {}, "family": [1], "custom": [] }),
        serde_json::json!({ "values": {}, "family": [], "custom": [{ "key": "k" }] }),
        serde_json::json!({ "values": {}, "family": [], "custom": [], "apiKey": "x" }),
    ] {
        assert!(matches!(db.save_profile(bad, 0), Err(StoreError::Validation(_))));
    }
    let many: Vec<_> = (0..=MAX_CUSTOM_FIELDS).map(|i| serde_json::json!({ "key": format!("k{i}"), "value": "" })).collect();
    let err = db.save_profile(serde_json::json!({ "values": {}, "family": [], "custom": many }), 0).unwrap_err();
    assert!(matches!(err, StoreError::Validation(m) if m.contains("最多 200 个")));
}

#[test]
fn templates_and_profile_survive_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let id = {
        let db = open(dir.path());
        let t = db.create_template("t", vec![group("g", vec![field("k", "v")])]).unwrap();
        db.save_profile(serde_json::json!({ "values": { "name": "张三" }, "family": [], "custom": [] }), 0).unwrap();
        t.id
    };
    let db = open(dir.path());
    assert_eq!(db.resume_overview().unwrap().active_template_id.as_deref(), Some(id.as_str()));
    assert_eq!(db.get_profile().unwrap().revision, 1);
}
