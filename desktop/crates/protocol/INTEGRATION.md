# D03 / D06 / D07 集成差异（D05 不改数据层）

D05 不修改 `desktop/crates/archive-store/`。若 D03 实现时出现下列差异，在集成 PR 里对齐，不要回头改 D01 文档来迁就。

1. 回执主键必须能表达 `(clientInstanceId, messageId, sourceRestoreEpoch)`，另存 `payloadSha256`、`resultId`、purged 墓碑。不同 Profile（不同 `clientInstanceId`）的相同 `messageId` 不得串号。
2. 信封 `restoreEpoch` 与 `current.json` 的当前 epoch 比较是业务层，不是 schema。
3. `previously_purged` 用于普通写入命中墓碑；`outbox.reconcile` 的对应项状态是 `purged`。二者都不得返回可用 `resultId`。
4. `not_found` 只表示当前库没有回执，不表示从未执行，禁止自动重写。
5. 快照每块独立且持久化的 `chunkMessageId`（即该块信封 `messageId`）。D03 不应在重启后为同一 `(snapshotId, chunkIndex, sourceRestoreEpoch)` 新铸 ID。
6. `ChunkAssembler` 是 D05 参考实现：严格解码 Base64、核验解码长度与 `chunkSha256`、按 `chunkIndex` 组装后再核验总长度/`snapshotSha256`。`Integrity::VerifiedInMemory` 只表示内存内容完整，**不是**可发给插件的 `ackKind: snapshot`，也**不能**当作删除 IndexedDB 暂存的许可。D06 必须在 D03 确认落盘后才调用 `plugin_snapshot_ack_payload`，然后 `forget` 释放会话；取消或失败调用 `cancel`。活动会话仍受 `maxAssemblerSessions` 限制。持久化后重放走回执，不依赖永不释放的内存。损坏、缺块、越界、超限或冲突块不得污染已有有效会话。同 `messageId`、相同字节、不同逻辑块（snapshot/index/application/count/length/总哈希）为 `conflict`。
7. 通过 D05 结构校验 ≠ 允许写入；通过写入决定 ≠ 已持久化。D05 不能凭内存模型证明 D03 已落盘。
8. SaveIntent 不入库、不进 NM。
9. `payloadSha256`（非快照）是去掉该字段后、对象键按字典序排序的 compact UTF-8 JSON 的 SHA-256（不做额外 `\uXXXX` 转义）。`snapshot.chunk` 回执使用 `snapshot_chunk_identity_sha256`（不可变块元数据，不含 `bytesBase64`）。Rust 与 JS 必须得到同一摘要；D03 回执应保存 **D05 线上摘要**。若 D03 `PluginOp::digest()` 不同，适配器另存线上摘要。
10. `occurredAt` 为 UTC `Z` 子集：`YYYY-MM-DDTHH:MM:SSZ` 或带小数秒，必须是真实日历日期与时钟。JSON Schema 的 pattern 只做句法；日历合法性由 JS/Rust 校验器执行。D03 不要把非法日期存成业务时间。
11. URL 字段先校验、再算摘要。校验器发现凭据就拒绝，不清洗后继续用原摘要。
12. `fill.submit` 必须带 `outcome`。桌面不得猜测成功/部分/失败/取消。

## fill.submit → D03 FillSubmitInput

| D05 线上 | D03 | 说明 |
| --- | --- | --- |
| `applicationId` | `application_id` | 必填 |
| `outcome`：`started`/`completed`/`partial`/`failed`/`cancelled` | `FillOutcome` 同名 snake_case | 必填；映射到 `fill_*` 事件 |
| `fieldCount` / `filledCount` / `unconfirmedCount` | `field_count` / `filled_count` / `unconfirmed_count` | 可选，≥0 |
| `durationsMs.{scan,match,fill,total}` | `durations_ms` JSON | 可选毫秒 |
| `urlRedacted` | `url_redacted` | 可选；必须已脱敏 |
| `templateName` / `templateVersion` | `template_name` / `template_version` | 可选 |
| `snapshotId` + `sha256` | `snapshot_id`；内容哈希不是块身份摘要 | 必须成对出现；不含快照字节 |
| `pluginVersion` | `plugin_version` | 可选 |
| 信封 `occurredAt` | `occurred` | D06 从信封转换，不进 payload |
| 无逐字段值 | 无 | 默认不采集控件值 |

D03 内部的 `via`/`note`（submit.confirm）以及 FillSubmit 以外的计数器不要塞进 NM 信封。

## 已观察到的 D03 字段差异（只记录，不改 D03）

下列对照来自并行 worktree 中的 `archive-store`，供 D03/D06 集成 PR 对齐。本 PR 不修改该 crate。

| D05 线上字段 | D03 当前实现 | 处理 |
| --- | --- | --- |
| `snapshotSha256` | `snapshot_uploads.total_sha256` / `SnapshotChunkInput.total_sha256` | D06 映射，不要改协议名 |
| 块信封 `messageId` | `snapshot_chunks.chunk_message_id` | 同一 UUID；重启不得新铸 |
| `job.save` 的 `applicationId` | `JobSaveInput.target_application_id` | D06 映射 |
| `fill.submit` 线上 `outcome`/`fieldCount`/… | `FillSubmitInput` 同义内部字段 | D06 映射；不要把 D03 未公开字段塞回信封 |
| `submit.confirm` 载荷（`applicationId`） | `SubmitConfirmInput.via` / `note` | 同上，内部字段不进信封 |
| `payloadSha256`（去掉该字段后的排序 compact UTF-8 JSON） | `PluginOp::digest()` 哈希的是 D03 类型化枚举，不是 D05 载荷正文 | 回执必须另存 **D05 线上摘要**，否则重放会对不上 |
| `Integrity::VerifiedInMemory` | `snapshot_uploads.full_acked` | 后者才是持久化完成；前者不能当作 `ackKind: snapshot` |
| `previously_purged` 且 `ok:false` 不得带 `resultId` | `StoreError::PreviouslyPurged { former_result_id }` | D06 不得把 `former_result_id` 写进错误应答的 `resultId` |
