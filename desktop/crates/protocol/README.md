# Resume Pro 协议契约（D05）

机器可校验的插件—桌面通信契约：JSON Schema、分层校验入口、正反测试向量。

**不是** Native Messaging host，不注册浏览器，不监听端口，不打开 SQLite。

## 测试

在本目录：

```bash
cargo test --manifest-path Cargo.toml --locked
node --test js/catalog.test.mjs js/validate.test.mjs
python js/run-browser-catalog.py
```

浏览器入口是 `js/validate.mjs`（ES module，无 `node:` / `Buffer`）。SHA-256 使用 Web Crypto，因此 `validateRequest` / `validateRequestBytes` / `payloadBodySha256` 是 **async**。配套文件：`schema-data.mjs`（由 `js/embed-schemas.mjs` 从 JSON 生成）、`schema-lite.mjs`、`time.mjs`。D07 把这四个文件作为 MV3 `type=module` 加载即可，不需要打包器，也不要再 `import` Node 版加载器。

仓库根目录插件回归（确认本 crate 不影响插件）：

```bash
node --test tests/*.test.js
```

本 crate 使用自己的 `Cargo.lock`，不改根目录 workspace / 公共 CI。D02/D03 合入后如需把 `cargo test` 接到 Desktop CI，请另开集成 PR。

## 分层（schema 做不到的不要假装做过）

| 层 | 做什么 | 谁 |
| --- | --- | --- |
| Size | 完整 UTF-8 JSON 信封 ≤ 65536（不含 NM 4 字节前缀）。原始块大小 ≠ 信封大小 | D05 |
| Structure | 字段、枚举、UUID、SHA-256、白名单 `messageType`、分片上下界、对账批次 ≤ 32 | D05 schema + 校验器 |
| Identity presence | `health`/`handshake`/`ai.complete`/`ui.open` **禁止**信封 `archiveId`/`restoreEpoch`；其余 **必须**有。禁止用 current 回填 | D05 |
| Secrets | 拒绝 API Key/Cookie/Bearer 等键与值；拒绝未脱敏 URL（userinfo / token 查询参数） | D05 |
| Business identity | 信封是否等于 **当前** `current.json`；`sourceRestoreEpoch` 是否等于当前 epoch | **D03/D06**（`check_current_identity`） |
| Idempotency | `(clientInstanceId, messageId, sourceRestoreEpoch)` + 摘要 → 重放 / conflict / previously_purged | **D03** 回执表（`evaluate_write` 是契约算法） |
| Snapshot integrity | 严格 Base64、块 SHA-256、按 index 组装后的总长度/`snapshotSha256`、连续 cursor、块数/大小/会话上限 | D05 `ChunkAssembler`：**内存完整性**，`VerifiedInMemory` ≠ 可发给插件的持久化 ACK。完成后必须 `forget`/`cancel` |
| Snapshot durability | 块 `messageId` 落盘、重启不得新铸、确认持久化后再发 `ackKind: snapshot` | **D03/D06/D08** |
| Reconcile | 只读历史回执；`applied/purged/not_found/conflict/unverifiable`；不授予重放 | **D03** 查回执；`reconcile()` 是契约算法 |

SaveIntent 只存在于插件 `chrome.storage.local`，**不是** `messageType`。

## v2（#130）

`rules.json` 的支持范围是 v1–v2。原有八类消息在 v1、v2 信封里都可用；新增的五类消息只接受 `protocolVersion: 2`。旧插件的 `link/envelope.mjs` 仍发送 v1，桌面响应版本回显和新消息处理在 PR 3b 接入。

| 消息 | 请求与响应约定 |
| --- | --- |
| `resume.read` | 带档案身份、空请求；返回模板摘要、当前模板全文、档案和版本号。完整响应信封 ≤ 65536 UTF-8 字节。 |
| `resume.update` | 带档案身份；切换模板或用 `expectedRevision` 整份保存档案，版本冲突返回 `conflict`。不走 `message_receipts`。 |
| `ai.complete` | 不带档案身份；插件传提示词，桌面用当前服务商和凭据发出。上游失败以 `ok: true`、`payload.status: "failed"` 和固定 `reason` 枚举返回；不回传上游错误正文、完整 URL 或凭据。 |
| `ui.open` | 不带档案身份；打开 `resume`、`settings-ai` 或 `home`，成功响应 `opened: true`。 |
| `legacy.import` | 带档案身份；先发 `manifest`，再按 `index` 发模板、档案及 AI 配置分片，摘要须与清单一致；`status` 只查询。幂等键是 `(importId, index)` 和内容摘要，确认在桌面端进行。 |

