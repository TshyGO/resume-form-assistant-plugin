use std::collections::HashMap;

use serde_json::{json, Value};

use base64::Engine;

use crate::digest::{payload_body_sha256, sha256_hex, snapshot_chunk_identity_sha256};
use crate::identity::check_current_identity;
use crate::receipts::{evaluate_write, reconcile, reconcile_grants_replay};
use crate::schema_lite::{
    envelope_schema, payload_schema, response_payload_schema, response_schema, validate_schema,
};
use crate::snapshot::{plugin_chunk_ack_payload, plugin_snapshot_ack_payload, ChunkAssembler, Integrity};
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

fn stamp_digest(payload: &mut Value) {
    let digest = payload_body_sha256(payload).unwrap();
    payload
        .as_object_mut()
        .unwrap()
        .insert("payloadSha256".into(), json!(digest));
}

fn job_save_payload() -> Value {
    let mut payload = json!({
        "sourceRestoreEpoch": EPOCH,
        "company": "合成公司",
        "title": "后端实习"
    });
    stamp_digest(&mut payload);
    payload
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
    stamp_digest(&mut payload);
    let base = serde_json::to_vec(&envelope("job.save", payload.clone())).unwrap();
    assert!(base.len() < target, "base envelope already {0} bytes", base.len());
    payload
        .as_object_mut()
        .unwrap()
        .insert("location".into(), json!("a".repeat(target - base.len())));
    stamp_digest(&mut payload);
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
    stamp_digest(&mut payload);
    let env = envelope("job.save", payload);
    let req = validate_request_value(&env).unwrap();
    let err = check_current_identity(&req, Some(&current())).unwrap_err();
    assert_code(err, "restore_epoch_mismatch");
}

