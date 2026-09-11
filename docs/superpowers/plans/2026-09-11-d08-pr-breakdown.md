# D08 当次简历快照与填写留档 PR 拆分计划

> **For agentic workers:** 本文是 **PR 级拆分**，不是可直接执行的任务清单。每个 PR 开工时先用 superpowers:writing-plans 为该 PR 写 bite-sized 实现计划（存到 `docs/superpowers/plans/YYYY-MM-DD-d08-prN-<name>.md`），再用 superpowers:subagent-driven-development 或 superpowers:executing-plans 执行。

**Goal:** 用户每次用插件填完表，可以选择把「这次填了什么结果、用的是哪份简历」留档到已绑定的申请；简历快照在确认那一刻冻结，之后改模板、断网、重启浏览器都不改变它，桌面最终存下的一定是当时那份字节。

**Architecture:** 插件侧沿用 D07 的两段式：确认留档时只落一条 **留档意图**（`FillRecord`，无 `messageId`、无 epoch），快照字节同时进扩展源 IndexedDB；桌面可握手且用户选定申请后，才铸 `fill.submit` 与每块 `chunkMessageId`、盖 `sourceRestoreEpoch`，走 D07 的 outbox / drain / reconcile。桌面侧把块字节和块回执写进 **同一个 SQLite 事务**，分片 ACK 因此是真实的落盘承诺；全部块到齐后从库里组装、核对总哈希、原子写入 `snapshots/<snapshotId>.json`，提交快照行后才发完整 ACK。

**Tech Stack:** 插件：MV3、原生 ES module、IndexedDB（扩展源，仅 SW 访问）、Web Crypto、`chrome.storage.local`、`node --test`，无新增第三方依赖。桌面：Rust（`archive-store` / `protocol` / `src-tauri`）、rusqlite 迁移、Tauri 前端原生 JS。

