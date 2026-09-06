use std::collections::HashMap;

use serde_json::Value;

use crate::digest::{decode_standard_base64, sha256_hex};
use crate::error::{ErrorCode, Layer, ProtocolError};
use crate::types::{AckKind, Request, MAX_CHUNK_COUNT, MAX_SNAPSHOT_BYTES};

const MAX_ASSEMBLER_SESSIONS: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkRecord {
    pub message_id: String,
    pub chunk_index: u32,
    pub application_id: String,
    pub chunk_sha256: String,
    pub identity_sha256: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct SnapshotSession {
    pub snapshot_id: String,
    pub client_instance_id: String,
    pub source_restore_epoch: String,
    pub application_id: String,
    pub chunk_count: u32,
    pub snapshot_sha256: String,
    pub byte_size: usize,
    pub chunks: HashMap<u32, ChunkRecord>,
}

impl SnapshotSession {
    pub fn chunk_cursor(&self) -> u32 {
        let mut cursor = 0;
        while self.chunks.contains_key(&cursor) {
            cursor += 1;
        }
        cursor
    }

    pub fn all_indexes_present(&self) -> bool {
        (0..self.chunk_count).all(|i| self.chunks.contains_key(&i))
    }

    pub fn assembled_bytes(&self) -> Option<Vec<u8>> {
        if !self.all_indexes_present() {
            return None;
        }
        let mut out = Vec::with_capacity(self.byte_size);
        for i in 0..self.chunk_count {
            out.extend_from_slice(&self.chunks.get(&i)?.bytes);
        }
        Some(out)
    }

    /// Content is complete and hashes match. This is not a durable snapshot ACK.
    pub fn integrity_verified(&self) -> bool {
        let Some(bytes) = self.assembled_bytes() else {
            return false;
        };
        bytes.len() == self.byte_size && sha256_hex(&bytes) == self.snapshot_sha256
    }

    pub fn stored_bytes(&self) -> usize {
        self.chunks.values().map(|c| c.bytes.len()).sum()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Integrity {
    Partial,
    VerifiedInMemory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssemblerOutcome {
    pub chunk_index: u32,
    pub chunk_cursor: u32,
    pub replay: bool,
    pub integrity: Integrity,
}

impl AssemblerOutcome {
    pub fn ready_to_persist(&self) -> bool {
        self.integrity == Integrity::VerifiedInMemory
    }
}

/// In-memory reference assembler. Integrity here is not a durable snapshot ACK.
#[derive(Default)]
pub struct ChunkAssembler {
    sessions: HashMap<String, SnapshotSession>,
}

impl ChunkAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    fn session_key(client: &str, snapshot: &str, epoch: &str) -> String {
        format!("{client}:{snapshot}:{epoch}")
    }

    pub fn apply_chunk(&mut self, req: &Request) -> Result<AssemblerOutcome, ProtocolError> {
        let parsed = parse_chunk(req)?;
        let key = Self::session_key(
            &req.client_instance_id,
            &parsed.snapshot_id,
            &parsed.source_restore_epoch,
        );
        if !self.sessions.contains_key(&key) && self.sessions.len() >= MAX_ASSEMBLER_SESSIONS {
            return Err(ProtocolError::new(
                ErrorCode::Unavailable,
                Layer::Business,
                "too many in-memory snapshot sessions",
            ));
        }
        if !self.sessions.contains_key(&key) {
            self.sessions.insert(
                key.clone(),
                SnapshotSession {
                    snapshot_id: parsed.snapshot_id.clone(),
                    client_instance_id: req.client_instance_id.clone(),
                    source_restore_epoch: parsed.source_restore_epoch.clone(),
                    application_id: parsed.application_id.clone(),
                    chunk_count: parsed.chunk_count,
                    snapshot_sha256: parsed.snapshot_sha256.clone(),
                    byte_size: parsed.byte_size,
                    chunks: HashMap::new(),
                },
            );
        }
        let stored = self.sessions.get(&key).map(|s| s.stored_bytes()).unwrap_or(0);
        let incoming = parsed.bytes.len();
        let replacing = self
            .sessions
            .get(&key)
            .and_then(|s| s.chunks.get(&parsed.chunk_index))
            .map(|c| c.bytes.len())
            .unwrap_or(0);
        if stored.saturating_sub(replacing).saturating_add(incoming) > MAX_SNAPSHOT_BYTES {
            if self
                .sessions
                .get(&key)
                .map(|s| s.chunks.is_empty())
                .unwrap_or(false)
            {
                self.sessions.remove(&key);
            }
            return Err(ProtocolError::new(
                ErrorCode::PayloadTooLarge,
                Layer::Size,
                "assembler snapshot exceeds 2 MiB",
            ));
        }
        let (result, remove_empty) = {
            let session = self.sessions.get_mut(&key).ok_or_else(|| {
                ProtocolError::new(ErrorCode::Unavailable, Layer::Business, "snapshot session missing")
            })?;
            if session.chunk_count != parsed.chunk_count
                || session.snapshot_sha256 != parsed.snapshot_sha256
                || session.byte_size != parsed.byte_size
                || session.application_id != parsed.application_id
                || session.snapshot_id != parsed.snapshot_id
                || session.source_restore_epoch != parsed.source_restore_epoch
            {
                return Err(ProtocolError::new(
                    ErrorCode::Conflict,
                    Layer::Business,
                    "snapshot metadata does not match the existing session",
                ));
            }
            if let Some(existing) = session.chunks.get(&parsed.chunk_index) {
                if existing.message_id != req.message_id
                    || existing.identity_sha256 != parsed.identity_sha256
                    || existing.chunk_sha256 != parsed.chunk_sha256
                    || existing.application_id != parsed.application_id
                    || existing.bytes != parsed.bytes
                {
                    return Err(ProtocolError::new(
                        ErrorCode::Conflict,
                        Layer::Business,
                        "same chunk identity with different content or messageId",
                    ));
                }
                return Ok(outcome(session, parsed.chunk_index, true));
            }
            if session
                .chunks
                .values()
                .any(|other| other.message_id == req.message_id)
            {
                return Err(ProtocolError::new(
                    ErrorCode::Conflict,
                    Layer::Business,
                    "chunk messageId is already bound to another chunkIndex",
                ));
            }
            session.chunks.insert(
                parsed.chunk_index,
                ChunkRecord {
                    message_id: req.message_id.clone(),
                    chunk_index: parsed.chunk_index,
                    application_id: parsed.application_id,
                    chunk_sha256: parsed.chunk_sha256,
                    identity_sha256: parsed.identity_sha256,
                    bytes: parsed.bytes,
                },
            );
            if session.all_indexes_present() && !session.integrity_verified() {
                session.chunks.remove(&parsed.chunk_index);
                (None, session.chunks.is_empty())
            } else {
                (Some(outcome(session, parsed.chunk_index, false)), false)
            }
        };
        if remove_empty {
            self.sessions.remove(&key);
        }
        result.ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Business,
                "assembled snapshot length or snapshotSha256 mismatch",
            )
        })
    }

    pub fn session(&self, client: &str, snapshot: &str, epoch: &str) -> Option<&SnapshotSession> {
        self.sessions.get(&Self::session_key(client, snapshot, epoch))
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    /// Drop an in-memory session after persist, cancel, or failure. Durable replay uses receipts.
    pub fn forget(&mut self, client: &str, snapshot: &str, epoch: &str) -> bool {
        self.sessions
            .remove(&Self::session_key(client, snapshot, epoch))
            .is_some()
    }

    pub fn cancel(&mut self, client: &str, snapshot: &str, epoch: &str) -> bool {
        self.forget(client, snapshot, epoch)
    }
}

fn outcome(session: &SnapshotSession, chunk_index: u32, replay: bool) -> AssemblerOutcome {
    AssemblerOutcome {
        chunk_index,
        chunk_cursor: session.chunk_cursor(),
        replay,
        integrity: if session.integrity_verified() {
            Integrity::VerifiedInMemory
        } else {
            Integrity::Partial
        },
    }
}

struct ParsedChunk {
    snapshot_id: String,
    application_id: String,
    source_restore_epoch: String,
    chunk_index: u32,
    chunk_count: u32,
    chunk_sha256: String,
    snapshot_sha256: String,
    identity_sha256: String,
    byte_size: usize,
    bytes: Vec<u8>,
}

fn payload_str(payload: &Value, key: &str) -> Result<String, ProtocolError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                format!("snapshot.chunk missing {key}"),
            )
        })
}

