//! The application side of the local IPC.
//!
//! Listening is bound to holding `host.lock`: the unique writer and the unique listener
//! are the same fact rather than two that could disagree (D01 decision 3). The caller
//! therefore starts this only after `DataHost::initialize` succeeded, and the returned
//! handle closes the endpoint when the application shuts down.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use local_ipc::{Endpoint, IpcError, Listener};

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
pub fn start(data_root: &Path) -> Result<IpcService, IpcError> {
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
                    std::thread::spawn(move || serve_connection(stream));
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
fn serve_connection<S: Read + Write>(mut stream: S) {
    loop {
        match nm_frame::read_frame(&mut stream) {
            Ok(None) => return,
            Ok(Some(frame)) => {
                // The application is the writer, so a caller reaching it is authorised by
                // construction; origin authorisation happened in the host.
                let Some(response) = crate::nm::response_for(&frame, &crate::nm::Caller::Unidentified)
                else {
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

#[cfg(test)]
mod tests {
    use super::*;

    const HEALTH: &str = r#"{"protocolVersion":1,"messageId":"33333333-3333-4333-8333-333333333333","clientInstanceId":"11111111-1111-4111-8111-111111111111","messageType":"health","occurredAt":"2026-09-06T12:00:00.000Z","payload":{}}"#;

    fn framed(body: &str) -> Vec<u8> {
        let mut wire = (body.len() as u32).to_ne_bytes().to_vec();
        wire.extend_from_slice(body.as_bytes());
        wire
    }

    #[test]
    fn a_client_gets_an_answer_over_the_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let service = start(dir.path()).unwrap();
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
        let _service = start(dir.path()).unwrap();
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
        let service = start(dir.path()).unwrap();
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
}
