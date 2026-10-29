use super::*;
use std::{
    io::{Read, Write},
    sync::mpsc,
};

fn config(endpoint: String) -> Config {
    Config {
        endpoint: Some(endpoint),
        platform: Some("windows"),
        timeout: Duration::from_millis(120),
    }
}
fn service() -> (tempfile::TempDir, Arc<Telemetry>) {
    let root = tempfile::tempdir().unwrap();
    let telemetry = Telemetry::load(
        root.path().to_path_buf(),
        config("http://127.0.0.1:9/v1/activity".into()),
    );
    (root, telemetry)
}
fn server(status: u16, delay: Duration, headers: &str) -> (String, mpsc::Receiver<String>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::channel();
    let headers = headers.to_owned();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0u8; 1024];
            let count = stream.read(&mut chunk).unwrap();
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                let length: usize = head
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length: ")
                            .and_then(|value| value.parse().ok())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        tx.send(String::from_utf8(bytes).unwrap()).unwrap();
        std::thread::sleep(delay);
        let _ = write!(
            stream,
            "HTTP/1.1 {status} result\r\nContent-Length: 0\r\nConnection: close\r\n{headers}\r\n"
        );
    });
    (format!("http://{address}/v1/activity"), rx)
}
fn request_json(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw.split_once("\r\n\r\n").unwrap().1).unwrap()
}

#[test]
fn first_install_is_on_but_notice_and_visible_use_are_required_before_identifier() {
    let (_root, service) = service();
    assert!(service.status().unwrap().enabled);
    assert!(service.status().unwrap().notice_required);
    assert!(service.reserve("2026-10-11", true).is_none());
    assert!(service
        .inner
        .lock()
        .unwrap()
        .stored
        .installation_id
        .is_none());
    service.acknowledge_notice().unwrap();
    assert!(service.reserve("2026-10-11", false).is_none());
    assert!(service.reserve("2026-02-30", true).is_none());
    assert!(service
        .inner
        .lock()
        .unwrap()
        .stored
        .installation_id
        .is_none());
    assert!(service.reserve("2026-10-11", true).is_some());
}

#[test]
fn default_builds_are_dormant_and_do_not_allocate_an_identifier() {
    assert!(Config::release().endpoint.is_none());
    let root = tempfile::tempdir().unwrap();
    let service = Telemetry::new(root.path().to_path_buf());
    service.acknowledge_notice().unwrap();
    assert!(service.reserve("2026-10-11", true).is_none());
    assert!(service
        .inner
        .lock()
        .unwrap()
        .stored
        .installation_id
        .is_none());
}

#[test]
fn opt_out_survives_restart_upgrade_and_missing_state_without_feedback_dependency() {
    let (root, service) = service();
    std::fs::write(
        root.path().join("feedback-state.json"),
        br#"{"consent":true,"anonymous_id":"feedback"}"#,
    )
    .unwrap();
    service.change(false).unwrap();
    let restarted = Telemetry::load(
        root.path().to_path_buf(),
        config("http://127.0.0.1:9/v1/activity".into()),
    );
    assert!(!restarted.status().unwrap().enabled);
    assert!(restarted.reserve("2026-10-12", true).is_none());
    std::fs::remove_file(&service.path).unwrap();
    let lost = Telemetry::load(
        root.path().to_path_buf(),
        config("http://127.0.0.1:9/v1/activity".into()),
    );
    assert!(!lost.status().unwrap().enabled);
    assert!(!lost.status().unwrap().available);
    assert!(
        std::fs::read_to_string(root.path().join("feedback-state.json"))
            .unwrap()
            .contains("feedback")
    );
}

