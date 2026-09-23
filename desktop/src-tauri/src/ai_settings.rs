//! 桌面这一侧的 AI 设置：接口地址和模型名。
//!
//! **Key 不在这里。** 它进 OS 凭据库（见 [`crate::ai_credentials`]），不进这个文件，
//! 也不进备份（data-privacy §1）。
//!
//! 单独一个 `ai-settings.json`，不跟配对草稿挤在 `settings.json` 里：那个文件是整份
//! 覆盖写的（`data-service::host::save_pairing_draft`），往里加东西会被下一次保存配对冲掉。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ai_credentials::{self, CredentialStore};

pub const DEFAULT_API_URL: &str = "https://api.openai.com/v1/chat/completions";
pub const DEFAULT_MODEL: &str = "gpt-4o-mini";
/// 从「只有一份」升级来的那条配置。重试用同一个 id，避免 Key 写进一个再也对不上的账户。
pub const LEGACY_PROFILE_ID: &str = "legacy";
const FILE_NAME: &str = "ai-settings.json";
const FILE_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfile {
    pub id: String,
    pub name: String,
    pub api_url: String,
    pub model: String,
}

/// 地址和模型的列表。Key 不在这里。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiStore {
    pub active_id: Option<String>,
    pub profiles: Vec<AiProfile>,
    pub legacy_credential_migrated: bool,
}

impl Default for AiStore {
    fn default() -> Self {
        Self {
            active_id: None,
            profiles: Vec::new(),
            legacy_credential_migrated: true,
        }
    }
}

impl AiStore {
    pub fn active(&self) -> Option<&AiProfile> {
        self.active_id
            .as_deref()
            .and_then(|id| self.profiles.iter().find(|profile| profile.id == id))
    }
}

