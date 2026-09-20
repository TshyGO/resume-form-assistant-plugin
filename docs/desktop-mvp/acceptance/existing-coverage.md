# D14 既有覆盖与缺口清点

当前自动化基线：`origin/main` 的 `1392579`；T2 映射见 [t2-business-regression.md](t2-business-regression.md)，T3 精确故障映射见 [t3-fault-matrix.md](t3-fault-matrix.md)。具体候选报告仍需记录被测 commit、运行链接和实机证据。

| D14 case | 已有覆盖（代表性文件/测试） | 当前判断 | T2/T3/T4/T5 缺口 |
| --- | --- | --- | --- |
| J01/F12 | `tests/link-session.test.js`、`link-envelope.test.js`、`link-transport.test.js`、`desktop/scripts/nm_browser_check.py`、`desktop/src-tauri/tests/nm_host.rs` | PARTIAL | D13 安装产物、生产注册、Chrome 与 Edge 各一次、普通账户、空格/中文安装路径 |
| J02/F01/F02 | T2 业务回归；T3 精确 link/IDB 映射 | STRONG_PARTIAL | 离线岗位、v1 快照、ACK 丢失、索引修复、配额/字节丢失均有确定性自动化；仍需正式插件 ZIP/安装 host 复验 |
| J03 | 既有 fill/outbox 测试；T2 `offline job and v1 fill...` | STRONG_PARTIAL | T2 已证明填写后仍为 `saved`、明确确认才产生一次投递事件、v1 快照不随 v2 改动；仍缺实装时间线证据 |
| J04/J05/F09/F10 | T2 业务回归；T3 `d14-v1` 非法响应与真实日期校验 | STRONG_PARTIAL | 固定响应、多岗位消歧、正式字段保护、幂等、ATS automated、历史补录、非法 JSON/枚举/候选/日期均有确定性自动化；真实 UI/选定服务走查归 T4/T5 |
| J06/F05/F06/F08 | T3 restore/reconcile/archive/hostile ZIP 精确映射 | STRONG_PARTIAL | 重复恢复、epoch、Profile 隔离、事件顺序、损坏包和路径穿越均有自动化；真实磁盘满和已安装插件对账仍缺 |
| J07 | D13 拆分计划；迁移/恢复相关 Rust 测试 | GAP_AT_INSTALL_LAYER | 可追溯旧候选、实际升级/卸载/重装、安装器注册清理和数据保留 |
| J08 | `link-intents.test.js`、`link-degradation.test.js`、插件填写回归 | PARTIAL | 实际卸载桌面后的 Chrome/Edge 填写；卸载残留对结果的影响 |
| F03/F04 | T3 精确映射 archive-store 事务回滚、墓碑与 link purged 对账 | AUTOMATED | 数据层确定性自动化完成；不再用文件级概括代替测试名 |
| F07 | 备份数据库快照、计数门禁、失败保留旧包 | AUTOMATED | 快照后引用文件消失会拒绝发布残包 |
| F11 | `d14-v1` 标记贯穿 URL、快照、wire/storage、预览路径和发布包扫描 | AUTOMATED | 全部合成禁采标记和发布 ZIP 文件边界已有自动化 |
| F13 | reminders crate 的 planning/平台测试 | GAP_AT_REAL_OS | 杀进程、跨次日、休眠、重启、主动退出的真实 Windows 证据；按最终支持范围补 macOS |

## 已确认可直接复用的断言

- 离线保存显示为 pending，且从未配对/未安装不建长期队列：`tests/link-intents.test.js`、`tests/link-copy.test.js`。
- 消息身份、档案身份、重试和恢复对账：`tests/link-envelope.test.js`、`tests/link-outbox.test.js`、`tests/link-reconcile.test.js`。
- 快照确定性、2 MiB 上限、32 KiB 分片和禁采字段：`tests/link-snapshot.test.js`。
- 完整 ACK 丢失、分片 gap、SW 重启、模板变化仍发送原字节：`tests/link-uploads.test.js`。
- 已恢复档案中的旧消息需要人工决定，不能自动重写：`tests/link-reconcile.test.js`、`tests/link-reconcile-snapshot.test.js`。
- AI 审核中多候选需选择、更新进度默认关闭、引用可展开、确认入参可修改：`desktop/src/ai/ReviewPanel.test.tsx`、`review.test.ts`。
- AI 取消、失败、暂存入口与正式记录保护：`desktop/src/ai/AiReview.test.tsx` 与后端命令测试。

## T3 之后的剩余高层证据

1. T4/T5 运行脚本可复用现有浏览器脚本的检查函数，但禁止使用开发 probe 扩展或开发注册结果作为 J01 的最终证据。
2. F08 需要隔离卷上的真实磁盘满；F13 需要杀进程、跨次日、休眠、重启和主动退出的真实 Windows 证据。
3. `src-tauri` 映射测试需 Windows MSVC CI 复核；本机 GNU 只完成编译，不能将启动失败写成测试通过。
