//! The application side of the local IPC.
//!
//! Listening is bound to holding `host.lock`: the unique writer and the unique listener
//! are the same fact rather than two that could disagree (D01 decision 3). The caller
//! therefore starts this only after `DataHost::initialize` succeeded, and the returned
//! handle closes the endpoint when the application shuts down.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use archive_store::ArchiveStore;

use local_ipc::{Endpoint, IpcError, Listener};
use resume_pro_protocol::{CurrentArchive, ErrorCode, Request};

use crate::plugin_bridge::Answer;

/// The application as a caller can see it: who it is, and what it will commit.
///
/// Identity is read per request rather than captured at startup. `restore_epoch` is
/// re-minted when an archive is restored, and a handshake that answered with a stale one
/// would hand the extension an identity its next write would be rejected against.
pub trait Application: Send + Sync + 'static {
    fn identity(&self) -> Option<CurrentArchive>;

    /// Commit one request against the archive. The default has no archive to commit to,
    /// which is the truthful answer for a process that never opened one.
    fn apply(&self, _request: &Request) -> Result<Answer, ErrorCode> {
        Err(ErrorCode::Unavailable)
    }
}

/// The archive this process currently has open.
///
/// Shares the application's own store slot rather than a copy of what it said at startup:
/// `rotate_restore_epoch` changes the epoch in place when an archive is restored, and a
/// closed or never-opened archive has neither an identity nor anywhere to commit.
pub struct OpenArchive {
    store: Arc<Mutex<Option<ArchiveStore>>>,
}

impl OpenArchive {
    pub fn new(store: Arc<Mutex<Option<ArchiveStore>>>) -> Self {
        Self { store }
    }
}

impl Application for OpenArchive {
    fn identity(&self) -> Option<CurrentArchive> {
        // A poisoned lock means a writer panicked mid-change; the epoch behind it cannot
        // be trusted, so this reports no identity rather than a possibly torn one.
        let guard = self.store.lock().ok()?;
        let identity = guard.as_ref()?.identity();
        Some(CurrentArchive {
            archive_id: identity.archive_id,
            restore_epoch: identity.restore_epoch,
        })
    }

    fn apply(&self, request: &Request) -> Result<Answer, ErrorCode> {
        // The same lock the window's own commands take. One writer means one queue: a
        // browser write and a window edit cannot interleave inside the archive.
        let guard = self.store.lock().map_err(|_| ErrorCode::Unavailable)?;
        let store = guard.as_ref().ok_or(ErrorCode::Unavailable)?;
        crate::plugin_bridge::apply(request, store)
    }
}

/// Keeps the accept loop alive. Dropping it stops serving and releases the endpoint.
pub struct IpcService {
    running: Arc<AtomicBool>,
    endpoint: String,
}

impl IpcService {
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }
}

impl Drop for IpcService {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

/// Serve frames on the endpoint for `data_root` until the returned handle is dropped.
///
/// Each connection is handled on its own thread. A Native Messaging host connects once
/// per browser message, so connections are short and numerous rather than long-lived.
pub fn start<A: Application>(
    data_root: &Path,
    application: Arc<A>,
) -> Result<IpcService, IpcError> {
    let endpoint = Endpoint::for_data_root(data_root)?;
    let mut listener = Listener::bind(&endpoint)?;
    let running = Arc::new(AtomicBool::new(true));
    let service = IpcService {
        running: Arc::clone(&running),
        endpoint: endpoint.display(),
    };

    std::thread::spawn(move || {
        while running.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok(stream) => {
                    let application = Arc::clone(&application);
                    std::thread::spawn(move || serve_connection(stream, application.as_ref()));
                }
                Err(err) => {
                    // The endpoint is gone or unusable; nothing here can recover it, and
                    // spinning on a broken listener would burn a core.
                    eprintln!("ipc: accept failed, no longer serving: {err}");
                    return;
                }
            }
        }
    });

    Ok(service)
}

/// Answer frames on one connection until the peer closes it.
///
/// The request is validated again here even though the host already did. The host is a
/// separate process on the other side of a pipe; treating its output as trusted because
/// it is ours would be the same mistake as trusting a local endpoint for being local.
fn serve_connection<S: Read + Write, A: Application + ?Sized>(mut stream: S, application: &A) {
    loop {
        match nm_frame::read_frame(&mut stream) {
            Ok(None) => return,
            Ok(Some(frame)) => {
                // The application is the writer, so a caller reaching it is authorised by
                // construction; origin authorisation happened in the host.
                let Some(response) = answer(&frame, application) else {
                    eprintln!("ipc: frame carries no usable messageId; closing");
                    return;
                };
                if let Err(err) = nm_frame::write_frame(&mut stream, &response) {
                    eprintln!("ipc: cannot write response: {err:?}");
                    return;
                }
            }
            Err(err) => {
                eprintln!("ipc: cannot read frame: {err:?}");
                return;
            }
        }
    }
}

