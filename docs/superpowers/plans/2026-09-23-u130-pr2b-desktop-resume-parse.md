# #130 PR 2b：桌面简历解析 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在桌面「简历」页上传 PDF / Word（.docx）/ TXT 简历，确认外发范围后交给「当前使用」的 AI 服务商解析，结果存成一个新模板并设为当前——取代插件管理页里的「解析简历」。

**Architecture:** 解析流程整体放在桌面前端，**直接复用插件的 JS**：`resume-utils.js`（PDF 按页抽文字）、`ai-helpers.js`（`normalizeParsedFields` 把模型返回整理成分组字段）与插件同一段提示词，都以「副本 + 测试锁死一字不差」的方式放进 `desktop/src/resume/`（同 PR 1 的 `profile-fields.js`）。文字抽取用与插件同版本的 `pdfjs-dist` 与 `mammoth`。Rust 只新增两个薄命令：`ai_complete_cmd`（用当前服务商问一次、可取消；PR 3 的 `ai.complete` 转发复用同一个函数）与 `create_resume_template_cmd`（把分组交给 PR 1 的存储层，照常剔除密码类字段、编号重名、检查大小）。

**Tech Stack:** Rust（Tauri 2、reqwest）、React 19 + TypeScript、`pdfjs-dist@6.3.289`、`mammoth@1`、Vite 6、Vitest、`node --test`。