#[test]
fn replay_conflict_purge_and_profile_isolation() {
    let save_payload = job_save_payload();
    let digest = save_payload["payloadSha256"].as_str().unwrap().to_string();
    let req = validate_request_value(&envelope("job.save", save_payload.clone())).unwrap();
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
            payload_sha256: digest.clone(),
        },
    );
    let store = MapStore(map.clone());
    match evaluate_write(&req, Some(&current()), &store).unwrap() {
        WriteDecision::Replay { result_id } => assert_eq!(result_id, RESULT),
        other => panic!("{other:?}"),
    }
    let mut other_hash = save_payload.clone();
    other_hash.as_object_mut().unwrap().insert("title".into(), json!("另一岗位"));
    let other_digest = payload_body_sha256(&other_hash).unwrap();
    other_hash
        .as_object_mut()
        .unwrap()
        .insert("payloadSha256".into(), json!(other_digest));
    let req2 = validate_request_value(&envelope("job.save", other_hash)).unwrap();
    assert_eq!(
        evaluate_write(&req2, Some(&current()), &store).unwrap(),
        WriteDecision::Conflict
    );
    let mut purged = HashMap::new();
    purged.insert(
        key,
        StoredOutcome::Purged {
            payload_sha256: digest,
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

fn load_fixture(rel: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(rel);
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn chunk_fixture(rel: &str) -> Value {
    load_fixture(rel)
}

#[test]
fn snapshot_chunks_cursor_acks_and_conflicts() {
    let mut asm = ChunkAssembler::new();
    let c0 = validate_request_value(&chunk_fixture("requests/snapshot-chunk-0-ok.json")).unwrap();
    let a0 = asm.apply_chunk(&c0).unwrap();
    assert_eq!(a0.integrity, Integrity::Partial);
    assert_eq!(a0.chunk_cursor, 1);
    assert!(!a0.ready_to_persist());
    let c1 = validate_request_value(&chunk_fixture("requests/snapshot-chunk-1-ok.json")).unwrap();
    let a1 = asm.apply_chunk(&c1).unwrap();
    assert_eq!(a1.integrity, Integrity::VerifiedInMemory);
    assert_eq!(a1.chunk_cursor, 2);
    assert!(a1.ready_to_persist());
    let replay = asm.apply_chunk(&c0).unwrap();
    assert!(replay.replay);
    assert_eq!(replay.integrity, Integrity::VerifiedInMemory);

    let mut asm = ChunkAssembler::new();
    let later = validate_request_value(&chunk_fixture("requests/snapshot-chunk-1-ok.json")).unwrap();
    let ack = asm.apply_chunk(&later).unwrap();
    assert_eq!(ack.integrity, Integrity::Partial);
    assert_eq!(ack.chunk_cursor, 0, "later ACK must not advance cursor");
    assert!(!asm.session(CLIENT_A, SNAP, EPOCH).unwrap().integrity_verified());
}

#[test]
fn missing_chunk_and_restart_reuses_message_id() {
    let mut asm = ChunkAssembler::new();
    let c1 = validate_request_value(&chunk_fixture("requests/snapshot-chunk-1-ok.json")).unwrap();
    asm.apply_chunk(&c1).unwrap();
    assert_eq!(asm.session(CLIENT_A, SNAP, EPOCH).unwrap().chunk_cursor(), 0);
    let c0 = validate_request_value(&chunk_fixture("requests/snapshot-chunk-0-ok.json")).unwrap();
    let ack = asm.apply_chunk(&c0).unwrap();
    assert_eq!(ack.integrity, Integrity::VerifiedInMemory);
    let mut restarted = ChunkAssembler::new();
    let again = restarted.apply_chunk(&c0).unwrap();
    assert!(!again.replay);
    let replay = restarted.apply_chunk(&c0).unwrap();
    assert!(replay.replay);
}

#[test]
fn corrupt_snapshot_does_not_yield_complete_integrity() {
    let wrong = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let mut first = chunk_fixture("requests/snapshot-chunk-0-ok.json");
    let mut second = chunk_fixture("requests/snapshot-chunk-1-ok.json");
    first["payload"]["snapshotSha256"] = json!(wrong);
    second["payload"]["snapshotSha256"] = json!(wrong);
    let mut asm = ChunkAssembler::new();
    let c0 = validate_request_value(&first).unwrap();
    asm.apply_chunk(&c0).unwrap();
    let c1 = validate_request_value(&second).unwrap();
    assert_eq!(asm.apply_chunk(&c1).unwrap_err().code.as_str(), "invalid_payload");
    assert!(!asm.session(CLIENT_A, SNAP, EPOCH).unwrap().integrity_verified());
    assert_eq!(asm.session(CLIENT_A, SNAP, EPOCH).unwrap().chunks.len(), 1);
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
    let mut write_payload = job_save_payload();
    write_payload["sourceRestoreEpoch"] = json!(EPOCH_OLD);
    stamp_digest(&mut write_payload);
    let write = envelope("job.save", write_payload);
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
    payload
        .as_object_mut()
        .unwrap()
        .insert("title".into(), json!("Risk-Management Analyst"));
    let digest = payload_body_sha256(&payload).unwrap();
    payload
        .as_object_mut()
        .unwrap()
        .insert("payloadSha256".into(), json!(digest));
    validate_request_value(&envelope("job.save", payload.clone())).unwrap();
    payload.as_object_mut().unwrap().insert("apiKey".into(), json!("sk-abcdefghijklmnopqrstuvwxyz"));
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
    let fill = load_fixture("requests/fill-submit-ok.json");
    assert_eq!(fill["payload"]["applicationId"].as_str(), Some(APP));
    validate_request_value(&fill).unwrap();
    validate_request_value(&load_fixture("requests/submit-confirm-ok.json")).unwrap();
}

#[test]
fn shared_catalog_agrees_with_schema_and_protocol() {
    let catalog: Value = load_fixture("catalog.json");
    for entry in catalog["requests"].as_array().unwrap() {
        let rel = format!("../fixtures/{}", entry["path"].as_str().unwrap());
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(entry["path"].as_str().unwrap());
        let value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let schema_ok: Result<(), ProtocolError> = (|| {
            validate_schema(&value, &envelope_schema())?;
            if let Some(schema) = payload_schema(value.get("messageType").and_then(Value::as_str).unwrap_or("")) {
                validate_schema(&value["payload"], &schema)?;
            }
            Ok(())
        })();
        if entry["schema"] == "accept" {
            assert!(schema_ok.is_ok(), "{} schema {:?}", entry["id"], schema_ok.err());
        } else {
            assert!(schema_ok.is_err(), "{} schema should reject", entry["id"]);
        }
        let protocol = validate_request_value(&value);
        if entry["protocol"]["accept"] == true {
            assert!(protocol.is_ok(), "{} protocol {:?}", entry["id"], protocol.err());
        } else {
            let err = protocol.unwrap_err();
            assert_eq!(err.code.as_str(), entry["protocol"]["code"].as_str().unwrap(), "{}", entry["id"]);
        }
        let _ = rel;
    }
    for entry in catalog["responses"].as_array().unwrap() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(entry["path"].as_str().unwrap());
        let value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let schema_ok: Result<(), ProtocolError> = (|| {
            validate_schema(&value, &response_schema())?;
            if value.get("ok") == Some(&json!(true)) {
                if let Some(schema) = response_payload_schema(entry["requestType"].as_str().unwrap_or("")) {
                    validate_schema(&value["payload"], &schema)?;
                }
            }
            Ok(())
        })();
        if entry["schema"] == "accept" {
            assert!(schema_ok.is_ok(), "{} response schema {:?}", entry["id"], schema_ok.err());
        } else {
            assert!(schema_ok.is_err(), "{} response schema should reject", entry["id"]);
        }
        let ty = MessageType::parse(entry["requestType"].as_str().unwrap()).unwrap();
        let protocol = validate_response_value(&value, ty);
        if entry["protocol"]["accept"] == true {
            assert!(protocol.is_ok(), "{} {:?}", entry["id"], protocol.err());
        } else {
            assert_eq!(
                protocol.unwrap_err().code.as_str(),
                entry["protocol"]["code"].as_str().unwrap()
            );
        }
    }
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
        "payload": {"ackKind": "snapshot", "snapshotId": SNAP, "chunkIndex": 1, "chunkCursor": 2}
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

#[test]
fn duplicate_chunk_conflict_does_not_pollute_valid_session() {
    let mut asm = ChunkAssembler::new();
    let c0 = validate_request_value(&chunk_fixture("requests/snapshot-chunk-0-ok.json")).unwrap();
    asm.apply_chunk(&c0).unwrap();
    let mut other = chunk_fixture("requests/snapshot-chunk-0-ok.json");
    other["messageId"] = json!(MSG2);
    let bytes = b"01234568";
    other["payload"]["bytesBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
    other["payload"]["chunkSha256"] = json!(sha256_hex(bytes));
    let conflict = validate_request_value(&other).unwrap();
    assert_eq!(asm.apply_chunk(&conflict).unwrap_err().code.as_str(), "conflict");
    let session = asm.session(CLIENT_A, SNAP, EPOCH).unwrap();
    assert_eq!(session.chunks.len(), 1);
    assert_eq!(session.chunks.get(&0).unwrap().message_id, MSG);
    assert_eq!(session.chunks.get(&0).unwrap().bytes, b"01234567");
}

#[test]
fn invalid_chunk_does_not_create_or_pollute_session() {
    let mut asm = ChunkAssembler::new();
    let mut bad = chunk_fixture("requests/snapshot-chunk-0-ok.json");
    bad["payload"]["bytesBase64"] = json!("!!!");
    let mut req = validate_request_value(&chunk_fixture("requests/snapshot-chunk-0-ok.json")).unwrap();
    req.payload
        .as_object_mut()
        .unwrap()
        .insert("bytesBase64".into(), json!("!!!"));
    assert_eq!(asm.apply_chunk(&req).unwrap_err().code.as_str(), "invalid_payload");
    assert!(asm.session(CLIENT_A, SNAP, EPOCH).is_none());
    let _ = bad;
    let good = validate_request_value(&chunk_fixture("requests/snapshot-chunk-0-ok.json")).unwrap();
    asm.apply_chunk(&good).unwrap();
    let mut later = validate_request_value(&chunk_fixture("requests/snapshot-chunk-1-ok.json")).unwrap();
    later
        .payload
        .as_object_mut()
        .unwrap()
        .insert("bytesBase64".into(), json!("!!!!"));
    assert_eq!(asm.apply_chunk(&later).unwrap_err().code.as_str(), "invalid_payload");
    let session = asm.session(CLIENT_A, SNAP, EPOCH).unwrap();
    assert_eq!(session.chunks.len(), 1);
    assert!(!session.integrity_verified());
}

#[test]
fn assembler_session_cap_and_plugin_ack_never_snapshot() {
    let mut asm = ChunkAssembler::new();
    let template = chunk_fixture("requests/snapshot-chunk-0-ok.json");
    for i in 0..16u8 {
        let mut env = template.clone();
        env["payload"]["snapshotId"] = json!(format!("66666666-6666-4666-8666-6666666666{i:02}"));
        let req = validate_request_value(&env).unwrap();
        let outcome = asm.apply_chunk(&req).unwrap();
        assert_eq!(plugin_chunk_ack_payload(&outcome)["ackKind"], "chunk");
        assert_eq!(crate::ack_kind_for_plugin(&outcome), crate::types::AckKind::Chunk);
        assert!(!outcome.ready_to_persist());
    }
    let mut extra = template;
    extra["payload"]["snapshotId"] = json!("66666666-6666-4666-8666-666666666699");
    let req = validate_request_value(&extra).unwrap();
    assert_eq!(asm.apply_chunk(&req).unwrap_err().code.as_str(), "unavailable");
    assert_eq!(asm.session_count(), 16);
    assert!(asm.forget(CLIENT_A, "66666666-6666-4666-8666-666666666600", EPOCH));
    assert_eq!(asm.session_count(), 15);
    let after_release = validate_request_value(&extra).unwrap();
    asm.apply_chunk(&after_release).unwrap();
    assert_eq!(asm.session_count(), 16);
    let persisted = plugin_snapshot_ack_payload(SNAP, 1, 2);
    assert_eq!(persisted["ackKind"], "snapshot");
}

#[test]
fn completed_sessions_can_be_released_and_reused() {
    let mut asm = ChunkAssembler::new();
    let first = chunk_fixture("requests/snapshot-chunk-0-ok.json");
    let second = chunk_fixture("requests/snapshot-chunk-1-ok.json");
    for i in 0..20u8 {
        let snap = format!("66666666-6666-4666-8666-6666666667{i:02}");
        let mut c0 = first.clone();
        let mut c1 = second.clone();
        c0["payload"]["snapshotId"] = json!(snap);
        c1["payload"]["snapshotId"] = json!(snap);
        let r0 = validate_request_value(&c0).unwrap();
        let r1 = validate_request_value(&c1).unwrap();
        assert_eq!(asm.apply_chunk(&r0).unwrap().integrity, Integrity::Partial);
        assert_eq!(asm.apply_chunk(&r1).unwrap().integrity, Integrity::VerifiedInMemory);
        assert!(asm.forget(CLIENT_A, &snap, EPOCH));
    }
    assert_eq!(asm.session_count(), 0);
}

#[test]
fn same_message_id_same_bytes_different_logic_is_conflict() {
    let mut env = chunk_fixture("requests/snapshot-chunk-0-ok.json");
    let req = validate_request_value(&env).unwrap();
    let digest = snapshot_chunk_identity_sha256(&req.payload).unwrap();
    let mut store = HashMap::new();
    store.insert(
        MessageKey {
            client_instance_id: CLIENT_A.into(),
            message_id: MSG.into(),
            source_restore_epoch: EPOCH.into(),
        },
        StoredOutcome::Applied {
            result_id: RESULT.into(),
            payload_sha256: digest,
        },
    );
    assert!(matches!(
        evaluate_write(&req, Some(&current()), &MapStore(store.clone())).unwrap(),
        WriteDecision::Replay { .. }
    ));
    env["payload"]["applicationId"] = json!("88888888-8888-4888-8888-888888888888");
    let other = validate_request_value(&env).unwrap();
    assert_ne!(
        snapshot_chunk_identity_sha256(&req.payload).unwrap(),
        snapshot_chunk_identity_sha256(&other.payload).unwrap()
    );
    assert_eq!(
        evaluate_write(&other, Some(&current()), &MapStore(store)).unwrap(),
        WriteDecision::Conflict
    );
    let mut asm = ChunkAssembler::new();
    asm.apply_chunk(&req).unwrap();
    assert_eq!(asm.apply_chunk(&other).unwrap_err().code.as_str(), "conflict");
}
