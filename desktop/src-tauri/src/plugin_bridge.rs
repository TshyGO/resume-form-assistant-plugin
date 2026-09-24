//! Mapping one validated D05 envelope onto the D03 transactional interface.
//!
//! Everything here runs inside the application process, which is the only writer. The
//! store commits the business row and its receipt in one transaction, so an answer is
//! only produced after the write is durable — the host never invents a success.

use archive_store::{
    ApplicationCandidate, ArchiveIdentity, ArchiveStore, FillOutcome, FillSubmitInput,
    JobSaveInput, Occurred, PluginOp, PluginWriteContext, PluginWriteOutcome, ReconcileOutcome,
    ReconcileQueryItem, SnapshotChunkInput, SnapshotCompletion, StoreError, SubmitConfirmInput,
};
use resume_pro_protocol::{
    plugin_chunk_ack_payload, plugin_snapshot_ack_payload, CurrentArchive, DurableChunk,
    ErrorCode, MessageType, Request, MAX_ENVELOPE_BYTES,
};
use serde_json::{json, Map, Value};

/// A successful answer: the envelope-level `resultId` and the response payload.
#[derive(Debug)]
pub struct Answer {
    pub result_id: Option<String>,
    pub payload: Value,
}

/// The response schema caps both candidate lists at 32.
const MAX_CANDIDATES: usize = 32;

/// Handle one request against the open archive.
///
/// Errors are returned as a bare protocol code. Store messages quote the offending value
/// — an applicationId, a company name — and the caller turns a code into a fixed message,
/// so nothing from the archive travels back to the extension.
pub fn apply(request: &Request, store: &ArchiveStore) -> Result<Answer, ErrorCode> {
    match request.message_type {
        MessageType::QueryCandidates => query_candidates(request, store),
        MessageType::JobSave | MessageType::FillSubmit | MessageType::SubmitConfirm => {
            write(request, store)
        }
        MessageType::OutboxReconcile => reconcile(request, store),
        MessageType::SnapshotChunk => snapshot_chunk(request, store),
        MessageType::ResumeRead => resume_read(request, store),
        MessageType::ResumeUpdate => resume_update(request, store),
        MessageType::Health | MessageType::Handshake => Err(ErrorCode::UnknownMessageType),
        MessageType::AiComplete | MessageType::UiOpen | MessageType::LegacyImport => Err(ErrorCode::ProtocolIncompatible),
    }
}

fn ensure_current_identity(request: &Request, store: &ArchiveStore) -> Result<(), ErrorCode> {
    let identity = store.identity();
    let current = CurrentArchive {
        archive_id: identity.archive_id,
        restore_epoch: identity.restore_epoch,
    };
    resume_pro_protocol::check_current_identity(request, Some(&current)).map_err(|err| err.code)
}

fn resume_read(request: &Request, store: &ArchiveStore) -> Result<Answer, ErrorCode> {
    ensure_current_identity(request, store)?;
    let overview = store.resume_overview().map_err(code_of)?;
    let profile = store.get_profile().map_err(code_of)?;
    let templates = overview.templates.into_iter().map(|summary| json!({
        "id": summary.id,
        "name": summary.name,
        "fieldCount": summary.field_count
    })).collect::<Vec<_>>();
    let active = match overview.active_template_id {
        Some(id) => {
            let template = store.get_template(&id).map_err(code_of)?.ok_or(ErrorCode::Unavailable)?;
            json!({"id": template.id, "name": template.name, "groups": template.groups})
        }
        None => Value::Null,
    };
    let payload = json!({
        "templates": templates,
        "activeTemplate": active,
        "profile": profile.profile,
        "profileRevision": profile.revision
    });
    let payload_size = serde_json::to_vec(&payload).map_err(|_| ErrorCode::Unavailable)?.len();
    if payload_size > MAX_ENVELOPE_BYTES - 1024 {
        return Err(ErrorCode::PayloadTooLarge);
    }
    let response = json!({
        "protocolVersion": request.protocol_version,
        "correlationId": request.message_id,
        "ok": true,
        "payload": payload
    });
    if serde_json::to_vec(&response).map_err(|_| ErrorCode::Unavailable)?.len() > MAX_ENVELOPE_BYTES {
        return Err(ErrorCode::PayloadTooLarge);
    }
    resume_pro_protocol::validate_response_for_request(&response, request).map_err(|err| err.code)?;
    Ok(Answer { result_id: None, payload })
}

fn resume_update(request: &Request, store: &ArchiveStore) -> Result<Answer, ErrorCode> {
    ensure_current_identity(request, store)?;
    let revision = match request.payload["op"].as_str() {
        Some("setActiveTemplate") => {
            let id = request.payload["templateId"].as_str().ok_or(ErrorCode::InvalidPayload)?;
            store.set_active_template(&id.to_ascii_lowercase()).map_err(code_of)?;
            store.get_profile().map_err(code_of)?.revision
        }
        Some("saveProfile") => {
            let profile = request.payload.get("profile").ok_or(ErrorCode::InvalidPayload)?.clone();
            archive_store::reject_profile_secrets(&profile).map_err(|_| ErrorCode::SecretForbidden)?;
            let expected = request.payload["expectedRevision"].as_i64().ok_or(ErrorCode::InvalidPayload)?;
            store.save_profile(profile, expected).map_err(code_of)?.revision
        }
        _ => return Err(ErrorCode::InvalidPayload),
    };
    let active = store.resume_overview().map_err(code_of)?.active_template_id;
    Ok(Answer {
        result_id: None,
        payload: json!({"activeTemplateId": active, "profileRevision": revision}),
    })
}

pub fn legacy_import(
    request: &Request,
    store: &ArchiveStore,
    services: &dyn crate::bridge_services::BridgeServices,
) -> Result<Answer, ErrorCode> {
    ensure_current_identity(request, store)?;
    // Housekeeping, not part of the answer: a keychain that cannot delete right now must not
    // make a status query or a part fail. Undeleted keys are retried at startup.
    match store.expire_legacy_imports(&archive_store::timeutil::now_utc()) {
        Ok(expired) => {
            for id in expired {
                crate::legacy_import_commands::clear_key_best_effort(store, services, &id);
            }
        }
        Err(err) => eprintln!("legacy import: expiry check deferred ({})", err.code()),
    }
    let import_id = request.payload["importId"].as_str().ok_or(ErrorCode::InvalidPayload)?;
    let kind = request.payload["kind"].as_str().ok_or(ErrorCode::InvalidPayload)?;
    let status = match kind {
        "manifest" => store.receive_legacy_manifest(import_id,
            request.payload.get("body").ok_or(ErrorCode::InvalidPayload)?.clone()).map_err(code_of)?,
        "status" => store.legacy_import_status(import_id).map_err(code_of)?,
        "template" | "profile" | "aiConfig" => {
            let index = request.payload["index"].as_i64().ok_or(ErrorCode::InvalidPayload)?;
            let body = request.payload.get("body").ok_or(ErrorCode::InvalidPayload)?;
            let digest = resume_pro_protocol::payload_body_sha256(body).map_err(|_| ErrorCode::InvalidPayload)?;
            let check = store.check_legacy_part(import_id, index, kind, &digest).map_err(code_of)?;
            if check.is_new { check_new_part(kind, body)?; }
            let stored = if kind == "aiConfig" {
                json!({
                    "apiUrl": body["apiUrl"],
                    "model": body["model"],
                    "hasKey": true
                })
            } else {
                body.clone()
            };
            // Only a part arriving for the first time brings a key worth keeping. A resend
            // after the batch was confirmed or rejected must not recreate the temporary
            // account that confirmation or rejection just deleted.
            if kind == "aiConfig" && check.is_new && check.state == "receiving" {
                let key = body["apiKey"].as_str().ok_or(ErrorCode::InvalidPayload)?;
                services.stage_import_key(import_id, key)?;
            }
            store.receive_legacy_part(import_id, index, kind, &digest, stored).map_err(code_of)?
        }
        _ => return Err(ErrorCode::InvalidPayload),
    };
    Ok(Answer { result_id: None, payload: json!(status) })
}

