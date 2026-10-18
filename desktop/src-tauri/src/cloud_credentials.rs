//! D15 secrets are bound to a connection ID AND its endpoint/account fingerprint.
//! No getter is exposed as a Tauri command; only Rust transfer jobs may read them.
use backup_crypt::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    WebdavPassword,
    BackupPassphrase,
}
impl Kind {
    fn suffix(self) -> &'static str {
        match self {
            Self::WebdavPassword => "webdav-password",
            Self::BackupPassphrase => "backup-passphrase",
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionDescriptor {
    pub connection_id: String,
    pub endpoint: String,
    pub username: String,
}
pub struct Binding {
    prefix: String,
}
impl Binding {
    /// Non-secret scope token for persisted jobs; changes with account/endpoint.
    pub fn scope(&self) -> &str {
        &self.prefix
    }
    pub fn checked(connection: &ConnectionDescriptor) -> Result<Self, Error> {
        let id = uuid::Uuid::parse_str(&connection.connection_id)
            .map_err(|_| Error::InvalidConnection)?;
        let mut endpoint =
            url::Url::parse(&connection.endpoint).map_err(|_| Error::InvalidConnection)?;
        if endpoint.scheme() != "https"
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || connection.username.is_empty()
            || connection.username.len() > 4096
            || connection.username.contains(':')
            || connection.username.chars().any(char::is_control)
        {
            return Err(Error::InvalidConnection);
        }
        if !endpoint.path().ends_with('/') {
            endpoint
                .path_segments_mut()
                .map_err(|_| Error::InvalidConnection)?
                .push("");
        }
        let mut fingerprint = Sha256::new();
        fingerprint.update(endpoint.as_str().as_bytes());
        fingerprint.update([0]);
        fingerprint.update(connection.username.as_bytes());
        let hash: String = fingerprint
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(Self {
            prefix: format!("cloud-backup:{id}:{hash}"),
        })
    }
    fn account(&self, kind: Kind) -> String {
        format!("{}:{}", self.prefix, kind.suffix())
    }
}
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    InvalidConnection,
    Empty,
    Unavailable,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidConnection => "云备份连接标识、HTTPS 地址或账号不合法。",
            Self::Empty => "密码或备份口令为空，没有保存。",
            Self::Unavailable => "系统凭据库不可用；秘密没有降级保存到文件。",
        })
    }
}
impl std::error::Error for Error {}
impl From<Error> for crate::commands::CommandError {
    fn from(error: Error) -> Self {
        Self {
            code: match error {
                Error::InvalidConnection | Error::Empty => "VALIDATION",
                Error::Unavailable => "CREDENTIAL_STORE_UNAVAILABLE",
            }
            .into(),
            message: error.to_string(),
        }
    }
}
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub has_webdav_password: bool,
    pub has_backup_passphrase: bool,
}

pub trait CredentialStore: Send + Sync {
    fn set(&self, binding: &Binding, kind: Kind, value: SecretString) -> Result<(), Error>;
    /// Rust only. Never make this method a command or serialize its return value.
    fn read(&self, binding: &Binding, kind: Kind) -> Result<Option<SecretString>, Error>;
    fn clear(&self, binding: &Binding, kind: Kind) -> Result<(), Error>;
    fn status(&self, binding: &Binding) -> Result<Status, Error> {
        Ok(Status {
            has_webdav_password: self.read(binding, Kind::WebdavPassword)?.is_some(),
            has_backup_passphrase: self.read(binding, Kind::BackupPassphrase)?.is_some(),
        })
    }
}