**上级计划：** [2026-09-23-u130-pr-breakdown.md](2026-09-23-u130-pr-breakdown.md)（PR 2）· [#130](https://github.com/TshyGO/resume-form-assistant-plugin/issues/130)

**依赖：** PR 2a（[计划](2026-09-23-u130-pr2a-desktop-ai-providers.md)）必须先合入——本 PR 用它的 `ai_provider_commands::active_with_key` 与 `get_ai_settings_cmd` 新形状。**分支：** `feat/130-pr2b-desktop-resume-parse`，从合入 2a 之后的 `origin/main` 新建。

---

## 与拆分计划的偏差（已定）

拆分计划决策 5 写「解析提示词与结果规范化移植到 Rust `resume_parse.rs`」。改为桌面前端复用插件 JS：规则只维护一处，插件在 PR 5 删掉解析功能时，桌面副本就成为唯一实现（届时删掉锁死测试即可）。PR 3 的 `ai.complete` 转发与本 PR 共用 Rust 的 `ai_complete` 函数。

## 已核实的事实（基线 bb68cbb + PR 2a）

- 插件解析流程：`popup.js` `buildResumeParsePayload`（txt 直接读文本；docx 用 `mammoth.convertToHtml` 再 `extractTextFromHtml`——`DOMParser` 取 `body.textContent` 并 `.replace(/\s+\n/g, "\n").trim()`；pdf 用 `ResumeProUtils.extractPdfText(pdfjsLib, arrayBuffer, { cMapPacked: true, cMapUrl })`，出错用 `getPdfExtractionErrorMessage`；抽不出文字时提示可能是扫描版）→ `ai-worker.js` `handleParseResume`（`userContent = "请提取以下简历中的所有信息：\n\n" + 文本`，系统提示词为 `ai-worker.js` 第 204 行起的 `SYSTEM_PROMPT` 七行，`temperature: 0`；返回用 `parseJsonContent` 去掉 ```json 围栏后 `JSON.parse`，再 `ResumeProAIHelpers.normalizeParsedFields`）→ `popup.js` `parsedFieldsToGroups`（按 group 首次出现顺序分组）→ 存成模板 `「<文件名去扩展名>（AI 解析）」`，插到最前并设为当前，提示「已存为模板「x」并设为当前，共 N 个字段。」
- 插件用的库版本：`vendor/pdfjs/pdf.min.mjs` 为 pdf.js **6.3.289**（含 `pdf.worker.min.mjs` 与 `cmaps/`）；`mammoth.browser.min.js` 为 mammoth 1.x 的浏览器 UMD 包。
- `resume-utils.js`、`ai-helpers.js` 都是自包含 IIFE：有 CommonJS 时 `module.exports`，同时挂到 `globalThis.ResumeProUtils` / `globalThis.ResumeProAIHelpers`，不依赖 `chrome.*` 或 DOM（`resume-utils.js` 里的 `document` 是局部变量名）。
- PR 1：`resume_commands::ImportResult { template, previous_field_count, skipped_secret_fields }`（`impl From<SavedTemplate>`）；`ArchiveStore::create_template(name, groups) -> SavedTemplate`（剔除密码类字段、名字截到 96 字并编号、模板 ≤ 24 KiB、最多 25 个）；前端 `importMessage(fieldCount, previous, skipped)`、`TemplateList`、`FilePickers`。
- PR 2a：`ai_provider_commands::active_with_key(data_root, creds) -> (AiProvider, key)`；`get_ai_settings_cmd` 返回 `{ providers, activeProviderId, credentialError }`。
- `ai_client::ChatClient::with_timeout(Duration)`、`chat(api_url, key, host, model, &body) -> Result<String, CommandError>`；`AppState.ai_inflight: ai_commands::InflightRegistry`（`begin(evidence_id, request_id)` 返回取消信号，同一 evidence_id 同时只允许一个；`finish(request_id)`；`cancel_analysis_cmd(request_id)` 取消任意在途请求）。
- CSP（`src-tauri/tauri.conf.json`）：`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost`。**`connect-src` 不含 `'self'`**，pdf.js 用 `fetch` 取 cMap 会被拦。
- Vite 6（`desktop/package.json`），Tauri `beforeDevCommand: npm run dev`、`beforeBuildCommand: npm run build`、`frontendDist: ../dist`。
- 外发原则（data-privacy §8、D11）：发送前让用户看到发给谁、发什么；不自动重试；可取消，取消不保证对方停止计费。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `desktop/src-tauri/src/ai_complete.rs`（新） | 用给定服务商问一次 Chat Completions 的纯函数（PR 3 复用） |
| `desktop/src-tauri/src/resume_commands.rs`（改） | `create_from_groups` |
| `desktop/src-tauri/src/lib.rs`（改） | `ai_complete_cmd`、`create_resume_template_cmd` |
| `desktop/src-tauri/tauri.conf.json`（改） | CSP `connect-src` 加 `'self'` |
| `desktop/src/resume/resume-utils.js`、`ai-helpers.js`（新，副本） | 与插件一字不差 |
| `desktop/src/resume/parse-helpers.ts`（新） | 类型化入口 + 提示词常量 |
| `desktop/src/resume/profile-sync.test.ts`（改） | 锁死三份副本与提示词 |
| `desktop/src/resume/extract-text.ts`（新）+ `.test.ts` | txt / docx / pdf 抽文字 |
| `desktop/src/resume/parse-resume.ts`（新）+ `.test.ts` | 解析流程（可注入依赖，便于测试） |
| `desktop/src/resume/ResumeParse.tsx`（新）+ `.test.tsx` | 上传、确认外发、等待与取消、结果 |
| `desktop/src/resume/ResumeView.tsx`（改） | 挂上 `ResumeParse` |
| `desktop/vite.config.js`、`desktop/package.json`（改） | 依赖与 cMap 静态拷贝 |
| `docs/desktop-mvp/data-privacy.md`（改） | §8 简历解析外发 |

---

### Task 1：Rust 通用补全函数与两个命令

**Files:**
- Create: `desktop/src-tauri/src/ai_complete.rs`
- Modify: `desktop/src-tauri/src/resume_commands.rs`、`desktop/src-tauri/src/lib.rs`

- [ ] **Step 1：写失败测试**

`ai_complete.rs`（测试模块；用本地 TCP 假服务器，照 `ai_models.rs` 里 `serve_once` 的写法在本文件内复制一个最小版本）：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_settings::AiProvider;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn serve_once(status: u16, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 65536];
            let n = stream.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).unwrap();
            request
        });
        (url, handle)
    }

    fn provider(url: &str) -> AiProvider {
        AiProvider { id: "p".into(), name: "P".into(), api_url: url.into(), model: "m1".into() }
    }

    #[tokio::test]
    async fn it_sends_system_and_user_and_returns_the_text() {
        let (url, server) = serve_once(200, r#"{"choices":[{"message":{"content":"[]"}}]}"#);
        let text = complete(&provider(&url), "sk-test", "SYS", "USER", Duration::from_secs(5)).await.unwrap();
        assert_eq!(text, "[]");
        let request = server.join().unwrap();
        assert!(request.contains("authorization: Bearer sk-test") || request.contains("Authorization: Bearer sk-test"));
        assert!(request.contains(r#""model":"m1""#));
        assert!(request.contains(r#""temperature":0"#));
        assert!(request.contains("SYS") && request.contains("USER"));
    }

    #[test]
    fn oversized_input_is_refused_before_sending() {
        let long = "字".repeat(MAX_USER_CHARS + 1);
        let err = check_sizes("s", &long).unwrap_err();
        assert_eq!(err.code, "AI_INPUT_TOO_LARGE");
        assert!(check_sizes(&"s".repeat(MAX_SYSTEM_CHARS + 1), "u").is_err());
        assert!(check_sizes("s", "u").is_ok());
    }
}
```

`resume_commands.rs` 测试模块追加：

```rust
    #[test]
    fn parsed_groups_become_a_new_current_template() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        let groups = vec![
            TemplateGroup { name: "基本信息".into(), fields: vec![
                TemplateField { key: "姓名".into(), value: "张三".into() },
                TemplateField { key: "邮箱密码".into(), value: "x".into() },
            ] },
        ];
        let result = create_from_groups(&db, "我的简历（AI 解析）", groups).unwrap();
        assert_eq!(result.template.name, "我的简历（AI 解析）");
        assert_eq!(result.template.field_count, 1);
        assert_eq!(result.skipped_secret_fields, 1);
        assert_eq!(result.previous_field_count, None);
        assert_eq!(db.resume_overview().unwrap().active_template_id.as_deref(), Some(result.template.id.as_str()));
    }
```

Run: `cd desktop && cargo test --manifest-path src-tauri/Cargo.toml --locked --lib ai_complete resume_commands`
Expected: 编译失败。

- [ ] **Step 2：实现**

`desktop/src-tauri/src/ai_complete.rs`：

```rust
//! 用给定服务商问一次 Chat Completions，返回正文。简历解析（PR 2b）与插件经桌面转发的
//! `ai.complete`（PR 3）共用这一个函数，规矩与 `ai_client` 相同：不重试、有硬超时、
//! 日志只记主机名与耗时。提示词由调用方给，这里不理解业务。

use std::time::Duration;

use serde_json::json;

use crate::ai_client::ChatClient;
use crate::ai_settings::{host_of, AiProvider};
use crate::commands::CommandError;

/// 系统提示词与用户内容的上限（字符数）。简历全文一般几千字；超过这个数多半选错了文件，
/// 也不该一次把这么多内容发给服务商。
pub const MAX_SYSTEM_CHARS: usize = 8_000;
pub const MAX_USER_CHARS: usize = 60_000;
/// 解析一份长简历，慢的模型可能要一两分钟。
pub const COMPLETE_TIMEOUT: Duration = Duration::from_secs(120);

pub fn check_sizes(system: &str, user: &str) -> Result<(), CommandError> {
    if system.chars().count() > MAX_SYSTEM_CHARS || user.chars().count() > MAX_USER_CHARS {
        return Err(CommandError {
            code: "AI_INPUT_TOO_LARGE".into(),
            message: format!("要发给 AI 的内容超过 {MAX_USER_CHARS} 字，没有发送。确认选对了文件。"),
        });
    }
    Ok(())
}

pub async fn complete(
    provider: &AiProvider,
    key: &str,
    system: &str,
    user: &str,
    timeout: Duration,
) -> Result<String, CommandError> {
    check_sizes(system, user)?;
    let body = json!({
        "model": provider.model,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });
    let host = host_of(&provider.api_url);
    ChatClient::with_timeout(timeout)?
        .chat(&provider.api_url, key, &host, &provider.model, &body)
        .await
}
```

（`ChatClient::with_timeout` 若是私有，改成 `pub`。）

`resume_commands.rs`：

```rust
/// 简历解析的结果：插到最前、设为当前，照常剔除密码类字段、编号重名、检查大小。
pub fn create_from_groups(store: &ArchiveStore, name: &str, groups: Vec<TemplateGroup>) -> Result<ImportResult, CommandError> {
    store.create_template(name, groups).map(ImportResult::from).map_err(resume_error)
}
```

`lib.rs`（`mod ai_complete;`，并注册两个命令）：

```rust
/// 用「当前使用」的服务商问一次。只给简历解析用；插件转发在 PR 3 走协议，不走这个命令。
/// 同一时间只允许一个（`ai_inflight` 以 `resume-parse` 占位），可以 `cancel_analysis_cmd` 取消。
#[tauri::command]
async fn ai_complete_cmd(
    state: State<'_, AppState>,
    system: String,
    user: String,
    request_id: String,
) -> Result<String, CommandError> {
    ai_complete::check_sizes(&system, &user)?;
    let (provider, key) = ai_provider_commands::active_with_key(&ai_data_root(&state)?, state.credentials.as_ref())?;
    checked_url(&provider.api_url)?;
    let cancelled = state.ai_inflight.begin("resume-parse", &request_id)?;
    let outcome = tokio::select! {
        result = ai_complete::complete(&provider, &key, &system, &user, ai_complete::COMPLETE_TIMEOUT) => result,
        _ = cancelled => Err(CommandError {
            code: "AI_CANCELLED".into(),
            message: "已取消。取消不保证对方停止计算或停止计费。".into(),
        }),
    };
    state.ai_inflight.finish(&request_id);
    outcome
}

#[tauri::command]
fn create_resume_template_cmd(
    state: State<AppState>,
    name: String,
    groups: Vec<archive_store::TemplateGroup>,
) -> Result<resume_commands::ImportResult, CommandError> {
    with_store(&state, move |store| resume_commands::create_from_groups(store, &name, groups))
}
```

先读 `ai_commands::InflightRegistry::begin` 的签名与它在「同一 evidence 已有请求」时返回的错误码，确认用 `"resume-parse"` 作为占位 id 不会与真实证据 id 冲突（证据 id 是 UUID，不会是这个字符串）。

- [ ] **Step 3：跑测试与构建**

Run: `cd desktop && cargo test --manifest-path src-tauri/Cargo.toml --locked --bins --lib && cargo build --manifest-path src-tauri/Cargo.toml --locked --bins`
Expected: 全绿。

- [ ] **Step 4：提交**

```bash
git add desktop/src-tauri/src/ai_complete.rs desktop/src-tauri/src/resume_commands.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): 通用 AI 补全与从解析结果建模板的命令 (#130)"
```

---

### Task 2：复用插件的解析辅助代码与提示词

**Files:**
- Create: `desktop/src/resume/resume-utils.js`、`desktop/src/resume/ai-helpers.js`（副本）、`desktop/src/resume/parse-helpers.ts`
- Modify: `desktop/src/resume/profile-sync.test.ts`

- [ ] **Step 1：写失败测试**（`profile-sync.test.ts` 追加）

```ts
test("解析用的 resume-utils.js、ai-helpers.js 与插件一字不差", () => {
  for (const name of ["resume-utils.js", "ai-helpers.js"]) {
    const plugin = readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8");
    const desktop = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    assert.equal(desktop, plugin, name);
  }
});

// 插件在 PR 5 删掉解析功能时，这条测试一起删，桌面成为唯一实现。
test("解析提示词与插件 ai-worker.js 的一致", async () => {
  const worker = readFileSync(new URL("../../../ai-worker.js", import.meta.url), "utf8");
  const { RESUME_PARSE_SYSTEM_PROMPT, RESUME_PARSE_USER_PREFIX } = await import("./parse-helpers.ts");
  for (const line of RESUME_PARSE_SYSTEM_PROMPT.split("\n")) {
    assert.ok(worker.includes(JSON.stringify(line).slice(1, -1)) || worker.includes(line), line);
  }
  assert.ok(worker.includes("请提取以下简历中的所有信息：\\n\\n"));
  assert.equal(RESUME_PARSE_USER_PREFIX, "请提取以下简历中的所有信息：\n\n");
});

test("解析辅助的类型化入口可用", async () => {
  const { parseHelpers } = await import("./parse-helpers.ts");
  const fields = parseHelpers.normalizeParsedFields([{ group: "基本信息", key: "姓名", value: "张三" }, { group: "", key: "x", value: "y" }]);
  assert.deepEqual(fields.map((f) => f.key), ["姓名"]);
  assert.equal(typeof parseHelpers.extractPdfText, "function");
});
```

Run: `cd desktop && npm run test:ui`
Expected: FAIL。

- [ ] **Step 2：实现**

```bash
cp resume-utils.js desktop/src/resume/resume-utils.js
cp ai-helpers.js desktop/src/resume/ai-helpers.js
```

`desktop/src/resume/parse-helpers.ts`：

```ts
// 插件的 resume-utils.js / ai-helpers.js 是自包含 IIFE：没有 CommonJS 时把 API 挂到 globalThis。
// 与 profile.ts 同一做法：副作用导入一次，再给 TS 一个有类型的入口。
import "./resume-utils.js";
import "./ai-helpers.js";

export interface ParsedField {
  group: string;
  key: string;
  value: string;
}

interface PdfLib {
  getDocument(options: Record<string, unknown>): { promise: Promise<unknown> };
}

interface ParseHelpers {
  normalizeParsedFields(payload: unknown): ParsedField[];
  extractPdfText(pdfjsLib: PdfLib, data: ArrayBuffer | Uint8Array, options?: Record<string, unknown>): Promise<string>;
  getPdfExtractionErrorMessage(error: unknown): string;
}

const g = globalThis as unknown as {
  ResumeProAIHelpers: { normalizeParsedFields: ParseHelpers["normalizeParsedFields"] };
  ResumeProUtils: { extractPdfText: ParseHelpers["extractPdfText"]; getPdfExtractionErrorMessage: ParseHelpers["getPdfExtractionErrorMessage"] };
};

export const parseHelpers: ParseHelpers = {
  normalizeParsedFields: (payload) => g.ResumeProAIHelpers.normalizeParsedFields(payload),
  extractPdfText: (lib, data, options) => g.ResumeProUtils.extractPdfText(lib, data, options),
  getPdfExtractionErrorMessage: (error) => g.ResumeProUtils.getPdfExtractionErrorMessage(error),
};

// 与插件 ai-worker.js handleParseResume 的 SYSTEM_PROMPT 逐行一致（测试锁死）。
export const RESUME_PARSE_SYSTEM_PROMPT = [
  "你是一个简历信息提取助手。请从用户提供的简历中提取所有关键信息。",
  "输出要求：",
  "1. 仅返回 JSON 数组，不含任何解释文字或 markdown 代码块",
  '2. 格式：[{"group":"分组名","key":"字段名","value":"字段值"}]',
  "3. 分组参考：基本信息、教育背景、实习经历、科研经历、校园经历、论文、专利、技能、证书、奖励",
  '4. 论文每条单独成行，字段名用"论文1标题"、"论文1期刊"、"论文1发表年份"等',
  '5. 专利每条单独成行，字段名用"专利1标题"、"专利1摘要"、"专利1申请号"等',
  '6. 多段经历用"实习1公司"、"实习2公司"等区分',
  "7. 字段值保持原文，不要缩写",
].join("\n");

export const RESUME_PARSE_USER_PREFIX = "请提取以下简历中的所有信息：\n\n";
```

- [ ] **Step 3：跑测试**

Run: `cd desktop && npm run test:ui && npm run typecheck`
Expected: PASS。提示词行在 `ai-worker.js` 里以 JS 字符串字面量出现（双引号或单引号），测试里两种写法都兼容；若仍不匹配，打印出不匹配的行对照修正常量，**不要改插件文件**。

- [ ] **Step 4：提交**

```bash
git add desktop/src/resume/resume-utils.js desktop/src/resume/ai-helpers.js desktop/src/resume/parse-helpers.ts desktop/src/resume/profile-sync.test.ts
git commit -m "feat(desktop): 复用插件的简历解析辅助代码与提示词，测试锁死 (#130)"
```

---

### Task 3：抽取简历文字（txt / docx / pdf）

**Files:**
- Modify: `desktop/package.json`、`desktop/package-lock.json`、`desktop/vite.config.js`、`desktop/src-tauri/tauri.conf.json`
- Create: `desktop/src/resume/extract-text.ts`、`desktop/src/resume/extract-text.test.ts`

- [ ] **Step 1：依赖**

```bash
cd desktop
npm install --save-exact pdfjs-dist@6.3.289
npm install mammoth@^1
npm install --save-dev vite-plugin-static-copy
```

`vite-plugin-static-copy` 选与 Vite 6 兼容的主版本（看它的 peerDependencies）；装完 `npm ls vite` 确认没有第二个 Vite。

`vite.config.js` 加 cMap 静态拷贝（开发与构建都生效）：

```js
import { viteStaticCopy } from "vite-plugin-static-copy";
// …plugins 数组里加：
viteStaticCopy({ targets: [{ src: "node_modules/pdfjs-dist/cmaps/*", dest: "pdfjs/cmaps" }] }),
```

`tauri.conf.json` 的 CSP：`connect-src ipc: http://ipc.localhost` 改为 `connect-src 'self' ipc: http://ipc.localhost`（pdf.js 用 `fetch` 读同源 cMap）。

- [ ] **Step 2：写失败测试** `extract-text.test.ts`（`node --test`，只测不依赖浏览器库的路径）

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { extensionOf, extractText, MAX_RESUME_BYTES } from "./extract-text.ts";

const file = (name: string, text: string) => new File([text], name);

test("只收 pdf / docx / txt", () => {
  assert.equal(extensionOf("a.PDF"), "pdf");
  assert.equal(extensionOf("a.docx"), "docx");
  assert.equal(extensionOf("a.doc"), null);
  assert.equal(extensionOf("noext"), null);
});

test("txt 直接读文字并去掉首尾空白", async () => {
  assert.equal(await extractText(file("r.txt", "  张三\n邮箱 a@b.c \n")), "张三\n邮箱 a@b.c");
});

test("不支持的类型、空文件、超大文件都说清楚", async () => {
  await assert.rejects(extractText(file("r.doc", "x")), /PDF、Word（.docx）或 TXT/);
  await assert.rejects(extractText(file("r.txt", "   ")), /没有可发送给 AI 的文字/);
  await assert.rejects(extractText(new File([new Uint8Array(MAX_RESUME_BYTES + 1)], "big.txt")), /超过 10 MB/);
});

test("docx 与 pdf 走注入的抽取器", async () => {
  const deps = {
    docxToHtml: async () => "<p>张三</p>\n<p>某大学</p>",
    pdfToText: async () => "第一页\n第二页",
  };
  assert.match(await extractText(file("r.docx", "x"), deps), /张三[\s\S]*某大学/);
  assert.equal(await extractText(file("r.pdf", "x"), deps), "第一页\n第二页");
});
```

Run: `npm run test:ui`，Expected: FAIL。

- [ ] **Step 3：实现** `extract-text.ts`

```ts
import { parseHelpers } from "./parse-helpers.ts";

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
export type ResumeExtension = "pdf" | "docx" | "txt";

export function extensionOf(name: string): ResumeExtension | null {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return ext === "pdf" || ext === "docx" || ext === "txt" ? ext : null;
}

export interface Extractors {
  docxToHtml(data: ArrayBuffer): Promise<string>;
  pdfToText(data: ArrayBuffer): Promise<string>;
}

// 与插件 popup.js extractTextFromHtml 一致。
function textFromHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  return (doc.body?.textContent || "").replace(/\s+\n/g, "\n").trim();
}

