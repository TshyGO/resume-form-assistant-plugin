//! Machine-local mailbox discovery. Nothing here writes formal archive evidence.
mod db;
pub mod imap;
mod rules;
pub use db::{Account, Candidate, Cursor, Database};
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
}
impl Provider {
    pub fn detect(address: &str) -> Result<(String, Self)> {
        let email = address.trim().to_ascii_lowercase();
        let (local, domain) = email.split_once('@').ok_or(Error::Address)?;
        if local.is_empty()
            || local.len() > 64
            || !local
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
        {
            return Err(Error::Address);
        }
        let provider = match domain {
            "qq.com" | "foxmail.com" => Self::Qq,
            "163.com" => Self::N163,
            "126.com" => Self::N126,
            _ => return Err(Error::Address),
        };
        // foxmail belongs to QQ; no arbitrary host, port or credential-bearing URL.
        Ok((email, provider))
    }
    pub fn server(self) -> &'static str {
        match self {
            Self::Qq => "imap.qq.com",
            Self::N163 => "imap.163.com",
            Self::N126 => "imap.126.com",
        }
    }
    pub fn needs_id(self) -> bool {
        self != Self::Qq
    }
}

pub const CHECK_INTERVAL: i64 = 600;
pub const FAILURE_LIMIT: u32 = 3;
pub fn retry_delay(failures: u32) -> i64 {
    60 * (1i64 << failures.saturating_sub(1).min(4))
}

#[cfg(test)]
mod tests;
