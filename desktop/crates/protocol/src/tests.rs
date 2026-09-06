use std::collections::HashMap;

use serde_json::{json, Value};

use crate::identity::check_current_identity;
use crate::receipts::{evaluate_write, reconcile, reconcile_grants_replay};
use crate::snapshot::ChunkAssembler;
use crate::types::{
    CurrentArchive, MessageKey, MessageType, ReceiptStore, ReconcileStatusKind, StoredOutcome,
    WriteDecision, MAX_ENVELOPE_BYTES,
};
use crate::validate::{utf8_json_len, validate_request_bytes, validate_request_value, validate_response_value};
use crate::{origin_allowed, ProtocolError};

const ARCHIVE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EPOCH: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EPOCH_OLD: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENT_A: &str = "11111111-1111-4111-8111-111111111111";
const CLIENT_B: &str = "22222222-2222-4222-8222-222222222222";
const MSG: &str = "33333333-3333-4333-8333-333333333333";
const MSG2: &str = "44444444-4444-4444-8444-444444444444";
const HASH: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HASH2: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RESULT: &str = "55555555-5555-4555-8555-555555555555";
const SNAP: &str = "66666666-6666-4666-8666-666666666666";
const APP: &str = "77777777-7777-4777-8777-777777777777";

fn current() -> CurrentArchive {
    CurrentArchive {
        archive_id: ARCHIVE.into(),
        restore_epoch: EPOCH.into(),
    }
}

fn envelope(message_type: &str, payload: Value) -> Value {
    let mut v = json!({
        "protocolVersion": 1,
        "messageId": MSG,
        "clientInstanceId": CLIENT_A,
        "messageType": message_type,
        "occurredAt": "2026-09-06T12:00:00.000Z",
        "payload": payload
    });
    if !matches!(message_type, "health" | "handshake") {
        v.as_object_mut().unwrap().insert("archiveId".into(), json!(ARCHIVE));
        v.as_object_mut()
            .unwrap()
            .insert("restoreEpoch".into(), json!(EPOCH));
    }
    v
}

fn job_save_payload() -> Value {
    json!({
        "sourceRestoreEpoch": EPOCH,
        "payloadSha256": HASH,
        "company": "合成公司",
        "title": "后端实习"
    })
}

struct MapStore(HashMap<MessageKey, StoredOutcome>);

impl ReceiptStore for MapStore {
    fn get(&self, key: &MessageKey) -> Option<StoredOutcome> {
        self.0.get(key).cloned()
    }
}

fn assert_code(err: ProtocolError, code: &str) {
    assert_eq!(err.code.as_str(), code, "{err}");
}

#[test]
fn health_and_handshake_ok() {
    let health = envelope("health", json!({}));
    validate_request_value(&health).unwrap();
    let hs = envelope(
        "handshake",
        json!({
            "pluginVersion": "0.3.0",
            "minProtocolVersion": 1,
            "maxProtocolVersion": 1
        }),
    );
    let req = validate_request_value(&hs).unwrap();
    assert_eq!(req.message_type, MessageType::Handshake);
    check_current_identity(&req, Some(&current())).unwrap();
}

#[test]
fn handshake_incompatible_version() {
    let mut hs = envelope(
        "handshake",
        json!({
            "pluginVersion": "9.0.0",
            "minProtocolVersion": 9,
            "maxProtocolVersion": 9
        }),
    );
    assert_code(validate_request_value(&hs).unwrap_err(), "protocol_incompatible");
    hs.as_object_mut()
        .unwrap()
        .insert("protocolVersion".into(), json!(9));
    assert_code(validate_request_value(&hs).unwrap_err(), "protocol_incompatible");
}

#[test]
fn health_and_handshake_must_not_carry_identity() {
    for ty in ["health", "handshake"] {
        let mut v = envelope(ty, if ty == "health" {
            json!({})
        } else {
            json!({"pluginVersion":"0.3.0","minProtocolVersion":1,"maxProtocolVersion":1})
        });
        v.as_object_mut().unwrap().insert("archiveId".into(), json!(ARCHIVE));
        v.as_object_mut()
            .unwrap()
            .insert("restoreEpoch".into(), json!(EPOCH));
        assert_code(validate_request_value(&v).unwrap_err(), "identity_not_allowed");
    }
}