/** 真正的库只在需要时加载：pdf.js 与 mammoth 都不小，打开「简历」页不该就下载它们。 */
export const browserExtractors: Extractors = {
  async docxToHtml(data) {
    const mammoth = await import("mammoth");
    const result = await (mammoth.default ?? mammoth).convertToHtml({ arrayBuffer: data });
    return result.value;
  },
  async pdfToText(data) {
    const pdfjs = await import("pdfjs-dist");
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return parseHelpers.extractPdfText(pdfjs as never, data, {
      cMapPacked: true,
      cMapUrl: `${import.meta.env?.BASE_URL ?? "/"}pdfjs/cmaps/`,
      isEvalSupported: false,
    });
  },
};

export async function extractText(file: File, deps: Extractors = browserExtractors): Promise<string> {
  const ext = extensionOf(file.name);
  if (!ext) throw new Error("只支持 PDF、Word（.docx）或 TXT 简历。");
  if (file.size > MAX_RESUME_BYTES) throw new Error("文件超过 10 MB，不像是简历，确认选对了文件。");
  let text: string;
  if (ext === "txt") {
    text = (await file.text()).trim();
  } else if (ext === "docx") {
    try {
      text = textFromHtml(await deps.docxToHtml(await file.arrayBuffer()));
    } catch {
      throw new Error("Word 文件读取失败，确认它能正常打开，或另存为 PDF / TXT 再试。");
    }
  } else {
    try {
      text = (await deps.pdfToText(await file.arrayBuffer())).trim();
    } catch (error) {
      throw new Error(parseHelpers.getPdfExtractionErrorMessage(error));
    }
    if (!text) {
      throw new Error("PDF 未检测到可提取文字，可能是扫描版。请改用 Word / TXT，或先用 OCR 转成文字。");
    }
  }
  if (!text) throw new Error("简历中没有可发送给 AI 的文字。");
  return text;
}
```

`import.meta.env` 在 `node --test` 下不存在，所以用可选链；若 `tsc` 报 `?url` 模块无类型，新建 `desktop/src/vite-env.d.ts`，内容 `/// <reference types="vite/client" />`（先看项目里是否已有）。`pdfjs-dist` 的 worker 路径以 6.3.289 包内实际文件为准（`ls node_modules/pdfjs-dist/build/`）。

