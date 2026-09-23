//! 桌面这一条 AI Key 的存放处：Windows Credential Manager / macOS Keychain。
//!
//! data-privacy §1：Key **禁止**进 SQLite、附件、备份、日志。所以这里只有三件事：
//! 存、取（只给 Rust 侧发请求用）、删。**没有把 Key 返回给界面的命令。**
//!
//! 插件那条 Key 永不复制过来；用户在桌面另配的是第二条凭据（§8）。

use std::collections::HashMap;
use std::sync::Mutex;

pub const SERVICE: &str = "com.resumepro.desktop";
/// 升级前唯一的那条 Key。迁移到某份配置自己的账户之后就不再读取。
pub const LEGACY_ACCOUNT: &str = "ai-api-key";

/// 每份配置一个账户，切换时只能读到自己的 Key。
pub fn profile_account(profile_id: &str) -> String {
    format!("ai-api-key:{profile_id}")
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
    fn set_key(&self, account: &str, key: &str) -> Result<(), CredentialError>;
    /// 只有发请求时才调。**不要**做成命令暴露给界面。
    fn get_key(&self, account: &str) -> Result<Option<String>, CredentialError>;
    fn clear_key(&self, account: &str) -> Result<(), CredentialError>;

    #[allow(dead_code)] // 目前只有测试在用；留着是因为它是这个 trait 的语义之一。
    fn has_key(&self, account: &str) -> bool {
        matches!(self.get_key(account), Ok(Some(_)))
    }
}

pub struct KeyringStore;

impl KeyringStore {
    fn entry(account: &str) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(SERVICE, account)
            .map_err(|e| CredentialError::Unavailable(e.to_string()))
    }
}

impl CredentialStore for KeyringStore {
    fn set_key(&self, account: &str, key: &str) -> Result<(), CredentialError> {
        let key = key.trim();
        if key.is_empty() {
            return Err(CredentialError::Empty);
        }
        Self::entry(account)?
            .set_password(key)
            .map_err(|e| CredentialError::Unavailable(e.to_string()))
    }

    fn get_key(&self, account: &str) -> Result<Option<String>, CredentialError> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(CredentialError::Unavailable(e.to_string())),
        }
    }

    fn clear_key(&self, account: &str) -> Result<(), CredentialError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) => Ok(()),
            // 本来就没有，调用方要的「之后没有这条 Key」已经成立。
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(CredentialError::Unavailable(e.to_string())),
        }
    }
}

/// 测试与 CI 用。进程退出就没了，正好符合「不落盘」。
#[allow(dead_code)]
#[derive(Default)]
pub struct MemoryStore {
    keys: Mutex<HashMap<String, String>>,
}

impl CredentialStore for MemoryStore {
    fn set_key(&self, account: &str, key: &str) -> Result<(), CredentialError> {
        let key = key.trim();
        if key.is_empty() {
            return Err(CredentialError::Empty);
        }
        self.keys
            .lock()
            .unwrap()
            .insert(account.to_string(), key.to_string());
        Ok(())
    }

    fn get_key(&self, account: &str) -> Result<Option<String>, CredentialError> {
        Ok(self.keys.lock().unwrap().get(account).cloned())
    }

    fn clear_key(&self, account: &str) -> Result<(), CredentialError> {
        self.keys.lock().unwrap().remove(account);
        Ok(())
    }
}

/// 明确不可用：每一步都如实报错，不假装保存成功。
#[allow(dead_code)]
pub struct UnavailableStore(pub String);

impl CredentialStore for UnavailableStore {
    fn set_key(&self, _account: &str, _key: &str) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable(self.0.clone()))
    }

    fn get_key(&self, _account: &str) -> Result<Option<String>, CredentialError> {
        Err(CredentialError::Unavailable(self.0.clone()))
    }

    fn clear_key(&self, _account: &str) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable(self.0.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_can_be_set_read_and_cleared() {
        let store = MemoryStore::default();
        let account = profile_account("a");
        assert!(!store.has_key(&account));
        store.set_key(&account, "  sk-synthetic  ").unwrap();
        assert!(store.has_key(&account));
        assert_eq!(store.get_key(&account).unwrap().as_deref(), Some("sk-synthetic"));
        store.clear_key(&account).unwrap();
        assert_eq!(store.get_key(&account).unwrap(), None);
    }

    #[test]
    fn two_accounts_do_not_share_a_key() {
        let store = MemoryStore::default();
        store.set_key(&profile_account("a"), "sk-a").unwrap();
        store.set_key(&profile_account("b"), "sk-b").unwrap();
        assert_eq!(store.get_key(&profile_account("a")).unwrap().as_deref(), Some("sk-a"));
        assert_eq!(store.get_key(&profile_account("b")).unwrap().as_deref(), Some("sk-b"));
        assert_eq!(store.get_key(LEGACY_ACCOUNT).unwrap(), None);
    }

    #[test]
    fn an_empty_key_is_refused_instead_of_stored() {
        let store = MemoryStore::default();
        assert_eq!(
            store.set_key(&profile_account("a"), "   ").unwrap_err(),
            CredentialError::Empty
        );
        assert!(!store.has_key(&profile_account("a")));
    }

    #[test]
    fn an_unavailable_store_says_so_instead_of_pretending() {
        let store = UnavailableStore("CI 上没有凭据库".into());
        let err = store.set_key(&profile_account("a"), "sk-synthetic").unwrap_err();
        assert_eq!(err.code(), "CREDENTIAL_STORE_UNAVAILABLE");
        assert!(err.message().contains("没有保存"));
        assert!(!store.has_key(&profile_account("a")));
    }
}