#[test]
fn writes_require_identity_and_reject_unknown_type() {
    let mut v = envelope("job.save", job_save_payload());
    v.as_object_mut().unwrap().remove("archiveId");
    assert_code(validate_request_value(&v).unwrap_err(), "identity_missing");
    let unknown = envelope("job.delete", json!({}));
    assert_code(validate_request_value(&unknown).unwrap_err(), "unknown_message_type");
    let intent = envelope("SaveIntent", json!({"intentId": MSG}));
    assert_code(validate_request_value(&intent).unwrap_err(), "unknown_message_type");
}

#[test]
fn success_and_error_response_constraints() {
    let ok = json!({
        "protocolVersion": 1,
        "correlationId": MSG,
        "ok": true,
        "resultId": RESULT,
        "payload": {}
    });
    validate_response_value(&ok, MessageType::JobSave).unwrap();
    let missing_result = json!({
        "protocolVersion": 1,
        "correlationId": MSG,
        "ok": true,
        "payload": {}
    });
    assert!(validate_response_value(&missing_result, MessageType::JobSave).is_err());
    let err_with_result = json!({
        "protocolVersion": 1,
        "correlationId": MSG,
        "ok": false,
        "resultId": RESULT,
        "error": {"code": "conflict", "retryable": false},
        "payload": {}
    });
    assert!(validate_response_value(&err_with_result, MessageType::JobSave).is_err());
    let err_ok = json!({
        "protocolVersion": 1,
        "correlationId": MSG,
        "ok": false,
        "error": {"code": "restore_epoch_mismatch", "retryable": false},
        "payload": {}
    });
    validate_response_value(&err_ok, MessageType::JobSave).unwrap();
}

#[test]
fn chinese_content_counts_utf8_bytes_not_chars() {
    let v = envelope("job.save", job_save_payload());
    let bytes = serde_json::to_vec(&v).unwrap();
    assert_eq!(bytes.len(), utf8_json_len(&v));
    assert!(bytes.len() < MAX_ENVELOPE_BYTES);
    let company = v["payload"]["company"].as_str().unwrap();
    assert_eq!(company.chars().count(), 4);
    assert_eq!(company.len(), 12);
}

fn padded_job_save(target: usize) -> Vec<u8> {
    let mut payload = job_save_payload();
    payload
        .as_object_mut()
        .unwrap()
        .insert("location".into(), json!(""));
    let base = serde_json::to_vec(&envelope("job.save", payload.clone())).unwrap();
    assert!(base.len() < target, "base envelope already {0} bytes", base.len());
    payload
        .as_object_mut()
        .unwrap()
        .insert("location".into(), json!("a".repeat(target - base.len())));
    let bytes = serde_json::to_vec(&envelope("job.save", payload)).unwrap();
    assert_eq!(bytes.len(), target);
    bytes
}

#[test]
fn envelope_size_65536_ok_65537_rejected() {
    let ok = padded_job_save(65536);
    assert_eq!(ok.len(), 65536);
    validate_request_bytes(&ok).unwrap();
    let mut too_big = ok.clone();
    too_big.push(b' ');
    assert_eq!(too_big.len(), 65537);
    assert_code(validate_request_bytes(&too_big).unwrap_err(), "payload_too_large");
}

#[test]
fn write_identity_old_epoch_is_not_replay() {
    let mut env = envelope("job.save", job_save_payload());
    env.as_object_mut()
        .unwrap()
        .insert("restoreEpoch".into(), json!(EPOCH_OLD));
    let req = validate_request_value(&env).unwrap();
    let err = check_current_identity(&req, Some(&current())).unwrap_err();
    assert_code(err, "restore_epoch_mismatch");
    let mut payload = job_save_payload();
    payload
        .as_object_mut()
        .unwrap()
        .insert("sourceRestoreEpoch".into(), json!(EPOCH_OLD));
    let env = envelope("job.save", payload);
    let req = validate_request_value(&env).unwrap();
    let err = check_current_identity(&req, Some(&current())).unwrap_err();
    assert_code(err, "restore_epoch_mismatch");
}