`resume.update` 的 `setActiveTemplate` 必须带 `templateId`，不得带 `profile` 或 `expectedRevision`，重复切换到同一模板不会增加写入效果。`saveProfile` 必须带 `profile` 和 `expectedRevision`，不得带 `templateId`；它用版本比较防止同一请求重复写入，但成功回复丢失后重试可能返回 `conflict`，并不保证重放同一成功响应。插件收到 `conflict` 时应重新 `resume.read`，比较当前档案与拟保存内容，再决定是否重新发起保存。

`ai.complete` 失败响应里的 `httpStatus` 与 `host` 仅供插件诊断界面使用，不得转发给页面或内容脚本。`host` 只允许 ASCII 字母、数字、点和连字符，不含 scheme、端口、路径或 userinfo；不返回上游错误正文。

`ai.complete` 失败 `reason` 枚举含 `credential_unavailable`：凭据存放在系统密钥链，读取或写入失败与「未配置」是两件不同的事，值得插件区分提示。**PR 3b** 接线桌面业务逻辑时按下表映射（本 PR 只加枚举值与一条响应向量，不接线）：

| 桌面内部错误 | `ai.complete` `reason` |
| --- | --- |
| `AI_NOT_CONFIGURED` | `not_configured` |
| `CREDENTIAL_STORE_UNAVAILABLE` | `credential_unavailable` |
| `AI_SETTINGS_WRITE_FAILED`（设置写入/准备失败） | `credential_unavailable` |
| `AI_OUTPUT_TOO_LARGE` | `response_too_large` |
| `AI_HTTP_3xx`（连同 `httpStatus`） | `http` |

Secrets 仅对 `legacy.import` 且 `kind: "aiConfig"` 的 `body.apiKey` 开一个精确路径例外；其他位置仍拒绝。`body.apiUrl` 同样检查 URL 凭据参数与 userinfo。Key 的临时凭据库存放和 SQLite 排除由 PR 3b 实现。

`legacy.import` 清单中每片的 `sha256` 是**该片 `body` 本身**的摘要，不含 `kind`、`index` 或信封字段。算法与现有 `payloadSha256` 一致：对象键递归按字典序排列，序列化为无空白的 JSON，以 UTF-8 编码后计算 SHA-256，小写十六进制输出。`fixtures/requests/legacy-import-ok.json` 与 `legacy-import-template-ok.json` 固定了一组含中文内容的真实摘要，Rust/JS 均据此验算。

Secrets 扫描对对象键名采用子串匹配；含 `token`、`secret`、`otp` 等片段的键名即使值不含凭据也会被拒绝。这与 Rust 校验器既有口径相同，PR 3b 处理桌面数据时需考虑这一边界。
模板字段与档案自定义字段的 `{key, value}` 中，`key` 的字符串内容按**桌面存储层同一规则**扫描（`archive-store::resume_secrets::is_secret_label`，与插件 `profile-fields.js` 的 `SECRET_LABEL` 同一口径：`密码|口令|验证码|校验码|授权码|密钥|私钥|令牌|password|passwd|captcha|token|secret`，大小写不敏感），而不是上面对象键名用的完整禁用词表——两张表不同：既没有裸 `otp`/`cookie`/`authorization`/`apikey`，也没有 `secret`/`token` 之外的英文词，但含中文敏感词。所以 "Work Authorization"「Carbon Footprint 项目」（含 "otp"）「Hotpot 爱好」「Cookie 研究方向」这类字段名会被接受，"网银密码""GitHub Token" 会被拒绝；"密码学课程" 虽然是无害的课程名，但因为含子串「密码」，存储层 `is_secret_label` 一样会拒绝它，协议层与其保持一致。存储层能接受的字段名，协议层必须放行；存储层会剥离的，协议层也必须拒绝。真正的 JSON 对象键名仍按上面的完整禁用词表子串匹配，未变。

字段级 `maxLength` 不保证整条信封能放进 65536 字节；请求和响应仍以序列化后的完整 UTF-8 字节数为准，超限不截断。PR 4 的插件需在发送 `ai.complete` 前量字节数；PR 3b 的桌面需在返回 `resume.read` 或 AI 正文前量响应信封。`legacy.import` 的 `body` 形状由 Rust/JS 运行时根据 `kind` 选择本 schema 的 `$defs` 校验；只检查顶层 JSON Schema 不等于完成协议校验。

## D06 最小用法（Rust host）

