# Resume Pro 协议契约（D05）

机器可校验的插件—桌面通信契约：JSON Schema、分层校验入口、正反测试向量。

**不是** Native Messaging host，不注册浏览器，不监听端口，不打开 SQLite。

## 测试

在本目录：

```bash
cargo test --manifest-path Cargo.toml --locked
node --test js/catalog.test.mjs js/validate.test.mjs
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
| Snapshot integrity | 严格 Base64、块 SHA-256、按 index 组装后的总长度/`snapshotSha256`、连续 cursor、块数/大小/会话上限 | D05 `ChunkAssembler`：**内存完整性**，`VerifiedInMemory` ≠ 可发给插件的持久化 ACK |
| Snapshot durability | 块 `messageId` 落盘、重启不得新铸、确认持久化后再发 `ackKind: snapshot` | **D03/D06/D08** |
| Reconcile | 只读历史回执；`applied/purged/not_found/conflict/unverifiable`；不授予重放 | **D03** 查回执；`reconcile()` 是契约算法 |

SaveIntent 只存在于插件 `chrome.storage.local`，**不是** `messageType`。

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
// 仅当 outcome.ready_to_persist() 且 D03 落盘成功后，才发送 plugin_snapshot_ack_payload。
// 分片过程中只发 plugin_chunk_ack_payload（ackKind=chunk）。
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
checkCurrentIdentity(req, lastHandshake);
const bytes = new TextEncoder().encode(JSON.stringify(req));
if (bytes.length > MAX_ENVELOPE_BYTES) {
  throw new Error("payload_too_large");
}
```

发送普通写入前：若 `payload.sourceRestoreEpoch !== lastHandshake.restoreEpoch`，**不要**发 `job.save` / `fill.submit` / `snapshot.chunk` / `submit.confirm`，只发 `outbox.reconcile`。

## 错误码

`identity_missing` · `identity_not_allowed` · `restore_epoch_mismatch` · `protocol_incompatible` · `unknown_message_type` · `invalid_payload` · `payload_too_large` · `conflict` · `previously_purged` · `unavailable`（唯一默认 retryable）· `secret_forbidden`

`ok: true` 的写入应答必须有 `resultId`。`ok: false` 不得有 `resultId`。

`snapshot.chunk` 应答 `payload.ackKind`：`chunk` = 这一块已被接受（不可清 IDB）；`snapshot` = **下游已持久化**完整快照且总哈希相符。D05 组装器的 `VerifiedInMemory` 只表示可以交给 D03 落盘，不能当作删除 IndexedDB 的许可。`plugin_chunk_ack_payload` 永远是 `ackKind: chunk`。`chunkCursor` 只按从 0 起的连续已收块前进，不跳过缺块。

`occurredAt` 使用 UTC RFC3339 子集：`YYYY-MM-DDTHH:MM:SSZ` 或带小数秒，必须是真实日历日期与时钟，只允许 `Z`。Schema pattern 只约束句法；`2026-13-01` 一类非法日期由校验器拒绝。

`payloadSha256` 是去掉该字段后、对象键排序的 compact UTF-8 JSON 的 SHA-256。合法 fixture 必须使用真实匹配的字节、长度和摘要，不得用虚构哈希让测试通过。