#[test]
fn corrupt_oversized_unknown_version_and_invalid_id_fail_closed() {
    let (root, service) = service();
    for bytes in [b"not json".to_vec(), vec![b' '; 4097],
        br#"{"settings_version":99,"enabled":true,"notice_version":1,"installation_id":null,"desktop_attempt_date":null}"#.to_vec(),
        br#"{"settings_version":1,"enabled":true,"notice_version":1,"installation_id":"archive-id","desktop_attempt_date":null}"#.to_vec()] {
        std::fs::write(&service.path, bytes).unwrap();
        let broken = Telemetry::load(root.path().to_path_buf(), config("http://127.0.0.1:9/v1/activity".into()));
        assert!(!broken.status().unwrap().enabled);
        assert!(broken.reserve("2026-10-11", true).is_none());
        assert!(broken.inner.lock().unwrap().stored.installation_id.is_none());
    }
}

#[test]
fn concurrent_signals_reserve_once_and_restart_preserves_quota_and_id() {
    let (root, service) = service();
    service.acknowledge_notice().unwrap();
    let tasks: Vec<_> = (0..100)
        .map(|_| {
            let service = Arc::clone(&service);
            std::thread::spawn(move || service.reserve("2026-12-31", true))
        })
        .collect();
    let bodies: Vec<_> = tasks
        .into_iter()
        .filter_map(|task| task.join().unwrap())
        .collect();
    assert_eq!(bodies.len(), 1);
    let restarted = Telemetry::load(
        root.path().to_path_buf(),
        config("http://127.0.0.1:9/v1/activity".into()),
    );
    assert!(restarted.reserve("2026-12-31", true).is_none());
    assert!(restarted.reserve("2026-12-30", true).is_none());
    let next = restarted.reserve("2027-01-01", true).unwrap();
    assert_eq!(bodies[0].installation_id, next.installation_id);
}

#[test]
fn state_write_failure_suppresses_request_and_disable_fallback_is_durable() {
    let (root, service) = service();
    service.acknowledge_notice().unwrap();
    service.reserve("2026-10-10", true).unwrap();
    std::fs::create_dir(service.path.with_extension("json.tmp")).unwrap();
    assert!(service.reserve("2026-10-11", true).is_none());
    assert!(!service.status().unwrap().available);
    service.change(false).unwrap();
    let restarted = Telemetry::load(
        root.path().to_path_buf(),
        config("http://127.0.0.1:9/v1/activity".into()),
    );
    assert!(!restarted.status().unwrap().enabled);
    let saved = std::fs::read_to_string(&service.path).unwrap();
    assert!(saved.contains("\"installation_id\":null"));
    assert!(saved.contains("\"desktop_attempt_date\":null"));
}

#[test]
fn complete_persistence_failure_still_stops_this_process_and_reports_the_limit() {
    let (_root, service) = service();
    service.acknowledge_notice().unwrap();
    service.reserve("2026-10-10", true).unwrap();
    std::fs::remove_file(&service.path).unwrap();
    std::fs::create_dir(&service.path).unwrap();
    std::fs::create_dir(service.path.with_extension("json.tmp")).unwrap();
    let failure = service.change(false).unwrap_err();
    assert_eq!(failure.message, OFF_SAVE_ERROR);
    assert!(
        failure.old_id.is_some(),
        "even persistence failure keeps a one-shot deletion handoff"
    );
    assert!(!service.status().unwrap().enabled);
    assert!(service.reserve("2026-10-11", true).is_none());
    assert!(service
        .inner
        .lock()
        .unwrap()
        .stored
        .installation_id
        .is_none());
}

#[test]
fn reenable_generates_new_id_only_at_next_use_and_does_not_replay_activity() {
    let (_root, service) = service();
    service.acknowledge_notice().unwrap();
    let old = service.reserve("2026-10-11", true).unwrap().installation_id;
    assert_eq!(service.change(false).unwrap().1, Some(old.clone()));
    assert!(service.reserve("2026-10-12", true).is_none());
    service.change(true).unwrap();
    assert!(service
        .inner
        .lock()
        .unwrap()
        .stored
        .installation_id
        .is_none());
    let new = service.reserve("2026-10-13", true).unwrap().installation_id;
    assert_ne!(old, new);
    // Re-saving ON cannot reset today's quota or identifier.
    service.change(true).unwrap();
    assert!(service.reserve("2026-10-13", true).is_none());
}