#[test]
fn replay_conflict_purge_and_profile_isolation() {
    let req = validate_request_value(&envelope("job.save", job_save_payload())).unwrap();
    let key = MessageKey {
        client_instance_id: CLIENT_A.into(),
        message_id: MSG.into(),
        source_restore_epoch: EPOCH.into(),
    };
    let mut map = HashMap::new();
    map.insert(
        key.clone(),
        StoredOutcome::Applied {
            result_id: RESULT.into(),
            payload_sha256: HASH.into(),
        },
    );
    let store = MapStore(map.clone());
    match evaluate_write(&req, Some(&current()), &store).unwrap() {
        WriteDecision::Replay { result_id } => assert_eq!(result_id, RESULT),
        other => panic!("{other:?}"),
    }
    let mut other_hash = job_save_payload();
    other_hash
        .as_object_mut()
        .unwrap()
        .insert("payloadSha256".into(), json!(HASH2));
    let req2 = validate_request_value(&envelope("job.save", other_hash)).unwrap();
    assert_eq!(
        evaluate_write(&req2, Some(&current()), &store).unwrap(),
        WriteDecision::Conflict
    );
    let mut purged = HashMap::new();
    purged.insert(
        key,
        StoredOutcome::Purged {
            payload_sha256: HASH.into(),
        },
    );
    assert_eq!(
        evaluate_write(&req, Some(&current()), &MapStore(purged)).unwrap(),
        WriteDecision::PreviouslyPurged
    );
    let mut env_b = envelope("job.save", job_save_payload());
    env_b
        .as_object_mut()
        .unwrap()
        .insert("clientInstanceId".into(), json!(CLIENT_B));
    let req_b = validate_request_value(&env_b).unwrap();
    assert_eq!(
        evaluate_write(&req_b, Some(&current()), &store).unwrap(),
        WriteDecision::Accept
    );
}

fn chunk(index: u32, count: u32, message_id: &str) -> Value {
    let mut v = envelope(
        "snapshot.chunk",
        json!({
            "sourceRestoreEpoch": EPOCH,
            "snapshotId": SNAP,
            "applicationId": APP,
            "chunkIndex": index,
            "chunkCount": count,
            "chunkSha256": HASH,
            "snapshotSha256": HASH2,
            "byteSize": 12,
            "bytesBase64": "5Lit5paH"
        }),
    );
    v.as_object_mut()
        .unwrap()
        .insert("messageId".into(), json!(message_id));
    v
}

#[test]
fn snapshot_chunks_cursor_acks_and_conflicts() {
    let mut asm = ChunkAssembler::new();
    let c0 = validate_request_value(&chunk(0, 2, MSG)).unwrap();
    let a0 = asm.apply_chunk(&c0).unwrap();
    assert_eq!(a0.ack_kind, crate::AckKind::Chunk);
    assert_eq!(a0.chunk_cursor, 1);
    let c1 = validate_request_value(&chunk(1, 2, MSG2)).unwrap();
    let a1 = asm.apply_chunk(&c1).unwrap();
    assert_eq!(a1.ack_kind, crate::AckKind::Snapshot);
    assert_eq!(a1.chunk_cursor, 2);
    let replay = asm.apply_chunk(&c0).unwrap();
    assert!(replay.replay);
    assert_eq!(replay.ack_kind, crate::AckKind::Snapshot);

    let mut asm = ChunkAssembler::new();
    let later = validate_request_value(&chunk(1, 2, MSG2)).unwrap();
    let ack = asm.apply_chunk(&later).unwrap();
    assert_eq!(ack.ack_kind, crate::AckKind::Chunk);
    assert_eq!(ack.chunk_cursor, 0, "later ACK must not advance cursor");
    assert!(!asm.session(CLIENT_A, SNAP, EPOCH).unwrap().complete());

    let mut conflict_payload = chunk(0, 2, MSG);
    conflict_payload["payload"]["chunkSha256"] = json!(HASH2);
    let bad = validate_request_value(&conflict_payload).unwrap();
    let mut asm = ChunkAssembler::new();
    asm.apply_chunk(&c0).unwrap();
    assert_eq!(asm.apply_chunk(&bad).unwrap_err().code.as_str(), "conflict");
}

