//! #130 PR 2a：设置页的服务商命令。Key 只往凭据库里写、只在发请求时取，
//! **没有任何一条路径把 Key 交回界面**。编辑服务商时协议或主机（来源）变了就清掉它的 Key。

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
    /// 协议或主机变了、旧 Key 被清掉、这次又没填新 Key。界面据此提醒重新填。
    pub key_cleared: bool,
    /// 服务商本身存好了，但填的 Key 没能存进系统凭据库（比如凭据库被策略锁了），或者保存前
    /// 顺带做的旧 Key 迁移（`migrate`）失败了。两种情况整体仍然是 Ok：服务商不该因为这一步
    /// 失败就从设置里消失，调用方也不该误以为整个保存失败了而对着同一次输入重试——那会在
    /// `id` 还是 `None` 的情况下再建一条一模一样的服务商（#158 评审）。界面拿到这个字段就该
    /// 关掉编辑器，用警示语气提醒用户重新填 Key。
    pub key_error: Option<String>,
}

fn credential_error(err: CredentialError) -> CommandError {
    CommandError { code: err.code().into(), message: err.message() }
}

fn settings_error(message: String) -> CommandError {
    CommandError { code: "AI_SETTINGS_INVALID".into(), message }
}

/// 旧版只有一把 Key。迁出来的 `default` 服务商存在时，把旧 Key 搬过去；幂等。
///
/// 只存过 Key、从没有 `ai-settings.json`（v0.4.0 及更早的正常状态）的用户，`load` 会给一份
/// 空的服务商列表，跟「没有服务商」区分不开——这份 Key 就永远等不到 `default` 服务商出现。
/// 一旦看到「没有服务商 + 旧 Key 还在」，先补出这条默认服务商（`ensure_legacy_default`），
/// 再照常搬 Key，用户升级后不会白白丢一把之前存过的 Key（#158 评审）。
///
/// 两类失败都往外报，用 `CommandError` 统一：凭据库打不开照旧是 `credential_error` 那个
/// code；`ensure_legacy_default` 写文件失败是新的 `AI_SETTINGS_WRITE_FAILED`——写不进去不能
/// 悄悄吞掉，不然「没有服务商 + 旧 Key 还在」这个判断会在下一次调用时又触发一遍（评审）。
fn migrate(data_root: &Path, creds: &dyn CredentialStore) -> Result<(), CommandError> {
    let mut settings = ai_settings::load(data_root);
    if settings.providers.is_empty() && creds.get_legacy_key().map_err(credential_error)?.is_some() {
        ai_settings::ensure_legacy_default(data_root).map_err(|message| CommandError {
            code: "AI_SETTINGS_WRITE_FAILED".into(),
            message,
        })?;
        settings = ai_settings::load(data_root);
    }
    if settings.providers.iter().any(|p| p.id == LEGACY_PROVIDER_ID) {
        migrate_legacy_key(creds, LEGACY_PROVIDER_ID).map_err(credential_error)?;
    }
    Ok(())
}

