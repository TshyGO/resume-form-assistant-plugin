//! 桌面获取模型列表。
//!
//! 地址怎么认，跟插件 `ai-models.js` 的 `resolveEndpoints` 是同一套规则，测试锁同一组例子。
//! 真正的失败文案和「哪些模型不算对话模型」仍由那份脚本的 `interpretModelTransport` 产生，
//! 桌面界面拿到这里的状态码和正文后再交给它，避免两套提示各写各的。
//!
//! 选 Key 的规矩：刚输入的 Key 只用于这一次，不落盘。没输入时，只有「这份配置已保存的
//! 地址」和「这次要请求的地址」解析成同一个 chat 端点，才读这一份自己的 Key。
//! 对不上就不读，更不会去读另一份配置或升级前的固定凭据。

use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use url::Url;

use crate::ai_credentials::{self, CredentialError, CredentialStore};
use crate::ai_settings::{host_of, AiStore};

pub const TIMEOUT_MS: u64 = 15_000;
const MAX_BODY: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub chat_url: String,
    pub models_url: Option<String>,
}

pub fn resolve_endpoints(input: &str) -> Option<Endpoints> {
    let text = input.trim();
    let url = Url::parse(text).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    let path = url.path().trim_end_matches('/').to_string();
    let chat = Regex::new(r"(?i)/chat/completions$").expect("chat suffix");
    if chat.is_match(&path) {
        let models_path = chat.replace(&path, "/models").to_string();
        return Some(Endpoints {
            chat_url: text.to_string(),
            models_url: Some(with_path(&url, &models_path)),
        });
    }
    let last = path.rsplit('/').next().unwrap_or("");
    if path.is_empty() || is_base_segment(last) {
        let base = if path.is_empty() { "/v1" } else { path.as_str() };
        return Some(Endpoints {
            chat_url: with_path(&url, &format!("{base}/chat/completions")),
            models_url: Some(with_path(&url, &format!("{base}/models"))),
        });
    }
    Some(Endpoints {
        chat_url: text.to_string(),
        models_url: None,
    })
}

fn is_base_segment(segment: &str) -> bool {
    Regex::new(r"(?i)^v\d+[a-z0-9]*$")
        .expect("version segment")
        .is_match(segment)
        || segment.eq_ignore_ascii_case("openai")
}

fn with_path(url: &Url, pathname: &str) -> String {
    let mut next = url.clone();
    next.set_fragment(None);
    next.set_path(pathname);
    next.to_string()
}

