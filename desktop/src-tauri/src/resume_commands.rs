//! #130：简历模板与「我的信息」的命令层。读写用户挑的文件、把存储层的错误翻成中文。
//! 密码类内容的拦截在存储层（`archive_store::resume_secrets`），这里不另查一遍。

use std::path::Path;

use archive_store::{
    ArchiveStore, ProfileRecord, ResumeOverview, ResumeTemplate, SavedTemplate, StoreError, TemplateField,
    TemplateGroup, TemplateSummary,
};
use serde::Serialize;
use serde_json::Value;

use crate::commands::CommandError;

/// 简历模板的 Excel 不会有几 MB；更大的多半是选错了文件，不读进内存。
pub const MAX_SHEET_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub template: TemplateSummary,
    /// 重新导入时覆盖前的字段数；新建时为空。界面靠它说「字段 A → B」。
    pub previous_field_count: Option<usize>,
    /// 看起来是密码或验证码、没有导入的字段数。界面据此补一句提示。
    pub skipped_secret_fields: usize,
}

impl From<SavedTemplate> for ImportResult {
    fn from(saved: SavedTemplate) -> Self {
        Self {
            template: TemplateSummary::from(&saved.template),
            previous_field_count: saved.previous_field_count,
            skipped_secret_fields: saved.skipped_secret_fields,
        }
    }
}

fn error(code: &str, message: impl Into<String>) -> CommandError {
    CommandError { code: code.into(), message: message.into() }
}

/// 存储层的中文提示原样给用户，不带 `invalid input:` 之类的前缀。
pub fn resume_error(err: StoreError) -> CommandError {
    match err {
        StoreError::Validation(message) => error("VALIDATION", message),
        StoreError::Conflict(message) => error("CONFLICT", message),
        StoreError::NotFound(_) => error("NOT_FOUND", "这个模板已经不在了，刷新一下列表。"),
        other => CommandError::from(other),
    }
}

fn to_store(groups: Vec<resume_sheet::Group>) -> Vec<TemplateGroup> {
    groups
        .into_iter()
        .map(|g| TemplateGroup {
            name: g.name,
            fields: g.fields.into_iter().map(|f| TemplateField { key: f.key, value: f.value }).collect(),
        })
        .collect()
}

fn to_sheet(groups: &[TemplateGroup]) -> Vec<resume_sheet::Group> {
    groups
        .iter()
        .map(|g| resume_sheet::Group {
            name: g.name.clone(),
            fields: g
                .fields
                .iter()
                .map(|f| resume_sheet::Field { key: f.key.clone(), value: f.value.clone() })
                .collect(),
        })
        .collect()
}

pub fn overview(store: &ArchiveStore) -> Result<ResumeOverview, CommandError> {
    store.resume_overview().map_err(resume_error)
}

pub fn get_template(store: &ArchiveStore, id: &str) -> Result<ResumeTemplate, CommandError> {
    store
        .get_template(id)
        .map_err(resume_error)?
        .ok_or_else(|| resume_error(StoreError::NotFound(id.into())))
}

/// 读并解析用户挑的表，不碰档案：放在档案锁外面做，慢盘上的大文件不会卡住别的命令。
/// 返回按文件名取的模板名（截断与去重由存储层做）和解析出的分组。
pub fn read_sheet(path: &Path) -> Result<(String, Vec<TemplateGroup>), CommandError> {
    let meta = std::fs::metadata(path).map_err(|_| error("SHEET_UNREADABLE", "读不到这个文件。"))?;
    if meta.len() > MAX_SHEET_BYTES {
        return Err(error("SHEET_TOO_LARGE", "文件超过 5 MB，不像是简历模板，确认选对了文件。"));
    }
    let bytes = std::fs::read(path).map_err(|_| error("SHEET_UNREADABLE", "读不到这个文件。"))?;
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let groups = resume_sheet::parse(file_name, &bytes).map_err(|e| error("SHEET_INVALID", e.to_string()))?;
    Ok((resume_sheet::template_name_from_file(file_name), to_store(groups)))
}

/// 把 [read_sheet] 的结果存进档案：`replace_id` 为空时新建（用 `name`），否则覆盖那个模板。
pub fn import_template(
    store: &ArchiveStore,
    name: &str,
    groups: Vec<TemplateGroup>,
    replace_id: Option<&str>,
) -> Result<ImportResult, CommandError> {
    let saved = match replace_id {
        Some(id) => store.replace_template_groups(id, groups),
        None => store.create_template(name, groups),
    };
    saved.map(ImportResult::from).map_err(resume_error)
}

