# D14 既有覆盖与缺口清点

清点基线：`e453b3e`。表中“已有覆盖”指测试意图和代码入口已经存在；T2/T3 仍需在各自实现 commit 上实际运行并记录结果。

| D14 case | 已有覆盖（代表性文件/测试） | 当前判断 | T2/T3/T4/T5 缺口 |
| --- | --- | --- | --- |
| J01/F12 | `tests/link-session.test.js`、`link-envelope.test.js`、`link-transport.test.js`、`desktop/scripts/nm_browser_check.py`、`desktop/src-tauri/tests/nm_host.rs` | PARTIAL | D13 安装产物、生产注册、Chrome 与 Edge 各一次、普通账户、空格/中文安装路径 |
| J02/F01/F02 | `link-intents.test.js`、`link-fill-submit.test.js`、`link-snapshot.test.js`、`link-staging.test.js`、`link-uploads.test.js`、`link-reconcile-snapshot.test.js`、`d08_browser_check.py` | STRONG_PARTIAL | 用正式插件 ZIP 和安装 host 复验；补真实配额/索引损坏入口的证据 |
| J03 | `link-degradation.test.js`、`link-outbox.test.js`、`link-fillrecords.test.js`、`link-fill-submit.test.js` | PARTIAL | 同一实装旅程的时间线、事件序号和 v1/v2 快照证明 |
| J04/J05/F09/F10 | `desktop/src/ai/*.test.ts(x)`、`desktop/src-tauri/src/ai_commands_tests.rs`、`desktop/crates/ai-extract/`、`commands_regression.rs` | PARTIAL | 固定 `d14-v1` 通知集映射；暂存跨重启；完整 AI 统计；真实 UI 旅程及选定服务一次走查 |
| J06/F05/F06/F08 | `tests/link-reconcile*.test.js`、`desktop/src-tauri/src/restore_tests.rs`、`desktop/crates/backup/tests/`、`desktop/crates/archive-store/tests/` | PARTIAL | 重复恢复同一备份的统一场景；旧 Profile 同 messageId；真实磁盘满；已安装插件对账 |
| J07 | D13 拆分计划；迁移/恢复相关 Rust 测试 | GAP_AT_INSTALL_LAYER | 可追溯旧候选、实际升级/卸载/重装、安装器注册清理和数据保留 |
| J08 | `link-intents.test.js`、`link-degradation.test.js`、插件填写回归 | PARTIAL | 实际卸载桌面后的 Chrome/Edge 填写；卸载残留对结果的影响 |
| F03/F04 | archive-store 幂等、事务与回执测试；`link-outbox.test.js` 重传 | PARTIAL | 明确映射事务故障点；ACK 丢失→永久删除→原消息重试的完整墓碑反例 |
| F07 | `desktop/crates/backup/tests/writing.rs`、`hostile.rs` | PARTIAL | 备份屏障内并发删除附件的确定性测试及引用完整性断言 |
| F11 | `link-privacy-d08.test.js`、`link-redact.test.js`、snapshot 禁采测试、backup exclude/hostile 测试、release allowlist | STRONG_PARTIAL | 将 `d14-v1` 全部标记贯穿请求、日志、备份和候选包扫描；导入取消后的路径持久化断言 |
| F13 | reminders crate 的 planning/平台测试 | GAP_AT_REAL_OS | 杀进程、跨次日、休眠、重启、主动退出的真实 Windows 证据；按最终支持范围补 macOS |

## 已确认可直接复用的断言

- 离线保存显示为 pending，且从未配对/未安装不建长期队列：`tests/link-intents.test.js`、`tests/link-copy.test.js`。
- 消息身份、档案身份、重试和恢复对账：`tests/link-envelope.test.js`、`tests/link-outbox.test.js`、`tests/link-reconcile.test.js`。
- 快照确定性、2 MiB 上限、32 KiB 分片和禁采字段：`tests/link-snapshot.test.js`。
- 完整 ACK 丢失、分片 gap、SW 重启、模板变化仍发送原字节：`tests/link-uploads.test.js`。
- 已恢复档案中的旧消息需要人工决定，不能自动重写：`tests/link-reconcile.test.js`、`tests/link-reconcile-snapshot.test.js`。
- AI 审核中多候选需选择、更新进度默认关闭、引用可展开、确认入参可修改：`desktop/src/ai/ReviewPanel.test.tsx`、`review.test.ts`。
- AI 取消、失败、暂存入口与正式记录保护：`desktop/src/ai/AiReview.test.tsx` 与后端命令测试。

## T2/T3 开工前要补的映射

1. 将每条既有测试按测试名映射到一个或多个 case 断言，避免用整个文件“概括通过”。
2. 将 `d14-v1` 的逻辑 ID 适配到现有 JS/Rust fixtures；不能为了复用测试而改变业务预期。
3. 对 F03、F04、F07、F08、F10、F11 建立明确缺口测试；F13 只做调度逻辑自动化仍不够。
4. 建立 T4/T5 运行脚本时复用现有浏览器脚本的检查函数，但禁止使用开发 probe 扩展或开发注册结果作为 J01 的最终证据。
