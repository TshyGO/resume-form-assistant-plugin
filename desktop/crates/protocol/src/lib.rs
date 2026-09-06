//! D05 plugin–desktop communication contract.
//!
//! JSON Schema files in `schemas/` are the shared shape. This crate (and
//! `js/validate.mjs`) enforce size, identity presence, secrets, and the
//! write/reconcile decision order. Matching the desktop *current* pointer is a
//! business check for D03/D06 — schema validation never treats that as proven.

mod error;
mod identity;
mod receipts;
mod secrets;
mod snapshot;
mod types;
mod validate;

pub use error::{ErrorCode, Layer, ProtocolError};
pub use identity::{check_current_identity, handshake_response_payload, origin_allowed};
pub use receipts::{evaluate_write, reconcile, reconcile_grants_replay, write_key};
pub use snapshot::{chunk_ack_payload, ChunkAck, ChunkAssembler, SnapshotSession};
pub use types::*;
pub use validate::{
    payload_sha256, source_restore_epoch, utf8_json_len, validate_request_bytes, validate_request_value,
    validate_response_value,
};

pub const RULES_JSON: &str = include_str!("../rules.json");

#[cfg(test)]
mod tests;
