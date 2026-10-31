//! User-requested webmail import. Only chunks travel over Native Messaging; a partial
//! upload stays in process memory, never becomes evidence, and cannot cross an archive epoch.
use crate::plugin_bridge::Answer;
use archive_store::{ArchiveStore, AttachmentBlobMeta, EvidenceKind, NewEvidence};
use resume_pro_protocol::{decode_standard_base64, sha256_hex, ErrorCode, Request};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(15 * 60);
const MAX_BUFFERED: usize = 64 * 1024 * 1024;
const MAX_UPLOADS: usize = 4;

struct Upload {
    client_instance_id: String,
    metadata: Value,
    touched: Instant,
    bytes: Vec<u8>,
    next: u64,
    saved: Option<(String, bool, String)>,
}
// OpenArchive serializes archive writes; this second gate also bounds buffers across archives.
static UPLOADS: OnceLock<Mutex<HashMap<String, Upload>>> = OnceLock::new();

pub fn apply(request: &Request, store: &ArchiveStore) -> Result<Answer, ErrorCode> {
    let p = &request.payload;
    let key = format!(
        "{}:{}:{}:{}",
        request.archive_id.as_deref().unwrap_or(""),
        request.restore_epoch.as_deref().unwrap_or(""),
        request.client_instance_id,
        p["uploadId"].as_str().ok_or(ErrorCode::InvalidPayload)?
    );
    let mut metadata = p.clone();
    for field in ["bytesBase64", "chunkIndex", "chunkSha256"] {
        metadata.as_object_mut().unwrap().remove(field);
    }
    let index = p["chunkIndex"].as_u64().ok_or(ErrorCode::InvalidPayload)?;
    let bytes = decode_standard_base64(p["bytesBase64"].as_str().ok_or(ErrorCode::InvalidPayload)?)
        .map_err(|e| e.code)?;
    let mut uploads = UPLOADS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| ErrorCode::Unavailable)?;
    uploads.retain(|_, u| u.touched.elapsed() < TTL);
    if uploads.len() >= 128 {
        let oldest = uploads
            .iter()
            .filter(|(_, u)| u.saved.is_some())
            .min_by_key(|(_, u)| u.touched)
            .map(|(id, _)| id.clone());
        if let Some(id) = oldest {
            uploads.remove(&id);
        }
    }
    if !uploads.contains_key(&key) {
        if index != 0 {
            return Err(ErrorCode::InvalidPayload);
        }
        // One worker serializes saves for this browser profile. A new user retry replaces
        // its abandoned upload, so repeated interruptions cannot fill all four slots.
        uploads
            .retain(|_, u| u.saved.is_some() || u.client_instance_id != request.client_instance_id);
        if uploads.values().filter(|u| u.saved.is_none()).count() >= MAX_UPLOADS {
            return Err(ErrorCode::Unavailable);
        }
        uploads.insert(
            key.clone(),
            Upload {
                client_instance_id: request.client_instance_id.clone(),
                metadata: metadata.clone(),
                touched: Instant::now(),
                bytes: Vec::new(),
                next: 0,
                saved: None,
            },
        );
    }
    let buffered: usize = uploads.values().map(|u| u.bytes.len()).sum();
    let u = uploads.get_mut(&key).unwrap();
    if u.metadata != metadata {
        return Err(ErrorCode::Conflict);
    }
    u.touched = Instant::now();
    if let Some((id, duplicate, final_sha)) = &u.saved {
        // A repeated final chunk gets the durable result, not a second evidence row.
        if p["chunkSha256"].as_str() != Some(final_sha.as_str())
            || index + 1 != p["chunkCount"].as_u64().unwrap()
        {
            return Err(ErrorCode::Conflict);
        }
        if store
            .get_evidence(id)
            .map_err(|_| ErrorCode::Unavailable)?
            .is_none()
        {
            return Err(ErrorCode::PreviouslyPurged);
        }
        return Ok(answer(p, Some((id.clone(), *duplicate))));
    }
    if index > u.next {
        return Err(ErrorCode::InvalidPayload);
    }
    if index < u.next {
        let start = index as usize * 32768;
        if u.bytes.get(start..start + bytes.len()) != Some(bytes.as_slice()) {
            return Err(ErrorCode::Conflict);
        }
    } else {
        if buffered + bytes.len() > MAX_BUFFERED {
            return Err(ErrorCode::PayloadTooLarge);
        }
        u.bytes.extend_from_slice(&bytes);
        u.next += 1;
    }
    if u.next != p["chunkCount"].as_u64().unwrap() {
        return Ok(answer(p, None));
    }
    if u.bytes.len() as u64 != p["byteSize"].as_u64().unwrap()
        || sha256_hex(&u.bytes) != p["sha256"].as_str().unwrap()
    {
        uploads.remove(&key);
        return Err(ErrorCode::InvalidPayload);
    }
    let application = p.get("applicationId").and_then(Value::as_str);
    // Validate the chosen application before any file is staged.
    if let Some(id) = application {
        let app = store
            .get_application(id)
            .map_err(|_| ErrorCode::Unavailable)?
            .ok_or(ErrorCode::InvalidPayload)?;
        if app.recycle_state != archive_store::RecycleState::Active {
            return Err(ErrorCode::InvalidPayload);
        }
    }
    let result = if p["kind"] == "eml" {
        if evidence_import::parse_eml(&u.bytes).is_none() {
            uploads.remove(&key);
            return Err(ErrorCode::InvalidPayload);
        }
        // Covers retry after a process crash even for a mail without Message-ID.
        let sha = sha256_hex(&u.bytes);
        let existing = store
            .evidence_for_blob(&sha)
            .map_err(|_| ErrorCode::Unavailable)?
            .into_iter()
            .filter_map(|id| store.get_evidence(&id).ok().flatten())
            .find(|e| {
                e.application_id.as_ref().is_none_or(|id| {
                    store
                        .get_application(id)
                        .ok()
                        .flatten()
                        .is_some_and(|a| a.recycle_state == archive_store::RecycleState::Active)
                })
            });
        // Let the established MailKey path perform inbox association when there is an ID.
        let has_id = evidence_import::parse_eml(&u.bytes)
            .and_then(|m| m.message_id)
            .is_some();
        if let Some(e) = existing.filter(|_| !has_id) {
            associate_unbound(store, &e.id, application)?;
            (e.id, true)
        } else {
            let (summary, duplicate) = crate::evidence_commands::import_bytes(
                store,
                store.archive_dir(),
                &u.bytes,
                Some("webmail.eml".into()),
                &crate::evidence_commands::bucket_now(),
                application,
            )
            .map_err(|e| {
                if e.code == "too_large" {
                    ErrorCode::PayloadTooLarge
                } else {
                    ErrorCode::Unavailable
                }
            })?;
            (summary.id, duplicate)
        }
    } else {
        match import_excerpt(store, &u.bytes, application) {
            Ok(result) => result,
            Err(ErrorCode::InvalidPayload) => {
                uploads.remove(&key);
                return Err(ErrorCode::InvalidPayload);
            }
            Err(error) => return Err(error),
        }
    };
    u.bytes.clear();
    u.bytes.shrink_to_fit();
    u.saved = Some((
        result.0.clone(),
        result.1,
        p["chunkSha256"].as_str().unwrap().into(),
    ));
    Ok(answer(p, Some(result)))
}

