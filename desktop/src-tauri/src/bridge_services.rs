//! Desktop-only services for v2 messages that do not need the archive lock.

use resume_pro_protocol::{ErrorCode, Request};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::plugin_bridge::Answer;
use crate::{ai_complete, ai_data_root, ai_provider_commands, ai_settings, checked_url, commands::CommandError, AppState};

#[derive(Debug, Clone)]
pub enum AiReply {
    Ok(String),
    Failed {
        reason: &'static str,
        http_status: Option<u16>,
        host: Option<String>,
    },
}

pub trait BridgeServices: Send + Sync + 'static {
    fn ai_complete(&self, purpose: &str, system: &str, user: &str) -> AiReply;
    fn open_view(&self, view: &str) -> bool;

    fn stage_import_key(&self, _import_id: &str, _key: &str) -> Result<(), ErrorCode> { Err(ErrorCode::Unavailable) }
    fn get_import_key(&self, _import_id: &str) -> Result<Option<String>, ErrorCode> { Err(ErrorCode::Unavailable) }
    fn clear_import_key(&self, _import_id: &str) -> Result<(), ErrorCode> { Err(ErrorCode::Unavailable) }
    fn validate_import_provider(&self, _import_id: &str, _api_url: &str, _model: &str) -> Result<(), ErrorCode> { Err(ErrorCode::Unavailable) }
    fn install_import_provider(&self, _import_id: &str, _api_url: &str, _model: &str, _key: &str) -> Result<(), ErrorCode> { Err(ErrorCode::Unavailable) }
    fn discard_import_provider(&self, _import_id: &str) -> Result<(), ErrorCode> { Err(ErrorCode::Unavailable) }
}

pub fn import_account(import_id: &str) -> String { format!("import-{import_id}") }

fn discard_import_provider(data_root: &std::path::Path, credentials: &dyn crate::ai_credentials::CredentialStore, import_id: &str) -> Result<(), ErrorCode> {
    let provider_id = format!("legacy-provider-{import_id}");
    // A failed OS-store delete must leave the batch pending, not orphan a Key.
    credentials.clear_key(&provider_id).map_err(|_| ErrorCode::Unavailable)?;
    if ai_settings::load(data_root).providers.iter().any(|provider| provider.id == provider_id) {
        ai_settings::delete_provider(data_root, &provider_id).map_err(|_| ErrorCode::Unavailable)?;
    }
    Ok(())
}

#[cfg(test)]
mod import_account_tests {
    use super::*;
    use crate::ai_credentials::{CredentialStore, MemoryStore};
    #[test]
    fn temporary_key_account_is_distinct_from_the_imported_provider_account() {
        let import_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let temp = crate::ai_credentials::account_for(&import_account(import_id));
        let permanent = crate::ai_credentials::account_for(&format!("legacy-provider-{import_id}"));
        assert_ne!(temp, permanent);
    }

    #[test]
    fn discarding_an_import_removes_its_permanent_provider_and_key() {
        let dir = tempfile::tempdir().unwrap();
        let import_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let provider_id = ai_settings::import_provider(dir.path(), import_id, "https://api.example.com/v1", "m").unwrap();
        let credentials = MemoryStore::default();
        credentials.set_key(&provider_id, "sk-synthetic").unwrap();
        discard_import_provider(dir.path(), &credentials, import_id).unwrap();
        discard_import_provider(dir.path(), &credentials, import_id).unwrap();
        assert!(ai_settings::load(dir.path()).providers.is_empty());
        assert_eq!(credentials.get_key(&provider_id).unwrap(), None);
    }
}

pub struct DesktopBridgeServices {
    app: AppHandle,
}

impl DesktopBridgeServices {
    pub fn new(app: AppHandle) -> Self { Self { app } }
}