fn payload_u32(payload: &Value, key: &str) -> Result<u32, ProtocolError> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                format!("snapshot.chunk missing integer {key}"),
            )
        })
}

fn parse_chunk(req: &Request) -> Result<ParsedChunk, ProtocolError> {
    if req.message_type != crate::types::MessageType::SnapshotChunk {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "apply_chunk requires snapshot.chunk",
        ));
    }
    let snapshot_id = payload_str(&req.payload, "snapshotId")?;
    let application_id = payload_str(&req.payload, "applicationId")?;
    let source_restore_epoch = payload_str(&req.payload, "sourceRestoreEpoch")?;
    let chunk_index = payload_u32(&req.payload, "chunkIndex")?;
    let chunk_count = payload_u32(&req.payload, "chunkCount")?;
    if chunk_count == 0 || chunk_count > MAX_CHUNK_COUNT {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "chunkCount must be 1..=128",
        ));
    }
    if chunk_index >= chunk_count {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "chunkIndex must be in 0..chunkCount",
        ));
    }
    let chunk_sha256 = payload_str(&req.payload, "chunkSha256")?;
    let snapshot_sha256 = payload_str(&req.payload, "snapshotSha256")?;
    let byte_size = payload_u32(&req.payload, "byteSize")? as usize;
    if byte_size == 0 || byte_size > MAX_SNAPSHOT_BYTES {
        return Err(ProtocolError::new(
            ErrorCode::PayloadTooLarge,
            Layer::Size,
            "snapshot byteSize exceeds 2 MiB",
        ));
    }
    let decoded = decode_standard_base64(&payload_str(&req.payload, "bytesBase64")?)?;
    if decoded.is_empty() || decoded.len() > byte_size {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "decoded chunk length is empty or exceeds snapshot byteSize",
        ));
    }
    if sha256_hex(&decoded) != chunk_sha256 {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            Layer::Structure,
            "chunkSha256 does not match decoded bytes",
        ));
    }
    let identity_sha256 = crate::digest::snapshot_chunk_identity_sha256(&req.payload)?;
    Ok(ParsedChunk {
        snapshot_id,
        application_id,
        source_restore_epoch,
        chunk_index,
        chunk_count,
        chunk_sha256,
        snapshot_sha256,
        identity_sha256,
        byte_size,
        bytes: decoded,
    })
}