**Spec 来源：** [#22](https://github.com/TshyGO/resume-form-assistant-plugin/issues/22)（范围、验收、D01 三轮修订）· [product-requirements.md §4 规则 1/7、§8.3、§8.5、§8.8、§8.10、§9、走查 10.10 / 10.14 / 10.21–10.23](../../desktop-mvp/product-requirements.md) · [data-privacy.md §4.1 / §4.2 / §7.2](../../desktop-mvp/data-privacy.md) · [adr-architecture.md §4](../../desktop-mvp/adr-architecture.md) · [protocol/README.md](../../../desktop/crates/protocol/README.md) · [protocol/INTEGRATION.md](../../../desktop/crates/protocol/INTEGRATION.md) · [D07 拆分计划](2026-09-09-d07-pr-breakdown.md)

**基线：** `c830814`（D07 七个 PR 与 #55 已合入 `main`）

---

## 已核实的外部事实（基线 c830814，实现时直接用，不必再查）

**协议载荷**（`desktop/crates/protocol/schemas/payloads/*.json`，均 `additionalProperties: false`）：

- `fill.submit`：必填 `sourceRestoreEpoch` / `payloadSha256` / `applicationId` / `outcome ∈ {started, completed, partial, failed, cancelled}`；可选 `fieldCount` / `filledCount` / `unconfirmedCount`（0–10000）、`durationsMs.{scan,match,fill,total}`（0–3600000）、`urlRedacted`（≤2000）、`templateName`（1–200）、`templateVersion`（≤64）、`snapshotId` + `sha256`（**必须成对**，INTEGRATION §fill.submit）、`pluginVersion`。**没有任何放逐字段值的字段。**
- `snapshot.chunk`：必填 `sourceRestoreEpoch` / `snapshotId` / `applicationId` / `chunkIndex`（0–127）/ `chunkCount`（1–128）/ `chunkSha256` / `snapshotSha256` / `byteSize`（1–2097152）/ `bytesBase64`（≤65536 字符）。**没有 `payloadSha256`、没有 `templateName`。** 回执摘要是 `snapshotChunkIdentitySha256`（不含 `bytesBase64`），D07 的 `link/envelope.mjs` 已把 `snapshot.chunk` 排除在 `DIGEST_TYPES` 外，`link/reconcile.mjs` 的 `identityOf` 已按块身份算摘要。
- 应答：写类型 `ok:true` 必有 `resultId`，载荷 `{resultKind?}`；`snapshot.chunk` 应答载荷 `{ackKind ∈ {chunk, snapshot}, chunkIndex, chunkCursor, snapshotId?}`。**必须** `validateResponseForRequest(res, req)`——只有它能把 `chunkIndex` / `chunkCursor` 限在请求的 `chunkCount` 内。
- 请求校验已经严格解码 Base64 并核对 `chunkSha256`（fixtures `invalid-base64.json` / `wrong-chunk-hash.json` 是请求级拒绝）。桌面拿到的每个通过校验的块，字节与块摘要已经对上。
- 常量：`MAX_ENVELOPE_BYTES = 65536`、`MAX_CHUNK_COUNT = 128`、`MAX_SNAPSHOT_BYTES = 2097152`；ADR §4 建议 raw chunk ≤ 32 KiB（32768 字节 → 43692 个 Base64 字符，整封信封约 44 KB，留足余量）。
- `outbox.reconcile` 的块项另带 `snapshotId` + `chunkIndex`，批次 ≤ 32。

**桌面现状：**

- `src-tauri/src/plugin_bridge.rs:32` 已接好 `fill.submit` → `PluginOp::FillSubmit` → `op_fill_submit`（`archive-store/src/receipts.rs:306`），写一条 `fill_*` 事件，`stage_update_mode = UpdateProgress`（completed / partial 把 `saved` 推到 `filling`）。**D08 不必改这条写路径。**
- `plugin_bridge.rs:39`：`snapshot.chunk` 一律 `Err(Unavailable)`，测试 `a_snapshot_chunk_is_never_acknowledged_while_the_bytes_have_nowhere_to_go`（:642）锁着它。PR2 要替换这条测试，而不是删掉它的意图。
- `archive-store` 已有表 `resume_snapshots` / `snapshot_uploads` / `snapshot_chunks`（`schema.rs:112/193/209`），**只有元数据，没有任何地方存块字节**。
- `op_snapshot_chunk`（`receipts.rs:359`）：父记录 upsert，父身份变化或 `chunkCount` / 总哈希不一致 → `conflict`；同块不同 `chunkSha256` → `conflict`；同块换 `messageId`（重启重铸）→ `conflict`；同块同 id → 幂等。
- `snapshot_progress`（:489）按连续块算游标；`finalize_snapshot_upload(client, snapshot, stored_rel_path)`（:540）要求 **文件已写好**（内部 `verify_file` 核对长度与哈希并 `sync_all`）、全部块已登记、已绑定申请、**旧 epoch 拒绝**；`template_name` 缺失时写 `"unknown"`。`get_snapshot` / `list_snapshots` 已有。
- 永久删除申请时连带删快照三张表（`applications.rs:572–652`）；`check_attachment_refs`（`evidence.rs:281`）已把 `resume_snapshots` 的文件纳入引用核对。`data-service/src/paths.rs` 的 `snapshots_dir = <archive>/snapshots`，写入探针已覆盖。
- `protocol/src/snapshot.rs`：`ChunkAssembler`（内存会话，上限 16，必须 `forget` / `cancel`）、`DurableChunk::committed(snapshot, index, count, chunkMessageId, durableCursor)`（**游标等于块下标时拒绝构造**，即「没落盘就想 ACK」）、`plugin_chunk_ack_payload`、`plugin_snapshot_ack_payload`。
- 桌面前端时间线（`desktop/src/applications-ui.js:200–218`）对填写事件只显示通用字段；:201 写着「附件、简历快照和待办尚未接入」。事件中文名在 `applications.js:25–29`。

**插件现状（D07 留下的）：**

- `link/outbox.mjs`：条目是 **扁平** 的一条消息一个 `messageId`；`enqueue` 需要当前握手身份（`identity`），所以 **只有桌面可握手时才能建绑定项**；先落盘再发送；成功后删条目。
- `link/drain.mjs`：串行、有上限退避、alarm 唤醒、空队列不探测。`link/reconcile.mjs`：epoch 不符即暂停，只发 `outbox.reconcile`，用户选关联 / 丢弃 / 另存。
- `link/store.mjs`：`chrome.storage.local` 只用四个 key（`desktopSaveIntents` / `desktopOutbox` / `desktopClientInstanceId` / `desktopPairing`），`RESERVED_KEYS` 列出插件既有 key，测试锁住边界。
- `content.js:752` `handleAiFillClick`：填写开始时取 `activeTemplate`，全程累计 `fieldCount` / `filledCount` / `unconfirmedCount`（仅辅助模式）、`timing.{scanMs, roundTripMs, fillMs}` 与总耗时，结果 `outcome ∈ {success, partial, failed}`，用户取消记在 `cancelRequested`（取消只放弃 AI 等待，保留本地匹配）。`handleRepeatFillClick`（:667，AI 辅助新增）最后也调 `handleAiFillClick(…, {scopes})`，**两条填写路径汇合在同一个 `finally`**。
- 「确认已投递」找申请的方式（`content.js:1727`）：用 `link/extract.mjs` 抽本页岗位字段 → `DESKTOP_CANDIDATES_FOR` → 用户从候选里点。D08 选申请直接复用这条路。

**测试命令：** 插件 `node --test tests/*.test.js`；桌面见 `.github/workflows/desktop.yml`：`cargo test --manifest-path crates/archive-store/Cargo.toml --locked`、`crates/protocol`、`src-tauri --bins --lib`，前端 `node --test src/pairing-form.test.js src/applications.test.js src/applications-ui.test.js`，协议 JS `node --test crates/protocol/js/*.test.mjs`。

---

## 架构决策

### 已定（PR 内落地；反对请在对应 PR 评论提）

**1. 插件两段式：留档意图 → 绑定消息。**
与 D07 的 SaveIntent / Bound outbox 同构。确认留档时只写 `FillRecord`：填写元数据 + 可选的快照元数据（`snapshotId` / `sha256` / `byteSize` / `chunkCount` / `staging: 'idb'`），**没有** `messageId`、申请 UUID 以外的身份、`restoreEpoch`。桌面可握手且用户选定申请后，才在同一步里铸 `fill.submit` 的 `messageId` 和每块 `chunkMessageId`、盖当前 epoch，写进 outbox。依据：§5.2.1 禁止「以先握手成功作为入队前提」；§8.5 分片身份「首次准备发送时铸造并持久化」；D07 的 `enqueue` 本来就需要 identity。

**2. 快照冻结的是「这次填写实际用的模板」。**
`handleAiFillClick` 开始时已经取了 `activeTemplate`。在同一刻做一份深拷贝留在内存里（不落盘、不外发），用户确认留档时序列化 **这份拷贝**。填写与确认之间用户若改了模板，快照仍是填写时的那份——那才是「当次使用的简历」。这是对 §8.5「从当时的活模板拷贝」的收紧解释，PR7 同步改文档措辞。

**3. 快照格式 v1 由 D08 定义**（downstream-decisions 把「快照 JSON 格式」列为 D08 的交付物）：

```json
{ "format": "resume-pro.snapshot", "formatVersion": 1,
  "templateName": "默认模板", "templateVersion": "3f2a9c01b7de",
  "capturedAt": "2026-09-11T12:00:00.000Z",
  "groups": [ { "name": "基本信息", "fields": [ { "key": "姓名", "value": "…" } ] } ],
  "omittedFieldCount": 0 }
```

- 用 vendored `canonicalJson` 序列化（键排序、compact、UTF-8），同一模板永远得到同一字节。
- `templateVersion` = 模板内容（`groups`，不含 `capturedAt`）canonical JSON 的 SHA-256 前 12 位，满足 §8.5「无版本号则用内容哈希短码」。
- **再剥一层 secret**（data-privacy §4.1「桌面留档仍要再剥一层」）：字段名命中 `密码|口令|password|passwd|pwd|验证码|校验码|otp|api[\s_-]?key|token|cookie|secret|授权码` 的整条字段丢弃，只记 `omittedFieldCount`。不确定就丢，不「先存再看」。
- `byteSize > 2097152` → 本次不带快照，明确告知，填写和元数据留档照常。

**4. 桌面块字节与块回执同事务落 SQLite。**
迁移 v2 新增 `snapshot_chunk_bytes(client_instance_id, snapshot_id, chunk_index, bytes BLOB NOT NULL, PRIMARY KEY(...))`，与 `snapshot_chunks` 行、`message_receipts` 回执在 **同一个事务** 里提交。事务提交后才用 `DurableChunk::committed(...)` 构造分片 ACK——此时它才是真话。不选「每块一个暂存文件」：那样要处理文件与库的跨介质一致性和孤儿清扫，D12 备份屏障也要额外纳入暂存目录。块字节最多 2 MiB × 在途份数，远在 SQLite 舒适区内；完整快照提交的同一事务里删掉这些块字节。

**5. 不保留长期的 `ChunkAssembler` 会话。**
每个块请求只做「校验过的字节入库」。凑齐时用一个 **临时** assembler（或同等逻辑）从库里按下标读回全部块、核对总长度与 `snapshotSha256`，用完立即 `forget`；失败 `cancel`。这样 D05 的「必须 forget / cancel、活动会话上限 16」天然满足，应用重启也不丢进度（进度在库里，不在内存）。

**6. 快照行的 `templateName` 从快照内容读，不改协议。**
`snapshot.chunk` 没有模板名，`finalize` 缺省写 `"unknown"`。完整字节核对哈希之后，解析决策 3 的格式取 `templateName` / `templateVersion` 写进 `finalize`。格式不认识就退回 `"unknown"` 并照常入库——字节已经逐块 ACK 过，此时拒绝会让上传永远卡住。

**7. 绑定后先发 `fill.submit`，再发快照块。**
事件是小消息，先落能让时间线最快出现记录；快照是可选附件，失败不应拖住事件。时间线据此要能显示「快照上传未完成」。

**8. 块大小固定 32 KiB，不申请 `unlimitedStorage`。**
暂存上限取 §8.5 建议值：合计 ≤ 20 MiB 且 ≤ 20 份（先到为准），默认配额足够。IndexedDB 打开失败或配额错误 → 本次留档不带快照并说明原因，**不**假装已暂存（§8.5 失败降级）。

**9. 只有两条 AI 填写路径产生留档，且只发最终结果。**
「一键 AI 填写」与「AI 辅助新增条目」产生留档；侧边栏 chip 的逐字段手动填写不产生（粒度是单个字段，不是一次填写）。不发 `started`：留档要用户在填写 **结束后** 确认，确认之前不能外发任何东西，所以只有最终 outcome。这与 #22 列出的「开始」有出入：中途关掉标签页的填写不会有记录——那次填写用户从未同意留档。协议枚举里的 `started` 保留不动，PR7 把这条解释写回 §8.8 与 #22。映射：`success → completed`、`partial → partial`、`failed → failed`；用户取消且 `filledCount = 0` → `cancelled`，取消但本地匹配已填了一部分 → `partial`（不把已写入控件的字段抹掉，也不把没写入的算成已写）。

**10. 从未配对不出现留档入口。**
沿用 §9：未安装 / 从未配对时插件不堆积任何桌面数据，填写后的留档卡片不渲染。已安装未配对同理，只在 D07 已有的位置提示配对。

### 需负责人确认（开工前拍板；未拍板的按「推荐」执行）

| # | 问题 | 推荐 | 不选的代价 |
| --- | --- | --- | --- |
| Q1 | 新增 `chrome.storage.local` key `desktopFillRecords` 存留档意图 | **同意**，PR3 按 D01 §5 的同步顺序更新 §8.10 的 key 列表 | 塞进 `desktopSaveIntents` 会把两种语义不同的对象混在一个列表里，D07 的去重与容量规则都要加分支 |
| Q2 | 逐字段值（AI 返回值 / 已写入控件的值）本期不做 | **不做**。协议 `fill.submit` 没有这个字段，D01 默认 OFF，downstream-decisions 已把「默认仅元数据」列为建议定案。另开 issue，需要时先改 D05 schema 再做开关 | 本期做就要改 D05 schema、vendored 校验器、fixtures、Rust 校验与桌面存储，并新增一个隐私设置，D08 至少多两个 PR |
| Q3 | 留档卡片里「附上本次使用的简历快照」勾选框默认值 | **默认勾选**。卡片在用户点「留档」之前完整可见，勾选框就在按钮旁边；D08 的目标本身就是「查清用了哪份简历」 | 默认不勾：多数用户不会主动勾，快照形同虚设，#22 验收 1 在真实使用里基本不会发生 |

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `link/snapshot.mjs` | 纯函数：模板 → 快照 v1 字节（canonical、secret 剥离、`templateVersion`、2 MiB 上限）、切 32 KiB 块并算每块 `chunkSha256` |
| `link/staging.mjs` | 扩展源 IndexedDB 暂存：父记录 + 原字节 + 每块元数据（含已铸的 `chunkMessageId`）；配额 20 份 / 20 MiB；列出、读块、删除、过期判定。经注入的 KV 适配器访问 IDB |
| `link/fillrecords.mjs` | 留档意图生命周期：新建、绑定、取消、容量；`desktopFillRecords` 读写 |
| `link/uploads.mjs` | 快照上传的绑定项：铸块身份（先写 IDB 再写 outbox）、按游标发块、处理两种 ACK、完整 ACK 后的幂等清理、启动时从 IDB 修复 outbox |
| `link/chrome.mjs` | 新增真实 IndexedDB 适配器（仅 SW 调用） |
| `link/outbox.mjs` / `link/drain.mjs` / `link/reconcile.mjs` | 接纳 `fill.submit` 与快照上传项；drain 串行驱动；对账覆盖块身份 |
| `link/messages.mjs` / `link/router.mjs` / `link/worker.mjs` | 新增留档相关消息与装配 |
| `link/limits.mjs` | 新增 `SNAPSHOT_CHUNK_BYTES`、`MAX_STAGED_SNAPSHOTS`、`MAX_STAGED_BYTES`、`STAGING_EXPIRY_MS`、`MAX_FILL_RECORDS` |
| `link/copy.mjs` | 留档相关文案集中处（沿用 D07「文案只在一处说」） |
| `content.js` / `content.css` | 填写结束后的留档卡片、选申请、待同步面板里的留档项与过期提示 |
| `desktop/crates/archive-store/src/{schema,migration,receipts}.rs` | 迁移 v2：块字节表；块入库同事务；组装、写快照文件、finalize、清理块字节 |
| `desktop/src-tauri/src/plugin_bridge.rs` | `snapshot.chunk` 真实处理：分片 ACK / 完整 ACK / 重放 |
| `desktop/src-tauri/src/{commands,lib}.rs` | 读快照的 Tauri 命令 |
| `desktop/src/applications{,-ui}.js` / `styles.css` | 时间线显示留档与快照状态、快照查看视图 |
| `desktop/scripts/d08_browser_check.py` | 真实浏览器端到端验收 |
| `tests/*.test.js` / `desktop/crates/*/tests` / `desktop/src/*.test.js` | 各 PR 自带测试 |

**IndexedDB 只在 service worker 里打开。** content script 的 IDB 属于宿主页面源（§8.5、ADR「永不」列表明确禁止）。content.js 通过 `chrome.runtime.sendMessage` 把模板拷贝交给 SW，由 SW 序列化、算摘要、暂存。2 MiB 以内的 JSON 远低于 runtime 消息上限。

---

## PR 1 · 快照格式与扩展源 IndexedDB 暂存（含 V12 原型）

**只做：** 两个插件模块和一次真实浏览器原型，证明「字节写进扩展源 IDB 后，SW 被回收、浏览器重启都能原样读回」。没有 UI、不发任何消息。

**文件：** `link/snapshot.mjs`、`link/staging.mjs`、`link/chrome.mjs`、`link/limits.mjs`、`tests/link-snapshot.test.js`、`tests/link-staging.test.js`、`desktop/scripts/d08_idb_check.py`

**关键契约：**

- `buildSnapshot(template, { now })` → `{ bytes: Uint8Array, sha256, byteSize, templateName, templateVersion, omittedFieldCount }` 或 `{ error: 'too_large' | 'empty' }`。输入是 `normalizeTemplate` 形状（`{name, groups:[{name, fields:[{key, value}]}]}`）。
- `planChunks(bytes)` → `[{ chunkIndex, chunkSha256, start, end }]`，32 KiB 一块；`chunkCount ≤ 128` 由 2 MiB 上限保证（最多 64 块）。
- `staging` 经注入的 `kv = { get, put, delete, list }`（真实实现在 `chrome.mjs` 包 IndexedDB，数据库 `resume-pro-desktop`、object store `snapshots`、key = `snapshotId`；测试用 Map 实现）。记录形状：`{ snapshotId, sha256, byteSize, chunkCount, bytes: ArrayBuffer, chunks: [{chunkIndex, chunkSha256, chunkMessageId: null}], templateName, templateVersion, createdAt, binding: null }`。`binding` 在 PR4 绑定时写入（`applicationId` / `archiveId` / `sourceRestoreEpoch` / `recordId`），它是修复 outbox 所需的全部信息。
- `stage(snapshot)`：先查配额（≤ 20 份且合计 ≤ 20 MiB），满了返回 `{ status: 'full' }`，**不覆盖、不挤掉旧项**；写入后读回核对 `sha256`，不一致视为失败。
- 任何 IDB 异常（打不开、配额、事务中止）一律返回 `{ status: 'unavailable', reason }`，不抛到填表路径。
- `d08_idb_check.py`（仿 `nm_browser_check.py`，Playwright 驱动已发布的插件）：从扩展页用插件自己的模块暂存一份多块合成快照 → 在 SW 里用裸 IndexedDB API 读回比对 SHA-256 → 关闭并重开浏览器（同一 user data dir）→ 在新的 SW 实例里再读回、并经 `staging.readChunk` 逐块拼回比对。**不单独做「停 SW」**：IDB 数据在浏览器进程的存储后端，不在 SW 的 renderer 里，空闲回收只丢 renderer；浏览器重启丢掉全部进程、必须从磁盘读回，是更严格的情形。实测 Playwright 挂在 SW 上的调试器会阻止回收，CDP `stopAllWorkers` 不生效，关 SW target 会拖垮整个会话，`runtime.reload()` 会卸掉命令行加载的扩展。

**测试：**

- 同一模板两次 `buildSnapshot` 字节完全相同；改一个字段值后 `sha256` 与 `templateVersion` 都变；`capturedAt` 不参与 `templateVersion`。
- 字段名「登录密码」「短信验证码」「API Key」「access_token」被剥离且 `omittedFieldCount` 正确；「期望薪资」「证件号码」这类非 secret 不被误剥（防过度剥离）。
- 2 MiB 边界：`2097152` 字节通过、`2097153` 返回 `too_large`。
- 切块：最后一块不足 32 KiB；各块拼回原字节；每块 `chunkSha256` 与独立计算一致。**用最大块造一封 `snapshot.chunk` 信封，`utf8JsonLen ≤ 65536` 且能过 vendored `validateRequest`**——把本 PR 与 D05 焊死（风险 V5）。
- 暂存：第 21 份被拒且前 20 份完好；合计超 20 MiB 被拒；`kv.put` 抛异常 → `unavailable` 而不是 reject。
- `RESERVED_KEYS` 与 D07 的四个 key 在整个流程后逐字节不变（IDB 不碰 `chrome.storage.local`）。

**门禁（V12）：** `d08_idb_check.py` 在 Windows 上跑通并把输出贴到 PR。**若 IDB 在 SW 回收或浏览器重启后读不回**：停在这里，按 downstream-decisions §5 的同步顺序改 §8.5（离线留档不带快照、改为明确不可用）与 #22 / #27 的验收，再调整后续 PR。不在实现里悄悄降级。

**覆盖 #22 的：**「模板变更」测试的字节不变部分、「禁止采集字段」的快照一侧；风险 V12、V5。

**不做：** 与 content.js 的接线、任何发送、绑定、outbox。

---

## PR 2 · 桌面：分片字节落盘、组装与两种 ACK

**只做：** 让桌面对 `snapshot.chunk` 说真话——分片 ACK 意味着这块已进库，完整 ACK 意味着快照文件与快照行都已提交。纯桌面，可与 PR1 / PR3 并行。

**文件：** `desktop/crates/archive-store/src/{schema.rs, migration.rs, receipts.rs, plugin.rs, lib.rs}`、`desktop/crates/archive-store/tests/storage.rs`、`desktop/src-tauri/src/plugin_bridge.rs`、`desktop/crates/archive-store/INTEGRATION.md`

**关键契约：**

- 迁移 v2：新增 `snapshot_chunk_bytes`（见架构决策 4），迁移前按现有机制备份库；v1 库里不会有块行（`snapshot.chunk` 在 D06 以来一律 `unavailable`），迁移不需要回填。
- `op_snapshot_chunk` 增加入参 `bytes: Vec<u8>`，在 **现有事务内** 写 `snapshot_chunk_bytes`。幂等重放（同块同 id 同摘要）不重复写。块字节长度与 `chunkSha256` 以请求校验结果为准，入库前再核一次长度，不一致 → `invalid_payload`。
- `plugin_bridge` 的 `snapshot.chunk` 流程：
  1. 解码 `bytesBase64`（已通过校验），调 `op_snapshot_chunk`，事务提交；
  2. 读 `snapshot_progress` 得到 durable 游标，`DurableChunk::committed(...)` 构造成功才返回 `plugin_chunk_ack_payload`；
  3. 若全部块已入库且 `full_acked = 0`：按下标读回字节 → 临时 assembler 核对总长度与 `snapshotSha256` → 写 `snapshots/<snapshotId>.json`（临时文件 → `sync_all` → rename）→ 解析内容取模板名 → `finalize_snapshot_upload` → **同一事务** 删 `snapshot_chunk_bytes` → 提交后返回 `plugin_snapshot_ack_payload`。模板名通过 `finalize_snapshot_upload` **新增的入参**（`template_name` / `template_version`）写进 `resume_snapshots`，**不回写** `snapshot_uploads`：那两列参与 `op_snapshot_chunk` 的父身份比对（`template_name IS ?`），回写之后，完整 ACK 丢失时的重发会被判成 `conflict`，上传永远完不成；
  4. 若 `full_acked = 1`（完整 ACK 丢失后的重发）：直接返回 `ackKind: snapshot`，不重写文件。
- **重放也要给出正确的 ACK。** 同一 `chunkMessageId` 重发走回执路径时，应答按库里当下的进度构造（可能是 chunk，也可能已经是 snapshot），不能只回原 `resultId`。插件恢复上传全靠这一点。
- 组装或写文件失败：不发完整 ACK，块字节保留，下次任一块重发时重试第 3 步；已发出的分片 ACK 仍然成立（字节确实在库里）。
- 旧 epoch 的块：信封校验先拒（`restore_epoch_mismatch`）；`finalize` 自身也拒旧 epoch（已有）。
- 日志与错误应答只含错误码与 `snapshotId`，**不含块字节、Base64 或快照内容**。

**测试（`cargo test` archive-store / src-tauri）：**

- 3 块顺序到达：块 0、1 应答 `ackKind: chunk`，游标 1、2；块 2 应答 `ackKind: snapshot`；`resume_snapshots` 恰好一行、文件存在且哈希相符、`snapshot_chunk_bytes` 为空。
- 乱序：先块 2 再块 0 → 块 2 的 ACK 游标仍为 0（不跳洞，`DurableChunk` 构造规则被真实数据触发），块 0 后游标为 1。
- **重启：** 提交块 0、1 后丢弃 `ArchiveStore` 重新打开，再发块 2 → 完整 ACK 成功（进度在库里）。
- 完整 ACK 丢失：再发一次块 2（同 `messageId`）→ 仍回 `ackKind: snapshot`，文件与快照行都只有一份。
- 冲突：同块不同字节 → `conflict`；同块新 `messageId` → `conflict`；两者都不污染已有会话。
- 写文件失败（快照目录只读或注入失败）→ 不发完整 ACK、块字节仍在；恢复可写后重发任一块 → 完整 ACK。
- 格式不认识的快照内容 → 模板名 `"unknown"`，照常完整 ACK。
- 64 块 2 MiB 边界跑通；没有任何长期 assembler 会话残留（会话数断言为 0）。
- 替换 `a_snapshot_chunk_is_never_acknowledged_while_the_bytes_have_nowhere_to_go`：改为断言「提交之前构造不出分片 ACK」。

**覆盖 #22 的：**「重传留档不会复制快照」「快照事务失败」「应答丢失重传」的桌面一侧；走查 10.21 正常路径与反例 2、3 的桌面一侧。

**不做：** 时间线与查看界面（PR6）、插件任何改动。

---

## PR 3 · 插件：留档确认与填写事件（`fill.submit`，先不带快照）

**只做：** 填完表后给出留档入口；用户同意并选定申请后，桌面时间线出现一条准确的填写事件。快照勾选框本 PR 不出现（PR4 才接）。

**文件：** `content.js`、`content.css`、`link/fillrecords.mjs`、`link/outbox.mjs`、`link/router.mjs`、`link/messages.mjs`、`link/worker.mjs`、`link/store.mjs`、`link/copy.mjs`、`link/limits.mjs`、`docs/desktop-mvp/product-requirements.md`（§8.10 key 列表，Q1）、`tests/link-fillrecords.test.js`、`tests/link-fill-submit.test.js`、`tests/link-degradation.test.js`

**关键契约：**

- `handleAiFillClick` 的 `finally` 汇总一个 **填写结果对象**：`{ outcome, fieldCount, filledCount, unconfirmedCount, durationsMs: {scan, match, fill, total}, urlRedacted, templateName, pluginVersion }`，outcome 按架构决策 9 映射；`urlRedacted` 用 D07 的 `redact.mjs` 的 `sourceUrl` 规则；`match` 取 `timing.roundTripMs`。只传计数与耗时，**不传任何字段值、AI 返回值或 prompt**（沿用 `formatFillDiagnostics` 的 allowlist 精神）。
- **三种「值」的区分（§8.8，D08 验收）落在计数上：** `filledCount` 只统计 `setElementValue` 成功（辅助模式另经读回确认）的字段，即「已写入控件」；AI 返回了但没写进去的不计入；「网站已接受 / 已保存」插件永远不知道，任何字段、计数、文案都不暗示它。卡片上的措辞是「已写入网页 X 项」，不是「已提交 X 项」。
- 留档卡片出现在侧边栏状态区下方，**不阻塞、不弹窗、可忽略**。忽略或点「不留档」= 什么都不发、什么都不存（#22 验收 4）。从未配对 / 未安装时不渲染（决策 10）。
- 选申请：
  - 桌面可握手 → 复用 `DESKTOP_CANDIDATES_FOR` 的候选（`link/extract.mjs` 抽本页岗位字段），列出 `exact` 与 `sameCompany`，**不默认选中任何一条**，只有用户点了才算绑定（#22「不能猜测关联」）。候选为空时提示「先保存岗位」，并提供「不留档」。
  - 桌面不可握手 → 选项只有「稍后在待同步里选择申请」与「不留档」。前者建 `FillRecord { recordId, clientInstanceId, fill: <结果对象>, createdAt, status: 'pending_bind', applicationId: null }`，UI 说「待同步（尚未选择申请）」。
- `FillRecord` 容量 `MAX_FILL_RECORDS = 100`，满了拒绝新增并提示，不丢旧项、不影响填表。
- 绑定（立即或稍后在待同步面板里）：握手成功 → `outbox.enqueue({ messageType: 'fill.submit', payload: { applicationId, ...fill }, recordId })`，先落盘再发送，成功后删 `FillRecord` 与条目；重试沿用同一 `messageId`。条目带 `recordId`，同一 `recordId` 只能入队一次（仿 D07 的 intent guard，防双击产生两条事件）。
- 待同步面板新增「留档」分组：列出 `FillRecord` 与 `fill.submit` 条目，支持「选择申请」「删除」「重试」，失败原因用 D07 的分类，不回显协议原文。
- 文案（集中在 `link/copy.mjs`）：只有 `ok:true` 之后才说「已留档到桌面」；待同步一律说「待同步」；**任何留档文案都不出现「已投递」**（规则 1）。

**测试：**

- outcome 映射：成功 / 部分 / 失败 / 取消且 0 项 / 取消但已填 3 项 各自对应 `completed` / `partial` / `failed` / `cancelled` / `partial`。
- 结果对象只有 allowlist 字段：构造含字段值的填写过程，断言发出的 payload 里不出现任何模板值、AI 返回值、`aiConfig` 任一字段（字符串搜索断言）。
- URL 里的 `access_token` / `code` 在 `urlRedacted` 里被剥离。
- 点「不留档」或忽略卡片 → `sendNative` 零调用、`desktopFillRecords` 与 `desktopOutbox` 都不变。
- 从未配对 → 卡片不渲染（源码级断言 + router 返回 `mode`）。
- 桌面不可用 → `FillRecord` 落盘、UI 文案不含「已留档」；桌面恢复后在面板选申请 → 恰好一条 `fill.submit`。
- 同一 `messageId` 重发，桌面返回同一 `resultId` → 条目只删一次、时间线只有一条事件（用 D07 的假 host）。
- 双击「留档」→ 只有一条 outbox 条目。
- 第 101 条 `FillRecord` 被拒且现有填表回归全绿（`tests/form-agent.test.js`、`tests/fill-highlight.test.js`）。
- `RESERVED_KEYS` 与 `templates` / `aiConfig` 在整个流程后逐字节不变。

**覆盖 #22 的：** 验收 3（失败 / 取消的准确结果、未确认不算已提交）、验收 4（拒绝留档不外发）、「记录用户主动触发的填写事件」「没有绑定申请时询问绑定或跳过」「确认已投递是单独操作」；测试项「部分填写」「手动取消」「未绑定申请」「应答丢失重传」的事件一侧。

**不做：** 快照勾选框、暂存、分片（PR4）；epoch 不匹配（PR5，本 PR 的条目沿用 D07 现有暂停逻辑即可）。

---

## PR 4 · 插件：快照暂存、分片上传、游标与清理

**只做：** 把 PR1 的暂存与 PR2 的桌面 ACK 接起来：勾选快照的留档，最终在桌面存下当时那份字节；中途断线、SW 回收、浏览器重启都从原字节继续。

**文件：** `link/uploads.mjs`、`link/staging.mjs`、`link/fillrecords.mjs`、`link/outbox.mjs`、`link/drain.mjs`、`link/router.mjs`、`link/worker.mjs`、`link/copy.mjs`、`content.js`、`content.css`、`tests/link-uploads.test.js`、`tests/link-staging-recovery.test.js`

**关键契约：**

- 留档卡片出现「附上本次使用的简历快照」勾选框（默认值按 Q3）。勾选时 content.js 把 **填写开始时的模板拷贝**（决策 2）交给 SW：`buildSnapshot` → `stage` → `FillRecord.snapshot = { snapshotId, sha256, byteSize, chunkCount, staging: 'idb' }`。**暂存成功之后** `FillRecord` 才带快照元数据；暂存失败（`unavailable` / `full` / `too_large`）→ 留档照常但不带快照，卡片明确说原因（§8.5 失败降级）。
- 绑定时（与 PR3 同一步）：
  1. 为每块铸 `chunkMessageId`，连同 `binding` 写回 **IDB 父记录**；
  2. 再写 outbox：`fill.submit` 条目（payload 带 `snapshotId` + `sha256`）+ 一个快照上传条目 `{ kind: 'snapshot', snapshotId, sha256, byteSize, chunkCount, applicationId, archiveId, sourceRestoreEpoch, chunks: [{chunkIndex, chunkMessageId, chunkSha256, acked: false}], chunkCursor: 0, status }`。
  顺序是 IDB 先、outbox 后：崩在两步之间时，IDB 里有足够信息重建 outbox（§8.5「IDB 暂存必须含父记录与每块 `chunkMessageId`」）。
- drain 对快照条目：从 IDB 读 `chunkCursor` 那一块的字节 → 组 `snapshot.chunk` 信封（`messageId = chunkMessageId`）→ 发送 → `validateResponseForRequest` → 标记该块 `acked`，`chunkCursor` = 从 0 起第一个未 ACK 的下标（**只按连续 ACK 前进**，较后块的 ACK 不跳洞）。每块 ACK 后先持久化再发下一块。条目排在同一申请的 `fill.submit` 之后（决策 7）。
- `ackKind: snapshot`：先把条目持久化为 `status: 'completed'` → 删 IDB 记录 → 删条目。三步可重入：启动时见到 `completed` 条目就继续删 IDB 与条目。
- 全部块都 ACK 了但没收到完整 ACK：重发最后一块（同 `chunkMessageId`），PR2 保证重放会回 `ackKind: snapshot`。**永不** 因为收不到完整 ACK 就删 IDB。
- SW 启动时的修复（`uploads.repair()`，挂在 `installDesktopLink`）：
  - IDB 有 `binding` 但 outbox 没有对应条目 → 按 IDB 重建条目，**沿用已铸的 `chunkMessageId`**，绝不新铸；
  - outbox 有快照条目但 IDB 没有字节 → 条目改为 `status: 'bytes_lost'`，文案「快照暂存丢失，请重新留档或在桌面导入」（走查 10.10），**不从当前模板重新生成**。
- 过期：暂存超过 30 天未完成 → 打开侧边栏时在待同步面板提示「有未完成的简历留档」，用户选「继续发送」或「丢弃」。**到期不自动删**。
- 丢弃快照 = 删 IDB + 删快照条目；已发出的 `fill.submit` 不受影响（事件照旧，时间线显示快照未上传）。

**测试（假 host + Map 版 KV）：**

- 走查 10.14：3 块，块 0、1 ACK 后丢弃全部内存态（模拟 SW 重启）→ 修复后续发块 2 且 `messageId` 仍是原 C2；期间把活模板改成 v2 → 发出的字节仍是 v1、最终总哈希仍是 H。
- 走查 10.21 反例：假 host 只 ACK 块 2 → 游标仍为 0，下一次发的是块 0；三块的 `messageId` 互不相同，且都不等于 `fill.submit` 的 `messageId`。
- 完整 ACK 丢失 → 重发最后一块 → 收到 snapshot ACK → IDB 与条目都被清掉，且在收到之前任何时刻 IDB 记录都在（在 `kv.delete` 里断言条目已是 `completed`）。
- 崩在「写 IDB 之后、写 outbox 之前」→ 修复后条目出现且块 id 与 IDB 一致。
- IDB 被清空 → `bytes_lost`，不产生任何 `snapshot.chunk` 发送。
- `kv` 抛配额错误 → 留档不带快照、`fill.submit` 里没有 `snapshotId`、卡片文案说明原因。
- 超 2 MiB 模板 → 同上，原因为 `too_large`。
- 30 天边界：29 天不提示、31 天提示；提示后不选择 → 仍保留。
- 走查 10.10：离线确认留档 → 改模板 → 桌面恢复 → 绑定 → 上传 → 假 host 收到的拼接字节等于 v1。

**覆盖 #22 的：** 验收 1（v1 快照不被 v2 改写）的插件一侧、验收 2（重传不复制快照）、「超限不能假报留档成功，且不影响正常填写」；测试项「模板变更」「应答丢失重传」「快照事务失败」的插件一侧；走查 10.10、10.14、10.21。

**不做：** epoch 不匹配（PR5）、桌面查看（PR6）。

---

## PR 5 · 插件：restoreEpoch 不匹配时的留档与快照对账

**只做：** 桌面恢复过备份后，旧的留档与快照块不许静默重放。

**文件：** `link/reconcile.mjs`、`link/uploads.mjs`、`content.js`、`tests/link-reconcile-snapshot.test.js`

**关键契约：**

- `fill.submit` 条目沿用 D07 的暂停 / 对账 / 三出口，不需要新逻辑，只补测试。
- 快照条目：握手后 `sourceRestoreEpoch ≠ current` → 整个条目暂停，**不发任何块**（走查 10.21 反例 4）。
- 对账：每块一项 `{clientInstanceId, messageId: chunkMessageId, sourceRestoreEpoch, payloadSha256: <块身份摘要>, snapshotId, chunkIndex}`，按 32 分批（64 块 = 2 批）。结果按块回填，汇总成快照级状态给用户看：全部 `applied`、部分 `applied`、存在 `conflict` / `not_found` / `unverifiable` / `purged`。
- 用户出口：
  - **丢弃**：删 IDB + 删条目；
  - **另存**：为 **所有块** 新铸 `chunkMessageId`、盖当前 epoch、记录旧身份（`previousIdentity`，每块一份），**先写 IDB 与 outbox 再发送**，重试不得生成第三套身份；`applicationId` 改由用户重新选（恢复后旧申请可能已不存在）；
  - **关联**：对快照而言等于「另存到指定申请」（`applicationId` 是块身份的一部分，换申请就是新块身份），UI 上合并成同一个入口，避免让用户理解两种说法。
- `applied` 不授予重写许可；`not_found` 不代表从未执行，不自动重写（§8.11）。
- 另存时仍用 IDB 里的 **原字节**，不从当前模板重建。

**测试：**

- 换 epoch 握手 → 快照条目与 `fill.submit` 条目都暂停，`sendNative` 再没收到 `snapshot.chunk` / `fill.submit`（全局断言）。
- 40 块待对账 → 两批，每批 ≤ 32，且每项带 `snapshotId` + `chunkIndex` 与正确的块身份摘要（与 D07 `link-reconcile.test.js:374` 的算法一致）。
- 另存：新块 id 全部不同于旧 id；落盘先于发送；连续两次重试只有一套新 id；发出的字节与原 sha256 相符。
- 部分 `applied` + 部分 `not_found` → 不自动任何动作，UI 给出三出口。

**覆盖 #22 的：** 走查 10.21 反例 4、10.23 在留档与快照上的延伸；D07 风险表的「恢复档案库后的旧队列」在快照上的补齐。

**不做：** 桌面恢复本身（D12）。

---

## PR 6 · 桌面：时间线显示留档与快照查看

**只做：** 用户在桌面申请详情里看得到每次填写的结果，并能从事件打开当次快照；界面明确说明快照不是网站最终提交内容的证明。依赖 PR2，可与 PR3–PR5 并行。

**文件：** `desktop/src-tauri/src/{commands.rs, lib.rs}`、`desktop/crates/archive-store/src/receipts.rs`（新增按一组 `snapshotId` 查 `stored` / `uploading` / `missing` 的只读查询）、`desktop/src/{applications.js, applications-ui.js, styles.css}`、`desktop/src/applications-ui.test.js`、`desktop/src/applications.test.js`

**关键契约：**

- 新命令 `get_snapshot_cmd(snapshotId)`：`get_snapshot` 取元数据 → `verify_file` 核对长度与哈希 → 解析快照 v1 → 返回 `{ meta, templateName, templateVersion, capturedAt, groups, omittedFieldCount }`。文件缺失或哈希不符 → 明确错误，不返回部分内容。
- `get_application_cmd` 的返回（`commands.rs` 的 `ApplicationView`）新增 `snapshotStates: { [snapshotId]: 'stored' | 'uploading' | 'missing' }`，只覆盖该申请事件里引用到的 `snapshotId`：`stored` = 有 `resume_snapshots` 行；`uploading` = 只有未完成的 `snapshot_uploads` 行；`missing` = 都没有。不另开命令：详情页本来就一次取完，另开一个会让时间线先画出错误状态再闪变。
- 时间线里的 `fill_*` 事件显示：结果、填写 X / 共 Y、未确认 Z、耗时、模板名与版本；有 `snapshotId` 时显示「查看简历快照」（`stored`）或「快照上传未完成」（`uploading`）或「快照不可用」（`missing`）。
- 快照查看视图只读，顶部固定说明：「这是插件在留档时从简历模板拷贝的内容，用来追溯当时用了哪份资料；它**不能**证明网站最终收到或保存了这些内容。」若 `omittedFieldCount > 0`，说明「N 个疑似密码 / 验证码类字段未保存」。
- 删掉 `applications-ui.js:201` 里「简历快照尚未接入」的说法（附件、待办仍未接入则保留那部分）。
- 所有快照内容经 `escapeHtml` 渲染；不在日志或诊断导出里写快照内容（ADR 诊断包「不含附件与快照正文」）。

**测试：**

- 前端：三种快照状态各自的渲染与按钮；免责声明文字存在（字符串断言）；恶意字段值（`<img onerror>`）被转义。
- 命令：快照文件被篡改 → 错误而非内容；缺文件 → 错误；正常 → 字段与写入一致。
- 时间线中「填写完成」不出现「已投递」字样（规则 1）。

**覆盖 #22 的：** 验收 6（能从事件打开快照、明确不是最终提交内容的证明）；验收 1 的「历史申请仍能看到 v1 快照」的查看一侧。

**不做：** 快照导出、对比两份快照（不在 D08 范围）。

---

## PR 7 · 端到端验收、隐私回归与文档收口

**只做：** 真实浏览器跑通 D08 的全链路，补齐隐私回归，把实现中确认的契约写回文档，给 #22 贴验收证据。

**文件：** `desktop/scripts/d08_browser_check.py`、`tests/link-privacy-d08.test.js`、`docs/desktop-mvp/{product-requirements.md, data-privacy.md}`、`desktop/crates/protocol/INTEGRATION.md`、`desktop/crates/archive-store/INTEGRATION.md`、`README.md`

**关键契约：**

- `d08_browser_check.py`（驱动已发布的插件本身，仿 `d07_browser_check.py`）四个阶段：
  1. **离线留档后改模板**（走查 10.10）：桌面未运行 → 用模板 v1 填写合成表单 → 留档并附快照 → 改成 v2 → 启动桌面 → 待同步里选申请 → 等上传完成 → 桌面打开的快照内容是 v1；
  2. **上传中断**（走查 10.14）：上传到一半用 CDP 停 SW → 恢复后完成，总哈希不变；
  3. **拒绝留档**：填写后点「不留档」→ 桌面库里没有新事件、NM 零写入；
  4. **敏感字段**：模板里放合成的「登录密码」字段、页面 URL 带 `access_token` → 快照、事件、桌面日志、备份目录里都搜不到这两个值。
  **关闭顺序：先让应用退出，再关浏览器**（D06 的实测约束）。
- 文档同步（按 downstream-decisions §5 顺序，先改文档再关 issue）：§8.10 的 key 列表加 `desktopFillRecords`（若 Q1 同意，PR3 已改则此处核对）；§8.5 补「快照冻结的是填写时实际使用的模板」、快照 JSON v1 格式、32 KiB 块大小；archive-store INTEGRATION 记录迁移 v2 与「块字节与回执同事务」；README 的 AI 配置 / 桌面一节补一句留档说明。
- 全量回归：`node --test tests/*.test.js` 与 desktop.yml 的全部步骤全绿。

**测试：** 上面四个阶段；`link-privacy-d08.test.js` 对 `fill.submit` payload、快照字节、outbox 条目、`FillRecord` 做统一的 secret 搜索断言（合成的密码、验证码、API Key、`access_token` 值一个都不能出现）。

**覆盖 #22 的：** 验收 5（敏感字段、URL 令牌、配置密钥不进入事件、日志和备份）完整；验收 1 的端到端；完成条件三条（证据、PR 链接、契约同步）。

---

## 依赖与并行

```text
PR1 (插件: 快照格式 + IDB 暂存, V12 门禁) ──┐
PR2 (桌面: 块落盘 + 两种 ACK) ──────────────┼──> PR4 (插件: 分片上传) ──> PR5 (插件: 对账) ──┐
PR3 (插件: 留档确认 + fill.submit) ─────────┘                                             ├──> PR7
PR2 ──> PR6 (桌面: 时间线 + 快照查看) ──────────────────────────────────────────────────────┘
```

- **PR1、PR2、PR3 互不依赖，可以并行开工。** PR1 是 V12 门禁，建议最先合：它若失败，PR4 的范围要改。
- PR3 与 PR1 都改 `link/limits.mjs` 与 `link/worker.mjs`，谁先合谁不改，后者 rebase。
- PR4 同时依赖 PR1（暂存）、PR2（桌面 ACK）、PR3（留档意图与绑定流程）。
- PR6 只依赖 PR2，可与 PR3–PR5 并行。
- PR5 与 PR4 都改 `link/uploads.mjs` 与待同步面板，顺序合并。

## #22 验收清单的覆盖

| #22 验收 | PR |
| --- | --- |
| 用模板 v1 填写后修改成 v2，历史申请仍能看到 v1 快照 | PR1（字节冻结）+ PR4（原字节上传）+ PR6（查看）+ PR7（端到端） |
| 重传留档不会复制快照或事件，快照与事件写入一致 | PR2（块与完整快照幂等）+ PR3（同 `messageId` 重发）+ PR4（完整 ACK 丢失后重发） |
| 失败 / 用户取消也有准确结果；尚未确认写入的字段不能记成已提交 | PR3 |
| 用户拒绝留档时正常填表，不额外发送采集数据 | PR3 + PR7 |
| 敏感字段、URL 令牌、配置密钥不进入事件、日志和备份 | PR1（快照剥离）+ PR2（桌面日志）+ PR3（payload allowlist、URL 脱敏）+ PR7（统一回归） |
| 本地详情能从事件打开相应快照，明确它不是网站最终提交内容的完整证明 | PR6 |

| #22 测试项 | PR |
| --- | --- |
| 模板变更 | PR1 + PR4 + PR7 |
| 部分填写 | PR3 |
| 手动取消 | PR3 |
| 未绑定申请 | PR3 |
| 禁止采集字段 | PR1 + PR3 + PR7 |
| 应答丢失重传 | PR2 + PR3 + PR4 |
| 快照事务失败 | PR2（写文件 / 提交失败）+ PR4（IDB 失败） |

| D01 强制走查 | PR |
| --- | --- |
| 10.10 离线留档后改模板 | PR4 + PR7 |
| 10.14 在线开始、上传中断、模板改变 | PR4 + PR7 |
| 10.21 快照分片身份（正常 + 反例 1–4） | PR2 + PR4 + PR5 |
| 10.22 / 10.23 信封身份与来源 epoch | PR5（沿用 D07） |

## 明确不在 D08 范围

- **逐字段值留档**（Q2）：协议无字段，默认 OFF。需要时另开 issue，先改 D05。
- **把离线留档自动挂到本页待同步的保存意图上**：离线时留档意图不关联 SaveIntent，桌面恢复后由用户在待同步面板选申请。自动挂接要处理意图被取消、被另存、绑到别的申请等分支，收益不足以进 MVP。
- **chip 逐字段手动填写的留档**（决策 9）。
- **快照导出、快照对比、从桌面导入快照**：§8.5 提到超限「走桌面导入」，那条路径不在 D08 实现，超限时只明确失败。
- **备份与恢复本身**（D12 #28）：块字节在 SQLite 里，随库备份；快照文件在 `snapshots/`，D12 的一致性屏障已把它列入。D08 只保证这两处的数据自洽。
- **生产安装与 host 注册**（D13 #29）。

## 风险登记（downstream-decisions.md）

| 编号 | 风险 | 本计划的处置 |
| --- | --- | --- |
| V12 | 扩展源 IndexedDB 在 SW 重启后能否读回 | PR1 的 `d08_idb_check.py` 是门禁；失败则按 §5 改产品条款后再继续，不在代码里悄悄降级 |
| V5 | 64 KiB 真实拒绝行为 | 32 KiB 块；PR1 用最大块造信封断言 ≤ 65536 且能过校验 |
| V4 | 一次性 `sendNativeMessage` 每条消息拉起一次 host | 2 MiB 快照最多 64 块，最坏约数十秒，全在后台串行、跨 SW 回收由 alarm 续上；常见快照几十到几百 KiB（1–8 块）。若实测过慢，按 D07 决策 1 只改 `link/transport.mjs` 换长连接 |
| 新 | 快照格式演进 | `formatVersion` 字段；桌面不认识的格式只影响模板名显示，不影响入库与查看原文 |
| 新 | 桌面 v1 → v2 迁移 | 沿用 `migration.rs` 的迁移前备份；v1 库没有块行，迁移只建表 |
