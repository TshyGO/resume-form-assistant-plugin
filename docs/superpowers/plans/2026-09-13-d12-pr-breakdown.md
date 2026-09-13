# D12 本地完整备份、恢复与回收 PR 拆分计划

> **For agentic workers:** 本文是 **PR 级拆分**，不是可直接执行的任务清单。每个 PR 开工时先用 superpowers:writing-plans 为该 PR 写 bite-sized 实现计划（存到 `docs/superpowers/plans/YYYY-MM-DD-d12-prN-<name>.md`），再用 superpowers:subagent-driven-development 或 superpowers:executing-plans 执行。

**Goal:** 用户能把整份求职档案——数据库、附件、简历快照、事件、待办——打成一个文件带走，在另一台机器或故障之后完整恢复；恢复过程可以预览、可以失败、可以退回，而且**绝不会**在半路把现有档案弄坏。

**Architecture:** 三层。一个不依赖 Tauri 的 `backup` crate 负责归档格式本身（清单、内容哈希、原子发布、解包校验、路径穿越防护）；`archive-store` 只多暴露一个「给我一份一致的数据库快照」和恢复切换要用的几个既有能力（`rotate_restore_epoch` 早就为 D12 备好了）；命令层负责编排——**先在独立 staging 里解压、校验、演练迁移，全过了再原子切换指针**，旧档案目录退休成回滚点。

**Tech Stack:** Rust（新 crate `backup`、`archive-store`、`src-tauri`）、`zip`、`sha2`、rusqlite 的 SQLite backup API、Tauri 2 命令层、TypeScript 前端。