- [ ] **Step 4：跑测试与构建**

Run: `npm run test:ui && npm run typecheck && npm run build`
Expected: 通过；`dist/pdfjs/cmaps/` 下有 `.bcmap` 文件（`ls dist/pdfjs/cmaps | head`）。

- [ ] **Step 5：提交**

```bash
git add desktop/package.json desktop/package-lock.json desktop/vite.config.js desktop/src-tauri/tauri.conf.json desktop/src/resume/extract-text.ts desktop/src/resume/extract-text.test.ts
git commit -m "feat(desktop): 抽取 PDF / Word / TXT 简历文字，与插件同版本 pdf.js (#130)"
```

（若新增了 `vite-env.d.ts`，一并提交。）

---

### Task 4：解析流程

**Files:**
- Create: `desktop/src/resume/parse-resume.ts`、`desktop/src/resume/parse-resume.test.ts`

- [ ] **Step 1：写失败测试**（`node --test`）

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldsToGroups, parseModelReply, templateNameFor } from "./parse-resume.ts";

test("去掉 ```json 围栏后解析，并按插件规则整理", () => {
  const fields = parseModelReply('```json\n[{"group":"基本信息","key":"姓名","value":"张三"}]\n```');
  assert.deepEqual(fields, [{ group: "基本信息", key: "姓名", value: "张三" }]);
});

