# D09 回复证据收件箱 PR 拆分计划

> **For agentic workers:** 本文是 **PR 级拆分**，不是可直接执行的任务清单。每个 PR 开工时先用 superpowers:writing-plans 为该 PR 写 bite-sized 实现计划（存到 `docs/superpowers/plans/YYYY-MM-DD-d09-prN-<name>.md`），再用 superpowers:subagent-driven-development 或 superpowers:executing-plans 执行。

**Goal:** 用户把回复邮件、截图、PDF 或一段粘贴的文本交给桌面程序之后，原件被安全地复制进档案目录、可以离线预览、可以手动关联到某条申请并确认它是什么类型的通知——全程不需要 AI，也不会因为「导入了一封信」就改变申请阶段。

**Architecture:** 存储层（D03）已经能登记证据与附件 blob 并投影 `replyEvidenceState`，所以 D09 只做三层：一个不依赖 Tauri 的 `evidence-import` crate（安全文件名、哈希、类型嗅探、`.eml` 解析、原子落盘），src-tauri 的命令层（导入、收件箱列表、预览、关联/取消关联、分类），以及桌面前端的收件箱视图与申请详情里的证据区。字节只经过 Rust；WebView 只拿到已经清洗过的文本和受控的预览数据。

**Tech Stack:** Rust（新 crate `evidence-import`、`src-tauri`、`archive-store`）、rusqlite、`mail-parser`（新依赖，解析 `.eml`）、`infer`（已在 lock 中，类型嗅探）、Tauri 2 命令层、原生 JS 前端 + `node --test`。