/// Checks a new part must pass before anything is staged, with the codes the plugin acts
/// on. The store repeats the shape checks when it stores the part; the profile's secret
/// check runs here first so it is reported as `secret_forbidden`, and the AI config's
/// provider rules live in this crate.
fn check_new_part(kind: &str, body: &Value) -> Result<(), ErrorCode> {
    match kind {
        "profile" => {
            archive_store::validate_profile(body).map_err(|_| ErrorCode::InvalidPayload)?;
            archive_store::reject_profile_secrets(body).map_err(|_| ErrorCode::SecretForbidden)
        }
        "aiConfig" => {
            let api_url = body["apiUrl"].as_str().ok_or(ErrorCode::InvalidPayload)?;
            let model = body["model"].as_str().ok_or(ErrorCode::InvalidPayload)?;
            crate::ai_settings::check_import_config(api_url, model).map_err(|_| ErrorCode::InvalidPayload)
        }
        _ => Ok(()),
    }
}

/// The identity the envelope claims. `None` reaches D03 as `identity_missing` rather than
/// being silently replaced with the current one, which would let an envelope from a
/// restored-over archive write as if it belonged here.
fn envelope_identity(request: &Request) -> Option<ArchiveIdentity> {
    Some(ArchiveIdentity {
        archive_id: request.archive_id.clone()?,
        restore_epoch: request.restore_epoch.clone()?,
    })
}

fn context(request: &Request) -> Result<PluginWriteContext, ErrorCode> {
    Ok(PluginWriteContext {
        envelope_identity: envelope_identity(request),
        client_instance_id: request.client_instance_id.clone(),
        message_id: request.message_id.clone(),
        source_restore_epoch: resume_pro_protocol::source_restore_epoch(request)
            .ok_or(ErrorCode::InvalidPayload)?,
        payload_sha256: resume_pro_protocol::payload_sha256(request)
            .ok_or(ErrorCode::InvalidPayload)?,
    })
}

/// When the client says the event happened. The validator has already established this is
/// a real UTC timestamp, so it is passed on rather than replaced with the arrival time.
fn occurred(request: &Request) -> Occurred {
    Occurred::DateTime {
        rfc3339: request.occurred_at.clone(),
        time_zone: None,
    }
}

fn text(payload: &Value, key: &str) -> Option<String> {
    payload.get(key).and_then(Value::as_str).map(str::to_string)
}

fn count(payload: &Value, key: &str) -> Option<i64> {
    payload.get(key).and_then(Value::as_i64)
}

fn write(request: &Request, store: &ArchiveStore) -> Result<Answer, ErrorCode> {
    let ctx = context(request)?;
    let payload = &request.payload;
    let op = match request.message_type {
        MessageType::JobSave => PluginOp::JobSave(JobSaveInput {
            target_application_id: text(payload, "applicationId"),
            company: text(payload, "company").ok_or(ErrorCode::InvalidPayload)?,
            title: text(payload, "title").ok_or(ErrorCode::InvalidPayload)?,
            source_url: text(payload, "sourceUrl"),
            location: text(payload, "location"),
            occurred: occurred(request),
        }),
        MessageType::FillSubmit => PluginOp::FillSubmit(FillSubmitInput {
            application_id: text(payload, "applicationId").ok_or(ErrorCode::InvalidPayload)?,
            outcome: fill_outcome(payload)?,
            field_count: count(payload, "fieldCount"),
            filled_count: count(payload, "filledCount"),
            unconfirmed_count: count(payload, "unconfirmedCount"),
            durations_ms: payload.get("durationsMs").cloned(),
            url_redacted: text(payload, "urlRedacted"),
            template_name: text(payload, "templateName"),
            template_version: text(payload, "templateVersion"),
            snapshot_id: text(payload, "snapshotId"),
            plugin_version: text(payload, "pluginVersion"),
            occurred: occurred(request),
        }),
        MessageType::SubmitConfirm => PluginOp::SubmitConfirm(SubmitConfirmInput {
            application_id: text(payload, "applicationId").ok_or(ErrorCode::InvalidPayload)?,
            // The archive records who confirmed. Only the extension reaches this path, so
            // recording `desktop` here would misattribute every plugin confirmation.
            via: "plugin".into(),
            note: None,
            occurred: occurred(request),
        }),
        _ => return Err(ErrorCode::UnknownMessageType),
    };

    // A replay is answered exactly like the original commit, with the original resultId:
    // that is what makes the plugin retry safe rather than duplicating an application.
    let (result_id, result_kind) = match store.submit_plugin_message(&ctx, op).map_err(code_of)? {
        PluginWriteOutcome::Committed {
            result_id,
            result_kind,
        }
        | PluginWriteOutcome::Replayed {
            result_id,
            result_kind,
        } => (result_id, result_kind),
    };
    Ok(Answer {
        result_id: Some(result_id),
        payload: json!({ "resultKind": result_kind }),
    })
}

/// One chunk of a snapshot upload (D08).
///
/// Both ACKs the plugin can get are statements about disk, not about memory:
///
/// - `ackKind: chunk` is built with [DurableChunk::committed] from the cursor the archive
///   reports *after* the chunk's bytes and receipt committed together. The plugin advances
///   its cursor on this, so an ACK for bytes only held in memory would strand the upload.
/// - `ackKind: snapshot` is sent only once the snapshot file is written and its row is
///   committed; it is the plugin's permission to delete its IndexedDB copy.
///
/// A resend of a chunk that already committed goes through the receipt as a replay and is
/// answered from the archive's current state, so a lost ACK — either kind — is recovered by
/// sending the same chunk again. That same resend retries completion if an earlier attempt
/// to write the file failed.
fn snapshot_chunk(request: &Request, store: &ArchiveStore) -> Result<Answer, ErrorCode> {
    let ctx = context(request)?;
    let payload = &request.payload;
    let snapshot_id = text(payload, "snapshotId").ok_or(ErrorCode::InvalidPayload)?;
    let chunk_index = count(payload, "chunkIndex").ok_or(ErrorCode::InvalidPayload)?;
    let chunk_count = count(payload, "chunkCount").ok_or(ErrorCode::InvalidPayload)?;
    // Already decoded and checked against chunkSha256 by the validator; decoded again here
    // because the validated request keeps the wire form.
    let bytes = resume_pro_protocol::decode_standard_base64(
        payload.get("bytesBase64").and_then(Value::as_str).ok_or(ErrorCode::InvalidPayload)?,
    )
    .map_err(|_| ErrorCode::InvalidPayload)?;
    let op = PluginOp::SnapshotChunk(SnapshotChunkInput {
        application_id: text(payload, "applicationId"),
        snapshot_id: snapshot_id.clone(),
        chunk_index,
        chunk_count,
        total_sha256: text(payload, "snapshotSha256").ok_or(ErrorCode::InvalidPayload)?,
        byte_size: count(payload, "byteSize").ok_or(ErrorCode::InvalidPayload)?,
        chunk_sha256: text(payload, "chunkSha256").ok_or(ErrorCode::InvalidPayload)?,
        // The envelope carries no template name. The snapshot row takes it from the
        // verified content at completion; see archive-store's complete_snapshot_upload.
        template_name: None,
        template_version: None,
        bytes,
    });

    let result_id = match store.submit_plugin_message(&ctx, op).map_err(code_of)? {
        PluginWriteOutcome::Committed { result_id, .. }
        | PluginWriteOutcome::Replayed { result_id, .. } => result_id,
    };

    let index = u32::try_from(chunk_index).map_err(|_| ErrorCode::InvalidPayload)?;
    let total = u32::try_from(chunk_count).map_err(|_| ErrorCode::InvalidPayload)?;
    let client = &request.client_instance_id;

    let payload = match store.complete_snapshot_upload(client, &snapshot_id) {
        Ok(SnapshotCompletion::Completed(_)) | Ok(SnapshotCompletion::AlreadyComplete(_)) => {
            plugin_snapshot_ack_payload(&snapshot_id, index, total)
        }
        Ok(SnapshotCompletion::Incomplete(progress)) => chunk_ack(&snapshot_id, index, total, &ctx.message_id, progress.chunk_cursor)?,
        // Every chunk arrived and matched its own digest, yet together they are not the
        // snapshot the envelope declares. The upload identity is immutable, so no resend can
        // repair that; a chunk ACK here would have the plugin retry forever.
        Err(StoreError::Validation(_)) => return Err(ErrorCode::InvalidPayload),
        // The chunk itself is durable, so its ACK is still true. Only the complete ACK is
        // withheld; the plugin keeps its copy and the next resend tries completion again.
        Err(_) => {
            let progress = store.snapshot_progress(client, &snapshot_id).map_err(code_of)?;
            chunk_ack(&snapshot_id, index, total, &ctx.message_id, progress.chunk_cursor)?
        }
    };

    Ok(Answer {
        result_id: Some(result_id),
        payload,
    })
}