#[test]
fn missing_chunk_and_restart_reuses_message_id() {
    let mut asm = ChunkAssembler::new();
    let c1 = validate_request_value(&chunk(1, 2, MSG2)).unwrap();
    asm.apply_chunk(&c1).unwrap();
    assert_eq!(asm.session(CLIENT_A, SNAP, EPOCH).unwrap().chunk_cursor(), 0);
    let c0 = validate_request_value(&chunk(0, 2, MSG)).unwrap();
    let ack = asm.apply_chunk(&c0).unwrap();
    assert_eq!(ack.ack_kind, crate::AckKind::Snapshot);
    let mut restarted = ChunkAssembler::new();
    let again = restarted.apply_chunk(&c0).unwrap();
    assert!(!again.replay);
    let replay = restarted.apply_chunk(&c0).unwrap();
    assert!(replay.replay);
}

#[test]
fn outbox_reconcile_is_read_only_and_echoes_full_identity() {
    let req = validate_request_value(&envelope(
        "outbox.reconcile",
        json!({
            "items": [
                {
                    "clientInstanceId": CLIENT_A,
                    "messageId": MSG,
                    "sourceRestoreEpoch": EPOCH_OLD,
                    "payloadSha256": HASH
                },
                {
                    "clientInstanceId": CLIENT_A,
                    "messageId": MSG2,
                    "sourceRestoreEpoch": EPOCH_OLD,
                    "payloadSha256": HASH2
                }
            ]
        }),
    ))
    .unwrap();
    check_current_identity(&req, Some(&current())).unwrap();
    let mut map = HashMap::new();
    map.insert(
        MessageKey {
            client_instance_id: CLIENT_A.into(),
            message_id: MSG.into(),
            source_restore_epoch: EPOCH_OLD.into(),
        },
        StoredOutcome::Applied {
            result_id: RESULT.into(),
            payload_sha256: HASH.into(),
        },
    );
    map.insert(
        MessageKey {
            client_instance_id: CLIENT_A.into(),
            message_id: MSG2.into(),
            source_restore_epoch: EPOCH_OLD.into(),
        },
        StoredOutcome::Purged {
            payload_sha256: HASH2.into(),
        },
    );
    let rows = reconcile(&req, Some(&current()), &MapStore(map)).unwrap();
    assert_eq!(rows[0].status, ReconcileStatusKind::Applied);
    assert_eq!(rows[0].result_id.as_deref(), Some(RESULT));
    assert_eq!(rows[0].source_restore_epoch, EPOCH_OLD);
    assert_eq!(rows[1].status, ReconcileStatusKind::Purged);
    assert!(rows[1].result_id.is_none());
    assert!(!reconcile_grants_replay(&rows[0]));
    let mut write = envelope("job.save", job_save_payload());
    write["payload"]["sourceRestoreEpoch"] = json!(EPOCH_OLD);
    let write_req = validate_request_value(&write).unwrap();
    assert_eq!(
        check_current_identity(&write_req, Some(&current()))
            .unwrap_err()
            .code
            .as_str(),
        "restore_epoch_mismatch"
    );
}

#[test]
fn reconcile_not_found_conflict_unverifiable() {
    let req = validate_request_value(&envelope(
        "outbox.reconcile",
        json!({
            "items": [{
                "clientInstanceId": CLIENT_A,
                "messageId": MSG,
                "sourceRestoreEpoch": EPOCH_OLD,
                "payloadSha256": HASH
            }]
        }),
    ))
    .unwrap();
    let empty = MapStore(HashMap::new());
    assert_eq!(
        reconcile(&req, Some(&current()), &empty).unwrap()[0].status,
        ReconcileStatusKind::NotFound
    );
    let mut conflict = HashMap::new();
    conflict.insert(
        MessageKey {
            client_instance_id: CLIENT_A.into(),
            message_id: MSG.into(),
            source_restore_epoch: EPOCH_OLD.into(),
        },
        StoredOutcome::Applied {
            result_id: RESULT.into(),
            payload_sha256: HASH2.into(),
        },
    );
    assert_eq!(
        reconcile(&req, Some(&current()), &MapStore(conflict)).unwrap()[0].status,
        ReconcileStatusKind::Conflict
    );
    let mut unver = HashMap::new();
    unver.insert(
        MessageKey {
            client_instance_id: CLIENT_A.into(),
            message_id: MSG.into(),
            source_restore_epoch: EPOCH_OLD.into(),
        },
        StoredOutcome::Unverifiable,
    );
    assert_eq!(
        reconcile(&req, Some(&current()), &MapStore(unver)).unwrap()[0].status,
        ReconcileStatusKind::Unverifiable
    );
}