test("返回不是 JSON 数组时给出插件同款提示", () => {
  assert.throws(() => parseModelReply("抱歉，我无法处理"), /AI 返回格式异常，无法解析/);
  assert.throws(() => parseModelReply("[]"), /AI 未能提取到有效信息/);
});

test("按分组首次出现的顺序合并", () => {
  const groups = fieldsToGroups([
    { group: "基本信息", key: "姓名", value: "张三" },
    { group: "教育背景", key: "学校", value: "某大学" },
    { group: "基本信息", key: "邮箱", value: "a@b.c" },
  ]);
  assert.deepEqual(groups.map((g) => [g.name, g.fields.map((f) => f.key)]), [
    ["基本信息", ["姓名", "邮箱"]],
    ["教育背景", ["学校"]],
  ]);
});

test("模板名取文件名并注明 AI 解析", () => {
  assert.equal(templateNameFor("张三-简历.pdf"), "张三-简历（AI 解析）");
  assert.equal(templateNameFor(".pdf"), "简历（AI 解析）");
});
```

Run: `npm run test:ui`，Expected: FAIL。

- [ ] **Step 2：实现** `parse-resume.ts`

```ts
import type { TemplateGroupView } from "../api.ts";
import { parseHelpers, RESUME_PARSE_SYSTEM_PROMPT, RESUME_PARSE_USER_PREFIX } from "./parse-helpers.ts";
import type { ParsedField } from "./parse-helpers.ts";

