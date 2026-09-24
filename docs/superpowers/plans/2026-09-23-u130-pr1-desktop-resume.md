# #130 PR 1：桌面接手简历模板与「我的信息」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面档案库保存简历模板和「我的信息」，桌面新增「简历」页，完成插件管理页里模板与我的信息的全部操作（Excel/CSV 导入、重新导入覆盖、导出 Excel、设为当前、重命名、删除、预览；我的信息表单编辑）。

**Architecture:** `archive-store` 迁移到 v4，新增 `resume_templates` 与 `resume_state` 两张表，模板分组与档案都以插件现有的 JSON 形状存储。Excel/CSV 互转放进不依赖 Tauri 的新 crate `resume-sheet`，表头与插件一致。命令层 `resume_commands.rs` 负责读文件、写文件、拦截密码类内容。前端新增 React 视图，「我的信息」的字段定义与规范化直接复用插件的 `profile-fields.js`（桌面保存一份副本，测试锁死两份一致）。

**Tech Stack:** Rust（rusqlite、serde_json、calamine 0.30、rust_xlsxwriter 0.92、csv、regex）、Tauri 2、React 19 + TypeScript、Vitest + Testing Library、`node --test`。

**上级计划：** [2026-09-23-u130-pr-breakdown.md](2026-09-23-u130-pr-breakdown.md) · [#130](https://github.com/TshyGO/resume-form-assistant-plugin/issues/130)

**基线：** `ccd17e1`（main，含 #150）

---

## 已核实的事实（直接用，不必再查）

- 插件模板形状：`{ id, name, groups: [{ name, fields: [{ key, value }] }] }`。规范化（`popup.js` `normalizeTemplate`）：组名 trim、空组名记为「未分类」；字段 key trim、空 key 丢弃；字段 value 原样保留；没有字段的组丢弃；模板名 trim、空名记为「未命名模板」。
- 插件导入规则（`popup.js` `parseTemplateFile`）：只收 `.xlsx`、`.csv`；取第一个工作表；跳过整行空白的行；第一行是表头；每行取前三列（一级分类、字段名、值）并 trim；三列全空跳过；字段名为空的行收集行号一起报错（超过 20 行改报「整列错位」）；组按首次出现的顺序排列；最后一个字段都没有报「未解析到任何字段，请检查 Excel 格式。」
- 插件导出：表头 `["一级分类", "字段名", "值"]`，工作表名「简历模板」，文件名为模板名去掉 `\/:*?"<>|` 与控制字符，空名用「简历模板」，扩展名 `.xlsx`。
- 插件命名（`resolveTemplateName`）：重名时依次尝试 `名 (2)`、`名 (3)`…；模板名取自文件名去扩展名。新模板插到列表最前并设为当前；重新导入覆盖原模板的分组、设为当前，并提示字段数「A → B」，数量不变时给出核对提醒（`buildImportSuccessMessage`）。
- 插件当前模板：存的 id 不存在时回落到列表第一个（`normalizeStore`）。
- 「我的信息」：`{ values: { <fieldId>: string }, family: [{ relation, name, birth, political, company, job, phone }], custom: [{ key, value }] }`，字段定义、规范化、合并都在仓库根的 `profile-fields.js`（IIFE，非 CommonJS 环境下挂到 `globalThis.ResumeProProfile`）。补充字段上限 200。`SECRET_LABEL`、`SECRET_VALUE` 两个正则识别密码类内容。
- `archive-store`：`SCHEMA_VERSION = 3`（`src/schema.rs:13`），迁移追加到 `MIGRATIONS`；业务操作写成 `impl StoreTx<'_>` 的方法，`src/facade.rs` 为每个方法包一个 `&self` 事务版本；`new_uuid()` 在 `crate::tx`，`now_utc()` 在 `crate::timeutil`。集成测试放 `tests/*.rs`，用 `ArchiveStore::open(ArchiveConfig::new(root.join("archive"), root.join("current.json")))`。
- `crates/backup` 不依赖 `archive-store`：`tests/writing.rs:48,101` 里的 `schema_version: 3` 是测试自己造的清单，升到 v4 **不用改**。恢复时的版本兼容由 `src-tauri` 用 `current_schema_version()` 判断，也不用改。
- 档案库文件路径用 `ArchiveConfig::db_path()`（`store.rs:41`，即 `archive_dir/archive.db`）。
- `CommandError::from(StoreError)` 的 message 是 `err.to_string()`，带英文前缀（`invalid input: …`）。简历命令要给用户看中文，自己做映射。
- Rust 版本：所有 crate 声明 `rust-version = "1.77.2"`，CI 工具链 1.94.0。`calamine` 0.30.1、`rust_xlsxwriter` 0.92.0 是 MSRV ≤ 1.77.2 的最新版（均为 1.75），`csv` 1.4.0 为 1.73。上界要卡住，写法照 `src-tauri/Cargo.toml` 里 `reqwest` 的注释。
- 每个 crate 自带 `Cargo.lock`，CI 用 `--locked`。新 crate 要在 `.github/workflows/desktop.yml` 与 `desktop/package.json` 的 `test` 脚本里各加一行。
- 前端：`desktop/package.json` 是 `"type": "module"`；`.ts` 测试跑 `npm run test:ui`（`node --test --experimental-strip-types`），`.tsx` 测试跑 `npm run test:react`（Vitest + jsdom）；组件经 `useInvoke()` 调命令，测试里用 `InvokeProvider` 注入假 invoke（范例 `desktop/src/ai/AiSettings.test.tsx`）；挂载用 `mountReact`（`desktop/src/react/mount.tsx`）。主视图切换在 `desktop/src/main.ts:38-66`，导航按钮在 `desktop/index.html:14-20`。
- 文件对话框：前端经 `window.__TAURI__.dialog` 调用（`main.ts:275-310`）。`src-tauri/capabilities/default.json` 目前只授权了 `dialog:allow-open`，**没有 `dialog:allow-save`**，导出 Excel 需要补上（Task 8 顺带核实 D12 备份导出是否也受影响）。
- `docs/desktop-mvp/data-privacy.md` §4.2 写着「活模板仅 `chrome.storage.local`」「不得把活模板全量写入桌面」，与 #130 决策冲突，本 PR 改写。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `desktop/crates/archive-store/src/schema.rs`（改） | v4 迁移：两张新表 |
| `desktop/crates/archive-store/src/resume.rs`（新） | 类型、规范化、校验、`StoreTx` 上的模板与档案操作 |
| `desktop/crates/archive-store/src/facade.rs`（改） | `&self` 包装 |
| `desktop/crates/archive-store/src/lib.rs`（改） | 导出 |
| `desktop/crates/archive-store/tests/resume.rs`（新） | 集成测试 |
| `desktop/crates/resume-sheet/`（新 crate） | Excel/CSV ↔ 分组 |
| `desktop/src-tauri/src/resume_commands.rs`（新） | 读写文件、密码类内容拦截、错误映射 |
| `desktop/src-tauri/src/lib.rs`（改） | 注册 Tauri 命令 |
| `desktop/src-tauri/capabilities/default.json`（改） | `dialog:allow-save` |
| `desktop/src/resume/profile-fields.js`（新，副本） | 与仓库根 `profile-fields.js` 字节一致 |
| `desktop/src/resume/profile.ts`（新） | 给 TS 用的类型化入口 |
| `desktop/src/resume/profile-sync.test.ts`（新） | 锁死两份 `profile-fields.js` 一致 |
| `desktop/src/resume/resume-text.ts`（新）+ `.test.ts` | 导入提示文案、导出文件名 |
| `desktop/src/resume/TemplateList.tsx`（新）+ `.test.tsx` | 模板列表与操作 |
| `desktop/src/resume/ProfileForm.tsx`（新）+ `.test.tsx` | 我的信息表单 |
| `desktop/src/resume/ResumeView.tsx`、`mount.tsx`（新） | 页面组合与挂载 |
| `desktop/src/api.ts`（改） | 视图类型 |
| `desktop/index.html`、`desktop/src/main.ts`、`desktop/src/styles.css`（改） | 导航与挂载 |
| `docs/desktop-mvp/data-privacy.md`（改） | §1、§4.2、§6.1 |

---

### Task 1：档案库 v4 迁移

**Files:**
- Modify: `desktop/crates/archive-store/src/schema.rs`
- Test: `desktop/crates/archive-store/tests/resume.rs`（新建）

- [ ] **Step 1：写失败测试**

新建 `desktop/crates/archive-store/tests/resume.rs`：

```rust
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
    assert_eq!(tables, vec!["resume_state", "resume_templates"]);
}
```

集成测试可以直接用包的 `[dependencies]` 里的 `rusqlite`（`tests/storage.rs:499` 就是这么用的），不用加依赖。

- [ ] **Step 2：确认失败**

Run: `cd desktop && cargo test --manifest-path crates/archive-store/Cargo.toml --locked --test resume`
Expected: FAIL，`left: 3, right: 4`。

- [ ] **Step 3：加迁移**

`src/schema.rs`：把 `pub const SCHEMA_VERSION: i64 = 3;` 改为 `4`，在 `V3_TODO_REMINDER_BOOKKEEPING` 之后加：

```rust
/// #130：简历模板与「我的信息」由桌面保存，插件不再存副本。
/// 分组与档案沿用插件 `chrome.storage.local` 的 JSON 形状，迁移与导入零转换。
/// `resume_state` 只有一行：当前模板与档案。当前模板不设外键，删除模板时由代码改指向。
pub const V4_RESUME: &str = r#"
CREATE TABLE resume_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  groups_json TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_resume_templates_name ON resume_templates(name);
CREATE INDEX idx_resume_templates_position ON resume_templates(position);

CREATE TABLE resume_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_template_id TEXT,
  profile_json TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
"#;
```

并在 `MIGRATIONS` 末尾追加：

```rust
    Migration {
        to_version: 4,
        description: "resume templates and profile owned by the desktop (#130)",
        sql: V4_RESUME,
    },
```

文件头注释第一行 `//! 物理 schema(v1 + v2)与迁移注册表。` 改为 `//! 物理 schema 与迁移注册表。`

- [ ] **Step 4：跑测试**

Run: `cd desktop && cargo test --manifest-path crates/archive-store/Cargo.toml --locked`
Expected: 全部 PASS（`tests/storage.rs` 里按 `MIGRATIONS` 最后一项取版本的用例会自动跟上 v4）。

- [ ] **Step 5：提交**

```bash
git add desktop/crates/archive-store
git commit -m "feat(store): 档案库 v4，新增简历模板与档案表 (#130)"
```

---

### Task 2：模板类型、规范化与读写

**Files:**
- Create: `desktop/crates/archive-store/src/resume.rs`
- Modify: `desktop/crates/archive-store/src/lib.rs`、`src/facade.rs`
- Test: `desktop/crates/archive-store/tests/resume.rs`

- [ ] **Step 1：写失败测试**（追加到 `tests/resume.rs`）

```rust
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
```

- [ ] **Step 2：确认失败**

Run: `cd desktop && cargo test --manifest-path crates/archive-store/Cargo.toml --locked --test resume`
Expected: 编译失败，`TemplateField`、`create_template` 等未定义。

- [ ] **Step 3：实现**

新建 `desktop/crates/archive-store/src/resume.rs`：

```rust
//! 简历模板与「我的信息」（#130）。桌面是唯一来源；插件经协议只读，
//! 只能做两种写：切换当前模板、保存「我的信息」（见 u130 计划 PR 3）。
//!
//! 形状沿用插件 `chrome.storage.local`，规范化规则逐条对齐 `popup.js`
//! 的 `normalizeTemplate` 与 `resolveTemplateName`，改这里要同步看那边。

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::StoreError;
use crate::timeutil::now_utc;
use crate::tx::{new_uuid, StoreTx};

/// 单个模板序列化后的上限。协议信封 64 KiB，一次 `resume.read` 要装下
/// 当前模板全文 + 档案 + 列表摘要，所以模板和档案各留 48 KiB 以内。
pub const MAX_TEMPLATE_BYTES: usize = 48 * 1024;
pub const MAX_PROFILE_BYTES: usize = 48 * 1024;
/// 与插件 `profile-fields.js` 的 `MAX_CUSTOM_FIELDS` 一致。
pub const MAX_CUSTOM_FIELDS: usize = 200;

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

fn clean_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() { UNNAMED.into() } else { trimmed.into() }
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

fn checked_groups(groups: Vec<TemplateGroup>) -> Result<(Vec<TemplateGroup>, String), StoreError> {
    let groups = normalize_groups(groups);
    if groups.is_empty() {
        return Err(invalid("未解析到任何字段，请检查 Excel 格式。"));
    }
    let json = groups_json(&groups)?;
    Ok((groups, json))
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
    pub fn create_template(&mut self, name: &str, groups: Vec<TemplateGroup>) -> Result<ResumeTemplate, StoreError> {
        let (_, json) = checked_groups(groups)?;
        let name = self.unique_template_name(&clean_name(name))?;
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
        self.get_template(&id)?
            .ok_or_else(|| StoreError::Internal("template vanished in same transaction".into()))
    }

    /// 「重新导入」：换掉分组，名字与位置不动，设为当前。返回覆盖前的字段数。
    pub fn replace_template_groups(
        &mut self,
        id: &str,
        groups: Vec<TemplateGroup>,
    ) -> Result<(ResumeTemplate, usize), StoreError> {
        let previous = self
            .get_template(id)?
            .ok_or_else(|| StoreError::NotFound(format!("template {id}")))?;
        let (_, json) = checked_groups(groups)?;
        self.conn().execute(
            "UPDATE resume_templates SET groups_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![json, now_utc(), id],
        )?;
        self.set_active_template(id)?;
        let updated = self
            .get_template(id)?
            .ok_or_else(|| StoreError::Internal("template vanished in same transaction".into()))?;
        Ok((updated, field_count(&previous.groups)))
    }

    /// 改名不自动加序号：用户明确要这个名字，撞了就说出来。
    pub fn rename_template(&mut self, id: &str, name: &str) -> Result<ResumeTemplate, StoreError> {
        if !self.template_exists(id)? {
            return Err(StoreError::NotFound(format!("template {id}")));
        }
        let name = clean_name(name);
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
    pub fn save_profile(&mut self, profile: Value, expected_revision: i64) -> Result<ProfileRecord, StoreError> {
        validate_profile(&profile)?;
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
```

`src/lib.rs`：在 `pub mod receipts;` 之后加 `pub mod resume;`，在 `pub use receipts::...` 附近加：

```rust
pub use resume::{
    empty_profile, field_count, normalize_groups, validate_profile, ProfileRecord, ResumeOverview,
    ResumeTemplate, TemplateField, TemplateGroup, TemplateSummary, MAX_CUSTOM_FIELDS,
    MAX_PROFILE_BYTES, MAX_TEMPLATE_BYTES,
};
```

`src/facade.rs`：文件顶部 `use` 区加 `use crate::resume::{ProfileRecord, ResumeOverview, ResumeTemplate, TemplateGroup};`，在 `impl ArchiveStore {` 块末尾加：

```rust
    // ---- 简历模板与「我的信息」(#130) ----

    pub fn resume_overview(&self) -> Result<ResumeOverview, StoreError> {
        self.transaction(|tx| tx.resume_overview())
    }

    pub fn get_template(&self, id: &str) -> Result<Option<ResumeTemplate>, StoreError> {
        self.transaction(|tx| tx.get_template(id))
    }

    pub fn create_template(&self, name: &str, groups: Vec<TemplateGroup>) -> Result<ResumeTemplate, StoreError> {
        self.transaction(|tx| tx.create_template(name, groups))
    }

    pub fn replace_template_groups(
        &self,
        id: &str,
        groups: Vec<TemplateGroup>,
    ) -> Result<(ResumeTemplate, usize), StoreError> {
        self.transaction(|tx| tx.replace_template_groups(id, groups))
    }

    pub fn rename_template(&self, id: &str, name: &str) -> Result<ResumeTemplate, StoreError> {
        self.transaction(|tx| tx.rename_template(id, name))
    }

    pub fn delete_template(&self, id: &str) -> Result<(), StoreError> {
        self.transaction(|tx| tx.delete_template(id))
    }

    pub fn set_active_template(&self, id: &str) -> Result<(), StoreError> {
        self.transaction(|tx| tx.set_active_template(id))
    }

    pub fn get_profile(&self) -> Result<crate::resume::ProfileRecord, StoreError> {
        self.transaction(|tx| tx.get_profile())
    }

    pub fn save_profile(&self, profile: serde_json::Value, expected_revision: i64) -> Result<ProfileRecord, StoreError> {
        self.transaction(|tx| tx.save_profile(profile, expected_revision))
    }
```

- [ ] **Step 4：跑测试**

Run: `cd desktop && cargo test --manifest-path crates/archive-store/Cargo.toml --locked`
Expected: 全部 PASS。

- [ ] **Step 5：提交**

```bash
git add desktop/crates/archive-store
git commit -m "feat(store): 简历模板读写，规范化与命名对齐插件 (#130)"
```

---

### Task 3：重新导入、改名、删除、当前模板、我的信息

**Files:**
- Test: `desktop/crates/archive-store/tests/resume.rs`（实现已在 Task 2 写完，本任务补齐行为用例；任何一条失败都回到 `src/resume.rs` 修）

- [ ] **Step 1：写测试**（追加）

```rust
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
```

`tests/resume.rs` 顶部如需 `serde_json`，确认 `[dev-dependencies]` 或 `[dependencies]` 里有（`[dependencies]` 已有 `serde_json = "1"`，集成测试可直接用）。

- [ ] **Step 2：跑测试**

Run: `cd desktop && cargo test --manifest-path crates/archive-store/Cargo.toml --locked --test resume`
Expected: 全部 PASS。若 `templates_and_profile_survive_reopening` 因档案目录锁失败（同进程二次 open），在第一个作用域末尾显式 `drop(db)`；仍失败则查 `tests/storage.rs` 里重开档案的现成写法照抄。

- [ ] **Step 3：提交**

```bash
git add desktop/crates/archive-store/tests/resume.rs
git commit -m "test(store): 重新导入、改名、删除、当前模板与档案版本号 (#130)"
```

---

### Task 4：`resume-sheet` crate（Excel/CSV ↔ 分组）

**Files:**
- Create: `desktop/crates/resume-sheet/Cargo.toml`、`desktop/crates/resume-sheet/src/lib.rs`、`desktop/crates/resume-sheet/Cargo.lock`（生成）
- Modify: `desktop/package.json`、`.github/workflows/desktop.yml`

- [ ] **Step 1：建 crate 与失败测试**

`desktop/crates/resume-sheet/Cargo.toml`：

```toml
[package]
name = "resume-sheet"
version = "0.1.0"
edition = "2021"
rust-version = "1.77.2"
description = "Resume Pro #130: 简历模板与 Excel/CSV 互转。表头、跳行、报错口径与插件 popup.js 一致。不碰数据库，不认识 Tauri。"
publish = false

[dependencies]
# 上界卡住：再往上的版本要求 Rust 1.88，而本仓库各 crate 声明的 rust-version 是 1.77.2。
calamine = ">=0.30.1, <0.31"
rust_xlsxwriter = ">=0.92.0, <0.93"
csv = "1.3"
```

`desktop/crates/resume-sheet/src/lib.rs` 先只写测试模块和空壳，确认失败：

```rust
//! 简历模板 ↔ Excel/CSV。口径逐条对齐插件 `popup.js` 的 `parseTemplateFile`、
//! `templateToSheetRows`、`templateExportFileName`、`getTemplateNameFromFile`。

#[cfg(test)]
mod tests {
    use super::*;

    fn g(name: &str, fields: &[(&str, &str)]) -> Group {
        Group {
            name: name.into(),
            fields: fields.iter().map(|(k, v)| Field { key: (*k).into(), value: (*v).into() }).collect(),
        }
    }

    #[test]
    fn csv_rows_become_groups_in_first_seen_order() {
        let csv = "\u{feff}一级分类,字段名,值\n基本信息,姓名, 张三 \n,手机号码,138\n\n教育经历,学校,某大学\n基本信息,邮箱,a@b.c\n,,\n";
        let groups = parse("我的简历.csv", csv.as_bytes()).unwrap();
        assert_eq!(
            groups,
            vec![
                g("基本信息", &[("姓名", "张三"), ("邮箱", "a@b.c")]),
                g("未分类", &[("手机号码", "138")]),
                g("教育经历", &[("学校", "某大学")]),
            ]
        );
    }

    #[test]
    fn rows_without_a_field_name_are_all_reported() {
        let csv = "一级分类,字段名,值\n基本信息,,张三\n基本信息,邮箱,x\n教育,,某大学\n";
        let err = parse("a.csv", csv.as_bytes()).unwrap_err();
        assert_eq!(err.to_string(), "第 2、4 行缺少「字段名」（第二列）。");
    }

    #[test]
    fn many_missing_names_suggest_a_shifted_column() {
        let mut csv = String::from("一级分类,字段名,值\n");
        for _ in 0..21 {
            csv.push_str("组,,值\n");
        }
        let err = parse("a.csv", csv.as_bytes()).unwrap_err();
        assert_eq!(err.to_string(), "共 21 行缺少「字段名」（第二列），请检查第二列是不是整列错位了。");
    }

    #[test]
    fn a_header_only_sheet_has_no_fields() {
        let err = parse("a.csv", "一级分类,字段名,值\n".as_bytes()).unwrap_err();
        assert_eq!(err.to_string(), "未解析到任何字段，请检查 Excel 格式。");
        let err = parse("a.csv", b"").unwrap_err();
        assert_eq!(err.to_string(), "Excel 内容为空。");
    }

    #[test]
    fn only_xlsx_and_csv_are_accepted() {
        assert_eq!(parse("a.xls", b"x").unwrap_err().to_string(), "仅支持 .xlsx 或 .csv 文件。");
        assert_eq!(parse("a", b"x").unwrap_err().to_string(), "仅支持 .xlsx 或 .csv 文件。");
    }

    #[test]
    fn a_non_utf8_csv_is_explained() {
        let gbk_like = [0xd0u8, 0xd5, 0xc3, 0xfb, b',', b'x', b'\n'];
        assert_eq!(parse("a.csv", &gbk_like).unwrap_err().to_string(), "CSV 需要 UTF-8 编码：请在 Excel 里另存为「CSV UTF-8」，或直接用 .xlsx。");
    }

    #[test]
    fn an_exported_workbook_reads_back_the_same() {
        let groups = vec![
            g("基本信息", &[("姓名", "张三"), ("手机号码", "13800000000")]),
            g("教育经历", &[("学校", "某大学"), ("说明", "")]),
        ];
        let bytes = write_xlsx(&groups).unwrap();
        assert_eq!(parse("导出.xlsx", &bytes).unwrap(), groups);
    }

    #[test]
    fn a_broken_xlsx_is_unreadable() {
        assert_eq!(parse("a.xlsx", b"not a zip").unwrap_err().to_string(), "读不出这个 Excel 文件，确认它没有损坏、也不是加密文件。");
    }

    #[test]
    fn names_follow_the_plugin() {
        assert_eq!(template_name_from_file("校招简历.xlsx"), "校招简历");
        assert_eq!(template_name_from_file(".xlsx"), "未命名模板");
        assert_eq!(template_name_from_file("a.b.csv"), "a.b");
        assert_eq!(export_file_name("a/b:c*?\"<>|\u{1}名"), "abc名.xlsx");
        assert_eq!(export_file_name("  "), "简历模板.xlsx");
    }
}
```

Run: `cd desktop && cargo test --manifest-path crates/resume-sheet/Cargo.toml`（首次不加 `--locked`，会生成 `Cargo.lock`）
Expected: 编译失败，`Group`、`parse` 等未定义。

- [ ] **Step 2：实现**

在 `src/lib.rs` 测试模块之前写：

```rust
use std::fmt;
use std::io::Cursor;

use calamine::{open_workbook_from_rs, Data, Reader, Xlsx};
use rust_xlsxwriter::Workbook;

pub const HEADER: [&str; 3] = ["一级分类", "字段名", "值"];
pub const SHEET_NAME: &str = "简历模板";
const UNGROUPED: &str = "未分类";
const UNNAMED: &str = "未命名模板";
const MAX_LISTED_ROW_NUMBERS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub name: String,
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SheetError {
    UnsupportedExtension,
    Unreadable,
    NotUtf8,
    NoSheet,
    Empty,
    MissingKeys(Vec<usize>),
    NoFields,
    WriteFailed,
}

impl fmt::Display for SheetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedExtension => f.write_str("仅支持 .xlsx 或 .csv 文件。"),
            Self::Unreadable => f.write_str("读不出这个 Excel 文件，确认它没有损坏、也不是加密文件。"),
            Self::NotUtf8 => f.write_str("CSV 需要 UTF-8 编码：请在 Excel 里另存为「CSV UTF-8」，或直接用 .xlsx。"),
            Self::NoSheet => f.write_str("文件中没有可用工作表。"),
            Self::Empty => f.write_str("Excel 内容为空。"),
            // 手改的表要一次看到所有出错行；太多时几乎都是整列错位，列一墙数字没用。
            Self::MissingKeys(rows) if rows.len() > MAX_LISTED_ROW_NUMBERS => write!(
                f,
                "共 {} 行缺少「字段名」（第二列），请检查第二列是不是整列错位了。",
                rows.len()
            ),
            Self::MissingKeys(rows) => {
                let list: Vec<String> = rows.iter().map(|r| r.to_string()).collect();
                write!(f, "第 {} 行缺少「字段名」（第二列）。", list.join("、"))
            }
            Self::NoFields => f.write_str("未解析到任何字段，请检查 Excel 格式。"),
            Self::WriteFailed => f.write_str("生成 Excel 失败。"),
        }
    }
}

impl std::error::Error for SheetError {}

/// 一行的前三列，带表格里的真实行号（从 1 起）。
type Row = (usize, [String; 3]);

fn extension(file_name: &str) -> Option<String> {
    let (stem, ext) = file_name.rsplit_once('.')?;
    let _ = stem;
    Some(ext.to_ascii_lowercase())
}

pub fn parse(file_name: &str, bytes: &[u8]) -> Result<Vec<Group>, SheetError> {
    let rows = match extension(file_name).as_deref() {
        Some("xlsx") => xlsx_rows(bytes)?,
        Some("csv") => csv_rows(bytes)?,
        _ => return Err(SheetError::UnsupportedExtension),
    };
    groups_from_rows(rows)
}

fn cell_text(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        // 手机号、学号这类整数存成浮点时，别显示成 1.38e10 或带 .0。
        Data::Float(v) if v.fract() == 0.0 && v.abs() < 1e15 => format!("{}", *v as i64),
        Data::Int(v) => v.to_string(),
        other => other.to_string(),
    }
}

fn xlsx_rows(bytes: &[u8]) -> Result<Vec<Row>, SheetError> {
    let mut workbook: Xlsx<_> =
        open_workbook_from_rs(Cursor::new(bytes.to_vec())).map_err(|_| SheetError::Unreadable)?;
    let first = workbook.sheet_names().first().cloned().ok_or(SheetError::NoSheet)?;
    let range = workbook.worksheet_range(&first).map_err(|_| SheetError::Unreadable)?;
    let (Some((top, _)), Some((bottom, _))) = (range.start(), range.end()) else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for r in top..=bottom {
        let cell = |c: u32| range.get_value((r, c)).map(cell_text).unwrap_or_default();
        rows.push((r as usize + 1, [cell(0), cell(1), cell(2)]));
    }
    Ok(rows)
}

fn csv_rows(bytes: &[u8]) -> Result<Vec<Row>, SheetError> {
    let text = std::str::from_utf8(bytes).map_err(|_| SheetError::NotUtf8)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut rows = Vec::new();
    for (index, record) in reader.records().enumerate() {
        let record = record.map_err(|_| SheetError::Unreadable)?;
        let line = record.position().map(|p| p.line() as usize).unwrap_or(index + 1);
        let cell = |c: usize| record.get(c).unwrap_or("").to_string();
        rows.push((line, [cell(0), cell(1), cell(2)]));
    }
    Ok(rows)
}

fn groups_from_rows(rows: Vec<Row>) -> Result<Vec<Group>, SheetError> {
    let mut rows = rows
        .into_iter()
        .map(|(n, cells)| (n, cells.map(|c| c.trim().to_string())))
        .filter(|(_, cells)| cells.iter().any(|c| !c.is_empty()));
    // 第一行非空行是表头。
    if rows.next().is_none() {
        return Err(SheetError::Empty);
    }
    let mut groups: Vec<Group> = Vec::new();
    let mut missing = Vec::new();
    for (line, [group, key, value]) in rows {
        if key.is_empty() {
            missing.push(line);
            continue;
        }
        let name = if group.is_empty() { UNGROUPED.to_string() } else { group };
        match groups.iter_mut().find(|g| g.name == name) {
            Some(existing) => existing.fields.push(Field { key, value }),
            None => groups.push(Group { name, fields: vec![Field { key, value }] }),
        }
    }
    if !missing.is_empty() {
        return Err(SheetError::MissingKeys(missing));
    }
    if groups.is_empty() {
        return Err(SheetError::NoFields);
    }
    Ok(groups)
}

/// 表头和列序与 `parse` 读的同一套，导出的文件能原样导回来。
/// 不剔密码类字段：这是用户自己那份 Excel 的往返，剔了就导不回去了。
pub fn write_xlsx(groups: &[Group]) -> Result<Vec<u8>, SheetError> {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet.set_name(SHEET_NAME).map_err(|_| SheetError::WriteFailed)?;
    for (col, title) in HEADER.iter().enumerate() {
        sheet.write_string(0, col as u16, *title).map_err(|_| SheetError::WriteFailed)?;
    }
    let mut row: u32 = 1;
    for group in groups {
        for field in &group.fields {
            sheet.write_string(row, 0, &group.name).map_err(|_| SheetError::WriteFailed)?;
            sheet.write_string(row, 1, &field.key).map_err(|_| SheetError::WriteFailed)?;
            sheet.write_string(row, 2, &field.value).map_err(|_| SheetError::WriteFailed)?;
            row += 1;
        }
    }
    workbook.save_to_buffer().map_err(|_| SheetError::WriteFailed)
}

/// 对齐 `getTemplateNameFromFile`：去掉最后一个扩展名。
pub fn template_name_from_file(file_name: &str) -> String {
    let stem = match file_name.rsplit_once('.') {
        Some((stem, _)) => stem,
        None => file_name,
    };
    let stem = stem.trim();
    if stem.is_empty() { UNNAMED.into() } else { stem.into() }
}

/// 对齐 `templateExportFileName`：只去掉文件系统不收的字符，保留原名，导回来名字不变。
pub fn export_file_name(template_name: &str) -> String {
    let safe: String = template_name
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    let safe = safe.trim();
    format!("{}.xlsx", if safe.is_empty() { "简历模板" } else { safe })
}
```

说明：插件报错行号是「去掉空白行后的序号 + 2」，这里改用表格里的真实行号，用户在 Excel 里直接能对上。这是有意的改进，不是漂移。

- [ ] **Step 3：跑测试**

Run: `cd desktop && cargo test --manifest-path crates/resume-sheet/Cargo.toml`
Expected: 全部 PASS。若 `calamine` 0.30 的 `Range::start/end/get_value` 签名与上面不符，按 `cargo doc --manifest-path crates/resume-sheet/Cargo.toml --open` 里的实际签名改（语义：`get_value` 取**绝对**坐标）。若 `rust_xlsxwriter` 0.92 的 `write_string` 行列类型不同，同样按文档改。

然后：`cargo test --manifest-path crates/resume-sheet/Cargo.toml --locked` 必须也 PASS（锁文件已生成）。

- [ ] **Step 4：接入 CI 与脚本**

`desktop/package.json` 的 `scripts` 加 `"test:resume-sheet": "cargo test --manifest-path crates/resume-sheet/Cargo.toml --locked",`，并在 `"test"` 串里 `npm run test:ai-extract` 之后插入 `&& npm run test:resume-sheet`。

`.github/workflows/desktop.yml`：照 `crates/ai-extract` 那一步（约第 127-129 行）复制一步，名字写 `Resume sheet tests`，命令 `cargo test --manifest-path crates/resume-sheet/Cargo.toml --locked --target ${{ matrix.rust-target }}`。

- [ ] **Step 5：提交**

```bash
git add desktop/crates/resume-sheet desktop/package.json .github/workflows/desktop.yml
git commit -m "feat(desktop): resume-sheet crate，模板与 Excel/CSV 互转 (#130)"
```

---

### Task 5：命令层 `resume_commands.rs`

**Files:**
- Create: `desktop/src-tauri/src/resume_commands.rs`
- Modify: `desktop/src-tauri/Cargo.toml`（加 `resume-sheet = { path = "../crates/resume-sheet" }`，按字母序放在 `resume-pro-protocol` 前），`desktop/src-tauri/src/lib.rs`（`mod resume_commands;`）

- [ ] **Step 1：写失败测试**

新建 `desktop/src-tauri/src/resume_commands.rs`，先只放测试：

```rust
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
}
```

先 `grep -n "tempfile" desktop/src-tauri/Cargo.toml` 确认 dev-dependencies 已有 `tempfile`（没有就加 `tempfile = "3"`）。

Run: `cd desktop && cargo test --manifest-path src-tauri/Cargo.toml --locked --lib resume_commands`
Expected: 编译失败（`--locked` 若因新依赖报锁文件需要更新，先不带 `--locked` 跑一次生成锁）。

- [ ] **Step 2：实现**（放在测试模块上方）

```rust
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
            let name = resume_sheet::template_name_from_file(file_name);
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
```

`lib.rs` 顶部模块列表按字母序加 `mod resume_commands;`。

- [ ] **Step 3：跑测试**

Run: `cd desktop && cargo test --manifest-path src-tauri/Cargo.toml --locked --lib resume_commands`
Expected: PASS。若 `open_store` 签名不是 `(&Path, &Path)`，按 `src-tauri/src/commands.rs:35` 实际签名改测试里的调用。

- [ ] **Step 4：提交**

```bash
git add desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock desktop/src-tauri/src/resume_commands.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): 简历命令层，文件导入导出与密码类内容拦截 (#130)"
```

---

### Task 6：注册 Tauri 命令与文件对话框权限

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs`、`desktop/src-tauri/capabilities/default.json`

- [ ] **Step 1：加命令**

在 `lib.rs` 里 `create_todo_cmd` 附近加（沿用 `with_store` 模式）：

```rust
#[tauri::command]
fn resume_overview_cmd(state: State<AppState>) -> Result<archive_store::ResumeOverview, CommandError> {
    with_store(&state, resume_commands::overview)
}

#[tauri::command]
fn get_resume_template_cmd(state: State<AppState>, id: String) -> Result<archive_store::ResumeTemplate, CommandError> {
    with_store(&state, |store| resume_commands::get_template(store, &id))
}

#[tauri::command]
fn import_resume_template_cmd(
    state: State<AppState>,
    path: String,
    replace_id: Option<String>,
) -> Result<resume_commands::ImportResult, CommandError> {
    with_store(&state, |store| {
        resume_commands::import_template(store, std::path::Path::new(&path), replace_id.as_deref())
    })
}

#[tauri::command]
fn export_resume_template_cmd(state: State<AppState>, id: String, path: String) -> Result<(), CommandError> {
    with_store(&state, |store| resume_commands::export_template(store, &id, std::path::Path::new(&path)))
}

#[tauri::command]
fn rename_resume_template_cmd(
    state: State<AppState>,
    id: String,
    name: String,
) -> Result<archive_store::TemplateSummary, CommandError> {
    with_store(&state, |store| resume_commands::rename_template(store, &id, &name))
}

#[tauri::command]
fn delete_resume_template_cmd(state: State<AppState>, id: String) -> Result<archive_store::ResumeOverview, CommandError> {
    with_store(&state, |store| resume_commands::delete_template(store, &id))
}

#[tauri::command]
fn set_active_resume_template_cmd(
    state: State<AppState>,
    id: String,
) -> Result<archive_store::ResumeOverview, CommandError> {
    with_store(&state, |store| resume_commands::set_active_template(store, &id))
}

#[tauri::command]
fn get_profile_cmd(state: State<AppState>) -> Result<archive_store::ProfileRecord, CommandError> {
    with_store(&state, resume_commands::get_profile)
}

#[tauri::command]
fn save_profile_cmd(
    state: State<AppState>,
    profile: serde_json::Value,
    revision: i64,
) -> Result<archive_store::ProfileRecord, CommandError> {
    with_store(&state, |store| resume_commands::save_profile(store, profile.clone(), revision))
}
```

在 `run()` 的 `tauri::generate_handler![...]` 列表里（`create_todo_cmd` 附近）加上这 9 个命令名。

- [ ] **Step 2：文件对话框权限**

`capabilities/default.json` 的 `permissions` 数组在 `"dialog:allow-open"` 后加 `"dialog:allow-save"`。然后核实 D12 备份导出：`grep -rn "allow-save" desktop/src-tauri desktop/src-tauri/gen 2>/dev/null`、`git log -S"dialog.save" --oneline -- desktop/src/main.ts`；如果备份导出此前确实缺这个权限，在 PR 描述里单独写一条「顺带修复：备份导出的保存对话框缺权限」，并在 #39 下留言提醒 D12 验收复核。

- [ ] **Step 3：编译与全量 Rust 测试**

Run: `cd desktop && cargo build --manifest-path src-tauri/Cargo.toml --locked --bins && cargo test --manifest-path src-tauri/Cargo.toml --locked --bins --lib`
Expected: 编译通过，测试全绿。

- [ ] **Step 4：提交**

```bash
git add desktop/src-tauri/src/lib.rs desktop/src-tauri/capabilities/default.json
git commit -m "feat(desktop): 注册简历命令，补保存对话框权限 (#130)"
```

---

### Task 7：前端复用 `profile-fields.js` 并锁死一致

**Files:**
- Create: `desktop/src/resume/profile-fields.js`（副本）、`desktop/src/resume/profile.ts`、`desktop/src/resume/profile-sync.test.ts`

- [ ] **Step 1：写失败测试** `desktop/src/resume/profile-sync.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 插件与桌面必须用同一份「我的信息」字段定义：字段 id 是存储键，两边一改一不改就会丢数据。
// 改字段时只改仓库根的 profile-fields.js，再把它原样复制到这里。
test("桌面的 profile-fields.js 与插件的一字不差", () => {
  const plugin = readFileSync(new URL("../../../profile-fields.js", import.meta.url), "utf8");
  const desktop = readFileSync(new URL("./profile-fields.js", import.meta.url), "utf8");
  assert.equal(desktop, plugin);
});

test("类型化入口拿得到字段定义与规范化", async () => {
  const { profileApi } = await import("./profile.ts");
  assert.ok(profileApi.PROFILE_SCHEMA.some((group) => group.name === "基本信息"));
  assert.deepEqual(profileApi.normalizeProfile(null), { values: {}, family: [], custom: [] });
});
```

Run: `cd desktop && npm run test:ui`
Expected: FAIL（文件不存在）。

- [ ] **Step 2：复制与入口**

```bash
cp profile-fields.js desktop/src/resume/profile-fields.js
```

`desktop/src/resume/profile.ts`：

```ts
// 插件的 profile-fields.js 是 IIFE：没有 CommonJS 时把 API 挂到 globalThis.ResumeProProfile。
// 这里只做一次副作用导入，再给 TS 一个有类型的入口。
import "./profile-fields.js";

export interface ProfileFieldDef {
  id: string;
  key: string;
  label?: string;
  type?: "select" | "month" | "textarea";
  options?: string[];
  placeholder?: string;
  aliases?: string[];
}

export interface ProfileGroupDef {
  name: string;
  fields: ProfileFieldDef[];
}

export interface FamilyMember {
  relation: string;
  [field: string]: string;
}

export interface CustomField {
  key: string;
  value: string;
}

export interface Profile {
  values: Record<string, string>;
  family: FamilyMember[];
  custom: CustomField[];
}

interface ProfileApi {
  PROFILE_SCHEMA: ProfileGroupDef[];
  FAMILY_FIELDS: ProfileFieldDef[];
  FAMILY_RELATIONS: string[];
  FAMILY_GROUP: string;
  CUSTOM_GROUP: string;
  normalizeProfile(raw: unknown): Profile;
  emptyProfile(): Profile;
  countPendingFields(profile: Profile): number;
}

export const profileApi = (globalThis as unknown as { ResumeProProfile: ProfileApi }).ResumeProProfile;
```

若 `tsc` 报 `profile-fields.js` 无类型声明，新建 `desktop/src/resume/profile-fields.d.ts`，内容为 `export {};`。

- [ ] **Step 3：跑测试与类型检查**

Run: `cd desktop && npm run test:ui && npm run typecheck`
Expected: PASS。若 Node 的类型剥离无法 `import "./profile-fields.js"`（package 为 ESM，IIFE 顶层 `typeof module` 为 undefined，应能挂到 globalThis），在测试里改为先 `await import("./profile-fields.js")` 再导入 `profile.ts`，并记录原因。

- [ ] **Step 4：提交**

```bash
git add desktop/src/resume/profile-fields.js desktop/src/resume/profile.ts desktop/src/resume/profile-sync.test.ts
git commit -m "feat(desktop): 复用插件 profile-fields.js，测试锁死两份一致 (#130)"
```

如果加了 `profile-fields.d.ts`，一并 `git add`。

---

### Task 8：前端类型与文案

**Files:**
- Modify: `desktop/src/api.ts`
- Create: `desktop/src/resume/resume-text.ts`、`desktop/src/resume/resume-text.test.ts`

- [ ] **Step 1：写失败测试** `desktop/src/resume/resume-text.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportFileName, importMessage } from "./resume-text.ts";

