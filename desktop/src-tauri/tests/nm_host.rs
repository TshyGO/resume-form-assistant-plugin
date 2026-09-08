//! Drives the real binary over stdio, the way a browser would. No registration, no
//! browser, no system state.

use std::io::Write;
use std::process::{Command, Stdio};

const HEALTH: &str = r#"{"protocolVersion":1,"messageId":"33333333-3333-4333-8333-333333333333","clientInstanceId":"11111111-1111-4111-8111-111111111111","messageType":"health","occurredAt":"2026-09-06T12:00:00.000Z","payload":{}}"#;
const ORIGIN: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";

fn framed(body: &str) -> Vec<u8> {
    let mut wire = (body.len() as u32).to_ne_bytes().to_vec();
    wire.extend_from_slice(body.as_bytes());
    wire
}

/// Send `input` to a fresh host process started with `args`, and return
/// (exit code, stdout, stderr).
fn run_host(args: &[&str], input: Vec<u8>) -> (i32, Vec<u8>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_resume-pro-desktop"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary must start");
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(&input)
        .expect("the host must accept input");
    let output = child.wait_with_output().expect("the host must exit");
    (
        output.status.code().unwrap_or(-1),
        output.stdout,
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// Assert `stdout` is one successful health frame and nothing else.
///
/// The body is compared field by field rather than to a fixed byte string, because
/// serde_json orders keys alphabetically rather than as written. The strict part is kept
/// another way: stdout must be exactly the prefix plus the length it declares, which is
/// what proves no stray byte rode along.
fn assert_single_health_frame(stdout: &[u8]) {
    assert!(stdout.len() > 4, "stdout is too short to be a frame");
    let declared = u32::from_ne_bytes(stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(
        stdout.len(),
        4 + declared,
        "stdout must be exactly one protocol frame with nothing after it"
    );
    let body: serde_json::Value =
        serde_json::from_slice(&stdout[4..]).expect("the frame body must be JSON");
    assert_eq!(body["protocolVersion"], 1);
    assert_eq!(body["ok"], true);
    assert_eq!(
        body["correlationId"],
        "33333333-3333-4333-8333-333333333333"
    );
    assert_eq!(body["payload"], serde_json::json!({}));
    assert!(body.get("error").is_none());
}

#[test]
fn the_test_entry_point_behaves_identically() {
    let (code, stdout, _stderr) = run_host(&["--nm-host"], framed(HEALTH));
    assert_eq!(code, 0);
    assert_single_health_frame(&stdout);
}

#[test]
fn the_caller_origin_is_recorded_on_stderr() {
    let tmp = isolated_data_dir("origin-recorded");
    let (_code, _stdout, stderr) = run_host_with_data_dir(&[ORIGIN], &tmp, framed(HEALTH));
    assert!(
        stderr.contains(ORIGIN),
        "the caller must be recorded: {stderr}"
    );
    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn a_closed_port_exits_cleanly_and_prints_nothing() {
    let (code, stdout, stderr) = run_host(&["--nm-host"], Vec::new());
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
    // stderr carries one line naming the caller; a clean close must add no failure.
    assert!(
        !stderr.contains("cannot") && !stderr.contains("closing"),
        "a clean close is not an error: {stderr}"
    );
}

#[test]
fn an_oversized_prefix_is_refused_on_stderr_and_stdout_stays_empty() {
    let mut wire = u32::MAX.to_ne_bytes().to_vec();
    wire.extend_from_slice(b"body");
    let (code, stdout, stderr) = run_host(&["--nm-host"], wire);
    assert_eq!(code, 2);
    assert!(stdout.is_empty(), "a refusal must not put bytes on stdout");
    assert!(
        stderr.contains("nm-host"),
        "the reason must reach stderr: {stderr}"
    );
}

#[test]
fn newline_bytes_in_a_request_survive_the_round_trip() {
    // Text-mode stdio would rewrite 0x0A as 0x0D 0x0A and corrupt the frame. ADR 3.7
    // requires binary stdout; this asserts it end to end through the real process.
    let pretty = "{\n  \"protocolVersion\": 1,\n  \"messageId\": \"33333333-3333-4333-8333-333333333333\",\n  \"clientInstanceId\": \"11111111-1111-4111-8111-111111111111\",\n  \"messageType\": \"health\",\n  \"occurredAt\": \"2026-09-06T12:00:00.000Z\",\n  \"payload\": {}\n}";
    assert!(pretty.contains('\n'));
    let (code, stdout, _stderr) = run_host(&["--nm-host"], framed(pretty));
    assert_eq!(code, 0);
    assert_single_health_frame(&stdout);
    assert!(
        !stdout.contains(&b'\r'),
        "stdout must not gain carriage returns"
    );
}

/// Run a host whose data directory is `data_dir`, so the pairing settings under test are
/// the only ones it can see. `RESUMEPRO_DATA_DIR` is the same override D02 uses.
fn run_host_with_data_dir(
    args: &[&str],
    data_dir: &std::path::Path,
    input: Vec<u8>,
) -> (i32, Vec<u8>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_resume-pro-desktop"))
        .args(args)
        .env("RESUMEPRO_DATA_DIR", data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary must start");
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(&input)
        .expect("the host must accept input");
    let output = child.wait_with_output().expect("the host must exit");
    (
        output.status.code().unwrap_or(-1),
        output.stdout,
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// A data directory of this test's own, so the developer's real ResumePro directory is
/// never read or created by the suite.
fn isolated_data_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("rp-nm-{label}-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn error_code_of(stdout: &[u8]) -> String {
    assert!(stdout.len() > 4, "stdout is too short to be a frame");
    let declared = u32::from_ne_bytes(stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(
        stdout.len(),
        4 + declared,
        "stdout must be exactly one frame"
    );
    let body: serde_json::Value = serde_json::from_slice(&stdout[4..]).unwrap();
    assert_eq!(body["ok"], false);
    body["error"]["code"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

#[test]
fn an_unpaired_caller_is_refused_per_message_and_the_port_stays_open() {
    // Nothing is paired in this data directory, so the caller cannot be authorised.
    let tmp = isolated_data_dir("unpaired");

    let mut two = framed(HEALTH);
    two.extend_from_slice(&framed(HEALTH));
    let (code, stdout, stderr) = run_host_with_data_dir(&[ORIGIN], &tmp, two);

    assert_eq!(code, 0, "the port must not be dropped: {stderr}");
    assert!(
        stderr.contains("not paired"),
        "the reason must reach stderr: {stderr}"
    );
    // Two requests, two refusals, nothing else.
    let first = u32::from_ne_bytes(stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(error_code_of(&stdout[..4 + first]), "identity_not_allowed");
    assert_eq!(error_code_of(&stdout[4 + first..]), "identity_not_allowed");

    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn a_paired_caller_is_served() {
    let tmp = isolated_data_dir("paired");
    // The shape D02's pairing form saves.
    std::fs::write(
        tmp.join("settings.json"),
        r#"{"chromeExtensionId":"abcdefghijklmnopabcdefghijklmnop","edgeExtensionId":""}"#,
    )
    .unwrap();

    let (code, stdout, stderr) = run_host_with_data_dir(&[ORIGIN], &tmp, framed(HEALTH));
    assert_eq!(code, 0);
    assert!(
        stderr.contains("authorised"),
        "the caller must be recorded as authorised: {stderr}"
    );
    assert_single_health_frame(&stdout);

    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn the_test_entry_point_never_touches_the_real_settings() {
    // A relative RESUMEPRO_DATA_DIR makes path resolution fail, which the host reports on
    // stderr. With no origin there is nothing to authorise, so pairing must not be
    // consulted at all and that message must not appear. Without this the --nm-host tests
    // read the developer's real ResumePro settings, which is what the isolation added
    // alongside was supposed to prevent.
    let (code, stdout, stderr) = run_host_with_data_dir(
        &["--nm-host"],
        std::path::Path::new("relative-not-absolute"),
        framed(HEALTH),
    );
    assert_eq!(code, 0);
    assert_single_health_frame(&stdout);
    assert!(
        !stderr.contains("cannot resolve data paths"),
        "pairing must not be read when there is no origin: {stderr}"
    );
}

#[test]
fn an_origin_does_make_the_host_consult_pairing() {
    // The counterpart to the test above: with an origin, resolution is attempted, so the
    // same broken override is reported. This is what proves the previous test observes a
    // real difference rather than a message that never appears.
    let (code, _stdout, stderr) = run_host_with_data_dir(
        &[ORIGIN],
        std::path::Path::new("relative-not-absolute"),
        framed(HEALTH),
    );
    assert_eq!(code, 0);
    assert!(
        stderr.contains("cannot resolve data paths"),
        "an origin must send the host to pairing: {stderr}"
    );
}

// ---------------------------------------------------------------------------
// End to end: a real host process reaching a real application process.
// ---------------------------------------------------------------------------

const JOB_SAVE: &str = r#"{"protocolVersion":1,"messageId":"44444444-4444-4444-8444-444444444444","clientInstanceId":"11111111-1111-4111-8111-111111111111","messageType":"job.save","occurredAt":"2026-09-06T12:00:00.000Z","payload":{"sourceRestoreEpoch":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","company":"合成公司","title":"后端实习","payloadSha256":"1ea8fcf15e56dd83a5e7f8e9adb0c34b94bc28fd5c1b51400ecf597d1f5cc8c4"},"archiveId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","restoreEpoch":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}"#;

fn error_of(stdout: &[u8]) -> (String, bool) {
    assert!(stdout.len() > 4, "stdout is too short to be a frame");
    let declared = u32::from_ne_bytes(stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(
        stdout.len(),
        4 + declared,
        "stdout must be exactly one frame"
    );
    let body: serde_json::Value = serde_json::from_slice(&stdout[4..]).unwrap();
    (
        body["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        body["ok"].as_bool().unwrap_or(false),
    )
}

fn paired_dir(label: &str) -> std::path::PathBuf {
    let dir = isolated_data_dir(label);
    std::fs::write(
        dir.join("settings.json"),
        format!(
            r#"{{"chromeExtensionId":"{}","edgeExtensionId":""}}"#,
            EXT_ID
        ),
    )
    .unwrap();
    dir
}

const EXT_ID: &str = "abcdefghijklmnopabcdefghijklmnop";

#[test]
fn a_request_the_host_cannot_answer_alone_is_not_reported_as_success() {
    // A relative RESUMEPRO_DATA_DIR leaves no data directory to reach an application in,
    // so the host has nowhere to forward to. It must say the service is unavailable
    // rather than invent a successful write.
    //
    // The data directory is deliberately unusable rather than merely empty: a usable one
    // would send the host into a real cold start, launching a desktop application from
    // the test suite and leaving it running.
    let (code, stdout, stderr) = run_host_with_data_dir(
        &["--nm-host"],
        std::path::Path::new("relative-not-absolute"),
        framed(JOB_SAVE),
    );
    assert_eq!(code, 0, "{stderr}");
    let (error, ok) = error_of(&stdout);
    assert!(
        !ok,
        "a write with nothing behind it must not report success"
    );
    assert_eq!(error, "unavailable", "and must be retryable: {stderr}");
}

#[test]
fn health_is_answered_without_starting_the_application() {
    // health asks nothing of the archive, so routing it through the application would put
    // a cold start in front of a liveness check. An empty but usable data directory means
    // nothing is listening, so a health that waited would take the full cold-start budget.
    let tmp = paired_dir("health-alone");
    let started = std::time::Instant::now();
    let (code, stdout, _stderr) = run_host_with_data_dir(&[ORIGIN], &tmp, framed(HEALTH));
    assert_eq!(code, 0);
    assert_single_health_frame(&stdout);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "health must not wait on a cold start"
    );
    std::fs::remove_dir_all(&tmp).ok();
}