// 与插件 ai-worker.js parseJsonContent 一致。
function parseJsonContent(content: string): unknown {
  const cleaned = content.trim().replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned);
}

export function parseModelReply(reply: string): ParsedField[] {
  let fields: ParsedField[];
  try {
    fields = parseHelpers.normalizeParsedFields(parseJsonContent(reply));
  } catch {
    throw new Error("AI 返回格式异常，无法解析。");
  }
  if (!fields.length) throw new Error("AI 未能提取到有效信息，请检查文件内容。");
  return fields;
}

// 与插件 popup.js parsedFieldsToGroups 一致。
export function fieldsToGroups(fields: ParsedField[]): TemplateGroupView[] {
  const map = new Map<string, Array<{ key: string; value: string }>>();
  for (const field of fields) {
    if (!map.has(field.group)) map.set(field.group, []);
    map.get(field.group)!.push({ key: field.key, value: field.value });
  }
  return [...map].map(([name, groupFields]) => ({ name, fields: groupFields }));
}

export function templateNameFor(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "").trim();
  return `${stem || "简历"}（AI 解析）`;
}

export function buildRequest(text: string): { system: string; user: string } {
  return { system: RESUME_PARSE_SYSTEM_PROMPT, user: `${RESUME_PARSE_USER_PREFIX}${text}` };
}
```

- [ ] **Step 3：跑测试**

Run: `npm run test:ui && npm run typecheck`，Expected: PASS。

- [ ] **Step 4：提交**

```bash
git add desktop/src/resume/parse-resume.ts desktop/src/resume/parse-resume.test.ts
git commit -m "feat(desktop): 简历解析结果整理与分组，口径同插件 (#130)"
```

---

### Task 5：上传与解析界面

**Files:**
- Create: `desktop/src/resume/ResumeParse.tsx`、`desktop/src/resume/ResumeParse.test.tsx`
- Modify: `desktop/src/resume/ResumeView.tsx`

流程：选文件 → 抽文字 → **确认外发**（发给哪个服务商的哪个主机与模型、多少字、对方可能留存）→ 等待（可取消）→ 建模板 → 提示并让模板列表刷新。

- [ ] **Step 1：写失败测试**

```tsx
import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiSettingsView, Invoke } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { ResumeParse } from "./ResumeParse.tsx";