#[derive(Debug, Clone)]
pub struct SaveProfile {
    pub id: Option<String>,
    pub name: String,
    pub api_url: String,
    pub model: String,
    /// `None` 或空白：编辑时保留这一份自己的 Key；新建时表示没填。
    pub key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveBinding {
    pub api_url: String,
    pub model: String,
    pub key: Option<String>,
}

pub fn path_for(data_root: &Path) -> PathBuf {
    data_root.join(FILE_NAME)
}

/// 只读文件。不碰凭据库，也不会把旧格式写回。
/// 文件不在或坏了就当成还没有配置——这里没有必须抢救的正文。
pub fn load_store(data_root: &Path) -> AiStore {
    let Ok(text) = fs::read_to_string(path_for(data_root)) else {
        return AiStore::default();
    };
    parse_store(&text).unwrap_or_default()
}

/// 读设置，并把升级前那条固定凭据挪到对应配置的账户上。
pub fn load_with_credentials(
    data_root: &Path,
    credentials: &dyn CredentialStore,
) -> Result<AiStore, ai_credentials::CredentialError> {
    if !path_for(data_root).is_file() {
        return Ok(AiStore::default());
    }
    let Some(mut store) = fs::read_to_string(path_for(data_root))
        .ok()
        .and_then(|text| parse_store(&text))
    else {
        return Ok(AiStore::default());
    };
    if store.legacy_credential_migrated {
        return Ok(store);
    }
    migrate_legacy_account(&store, credentials)?;
    store.legacy_credential_migrated = true;
    write_store(data_root, &store).map_err(ai_credentials::CredentialError::Unavailable)?;
    Ok(store)
}

/// 地址里夹带凭据就不保存。
///
/// 文档写着「Key 只在 Authorization 头里，`ai-settings.json` 不含 Key」。用户把 key 贴进
/// 地址（`https://user:pass@host/…` 或 `?api-key=…`）就会把这句话变成假话：它会落进设置
/// 文件、随每次请求出现在 URL 里、也更容易被中转站的访问日志记下来。界面上的提醒挡不住
/// 直接改文件或粘贴，所以这一层必须拦。
pub fn credential_in_url(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let authority = rest.split('/').next().unwrap_or("");
    if authority.contains('@') {
        return Some("接口地址里带了用户名或密码。Key 请填在「API Key」里，别放进地址。".into());
    }
    // 查询串会随每次请求发出去；fragment 不会上线，但它照样落进 `ai-settings.json`、
    // 跟着截图和粘贴到处走，而用户多半以为自己在正确地配 Key。两个都拦。
    let query = url.split_once('?').map(|(_, rest)| rest).unwrap_or("");
    let fragment = url.split_once('#').map(|(_, rest)| rest).unwrap_or("");
    let hit = query
        .split(['&', ';'])
        .chain(fragment.split(['&', ';']))
        .find_map(|pair| {
        let name = pair.split('=').next().unwrap_or("").to_ascii_lowercase();
        // 按分段比，不按子串比：`api-key` / `api_key` / `x-token` 要拦住,
        // `monkey` / `keynote` / `api-version` 不能误伤。
            let segments = name.split(|c: char| !c.is_ascii_alphanumeric());
            segments
                .into_iter()
                .any(|segment| {
                    matches!(
                        segment,
                        "key" | "apikey" | "token" | "secret" | "password" | "auth" | "credential"
                            | "sig" | "sign" | "signature"
                    )
                })
                .then_some(name)
        });
    if let Some(name) = hit {
        return Some(format!(
            "接口地址里的 `{name}` 看着像一把 Key。Key 请填在「API Key」里，别放进地址。"
        ));
    }
    None
}

/// 保存并使用。新建时必须自带 Key，不会复制其他配置的 Key。
/// 编辑时 Key 留空表示保留这一份原来的 Key；这一份还没有 Key 就不启用、也不改文件。
pub fn save_and_use(
    data_root: &Path,
    credentials: &dyn CredentialStore,
    input: SaveProfile,
) -> Result<AiStore, String> {
    if let Some(problem) = credential_in_url(&input.api_url) {
        return Err(problem);
    }
    let typed_url = input.api_url.trim();
    let model = input.model.trim();
    if typed_url.is_empty() || model.is_empty() {
        return Err("请把接口地址和模型名称都填完。未完成的配置不会启用。".into());
    }
    let typed_key = input.key.unwrap_or_default();
    let typed_key = typed_key.trim();
    let mut store = load_with_credentials(data_root, credentials).map_err(|err| err.message())?;

    if let Some(id) = input.id.as_deref().filter(|id| !id.is_empty()) {
        let Some(index) = store.profiles.iter().position(|profile| profile.id == id) else {
            return Err("要编辑的配置已经不在了，没有保存。".into());
        };
        let account = ai_credentials::profile_account(id);
        if !typed_key.is_empty() {
            credentials
                .set_key(&account, typed_key)
                .map_err(|err| err.message())?;
        }
        let has_key = credentials
            .get_key(&account)
            .map_err(|err| err.message())?
            .is_some();
        if !has_key {
            return Err("这份配置还没有 Key，没有启用，也没有改动已保存的配置。".into());
        }
        let previous_url = store.profiles[index].api_url.clone();
        let api_url = if typed_url == previous_url {
            previous_url
        } else {
            normalize_api_url(typed_url, &previous_url)
        };
        let name = chosen_name(&input.name, &api_url, &store, Some(id));
        store.profiles[index].name = name;
        store.profiles[index].api_url = api_url;
        store.profiles[index].model = model.to_string();
        store.active_id = Some(id.to_string());
    } else {
        if typed_key.is_empty() {
            return Err("新建配置要填写 API Key。未完成的配置不会启用，也不会复用其他配置的 Key。".into());
        }
        let id = Uuid::new_v4().to_string();
        let api_url = normalize_api_url(typed_url, DEFAULT_API_URL);
        credentials
            .set_key(&ai_credentials::profile_account(&id), typed_key)
            .map_err(|err| err.message())?;
        let name = chosen_name(&input.name, &api_url, &store, None);
        store.profiles.push(AiProfile {
            id: id.clone(),
            name,
            api_url,
            model: model.to_string(),
        });
        store.active_id = Some(id);
    }

    store.legacy_credential_migrated = true;
    write_store(data_root, &store)?;
    Ok(store)
}

pub fn rename_profile(
    data_root: &Path,
    credentials: &dyn CredentialStore,
    id: &str,
    name: &str,
) -> Result<AiStore, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("配置名称不能为空。".into());
    }
    let mut store = load_with_credentials(data_root, credentials).map_err(|err| err.message())?;
    let Some(profile) = store.profiles.iter_mut().find(|profile| profile.id == id) else {
        return Err("要改名的配置已经不在了。".into());
    };
    profile.name = name.chars().take(80).collect();
    write_store(data_root, &store)?;
    Ok(store)
}

