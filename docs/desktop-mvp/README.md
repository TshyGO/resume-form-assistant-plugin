# Resume Pro 桌面求职管理 MVP — 设计文档索引

| 字段 | 值 |
| --- | --- |
| 标题 | 桌面求职管理 MVP 设计基线 |
| 作者 | D01 design PR |
| 日期 | 2026-09-06 |
| 状态 | Draft / Ready for review |
| Issue | [D01 #17](https://github.com/TshyGO/resume-form-assistant-plugin/issues/17) |
| Epic | [#15](https://github.com/TshyGO/resume-form-assistant-plugin/issues/15) |

本文档集是 Epic #15 的 **P0 设计冻结** 产物。D01 **只产出设计决策**，不实现桌面应用、SQLite 迁移、Native Messaging host、协议 JSON Schema、安装器或插件功能变更。当前插件仍为 Manifest V3 `0.3.0`，权限与填写行为保持不变。

负责人在本 PR / #17 上确认关键决策之前，下游只允许可丢弃原型，不得冻结实现接口。

## 如何阅读

按角色选择入口，不必按文件顺序通读：

1. **产品 / 负责人**：先读本页「关键决策快照」和 [需要负责人选择的项](downstream-decisions.md#需要项目负责人选择)，再读 [产品需求](product-requirements.md) 的目标用户、十条冻结规则、阶段模型和八个合成走查。
2. **D02 / D06 / D13（壳、进程、安装）**：读 [架构 ADR](adr-architecture.md) 的技术选型、进程模型、安装与仓库布局。
3. **D03 / D04 / D08 / D09 / D10（数据与界面）**：读 [产品需求](product-requirements.md) 的对象关系、字段目录和走查；物理 schema 仍归 D03。
4. **D05 / D07（协议与插件连接）**：读 ADR 的协议原则，以及 [数据与隐私](data-privacy.md) 的密钥/URL 脱敏规则。不要在 D01 寻找完整 JSON Schema。
5. **D11 / D12 / D14（AI、备份、首发）**：读 [数据与隐私](data-privacy.md) 与 [下游映射](downstream-decisions.md)。

文档互相链接，稳定标识符（stage code、协议字段、crate 名）保持英文；正文为中文。

## 文档清单

| 文档 | 内容 | 主要消费者 |
| --- | --- | --- |
| [product-requirements.md](product-requirements.md) | MVP 产品规则、阶段、字段目录、合成走查、降级模式 | D03–D04、D07–D11、D14 |
| [adr-architecture.md](adr-architecture.md) | Tauri 2 + Rust 选型、进程模型、协议原则、仓库布局、安装 | D02、D05、D06、D13 |
| [data-privacy.md](data-privacy.md) | 数据归属、敏感分级、备份恢复、密钥、日志 | D03、D08、D11、D12、D13 |
| [downstream-decisions.md](downstream-decisions.md) | D02–D14 消费清单、定案/待选/待验证、依赖图 | 全部下游 |

现有插件文档 [../ai-repeat-validation.md](../ai-repeat-validation.md) **不在本次修改范围**，仍是 v0.3.0 填写/辅助新增的验证记录。

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
| `chrome.storage.local` 另有 `resumeProUpdateCache` / `resumeProDismissedVersion`（更新检查）。D07 outbox 不得占用这些 key | [`popup.js`](../../popup.js) |
| 填写由用户点击触发；`form-agent.js` 仅在确认后点击安全的「新增/添加」按钮；不提交表单 | [`form-agent.js`](../../form-agent.js) `isSafeButton` / `execute` |
| 今天不存在求职档案、填写事件日志或桌面连接 | 全仓库无 `sendNativeMessage` / 申请对象 |
| 以 ZIP 解压后在 Chrome/Edge 加载已解压扩展；MIT License | [`README.md`](../../README.md)、[`LICENSE`](../../LICENSE) |

仓库根目录 **没有** `AGENTS.md` / `Claude.md`。

## 关键决策快照

下列为本次建议定案，**等负责人在 #17 / 本 PR 确认后冻结**。理由与备选见各专文。完整列表见文末「关键决策」在 [下游文档](downstream-decisions.md) 与各专文的对应章节。

| # | 决策 | 一句话 |
| --- | --- | --- |
| 1 | 桌面栈 | **Tauri 2**；Rust 后端 = 唯一写入者；不用 Electron |
| 2 | 安装包 | 仅 **NSIS `setup.exe`、per-user、默认不要求管理员**；MVP 不做 MSI |
| 3 | 进程 | **两个 EXE**：Tauri GUI（后端=唯一写入者）+ 薄 `native-host.exe`。v1 **没有**第三个常驻写入进程。禁止未鉴权 HTTP |
| 4 | 权威源 | **桌面档案是申请数据的 source of truth**；插件模板与填写在未装桌面时仍独立可用 |
| 5 | 默认阶段 | 插件保存岗位 → `saved`（已收藏），**不是** `submitted`。插件「确认已投递」归 **D07** |
| 6 | 身份 | 申请 UUID；两层候选（精确三元组 / 同公司提示）；**禁止**自动合并 |
| 7 | 协议 | 业务信封双向 **64 KiB**；文件字节走分片 NM；幂等键 `(clientInstanceId, messageId)` |
| 8 | 配对 | **D01 不加 `key`**。桌面 UI **粘贴扩展 ID** 写入 host manifest；**第一条 NM 不是配对消息**。未配对 ≠ 未安装，且不建长期队列 |
| 9 | 填写留档 | 默认只存事件元数据；逐字段值默认关闭；快照 ≤ 2 MiB，分片传输 |
| 10 | 备份 | MVP **不加密**；恢复到新目录、**保留 backup 的 `archiveId`、必增 `generation`**；握手成功后插件暂停旧队列 |
| 11 | 密钥 | 插件 Key 留在扩展存储；桌面 Key 进 OS 凭据库；二者都不进档案/备份/日志 |
| 12 | 范围 | Windows + Chrome/Edge；无邮箱 OAuth/IMAP、无自动投递、无云账号、无多设备同步、无 Mac/Linux 成品 |

未确认项与「不选的代价」见 [需要项目负责人选择](downstream-decisions.md#需要项目负责人选择)。原型验证项见 [需要后续原型验证](downstream-decisions.md#需要后续原型验证)。

## 开放问题入口

只把真正需要负责人拍板的问题放在 [downstream-decisions.md](downstream-decisions.md#需要项目负责人选择)。当前建议的负责人选择集（共 7 项，不扩写）：

1. Tauri 2 vs Electron
2. NSIS-only vs NSIS+MSI
3. 托盘 + 后台空闲退出 vs 关窗口即杀服务
4. 桌面粘贴扩展 ID 配对 vs 在插件里加 `key`（会迁移扩展 ID）
5. 填写留档默认仅元数据 vs 默认包含字段值
6. 备份不加密 vs 加密
7. 64 KiB 信封上限 vs 其他上限

## 本 D01 的交付与非交付

**交付：** 本目录五份中文设计文档（含本索引）。文档 PR 即 D01 的全部实现。

**明确不交付：** `/desktop` 源码树、crate 脚手架、SQLite `CREATE TABLE`、协议 JSON Schema、Native Messaging 注册、安装器、Tauri/Electron 安装、真实 AI 调用、邮箱连接、插件权限/版本变更。

下游任务编号与 GitHub issue 对照见 [downstream-decisions.md](downstream-decisions.md#d02d14-消费映射)。
