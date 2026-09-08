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
    assert!(stderr.contains(ORIGIN), "the caller must be recorded: {stderr}");
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
    assert_eq!(stdout.len(), 4 + declared, "stdout must be exactly one frame");
    let body: serde_json::Value = serde_json::from_slice(&stdout[4..]).unwrap();
    assert_eq!(body["ok"], false);
    body["error"]["code"].as_str().unwrap_or_default().to_string()
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