pub fn activate_profile(
    data_root: &Path,
    credentials: &dyn CredentialStore,
    id: &str,
) -> Result<AiStore, String> {
    let mut store = load_with_credentials(data_root, credentials).map_err(|err| err.message())?;
    if !store.profiles.iter().any(|profile| profile.id == id) {
        return Err("要使用的配置已经不在了。".into());
    }
    store.active_id = Some(id.to_string());
    write_store(data_root, &store)?;
    Ok(store)
}

/// `next_id`：删的是当前配置时必填。`Some("")` 表示进入未配置，`None` 则拒绝删除。
pub fn delete_profile(
    data_root: &Path,
    credentials: &dyn CredentialStore,
    id: &str,
    next_id: Option<&str>,
) -> Result<AiStore, String> {
    let mut store = load_with_credentials(data_root, credentials).map_err(|err| err.message())?;
    if !store.profiles.iter().any(|profile| profile.id == id) {
        return Err("这份配置已经不在了。".into());
    }
    let is_active = store.active_id.as_deref() == Some(id);
    if is_active {
        match next_id {
            None => {
                return Err("删除当前配置时要选择另一份，或明确进入未配置状态。".into());
            }
            Some(next) if next == id => {
                return Err("不能改用正在删除的这一份。".into());
            }
            Some(next) if !next.is_empty() && !store.profiles.iter().any(|profile| profile.id == next) => {
                return Err("要改用的配置不存在，当前配置没有删除。".into());
            }
            Some(_) => {}
        }
    }

    store.profiles.retain(|profile| profile.id != id);
    if is_active {
        let next = next_id.unwrap_or("");
        store.active_id = if next.is_empty() {
            None
        } else {
            Some(next.to_string())
        };
    } else if store.active_id.as_deref() == Some(id) {
        store.active_id = None;
    }
    write_store(data_root, &store)?;
    credentials
        .clear_key(&ai_credentials::profile_account(id))
        .map_err(|err| err.message())?;
    Ok(store)
}

pub fn clear_profile_key(
    data_root: &Path,
    credentials: &dyn CredentialStore,
    id: &str,
) -> Result<AiStore, String> {
    let store = load_with_credentials(data_root, credentials).map_err(|err| err.message())?;
    if !store.profiles.iter().any(|profile| profile.id == id) {
        return Err("这份配置已经不在了。".into());
    }
    credentials
        .clear_key(&ai_credentials::profile_account(id))
        .map_err(|err| err.message())?;
    Ok(store)
}

/// 发请求时只用当前配置自己的 Key。没有当前配置，或这一份没有 Key，就返回 `None` 的 key，
/// 不会去读其他配置或升级前的那条固定凭据。
pub fn active_binding(
    store: &AiStore,
    credentials: &dyn CredentialStore,
) -> Result<Option<ActiveBinding>, ai_credentials::CredentialError> {
    let Some(active) = store.active() else {
        return Ok(None);
    };
    let key = credentials.get_key(&ai_credentials::profile_account(&active.id))?;
    Ok(Some(ActiveBinding {
        api_url: active.api_url.clone(),
        model: active.model.clone(),
        key,
    }))
}

