# 桌面求职管理 MVP — 产品需求

| 字段 | 值 |
| --- | --- |
| 标题 | MVP 产品需求与对象模型 |
| 作者 | D01 design PR |
| 日期 | 2026-09-06 |
| 状态 | Draft / Ready for review |
| 上级 | [README.md](README.md) · [D01 #17](https://github.com/TshyGO/resume-form-assistant-plugin/issues/17) · [Epic #15](https://github.com/TshyGO/resume-form-assistant-plugin/issues/15) |
| 并列 | [adr-architecture.md](adr-architecture.md) · [data-privacy.md](data-privacy.md) · [downstream-decisions.md](downstream-decisions.md) |

本文定义 **做什么、不做什么、对象怎么命名**。物理表结构归 [D03 #18](https://github.com/TshyGO/resume-form-assistant-plugin/issues/18)；通信信封归 [D05 #23](https://github.com/TshyGO/resume-form-assistant-plugin/issues/23)。D01 不写 `CREATE TABLE` 或完整 JSON Schema。

---

## 1. Overview

求职者已经在用 Resume Pro 插件填写网申，但填完之后不知道「哪份投了、用了哪版简历、后来邮件是哪一岗」。本 MVP 把产品扩成 **浏览器填写入口 + Windows 本地求职档案**：插件继续独立填表；桌面主程序保存申请、事件、附件、当次简历快照和待办。桌面档案是申请数据的权威源；插件通过受限 Native Messaging 写入，离线时入队。

当前仓库 **没有** 申请对象、填写事件日志或桌面连接（见 [README 现状表](README.md#现状以仓库代码为准不以-readme-宣传为准)）。填写仍是用户点击触发；[`form-agent.js`](../../form-agent.js) 只在确认后点击安全「新增/添加」按钮，从不提交表单。本需求保持该安全边界，并加上「填写完成 ≠ 已投递」。

---

## 2. Background & Motivation

### 2.1 当前状态

- 插件 v0.3.0：多模板、AI 匹配填写、PDF/Word 解析、辅助新增条目。数据在 `chrome.storage.local`。
- AI 配置（含明文 `apiKey`）只存在扩展存储，经 offscreen worker 发往用户自己的 OpenAI 兼容接口。
- 没有「投递了没有」「面试约在哪天」「这封 HR 邮件属于哪一岗」的本地档案。
- 秋招场景下一公司多岗、同岗重复投、自动回执与面试通知混在一起，靠记忆或表格容易串记录。

### 2.2 痛点

1. 填完表不等于网站已保存或已提交，插件今天也无法知道网站是否接受。
2. 邮箱里的自动回执容易被当成「通过筛选」。
3. 没把邮件导入工具 ≠ 对方没回；UI 若写成「未回复」会误导。
4. 按公司名或 URL 去重会把两个岗位或两次投递合成一条，后续通知无法消歧。

### 2.3 目标用户

在 Windows 上使用 Chrome 或 Edge、已用 Resume Pro 填写网申的 **中文个人求职者**。不假设企业 IT、不假设多设备、不假设会写代码。能接受「先装桌面程序再从网页保存岗位」；不装桌面时原插件能力必须仍可用。

---

## 3. Goals & Non-Goals

### 3.1 Goals（首版必须）

- 不装插件、不接 AI，也能在桌面手动走完：建档 → 确认投递 → 测评 → 多轮面试 → Offer/拒绝。
- 从网页 **主动** 保存岗位到本地；填写后可选择留档当次快照与填写事件；投递必须另一次明确确认。
- 导入 `.eml` / `.txt` / PNG / JPEG / PDF 与粘贴文本；预览；可选 AI 建议；确认后事务性更新阶段/事件/待办。
- 同公司多岗位、同岗位多次申请可区分；疑似重复只提示，不自动合并。
- 完整备份与恢复；升级/卸载默认不删档案。
- 插件原填写路径在桌面缺失、离线、AI 失败时仍可用。

### 3.2 Non-Goals（首版明确不做）

与 Epic #15 一致，D01 **不得重开**：

- 邮箱 OAuth / IMAP 轮询 / 自动拉取
- 自动提交网申、代发邮件、任意网页 Agent
- 云账号、云同步、多设备同步、团队协作
- Mac / Linux 成品
- 扩展商店上架与静默自动更新（检查更新仍可沿用插件现有 GitHub Release 提示）
- `.msg` / Outlook 虚拟拖拽对象（不支持时提示导出 `.eml` 或粘贴正文）
- 把当前开发者机器路径写进产品
- 在 D01 修改插件权限、存储、功能或把 `manifest.json` 版本从 `0.3.0` 改掉

---

## 4. 十条冻结产品规则

来自 Epic #15，D01 只落实为可执行规则，不重新辩论。

1. **填写完成 ≠ 已投递。** `fill_completed` / `fill_partial` 不得把阶段推到 `submitted`。
2. **自动回执 ≠ 通过筛选 / ≠ 人工回复。** `auto_ack` 证据不把阶段推到 `interview`，也不暗示「已通过」。
3. **没有导入邮件 ≠ 没有收到回信。** UI 文案必须是「尚未导入回复证据」，禁止「对方未回复」。
4. **同公司多岗、重复申请必须可区分。** 禁止按公司或 URL 自动合并；身份是申请 UUID。
5. **AI 只建议。** 确认后才事务性写事件/阶段/待办；模型输出不得替换原始证据字节。
6. **桌面档案是 source of truth。** 插件离线队列 + 幂等 + `archiveId`/`generation` 检查。
7. **只记录用户主动使用插件的操作。** 禁止密码、OTP、API Key、Cookie；禁止全局键鼠采集。
8. **升级 / 卸载 / 恢复不得静默删除申请和附件。**
9. **AI 或网络失败时，手动管理必须仍可用。**
10. **无邮箱连接、无自动投递、无通用 web agent、无云账号、无多设备同步、v1 无 Mac/Linux 成品。**

---

## 5. 核心用户流程

### 5.1 纯手动（无插件、无 AI）

1. 桌面「新建申请」：公司、岗位、链接、地点、备注。默认阶段 `saved`。
2. 用户明确「确认已投递」→ 事件 `submit_confirmed`，阶段投影为 `submitted`。
3. 手动记录测评、面试（含轮次）、Offer、拒绝、撤回、结束。
4. 导入文件到证据收件箱，手动关联申请。
5. 手动待办：测评截止、面试时间、待回复。

此流程是 [D04 #19](https://github.com/TshyGO/resume-form-assistant-plugin/issues/19) 的验收闭环，不断网、不调外部 API。

### 5.2 插件辅助

1. 用户在招聘页点「保存岗位到本地」（**D07**）。侧边栏展示提取的公司/岗位/地点/URL，缺项手补，不捏造。
2. 桌面按 **两层候选**（§7）返回最小元数据；用户选「使用已有」或「新建」。默认阶段 `saved`。
3. 用户照常使用现有「一键 AI 填写」/「AI 辅助新增条目」。填写本身不依赖桌面。
4. 可选：将本次填写事件 + 简历快照归档到已绑定申请（D08；快照字节走分片，见 ADR §4）。
5. 用户另点「确认已投递」（**插件按钮归 D07**，`submit.confirm`，与填写成功无关），或之后在桌面（D04）/证据确认（D11）推进阶段。

**Outbox 顺序（冻结）：** 先探测 host 注册 / 本 origin 是否已配对 / 协议是否兼容。未安装、未配对：不建长期队列。协议不兼容：不入队，提示升级。`handshake` 与 `application.queryCandidates` 是 **读**，不写 outbox。**只在用户确认「使用已有」或「新建」之后、派发写入**（`job.save` / `fill.submit` / `snapshot.chunk` / `submit.confirm`）时才持久化 outbox 行，并盖上握手得到的 `(archiveId, generation)`。用户点「取消」：什么都不入队。已配对但 EXE 未运行或离线或拉起失败：此时才 durable 入队 +「待同步」。

```mermaid
sequenceDiagram
  participant U as 用户
  participant CS as content.js
  participant SW as background.js
  participant H as native-host.exe
  participant APP as Tauri EXE
  U->>CS: 保存岗位到本地（确认字段）
  CS->>CS: 剥离 URL 秘密参数
  CS->>SW: runtime.sendMessage
  SW->>SW: 探测：host 注册？本 origin 已配对？
  alt 未安装或未配对
    SW-->>U: 安装说明 / 粘贴扩展 ID（不写 outbox）
  else 已安装已配对
    SW->>H: Native Messaging handshake（读，不是配对，不入队）
    alt 协议不兼容
      SW-->>U: 提示升级（不入队）
    else 握手成功
      SW->>SW: 比对已有 outbox 上的 archiveId/generation
      alt 身份不匹配
        SW-->>U: 暂停旧队列：关联 / 丢弃 / 另存
      else 身份匹配或队列空
        alt EXE 未运行
          H->>APP: 按需启动 Tauri EXE（可隐藏）
        end
        SW->>H: application.queryCandidates（读，不入队）
        APP-->>SW: exact[] + sameCompany[]
        U->>CS: 使用已有 / 新建 / 取消
        alt 取消
          Note over SW: 不写 outbox
        else 使用已有或新建
          SW->>SW: 此时才写入 outbox（固定 messageId，盖上当前 archiveId/generation）
          SW->>H: job.save
          APP-->>SW: 提交后的 resultId
          SW->>SW: 删除对应 outbox 项
          SW-->>U: 桌面已保存（stage=saved，非已投递）
        end
      end
    end
  end
```

「桌面已保存」只在持久化应答之后显示。已入队但未提交时显示「待同步」，不得假成功。取消选择器不会留下 `job.save` 队列项。

### 5.3 证据 + AI 建议

1. 导入 eml/txt/png/jpeg/pdf 或粘贴文本 → 本地副本 + 预览。
2. 可先不关联申请。
3. 可选调用桌面 AI：展示外发范围 → 结构化建议 → 用户确认/修改后确认/拒绝/暂存。
4. 确认时同一事务写事件、阶段投影、待办，并引用原始证据。

```mermaid
flowchart TD
  A[网页或手动] --> B{是否已有申请 UUID}
  B -->|新建| C[Application stage=saved]
  B -->|绑定已有| D[已有 Application]
  C --> E[可选填写留档]
  D --> E
  E --> F{用户确认已投递?}
  F -->|否| G[停留 saved / filling]
  F -->|是| H[Event submit_confirmed / stage=submitted]
  H --> I[导入证据]
  I --> J{用户确认 AI 或手动改阶段?}
  J -->|否| K[证据已存 阶段不变]
  J -->|是| L[同一事务: Event + stage 投影 + Todo]
```

---

## 6. 阶段模型

### 6.1 稳定 stage code

Code 稳定，供存储、协议、过滤使用；展示名可本地化。MVP 中文如下。

| code | 展示名 | 含义 |
| --- | --- | --- |
| `saved` | 已收藏 | 已建档，尚未确认投递。插件保存岗位的默认值 |
| `filling` | 填写中 | MVP **会**投影。已有成功/部分填写事件且尚未 `submit_confirmed`。D04 必须能按此过滤 |
| `submitted` | 已投递 | 仅由 `submit_confirmed` 在 `saved`/`filling` 上进入；从更后阶段回来必须走 `stage_corrected` |
| `assessment` | 测评 | 笔试/在线测评等 |
| `interview` | 面试 | 任意轮次的面试；轮次不是独立 stage |
| `offer` | Offer | 录用意向/Offer |
| `rejected` | 拒绝 | 被拒（当前阶段可以是 `rejected`） |
| `withdrawn` | 撤回 | 用户主动撤回（当前阶段可以是 `withdrawn`） |
| `closed` | 结束 | **当前阶段**之一（入职、放弃收尾）。拒绝/撤回事件仍留在时间线，不与 `closed` 同时作为 current |

面试轮次是面试事件/待办上的 **整数 + 可选标签**（`round=1`，「一面」），不是新的 stage code。

### 6.2 阶段折叠函数（冻结，D03 必须实现）

`currentStage` 是按 `recordedAt` 升序（并列用 `id`）折叠事件得到的投影，并在写入那条事件的 **同一事务** 内更新。禁止普通编辑无声改阶段。纠错追加 `stage_corrected`（`from`/`to`/`actor`/`reason`），**不改写**历史事件。

`stage_corrected` 只是又一条 **set-absolute** 事件：它成为当前值是因为它排在后面，**不是**因为纠错永远压过未来事件。10.6 在纠错之后补 `interview_recorded` 仍然生效。

每个 `eventType` 的折叠效应只有四种：`set-absolute` / `never-regress` / `advance` / `no-op`。

| `eventType` | 效应 |
| --- | --- |
| `application_created` | `set-absolute saved` |
| `application_updated` | `no-op` |
| `job_saved` | `never-regress`：current ∈ {∅, `saved`} → `saved`；已是更后阶段 → `no-op` |
| `fill_started` / `fill_completed` / `fill_partial` | `advance`：仅 `saved` → `filling`；其他 current `no-op`。**绝不**→`submitted` |
| `fill_failed` / `fill_cancelled` | `no-op`（失败/取消不标「填写中」） |
| `submit_confirmed` | 仅当 current ∈ {`saved`,`filling`} 时 `set-absolute submitted`；否则 `no-op`（从 `interview` 等退回须用户 `stage_corrected`） |
| `assessment_recorded` | `set-absolute assessment` |
| `interview_recorded` | `set-absolute interview` |
| `interview_rescheduled` | 仅当 current ∈ {`saved`,`filling`,`submitted`,`assessment`} 时设 `interview`；若 current ∈ {`interview`,`offer`,`rejected`,`withdrawn`,`closed`} 则 `no-op`（从拒绝等恢复须 `stage_corrected` 或 `interview_recorded`） |
| `offer_recorded` / `rejected` / `withdrawn` / `closed` | `set-absolute` 对应 code |
| `stage_corrected` | `set-absolute` payload.`to` |
| `evidence_*` / `note_*` / `todo_*` | `no-op` |

建议的正向路径（UI 可跳步，但必须写对应事件）：

```text
saved → filling → submitted → assessment → interview → offer
                                              ↘ rejected | withdrawn | closed
任意阶段 --stage_corrected--> 任意阶段（需原因）
```

### 6.3 第二维度：回复证据状态

与流程阶段独立。`replyEvidenceState` 只折叠 **已关联到该申请、且已确认** 的证据上的 `replyClass`（不是 `kind`，也不是未确认的 AI 建议）。证据本身不蕴含阶段。

对一条申请，令 `C` 为上述 `replyClass` 的集合，并 **忽略** `unknown` 与空：

| `C` 的内容 | `replyEvidenceState` |
| --- | --- |
| 没有非空、非 `unknown` 的 `replyClass` | `none_imported` |
| 只有 `auto_ack` | `auto_ack` |
| 含 `{human_reply, assessment_invite, interview_invite, action_required, offer, reject, other}` 之一，且 **没有** `auto_ack` | `human_reply` |
| 同时有 `auto_ack` 与上一行任一人工作类 | `mixed` |

| code | 展示 | 规则 |
| --- | --- | --- |
| `none_imported` | 尚未导入回复证据 | 默认。禁止写成「对方未回复」 |
| `auto_ack` | 已导入自动回执 | 不移动到 `interview`，不暗示通过筛选 |
| `human_reply` | 已导入人工回复 | 含面试/测评/Offer/拒信等人工类；仍需用户确认才改 **阶段** |
| `mixed` | 回执与人工回复均有 | 列表可用摘要，详情看时间线 |

---

## 7. 重复、关联与冲突

身份：**Application UUID**。D03 **不得** 对 `(company, url)` 或 `(company, title)` 建禁止重复的唯一约束。

规范化（逻辑规则，算法细节 D07/D03 实现）：

- 公司名：去首尾空白、全半角、常见后缀（有限词表，如「有限公司」）折叠后再比；原始字符串始终保留。
- 岗位名：去首尾空白、压缩空白。
- URL：去掉 fragment；剥离已知密钥查询参数（见 [data-privacy.md](data-privacy.md#71-url-脱敏)）；host 小写。

保存时两层查询（同一最小元数据形状：id、公司、岗位、阶段、URL、更新时间；不把整库同步给插件）：

1. **精确层（走查 10.4）：** 规范化三元组 `(company, title, url)` 命中 → 「可能是同一岗位的重复投递」。默认仍由用户选使用已有 / 新建。
2. **同公司提示层（走查 10.1）：** 规范化公司相同，但 title 或 URL 不同 → 「同公司其他岗位」列表。**默认新建**，永不自动绑定。同公司命中是 **提示不是身份**。

其余规则：

3. UI 另可取消。同公司两个岗位 = 两条申请。
4. 对同一 posting 再投一次 = 用户说新建就是两条。
5. 内容哈希用于 **重复通知警告**，不因同哈希自动撤销用户选择的不同关联。
6. 误关联：改关联保留原始附件字节，追加 `association_changed`（from/to application id）。
7. 阶段折叠：见 §6.2。

---

## 8. 逻辑对象与字段目录

下表是逻辑字段，不是 SQL。每列：含义、是否必填、来源、可变性、敏感级。

**来源：** `user` / `plugin` / `import` / `system` / `ai_suggest`（建议确认前不写入正式字段）。

**可变性：** `immutable` / `mutable` / `append-only` / `projected`（由事件折叠得出，禁止直接 UPDATE）。

**敏感级：** `public-meta` / `PII` / `secret-forbidden`。`secret-forbidden` 的值若出现在输入中必须丢弃或剥离，不得入库、不得进日志、不得进备份。

### 8.1 ArchiveMeta

| 字段 | 含义 | 必填 | 来源 | 可变性 | 敏感级 |
| --- | --- | --- | --- | --- | --- |
| `archiveId` | 本档案实例 UUID。恢复 **保留 backup 的值**，不新铸 | 是 | system | immutable | public-meta |
| `generation` | 单调递增；每次恢复 **必 +1** | 是 | system | mutable（仅系统提升） | public-meta |
| `schemaVersion` | 逻辑/物理 schema 版本 | 是 | system | mutable（迁移） | public-meta |
| `createdAt` | 档案创建 UTC | 是 | system | immutable | public-meta |
| `displayName` | 用户可见档案名 | 否 | user | mutable | public-meta |

同一时刻桌面只把 **一个** 档案标为 current。插件握手拿到的就是 current 的 `archiveId`+`generation`。

### 8.2 Application

| 字段 | 含义 | 必填 | 来源 | 可变性 | 敏感级 |
| --- | --- | --- | --- | --- | --- |
| `id` | 申请 UUID | 是 | system | immutable | public-meta |
| `company` | 公司名（原始） | 是 | user/plugin | mutable | PII |
| `companyNormalized` | 去重查询用 | 是 | system | mutable（随 company） | PII |
| `title` | 岗位名（原始）。与公司连用可识别雇主关系，按 PII 处理 | 是 | user/plugin | mutable | PII |
| `titleNormalized` | 去重查询用 | 是 | system | mutable | PII |
| `sourceUrl` | 展示/存储用 URL（剥秘密参数，保留 ATS `code`/`key` 岗位号，见隐私 §7.1） | 否 | user/plugin | mutable | PII |
| `dedupeUrl` | 身份规范化 URL（更窄剥离集） | 否 | system | mutable | PII |
| `location` | 地点 | 否 | user/plugin | mutable | PII |
| `notes` | 备注 | 否 | user | mutable | PII |
| `currentStage` | 阶段投影（§6.2 折叠） | 是 | system | projected | public-meta |
| `replyEvidenceState` | 由 `replyClass` 投影，不是文件类型 | 是 | system | projected | public-meta |
| `createdAt` / `updatedAt` | UTC | 是 | system | created immutable | public-meta |
| `archivedAt` | 列表归档（非回收） | 否 | user | mutable | public-meta |
| `recycleState` | `active` / `recycled` / `purged` | 是 | user/system | mutable | public-meta |
| `origin` | `manual` / `plugin` | 是 | system | immutable | public-meta |

元数据编辑建议追加 `application_updated` 事件（from/to），D03 定物理形状。回收不是永久删除，见 [data-privacy.md](data-privacy.md#5-删除回收与永久清除)。

### 8.3 Event

事件 **append-only**。错误用新事件表达，不用 UPDATE 覆盖载荷。

| 字段 | 含义 | 必填 | 来源 | 可变性 | 敏感级 |
| --- | --- | --- | --- | --- | --- |
| `id` | 事件 UUID | 是 | system | immutable | public-meta |
| `applicationId` | 所属申请；未绑定证据事件可空 | 视类型 | system | immutable | public-meta |
| `eventType` | 见下表 | 是 | system | immutable | public-meta |
| `occurredAt` | 业务发生时间。`occurredPrecision=unknown` 时 **必须为 null**，禁止填午夜伪造 | 当 precision≠`unknown` | user/import/plugin | immutable | public-meta |
| `recordedAt` | 写入时间 UTC | 是 | system | immutable | public-meta |
| `occurredPrecision` | `datetime` / `date` / `unknown` | 是 | system | immutable | public-meta |
| `timeZone` | 有意义时区；未知则空 | 否 | user/import | immutable | public-meta |
| `source` | `manual` / `plugin` / `import` / `ai_confirmed` | 是 | system | immutable | public-meta |
| `sourceRequestId` | 插件 `messageId` 或导入批次 | 否 | plugin/import | immutable | public-meta |
| `payloadVersion` | 载荷 schema | 是 | system | immutable | public-meta |
| `payload` | 结构化；禁止 secret | 是 | 视类型 | immutable | PII 或 public-meta |
| `actor` | `user` / `plugin` / `system` | 是 | system | immutable | public-meta |

**时间语义（D10 必须遵守）：** 存储 UTC 时间戳；只有日期的通知不得伪造「当天 00:00」为精确时刻。`occurredPrecision=date` 时 UI 只显示日期。

MVP 事件类型（可在 D03 增补，但下列语义冻结）：

| `eventType` | 典型 payload | 折叠效应（正式定义见 §6.2） |
| --- | --- | --- |
| `application_created` | 初始字段快照 | set-absolute `saved` |
| `application_updated` | from/to 字段 | no-op |
| `job_saved` | 插件提交的岗位元数据 | never-regress |
| `fill_started` / `fill_completed` / `fill_partial` | 字段计数、耗时、URL、template、snapshotId、outcome | advance `saved`→`filling` |
| `fill_failed` / `fill_cancelled` | 同上 outcome | no-op |
| `submit_confirmed` | 确认方式（插件 D07 或桌面 D04） | 仅 saved/filling → `submitted` |
| `stage_corrected` | from/to/reason | set-absolute `to` |
| `assessment_recorded` | 名称、截止 | set-absolute `assessment` |
| `interview_recorded` | round、时间 | set-absolute `interview` |
| `interview_rescheduled` | round、from/to 时间 | 仅 saved/filling/submitted/assessment → `interview`；其余 no-op |
| `offer_recorded` / `rejected` / `withdrawn` / `closed` | 原因可选 | set-absolute 对应 code |
| `evidence_imported` | evidenceId | no-op |
| `evidence_associated` / `association_changed` | evidenceId, from/to app | no-op |
| `note_added` | 文本 | no-op |
| `todo_created` / `todo_completed` | todoId | no-op |

### 8.4 ReplyEvidence 与 AttachmentBlob

附件字节在库外。`kind` 是 **获取/格式**，`replyClass` 是 **语义**（确认后才写）。`replyEvidenceState` 按 §6.3 从已关联、已确认的 `replyClass` 投影（`unknown`/空不计数）。一封面试邮件可以同时是 `kind=eml` 与 `replyClass=interview_invite`，此时该申请的 `replyEvidenceState=human_reply`。

| 字段 | 含义 | 必填 | 来源 | 可变性 | 敏感级 |
| --- | --- | --- | --- | --- | --- |
| `evidenceId` | UUID | 是 | system | immutable | public-meta |
| `applicationId` | 可空（收件箱未关联） | 否 | user | mutable（改关联） | public-meta |
| `kind` | 获取格式：`eml` / `screenshot` / `pdf` / `paste` / `unknown` | 是 | import/system | immutable | public-meta |
| `replyClass` | 语义：`auto_ack` / `human_reply` / `assessment_invite` / `interview_invite` / `action_required` / `offer` / `reject` / `other` / `unknown`；确认前可空 | 否 | user / ai_suggest+confirm | mutable 至确认 | public-meta |
| `blobSha256` | 指向 AttachmentBlob | 是 | system | immutable | public-meta |
| `originalFilename` | 导入时文件名 | 否 | import | immutable | PII |
| `importedAt` | UTC | 是 | system | immutable | public-meta |
| `sourcePathHint` | 仅导入瞬间；**不作为长期依赖** | 否 | import | immutable | PII |
| `subject` / `fromAddr` / `sentAt` | 邮件头（若可解析） | 否 | import | immutable | PII |
| `bodyExtract` | 本地提取的纯文本/清洗 HTML 转文本 | 否 | import | immutable | PII |

**AttachmentBlob**（ER 中的字节实体）：

| 字段 | 含义 | 必填 | 来源 | 可变性 | 敏感级 |
| --- | --- | --- | --- | --- | --- |
| `sha256` | 内容哈希，主键 | 是 | system | immutable | public-meta |
| `sizeBytes` | 字节数 | 是 | system | immutable | public-meta |
| `storedRelPath` | 档案目录内相对路径 | 是 | system | immutable | public-meta |
| `refCount` | 引用该 blob 的 evidence 数 | 是 | system | mutable | public-meta |
| `mime` | MIME | 否 | import | immutable | public-meta |

同一字节被多条申请引用时不复制文件。`refCount=0` 才允许永久删除。HTML 邮件：清洗展示，不执行脚本、不加载远程图片/跟踪像素、不自动打开链接（D09）。

### 8.5 ResumeSnapshot

插件实时模板继续只活在 `chrome.storage.local`。桌面快照是填写归档时的 **拷贝**，之后不可变。改插件模板不得改写历史快照。

| 字段 | 含义 | 必填 | 来源 | 可变性 | 敏感级 |
| --- | --- | --- | --- | --- | --- |
| `snapshotId` | UUID | 是 | system | immutable | public-meta |
| `applicationId` | 所属申请 | 是 | plugin/user | immutable | public-meta |
| `templateName` | 当时模板名 | 是 | plugin | immutable | public-meta |
| `templateVersion` | 插件侧版本/修订标记；无则用内容哈希短码 | 否 | plugin | immutable | public-meta |
| `sha256` | 快照内容摘要 | 是 | system | immutable | public-meta |
| `storedRelPath` | 快照文件 | 是 | system | immutable | public-meta |
| `createdAt` | UTC | 是 | system | immutable | public-meta |
| `byteSize` | 用于超限判断 | 是 | system | immutable | public-meta |

快照内容是 PII。默认填写留档 **不把逐字段值塞进 `fill.submit` 信封**；快照文件由用户在归档时确认后经 `snapshot.chunk` 传输（每块 ≤ 64 KiB），或改在桌面导入。单份快照 **> 2 MiB 拒绝**，明确失败。Outbox 只存 `snapshotId`/`sha256`/分片游标，不把整份 blob 放进 `chrome.storage.local`。

### 8.6 Todo

| 字段 | 含义 | 必填 | 来源 | 可变性 | 敏感级 |
| --- | --- | --- | --- | --- | --- |
| `id` | UUID | 是 | system | immutable | public-meta |
| `applicationId` | 所属申请 | 是 | user/ai_confirmed | immutable | public-meta |
| `title` | 待办标题 | 是 | user/ai_suggest+confirm | mutable | PII |
| `duePrecision` | `datetime` / `date` / `none` | 是 | user | mutable | public-meta |
| `dueAtUtc` | 仅 precision=datetime | 否 | user | mutable | public-meta |
| `dueDate` | 仅 precision=date（日历日） | 否 | user | mutable | public-meta |
| `timeZone` | 显示与提醒用 | 否 | user | mutable | public-meta |
| `remindAtUtc` | 本地提醒时刻 | 否 | user | mutable | public-meta |
| `status` | `open` / `done` / `cancelled` | 是 | user | mutable | public-meta |
| `interviewRound` | 可选轮次 | 否 | user | mutable | public-meta |
| `sourceEventId` | 创建来源 | 否 | system | immutable | public-meta |

提醒能力依赖进程模型：窗口关闭但 Tauri EXE 后端仍在（托盘/idle 窗口期内）时可提醒；彻底退出或关机后 **v1 不保证** 提醒，且 **不得** 偷偷注册开机启动（D10 / ADR）。Idle 默认 15 分钟，见 ADR §3.4。

### 8.7 AiSuggestion

与已确认事件分离。确认前正式阶段/待办不变。

| 字段 | 含义 | 必填 | 来源 | 可变性 | 敏感级 |
| --- | --- | --- | --- | --- | --- |
| `id` | UUID | 是 | system | immutable | public-meta |
| `evidenceId` | 所分析证据 | 是 | system | immutable | public-meta |
| `status` | `pending` / `confirmed` / `modified_confirmed` / `rejected` / `deferred` | 是 | user | mutable | public-meta |
| `candidateApplicationIds` | 消歧列表，可多条 | 是 | ai_suggest | immutable | public-meta |
| `suggestedStage` | 可空 | 否 | ai_suggest | immutable | public-meta |
| `suggestedRound` | 可空 | 否 | ai_suggest | immutable | public-meta |
| `suggestedTodos` | 结构化待办草案 | 否 | ai_suggest | immutable | PII |
| `excerptRefs` | 证据片段引用 | 否 | ai_suggest | immutable | PII |
| `uncertainties` | 模型自报不确定点 | 否 | ai_suggest | immutable | public-meta |
| `modelLabel` | 用户配置的模型名 | 否 | system | immutable | public-meta |
| `promptScope` | 外发范围摘要（非原文密钥） | 否 | system | immutable | public-meta |

禁止字段：API Key、完整档案库、未选中申请的简历快照。D11 建议的分类写入 `ReplyEvidence.replyClass`（与 `kind` 分离），确认前不改正式阶段。

### 8.8 填写留档默认范围

默认写入 `fill_*` 事件的 payload：

- outcome：`started` / `completed` / `partial` / `failed` / `cancelled`
- `fieldCount`、`filledCount`、`unconfirmedCount`
- 耗时（扫描/匹配/填写/总计，毫秒）
- 脱敏后的 URL
- `templateName` / `templateVersion` / `snapshotId`（若用户同意保存快照）
- 插件版本、`messageId`

**逐字段值默认 OFF**，需用户在当次或设置里明确打开。打开后仍禁止密码/OTP/支付框。

必须区分三种「值」（D08 验收）：

| 概念 | 插件能否知道 | 默认是否落盘 |
| --- | --- | --- |
| AI 返回值 | 能（匹配结果） | 默认否 |
| 已写入控件 | 能（`setElementValue` 成功；辅助模式还有短时读回） | 默认否；计数默认是 |
| 网站已接受/服务端已保存 | **不能**。读回 ≠ 服务端持久化（见 [`docs/ai-repeat-validation.md`](../ai-repeat-validation.md)） | 永不自动标记；仅 `submit_confirmed` 表示用户声称已投递 |

现有诊断 [`content.js` `formatFillDiagnostics`](../../content.js) 已不允许复制接口地址、Key、简历内容；桌面事件应保持同一 allowlist 精神。

### 8.9 对象关系

```mermaid
erDiagram
  ArchiveMeta ||--o{ Application : contains
  Application ||--o{ Event : timeline
  Application ||--o{ Todo : has
  Application ||--o{ ResumeSnapshot : snapshots
  Application ||--o{ ReplyEvidence : associated
  ReplyEvidence }o--|| AttachmentBlob : blobSha256
  ReplyEvidence ||--o{ AiSuggestion : suggestions
  Event }o--o| ResumeSnapshot : may_cite
  Event }o--o| ReplyEvidence : may_cite
  Todo }o--o| Event : sourced_from
```

### 8.10 Plugin Outbox（逻辑对象，存在 `chrome.storage.local.desktopOutbox`）

仅在 **host 已注册 ∧ 本 origin 已配对 ∧ 协议兼容 ∧ 用户已确认派发写入**（`job.save` / `fill.submit` / `snapshot.chunk` / `submit.confirm`）之后持久化。handshake 与候选查询不入队。每条记录盖上当时握手到的档案身份。

| 字段 | 含义 | 必填 | 来源 | 可变性 | 敏感级 |
| --- | --- | --- | --- | --- | --- |
| `messageId` | 幂等键之一 | 是 | plugin | immutable | public-meta |
| `clientInstanceId` | 每扩展安装/Profile 一次的 UUID（`desktopClientInstanceId`） | 是 | plugin | immutable | public-meta |
| `messageType` | 与 ADR 枚举相同 | 是 | plugin | immutable | public-meta |
| `archiveId` | 入队时握手到的档案 | 是 | handshake | immutable | public-meta |
| `generation` | 入队时握手到的代 | 是 | handshake | immutable | public-meta |
| `payload` | 业务载荷，**无** Key/密码 | 是 | plugin | immutable | PII |
| `createdAt` | 入队 UTC | 是 | plugin | immutable | public-meta |
| `bytes` | payload 序列化字节数 | 是 | plugin | immutable | public-meta |
| `chunkCursor` | `snapshot.chunk` 已确认的最后序号；非分片则为空 | 否 | plugin | mutable | public-meta |

恢复后：握手 **成功** 并返回新 `(archiveId, generation)`；插件比较每条 outbox 上盖的身份，不匹配则暂停，用户选关联/丢弃/另存。关联通过 `outbox.reconcile` 查询哪些 `messageId` 已在恢复库中。服务端幂等是安全网，不是「静默重放许可」。

---

## 9. 降级模式

| 模式 | 插件填写/模板/AI | 保存岗位 / 确认投递 | 桌面档案 | AI 建议 |
| --- | --- | --- | --- | --- |
| 未安装桌面 | 与今天相同 | 说明如何安装；**不建 durable outbox**；不得说已保存 | 无 | 无 |
| 已安装但未配对 | 正常 | 说明在桌面粘贴扩展 ID；**不建 durable outbox**；**不得**说「未安装」 | 本地手动可用 | 桌面侧可用 |
| 已安装已配对但未运行 | 正常 | host 按需启动 Tauri EXE；失败则 **durable 入队** +「待同步」 | 拉起后可用 | 拉起后可用 |
| 离线（无互联网） | 本地匹配仍可用；上游 AI 失败 | 已配对则可入队 | 导入/待办/改阶段全部可用 | 禁用并给出原因 |
| AI 不可用 | 现有：保留已验证本地匹配 | 与 AI 无关 | 手动阶段/证据可用 | 建议失败开放 |
| 协议不兼容 | 填写不受影响 | **不入队**；提示升级 | 本地手动可用 | 本地手动可用 |
| `generation` 不匹配 | 填写不受影响 | 握手成功；**暂停旧队列**；关联/丢弃/另存 | 以桌面 current 为准 | 正常 |

队列容量满：停止新增留档并提示，不静默丢旧项，**不阻止**原有填表（D07）。

---

## 10. 合成走查（强制）

下列使用合成数据，不读取真实简历或邮箱。每个走查列出对象、阶段、事件、证据、待办和用户选择。

### 10.1 同公司两岗 + 无岗位名的面试邮件

**设定：** 用户投了「星河科技 / 后端开发」和「星河科技 / 测试开发」。HR 来信主题「面试邀请」，正文无岗位名。

| 步骤 | 用户选择 | 对象变化 |
| --- | --- | --- |
| 1 | 插件保存岗 A | `app-A` UUID1，company=星河科技，title=后端开发，stage=`saved`，Event `job_saved`+`application_created` |
| 2 | 确认投递 A | Event `submit_confirmed`，stage=`submitted` |
| 3 | 保存岗 B（同公司不同 title/URL） | **精确三元组不命中**；同公司提示层列出 `app-A`（「同公司其他岗位」）。默认 **新建**。用户选新建 → `app-B` UUID2，stage=`saved`。不自动绑定 |
| 4 | 确认投递 B | `app-B` → `submitted` |
| 5 | 导入面试邮件 | Evidence `ev-1`，`applicationId=null`，`kind=eml`，`replyClass` 空，收件箱可见 |
| 6 | 可选 AI | 建议 `candidateApplicationIds=[UUID1,UUID2]`，`replyClass=interview_invite`，`uncertainties` 含「无岗位名」；**不自动选** |
| 7 | 用户把 `ev-1` 关联到 `app-A` 并确认「面试 一面」 | Event `evidence_associated`、`interview_recorded`（round=1）；`replyClass=interview_invite`；`app-A` stage=`interview`（set-absolute）；**`app-A.replyEvidenceState=human_reply`**（§6.3：`interview_invite` ∈ 人工类且无 `auto_ack`）；Todo「一面」；`app-B` 的 `replyEvidenceState` 仍 `none_imported` |

禁止：只因公司名相同把邮件归到最近一条申请。

### 10.2 导入自动回执

**设定：** `app-A` 已是 `submitted`。导入「我们已收到您的申请」。

- Evidence `ev-ack`，`kind=eml`；用户或确认后的 AI 写入 `replyClass=auto_ack`。
- Event `evidence_imported`（+ 可选 `evidence_associated`）。
- `replyEvidenceState=auto_ack`。
- **stage 仍为 `submitted`。** 不创建面试待办。
- UI：详情显示「已导入自动回执」，不显示「通过筛选」。

若用户强行把阶段改到 `interview`，必须走 `stage_corrected` 并填写原因，时间线同时保留回执事件。

### 10.3 面试改期

**设定：** `app-A` 已有 `interview_recorded` round=1，occurredAt=2026-09-20 14:00+08，Todo 未完成。

- 导入「改至 9 月 22 日 10:00」→ `ev-2`。
- AI 建议 `interview_rescheduled`，from/to 明确；用户确认。
- 同一事务：Event `interview_rescheduled`；Todo 的 `dueAtUtc` 更新；旧提醒计划撤销；stage 保持 `interview`。
- 时间线顺序：原面试事件 → 改期事件。两者都保留。`occurredPrecision=datetime`，时区 +08。

不得把原事件的 `occurredAt` 覆盖掉。

### 10.4 对同一 posting 重复申请

**设定：** `app-A` 已投递 URL `https://jobs.example.com/req/42`。用户再次从同一页保存。

- **精确层** 规范化三元组命中 `app-A`（同一 posting）。同公司提示层可同时列出，但不替代精确警告。
- 提示：「可能重复。使用已有申请，或作为再一次投递新建？」
- 用户选 **新建** → `app-C` 新 UUID，相同 company/title/URL，stage=`saved`。
- 两条申请列表并存；后续通知必须消歧（走查 10.1 同类）。

用户选「使用已有」则只追加 `job_saved`（或忽略重复保存），不新建 UUID。

### 10.5 重复通知

**设定：** 同一封面试邮件被导入两次（或转发副本，哈希相同）。

- 第一次：`ev-1`，sha256=H，关联 `app-A`。
- 第二次：计算 H 已存在，UI 警告「内容与已有证据相同」。
- 用户仍可：忽略导入 / 仍导入并关联到 `app-B`（用户有意的不同链接）。
- **不**因同哈希自动撤销 `app-A` 的关联，也 **不**自动跳过用户选择。
- 物理上可复用同一 `AttachmentBlob`，两条 evidence 元数据可并存（D09/D03）。

### 10.6 误标拒绝后恢复面试

**设定：** 用户（或确认过的 AI）把 `app-A` 标为 `rejected`。后来发现是面试通知。

- 已有 Event `rejected`，stage 投影 `rejected`。
- 用户「纠正阶段」→ `interview`，原因「误把面试信标为拒信」。
- Event `stage_corrected` {from:`rejected`, to:`interview`, actor:`user`, reason}。
- 折叠后 current=`interview`（`stage_corrected` 是后一条 set-absolute）。时间线：**拒绝事件与纠错事件都在**。
- 可再补 `interview_recorded`（仍 set-absolute `interview`）与 Todo。若曾有拒绝相关 Todo，用户手动取消；系统不猜。
- 若纠错 **之后** 又来一条更晚的 `assessment_recorded`，折叠会把 current 设为 `assessment`——纠错 **不**永远压过未来事件。
- 若再次纠回 `rejected`，再追加一条 `stage_corrected`，不删除前两条。

### 10.7 桌面未安装 / 未运行 / 离线 / AI 宕机

| 场景 | 期望 |
| --- | --- |
| 未安装 | 填写、模板、插件 AI 与今天一致。保存入口说明安装；**不写 durable outbox**；不假装已保存 |
| 已安装未配对 | 同上填写。入口说明到桌面粘贴扩展 ID（Chrome/Edge 各一次）。**不写 durable outbox**。**不得**显示「未安装」 |
| 已安装已配对未运行 | host 按需启动 Tauri EXE（可隐藏）。成功则保存；失败则 durable 入队 +「待同步」，**禁止**显示「桌面已保存」 |
| 离线 | 桌面列表/详情/导入/待办/改阶段可用。插件 AI 走现有错误路径。**仅已配对**的保存请求入队 |
| AI 宕机 | 桌面建议失败开放。证据与手动改阶段不受影响。插件「取消 AI 等待（保留本地匹配）」保持 |

### 10.8 恢复档案后的旧插件队列

**设定：** 插件 outbox 有 `messageId=M1` 的 `job.save`，记录上盖着 `archiveId=A1, generation=3`。用户用该档案的备份恢复。

- 恢复预览 → 确认 → **解压到新档案目录**，current 指针切换，**`archiveId` 仍为 backup 中的 A1**，`generation` **必** 从 3 增到 4；旧目录保留为回滚点。
- 插件下次 **握手成功**，返回 `(A1, 4)`。握手不因 generation 变化失败。
- 插件比较 M1 上盖的 `(A1, 3)` ≠ 当前 `(A1, 4)` → **暂停**旧队列（不清掉存储）。
- UI 三选：
  - **关联：** 采用新握手身份；调用 `outbox.reconcile([M1,…])`；已在恢复库中的 messageId 不再重放；未包含的项需用户逐条确认后作为新写入（默认不自动重放）。
  - **丢弃：** 删除旧队列项，不写入。
  - **另存：** 把队列项当作对新 generation 的新申请（新 `messageId` 或用户确认的强制新写），仍走两层候选。
- **禁止** 把 generation=3 的项在用户确认前自动打进 generation=4。服务端幂等只防止确认后的重复提交。

---

## 11. UI 文案约束（产品级）

| 禁止 | 必须 |
| --- | --- |
| 「对方未回复」 | 「尚未导入回复证据」 |
| 「已通过筛选」（仅因回执） | 「已导入自动回执」 |
| 填写成功后自动显示「已投递」 | 「填写完成（未确认投递）」 |
| 「本地应用 = AI 全部离线」 | 使用云端模型时展示外发范围与服务商 |
| 未持久化应答显示「桌面已保存」 | 「待同步」/ 错误码 |
| 把未配对说成「未安装」 | 「请在桌面主程序粘贴扩展 ID」 |

空列表、存储失败、目录不可写必须可操作，禁止静默切到临时目录（D02）。

---

## 12. 最低环境与发行（产品口径）

| 项 | MVP 口径 |
| --- | --- |
| OS | Windows 10 22H2 或更新，64 位。Windows 11 含 WebView2；Win10 大多数已有 Runtime，安装器仍应能引导安装（见 ADR） |
| 浏览器 | Chrome / Edge **116+**（与当前 `minimum_chrome_version` 一致） |
| 权限 | 日常使用不要求管理员；per-user 安装 |
| 签名 | 未持有代码签名证书前 **不宣传已签名**；文档必须写明 SmartScreen 对未签名 `setup.exe` 的警告 |
| 离线 | 档案、导入、待办、手动阶段：可用。云端 AI：不可用并说明原因 |
| 插件分发 | 继续独立 ZIP；不装桌面也能填表 |

负载预期：单用户、一季秋招约数十至数百条申请，不是服务器 QPS。列表查询目标：数百条申请过滤/搜索在本地 **100 ms 量级**（D03/D04 验证，非 D01 实现）。

---

## 13. 风险（产品）

| 严重度 | 风险 | 缓解 |
| --- | --- | --- |
| 高 | 用户把填写成功当成已投递 | 默认 `saved`；独立确认；文案冻结 |
| 高 | 按公司自动合并导致通知串岗 | UUID 身份；候选提示；AI 强制消歧 |
| 中 | 未打包扩展 ID 漂移 / 把未配对当成未安装 | 桌面粘贴 ID；未配对单独降级且不入队 |
| 中 | 快照大于业务信封 | `snapshot.chunk`；> 2 MiB 拒绝；outbox 不存整 blob |
| 低 | 托盘图标被用户视为广告 | 负责人可关托盘；见开放问题 |

---

## 14. Open Questions

产品侧需负责人确认的项并入 [downstream-decisions.md](downstream-decisions.md#需要项目负责人选择)（填写留档默认范围、托盘、备份加密等）。本文不单开重复列表。

---

## 15. References

- Epic [#15](https://github.com/TshyGO/resume-form-assistant-plugin/issues/15)、D01 [#17](https://github.com/TshyGO/resume-form-assistant-plugin/issues/17)、D04 [#19](https://github.com/TshyGO/resume-form-assistant-plugin/issues/19)、D07 [#20](https://github.com/TshyGO/resume-form-assistant-plugin/issues/20)、D08 [#22](https://github.com/TshyGO/resume-form-assistant-plugin/issues/22)、D09 [#21](https://github.com/TshyGO/resume-form-assistant-plugin/issues/21)、D10 [#26](https://github.com/TshyGO/resume-form-assistant-plugin/issues/26)、D11 [#25](https://github.com/TshyGO/resume-form-assistant-plugin/issues/25)
- 当前插件：[`manifest.json`](../../manifest.json)、[`content.js`](../../content.js)、[`form-agent.js`](../../form-agent.js)、[`docs/ai-repeat-validation.md`](../ai-repeat-validation.md)
- 架构与隐私：[adr-architecture.md](adr-architecture.md)、[data-privacy.md](data-privacy.md)
