# D10 手动待办、截止时间与本地提醒 PR 拆分计划

> **For agentic workers:** 本文是 **PR 级拆分**，不是可直接执行的任务清单。每个 PR 开工时先用 superpowers:writing-plans 为该 PR 写 bite-sized 实现计划（存到 `docs/superpowers/plans/YYYY-MM-DD-d10-prN-<name>.md`），再用 superpowers:subagent-driven-development 或 superpowers:executing-plans 执行。

**Goal:** 用户能给一条申请挂上「测评周五截止」「明天上午十点一面」这样的待办，在一个统一列表里看到所有待办与逾期项，并在授权之后由**操作系统**在到期时弹出通知——应用进程已经退出也照样弹。同时，界面在任何时候都如实告诉用户「提醒现在会不会响」，绝不拿「进程碰巧还活着」冒充日程。

**Architecture:** 存储层（D03）已经有 `todos` 表与 `create/get/update/complete/cancel/list` 六个方法，D10 只补它缺的四处（重新打开、按到期排序与过滤、提醒登记状态、OS 侧句柄），然后往上加三层：一个不依赖 Tauri 的 `reminders` crate（把「登记/撤销某条待办的提醒」翻译成平台调用，Windows 计划 Toast / macOS 日历触发 / 不支持时的 no-op），src-tauri 的命令层与到期计算，以及前端的待办视图。**前三个 PR 交付的是一个完全可用、零 OS 集成的待办功能**；平台调度是后面两个 PR 往同一个接口里填实现。

**Tech Stack:** Rust（`archive-store` 迁移、新 crate `reminders`、`src-tauri`）、rusqlite、`windows` crate（`ScheduledToastNotification`）、`objc2-user-notifications`（`UNCalendarNotificationTrigger`）、Tauri 2 命令层、TypeScript 前端（`tsc --noEmit` + `node --test --experimental-strip-types`）。