fn chunk_ack(
    snapshot_id: &str,
    index: u32,
    total: u32,
    chunk_message_id: &str,
    durable_cursor: i64,
) -> Result<Value, ErrorCode> {
    let cursor = u32::try_from(durable_cursor).map_err(|_| ErrorCode::Unavailable)?;
    // Refuses to build an ACK for a chunk the cursor says was not written. Reaching that
    // would be a defect here, and `unavailable` keeps the plugin's copy and retries.
    let durable = DurableChunk::committed(snapshot_id, index, total, chunk_message_id, cursor)
        .map_err(|_| ErrorCode::Unavailable)?;
    Ok(plugin_chunk_ack_payload(&durable))
}

fn fill_outcome(payload: &Value) -> Result<FillOutcome, ErrorCode> {
    match payload.get("outcome").and_then(Value::as_str) {
        Some("started") => Ok(FillOutcome::Started),
        Some("completed") => Ok(FillOutcome::Completed),
        Some("partial") => Ok(FillOutcome::Partial),
        Some("failed") => Ok(FillOutcome::Failed),
        Some("cancelled") => Ok(FillOutcome::Cancelled),
        _ => Err(ErrorCode::InvalidPayload),
    }
}

fn query_candidates(request: &Request, store: &ArchiveStore) -> Result<Answer, ErrorCode> {
    let company = text(&request.payload, "company").ok_or(ErrorCode::InvalidPayload)?;
    let title = text(&request.payload, "title").unwrap_or_default();
    let source_url = text(&request.payload, "sourceUrl");
    let found = store
        .query_candidates(&company, &title, source_url.as_deref())
        .map_err(code_of)?;
    Ok(Answer {
        result_id: None,
        payload: json!({
            "exact": candidates(&found.exact),
            "sameCompany": candidates(&found.same_company),
        }),
    })
}

fn candidates(items: &[ApplicationCandidate]) -> Vec<Value> {
    items
        .iter()
        .take(MAX_CANDIDATES)
        .map(|c| {
            let mut item = Map::new();
            item.insert("applicationId".into(), json!(c.id));
            item.insert("company".into(), json!(c.company));
            item.insert("title".into(), json!(c.title));
            item.insert("stage".into(), json!(c.current_stage.as_str()));
            item.insert("updatedAt".into(), json!(c.updated_at));
            if let Some(url) = &c.source_url {
                item.insert("sourceUrl".into(), json!(url));
            }
            Value::Object(item)
        })
        .collect()
}

fn reconcile(request: &Request, store: &ArchiveStore) -> Result<Answer, ErrorCode> {
    let raw = request
        .payload
        .get("items")
        .and_then(Value::as_array)
        .ok_or(ErrorCode::InvalidPayload)?;
    let mut items = Vec::with_capacity(raw.len());
    for item in raw {
        items.push(ReconcileQueryItem {
            client_instance_id: text(item, "clientInstanceId").ok_or(ErrorCode::InvalidPayload)?,
            message_id: text(item, "messageId").ok_or(ErrorCode::InvalidPayload)?,
            source_restore_epoch: text(item, "sourceRestoreEpoch")
                .ok_or(ErrorCode::InvalidPayload)?,
            payload_sha256: text(item, "payloadSha256").ok_or(ErrorCode::InvalidPayload)?,
            snapshot_id: text(item, "snapshotId"),
            chunk_index: count(item, "chunkIndex"),
        });
    }
    let replies = store
        .reconcile_lookup(
            envelope_identity(request).as_ref(),
            &request.client_instance_id,
            &items,
        )
        .map_err(code_of)?;

    let answered = replies
        .iter()
        .map(|reply| {
            let mut item = Map::new();
            item.insert(
                "clientInstanceId".into(),
                json!(reply.item.client_instance_id),
            );
            item.insert("messageId".into(), json!(reply.item.message_id));
            item.insert(
                "sourceRestoreEpoch".into(),
                json!(reply.item.source_restore_epoch),
            );
            item.insert("payloadSha256".into(), json!(reply.item.payload_sha256));
            if let Some(snapshot) = &reply.item.snapshot_id {
                item.insert("snapshotId".into(), json!(snapshot));
            }
            if let Some(index) = reply.item.chunk_index {
                item.insert("chunkIndex".into(), json!(index));
            }
            // `resultId` accompanies `applied` and nothing else, and the reason strings
            // stay here: they quote archive content, which must not reach the extension.
            match &reply.outcome {
                ReconcileOutcome::Applied { result_id } => {
                    item.insert("status".into(), json!("applied"));
                    item.insert("resultId".into(), json!(result_id));
                }
                ReconcileOutcome::Purged => {
                    item.insert("status".into(), json!("purged"));
                }
                ReconcileOutcome::NotFound => {
                    item.insert("status".into(), json!("not_found"));
                }
                ReconcileOutcome::Conflict { .. } => {
                    item.insert("status".into(), json!("conflict"));
                }
                ReconcileOutcome::Unverifiable { .. } => {
                    item.insert("status".into(), json!("unverifiable"));
                }
            }
            Value::Object(item)
        })
        .collect::<Vec<_>>();

    Ok(Answer {
        result_id: None,
        payload: json!({ "items": answered }),
    })
}