/// Chunk ACK that may be returned immediately after a valid chunk is accepted.
/// Never a durable complete-snapshot ACK.
pub fn plugin_chunk_ack_payload(outcome: &AssemblerOutcome) -> Value {
    serde_json::json!({
        "ackKind": "chunk",
        "chunkIndex": outcome.chunk_index,
        "chunkCursor": outcome.chunk_cursor,
    })
}

/// Call only after D03 confirms the assembled snapshot is persisted.
pub fn plugin_snapshot_ack_payload(snapshot_id: &str, chunk_index: u32, chunk_cursor: u32) -> Value {
    serde_json::json!({
        "ackKind": "snapshot",
        "snapshotId": snapshot_id,
        "chunkIndex": chunk_index,
        "chunkCursor": chunk_cursor,
    })
}

pub fn ack_kind_for_plugin(_outcome: &AssemblerOutcome) -> AckKind {
    AckKind::Chunk
}

#[cfg(test)]
mod tests {
    use super::ack_kind_for_plugin;
    use crate::types::AckKind;

    #[test]
    fn assembler_never_emits_persistent_snapshot_ack() {
        let outcome = crate::snapshot::AssemblerOutcome {
            chunk_index: 1,
            chunk_cursor: 2,
            replay: false,
            integrity: crate::snapshot::Integrity::VerifiedInMemory,
        };
        assert_eq!(ack_kind_for_plugin(&outcome), AckKind::Chunk);
        assert!(outcome.ready_to_persist());
    }
}