test("新建与覆盖的导入提示和插件一致", () => {
  assert.deepEqual(importMessage(12, null), { tone: "ok", text: "简历模板导入成功，共 12 个字段。" });
  assert.deepEqual(importMessage(12, 10), { tone: "ok", text: "模板已覆盖，字段 10 → 12 个。" });
  const same = importMessage(12, 12);
  assert.equal(same.tone, "warn");
  assert.match(same.text, /仍是 12 个字段，数量没有变化/);
});

test("导出文件名去掉文件系统不收的字符", () => {
  assert.equal(exportFileName('a/b:c*?"<>|名'), "abc名.xlsx");
  assert.equal(exportFileName("  "), "简历模板.xlsx");
});
```

Run: `cd desktop && npm run test:ui`
Expected: FAIL。

- [ ] **Step 2：实现**

`desktop/src/resume/resume-text.ts`：

```ts
export interface Notice {
  tone: "ok" | "warn" | "error";
  text: string;
}

// 手改完 Excel 之后，用户一眼能核对的只有字段数，所以要说出来；数量没变多半是选错了文件。
export function importMessage(fieldCount: number, previous: number | null): Notice {
  if (previous === null) return { tone: "ok", text: `简历模板导入成功，共 ${fieldCount} 个字段。` };
  if (previous === fieldCount) {
    return {
      tone: "warn",
      text: `模板已覆盖，仍是 ${fieldCount} 个字段，数量没有变化。如果刚在 Excel 里加过内容，请确认选中的是改完并保存后的那份文件。`,
    };
  }
  return { tone: "ok", text: `模板已覆盖，字段 ${previous} → ${fieldCount} 个。` };
}

