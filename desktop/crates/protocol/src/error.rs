use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    IdentityMissing,
    IdentityNotAllowed,
    RestoreEpochMismatch,
    ProtocolIncompatible,
    UnknownMessageType,
    InvalidPayload,
    PayloadTooLarge,
    Conflict,
    PreviouslyPurged,
    Unavailable,
    SecretForbidden,
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::IdentityMissing => "identity_missing",
            Self::IdentityNotAllowed => "identity_not_allowed",
            Self::RestoreEpochMismatch => "restore_epoch_mismatch",
            Self::ProtocolIncompatible => "protocol_incompatible",
            Self::UnknownMessageType => "unknown_message_type",
            Self::InvalidPayload => "invalid_payload",
            Self::PayloadTooLarge => "payload_too_large",
            Self::Conflict => "conflict",
            Self::PreviouslyPurged => "previously_purged",
            Self::Unavailable => "unavailable",
            Self::SecretForbidden => "secret_forbidden",
        }
    }

    pub fn retryable(self) -> bool {
        matches!(self, Self::Unavailable)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    Size,
    Structure,
    IdentityPresence,
    Secrets,
    Business,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {message}")]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub retryable: bool,
    pub message: String,
    pub layer: Layer,
}

impl ProtocolError {
    pub fn new(code: ErrorCode, layer: Layer, message: impl Into<String>) -> Self {
        Self {
            retryable: code.retryable(),
            code,
            message: message.into(),
            layer,
        }
    }

    pub fn to_error_object(&self) -> serde_json::Value {
        const MAX_MESSAGE_CHARS: usize = 300;
        let message: String = self.message.chars().take(MAX_MESSAGE_CHARS).collect();
        serde_json::json!({
            "code": self.code.as_str(),
            "retryable": self.retryable,
            "message": message,
        })
    }
}
