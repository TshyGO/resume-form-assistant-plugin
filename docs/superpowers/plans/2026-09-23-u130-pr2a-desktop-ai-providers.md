# #130 PR 2a：桌面多服务商 AI 配置 + 获取模型 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面 AI 设置从「一个地址 + 一把 Key」改为「服务商列表 + 当前使用」，每个服务商单独存 Key；设置页可从预设新建服务商、编辑、删除、切换当前、点「获取模型」从 `/models` 拉候选。收件箱「AI 整理」改用当前服务商。

**Architecture:** `ai-settings.json` 改存服务商列表（仍不含 Key），旧的单配置文件在读取时自动迁成一条 id 为 `default` 的服务商；凭据库账户改为 `ai-api-key:<providerId>`，旧账户 `ai-api-key` 的 Key 在首次读取时搬到 `ai-api-key:default`。编辑服务商时主机名变了就清空它的 Key，所以 Key 永远只发给它被填写时对应的主机。获取模型的 Rust 实现从 PR #146 的 `a09db3d` 移植，并补两处评审遗留。前端设置页拆成列表 + 编辑器两个组件。

**Tech Stack:** Rust（serde、reqwest、keyring、uuid、url、regex）、Tauri 2、React 19 + TypeScript、Vitest、`node --test`。