/// 目标没有 `.xlsx` 后缀（不分大小写）就整段追加，不是替换已有后缀：
/// `foo` → `foo.xlsx`，`foo.csv` → `foo.csv.xlsx`。
fn ensure_xlsx_extension(path: &Path) -> std::path::PathBuf {
    let already_xlsx = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("xlsx"));
    if already_xlsx {
        return path.to_path_buf();
    }
    let mut file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("简历模板").to_string();
    file_name.push_str(".xlsx");
    path.with_file_name(file_name)
}

/// 权限被拒或 Windows 共享冲突（原始错误码 32）大概率是文件被 Excel 之类的程序占着；
/// 其余情况给不出更具体的原因，只能让用户换个位置试试。
fn write_error(err: &std::io::Error) -> CommandError {
    let locked = err.kind() == std::io::ErrorKind::PermissionDenied || err.raw_os_error() == Some(32);
    if locked {
        error("SHEET_WRITE_FAILED", "这个文件可能正在被 Excel 打开，关掉后再导出。")
    } else {
        error("SHEET_WRITE_FAILED", "写不进这个位置，换个文件夹试试。")
    }
}

/// 先写同目录里一个带随机后缀的临时文件再改名，导出到一半失败不会留下半个 xlsx
/// 盖掉用户原来的文件；随机后缀避免并发导出撞名。
pub fn export_template(store: &ArchiveStore, id: &str, path: &Path) -> Result<(), CommandError> {
    let template = get_template(store, id)?;
    let bytes = resume_sheet::write_xlsx(&to_sheet(&template.groups))
        .map_err(|e| error("SHEET_WRITE_FAILED", e.to_string()))?;
    let path = ensure_xlsx_extension(path);
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("简历模板.xlsx");
    let tmp = path.with_file_name(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, bytes).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        write_error(&e)
    })?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        write_error(&e)
    })
}

/// 简历解析的结果：插到最前、设为当前，照常剔除密码类字段、编号重名、检查大小。
pub fn create_from_groups(store: &ArchiveStore, name: &str, groups: Vec<TemplateGroup>) -> Result<ImportResult, CommandError> {
    store.create_template(name, groups).map(ImportResult::from).map_err(resume_error)
}

/// 字数上限（100 字，首尾空白不计）和重名由存储层把关。
pub fn rename_template(store: &ArchiveStore, id: &str, name: &str) -> Result<TemplateSummary, CommandError> {
    store.rename_template(id, name).map(|t| TemplateSummary::from(&t)).map_err(resume_error)
}

pub fn delete_template(store: &ArchiveStore, id: &str) -> Result<ResumeOverview, CommandError> {
    store.delete_template(id).map_err(resume_error)?;
    overview(store)
}

pub fn set_active_template(store: &ArchiveStore, id: &str) -> Result<ResumeOverview, CommandError> {
    store.set_active_template(id).map_err(resume_error)?;
    overview(store)
}

pub fn get_profile(store: &ArchiveStore) -> Result<ProfileRecord, CommandError> {
    store.get_profile().map_err(resume_error)
}