/// 用户填的多半是服务商文档上的 Base URL。规则和插件那边（`ai-models.js`）一致：
/// 已经指向具体端点的原样保留，看着像 base 的补上 `/chat/completions`。
pub fn normalize_api_url(typed: &str, fallback: &str) -> String {
    let value = typed.trim();
    if value.is_empty() {
        return fallback.to_string();
    }
    let (prefix, rest) = match value.find("://") {
        Some(at) => value.split_at(at + 3),
        None => ("", value),
    };
    let (authority_and_path, suffix) = match rest.find(['?', '#']) {
        Some(at) => rest.split_at(at),
        None => (rest, ""),
    };
    let trimmed = authority_and_path.trim_end_matches('/');
    let path_start = trimmed.find('/').unwrap_or(trimmed.len());
    let (authority, path) = trimmed.split_at(path_start);
    let lower = path.to_ascii_lowercase();

    if lower.ends_with("/chat/completions") || lower.ends_with("/messages") {
        return value.to_string();
    }
    let last = path.rsplit('/').next().unwrap_or("");
    let looks_like_base = path.is_empty() || is_version_segment(last) || last.eq_ignore_ascii_case("openai");
    if !looks_like_base {
        return value.to_string();
    }
    let base = if path.is_empty() { "/v1" } else { path };
    format!("{prefix}{authority}{base}/chat/completions{suffix}")
}

fn is_version_segment(segment: &str) -> bool {
    let mut chars = segment.chars();
    match chars.next() {
        Some('v') | Some('V') => {}
        _ => return false,
    }
    let rest: String = chars.collect();
    !rest.is_empty() && rest.chars().next().is_some_and(|c| c.is_ascii_digit())
}

