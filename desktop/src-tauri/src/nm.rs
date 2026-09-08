//! Native Messaging wiring: frames in, D05-validated responses out.
//!
//! This slice does not reach the archive. Anything it cannot serve is answered
//! `unavailable`, the one retryable code in D05, rather than a false success.

use data_service::PairingDraft;
use resume_pro_protocol::{
    origin_allowed, validate_request_bytes, ErrorCode, MessageType, MAX_ENVELOPE_BYTES,
};
use serde_json::{json, Value};
use std::io::{Read, Write};

const _FRAME_LIMIT_MATCHES_ENVELOPE: () = assert!(nm_frame::MAX_FRAME_BYTES == MAX_ENVELOPE_BYTES);

/// Who is on the other end of the port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    /// No origin was supplied. Only the `--nm-host` test entry point reaches this.
    Unidentified,
    /// The origin matches the desktop's pairing settings.
    Authorised(String),
    /// An origin was supplied but does not match pairing, or nothing is paired.
    Rejected(String),
}

/// The origins the desktop has been paired with.
///
/// Edge is Chromium, so an Edge extension's origin uses the `chrome-extension` scheme
/// too; both stored ids produce the same form. Empty ids are skipped rather than turned
/// into an origin that could never match.
pub fn allowed_origins_from(draft: &PairingDraft) -> Vec<String> {
    [&draft.chrome_extension_id, &draft.edge_extension_id]
        .into_iter()
        .filter(|id| !id.is_empty())
        .map(|id| format!("chrome-extension://{id}/"))
        .collect()
}

/// Decide whether the caller may be served.
///
/// Wildcards are refused on both sides by D05's `origin_allowed`, which the ADR requires
/// and which is reused here rather than reimplemented.
pub fn authorise(origin: Option<&str>, allowed: &[String]) -> Caller {
    match origin {
        None => Caller::Unidentified,
        Some(origin) if origin_allowed(origin, allowed) => Caller::Authorised(origin.to_string()),
        Some(origin) => Caller::Rejected(origin.to_string()),
    }
}

/// Read frames until the port closes. Returns the process exit code.
///
/// Diagnostics go to stderr only. Anything on stdout other than a protocol frame breaks
/// the channel, and the browser reports it as an unexplained disconnect.
pub fn serve<R: Read, W: Write>(caller: &Caller, input: &mut R, output: &mut W) -> i32 {
    loop {
        match nm_frame::read_frame(input) {
            Ok(None) => return 0,
            Ok(Some(frame)) => {
                let Some(response) = response_for(&frame, caller) else {
                    eprintln!("nm-host: frame carries no usable messageId; closing");
                    return 2;
                };
                if let Err(err) = nm_frame::write_frame(output, &response) {
                    eprintln!("nm-host: cannot write response: {err:?}");
                    return 2;
                }
            }
            Err(err) => {
                eprintln!("nm-host: cannot read frame: {err:?}");
                return 2;
            }
        }
    }
}

/// Build the response for one received frame.
///
/// `None` means no compliant response can be built, because the D05 response envelope
/// requires a `correlationId` and this frame carries no usable `messageId`. Closing
/// beats emitting something the extension would also reject, which would hide the cause.
pub fn response_for(frame: &[u8], caller: &Caller) -> Option<Vec<u8>> {
    match validate_request_bytes(frame) {
        Ok(request) => {
            let response = if matches!(caller, Caller::Rejected(_)) {
                // Answered per message rather than dropped: a closed port reaches the
                // extension as an unexplained disconnect, while this says why.
                error_response(&request.message_id, ErrorCode::IdentityNotAllowed)
            } else if request.message_type == MessageType::Health {
                json!({
                    "protocolVersion": 1,
                    "correlationId": request.message_id,
                    "ok": true,
                    "payload": {}
                })
            } else {
                error_response(&request.message_id, ErrorCode::Unavailable)
            };
            serde_json::to_vec(&response).ok()
        }
        Err(err) => {
            let message_id = message_id_of(frame)?;
            let code = if matches!(caller, Caller::Rejected(_)) {
                ErrorCode::IdentityNotAllowed
            } else {
                err.code
            };
            serde_json::to_vec(&error_response(&message_id, code)).ok()
        }
    }
}

/// A fixed message per code. Validator messages quote the offending value, so forwarding
/// one would hand rejected content back to the extension.
fn error_response(correlation_id: &str, code: ErrorCode) -> Value {
    json!({
        "protocolVersion": 1,
        "correlationId": correlation_id,
        "ok": false,
        "payload": {},
        "error": {
            "code": code.as_str(),
            "retryable": code == ErrorCode::Unavailable,
            "message": fixed_message(code)
        }
    })
}

fn fixed_message(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::Unavailable => "The desktop archive service is not connected in this build.",
        ErrorCode::ProtocolIncompatible => "The request protocol version is not supported.",
        ErrorCode::UnknownMessageType => "The request message type is not supported.",
        ErrorCode::PayloadTooLarge => "The request exceeds the envelope limit.",
        ErrorCode::SecretForbidden => "The request carries content that must not be stored.",
        ErrorCode::IdentityNotAllowed => {
            "This extension is not paired with the desktop application."
        }
        _ => "The request was rejected by contract validation.",
    }
}

