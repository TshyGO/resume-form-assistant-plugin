# Resume Pro 桌面求职管理 MVP — 设计文档索引

| 字段 | 值 |
| --- | --- |
| 标题 | 桌面求职管理 MVP 设计基线 |
| 作者 | D01 design PR |
| 日期 | 2026-09-06 |
| 状态 | Draft / Ready for review（**未冻结**；负责人确认前下游只做可丢弃原型） |
| Issue | [D01 #17](https://github.com/TshyGO/resume-form-assistant-plugin/issues/17) |
| Epic | [#15](https://github.com/TshyGO/resume-form-assistant-plugin/issues/15) |

本文档集是 Epic #15 的 **P0 设计基线**。D01 **只产出设计决策**，不实现桌面应用、SQLite 迁移、Native Messaging host、协议 JSON Schema、安装器或插件功能变更。当前插件仍为 Manifest V3 `0.3.0`，权限与填写行为保持不变。

负责人在本 PR / #17 上确认关键决策之前，**不得宣称架构已冻结**。下游只允许可丢弃原型，不得把本目录当作已批准的实现接口。

## 如何阅读

按角色选择入口，不必按文件顺序通读：

1. **产品 / 负责人**：先读本页「关键决策快照」和 [需要负责人选择的项](downstream-decisions.md#4-需要项目负责人选择)，再读 [产品需求](product-requirements.md) 的目标用户、产品规则、阶段模型、离线意图/绑定，以及合成走查。
2. **D02 / D06 / D13（壳、进程、安装）**：读 [架构 ADR](adr-architecture.md) 的技术选型、**进程角色**（不是「两个 EXE」契约）、跨平台适配边界、安装与仓库布局。D02 起必须做 **macOS 原型**，不能等 Windows 全做完再移植。
3. **D03 / D04 / D08 / D09 / D10（数据与界面）**：读 [产品需求](product-requirements.md) 的对象关系、字段目录、`restoreEpoch`、提醒语义和走查；物理 schema 仍归 D03。
4. **D05 / D07（协议与插件连接）**：读 ADR 的协议原则，产品需求的 **保存意图 vs 已绑定业务消息**，以及 [数据与隐私](data-privacy.md) 的快照暂存 / 密钥规则。不要在 D01 寻找完整 JSON Schema。
5. **D11 / D12 / D14（AI、备份、首发）**：读 [数据与隐私](data-privacy.md) 与 [下游映射](downstream-decisions.md)。

文档互相链接。稳定标识符（stage code、协议字段、crate 名、进程角色名）保持英文；正文为中文。平台无关契约不写 `*.exe`。

## 文档清单

| 文档 | 内容 | 主要消费者 |
| --- | --- | --- |
| [product-requirements.md](product-requirements.md) | MVP 产品规则、阶段、离线意图/绑定、快照暂存、提醒语义、字段目录、合成走查 | D03–D04、D07–D11、D14 |
| [adr-architecture.md](adr-architecture.md) | Tauri 2 选型、进程角色、跨平台适配、协议原则、安装形态 | D02、D05、D06、D13 |
| [data-privacy.md](data-privacy.md) | 数据归属、目录、敏感分级、IndexedDB 暂存、备份恢复、密钥 | D03、D08、D11、D12、D13 |
| [downstream-decisions.md](downstream-decisions.md) | D02–D14 消费清单、定案/待选/待验证、依赖图 | 全部下游 |

现有插件文档 [../ai-repeat-validation.md](../ai-repeat-validation.md) **不在本次修改范围**，仍是 v0.3.0 填写/辅助新增的验证记录。

仓库根目录的 [`LICENSE`](../../LICENSE) 是 **当前插件** 的 MIT 许可。后续桌面模块的产品许可 **尚未定案**，不得把现有 MIT 写成未来所有模块的既定承诺。

## 现状（以仓库代码为准，不以 README 宣传为准）

以下事实来自当前仓库，D01 不得改动这些运行时文件：

| 事实 | 来源 |
| --- | --- |
| Manifest V3，`version` `0.3.0`，`minimum_chrome_version` `116` | [`manifest.json`](../../manifest.json) |
| 权限：`offscreen`、`storage`、`scripting`、`activeTab`、`tabs`；`host_permissions`：`<all_urls>` | 同上 |
| **没有** `nativeMessaging` 权限；**没有** extension `key` | 同上；未打包扩展 ID 由加载路径哈希派生，移动目录会变 |
| 模板、`activeTemplateId`、`aiConfig`（`apiUrl` / `model` / `apiKey` 明文）存在 `chrome.storage.local` | [`content.js`](../../content.js) `STORAGE_KEYS`；[`popup.js`](../../popup.js) `DEFAULT_STORE` |
| Service worker 今天 = `chrome.action.onClicked` → `TOGGLE_MANAGER` **加上** `ENSURE_AI_HOST`（offscreen.createDocument）。**没有** NM | [`background.js`](../../background.js)；D07 增加 NM 时不得覆盖 `onClicked` |
| AI 请求走 offscreen `ai-host.html` + `ai-worker.js`，不在 service worker 里等响应 | [`ai-host.js`](../../ai-host.js) |
| `chrome.storage.local` 另有 `resumeProUpdateCache` / `resumeProDismissedVersion`（更新检查）。D07 outbox / 意图队列不得占用这些 key | [`popup.js`](../../popup.js) |
| 填写由用户点击触发；`form-agent.js` 仅在确认后点击安全的「新增/添加」按钮；不提交表单 | [`form-agent.js`](../../form-agent.js) `isSafeButton` / `execute` |
| 今天不存在求职档案、填写事件日志或桌面连接 | 全仓库无 `sendNativeMessage` / 申请对象 |
| 以 ZIP 解压后在 Chrome/Edge 加载已解压扩展 | [`README.md`](../../README.md) |

仓库根目录 **没有** `AGENTS.md` / `Claude.md`。

## 关键决策快照

下列为本次 **建议**，**等负责人在 #17 / 本 PR 确认后才可冻结**。理由与备选见各专文。

| # | 决策 | 一句话 |
| --- | --- | --- |
| 1 | 平台 | **Windows 与 macOS 都是目标平台**。实现可 Windows 优先，但 D02 起必须做 Mac 原型。Linux 仍非首版产品。浏览器首阶段仍是 Chrome/Edge，**不默认承诺 Safari** |
| 2 | 桌面栈 | **推荐 Tauri 2**（团队成本、体积、原生集成、跨平台维护）。Electron 可做同等产品，不是「必须管理员」或「不能做 stdio」 |
| 3 | 进程角色 | **应用进程 = 唯一写入者**；**NM host 进程 = 翻译器**（浏览器可拉起多个实例）；WebView/WKWebView 子进程不是写入者。平台无关契约不写 `*.exe` |
| 4 | 权威源 | **桌面档案是申请数据的 source of truth**；插件模板与填写在未装桌面时仍独立可用 |
| 5 | 默认阶段 | 插件保存岗位 → `saved`（已收藏），**不是** `submitted`。插件「确认已投递」归 **D07** |
| 6 | 身份 | 申请 UUID；两层候选（精确三元组 / 同公司提示）；**禁止**自动合并 |
| 7 | 离线保存 | 区分 **保存意图**（已确认要存、尚未绑定申请）与 **已绑定业务消息**。曾经配对但桌面暂不可用：可持久化意图并显示「待同步」，**不得**显示「桌面已保存」。未安装/从未配对：不建长期队列 |
| 8 | 快照 | 确认留档时立即生成不可变字节；无论桌面是否在线，发送前完整字节先提交到 **扩展源 IndexedDB**，完整提交/哈希 ACK 前保留，元数据进 `chrome.storage.local`。重试不得从最新模板重生成 |
| 9 | 协议 | 握手后写入与 `outbox.reconcile` **必须**在信封携带当前 `archiveId`/`restoreEpoch`；health/handshake 禁止携带。分片每块独立持久化 `messageId`。64 KiB 指完整 UTF-8 JSON |
| 10 | 配对 | **D01 不加 `key`**。桌面 UI **粘贴扩展 ID**；**第一条 NM 不是配对消息** |
| 11 | 恢复隔离 | 备份保留 `archiveId`；每次成功切换 current 指针 **新铸 `restoreEpoch`（UUID）**，不从备份恢复当前身份；历史回执可含 sourceRestoreEpoch，不按 backup.generation+1。旧队列盖章对不上则暂停 |
| 12 | 提醒 | 关窗 ≠ 退出。启用后台提醒时走 **用户授权的系统调度通知**，不把进程闲置包装成次日提醒。不偷偷开机启动。主动退出须展示能力限制 |
| 13 | 通知语义 | `replyClass` ≠ `sendMode`。已导入未分类 = `imported_unclassified`，禁止显示「尚未导入」。面试邀请不得写成「人工回复」 |
| 18 | 事件顺序 | 每申请单调 `eventSequence` 与写入同事务；`recordedAt` 不做折叠键 |
| 14 | 密钥 | 插件 Key 留在扩展存储；桌面 Key 进 OS 凭据库（Windows Credential Manager / DPAPI，macOS Keychain）；二者都不进档案/备份/日志 |
| 15 | 备份 | MVP **不加密**；导出警告含 PII |
| 16 | 填写留档 | 默认只存事件元数据；逐字段值默认关闭；快照 ≤ 2 MiB |
| 17 | 交付物 | Windows：NSIS per-user 安装包。macOS：`.app` / `.dmg`。正式版是否必须双平台同时交付 → [开放问题](downstream-decisions.md#4-需要项目负责人选择) |

未确认项见 [需要项目负责人选择](downstream-decisions.md#4-需要项目负责人选择)。原型验证项见 [需要后续原型验证](downstream-decisions.md#5-需要后续原型验证)。

## 开放问题入口

只把真正需要负责人拍板的问题放在 [downstream-decisions.md](downstream-decisions.md#4-需要项目负责人选择)。当前建议的负责人选择集：

1. 首个对外「正式桌面 MVP」是否必须 Windows + macOS 同时交付
2. Tauri 2 vs Electron
3. 后台提醒：系统调度通知 vs 常驻进程
4. 备份不加密 vs 加密
5. Windows 是否另发 MSI（macOS 仍是 `.dmg`）

配对方式、64 KiB 信封、填写留档默认仅元数据：本次作为 **建议定案** 写入正文，不再占用拍板名额；否决时仍按「先改 D01 再动下游」处理。

## 本 D01 的交付与非交付

**交付：** 本目录五份中文设计文档（含本索引），以及同步后的相关 GitHub issue 正文。文档 PR 即 D01 的全部实现。

**明确不交付：** `/desktop` 源码树、crate 脚手架、SQLite `CREATE TABLE`、协议 JSON Schema、Native Messaging 注册、安装器、Tauri/Electron 安装、真实 AI 调用、邮箱连接、插件权限/版本变更、合并、关闭 #17、宣称架构已冻结。

下游任务编号与 GitHub issue 对照见 [downstream-decisions.md](downstream-decisions.md#2-d02d14-消费映射)。