/// 预览和日志里只出现主机名，不出现完整地址（data-privacy §9）。
pub fn host_of(api_url: &str) -> String {
    let rest = api_url.split("://").nth(1).unwrap_or(api_url);
    let authority = rest.split('/').next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    if host.is_empty() {
        "（接口地址无法解析）".to_string()
    } else {
        host.to_ascii_lowercase()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyFile {
    api_url: String,
    model: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiFile {
    version: u32,
    active_id: Option<String>,
    profiles: Vec<AiProfile>,
    #[serde(default)]
    legacy_credential_migrated: bool,
}

fn parse_store(text: &str) -> Option<AiStore> {
    if let Ok(file) = serde_json::from_str::<AiFile>(text) {
        if file.version >= FILE_VERSION {
            let active_id = file
                .active_id
                .filter(|id| file.profiles.iter().any(|profile| profile.id == *id));
            return Some(AiStore {
                active_id,
                profiles: file.profiles,
                legacy_credential_migrated: file.legacy_credential_migrated,
            });
        }
    }
    let legacy: LegacyFile = serde_json::from_str(text).ok()?;
    Some(legacy_store(legacy))
}

fn legacy_store(legacy: LegacyFile) -> AiStore {
    let api_url = nonempty(&legacy.api_url, DEFAULT_API_URL);
    let model = nonempty(&legacy.model, DEFAULT_MODEL);
    AiStore {
        active_id: Some(LEGACY_PROFILE_ID.to_string()),
        profiles: vec![AiProfile {
            id: LEGACY_PROFILE_ID.to_string(),
            name: default_name(&api_url, &[]),
            api_url,
            model,
        }],
        legacy_credential_migrated: false,
    }
}

fn migrate_legacy_account(
    store: &AiStore,
    credentials: &dyn CredentialStore,
) -> Result<(), ai_credentials::CredentialError> {
    let Some(legacy_key) = credentials.get_key(ai_credentials::LEGACY_ACCOUNT)? else {
        return Ok(());
    };
    let target = if store.profiles.len() == 1 {
        Some(store.profiles[0].id.clone())
    } else {
        store
            .profiles
            .iter()
            .find(|profile| profile.id == LEGACY_PROFILE_ID)
            .map(|profile| profile.id.clone())
    };
    let Some(id) = target else {
        // 已经有多份配置，又对不上升级来的那一条：不要把旧 Key 安到其中任何一份上。
        return Ok(());
    };
    let account = ai_credentials::profile_account(&id);
    if credentials.get_key(&account)?.is_none() {
        credentials.set_key(&account, &legacy_key)?;
    }
    credentials.clear_key(ai_credentials::LEGACY_ACCOUNT)
}

fn write_store(data_root: &Path, store: &AiStore) -> Result<(), String> {
    let file = AiFile {
        version: FILE_VERSION,
        active_id: store.active_id.clone(),
        profiles: store.profiles.clone(),
        legacy_credential_migrated: store.legacy_credential_migrated,
    };
    let target = path_for(data_root);
    let tmp = target.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&file).map_err(|err| err.to_string())?;
    fs::write(&tmp, json).map_err(|err| format!("写 {} 失败：{err}", tmp.display()))?;
    fs::rename(&tmp, &target).map_err(|err| format!("保存 {} 失败：{err}", target.display()))?;
    Ok(())
}

fn nonempty(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn default_name(api_url: &str, taken: &[&str]) -> String {
    let host = host_of(api_url);
    let base = if host.starts_with('（') { "配置".to_string() } else { host };
    if !taken.contains(&base.as_str()) {
        return base;
    }
    let mut index = 2;
    loop {
        let candidate = format!("{base} ({index})");
        if !taken.iter().any(|name| *name == candidate) {
            return candidate;
        }
        index += 1;
    }
}

fn chosen_name(typed: &str, api_url: &str, store: &AiStore, ignore_id: Option<&str>) -> String {
    let typed = typed.trim();
    if !typed.is_empty() {
        return typed.chars().take(80).collect();
    }
    let taken: Vec<&str> = store
        .profiles
        .iter()
        .filter(|profile| Some(profile.id.as_str()) != ignore_id)
        .map(|profile| profile.name.as_str())
        .collect();
    default_name(api_url, &taken)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_base_url_grows_the_endpoint_and_a_full_one_is_left_alone() {
        let cases = [
            ("https://api.deepseek.com", "https://api.deepseek.com/v1/chat/completions"),
            ("https://api.deepseek.com/", "https://api.deepseek.com/v1/chat/completions"),
            ("https://api.deepseek.com/v1", "https://api.deepseek.com/v1/chat/completions"),
            ("https://api.deepseek.com/v1/", "https://api.deepseek.com/v1/chat/completions"),
            (
                "https://open.bigmodel.cn/api/paas/v4",
                "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            ),
            (
                "https://generativelanguage.googleapis.com/v1beta/openai",
                "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            ),
            (
                "https://api.openai.com/v1/chat/completions",
                "https://api.openai.com/v1/chat/completions",
            ),
            (
                "https://relay.example/v1/chat/completions?api-version=2024-10-21",
                "https://relay.example/v1/chat/completions?api-version=2024-10-21",
            ),
            ("http://127.0.0.1:8000", "http://127.0.0.1:8000/v1/chat/completions"),
        ];
        for (typed, expected) in cases {
            assert_eq!(normalize_api_url(typed, DEFAULT_API_URL), expected, "{typed}");
        }
    }

    #[test]
    fn an_empty_address_keeps_whatever_was_there_before() {
        assert_eq!(normalize_api_url("   ", "https://kept.example/v1/chat/completions"),
            "https://kept.example/v1/chat/completions");
    }

    #[test]
    fn an_unrecognised_path_is_not_rewritten() {
        // 中转站有各种自定义路径，猜着改只会把能用的地址改坏。
        assert_eq!(
            normalize_api_url("https://relay.example/proxy/openai-compatible", DEFAULT_API_URL),
            "https://relay.example/proxy/openai-compatible"
        );
    }

    #[test]
    fn the_host_never_carries_credentials() {
        assert_eq!(host_of("https://user:pass@API.Example.test/v1/chat/completions"), "api.example.test");
    }

    fn memory() -> crate::ai_credentials::MemoryStore {
        crate::ai_credentials::MemoryStore::default()
    }

    fn save_new(dir: &std::path::Path, url: &str, model: &str, key: &str) -> AiStore {
        let creds = memory();
        save_and_use(
            dir,
            &creds,
            SaveProfile {
                id: None,
                name: String::new(),
                api_url: url.to_string(),
                model: model.to_string(),
                key: Some(key.to_string()),
            },
        )
        .unwrap()
    }

    #[test]
    fn settings_round_trip_and_a_broken_file_is_unconfigured() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_store(dir.path()).profiles.is_empty());
        assert!(load_store(dir.path()).active().is_none());

        let creds = memory();
        let saved = save_and_use(
            dir.path(),
            &creds,
            SaveProfile {
                id: None,
                name: String::new(),
                api_url: "https://api.deepseek.com".into(),
                model: "deepseek-chat".into(),
                key: Some("sk-synthetic".into()),
            },
        )
        .unwrap();
        assert_eq!(
            saved.active().unwrap().api_url,
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(load_with_credentials(dir.path(), &creds).unwrap(), saved);

        std::fs::write(path_for(dir.path()), "{ 坏掉的").unwrap();
        assert_eq!(load_store(dir.path()), AiStore::default());
    }

    #[test]
    fn an_address_that_carries_a_credential_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for bad in [
            "https://someone:sk-123@relay.example/v1/chat/completions",
            "https://relay.example/v1/chat/completions?api-key=sk-123",
            "https://relay.example/v1/chat/completions?token=abc",
        ] {
            let err = save_and_use(
                dir.path(),
                &memory(),
                SaveProfile {
                    id: None,
                    name: String::new(),
                    api_url: bad.into(),
                    model: "m".into(),
                    key: Some("sk-synthetic".into()),
                },
            )
            .unwrap_err();
            assert!(err.contains("API Key"), "{bad}: {err}");
        }
        // fragment 里的也算。
        assert!(credential_in_url("https://relay.example/v1/chat/completions#api-key=sk-1").is_some());
        // 正常参数不该被误伤：按分段比，不按子串比。
        for fine in [
            "https://relay.example/v1/chat/completions?api-version=2024-10-21",
            "https://relay.example/v1/chat/completions?monkey=1",
            "https://relay.example/v1/chat/completions?keynote=x",
        ] {
            assert!(credential_in_url(fine).is_none(), "{fine}");
        }
        assert!(save_and_use(
            dir.path(),
            &memory(),
            SaveProfile {
                id: None,
                name: String::new(),
                api_url: "https://relay.example/v1/chat/completions?api-version=2024-10-21".into(),
                model: "m".into(),
                key: Some("sk-synthetic".into()),
            },
        )
        .is_ok());
        // 报错里带上命中的那个参数名，用户才知道该删哪个。
        let named = credential_in_url("https://relay.example/v1?x-token=abc").unwrap();
        assert!(named.contains("x-token"), "{named}");
        let text = std::fs::read_to_string(path_for(dir.path())).unwrap();
        assert!(!text.contains("sk-123"), "被拒的地址还是写进了文件：{text}");
    }

    #[test]
    fn the_settings_file_never_contains_a_key() {
        let dir = tempfile::tempdir().unwrap();
        let _ = save_new(dir.path(), "https://api.deepseek.com/v1", "deepseek-chat", "sk-synthetic");
        let text = std::fs::read_to_string(path_for(dir.path())).unwrap();
        for forbidden in ["key", "Key", "token", "secret", "sk-synthetic"] {
            assert!(!text.contains(forbidden), "设置文件里出现了 {forbidden}：{text}");
        }
    }

    #[test]
    fn a_legacy_file_and_its_single_credential_become_one_profile() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            path_for(dir.path()),
            r#"{"apiUrl":"https://api.deepseek.com/v1/chat/completions","model":"deepseek-chat"}"#,
        )
        .unwrap();
        let creds = memory();
        creds
            .set_key(crate::ai_credentials::LEGACY_ACCOUNT, "sk-legacy")
            .unwrap();

        let store = load_with_credentials(dir.path(), &creds).unwrap();
        let active = store.active().unwrap();
        assert_eq!(active.api_url, "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(active.model, "deepseek-chat");
        assert_eq!(
            creds
                .get_key(&crate::ai_credentials::profile_account(&active.id))
                .unwrap()
                .as_deref(),
            Some("sk-legacy")
        );
        assert_eq!(creds.get_key(crate::ai_credentials::LEGACY_ACCOUNT).unwrap(), None);
        let binding = active_binding(&store, &creds).unwrap().unwrap();
        assert_eq!(binding.key.as_deref(), Some("sk-legacy"));
        assert_eq!(binding.api_url, active.api_url);
    }

    #[test]
    fn switching_profiles_reads_only_that_profiles_key() {
        let dir = tempfile::tempdir().unwrap();
        let creds = memory();
        let first = save_and_use(
            dir.path(),
            &creds,
            SaveProfile {
                id: None,
                name: "A".into(),
                api_url: "https://a.example/v1".into(),
                model: "model-a".into(),
                key: Some("sk-a".into()),
            },
        )
        .unwrap();
        let id_a = first.active_id.clone().unwrap();
        let second = save_and_use(
            dir.path(),
            &creds,
            SaveProfile {
                id: None,
                name: "B".into(),
                api_url: "https://b.example/v1".into(),
                model: "model-b".into(),
                key: Some("sk-b".into()),
            },
        )
        .unwrap();
        assert_eq!(second.profiles.len(), 2);
        let binding = active_binding(&second, &creds).unwrap().unwrap();
        assert_eq!(binding.api_url, "https://b.example/v1/chat/completions");
        assert_eq!(binding.key.as_deref(), Some("sk-b"));

        let switched = activate_profile(dir.path(), &creds, &id_a).unwrap();
        let binding = active_binding(&switched, &creds).unwrap().unwrap();
        assert_eq!(binding.api_url, "https://a.example/v1/chat/completions");
        assert_eq!(binding.key.as_deref(), Some("sk-a"));
        assert_eq!(
            creds
                .get_key(&crate::ai_credentials::profile_account(
                    second.active_id.as_deref().unwrap()
                ))
                .unwrap()
                .as_deref(),
            Some("sk-b")
        );
    }

    #[test]
    fn editing_one_profile_does_not_change_the_other_and_a_new_one_does_not_reuse_its_key() {
        let dir = tempfile::tempdir().unwrap();
        let creds = memory();
        let first = save_and_use(
            dir.path(),
            &creds,
            SaveProfile {
                id: None,
                name: "A".into(),
                api_url: "https://a.example/v1".into(),
                model: "model-a".into(),
                key: Some("sk-a".into()),
            },
        )
        .unwrap();
        let id_a = first.active_id.unwrap();
        save_and_use(
            dir.path(),
            &creds,
            SaveProfile {
                id: None,
                name: "B".into(),
                api_url: "https://b.example/v1".into(),
                model: "model-b".into(),
                key: Some("sk-b".into()),
            },
        )
        .unwrap();

        let edited = save_and_use(
            dir.path(),
            &creds,
            SaveProfile {
                id: Some(id_a.clone()),
                name: "A2".into(),
                api_url: "https://a.example/v1/chat/completions".into(),
                model: "model-a2".into(),
                key: None,
            },
        )
        .unwrap();
        let profile_a = edited.profiles.iter().find(|profile| profile.id == id_a).unwrap();
        let profile_b = edited.profiles.iter().find(|profile| profile.name == "B").unwrap();
        assert_eq!(profile_a.model, "model-a2");
        assert_eq!(
            creds
                .get_key(&crate::ai_credentials::profile_account(&profile_a.id))
                .unwrap()
                .as_deref(),
            Some("sk-a")
        );
        assert_eq!(profile_b.model, "model-b");
        assert_eq!(
            creds
                .get_key(&crate::ai_credentials::profile_account(&profile_b.id))
                .unwrap()
                .as_deref(),
            Some("sk-b")
        );

        let err = save_and_use(
            dir.path(),
            &creds,
            SaveProfile {
                id: None,
                name: "C".into(),
                api_url: "https://c.example/v1".into(),
                model: "model-c".into(),
                key: None,
            },
        )
        .unwrap_err();
        assert!(err.contains("Key"), "{err}");
        let still = load_with_credentials(dir.path(), &creds).unwrap();
        assert_eq!(still.profiles.len(), 2);
        assert!(still.profiles.iter().all(|profile| profile.name != "C"));
    }

    #[test]
    fn deleting_the_active_profile_requires_an_explicit_next_choice() {
        let dir = tempfile::tempdir().unwrap();
        let creds = memory();
        let first = save_and_use(
            dir.path(),
            &creds,
            SaveProfile {
                id: None,
                name: "A".into(),
                api_url: "https://a.example/v1".into(),
                model: "model-a".into(),
                key: Some("sk-a".into()),
            },
        )
        .unwrap();
        let id_a = first.active_id.unwrap();
        let second = save_and_use(
            dir.path(),
            &creds,
            SaveProfile {
                id: None,
                name: "B".into(),
                api_url: "https://b.example/v1".into(),
                model: "model-b".into(),
                key: Some("sk-b".into()),
            },
        )
        .unwrap();
        let id_b = second.active_id.clone().unwrap();

        let err = delete_profile(dir.path(), &creds, &id_b, None).unwrap_err();
        assert!(err.contains("选择"), "{err}");
        let unchanged = load_with_credentials(dir.path(), &creds).unwrap();
        assert_eq!(unchanged.active_id.as_deref(), Some(id_b.as_str()));
        assert_eq!(
            active_binding(&unchanged, &creds).unwrap().unwrap().key.as_deref(),
            Some("sk-b")
        );

        let cleared = delete_profile(dir.path(), &creds, &id_b, Some("")).unwrap();
        assert!(cleared.active().is_none());
        assert!(active_binding(&cleared, &creds).unwrap().is_none());
        assert_eq!(
            creds
                .get_key(&crate::ai_credentials::profile_account(&id_a))
                .unwrap()
                .as_deref(),
            Some("sk-a")
        );
        assert_eq!(
            creds
                .get_key(&crate::ai_credentials::profile_account(&id_b))
                .unwrap(),
            None
        );

        let again = save_and_use(
            dir.path(),
            &creds,
            SaveProfile {
                id: None,
                name: "B".into(),
                api_url: "https://b.example/v1".into(),
                model: "model-b".into(),
                key: Some("sk-b2".into()),
            },
        )
        .unwrap();
        let id_b2 = again.active_id.clone().unwrap();
        let switched = delete_profile(dir.path(), &creds, &id_b2, Some(&id_a)).unwrap();
        let binding = active_binding(&switched, &creds).unwrap().unwrap();
        assert_eq!(binding.key.as_deref(), Some("sk-a"));
        assert_eq!(binding.api_url, "https://a.example/v1/chat/completions");
    }

    #[test]
    fn an_incomplete_edit_does_not_replace_the_active_profile() {
        let dir = tempfile::tempdir().unwrap();
        let creds = memory();
        let saved = save_and_use(
            dir.path(),
            &creds,
            SaveProfile {
                id: None,
                name: "A".into(),
                api_url: "https://a.example/v1".into(),
                model: "model-a".into(),
                key: Some("sk-a".into()),
            },
        )
        .unwrap();
        let id = saved.active_id.unwrap();
        clear_profile_key(dir.path(), &creds, &id).unwrap();
        let err = save_and_use(
            dir.path(),
            &creds,
            SaveProfile {
                id: Some(id.clone()),
                name: "A".into(),
                api_url: "https://changed.example/v1".into(),
                model: "other".into(),
                key: None,
            },
        )
        .unwrap_err();
        assert!(err.contains("没有启用"), "{err}");
        let store = load_with_credentials(dir.path(), &creds).unwrap();
        assert_eq!(store.active().unwrap().api_url, "https://a.example/v1/chat/completions");
        assert_eq!(store.active().unwrap().model, "model-a");
    }
}