#[test]
fn structure_ok_is_not_permission_to_write() {
    let req = validate_request_value(&envelope("job.save", job_save_payload())).unwrap();
    assert!(check_current_identity(&req, None).is_err());
    let foreign = CurrentArchive {
        archive_id: ARCHIVE.into(),
        restore_epoch: EPOCH_OLD.into(),
    };
    assert_eq!(
        check_current_identity(&req, Some(&foreign))
            .unwrap_err()
            .code
            .as_str(),
        "restore_epoch_mismatch"
    );
}

#[test]
fn secrets_and_origins() {
    let mut payload = job_save_payload();
    payload.as_object_mut().unwrap().insert("apiKey".into(), json!("sk-test"));
    assert_eq!(
        validate_request_value(&envelope("job.save", payload))
            .unwrap_err()
            .code
            .as_str(),
        "secret_forbidden"
    );
    assert!(origin_allowed(
        "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/",
        &["chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/".into()]
    ));
    assert!(!origin_allowed("chrome-extension://*/", &["chrome-extension://*/".into()]));
}

#[test]
fn query_candidates_and_fill_submit_ok() {
    validate_request_value(&envelope(
        "application.queryCandidates",
        json!({"company": "合成公司"}),
    ))
    .unwrap();
    validate_request_value(&envelope(
        "fill.submit",
        json!({
            "sourceRestoreEpoch": EPOCH,
            "payloadSha256": HASH,
            "applicationId": APP,
            "snapshotId": SNAP,
            "sha256": HASH2
        }),
    ))
    .unwrap();
    validate_request_value(&envelope(
        "submit.confirm",
        json!({
            "sourceRestoreEpoch": EPOCH,
            "payloadSha256": HASH,
            "applicationId": APP
        }),
    ))
    .unwrap();
}

#[test]
fn fixtures_on_disk_match_validator() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/requests");
    let health = std::fs::read(root.join("health-ok.json")).unwrap();
    validate_request_bytes(&health).unwrap();
    let save = std::fs::read(root.join("job-save-ok.json")).unwrap();
    validate_request_bytes(&save).unwrap();
    let response = serde_json::from_slice(&std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/responses/job-save-error.json"),
    )
    .unwrap())
    .unwrap();
    validate_response_value(&response, MessageType::JobSave).unwrap();
}

#[test]
fn snapshot_chunk_ack_kinds_are_distinct() {
    let chunk_ack = json!({
        "protocolVersion": 1,
        "correlationId": MSG,
        "ok": true,
        "resultId": RESULT,
        "payload": {"ackKind": "chunk", "chunkIndex": 0, "chunkCursor": 1}
    });
    validate_response_value(&chunk_ack, MessageType::SnapshotChunk).unwrap();
    let complete = json!({
        "protocolVersion": 1,
        "correlationId": MSG2,
        "ok": true,
        "resultId": RESULT,
        "payload": {"ackKind": "snapshot", "chunkIndex": 1, "chunkCursor": 2}
    });
    validate_response_value(&complete, MessageType::SnapshotChunk).unwrap();
    let missing_kind = json!({
        "protocolVersion": 1,
        "correlationId": MSG,
        "ok": true,
        "resultId": RESULT,
        "payload": {"chunkIndex": 0}
    });
    assert!(validate_response_value(&missing_kind, MessageType::SnapshotChunk).is_err());
}