// 与 resume-sheet 的 export_file_name 同一口径：导入时模板名取自文件名，所以保留原名。
export function exportFileName(templateName: string): string {
  const safe = templateName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim();
  return `${safe || "简历模板"}.xlsx`;
}
```

`desktop/src/api.ts` 末尾加：

```ts
/** #130 简历模板：列表里的一行。 */
export interface TemplateSummary {
  id: string;
  name: string;
  fieldCount: number;
  updatedAt: string;
}

export interface ResumeOverview {
  templates: TemplateSummary[];
  activeTemplateId: string | null;
}

export interface TemplateGroupView {
  name: string;
  fields: Array<{ key: string; value: string }>;
}

export interface ResumeTemplateView {
  id: string;
  name: string;
  groups: TemplateGroupView[];
  updatedAt: string;
}

export interface ImportResultView {
  template: TemplateSummary;
  previousFieldCount: number | null;
}

export interface ProfileRecordView {
  profile: import("./resume/profile.ts").Profile;
  revision: number;
}
```

若 `verbatimModuleSyntax` 不接受 `import()` 类型写法，改为在文件顶部 `import type { Profile } from "./resume/profile.ts";`。

- [ ] **Step 3：跑测试**

Run: `cd desktop && npm run test:ui && npm run typecheck`
Expected: PASS。

- [ ] **Step 4：提交**

```bash
git add desktop/src/api.ts desktop/src/resume/resume-text.ts desktop/src/resume/resume-text.test.ts
git commit -m "feat(desktop): 简历视图类型与导入提示文案 (#130)"
```

---

### Task 9：模板列表组件

**Files:**
- Create: `desktop/src/resume/TemplateList.tsx`、`desktop/src/resume/TemplateList.test.tsx`

- [ ] **Step 1：写失败测试** `desktop/src/resume/TemplateList.test.tsx`

```tsx
import { expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Invoke, ResumeOverview } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { TemplateList } from "./TemplateList.tsx";
import type { FilePickers } from "./TemplateList.tsx";

