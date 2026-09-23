//! #130：简历模板与「我的信息」的命令层。读写用户挑的文件、把存储层的错误翻成中文，
//! 并拦下密码类内容——档案会整库进 D12 备份，不能让「网银密码」这种补充字段跟着走。

use std::path::Path;
use std::sync::OnceLock;

use archive_store::{
    ArchiveStore, ProfileRecord, ResumeOverview, ResumeTemplate, StoreError, TemplateField, TemplateGroup,
    TemplateSummary,
};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::commands::CommandError;

/// 简历模板的 Excel 不会有几 MB；更大的多半是选错了文件，不读进内存。
pub const MAX_SHEET_BYTES: u64 = 5 * 1024 * 1024;

/// 模板名的字数上限。插件那边没有限制，但档案库整库进 D12 备份，
/// 一个离谱长的模板名没有意义，还会把列表挤成一团。
const MAX_TEMPLATE_NAME_CHARS: usize = 100;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub template: TemplateSummary,
    /// 重新导入时覆盖前的字段数；新建时为空。界面靠它说「字段 A → B」。
    pub previous_field_count: Option<usize>,
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

/// 超过上限就截到前 100 个字。导入是从文件名自动取的名字，用户没有机会先改再确认，
/// 截断比直接报错更顺手。
fn truncate_template_name(name: &str) -> String {
    if name.chars().count() > MAX_TEMPLATE_NAME_CHARS {
        name.chars().take(MAX_TEMPLATE_NAME_CHARS).collect()
    } else {
        name.to_string()
    }
}

pub fn import_template(store: &ArchiveStore, path: &Path, replace_id: Option<&str>) -> Result<ImportResult, CommandError> {
    let meta = std::fs::metadata(path).map_err(|_| error("SHEET_UNREADABLE", "读不到这个文件。"))?;
    if meta.len() > MAX_SHEET_BYTES {
        return Err(error("SHEET_TOO_LARGE", "文件超过 5 MB，不像是简历模板，确认选对了文件。"));
    }
    let bytes = std::fs::read(path).map_err(|_| error("SHEET_UNREADABLE", "读不到这个文件。"))?;
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let groups = resume_sheet::parse(file_name, &bytes).map_err(|e| error("SHEET_INVALID", e.to_string()))?;
    let groups = to_store(groups);
    match replace_id {
        Some(id) => {
            let (template, previous) = store.replace_template_groups(id, groups).map_err(resume_error)?;
            Ok(ImportResult { template: TemplateSummary::from(&template), previous_field_count: Some(previous) })
        }
        None => {
            let name = truncate_template_name(&resume_sheet::template_name_from_file(file_name));
            let template = store.create_template(&name, groups).map_err(resume_error)?;
            Ok(ImportResult { template: TemplateSummary::from(&template), previous_field_count: None })
        }
    }
}

/// 先写同目录临时文件再改名，导出到一半失败不会留下半个 xlsx 盖掉用户原来的文件。
pub fn export_template(store: &ArchiveStore, id: &str, path: &Path) -> Result<(), CommandError> {
    let template = get_template(store, id)?;
    let bytes = resume_sheet::write_xlsx(&to_sheet(&template.groups))
        .map_err(|e| error("SHEET_WRITE_FAILED", e.to_string()))?;
    let tmp = path.with_extension("xlsx.tmp");
    std::fs::write(&tmp, bytes).map_err(|_| error("SHEET_WRITE_FAILED", "写不进这个位置，换个文件夹试试。"))?;
    std::fs::rename(&tmp, path).map_err(|_| {
        let _ = std::fs::remove_file(&tmp);
        error("SHEET_WRITE_FAILED", "写不进这个位置，换个文件夹试试。")
    })
}

pub fn rename_template(store: &ArchiveStore, id: &str, name: &str) -> Result<TemplateSummary, CommandError> {
    if name.chars().count() > MAX_TEMPLATE_NAME_CHARS {
        return Err(error("VALIDATION", "模板名太长了，请控制在 100 个字以内。"));
    }
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

// 与插件 `profile-fields.js` 的 SECRET_LABEL / SECRET_VALUE 同一口径。
fn secret_label() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)密码|口令|验证码|校验码|授权码|密钥|私钥|令牌|password|passwd|captcha|token|secret").unwrap())
}

fn secret_value() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(密码|口令|验证码|校验码|授权码|密钥|令牌|password|passwd|pwd|token|secret)\s*[:=：]\s*\S").unwrap()
    })
}