```rust
use resume_pro_protocol::{
    check_current_identity, evaluate_write, validate_request_bytes, CurrentArchive,
};

let req = validate_request_bytes(&frame)?; // 通过校验 ≠ 允许写入
check_current_identity(&req, Some(&current))?;
match evaluate_write(&req, Some(&current), &receipts)? {
    WriteDecision::Accept => { /* D03 persist THEN ACK */ }
    WriteDecision::Replay { result_id } => { /* return original resultId */ }
    WriteDecision::PreviouslyPurged => { /* error previously_purged, no resultId */ }
    WriteDecision::Conflict => { /* error conflict */ }
}
// snapshot.chunk: ChunkAssembler::apply_chunk 只证明内存完整性。
// 每块 ACK 同样是落盘承诺：D03 提交该块并写下 chunkMessageId 之后，用它返回的
// 记录构造 DurableChunk::committed(...)，再发 plugin_chunk_ack_payload（ackKind=chunk）。
// 内存里的 outcome 构造不出 DurableChunk —— 插件会按分片 ACK 推进 chunkCursor，
// 若 ACK 了只存在内存里的块，桌面重启后插件会跳过它，快照永远凑不齐。
// 仅当 outcome.ready_to_persist() 且 D03 整份落盘成功后，才发送 plugin_snapshot_ack_payload，
// 然后 assembler.forget(...) 释放会话。失败或取消调用 cancel。
```

`outbox.reconcile` 走 `reconcile()`。返回 `applied` **不得**被当成可以重放旧信封。

校验**响应**时用 `validate_response_for_request(&value, &req)`，不要用 `validate_response_value`。后者看不到请求，只能确认 `correlationId` 是个 UUID、游标是非负整数；前者才会核对 `correlationId` 等于请求的 `messageId`，并把快照 ACK 的 `chunkIndex` / `chunkCursor` 限制在该请求声明的 `chunkCount` 之内。

Origin：`origin_allowed(origin, &allowed)`，禁止 `*`。

## D07 最小用法（插件 JS）

```js
import {
  validateRequest,
  validateResponseForRequest,
  checkCurrentIdentity,
  MAX_ENVELOPE_BYTES,
} from "../desktop/crates/protocol/js/validate.mjs";

const req = await validateRequest(envelope);
checkCurrentIdentity(req, lastHandshake);
const bytes = new TextEncoder().encode(JSON.stringify(req));
if (bytes.length > MAX_ENVELOPE_BYTES) {
  throw new Error("payload_too_large");
}

// 收到回复时带上原请求，`validateResponse` 看不到请求，无法把回复绑回它。
validateResponseForRequest(response, req);
```

发送普通写入前：若 `payload.sourceRestoreEpoch !== lastHandshake.restoreEpoch`，**不要**发 `job.save` / `fill.submit` / `snapshot.chunk` / `submit.confirm`，只发 `outbox.reconcile`。

## 错误码

`identity_missing` · `identity_not_allowed` · `restore_epoch_mismatch` · `protocol_incompatible` · `unknown_message_type` · `invalid_payload` · `payload_too_large` · `conflict` · `previously_purged` · `unavailable`（唯一默认 retryable）· `secret_forbidden`

`ok: true` 的写入应答必须有 `resultId`。`ok: false` 不得有 `resultId`。

`snapshot.chunk` 应答 `payload.ackKind`：`chunk` = **这一块已落盘**（但不可清 IDB，整份未确认）；`snapshot` = **下游已持久化**完整快照且总哈希相符。D05 组装器的 `VerifiedInMemory` 只表示可以交给 D03 落盘，不能当作删除 IndexedDB 的许可。`plugin_chunk_ack_payload` 永远是 `ackKind: chunk`。`chunkCursor` 只按从 0 起的连续已收块前进，不跳过缺块。

`occurredAt` 使用 UTC RFC3339 子集：`YYYY-MM-DDTHH:MM:SSZ` 或带小数秒，必须是真实日历日期与时钟，只允许 `Z`。Schema pattern 只约束句法；`2026-13-01` 一类非法日期由校验器拒绝。

`payloadSha256` 是去掉该字段后、对象键排序的 compact UTF-8 JSON 的 SHA-256。`snapshot.chunk` 回执摘要是不可变块身份（snapshot/index/application/count/length/hashes）的同一规范化摘要，不是单独的 `chunkSha256`。合法 fixture 必须使用真实匹配的字节、长度和摘要。

`sourceUrl` / `urlRedacted` 等 URL 字段默认拒绝 userinfo 与 `access_token`/`code`/`key` 等参数（含百分号编码名），且必须是 `https`。校验器不改写 payload；调用方必须先脱敏再计算摘要。`rules.json` 的 `urlAllowlist` 默认为空。

`aiConfig.apiUrl`（`legacy.import` kind `aiConfig` 的 `body.apiUrl`）不走上面这条通用 URL 规则：插件与桌面都允许局域网/本机代理（比如 Ollama）没有 TLS，所以它自己的检查接受 `http` 或 `https` 两种 scheme，但同样拒绝 userinfo 与凭据类查询参数（复用同一套 `SECRET_QUERY_KEYS` 逻辑）。scheme 既不是 `http` 也不是 `https`（比如 `ftp://`）时报 `invalid_payload`，因为这是负载结构问题，不是凭据泄漏；userinfo 或凭据查询参数仍报 `secret_forbidden`。