const overview: ResumeOverview = {
  templates: [
    { id: "t2", name: "实习简历", fieldCount: 8, updatedAt: "2026-09-23T00:00:00Z" },
    { id: "t1", name: "校招简历", fieldCount: 12, updatedAt: "2026-09-22T00:00:00Z" },
  ],
  activeTemplateId: "t2",
};

function mount(handler: (command: string, args?: Record<string, unknown>) => unknown, pickers: FilePickers | null) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <TemplateList pickers={pickers} />
    </InvokeProvider>,
  );
  return calls;
}

const pickers = (open: string | null, save: string | null): FilePickers => ({
  open: async () => open,
  save: async () => save,
});

test("列出模板，标出当前模板和字段数", async () => {
  mount(() => overview, pickers(null, null));
  const current = await screen.findByRole("listitem", { name: /实习简历/ });
  expect(within(current).getByText("当前")).toBeTruthy();
  expect(within(current).getByText("8 个字段")).toBeTruthy();
});

test("没有模板时引导导入", async () => {
  mount(() => ({ templates: [], activeTemplateId: null }), pickers(null, null));
  expect(await screen.findByText(/还没有简历模板/)).toBeTruthy();
});

test("导入 Excel 用选中的文件新建模板，并说出字段数", async () => {
  const user = userEvent.setup();
  const calls = mount((command) => {
    if (command === "import_resume_template_cmd") {
      return { template: { id: "t3", name: "新", fieldCount: 5, updatedAt: "" }, previousFieldCount: null };
    }
    return overview;
  }, pickers("/tmp/新.xlsx", null));
  await user.click(await screen.findByRole("button", { name: "导入 Excel" }));
  await waitFor(() => expect(screen.getByText("简历模板导入成功，共 5 个字段。")).toBeTruthy());
  expect(calls.find((c) => c.command === "import_resume_template_cmd")?.args).toEqual({ path: "/tmp/新.xlsx", replaceId: null });
});

