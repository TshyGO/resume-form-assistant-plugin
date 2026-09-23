//! 简历模板与「我的信息」（#130）。桌面是唯一来源；插件经协议只读，
//! 只能做两种写：切换当前模板、保存「我的信息」（见 u130 计划 PR 3）。
//!
//! 形状沿用插件 `chrome.storage.local`，规范化规则逐条对齐 `popup.js`
//! 的 `normalizeTemplate` 与 `resolveTemplateName`，改这里要同步看那边。

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::StoreError;
use crate::resume_secrets::{is_secret_label, is_secret_value};
use crate::timeutil::now_utc;
use crate::tx::{new_uuid, StoreTx};

// 上限的账：插件的 `resume.read`（u130 PR 3）要在**一条**协议消息里带回当前模板全文、
// 「我的信息」和全部模板摘要，信封上限 65536 字节（UTF-8 JSON）。
//
//   当前模板分组   ≤ 24 KiB = 24576
//   「我的信息」   ≤ 24 KiB = 24576
//   模板摘要       ≤ 25 条 × ~0.52 KB（名字按 101 个四字节字符算）≈ 13.0 KB
//   当前模板的 id / 名字 / 时间、字段名       ≈ 0.6 KB
//   合计 ≈ 62.7 KB，给信封字段留 1 KiB 后仍有约 1.8 KB 余量。
//
// 模板数若放到 50 条，同样算法最坏要 ~75.7 KB，装不下，所以是 25。
// `tests/resume.rs` 的 `the_worst_case_resume_read_fits_one_protocol_envelope` 按这些常量
// 拼最坏情况核对，改任何一个都要让它继续通过。

/// 单个模板分组序列化后的上限。
pub const MAX_TEMPLATE_BYTES: usize = 24 * 1024;
/// 「我的信息」序列化后的上限。
pub const MAX_PROFILE_BYTES: usize = 24 * 1024;
/// 模板个数上限，满了要先删再导入。
pub const MAX_TEMPLATES: usize = 25;
/// 与插件 `profile-fields.js` 的 `MAX_CUSTOM_FIELDS` 一致。
pub const MAX_CUSTOM_FIELDS: usize = 200;

/// 模板名的字数上限。插件那边没有限制，但一个离谱长的模板名没有意义，
/// 还会把列表挤成一团、撑大 `resume.read` 的摘要（见上面的账）。
pub const MAX_TEMPLATE_NAME_CHARS: usize = 100;
/// 新建时自动取名截到的字数，比 [MAX_TEMPLATE_NAME_CHARS] 小一截：去重可能加上
/// 「 (2)」这类后缀，留出余量才能保证常见情况下最终名字仍然不超过 100 个字。
/// 名字多半来自文件名，用户没机会先改再确认，所以截断而不是报错。
const MAX_CREATED_NAME_CHARS: usize = 96;

