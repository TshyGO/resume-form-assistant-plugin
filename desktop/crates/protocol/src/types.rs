use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{ErrorCode, Layer, ProtocolError};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MIN_PROTOCOL_VERSION: u32 = 1;
pub const MAX_PROTOCOL_VERSION: u32 = 1;
pub const MAX_ENVELOPE_BYTES: usize = 65536;
pub const SUGGESTED_RAW_CHUNK_BYTES: usize = 32768;
pub const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_RECONCILE_ITEMS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageType {
    #[serde(rename = "health")]
    Health,
    #[serde(rename = "handshake")]
    Handshake,
    #[serde(rename = "application.queryCandidates")]
    QueryCandidates,
    #[serde(rename = "job.save")]
    JobSave,
    #[serde(rename = "fill.submit")]
    FillSubmit,
    #[serde(rename = "snapshot.chunk")]
    SnapshotChunk,
    #[serde(rename = "submit.confirm")]
    SubmitConfirm,
    #[serde(rename = "outbox.reconcile")]
    OutboxReconcile,
}

impl MessageType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Health => "health",
            Self::Handshake => "handshake",
            Self::QueryCandidates => "application.queryCandidates",
            Self::JobSave => "job.save",
            Self::FillSubmit => "fill.submit",
            Self::SnapshotChunk => "snapshot.chunk",
            Self::SubmitConfirm => "submit.confirm",
            Self::OutboxReconcile => "outbox.reconcile",
        }
    }

    pub fn parse(value: &str) -> Result<Self, ProtocolError> {
        match value {
            "health" => Ok(Self::Health),
            "handshake" => Ok(Self::Handshake),
            "application.queryCandidates" => Ok(Self::QueryCandidates),
            "job.save" => Ok(Self::JobSave),
            "fill.submit" => Ok(Self::FillSubmit),
            "snapshot.chunk" => Ok(Self::SnapshotChunk),
            "submit.confirm" => Ok(Self::SubmitConfirm),
            "outbox.reconcile" => Ok(Self::OutboxReconcile),
            "SaveIntent" | "saveIntent" | "save.intent" => Err(ProtocolError::new(
                ErrorCode::UnknownMessageType,
                Layer::Structure,
                "SaveIntent is a plugin-local object, not a Native Messaging messageType",
            )),
            _ => Err(ProtocolError::new(
                ErrorCode::UnknownMessageType,
                Layer::Structure,
                format!("unknown messageType {value}"),
            )),
        }
    }

    pub fn identity_forbidden(self) -> bool {
        matches!(self, Self::Health | Self::Handshake)
    }

    pub fn identity_required(self) -> bool {
        !self.identity_forbidden()
    }

    pub fn is_write(self) -> bool {
        matches!(
            self,
            Self::JobSave | Self::FillSubmit | Self::SnapshotChunk | Self::SubmitConfirm
        )
    }

    pub fn needs_source_restore_epoch(self) -> bool {
        self.is_write()
    }
}

#[derive(Debug, Clone)]
pub struct Request {
    pub protocol_version: u32,
    pub message_id: String,
    pub client_instance_id: String,
    pub message_type: MessageType,
    pub occurred_at: String,
    pub archive_id: Option<String>,
    pub restore_epoch: Option<String>,
    pub payload: Value,
    pub raw: Value,
}

#[derive(Debug, Clone)]
pub struct CurrentArchive {
    pub archive_id: String,
    pub restore_epoch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MessageKey {
    pub client_instance_id: String,
    pub message_id: String,
    pub source_restore_epoch: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoredOutcome {
    Applied {
        result_id: String,
        payload_sha256: String,
    },
    Purged {
        payload_sha256: String,
    },
    Unverifiable,
}

pub trait ReceiptStore {
    fn get(&self, key: &MessageKey) -> Option<StoredOutcome>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteDecision {
    Accept,
    Replay { result_id: String },
    Conflict,
    PreviouslyPurged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconcileStatusKind {
    Applied,
    Purged,
    NotFound,
    Conflict,
    Unverifiable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileItemResult {
    pub client_instance_id: String,
    pub message_id: String,
    pub source_restore_epoch: String,
    pub payload_sha256: String,
    pub status: ReconcileStatusKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_index: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AckKind {
    Chunk,
    Snapshot,
}