/// 服务商列表 + 每条的 Key 状态，给设置页整页渲染用。**不是纯读**：第一次遇到「有旧 Key
/// 没有服务商接」的情况会顺带调 `migrate`（补默认服务商、把旧 Key 搬到它名下）；重复调用
/// 幂等——已经迁移过的话 `migrate` 内部两个判断都不成立，什么都不做。
pub fn settings_view(data_root: &Path, creds: &dyn CredentialStore) -> AiSettingsView {
    let mut credential_error = migrate(data_root, creds).err().map(|e| e.message);
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
    // migrate 失败（凭据库锁了、或者 ensure_legacy_default 写文件失败）不该挡住这次保存：
    // 用户填的是一条新服务商，跟「旧 Key 有没有搬家」没关系，没理由因为迁移这一步失败就让
    // 保存也跟着失败。先记下来，如果后面没有别的错误更值得报，就用它顶上 key_error
    // （评审）。
    let migrate_error = migrate(data_root, creds).err().map(|e| e.message);
    let input = ProviderInput {
        id: args.id.clone(),
        name: args.name.clone(),
        api_url: args.api_url.clone(),
        model: args.model.clone(),
    };
    // 先校验，再算「来源是不是变了」、再清旧 Key：校验没过就不能有任何副作用，
    // 不然一次因为模型名填空而被拒的保存会先把 Key 清掉，设置却完全没变（#158 评审）。
    ai_settings::validate(data_root, &input).map_err(settings_error)?;
    // Clear an old Key before writing a new origin (scheme + host + port). If the credential
    // store is locked, the settings must still point at the old origin so the old Key cannot
    // be sent elsewhere.
    let existing = ai_settings::load(data_root);
    let moving_id = args.id.as_ref().and_then(|id| {
        existing.providers.iter().find(|p| &p.id == id).and_then(|p| {
            let next_url = ai_settings::normalize_api_url(&args.api_url, &p.api_url);
            (!ai_settings::same_origin(&next_url, &p.api_url)).then_some(id)
        })
    });
    let typed = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    let had_key = moving_id.is_some_and(|id| creds.has_key(id));
    if let Some(id) = moving_id {
        creds.clear_key(id).map_err(credential_error)?;
    }
    let outcome = ai_settings::save_provider(data_root, input).map_err(settings_error)?;
    let key_cleared = outcome.host_changed && had_key && typed.is_none();
    // 服务商这边已经落盘了。Key 存不进凭据库不该把整个保存变成一个 Err：那样调用方拿不到
    // provider_id，容易在界面上以为「什么都没存上」又提交一次同样的输入，
    // 结果建出第二条一模一样的服务商（#158 评审）。改成把失败原因放进 key_error，
    // 整体照样 Ok。
    // Key 存失败比 migrate 失败更直接影响这次保存的结果，优先报它；两者都没有才是 None。
    let key_error = typed
        .and_then(|key| creds.set_key(&outcome.provider_id, &key).err())
        .map(|e| e.message())
        .or(migrate_error);
    Ok(SaveProviderResult { view: settings_view(data_root, creds), provider_id: outcome.provider_id, key_cleared, key_error })
}

