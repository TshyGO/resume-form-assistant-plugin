use std::collections::HashMap;

use crate::error::{ErrorCode, Layer, ProtocolError};
use crate::types::{AckKind, Request};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkRecord {
    pub message_id: String,
    pub chunk_index: u32,
    pub chunk_sha256: String,
    pub acked: bool,
}

#[derive(Debug, Clone)]
pub struct SnapshotSession {
    pub snapshot_id: String,
    pub client_instance_id: String,
    pub source_restore_epoch: String,
    pub chunk_count: u32,
    pub snapshot_sha256: String,
    pub chunks: HashMap<u32, ChunkRecord>,
}

impl SnapshotSession {
    pub fn chunk_cursor(&self) -> u32 {
        let mut cursor = 0;
        while self
            .chunks
            .get(&cursor)
            .map(|c| c.acked)
            .unwrap_or(false)
        {
            cursor += 1;
        }
        cursor
    }

    pub fn complete(&self) -> bool {
        self.chunk_cursor() == self.chunk_count
            && (0..self.chunk_count).all(|i| self.chunks.get(&i).map(|c| c.acked).unwrap_or(false))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkAck {
    pub ack_kind: AckKind,
    pub chunk_index: u32,
    pub chunk_cursor: u32,
    pub replay: bool,
}

/// In-memory assembler for contract tests. Durable persistence is D03.
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

    pub fn apply_chunk(&mut self, req: &Request) -> Result<ChunkAck, ProtocolError> {
        if req.message_type != crate::types::MessageType::SnapshotChunk {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                Layer::Structure,
                "apply_chunk requires snapshot.chunk",
            ));
        }
        let snapshot_id = req.payload.get("snapshotId").unwrap().as_str().unwrap().to_string();
        let source_restore_epoch = req
            .payload
            .get("sourceRestoreEpoch")
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        let chunk_index = req.payload.get("chunkIndex").unwrap().as_u64().unwrap() as u32;
        let chunk_count = req.payload.get("chunkCount").unwrap().as_u64().unwrap() as u32;
        let chunk_sha256 = req.payload.get("chunkSha256").unwrap().as_str().unwrap().to_string();
        let snapshot_sha256 = req
            .payload
            .get("snapshotSha256")
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        let key = Self::session_key(&req.client_instance_id, &snapshot_id, &source_restore_epoch);
        let session = self.sessions.entry(key).or_insert_with(|| SnapshotSession {
            snapshot_id: snapshot_id.clone(),
            client_instance_id: req.client_instance_id.clone(),
            source_restore_epoch: source_restore_epoch.clone(),
            chunk_count,
            snapshot_sha256: snapshot_sha256.clone(),
            chunks: HashMap::new(),
        });
        if session.chunk_count != chunk_count || session.snapshot_sha256 != snapshot_sha256 {
            return Err(ProtocolError::new(
                ErrorCode::Conflict,
                Layer::Business,
                "snapshot metadata does not match the existing session",
            ));
        }
        if let Some(existing) = session.chunks.get(&chunk_index) {
            if existing.message_id != req.message_id || existing.chunk_sha256 != chunk_sha256 {
                return Err(ProtocolError::new(
                    ErrorCode::Conflict,
                    Layer::Business,
                    "same chunk identity with different content or messageId",
                ));
            }
            let cursor = session.chunk_cursor();
            return Ok(ChunkAck {
                ack_kind: if session.complete() {
                    AckKind::Snapshot
                } else {
                    AckKind::Chunk
                },
                chunk_index,
                chunk_cursor: cursor,
                replay: true,
            });
        }
        for other in session.chunks.values() {
            if other.message_id == req.message_id {
                return Err(ProtocolError::new(
                    ErrorCode::Conflict,
                    Layer::Business,
                    "chunk messageId is already bound to another chunkIndex",
                ));
            }
        }
        session.chunks.insert(
            chunk_index,
            ChunkRecord {
                message_id: req.message_id.clone(),
                chunk_index,
                chunk_sha256,
                acked: true,
            },
        );
        let cursor = session.chunk_cursor();
        let complete = session.complete();
        Ok(ChunkAck {
            ack_kind: if complete {
                AckKind::Snapshot
            } else {
                AckKind::Chunk
            },
            chunk_index,
            chunk_cursor: cursor,
            replay: false,
        })
    }

    pub fn session(&self, client: &str, snapshot: &str, epoch: &str) -> Option<&SnapshotSession> {
        self.sessions.get(&Self::session_key(client, snapshot, epoch))
    }
}

pub fn chunk_ack_payload(ack: &ChunkAck, snapshot_id: &str) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "ackKind": match ack.ack_kind {
            AckKind::Chunk => "chunk",
            AckKind::Snapshot => "snapshot",
        },
        "chunkIndex": ack.chunk_index,
        "chunkCursor": ack.chunk_cursor,
    });
    if ack.ack_kind == AckKind::Snapshot {
        payload
            .as_object_mut()
            .unwrap()
            .insert("snapshotId".into(), serde_json::Value::String(snapshot_id.into()));
    }
    payload
}
