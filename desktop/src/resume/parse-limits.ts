// 简历解析前端提前拦的两个上限。它们其实是后端已经强制的同一条规则，只是为了不浪费
// 一次 AI 调用（或一次注定存不下的建模板请求）而在界面上提前算一遍——真正的数字定义
// 在 Rust 那边，这里必须和它们相等。`parse-limits.test.ts` 读源码校验这一点，
// 不指望改了一边、记得同时改另一边。

// 与 desktop/src-tauri/src/ai_complete.rs 的 MAX_USER_CHARS 一致：前端提前拦，
// 免得用户等了一两分钟才被后端拒绝。
export const MAX_USER_CHARS = 60_000;

// 与 desktop/crates/archive-store/src/resume.rs 的 MAX_TEMPLATES 一致：到了上限
// 存不进去，就不该先花一次 AI 调用去解析一份注定存不下的模板。
export const MAX_TEMPLATES = 25;