pub fn delete_provider(data_root: &Path, creds: &dyn CredentialStore, id: &str) -> Result<AiSettingsView, CommandError> {
    // 先迁移：如果这条要删的服务商正好是旧迁移账户（`default`）、旧 Key 还没搬过来，
    // 先把它搬过去、清空旧账户，再删。不然删完之后设置文件空了、旧账户还留着 Key，
    // 下一次 settings_view 又会看到「没有服务商 + 旧 Key 还在」，把刚删掉的 `default`
    // 服务商重新变出来（评审）。
    migrate(data_root, creds)?;
    // 先删 Key、再删设置：Key 删不掉（凭据库锁了之类）就别把服务商也删了，不然那把
    // Key 变成孤儿——留在凭据库里，界面上却再也找不到它、没法清理（#158 评审）。
    creds.clear_key(id).map_err(credential_error)?;
    ai_settings::delete_provider(data_root, id).map_err(settings_error)?;
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
    migrate(data_root, creds)?;
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

/// 获取模型用哪把 Key：界面上刚填的优先；否则只有「输入的地址与已保存地址同源
/// （协议 + 主机 + 端口都一致，见 `ai_settings::same_origin`）」时才用这个服务商存着的
/// Key——未保存的新地址、或者只是把 https 改成 http，都拿不到旧 Key。
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
    // 界面刚填了 Key 就不用碰凭据库，上面提前返回了。走到这一步要用已存的 Key，
    // 先迁移一次：旧迁移账户（`default`）的 Key 可能还没搬过来，不迁移的话
    // 下面 `creds.get_key(id)` 会读到空的，明明存过 Key 却被当成没配置。
    migrate(data_root, creds)?;
    let missing = || CommandError {
        code: "AI_MODELS_MISSING_KEY".into(),
        message: "请先填写 API Key，再获取模型。".into(),
    };
    let id = provider_id.ok_or_else(missing)?;
    let settings = ai_settings::load(data_root);
    let saved = settings.providers.iter().find(|p| p.id == id).ok_or_else(missing)?;
    if !ai_settings::same_origin(&saved.api_url, api_url) {
        return Err(missing());
    }
    creds.get_key(id).map_err(credential_error)?.ok_or_else(missing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_credentials::{CredentialError, MemoryStore, UnavailableStore};

    /// 只在 `set_key` 上失败，其它都照常委托给内存实现：验证「Key 存不进凭据库」这一步
    /// 单独失败时，服务商不会跟着消失、也不会因为调用方误以为整体失败而重试出重复的一条
    /// （#158 评审）。
    struct SetOnlyFails(MemoryStore);

    impl CredentialStore for SetOnlyFails {
        fn set_key(&self, _provider_id: &str, _key: &str) -> Result<(), CredentialError> {
            Err(CredentialError::Unavailable("凭据库锁了".into()))
        }
        fn get_key(&self, provider_id: &str) -> Result<Option<String>, CredentialError> {
            self.0.get_key(provider_id)
        }
        fn clear_key(&self, provider_id: &str) -> Result<(), CredentialError> {
            self.0.clear_key(provider_id)
        }
        fn get_legacy_key(&self) -> Result<Option<String>, CredentialError> {
            self.0.get_legacy_key()
        }
        fn clear_legacy_key(&self) -> Result<(), CredentialError> {
            self.0.clear_legacy_key()
        }
    }

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
    fn a_key_storage_failure_does_not_fail_the_save_or_duplicate_the_provider() {
        // Key 存不进凭据库那一步单独失败时，服务商已经建好了：整体应该是 Ok，
        // 带上 keyError，让调用方拿到 provider_id、编辑器能正常关掉，不会因为
        // 以为「保存整体失败」而对着同一次输入重试、建出第二条服务商。
        let dir = tempfile::tempdir().unwrap();
        let creds = SetOnlyFails(MemoryStore::default());
        let result = save_provider(dir.path(), &creds, args(None, "https://a.example/v1"), Some("sk-a".into())).unwrap();
        assert!(result.key_error.is_some(), "Key 存失败该体现在 keyError 里");
        assert!(result.key_error.as_deref().unwrap().contains("凭据库锁了"));
        assert!(!result.key_cleared);
        let settings = crate::ai_settings::load(dir.path());
        assert_eq!(settings.providers.len(), 1, "服务商已经建好了，不该因为 Key 存不进去就消失");
        assert_eq!(settings.providers[0].id, result.provider_id);
    }

    #[test]
    fn a_migrate_failure_does_not_block_creating_a_new_provider_without_a_key() {
        // 凭据库整个用不了：migrate 内部读旧 Key 那一步会失败。新建服务商没填 Key，
        // 这次保存跟「旧 Key 搬没搬家」毫无关系，不该被这一步拖累（#158 评审）。
        let dir = tempfile::tempdir().unwrap();
        let creds = UnavailableStore("locked".into());
        let result = save_provider(dir.path(), &creds, args(None, "https://a.example/v1"), None).unwrap();
        assert!(result.key_error.is_some(), "migrate 失败该体现在 key_error 里，不能悄悄咽掉");
        assert!(result.key_error.as_deref().unwrap().contains("locked"), "{:?}", result.key_error);
        let settings = crate::ai_settings::load(dir.path());
        assert_eq!(settings.providers.len(), 1, "migrate 失败不该挡住这次保存");
        assert_eq!(settings.providers[0].id, result.provider_id);
    }

    #[test]
    fn a_key_storage_failure_is_reported_over_a_migrate_failure() {
        // 两个都失败时，Key 存失败跟这次保存关系更直接，优先报它。
        struct BothFail;
        impl CredentialStore for BothFail {
            fn set_key(&self, _: &str, _: &str) -> Result<(), CredentialError> {
                Err(CredentialError::Unavailable("set 失败".into()))
            }
            fn get_key(&self, _: &str) -> Result<Option<String>, CredentialError> {
                Err(CredentialError::Unavailable("get 失败".into()))
            }
            fn clear_key(&self, _: &str) -> Result<(), CredentialError> {
                Err(CredentialError::Unavailable("clear 失败".into()))
            }
            fn get_legacy_key(&self) -> Result<Option<String>, CredentialError> {
                Err(CredentialError::Unavailable("legacy 失败".into()))
            }
            fn clear_legacy_key(&self) -> Result<(), CredentialError> {
                Err(CredentialError::Unavailable("legacy 清除失败".into()))
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let result = save_provider(dir.path(), &BothFail, args(None, "https://a.example/v1"), Some("sk-a".into())).unwrap();
        assert!(result.key_error.as_deref().unwrap().contains("set 失败"), "{:?}", result.key_error);
    }

    #[test]
    fn a_settings_write_failure_during_migration_surfaces_with_its_own_code() {
        // data_root 指向一个文件（不是目录）：ensure_legacy_default 写文件那一步会失败。
        // migrate 不该把这个原因吞掉——不然「没有服务商 + 旧 Key 还在」这个判断会在下一次
        // 调用时又触发一遍（评审）。
        let dir = tempfile::tempdir().unwrap();
        let not_a_dir = dir.path().join("not-a-dir");
        std::fs::write(&not_a_dir, "x").unwrap();
        let creds = MemoryStore::with_legacy("sk-old");
        let err = migrate(&not_a_dir, &creds).unwrap_err();
        assert_eq!(err.code, "AI_SETTINGS_WRITE_FAILED");
        // active_with_key 走同一个 migrate,应该原样把这个错误传出去。
        let err = active_with_key(&not_a_dir, &creds).unwrap_err();
        assert_eq!(err.code, "AI_SETTINGS_WRITE_FAILED");
    }

    #[test]
    fn deleting_the_legacy_default_provider_does_not_resurrect_it() {
        // #158 评审：旧 Key 还没搬过来（只在 legacy 账户里）、设置文件里已经有 default
        // 服务商了。删除 default 之前得先迁移一次，不然删完之后设置空了、legacy 账户还留着
        // Key，下一次 settings_view 又会把 default 服务商重新变出来。
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            crate::ai_settings::path_for(dir.path()),
            r#"{"providers":[{"id":"default","name":"默认","apiUrl":"https://api.deepseek.com/v1/chat/completions","model":"m"}],"activeProviderId":"default"}"#,
        )
        .unwrap();
        let creds = MemoryStore::with_legacy("sk-old");
        delete_provider(dir.path(), &creds, "default").unwrap();
        let view = settings_view(dir.path(), &creds);
        assert!(view.providers.is_empty(), "default 服务商删了就该没了，不能在下次 settings_view 时被 legacy Key 变回来");
        assert_eq!(creds.get_legacy_key().unwrap(), None, "legacy 账户该在删除前就被迁移清空");
    }

    #[test]
    fn key_for_models_migrates_a_legacy_key_before_looking_it_up() {
        // default 服务商已经在设置文件里了，但旧 Key 还没搬家（只在 legacy 账户里）。
        // 不先迁移的话 creds.get_key("default") 读到空的，明明存过 Key 却被当成没配置。
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            crate::ai_settings::path_for(dir.path()),
            r#"{"providers":[{"id":"default","name":"默认","apiUrl":"https://api.deepseek.com/v1/chat/completions","model":"m"}],"activeProviderId":"default"}"#,
        )
        .unwrap();
        let creds = MemoryStore::with_legacy("sk-old");
        let key = key_for_models(
            dir.path(),
            &creds,
            Some("default"),
            "https://api.deepseek.com/v1/chat/completions",
            None,
        )
        .unwrap();
        assert_eq!(key, "sk-old");
    }

    #[test]
    fn a_successful_key_save_has_no_key_error() {
        let dir = tempfile::tempdir().unwrap();
        let creds = MemoryStore::default();
        let result = save_provider(dir.path(), &creds, args(None, "https://a.example/v1"), Some("sk-a".into())).unwrap();
        assert!(result.key_error.is_none());
        assert_eq!(creds.get_key(&result.provider_id).unwrap().as_deref(), Some("sk-a"));
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
    fn a_save_that_fails_validation_does_not_clear_the_key_or_change_the_host_first() {
        let dir = tempfile::tempdir().unwrap();
        let creds = MemoryStore::default();
        let id = save_provider(dir.path(), &creds, args(None, "https://a.example/v1"), Some("sk-a".into())).unwrap().provider_id;
        // 主机换了，但模型名填空——这次保存整体应该被拒绝，而不是先清 Key 再报错。
        let bad = ProviderArgs { id: Some(id.clone()), name: "P".into(), api_url: "https://b.example/v1".into(), model: "  ".into() };
        let err = save_provider(dir.path(), &creds, bad, None).unwrap_err();
        assert_eq!(err.code, "AI_SETTINGS_INVALID");
        assert!(creds.has_key(&id), "校验没过，Key 不该被清掉");
        let settings = crate::ai_settings::load(dir.path());
        assert_eq!(settings.providers[0].api_url, "https://a.example/v1/chat/completions", "校验没过，地址也不该被改");
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
    fn a_failed_key_clear_leaves_the_provider_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let creds = MemoryStore::default();
        let id = save_provider(dir.path(), &creds, args(None, "https://a.example/v1"), Some("sk-a".into())).unwrap().provider_id;
        let unavailable = UnavailableStore("locked".into());
        let err = delete_provider(dir.path(), &unavailable, &id).unwrap_err();
        assert_eq!(err.code, "CREDENTIAL_STORE_UNAVAILABLE");
        let settings = crate::ai_settings::load(dir.path());
        assert_eq!(settings.providers.len(), 1, "Key 删不掉，服务商不该被删掉，不然 Key 变成孤儿");
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
    fn a_key_only_upgrade_from_v0_4_0_gets_a_default_provider() {
        // v0.4.0 及更早没有 ai-settings.json、没有服务商列表：一个地址、一个模型都是写死的，
        // Key 单独有个保存按钮。升级后这把 Key 不该找不到主人（#158 评审）。
        let dir = tempfile::tempdir().unwrap();
        let creds = MemoryStore::with_legacy("sk-old");
        let view = settings_view(dir.path(), &creds);
        assert_eq!(view.providers.len(), 1);
        let p = &view.providers[0];
        assert_eq!(p.id, crate::ai_settings::LEGACY_PROVIDER_ID);
        assert_eq!(p.name, "默认");
        assert_eq!(p.api_url, crate::ai_settings::DEFAULT_API_URL);
        assert_eq!(p.model, "gpt-4o-mini");
        assert!(p.key_configured);
        assert_eq!(view.active_provider_id.as_deref(), Some(crate::ai_settings::LEGACY_PROVIDER_ID));
        assert_eq!(creds.get_legacy_key().unwrap(), None, "旧账户该清空");
    }

    #[test]
    fn no_file_and_no_legacy_key_still_means_no_providers() {
        let dir = tempfile::tempdir().unwrap();
        let creds = MemoryStore::default();
        let view = settings_view(dir.path(), &creds);
        assert!(view.providers.is_empty());
        assert_eq!(view.active_provider_id, None);
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
    fn settings_view_surfaces_an_unavailable_credential_store() {
        let dir = tempfile::tempdir().unwrap();
        let workable = MemoryStore::default();
        save_provider(dir.path(), &workable, args(None, "https://a.example/v1"), None).unwrap();
        let unavailable = UnavailableStore("locked".into());
        let view = settings_view(dir.path(), &unavailable);
        assert!(!view.providers[0].key_configured, "读不出来就当没配，不能瞎猜");
        let error = view.credential_error.expect("凭据库读不出来得如实说明，不能假装没配置过");
        assert!(error.contains("locked"), "{error}");
    }

    #[test]
    fn active_with_key_surfaces_an_unavailable_credential_store() {
        let dir = tempfile::tempdir().unwrap();
        let workable = MemoryStore::default();
        save_provider(dir.path(), &workable, args(None, "https://a.example/v1"), None).unwrap();
        let unavailable = UnavailableStore("locked".into());
        let err = active_with_key(dir.path(), &unavailable).unwrap_err();
        assert_eq!(err.code, "CREDENTIAL_STORE_UNAVAILABLE");
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

    #[test]
    fn key_for_models_refuses_a_protocol_downgrade_even_on_the_same_host() {
        // 保存的地址是 https，界面上把它改成 http（还没保存）就去获取模型：主机名一样，
        // 但来源不同，不能把只该发给 https 的 Key 发到明文连接上（#158 评审）。
        let dir = tempfile::tempdir().unwrap();
        let creds = MemoryStore::default();
        let id = save_provider(dir.path(), &creds, args(None, "https://a.example/v1"), Some("sk-a".into())).unwrap().provider_id;
        let err = key_for_models(dir.path(), &creds, Some(&id), "http://a.example/v1", None).unwrap_err();
        assert_eq!(err.code, "AI_MODELS_MISSING_KEY");
    }
}