const settings: AiSettingsView = {
  providers: [{ id: "p1", name: "DeepSeek", apiUrl: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat", host: "api.deepseek.com", keyConfigured: true }],
  activeProviderId: "p1",
  credentialError: null,
};

function mount(handler: (command: string, args?: Record<string, unknown>) => unknown) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  const onCreated = vi.fn();
  render(
    <InvokeProvider invoke={invoke}>
      <ResumeParse onCreated={onCreated} extract={async () => "张三\n某大学"} />
    </InvokeProvider>,
  );
  return { calls, onCreated };
}

const upload = async (user: ReturnType<typeof userEvent.setup>) =>
  user.upload(screen.getByLabelText("选择简历文件"), new File(["x"], "张三简历.pdf"));

test("确认前说清楚发给谁、发多少字，确认后才发送", async () => {
  const user = userEvent.setup();
  const { calls, onCreated } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "ai_complete_cmd") return '[{"group":"基本信息","key":"姓名","value":"张三"}]';
    return { template: { id: "t1", name: "张三简历（AI 解析）", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 0 };
  });
  await upload(user);
  expect(await screen.findByText(/DeepSeek/)).toBeTruthy();
  expect(screen.getByText(/api\.deepseek\.com · deepseek-chat/)).toBeTruthy();
  expect(screen.getByText(/7 字/)).toBeTruthy();
  expect(calls.some((c) => c.command === "ai_complete_cmd")).toBe(false);
  await user.click(screen.getByRole("button", { name: "发送并解析" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(screen.getByText("已存为模板「张三简历（AI 解析）」并设为当前，共 1 个字段。")).toBeTruthy();
  const created = calls.find((c) => c.command === "create_resume_template_cmd")!;
  expect(created.args).toEqual({ name: "张三简历（AI 解析）", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "张三" }] }] });
});

test("没有可用服务商时不让发送，并指向设置页", async () => {
  const user = userEvent.setup();
  mount((command) => (command === "get_ai_settings_cmd" ? { providers: [], activeProviderId: null, credentialError: null } : null));
  await upload(user);
  expect(await screen.findByText(/先在「设置 → AI」添加服务商/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "发送并解析" })).toBeNull();
});

test("等待中可以取消", async () => {
  const user = userEvent.setup();
  let release: (value: unknown) => void = () => {};
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "ai_complete_cmd") return new Promise((resolve) => { release = resolve; });
    if (command === "cancel_analysis_cmd") { release('[]'); return true; }
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  await user.click(await screen.findByRole("button", { name: "取消" }));
  const cancel = calls.find((c) => c.command === "cancel_analysis_cmd")!;
  const sent = calls.find((c) => c.command === "ai_complete_cmd")!;
  expect(cancel.args?.requestId).toBe(sent.args?.requestId);
});

test("模型返回乱码时如实提示，不建模板", async () => {
  const user = userEvent.setup();
  const { calls } = mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "ai_complete_cmd") return "抱歉";
    return null;
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  expect(await screen.findByText(/AI 返回格式异常/)).toBeTruthy();
  expect(calls.some((c) => c.command === "create_resume_template_cmd")).toBe(false);
});

test("剔掉的密码类字段要说出来", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "get_ai_settings_cmd") return settings;
    if (command === "ai_complete_cmd") return '[{"group":"g","key":"k","value":"v"}]';
    return { template: { id: "t1", name: "n", fieldCount: 1, updatedAt: "" }, previousFieldCount: null, skippedSecretFields: 2 };
  });
  await upload(user);
  await user.click(await screen.findByRole("button", { name: "发送并解析" }));
  expect(await screen.findByText(/另有 2 个像密码或验证码的字段没有存/)).toBeTruthy();
});
```

Run: `npm run test:react -- src/resume/ResumeParse.test.tsx`，Expected: FAIL。

- [ ] **Step 2：实现** `ResumeParse.tsx`

```tsx
import { useRef, useState } from "react";
import type { AiProviderView, AiSettingsView, ImportResultView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { extractText } from "./extract-text.ts";
import { buildRequest, fieldsToGroups, parseModelReply, templateNameFor } from "./parse-resume.ts";
import type { Notice } from "./resume-text.ts";

type Stage =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "confirm"; fileName: string; text: string; provider: AiProviderView | null }
  | { kind: "sending"; requestId: string }
  | { kind: "done" };

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return (error as { message?: string } | null)?.message ?? "解析失败，请重试。";
}

/**
 * 上传一份简历，交给「当前使用」的 AI 服务商解析，存成新模板并设为当前。
 * 发送前必须让用户看到：发给谁（服务商、主机、模型）、发多少字、对方可能留存（data-privacy §8）。
 */