test("重新导入带上被覆盖的模板 id", async () => {
  const user = userEvent.setup();
  const calls = mount((command) => {
    if (command === "import_resume_template_cmd") {
      return { template: { id: "t1", name: "校招简历", fieldCount: 14, updatedAt: "" }, previousFieldCount: 12 };
    }
    return overview;
  }, pickers("/tmp/改.xlsx", null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "重新导入" }));
  await waitFor(() => expect(screen.getByText("模板已覆盖，字段 12 → 14 个。")).toBeTruthy());
  expect(calls.find((c) => c.command === "import_resume_template_cmd")?.args).toEqual({ path: "/tmp/改.xlsx", replaceId: "t1" });
});

test("导出用模板名作默认文件名，取消保存不调命令", async () => {
  const user = userEvent.setup();
  let suggested = "";
  const calls = mount(() => overview, {
    open: async () => null,
    save: async (name) => {
      suggested = name;
      return null;
    },
  });
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "导出 Excel" }));
  expect(suggested).toBe("校招简历.xlsx");
  expect(calls.some((c) => c.command === "export_resume_template_cmd")).toBe(false);
});

test("删除要先确认", async () => {
  const user = userEvent.setup();
  const calls = mount((command) =>
    command === "delete_resume_template_cmd" ? { templates: [overview.templates[0]], activeTemplateId: "t2" } : overview,
  pickers(null, null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "删除" }));
  expect(calls.some((c) => c.command === "delete_resume_template_cmd")).toBe(false);
  await user.click(within(row).getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(screen.queryByRole("listitem", { name: /校招简历/ })).toBeNull());
});