**Spec 来源：** [#26](https://github.com/TshyGO/resume-form-assistant-plugin/issues/26)（范围与验收）· [产品需求 §5.4 提醒与进程生命周期、§8.6 Todo、走查 10.11](../../desktop-mvp/product-requirements.md) · [ADR §3.8 提醒与后台（平台实现）](../../desktop-mvp/adr-architecture.md) · [data-privacy §4](../../desktop-mvp/data-privacy.md) · [#81](https://github.com/TshyGO/resume-form-assistant-plugin/issues/81)（第二投递通道，本期不做，但要留缝）· [D09 拆分计划](2026-09-12-d09-pr-breakdown.md)

**基线：** `462f548`（D09 六个 PR、设置备份 #77、扩展 ID 固定 #80 均已在 `main`）

---

## 已核实的外部事实（基线 462f548，实现时直接用，不必再查）

**存储层已经有的（`desktop/crates/archive-store/src/todos.rs`，274 行，D03 交付）：**

- 表 `todos`（`schema.rs:127`）：`id, application_id, title, due_precision, due_at_utc, due_date, time_zone, remind_at_utc, status, interview_round, source_event_id, created_at, updated_at`；`due_precision CHECK IN ('datetime','date','none')`；`status CHECK IN ('open','done','cancelled')`；索引 `idx_todos_app`、`idx_todos_status`。
- `create_todo(NewTodo)`：标题非空校验、`ensure_application`、`source_event_id` 必须属于同一申请、`remind_at_utc` 过 `parse_rfc3339` 归一、`interview_round >= 1`，写 `todo_created` 事件。
- `update_todo(id, TodoPatch)`：`TodoPatch { title, due, time_zone, remind_at_utc, interview_round }`，双层 `Option` 表达「不改 / 改成 None」。**不发阶段事件**（改期事件由调用方在同一事务里追加）。
- `complete_todo` / `cancel_todo`：走私有 `set_todo_status`，写 `todo_completed` / `todo_cancelled`；同状态重复调用是幂等的。
- `list_todos(application_id, status, due_before_utc, limit, offset)`。
- 模型：`TodoDue = DateTime(String) | Date(String) | None`（`model.rs:738`）、`TodoStatus = Open|Done|Cancelled`、`DuePrecision`、`Todo`、`NewTodo`。事件负载 `EventPayload::TodoCreated{todo_id,title}` / `TodoCompleted{todo_id}` / `TodoCancelled{todo_id}`。
- 已有测试：`archive-store/tests/storage.rs:765` `todo_date_precision_and_nullable_patch_survive_reopen`。

**存储层缺的四处（D10 必须补，PR 1）：**

1. **没有「重新打开」。** `set_todo_status` 是私有的，没有 `reopen_todo`，也没有 `EventPayload::TodoReopened`。#26 范围明写「重新打开」。
2. **`due_before_utc` 只认 datetime 精度**（`todos.rs:203`）：SQL 是 `due_precision = 'datetime' AND due_at_utc IS NOT NULL AND due_at_utc < ?`，**date 精度的待办永远不会出现在到期过滤里**，逾期汇总会漏掉它们。
3. **`ORDER BY created_at ASC`**（`todos.rs:216`）：待办列表按创建时间排，不是按到期排。
4. **没有任何列记录提醒的登记与送达状态**，也没有 OS 侧句柄。后果：改期撤不掉旧计划（#26 验收第 3 条）、逾期汇总每次打开都重报一遍（#26 范围「不连续弹出大量旧提醒」）。

**通知能力（已查证，这条决定了整个 PR 4/5 的形状）：**

- `tauri-plugin-notification` 的**桌面实现只支持立即弹出，没有 schedule**。其 `desktop.rs` 里的 `Notification` 结构只有 `body / title / icon / sound / identifier`，`show()` 立即投递。schedule 是移动端才有的。
- 而且这个插件**目前根本不在依赖里**。`desktop/src-tauri/Cargo.toml` 现有：`tauri 2 (features: tray-icon, image-png)`、`tauri-plugin-dialog`、`tauri-plugin-opener`、`tauri-plugin-single-instance`。
- **结论：OS 调度必须自己写**，不能指望插件。ADR §3.8 指定的两条路是 Windows `ScheduledToastNotification` 与 macOS `UNCalendarNotificationTrigger`。

**进程生命周期已经有的（D02，`src-tauri/src/lib.rs`）：**

- 托盘已建（`build_tray`，`lib.rs:825`），菜单两项「打开」「退出」；点退出会写 `APP_QUIT` 日志再 `app.exit(0)`。
- 关窗隐藏到托盘：`on_window_event` 拦 `CloseRequested`（`lib.rs:794`）；诊断里已有 `close_window_means: "hide-to-tray"`（`lib.rs:171`）。
- 设置页已有「窗口与退出」段落，含 `#btn-hide` / `#btn-quit` / `#btn-diag`（`desktop/index.html:169` 起）。
- **托盘退出与设置页退出是两个入口，PR 6 两个都要挂上「退出后不会弹提醒」的告知。**

**时间处理：** `archive-store` 用 `time` 0.3（features: formatting, parsing, macros），**没有 IANA 时区库**。`timeutil::Occurred` 有 `DateTime{rfc3339,time_zone} | Date{date,time_zone} | Unknown` 三态，`time_zone` 只是个字符串提示，没有人拿它做过换算。把「9 月 20 日（date 精度）+ Asia/Shanghai」换算成一个 UTC 时刻，现在做不到（见 Q1）。

**前端现状：** 导航已有 `data-route="todos"` 按钮（`index.html:17`），`#view-todos` 是空视图（`index.html:161`，文案「没有待办。」）。前端已全量 TypeScript：`desktop/src/*.ts`，`api.ts` 定义边界类型，`dom.ts` 提供 `must/maybe/input/select/dialog/valueOf`，UI 模块的模式是 `mountXxx(invoke)`，测试用 `.test.ts` 里的假 DOM harness。

**命令层现状：** `commands.rs` 的 `ApplicationView { application, events, snapshots, snapshot_states, evidence }` —— **还没有 todos**，PR 3 要加。命令注册在 `lib.rs` 的 `generate_handler!`，回归测试在 `commands_regression.rs`（现 76 个）。

**测试命令：** `cargo test --manifest-path crates/<name>/Cargo.toml --locked`、`cargo test --manifest-path src-tauri/Cargo.toml --locked`、前端 `npm run typecheck` + `npm run test:ui`。`.github/workflows/desktop.yml` 的作业列表是权威口径，**新 crate 要在那里加一行**。

---

## 架构决策

### 已定（PR 内落地；反对请在对应 PR 评论提）

**1. 提醒调度放独立 crate `desktop/crates/reminders`，不进 archive-store，也不进 src-tauri。**
它只认三个动词：`schedule(ReminderRequest) -> ScheduledHandle`、`cancel(&ScheduledHandle)`、`capability() -> Capability`。不依赖 Tauri、不依赖 rusqlite，因此平台无关的部分（时刻计算、句柄编解码、状态机）可以用普通 `cargo test` 覆盖。平台实现走 `#[cfg(target_os)]`，第三个实现是 `Unsupported`（返回明确的原因，不是静默失败）。

**2. 这个接口就是 [#81](https://github.com/TshyGO/resume-form-assistant-plugin/issues/81) 要求留的缝。**
业务层永远只说「登记 / 撤销某条待办的提醒」，不认识 Toast、不认识 webhook。以后加邮件或飞书机器人是多写一个实现，不用回头改。**禁止**在命令层或前端出现 `Toast`、`ScheduledToastNotification` 这类词。

**3. 「已登记」「已送达」「已汇总」是三件事，都要落库。**
新增列：`reminder_scheduled_for_utc`（登记时算出的绝对时刻）、`reminder_handle`（OS 侧句柄，Windows 是 tag/group，macOS 是 request identifier）、`reminder_state`（`none | scheduled | fired | missed | unsupported`）、`overdue_ack_at`（逾期汇总已经报过一次的时间）。逾期汇总只挑「已过期 + status=open + `overdue_ack_at` 为空」的，报完写上时间，**所以打开十次不会报十次**。

**4. date 精度的待办不补零点。**
`TodoDue::Date` 保持 date 精度**不变**。用户如果要为它设提醒，必须显式给一个提醒时刻，写进 `remind_at_utc`（默认预填当天 09:00 本地，可改，见 Q3）。「不知道几点」和「早上九点提醒我」是两条独立信息，界面上也要分开呈现，不能让设了提醒就把 due 悄悄变成 datetime。

**5. 没有提醒也必须完整可用。**
未授权通知 / 未启用后台提醒 / 用户已退出 / 平台不支持——这四种情况下，待办的增删改查、统一列表、逾期汇总**全部照常**。系统通知是增强，不是前提（§5.4「未授权通知：必须仍可用」）。

**6. 主动退出默认撤销未触发的计划，且退出前告知。**
托盘「退出」与设置页「退出应用」两个入口都要先弹一句「退出后不会弹出提醒」。这不是可选的礼貌，是 §5.4 点名的要求。关窗（隐藏到托盘）**不撤销**。

**7. 不注册开机启动，不拿进程存活冒充日程。**
不写 Run 键、不建保活计划任务、不加 Login Item。代码里不允许出现「只要进程还在就 setTimeout 到明天早上」这种实现——一条都不许有。

**8. 通知内容默认最小化。**
标题是公司 + 岗位，正文是待办标题。**不带**简历正文、不带邮件正文、不带证据摘录（data-privacy §4，走查 10.11 明写「标题含公司/岗位，无简历正文」）。

**9. Windows 的 5 分钟投递窗口要写进界面。**
设置页启用后台提醒的地方必须写明：关机时间过长时这条提醒可能不会送达，打开应用会补一次汇总。**不得**在任何地方承诺「关机期间也一定送到」。

**10. D11 走同一套命令建待办。**
命令层暴露的建待办入口就是将来 AI 确认后要调的那个，**不允许** D11 另写一套调度。#26 验收第 5 条明写这一点，PR 3 的命令签名要按「人工创建」和「由某个事件创建」两种来源都能走通来设计（`source_event_id` 存储层已经支持）。

### 需负责人确认（开工前拍板；未拍板按「推荐」执行）

| # | 问题 | 推荐 | 不选的代价 |
| --- | --- | --- | --- |
| Q1 | 时区换算 | **加 `time-tz`（IANA 数据库）**，把「日期 + 时区 + 时刻」算成 UTC 绝对时刻 | 只用固定偏移的话，跨夏令时的提醒会差一小时；而 Windows 的 `ScheduledToastNotification` 收的是绝对时刻，必须我们自己算对。（macOS 的 `UNCalendarNotificationTrigger` 收的是 wall-clock `DateComponents`，DST 由系统处理，天然正确——两端行为不一致本身也要测） |
| Q2 | Windows 未打包应用能不能弹计划 Toast（ADR 标注的 **V9 待验证**） | **PR 4 开工前先做一个一次性 spike**：装一个带 AUMID 的开始菜单快捷方式，用 `windows` crate 调 `ToastNotificationManager::CreateToastNotifierWithId(aumid)` + `AddToSchedule`，验证杀掉进程后到点是否弹出。结论写进 ADR §3.8 | 直接开工可能写完才发现未打包应用弹不出来。**退路要提前想好**：Windows 上先只做「应用运行时提醒 + 打开时逾期汇总」，并在设置页如实说明，而不是假装登记成功 |
| Q3 | date 精度待办的默认提醒时刻 | **当天 09:00 本地**，输入框预填、可改、可清空 | 不给默认值等于每条 date 待办都要手填时刻，多数人会干脆不设提醒 |
| Q4 | 要不要「提前 N 分钟提醒」 | **MVP 不做**。一条待办只有一个提醒时刻，就是 `remind_at_utc` | 提前量会和 `due` 纠缠出四种组合（datetime+提前、date+提前……），是本期最容易把时间语义搞乱的一块。想提前就把提醒时刻往前填 |
| Q5 | macOS 的 `UN*` 怎么调 | **`objc2-user-notifications`**（objc2 生态，纯 Rust 绑定） | 手写 `objc` 消息发送容易在 ARC 语义上出错；而且 `UNUserNotificationCenter.current()` 在**未打包**的二进制里会直接崩，dev 下必须走 `Unsupported` 分支——这条无论选什么绑定都要处理 |

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `desktop/crates/archive-store/src/todos.rs` | 补 `reopen_todo`；`list_todos` 改成按到期排序、date 精度也参与到期过滤；提醒登记状态的读写 |
| `desktop/crates/archive-store/src/model.rs` | `EventPayload::TodoReopened`；`Todo` 增加提醒登记字段；`ReminderState` 枚举 |
| `desktop/crates/archive-store/src/schema.rs` | 新迁移：`todos` 增加 4 列 + 到期索引 |
| `desktop/crates/reminders/src/lib.rs` | `ReminderScheduler` trait、`ReminderRequest`、`ScheduledHandle`、`Capability`、平台选择 |
| `desktop/crates/reminders/src/plan.rs` | 平台无关的时刻计算：due + 时区 + 提醒时刻 → UTC 绝对时刻；过期判定；句柄编解码 |
| `desktop/crates/reminders/src/windows.rs` | `ScheduledToastNotification` 登记与撤销（`#[cfg(windows)]`） |
| `desktop/crates/reminders/src/macos.rs` | `UNCalendarNotificationTrigger` 登记与撤销（`#[cfg(target_os = "macos")]`） |
| `desktop/crates/reminders/src/unsupported.rs` | 兜底实现：返回带原因的 `Capability::Unavailable`，不静默成功 |
| `desktop/crates/reminders/tests/` | 时刻计算、跨 DST、句柄往返、过期判定 |
| `desktop/src-tauri/src/todo_commands.rs` | 建/改/完成/取消/重开、统一列表、逾期汇总、提醒开关与授权状态 |
| `desktop/src-tauri/src/commands.rs` | `ApplicationView` 增加 `todos` |
| `desktop/src-tauri/src/lifecycle.rs` | 退出前撤销未触发的计划 |
| `desktop/src/todos.ts` | 纯函数：分组（逾期/今天/本周/以后/已完成）、到期文案、五种提醒状态的文案映射 |
| `desktop/src/todos-ui.ts` | 待办视图：列表、新建/编辑表单、完成/取消/重开、逾期汇总条 |
| `desktop/src/applications-ui.ts` | 申请详情里的待办区 |
| `desktop/index.html` / `desktop/src/styles.css` | `#view-todos` 的真实结构；设置页的后台提醒开关与说明 |
| `desktop/src/*.test.ts` | 前端测试（沿用假 DOM harness） |
| `.github/workflows/desktop.yml` | `reminders` crate 的测试作业 |
| `docs/desktop-mvp/adr-architecture.md` | Q2 spike 的结论回填到 §3.8 |

---

## PR 1 · 存储层补齐：重开、按到期排序、提醒登记状态

**只做：** `archive-store` 内部。没有命令、没有界面、不碰任何平台 API。

**改动：**

- 迁移（新版本号，走既有 `MIGRATIONS` 机制，迁移前自动备份已由 `migration.rs` 保证）：`todos` 增加 `reminder_scheduled_for_utc TEXT`、`reminder_handle TEXT`、`reminder_state TEXT NOT NULL DEFAULT 'none' CHECK (reminder_state IN ('none','scheduled','fired','missed','unsupported'))`、`overdue_ack_at TEXT`；新增索引 `idx_todos_due`。
- `reopen_todo(id)`：`Done`/`Cancelled` → `Open`，写新的 `EventPayload::TodoReopened { todo_id }`；已经是 `Open` 时幂等返回。
- `list_todos` 排序改为「先按有无到期、再按到期时刻、最后按创建时间」；`due_before_utc` 过滤要覆盖 **date 精度**——date 精度用 `due_date` 与传入时刻所在日历日比较，**不**把 `due_date` 当成当天零点去比。
- `set_todo_reminder(id, ReminderState, scheduled_for, handle)` 与 `ack_overdue(ids, now)`：只写这几列，不发事件（提醒是本机投递状态，不是申请历史）。

**测试：** date 精度待办出现在逾期过滤里；datetime 与 date 混排的顺序；重开后 `status`/事件都对、重开再完成不重复发事件；`reminder_state` 的每种取值往返；`ack_overdue` 之后同一条不再出现在待汇总集合里；迁移在有数据的旧库上跑通且备份存在。

**验收关联：** #26 验收 1（重启后仍在）的存储侧、验收 3（改期不残留旧计划）的记账基础。

---

## PR 2 · `reminders` crate：调度接口与时刻计算

**只做：** 一个不依赖 Tauri、不依赖数据库的 crate。**本 PR 不写任何平台实现**，只有接口、平台无关的时刻计算，和 `Unsupported` 兜底。

**改动：**

- `ReminderRequest { todo_id, title, company, position, fire_at_utc, time_zone }`——注意这里**已经是绝对时刻**，换算在 `plan.rs` 里完成，平台实现不做时间语义。
- `plan.rs`：`fire_at(due, time_zone, remind_at_utc, default_time_of_day) -> Option<OffsetDateTime>`。规则：`remind_at_utc` 有值就直接用；没有值时，datetime 精度用 due 本身，date 精度用「当天 + 默认时刻 + 时区」（Q1 的时区库在这里用），`none` 精度返回 `None`（没有到期就没有提醒）。
- `Capability::{ Available, Unavailable { reason } }`，`reason` 是给用户看的一句话（未授权 / 平台不支持 / 未打包）。
- `ScheduledHandle` 的编解码（存进 `reminder_handle` 一列，所以要能来回转字符串）。

**测试：** 跨夏令时的 date 待办（选一个真有 DST 的时区，验证前后两天的绝对时刻差不是恒定 24h）；`none` 精度不产生提醒；显式 `remind_at_utc` 覆盖默认；已过去的时刻返回「不再登记」而不是登记到过去；句柄字符串往返；`Unsupported` 返回的是带原因的失败而不是 `Ok`。

**验收关联：** #26 验收 2（日期与时区正确、跨日与夏令时有确定行为）。

---

## PR 3 · 命令层与待办界面：不依赖系统通知的完整功能

**只做：** 把 PR 1/2 接到命令层和前端。**这个 PR 合完，待办功能就是完整可用的**，只是提醒还只会在应用打开时以逾期汇总的形式出现。

**改动：**

- `todo_commands.rs`：`create_todo`、`update_todo`、`complete_todo`、`cancel_todo`、`reopen_todo`、`list_todos`（统一列表，支持按状态过滤）、`overdue_digest`（拉取待汇总项并 ack）。字段用 `rename_all = "camelCase"`，与 D08/D09 一致。
- `ApplicationView` 增加 `todos`。
- `desktop/src/todos.ts`：分组与文案纯函数。分组是「逾期 / 今天 / 本周 / 以后 / 无到期 / 已完成」。到期文案要区分三种精度：datetime 显示到分钟并带时区、date 只显示日期、none 显示「未设到期」——**绝不**把 date 显示成「00:00」。
- `desktop/src/todos-ui.ts` + `#view-todos` 的真实结构：列表、新建/编辑表单（标题、关联申请、到期精度三选一、时区、提醒时刻、面试轮次）、完成/取消/重开按钮、顶部逾期汇总条。
- 申请详情里的待办区。

**测试：** 前端假 DOM harness 覆盖分组边界（刚好今天 23:59 / 明天 00:00）、三种精度的文案、改期后表单回填、完成后从「今天」移到「已完成」、逾期汇总条出现一次后不再出现。`commands_regression.rs` 覆盖命令层往返与 `ApplicationView.todos`。

**验收关联：** #26 验收 1（重启后仍在、完成后不再提醒）、验收 5（D11 可走同一接口——本 PR 定下命令签名）。

---

## PR 4 · Windows：计划 Toast

**前置：** Q2 的 spike 必须先出结论并回填 ADR §3.8。spike 不合入产品代码。

**只做：** `reminders/src/windows.rs`。

**改动：** `ToastNotificationManager::CreateToastNotifierWithId(aumid)` + `AddToSchedule`；撤销走 `GetScheduledToastNotifications()` 找 tag/group 再 `RemoveFromSchedule`。AUMID 与安装期的开始菜单快捷方式绑定（这一块与 D13 的安装器有交集，**本 PR 只负责运行期，安装期的快捷方式注册记到 [#29](https://github.com/TshyGO/resume-form-assistant-plugin/issues/29)**）。未拿到有效 AUMID 时返回 `Capability::Unavailable { reason }`，**不**假装登记成功。

**测试：** 能自动化的部分（句柄格式、撤销时的匹配逻辑、AUMID 缺失时的降级）走单测；「杀进程后到点弹出」是人工走查，步骤写进 PR 描述，结果贴进 #26。

**验收关联：** ADR §3.8「D10 验收：杀掉应用进程，到期仍应尽量弹出」的 Windows 侧。

---

## PR 5 · macOS：日历触发

**只做：** `reminders/src/macos.rs`。

**改动：** `UNUserNotificationCenter.current()` + `requestAuthorization` + `UNCalendarNotificationTrigger(dateMatching:repeats:false)` + `add(UNNotificationRequest)`；撤销走 `removePendingNotificationRequests(withIdentifiers:)`。**未打包运行（`cargo run` 直接跑二进制）时 `current()` 会崩**，必须先判断是否有 bundle identifier，没有就走 `Unsupported`——这条要有测试或至少有明确的早退分支。

注意与 Windows 的语义差异：这里传的是 wall-clock `DateComponents`，DST 由系统处理；Windows 传的是绝对时刻，由我们算。两边对同一条待办应当产生同一个本地墙钟时间，PR 2 的 `plan.rs` 要为这个差异提供两种输出（绝对时刻 + 墙钟分量），测试要把两者对齐。

**验收关联：** 同上，macOS 侧。ADR §3.8 的「macOS 日历触发在重启后通常仍在（待验证）」也在这个 PR 里验证并回填。

---

## PR 6 · 五种状态如实告知 + 验收

**只做：** 文案、设置页、退出流程与验收记录。不加新功能。

**改动：**

- 设置页新增「后台提醒」段落：开关、当前授权状态、当前 `Capability`（不可用时显示原因原文）、**Windows 5 分钟投递窗口的说明**。
- 托盘「退出」与设置页「退出应用」两个入口，退出前告知「退出后不会弹出提醒」，并撤销未触发的计划（`lifecycle.rs`）。
- 关窗（隐藏到托盘）时**不**撤销，设置页要说清关窗与退出的区别（现有「窗口与退出」段落已经在说进程模型，这里补提醒的部分）。
- 待办列表顶部按当前状态显示一句话，五种状态五句话，措辞对照 §5.4 与走查 10.11 的「用户看见」列。
- 走查 10.11 的人工记录：今天 21:00 建「一面，明天 10:00」→ 启用后台提醒并授权 → 关窗 → 杀进程 → 次日到点。结果贴进 #26。

**验收关联：** #26 验收 4（提醒失败不影响保存，用户能看到原因）、走查 10.11 全部。

---

## 验收对照表（写 PR 描述时直接引用）

| #26 验收 | 落在哪 | 证据形式 |
| --- | --- | --- |
| 手动创建测评截止/面试事项，重启后仍在，完成后不再提醒 | PR 1、PR 3、PR 4/5 | 存储单测 + 命令回归 + 完成时撤销计划的单测 |
| 日期与时区正确显示，跨日和夏令时有确定行为 | PR 2、PR 3 | `plan.rs` 的跨 DST 单测 + 前端三种精度文案测试 |
| 修改/取消待办不会残留旧通知计划 | PR 1、PR 4/5 | `reminder_handle` 记账单测 + 平台撤销逻辑单测 |
| 提醒失败不影响保存，用户能看到未授权或后台未运行的原因 | PR 2、PR 6 | `Capability::Unavailable{reason}` 单测 + 设置页文案测试 |
| D11 可通过同一业务接口创建待办，不另写调度器 | PR 3 | 命令签名支持 `sourceEventId`；`reminders` crate 不被 D11 直接依赖 |
| ADR §3.8：杀进程后到期仍尽量弹出 | PR 4、PR 5 | 人工走查记录贴 #26 |
| 走查 10.11 全流程 | PR 6 | 人工走查记录贴 #26 |

---

## 风险

**Q2 是本期唯一可能推翻架构的未知。** 如果未打包的 Tauri 应用在 Windows 上弹不出计划 Toast，PR 4 就要换成「运行时提醒 + 逾期汇总」，并且设置页文案要如实降级。**PR 1–3 完全不受影响**，这是把平台调度排在后面的原因。

**macOS 需要真机。** PR 5 的验证和 #16（D02）卡的是同一件事——没有 Mac 就只能停在「代码写完、CI 编译过、行为未验证」，PR 描述里要如实标注，不能算验收通过。

**时区库是新依赖。** Q1 若批准，`time-tz` 会进桌面端依赖树，`Cargo.lock` 变动要在 PR 2 里单独说明。

**D10 关不掉，除非 #19（D04）先验收。** #26 明写「不得先于硬依赖验收关闭」，而 #19 卡在人工走查上。代码可以照做，关 issue 要等那一步。