export function ResumeParse({ onCreated, extract = extractText }: { onCreated(): void; extract?: (file: File) => Promise<string> }) {
  const invoke = useInvoke();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const counter = useRef(0);

  if (!invoke) return null;

  const pick = async (file: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!file) return;
    setNotice(null);
    setStage({ kind: "reading" });
    try {
      const [text, settings] = await Promise.all([extract(file), invoke<AiSettingsView>("get_ai_settings_cmd")]);
      const provider = settings.providers.find((p) => p.id === settings.activeProviderId && p.keyConfigured) ?? null;
      setStage({ kind: "confirm", fileName: file.name, text, provider });
    } catch (error) {
      setStage({ kind: "idle" });
      setNotice({ tone: "error", text: errorText(error) });
    }
  };

  const send = async (fileName: string, text: string) => {
    const requestId = `resume-parse-${Date.now()}-${++counter.current}`;
    setStage({ kind: "sending", requestId });
    try {
      const { system, user } = buildRequest(text);
      const reply = await invoke<string>("ai_complete_cmd", { system, user, requestId });
      const groups = fieldsToGroups(parseModelReply(reply));
      const result = await invoke<ImportResultView>("create_resume_template_cmd", { name: templateNameFor(fileName), groups });
      const skipped = result.skippedSecretFields
        ? `另有 ${result.skippedSecretFields} 个像密码或验证码的字段没有存。`
        : "";
      setNotice({
        tone: skipped ? "warn" : "ok",
        text: `已存为模板「${result.template.name}」并设为当前，共 ${result.template.fieldCount} 个字段。${skipped}`,
      });
      setStage({ kind: "done" });
      onCreated();
    } catch (error) {
      setStage({ kind: "idle" });
      setNotice({ tone: "error", text: errorText(error) });
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <label className="button-like">
          上传简历，AI 解析
          <input
            ref={input}
            aria-label="选择简历文件"
            type="file"
            accept=".pdf,.docx,.txt"
            hidden
            disabled={stage.kind === "reading" || stage.kind === "sending"}
            onChange={(event) => void pick(event.target.files?.[0])}
          />
        </label>
        <span className="muted">支持 PDF、Word（.docx）、TXT。扫描版 PDF 抽不出文字。</span>
      </div>
      {stage.kind === "reading" ? <p className="muted">正在读取文件…</p> : null}
      {stage.kind === "confirm" ? (
        stage.provider ? (
          <div className="note warn stack" role="group" aria-label="确认外发">
            <p>
              将把简历全文（{stage.text.length} 字）发给「{stage.provider.name}」解析：{stage.provider.host} · {stage.provider.model}。对方可能留存这些内容。
            </p>
            <div className="row">
              <button type="button" className="primary" onClick={() => void send(stage.fileName, stage.text)}>
                发送并解析
              </button>
              <button type="button" onClick={() => setStage({ kind: "idle" })}>
                不发送
              </button>
            </div>
          </div>
        ) : (
          <p className="note warn">还没有可用的 AI 服务商（或它还没有 Key）。先在「设置 → AI」添加服务商并填好 Key。</p>
        )
      ) : null}
      {stage.kind === "sending" ? (
        <div className="row">
          <span className="muted">正在等待 AI 解析，长简历可能要一两分钟…</span>
          <button type="button" onClick={() => void invoke("cancel_analysis_cmd", { requestId: stage.requestId })}>
            取消
          </button>
        </div>
      ) : null}
      {notice ? <p role="status" className={`note ${notice.tone}`}>{notice.text}</p> : null}
    </div>
  );
}
```

取消后 `ai_complete_cmd` 以 `AI_CANCELLED` 报错，走 `catch`，界面显示「已取消。取消不保证对方停止计算或停止计费。」。`.button-like` 若样式里没有，在 `styles.css` 加一条让 label 看起来像按钮（参考现有 `button` 样式）。

`ResumeView.tsx`：在「简历模板」一节 `<TemplateList …/>` 之前放 `<ResumeParse onCreated={() => setListKey((k) => k + 1)} />`，并给 `TemplateList` 加 `key={listKey}`，让解析成功后模板列表重新读取（`ResumeView` 用 `useState` 持有 `listKey`）。

- [ ] **Step 3：跑测试**

Run: `npm run test:react && npm run typecheck && npm run build`，Expected: 全部通过。

- [ ] **Step 4：提交**

```bash
git add desktop/src/resume/ResumeParse.tsx desktop/src/resume/ResumeParse.test.tsx desktop/src/resume/ResumeView.tsx desktop/src/styles.css
git commit -m "feat(desktop): 简历页上传简历交给 AI 解析，发送前确认外发 (#130)"
```

---

### Task 6：文档与收尾

- [ ] **Step 1**：`docs/desktop-mvp/data-privacy.md` §8 桌面一列「内容」补：`简历解析：用户上传的简历全文（发送前显示发给哪个服务商、主机、模型与字数，用户点「发送并解析」才发出）`；「确认」补：`简历解析同样先确认再发送；可取消，取消不保证对方停止计费`。
- [ ] **Step 2**：`cd desktop && npm test` 全量；仓库根 `npm test`。
- [ ] **Step 3**：实机走查（需要人）：`npm run desktop:dev`，分别上传一份中文 PDF（含非嵌入字体的最好）、一份 .docx、一份 .txt；确认外发文案正确；解析成功生成「xx（AI 解析）」模板并设为当前；取消能取消；扫描版 PDF 给出扫描版提示；打包版（`npm run desktop:build`）里 PDF 解析同样可用（验证 CSP 与 cMap 路径）。结果写进 PR 描述。
- [ ] **Step 4**：提交文档，推送，开 PR（标题 `feat(desktop): 桌面简历解析 (#130 PR 2b)`），关联 `Refs #130`。PR 描述写明与拆分计划的偏差（复用插件 JS 而非移植 Rust）与 CSP 变更。

---

## 自检

- 覆盖拆分计划 PR 2 的「简历解析：前端抽文本，存为新模板并设为当前」；外发确认、取消、不重试按 data-privacy §8。
- 与插件行为一致之处都有锁死测试（两个 JS 副本、提示词）；有意差异：发送前多一步外发确认（插件没有），模板大小受桌面 24 KiB 上限约束（超出时存储层报「模板太大」）。
- `ai_complete::complete` 与 `ai_provider_commands::active_with_key` 供 PR 3 的 `ai.complete` 直接复用。
