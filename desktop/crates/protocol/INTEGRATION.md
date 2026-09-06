# D03 / D06 / D07 集成差异（D05 不改数据层）

D05 不修改 `desktop/crates/archive-store/`。若 D03 实现时出现下列差异，在集成 PR 里对齐，不要回头改 D01 文档来迁就。

1. 回执主键必须能表达 `(clientInstanceId, messageId, sourceRestoreEpoch)`，另存 `payloadSha256`、`resultId`、purged 墓碑。不同 Profile（不同 `clientInstanceId`）的相同 `messageId` 不得串号。
2. 信封 `restoreEpoch` 与 `current.json` 的当前 epoch 比较是业务层，不是 schema。
3. `previously_purged` 用于普通写入命中墓碑；`outbox.reconcile` 的对应项状态是 `purged`。二者都不得返回可用 `resultId`。
4. `not_found` 只表示当前库没有回执，不表示从未执行，禁止自动重写。
5. 快照每块独立且持久化的 `chunkMessageId`（即该块信封 `messageId`）。D03 不应在重启后为同一 `(snapshotId, chunkIndex, sourceRestoreEpoch)` 新铸 ID。
6. SaveIntent 不入库、不进 NM。
