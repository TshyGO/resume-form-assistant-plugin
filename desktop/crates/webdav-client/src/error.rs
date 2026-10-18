use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    InvalidConfig,
    InvalidPath,
    Authentication,
    Permission,
    NotFound,
    Conflict,
    TooLarge,
    RateLimited,
    NoSpace,
    Unsupported,
    Redirect,
    InvalidResponse,
    Network,
    Timeout,
    Cancelled,
    Io,
    Server,
}

/// Deliberately excludes response bodies, URLs, usernames and credentials.
#[derive(Debug, Clone)]
pub struct Error {
    pub kind: ErrorKind,
    pub status: Option<u16>,
    pub retry_after: Option<Duration>,
    pub outcome_unknown: bool,
}
impl Error {
    pub(crate) fn new(kind: ErrorKind) -> Self {
        Self {
            kind,
            status: None,
            retry_after: None,
            outcome_unknown: false,
        }
    }
    pub(crate) fn retryable(&self) -> bool {
        matches!(
            self.kind,
            ErrorKind::Network | ErrorKind::Timeout | ErrorKind::RateLimited
        ) || matches!(self.status, Some(502 | 503 | 504))
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "WebDAV {:?}", self.kind)?;
        if let Some(status) = self.status {
            write!(f, " (HTTP {status})")?;
        }
        if self.outcome_unknown {
            f.write_str("; mutation outcome unknown: reconcile before retry")?;
        }
        Ok(())
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self::new(ErrorKind::Io)
    }
}
