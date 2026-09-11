# D02 / D04 / D06 integration

## D02: ownership

Host 持有一个 ArchiveStore。注入 `HostPaths::archive_dir` 与 `HostPaths::current_pointer`，不要将连接共享给 renderer，不创建第二个 writer。UI 通过业务方法调用。独立 crate 的 Cargo.lock 不改变公共 workspace 或 D02 锁文件。

## D04: manual flow

入口包括 create/get/update/list_application、append_event、recycle/purge、evidence、todo、suggestion。ApplicationDetail.summary 包含列表字段；列表在 SQL 内过滤/分页。组合写操作使用 StoreTx 并将任何失败向外返回以整体回滚。

## D05 / D06: adapter, not shared wire structs

本 crate 不依赖尚在修复的 protocol crate。**Rust DTO 是 D03 内部接口，不是 D05 wire JSON**：字段命名、Occurred 枚举、结果枚举、限额和认证由适配器显式转换；不要直接 serde 转发成 NM 应答。

1. D06 先使用 D05 校验完整信封、UUID、字节预算、来源权限及 wire payload 摘要。
2. 映射为 PluginOp，并将已验证的 wire payloadSha256 放入 PluginWriteContext.payload_sha256，保留协议原摘要用于历史对账。D03 另外计算并持久化带操作类型的 typed-operation 摘要；重放必须两个摘要都一致，防止同 wire 摘要对应不同映射操作。内部摘要不替换 wire 摘要、不要求修改 D05。`PluginOp::digest()` 仅是该内部表示的工具，示例用它模拟外部摘要，生产适配器仍需先验证真实 wire 摘要。
3. `submit_plugin_message` 在事务锁内核验 current/archive/source epoch，再查内部回执/墓碑，提交后返回 Committed/Replayed。不同 client 同 messageId 隔离。错误 code()/retryable() 可映射，但不自动创建新 messageId 重试。
4. `reconcile_lookup(envelope_identity, caller_client_id, items)` 限当前档案、有界批次、同调用 client；查询完整旧身份/内部摘要。结果只读，不授权旧 epoch 写入。

## Snapshot boundary (important)

**D08 起（schema v2）块字节进库。** `SnapshotChunkInput.bytes` 携带解码后的块字节（不参与 `PluginOp::digest()`，`chunk_sha256` 已钉住它们）。`op_snapshot_chunk` 先核对字节的 SHA-256 与长度，再把账本行、`snapshot_chunk_bytes` 行与回执放进 **同一个事务**。所以 `submit_plugin_message` 返回 Committed / Replayed 之后，`snapshot_progress().chunk_cursor` 就是真实落盘的连续游标——D06 桥接据此用 `DurableChunk::committed(...)` 构造分片 ACK。

`complete_snapshot_upload(client, snapshot)` 在一个事务里：按下标读回全部块 → 核对总长度与 `snapshotSha256` → 原子写 `snapshots/<snapshotId>.json`（临时名 → `sync_all` → rename）→ 从 v1 快照内容取模板名 → `finalize_snapshot_upload_with` 登记快照行、置 `full_acked`、删除该上传的暂存块字节。返回 `Incomplete` / `Completed` / `AlreadyComplete`；只有后两者之后才可发 `ackKind: snapshot`。失败整体回滚，块字节保留，下一次任一块重发会重试；上次失败留下的同名文件会被相同字节覆盖。

模板名 **不回写** `snapshot_uploads`：那两列参与每块的父身份比对，回写会让完整 ACK 丢失后的重发撞上 `conflict`。

`finalize_snapshot_upload(client, snapshot, rel_path)` 仍保留给「调用方自己写文件」的路径：要求完整账本、当前 epoch、绑定申请和真实档案内文件存在，重新核对整文件长度/总 SHA-256 并刷新文件后才登记完整快照，同样会清掉暂存块字节。外部文件一旦登记必须保持不可变。永久删除申请时连同暂存块字节一起删除。

恢复后旧 upload 不继续写；显式恢复/另存应由 D08/D12 制定新传输身份，不原地篡改旧来源 epoch。D12 应在关闭旧 Store 后处理新目录、验证及指针切换；完整备份期间的 DB/文件一致性屏障仍由唯一宿主与 D12 提供。

## Integration work left

- 对照 D05 最终 schema 编写显式适配器和共同向量，尤其是 wire 摘要验证、字段映射和快照 ACK。
- 接入 D02 宿主、D04 UI；本 PR 不修改另一 agent 的源码。
- 集成 PR 把本 crate 的 locked tests 加入 Windows/macOS CI。当前仓库根 Test CI 只测试插件，不能当成 D03 跨平台验收。
