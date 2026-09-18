# D14 既有覆盖与缺口清点

清点基线：`e453b3e`；T2 的新增映射见 [t2-business-regression.md](t2-business-regression.md)。表中“已有覆盖”指测试意图和代码入口已经存在；具体报告仍需在被测 commit 上实际运行并记录结果。

| D14 case | 已有覆盖（代表性文件/测试） | 当前判断 | T2/T3/T4/T5 缺口 |
| --- | --- | --- | --- |
| J01/F12 | `tests/link-session.test.js`、`link-envelope.test.js`、`link-transport.test.js`、`desktop/scripts/nm_browser_check.py`、`desktop/src-tauri/tests/nm_host.rs` | PARTIAL | D13 安装产物、生产注册、Chrome 与 Edge 各一次、普通账户、空格/中文安装路径 |
| J02/F01/F02 | 既有 link 测试；T2 `offline job and v1 fill...` | STRONG_PARTIAL | T2 已把离线岗位、填充、v1 快照、ACK 和上线绑定串成一条 `d14-v1` 回归；仍需正式插件 ZIP/安装 host 复验，F02 的配额/索引故障归 T3 |
| J03 | 既有 fill/outbox 测试；T2 `offline job and v1 fill...` | STRONG_PARTIAL | T2 已证明填写后仍为 `saved`、明确确认才产生一次投递事件、v1 快照不随 v2 改动；仍缺实装时间线证据 |
| J04/J05/F09/F10 | 既有 AI/命令层测试；T2 的 AI extract、review logic、archive-store 回归 | STRONG_PARTIAL | T2 已固定 `d14-v1` 通知映射、多岗位消歧、确认前不改正式字段、修改后确认/待办、幂等、ATS automated 和历史补录不回退；暂存跨重启、错误响应统计与故障矩阵归 T3，真实 UI/服务走查归 T4/T5 |
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

## T2 之后、T3 开工前的剩余映射

1. T2 的新增测试已按精确测试名映射；T3 继续为复用的既有故障测试补精确测试名，避免用整个文件“概括通过”。
2. 对 F03、F04、F07、F08、F10、F11 建立明确缺口测试；F13 只做调度逻辑自动化仍不够。
3. 建立 T4/T5 运行脚本时复用现有浏览器脚本的检查函数，但禁止使用开发 probe 扩展或开发注册结果作为 J01 的最终证据。