pub struct KeyringStore;
impl KeyringStore {
    fn entry(binding: &Binding, kind: Kind) -> Result<keyring::Entry, Error> {
        keyring::Entry::new(crate::ai_credentials::SERVICE, &binding.account(kind))
            .map_err(|_| Error::Unavailable)
    }
}
impl CredentialStore for KeyringStore {
    fn set(&self, binding: &Binding, kind: Kind, value: SecretString) -> Result<(), Error> {
        // Spaces and Unicode are meaningful in a passphrase. Never trim it.
        if value.expose_secret().is_empty() {
            return Err(Error::Empty);
        }
        Self::entry(binding, kind)?
            .set_password(value.expose_secret())
            .map_err(|_| Error::Unavailable)
    }
    fn read(&self, binding: &Binding, kind: Kind) -> Result<Option<SecretString>, Error> {
        match Self::entry(binding, kind)?.get_password() {
            Ok(value) => Ok(Some(SecretString::from(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(Error::Unavailable),
        }
    }
    fn clear(&self, binding: &Binding, kind: Kind) -> Result<(), Error> {
        match Self::entry(binding, kind)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(Error::Unavailable),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<String, SecretString>>);
    impl CredentialStore for MemoryStore {
        fn set(&self, binding: &Binding, kind: Kind, value: SecretString) -> Result<(), Error> {
            if value.expose_secret().is_empty() {
                return Err(Error::Empty);
            }
            self.0.lock().unwrap().insert(binding.account(kind), value);
            Ok(())
        }
        fn read(&self, binding: &Binding, kind: Kind) -> Result<Option<SecretString>, Error> {
            Ok(self.0.lock().unwrap().get(&binding.account(kind)).cloned())
        }
        fn clear(&self, binding: &Binding, kind: Kind) -> Result<(), Error> {
            self.0.lock().unwrap().remove(&binding.account(kind));
            Ok(())
        }
    }
    fn descriptor() -> ConnectionDescriptor {
        ConnectionDescriptor {
            connection_id: uuid::Uuid::new_v4().to_string(),
            endpoint: "https://dav.jianguoyun.com/dav/".into(),
            username: "synthetic@example.invalid".into(),
        }
    }
    #[test]
    fn secrets_are_bound_to_endpoint_account_id_and_kind_without_normalizing_passphrases() {
        let store = MemoryStore::default();
        let mut connection = descriptor();
        let original = Binding::checked(&connection).unwrap();
        let secret = "  合成 passphrase \t ";
        store
            .set(
                &original,
                Kind::BackupPassphrase,
                SecretString::from(secret.to_owned()),
            )
            .unwrap();
        assert_eq!(
            store
                .read(&original, Kind::BackupPassphrase)
                .unwrap()
                .unwrap()
                .expose_secret(),
            secret
        );
        assert!(!store.status(&original).unwrap().has_webdav_password);
        connection.username = "different@example.invalid".into();
        assert!(
            !store
                .status(&Binding::checked(&connection).unwrap())
                .unwrap()
                .has_backup_passphrase
        );
        connection.endpoint = "https://other.example.invalid/dav/".into();
        assert!(
            !store
                .status(&Binding::checked(&connection).unwrap())
                .unwrap()
                .has_backup_passphrase
        );
        connection.connection_id = uuid::Uuid::new_v4().to_string();
        assert!(
            !store
                .status(&Binding::checked(&connection).unwrap())
                .unwrap()
                .has_backup_passphrase
        );
        assert_eq!(
            store.set(
                &original,
                Kind::WebdavPassword,
                SecretString::from(String::new())
            ),
            Err(Error::Empty)
        );
        store.clear(&original, Kind::BackupPassphrase).unwrap();
        assert!(!store.status(&original).unwrap().has_backup_passphrase);
    }
    #[test]
    fn status_serializes_only_booleans_and_errors_never_include_inputs() {
        let mut connection = descriptor();
        connection.endpoint = "https://user:synthetic-secret@example.invalid/".into();
        assert!(matches!(
            Binding::checked(&connection),
            Err(Error::InvalidConnection)
        ));
        let text = serde_json::to_string(&Status {
            has_webdav_password: true,
            has_backup_passphrase: false,
        })
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            serde_json::json!({"hasWebdavPassword":true,"hasBackupPassphrase":false})
        );
        assert!(!Error::Unavailable.to_string().contains("synthetic"));
    }
    #[test]
    #[ignore = "Explicit native credential-store check using synthetic per-run accounts"]
    fn native_keyring_persists_across_store_instances_and_clears() {
        let binding = Binding::checked(&descriptor()).unwrap();
        let secret = SecretString::from(" synthetic-native-passphrase ".to_owned());
        KeyringStore
            .set(&binding, Kind::BackupPassphrase, secret)
            .unwrap();
        // A new adapter reopens the native entry; it has no in-memory secret cache.
        let fresh = KeyringStore;
        let read = fresh.read(&binding, Kind::BackupPassphrase);
        fresh.clear(&binding, Kind::BackupPassphrase).unwrap();
        let read = read.unwrap().unwrap();
        assert_eq!(read.expose_secret(), " synthetic-native-passphrase ");
        assert!(!fresh.status(&binding).unwrap().has_backup_passphrase);
    }
}
