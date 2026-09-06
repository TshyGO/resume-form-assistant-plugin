# D03: archive-store

独立 Rust/SQLite 数据层，可在没有 GUI、浏览器或 AI 的情况下运行。路径由调用方注入；不修改 D02/D05，不注册 Native Messaging，不启动第二个后台服务。

## 运行与测试

在仓库根目录（Windows 已用 Rust 1.94.0 实测）：

```sh
cargo test --manifest-path desktop/crates/archive-store/Cargo.toml --locked
cargo run --manifest-path desktop/crates/archive-store/Cargo.toml --locked --example persistence_loop
cargo fmt --manifest-path desktop/crates/archive-store/Cargo.toml -- --check
```

示例实际创建 SQLite、写申请与投递事件、关闭并重开，再断言阶段和事件仍在。默认使用隔离临时目录并清理；如传入**绝对路径**，则保留合成数据，连续两次运行可观察 existingApplications 递增。不要对真实资料目录运行演示。

## 存储与事务

`ArchiveStore::open(ArchiveConfig::new(archive_dir, current_pointer))` 接收绝对路径。它持有档案锁和指针锁、单个 Mutex 连接，WAL + synchronous=FULL；配合 D02 宿主保持一个逻辑写入者。第二 Store 打开同一档案/指针失败，不另开写入服务。关闭后可重开。

普通方法使用事务；批量操作用 `store.transaction(|tx| ...)`。闭包中不要重入 store 方法，调用 tx；遇到业务错误应向外返回 Err，不能吞掉错误后提交。阶段投影、序号、事件和回执同事务。历史补录不回退当前进度，纠正需匹配原阶段并提供原因。

| 表族 | 关系与用途 |
| --- | --- |
| applications / events | 一份申请有有序事件；UUID 不是公司/URL 去重键，eventSequence 是排序依据 |
| reply_evidence / attachment_blobs | 证据可未关联；多个证据引用一个不可变 blob，引用计数决定释放资格 |
| ai_suggestions / todos | 建议保留原分类及批准值；确认事务更新证据/事件/待办，重复确认不重复写 |
| message_receipts | 历史来源 epoch、摘要、结果和最小删除墓碑；旧请求不复活数据 |
| snapshot_uploads / snapshot_chunks / resume_snapshots | 分片**元数据账本**与完整文件登记，不存字节，不替代 D08 文件传输 |
| archive_meta / schema_migrations | schema v1、迁移历史；完整 SQL 见 src/schema.rs |

所有待执行迁移、迁移记录和 user_version 在一次事务内提交；旧库迁移前用 SQLite backup API 生成唯一备份。任一步失败不留下前面步骤的半迁移。新版本库拒绝降级；未知无版本旧库不猜测迁移。迁移备份只有 DB，不是 D12 的完整附件备份。

`meta.json` 的 archiveId 必须与库一致；当前指针身份单独保存。`rotate_restore_epoch()` 与数据事务串行，先成功写入原子指针才更新内存；不实现 D12 完整恢复向导。外部改变指针时旧 Store 拒绝继续业务事务，必须关闭重开。

## 边界与安全

- 数据层不发送网络请求，不产生日志；例子只使用合成数据。
- source URL 使用 URL parser 清洗，默认剥离 code/key/token 及编码后的参数名；保留路径和岗位值大小写。
- 任意 JSON 扩展字段拒绝秘密类键；这不是任意自然语言正文的秘密识别器，导入/外发层仍须执行隐私策略。
- 附件路径限档案内相对路径。`check_attachment_refs()` 检查数据库引用和实际文件长度/摘要，报告缺失/损坏；不修复或删除文件。
- purge 只删业务行、保留回执墓碑，不删磁盘附件，返回释放的 blob ID 给 D09/D12。共享引用不会提前释放。
- 此阶段没有 UI、邮箱、OCR、系统提醒、NM 帧或正式备份系统。尚未做 macOS 实机运行或 D02/D05 集成。

详细接入边界见 [INTEGRATION.md](INTEGRATION.md)。