/// The top-level `messageId`, only when it is a syntactically valid UUID. Anything else
/// cannot correlate a response.
fn message_id_of(frame: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(frame).ok()?;
    let id = value.get("messageId")?.as_str()?;
    let mut groups = id.split('-');
    for len in [8usize, 4, 4, 4, 12] {
        let group = groups.next()?;
        if group.len() != len || !group.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
    }
    if groups.next().is_some() {
        return None;
    }
    Some(id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const HEALTH: &str = r#"{"protocolVersion":1,"messageId":"33333333-3333-4333-8333-333333333333","clientInstanceId":"11111111-1111-4111-8111-111111111111","messageType":"health","occurredAt":"2026-09-06T12:00:00.000Z","payload":{}}"#;

    fn respond(request: &str) -> Value {
        let raw = response_for(request.as_bytes(), &Caller::Unidentified)
            .expect("a response is expected");
        serde_json::from_slice(&raw).expect("the response must be JSON")
    }

    fn framed(body: &str) -> Vec<u8> {
        let mut wire = (body.len() as u32).to_ne_bytes().to_vec();
        wire.extend_from_slice(body.as_bytes());
        wire
    }

    #[test]
    fn health_gets_a_successful_response_correlated_to_the_request() {
        let response = respond(HEALTH);
        assert_eq!(response["ok"], true);
        assert_eq!(response["protocolVersion"], 1);
        assert_eq!(
            response["correlationId"],
            "33333333-3333-4333-8333-333333333333"
        );
        assert_eq!(response["payload"], serde_json::json!({}));
    }

    #[test]
    fn a_request_this_slice_cannot_serve_is_reported_unavailable_not_successful() {
        // handshake is valid and identity-free, and nothing behind this slice can answer
        // it, so it must say so rather than claim success. Mirrors the D05 fixture
        // fixtures/requests/handshake-ok.json.
        const HANDSHAKE: &str = r#"{"protocolVersion":1,"messageId":"33333333-3333-4333-8333-333333333333","clientInstanceId":"11111111-1111-4111-8111-111111111111","messageType":"handshake","occurredAt":"2026-09-06T12:00:00.000Z","payload":{"pluginVersion":"0.3.0","minProtocolVersion":1,"maxProtocolVersion":1}}"#;
        let response = respond(HANDSHAKE);
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "unavailable");
        assert_eq!(response["error"]["retryable"], true);
        assert!(response.get("resultId").is_none());
    }

    #[test]
    fn a_rejected_request_is_answered_with_its_own_message_id() {
        let bad = HEALTH.replace("\"protocolVersion\":1", "\"protocolVersion\":9");
        let response = respond(&bad);
        assert_eq!(response["ok"], false);
        assert_eq!(
            response["correlationId"],
            "33333333-3333-4333-8333-333333333333"
        );
        assert_eq!(response["error"]["code"], "protocol_incompatible");
        assert_eq!(response["error"]["retryable"], false);
    }

    #[test]
    fn an_error_message_never_echoes_the_payload_back() {
        // Validator messages quote the offending value. Echoing one would hand rejected
        // content back to the extension, so responses carry a fixed message per code.
        let bad = HEALTH.replace(
            "\"occurredAt\":\"2026-09-06T12:00:00.000Z\"",
            "\"occurredAt\":\"2026-99-99T99:99:99Z\"",
        );
        let response = respond(&bad);
        assert_eq!(response["ok"], false);
        let message = response["error"]["message"].as_str().unwrap_or_default();
        assert!(
            !message.contains("2026-99-99"),
            "message echoed the input: {message}"
        );
        assert!(
            message.len() <= 300,
            "the response envelope caps message at 300"
        );
    }

    #[test]
    fn a_frame_without_a_usable_message_id_gets_no_response() {
        assert!(response_for(b"not json at all", &Caller::Unidentified).is_none());
        assert!(response_for(br#"{"messageId":"not-a-uuid"}"#, &Caller::Unidentified).is_none());
        assert!(
            response_for(
                br#"{"messageId":"33333333-3333-4333-8333-333333333333-extra"}"#,
                &Caller::Unidentified
            )
            .is_none()
        );
    }

    #[test]
    fn a_closed_port_ends_the_session_with_success() {
        let mut input = std::io::Cursor::new(Vec::new());
        let mut output = Vec::new();
        assert_eq!(serve(&Caller::Unidentified, &mut input, &mut output), 0);
        assert!(output.is_empty());
    }

    #[test]
    fn two_health_frames_get_two_responses_and_nothing_else_on_stdout() {
        let mut wire = framed(HEALTH);
        wire.extend_from_slice(&framed(HEALTH));
        let mut input = std::io::Cursor::new(wire);
        let mut output = Vec::new();
        assert_eq!(serve(&Caller::Unidentified, &mut input, &mut output), 0);

        let mut cursor = std::io::Cursor::new(output);
        for _ in 0..2 {
            let frame = nm_frame::read_frame(&mut cursor)
                .expect("a frame is expected")
                .expect("the stream must not end early");
            let value: Value = serde_json::from_slice(&frame).unwrap();
            assert_eq!(value["ok"], true);
        }
        assert_eq!(
            nm_frame::read_frame(&mut cursor).unwrap(),
            None,
            "stdout must carry protocol frames and nothing else"
        );
    }

    #[test]
    fn an_oversized_prefix_closes_the_session_without_answering() {
        let mut wire = u32::MAX.to_ne_bytes().to_vec();
        wire.extend_from_slice(b"body");
        let mut input = std::io::Cursor::new(wire);
        let mut output = Vec::new();
        assert_eq!(serve(&Caller::Unidentified, &mut input, &mut output), 2);
        assert!(output.is_empty());
    }

    fn draft(chrome: &str, edge: &str) -> data_service::PairingDraft {
        data_service::PairingDraft {
            chrome_extension_id: chrome.into(),
            edge_extension_id: edge.into(),
            native_messaging_registered: false,
        }
    }

    const CHROME_ID: &str = "abcdefghijklmnopabcdefghijklmnop";
    const EDGE_ID: &str = "qrstuvwxyzabcdefqrstuvwxyzabcdef";

    #[test]
    fn each_paired_extension_id_becomes_one_origin() {
        // Edge is Chromium, so its extensions use the chrome-extension scheme too.
        assert_eq!(
            allowed_origins_from(&draft(CHROME_ID, EDGE_ID)),
            vec![
                format!("chrome-extension://{CHROME_ID}/"),
                format!("chrome-extension://{EDGE_ID}/"),
            ]
        );
        assert_eq!(
            allowed_origins_from(&draft(CHROME_ID, "")),
            vec![format!("chrome-extension://{CHROME_ID}/")]
        );
        assert!(allowed_origins_from(&draft("", "")).is_empty());
    }

    #[test]
    fn a_paired_caller_is_authorised() {
        let allowed = allowed_origins_from(&draft(CHROME_ID, EDGE_ID));
        assert!(matches!(
            authorise(Some(&format!("chrome-extension://{CHROME_ID}/")), &allowed),
            Caller::Authorised(_)
        ));
        assert!(matches!(
            authorise(Some(&format!("chrome-extension://{EDGE_ID}/")), &allowed),
            Caller::Authorised(_)
        ));
    }

    #[test]
    fn an_unpaired_or_mismatched_caller_is_rejected() {
        let allowed = allowed_origins_from(&draft(CHROME_ID, ""));
        assert!(matches!(
            authorise(Some("chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/"), &allowed),
            Caller::Rejected(_)
        ));
        // Nothing paired at all.
        assert!(matches!(
            authorise(Some(&format!("chrome-extension://{CHROME_ID}/")), &[]),
            Caller::Rejected(_)
        ));
    }

    #[test]
    fn a_wildcard_origin_is_never_authorised() {
        // The ADR forbids wildcards in allowed_origins; D05's origin_allowed enforces it
        // on both sides, and this pins that we rely on it rather than reimplementing.
        let wild = vec!["chrome-extension://*/".to_string()];
        assert!(matches!(
            authorise(Some("chrome-extension://*/"), &wild),
            Caller::Rejected(_)
        ));
    }

    #[test]
    fn no_origin_leaves_the_caller_unidentified() {
        assert!(matches!(authorise(None, &[]), Caller::Unidentified));
    }

    #[test]
    fn a_rejected_caller_gets_identity_not_allowed_for_every_request() {
        let caller = Caller::Rejected("chrome-extension://zzzz/".into());
        let raw = response_for(HEALTH.as_bytes(), &caller).expect("a response is expected");
        let response: Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "identity_not_allowed");
        assert_eq!(response["error"]["retryable"], false);
        assert_eq!(
            response["correlationId"],
            "33333333-3333-4333-8333-333333333333"
        );
    }

    #[test]
    fn a_rejected_caller_keeps_the_connection_rather_than_being_dropped() {
        // Dropping the port shows up in the extension as an unexplained disconnect, which
        // is the failure mode these slices keep working to avoid.
        let mut wire = framed(HEALTH);
        wire.extend_from_slice(&framed(HEALTH));
        let mut input = std::io::Cursor::new(wire);
        let mut output = Vec::new();
        let caller = Caller::Rejected("chrome-extension://zzzz/".into());
        assert_eq!(serve(&caller, &mut input, &mut output), 0);

        let mut cursor = std::io::Cursor::new(output);
        for _ in 0..2 {
            let frame = nm_frame::read_frame(&mut cursor).unwrap().unwrap();
            let value: Value = serde_json::from_slice(&frame).unwrap();
            assert_eq!(value["error"]["code"], "identity_not_allowed");
        }
        assert_eq!(nm_frame::read_frame(&mut cursor).unwrap(), None);
    }
}