**上级计划：** [2026-09-23-u130-pr-breakdown.md](2026-09-23-u130-pr-breakdown.md)（PR 2，决策 6）· [#130](https://github.com/TshyGO/resume-form-assistant-plugin/issues/130) · [#143](https://github.com/TshyGO/resume-form-assistant-plugin/issues/143) · PR #146（本 PR 合入后关闭）

**基线：** `bb68cbb`（main，含 PR 1 #155）。**分支：** `feat/130-pr2a-desktop-ai-providers`（从 `origin/main` 新建）。

**PR 2b（简历解析）** 另见 [2026-09-23-u130-pr2b-desktop-resume-parse.md](2026-09-23-u130-pr2b-desktop-resume-parse.md)，依赖本 PR。

---

## 负责人已定（不要改）

- 只支持 OpenAI 兼容的 **Chat Completions**。不做 Responses / Anthropic 协议。
- 多服务商只在桌面做；插件不做配置界面（插件 AI 配置在 PR 5 删除）。
- 不做失败后自动换服务商（会把内容发给用户没选的服务商，且重复计费）。
- 不按任务分别指定服务商。

## 已核实的事实（基线 bb68cbb）

- `desktop/src-tauri/src/ai_settings.rs`：`AiSettings { api_url, model }`（camelCase 存进 `<data_root>/ai-settings.json`）；`load` 读不动就回默认值（OpenAI + `gpt-4o-mini`）；`save` 先写 `.json.tmp` 再改名；`credential_in_url` 拦地址里的凭据；`normalize_api_url(typed, fallback)` 补 `/chat/completions`；私有 `is_version_segment`；`host_of` 取主机名（小写、去 userinfo）。
- `desktop/src-tauri/src/ai_credentials.rs`：`SERVICE = "com.resumepro.desktop"`、`ACCOUNT = "ai-api-key"`；trait `CredentialStore { set_key(key), get_key(), clear_key(), has_key() }`；实现 `KeyringStore`、`MemoryStore`（测试用）、`UnavailableStore`。
- `desktop/src-tauri/src/lib.rs`：`AppState.credentials: Box<dyn CredentialStore>`（第 63 行，生产用 `KeyringStore`，第 1487 行）；`AiSettingsView`（第 76 行）与 `ai_settings_view`；命令 `get_ai_settings_cmd`、`save_ai_settings_cmd`、`set_ai_key_cmd`、`clear_ai_key_cmd`、`preview_analysis_cmd`、`analyze_evidence_cmd`（约 945–1060 行）；`checked_url`、`credential_error`、`ai_data_root` 辅助函数。
- 用到这些命令的前端只有 `desktop/src/api.ts`（`AiSettingsView`）、`desktop/src/ai/ai-settings.ts`（+ `.test.ts`）、`desktop/src/ai/AiSettings.tsx`（+ `.test.tsx`）。
- PR #146 分支 `origin/feat/143-desktop-fetch-models` 的提交 `a09db3d` 是「只改桌面」的获取模型最终版：`desktop/src-tauri/src/ai_models.rs`（新文件，含 `resolve_endpoints`、`parse_model_list`、`filter_chat_models`、`fetch_model_list_with_timeout` 及大量测试，其中有一条测试直接读仓库根 `ai-models.js` 比对过滤词）、`ai_settings.rs` 里把 `is_version_segment` 改成 `pub(crate)` 并收紧为 `/^v\d+[a-z0-9]*$/i` 口径、`ai-settings.ts` 里的 `describeModelsResult` / `matchModels`、`api.ts` 的 `ModelListView`。**不要移植** `a09db3d` 之后的提交（`e7b06b3`、`38d7e84`、`ad8a82a` 是已否决的协议统一）。
- 评审遗留两点，本 PR 必须做到：① 非 2xx 只按状态码分类，**不读、不回显服务商错误正文**（正文可能带完整地址或 Key）；② 未保存的新地址不能使用已存的 Key。
- `data-privacy.md` §8 表格「桌面通知整理（D11）」一列与 §6.3.1「`ai-settings.json` 不进备份」需同步。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `desktop/src-tauri/src/ai_settings.rs`（改） | 服务商列表的读写、旧文件迁移、地址规范化 |
| `desktop/src-tauri/src/ai_credentials.rs`（改） | 按服务商存取 Key、旧 Key 迁移 |
| `desktop/src-tauri/src/ai_models.rs`（新，移植） | `/models` 拉取与过滤 |
| `desktop/src-tauri/src/ai_provider_commands.rs`（新） | 设置页命令的业务逻辑（可单测，不依赖 Tauri State） |
| `desktop/src-tauri/src/lib.rs`（改） | 命令注册、`AppState` 接线、分析命令改用当前服务商 |
| `desktop/src/api.ts`（改） | 视图类型 |
| `desktop/src/ai/ai-settings.ts`（改）+ `.test.ts` | 文案、预设、模型候选排序 |
| `desktop/src/ai/ProviderEditor.tsx`（新）+ `.test.tsx` | 单个服务商的编辑表单（含获取模型、Key） |
| `desktop/src/ai/AiSettings.tsx`（改写）+ `.test.tsx` | 服务商列表、当前使用、新建、删除 |
| `docs/desktop-mvp/data-privacy.md`（改） | §8、§6.3.1 |

---

### Task 1：服务商列表的存储与旧文件迁移

**Files:**
- Modify: `desktop/src-tauri/src/ai_settings.rs`

- [ ] **Step 1：写失败测试**（追加到 `ai_settings.rs` 的 `mod tests`）

```rust
    fn input(id: Option<&str>, name: &str, url: &str, model: &str) -> ProviderInput {
        ProviderInput { id: id.map(str::to_string), name: name.into(), api_url: url.into(), model: model.into() }
    }

    #[test]
    fn no_file_means_no_providers() {
        let dir = tempfile::tempdir().unwrap();
        let settings = load(dir.path());
        assert!(settings.providers.is_empty());
        assert_eq!(settings.active_provider_id, None);
        assert!(active(&settings).is_none());
    }

    #[test]
    fn a_legacy_single_config_becomes_the_default_provider() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            path_for(dir.path()),
            r#"{"apiUrl":"https://api.deepseek.com/v1/chat/completions","model":"deepseek-chat"}"#,
        )
        .unwrap();
        let settings = load(dir.path());
        assert_eq!(settings.providers.len(), 1);
        let p = &settings.providers[0];
        assert_eq!((p.id.as_str(), p.name.as_str()), (LEGACY_PROVIDER_ID, "默认"));
        assert_eq!(p.api_url, "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(p.model, "deepseek-chat");
        assert_eq!(settings.active_provider_id.as_deref(), Some(LEGACY_PROVIDER_ID));
    }

    #[test]
    fn a_broken_file_reads_as_empty_not_as_an_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path_for(dir.path()), "{not json").unwrap();
        assert!(load(dir.path()).providers.is_empty());
    }

    #[test]
    fn saving_a_new_provider_normalizes_the_url_and_makes_the_first_one_current() {
        let dir = tempfile::tempdir().unwrap();
        let out = save_provider(dir.path(), input(None, " DeepSeek ", "https://api.deepseek.com", " deepseek-chat ")).unwrap();
        let p = out.settings.providers.iter().find(|p| p.id == out.provider_id).unwrap();
        assert_eq!(p.name, "DeepSeek");
        assert_eq!(p.api_url, "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(p.model, "deepseek-chat");
        assert!(!out.host_changed);
        assert_eq!(out.settings.active_provider_id.as_deref(), Some(out.provider_id.as_str()));
        let second = save_provider(dir.path(), input(None, "通义", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus")).unwrap();
        assert_eq!(second.settings.active_provider_id.as_deref(), Some(out.provider_id.as_str()));
        assert_eq!(load(dir.path()), second.settings);
    }

    #[test]
    fn editing_reports_when_the_host_changed() {
        let dir = tempfile::tempdir().unwrap();
        let a = save_provider(dir.path(), input(None, "A", "https://api.deepseek.com", "m")).unwrap();
        let same = save_provider(dir.path(), input(Some(&a.provider_id), "A", "https://API.deepseek.com/v1", "m2")).unwrap();
        assert!(!same.host_changed);
        let moved = save_provider(dir.path(), input(Some(&a.provider_id), "A", "https://api.moonshot.cn/v1", "m2")).unwrap();
        assert!(moved.host_changed);
    }

    #[test]
    fn invalid_input_is_refused_with_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        let cases = [
            (input(None, "", "https://a.example/v1", "m"), "名称"),
            (input(None, &"名".repeat(MAX_PROVIDER_NAME_CHARS + 1), "https://a.example/v1", "m"), "名称"),
            (input(None, "A", "  ", "m"), "接口地址"),
            (input(None, "A", "https://a.example/v1", " "), "模型"),
            (input(None, "A", "https://u:p@a.example/v1", "m"), "用户名或密码"),
            (input(Some("missing"), "A", "https://a.example/v1", "m"), "不在了"),
        ];
        for (bad, needle) in cases {
            let err = save_provider(dir.path(), bad).unwrap_err();
            assert!(err.contains(needle), "{err}");
        }
    }

    #[test]
    fn at_most_twenty_providers() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..MAX_PROVIDERS {
            save_provider(dir.path(), input(None, &format!("P{i}"), "https://a.example/v1", "m")).unwrap();
        }
        let err = save_provider(dir.path(), input(None, "one more", "https://a.example/v1", "m")).unwrap_err();
        assert!(err.contains("最多"), "{err}");
    }

    #[test]
    fn deleting_the_current_provider_falls_back_to_the_first_remaining() {
        let dir = tempfile::tempdir().unwrap();
        let a = save_provider(dir.path(), input(None, "A", "https://a.example/v1", "m")).unwrap().provider_id;
        let b = save_provider(dir.path(), input(None, "B", "https://b.example/v1", "m")).unwrap().provider_id;
        set_active(dir.path(), &b).unwrap();
        let after = delete_provider(dir.path(), &b).unwrap();
        assert_eq!(after.active_provider_id.as_deref(), Some(a.as_str()));
        let empty = delete_provider(dir.path(), &a).unwrap();
        assert_eq!(empty.active_provider_id, None);
        assert!(delete_provider(dir.path(), &a).unwrap_err().contains("不在了"));
        assert!(set_active(dir.path(), "nope").unwrap_err().contains("不在了"));
    }
```

- [ ] **Step 2：确认失败**

Run: `cd desktop && cargo test --manifest-path src-tauri/Cargo.toml --locked --lib ai_settings`
Expected: 编译失败（`ProviderInput`、`save_provider` 等未定义）。

- [ ] **Step 3：实现**

用下面的结构替换 `ai_settings.rs` 顶部的 `AiSettings`、`Default`、`load`、`save`（保留 `credential_in_url`、`normalize_api_url`、`is_version_segment`、`host_of` 及其测试）。文件头注释改为说明「服务商列表，Key 按服务商另存凭据库」。

```rust
pub const DEFAULT_API_URL: &str = "https://api.openai.com/v1/chat/completions";
const FILE_NAME: &str = "ai-settings.json";
/// 从旧的单配置文件迁移来的那一条服务商的 id。旧 Key 也搬到这个 id 名下（见 `ai_credentials`）。
pub const LEGACY_PROVIDER_ID: &str = "default";
pub const MAX_PROVIDERS: usize = 20;
pub const MAX_PROVIDER_NAME_CHARS: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProvider {
    pub id: String,
    pub name: String,
    pub api_url: String,
    pub model: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub providers: Vec<AiProvider>,
    pub active_provider_id: Option<String>,
}

/// v0.4.0 及以前的文件形状：一个地址、一个模型。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySettings {
    api_url: String,
    model: String,
}

pub struct ProviderInput {
    /// `None` 表示新建。
    pub id: Option<String>,
    pub name: String,
    pub api_url: String,
    pub model: String,
}

pub struct SaveOutcome {
    pub settings: AiSettings,
    pub provider_id: String,
    /// 编辑已有服务商时主机名变了。调用方据此清掉它的 Key：Key 只发给填写它时对应的主机。
    pub host_changed: bool,
}

pub fn path_for(data_root: &Path) -> PathBuf {
    data_root.join(FILE_NAME)
}

/// 读设置。文件不在或坏了就当没有配置——这里没有不可再生的数据。
/// 旧的单配置文件读成一条 id 为 `default` 的服务商，下次保存时按新形状写回。
pub fn load(data_root: &Path) -> AiSettings {
    let Ok(text) = fs::read_to_string(path_for(data_root)) else {
        return AiSettings::default();
    };
    if let Ok(mut settings) = serde_json::from_str::<AiSettings>(&text) {
        let known = |id: &String| settings.providers.iter().any(|p| &p.id == id);
        if !settings.active_provider_id.as_ref().is_some_and(known) {
            settings.active_provider_id = settings.providers.first().map(|p| p.id.clone());
        }
        return settings;
    }
    match serde_json::from_str::<LegacySettings>(&text) {
        Ok(legacy) => {
            let api_url = if legacy.api_url.trim().is_empty() { DEFAULT_API_URL.to_string() } else { legacy.api_url };
            AiSettings {
                providers: vec![AiProvider {
                    id: LEGACY_PROVIDER_ID.into(),
                    name: "默认".into(),
                    api_url,
                    model: legacy.model.trim().to_string(),
                }],
                active_provider_id: Some(LEGACY_PROVIDER_ID.into()),
            }
        }
        Err(_) => AiSettings::default(),
    }
}

pub fn active(settings: &AiSettings) -> Option<&AiProvider> {
    let id = settings.active_provider_id.as_deref()?;
    settings.providers.iter().find(|p| p.id == id)
}

const GONE: &str = "这个服务商已经不在了，刷新一下。";

fn write(data_root: &Path, settings: &AiSettings) -> Result<(), String> {
    let target = path_for(data_root);
    let tmp = target.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| format!("写 {} 失败：{e}", tmp.display()))?;
    fs::rename(&tmp, &target).map_err(|e| format!("保存 {} 失败：{e}", target.display()))
}

pub fn save_provider(data_root: &Path, input: ProviderInput) -> Result<SaveOutcome, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() || name.chars().count() > MAX_PROVIDER_NAME_CHARS {
        return Err(format!("名称不能为空，最多 {MAX_PROVIDER_NAME_CHARS} 个字。"));
    }
    if input.api_url.trim().is_empty() {
        return Err("接口地址不能为空。".into());
    }
    if let Some(problem) = credential_in_url(&input.api_url) {
        return Err(problem);
    }
    let model = input.model.trim().to_string();
    if model.is_empty() {
        return Err("模型名称不能为空，可以点「获取模型」挑一个。".into());
    }
    let mut settings = load(data_root);
    let (provider_id, host_changed) = match input.id {
        Some(id) => {
            let existing = settings.providers.iter_mut().find(|p| p.id == id).ok_or_else(|| GONE.to_string())?;
            let api_url = normalize_api_url(&input.api_url, &existing.api_url);
            let host_changed = host_of(&api_url) != host_of(&existing.api_url);
            *existing = AiProvider { id: id.clone(), name, api_url, model };
            (id, host_changed)
        }
        None => {
            if settings.providers.len() >= MAX_PROVIDERS {
                return Err(format!("服务商最多 {MAX_PROVIDERS} 个，先删掉用不上的。"));
            }
            let id = uuid::Uuid::new_v4().to_string();
            let api_url = normalize_api_url(&input.api_url, DEFAULT_API_URL);
            settings.providers.push(AiProvider { id: id.clone(), name, api_url, model });
            if active(&settings).is_none() {
                settings.active_provider_id = Some(id.clone());
            }
            (id, false)
        }
    };
    write(data_root, &settings)?;
    Ok(SaveOutcome { settings, provider_id, host_changed })
}

pub fn delete_provider(data_root: &Path, id: &str) -> Result<AiSettings, String> {
    let mut settings = load(data_root);
    let before = settings.providers.len();
    settings.providers.retain(|p| p.id != id);
    if settings.providers.len() == before {
        return Err(GONE.into());
    }
    if settings.active_provider_id.as_deref() == Some(id) {
        settings.active_provider_id = settings.providers.first().map(|p| p.id.clone());
    }
    write(data_root, &settings)?;
    Ok(settings)
}

pub fn set_active(data_root: &Path, id: &str) -> Result<AiSettings, String> {
    let mut settings = load(data_root);
    if !settings.providers.iter().any(|p| p.id == id) {
        return Err(GONE.into());
    }
    settings.active_provider_id = Some(id.to_string());
    write(data_root, &settings)?;
    Ok(settings)
}
```

同时按 `a09db3d` 收紧版本段判断：`git show a09db3d:desktop/src-tauri/src/ai_settings.rs` 里的 `is_version_segment` 与其测试（`v1-beta` 不再算版本段）原样替换进来，并改成 `pub(crate)`（Task 3 的 `ai_models.rs` 要用）。

删除旧的 `DEFAULT_MODEL`、`save`、旧 `AiSettings` 相关测试（`an_empty_address_keeps_whatever_was_there_before` 若只测旧 `save` 行为则删；只测 `normalize_api_url` 的保留）。`uuid` 已是 `src-tauri` 的依赖。

- [ ] **Step 4：跑测试**

Run: `cd desktop && cargo test --manifest-path src-tauri/Cargo.toml --locked --lib ai_settings`
Expected: PASS。`lib.rs` 此时会因为旧 `ai_settings::save` / `settings.api_url` 编译失败，而每个任务结束时整个 crate 都必须能编译、测试全绿。所以本步把 `lib.rs` 里用到旧 API 的地方临时改成「取当前服务商」的最小形式（Task 5 会整体重写）：`ai_settings_view` 里用 `ai_settings::active(&settings)`，没有就用空字符串；`save_ai_settings_cmd` 改为调用 `save_provider` 保存/更新当前服务商（`id` 为当前 id，`name` 用「默认」）；`preview_analysis_cmd` / `analyze_evidence_cmd` 里 `settings.api_url` / `settings.model` 改为从 `active(&settings)` 取，没有当前服务商时返回 `CommandError { code: "AI_NOT_CONFIGURED", message: "还没有配置 AI 服务商，先去设置页添加一个。" }`。然后跑 `cargo test --manifest-path src-tauri/Cargo.toml --locked --bins --lib`，全绿。

- [ ] **Step 5：提交**

```bash
git add desktop/src-tauri/src/ai_settings.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): AI 设置改为服务商列表，旧配置自动迁移 (#130)"
```

---

### Task 2：Key 按服务商存取，旧 Key 迁移

**Files:**
- Modify: `desktop/src-tauri/src/ai_credentials.rs`

- [ ] **Step 1：写失败测试**（替换该文件 `mod tests` 里的旧用例）

```rust
    #[test]
    fn keys_are_kept_per_provider() {
        let store = MemoryStore::default();
        store.set_key("a", " sk-a ").unwrap();
        store.set_key("b", "sk-b").unwrap();
        assert_eq!(store.get_key("a").unwrap().as_deref(), Some("sk-a"));
        assert_eq!(store.get_key("b").unwrap().as_deref(), Some("sk-b"));
        store.clear_key("a").unwrap();
        assert_eq!(store.get_key("a").unwrap(), None);
        assert!(store.has_key("b"));
        assert_eq!(store.set_key("a", "  ").unwrap_err(), CredentialError::Empty);
        store.clear_key("never-set").unwrap();
    }

    #[test]
    fn the_legacy_key_moves_to_the_default_provider_once() {
        let store = MemoryStore::with_legacy("sk-old");
        assert!(migrate_legacy_key(&store, "default").unwrap());
        assert_eq!(store.get_key("default").unwrap().as_deref(), Some("sk-old"));
        assert_eq!(store.get_legacy_key().unwrap(), None);
        assert!(!migrate_legacy_key(&store, "default").unwrap());
    }

    #[test]
    fn an_existing_provider_key_is_not_overwritten_by_the_legacy_one() {
        let store = MemoryStore::with_legacy("sk-old");
        store.set_key("default", "sk-new").unwrap();
        assert!(!migrate_legacy_key(&store, "default").unwrap());
        assert_eq!(store.get_key("default").unwrap().as_deref(), Some("sk-new"));
        assert_eq!(store.get_legacy_key().unwrap(), None, "旧账户清掉，不留第二份");
    }

    #[test]
    fn an_unavailable_store_says_so_everywhere() {
        let store = UnavailableStore("locked".into());
        assert!(store.get_key("a").is_err());
        assert!(migrate_legacy_key(&store, "default").is_err());
    }

    #[test]
    fn accounts_are_namespaced() {
        assert_eq!(account_for("abc"), "ai-api-key:abc");
    }
```

- [ ] **Step 2：确认失败**

Run: `cd desktop && cargo test --manifest-path src-tauri/Cargo.toml --locked --lib ai_credentials`
Expected: 编译失败。

- [ ] **Step 3：实现**

```rust
pub const SERVICE: &str = "com.resumepro.desktop";
/// v0.4.0 及以前唯一的那条 Key。只在迁移时读一次，读完搬走并删除。
pub const LEGACY_ACCOUNT: &str = "ai-api-key";

pub fn account_for(provider_id: &str) -> String {
    format!("{LEGACY_ACCOUNT}:{provider_id}")
}

pub trait CredentialStore: Send + Sync {
    fn set_key(&self, provider_id: &str, key: &str) -> Result<(), CredentialError>;
    /// 只有发请求时才调。**不要**做成命令暴露给界面。
    fn get_key(&self, provider_id: &str) -> Result<Option<String>, CredentialError>;
    fn clear_key(&self, provider_id: &str) -> Result<(), CredentialError>;
    fn get_legacy_key(&self) -> Result<Option<String>, CredentialError>;
    fn clear_legacy_key(&self) -> Result<(), CredentialError>;

    fn has_key(&self, provider_id: &str) -> bool {
        matches!(self.get_key(provider_id), Ok(Some(_)))
    }
}

/// 把旧账户的 Key 搬到 `to_provider` 名下。先写新、再删旧：写新失败时旧 Key 还在。
/// 新账户已有 Key 时不覆盖，只删旧的。返回是否真的搬了。
pub fn migrate_legacy_key(store: &dyn CredentialStore, to_provider: &str) -> Result<bool, CredentialError> {
    let Some(legacy) = store.get_legacy_key()? else {
        return Ok(false);
    };
    let moved = if store.get_key(to_provider)?.is_none() {
        store.set_key(to_provider, &legacy)?;
        true
    } else {
        false
    };
    store.clear_legacy_key()?;
    Ok(moved)
}
```

`KeyringStore`：`entry(account: &str)` 用 `keyring::Entry::new(SERVICE, account)`；`set_key/get_key/clear_key` 用 `account_for(provider_id)`，`get_legacy_key/clear_legacy_key` 用 `LEGACY_ACCOUNT`，其余逻辑（trim、空 Key 报 `Empty`、`NoEntry` 当作没有）不变。

`MemoryStore`：改为 `keys: Mutex<HashMap<String, String>>`（键是账户名），加 `pub fn with_legacy(key: &str) -> Self`（测试用，写入 `LEGACY_ACCOUNT`）。`UnavailableStore`：五个方法都返回 `Unavailable`。

`lib.rs` 里所有 `state.credentials.*` 调用临时补上服务商 id（当前服务商的 id；没有时按「未配置」处理），保证编译通过；Task 5 会整体整理。

- [ ] **Step 4：跑测试**

Run: `cd desktop && cargo test --manifest-path src-tauri/Cargo.toml --locked --bins --lib`
Expected: 全绿。

- [ ] **Step 5：提交**

```bash
git add desktop/src-tauri/src/ai_credentials.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): Key 按服务商分别存进凭据库，旧 Key 自动迁移 (#130)"
```

---

### Task 3：移植获取模型（#146 桌面部分）并补评审遗留

**Files:**
- Create: `desktop/src-tauri/src/ai_models.rs`
- Modify: `desktop/src-tauri/src/lib.rs`（`mod ai_models;`）

- [ ] **Step 1：取出原实现**

```bash
git fetch origin feat/143-desktop-fetch-models
git show a09db3d:desktop/src-tauri/src/ai_models.rs > desktop/src-tauri/src/ai_models.rs
```

在 `lib.rs` 模块列表加 `mod ai_models;`。跑 `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib ai_models`，确认原有测试在当前基线上全绿（若因 `is_version_segment` 未公开而编译失败，说明 Task 1 那一步漏了）。

- [ ] **Step 2：写失败测试——报错不回显服务商正文**

在 `ai_models.rs` 的 `fetch_statuses_map_to_the_documented_failures` 里，把 401 用例的响应体改成 `r#"{"error":{"message":"bad key https://relay.example?api_key=sk-secret"}}"#`，把原来的 `assert!(err.message.contains("bad key"))` 改成：

```rust
        assert!(!err.message.contains("sk-secret"), "{}", err.message);
        assert!(!err.message.contains("bad key"), "{}", err.message);
```

并在同一测试末尾追加一个 500 用例：

```rust
        let (server_url, server) =
            serve_once(500, r#"{"error":{"message":"upstream https://relay.example?key=sk-secret"}}"#);
        let err = fetch_model_list_with_timeout(&server_url, "sk-test", "relay.example", Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_HTTP_500");
        assert!(!err.message.contains("sk-secret"), "{}", err.message);
        server.join().unwrap();
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib ai_models`
Expected: FAIL（当前会把 `bad key` 拼进提示）。

- [ ] **Step 3：实现**

删掉 `provider_detail` 与 `read_optional_summary` 两个函数，把 `fetch_model_list_with_timeout` 里非 2xx 的分支改为「只看状态码」：

```rust
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        // 只按状态码分类，不读也不回显服务商正文：错误文本可能包含完整地址或 Key。
        eprintln!("ai-models: {host} · HTTP {status} · {} ms", started.elapsed().as_millis());
        if status == 401 || status == 403 {
            return Err(CommandError {
                code: "AI_MODELS_AUTH".into(),
                message: format!("{host} 拒绝了这个 Key（HTTP {status}）：请检查密钥是否正确、是否有效。"),
            });
        }
        if status == 404 || status == 405 {
            return Err(CommandError {
                code: "AI_MODELS_NOT_FOUND".into(),
                message: format!(
                    "{host} 没有返回模型列表（HTTP {status}）。可能是地址不对（常见：漏了 /v1），也可能是服务商不提供模型列表——可直接手填模型名称。"
                ),
            });
        }
        return Err(CommandError {
            code: format!("AI_MODELS_HTTP_{status}"),
            message: format!("从 {host} 获取模型失败（HTTP {status}）。"),
        });
    }
```

并删掉 2xx 路径里 `let detail = provider_detail(...)` 及其后仅用于非 2xx 的分支。检查 `error_statuses_win_over_body_problems` 等测试仍成立（状态码优先本来就是它们要的）。

在文件头注释里补一句：「过滤词锁死测试读的是插件 `ai-models.js`；PR 5 删除该文件时，把这条测试一并删掉，桌面成为唯一实现。」

- [ ] **Step 4：跑测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --locked --bins --lib`
Expected: 全绿（`ai_models` 里暂未被命令使用的函数可能有 dead_code 警告，Task 5 接上后消失）。

- [ ] **Step 5：提交**

```bash
git add desktop/src-tauri/src/ai_models.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): 移植获取模型（#146 桌面部分），报错不回显服务商正文 (#130)"
```

---

### Task 4：设置页命令的业务逻辑

**Files:**
- Create: `desktop/src-tauri/src/ai_provider_commands.rs`

把命令逻辑写成接收 `data_root: &Path` 与 `&dyn CredentialStore` 的普通函数，Tauri 命令只做薄包装，这样能在单测里用 `MemoryStore` 覆盖。

- [ ] **Step 1：写失败测试**（文件末尾 `#[cfg(test)] mod tests`）

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_credentials::MemoryStore;

    fn args(id: Option<&str>, url: &str) -> ProviderArgs {
        ProviderArgs { id: id.map(str::to_string), name: "P".into(), api_url: url.into(), model: "m".into() }
    }

    #[test]
    fn the_view_never_carries_a_key_and_says_which_providers_have_one() {
        let dir = tempfile::tempdir().unwrap();
        let creds = MemoryStore::default();
        let saved = save_provider(dir.path(), &creds, args(None, "https://a.example/v1"), Some("sk-a".into())).unwrap();
        let view = settings_view(dir.path(), &creds);
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("sk-a"));
        assert!(view.providers[0].key_configured);
        assert_eq!(view.providers[0].host, "a.example");
        assert_eq!(view.active_provider_id.as_deref(), Some(saved.provider_id.as_str()));
    }

    #[test]
    fn moving_a_provider_to_another_host_drops_its_key() {
        let dir = tempfile::tempdir().unwrap();
        let creds = MemoryStore::default();
        let id = save_provider(dir.path(), &creds, args(None, "https://a.example/v1"), Some("sk-a".into())).unwrap().provider_id;
        let same = save_provider(dir.path(), &creds, args(Some(&id), "https://a.example/v2"), None).unwrap();
        assert!(!same.key_cleared);
        assert!(creds.has_key(&id));
        let moved = save_provider(dir.path(), &creds, args(Some(&id), "https://b.example/v1"), None).unwrap();
        assert!(moved.key_cleared);
        assert!(!creds.has_key(&id));
        let retyped = save_provider(dir.path(), &creds, args(Some(&id), "https://c.example/v1"), Some("sk-c".into())).unwrap();
        assert!(!retyped.key_cleared, "同时填了新 Key，就不算被清掉");
        assert_eq!(creds.get_key(&id).unwrap().as_deref(), Some("sk-c"));
    }

    #[test]
    fn deleting_a_provider_deletes_its_key() {
        let dir = tempfile::tempdir().unwrap();
        let creds = MemoryStore::default();
        let id = save_provider(dir.path(), &creds, args(None, "https://a.example/v1"), Some("sk-a".into())).unwrap().provider_id;
        delete_provider(dir.path(), &creds, &id).unwrap();
        assert!(!creds.has_key(&id));
    }

    #[test]
    fn the_legacy_setup_keeps_working_after_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            crate::ai_settings::path_for(dir.path()),
            r#"{"apiUrl":"https://api.deepseek.com/v1/chat/completions","model":"deepseek-chat"}"#,
        )
        .unwrap();
        let creds = MemoryStore::with_legacy("sk-old");
        let (provider, key) = active_with_key(dir.path(), &creds).unwrap();
        assert_eq!(provider.id, crate::ai_settings::LEGACY_PROVIDER_ID);
        assert_eq!(key, "sk-old");
    }

    #[test]
    fn nothing_configured_is_explained() {
        let dir = tempfile::tempdir().unwrap();
        let creds = MemoryStore::default();
        assert_eq!(active_with_key(dir.path(), &creds).unwrap_err().code, "AI_NOT_CONFIGURED");
        save_provider(dir.path(), &creds, args(None, "https://a.example/v1"), None).unwrap();
        let err = active_with_key(dir.path(), &creds).unwrap_err();
        assert_eq!(err.code, "AI_NOT_CONFIGURED");
        assert!(err.message.contains("Key"), "{}", err.message);
    }

    #[test]
    fn a_stored_key_is_only_used_for_the_host_it_was_saved_for() {
        let dir = tempfile::tempdir().unwrap();
        let creds = MemoryStore::default();
        let id = save_provider(dir.path(), &creds, args(None, "https://a.example/v1"), Some("sk-a".into())).unwrap().provider_id;
        assert_eq!(key_for_models(dir.path(), &creds, Some(&id), "https://a.example/v1", None).unwrap(), "sk-a");
        let err = key_for_models(dir.path(), &creds, Some(&id), "https://b.example/v1", None).unwrap_err();
        assert_eq!(err.code, "AI_MODELS_MISSING_KEY");
        assert_eq!(key_for_models(dir.path(), &creds, Some(&id), "https://b.example/v1", Some(" sk-b ".into())).unwrap(), "sk-b");
        assert_eq!(key_for_models(dir.path(), &creds, None, "https://a.example/v1", None).unwrap_err().code, "AI_MODELS_MISSING_KEY");
    }
}
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib ai_provider_commands`
Expected: 编译失败。

- [ ] **Step 2：实现**（放在测试之上；`lib.rs` 加 `mod ai_provider_commands;`）

```rust
//! #130 PR 2a：设置页的服务商命令。Key 只往凭据库里写、只在发请求时取，
//! **没有任何一条路径把 Key 交回界面**。编辑服务商时主机变了就清掉它的 Key。

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::ai_credentials::{migrate_legacy_key, CredentialError, CredentialStore};
use crate::ai_settings::{self, AiProvider, ProviderInput, LEGACY_PROVIDER_ID};
use crate::commands::CommandError;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderArgs {
    pub id: Option<String>,
    pub name: String,
    pub api_url: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: String,
    pub name: String,
    pub api_url: String,
    pub model: String,
    /// 预览和提示里只出现主机名。
    pub host: String,
    pub key_configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsView {
    pub providers: Vec<ProviderView>,
    pub active_provider_id: Option<String>,
    /// 凭据库读不出来时说明原因，不假装「没配过」。
    pub credential_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProviderResult {
    pub view: AiSettingsView,
    pub provider_id: String,
    /// 主机变了、旧 Key 被清掉、这次又没填新 Key。界面据此提醒重新填。
    pub key_cleared: bool,
}

fn credential_error(err: CredentialError) -> CommandError {
    CommandError { code: err.code().into(), message: err.message() }
}

fn settings_error(message: String) -> CommandError {
    CommandError { code: "AI_SETTINGS_INVALID".into(), message }
}

/// 旧版只有一把 Key。迁出来的 `default` 服务商存在时，把旧 Key 搬过去；幂等。
fn migrate(data_root: &Path, creds: &dyn CredentialStore) -> Result<(), CredentialError> {
    let settings = ai_settings::load(data_root);
    if settings.providers.iter().any(|p| p.id == LEGACY_PROVIDER_ID) {
        migrate_legacy_key(creds, LEGACY_PROVIDER_ID)?;
    }
    Ok(())
}

pub fn settings_view(data_root: &Path, creds: &dyn CredentialStore) -> AiSettingsView {
    let mut credential_error = migrate(data_root, creds).err().map(|e| e.message());
    let settings = ai_settings::load(data_root);
    let providers = settings
        .providers
        .iter()
        .map(|p| {
            let key_configured = match creds.get_key(&p.id) {
                Ok(found) => found.is_some(),
                Err(err) => {
                    credential_error.get_or_insert(err.message());
                    false
                }
            };
            ProviderView {
                id: p.id.clone(),
                name: p.name.clone(),
                api_url: p.api_url.clone(),
                model: p.model.clone(),
                host: ai_settings::host_of(&p.api_url),
                key_configured,
            }
        })
        .collect();
    AiSettingsView { providers, active_provider_id: settings.active_provider_id, credential_error }
}

/// 保存服务商；`key` 非空时顺带存 Key（新建时可以一步填完）。
pub fn save_provider(
    data_root: &Path,
    creds: &dyn CredentialStore,
    args: ProviderArgs,
    key: Option<String>,
) -> Result<SaveProviderResult, CommandError> {
    let outcome = ai_settings::save_provider(
        data_root,
        ProviderInput { id: args.id, name: args.name, api_url: args.api_url, model: args.model },
    )
    .map_err(settings_error)?;
    let typed = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    let mut key_cleared = false;
    if outcome.host_changed {
        let had_key = creds.has_key(&outcome.provider_id);
        creds.clear_key(&outcome.provider_id).map_err(credential_error)?;
        key_cleared = had_key && typed.is_none();
    }
    if let Some(key) = typed {
        creds.set_key(&outcome.provider_id, &key).map_err(credential_error)?;
    }
    Ok(SaveProviderResult { view: settings_view(data_root, creds), provider_id: outcome.provider_id, key_cleared })
}

pub fn delete_provider(data_root: &Path, creds: &dyn CredentialStore, id: &str) -> Result<AiSettingsView, CommandError> {
    ai_settings::delete_provider(data_root, id).map_err(settings_error)?;
    creds.clear_key(id).map_err(credential_error)?;
    Ok(settings_view(data_root, creds))
}

pub fn set_active(data_root: &Path, creds: &dyn CredentialStore, id: &str) -> Result<AiSettingsView, CommandError> {
    ai_settings::set_active(data_root, id).map_err(settings_error)?;
    Ok(settings_view(data_root, creds))
}

fn provider_exists(data_root: &Path, id: &str) -> Result<(), CommandError> {
    let settings = ai_settings::load(data_root);
    if settings.providers.iter().any(|p| p.id == id) {
        Ok(())
    } else {
        Err(settings_error("这个服务商已经不在了，刷新一下。".into()))
    }
}

/// Key 只进凭据库。这里不写日志、不回显，连长度都不记。
pub fn set_key(data_root: &Path, creds: &dyn CredentialStore, id: &str, key: &str) -> Result<AiSettingsView, CommandError> {
    provider_exists(data_root, id)?;
    creds.set_key(id, key).map_err(credential_error)?;
    Ok(settings_view(data_root, creds))
}

pub fn clear_key(data_root: &Path, creds: &dyn CredentialStore, id: &str) -> Result<AiSettingsView, CommandError> {
    provider_exists(data_root, id)?;
    creds.clear_key(id).map_err(credential_error)?;
    Ok(settings_view(data_root, creds))
}

/// 分析、解析、转发都用它：当前服务商 + 它的 Key。
pub fn active_with_key(data_root: &Path, creds: &dyn CredentialStore) -> Result<(AiProvider, String), CommandError> {
    migrate(data_root, creds).map_err(credential_error)?;
    let settings = ai_settings::load(data_root);
    let provider = ai_settings::active(&settings).cloned().ok_or_else(|| CommandError {
        code: "AI_NOT_CONFIGURED".into(),
        message: "还没有配置 AI 服务商，先去设置页添加一个。".into(),
    })?;
    let key = creds.get_key(&provider.id).map_err(credential_error)?.ok_or_else(|| CommandError {
        code: "AI_NOT_CONFIGURED".into(),
        message: format!("「{}」还没有 Key，先去设置页填一条。", provider.name),
    })?;
    Ok((provider, key))
}

/// 获取模型用哪把 Key：界面上刚填的优先；否则只有「输入的地址与已保存地址是同一主机」时
/// 才用这个服务商存着的 Key——未保存的新地址拿不到旧 Key。
pub fn key_for_models(
    data_root: &Path,
    creds: &dyn CredentialStore,
    provider_id: Option<&str>,
    api_url: &str,
    typed: Option<String>,
) -> Result<String, CommandError> {
    if let Some(key) = typed.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        return Ok(key);
    }
    let missing = || CommandError {
        code: "AI_MODELS_MISSING_KEY".into(),
        message: "请先填写 API Key，再获取模型。".into(),
    };
    let id = provider_id.ok_or_else(missing)?;
    let settings = ai_settings::load(data_root);
    let saved = settings.providers.iter().find(|p| p.id == id).ok_or_else(missing)?;
    if ai_settings::host_of(&saved.api_url) != ai_settings::host_of(api_url) {
        return Err(missing());
    }
    creds.get_key(id).map_err(credential_error)?.ok_or_else(missing)
}
```

- [ ] **Step 3：跑测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib ai_provider_commands`
Expected: PASS。

- [ ] **Step 4：提交**

```bash
git add desktop/src-tauri/src/ai_provider_commands.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): 服务商命令逻辑，主机变更清 Key、获取模型只在同主机用已存 Key (#130)"
```

---

### Task 5：注册命令，分析改用当前服务商

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs`

- [ ] **Step 1：替换 AI 设置命令**

删除 `lib.rs` 里旧的 `AiSettingsView`、`ai_settings_view`、`save_ai_settings_cmd`、旧签名的 `set_ai_key_cmd` / `clear_ai_key_cmd`，改为：

```rust
#[tauri::command]
fn get_ai_settings_cmd(state: State<AppState>) -> Result<ai_provider_commands::AiSettingsView, CommandError> {
    Ok(ai_provider_commands::settings_view(&ai_data_root(&state)?, state.credentials.as_ref()))
}

#[tauri::command]
fn save_ai_provider_cmd(
    state: State<AppState>,
    provider: ai_provider_commands::ProviderArgs,
    key: Option<String>,
) -> Result<ai_provider_commands::SaveProviderResult, CommandError> {
    ai_provider_commands::save_provider(&ai_data_root(&state)?, state.credentials.as_ref(), provider, key)
}

#[tauri::command]
fn delete_ai_provider_cmd(state: State<AppState>, id: String) -> Result<ai_provider_commands::AiSettingsView, CommandError> {
    ai_provider_commands::delete_provider(&ai_data_root(&state)?, state.credentials.as_ref(), &id)
}

#[tauri::command]
fn set_active_ai_provider_cmd(state: State<AppState>, id: String) -> Result<ai_provider_commands::AiSettingsView, CommandError> {
    ai_provider_commands::set_active(&ai_data_root(&state)?, state.credentials.as_ref(), &id)
}

/// Key 只进凭据库。这里不写日志、不回显，连长度都不记。
#[tauri::command]
fn set_ai_key_cmd(state: State<AppState>, provider_id: String, key: String) -> Result<ai_provider_commands::AiSettingsView, CommandError> {
    ai_provider_commands::set_key(&ai_data_root(&state)?, state.credentials.as_ref(), &provider_id, &key)
}

#[tauri::command]
fn clear_ai_key_cmd(state: State<AppState>, provider_id: String) -> Result<ai_provider_commands::AiSettingsView, CommandError> {
    ai_provider_commands::clear_key(&ai_data_root(&state)?, state.credentials.as_ref(), &provider_id)
}

/// 设置页给界面的模型列表：只含名字、隐藏数、主机名。**不含 Key，不含完整地址。**
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelListView {
    models: Vec<String>,
    hidden_count: usize,
    host: String,
}

/// 用户在设置页主动点一次，才往所填地址对应的 `/models` 发一次只带 Key 的 GET。
#[tauri::command]
async fn list_ai_models_cmd(
    state: State<'_, AppState>,
    provider_id: Option<String>,
    api_url: String,
    key: Option<String>,
) -> Result<ModelListView, CommandError> {
    checked_url(&api_url)?;
    let models_url = ai_models::resolve_endpoints(&api_url)
        .ok_or_else(|| CommandError {
            code: "AI_MODELS_BAD_URL".into(),
            message: "API URL 格式不对，请填写以 http:// 或 https:// 开头的地址。".into(),
        })?
        .models_url
        .ok_or_else(|| CommandError {
            code: "AI_MODELS_UNKNOWN_SHAPE".into(),
            message: "无法从这个 API URL 推断模型列表地址（通常以 /v1 或 /chat/completions 结尾）。可直接手填模型名称。".into(),
        })?;
    let effective = ai_provider_commands::key_for_models(
        &ai_data_root(&state)?,
        state.credentials.as_ref(),
        provider_id.as_deref(),
        &api_url,
        key,
    )?;
    let host = ai_settings::host_of(&api_url);
    let list = ai_models::fetch_model_list(&models_url, &effective, &host).await?;
    Ok(ModelListView { models: list.models, hidden_count: list.hidden_count, host })
}
```

`fetch_model_list` 的名字以移植来的 `ai_models.rs` 为准（`a09db3d` 里是 `fetch_model_list(models_url, api_key, host)`）。

- [ ] **Step 2：分析命令改用当前服务商**

`preview_analysis_cmd`：

```rust
    let (provider, _key) = ai_provider_commands::active_with_key(&ai_data_root(&state)?, state.credentials.as_ref())?;
    checked_url(&provider.api_url)?;
```

后面的 `settings.api_url` / `settings.model` 改为 `provider.api_url` / `provider.model`。（预览也要求有 Key：没有 Key 的服务商发不出去，预览时就说清楚。）

`analyze_evidence_cmd`：用同一个 `active_with_key` 取 `(provider, key)`，替换原来的 `ai_settings::load` + `state.credentials.get_key()`；`host`、`build_request`、`client.chat` 都改用 `provider`。

- [ ] **Step 3：注册**

`generate_handler!` 里删 `save_ai_settings_cmd`，加 `save_ai_provider_cmd`、`delete_ai_provider_cmd`、`set_active_ai_provider_cmd`、`list_ai_models_cmd`（`set_ai_key_cmd`、`clear_ai_key_cmd`、`get_ai_settings_cmd` 保留名字、签名已变）。删掉 Task 1–2 里为编译通过加的临时代码。`ai_models.rs` 若还有未用函数的 dead_code 警告，确认是测试专用的就加 `#[cfg(test)]` 或删掉。

- [ ] **Step 4：全量 Rust 测试与构建**

Run: `cd desktop && cargo test --manifest-path src-tauri/Cargo.toml --locked --bins --lib && cargo build --manifest-path src-tauri/Cargo.toml --locked --bins`
Expected: 全绿、编译通过、无新警告。

- [ ] **Step 5：提交**

```bash
git add desktop/src-tauri/src/lib.rs desktop/src-tauri/src/ai_models.rs
git commit -m "feat(desktop): 注册服务商与获取模型命令，AI 整理改用当前服务商 (#130)"
```

---

### Task 6：前端类型、预设与文案

**Files:**
- Modify: `desktop/src/api.ts`、`desktop/src/ai/ai-settings.ts`、`desktop/src/ai/ai-settings.test.ts`

- [ ] **Step 1：写失败测试**（`ai-settings.test.ts` 追加；删除只测旧 `describeKeyState(view)` / `describeSaved` 的用例）

```ts
import { describeModelsResult, describeProviderKey, matchModels, PRESETS } from "./ai-settings.ts";

test("预设都是 https 的 Base URL，名字不重复", () => {
  const names = new Set(PRESETS.map((p) => p.name));
  assert.equal(names.size, PRESETS.length);
  for (const preset of PRESETS) {
    if (preset.id === "custom") continue;
    assert.match(preset.apiUrl, /^https:\/\//);
    assert.match(preset.keyPage, /^https:\/\//);
  }
  assert.ok(PRESETS.some((p) => p.id === "custom" && p.apiUrl === ""));
});

test("每个服务商的 Key 状态", () => {
  assert.equal(describeProviderKey({ keyConfigured: true }, null).tone, "ok");
  assert.equal(describeProviderKey({ keyConfigured: false }, null).tone, "warn");
  assert.equal(describeProviderKey({ keyConfigured: false }, "钥匙串锁了").tone, "error");
});

test("模型候选：完全一致 > 前缀（含 vendor/ 之后） > 子串", () => {
  assert.deepEqual(matchModels(["a/deepseek-chat", "deepseek-chat", "x-deepseek"], "deepseek-chat"), [
    "deepseek-chat",
    "a/deepseek-chat",
  ]);
  assert.deepEqual(matchModels(["qwen-plus", "qwen-max"], ""), ["qwen-plus", "qwen-max"]);
});

test("获取模型的结果提示", () => {
  assert.match(describeModelsResult({ models: ["a"], hiddenCount: 2, host: "h" }).text, /拿到 1 个模型.*另有 2 个非对话模型已隐藏/);
  assert.equal(describeModelsResult({ models: [], hiddenCount: 0, host: "h" }).tone, "warn");
});
```

Run: `cd desktop && npm run test:ui`
Expected: FAIL。

- [ ] **Step 2：实现**

`desktop/src/api.ts`：用下面替换旧 `AiSettingsView`：

```ts
/** 设置页的一个 AI 服务商。**Key 本身永远不会回到前端**，只有配没配。 */
export interface AiProviderView {
  id: string;
  name: string;
  apiUrl: string;
  model: string;
  /** 只有主机名，不含完整地址。 */
  host: string;
  keyConfigured: boolean;
}

export interface AiSettingsView {
  providers: AiProviderView[];
  activeProviderId: string | null;
  /** 凭据库读不出来时的原因；正常是 null。 */
  credentialError: string | null;
}

export interface SaveProviderResult {
  view: AiSettingsView;
  providerId: string;
  keyCleared: boolean;
}

/** `list_ai_models_cmd` 的结果：只含模型名和主机名。 */
export interface ModelListView {
  models: string[];
  hiddenCount: number;
  host: string;
}
```

`desktop/src/ai/ai-settings.ts`：删 `describeKeyState`、`describeSaved`；从 `a09db3d` 取 `describeModelsResult`、`matchModels`（`git show a09db3d:desktop/src/ai/ai-settings.ts`，原样）；加：

```ts
export interface Preset {
  id: string;
  name: string;
  /** Base URL，保存时由桌面补全 /chat/completions。自定义为空。 */
  apiUrl: string;
  /** 去哪里申请 Key。只显示为可复制的文字，不在应用里打开外部网页。 */
  keyPage: string;
  modelHint: string;
}

// 只列 OpenAI 兼容 Chat Completions 的常用服务商。模型名不预填：各家更新快，
// 用「获取模型」从对方的列表里挑，比写死更可靠。
export const PRESETS: Preset[] = [
  { id: "deepseek", name: "DeepSeek", apiUrl: "https://api.deepseek.com/v1", keyPage: "https://platform.deepseek.com/api_keys", modelHint: "deepseek-chat" },
  { id: "qwen", name: "通义千问", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", keyPage: "https://bailian.console.aliyun.com/", modelHint: "qwen-plus" },
  { id: "kimi", name: "Kimi", apiUrl: "https://api.moonshot.cn/v1", keyPage: "https://platform.moonshot.cn/console/api-keys", modelHint: "" },
  { id: "zhipu", name: "智谱", apiUrl: "https://open.bigmodel.cn/api/paas/v4", keyPage: "https://open.bigmodel.cn/usercenter/apikeys", modelHint: "" },
  { id: "doubao", name: "豆包（火山方舟）", apiUrl: "https://ark.cn-beijing.volces.com/api/v3", keyPage: "https://console.volcengine.com/ark", modelHint: "" },
  { id: "openrouter", name: "OpenRouter", apiUrl: "https://openrouter.ai/api/v1", keyPage: "https://openrouter.ai/keys", modelHint: "" },
  { id: "openai", name: "OpenAI", apiUrl: "https://api.openai.com/v1", keyPage: "https://platform.openai.com/api-keys", modelHint: "gpt-4o-mini" },
  { id: "custom", name: "自定义", apiUrl: "", keyPage: "", modelHint: "" },
];

/** 一个服务商的 Key 状态。凭据库本身出错时优先说出错。 */
export function describeProviderKey(provider: { keyConfigured: boolean }, credentialError: string | null): Message {
  if (credentialError) return { tone: "error", text: credentialError };
  return provider.keyConfigured
    ? { tone: "ok", text: "已保存 Key（存在系统凭据库里，界面不会显示它）。" }
    : { tone: "warn", text: "还没有 Key。没有 Key 就不能用 AI，手动操作照常可用。" };
}
```

`ModelListView` 从 `../api.ts` 导入。

- [ ] **Step 3：跑测试**

Run: `cd desktop && npm run test:ui && npm run typecheck`
Expected: `test:ui` PASS；`typecheck` 此时会因 `AiSettings.tsx` 仍用旧类型失败——下一任务重写，本步只要求 `test:ui` 通过、`typecheck` 的报错**只**出现在 `AiSettings.tsx` / `AiSettings.test.tsx`。

- [ ] **Step 4：提交**

```bash
git add desktop/src/api.ts desktop/src/ai/ai-settings.ts desktop/src/ai/ai-settings.test.ts
git commit -m "feat(desktop): 服务商视图类型、预设与模型候选排序 (#130)"
```

---

### Task 7：服务商编辑器组件

**Files:**
- Create: `desktop/src/ai/ProviderEditor.tsx`、`desktop/src/ai/ProviderEditor.test.tsx`

编辑器负责一个服务商：名称、接口地址（带明文传输与地址夹带凭据提醒）、模型（带「获取模型」与候选）、API Key（新填或清除）。保存时一次调用 `save_ai_provider_cmd { provider, key }`。

- [ ] **Step 1：写失败测试**

```tsx
import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiProviderView, Invoke, SaveProviderResult } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { ProviderEditor } from "./ProviderEditor.tsx";

const existing: AiProviderView = {
  id: "p1", name: "DeepSeek", apiUrl: "https://api.deepseek.com/v1/chat/completions",
  model: "deepseek-chat", host: "api.deepseek.com", keyConfigured: true,
};

const saved = (over: Partial<SaveProviderResult> = {}): SaveProviderResult => ({
  view: { providers: [existing], activeProviderId: "p1", credentialError: null },
  providerId: "p1", keyCleared: false, ...over,
});

function mount(
  props: Partial<Parameters<typeof ProviderEditor>[0]>,
  handler: (command: string, args?: Record<string, unknown>) => unknown,
) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(
    <InvokeProvider invoke={invoke}>
      <ProviderEditor provider={null} preset={null} credentialError={null} onSaved={onSaved} onCancel={onCancel} {...props} />
    </InvokeProvider>,
  );
  return { calls, onSaved, onCancel };
}

test("从预设新建：填好地址，保存时连 Key 一起交出去", async () => {
  const user = userEvent.setup();
  const { calls, onSaved } = mount(
    { preset: { id: "deepseek", name: "DeepSeek", apiUrl: "https://api.deepseek.com/v1", keyPage: "https://platform.deepseek.com/api_keys", modelHint: "deepseek-chat" } },
    () => saved(),
  );
  expect(screen.getByLabelText("接口地址")).toHaveProperty("value", "https://api.deepseek.com/v1");
  expect(screen.getByText("https://platform.deepseek.com/api_keys")).toBeTruthy();
  await user.type(screen.getByLabelText("模型名称"), "deepseek-chat");
  await user.type(screen.getByLabelText("API Key"), "sk-x");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(calls[0]).toEqual({
    command: "save_ai_provider_cmd",
    args: { provider: { id: null, name: "DeepSeek", apiUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" }, key: "sk-x" },
  });
});

test("编辑已有服务商不填 Key 时不动原来的 Key", async () => {
  const user = userEvent.setup();
  const { calls } = mount({ provider: existing }, () => saved());
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0].args?.key).toBeNull();
});

test("主机变了、旧 Key 被清掉时要说出来", async () => {
  const user = userEvent.setup();
  const { onSaved } = mount({ provider: existing }, () => saved({ keyCleared: true }));
  const url = screen.getByLabelText("接口地址");
  await user.clear(url);
  await user.type(url, "https://api.moonshot.cn/v1");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(onSaved.mock.calls[0][0]).toMatchObject({ keyCleared: true });
});

test("获取模型：用刚填的 Key，点候选填进模型名", async () => {
  const user = userEvent.setup();
  const { calls } = mount({ provider: existing }, (command) =>
    command === "list_ai_models_cmd" ? { models: ["deepseek-chat", "deepseek-reasoner"], hiddenCount: 1, host: "api.deepseek.com" } : saved(),
  );
  await user.type(screen.getByLabelText("API Key"), "sk-new");
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  await user.click(await screen.findByRole("button", { name: "deepseek-reasoner" }));
  expect(screen.getByLabelText("模型名称")).toHaveProperty("value", "deepseek-reasoner");
  expect(calls[0]).toEqual({
    command: "list_ai_models_cmd",
    args: { providerId: "p1", apiUrl: existing.apiUrl, key: "sk-new" },
  });
  expect(screen.getByText(/另有 1 个非对话模型已隐藏/)).toBeTruthy();
});

test("改地址后旧候选作废", async () => {
  const user = userEvent.setup();
  mount({ provider: existing }, () => ({ models: ["deepseek-chat"], hiddenCount: 0, host: "api.deepseek.com" }));
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  expect(await screen.findByRole("button", { name: "deepseek-chat" })).toBeTruthy();
  await user.type(screen.getByLabelText("接口地址"), "x");
  expect(screen.queryByRole("button", { name: "deepseek-chat" })).toBeNull();
});

test("获取失败只提示，不拦保存", async () => {
  const user = userEvent.setup();
  const { calls } = mount({ provider: existing }, (command) => {
    if (command === "list_ai_models_cmd") throw { code: "AI_MODELS_AUTH", message: "api.deepseek.com 拒绝了这个 Key（HTTP 401）" };
    return saved();
  });
  await user.click(screen.getByRole("button", { name: "获取模型" }));
  expect(await screen.findByText(/拒绝了这个 Key/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(calls.some((c) => c.command === "save_ai_provider_cmd")).toBe(true));
});

test("清除 Key 要确认", async () => {
  const user = userEvent.setup();
  const { calls } = mount({ provider: existing }, () => ({ providers: [{ ...existing, keyConfigured: false }], activeProviderId: "p1", credentialError: null }));
  await user.click(screen.getByRole("button", { name: "清除 Key" }));
  expect(calls).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "确认清除" }));
  await waitFor(() => expect(calls[0]).toEqual({ command: "clear_ai_key_cmd", args: { providerId: "p1" } }));
});

test("明文 http 与地址里夹带凭据会提示", async () => {
  const user = userEvent.setup();
  mount({}, () => saved());
  await user.type(screen.getByLabelText("接口地址"), "http://relay.example.com/v1?api_key=abc");
  expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(1);
});
```

Run: `cd desktop && npm run test:react -- src/ai/ProviderEditor.test.tsx`
Expected: FAIL。

- [ ] **Step 2：实现** `desktop/src/ai/ProviderEditor.tsx`

```tsx
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AiProviderView, AiSettingsView, ModelListView, SaveProviderResult } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import {
  describeCommandError,
  describeModelsResult,
  describeProviderKey,
  describeTransportRisk,
  describeUrlSecrets,
  matchModels,
} from "./ai-settings.ts";
import type { Message, Preset } from "./ai-settings.ts";

export interface ProviderEditorProps {
  /** 编辑已有的；新建时为 null。 */
  provider: AiProviderView | null;
  /** 新建时选的预设；编辑时为 null。 */
  preset: Preset | null;
  credentialError: string | null;
  onSaved(result: SaveProviderResult): void;
  onCancel(): void;
  /** 清除 Key 之后把新视图交回列表。 */
  onKeyCleared?(view: AiSettingsView): void;
}

export function ProviderEditor({ provider, preset, credentialError, onSaved, onCancel, onKeyCleared }: ProviderEditorProps) {
  const invoke = useInvoke();
  const [name, setName] = useState(provider?.name ?? preset?.name ?? "");
  const [apiUrl, setApiUrl] = useState(provider?.apiUrl ?? preset?.apiUrl ?? "");
  const [model, setModel] = useState(provider?.model ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // 候选只对拉取那一刻的地址与 Key 有效；改了就作废，迟到的回包按序号丢掉。
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsNote, setModelsNote] = useState<Message | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const request = useRef(0);

  const invalidateModels = () => {
    request.current += 1;
    setModels(null);
    setModelsNote(null);
    setModelsBusy(false);
  };

  useEffect(() => invalidateModels, []);

  const fetchModels = () => {
    if (!invoke || modelsBusy) return;
    const mine = ++request.current;
    setModelsBusy(true);
    invoke<ModelListView>("list_ai_models_cmd", {
      providerId: provider?.id ?? null,
      apiUrl,
      key: key.trim() === "" ? null : key,
    })
      .then((result) => {
        if (request.current !== mine) return;
        setModels(result.models);
        setModelsNote(describeModelsResult(result));
      })
      .catch((error: unknown) => {
        if (request.current !== mine) return;
        setModelsNote(describeCommandError(error));
      })
      .finally(() => {
        if (request.current === mine) setModelsBusy(false);
      });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!invoke || busy) return;
    setBusy(true);
    try {
      const result = await invoke<SaveProviderResult>("save_ai_provider_cmd", {
        provider: { id: provider?.id ?? null, name, apiUrl, model },
        key: key.trim() === "" ? null : key,
      });
      setKey("");
      onSaved(result);
    } catch (error) {
      setMessage(describeCommandError(error));
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    if (!invoke || !provider || busy) return;
    setBusy(true);
    try {
      const view = await invoke<AiSettingsView>("clear_ai_key_cmd", { providerId: provider.id });
      setConfirmClear(false);
      setMessage({ tone: "ok", text: "Key 已从系统凭据库删除。" });
      onKeyCleared?.(view);
    } catch (error) {
      setMessage(describeCommandError(error));
    } finally {
      setBusy(false);
    }
  };

  const risk = describeTransportRisk(apiUrl);
  const secrets = describeUrlSecrets(apiUrl);
  const keyState = provider ? describeProviderKey(provider, credentialError) : null;
  const candidates = models ? matchModels(models, model).slice(0, 30) : [];

  return (
    <form className="stack ai-config-form" onSubmit={save}>
      <label>
        名称
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoComplete="off" />
      </label>
      <label>
        接口地址
        <input
          value={apiUrl}
          onChange={(event) => {
            setApiUrl(event.target.value);
            invalidateModels();
          }}
          placeholder="https://api.deepseek.com/v1"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <p className="muted">填 Base URL 就行，保存时补全成 /chat/completions；自定义代理路径保持原样。</p>
      {risk ? <p role="status" className={`note ${risk.tone}`}>{risk.text}</p> : null}
      {secrets ? <p role="status" className={`note ${secrets.tone}`}>{secrets.text}</p> : null}
      {preset?.keyPage ? (
        <p className="muted">
          去这里申请 Key：<code>{preset.keyPage}</code>
        </p>
      ) : null}
      <label>
        模型名称
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder={preset?.modelHint || "deepseek-chat"}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="row">
        <button type="button" onClick={fetchModels} disabled={modelsBusy || !invoke || apiUrl.trim() === ""}>
          {modelsBusy ? "正在获取…" : "获取模型"}
        </button>
        <span className="muted">只发 Key，不发简历；失败不影响保存，永远可以手填。</span>
      </div>
      {candidates.length ? (
        <ul className="model-candidates">
          {candidates.map((id) => (
            <li key={id}>
              <button type="button" onClick={() => setModel(id)}>
                {id}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {modelsNote ? <p role="status" className={`note ${modelsNote.tone}`}>{modelsNote.text}</p> : null}
      {keyState ? <p className={`note ${keyState.tone}`}>{keyState.text}</p> : null}
      <label>
        API Key
        <input
          type="password"
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
            invalidateModels();
          }}
          placeholder={provider?.keyConfigured ? "不改就留空" : "粘贴后点保存，界面不会再显示它"}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {provider?.keyConfigured ? (
        confirmClear ? (
          <div className="row">
            <button type="button" className="danger" onClick={() => void clearKey()} disabled={busy}>
              确认清除
            </button>
            <button type="button" onClick={() => setConfirmClear(false)}>
              取消
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmClear(true)} disabled={busy}>
            清除 Key
          </button>
        )
      ) : null}
      {message ? <p role="status" className={`note ${message.tone}`}>{message.text}</p> : null}
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !invoke}>
          保存
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
```

`useEffect(() => invalidateModels, [])` 的作用是卸载时让迟到回包作废；若 lint/StrictMode 下有问题，改为 `useEffect(() => () => { request.current += 1; }, [])`。

- [ ] **Step 3：跑测试**

Run: `cd desktop && npm run test:react -- src/ai/ProviderEditor.test.tsx`
Expected: PASS。若某条测试与真实组件行为不符，最小修改测试并在提交说明里写原因（不得削弱它验证的内容）。

- [ ] **Step 4：提交**

```bash
git add desktop/src/ai/ProviderEditor.tsx desktop/src/ai/ProviderEditor.test.tsx
git commit -m "feat(desktop): 服务商编辑器，获取模型与按服务商存 Key (#130)"
```

---

### Task 8：服务商列表（设置页 AI 一段）

**Files:**
- Modify（改写）: `desktop/src/ai/AiSettings.tsx`、`desktop/src/ai/AiSettings.test.tsx`

- [ ] **Step 1：写失败测试**（整体替换 `AiSettings.test.tsx`）

```tsx
import { expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiSettingsView, Invoke } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { AiSettings } from "./AiSettings.tsx";

const view: AiSettingsView = {
  providers: [
    { id: "p1", name: "DeepSeek", apiUrl: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat", host: "api.deepseek.com", keyConfigured: true },
    { id: "p2", name: "通义千问", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-plus", host: "dashscope.aliyuncs.com", keyConfigured: false },
  ],
  activeProviderId: "p1",
  credentialError: null,
};

function mount(handler: (command: string, args?: Record<string, unknown>) => unknown) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <AiSettings />
    </InvokeProvider>,
  );
  return calls;
}

test("列出服务商，标出当前使用、主机、模型、Key 状态", async () => {
  mount(() => view);
  const current = await screen.findByRole("listitem", { name: /DeepSeek/ });
  expect(within(current).getByText("当前使用")).toBeTruthy();
  expect(within(current).getByText(/api\.deepseek\.com/)).toBeTruthy();
  const other = screen.getByRole("listitem", { name: /通义千问/ });
  expect(within(other).getByText(/没有 Key/)).toBeTruthy();
});

test("没有服务商时引导从预设添加", async () => {
  mount(() => ({ providers: [], activeProviderId: null, credentialError: null }));
  expect(await screen.findByText(/还没有配置 AI 服务商/)).toBeTruthy();
  expect(screen.getByLabelText("从预设添加")).toBeTruthy();
});

test("切换当前使用", async () => {
  const user = userEvent.setup();
  const calls = mount((command) => (command === "set_active_ai_provider_cmd" ? { ...view, activeProviderId: "p2" } : view));
  const other = await screen.findByRole("listitem", { name: /通义千问/ });
  await user.click(within(other).getByRole("button", { name: "设为当前" }));
  await waitFor(() => expect(within(other).getByText("当前使用")).toBeTruthy());
  expect(calls.find((c) => c.command === "set_active_ai_provider_cmd")?.args).toEqual({ id: "p2" });
});

test("从预设新建会打开编辑器并预填地址", async () => {
  const user = userEvent.setup();
  mount(() => view);
  await screen.findByRole("listitem", { name: /DeepSeek/ });
  await user.selectOptions(screen.getByLabelText("从预设添加"), "kimi");
  await user.click(screen.getByRole("button", { name: "添加" }));
  expect(screen.getByLabelText("接口地址")).toHaveProperty("value", "https://api.moonshot.cn/v1");
});

test("删除要确认，删掉的服务商连 Key 一起删", async () => {
  const user = userEvent.setup();
  const calls = mount((command) =>
    command === "delete_ai_provider_cmd" ? { ...view, providers: [view.providers[0]] } : view,
  );
  const other = await screen.findByRole("listitem", { name: /通义千问/ });
  await user.click(within(other).getByRole("button", { name: "删除" }));
  expect(calls.some((c) => c.command === "delete_ai_provider_cmd")).toBe(false);
  expect(within(other).getByText(/Key 也会一起删除/)).toBeTruthy();
  await user.click(within(other).getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(screen.queryByRole("listitem", { name: /通义千问/ })).toBeNull());
});

test("保存后主机变了、Key 被清掉，提醒重新填", async () => {
  const user = userEvent.setup();
  mount((command) =>
    command === "save_ai_provider_cmd" ? { view, providerId: "p1", keyCleared: true } : view,
  );
  const row = await screen.findByRole("listitem", { name: /DeepSeek/ });
  await user.click(within(row).getByRole("button", { name: "编辑" }));
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByText(/换了主机，原来的 Key 已清除/)).toBeTruthy();
});

test("没连上桌面宿主时如实说明", async () => {
  render(
    <InvokeProvider invoke={null}>
      <AiSettings />
    </InvokeProvider>,
  );
  expect(screen.getByText(/没连上桌面宿主/)).toBeTruthy();
});
```

Run: `cd desktop && npm run test:react -- src/ai/AiSettings.test.tsx`
Expected: FAIL。

- [ ] **Step 2：实现**（整体替换 `AiSettings.tsx`）

```tsx
import { useEffect, useState } from "react";
import type { AiProviderView, AiSettingsView, SaveProviderResult } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { describeCommandError, describeProviderKey, PRESETS } from "./ai-settings.ts";
import type { Message, Preset } from "./ai-settings.ts";
import { ProviderEditor } from "./ProviderEditor.tsx";

type Editing = { provider: AiProviderView | null; preset: Preset | null } | null;

/**
 * 设置页的 AI 一段：服务商列表 + 当前使用。Key 只往下走，不往上回。
 * 收件箱「AI 整理」和简历解析都用「当前使用」的那一个；不做失败后自动换服务商。
 */
export function AiSettings() {
  const invoke = useInvoke();
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!invoke) return;
    invoke<AiSettingsView>("get_ai_settings_cmd")
      .then(setView)
      .catch((error: unknown) => setMessage(describeCommandError(error)));
  }, [invoke]);

  if (!invoke) return <p className="note warn">没连上桌面宿主，AI 设置读不出来。</p>;

  const run = async (work: () => Promise<AiSettingsView>, done: Message) => {
    if (busy) return;
    setBusy(true);
    try {
      setView(await work());
      setMessage(done);
    } catch (error) {
      setMessage(describeCommandError(error));
    } finally {
      setBusy(false);
    }
  };

  const onSaved = (result: SaveProviderResult) => {
    setView(result.view);
    setEditing(null);
    setMessage(
      result.keyCleared
        ? { tone: "warn", text: "已保存。接口地址换了主机，原来的 Key 已清除，请重新填写这个服务商的 Key。" }
        : { tone: "ok", text: "已保存。" },
    );
  };

  return (
    <div className="stack">
      <p className="muted">收件箱的「AI 整理」和简历解析都用「当前使用」的服务商。发送前你可以预览并确认要交给服务商的内容。</p>
      <details className="settings-disclosure">
        <summary>Key 保存说明</summary>
        <p className="muted">每个服务商的 Key 分别保存在系统凭据库（Windows 凭据管理器 / macOS 钥匙串），不进入档案、备份或日志。</p>
      </details>

      {view && view.providers.length === 0 ? <p className="note warn">还没有配置 AI 服务商。从下面的预设添加一个。</p> : null}

      {view && view.providers.length > 0 ? (
        <ul className="provider-list">
          {view.providers.map((provider) => {
            const active = provider.id === view.activeProviderId;
            const keyState = describeProviderKey(provider, view.credentialError);
            return (
              <li key={provider.id} aria-label={provider.name} className={active ? "provider-item active" : "provider-item"}>
                <div className="row">
                  <strong>{provider.name}</strong>
                  {active ? <span className="pill">当前使用</span> : null}
                  <span className="muted">
                    {provider.host} · {provider.model}
                  </span>
                </div>
                <p className={`note ${keyState.tone}`}>{keyState.text}</p>
                <div className="row">
                  {!active ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => invoke<AiSettingsView>("set_active_ai_provider_cmd", { id: provider.id }),
                          { tone: "ok", text: `已切换到「${provider.name}」。` },
                        )
                      }
                    >
                      设为当前
                    </button>
                  ) : null}
                  <button type="button" disabled={busy} onClick={() => setEditing({ provider, preset: null })}>
                    编辑
                  </button>
                  {confirmDelete === provider.id ? (
                    <>
                      <span className="muted">Key 也会一起删除。</span>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => invoke<AiSettingsView>("delete_ai_provider_cmd", { id: provider.id }),
                            { tone: "ok", text: `已删除「${provider.name}」。` },
                          ).then(() => setConfirmDelete(null))
                        }
                      >
                        确认删除
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => setConfirmDelete(provider.id)}>
                      删除
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {editing ? (
        <ProviderEditor
          key={editing.provider?.id ?? `new-${editing.preset?.id}`}
          provider={editing.provider}
          preset={editing.preset}
          credentialError={view?.credentialError ?? null}
          onSaved={onSaved}
          onCancel={() => setEditing(null)}
          onKeyCleared={setView}
        />
      ) : (
        <div className="row">
          <label>
            从预设添加
            <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
              {PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setEditing({ provider: null, preset: PRESETS.find((p) => p.id === presetId) ?? null })}
          >
            添加
          </button>
        </div>
      )}

      {message ? <p role="status" className={`note ${message.tone}`}>{message.text}</p> : null}
    </div>
  );
}
```

`styles.css` 追加（先 `grep -n "^\s*--" desktop/src/styles.css` 用已有变量名）：

```css
.provider-list { list-style: none; padding: 0; display: grid; gap: 12px; }
.provider-item { border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: grid; gap: 8px; }
.provider-item.active { border-color: var(--accent); }
```

`.model-candidates` 若已不存在（PR #146 才有），追加：`.model-candidates { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }`

- [ ] **Step 3：全量前端检查**

Run: `cd desktop && npm run typecheck && npm run test:ui && npm run test:react && npm run build`
Expected: 全部通过。

- [ ] **Step 4：提交**

```bash
git add desktop/src/ai/AiSettings.tsx desktop/src/ai/AiSettings.test.tsx desktop/src/styles.css
git commit -m "feat(desktop): 设置页 AI 服务商列表，当前使用、预设新建、删除确认 (#130)"
```

---

### Task 9：文档

**Files:**
- Modify: `docs/desktop-mvp/data-privacy.md`

- [ ] **Step 1**：§8 表格（「插件填写/解析 | 桌面通知整理（D11）」那张）桌面一列：
  - 「配置位置」：`Windows：Credential Manager / DPAPI；macOS：Keychain` 后补「每个服务商一条（账户 `ai-api-key:<服务商 id>`）」。
  - 「发往」改为：`用户在桌面设置的「当前使用」服务商；设置页点「获取模型」时另向所填地址对应的 /models 发一次只带 Key 的 GET（Key 优先用刚填的；否则只有地址与已保存地址是同一主机时才用该服务商已存的 Key。15 秒超时，日志只记主机名，报错只按状态码分类、不回显服务商正文，失败不拦手填）。编辑服务商时接口地址换了主机，该服务商的 Key 自动清除。`
- [ ] **Step 2**：§6.3.1 表格「不进包」一列里 `ai-settings.json（D11 的桌面 AI 接口地址与模型名）` 改为 `ai-settings.json（桌面 AI 服务商列表：名称、接口地址、模型名；不含 Key）`。
- [ ] **Step 3**：提交

```bash
git add docs/desktop-mvp/data-privacy.md
git commit -m "docs(privacy): 桌面 AI 多服务商与获取模型的外发口径 (#130)"
```

---

### Task 10：收尾与开 PR

- [ ] **Step 1**：`cd desktop && npm test`（全量），仓库根 `npm test`（插件，不应受影响）。全部通过。
- [ ] **Step 2**：实机走查（需要人）：`npm run desktop:dev`，① 旧版配置（有地址和 Key）升级后出现「默认」服务商且 AI 整理照常；② 从 DeepSeek 预设新建、填 Key、获取模型、选模型、保存；③ 切换当前使用后 AI 整理走新服务商（看预览里的主机名）；④ 编辑时改到另一个主机，保存后提示 Key 已清除；⑤ 删除服务商。结果写进 PR 描述。
- [ ] **Step 3**：推送并开 PR（标题 `feat(desktop): 桌面多服务商 AI 配置与获取模型 (#130 PR 2a)`），描述里写：取代 #146 的桌面部分（合入后关闭 #146 并在 #146 留言）、旧配置与旧 Key 的迁移方式、评审遗留两点如何做到、实机走查结果。关联 `Refs #130`、`Closes #143`。

---

## 自检

- 覆盖拆分计划 PR 2 的：服务商列表（Task 1）、Key 按服务商（Task 2）、旧配置与旧 Key 迁移（Task 1、2、4）、#146 移植 + 两处遗留（Task 3、4）、`ai_client` 读当前服务商（Task 5）、预设与设置页 UI（Task 6–8）、文档（Task 9）。简历解析在 PR 2b。
- 与拆分计划的偏差：拆分计划的决策 5 说简历解析的提示词与规范化移植到 Rust；改为桌面前端复用插件的 JS（见 PR 2b 计划），本 PR 不涉及。
- 命名一致性：命令 `get_ai_settings_cmd` / `save_ai_provider_cmd` / `delete_ai_provider_cmd` / `set_active_ai_provider_cmd` / `set_ai_key_cmd(providerId, key)` / `clear_ai_key_cmd(providerId)` / `list_ai_models_cmd(providerId, apiUrl, key)`，前后端与测试一致；`ai_provider_commands::active_with_key` 供 PR 2b 的 `ai_complete_cmd` 与 PR 3 的 `ai.complete` 复用。