#[test]
fn changed_notice_does_not_send_or_reset_existing_choice_without_new_disclosure() {
    let (root, service) = service();
    service.acknowledge_notice().unwrap();
    let mut saved = service.inner.lock().unwrap().stored.clone();
    saved.notice_version = Some(0);
    save_state(&service.path, &saved).unwrap();
    let updated = Telemetry::load(
        root.path().to_path_buf(),
        config("http://127.0.0.1:9/v1/activity".into()),
    );
    assert!(updated.status().unwrap().notice_required);
    assert!(updated.reserve("2026-10-11", true).is_none());
}

#[tokio::test]
async fn real_http_body_is_exactly_the_contract_and_failures_use_daily_quota() {
    let root = tempfile::tempdir().unwrap();
    let (endpoint, captured) = server(500, Duration::ZERO, "");
    let service = Telemetry::load(root.path().to_path_buf(), config(endpoint));
    service.acknowledge_notice().unwrap();
    service.touch("2026-10-11", true).await;
    let raw = captured.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(raw.starts_with("POST /v1/activity "));
    assert!(!raw.to_lowercase().contains("authorization:"));
    assert!(!raw.to_lowercase().contains("user-agent:"));
    let body = request_json(&raw);
    assert_eq!(body.as_object().unwrap().len(), 5);
    assert_eq!(body["schema_version"], 1);
    assert_eq!(body["platform"], "windows");
    assert_eq!(body["surface"], "desktop");
    assert_eq!(body["app_version"], env!("CARGO_PKG_VERSION"));
    assert!(uuid::Uuid::parse_str(body["installation_id"].as_str().unwrap()).is_ok());
    assert!(service.reserve("2026-10-11", true).is_none());
    let status = serde_json::to_string(&service.status().unwrap()).unwrap();
    assert!(!status.contains(body["installation_id"].as_str().unwrap()));
}