const UNGROUPED: &str = "未分类";
const UNNAMED: &str = "未命名模板";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateField {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateGroup {
    pub name: String,
    pub fields: Vec<TemplateField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeTemplate {
    pub id: String,
    pub name: String,
    pub groups: Vec<TemplateGroup>,
    pub updated_at: String,
}

/// 新建或重新导入之后的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedTemplate {
    pub template: ResumeTemplate,
    /// 重新导入时覆盖前的字段数；新建时为 `None`。
    pub previous_field_count: Option<usize>,
    /// 看起来是密码或验证码、没有存进档案的字段数（data-privacy §4.1）。
    pub skipped_secret_fields: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSummary {
    pub id: String,
    pub name: String,
    pub field_count: usize,
    pub updated_at: String,
}

impl From<&ResumeTemplate> for TemplateSummary {
    fn from(t: &ResumeTemplate) -> Self {
        Self {
            id: t.id.clone(),
            name: t.name.clone(),
            field_count: field_count(&t.groups),
            updated_at: t.updated_at.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeOverview {
    /// 新的在前，与插件「新模板插到最前」一致。
    pub templates: Vec<TemplateSummary>,
    /// 存的 id 不在了就回落到列表第一个，和插件 `normalizeStore` 一样；没有模板时为空。
    pub active_template_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRecord {
    pub profile: Value,
    /// 每保存一次加一。保存时带上读到的值，对不上说明别处改过（插件侧边栏也会写）。
    pub revision: i64,
}

pub fn field_count(groups: &[TemplateGroup]) -> usize {
    groups.iter().map(|g| g.fields.len()).sum()
}

/// 对齐 `popup.js` `normalizeTemplate`：组名与字段名 trim，值原样；
/// 空字段名丢弃，空组丢弃，空组名记为「未分类」。
pub fn normalize_groups(groups: Vec<TemplateGroup>) -> Vec<TemplateGroup> {
    groups
        .into_iter()
        .filter_map(|g| {
            let fields: Vec<TemplateField> = g
                .fields
                .into_iter()
                .map(|f| TemplateField { key: f.key.trim().to_string(), value: f.value })
                .filter(|f| !f.key.is_empty())
                .collect();
            if fields.is_empty() {
                return None;
            }
            let name = g.name.trim();
            Some(TemplateGroup {
                name: if name.is_empty() { UNGROUPED.into() } else { name.into() },
                fields,
            })
        })
        .collect()
}

pub fn empty_profile() -> Value {
    json!({ "values": {}, "family": [], "custom": [] })
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::Validation(message.into())
}

/// 去控制字符（U+0000–U+001F、U+007F）再 trim。控制字符在 JSON 里各要转义成
/// 6 字节（如 `\u0000`），`resume.read` 最坏情况的账（本文件顶部注释）按每字符
/// ≤ 4 字节算，不清理就可能超出信封上限。
fn clean_name(name: &str) -> String {
    let cleaned: String = name.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() { UNNAMED.into() } else { trimmed.into() }
}

fn truncate_chars(name: String, max: usize) -> String {
    if name.chars().count() > max { name.chars().take(max).collect() } else { name }
}

fn groups_json(groups: &[TemplateGroup]) -> Result<String, StoreError> {
    let json = serde_json::to_string(groups)?;
    if json.len() > MAX_TEMPLATE_BYTES {
        return Err(invalid(format!(
            "模板太大（超过 {} KB），请拆成几个模板。",
            MAX_TEMPLATE_BYTES / 1024
        )));
    }
    Ok(json)
}

/// 规范化之后剔除像密码、验证码的字段：字段名像（「邮箱密码」），或内容里写着
/// 「密码：xxx」。剔完变空的组一并丢掉。返回剩下的分组和剔掉的字段数。
fn without_secrets(groups: Vec<TemplateGroup>) -> (Vec<TemplateGroup>, usize) {
    let mut skipped = 0;
    let kept = groups
        .into_iter()
        .filter_map(|g| {
            let before = g.fields.len();
            let fields: Vec<TemplateField> = g
                .fields
                .into_iter()
                .filter(|f| !is_secret_label(&f.key) && !is_secret_value(&f.value))
                .collect();
            skipped += before - fields.len();
            (!fields.is_empty()).then_some(TemplateGroup { name: g.name, fields })
        })
        .collect();
    (kept, skipped)
}

/// 返回要存的 JSON 和剔掉的密码类字段数。
fn checked_groups(groups: Vec<TemplateGroup>) -> Result<(String, usize), StoreError> {
    let (groups, skipped) = without_secrets(normalize_groups(groups));
    if groups.is_empty() {
        return Err(invalid("未解析到任何字段，请检查 Excel 格式。"));
    }
    let json = groups_json(&groups)?;
    Ok((json, skipped))
}

/// 「我的信息」只校验形状和大小；字段级规范化在前端用插件同一份
/// `profile-fields.js` 做，这里不另写一份规则。
pub fn validate_profile(profile: &Value) -> Result<(), StoreError> {
    let bad = || invalid("「我的信息」格式不对，没有保存。");
    let obj = profile.as_object().ok_or_else(bad)?;
    if obj.keys().any(|k| !matches!(k.as_str(), "values" | "family" | "custom")) {
        return Err(bad());
    }
    let values = obj.get("values").and_then(Value::as_object).ok_or_else(bad)?;
    if values.values().any(|v| !v.is_string()) {
        return Err(bad());
    }
    let family = obj.get("family").and_then(Value::as_array).ok_or_else(bad)?;
    for member in family {
        let member = member.as_object().ok_or_else(bad)?;
        if member.values().any(|v| !v.is_string()) {
            return Err(bad());
        }
    }
    let custom = obj.get("custom").and_then(Value::as_array).ok_or_else(bad)?;
    if custom.len() > MAX_CUSTOM_FIELDS {
        return Err(invalid(format!("补充字段最多 {MAX_CUSTOM_FIELDS} 个。")));
    }
    for item in custom {
        let key = item.get("key").and_then(Value::as_str);
        let value = item.get("value").and_then(Value::as_str);
        if key.is_none() || value.is_none() {
            return Err(bad());
        }
    }
    if serde_json::to_vec(profile)?.len() > MAX_PROFILE_BYTES {
        return Err(invalid(format!(
            "「我的信息」太大（超过 {} KB）。",
            MAX_PROFILE_BYTES / 1024
        )));
    }
    Ok(())
}

/// 找「我的信息」里第一处像密码的内容，给出提示。`values` / `family` 的 key 是内部字段 id
/// （比如 `"skills"`），不是用户写的文本，报出来没有意义还可能造成误解，所以只给笼统的提示；
/// `custom` 的 key 是用户自己填的标签，点名反而更清楚是哪一项。
fn reject_secrets(profile: &Value) -> Result<(), StoreError> {
    const GENERIC: &str = "有一项内容看起来是密码或验证码，这类内容不存进档案（档案会随备份带走）。";
    let strings = |v: &Value| -> Vec<String> {
        v.as_object()
            .map(|o| o.values().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default()
    };
    let values = profile.get("values").map(strings).unwrap_or_default();
    if values.iter().any(|v| is_secret_value(v)) {
        return Err(invalid(GENERIC));
    }
    for member in profile.get("family").and_then(Value::as_array).into_iter().flatten() {
        if strings(member).iter().any(|v| is_secret_value(v)) {
            return Err(invalid(GENERIC));
        }
    }
    for item in profile.get("custom").and_then(Value::as_array).into_iter().flatten() {
        let key = item.get("key").and_then(Value::as_str).unwrap_or("");
        let value = item.get("value").and_then(Value::as_str).unwrap_or("");
        if is_secret_label(key) || is_secret_value(value) {
            return Err(invalid(format!(
                "「{key}」看起来是密码或验证码，这类内容不存进档案（档案会随备份带走）。"
            )));
        }
    }
    Ok(())
}

impl StoreTx<'_> {
    fn ensure_resume_state(&self) -> Result<(), StoreError> {
        self.conn().execute(
            "INSERT OR IGNORE INTO resume_state (id, active_template_id, profile_json, profile_revision, updated_at) \
             VALUES (1, NULL, ?1, 0, ?2)",
            params![empty_profile().to_string(), now_utc()],
        )?;
        Ok(())
    }

    fn template_exists(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self
            .conn()
            .query_row("SELECT 1 FROM resume_templates WHERE id = ?1", params![id], |_| Ok(()))
            .optional()?
            .is_some())
    }

    fn name_taken(&self, name: &str, except_id: Option<&str>) -> Result<bool, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT 1 FROM resume_templates WHERE name = ?1 AND id IS NOT ?2",
                params![name, except_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// 对齐 `popup.js` `resolveTemplateName`：重名时依次试 `名 (2)`、`名 (3)`…
    fn unique_template_name(&self, wanted: &str) -> Result<String, StoreError> {
        if !self.name_taken(wanted, None)? {
            return Ok(wanted.to_string());
        }
        let mut index = 2;
        loop {
            let candidate = format!("{wanted} ({index})");
            if !self.name_taken(&candidate, None)? {
                return Ok(candidate);
            }
            index += 1;
        }
    }

    pub fn resume_overview(&self) -> Result<ResumeOverview, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT id, name, groups_json, updated_at FROM resume_templates ORDER BY position ASC, created_at DESC",
        )?;
        let templates = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
            })?
            .map(|row| {
                let (id, name, json, updated_at) = row?;
                let groups: Vec<TemplateGroup> = serde_json::from_str(&json)?;
                Ok(TemplateSummary { id, name, field_count: field_count(&groups), updated_at })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        let stored: Option<String> = self
            .conn()
            .query_row("SELECT active_template_id FROM resume_state WHERE id = 1", [], |r| {
                r.get::<_, Option<String>>(0)
            })
            .optional()?
            .flatten();
        let active_template_id = stored
            .filter(|id| templates.iter().any(|t| &t.id == id))
            .or_else(|| templates.first().map(|t| t.id.clone()));
        Ok(ResumeOverview { templates, active_template_id })
    }

    pub fn get_template(&self, id: &str) -> Result<Option<ResumeTemplate>, StoreError> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, name, groups_json, updated_at FROM resume_templates WHERE id = ?1",
                params![id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)),
            )
            .optional()?;
        row.map(|(id, name, json, updated_at)| {
            Ok(ResumeTemplate { id, name, groups: serde_json::from_str(&json)?, updated_at })
        })
        .transpose()
    }

    /// 新模板插到最前并设为当前（插件导入与简历解析都是这样）。
    /// 像密码、验证码的字段不存，数量放在返回值里让界面说出来。
    pub fn create_template(&mut self, name: &str, groups: Vec<TemplateGroup>) -> Result<SavedTemplate, StoreError> {
        let count: i64 = self.conn().query_row("SELECT COUNT(*) FROM resume_templates", [], |r| r.get(0))?;
        if count as usize >= MAX_TEMPLATES {
            return Err(invalid(format!("模板最多 {MAX_TEMPLATES} 个，先删掉用不上的再导入。")));
        }
        let (json, skipped_secret_fields) = checked_groups(groups)?;
        let name = self.unique_template_name(&truncate_chars(clean_name(name), MAX_CREATED_NAME_CHARS))?;
        let position: i64 = self.conn().query_row(
            "SELECT COALESCE(MIN(position), 1) - 1 FROM resume_templates",
            [],
            |r| r.get(0),
        )?;
        let now = now_utc();
        let id = new_uuid();
        self.conn().execute(
            "INSERT INTO resume_templates (id, name, groups_json, position, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, name, json, position, now],
        )?;
        self.set_active_template(&id)?;
        let template = self
            .get_template(&id)?
            .ok_or_else(|| StoreError::Internal("template vanished in same transaction".into()))?;
        Ok(SavedTemplate { template, previous_field_count: None, skipped_secret_fields })
    }

    /// 「重新导入」：换掉分组，名字与位置不动，设为当前。结果里带覆盖前的字段数；
    /// 密码类字段和新建时一样剔除并计数。
    pub fn replace_template_groups(&mut self, id: &str, groups: Vec<TemplateGroup>) -> Result<SavedTemplate, StoreError> {
        let previous = self
            .get_template(id)?
            .ok_or_else(|| StoreError::NotFound(format!("template {id}")))?;
        let (json, skipped_secret_fields) = checked_groups(groups)?;
        self.conn().execute(
            "UPDATE resume_templates SET groups_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![json, now_utc(), id],
        )?;
        self.set_active_template(id)?;
        let template = self
            .get_template(id)?
            .ok_or_else(|| StoreError::Internal("template vanished in same transaction".into()))?;
        Ok(SavedTemplate {
            template,
            previous_field_count: Some(field_count(&previous.groups)),
            skipped_secret_fields,
        })
    }

    /// 改名不自动加序号：用户明确要这个名字，撞了就说出来。
    pub fn rename_template(&mut self, id: &str, name: &str) -> Result<ResumeTemplate, StoreError> {
        if !self.template_exists(id)? {
            return Err(StoreError::NotFound(format!("template {id}")));
        }
        // 先 trim 再数：首尾空白不计入字数。
        let name = clean_name(name);
        if name.chars().count() > MAX_TEMPLATE_NAME_CHARS {
            return Err(invalid(format!("模板名太长了，请控制在 {MAX_TEMPLATE_NAME_CHARS} 个字以内。")));
        }
        if self.name_taken(&name, Some(id))? {
            return Err(invalid(format!("已有同名模板「{name}」，换个名字吧。")));
        }
        self.conn().execute(
            "UPDATE resume_templates SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, now_utc(), id],
        )?;
        self.get_template(id)?
            .ok_or_else(|| StoreError::Internal("template vanished in same transaction".into()))
    }

    /// 删掉当前模板时改指向剩下的第一个；删光了当前就为空。
    pub fn delete_template(&mut self, id: &str) -> Result<(), StoreError> {
        if !self.template_exists(id)? {
            return Err(StoreError::NotFound(format!("template {id}")));
        }
        self.conn().execute("DELETE FROM resume_templates WHERE id = ?1", params![id])?;
        self.ensure_resume_state()?;
        let active: Option<String> = self
            .conn()
            .query_row("SELECT active_template_id FROM resume_state WHERE id = 1", [], |r| r.get(0))?;
        if active.as_deref() == Some(id) {
            let next: Option<String> = self
                .conn()
                .query_row(
                    "SELECT id FROM resume_templates ORDER BY position ASC, created_at DESC LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            self.conn().execute(
                "UPDATE resume_state SET active_template_id = ?1, updated_at = ?2 WHERE id = 1",
                params![next, now_utc()],
            )?;
        }
        Ok(())
    }

    pub fn set_active_template(&mut self, id: &str) -> Result<(), StoreError> {
        if !self.template_exists(id)? {
            return Err(StoreError::NotFound(format!("template {id}")));
        }
        self.ensure_resume_state()?;
        self.conn().execute(
            "UPDATE resume_state SET active_template_id = ?1, updated_at = ?2 WHERE id = 1",
            params![id, now_utc()],
        )?;
        Ok(())
    }

    pub fn get_profile(&self) -> Result<ProfileRecord, StoreError> {
        let row = self
            .conn()
            .query_row(
                "SELECT profile_json, profile_revision FROM resume_state WHERE id = 1",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?;
        match row {
            Some((json, revision)) => Ok(ProfileRecord { profile: serde_json::from_str(&json)?, revision }),
            None => Ok(ProfileRecord { profile: empty_profile(), revision: 0 }),
        }
    }

    /// `expected_revision` 是调用方读到的版本号；对不上返回 `Conflict`，不覆盖别处刚存的内容。
    /// 像密码、验证码的内容整份拒绝（不悄悄删掉用户正在编辑的字段）。
    pub fn save_profile(&mut self, profile: Value, expected_revision: i64) -> Result<ProfileRecord, StoreError> {
        validate_profile(&profile)?;
        reject_secrets(&profile)?;
        self.ensure_resume_state()?;
        let current = self.get_profile()?.revision;
        if current != expected_revision {
            return Err(StoreError::Conflict("「我的信息」已在别处改过，请刷新后再保存。".into()));
        }
        let revision = current + 1;
        self.conn().execute(
            "UPDATE resume_state SET profile_json = ?1, profile_revision = ?2, updated_at = ?3 WHERE id = 1",
            params![profile.to_string(), revision, now_utc()],
        )?;
        Ok(ProfileRecord { profile, revision })
    }
}