/// 返回第一处像密码的内容的名字，给提示用；没有返回 None。
fn secret_like(profile: &Value) -> Option<String> {
    let strings = |v: Option<&Value>| -> Vec<(String, String)> {
        v.and_then(Value::as_object)
            .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
            .unwrap_or_default()
    };
    for (key, value) in strings(profile.get("values")) {
        if secret_value().is_match(&value) {
            return Some(key);
        }
    }
    for member in profile.get("family").and_then(Value::as_array).into_iter().flatten() {
        for (key, value) in strings(Some(member)) {
            if secret_value().is_match(&value) {
                return Some(key);
            }
        }
    }
    for item in profile.get("custom").and_then(Value::as_array).into_iter().flatten() {
        let key = item.get("key").and_then(Value::as_str).unwrap_or("");
        let value = item.get("value").and_then(Value::as_str).unwrap_or("");
        if secret_label().is_match(key) || secret_value().is_match(value) {
            return Some(key.to_string());
        }
    }
    None
}

pub fn save_profile(store: &ArchiveStore, profile: Value, revision: i64) -> Result<ProfileRecord, CommandError> {
    if let Some(name) = secret_like(&profile) {
        return Err(error(
            "VALIDATION",
            format!("「{name}」看起来是密码或验证码，这类内容不存进档案（档案会随备份带走）。"),
        ));
    }
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

    #[test]
    fn a_csv_import_creates_a_template_named_after_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let path = dir.path().join("校招简历.csv");
        std::fs::write(&path, "一级分类,字段名,值\n基本信息,姓名,张三\n").unwrap();
        let result = import_template(&db, &path, None).unwrap();
        assert_eq!(result.template.name, "校招简历");
        assert_eq!(result.template.field_count, 1);
        assert_eq!(result.previous_field_count, None);
    }

    #[test]
    fn reimport_overwrites_and_a_bad_file_leaves_the_template_alone() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let first = dir.path().join("a.csv");
        std::fs::write(&first, "一级分类,字段名,值\n组,k1,v\n组,k2,v\n").unwrap();
        let created = import_template(&db, &first, None).unwrap().template;
        let bad = dir.path().join("b.csv");
        std::fs::write(&bad, "一级分类,字段名,值\n组,,v\n").unwrap();
        let err = import_template(&db, &bad, Some(&created.id)).unwrap_err();
        assert_eq!(err.code, "SHEET_INVALID");
        assert_eq!(db.get_template(&created.id).unwrap().unwrap().groups.len(), 1);
        let good = dir.path().join("c.csv");
        std::fs::write(&good, "一级分类,字段名,值\n组,k,v\n").unwrap();
        let replaced = import_template(&db, &good, Some(&created.id)).unwrap();
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
        let t = import_template(&db, &src, None).unwrap().template;
        let out = dir.path().join("导出.xlsx");
        export_template(&db, &t.id, &out).unwrap();
        let again = import_template(&db, &out, None).unwrap().template;
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
        assert_eq!(import_template(&db, &path, None).unwrap_err().code, "SHEET_TOO_LARGE");
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
    fn secret_like_profile_content_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let by_label = json!({ "values": {}, "family": [], "custom": [{ "key": "网银密码", "value": "" }] });
        let err = save_profile(&db, by_label, 0).unwrap_err();
        assert!(err.message.contains("网银密码"));
        let by_value = json!({ "values": { "skills": "密码：abc123" }, "family": [], "custom": [] });
        assert_eq!(save_profile(&db, by_value, 0).unwrap_err().code, "VALIDATION");
        let fine = json!({ "values": { "name": "张三" }, "family": [], "custom": [{ "key": "户籍派出所", "value": "" }] });
        assert_eq!(save_profile(&db, fine, 0).unwrap().revision, 1);
    }

    #[test]
    fn rename_rejects_names_over_100_chars() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let path = dir.path().join("a.csv");
        std::fs::write(&path, "一级分类,字段名,值\n组,k,v\n").unwrap();
        let created = import_template(&db, &path, None).unwrap().template;
        let too_long: String = std::iter::repeat('名').take(101).collect();
        let err = rename_template(&db, &created.id, &too_long).unwrap_err();
        assert_eq!(err.code, "VALIDATION");
        assert!(err.message.contains("100"));
        let ok_len: String = std::iter::repeat('名').take(100).collect();
        assert!(rename_template(&db, &created.id, &ok_len).is_ok());
    }

    #[test]
    fn imported_names_longer_than_100_chars_are_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let long_stem: String = std::iter::repeat('名').take(150).collect();
        let path = dir.path().join(format!("{long_stem}.csv"));
        std::fs::write(&path, "一级分类,字段名,值\n组,k,v\n").unwrap();
        let result = import_template(&db, &path, None).unwrap();
        assert_eq!(result.template.name.chars().count(), 100);
    }
}
