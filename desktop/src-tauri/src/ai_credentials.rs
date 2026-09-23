//! 桌面每个 AI 服务商的 Key 分别存进 Windows Credential Manager / macOS Keychain。
//!
//! data-privacy §1：Key **禁止**进 SQLite、附件、备份、日志。所以这里只有三件事：
//! 存、取（只给 Rust 侧发请求用）、删。**没有把 Key 返回给界面的命令。**
//!
//! 插件那条 Key 永不复制过来；用户在桌面另配的是第二条凭据（§8）。

use std::collections::HashMap;
use std::sync::Mutex;

pub const SERVICE: &str = "com.resumepro.desktop";
/// 旧版本的单个 Key 账户；迁移后删除。
pub const LEGACY_ACCOUNT: &str = "ai-api-key";

pub fn account_for(provider_id: &str) -> String {
    format!("{LEGACY_ACCOUNT}:{provider_id}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialError {
    /// 凭据库打不开或不可用（CI、被策略禁用、Keychain 被锁）。
    Unavailable(String),
    /// 用户给了一条空的 Key。
    Empty,
}

impl CredentialError {
    pub fn code(&self) -> &'static str {
        match self {
            CredentialError::Unavailable(_) => "CREDENTIAL_STORE_UNAVAILABLE",
            CredentialError::Empty => "VALIDATION",
        }
    }

    pub fn message(&self) -> String {
        match self {
            CredentialError::Unavailable(detail) => {
                format!("系统凭据库用不了，Key 没有保存：{detail}")
            }
            CredentialError::Empty => "Key 是空的，没有保存。".into(),
        }
    }
}

/// 可注入，CI 上换成内存实现。真实凭据库只在人工走查里验证。
pub trait CredentialStore: Send + Sync {
    fn set_key(&self, provider_id: &str, key: &str) -> Result<(), CredentialError>;
    /// 只有发请求时才调。**不要**做成命令暴露给界面。
    fn get_key(&self, provider_id: &str) -> Result<Option<String>, CredentialError>;
    fn clear_key(&self, provider_id: &str) -> Result<(), CredentialError>;
    fn get_legacy_key(&self) -> Result<Option<String>, CredentialError>;
    fn clear_legacy_key(&self) -> Result<(), CredentialError>;

    #[allow(dead_code)] // 目前只有测试在用；留着是因为它是这个 trait 的语义之一。
    fn has_key(&self, provider_id: &str) -> bool {
        matches!(self.get_key(provider_id), Ok(Some(_)))
    }
}

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

pub struct KeyringStore;

impl KeyringStore {
    fn entry(account: &str) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(SERVICE, account)
            .map_err(|e| CredentialError::Unavailable(e.to_string()))
    }

    fn read(account: &str) -> Result<Option<String>, CredentialError> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(CredentialError::Unavailable(e.to_string())),
        }
    }

    fn clear(account: &str) -> Result<(), CredentialError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(CredentialError::Unavailable(e.to_string())),
        }
    }
}

impl CredentialStore for KeyringStore {
    fn set_key(&self, provider_id: &str, key: &str) -> Result<(), CredentialError> {
        let key = key.trim();
        if key.is_empty() {
            return Err(CredentialError::Empty);
        }
        Self::entry(&account_for(provider_id))?
            .set_password(key)
            .map_err(|e| CredentialError::Unavailable(e.to_string()))
    }

    fn get_key(&self, provider_id: &str) -> Result<Option<String>, CredentialError> {
        Self::read(&account_for(provider_id))
    }

    fn clear_key(&self, provider_id: &str) -> Result<(), CredentialError> {
        Self::clear(&account_for(provider_id))
    }

    fn get_legacy_key(&self) -> Result<Option<String>, CredentialError> {
        Self::read(LEGACY_ACCOUNT)
    }

    fn clear_legacy_key(&self) -> Result<(), CredentialError> {
        Self::clear(LEGACY_ACCOUNT)
    }
}

/// 测试与 CI 用。进程退出就没了，正好符合「不落盘」。
#[allow(dead_code)]
#[derive(Default)]
pub struct MemoryStore {
    keys: Mutex<HashMap<String, String>>,
}

impl MemoryStore {
    #[cfg(test)]
    pub fn with_legacy(key: &str) -> Self {
        let mut keys = HashMap::new();
        keys.insert(LEGACY_ACCOUNT.into(), key.into());
        Self { keys: Mutex::new(keys) }
    }
}

impl CredentialStore for MemoryStore {
    fn set_key(&self, provider_id: &str, key: &str) -> Result<(), CredentialError> {
        let key = key.trim();
        if key.is_empty() {
            return Err(CredentialError::Empty);
        }
        self.keys.lock().unwrap().insert(account_for(provider_id), key.to_string());
        Ok(())
    }

    fn get_key(&self, provider_id: &str) -> Result<Option<String>, CredentialError> {
        Ok(self.keys.lock().unwrap().get(&account_for(provider_id)).cloned())
    }

    fn clear_key(&self, provider_id: &str) -> Result<(), CredentialError> {
        self.keys.lock().unwrap().remove(&account_for(provider_id));
        Ok(())
    }

    fn get_legacy_key(&self) -> Result<Option<String>, CredentialError> {
        Ok(self.keys.lock().unwrap().get(LEGACY_ACCOUNT).cloned())
    }

    fn clear_legacy_key(&self) -> Result<(), CredentialError> {
        self.keys.lock().unwrap().remove(LEGACY_ACCOUNT);
        Ok(())
    }
}

/// 明确不可用：每一步都如实报错，不假装保存成功。
#[allow(dead_code)]
pub struct UnavailableStore(pub String);

impl CredentialStore for UnavailableStore {
    fn set_key(&self, _provider_id: &str, _key: &str) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable(self.0.clone()))
    }

    fn get_key(&self, _provider_id: &str) -> Result<Option<String>, CredentialError> {
        Err(CredentialError::Unavailable(self.0.clone()))
    }

    fn clear_key(&self, _provider_id: &str) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable(self.0.clone()))
    }

    fn get_legacy_key(&self) -> Result<Option<String>, CredentialError> {
        Err(CredentialError::Unavailable(self.0.clone()))
    }

    fn clear_legacy_key(&self) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable(self.0.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(store.get_legacy_key().unwrap(), None);
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
}
