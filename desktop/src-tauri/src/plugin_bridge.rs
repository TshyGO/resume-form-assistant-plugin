//! Mapping one validated D05 envelope onto the D03 transactional interface.
//!
//! Everything here runs inside the application process, which is the only writer. The
//! store commits the business row and its receipt in one transaction, so an answer is
//! only produced after the write is durable — the host never invents a success.

use archive_store::{
    ApplicationCandidate, ArchiveIdentity, ArchiveStore, FillOutcome, FillSubmitInput,
    JobSaveInput, Occurred, PluginOp, PluginWriteContext, PluginWriteOutcome, ReconcileOutcome,
    ReconcileQueryItem, StoreError, SubmitConfirmInput,
};
use resume_pro_protocol::{ErrorCode, MessageType, Request};
use serde_json::{json, Map, Value};

/// A successful answer: the envelope-level `resultId` and the response payload.
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
        // The wire carries chunk bytes, and nothing in the archive stores bytes yet.
        // Acknowledging a chunk would move the plugin cursor past data that was never
        // written, and a complete ACK is its permission to drop its own copy.
        MessageType::SnapshotChunk => Err(ErrorCode::Unavailable),
        MessageType::Health | MessageType::Handshake => Err(ErrorCode::UnknownMessageType),
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

    #[test]
    fn a_snapshot_chunk_is_never_acknowledged_while_the_bytes_have_nowhere_to_go() {
        // A chunk ACK moves the plugin cursor, and a complete ACK is its permission to
        // drop its own copy. Neither may be sent for bytes that were not stored.
        let (_dir, store) = store();
        let identity = store.identity();
        let bytes = [0u8, 0, 0];
        let digest = sha256_hex(&bytes);
        let chunk = request(
            "snapshot.chunk",
            "22222222-2222-4222-8222-222222222222",
            Some(&identity),
            json!({
                "snapshotId": "77777777-7777-4777-8777-777777777777",
                "applicationId": "55555555-5555-4555-8555-555555555555",
                "chunkIndex": 0,
                "chunkCount": 1,
                "chunkSha256": digest,
                "snapshotSha256": digest,
                "byteSize": bytes.len(),
                "bytesBase64": "AAAA"
            }),
        );
        assert!(matches!(apply(&chunk, &store), Err(ErrorCode::Unavailable)));
    }
}
