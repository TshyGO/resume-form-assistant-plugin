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
    // Clear an old Key before writing a new host. If the credential store is locked,
    // the settings must still point at the old host so the old Key cannot be sent elsewhere.
    migrate(data_root, creds).map_err(credential_error)?;
    let existing = ai_settings::load(data_root);
    let moving_id = args.id.as_ref().and_then(|id| {
        existing.providers.iter().find(|p| &p.id == id).and_then(|p| {
            let next_url = ai_settings::normalize_api_url(&args.api_url, &p.api_url);
            (ai_settings::host_of(&next_url) != ai_settings::host_of(&p.api_url)).then_some(id)
        })
    });
    let typed = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    let had_key = moving_id.is_some_and(|id| creds.has_key(id));
    if let Some(id) = moving_id {
        creds.clear_key(id).map_err(credential_error)?;
    }
    let outcome = ai_settings::save_provider(
        data_root,
        ProviderInput { id: args.id, name: args.name, api_url: args.api_url, model: args.model },
    )
    .map_err(settings_error)?;
    let key_cleared = outcome.host_changed && had_key && typed.is_none();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_credentials::{MemoryStore, UnavailableStore};

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
    fn failed_key_removal_keeps_the_old_host() {
        let dir = tempfile::tempdir().unwrap();
        let creds = MemoryStore::default();
        let id = save_provider(dir.path(), &creds, args(None, "https://a.example/v1"), Some("sk-a".into())).unwrap().provider_id;
        let unavailable = UnavailableStore("locked".into());
        assert!(save_provider(dir.path(), &unavailable, args(Some(&id), "https://b.example/v1"), None).is_err());
        let settings = crate::ai_settings::load(dir.path());
        assert_eq!(settings.providers[0].api_url, "https://a.example/v1/chat/completions");
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
    fn changing_a_legacy_providers_host_clears_the_migrated_key() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            crate::ai_settings::path_for(dir.path()),
            r#"{"apiUrl":"https://a.example/v1/chat/completions","model":"m"}"#,
        ).unwrap();
        let creds = MemoryStore::with_legacy("sk-old");
        let changed = save_provider(
            dir.path(),
            &creds,
            args(Some(crate::ai_settings::LEGACY_PROVIDER_ID), "https://b.example/v1"),
            None,
        ).unwrap();
        assert!(changed.key_cleared);
        assert!(!creds.has_key(crate::ai_settings::LEGACY_PROVIDER_ID));
        assert_eq!(creds.get_legacy_key().unwrap(), None);
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
