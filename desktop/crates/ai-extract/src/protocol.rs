use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProtocol {
    #[default]
    Chat,
    Responses,
    Anthropic,
}

impl AiProtocol {
    pub fn suffix(self) -> &'static str {
        match self {
            Self::Chat => "/chat/completions",
            Self::Responses => "/responses",
            Self::Anthropic => "/messages",
        }
    }

    pub fn request_body(self, model: &str, system: &str, user: &str) -> Value {
        match self {
            Self::Chat => json!({"model": model, "temperature": 0, "messages": [
                {"role": "system", "content": system}, {"role": "user", "content": user}
            ]}),
            Self::Responses => {
                json!({"model": model, "instructions": system, "input": user, "store": false})
            }
            Self::Anthropic => {
                json!({"model": model, "max_tokens": 4096, "system": system, "messages": [
                    {"role": "user", "content": user}
                ]})
            }
        }
    }

    pub fn response_text(self, body: &Value) -> Option<String> {
        let text = match self {
            Self::Chat => body
                .get("choices")?
                .as_array()?
                .first()?
                .get("message")?
                .get("content")?
                .as_str()?
                .to_string(),
            Self::Responses => body
                .get("output")?
                .as_array()?
                .iter()
                .filter(|item| {
                    item.get("type").and_then(Value::as_str) == Some("message")
                        && item.get("role").and_then(Value::as_str) == Some("assistant")
                })
                .filter_map(|item| item.get("content").and_then(Value::as_array))
                .flatten()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("output_text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
            Self::Anthropic => body
                .get("content")?
                .as_array()?
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
        };
        (!text.trim().is_empty()).then_some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_protocols_have_distinct_wire_contracts() {
        let chat = AiProtocol::Chat.request_body("m", "rules", "input");
        assert_eq!(chat["messages"][1]["content"], "input");
        assert_eq!(
            AiProtocol::Chat
                .response_text(&json!({"choices":[{"message":{"content":"[]"}}]}))
                .as_deref(),
            Some("[]")
        );

        let responses = AiProtocol::Responses.request_body("m", "rules", "input");
        assert_eq!(responses["instructions"], "rules");
        assert_eq!(responses["input"], "input");
        assert_eq!(responses["store"], false);
        assert_eq!(AiProtocol::Responses.response_text(&json!({"output":[{"type":"reasoning"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"[]"}]}]})).as_deref(), Some("[]"));
        assert_eq!(AiProtocol::Responses.response_text(&json!({"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"he"},{"type":"output_text","text":"llo"}]}]})).as_deref(), Some("hello"));

        let anthropic = AiProtocol::Anthropic.request_body("m", "rules", "input");
        assert_eq!(anthropic["max_tokens"], 4096);
        assert_eq!(anthropic["messages"][0]["content"], "input");
        assert_eq!(AiProtocol::Anthropic.response_text(&json!({"content":[{"type":"thinking","text":"ignored"},{"type":"text","text":"[]"}]})).as_deref(), Some("[]"));
        assert_eq!(AiProtocol::Anthropic.response_text(&json!({"content":[{"type":"text","text":"he"},{"type":"text","text":"llo"}]})).as_deref(), Some("hello"));
    }
}