test("设为当前", async () => {
  const user = userEvent.setup();
  const calls = mount((command) =>
    command === "set_active_resume_template_cmd" ? { ...overview, activeTemplateId: "t1" } : overview,
  pickers(null, null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "设为当前" }));
  await waitFor(() => expect(within(row).getByText("当前")).toBeTruthy());
  expect(calls.find((c) => c.command === "set_active_resume_template_cmd")?.args).toEqual({ id: "t1" });
});

test("预览展开分组与字段", async () => {
  const user = userEvent.setup();
  mount((command) =>
    command === "get_resume_template_cmd"
      ? { id: "t1", name: "校招简历", updatedAt: "", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "张三" }] }] }
      : overview,
  pickers(null, null));
  const row = await screen.findByRole("listitem", { name: /校招简历/ });
  await user.click(within(row).getByRole("button", { name: "预览" }));
  expect(await within(row).findByText("张三")).toBeTruthy();
  expect(within(row).getByText("基本信息")).toBeTruthy();
});

test("命令报错时如实显示", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "import_resume_template_cmd") throw { code: "SHEET_INVALID", message: "第 3 行缺少「字段名」（第二列）。" };
    return overview;
  }, pickers("/tmp/a.xlsx", null));
  await user.click(await screen.findByRole("button", { name: "导入 Excel" }));
  expect(await screen.findByText(/第 3 行缺少「字段名」/)).toBeTruthy();
});
```

Run: `cd desktop && npm run test:react -- src/resume/TemplateList.test.tsx`
Expected: FAIL（组件不存在）。

- [ ] **Step 2：实现** `desktop/src/resume/TemplateList.tsx`

```tsx
import { useCallback, useEffect, useState } from "react";
import type { ImportResultView, ResumeOverview, ResumeTemplateView, TemplateSummary } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { exportFileName, importMessage } from "./resume-text.ts";
import type { Notice } from "./resume-text.ts";

/** 原生文件对话框。浏览器里直接打开 index.html 时为 null，界面如实说明。 */
export interface FilePickers {
  open(): Promise<string | null>;
  save(suggested: string): Promise<string | null>;
}

function describe(error: unknown): Notice {
  const err = error as { message?: string } | null;
  return { tone: "error", text: err?.message ?? "操作失败，请重试。" };
}

