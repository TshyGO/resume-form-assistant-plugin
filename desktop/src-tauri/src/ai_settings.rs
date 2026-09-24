//! 桌面这一侧的 AI 服务商列表。Key 按服务商另存系统凭据库。
//!
//! **Key 不在这里。** 它进 OS 凭据库（见 [`crate::ai_credentials`]），不进这个文件，
//! 也不进备份（data-privacy §1）。
//!
//! 单独一个 `ai-settings.json`，不跟配对草稿挤在 `settings.json` 里：那个文件是整份
//! 覆盖写的（`data-service::host::save_pairing_draft`），往里加东西会被下一次保存配对冲掉。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_API_URL: &str = "https://api.openai.com/v1/chat/completions";
const FILE_NAME: &str = "ai-settings.json";
/// 从旧的单配置文件迁移来的那一条服务商的 id。旧 Key 也搬到这个 id 名下（见 `ai_credentials`）。
pub const LEGACY_PROVIDER_ID: &str = "default";
pub const MAX_PROVIDERS: usize = 20;
pub const MAX_PROVIDER_NAME_CHARS: usize = 40;
/// v0.4.0 及以前写死的默认模型。旧的单配置文件里 `model` 是空/空白（用户从没改过、或者是
/// 手动清空过的坏文件）时，落回这个值，跟 `ensure_legacy_default` 补出来的默认服务商口径
/// 一致（评审）。
pub const LEGACY_DEFAULT_MODEL: &str = "gpt-4o-mini";

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

#[derive(Debug)]
pub struct SaveOutcome {
    #[allow(dead_code)] // Task 1 的完整存储结果供调用方和测试检查；运行时暂只取 id/主机变更。
    pub settings: AiSettings,
    pub provider_id: String,
    /// 编辑已有服务商时来源（协议 + 主机 + 端口，见 [`same_origin`]）变了。调用方据此清掉
    /// 它的 Key：Key 只发给填写它时对应的那个来源。字段名沿用 `host_changed`，语义已经是
    /// 「来源变了」，不只是主机名（#158 评审）。
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
        // 手改过的文件可能塞进奇怪的 id：keychain 账户是拿 id 拼的（`account_for`），
        // 带 `/`、空格之类字符的 id 会拼出一个不对应任何真实凭据条目的账户名，
        // 界面上「已配置 Key」的判断也会跟着乱掉。不合规的 id 直接整条服务商丢弃
        // （评审）。
        settings.providers.retain(|p| is_valid_provider_id(&p.id));
        let known = |id: &String| settings.providers.iter().any(|p| &p.id == id);
        if !settings.active_provider_id.as_ref().is_some_and(known) {
            settings.active_provider_id = settings.providers.first().map(|p| p.id.clone());
        }
        return settings;
    }
    match serde_json::from_str::<LegacySettings>(&text) {
        Ok(legacy) => {
            let api_url = if legacy.api_url.trim().is_empty() { DEFAULT_API_URL.to_string() } else { legacy.api_url };
            let model = legacy.model.trim().to_string();
            let model = if model.is_empty() { LEGACY_DEFAULT_MODEL.to_string() } else { model };
            AiSettings {
                providers: vec![AiProvider {
                    id: LEGACY_PROVIDER_ID.into(),
                    name: "默认".into(),
                    api_url,
                    model,
                }],
                active_provider_id: Some(LEGACY_PROVIDER_ID.into()),
            }
        }
        Err(_) => AiSettings::default(),
    }
}