fn safe_host(api_url: &str) -> Option<String> {
    url::Url::parse(api_url).ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .filter(|host| !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
}

fn from_ai_error(err: CommandError, host: Option<String>) -> AiReply {
    let code = err.code.as_str();
    if let Some(status) = code.strip_prefix("AI_HTTP_").and_then(|text| text.parse::<u16>().ok()) {
        let reason = match status {
            401 | 403 => "auth",
            429 => "rate_limited",
            _ => "http",
        };
        return AiReply::Failed { reason, http_status: Some(status), host };
    }
    let reason = match code {
        // A provider URL carrying credentials is unusable as configured: the user has to fix it.
        "AI_NOT_CONFIGURED" | "NO_DATA_DIR" | "AI_URL_HAS_CREDENTIAL" => "not_configured",
        "CREDENTIAL_STORE_UNAVAILABLE" | "AI_SETTINGS_WRITE_FAILED" => "credential_unavailable",
        "AI_INPUT_TOO_LARGE" => "input_too_large",
        "AI_OUTPUT_TOO_LARGE" => "response_too_large",
        "AI_TIMEOUT" => "timeout",
        "AI_NETWORK" => "network",
        _ => "bad_response",
    };
    AiReply::Failed { reason, http_status: None, host: None }
}

impl BridgeServices for DesktopBridgeServices {
    fn ai_complete(&self, _purpose: &str, system: &str, user: &str) -> AiReply {
        let state = self.app.state::<AppState>();
        let data_root = match ai_data_root(&state) {
            Ok(root) => root,
            Err(err) => return from_ai_error(err, None),
        };
        let (provider, key) = match ai_provider_commands::active_with_key(&data_root, state.credentials.as_ref()) {
            Ok(active) => active,
            Err(err) => return from_ai_error(err, None),
        };
        if let Err(err) = checked_url(&provider.api_url) {
            return from_ai_error(err, None);
        }
        let host = safe_host(&provider.api_url);
        match tauri::async_runtime::block_on(ai_complete::complete(
            &provider, &key, system, user, ai_complete::COMPLETE_TIMEOUT,
        )) {
            Ok(text) => AiReply::Ok(text),
            Err(err) => from_ai_error(err, host),
        }
    }

    fn open_view(&self, view: &str) -> bool {
        if self.app.get_webview_window("main").is_none() { return false; }
        crate::lifecycle::show_main_window(&self.app);
        // The window is already in front at this point; a lost navigation event leaves the
        // user on the current page, which is not worth telling the plugin "unavailable".
        if self.app.emit("resume-pro://navigate", view).is_err() {
            eprintln!("bridge: ui.open could not emit the navigation event");
        }
        true
    }

    fn stage_import_key(&self, import_id: &str, key: &str) -> Result<(), ErrorCode> {
        self.app.state::<AppState>().credentials.set_key(&import_account(import_id), key)
            .map_err(|_| ErrorCode::Unavailable)
    }

    fn get_import_key(&self, import_id: &str) -> Result<Option<String>, ErrorCode> {
        self.app.state::<AppState>().credentials.get_key(&import_account(import_id))
            .map_err(|_| ErrorCode::Unavailable)
    }

    fn clear_import_key(&self, import_id: &str) -> Result<(), ErrorCode> {
        self.app.state::<AppState>().credentials.clear_key(&import_account(import_id))
            .map_err(|_| ErrorCode::Unavailable)
    }

    fn install_import_provider(&self, import_id: &str, api_url: &str, model: &str, key: &str) -> Result<(), ErrorCode> {
        let state = self.app.state::<AppState>();
        let data_root = ai_data_root(&state).map_err(|_| ErrorCode::Unavailable)?;
        let provider_id = ai_settings::import_provider(&data_root, import_id, api_url, model)
            .map_err(|_| ErrorCode::Unavailable)?;
        state.credentials.set_key(&provider_id, key).map_err(|_| ErrorCode::Unavailable)
    }

    fn discard_import_provider(&self, import_id: &str) -> Result<(), ErrorCode> {
        let state = self.app.state::<AppState>();
        let data_root = ai_data_root(&state).map_err(|_| ErrorCode::Unavailable)?;
        discard_import_provider(&data_root, state.credentials.as_ref(), import_id)
    }

    fn validate_import_provider(&self, import_id: &str, api_url: &str, model: &str) -> Result<(), ErrorCode> {
        let state = self.app.state::<AppState>();
        let data_root = ai_data_root(&state).map_err(|_| ErrorCode::Unavailable)?;
        ai_settings::validate_import_provider(&data_root, import_id, api_url, model)
            .map_err(|_| ErrorCode::InvalidPayload)
    }
}

#[cfg(test)]
pub struct NoopServices;

#[cfg(test)]
impl BridgeServices for NoopServices {
    fn ai_complete(&self, _purpose: &str, _system: &str, _user: &str) -> AiReply {
        AiReply::Failed { reason: "not_configured", http_status: None, host: None }
    }
    fn open_view(&self, _view: &str) -> bool { false }
}

fn checked_answer(request: &Request, payload: Value) -> Result<Answer, ErrorCode> {
    let response = json!({
        "protocolVersion": request.protocol_version,
        "correlationId": request.message_id,
        "ok": true,
        "payload": payload,
    });
    resume_pro_protocol::validate_response_for_request(&response, request).map_err(|err| err.code)?;
    Ok(Answer { result_id: None, payload })
}

fn failed(request: &Request, reason: &'static str, http_status: Option<u16>, host: Option<String>) -> Result<Answer, ErrorCode> {
    let mut payload = json!({"status": "failed", "reason": reason});
    if let Some(status) = http_status {
        payload["httpStatus"] = json!(status);
    }
    if let Some(host) = host.filter(|value| !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')) {
        payload["host"] = json!(host);
    }
    checked_answer(request, payload)
}

pub fn answer(request: &Request, services: &dyn BridgeServices) -> Result<Answer, ErrorCode> {
    match request.message_type {
        resume_pro_protocol::MessageType::AiComplete => {
            let purpose = request.payload["purpose"].as_str().ok_or(ErrorCode::InvalidPayload)?;
            let system = request.payload["system"].as_str().ok_or(ErrorCode::InvalidPayload)?;
            let user = request.payload["user"].as_str().ok_or(ErrorCode::InvalidPayload)?;
            match services.ai_complete(purpose, system, user) {
                AiReply::Ok(text) => match checked_answer(request, json!({"status": "ok", "text": text})) {
                    Ok(answer) => Ok(answer),
                    Err(ErrorCode::PayloadTooLarge) => failed(request, "response_too_large", None, None),
                    Err(_) => failed(request, "bad_response", None, None),
                },
                AiReply::Failed { reason, http_status, host } => failed(request, reason, http_status, host),
            }
        }
        resume_pro_protocol::MessageType::UiOpen => {
            let view = request.payload["view"].as_str().ok_or(ErrorCode::InvalidPayload)?;
            if services.open_view(view) {
                checked_answer(request, json!({"opened": true}))
            } else {
                Err(ErrorCode::Unavailable)
            }
        }
        _ => Err(ErrorCode::UnknownMessageType),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use resume_pro_protocol::validate_request_bytes;
    use std::sync::Mutex;

    struct FakeServices {
        reply: AiReply,
        opened: bool,
        calls: Mutex<Vec<String>>,
    }

    impl BridgeServices for FakeServices {
        fn ai_complete(&self, purpose: &str, system: &str, user: &str) -> AiReply {
            self.calls.lock().unwrap().push(format!("ai:{purpose}:{system}:{user}"));
            self.reply.clone()
        }

        fn open_view(&self, view: &str) -> bool {
            self.calls.lock().unwrap().push(format!("ui:{view}"));
            self.opened
        }
    }

    fn request(message_type: &str, payload: Value) -> Request {
        let value = json!({
            "protocolVersion": 2,
            "messageId": "33333333-3333-4333-8333-333333333333",
            "clientInstanceId": "11111111-1111-4111-8111-111111111111",
            "messageType": message_type,
            "occurredAt": "2026-09-24T00:00:00.000Z",
            "payload": payload
        });
        validate_request_bytes(&serde_json::to_vec(&value).unwrap()).unwrap()
    }

    fn fake(reply: AiReply, opened: bool) -> FakeServices {
        FakeServices { reply, opened, calls: Mutex::new(Vec::new()) }
    }

    #[test]
    fn ai_complete_returns_text_or_a_fixed_failure_without_upstream_body() {
        let request = request("ai.complete", json!({"purpose": "fill", "system": "SYS", "user": "USER"}));
        let success = fake(AiReply::Ok("result".into()), false);
        let result = answer(&request, &success).unwrap();
        assert_eq!(result.payload, json!({"status": "ok", "text": "result"}));
        assert_eq!(success.calls.lock().unwrap().as_slice(), ["ai:fill:SYS:USER"]);

        let missing = fake(AiReply::Failed { reason: "not_configured", http_status: None, host: None }, false);
        assert_eq!(answer(&request, &missing).unwrap().payload, json!({"status":"failed","reason":"not_configured"}));
        let auth = fake(AiReply::Failed { reason: "auth", http_status: Some(401), host: Some("api.example.com".into()) }, false);
        let reply = answer(&request, &auth).unwrap().payload;
        assert_eq!(reply["reason"], "auth");
        assert_eq!(reply["httpStatus"], 401);
        assert_eq!(reply["host"], "api.example.com");
    }

    #[test]
    fn ai_complete_sanitizes_secret_and_oversized_model_text() {
        let request = request("ai.complete", json!({"purpose": "plan", "system": "SYS", "user": "USER"}));
        let secret = fake(AiReply::Ok("Bearer synthetic-secret".into()), false);
        assert_eq!(answer(&request, &secret).unwrap().payload, json!({"status":"failed","reason":"bad_response"}));
        let large = fake(AiReply::Ok("a".repeat(70_000)), false);
        assert_eq!(answer(&request, &large).unwrap().payload, json!({"status":"failed","reason":"response_too_large"}));
    }

    #[test]
    fn ui_open_calls_window_service_and_reports_unavailable_on_failure() {
        let request = request("ui.open", json!({"view": "settings-ai"}));
        let opened = fake(AiReply::Ok(String::new()), true);
        assert_eq!(answer(&request, &opened).unwrap().payload, json!({"opened":true}));
        assert_eq!(opened.calls.lock().unwrap().as_slice(), ["ui:settings-ai"]);
        let closed = fake(AiReply::Ok(String::new()), false);
        assert_eq!(answer(&request, &closed).err(), Some(ErrorCode::Unavailable));
    }

    #[test]
    fn provider_failures_map_to_fixed_reasons_without_error_bodies() {
        let map = |code: &str| from_ai_error(CommandError {
            code: code.into(),
            message: "upstream body must not be returned".into(),
        }, safe_host("https://api.example.com:8443/v1"));
        let cases = [
            ("AI_NOT_CONFIGURED", "not_configured", None),
            ("CREDENTIAL_STORE_UNAVAILABLE", "credential_unavailable", None),
            ("AI_SETTINGS_WRITE_FAILED", "credential_unavailable", None),
            ("AI_URL_HAS_CREDENTIAL", "not_configured", None),
            ("AI_HTTP_401", "auth", Some(401)),
            ("AI_HTTP_429", "rate_limited", Some(429)),
            ("AI_HTTP_500", "http", Some(500)),
            ("AI_TIMEOUT", "timeout", None),
            ("AI_NETWORK", "network", None),
            ("AI_INPUT_TOO_LARGE", "input_too_large", None),
            ("AI_OUTPUT_TOO_LARGE", "response_too_large", None),
            ("AI_BAD_RESPONSE", "bad_response", None),
        ];
        for (code, expected, status) in cases {
            match map(code) {
                AiReply::Failed { reason, http_status, host } => {
                    assert_eq!(reason, expected);
                    assert_eq!(http_status, status);
                    if status.is_some() { assert_eq!(host.as_deref(), Some("api.example.com")); }
                }
                AiReply::Ok(_) => panic!("{code} cannot be a success"),
            }
        }
        assert_eq!(safe_host("https://[::1]:8443/v1"), None);
    }
}