fn chat_urls_match(saved: &str, typed: &str) -> bool {
    match (resolve_endpoints(saved), resolve_endpoints(typed)) {
        (Some(saved), Some(typed)) => saved.chat_url == typed.chat_url,
        _ => saved.trim() == typed.trim(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchPrep {
    Ready { models_url: String, key: String },
    Failed { reason: &'static str },
}

pub fn prepare_model_fetch(
    typed_url: &str,
    typed_key: &str,
    profile_id: Option<&str>,
    store: &AiStore,
    credentials: &dyn CredentialStore,
) -> Result<FetchPrep, CredentialError> {
    let Some(endpoints) = resolve_endpoints(typed_url) else {
        return Ok(FetchPrep::Failed { reason: "invalid-url" });
    };
    let Some(models_url) = endpoints.models_url else {
        return Ok(FetchPrep::Failed { reason: "unknown-shape" });
    };
    let typed_key = typed_key.trim();
    if !typed_key.is_empty() {
        return Ok(FetchPrep::Ready {
            models_url,
            key: typed_key.to_string(),
        });
    }
    let Some(profile_id) = profile_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(FetchPrep::Failed { reason: "missing-key" });
    };
    let Some(profile) = store.profiles.iter().find(|profile| profile.id == profile_id) else {
        return Ok(FetchPrep::Failed { reason: "missing-key" });
    };
    if !chat_urls_match(&profile.api_url, typed_url) {
        return Ok(FetchPrep::Failed {
            reason: "key-url-mismatch",
        });
    }
    match credentials.get_key(&ai_credentials::profile_account(&profile.id))? {
        Some(key) => Ok(FetchPrep::Ready { models_url, key }),
        None => Ok(FetchPrep::Failed { reason: "missing-key" }),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFetchRaw {
    pub reason: String,
    pub status: Option<u16>,
    pub body: String,
    pub timeout_ms: u64,
}

pub enum TransportOutcome {
    Timeout,
    Network,
    Http { status: u16, body: String },
}

pub fn raw_from_outcome(prep: &FetchPrep, outcome: Option<TransportOutcome>, timeout_ms: u64) -> ModelFetchRaw {
    match prep {
        FetchPrep::Failed { reason } => ModelFetchRaw {
            reason: (*reason).to_string(),
            status: None,
            body: String::new(),
            timeout_ms,
        },
        FetchPrep::Ready { key, .. } => match outcome {
            Some(TransportOutcome::Timeout) => ModelFetchRaw {
                reason: "timeout".into(),
                status: None,
                body: String::new(),
                timeout_ms,
            },
            Some(TransportOutcome::Network) | None => ModelFetchRaw {
                reason: "network".into(),
                status: None,
                body: String::new(),
                timeout_ms,
            },
            Some(TransportOutcome::Http { status, body }) => {
                // Providers sometimes echo request details in error bodies. Never send a
                // credential back over the Tauri command, even when they do.
                let body = if key.is_empty() { body } else { body.replace(key, "[redacted]") };
                ModelFetchRaw {
                    reason: "http".into(),
                    status: Some(status),
                    body: body.chars().take(MAX_BODY).collect(),
                    timeout_ms,
                }
            }
        },
    }
}

pub fn client() -> Result<reqwest::Client, String> {
    client_with_timeout(Duration::from_millis(TIMEOUT_MS))
}

pub fn client_with_timeout(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|err| {
            eprintln!("ai-models: client-init-failed · {err}");
            "HTTP 客户端没建起来，这次没有获取模型。".into()
        })
}

pub async fn execute(client: &reqwest::Client, prep: FetchPrep) -> ModelFetchRaw {
    let FetchPrep::Ready { models_url, key } = &prep else {
        return raw_from_outcome(&prep, None, TIMEOUT_MS);
    };
    let host = host_of(models_url);
    let outcome = match client.get(models_url).bearer_auth(key).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            eprintln!("ai-models: {host} · HTTP {status}");
            TransportOutcome::Http { status, body }
        }
        Err(err) if err.is_timeout() => {
            eprintln!("ai-models: {host} · timeout");
            TransportOutcome::Timeout
        }
        Err(_) => {
            eprintln!("ai-models: {host} · network");
            TransportOutcome::Network
        }
    };
    raw_from_outcome(&prep, Some(outcome), TIMEOUT_MS)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    use super::*;
    use crate::ai_credentials::MemoryStore;
    use crate::ai_settings::{save_and_use, SaveProfile};

    #[test]
    fn endpoint_resolution_matches_the_plugin() {
        let cases = [
            (
                "https://api.openai.com/v1/chat/completions",
                Some("https://api.openai.com/v1/chat/completions"),
                Some("https://api.openai.com/v1/models"),
            ),
            (
                "https://api.siliconflow.cn/v1",
                Some("https://api.siliconflow.cn/v1/chat/completions"),
                Some("https://api.siliconflow.cn/v1/models"),
            ),
            (
                "https://api.siliconflow.cn/v1/",
                Some("https://api.siliconflow.cn/v1/chat/completions"),
                Some("https://api.siliconflow.cn/v1/models"),
            ),
            (
                "https://relay.example/v1/chat/completions/",
                Some("https://relay.example/v1/chat/completions/"),
                Some("https://relay.example/v1/models"),
            ),
            (
                "https://openrouter.ai/api/v1",
                Some("https://openrouter.ai/api/v1/chat/completions"),
                Some("https://openrouter.ai/api/v1/models"),
            ),
            (
                "https://generativelanguage.googleapis.com/v1beta/openai",
                Some("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"),
                Some("https://generativelanguage.googleapis.com/v1beta/openai/models"),
            ),
            (
                "https://api.openai.com",
                Some("https://api.openai.com/v1/chat/completions"),
                Some("https://api.openai.com/v1/models"),
            ),
            (
                "https://relay.example/v1/chat/completions?api-version=2024-10-21",
                Some("https://relay.example/v1/chat/completions?api-version=2024-10-21"),
                Some("https://relay.example/v1/models?api-version=2024-10-21"),
            ),
            (
                "https://proxy.example/custom/openai-chat",
                Some("https://proxy.example/custom/openai-chat"),
                None,
            ),
        ];
        for (input, chat, models) in cases {
            let resolved = resolve_endpoints(input);
            assert_eq!(resolved.as_ref().map(|item| item.chat_url.as_str()), chat, "{input}");
            assert_eq!(
                resolved.as_ref().and_then(|item| item.models_url.as_deref()),
                models,
                "{input}"
            );
        }
        assert!(resolve_endpoints("not a url").is_none());
        assert!(resolve_endpoints("ftp://example.com/v1").is_none());
    }

    fn store_with_profile(url: &str, key: &str) -> (tempfile::TempDir, MemoryStore, AiStore, String) {
        let dir = tempfile::tempdir().unwrap();
        let creds = MemoryStore::default();
        let saved = save_and_use(
            dir.path(),
            &creds,
            SaveProfile {
                id: None,
                name: "A".into(),
                api_url: url.into(),
                model: "model-a".into(),
                key: Some(key.into()),
            },
        )
        .unwrap();
        let id = saved.active_id.clone().unwrap();
        (dir, creds, saved, id)
    }

    #[test]
    fn a_typed_key_is_used_for_that_url_and_is_not_stored() {
        let (dir, creds, store, id) = store_with_profile("https://a.example/v1", "sk-a");
        let prep = prepare_model_fetch(
            "https://b.example/v1",
            "sk-typed",
            Some(&id),
            &store,
            &creds,
        )
        .unwrap();
        match prep {
            FetchPrep::Ready { models_url, key } => {
                assert_eq!(models_url, "https://b.example/v1/models");
                assert_eq!(key, "sk-typed");
            }
            FetchPrep::Failed { reason } => panic!("应使用刚输入的 Key，得到 {reason}"),
        }
        assert_eq!(
            creds
                .get_key(&ai_credentials::profile_account(&id))
                .unwrap()
                .as_deref(),
            Some("sk-a")
        );
        let text = std::fs::read_to_string(crate::ai_settings::path_for(dir.path())).unwrap();
        assert!(!text.contains("sk-typed"));
        assert!(!text.contains("sk-a"));
    }

    #[test]
    fn a_saved_key_is_not_sent_to_a_different_address() {
        let (_dir, creds, store, id) = store_with_profile("https://a.example/v1", "sk-a");
        let prep = prepare_model_fetch("https://b.example/v1", "", Some(&id), &store, &creds).unwrap();
        assert_eq!(prep, FetchPrep::Failed { reason: "key-url-mismatch" });
        let raw = raw_from_outcome(&prep, None, TIMEOUT_MS);
        assert!(!serde_json::to_string(&raw).unwrap().contains("sk-a"));
    }

    #[test]
    fn a_saved_key_is_used_when_the_typed_base_url_is_the_same_endpoint() {
        let (_dir, creds, store, id) = store_with_profile("https://a.example/v1/chat/completions", "sk-a");
        let prep = prepare_model_fetch("https://a.example/v1", "  ", Some(&id), &store, &creds).unwrap();
        match prep {
            FetchPrep::Ready { key, .. } => assert_eq!(key, "sk-a"),
            FetchPrep::Failed { reason } => panic!("{reason}"),
        }
    }

    #[test]
    fn an_unknown_path_does_not_call_out_or_touch_the_saved_model() {
        let (dir, creds, store, id) = store_with_profile("https://a.example/v1", "sk-a");
        let before = std::fs::read_to_string(crate::ai_settings::path_for(dir.path())).unwrap();
        let prep = prepare_model_fetch(
            "https://proxy.example/custom/openai-chat",
            "",
            Some(&id),
            &store,
            &creds,
        )
        .unwrap();
        assert_eq!(prep, FetchPrep::Failed { reason: "unknown-shape" });
        let after = std::fs::read_to_string(crate::ai_settings::path_for(dir.path())).unwrap();
        assert_eq!(before, after);
        assert_eq!(store.active().unwrap().model, "model-a");
    }

    struct FakeServer {
        url: String,
        request: std::sync::mpsc::Receiver<String>,
    }

    impl FakeServer {
        fn new(status: &str, body: &str) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let (tx, rx) = std::sync::mpsc::channel();
            let status = status.to_string();
            let body = body.to_string();
            std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            });
            Self {
                url: format!("http://127.0.0.1:{port}/v1"),
                request: rx,
            }
        }
    }

    #[tokio::test]
    async fn a_successful_fetch_sends_only_the_typed_key_and_returns_the_body() {
        let server = FakeServer::new("200 OK", r#"{"data":[{"id":"gpt-4o-mini"}]}"#);
        let (_dir, creds, store, id) = store_with_profile("https://a.example/v1", "sk-saved");
        let prep = prepare_model_fetch(&server.url, "sk-typed", Some(&id), &store, &creds).unwrap();
        let client = client_with_timeout(Duration::from_secs(2)).unwrap();
        let raw = execute(&client, prep).await;
        assert_eq!(raw.reason, "http");
        assert_eq!(raw.status, Some(200));
        assert!(raw.body.contains("gpt-4o-mini"));
        assert!(!serde_json::to_string(&raw).unwrap().contains("sk-typed"));
        let seen = server.request.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(seen.contains("GET /v1/models"));
        assert!(seen.to_ascii_lowercase().contains("authorization: bearer sk-typed"));
        assert!(!seen.contains("sk-saved"));
    }

    #[tokio::test]
    async fn a_rejected_key_and_a_timeout_keep_their_reasons() {
        let server = FakeServer::new("401 Unauthorized", r#"{"error":{"message":"nope"}}"#);
        let prep = FetchPrep::Ready {
            models_url: format!("{}/models", server.url),
            key: "sk-typed".into(),
        };
        let client = client_with_timeout(Duration::from_secs(2)).unwrap();
        let raw = execute(&client, prep).await;
        assert_eq!(raw.reason, "http");
        assert_eq!(raw.status, Some(401));
        assert!(raw.body.contains("nope"));
        assert!(!raw.body.contains("sk-typed"));

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_secs(2));
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
        });
        let client = client_with_timeout(Duration::from_millis(200)).unwrap();
        let raw = execute(
            &client,
            FetchPrep::Ready {
                models_url: format!("http://127.0.0.1:{port}/v1/models"),
                key: "sk-slow".into(),
            },
        )
        .await;
        assert_eq!(raw.reason, "timeout");
        assert!(!serde_json::to_string(&raw).unwrap().contains("sk-slow"));
    }

    #[test]
    fn a_provider_echoing_the_key_cannot_send_it_back_to_the_frontend() {
        let prep = FetchPrep::Ready {
            models_url: "https://example.test/v1/models".into(),
            key: "sk-synthetic-secret".into(),
        };
        let raw = raw_from_outcome(
            &prep,
            Some(TransportOutcome::Http {
                status: 401,
                body: r#"{"error":{"message":"Rejected sk-synthetic-secret"}}"#.into(),
            }),
            TIMEOUT_MS,
        );
        assert!(!serde_json::to_string(&raw).unwrap().contains("sk-synthetic-secret"));
        assert!(raw.body.contains("[redacted]"));
    }
}