/// keychain 账户名（`account_for`）直接拼接 id，只放心得住的字符：字母、数字、连字符，
/// 1–64 个。
fn is_valid_provider_id(id: &str) -> bool {
    let len = id.chars().count();
    (1..=64).contains(&len) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// v0.4.0 及更早版本没有服务商列表——一个写死的地址（`DEFAULT_API_URL`）、一个写死的模型
/// （`gpt-4o-mini`），Key 单独有个保存按钮，不跟着 `ai-settings.json` 走。升级后如果这份
/// 文件根本不存在，`load` 只会给一个空的 `AiSettings`（跟「从来没配置过」区分不开），这把
/// 旧 Key 就再没有服务商能接住：它既不在 `LEGACY_PROVIDER_ID` 名下（那是单配置文件被读成
/// 一条服务商时才有的 id），也没有别的服务商，永远用不上、界面上也看不见、没法清理
/// （#158 评审）。
///
/// 调用方（`ai_provider_commands::migrate`）在检测到「没有服务商 + 旧 Key 还在」时调这个
/// 函数，把这条默认服务商建出来、设成当前，再照常把 Key 搬过去。已经有服务商（不管是不是
/// 这个 id）就什么也不做，返回 `Ok(())`。写文件失败时把原因带出去，调用方据此报
/// `AI_SETTINGS_WRITE_FAILED`，不能悄悄吞掉——不然「没有服务商 + 旧 Key 还在」这个判断会在
/// 下一次调用时重新触发，看着像是每次都在正常工作（评审）。
pub fn ensure_legacy_default(data_root: &Path) -> Result<(), String> {
    let mut settings = load(data_root);
    if !settings.providers.is_empty() {
        return Ok(());
    }
    settings.providers.push(AiProvider {
        id: LEGACY_PROVIDER_ID.into(),
        name: "默认".into(),
        api_url: DEFAULT_API_URL.into(),
        model: LEGACY_DEFAULT_MODEL.into(),
    });
    settings.active_provider_id = Some(LEGACY_PROVIDER_ID.into());
    write(data_root, &settings)
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

/// 校验一条服务商输入：名称、地址、模型、地址里不能夹带凭据，编辑时 id 得真存在。
///
/// 调用方（`ai_provider_commands::save_provider`）必须在算「来源是不是变了」、清旧 Key
/// 之前先调这个函数——不然一次校验没过的保存（比如模型名填空了）会先把 Key 清掉、
/// 设置却没改，用户就白白丢了 Key（见 PR #158 评审）。这里保存前也照样调一遍，
/// 防止以后有别的调用方跳过 `ai_provider_commands` 直接调 `save_provider`。
pub fn validate(data_root: &Path, input: &ProviderInput) -> Result<(), String> {
    validate_fields(input)?;
    if let Some(id) = &input.id {
        let settings = load(data_root);
        if !settings.providers.iter().any(|p| &p.id == id) {
            return Err(GONE.into());
        }
    }
    Ok(())
}

/// Whether a legacy import's AI config could become a provider at all, judged from the
/// config alone (no settings file, no key). Used when the part arrives; the provider limit
/// and the existing-provider check wait until the user confirms.
pub fn check_import_config(api_url: &str, model: &str) -> Result<(), String> {
    validate_fields(&ProviderInput {
        id: None,
        name: "插件导入".into(),
        api_url: api_url.into(),
        model: model.into(),
    })
}

fn validate_fields(input: &ProviderInput) -> Result<(), String> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > MAX_PROVIDER_NAME_CHARS {
        return Err(format!("名称不能为空，最多 {MAX_PROVIDER_NAME_CHARS} 个字。"));
    }
    if input.api_url.trim().is_empty() {
        return Err("接口地址不能为空。".into());
    }
    if let Some(problem) = credential_in_url(&input.api_url) {
        return Err(problem);
    }
    // 校验的是补全之后的地址：用户多半填的是不带协议的裸主机名（比如直接抄局域网 IP 或者
    // 把 `https://` 手滑删了），normalize_api_url 不会替他们把协议补上，得在这里挡住，
    // 不然会存进去一条 `url::Url` 解析不出来、发请求时才炸的地址。这里传的 fallback 不会
    // 被用到——上面已经确认 `input.api_url` trim 非空。
    let normalized = normalize_api_url(&input.api_url, DEFAULT_API_URL);
    let scheme_ok = url::Url::parse(&normalized)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https"));
    if !scheme_ok {
        return Err("接口地址要以 http:// 或 https:// 开头。".into());
    }
    if input.model.trim().is_empty() {
        return Err("模型名称不能为空，可以点「获取模型」挑一个。".into());
    }
    Ok(())
}

pub fn save_provider(data_root: &Path, input: ProviderInput) -> Result<SaveOutcome, String> {
    validate(data_root, &input)?;
    let name = input.name.trim().to_string();
    let model = input.model.trim().to_string();
    let mut settings = load(data_root);
    let (provider_id, host_changed) = match input.id {
        Some(id) => {
            let existing = settings.providers.iter_mut().find(|p| p.id == id).ok_or_else(|| GONE.to_string())?;
            let api_url = normalize_api_url(&input.api_url, &existing.api_url);
            let host_changed = !same_origin(&api_url, &existing.api_url);
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

/// Create the provider from one confirmed legacy import. The stable id lets a retry
/// finish moving its Key without creating another provider after an interrupted run.
pub fn validate_import_provider(data_root: &Path, import_id: &str, api_url: &str, model: &str) -> Result<(), String> {
    let id = format!("legacy-provider-{import_id}");
    let input = ProviderInput {
        id: None,
        name: format!("插件导入 {}", import_id.chars().take(8).collect::<String>()),
        api_url: api_url.into(),
        model: model.into(),
    };
    validate(data_root, &input)?;
    let settings = load(data_root);
    let normalized = normalize_api_url(api_url, DEFAULT_API_URL);
    if let Some(existing) = settings.providers.iter().find(|provider| provider.id == id) {
        if existing.api_url != normalized || existing.model != model.trim() {
            return Err("同一导入编号对应的 AI 配置已经变化，不能覆盖。".into());
        }
    } else if settings.providers.len() >= MAX_PROVIDERS {
        return Err(format!("服务商最多 {MAX_PROVIDERS} 个，先删掉用不上的。"));
    }
    Ok(())
}

pub fn import_provider(data_root: &Path, import_id: &str, api_url: &str, model: &str) -> Result<String, String> {
    validate_import_provider(data_root, import_id, api_url, model)?;
    let id = format!("legacy-provider-{import_id}");
    let input = ProviderInput {
        id: None,
        name: format!("插件导入 {}", import_id.chars().take(8).collect::<String>()),
        api_url: api_url.into(),
        model: model.into(),
    };
    let mut settings = load(data_root);
    let normalized = normalize_api_url(api_url, DEFAULT_API_URL);
    if let Some(existing) = settings.providers.iter().find(|provider| provider.id == id) {
        if existing.api_url == normalized && existing.model == model.trim() {
            return Ok(id);
        }
        return Err("同一导入编号对应的 AI 配置已经变化，不能覆盖。".into());
    }
    if settings.providers.len() >= MAX_PROVIDERS {
        return Err(format!("服务商最多 {MAX_PROVIDERS} 个，先删掉用不上的。"));
    }
    settings.providers.push(AiProvider {
        id: id.clone(), name: input.name, api_url: normalized, model: model.trim().into(),
    });
    if active(&settings).is_none() { settings.active_provider_id = Some(id.clone()); }
    write(data_root, &settings)?;
    Ok(id)
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

pub(crate) fn is_version_segment(segment: &str) -> bool {
    let rest = match segment.strip_prefix('v').or_else(|| segment.strip_prefix('V')) {
        Some(rest) => rest,
        None => return false,
    };
    let mut chars = rest.chars();
    match chars.next() {
        Some(first) if first.is_ascii_digit() => {}
        _ => return false,
    }
    rest.chars().all(|c| c.is_ascii_alphanumeric())
}

/// 同一来源：协议、主机（大小写不敏感）、端口（省略端口和该协议的默认端口视为一样）都一致。
/// 光比主机名（`host_of`）会漏掉 `https://api.example.com` 编辑成
/// `http://api.example.com` 这种情况——主机没变，可是原来只发给 https 的 Key 会跟着
/// 走上明文连接。「Key 换主机就清」这条规则因此要按完整来源判断，不能只看主机
/// （#158 评审）。解析不出来的地址一律当作不同源：保存过的 Key 不该被含糊的输入继续沿用。
pub fn same_origin(a: &str, b: &str) -> bool {
    let (Ok(a), Ok(b)) = (url::Url::parse(a), url::Url::parse(b)) else {
        return false;
    };
    a.scheme() == b.scheme()
        && a.host_str().map(str::to_ascii_lowercase) == b.host_str().map(str::to_ascii_lowercase)
        && a.port_or_known_default() == b.port_or_known_default()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn importing_one_provider_is_idempotent_and_never_overwrites_a_changed_source() {
        let dir = tempfile::tempdir().unwrap();
        let import_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let id = import_provider(dir.path(), import_id, "https://api.example.com/v1", "m").unwrap();
        assert_eq!(id, format!("legacy-provider-{import_id}"));
        assert_eq!(import_provider(dir.path(), import_id, "https://api.example.com/v1", "m").unwrap(), id);
        assert_eq!(load(dir.path()).providers.len(), 1);
        assert_eq!(load(dir.path()).active_provider_id.as_deref(), Some(id.as_str()));
        assert!(import_provider(dir.path(), import_id, "https://other.example.com/v1", "m").is_err());
        assert_eq!(load(dir.path()).providers.len(), 1);
    }

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
        std::fs::write(path_for(dir.path()), r#"{"apiUrl":"https://api.deepseek.com/v1/chat/completions","model":"deepseek-chat"}"#).unwrap();
        let settings = load(dir.path());
        assert_eq!(settings.providers.len(), 1);
        let p = &settings.providers[0];
        assert_eq!((p.id.as_str(), p.name.as_str()), (LEGACY_PROVIDER_ID, "默认"));
        assert_eq!(p.api_url, "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(p.model, "deepseek-chat");
        assert_eq!(settings.active_provider_id.as_deref(), Some(LEGACY_PROVIDER_ID));
    }

    #[test]
    fn a_legacy_config_with_an_empty_model_falls_back_to_the_old_default() {
        // v0.4.0 写死 gpt-4o-mini；坏文件或者手动清空过 model 的旧配置，读出来不该是空模型名。
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path_for(dir.path()), r#"{"apiUrl":"https://api.deepseek.com/v1/chat/completions","model":"   "}"#).unwrap();
        let settings = load(dir.path());
        assert_eq!(settings.providers[0].model, LEGACY_DEFAULT_MODEL);
        assert_eq!(LEGACY_DEFAULT_MODEL, "gpt-4o-mini");
    }

    #[test]
    fn hand_edited_providers_with_a_bad_id_are_dropped() {
        // keychain 账户名直接拼 id（account_for），带 `/`、空格之类字符的 id 拼不出真实账户，
        // 「已配置 Key」的判断会跟着乱掉。手改文件塞进来的坏 id 整条丢弃，好的留着。
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            path_for(dir.path()),
            r#"{"providers":[
                {"id":"good-id","name":"A","apiUrl":"https://a.example/v1","model":"m"},
                {"id":"has space","name":"B","apiUrl":"https://b.example/v1","model":"m"},
                {"id":"has/slash","name":"C","apiUrl":"https://c.example/v1","model":"m"},
                {"id":"","name":"D","apiUrl":"https://d.example/v1","model":"m"}
            ],"activeProviderId":"has space"}"#,
        )
        .unwrap();
        let settings = load(dir.path());
        assert_eq!(settings.providers.len(), 1);
        assert_eq!(settings.providers[0].id, "good-id");
        // 原来指向的 active id 也没了，落到剩下的第一个。
        assert_eq!(settings.active_provider_id.as_deref(), Some("good-id"));
    }

    #[test]
    fn load_falls_back_to_the_first_provider_when_the_active_one_is_missing() {
        // activeProviderId 指向的服务商被手动改过文件、或者是别的原因不在列表里了：
        // 不该让「当前使用」悬空指向一个不存在的 id，落到第一个还在的服务商上。
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            path_for(dir.path()),
            r#"{"providers":[
                {"id":"a","name":"A","apiUrl":"https://a.example/v1","model":"m"},
                {"id":"b","name":"B","apiUrl":"https://b.example/v1","model":"m"}
            ],"activeProviderId":"gone"}"#,
        )
        .unwrap();
        let settings = load(dir.path());
        assert_eq!(settings.active_provider_id.as_deref(), Some("a"));
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
    fn editing_reports_when_only_the_protocol_changed() {
        // host_of 只比对主机名，https -> http 换协议时不认为变了，旧 Key 会继续被用在明文连接上。
        // host_changed 现在要按完整来源（协议 + 主机 + 端口）判断（见 same_origin，#158 评审）。
        let dir = tempfile::tempdir().unwrap();
        let a = save_provider(dir.path(), input(None, "A", "https://api.deepseek.com", "m")).unwrap();
        let downgraded = save_provider(dir.path(), input(Some(&a.provider_id), "A", "http://api.deepseek.com/v1", "m2")).unwrap();
        assert!(downgraded.host_changed, "协议从 https 换成 http，来源变了，Key 不该继续沿用");
        let explicit_default_port =
            save_provider(dir.path(), input(Some(&a.provider_id), "A", "http://api.deepseek.com:80/v1", "m3")).unwrap();
        assert!(!explicit_default_port.host_changed, "显式写出默认端口和省略端口是同一个来源");
        let same_origin_diff_path =
            save_provider(dir.path(), input(Some(&a.provider_id), "A", "http://api.deepseek.com/v2", "m4")).unwrap();
        assert!(!same_origin_diff_path.host_changed, "只改路径，来源没变，Key 该留着");
    }

    #[test]
    fn same_origin_compares_scheme_host_and_port() {
        assert!(same_origin("https://api.deepseek.com/v1", "https://API.deepseek.com/v2"), "大小写不敏感、路径不参与比较");
        assert!(same_origin("https://api.deepseek.com", "https://api.deepseek.com:443"), "https 默认端口 443");
        assert!(same_origin("http://api.deepseek.com", "http://api.deepseek.com:80"), "http 默认端口 80");
        assert!(!same_origin("https://api.deepseek.com/v1", "http://api.deepseek.com/v1"), "协议不同");
        assert!(!same_origin("https://a.example", "https://b.example"), "主机不同");
        assert!(!same_origin("https://a.example:443", "https://a.example:8443"), "端口不同");
        assert!(!same_origin("not a url", "https://a.example"), "解析不出来就当不同源");
        assert!(!same_origin("https://a.example", "not a url"), "解析不出来就当不同源");
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
            (input(None, "A", "foo", "m"), "http://"),
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
    fn a_hyphenated_version_like_path_is_not_a_base_url() {
        assert!(!is_version_segment("v1-beta"));
        assert!(is_version_segment("v1beta"));
        assert_eq!(
            normalize_api_url("https://relay.example/v1-beta", DEFAULT_API_URL),
            "https://relay.example/v1-beta"
        );
    }

    #[test]
    fn the_host_never_carries_credentials() {
        assert_eq!(host_of("https://user:pass@API.Example.test/v1/chat/completions"), "api.example.test");
    }


    #[test]
    fn an_address_that_carries_a_credential_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for bad in [
            "https://someone:sk-123@relay.example/v1/chat/completions",
            "https://relay.example/v1/chat/completions?api-key=sk-123",
            "https://relay.example/v1/chat/completions?token=abc",
        ] {
            let err = save_provider(dir.path(), input(None, "A", bad, "m")).unwrap_err();
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
        assert!(save_provider(
            dir.path(),
            input(None, "A", "https://relay.example/v1/chat/completions?api-version=2024-10-21", "m")
        )
        .is_ok());
        // 报错里带上命中的那个参数名，用户才知道该删哪个。
        let named = credential_in_url("https://relay.example/v1?x-token=abc").unwrap();
        assert!(named.contains("x-token"), "{named}");
        let text = std::fs::read_to_string(path_for(dir.path())).unwrap();
        assert!(!text.contains("sk-123"), "被拒的地址还是写进了文件：{text}");
    }

    #[test]
    fn ensure_legacy_default_reports_when_the_write_fails() {
        // data_root 指向一个普通文件（不是目录）：`path_for` 拼出来的路径的父级组件
        // 不是目录，写文件会失败。`ensure_legacy_default` 不该把这个原因吞掉。
        let dir = tempfile::tempdir().unwrap();
        let not_a_dir = dir.path().join("this-is-a-file");
        std::fs::write(&not_a_dir, "x").unwrap();
        let err = ensure_legacy_default(&not_a_dir).unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn the_settings_file_never_contains_a_key() {
        let dir = tempfile::tempdir().unwrap();
        save_provider(dir.path(), input(None, "DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat")).unwrap();
        let text = std::fs::read_to_string(path_for(dir.path())).unwrap();
        for forbidden in ["key", "Key", "token", "secret"] {
            assert!(!text.contains(forbidden), "设置文件里出现了 {forbidden}：{text}");
        }
    }
}