fn answer(p: &Value, saved: Option<(String, bool)>) -> Answer {
    let mut payload =
        json!({"status": "chunk", "uploadId": p["uploadId"], "chunkIndex": p["chunkIndex"]});
    let result_id = saved.map(|(id, duplicate)| {
        payload["status"] = json!("saved");
        payload["evidenceId"] = json!(id);
        payload["duplicate"] = json!(duplicate);
        id
    });
    Answer { result_id, payload }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Excerpt {
    subject: String,
    from: String,
    sent_time: String,
    body: String,
}
fn import_excerpt(
    store: &ArchiveStore,
    bytes: &[u8],
    application: Option<&str>,
) -> Result<(String, bool), ErrorCode> {
    let e: Excerpt = serde_json::from_slice(bytes).map_err(|_| ErrorCode::InvalidPayload)?;
    if e.subject.trim().is_empty()
        || e.body.trim().is_empty()
        || e.subject.len() > 2000
        || e.from.len() > 2000
        || e.sent_time.len() > 800
        || e.body.len() > 1024 * 1024
    {
        return Err(ErrorCode::InvalidPayload);
    }
    let text = format!(
        "网页摘录（未保存邮件原件及附件）\n标题：{}\n发件人：{}\n发送时间：{}\n\n{}",
        e.subject, e.from, e.sent_time, e.body
    );
    let sha = sha256_hex(text.as_bytes());
    if let Some(id) = store
        .evidence_for_blob(&sha)
        .map_err(|_| ErrorCode::Unavailable)?
        .into_iter()
        .find(|id| {
            store.get_evidence(id).ok().flatten().is_some_and(|e| {
                e.application_id.as_ref().is_none_or(|app| {
                    store
                        .get_application(app)
                        .ok()
                        .flatten()
                        .is_some_and(|a| a.recycle_state == archive_store::RecycleState::Active)
                })
            })
        })
    {
        associate_unbound(store, &id, application)?;
        return Ok((id, true));
    }
    let existing = |sha: &str| {
        store
            .find_blob(sha)
            .ok()
            .flatten()
            .map(|b| b.meta.stored_rel_path)
    };
    let staged = evidence_import::stage_text(
        store.archive_dir(),
        &text,
        &crate::evidence_commands::bucket_now(),
        &existing,
    )
    .map_err(|_| ErrorCode::Unavailable)?;
    let record = store
        .import_evidence(NewEvidence {
            application_id: application.map(str::to_string),
            kind: EvidenceKind::Paste,
            blob: AttachmentBlobMeta {
                sha256: staged.sha256,
                size_bytes: staged.size_bytes,
                stored_rel_path: staged.stored_rel_path,
                mime: staged.mime,
            },
            original_filename: Some("网页摘录.txt".into()),
            subject: Some(format!("{}（网页摘录）", e.subject)),
            from_addr: Some(e.from),
            sent_at: None,
            body_extract: Some(text.chars().take(16000).collect()),
            message_id: None,
            append_event: true,
        })
        .map_err(|_| ErrorCode::Unavailable)?;
    Ok((record.id, false))
}

fn associate_unbound(
    store: &ArchiveStore,
    id: &str,
    application: Option<&str>,
) -> Result<(), ErrorCode> {
    if store.is_evidence_recycled(id).map_err(|_| ErrorCode::Unavailable)? {
        return Ok(());
    }
    if let Some(app) = application {
        if store
            .get_evidence(id)
            .map_err(|_| ErrorCode::Unavailable)?
            .is_some_and(|e| e.application_id.is_none())
        {
            store
                .associate_evidence(id, app)
                .map_err(|_| ErrorCode::Unavailable)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::open_store;
    use resume_pro_protocol::validate_request_value;
    static TEST_GATE: Mutex<()> = Mutex::new(());
    fn setup() -> (
        std::sync::MutexGuard<'static, ()>,
        tempfile::TempDir,
        ArchiveStore,
    ) {
        let guard = TEST_GATE.lock().unwrap_or_else(|e| e.into_inner());
        UPLOADS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .clear();
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(
            &dir.path().join("archive"),
            &dir.path().join("current.json"),
        )
        .unwrap();
        (guard, dir, store)
    }
    fn b64(bytes: &[u8]) -> String {
        const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for part in bytes.chunks(3) {
            let bits = ((part[0] as u32) << 16)
                | ((part.get(1).copied().unwrap_or(0) as u32) << 8)
                | part.get(2).copied().unwrap_or(0) as u32;
            out.push(ABC[(bits >> 18) as usize] as char);
            out.push(ABC[((bits >> 12) & 63) as usize] as char);
            out.push(if part.len() > 1 {
                ABC[((bits >> 6) & 63) as usize] as char
            } else {
                '='
            });
            out.push(if part.len() > 2 {
                ABC[(bits & 63) as usize] as char
            } else {
                '='
            });
        }
        out
    }
    fn requests(store: &ArchiveStore, bytes: &[u8], kind: &str) -> Vec<Request> {
        let identity = store.identity();
        let upload = uuid::Uuid::new_v4().to_string();
        bytes.chunks(32768).enumerate().map(|(index, chunk)| validate_request_value(&json!({
            "protocolVersion":4,"messageId":uuid::Uuid::new_v4().to_string(),"clientInstanceId":"11111111-1111-4111-8111-111111111111",
            "messageType":"mail.import","occurredAt":"2026-10-26T00:00:00Z","archiveId":identity.archive_id,"restoreEpoch":identity.restore_epoch,
            "payload":{"uploadId":upload,"kind":kind,"byteSize":bytes.len(),"sha256":sha256_hex(bytes),"chunkIndex":index,"chunkCount":bytes.len().div_ceil(32768),"chunkSha256":sha256_hex(chunk),"bytesBase64":b64(chunk)}
        })).unwrap()).collect()
    }
    fn save(store: &ArchiveStore, bytes: &[u8], kind: &str) -> Answer {
        let mut answer = None;
        for request in requests(store, bytes, kind) {
            let got = crate::plugin_bridge::apply(&request, store).unwrap();
            let response = json!({"protocolVersion":4,"correlationId":request.message_id,"ok":true,"resultId":got.result_id,"payload":got.payload});
            let mut response = response;
            if response["resultId"].is_null() {
                response.as_object_mut().unwrap().remove("resultId");
            }
            resume_pro_protocol::validate_response_for_request(&response, &request).unwrap();
            answer = Some(got);
        }
        answer.unwrap()
    }
    fn mail(id: Option<&str>) -> Vec<u8> {
        format!("From: hr@example.test\r\nSubject: Interview\r\nDate: Mon, 26 Oct 2026 08:00:00 +0000\r\n{}MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=demo\r\n\r\n--demo\r\nContent-Type: text/plain\r\n\r\nInterview tomorrow\r\n--demo\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=guide.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQ=\r\n--demo--\r\n", id.map(|id| format!("Message-ID: <{id}>\r\n")).unwrap_or_default()).into_bytes()
    }
    #[test]
    fn original_keeps_attachment_bytes_and_cross_channel_message_id_dedup() {
        let (_guard, _dir, store) = setup();
        let raw = mail(Some("one@example.test"));
        let saved = save(&store, &raw, "eml");
        let id = saved.result_id.unwrap();
        let evidence = store.get_evidence(&id).unwrap().unwrap();
        assert_eq!(
            std::fs::read(store.archive_dir().join(evidence.blob.meta.stored_rel_path)).unwrap(),
            raw
        );
        assert_eq!(
            evidence_import::parse_eml(&raw)
                .unwrap()
                .message_id
                .as_deref(),
            Some("one@example.test")
        );
        let imap = String::from_utf8(raw)
            .unwrap()
            .replace("\r\n", "\n")
            .into_bytes();
        let (duplicate, yes) = crate::evidence_commands::import_bytes(
            &store,
            store.archive_dir(),
            &imap,
            Some("imap.eml".into()),
            "2026-10",
            None,
        )
        .unwrap();
        assert!(yes);
        assert_eq!(duplicate.id, id);
        assert_eq!(store.list_evidence(None).unwrap().len(), 1);
    }
    #[test]
    fn repeated_final_chunk_and_idless_retry_never_create_a_second_record() {
        let (_guard, _dir, store) = setup();
        let raw = mail(None);
        let request = requests(&store, &raw, "eml").pop().unwrap();
        let first = crate::plugin_bridge::apply(&request, &store).unwrap();
        assert_eq!(
            crate::plugin_bridge::apply(&request, &store)
                .unwrap()
                .result_id,
            first.result_id
        );
        assert_eq!(save(&store, &raw, "eml").result_id, first.result_id);
        assert_eq!(store.list_evidence(None).unwrap().len(), 1);
        let id = first.result_id.as_deref().unwrap();
        store.set_evidence_recycled(id, true).unwrap();
        assert_eq!(crate::plugin_bridge::apply(&request, &store).unwrap().result_id, first.result_id);
        assert_eq!(save(&store, &raw, "eml").result_id, first.result_id);
        assert!(store.is_evidence_recycled(id).unwrap());
        assert!(store.list_evidence(None).unwrap().is_empty());
        let mut changed = request.raw.clone();
        let other = vec![b'x'; raw.len()];
        changed["payload"]["bytesBase64"] = json!(b64(&other));
        changed["payload"]["chunkSha256"] = json!(sha256_hex(&other));
        let changed = validate_request_value(&changed).unwrap();
        assert_eq!(
            crate::plugin_bridge::apply(&changed, &store).unwrap_err(),
            ErrorCode::Conflict
        );
        let original = store.get_evidence(id).unwrap().unwrap();
        store.purge_recycled_evidence(id, &original.blob.meta.sha256).unwrap();
        assert_eq!(crate::plugin_bridge::apply(&request, &store).unwrap_err(), ErrorCode::PreviouslyPurged);
        assert!(store.list_evidence(None).unwrap().is_empty());
    }
    #[test]
    fn partial_upload_creates_no_evidence_and_restored_archive_rejects_remaining_chunks() {
        let (_guard, _dir, store) = setup();
        let mut bytes = mail(Some("large@example.test"));
        bytes.extend(vec![b'x'; 70000]);
        let mut parts = requests(&store, &bytes, "eml");
        assert_eq!(
            crate::plugin_bridge::apply(&parts[0], &store)
                .unwrap()
                .payload["status"],
            "chunk"
        );
        assert!(store.list_evidence(None).unwrap().is_empty());
        parts[1].restore_epoch = Some(uuid::Uuid::new_v4().to_string());
        assert_eq!(
            crate::plugin_bridge::apply(&parts[1], &store).unwrap_err(),
            ErrorCode::RestoreEpochMismatch
        );
        let final_answer = save(&store, &bytes, "eml");
        assert_eq!(final_answer.payload["status"], "saved");
    }
    #[test]
    fn idless_mail_can_be_associated_after_it_was_saved_to_inbox() {
        let (_guard, _dir, store) = setup();
        let raw = mail(None);
        let first = save(&store, &raw, "eml").result_id.unwrap();
        let app = crate::commands::create_application(
            &store,
            serde_json::from_value(json!({"company":"Synthetic","title":"Job"})).unwrap(),
        )
        .unwrap()
        .application
        .unwrap();
        let mut request = requests(&store, &raw, "eml").pop().unwrap();
        request.payload["applicationId"] = json!(app.id);
        let saved = crate::plugin_bridge::apply(&request, &store).unwrap();
        assert_eq!(saved.result_id.as_deref(), Some(first.as_str()));
        assert_eq!(
            store
                .get_evidence(&first)
                .unwrap()
                .unwrap()
                .application_id
                .as_deref(),
            Some(app.id.as_str())
        );
    }
    #[test]
    fn a_missing_selected_application_is_rejected_before_staging_a_file() {
        let (_guard, _dir, store) = setup();
        let mut request = requests(&store, &mail(None), "eml").pop().unwrap();
        request.payload["applicationId"] = json!(uuid::Uuid::new_v4().to_string());
        assert_eq!(
            crate::plugin_bridge::apply(&request, &store).unwrap_err(),
            ErrorCode::InvalidPayload
        );
        assert!(store.list_evidence(None).unwrap().is_empty());
        assert!(!store.archive_dir().join("attachments").exists());
    }

    #[test]
    fn a_new_browser_retry_releases_its_abandoned_partial_upload() {
        let (_guard, _dir, store) = setup();
        let mut bytes = mail(None);
        bytes.extend(vec![b'x'; 70000]);
        for _ in 0..6 {
            let parts = requests(&store, &bytes, "eml");
            assert_eq!(
                crate::plugin_bridge::apply(&parts[0], &store)
                    .unwrap()
                    .payload["status"],
                "chunk"
            );
        }
        assert_eq!(
            UPLOADS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .values()
                .filter(|u| u.saved.is_none())
                .count(),
            1
        );
        assert_eq!(save(&store, &bytes, "eml").payload["status"], "saved");
    }

    #[test]
    fn full_digest_and_raw_mail_shape_are_checked_before_importing() {
        let (_guard, _dir, store) = setup();
        let mut request = requests(&store, &mail(Some("bad@example.test")), "eml")
            .pop()
            .unwrap();
        request.payload["sha256"] = json!("a".repeat(64));
        assert_eq!(
            crate::plugin_bridge::apply(&request, &store).unwrap_err(),
            ErrorCode::InvalidPayload
        );
        let html = requests(&store, b"<html>Please log in</html>", "eml")
            .pop()
            .unwrap();
        assert_eq!(
            crate::plugin_bridge::apply(&html, &store).unwrap_err(),
            ErrorCode::InvalidPayload
        );
        assert!(store.list_evidence(None).unwrap().is_empty());
    }
    #[test]
    fn excerpts_are_labelled_as_excerpts_and_never_fabricate_a_message_id_or_date() {
        let (_guard, _dir, store) = setup();
        let bytes = serde_json::to_vec(&json!({"subject":"Interview", "from":"hr@example.test", "sentTime":"昨天", "body":"Tomorrow at ten"})).unwrap();
        let id = save(&store, &bytes, "excerpt").result_id.unwrap();
        let e = store.get_evidence(&id).unwrap().unwrap();
        assert_eq!(e.kind, EvidenceKind::Paste);
        assert!(matches!(
            e.sent_at,
            None | Some(archive_store::Occurred::Unknown)
        ));
        assert!(e.subject.unwrap().contains("网页摘录"));
        assert!(e.body_extract.unwrap().contains("未保存邮件原件及附件"));
        assert_eq!(save(&store, &bytes, "excerpt").result_id.unwrap(), id);
        assert_eq!(store.list_evidence(None).unwrap().len(), 1);
    }
}