/// 密码类内容由存储层拒绝，提示原样带 `VALIDATION` 返回。
pub fn save_profile(store: &ArchiveStore, profile: Value, revision: i64) -> Result<ProfileRecord, CommandError> {
    store.save_profile(profile, revision).map_err(resume_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::open_store;
    use serde_json::json;

    fn store(dir: &std::path::Path) -> ArchiveStore {
        open_store(&dir.join("archive"), &dir.join("current.json")).unwrap()
    }

    /// 与 `import_resume_template_cmd` 同样的两步：先在锁外读表，再进存储。
    fn import(db: &ArchiveStore, path: &Path, replace_id: Option<&str>) -> Result<ImportResult, CommandError> {
        let (name, groups) = read_sheet(path)?;
        import_template(db, &name, groups, replace_id)
    }

    #[test]
    fn reading_a_sheet_needs_no_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("校招简历.csv");
        std::fs::write(&path, "一级分类,字段名,值\n基本信息,姓名,张三\n").unwrap();
        let (name, groups) = read_sheet(&path).unwrap();
        assert_eq!(name, "校招简历");
        assert_eq!(
            groups,
            vec![TemplateGroup { name: "基本信息".into(), fields: vec![TemplateField { key: "姓名".into(), value: "张三".into() }] }]
        );
        let big = dir.path().join("big.csv");
        std::fs::write(&big, vec![b'a'; (MAX_SHEET_BYTES + 1) as usize]).unwrap();
        assert_eq!(read_sheet(&big).unwrap_err().code, "SHEET_TOO_LARGE");
    }

    #[test]
    fn a_csv_import_creates_a_template_named_after_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let path = dir.path().join("校招简历.csv");
        std::fs::write(&path, "一级分类,字段名,值\n基本信息,姓名,张三\n").unwrap();
        let result = import(&db, &path, None).unwrap();
        assert_eq!(result.template.name, "校招简历");
        assert_eq!(result.template.field_count, 1);
        assert_eq!(result.previous_field_count, None);
    }

    #[test]
    fn secret_like_rows_are_dropped_on_import_and_counted() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let path = dir.path().join("t.csv");
        std::fs::write(&path, "一级分类,字段名,值\n账号,邮箱,a@example.com\n账号,邮箱密码,abc123\n").unwrap();
        let result = import(&db, &path, None).unwrap();
        assert_eq!(result.template.field_count, 1);
        assert_eq!(result.skipped_secret_fields, 1);
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["skippedSecretFields"], 1);
        let fields = &db.get_template(&result.template.id).unwrap().unwrap().groups[0].fields;
        assert!(fields.iter().all(|f| f.key != "邮箱密码" && f.value != "abc123"));
        let replaced = import(&db, &path, Some(&result.template.id)).unwrap();
        assert_eq!(replaced.skipped_secret_fields, 1);
        assert_eq!(replaced.previous_field_count, Some(1));
    }

    #[test]
    fn reimport_overwrites_and_a_bad_file_leaves_the_template_alone() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let first = dir.path().join("a.csv");
        std::fs::write(&first, "一级分类,字段名,值\n组,k1,v\n组,k2,v\n").unwrap();
        let created = import(&db, &first, None).unwrap().template;
        let bad = dir.path().join("b.csv");
        std::fs::write(&bad, "一级分类,字段名,值\n组,,v\n").unwrap();
        let err = import(&db, &bad, Some(&created.id)).unwrap_err();
        assert_eq!(err.code, "SHEET_INVALID");
        assert_eq!(db.get_template(&created.id).unwrap().unwrap().groups.len(), 1);
        let good = dir.path().join("c.csv");
        std::fs::write(&good, "一级分类,字段名,值\n组,k,v\n").unwrap();
        let replaced = import(&db, &good, Some(&created.id)).unwrap();
        assert_eq!(replaced.previous_field_count, Some(2));
        assert_eq!(replaced.template.field_count, 1);
        assert_eq!(replaced.template.name, "a");
    }

    #[test]
    fn export_then_import_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let src = dir.path().join("t.csv");
        std::fs::write(&src, "一级分类,字段名,值\n基本信息,手机号码,13800000000\n").unwrap();
        let t = import(&db, &src, None).unwrap().template;
        let out = dir.path().join("导出.xlsx");
        export_template(&db, &t.id, &out).unwrap();
        let again = import(&db, &out, None).unwrap().template;
        assert_eq!(
            db.get_template(&again.id).unwrap().unwrap().groups,
            db.get_template(&t.id).unwrap().unwrap().groups
        );
    }

    #[test]
    fn a_huge_file_is_refused_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let path = dir.path().join("big.csv");
        std::fs::write(&path, vec![b'a'; (MAX_SHEET_BYTES + 1) as usize]).unwrap();
        assert_eq!(import(&db, &path, None).unwrap_err().code, "SHEET_TOO_LARGE");
    }

    #[test]
    fn store_errors_reach_the_user_in_chinese() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let err = rename_template(&db, "missing", "x").unwrap_err();
        assert_eq!(err.code, "NOT_FOUND");
        assert!(err.message.contains("模板已经不在了"));
    }

    #[test]
    fn secret_like_profile_content_is_refused_with_a_chinese_message() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        // custom 的 key 是用户自己写的文本，点名它没问题。
        let by_label = json!({ "values": {}, "family": [], "custom": [{ "key": "网银密码", "value": "" }] });
        let err = save_profile(&db, by_label, 0).unwrap_err();
        assert!(err.message.contains("网银密码"));
        // values / family 的 key 是内部字段 id（如 "skills"），不是用户文本，不能出现在提示里。
        let by_value = json!({ "values": { "skills": "密码：abc123" }, "family": [], "custom": [] });
        let err2 = save_profile(&db, by_value, 0).unwrap_err();
        assert_eq!(err2.code, "VALIDATION");
        assert!(!err2.message.contains("skills"));
        assert!(err2.message.contains("看起来是密码或验证码"));
        let by_family = json!({
            "values": {},
            "family": [{ "relation": "父亲", "phone": "口令: 123456" }],
            "custom": []
        });
        let err3 = save_profile(&db, by_family, 0).unwrap_err();
        assert_eq!(err3.code, "VALIDATION");
        assert!(!err3.message.contains("phone"));
        let fine = json!({ "values": { "name": "张三" }, "family": [], "custom": [{ "key": "户籍派出所", "value": "" }] });
        assert_eq!(save_profile(&db, fine, 0).unwrap().revision, 1);
    }

    #[test]
    fn rename_rejects_names_over_100_chars_but_trims_first() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let path = dir.path().join("a.csv");
        std::fs::write(&path, "一级分类,字段名,值\n组,k,v\n").unwrap();
        let created = import(&db, &path, None).unwrap().template;
        let too_long: String = std::iter::repeat('名').take(101).collect();
        let err = rename_template(&db, &created.id, &too_long).unwrap_err();
        assert_eq!(err.code, "VALIDATION");
        assert!(err.message.contains("100"));
        let ok_len: String = std::iter::repeat('名').take(100).collect();
        assert!(rename_template(&db, &created.id, &ok_len).is_ok());
        // 前后空白不计入字数：填满 100 个字再加空白应该照样通过。
        let padded = format!("  {ok_len}  ");
        assert!(rename_template(&db, &created.id, &padded).is_ok());
    }

    #[test]
    fn imported_names_longer_than_96_chars_are_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        // ASCII，不是多字节字符：150 个「名」在 UTF-8 下是 450 字节，加上扩展名会
        // 超过某些文件系统（如 Linux ext4）255 字节的文件名上限。
        let long_stem: String = "n".repeat(150);
        let path = dir.path().join(format!("{long_stem}.csv"));
        std::fs::write(&path, "一级分类,字段名,值\n组,k,v\n").unwrap();
        let result = import(&db, &path, None).unwrap();
        // 96 个字而不是 100：给存储层可能加的「 (2)」这类去重后缀留出空间，
        // 保证常见情况下最终名字仍然 ≤ 100。
        assert_eq!(result.template.name.chars().count(), 96);
    }

    #[test]
    fn export_appends_xlsx_extension_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let src = dir.path().join("t.csv");
        std::fs::write(&src, "一级分类,字段名,值\n组,k,v\n").unwrap();
        let t = import(&db, &src, None).unwrap().template;
        let out = dir.path().join("导出");
        export_template(&db, &t.id, &out).unwrap();
        assert!(dir.path().join("导出.xlsx").is_file());
        assert!(!out.is_file());
    }

    #[test]
    fn export_appends_xlsx_even_when_extension_is_something_else() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let src = dir.path().join("t.csv");
        std::fs::write(&src, "一级分类,字段名,值\n组,k,v\n").unwrap();
        let t = import(&db, &src, None).unwrap().template;
        let out = dir.path().join("foo.csv");
        export_template(&db, &t.id, &out).unwrap();
        assert!(dir.path().join("foo.csv.xlsx").is_file());
    }

    #[test]
    fn write_error_recognizes_a_locked_file() {
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(write_error(&denied).message.contains("正在被 Excel 打开"));
        let sharing = std::io::Error::from_raw_os_error(32);
        assert!(write_error(&sharing).message.contains("正在被 Excel 打开"));
        let other = std::io::Error::new(std::io::ErrorKind::Other, "boom");
        assert!(write_error(&other).message.contains("换个文件夹"));
    }

    #[test]
    fn parsed_groups_become_a_new_current_template() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let groups = vec![
            TemplateGroup { name: "基本信息".into(), fields: vec![
                TemplateField { key: "姓名".into(), value: "张三".into() },
                TemplateField { key: "邮箱密码".into(), value: "x".into() },
            ] },
        ];
        let result = create_from_groups(&db, "我的简历（AI 解析）", groups).unwrap();
        assert_eq!(result.template.name, "我的简历（AI 解析）");
        assert_eq!(result.template.field_count, 1);
        assert_eq!(result.skipped_secret_fields, 1);
        assert_eq!(result.previous_field_count, None);
        assert_eq!(db.resume_overview().unwrap().active_template_id.as_deref(), Some(result.template.id.as_str()));
    }
}
