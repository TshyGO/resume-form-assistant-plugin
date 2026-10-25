//! Machine-local mailbox discovery. Nothing here writes formal archive evidence.
pub mod config;
mod db;
pub mod discovery;
pub mod imap;
mod rules;
pub use config::{ConnectionConfig, Encryption};
pub use db::{Account, Candidate, Cursor, Database, HeaderRetry};
pub use rules::{classify, Header};
use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

/// Only safe categories cross IPC. Never forward an IMAP response or credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Error {
    Address,
    Auth,
    ImapDisabled,
    Network,
    Tls,
    Protocol,
    Storage,
    Missing,
    TooLarge,
    Changed,
    Busy,
    Credentials,
    Configuration,
    OAuthRequired,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Qq,
    N163,
    N126,
    Gmail,
    Icloud,
    Sina,
    Sohu,
    Aliyun,
    N139,
    Custom,
}
impl Provider {
    pub fn detect(address: &str) -> Result<(String, Self)> {
        let email = config::normalize_email(address)?;
        let (_, domain) = email.split_once('@').ok_or(Error::Address)?;
        let provider = match domain {
            "qq.com" | "foxmail.com" => Self::Qq,
            "163.com" => Self::N163,
            "126.com" => Self::N126,
            "gmail.com" | "googlemail.com" => Self::Gmail,
            "icloud.com" | "me.com" | "mac.com" => Self::Icloud,
            "sina.com" | "sina.cn" | "vip.sina.com" | "vip.sina.cn" => Self::Sina,
            "sohu.com" => Self::Sohu,
            "aliyun.com" => Self::Aliyun,
            "139.com" => Self::N139,
            _ => return Err(Error::Address),
        };
        Ok((email, provider))
    }
    pub fn server(self) -> &'static str {
        match self {
            Self::Qq => "imap.qq.com",
            Self::N163 => "imap.163.com",
            Self::N126 => "imap.126.com",
            Self::Gmail => "imap.gmail.com",
            Self::Icloud => "imap.mail.me.com",
            Self::Sina => "imap.sina.com",
            Self::Sohu => "imap.sohu.com",
            Self::Aliyun => "imap.aliyun.com",
            Self::N139 => "imap.139.com",
            Self::Custom => "",
        }
    }
    pub fn needs_id(self) -> bool {
        matches!(self, Self::N163 | Self::N126)
    }
}

pub const CHECK_INTERVAL: i64 = 600;
pub const FAILURE_LIMIT: u32 = 3;
pub fn retry_delay(failures: u32) -> i64 {
    60 * (1i64 << failures.saturating_sub(1).min(4))
}

#[cfg(test)]
mod tests;