**Spec 来源：** [#28](https://github.com/TshyGO/resume-form-assistant-plugin/issues/28)（范围与验收，含两轮 D01 修订）· [产品需求 §8.1](../../desktop-mvp/product-requirements.md) · [data-privacy §4、§6](../../desktop-mvp/data-privacy.md) · [ADR](../../desktop-mvp/adr-architecture.md) · [D10 拆分计划](2026-09-13-d10-pr-breakdown.md)

**基线：** `ddefc5b`（D10 六个 PR 与三条修复均已在 `main`）

---

## 已核实的外部事实（基线 ddefc5b，实现时直接用，不必再查）

**身份与指针（`archive-store/src/identity.rs`，D03 交付，已经是按 D12 设计的）：**

- `ArchiveIdentity { archive_id, restore_epoch }`，`mint()` 新铸一个 UUID epoch。
- `meta.json` 跟着**档案目录**走：`{ archiveId, schemaVersion, createdAt, displayName }`。**不含 restoreEpoch。**
- `current.json` 是**机器本地指针**：`{ archiveDir, archiveId, restoreEpoch }`，放在 `data_root`。文件头注释写得很清楚：**不进备份**。
- `atomic_write_json`：写 `.tmp-<uuid>` 再 rename。
- `ArchiveStore::rotate_restore_epoch()`（`store.rs:244`）已经存在，文档原话是「恢复/回滚流程(D12)在成功切换档案目录后调用：新铸 restoreEpoch」。**不要另写一个。** 它会先核对指针没被人改过，再原子写新指针。
- `ArchiveStore::open` 在「current 指针指向另一个目录」时直接报错，错误信息就是 `use a separate staging pointer for restore validation`——staging 这条路是设计里预留好的。

**目录布局（`data-service/src/paths.rs`）：**

| 路径 | 内容 | 进备份吗 |
| --- | --- | --- |
| `<data_root>/archive/` | `archive.db`、`meta.json` | 是 |
| `<data_root>/archive/attachments/` | `<yyyy>/<mm>/<sha16>-<安全名>` | 是 |
| `<data_root>/archive/snapshots/` | `<snapshotId>.json` | 是 |
| `<data_root>/archive/tmp/` | 临时文件 | 否 |
| `<data_root>/archive/backups/` | 迁移前的库备份 | 否 |
| `<data_root>/current.json` | 机器本地指针 + 当前 epoch | **否** |
| `<data_root>/settings.json` | 配对草稿等 | 见 Q3 |
| `<data_root>/logs/`、`cache_dir` | 日志与 WebView 缓存 | 否 |
| `<data_root>/archives-retired/` | 退休的旧档案（回滚点） | 否 |

**已经有的、可以直接用的：**

- 迁移前自动备份库文件（`migration.rs:46`，落在档案目录的 `backups/`），用的就是 SQLite backup API——**一致性快照不用重新发明**，把它抽成一个公开方法即可。
- `check_attachment_refs() -> AttachmentRefReport`（`evidence.rs:345`）：报告零引用 blob 与悬空引用，**只报告不删除**。D12 的孤立附件检查接这个。
- `purge_application(id) -> PurgeReport`（`applications.rs:539`）：永久删除。`set_recycle_state` 明确拒绝把状态写成 `Purged`，必须走 purge。
- `RecycleState` 已在模型里，列表支持按它过滤。

**还没有的：**

- **归档格式本身**——没有任何 zip/tar 依赖（`desktop/**/Cargo.toml` 里一个都没有）。
- 备份的写、读、校验、恢复、回滚，全部为零。
- 「回收站」界面。前端目前只有申请、收件箱、待办、设置四个视图。

**D10 留下的一个必须处理的交互：** `todos` 表上有 `reminder_state` / `reminder_handle` / `reminder_scheduled_for_utc`。它们是**本机投递状态**，句柄指向的是这台机器的 OS 计划。备份里带着它们、恢复到另一台机器上，就会出现「状态说已登记、实际什么都没有」，而且撤销时拿着一个不存在的句柄。**恢复后必须把这三列清零并按当前到期重新登记**——这正是 #28 验收里「提醒不会瞬间重复轰炸」那一条。

**测试命令：** `cargo test --manifest-path crates/<name>/Cargo.toml --locked`、`cargo test --manifest-path src-tauri/Cargo.toml --locked`、前端 `npm run typecheck` + `npm run test:ui`（**已经是 glob，新测试文件自动进**）。`.github/workflows/desktop.yml` 的作业列表是权威口径，新 crate 要在那里加一行。

---

## 架构决策

### 已定（PR 内落地；反对请在对应 PR 评论提）

**1. 归档格式与校验放独立 crate `desktop/crates/backup`。**
输入输出都是路径和字节，不依赖 Tauri、不依赖 rusqlite。数据库的一致性快照由 `archive-store` 生成成一个文件之后交给它。这样恶意归档、截断、哈希不符、磁盘失败这些情形可以用普通 `cargo test` 覆盖。

**2. 先 staging、后切换，中途失败一律不动现有档案。**
顺序固定：解压到 `<data_root>/archives-staging/<uuid>/` → 校验清单与每个文件的哈希 → 用 staging 自己的指针打开库、跑一遍迁移（演练）→ 全过之后才原子写 `current.json` 指向新目录 → `rotate_restore_epoch()` 新铸 epoch → 旧档案目录移进 `archives-retired/<时间戳>/`。**切换之前的任何一步失败，只删 staging，原档案与原指针一个字节都不动。**

**3. `current.json` 与当前 restoreEpoch 永不进备份。**
备份里带 `archiveId` 和业务回执里的历史 `sourceRestoreEpoch`（只读对账用），**不带**当前生效的 epoch。同一个备份恢复两次必须得到两个不同的 epoch（#28 的 D01 修订原话）。这条要有测试。

**4. 恢复后清空提醒记账并重新登记。**
`reminder_state` / `reminder_handle` / `reminder_scheduled_for_utc` 三列在恢复后一律清零，然后按每条待办当前的到期重新走一遍 D10 的登记。理由见上面那条「必须处理的交互」。`overdue_ack_at` **保留**——它记的是「这条已经跟用户说过了」，换台机器也仍然说过了。

**5. 排除项用显式清单，并由测试钉死。**
API Key、认证缓存、日志、`tmp/`、`backups/`、`cache_dir`、机器专属 native-host 路径一律不进包。清单写成常量 + 一条「往档案目录里塞一个不在清单里的文件，它不能出现在包里」的测试。参照插件那边 `plugin-release-assets.json` 的做法：**手写清单必须有守卫**，否则加东西的人忘了补就静默漏。

**6. 解包时防路径穿越，按内容而不是按条目名信任。**
每个条目名先归一化再校验：拒绝绝对路径、`..`、盘符、UNC、符号链接项、以及归一化之后跑出 staging 根目录的任何路径。清单里没列的条目一律不解。这条是 #28 验收点名的。

**7. 备份不加密，导出界面必须说明。**
data-privacy §6.3 已经定了 MVP 不加密，并且要求导出 UI 警告文件含 PII、应放在用户自己控制的位置。**不得在任何地方宣传「已加密」。** 措辞沿用插件端设置备份那次的口径。

**8. 恢复要先预览再确认。**
校验通过之后先给用户看：备份是什么时候的、里面有多少条申请/事件/快照/待办/附件、当前档案有多少、恢复之后会发生什么（切到新目录、旧目录退休成回滚点）。**用户点确认才切。**

**9. 回收不等于删除；永久删除只在无引用时清附件。**
回收后必须能恢复。永久删除走 `purge_application`，附件只有在 `check_attachment_refs` 报告零引用时才清理，**不确定的一律留着**。

**10. 卸载不碰用户数据。**
安装器归 D13，但这条约束现在就写进文档：卸载不得删除 `data_root` 或用户导出的备份文件。

### 需负责人确认（开工前拍板；未拍板按「推荐」执行）

| # | 问题 | 推荐 | 不选的代价 |
| --- | --- | --- | --- |
| Q1 | 归档格式 | **zip（`zip` crate，deflate）** | tar.zst 压得更小，但 Windows 上用户双击就能看包里有什么这件事更值钱——「用户可验证导出结果」是 #28 的验收项 |
| Q2 | `settings.json` 进不进包 | **进，但只进显式列出的键**（当前只有配对草稿的扩展 ID），其余丢弃 | 整份带走会把将来加的任何机器专属设置一起带走；整份不带则换机后要重新配一遍配对 |
| Q3 | 保留几个回滚点 | **最近 3 个**，超出的**只提示不自动删** | 自动删会在用户最需要的时候删掉那一个；无上限则档案目录无声膨胀 |
| Q4 | 备份文件放哪 | **用户选目录**（`tauri-plugin-dialog` 已在依赖里），默认文件名 `resume-pro-archive-<yyyymmdd-hhmm>.zip` | 固定放 `data_root` 里等于「备份和原件在同一块盘上」，磁盘坏了两个一起没 |
| Q5 | 恢复后旧的插件补传队列怎么办 | **暂停并提示**，不静默重放也不丢弃（#28 的 D01 修订原话：旧绑定队列盖章不符则暂停） | 静默重放会把旧 epoch 的消息灌进新档案；直接丢弃会让用户以为那些填写记录还在 |

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `desktop/crates/backup/src/lib.rs` | 对外入口：`write_archive(...)`、`read_manifest(...)`、`extract_to_staging(...)` |
| `desktop/crates/backup/src/manifest.rs` | 清单结构、格式版本、内容哈希、计数 |
| `desktop/crates/backup/src/writer.rs` | 打包：临时文件 → `sync_all` → 原子改名发布 |
| `desktop/crates/backup/src/reader.rs` | 解包与校验：哈希、大小、条目名归一化、路径穿越 |
| `desktop/crates/backup/src/exclude.rs` | 排除清单 + 守卫 |
| `desktop/crates/backup/tests/` | 往返、损坏、截断、恶意条目名、磁盘失败 |
| `desktop/crates/archive-store/src/store.rs` | 公开「一致性数据库快照到某个路径」 |
| `desktop/crates/archive-store/src/todos.rs` | 恢复后清空提醒记账 |
| `desktop/src-tauri/src/backup_commands.rs` | 导出、预览、恢复、回滚、回收站、永久删除 |
| `desktop/src/backup-ui.ts` / `backup.ts` | 设置页的备份与恢复、回收站视图 |
| `desktop/index.html` / `src/styles.css` | 结构与样式 |
| `.github/workflows/desktop.yml` | 新 crate 的测试作业 |
| `docs/desktop-mvp/data-privacy.md` | 备份包含项 / 排除项的权威清单 |

---

## PR 1 · `backup` crate：格式、清单与打包

**只做：** 把「一个档案目录 + 一份数据库快照文件」写成一个 zip，附一份清单。没有恢复、没有命令、没有界面。

**改动：** `manifest.json`（`formatVersion`、`createdAt`、`archiveId`、`schemaVersion`、每个条目的 `path`/`sizeBytes`/`sha256`、以及申请/事件/快照/待办/附件的计数）；写包走 `tmp → sync_all → rename`，失败不覆盖已有备份；排除清单与守卫。

**测试：** 往返（打包再列清单，条目与哈希一致）；排除项一个都不在包里；往档案目录塞一个清单外的文件，它不进包；写到只读目录时报错且不留半个文件；已有同名备份在失败时不被覆盖。

**验收关联：** #28「明确备份内容与排除项，用户可验证导出结果」「备份失败不覆盖已有有效备份」。

---

## PR 2 · 解包与校验

**只做：** 读一个包，判断它能不能用，并解到 staging。**不切换任何指针。**

**改动：** 校验顺序固定——格式版本 → 清单能解析 → 每个条目名归一化并防穿越 → 逐个文件比大小与 sha256 → 清单里没有的条目拒绝。任何一步失败返回带原因的错误，staging 目录整个删掉。

**测试：** 截断的包、改过一个字节的附件、清单里少一项、多一项、条目名是 `../../evil`、绝对路径、`C:\`、UNC、符号链接项、格式版本比我们新、空包；每一种都必须**拒绝且不留下 staging 残留**。

**验收关联：** #28「损坏/截断/不支持版本/路径穿越备份被拒绝，当前档案不改变」。

---

## PR 3 · 恢复、切换与回滚

**只做：** 编排。staging 校验通过 → 迁移演练 → 原子切换 → 新铸 epoch → 旧目录退休。

**改动：** 用 staging 自己的指针打开库跑一遍迁移（演练失败就当校验失败）；切换用 `atomic_write_json` 写 `current.json`；切换后调 `rotate_restore_epoch()`；旧档案目录移进 `archives-retired/<时间戳>/`；回滚是「把某个退休目录再恢复一次」，同样**新铸 epoch**（#28 的 D01 修订：回滚也是一次新切换）。清空 `todos` 的三列提醒记账。

**测试：** 同一个包恢复两次得到两个不同 epoch；切换前失败原指针不变、原库不动；切换后崩溃（模拟：写完指针立刻返回）再打开能识别到新档案；回滚回到旧档案且 epoch 又是新的；恢复后待办的 `reminder_state` 全是 `none`、`reminder_handle` 全空、`overdue_ack_at` 保留。

**验收关联：** #28「在全新目录恢复后数量一致」「恢复失败或磁盘满时原库和至少一个有效恢复点仍在」「恢复后提醒不会瞬间重复轰炸」。

---

## PR 4 · 命令层与恢复后的队列联动

**只做：** 把 PR 1–3 接到命令层，并处理插件那边的旧消息。

**改动：** `export_archive`、`preview_restore`（返回预览用的计数对比）、`restore_archive`、`list_rollback_points`、`rollback_to`。恢复之后旧 epoch 的插件消息按 Q5 处理：**暂停队列并给出可见提示**，不静默重放也不丢弃。历史回执里的 `sourceRestoreEpoch` 只读保留，用于对账，不作为写入授权。

**测试：** `commands_regression.rs` 覆盖导出→恢复→计数一致；恢复后拿旧 epoch 提交一条插件消息必须被拒绝且有明确错误码；预览的计数对得上；权限/磁盘错误有可操作的提示。

**验收关联：** #28「恢复后插件旧消息不会静默回灌」。

---

## PR 5 · 回收站与永久删除

**只做：** 回收后可恢复、永久删除只在无引用时清附件、孤立附件检查可见。

**改动：** 回收站视图（列出 `recycle_state` 非空的申请与证据，可恢复）；永久删除走 `purge_application` 并在删除前展示会连带删掉什么；`check_attachment_refs` 的结果做成一个「检查孤立附件」的按钮，**只报告，删除要用户逐项确认**。

**测试：** 回收→恢复→数据完好；永久删除后同一份字节被别的证据引用时附件不删；孤立报告列出的项与实际一致。

**验收关联：** #28 范围里的回收与附件清理条款。

---

## PR 6 · 界面与验收

**只做：** 设置页的备份与恢复、文案、走查记录。不加新功能。

**改动：** 设置页「备份与恢复」一段：导出（选目录、说明包含什么/排除什么、**明说不加密且含 PII**）、恢复（选文件 → 预览 → 确认）、回滚点列表。文案沿用插件端设置备份那次的口径。

**测试：** 前端假 DOM 覆盖预览与确认两步、拒绝时的错误展示、不加密提示必须出现。人工走查：导出 → 换一个 `RESUMEPRO_DATA_DIR` 启动 → 恢复 → 数量一致、历史能打开，记录贴进 #28。

**验收关联：** #28 全部六条 + 「不会因程序卸载而自动删除用户备份或数据」（文档条款，安装器在 D13 落实）。

---

## 验收对照表（写 PR 描述时直接引用）

| #28 验收 | 落在哪 | 证据形式 |
| --- | --- | --- |
| 全新目录恢复后数量一致、附件摘要一致、历史可打开 | PR 3、PR 4、PR 6 | 往返测试 + 命令回归 + 人工走查 |
| 损坏/截断/不支持版本/路径穿越被拒绝，当前档案不变 | PR 2 | 十种恶意/损坏输入的单测 |
| 恢复失败或磁盘满时原库和至少一个有效恢复点仍在 | PR 1、PR 3 | 切换前失败的单测 + 退休目录保留 |
| 恢复后插件旧消息不会静默回灌；提醒不会瞬间重复轰炸 | PR 3、PR 4 | 旧 epoch 消息被拒的回归 + 提醒记账清零的单测 |
| 明确备份内容与排除项，用户可验证导出结果 | PR 1、PR 6 | 排除清单守卫 + 清单可读 + 界面文案 |
| 不会因程序卸载而自动删除用户备份或数据 | PR 6（文档）、D13（落实） | data-privacy 条款 + 安装器脚本 |

---

## 风险

**这是目前为止最容易把用户数据弄坏的一块。** 所有设计都围绕一件事：**切换之前，现有档案一个字节都不动。** 每个 PR 的测试都要有对应的「失败之后原状不变」用例，不能只测成功路径。

**恢复后的 epoch 联动横跨 D05/D07/D08/D10 四块。** 插件队列、快照上传、待办提醒都会受影响。PR 3 和 PR 4 要一起看，单独看任何一个都容易漏掉一条路径。

**D12 关不掉，除非 D07（#20）与 D09（#21）的验收也有据可查。** #28 明写硬依赖不得先于本 issue 关闭；#21 已经由 #66 接手并关闭，#20 已关，但两者的人工走查记录要能拿得出来。

**它是 D13 的硬依赖。** 现在挂在「等 D13」上的那批验证（Windows AUMID 端到端、走查 10.11、真扩展 ID 的配对、上架前四条整改）都排在 D12 后面，所以这块拖多久，那批就跟着拖多久。