/// Answer one frame as the application.
///
/// Validated again here even though the host already did. The host is a separate process
/// on the other side of a pipe; treating its output as trusted because it is ours would
/// be the same mistake as trusting a local endpoint for being local.
fn answer<A: Application + ?Sized>(frame: &[u8], application: &A) -> Option<Vec<u8>> {
    use resume_pro_protocol::{handshake_response_payload, validate_request_bytes, MessageType};

    match validate_request_bytes(frame) {
        Ok(request) if request.message_type == MessageType::Handshake => {
            let Some(current) = application.identity() else {
                // No archive open means no identity to hand out. Saying so is retryable;
                // answering with a placeholder would have the extension stamp writes with
                // an identity that never existed.
                return crate::nm::error_frame(&request.message_id, ErrorCode::Unavailable);
            };
            let payload = handshake_response_payload(&current, env!("CARGO_PKG_VERSION"));
            serde_json::to_vec(&serde_json::json!({
                "protocolVersion": 1,
                "correlationId": request.message_id,
                "ok": true,
                "payload": payload
            }))
            .ok()
        }
        Ok(request) if request.message_type == MessageType::Health => {
            serde_json::to_vec(&serde_json::json!({
                "protocolVersion": 1,
                "correlationId": request.message_id,
                "ok": true,
                "payload": {}
            }))
            .ok()
        }
        // The write has already committed by the time this returns, so the answer states
        // a fact rather than an intention.
        Ok(request) => match application.apply(&request) {
            Ok(answer) => {
                let mut response = serde_json::json!({
                    "protocolVersion": 1,
                    "correlationId": request.message_id,
                    "ok": true,
                    "payload": answer.payload
                });
                if let Some(result_id) = answer.result_id {
                    response["resultId"] = serde_json::json!(result_id);
                }
                // A response that does not satisfy the contract is a defect on this side,
                // and sending it anyway would push the defect into the extension. Note
                // that the write has already committed: this reports the answer as
                // unusable, not the write as undone.
                if let Err(err) =
                    resume_pro_protocol::validate_response_for_request(&response, &request)
                {
                    eprintln!(
                        "ipc: refusing to send a response that fails validation: {}",
                        err.code
                    );
                    return crate::nm::error_frame(&request.message_id, ErrorCode::Unavailable);
                }
                serde_json::to_vec(&response).ok()
            }
            Err(code) => crate::nm::error_frame(&request.message_id, code),
        },
        Err(err) => {
            let message_id = crate::nm::message_id_of(frame)?;
            crate::nm::error_frame(&message_id, err.code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An archive that is open, or one that is not. Both are real states the application
    /// can be in when a caller arrives.
    struct FakeIdentity(Option<CurrentArchive>);

    impl Application for FakeIdentity {
        fn identity(&self) -> Option<CurrentArchive> {
            self.0.clone()
        }
    }

    fn open_archive() -> Arc<FakeIdentity> {
        Arc::new(FakeIdentity(Some(CurrentArchive {
            archive_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            restore_epoch: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
        })))
    }

    const HANDSHAKE: &str = r#"{"protocolVersion":1,"messageId":"33333333-3333-4333-8333-333333333333","clientInstanceId":"11111111-1111-4111-8111-111111111111","messageType":"handshake","occurredAt":"2026-09-06T12:00:00.000Z","payload":{"pluginVersion":"0.3.0","minProtocolVersion":1,"maxProtocolVersion":1}}"#;

    const HEALTH: &str = r#"{"protocolVersion":1,"messageId":"33333333-3333-4333-8333-333333333333","clientInstanceId":"11111111-1111-4111-8111-111111111111","messageType":"health","occurredAt":"2026-09-06T12:00:00.000Z","payload":{}}"#;

    fn framed(body: &str) -> Vec<u8> {
        let mut wire = (body.len() as u32).to_ne_bytes().to_vec();
        wire.extend_from_slice(body.as_bytes());
        wire
    }

    #[test]
    fn a_client_gets_an_answer_over_the_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let service = start(dir.path(), open_archive()).unwrap();
        assert!(!service.endpoint().is_empty());

        let endpoint = Endpoint::for_data_root(dir.path()).unwrap();
        let mut client = local_ipc::connect(&endpoint).unwrap();
        nm_frame::write_frame(&mut client, framed(HEALTH)[4..].to_vec().as_slice()).unwrap();
        let reply = nm_frame::read_frame(&mut client).unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&reply).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(
            value["correlationId"],
            "33333333-3333-4333-8333-333333333333"
        );
    }

    #[test]
    fn two_clients_are_served_by_the_one_listener() {
        // A Native Messaging host connects once per browser message, so several arrive at
        // the same endpoint. None of them may need a second application process.
        let dir = tempfile::tempdir().unwrap();
        let _service = start(dir.path(), open_archive()).unwrap();
        let endpoint = Endpoint::for_data_root(dir.path()).unwrap();

        for _ in 0..2 {
            let mut client = local_ipc::connect(&endpoint).unwrap();
            nm_frame::write_frame(&mut client, framed(HEALTH)[4..].to_vec().as_slice()).unwrap();
            let reply = nm_frame::read_frame(&mut client).unwrap().unwrap();
            let value: serde_json::Value = serde_json::from_slice(&reply).unwrap();
            assert_eq!(value["ok"], true);
        }
    }

    #[test]
    fn dropping_the_service_releases_the_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let service = start(dir.path(), open_archive()).unwrap();
        drop(service);
        // The accept loop may still be inside accept(); rebinding is what proves the
        // endpoint is free, and it must not report AlreadyListening forever.
        let endpoint = Endpoint::for_data_root(dir.path()).unwrap();
        let mut attempts = 0;
        loop {
            match Listener::bind(&endpoint) {
                Ok(_) => break,
                Err(IpcError::AlreadyListening) if attempts < 20 => {
                    attempts += 1;
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(err) => panic!("the endpoint was never released: {err}"),
            }
        }
    }

    #[test]
    fn a_handshake_carries_the_identity_writes_will_be_stamped_with() {
        let reply = answer(&framed(HANDSHAKE)[4..], open_archive().as_ref()).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&reply).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(
            value["payload"]["archiveId"],
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        );
        assert_eq!(
            value["payload"]["restoreEpoch"],
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        );
        assert_eq!(value["payload"]["minProtocolVersion"], 1);
        assert!(
            value["payload"]["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c == "job.save"),
            "the extension learns what it may send from this list"
        );
    }

    #[test]
    fn a_handshake_without_an_open_archive_is_retryable_not_invented() {
        // Answering with a placeholder identity would have the extension stamp writes
        // with one that never existed, and every such write would then be rejected.
        let closed = Arc::new(FakeIdentity(None));
        let reply = answer(&framed(HANDSHAKE)[4..], closed.as_ref()).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&reply).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "unavailable");
        assert_eq!(value["error"]["retryable"], true);
        assert!(value["payload"].get("archiveId").is_none());
    }

    #[test]
    fn the_identity_is_read_per_request_not_captured_once() {
        // restore_epoch is re-minted when an archive is restored. A handshake answering
        // with a stale one would hand out an identity the next write is rejected against.
        struct Rotating(Mutex<u32>);
        impl Application for Rotating {
            fn identity(&self) -> Option<CurrentArchive> {
                let mut n = self.0.lock().unwrap();
                *n += 1;
                Some(CurrentArchive {
                    archive_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                    restore_epoch: format!("bbbbbbbb-bbbb-4bbb-8bbb-{:012}", n),
                })
            }
        }
        let rotating = Arc::new(Rotating(Mutex::new(0)));
        let first = answer(&framed(HANDSHAKE)[4..], rotating.as_ref()).unwrap();
        let second = answer(&framed(HANDSHAKE)[4..], rotating.as_ref()).unwrap();
        let a: serde_json::Value = serde_json::from_slice(&first).unwrap();
        let b: serde_json::Value = serde_json::from_slice(&second).unwrap();
        assert_ne!(a["payload"]["restoreEpoch"], b["payload"]["restoreEpoch"]);
    }

    /// A real archive behind a real endpoint, with no window ever created.
    fn open_store(
        dir: &Path,
    ) -> (
        Arc<Mutex<Option<ArchiveStore>>>,
        archive_store::ArchiveIdentity,
    ) {
        let archive = dir.join("archive");
        std::fs::create_dir_all(&archive).unwrap();
        let store = crate::commands::open_store(&archive, &dir.join("current.json")).unwrap();
        let identity = store.identity();
        (Arc::new(Mutex::new(Some(store))), identity)
    }

    fn job_save(identity: &archive_store::ArchiveIdentity) -> Vec<u8> {
        let mut payload = serde_json::json!({
            "sourceRestoreEpoch": identity.restore_epoch,
            "company": "Synthetic Ltd",
            "title": "Engineer",
            "sourceUrl": "https://jobs.example.test/1"
        });
        payload["payloadSha256"] =
            serde_json::json!(resume_pro_protocol::payload_body_sha256(&payload).unwrap());
        serde_json::to_vec(&serde_json::json!({
            "protocolVersion": 1,
            "messageId": "22222222-2222-4222-8222-222222222222",
            "clientInstanceId": "11111111-1111-4111-8111-111111111111",
            "messageType": "job.save",
            "occurredAt": "2026-09-06T12:00:00.000Z",
            "archiveId": identity.archive_id,
            "restoreEpoch": identity.restore_epoch,
            "payload": payload
        }))
        .unwrap()
    }

    #[test]
    fn a_job_saved_from_the_browser_is_in_the_archive_with_no_window_open() {
        // The whole point of the host: nothing here creates a window, and the row is in
        // the archive by the time the extension has its answer.
        let dir = tempfile::tempdir().unwrap();
        let (shared, identity) = open_store(dir.path());
        let _service = start(dir.path(), Arc::new(OpenArchive::new(Arc::clone(&shared)))).unwrap();

        // The host side, reached the way the browser reaches it. The program path cannot
        // exist, so a cold start would fail rather than quietly succeed.
        let mut backend = crate::nm::AppBackend {
            data_root: dir.path().to_path_buf(),
            program: dir.path().join("must-not-be-started"),
        };
        let caller = crate::nm::Caller::Authorised("chrome-extension://abcdefghijklmnop/".into());
        let raw = crate::nm::response_for_with(&job_save(&identity), &caller, &mut backend)
            .expect("the host must answer");
        let response: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(response["ok"], true, "response was {response}");
        let result_id = response["resultId"]
            .as_str()
            .expect("a write names what it produced");

        let guard = shared.lock().unwrap();
        let found = guard
            .as_ref()
            .unwrap()
            .query_candidates(
                "Synthetic Ltd",
                "Engineer",
                Some("https://jobs.example.test/1"),
            )
            .unwrap();
        assert_eq!(found.exact.len(), 1);
        assert_eq!(found.exact[0].id, result_id);
    }

    #[test]
    fn the_same_browser_message_twice_over_two_connections_saves_one_application() {
        // Two tabs, or one tab retrying after a lost answer: each browser message opens
        // its own connection, and neither may produce a second application.
        let dir = tempfile::tempdir().unwrap();
        let (shared, identity) = open_store(dir.path());
        let _service = start(dir.path(), Arc::new(OpenArchive::new(Arc::clone(&shared)))).unwrap();
        let mut backend = crate::nm::AppBackend {
            data_root: dir.path().to_path_buf(),
            program: dir.path().join("must-not-be-started"),
        };
        let caller = crate::nm::Caller::Authorised("chrome-extension://abcdefghijklmnop/".into());

        let mut result_ids = Vec::new();
        for _ in 0..2 {
            let raw = crate::nm::response_for_with(&job_save(&identity), &caller, &mut backend)
                .expect("the host must answer");
            let response: serde_json::Value = serde_json::from_slice(&raw).unwrap();
            assert_eq!(response["ok"], true, "response was {response}");
            result_ids.push(response["resultId"].as_str().unwrap().to_string());
        }
        assert_eq!(result_ids[0], result_ids[1]);

        let guard = shared.lock().unwrap();
        let found = guard
            .as_ref()
            .unwrap()
            .query_candidates(
                "Synthetic Ltd",
                "Engineer",
                Some("https://jobs.example.test/1"),
            )
            .unwrap();
        assert_eq!(
            found.exact.len(),
            1,
            "a retry must not duplicate the application"
        );
    }

    #[test]
    fn a_write_that_cannot_be_committed_is_reported_as_an_error_not_as_success() {
        // No archive open: the answer must say so rather than claim a save that no
        // storage ever received.
        let dir = tempfile::tempdir().unwrap();
        let (_shared, identity) = open_store(dir.path());
        let empty: Arc<Mutex<Option<ArchiveStore>>> = Arc::new(Mutex::new(None));
        let reply = answer(&job_save(&identity), &OpenArchive::new(empty)).unwrap();
        let response: serde_json::Value = serde_json::from_slice(&reply).unwrap();
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "unavailable");
        assert!(response.get("resultId").is_none());
    }
}