#[tokio::test]
async fn redirects_are_not_followed_and_delete_has_only_two_fields() {
    let root = tempfile::tempdir().unwrap();
    let target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    target.set_nonblocking(true).unwrap();
    let (endpoint, captured) = server(
        307,
        Duration::ZERO,
        &format!("Location: http://{}/leak\r\n", target.local_addr().unwrap()),
    );
    let service = Telemetry::load(root.path().to_path_buf(), config(endpoint));
    service.acknowledge_notice().unwrap();
    let old = service.reserve("2026-10-11", true).unwrap().installation_id;
    let (_, id, revision) = service.change(false).unwrap();
    let receipt = service.delete(id.unwrap(), revision).await.unwrap();
    assert_eq!(receipt.deletion, Deletion::Unconfirmed);
    let raw = captured.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(raw.starts_with("DELETE /v1/activity "));
    assert!(!raw.to_lowercase().contains("user-agent:"));
    assert_eq!(
        request_json(&raw),
        serde_json::json!({ "schema_version": 1, "installation_id": old })
    );
    assert!(target.accept().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabling_cancels_an_inflight_post_without_waiting_for_timeout() {
    let root = tempfile::tempdir().unwrap();
    // The server answers only after 30 s and the client would wait 60 s, so the request can end
    // within the bound below only by being cancelled. The bound leaves a slow runner room for
    // saving the choice, which happens before the request is awaited.
    let (endpoint, captured) = server(204, Duration::from_secs(30), "");
    let mut cfg = config(endpoint);
    cfg.timeout = Duration::from_secs(60);
    let service = Telemetry::load(root.path().to_path_buf(), cfg);
    service.acknowledge_notice().unwrap();
    let active = Arc::clone(&service);
    let request = tokio::spawn(async move {
        active.touch("2026-10-11", true).await;
    });
    captured.recv_timeout(Duration::from_secs(10)).unwrap();
    let (_, old, _) = service.change(false).unwrap();
    assert!(old.is_some());
    tokio::time::timeout(Duration::from_secs(5), request)
        .await
        .expect("disabling must cancel the in-flight post")
        .unwrap();
    assert!(!service.status().unwrap().enabled);
}

#[tokio::test]
async fn timeout_does_not_retry_and_late_delete_cannot_change_a_new_choice() {
    let root = tempfile::tempdir().unwrap();
    let (endpoint, captured) = server(204, Duration::from_millis(500), "");
    let service = Telemetry::load(root.path().to_path_buf(), config(endpoint));
    service.acknowledge_notice().unwrap();
    service.touch("2026-10-11", true).await;
    captured.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(service.reserve("2026-10-11", true).is_none());
    let (_, id, revision) = service.change(false).unwrap();
    service.change(true).unwrap();
    let receipt = service.delete(id.unwrap(), revision).await.unwrap();
    assert!(receipt.enabled);
    assert_eq!(receipt.deletion, Deletion::None);
}

#[tokio::test]
async fn successful_delete_confirms_only_corresponding_details() {
    let root = tempfile::tempdir().unwrap();
    let (endpoint, captured) = server(204, Duration::ZERO, "");
    let service = Telemetry::load(root.path().to_path_buf(), config(endpoint));
    service.acknowledge_notice().unwrap();
    service.reserve("2026-10-11", true).unwrap();
    let (_, id, revision) = service.change(false).unwrap();
    assert_eq!(
        service
            .delete(id.unwrap(), revision)
            .await
            .unwrap()
            .deletion,
        Deletion::Deleted
    );
    captured.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(!std::fs::read_to_string(&service.path)
        .unwrap()
        .contains("installation_id\":\""));
}

#[test]
fn release_destination_must_be_https_without_credentials_or_extra_url_fields() {
    assert!(checked_endpoint("https://example.workers.dev/v1/activity"));
    for url in [
        "http://example.test/v1/activity",
        "https://token@example.test/v1/activity",
        "https://example.test/v1/activity?q=1",
        "https://example.test/v1/activity#x",
        "https://example.test/feedback",
    ] {
        assert!(!checked_endpoint(url));
    }
}

#[test]
fn only_reviewed_release_builds_can_enable_statistics_in_ci() {
    assert!(!release_build_allowed(true, false, false, true, true));
    assert!(!release_build_allowed(false, true, false, true, true));
    assert!(!release_build_allowed(false, false, true, false, true));
    assert!(!release_build_allowed(false, false, true, true, false));
    assert!(release_build_allowed(false, false, true, true, true));
    assert!(release_build_allowed(false, false, false, false, true));
}

#[test]
fn desktop_and_both_browsers_share_one_identifier_with_independent_daily_surface_quotas() {
    let (root, service) = service();
    assert!(service
        .reserve_surface("2026-10-11", true, "extension")
        .is_none());
    service.acknowledge_notice().unwrap();
    let desktop = service
        .reserve_surface("2026-10-11", true, "desktop")
        .unwrap();
    let extension = service
        .reserve_surface("2026-10-11", true, "extension")
        .unwrap();
    assert_eq!(desktop.installation_id, extension.installation_id);
    assert_eq!(extension.surface, "extension");
    assert!(service
        .reserve_surface("2026-10-11", true, "extension")
        .is_none());
    let restarted = Telemetry::load(
        root.path().to_path_buf(),
        config("http://127.0.0.1:9/v1/activity".into()),
    );
    assert!(restarted
        .reserve_surface("2026-10-11", true, "extension")
        .is_none());
    assert!(restarted
        .reserve_surface("2026-10-11", true, "desktop")
        .is_none());
    service.change(false).unwrap();
    let state = service.inner.lock().unwrap();
    assert!(state.stored.installation_id.is_none());
    assert!(state.stored.extension_attempt_date.is_none());
}