**Spec 来源：** [#66](https://github.com/TshyGO/resume-form-assistant-plugin/issues/66)（本次范围与验收）· [#21](https://github.com/TshyGO/resume-form-assistant-plugin/issues/21)（原始 D09 范围，仍然有效）· [产品需求 §6.3、§7、§8.4、§9、§11、走查 10.1 / 10.2 / 10.5 / 10.13 / 10.16 / 10.20](../../desktop-mvp/product-requirements.md) · [data-privacy §4、§5、§6](../../desktop-mvp/data-privacy.md) · [D07 拆分计划](2026-09-09-d07-pr-breakdown.md) · [D08 拆分计划](2026-09-11-d08-pr-breakdown.md)

**基线：** `d91137b`（D08 七个 PR 与 #58 已在 `main`）

---

## 已核实的外部事实（基线 d91137b，实现时直接用，不必再查）

**存储层已经有的（`desktop/crates/archive-store/src/evidence.rs`，D03 交付）：**

- `import_evidence(NewEvidence) -> ReplyEvidence`：校验 `stored_rel_path`（`validate_rel_path` 拒绝绝对路径、`..`、盘符、UNC）与 `sha256`（64 位十六进制）；`attachment_blobs` 按 `sha256` upsert（同字节不重复登记）、`ref_count` 自增；`application_id` 为 `None` 时进收件箱，事件用档案级 `inbox_event_sequence`（`tx.rs:246`），不参与任何申请的阶段折叠。
- `associate_evidence(evidence_id, to_application)`：写 `evidence_associated` 或 `association_changed` 事件，并对新旧申请各调用一次 `recompute_reply_state`。**没有「取消关联」**，PR3 要补。
- `classify_evidence(evidence_id, reply_class, send_mode)`：写 `evidence_classified` 事件并重算投影。
- `get_evidence(id)`、`list_evidence(application_id: Option<&str>)`（SQL 是 `WHERE application_id IS ?1`，传 `None` 就是收件箱）、`check_attachment_refs()`（零引用 blob 与悬空引用，只报告不删除）。
- `recompute_reply_state`（`tx.rs:265`）实现 §6.3 的投影，`import` / `associate` / `classify` / AI 建议确认都会调用它。**D09 不要自己算这个状态，读 `applications.reply_evidence_state` 即可。**

**模型（`model.rs`）：** `EvidenceKind = eml | screenshot | pdf | paste | unknown`；`ReplyClass = auto_ack | assessment_invite | interview_invite | action_required | offer | reject | other | unknown`；`SendMode = human | automated | unknown`；`ReplyEvidence { id, application_id, kind, reply_class, send_mode, blob{sha256,size_bytes,stored_rel_path,ref_count,mime}, original_filename, imported_at, subject, from_addr, sent_at, body_extract }`；`ReplyEvidenceState = none_imported | imported_unclassified | auto_ack | classified | mixed`。

**目录：** `data-service` 的 `HostPaths::attachments_dir = <archive>/attachments`，已纳入启动时的可写探针（`paths.rs:19/55/73`）。

**WebView 安全基线（`desktop/src-tauri/tauri.conf.json:26`）：**
`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost`
→ 远程图片、远程脚本、远程字体、`fetch` 到外网**已经被 CSP 挡住**；`data:` 图片可用；`object-src` 继承 `default-src`，所以 `<embed>`/`<object>` 只能加载 `'self'`，**内嵌 PDF 需要显式放宽 CSP**（见 Q2）。

**前端现状：** `desktop/index.html` 已有 `#view-inbox` 的空视图（文案「证据收件箱尚未接入」）；`desktop/src/main.js` 负责路由与设置页；`desktop/src/applications-ui.js` 的模式是 `mountApplications(invoke)`，测试用 `applications-ui.test.js` 里的假 DOM harness（`document.getElementById` 打桩 + `invoke` 打桩），没有浏览器依赖。命令实现在 `desktop/src-tauri/src/commands.rs`，注册在 `lib.rs` 的 `generate_handler!` 列表，回归测试在 `commands_regression.rs`。

**依赖现状：** `Cargo.lock` 已含 `infer`（类型嗅探）与 `mime`，**没有**邮件解析库；`src-tauri/Cargo.toml` 里**没有** `tauri-plugin-dialog`、也没有 `tauri-plugin-opener`。

**测试命令：** 桌面 Rust `cargo test --manifest-path crates/<name>/Cargo.toml --locked`、`cargo test --manifest-path src-tauri/Cargo.toml --locked`；前端 `node --test src/*.test.js`（`.github/workflows/desktop.yml` 的作业列表就是权威口径，新 crate 要在那里加一行）。

---

## 架构决策

### 已定（PR 内落地；反对请在对应 PR 评论提）

**1. 导入逻辑放独立 crate `desktop/crates/evidence-import`，不进 archive-store。**
D03 明确「只登记元数据，不写文件、不做导入」。新 crate 不依赖 Tauri、不依赖 rusqlite，输入是路径与字节、输出是「已经安全落盘的 blob 元数据 + 解析出的邮件头/正文」，因此可以用普通 `cargo test` 覆盖恶意文件名、损坏邮件、磁盘失败这些情形。

**2. 先落文件、再登记数据库，失败留可回收的临时文件而不是半份记录。**
顺序固定：写 `attachments/.tmp-<uuid>` → `sync_all` → 计算 sha256（边写边算）→ 若同 sha 的 blob 已在库里则删除临时文件、复用既有 `stored_rel_path` → 否则 rename 到最终名 → 调 `import_evidence` 登记。任何一步失败都删除临时文件；rename 之后、登记之前崩溃会留下一个没有引用的文件，由 `check_attachment_refs` 报告（D12 清理），**绝不会出现「库里有记录、文件不在」**。

**3. 存储路径与文件名。**
`attachments/<yyyy>/<mm>/<sha256 前 16 位>-<安全文件名>`，安全文件名规则：只保留 Unicode 字母/数字/`.`/`-`/`_`/空格与常见 CJK，其余替换为 `_`；去掉前后空白与点；砍到 80 字符（保留扩展名）；Windows 保留名（`CON`/`PRN`/`AUX`/`NUL`/`COM1..9`/`LPT1..9`）前加 `_`；空名回退为 `evidence`。冲突时加 `-2`、`-3`……**不覆盖**（data-privacy 明确要求）。`sourcePathHint` 只在导入函数的参数里存在，不写入任何结构体字段、不进日志。

**4. 类型判定按内容而不是扩展名。**
`infer` 嗅探字节 → `image/png`、`image/jpeg`、`application/pdf`；`.eml` 由「能解析出至少一个邮件头」判定；粘贴文本走 `paste`；其余 `unknown`。扩展名只用来在两者一致时确认，不作为唯一依据（伪装成 `.png` 的 PDF 按 PDF 处理并提示）。

**5. 邮件解析用 `mail-parser`，正文提取为纯文本。**
优先 `text/plain` 部件；没有就把 `text/html` 转成文本（去标签、保留链接文本形式 `文字 <URL>`）。`bodyExtract` 上限 64 KiB（超出截断并标注）。原始 `.eml` 字节始终保留在附件目录，将来要做清洗后的 HTML 渲染不需要重新导入。

**6. 预览数据由 Rust 组装，WebView 不碰路径。**
`get_evidence_preview_cmd` 返回 `{ kind, mime, sizeBytes, subject, fromAddr, sentAt, bodyExtract, imageDataUrl?, note? }`。图片 ≤ 8 MiB 时才生成 `data:` URL（CSP 允许 `img-src data:`），更大只给元数据与说明。**前端拿不到 `stored_rel_path`，也拿不到绝对路径**（与 D08 快照的做法一致）。

**7. 分类是两个独立字段，文案不得互相投影。**
界面必须分两栏：「通知类型」（`replyClass`）与「发送方式」（`sendMode`）。默认 `sendMode = unknown`，不因为选了「面试邀请」就写 `human`（§6.3、走查 10.13）。列表里 `classified` 不得写成「已导入人工回复」。

**8. 关联后未分类 = `imported_unclassified`，界面禁止显示「尚未导入回复证据」；取消关联后才回到 `none_imported`（走查 10.20）。** 状态由存储层投影，前端只做文案映射。

**9. 导入不改阶段。**
D09 只写 `evidence_*` 事件，永远不写阶段事件；界面上导入成功的提示必须是「已导入，待分类」而不是任何暗示对方回复结果的说法（§11）。

**10. 离线是常态，不是降级。**
整条链路没有任何网络调用；CSP 已经挡住远程资源，代码里也不得新增 `fetch`/`connect-src` 例外。

### 需负责人确认（开工前拍板；未拍板按「推荐」执行）

| # | 问题 | 推荐 | 不选的代价 |
| --- | --- | --- | --- |
| Q1 | 选择文件的方式 | **加官方 `tauri-plugin-dialog`**，原生对话框给路径，字节由 Rust 读 | 用 `<input type="file">` 要把整份字节经 IPC 传进 Rust，25 MiB 的 PDF 会明显卡顿，还要在 JS 里处理二进制 |
| Q2 | PDF 预览 | **MVP 不内嵌**：显示文件名/大小/页数未知，并给「用系统程序打开本机副本」（加 `tauri-plugin-opener`），按钮旁写明这会离开应用沙箱 | 内嵌要放宽 CSP 的 `object-src` 并配置 asset 协议 scope，等于为了预览削弱唯一一道现成的防线 |
| Q3 | 单份附件大小上限（文档没写死） | **25 MiB**，超过明确拒绝并说明；一次导入最多 20 个文件 | 不设限时一份几百 MB 的 PDF 会把哈希、复制和备份（D12）一起拖垮 |
| Q4 | HTML 邮件的展示 | **MVP 只渲染纯文本**，链接以文本形式显示、不可点击；另给「查看原始来源」按钮展示 `.eml` 的头部信息 | 直接渲染清洗后的 HTML 需要一个可信的清洗器与一套注入测试，是本期最容易出安全事故的一块 |

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `desktop/crates/evidence-import/src/lib.rs` | 对外入口：`stage_file(...)`、`stage_text(...)` → `StagedBlob { sha256, size_bytes, stored_rel_path, mime, kind, original_filename }` |
| `desktop/crates/evidence-import/src/names.rs` | 安全文件名、冲突加后缀、Windows 保留名、路径拼装 |
| `desktop/crates/evidence-import/src/sniff.rs` | `infer` 嗅探 + 扩展名一致性 → `EvidenceKind` / MIME |
| `desktop/crates/evidence-import/src/eml.rs` | `.eml` 解析：主题、发件人、发送时间、正文提取、编码与转发/引用 |
| `desktop/crates/evidence-import/tests/` | 合成夹具与恶意输入用例 |
| `desktop/src-tauri/src/evidence_commands.rs` | 导入、收件箱列表、预览、关联/取消关联、分类五组命令 |
| `desktop/src-tauri/src/commands.rs` | `ApplicationView` 增加该申请的证据列表（只读视图，不含路径） |
| `desktop/crates/archive-store/src/evidence.rs` | 新增 `unassociate_evidence`（写 `association_changed` 的取消形态并重算投影） |
| `desktop/src/inbox.js` | 纯函数：列表分组、状态与分类的中文文案、重复导入提示语 |
| `desktop/src/inbox-ui.js` | 收件箱视图：拖入/选择/粘贴、列表、预览面板、关联与分类操作 |
| `desktop/index.html` / `desktop/src/styles.css` | 收件箱视图与预览面板的结构与样式 |
| `desktop/src/applications-ui.js` | 申请详情里的证据区与 `replyEvidenceState` 文案 |
| `desktop/src/*.test.js` | 前端测试（沿用假 DOM harness） |
| `.github/workflows/desktop.yml` | 新 crate 的测试作业 |

---

## PR 1 · `evidence-import` crate：安全落盘与类型判定

**只做：** 一个不依赖 Tauri、不依赖数据库的 crate，把「一个本机文件或一段文本」变成「档案目录里的一份受控副本 + 元数据」。没有命令、没有界面。

**文件：** `desktop/crates/evidence-import/{Cargo.toml,src/lib.rs,src/names.rs,src/sniff.rs}`、`desktop/crates/evidence-import/tests/staging.rs`、`.github/workflows/desktop.yml`

**关键契约：**

- `stage_file(attachments_dir: &Path, source: &Path, now: OffsetDateTimeLike, existing: &dyn Fn(&str) -> Option<String>) -> Result<StagedBlob, ImportError>`：`existing` 回调让调用方回答「这个 sha256 是否已有 `stored_rel_path`」，命中就复用、删除临时文件、`StagedBlob.deduplicated = true`。
- `stage_text(attachments_dir, text, now, existing)`：粘贴文本按 UTF-8 落成 `.txt`，`kind = paste`。
- `ImportError`：`TooLarge { size_bytes }` / `SourceUnreadable` / `Unsupported { mime }` / `DiskFull` / `Io`。错误里**只带安全文件名与错误码**，不带源路径。`.msg` 与 Outlook 的虚拟拖拽对象走 `Unsupported`，文案在 PR4 里给出「请在邮件客户端另存为 .eml，或直接粘贴正文」。
- 上限 25 MiB（Q3），常量 `MAX_ATTACHMENT_BYTES` 导出，命令层复用。

**测试：**

- 安全文件名：`../../etc/passwd`、`C:\Windows\win.ini`、`\\server\share\x`、`CON.txt`、200 字符长名、`中文 报价单.pdf`、空名、只有点的名字 → 结果都落在 `attachments/` 之内且不覆盖既有文件（用 `std::fs::canonicalize` 断言前缀）。
- 冲突：两次导入同名但不同内容 → 第二份得到 `-2` 后缀，第一份字节不变。
- 去重：两次导入同一份字节 → 只有一个文件，第二次 `deduplicated = true`。
- 嗅探：PNG/JPEG/PDF 真实魔数、改名成 `.png` 的 PDF、纯文本、空文件。
- 失败：源文件在复制途中消失（用一个读到一半就报错的 reader）、目标目录不可写、超过 25 MiB → 都不留下临时文件，也不留下半份最终文件。

**覆盖 #66 的：** 导入管线、安全文件名与路径穿越、大小上限、重复哈希提示的基础。

---

## PR 2 · `.eml` 解析与正文提取

**只做：** 在同一个 crate 里加 `eml.rs`。不改落盘逻辑，不碰命令层。

**文件：** `desktop/crates/evidence-import/src/eml.rs`、`desktop/crates/evidence-import/tests/eml.rs`、`desktop/crates/evidence-import/Cargo.toml`（加 `mail-parser`）

**关键契约：**

- `parse_eml(bytes: &[u8]) -> ParsedMail`：`{ subject: Option<String>, from_addr: Option<String>, sent_at: Option<Rfc3339>, body_extract: Option<String>, had_html: bool, attachments: usize }`。
- 解析不出邮件头 → 返回 `None` 形态而不是报错，调用方按 `unknown` 处理（**损坏文件不能让导入整体失败**）。
- 正文优先 `text/plain`；只有 HTML 时转文本：去标签、`<br>`/`</p>` 变换行、实体解码、链接渲染成 `文字 <URL>`；截断到 64 KiB 并在末尾标注「（正文已截断）」。
- 发送时间转成 UTC 的 RFC3339；解析不出就 `None`（存储层的 `Occurred::Unknown`），**不拿导入时间冒充发送时间**。

**测试（夹具全部合成）：**

- GB18030 与 Base64/Quoted-Printable 编码的中文主题与正文。
- `multipart/alternative`（plain + html）取 plain；只有 html 时的转文本结果。
- 转发与引用（`> ` 前缀、`-----Original Message-----`）保持可读。
- 头部缺失、正文为空、非法 MIME 边界、截断的文件 → 不 panic，返回可用的部分。
- HTML 正文里的 `<script>`、`<img src=http://tracker/...>`、`javascript:` 链接 → 转文本后既不含标签也不含可执行内容，远程地址只作为文本出现。

**覆盖 #66 的：** 邮件 MIME/字符集解析、正文提取、损坏文件不崩。

---

## PR 3 · 命令层：导入、收件箱、预览、关联、分类

**只做：** 把前两个 PR 接到 archive-store 上，暴露给 WebView。仍然没有界面。

**文件：** `desktop/src-tauri/src/evidence_commands.rs`、`desktop/src-tauri/src/lib.rs`（注册）、`desktop/src-tauri/Cargo.toml`（`evidence-import`、`tauri-plugin-dialog`）、`desktop/crates/archive-store/src/evidence.rs`（`unassociate_evidence`）、`desktop/src-tauri/src/commands_regression.rs`

**关键契约：**

- `import_evidence_cmd({ paths: Vec<String>, text: Option<String>, applicationId: Option<String> }) -> ImportReport`：逐个导入，`ImportReport { imported: Vec<EvidenceSummary>, duplicates: Vec<EvidenceSummary>, failed: Vec<{ safeName, code }> }`。一个文件失败不影响其余文件。
- `list_inbox_cmd() -> Vec<EvidenceSummary>`：`list_evidence(None)`，按导入时间倒序，附 `hasDuplicate`（同 sha 的其他证据数 > 0）。
- `get_evidence_preview_cmd(evidenceId) -> EvidencePreview`（决策 6 的形状）。
- `associate_evidence_cmd(evidenceId, applicationId)`、`unassociate_evidence_cmd(evidenceId)`、`classify_evidence_cmd(evidenceId, replyClass, sendMode)`。
- **`EvidenceSummary` 里没有 `storedRelPath`、没有绝对路径**，只有 `id / kind / mime / sizeBytes / originalFilename / importedAt / subject / fromAddr / sentAt / applicationId / replyClass / sendMode`。
- `unassociate_evidence`（archive-store）：把 `application_id` 置空，写 `association_changed { from, to: null }`（枚举需要允许 `to_application_id` 为空，改动要带迁移说明——事件载荷是 JSON，无需 schema 迁移），并对原申请重算投影。

**测试：**

- 导入两个文件其中一个损坏 → `imported` 一条、`failed` 一条，数据库里只有一条证据。
- 同一份字节导入两次 → 第二次进 `duplicates`，`attachment_blobs` 仍只有一行，`ref_count = 2`。
- 关联 → 取消关联 → 再关联到另一条申请：三次投影分别是 `imported_unclassified`、`none_imported`、`imported_unclassified`；事件链完整。
- 分类为 `interview_invite` + `sendMode = automated` → 投影 `classified`，且申请阶段**没有**变化（走查 10.13）。
- 预览：图片给出 `data:` URL；> 8 MiB 的图片只给元数据；`.eml` 给出解析后的头与正文；PDF 给元数据与「用系统程序打开」的提示文本。
- 命令返回的 JSON 里搜不到 `attachments\\` 或绝对路径片段。

**覆盖 #66 的：** 收件箱数据、关联/取消关联/改关联、重复提示、状态语义、预览数据不带路径。

---

## PR 4 · 收件箱界面

**只做：** `#view-inbox` 从空视图变成可用界面。不动申请详情。

**文件：** `desktop/src/inbox.js`、`desktop/src/inbox-ui.js`、`desktop/src/inbox.test.js`、`desktop/src/inbox-ui.test.js`、`desktop/index.html`、`desktop/src/styles.css`、`desktop/src/main.js`（挂载）

**关键契约：**

- 三种入口：把文件拖到窗口（Tauri 的拖放事件给路径）、「选择文件」（Q1 的原生对话框）、「粘贴文本」（一个文本框 + 导入按钮）。
- 列表按「待处理（未关联）」与「已关联」分组；每条显示类型图标、主题或文件名、发件人、发送时间、导入时间、重复标记。
- 选中一条 → 右侧预览面板：邮件头 + 纯文本正文（`textContent` 写入，绝不用 `innerHTML` 放正文）、图片 `data:` URL、PDF 的元数据与外部打开按钮。
- 操作：关联到已有申请（搜索选择）、新建申请后关联、暂不处理、取消关联、分类（两个下拉：通知类型 / 发送方式，默认「未知」）。
- **同公司多个岗位不自动归并**：候选列表按公司过滤后仍逐条列出岗位名与创建时间，默认不预选任何一条，用户必须自己点（§7、走查 10.1）。
- 文案集中在 `inbox.js`（沿用 D07/D08 的「文案只在一处说」）：导入成功说「已导入，待分类」；重复导入说「这份内容已经导入过，可以仍然关联到另一条申请」；失败按错误码给具体原因。

**测试（假 DOM harness，沿用 `applications-ui.test.js` 的写法）：**

- 拖入两个文件 → 调用一次 `import_evidence_cmd`，参数是路径数组。
- 正文里含 `<img src=x onerror=alert(1)>` 的邮件 → 预览面板的 HTML 里没有 `<img`，有转义后的文本。
- 未关联的一条 → 列表显示在「待处理」；关联后移到「已关联」并显示「已导入，待分类」，**断言页面上不出现「尚未导入」**。
- 分类下拉选「面试邀请」不会自动把发送方式改成「人工」。
- 导入失败的文件在列表里显示原因，不影响成功的那几条；`.msg` 的提示里出现「另存为 .eml」。
- 同一家公司两条申请 → 关联对话框两条都列出、都不预选，选中之后才允许确认（走查 10.1）。

**覆盖 #66 的：** 收件箱、预览、关联、分类、文案约束。

---

## PR 5 · 申请详情里的证据与状态

**只做：** 申请详情页显示这条申请的证据，并把 `replyEvidenceState` 的文案接进列表与详情。

**文件：** `desktop/src-tauri/src/commands.rs`（`ApplicationView` 加 `evidence: Vec<EvidenceSummary>`）、`desktop/src/applications.js`（状态文案）、`desktop/src/applications-ui.js`（证据区）、对应测试

**关键契约：**

- 详情里按导入时间列出证据，可打开同一个预览面板、可取消关联、可分类。
- 状态文案严格按 §6.3：`none_imported` = 「尚未导入回复证据」（**只有真的没有证据时才显示**）、`imported_unclassified` = 「已导入，待分类」、`auto_ack` = 「已导入自动回执」、`classified` = 「已导入分类通知」（详情里显示具体类型与发送方式）、`mixed` = 「回执与其他分类通知均有」。
- 列表页的状态列同样只用这套词，不出现「已导入人工回复」。
- 「尚未导入回复证据」旁边固定一句：这不代表对方没有回复。

**测试：**

- 一条申请有一封已分类 `auto_ack` 和一封未分类 → 状态 `auto_ack`，未分类那条单独标「待分类」，不退回 `none_imported`（走查 10.20）。
- 取消关联最后一条证据 → 状态回到 `none_imported`。
- `commands_regression`：`ApplicationView` 的证据里不含路径字段。

**覆盖 #66 的：** 状态语义、详情接入、「导入不等于确认」。

---

## PR 6 · 验收：安全用例、离线走查与文档

**只做：** 把 #66 的验收逐条钉上测试或可复现脚本，并把实现回写文档。

**文件：** `desktop/crates/evidence-import/tests/hostile.rs`、`desktop/src-tauri/src/commands_regression.rs`、`desktop/scripts/d09_inbox_check.py`（可选的手动走查脚本）、`docs/desktop-mvp/product-requirements.md`、`docs/desktop-mvp/data-privacy.md`、`desktop/README.md`

**关键内容：**

- 一个统一的「敌意输入」测试：路径穿越名、Windows 保留名、超长名、伪装 MIME、`<script>`/远程图片/`javascript:` 链接、损坏 `.eml`、0 字节文件、超限文件 —— 断言全部落在 `attachments/` 内、没有网络调用、没有 panic。
- 一个「离线」断言：整套导入到分类的流程在没有任何网络的测试环境里跑通（Rust 测试本来就没有网络，这里做的是显式记录）。
- 文档：product-requirements §8.4 补充实现细节（存储路径形状、去重与 `refCount`、`sourcePathHint` 只在内存）、data-privacy 补一节「证据导入的可核对事实」、`desktop/README.md` 加「证据收件箱」使用说明与已知限制（PDF 不内嵌、`.msg` 不支持）。
- 手动走查清单（写进 PR 描述）：拖入 → 预览 → 关联 → 分类 → 取消关联 → 删除源文件后仍可预览。

**覆盖 #66 的：** 全部六条验收的证据集中在这里。

---

## 验收对照表（写 PR 描述时直接引用）

| #66 的验收 | 由哪个 PR 提供证据 |
| --- | --- |
| 导入后移走/删除原文件仍可查看 | PR1（副本与 sha 校验）+ PR6（走查） |
| 先不关联，之后关联/改关联，调整留痕 | PR3（事件链测试）+ PR4/PR5（界面） |
| 导入不等于确认面试/拒绝 | PR3（阶段不变的测试）+ PR5（文案）+ PR6 |
| 超大/不支持/损坏文件有提示且不崩 | PR1、PR2（解析失败）、PR3（逐个失败隔离） |
| 恶意文件名/路径穿越/脚本/远程图片 | PR1、PR2、PR4（预览不 innerHTML）、PR6（统一敌意用例） |
| 离线完成导入、预览与处理 | PR6（显式断言）+ 决策 10 |
| 关联后未分类显示「已导入待分类」 | PR3（投影）+ PR5（文案）+ 走查 10.20 |

---

## 风险

| 风险 | 处理 |
| --- | --- |
| `mail-parser` 引入新的依赖树 | PR2 单独引入并跑 `cargo tree` 记录体积；解析全部在独立 crate 内，接口是纯字节进、结构体出，将来换库不影响命令层 |
| 拖放在 Windows/macOS 的路径行为不同 | PR4 用 Tauri 的拖放事件而不是 HTML5 `DataTransfer.files`，并在两个平台各手动试一次；测试里对事件负载打桩 |
| 图片 `data:` URL 让内存翻倍 | 8 MiB 阈值（决策 6），超过只给元数据；PDF 从不进 WebView |
| 用户把简历本身当证据导入 | 不阻止，但导入不写任何阶段事件，也不与 D08 快照混用同一目录（`attachments/` vs `snapshots/`） |
| D12 备份要覆盖 `attachments/` | 本期不做，但 PR6 的文档里写明附件目录已经是备份屏障的一部分（data-privacy 已有条款） |
