use serde::Serialize;
use std::path::PathBuf;

/// Stable error codes for logs, settings UI, and `--probe`.
pub const DIR_NOT_WRITABLE: &str = "DIR_NOT_WRITABLE";
pub const DIR_CREATE_FAILED: &str = "DIR_CREATE_FAILED";
pub const PATH_INVALID: &str = "PATH_INVALID";
pub const INSTANCE_LOCK_FAILED: &str = "INSTANCE_LOCK_FAILED";
pub const LOG_WRITE_FAILED: &str = "LOG_WRITE_FAILED";

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("{code}: {message}")]
    Coded {
        code: &'static str,
        message: String,
        path: Option<PathBuf>,
        hint: String,
    },
}

impl HostError {
    pub fn new(
        code: &'static str,
        message: impl Into<String>,
        path: Option<PathBuf>,
        hint: impl Into<String>,
    ) -> Self {
        Self::Coded {
            code,
            message: message.into(),
            path,
            hint: hint.into(),
        }
    }

    pub fn path_invalid(message: impl Into<String>) -> Self {
        Self::new(
            PATH_INVALID,
            message,
            None,
            "Use an absolute directory path. Relative paths and empty overrides are rejected.",
        )
    }

    pub fn dir_create_failed(path: PathBuf, message: impl Into<String>) -> Self {
        let hint = "Create the directory or fix permissions. The app will not fall back to a temporary directory.";
        Self::new(DIR_CREATE_FAILED, message, Some(path), hint)
    }

    pub fn dir_not_writable(path: PathBuf, message: impl Into<String>) -> Self {
        let hint = "Make the data directory writable, or set RESUMEPRO_DATA_DIR to a writable absolute path and restart. The app will not silently use a temp directory.";
        Self::new(DIR_NOT_WRITABLE, message, Some(path), hint)
    }

    pub fn instance_lock_failed(path: PathBuf) -> Self {
        Self::new(
            INSTANCE_LOCK_FAILED,
            "another unique-writer host already holds the data directory lock",
            Some(path),
            "A second launch should focus the existing window instead of creating another writer.",
        )
    }

    pub fn log_write_failed(path: PathBuf, message: impl Into<String>) -> Self {
        Self::new(
            LOG_WRITE_FAILED,
            message,
            Some(path),
            "The log directory is shown in Settings. Fix write permission there; logs are not sent anywhere else.",
        )
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Coded { code, .. } => code,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Coded { message, .. } => message,
        }
    }

    pub fn path(&self) -> Option<&std::path::Path> {
        match self {
            Self::Coded { path, .. } => path.as_deref(),
        }
    }

    pub fn hint(&self) -> &str {
        match self {
            Self::Coded { hint, .. } => hint,
        }
    }

    pub fn to_dto(&self) -> HostErrorDto {
        HostErrorDto {
            code: self.code().to_string(),
            message: self.message().to_string(),
            path: self.path().map(|p| p.display().to_string()),
            hint: self.hint().to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostErrorDto {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
    pub hint: String,
}