export function TemplateList({ pickers }: { pickers: FilePickers | null }) {
  const invoke = useInvoke();
  const [overview, setOverview] = useState<ResumeOverview | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!invoke) return;
    try {
      setOverview(await invoke<ResumeOverview>("resume_overview_cmd"));
    } catch (error) {
      setNotice(describe(error));
    }
  }, [invoke]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      setNotice(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const importFile = (replaceId: string | null) =>
    run(async () => {
      if (!invoke || !pickers) return;
      const path = await pickers.open();
      if (!path) return;
      const result = await invoke<ImportResultView>("import_resume_template_cmd", { path, replaceId });
      setNotice(importMessage(result.template.fieldCount, result.previousFieldCount));
      await reload();
    });

  const exportTemplate = (template: TemplateSummary) =>
    run(async () => {
      if (!invoke || !pickers) return;
      const path = await pickers.save(exportFileName(template.name));
      if (!path) return;
      await invoke("export_resume_template_cmd", { id: template.id, path });
      setNotice({ tone: "ok", text: `已导出 ${template.fieldCount} 个字段。` });
    });

  if (!invoke) return <p className="muted">没有连上桌面程序，模板要在桌面程序里管理。</p>;
  if (!overview) return <p className="muted">正在读取模板…</p>;

  return (
    <div className="stack">
      <div className="row">
        <button type="button" className="primary" disabled={busy || !pickers} onClick={() => void importFile(null)}>
          导入 Excel
        </button>
        {!pickers ? <span className="muted">请在桌面程序里导入。</span> : null}
      </div>
      <p className="muted">支持 .xlsx 和 UTF-8 编码的 .csv，三列：一级分类、字段名、值。</p>
      {notice ? <p className={`note ${notice.tone}`}>{notice.text}</p> : null}
      {overview.templates.length === 0 ? (
        <p className="muted">还没有简历模板。导入一份 Excel，或在插件旧版里导出后再导入。</p>
      ) : (
        <ul className="template-list">
          {overview.templates.map((template) => (
            <TemplateRow
              key={template.id}
              template={template}
              active={template.id === overview.activeTemplateId}
              busy={busy}
              canUseFiles={Boolean(pickers)}
              onActivate={() =>
                run(async () => {
                  setOverview(await invoke<ResumeOverview>("set_active_resume_template_cmd", { id: template.id }));
                  setNotice({ tone: "ok", text: "已切换当前模板。" });
                })
              }
              onReimport={() => void importFile(template.id)}
              onExport={() => void exportTemplate(template)}
              onRename={(name) =>
                run(async () => {
                  await invoke("rename_resume_template_cmd", { id: template.id, name });
                  setNotice({ tone: "ok", text: "已改名。" });
                  await reload();
                })
              }
              onDelete={() =>
                run(async () => {
                  setOverview(await invoke<ResumeOverview>("delete_resume_template_cmd", { id: template.id }));
                  setNotice({ tone: "ok", text: `已删除「${template.name}」。` });
                })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TemplateRow(props: {
  template: TemplateSummary;
  active: boolean;
  busy: boolean;
  canUseFiles: boolean;
  onActivate(): void;
  onReimport(): void;
  onExport(): void;
  onRename(name: string): void;
  onDelete(): void;
}) {
  const invoke = useInvoke();
  const { template } = props;
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(template.name);
  const [preview, setPreview] = useState<ResumeTemplateView | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const togglePreview = async () => {
    if (preview) {
      setPreview(null);
      return;
    }
    try {
      setPreview(await invoke!<ResumeTemplateView>("get_resume_template_cmd", { id: template.id }));
      setPreviewError(null);
    } catch (error) {
      setPreviewError(describe(error).text);
    }
  };

  return (
    <li aria-label={template.name} className={props.active ? "template-item active" : "template-item"}>
      <div className="row">
        <strong>{template.name}</strong>
        {props.active ? <span className="pill">当前</span> : null}
        <span className="muted">{template.fieldCount} 个字段</span>
      </div>
      <div className="row">
        {!props.active ? (
          <button type="button" disabled={props.busy} onClick={props.onActivate}>
            设为当前
          </button>
        ) : null}
        <button type="button" onClick={() => void togglePreview()}>
          {preview ? "收起" : "预览"}
        </button>
        <button type="button" disabled={props.busy || !props.canUseFiles} onClick={props.onReimport}>
          重新导入
        </button>
        <button type="button" disabled={props.busy || !props.canUseFiles} onClick={props.onExport}>
          导出 Excel
        </button>
        <button type="button" disabled={props.busy} onClick={() => setRenaming((v) => !v)}>
          重命名
        </button>
        {confirming ? (
          <>
            <button type="button" className="danger" disabled={props.busy} onClick={props.onDelete}>
              确认删除
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              取消
            </button>
          </>
        ) : (
          <button type="button" disabled={props.busy} onClick={() => setConfirming(true)}>
            删除
          </button>
        )}
      </div>
      {renaming ? (
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            props.onRename(draftName);
            setRenaming(false);
          }}
        >
          <label>
            新名称
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
          </label>
          <button type="submit">保存名称</button>
        </form>
      ) : null}
      {previewError ? <p className="note error">{previewError}</p> : null}
      {preview ? (
        <div className="template-preview">
          {preview.groups.map((group) => (
            <section key={group.name}>
              <h4>{group.name}</h4>
              <dl>
                {group.fields.map((field, index) => (
                  <div key={`${field.key}-${index}`} className="row">
                    <dt>{field.key}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      ) : null}
    </li>
  );
}
```

- [ ] **Step 3：跑测试**

Run: `cd desktop && npm run test:react -- src/resume/TemplateList.test.tsx && npm run typecheck`
Expected: PASS。

- [ ] **Step 4：提交**

```bash
git add desktop/src/resume/TemplateList.tsx desktop/src/resume/TemplateList.test.tsx
git commit -m "feat(desktop): 简历模板列表，导入导出、当前、改名、删除、预览 (#130)"
```

---

### Task 10：「我的信息」表单组件

**Files:**
- Create: `desktop/src/resume/ProfileForm.tsx`、`desktop/src/resume/ProfileForm.test.tsx`

- [ ] **Step 1：写失败测试** `desktop/src/resume/ProfileForm.test.tsx`

```tsx
import { expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Invoke, ProfileRecordView } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { ProfileForm } from "./ProfileForm.tsx";

const record: ProfileRecordView = {
  profile: {
    values: { name: "张三", gender: "男" },
    family: [{ relation: "父亲", name: "张大", birth: "", political: "", company: "", job: "", phone: "" }],
    custom: [{ key: "户籍派出所", value: "" }],
  },
  revision: 3,
};

function mount(handler: (command: string, args?: Record<string, unknown>) => unknown) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <ProfileForm />
    </InvokeProvider>,
  );
  return calls;
}

test("按字段定义画出表单并填好已有内容", async () => {
  mount(() => record);
  expect(await screen.findByLabelText("姓名")).toHaveProperty("value", "张三");
  expect(screen.getByLabelText("性别")).toHaveProperty("value", "男");
  expect(screen.getByLabelText("身高（厘米）")).toBeTruthy();
  expect(screen.getByText("基本信息")).toBeTruthy();
});

test("待补充的补充字段要标出来", async () => {
  mount(() => record);
  const row = await screen.findByRole("group", { name: /户籍派出所/ });
  expect(within(row).getByText("待补充")).toBeTruthy();
});

test("保存时带上读到的版本号和规范化后的档案", async () => {
  const user = userEvent.setup();
  const calls = mount((command, args) =>
    command === "save_profile_cmd" ? { profile: args?.profile, revision: 4 } : record,
  );
  const name = await screen.findByLabelText("姓名");
  await user.clear(name);
  await user.type(name, " 李四 ");
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  await waitFor(() => expect(screen.getByText("已保存。")).toBeTruthy());
  const saved = calls.find((c) => c.command === "save_profile_cmd")!.args!;
  expect(saved.revision).toBe(3);
  expect((saved.profile as { values: Record<string, string> }).values.name).toBe("李四");
});

test("版本冲突时提示刷新，不覆盖", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "save_profile_cmd") throw { code: "CONFLICT", message: "「我的信息」已在别处改过，请刷新后再保存。" };
    return record;
  });
  await screen.findByLabelText("姓名");
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  expect(await screen.findByText(/已在别处改过/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新读取" })).toBeTruthy();
});

test("可以加家庭成员和补充字段", async () => {
  const user = userEvent.setup();
  const calls = mount((command, args) =>
    command === "save_profile_cmd" ? { profile: args?.profile, revision: 4 } : record,
  );
  await screen.findByLabelText("姓名");
  await user.click(screen.getByRole("button", { name: "添加家庭成员" }));
  await user.click(screen.getByRole("button", { name: "添加补充字段" }));
  const keys = screen.getAllByLabelText("字段名");
  await user.type(keys[keys.length - 1], "紧急联系人邮箱");
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  await waitFor(() => expect(calls.some((c) => c.command === "save_profile_cmd")).toBe(true));
  const saved = calls.find((c) => c.command === "save_profile_cmd")!.args!.profile as { custom: Array<{ key: string }> };
  expect(saved.custom.map((c) => c.key)).toContain("紧急联系人邮箱");
});
```

Run: `cd desktop && npm run test:react -- src/resume/ProfileForm.test.tsx`
Expected: FAIL。

- [ ] **Step 2：实现** `desktop/src/resume/ProfileForm.tsx`

```tsx
import { useCallback, useEffect, useState } from "react";
import type { ProfileRecordView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { profileApi } from "./profile.ts";
import type { FamilyMember, Profile, ProfileFieldDef } from "./profile.ts";
import type { Notice } from "./resume-text.ts";

function emptyMember(): FamilyMember {
  const member: FamilyMember = { relation: profileApi.FAMILY_RELATIONS[0] };
  profileApi.FAMILY_FIELDS.forEach((field) => {
    member[field.id] = "";
  });
  return member;
}

function FieldInput({
  id,
  def,
  value,
  onChange,
  labelPrefix = "",
}: {
  id: string;
  def: ProfileFieldDef;
  value: string;
  onChange(value: string): void;
  /** 家庭成员的「姓名」「出生年月」和本人的同名，加前缀才能让读屏和测试分得清。 */
  labelPrefix?: string;
}) {
  const label = `${labelPrefix}${def.label ?? def.key}`;
  if (def.type === "select") {
    return (
      <label htmlFor={id}>
        {label}
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">未填</option>
          {(def.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (def.type === "textarea") {
    return (
      <label htmlFor={id}>
        {label}
        <textarea id={id} value={value} placeholder={def.placeholder} onChange={(event) => onChange(event.target.value)} />
      </label>
    );
  }
  return (
    <label htmlFor={id}>
      {label}
      <input
        id={id}
        type={def.type === "month" ? "month" : "text"}
        value={value}
        placeholder={def.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function ProfileForm() {
  const invoke = useInvoke();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!invoke) return;
    try {
      const record = await invoke<ProfileRecordView>("get_profile_cmd");
      setProfile(profileApi.normalizeProfile(record.profile));
      setRevision(record.revision);
      setConflict(false);
      setNotice(null);
    } catch (error) {
      setNotice({ tone: "error", text: (error as { message?: string })?.message ?? "读取失败。" });
    }
  }, [invoke]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!invoke) return <p className="muted">没有连上桌面程序，「我的信息」要在桌面程序里编辑。</p>;
  if (!profile) return notice ? <p className={`note ${notice.tone}`}>{notice.text}</p> : <p className="muted">正在读取…</p>;

  const setValue = (id: string, value: string) =>
    setProfile({ ...profile, values: { ...profile.values, [id]: value } });
  const setMember = (index: number, field: string, value: string) =>
    setProfile({ ...profile, family: profile.family.map((m, i) => (i === index ? { ...m, [field]: value } : m)) });
  const setCustom = (index: number, field: "key" | "value", value: string) =>
    setProfile({ ...profile, custom: profile.custom.map((c, i) => (i === index ? { ...c, [field]: value } : c)) });

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // 规范化用插件同一份规则：空值去掉、同名补充字段合并、全空的家庭成员丢掉。
      const normalized = profileApi.normalizeProfile(profile);
      const record = await invoke<ProfileRecordView>("save_profile_cmd", { profile: normalized, revision });
      setProfile(profileApi.normalizeProfile(record.profile));
      setRevision(record.revision);
      setNotice({ tone: "ok", text: "已保存。" });
    } catch (error) {
      const err = error as { code?: string; message?: string } | null;
      setConflict(err?.code === "CONFLICT");
      setNotice({ tone: "error", text: err?.message ?? "保存失败。" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {profileApi.PROFILE_SCHEMA.map((group) => (
        <fieldset key={group.name}>
          <legend>{group.name}</legend>
          {group.fields.map((def) => (
            <FieldInput
              key={def.id}
              id={`profile-${def.id}`}
              def={def}
              value={profile.values[def.id] ?? ""}
              onChange={(value) => setValue(def.id, value)}
            />
          ))}
        </fieldset>
      ))}

      <fieldset>
        <legend>{profileApi.FAMILY_GROUP}</legend>
        {profile.family.map((member, index) => (
          <div key={index} role="group" aria-label={`家庭成员 ${index + 1}`} className="row">
            <label htmlFor={`family-${index}-relation`}>
              成员 {index + 1} 关系
              <select
                id={`family-${index}-relation`}
                value={member.relation}
                onChange={(event) => setMember(index, "relation", event.target.value)}
              >
                {profileApi.FAMILY_RELATIONS.map((relation) => (
                  <option key={relation} value={relation}>
                    {relation}
                  </option>
                ))}
              </select>
            </label>
            {profileApi.FAMILY_FIELDS.map((def) => (
              <FieldInput
                key={def.id}
                id={`family-${index}-${def.id}`}
                def={def}
                labelPrefix={`成员 ${index + 1} `}
                value={member[def.id] ?? ""}
                onChange={(value) => setMember(index, def.id, value)}
              />
            ))}
            <button
              type="button"
              onClick={() => setProfile({ ...profile, family: profile.family.filter((_, i) => i !== index) })}
            >
              删除成员
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setProfile({ ...profile, family: [...profile.family, emptyMember()] })}>
          添加家庭成员
        </button>
      </fieldset>

      <fieldset>
        <legend>{profileApi.CUSTOM_GROUP}</legend>
        <p className="muted">从网页上「加到我的信息」的字段会出现在这里，补上内容后下次就能自动填。</p>
        {profile.custom.map((item, index) => (
          <div key={index} role="group" aria-label={item.key || `补充字段 ${index + 1}`} className="row">
            <label htmlFor={`custom-${index}-key`}>
              字段名
              <input id={`custom-${index}-key`} value={item.key} onChange={(event) => setCustom(index, "key", event.target.value)} />
            </label>
            <label htmlFor={`custom-${index}-value`}>
              内容
              <input id={`custom-${index}-value`} value={item.value} onChange={(event) => setCustom(index, "value", event.target.value)} />
            </label>
            {!item.value ? <span className="pill warn">待补充</span> : null}
            <button
              type="button"
              onClick={() => setProfile({ ...profile, custom: profile.custom.filter((_, i) => i !== index) })}
            >
              删除
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setProfile({ ...profile, custom: [...profile.custom, { key: "", value: "" }] })}>
          添加补充字段
        </button>
      </fieldset>

      {notice ? <p className={`note ${notice.tone}`}>{notice.text}</p> : null}
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          保存我的信息
        </button>
        {conflict ? (
          <button type="button" onClick={() => void load()}>
            重新读取
          </button>
        ) : null}
      </div>
    </form>
  );
}
```

注意：`normalizeProfile` 会丢掉 key 为空的补充字段——「添加补充字段」后没填字段名就保存，这一行会消失，这是插件同样的行为。

- [ ] **Step 3：跑测试**

Run: `cd desktop && npm run test:react -- src/resume/ProfileForm.test.tsx && npm run typecheck`
Expected: PASS。若 Vitest 环境下 `profile.ts` 的副作用导入没有挂上 `globalThis.ResumeProProfile`，在 `vitest.config.ts` 不改的前提下，把 `profile.ts` 改为 `import * as legacy from "./profile-fields.js"` 不可行（IIFE 无导出），应检查 Vite 是否把 `.js` 当 ESM 执行、`typeof module` 是否被注入；按实际情况修，并在提交说明里写清。

- [ ] **Step 4：提交**

```bash
git add desktop/src/resume/ProfileForm.tsx desktop/src/resume/ProfileForm.test.tsx
git commit -m "feat(desktop): 我的信息表单，版本冲突不覆盖 (#130)"
```

---

### Task 11：「简历」页挂到导航

**Files:**
- Create: `desktop/src/resume/ResumeView.tsx`、`desktop/src/resume/mount.tsx`
- Modify: `desktop/index.html`、`desktop/src/main.ts`、`desktop/src/styles.css`

- [ ] **Step 1：组合与挂载**

`desktop/src/resume/ResumeView.tsx`：

```tsx
import { ProfileForm } from "./ProfileForm.tsx";
import { TemplateList } from "./TemplateList.tsx";
import type { FilePickers } from "./TemplateList.tsx";

/**
 * 简历模板与「我的信息」都归桌面管（#130）。插件侧边栏填写时从这里读：
 * 模板优先，模板里没有的字段再用「我的信息」补。
 */
export function ResumeView({ pickers }: { pickers: FilePickers | null }) {
  return (
    <div className="stack">
      <header>
        <h2>简历</h2>
        <p className="muted">插件填写网页时用这里的「当前模板」和「我的信息」。模板里已有的字段优先，其余由「我的信息」补上。</p>
      </header>
      <section aria-labelledby="resume-templates-title" className="stack">
        <h3 id="resume-templates-title">简历模板</h3>
        <TemplateList pickers={pickers} />
      </section>
      <section aria-labelledby="resume-profile-title" className="stack">
        <h3 id="resume-profile-title">我的信息</h3>
        <p className="muted">网申表常问、简历里通常没有的内容。</p>
        <ProfileForm />
      </section>
    </div>
  );
}
```

`desktop/src/resume/mount.tsx`：

```tsx
import type { Invoke } from "../api.ts";
import { mountReact } from "../react/mount.tsx";
import { ResumeView } from "./ResumeView.tsx";
import type { FilePickers } from "./TemplateList.tsx";

/** 「简历」主视图。容器归 React 管，旧视图不往里写 innerHTML。 */
export function mountResume(container: Element, invoke: Invoke | null, pickers: FilePickers | null) {
  return mountReact(container, invoke, <ResumeView pickers={pickers} />);
}
```

- [ ] **Step 2：导航与视图**

`desktop/index.html`：导航里 `申请` 按钮之后加 `<button type="button" data-route="resume">简历</button>`；在 `<section id="view-inbox" ...>` 之前加：

```html
        <section id="view-resume" class="view hidden">
          <div id="resume-root"></div>
        </section>
```

`desktop/src/main.ts`：
1. 顶部 import 区加 `import { mountResume } from "./resume/mount.tsx";`
2. `views` 对象加 `resume: must("view-resume"),`
3. 在 `const dialog = window.__TAURI__?.dialog;`（约第 275 行）之后、使用前，加：

```ts
// 简历模板只收 .xlsx / .csv；导出默认用模板名。没有 Tauri 时为 null，界面会如实说明。
const resumePickers =
  dialog?.open && dialog?.save
    ? {
        open: async () => {
          const chosen = await dialog.open?.({
            multiple: false,
            filters: [{ name: "Excel / CSV", extensions: ["xlsx", "csv"] }],
          });
          return typeof chosen === "string" ? chosen : null;
        },
        save: async (suggested: string) =>
          (await dialog.save?.({ defaultPath: suggested, filters: [{ name: "Excel", extensions: ["xlsx"] }] })) ?? null,
      }
    : null;
mountResume(must("resume-root"), invoke ?? null, resumePickers);
```

写之前先看 `main.ts:275-310` 里 `dialog.open` / `dialog.save` 的类型声明（`desktop/src/tauri.d.ts`），参数类型不接受 `filters` / `multiple` 时在 `tauri.d.ts` 里补上可选字段。

`desktop/src/styles.css` 末尾加：

```css
.template-list { list-style: none; padding: 0; display: grid; gap: 12px; }
.template-item { border: 1px solid var(--border, #d0d7de); border-radius: 8px; padding: 12px; display: grid; gap: 8px; }
.template-item.active { border-color: var(--accent, #2563eb); }
.template-preview { display: grid; gap: 8px; max-height: 320px; overflow: auto; }
.template-preview dl { margin: 0; display: grid; gap: 4px; }
.template-preview dt { font-weight: 600; min-width: 8em; }
.template-preview dd { margin: 0; white-space: pre-wrap; }
.profile-form fieldset { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px 16px; }
.profile-form fieldset > legend, .profile-form fieldset > p, .profile-form fieldset > [role="group"] { grid-column: 1 / -1; }
```

先 `grep -n "^\s*--" desktop/src/styles.css | head` 看现有颜色变量名，把上面的 `var(--border…)`、`var(--accent…)` 换成已有变量。

- [ ] **Step 3：全量前端检查**

Run: `cd desktop && npm run typecheck && npm run test:ui && npm run test:react && npm run build`
Expected: 全部通过。

- [ ] **Step 4：实机走查**

Run: `cd desktop && npm run desktop:dev`
手动核对：导航出现「简历」；导入一份插件导出的 Excel → 列表出现、字段数正确、成为当前；重新导入改过的文件 → 提示「字段 A → B」；导出 → 用旧版插件导入该文件成功（兼容性回归）；改名撞名有提示；删除当前模板后当前改指向下一个；我的信息填写、加家庭成员、加补充字段、保存、关掉重开仍在；补充字段写「网银密码」保存被拒。

- [ ] **Step 5：提交**

```bash
git add desktop/index.html desktop/src/main.ts desktop/src/styles.css desktop/src/resume/ResumeView.tsx desktop/src/resume/mount.tsx desktop/src/tauri.d.ts
git commit -m "feat(desktop): 新增「简历」页 (#130)"
```

---

### Task 12：文档

**Files:**
- Modify: `docs/desktop-mvp/data-privacy.md`

- [ ] **Step 1：改 §1 Overview 第一段**

把「浏览器插件不是权威源：它持有可编辑的活模板和自己的 AI Key，并可在用户同意后向桌面投递岗位/填写事件。」改为：

「简历模板与「我的信息」自 v0.4.1 起也归桌面档案所有（#130）。浏览器插件不是权威源：它只在填写时向桌面读取这些数据，并可在用户同意后向桌面投递岗位/填写事件。」

- [ ] **Step 2：改 §4.2**

标题改为「### 4.2 活模板 vs 桌面快照」，前后两条改为：

```markdown
- 活模板：v0.4.1 起存于桌面档案（`resume_templates`，#130），用户可随时在桌面「重新导入 Excel」覆盖。插件不再保存副本，填写时经 Native Messaging 读取。
- 快照：填写归档确认时拷贝，之后 **immutable**。（后半句保持原文不变）
```

删除第三条「不得为了「方便同步」把活模板全量写入桌面…」。

- [ ] **Step 3：改 §6.1**

在「事件、待办、已提交消息回执…」之后加一条：

`- 简历模板与「我的信息」（随 DB，#130）。「我的信息」可能含身份证号、家庭成员等个人信息；密码、验证码类内容在保存时即被拒绝，不会进入档案与备份。`

- [ ] **Step 4：提交**

```bash
git add docs/desktop-mvp/data-privacy.md
git commit -m "docs(privacy): 简历模板与我的信息归桌面档案 (#130)"
```

---

### Task 13：收尾与开 PR

- [ ] **Step 1：全量验证**

Run: `cd desktop && npm test`，再在仓库根跑 `npm test`（插件测试不应受影响）。
Expected: 全部通过。任何失败先修再继续。

- [ ] **Step 2：推送并开 PR**（需负责人确认后执行）

```bash
git push -u origin feat/130-pr1-desktop-resume
gh pr create --base main --title "feat(desktop): 桌面接手简历模板与我的信息 (#130 PR 1)" --body-file <PR 描述>
```

PR 描述写：做了什么（对照本计划 Task 1–12）、与插件行为的有意差异（Excel 报错用真实行号、密码类内容不入档案、改名撞名直接报错不自动加序号）、实机走查结果（Task 11 Step 4 逐条）、是否顺带修了备份导出的保存对话框权限（Task 6 Step 2）。关联 `Refs #130`，不写 Closes。

---

## 自检

- 规格覆盖：拆分计划 PR 1 的四项——迁移 v4（Task 1）、CRUD/排序/当前模板（Task 2–3）、规范化用例移植（Task 2–3，对齐 `normalizeTemplate`、`resolveTemplateName`；档案规范化复用插件 JS，Task 7 锁死）、Excel 导入导出（Task 4–5）、简历页与我的信息表单（Task 9–11）、验收「导出的 Excel 能被旧插件导入」（Task 11 Step 4）。
- 与拆分计划的一处偏差：拆分计划写「`normalize_profile` 移植到 Rust」，本计划改为桌面前端直接复用插件 `profile-fields.js`（Task 7），Rust 只校验形状与大小。理由：同一份规则只维护一处，PR 3 的「加到我的信息」也由插件用同一份 JS 计算后带版本号写回，不需要 Rust 版本。PR 3 计划按此写。