/// Translate a store failure into the protocol vocabulary.
///
/// The vocabulary has no code for "this archive is broken", and the closest one that
/// exists — `unavailable` — is retryable. That is the safe direction: the plugin keeps
/// its outbox copy and tries again, where a permanent-looking code would have it drop
/// work that was never written.
fn code_of(err: StoreError) -> ErrorCode {
    match err.code() {
        "identity_missing" => ErrorCode::IdentityMissing,
        "restore_epoch_mismatch" => ErrorCode::RestoreEpochMismatch,
        "conflict" => ErrorCode::Conflict,
        "previously_purged" => ErrorCode::PreviouslyPurged,
        // The request named something that is not there, or is not acceptable. Both are
        // faults in what arrived rather than in the archive.
        "not_found" | "validation_failed" => ErrorCode::InvalidPayload,
        _ => ErrorCode::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use resume_pro_protocol::{payload_body_sha256, sha256_hex, validate_request_bytes};
    use tempfile::TempDir;

    const CLIENT: &str = "11111111-1111-4111-8111-111111111111";
    const JOB_URL: &str = "https://jobs.example.test/1";

    fn store() -> (TempDir, ArchiveStore) {
        let dir = TempDir::new().unwrap();
        let archive = dir.path().join("archive");
        std::fs::create_dir_all(&archive).unwrap();
        let store =
            crate::commands::open_store(&archive, &dir.path().join("current.json")).unwrap();
        (dir, store)
    }

    /// Build the envelope the extension would send, digest included, so these tests go
    /// through the same validator the wire does rather than around it.
    fn request(
        message_type: &str,
        message_id: &str,
        identity: Option<&ArchiveIdentity>,
        mut payload: Value,
    ) -> Request {
        if let Some(id) = identity {
            let stamped = !matches!(
                message_type,
                "outbox.reconcile" | "application.queryCandidates"
            );
            if stamped && payload.get("sourceRestoreEpoch").is_none() {
                payload["sourceRestoreEpoch"] = json!(id.restore_epoch);
            }
        }
        if !matches!(
            message_type,
            "application.queryCandidates" | "outbox.reconcile" | "snapshot.chunk"
        ) {
            payload["payloadSha256"] = json!(payload_body_sha256(&payload).unwrap());
        }
        let mut envelope = json!({
            "protocolVersion": 1,
            "messageId": message_id,
            "clientInstanceId": CLIENT,
            "messageType": message_type,
            "occurredAt": "2026-09-06T12:00:00.000Z",
            "payload": payload
        });
        if let Some(id) = identity {
            envelope["archiveId"] = json!(id.archive_id);
            envelope["restoreEpoch"] = json!(id.restore_epoch);
        }
        validate_request_bytes(&serde_json::to_vec(&envelope).unwrap())
            .expect("the test envelope must be one the validator accepts")
    }

    fn job(message_id: &str, identity: &ArchiveIdentity, title: &str) -> Request {
        request(
            "job.save",
            message_id,
            Some(identity),
            json!({"company": "Synthetic Ltd", "title": title, "sourceUrl": JOB_URL}),
        )
    }

    fn v2_request(message_type: &str, identity: &ArchiveIdentity, payload: Value) -> Request {
        let envelope = json!({
            "protocolVersion": 2,
            "messageId": "33333333-3333-4333-8333-333333333333",
            "clientInstanceId": CLIENT,
            "messageType": message_type,
            "occurredAt": "2026-09-24T00:00:00.000Z",
            "archiveId": identity.archive_id,
            "restoreEpoch": identity.restore_epoch,
            "payload": payload
        });
        validate_request_bytes(&serde_json::to_vec(&envelope).unwrap()).unwrap()
    }

    fn checked_v2_response(request: &Request, answer: &Answer) -> Value {
        let response = json!({
            "protocolVersion": 2,
            "correlationId": request.message_id,
            "ok": true,
            "payload": answer.payload
        });
        resume_pro_protocol::validate_response_for_request(&response, request).unwrap();
        response
    }

    #[test]
    fn resume_read_returns_empty_profile_and_no_templates() {
        let (_dir, store) = store();
        let request = v2_request("resume.read", &store.identity(), json!({}));
        let answer = apply(&request, &store).unwrap();
        assert!(answer.result_id.is_none());
        let response = checked_v2_response(&request, &answer);
        assert_eq!(response["payload"]["templates"], json!([]));
        assert!(response["payload"]["activeTemplate"].is_null());
        assert_eq!(response["payload"]["profile"], archive_store::empty_profile());
        assert_eq!(response["payload"]["profileRevision"], 0);
    }

    #[test]
    fn resume_read_returns_summaries_in_desktop_order_and_active_template_body() {
        let (_dir, store) = store();
        let groups = vec![archive_store::TemplateGroup {
            name: "基本信息".into(),
            fields: vec![archive_store::TemplateField { key: "姓名".into(), value: "张三".into() }],
        }];
        let first = store.create_template("第一份", groups.clone()).unwrap().template;
        let second = store.create_template("第二份", groups).unwrap().template;
        let request = v2_request("resume.read", &store.identity(), json!({}));
        let answer = apply(&request, &store).unwrap();
        let response = checked_v2_response(&request, &answer);
        assert_eq!(response["payload"]["templates"][0]["id"], second.id);
        assert_eq!(response["payload"]["templates"][1]["id"], first.id);
        assert_eq!(response["payload"]["activeTemplate"]["id"], second.id);
        assert_eq!(response["payload"]["activeTemplate"]["groups"][0]["fields"][0]["value"], "张三");
        assert!(response["payload"]["activeTemplate"].get("updatedAt").is_none());
    }

    #[test]
    fn resume_update_switches_by_uuid_and_saves_profile_with_revision() {
        let (_dir, store) = store();
        let groups = vec![archive_store::TemplateGroup {
            name: "基本信息".into(),
            fields: vec![archive_store::TemplateField { key: "姓名".into(), value: "张三".into() }],
        }];
        let first = store.create_template("第一份", groups.clone()).unwrap().template;
        store.create_template("第二份", groups).unwrap();
        let switch = v2_request("resume.update", &store.identity(), json!({
            "op": "setActiveTemplate", "templateId": first.id.to_ascii_uppercase()
        }));
        let switched = apply(&switch, &store).unwrap();
        let response = checked_v2_response(&switch, &switched);
        assert_eq!(response["payload"]["activeTemplateId"], first.id);
        let missing = v2_request("resume.update", &store.identity(), json!({
            "op": "setActiveTemplate", "templateId": "ffffffff-ffff-4fff-8fff-ffffffffffff"
        }));
        assert_eq!(apply(&missing, &store).err(), Some(ErrorCode::InvalidPayload));

        let profile = json!({"values": {"fullName": "Alice"}, "family": [], "custom": []});
        let save = v2_request("resume.update", &store.identity(), json!({
            "op": "saveProfile", "profile": profile, "expectedRevision": 0
        }));
        let saved = apply(&save, &store).unwrap();
        let response = checked_v2_response(&save, &saved);
        assert_eq!(response["payload"]["profileRevision"], 1);
        assert_eq!(response["payload"]["activeTemplateId"], first.id);
        assert_eq!(apply(&save, &store).err(), Some(ErrorCode::Conflict));
        let secret = v2_request("resume.update", &store.identity(), json!({
            "op": "saveProfile",
            "profile": {"values": {"note": "密码：123456"}, "family": [], "custom": []},
            "expectedRevision": 1
        }));
        assert_eq!(apply(&secret, &store).err(), Some(ErrorCode::SecretForbidden));
    }

    #[test]
    fn resume_read_rejects_a_foreign_archive_identity() {
        let (_dir, store) = store();
        let mut foreign = store.identity();
        foreign.restore_epoch = "ffffffff-ffff-4fff-8fff-ffffffffffff".into();
        let request = v2_request("resume.read", &foreign, json!({}));
        assert_eq!(apply(&request, &store).err(), Some(ErrorCode::RestoreEpochMismatch));
    }

    #[test]
    fn resume_read_worst_case_fits_a_single_envelope() {
        let (_dir, store) = store();
        let small = vec![archive_store::TemplateGroup {
            name: "g".into(),
            fields: vec![archive_store::TemplateField { key: "k".into(), value: "v".into() }],
        }];
        let prefix = "𠀀".repeat(98);
        for i in 0..24 {
            store.create_template(&format!("{prefix}{i:02}"), small.clone()).unwrap();
        }
        let mut large = small;
        let base = serde_json::to_vec(&large).unwrap().len() - 1;
        large[0].fields[0].value = "a".repeat(archive_store::MAX_TEMPLATE_BYTES - base);
        assert_eq!(serde_json::to_vec(&large).unwrap().len(), archive_store::MAX_TEMPLATE_BYTES);
        store.create_template(&format!("{prefix}24"), large).unwrap();
        let mut profile = archive_store::empty_profile();
        profile["values"]["k"] = json!("");
        let base = serde_json::to_vec(&profile).unwrap().len();
        profile["values"]["k"] = json!("a".repeat(archive_store::MAX_PROFILE_BYTES - base));
        assert_eq!(serde_json::to_vec(&profile).unwrap().len(), archive_store::MAX_PROFILE_BYTES);
        store.save_profile(profile, 0).unwrap();

        let request = v2_request("resume.read", &store.identity(), json!({}));
        let answer = apply(&request, &store).unwrap();
        let response = checked_v2_response(&request, &answer);
        assert_eq!(response["payload"]["templates"].as_array().unwrap().len(), 25);
        assert!(serde_json::to_vec(&response).unwrap().len() <= resume_pro_protocol::MAX_ENVELOPE_BYTES);
    }

    #[test]
    fn resume_read_refuses_a_stored_secret_like_field() {
        let (_dir, store) = store();
        store.create_template("已有字段", vec![archive_store::TemplateGroup {
            name: "基本信息".into(),
            fields: vec![archive_store::TemplateField {
                key: "备注".into(),
                value: "Bearer abcdefghijklmnopqrstuvwxyz".into(),
            }],
        }]).unwrap();
        let request = v2_request("resume.read", &store.identity(), json!({}));
        assert_eq!(apply(&request, &store).err(), Some(ErrorCode::SecretForbidden));
    }

    #[test]
    fn legacy_ai_config_stages_the_key_outside_sqlite() {
        struct KeyServices(std::sync::Mutex<Option<String>>);
        impl crate::bridge_services::BridgeServices for KeyServices {
            fn ai_complete(&self, _: &str, _: &str, _: &str) -> crate::bridge_services::AiReply {
                crate::bridge_services::AiReply::Failed { reason: "not_configured", http_status: None, host: None }
            }
            fn open_view(&self, _: &str) -> bool { false }
            fn stage_import_key(&self, _: &str, key: &str) -> Result<(), ErrorCode> {
                *self.0.lock().unwrap() = Some(key.into());
                Ok(())
            }
        }
        let (dir, store) = store();
        let services = KeyServices(std::sync::Mutex::new(None));
        let import_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let body = json!({"apiUrl":"https://api.example.com/v1","model":"m","apiKey":"sk-synthetic-example-value"});
        let digest = resume_pro_protocol::payload_body_sha256(&body).unwrap();
        let manifest = v2_request("legacy.import", &store.identity(), json!({
            "importId": import_id, "kind": "manifest", "index": 0,
            "body": {"pluginVersion":"0.4.0","total":1,"parts":[{"index":1,"kind":"aiConfig","sha256":digest}]}
        }));
        legacy_import(&manifest, &store, &services).unwrap();
        let part = v2_request("legacy.import", &store.identity(), json!({
            "importId": import_id, "kind": "aiConfig", "index": 1, "body": body
        }));
        let answer = legacy_import(&part, &store, &services).unwrap();
        assert_eq!(answer.payload["state"], "awaiting_confirmation");
        assert_eq!(services.0.lock().unwrap().as_deref(), Some("sk-synthetic-example-value"));
        let db = rusqlite::Connection::open(dir.path().join("archive/archive.db")).unwrap();
        let raw: String = db.query_row("SELECT body_json FROM legacy_import_parts", [], |row| row.get(0)).unwrap();
        assert!(!raw.contains("sk-synthetic-example-value"));
        assert!(!raw.contains("apiKey"));
        let changed = v2_request("legacy.import", &store.identity(), json!({
            "importId": import_id, "kind": "aiConfig", "index": 1,
            "body": {"apiUrl":"https://api.example.com/v1","model":"m","apiKey":"sk-different-synthetic-value"}
        }));
        assert_eq!(legacy_import(&changed, &store, &services).err(), Some(ErrorCode::Conflict));
        assert_eq!(services.0.lock().unwrap().as_deref(), Some("sk-synthetic-example-value"));
    }

    #[test]
    fn failed_key_staging_never_marks_an_ai_part_received() {
        struct LockedKeyring;
        impl crate::bridge_services::BridgeServices for LockedKeyring {
            fn ai_complete(&self, _: &str, _: &str, _: &str) -> crate::bridge_services::AiReply {
                crate::bridge_services::AiReply::Failed { reason: "not_configured", http_status: None, host: None }
            }
            fn open_view(&self, _: &str) -> bool { false }
            fn stage_import_key(&self, _: &str, _: &str) -> Result<(), ErrorCode> { Err(ErrorCode::Unavailable) }
        }
        let (_dir, store) = store();
        let import_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let body = json!({"apiUrl":"https://api.example.com/v1","model":"m","apiKey":"sk-synthetic-example-value"});
        let digest = resume_pro_protocol::payload_body_sha256(&body).unwrap();
        let manifest = v2_request("legacy.import", &store.identity(), json!({
            "importId": import_id, "kind": "manifest", "index": 0,
            "body": {"pluginVersion":"0.4.0","total":1,"parts":[{"index":1,"kind":"aiConfig","sha256":digest}]}
        }));
        legacy_import(&manifest, &store, &LockedKeyring).unwrap();
        let part = v2_request("legacy.import", &store.identity(), json!({
            "importId": import_id, "kind": "aiConfig", "index": 1, "body": body
        }));
        assert_eq!(legacy_import(&part, &store, &LockedKeyring).err(), Some(ErrorCode::Unavailable));
        let status = store.legacy_import_status(import_id).unwrap();
        assert_eq!((status.state.as_str(), status.received), ("receiving", 0));
    }

    /// A keychain stand-in that counts staging and can refuse deletes.
    #[derive(Default)]
    struct TempKeys {
        keys: std::sync::Mutex<std::collections::HashMap<String, String>>,
        staged: std::sync::atomic::AtomicUsize,
        fail_clear: std::sync::atomic::AtomicBool,
    }

    impl crate::bridge_services::BridgeServices for TempKeys {
        fn ai_complete(&self, _: &str, _: &str, _: &str) -> crate::bridge_services::AiReply {
            crate::bridge_services::AiReply::Failed { reason: "not_configured", http_status: None, host: None }
        }
        fn open_view(&self, _: &str) -> bool { false }
        fn stage_import_key(&self, id: &str, key: &str) -> Result<(), ErrorCode> {
            self.staged.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            self.keys.lock().unwrap().insert(id.into(), key.into());
            Ok(())
        }
        fn get_import_key(&self, id: &str) -> Result<Option<String>, ErrorCode> {
            Ok(self.keys.lock().unwrap().get(id).cloned())
        }
        fn clear_import_key(&self, id: &str) -> Result<(), ErrorCode> {
            if self.fail_clear.load(std::sync::atomic::Ordering::Relaxed) { return Err(ErrorCode::Unavailable); }
            self.keys.lock().unwrap().remove(id);
            Ok(())
        }
        fn validate_import_provider(&self, _: &str, _: &str, _: &str) -> Result<(), ErrorCode> { Ok(()) }
        fn install_import_provider(&self, _: &str, _: &str, _: &str, _: &str) -> Result<(), ErrorCode> { Ok(()) }
        fn discard_import_provider(&self, _: &str) -> Result<(), ErrorCode> { Ok(()) }
    }

    const IMPORT_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    fn send_manifest(store: &ArchiveStore, services: &TempKeys, parts: &[(&str, &Value)]) {
        let parts = parts.iter().enumerate().map(|(i, (kind, body))| json!({
            "index": i + 1, "kind": kind, "sha256": resume_pro_protocol::payload_body_sha256(body).unwrap()
        })).collect::<Vec<_>>();
        let manifest = v2_request("legacy.import", &store.identity(), json!({
            "importId": IMPORT_ID, "kind": "manifest", "index": 0,
            "body": {"pluginVersion":"0.4.0","total":parts.len(),"parts":parts}
        }));
        legacy_import(&manifest, store, services).unwrap();
    }

    fn send_part(store: &ArchiveStore, services: &TempKeys, index: usize, kind: &str, body: &Value) -> Result<Answer, ErrorCode> {
        let part = v2_request("legacy.import", &store.identity(), json!({
            "importId": IMPORT_ID, "kind": kind, "index": index, "body": body
        }));
        legacy_import(&part, store, services)
    }

    #[test]
    fn resending_the_ai_part_after_import_does_not_stage_the_key_again() {
        let (_dir, store) = store();
        let services = TempKeys::default();
        let ai = json!({"apiUrl":"https://api.example.com/v1","model":"m","apiKey":"sk-synthetic-example-value"});
        send_manifest(&store, &services, &[("aiConfig", &ai)]);
        send_part(&store, &services, 1, "aiConfig", &ai).unwrap();
        send_part(&store, &services, 1, "aiConfig", &ai).unwrap();
        assert_eq!(services.staged.load(std::sync::atomic::Ordering::Relaxed), 1);
        assert_eq!(crate::legacy_import_commands::confirm(&store, &services, IMPORT_ID).unwrap().state, "imported");
        assert!(services.keys.lock().unwrap().is_empty());

        let answer = send_part(&store, &services, 1, "aiConfig", &ai).unwrap();
        assert_eq!(answer.payload["state"], "imported");
        assert!(services.keys.lock().unwrap().is_empty());
        assert_eq!(services.staged.load(std::sync::atomic::Ordering::Relaxed), 1);
    }

    #[test]
    fn resending_the_ai_part_after_rejection_does_not_stage_the_key_again() {
        let (_dir, store) = store();
        let services = TempKeys::default();
        let ai = json!({"apiUrl":"https://api.example.com/v1","model":"m","apiKey":"sk-synthetic-example-value"});
        send_manifest(&store, &services, &[("aiConfig", &ai)]);
        send_part(&store, &services, 1, "aiConfig", &ai).unwrap();
        store.apply_legacy_confirmation(IMPORT_ID).unwrap();
        assert_eq!(crate::legacy_import_commands::reject(&store, &services, IMPORT_ID).unwrap().state, "rejected");
        assert!(services.keys.lock().unwrap().is_empty());

        send_manifest(&store, &services, &[("aiConfig", &ai)]);
        let answer = send_part(&store, &services, 1, "aiConfig", &ai).unwrap();
        assert_eq!(answer.payload["state"], "rejected");
        assert!(services.keys.lock().unwrap().is_empty());
        assert_eq!(services.staged.load(std::sync::atomic::Ordering::Relaxed), 1);
    }

    #[test]
    fn a_status_query_survives_a_keychain_that_cannot_delete_expired_keys() {
        let (dir, store) = store();
        let services = TempKeys::default();
        let ai = json!({"apiUrl":"https://api.example.com/v1","model":"m","apiKey":"sk-synthetic-example-value"});
        let template = json!({"name":"First","wasActive":true,"groups":[{"name":"Basic","fields":[{"key":"Name","value":"Alice"}]}]});
        send_manifest(&store, &services, &[("aiConfig", &ai), ("template", &template)]);
        send_part(&store, &services, 1, "aiConfig", &ai).unwrap();
        let db = rusqlite::Connection::open(dir.path().join("archive/archive.db")).unwrap();
        db.execute("UPDATE legacy_imports SET created_at = '2026-01-01T00:00:00.000Z'", []).unwrap();
        services.fail_clear.store(true, std::sync::atomic::Ordering::Relaxed);

        let status = v2_request("legacy.import", &store.identity(), json!({"importId": IMPORT_ID, "kind": "status"}));
        assert_eq!(legacy_import(&status, &store, &services).unwrap().payload["state"], "expired");
        // Not deleted yet, so startup cleanup still has it on its list.
        assert_eq!(store.legacy_import_cleanup_ids().unwrap().ids, vec![IMPORT_ID.to_string()]);
    }

    #[test]
    fn a_cleared_expired_key_is_not_listed_for_startup_cleanup_again() {
        let (dir, store) = store();
        let services = TempKeys::default();
        let ai = json!({"apiUrl":"https://api.example.com/v1","model":"m","apiKey":"sk-synthetic-example-value"});
        let template = json!({"name":"First","wasActive":true,"groups":[{"name":"Basic","fields":[{"key":"Name","value":"Alice"}]}]});
        send_manifest(&store, &services, &[("aiConfig", &ai), ("template", &template)]);
        send_part(&store, &services, 1, "aiConfig", &ai).unwrap();
        let db = rusqlite::Connection::open(dir.path().join("archive/archive.db")).unwrap();
        db.execute("UPDATE legacy_imports SET created_at = '2026-01-01T00:00:00.000Z'", []).unwrap();
        let status = v2_request("legacy.import", &store.identity(), json!({"importId": IMPORT_ID, "kind": "status"}));
        assert_eq!(legacy_import(&status, &store, &services).unwrap().payload["state"], "expired");
        assert!(services.keys.lock().unwrap().is_empty());
        assert!(store.legacy_import_cleanup_ids().unwrap().ids.is_empty());
    }

    #[test]
    fn a_bad_part_is_refused_on_arrival_with_the_matching_code() {
        let (_dir, store) = store();
        let services = TempKeys::default();
        let secret = json!({"values":{"note":"密码：hunter2"},"family":[],"custom":[]});
        let blank = json!({"name":"Blank","wasActive":false,"groups":[{"name":"g","fields":[{"key":" ","value":"v"}]}]});
        let ai = json!({"apiUrl":"https://api.example.com/v1","model":" ","apiKey":"sk-synthetic-example-value"});
        send_manifest(&store, &services, &[("profile", &secret), ("template", &blank), ("aiConfig", &ai)]);
        assert_eq!(send_part(&store, &services, 1, "profile", &secret).err(), Some(ErrorCode::SecretForbidden));
        assert_eq!(send_part(&store, &services, 2, "template", &blank).err(), Some(ErrorCode::InvalidPayload));
        assert_eq!(send_part(&store, &services, 3, "aiConfig", &ai).err(), Some(ErrorCode::InvalidPayload));
        assert_eq!(services.staged.load(std::sync::atomic::Ordering::Relaxed), 0);
        assert_eq!(store.legacy_import_status(IMPORT_ID).unwrap().received, 0);
    }

    #[test]
    fn a_saved_job_is_in_the_archive_by_the_time_the_answer_exists() {
        let (_dir, store) = store();
        let identity = store.identity();
        let answer = apply(
            &job(
                "22222222-2222-4222-8222-222222222222",
                &identity,
                "Engineer",
            ),
            &store,
        )
        .expect("a job the archive can take must be saved");
        let result_id = answer.result_id.expect("a write names what it produced");

        // Read through the store, not through the answer: the point is that the row is
        // already there, not that the response said so.
        let found = store
            .query_candidates("Synthetic Ltd", "Engineer", Some(JOB_URL))
            .unwrap();
        assert_eq!(found.exact.len(), 1);
        assert_eq!(found.exact[0].id, result_id);
    }

    #[test]
    fn the_same_message_sent_twice_saves_one_application() {
        // The plugin retries when an answer is lost. A second application for the same
        // message would be a duplicate the user has to clean up by hand.
        let (_dir, store) = store();
        let identity = store.identity();
        let first = apply(
            &job(
                "22222222-2222-4222-8222-222222222222",
                &identity,
                "Engineer",
            ),
            &store,
        )
        .unwrap()
        .result_id;
        let second = apply(
            &job(
                "22222222-2222-4222-8222-222222222222",
                &identity,
                "Engineer",
            ),
            &store,
        )
        .unwrap()
        .result_id;
        assert_eq!(first, second, "a replay returns the original resultId");
        let found = store
            .query_candidates("Synthetic Ltd", "Engineer", Some(JOB_URL))
            .unwrap();
        assert_eq!(found.exact.len(), 1);
    }

    #[test]
    fn a_different_message_id_saves_a_second_application() {
        // The guard above must come from the receipt, not from refusing anything that
        // looks similar: two genuine saves of the same posting are the user's to make.
        let (_dir, store) = store();
        let identity = store.identity();
        apply(
            &job(
                "22222222-2222-4222-8222-222222222222",
                &identity,
                "Engineer",
            ),
            &store,
        )
        .unwrap();
        apply(
            &job(
                "33333333-3333-4333-8333-333333333333",
                &identity,
                "Engineer",
            ),
            &store,
        )
        .unwrap();
        let found = store
            .query_candidates("Synthetic Ltd", "Engineer", Some(JOB_URL))
            .unwrap();
        assert_eq!(found.exact.len(), 2);
    }

    #[test]
    fn an_envelope_from_before_a_restore_is_refused_rather_than_written() {
        // After a restore the epoch is re-minted. A write stamped with the old one was
        // composed against an archive that is no longer current, and applying it would
        // silently attach it to different data.
        let (_dir, store) = store();
        let stale = ArchiveIdentity {
            archive_id: store.identity().archive_id,
            restore_epoch: "44444444-4444-4444-8444-444444444444".into(),
        };
        let outcome = apply(
            &job("22222222-2222-4222-8222-222222222222", &stale, "Engineer"),
            &store,
        );
        assert!(matches!(outcome, Err(ErrorCode::RestoreEpochMismatch)));
        let found = store
            .query_candidates("Synthetic Ltd", "Engineer", Some(JOB_URL))
            .unwrap();
        assert!(
            found.exact.is_empty(),
            "nothing may be written on a refused epoch"
        );
    }

    #[test]
    fn an_envelope_with_no_identity_is_refused() {
        // The validator rejects this before the bridge ever sees it, so the check here is
        // deliberately duplicated: an unstamped write must not become one stamped with
        // whatever archive happens to be open, whichever way it arrives.
        let (_dir, store) = store();
        let identity = store.identity();
        let mut anonymous = job(
            "22222222-2222-4222-8222-222222222222",
            &identity,
            "Engineer",
        );
        anonymous.archive_id = None;
        anonymous.restore_epoch = None;
        assert!(matches!(
            apply(&anonymous, &store),
            Err(ErrorCode::IdentityMissing)
        ));
        assert!(store
            .query_candidates("Synthetic Ltd", "Engineer", Some(JOB_URL))
            .unwrap()
            .exact
            .is_empty());
    }

    #[test]
    fn a_fill_event_for_an_application_that_does_not_exist_is_not_a_server_fault() {
        // Reporting this as unavailable would have the plugin retry forever; the fault is
        // in the applicationId that arrived.
        let (_dir, store) = store();
        let identity = store.identity();
        let orphan = request(
            "fill.submit",
            "22222222-2222-4222-8222-222222222222",
            Some(&identity),
            json!({
                "applicationId": "55555555-5555-4555-8555-555555555555",
                "outcome": "completed"
            }),
        );
        assert!(matches!(
            apply(&orphan, &store),
            Err(ErrorCode::InvalidPayload)
        ));
    }

    #[test]
    fn a_fill_event_lands_on_the_application_it_names() {
        let (_dir, store) = store();
        let identity = store.identity();
        let saved = apply(
            &job(
                "22222222-2222-4222-8222-222222222222",
                &identity,
                "Engineer",
            ),
            &store,
        )
        .unwrap()
        .result_id
        .unwrap();
        let filled = request(
            "fill.submit",
            "33333333-3333-4333-8333-333333333333",
            Some(&identity),
            json!({
                "applicationId": saved,
                "outcome": "completed",
                "fieldCount": 12,
                "filledCount": 12
            }),
        );
        let answer = apply(&filled, &store).expect("a fill event on a real application is savable");
        assert!(answer.result_id.is_some());
        assert!(!store.list_events(&saved).unwrap().is_empty());
    }

    #[test]
    fn candidates_are_answered_in_two_layers_and_write_nothing() {
        // The plugin asks before it saves, so this must not create anything. The exact
        // layer needs the posting URL as well; without it the same row is only a
        // same-company hint, which is what stops a silent bind to the wrong application.
        let (_dir, store) = store();
        let identity = store.identity();
        apply(
            &job(
                "22222222-2222-4222-8222-222222222222",
                &identity,
                "Engineer",
            ),
            &store,
        )
        .unwrap();

        let with_url = apply(
            &request(
                "application.queryCandidates",
                "33333333-3333-4333-8333-333333333333",
                Some(&identity),
                json!({"company": "Synthetic Ltd", "title": "Engineer", "sourceUrl": JOB_URL}),
            ),
            &store,
        )
        .unwrap();
        assert!(
            with_url.result_id.is_none(),
            "a query produces no result object"
        );
        let exact = with_url.payload["exact"].as_array().unwrap();
        assert_eq!(exact.len(), 1);
        assert_eq!(exact[0]["company"], "Synthetic Ltd");
        assert!(exact[0]["applicationId"].is_string());
        assert_eq!(exact[0]["stage"], "saved");

        let without_url = apply(
            &request(
                "application.queryCandidates",
                "44444444-4444-4444-8444-444444444444",
                Some(&identity),
                json!({"company": "Synthetic Ltd", "title": "Engineer"}),
            ),
            &store,
        )
        .unwrap();
        assert!(without_url.payload["exact"].as_array().unwrap().is_empty());
        assert_eq!(
            without_url.payload["sameCompany"].as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn reconcile_reports_a_committed_message_as_applied_and_an_unknown_one_as_not_found() {
        // not_found does not mean "never happened", so it must not carry a resultId that
        // would let the plugin treat it as done.
        let (_dir, store) = store();
        let identity = store.identity();
        let saved = apply(
            &job(
                "22222222-2222-4222-8222-222222222222",
                &identity,
                "Engineer",
            ),
            &store,
        )
        .unwrap()
        .result_id
        .unwrap();
        let digest = job(
            "22222222-2222-4222-8222-222222222222",
            &identity,
            "Engineer",
        )
        .payload["payloadSha256"]
            .as_str()
            .unwrap()
            .to_string();
        let asked = request(
            "outbox.reconcile",
            "33333333-3333-4333-8333-333333333333",
            Some(&identity),
            json!({"items": [
                {
                    "clientInstanceId": CLIENT,
                    "messageId": "22222222-2222-4222-8222-222222222222",
                    "sourceRestoreEpoch": identity.restore_epoch,
                    "payloadSha256": digest
                },
                {
                    "clientInstanceId": CLIENT,
                    "messageId": "66666666-6666-4666-8666-666666666666",
                    "sourceRestoreEpoch": identity.restore_epoch,
                    "payloadSha256": "0".repeat(64)
                }
            ]}),
        );
        let answer = apply(&asked, &store).unwrap();
        let items = answer.payload["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["status"], "applied");
        assert_eq!(items[0]["resultId"], saved);
        assert_eq!(items[1]["status"], "not_found");
        assert!(items[1].get("resultId").is_none());
    }

    // --- snapshot.chunk ---------------------------------------------------------------

    const SNAPSHOT: &str = "77777777-7777-4777-8777-777777777777";

    /// Standard padded Base64, the only form the validator accepts. Local so the test does
    /// not lean on the code under test to build its own input.
    fn base64(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for group in bytes.chunks(3) {
            let n = (group[0] as u32) << 16
                | (*group.get(1).unwrap_or(&0) as u32) << 8
                | *group.get(2).unwrap_or(&0) as u32;
            for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
                if i <= group.len() {
                    out.push(TABLE[((n >> shift) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    /// A synthetic snapshot in the plugin's v1 format, cut into `size`-byte chunks.
    struct Upload {
        bytes: Vec<u8>,
        size: usize,
    }

    impl Upload {
        fn new(size: usize) -> Self {
            let fields: Vec<String> = (0..40)
                .map(|i| format!(r#"{{"key":"项目{i}","value":"合成描述{i}"}}"#))
                .collect();
            let bytes = format!(
                r#"{{"capturedAt":"2026-09-12T08:00:00.000Z","format":"resume-pro.snapshot","formatVersion":1,"groups":[{{"fields":[{}],"name":"经历"}}],"omittedFieldCount":0,"templateName":"合成模板","templateVersion":"0123456789ab"}}"#,
                fields.join(",")
            )
            .into_bytes();
            Self { bytes, size }
        }

        fn count(&self) -> usize {
            self.bytes.len().div_ceil(self.size)
        }

        fn piece(&self, index: usize) -> &[u8] {
            &self.bytes[index * self.size..((index + 1) * self.size).min(self.bytes.len())]
        }

        fn chunk(&self, identity: &ArchiveIdentity, application_id: &str, index: usize) -> Request {
            self.chunk_with(identity, application_id, index, self.piece(index).to_vec(), &message_for(index))
        }

        fn chunk_with(
            &self,
            identity: &ArchiveIdentity,
            application_id: &str,
            index: usize,
            bytes: Vec<u8>,
            message_id: &str,
        ) -> Request {
            request(
                "snapshot.chunk",
                message_id,
                Some(identity),
                json!({
                    "snapshotId": SNAPSHOT,
                    "applicationId": application_id,
                    "chunkIndex": index,
                    "chunkCount": self.count(),
                    "chunkSha256": sha256_hex(&bytes),
                    "snapshotSha256": sha256_hex(&self.bytes),
                    "byteSize": self.bytes.len(),
                    "bytesBase64": base64(&bytes)
                }),
            )
        }
    }

    fn message_for(index: usize) -> String {
        format!("9{index:07}-9999-4999-8999-999999999999")
    }

    fn saved_application(store: &ArchiveStore) -> String {
        apply(
            &job("22222222-2222-4222-8222-222222222222", &store.identity(), "Engineer"),
            store,
        )
        .unwrap()
        .result_id
        .unwrap()
    }

    /// Send one request and return the ACK payload, having checked that the whole response
    /// is one the extension would accept for that request.
    fn ack(request: &Request, store: &ArchiveStore) -> Value {
        let answer = apply(request, store).expect("the chunk must be accepted");
        let response = json!({
            "protocolVersion": 1,
            "correlationId": request.message_id,
            "ok": true,
            "resultId": answer.result_id.clone().expect("a write names its result"),
            "payload": answer.payload.clone()
        });
        resume_pro_protocol::validate_response_for_request(&response, request)
            .expect("the ACK must be a valid response to this very request");
        answer.payload
    }

    #[test]
    fn chunks_in_order_are_acknowledged_one_by_one_and_the_last_completes_the_snapshot() {
        let (dir, store) = store();
        let identity = store.identity();
        let app_id = saved_application(&store);
        let upload = Upload::new(512);
        assert!(upload.count() >= 3);

        for index in 0..upload.count() - 1 {
            let payload = ack(&upload.chunk(&identity, &app_id, index), &store);
            assert_eq!(payload["ackKind"], "chunk");
            assert_eq!(payload["chunkIndex"], index);
            assert_eq!(payload["chunkCursor"], index + 1);
            assert!(store.get_snapshot(SNAPSHOT).unwrap().is_none(), "no snapshot before the last chunk");
        }
        let last = upload.count() - 1;
        let payload = ack(&upload.chunk(&identity, &app_id, last), &store);
        assert_eq!(payload["ackKind"], "snapshot");
        assert_eq!(payload["snapshotId"], SNAPSHOT);
        assert_eq!(payload["chunkCursor"], upload.count());

        // The complete ACK exists only once the file and the row do.
        let meta = store.get_snapshot(SNAPSHOT).unwrap().expect("the snapshot row is committed");
        assert_eq!(meta.template_name, "合成模板");
        let file = dir.path().join("archive").join(&meta.stored_rel_path);
        assert_eq!(std::fs::read(file).unwrap(), upload.bytes);
    }

    #[test]
    fn a_later_chunk_first_does_not_move_the_cursor_past_the_gap() {
        let (_dir, store) = store();
        let identity = store.identity();
        let app_id = saved_application(&store);
        let upload = Upload::new(512);

        let early = ack(&upload.chunk(&identity, &app_id, 2), &store);
        assert_eq!(early["ackKind"], "chunk");
        assert_eq!(early["chunkIndex"], 2);
        assert_eq!(early["chunkCursor"], 0, "chunks 0 and 1 are still missing");

        let first = ack(&upload.chunk(&identity, &app_id, 0), &store);
        assert_eq!(first["chunkCursor"], 1);
    }

    #[test]
    fn resending_the_last_chunk_after_completion_answers_complete_again() {
        // What the plugin does when the complete ACK was lost on the way back.
        let (_dir, store) = store();
        let identity = store.identity();
        let app_id = saved_application(&store);
        let upload = Upload::new(512);
        for index in 0..upload.count() {
            ack(&upload.chunk(&identity, &app_id, index), &store);
        }
        let again = ack(&upload.chunk(&identity, &app_id, upload.count() - 1), &store);
        assert_eq!(again["ackKind"], "snapshot");
        assert_eq!(store.list_snapshots(&app_id).unwrap().len(), 1);
    }

    #[test]
    fn a_chunk_that_changes_bytes_or_identity_is_a_conflict() {
        let (_dir, store) = store();
        let identity = store.identity();
        let app_id = saved_application(&store);
        let upload = Upload::new(512);
        ack(&upload.chunk(&identity, &app_id, 0), &store);

        let mut altered = upload.piece(0).to_vec();
        altered[0] ^= 0x01;
        let different_bytes = upload.chunk_with(&identity, &app_id, 0, altered, &message_for(7));
        assert!(matches!(apply(&different_bytes, &store), Err(ErrorCode::Conflict)));

        // The same chunk re-minted under a new messageId after a restart is forbidden too.
        let reminted = upload.chunk_with(&identity, &app_id, 0, upload.piece(0).to_vec(), &message_for(8));
        assert!(matches!(apply(&reminted, &store), Err(ErrorCode::Conflict)));
    }

    #[test]
    fn an_upload_survives_the_application_restarting() {
        let (dir, store) = store();
        let identity = store.identity();
        let app_id = saved_application(&store);
        let upload = Upload::new(512);
        ack(&upload.chunk(&identity, &app_id, 0), &store);
        store.close().unwrap();

        let archive = dir.path().join("archive");
        let store = crate::commands::open_store(&archive, &dir.path().join("current.json")).unwrap();
        let mut last = Value::Null;
        for index in 1..upload.count() {
            last = ack(&upload.chunk(&identity, &app_id, index), &store);
        }
        assert_eq!(last["ackKind"], "snapshot");
    }

    #[test]
    fn a_chunk_for_an_application_that_does_not_exist_is_refused_and_nothing_is_staged() {
        // A chunk ACK moves the plugin cursor. It may only exist for bytes the archive holds,
        // and a chunk bound to nothing is not something the archive can hold.
        let (_dir, store) = store();
        let identity = store.identity();
        let upload = Upload::new(512);
        let orphan = upload.chunk(&identity, "55555555-5555-4555-8555-555555555555", 0);
        assert!(matches!(apply(&orphan, &store), Err(ErrorCode::InvalidPayload)));
        assert!(store.snapshot_progress(CLIENT, SNAPSHOT).is_err());
    }

    #[test]
    fn chunks_that_do_not_add_up_to_the_declared_snapshot_are_refused_not_retried_forever() {
        // Each chunk matches its own digest, but together they are not the snapshot the
        // envelope declares. Resending cannot fix that, so the answer is invalid_payload rather
        // than a chunk ACK the plugin would keep retrying.
        let (_dir, store) = store();
        let identity = store.identity();
        let app_id = saved_application(&store);
        let real = Upload::new(512);
        let mut declared_bytes = real.bytes.clone();
        *declared_bytes.last_mut().unwrap() ^= 0x01;
        let declared = Upload { bytes: declared_bytes, size: real.size };

        let last = real.count() - 1;
        for index in 0..last {
            let payload = ack(&declared.chunk_with(&identity, &app_id, index, real.piece(index).to_vec(), &message_for(index)), &store);
            assert_eq!(payload["ackKind"], "chunk");
        }
        let final_chunk = declared.chunk_with(&identity, &app_id, last, real.piece(last).to_vec(), &message_for(last));
        assert!(matches!(apply(&final_chunk, &store), Err(ErrorCode::InvalidPayload)));
        assert!(matches!(apply(&final_chunk, &store), Err(ErrorCode::InvalidPayload)), "and the same on a resend");
        assert!(store.get_snapshot(SNAPSHOT).unwrap().is_none());
    }

    #[test]
    fn a_snapshot_file_that_cannot_be_written_withholds_only_the_complete_ack() {
        let (dir, store) = store();
        let identity = store.identity();
        let app_id = saved_application(&store);
        let upload = Upload::new(512);
        let snapshots = dir.path().join("archive").join("snapshots");
        let _ = std::fs::remove_dir_all(&snapshots);
        std::fs::write(&snapshots, b"not a directory").unwrap();

        let mut last = Value::Null;
        for index in 0..upload.count() {
            last = ack(&upload.chunk(&identity, &app_id, index), &store);
        }
        // Every chunk is durable, so saying so is true; the snapshot is not, so that is withheld.
        assert_eq!(last["ackKind"], "chunk");
        assert_eq!(last["chunkCursor"], upload.count());
        assert!(store.get_snapshot(SNAPSHOT).unwrap().is_none());

        std::fs::remove_file(&snapshots).unwrap();
        let retried = ack(&upload.chunk(&identity, &app_id, upload.count() - 1), &store);
        assert_eq!(retried["ackKind"], "snapshot");
    }
}
