# Resume Pro 协议契约（D05）

机器可校验的插件—桌面通信契约：JSON Schema、分层校验入口、正反测试向量。

**不是** Native Messaging host，不注册浏览器，不监听端口，不打开 SQLite。

## 测试

在本目录：

```bash
cargo test --manifest-path Cargo.toml --locked
node --test js/validate.test.mjs
```

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
| Identity presence | `health`/`handshake` **禁止**信封 `archiveId`/`restoreEpoch`；其余 **必须**有。禁止用 current 回填 | D05 |
| Secrets | 拒绝 API Key/Cookie/Bearer 等键与值 | D05 |
| Business identity | 信封是否等于 **当前** `current.json`；`sourceRestoreEpoch` 是否等于当前 epoch | **D03/D06**（`check_current_identity`） |
| Idempotency | `(clientInstanceId, messageId, sourceRestoreEpoch)` + 摘要 → 重放 / conflict / previously_purged | **D03** 回执表（`evaluate_write` 是契约算法） |
| Snapshot durability | 块 `messageId` 持久化、重启不得新铸、cursor 连续、分片 ACK ≠ 完整 ACK | **D03/D08** 持久化；`ChunkAssembler` 是语义夹具 |
| Reconcile | 只读历史回执；`applied/purged/not_found/conflict/unverifiable`；不授予重放 | **D03** 查回执；`reconcile()` 是契约算法 |

SaveIntent 只存在于插件 `chrome.storage.local`，**不是** `messageType`。

## D06 最小用法（Rust host）

```rust
use resume_pro_protocol::{
    check_current_identity, evaluate_write, validate_request_bytes, CurrentArchive,
};

let req = validate_request_bytes(&frame)?;
check_current_identity(&req, Some(&current))?;
match evaluate_write(&req, Some(&current), &receipts)? {
    WriteDecision::Accept => { /* persist then ACK */ }
    WriteDecision::Replay { result_id } => { /* return original resultId */ }
    WriteDecision::PreviouslyPurged => { /* error previously_purged, no resultId */ }
    WriteDecision::Conflict => { /* error conflict */ }
}
```

`outbox.reconcile` 走 `reconcile()`。返回 `applied` **不得**被当成可以重放旧信封。

Origin：`origin_allowed(origin, &allowed)`，禁止 `*`。

## D07 最小用法（插件 JS）

```js
import {
  validateRequest,
  checkCurrentIdentity,
  MAX_ENVELOPE_BYTES,
} from "../desktop/crates/protocol/js/validate.mjs";

const req = validateRequest(envelope);
if (req.messageType === "SaveIntent") throw new Error("not a native message");
checkCurrentIdentity(req, lastHandshake);
if (Buffer.byteLength(JSON.stringify(req), "utf8") > MAX_ENVELOPE_BYTES) {
  throw new Error("payload_too_large");
}
```

发送普通写入前：若 `payload.sourceRestoreEpoch !== lastHandshake.restoreEpoch`，**不要**发 `job.save` / `fill.submit` / `snapshot.chunk` / `submit.confirm`，只发 `outbox.reconcile`。

## 错误码

`identity_missing` · `identity_not_allowed` · `restore_epoch_mismatch` · `protocol_incompatible` · `unknown_message_type` · `invalid_payload` · `payload_too_large` · `conflict` · `previously_purged` · `unavailable`（唯一默认 retryable）· `secret_forbidden`

`ok: true` 的写入应答必须有 `resultId`。`ok: false` 不得有 `resultId`。

`snapshot.chunk` 应答 `payload.ackKind`：`chunk`（块已持久化，不可清 IDB）或 `snapshot`（全部到齐且总哈希相符）。`chunkCursor` 只按从 0 起的连续 ACK 前进。
