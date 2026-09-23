//! D11：「发什么」与「收回来的东西能不能信」。
//!
//! 这个 crate 不联网、不碰数据库、不依赖 Tauri。命令层负责凭据、HTTP 和写库；
//! 提示注入、越界编号、编造引用、非法 JSON 这些情形在这里用普通 `cargo test` 覆盖。
//!
//! 两条贯穿全文的规矩：
//!
//! - **模型看不到申请 UUID。** 候选在请求里是 `c1 / c2 / ...`，回来之后由 [`RequestContext`]
//!   映射回本地 id；给了一个不在列表里的编号，整条建议作废。
//! - **宁可 `unknown` 也不猜。** 枚举外的值一律降级，日期解析不了就丢掉那条待办并记一条
//!   不确定点，只有 JSON 根本解析不了才算失败。

pub mod candidates;
pub mod excerpt;
pub mod prompt;
pub mod protocol;
pub mod schema;

pub use candidates::{pick_candidates, Candidate, MAX_CANDIDATES};
pub use excerpt::normalize;
pub use prompt::{
    build_request, build_request_for_protocol, BuiltRequest, EvidenceInput, OutboundScope, RequestContext, ScopeCandidate,
    MAX_BODY_CHARS,
};
pub use protocol::AiProtocol;
pub use schema::{
    parse_response, Due, ExtractError, Extraction, SuggestedTodo, REPLY_CLASSES, SEND_MODES, STAGES,
};
