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
fn a_browser_origin_starts_the_host_and_stdout_carries_only_the_response() {
    // This is the launch shape a browser produces: no flag of ours, just the origin.
    let (code, stdout, _stderr) = run_host(&[ORIGIN], framed(HEALTH));
    assert_eq!(code, 0);
    assert_single_health_frame(&stdout);
}

#[test]
fn the_test_entry_point_behaves_identically() {
    let (code, stdout, _stderr) = run_host(&["--nm-host"], framed(HEALTH));
    assert_eq!(code, 0);
    assert_single_health_frame(&stdout);
}

#[test]
fn the_caller_origin_is_recorded_on_stderr() {
    let (_code, _stdout, stderr) = run_host(&[ORIGIN], framed(HEALTH));
    assert!(stderr.contains(ORIGIN), "the caller must be recorded: {stderr}");
}

#[test]
fn a_closed_port_exits_cleanly_and_prints_nothing() {
    let (code, stdout, stderr) = run_host(&["--nm-host"], Vec::new());
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
    assert!(stderr.is_empty(), "a clean close is not an error: {stderr}");
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
