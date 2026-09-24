# #130 PR 5：旧数据迁移、插件瘦身、文档与 0.4.1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 老用户升级到 0.4.1 后，插件里的模板、「我的信息」和 AI Key 能在桌面确认后迁入桌面，确认前数据不丢。插件管理页精简为连接状态页。文档改为统一后的口径，插件和桌面版本升到 `0.4.1`。

**Architecture:** 桌面端补上确认界面，包括预览、「我的信息」冲突选择、模板超额提示、AI 步骤失败后的收尾，以及收到导入时的实时通知。插件 service worker 在握手成功后检测旧数据，按 PR 3 定好的 `legacy.import` 协议发送清单和分片，然后轮询状态，只有状态为 `imported` 才清理本地旧数据。插件管理页删除模板、我的信息、AI 配置、备份和简历解析，只保留连接状态、打开桌面和迁移状态。

**Tech Stack:** Rust（archive-store、src-tauri）、React 19 / TS（桌面简历页）、Chrome MV3 无构建 JS（`link/`、`popup.*`）、`node --test`、Vitest。

**前置与合并顺序：**
- 桌面端任务（Task 1–4）只依赖 main，**现在就能做**。
- 插件端任务（Task 5–9）依赖 PR 4（#162）：v2 信封、`probe()` 模式、`DESKTOP_OPEN_VIEW`、`DESKTOP_DOWNLOAD_URL`、侧栏降级区。**PR 4 合入后先 `git merge origin/main` 再做。**
- 一个 PR。**PR 4 与 PR 5 连着合入，中间不发版**；PR 5 合入后才能出 `desktop-v0.4.1-beta.N`。
- 仓库规则禁止强推，同步 main 一律用 merge。

---

## 已核实的现状（基线 `307a358`，PR 3b 与 #164 已合入）

**协议（`desktop/crates/protocol/schemas/payloads/legacy-import.json`、`responses/legacy-import.json`）**
- `kind`：`manifest`（index 0）、`template`、`profile`、`aiConfig`、`status`。清单 `body = { pluginVersion, total(1..63), parts:[{index, kind, sha256}] }`。
- 分片 body：
  - `template = { name(1..100 字), wasActive, groups:[{name, fields:[{key,value}]}] }`；
  - `profile = { values, family, custom(≤200) }`；
  - `aiConfig = { apiUrl, model, apiKey }`。
- `sha256` 用 `payloadBodySha256(body)`（`link/protocol/validate.mjs`）。
- 响应：`{ state: receiving|awaiting_confirmation|imported|rejected|expired, received, total, aiConfigDropped? }`。`aiConfigDropped: true` 只会和 `imported` 一起出现（#164）。
- 幂等：同 `(importId, index)` 同摘要返回原结果，摘要不同返回 `conflict`。同一时间只接受一批，另一个 `importId` 在当前批未结束时返回 `conflict`。
- `aiConfig` 是协议里唯一允许带 Key 的位置，`apiUrl` 的 http 例外也只在这里。

**桌面存储（`desktop/crates/archive-store/src/legacy_import.rs`）**
- 清单：模板 ≤ `MAX_TEMPLATES`（25）、档案 ≤1、AI 配置 ≤1。
- 分片到达即校验：模板走 `checked_groups`，单个模板 JSON > 24 KiB 报错（`resume.rs` `MAX_TEMPLATE_BYTES`）。档案走 `validate_profile` 和 `reject_profile_secrets`，**有一项像密码就整片拒绝**。
- 24 小时未收齐的批次过期。
- `apply_legacy_confirmation`：
  - 已有模板数 + 本批模板数 > 25 时，返回 `invalid`，文案带两个数字。命令层映射为 `template_limit`（`legacy_import_commands.rs`）。
  - **桌面已有非空「我的信息」时返回 `conflict("existing profile requires a user choice")`，目前没有任何办法让用户做这个选择。** 本 PR 要补上。
  - 模板逐个 `create_template`（重名编号），`wasActive` 的设为当前。
- 确认流程在 `legacy_import_commands::confirm`：先应用模板和档案（写 `applied_at`），再安装 AI 服务商，最后收尾。
- 拒绝：已应用的批次收尾为 `imported` 且 `ai_config_dropped = 1`。拒绝前先清理可能装了一半的服务商（#164）。
- `list_pending_legacy_imports` 返回 `{ importId, state, received, total, pluginVersion, applied }`。

**桌面命令与界面**
- 已有 `list_legacy_imports_cmd`、`confirm_legacy_import_cmd`、`reject_legacy_import_cmd`（`desktop/src-tauri/src/lib.rs` ≈786–800）。
- **桌面界面里还没有任何导入相关的 UI**：`desktop/src/` 下搜不到 legacy。
- 插件写入后通知窗口的机制已有先例：`ipc_server::OpenArchive::notifying(..)` 在事务提交后 `emit("applications-changed")`（#153）。
- `ui.open` 支持 `resume`、`settings-ai`、`home`。

**插件（PR 4 合入后的预期状态，开工前复核）**
- 旧数据在 `chrome.storage.local` 的 `templates`、`activeTemplateId`、`profile`、`aiConfig`。PR 4 之后运行时不再读它们，只有 `popup.js` 还在用。
- `popup.html`（约 230 行）加载了 `xlsx.full.min.js`、`mammoth.browser.min.js`、`ai-helpers.js`、`resume-utils.js`、`profile-fields.js`、`ai-client.js`、`ai-models.js`、`popup.js`；`vendor/pdfjs/` 只给简历解析用。
- `ai-worker.js` 仍 `importScripts("ai-helpers.js", "resume-utils.js", "form-agent.js")` 做填写，**这两个文件不能删**。桌面 `desktop/src/resume/profile-sync.test.ts` 锁定它们和 `profile-fields.js` 与插件逐字节一致。
- `background.js` 的 `openManagerTab()` 打开 `popup.html`：浏览器没有侧栏 API 时，点工具栏图标走这里（#161）。
- `profile-fields.js` 有 `SECRET_LABEL` / `SECRET_VALUE`，与桌面 `resume_secrets.rs` 同一口径。

---

## 已定的设计

1. **何时迁移。** 在 service worker 里，`probe()` 为 `ready` 且本地有旧数据时开始。旧数据指：模板非空、`hasProfileContent(profile)`，或 `aiConfig.apiKey` 非空，三者满足其一。只有默认 AI 地址和模型、没有 Key 的不算。触发点：扩展启动或安装更新（`runtime.onStartup` / `onInstalled`），加上侧栏打开时的握手。同一时间只跑一个迁移任务，service worker 重启后从持久化状态续上。

2. **持久化状态。** `chrome.storage.local.legacyImport`：
   ```
   { importId, phase, parts: [{index, kind, sha256}], skipped: {...}, lastState, updatedAt }
   ```
   `phase` 取值：`sending`、`waiting`、`imported`、`imported_ai_dropped`、`rejected`、`expired`。清单和分片摘要在第一次计算后固定下来，重发时用同一个 `importId` 和同一批摘要，靠幂等保证安全。

3. **发送前整理，只发桌面能收下的。**
   - **模板**：沿用 `popup.js` 的 `normalizeTemplate` 规则（空组、空 key 丢弃）；名称超过 100 字截到 100。`wasActive = (id === activeTemplateId)`。序列化后 `groups` 超过 24 KiB 的模板**不发**。超过 25 个时，当前模板优先，其余按原顺序取前 25 个，多出的不发。
   - **我的信息**：`profile-fields.js` 新增 `stripProfileSecrets(profile) → { profile, removed }`：
     - 剔除 `values` 与家庭成员中值命中 `SECRET_VALUE` 的项；
     - 剔除 `custom` 中 key 命中 `SECRET_LABEL` 或值命中 `SECRET_VALUE` 的项。
     剔除后为空就不发这一片。改完原样复制到 `desktop/src/resume/profile-fields.js`，逐字节测试会检查。
   - **AI 配置**：只有 `apiKey` 非空才发 `{ apiUrl, model, apiKey }`。

   **没发出去的模板不丢**：记进 `legacyImport.skipped.templates`，写明名称和原因（`too_large` / `over_limit`）。状态页提供「下载这些模板（CSV）」，表头 `一级分类,字段名,值`，桌面「简历」页能直接导入 CSV。
   **剔掉的敏感项不迁移**：个数记进 `legacyImport.skipped.profileSecrets`，状态页说明。

4. **发送。** 先发清单，再按 index 逐片发送，全部用一次性 `sendNativeMessage`，不走 PR 4 的长连接。遇到 `conflict`（另一批正在进行）：保持 `sending`，5 分钟后用 `chrome.alarms` 重试。遇到 `invalid_payload`：停止，状态页显示「有数据桌面不接受」和错误文案，**不清任何本地数据**。全部发完后发一次 `ui.open { view: "resume" }`，把桌面拉到简历页，确认横幅就在那里。

5. **轮询与清理。** `waiting` 阶段每 1 分钟查一次 `status`（alarm），另外侧栏和状态页打开时各查一次。
   | 桌面返回 | 插件做什么 |
   | --- | --- |
   | `receiving` / `awaiting_confirmation` | 继续等 |
   | `imported`（没有 `aiConfigDropped`） | 删除 `templates`、`activeTemplateId`、`profile`、`aiConfig`，`phase = imported` |
   | `imported` + `aiConfigDropped` | 删除 `templates`、`activeTemplateId`、`profile`，**保留 `aiConfig`**，`phase = imported_ai_dropped` |
   | `rejected` | 不删任何数据，`phase = rejected`，**不自动重发** |
   | `expired` | 不删数据；下次 `ready` 时用新的 `importId` 自动重来一次，再过期就停下，交给状态页 |
   | 查询失败 | 不删数据，下次再查 |

   `skipped` 里的模板在清理时保留，存到 `legacyUnmigratedTemplates`，直到用户下载或删除。

6. **桌面确认界面放在「简历」页顶部，用横幅加确认面板**（不用系统弹窗，免得启动时抢焦点）。
   - **收到导入**：`plugin_bridge` 处理 `legacy.import` 且事务提交后，`emit("legacy-import-changed")`，复用 `OpenArchive` 的通知机制，增加一种事件。简历页监听这个事件，挂载时也查一次 `list_legacy_imports_cmd`。
   - **`receiving`**：横幅显示「正在接收插件里的旧数据（已收 x / 共 y）」。
   - **`awaiting_confirmation`**：面板展示预览（新命令 `legacy_import_preview_cmd`，**不含任何 Key 和字段值**）：
     - 每个模板的名称、字段数、是否曾是当前模板；
     - 「我的信息」有几项；
     - AI 配置的主机名和模型（或「不含 AI 配置」）；
     - 桌面现有模板数、桌面「我的信息」是否为空。
   - **「我的信息」冲突**：桌面已有非空档案时，面板要求在两项里选一个：「保留桌面的」「用插件里的覆盖」。不选不能确认。确认命令带上 `profileChoice`（`keep_desktop` / `use_imported`）。
   - **模板超额**：确认返回 `template_limit` 时，显示「桌面已有 N 个，要导入 M 个，超过 25 个上限，请先删掉一些」，按钮可跳到模板列表。删完回来再点确认即可。
   - **AI 步骤失败**（`applied = true` 仍是 `awaiting_confirmation`）：面板显示「简历和我的信息已导入，AI 配置没导入成功」，提供「重试」（再次确认）和「不导入 AI 配置」（调用拒绝，结果是 `imported` 且 `aiConfigDropped`）。
   - **拒绝**：未应用时显示「不导入」，二次确认后调用拒绝。文案说明「插件里的数据会保留，之后可以从插件重新发起」。
   - 确认成功后刷新模板列表、我的信息和 AI 设置。

7. **存储层的档案选择。** `apply_legacy_confirmation(import_id, profile_choice: Option<ProfileChoice>)`：
   - 桌面档案为空（`revision == 0` 且内容为空）：忽略选择，直接写入。
   - 桌面档案不为空且没有选择：保持现有的 `conflict`。
   - `KeepDesktop`：跳过档案分片。
   - `UseImported`：用当前 revision 写入，覆盖桌面档案。
   - 仍在同一事务里，仍经过 `validate_profile` / `reject_profile_secrets`。

8. **插件管理页变成状态页**（`popup.html/js/css` 重写，文件名不变，免得动 `background.js` 和 manifest）：
   - 桌面连接状态：复用 PR 4 降级表的五种模式与文案；正常时显示「已连接桌面」和桌面版本。
   - 按钮：「打开桌面」（`DESKTOP_OPEN_VIEW home`），没装桌面时显示「去下载」。
   - 迁移区：按 `legacyImport.phase` 显示对应说明与操作。
     - `rejected` 时提供「重新发送到桌面」（新的 `importId`）和「删除插件里的旧数据」（二次确认）。
     - `imported_ai_dropped` 时提供「复制旧 API Key」（用户主动点，写入剪贴板）和「删除旧 Key」。
     - 有 `skipped` 时提供「下载未迁移的模板（CSV）」。
   - 更新提示：`incompatible` 时说明要更新桌面；插件版本从 manifest 读。
   - **删掉**：模板管理、Excel/CSV 导入导出、JSON 备份导入导出、我的信息编辑、AI 配置与获取模型、简历解析，以及它们的全部代码。

9. **侧栏的迁移提示。** 侧栏（`sidepanel.js`，以及没有侧栏 API 时的 `content.js`）在 PR 4 降级区旁加一行，只在 `sending` / `waiting` 时出现：「插件里的旧简历正在迁到桌面，请到桌面『简历』页确认」，附「打开桌面」按钮。其他阶段不打扰，状态页里有详情。

10. **删除清单**：`xlsx.full.min.js`、`mammoth.browser.min.js`、`vendor/pdfjs/`、`ai-models.js`，`ai-worker.js` 里 `PARSE_RESUME` 相关代码（PR 4 已改为返回「已搬到桌面」，这里直接删掉），以及对应测试。`ai-client.js` 如果 PR 4 之后只剩填写在用，就保留。`desktop/scripts/plugin-release-assets.json`、manifest 的 `web_accessible_resources` 和 CSP 同步修改。`resume-utils.js`、`ai-helpers.js`、`profile-fields.js`、`form-agent.js` 保留。

---

## 文件结构

| 文件 | 改动 |
| --- | --- |
| `desktop/crates/archive-store/src/legacy_import.rs` | `apply_legacy_confirmation` 加 `profile_choice`；新增 `legacy_import_preview(import_id)` |
| `desktop/crates/archive-store/tests/legacy_import.rs` | 档案选择三种情况、预览不含 Key 与字段值 |
| `desktop/src-tauri/src/legacy_import_commands.rs` | `confirm` 透传 `profile_choice`；新增 `preview` |
| `desktop/src-tauri/src/lib.rs` | `confirm_legacy_import_cmd` 加参数；注册 `legacy_import_preview_cmd`；接上 `legacy-import-changed` 事件 |
| `desktop/src-tauri/src/ipc_server.rs` | 通知机制增加 `legacy.import` 提交后的事件 |
| `desktop/src/resume/LegacyImport.tsx`（新）+ 测试 | 横幅、确认面板、档案选择、超额提示、AI 失败收尾、拒绝 |
| `desktop/src/resume/*`（挂载处） | 在简历页顶部挂载；确认后刷新 |
| `profile-fields.js` + `desktop/src/resume/profile-fields.js` | `stripProfileSecrets` |
| `link/legacy.mjs`（新） | 检测、整理、清单与分片、发送、轮询、清理、CSV 生成 |
| `link/messages.mjs`、`link/router.mjs`、`link/worker.mjs` | `DESKTOP_LEGACY_STATUS`（读状态）、`DESKTOP_LEGACY_RESEND`、`DESKTOP_LEGACY_DISCARD`；alarm 轮询 |
| `popup.html/js/css` | 重写为状态页 |
| `sidepanel.*`、`content.js` | 迁移中提示一行 |
| `ai-worker.js` | 删除 `PARSE_RESUME` |
| 删除 | `xlsx.full.min.js`、`mammoth.browser.min.js`、`vendor/pdfjs/`、`ai-models.js` 及测试 |
| `manifest.json`、`desktop/scripts/plugin-release-assets.json` | 同步删除项 |
| 文档 | 见 Task 10 |

---

### Task 1：存储层「我的信息」选择与预览

- [ ] 测试（`desktop/crates/archive-store/tests/legacy_import.rs`）：
  - 桌面档案为空，`apply(.., None)` 写入导入的档案。
  - 桌面档案非空，`apply(.., None)` 返回 `Conflict`，模板**没有**被创建。
  - `KeepDesktop`：模板导入，档案不变，revision 不变。
  - `UseImported`：档案被覆盖，revision 加 1。
  - 导入的档案含密码类内容时两种选择都返回 `Validation`，整批回滚。
  - `legacy_import_preview`：返回模板 `{name, fieldCount, wasActive}`、`profileItemCount`、`ai: {host, model} | null`、`desktopTemplateCount`、`desktopProfileEmpty`；序列化结果里搜不到任何字段值、`apiUrl` 路径或 Key（用合成值断言）。
- [ ] 实现：`ProfileChoice` 枚举。预览从暂存分片计算，`host` 由 `apiUrl` 解析，只取主机名。
- [ ] 提交 `feat(store): 旧数据导入支持选择保留哪份我的信息，并提供不含内容的预览 (#130)`。

### Task 2：命令与事件

- [ ] 测试：`legacy_import_commands::confirm` 透传选择（`FakeServices`）；`preview` 的错误映射；`ipc_server` 里 `legacy.import` 提交后触发一次通知，状态查询不触发（照 `a_committed_plugin_write_notifies…` 写）。
- [ ] 实现：`confirm_legacy_import_cmd(import_id, profile_choice: Option<String>)`，取值 `keep_desktop` / `use_imported`，其他值报参数错误；注册 `legacy_import_preview_cmd`；`emit("legacy-import-changed", {importId, state})`。
- [ ] 提交 `feat(desktop): 旧数据导入的预览命令与到达通知 (#130)`。

### Task 3：简历页的导入横幅与确认面板

- [ ] 测试（Vitest，照 `desktop/src/resume/*.test.tsx` 的写法注入假 `invoke` / `listen`）：
  - `receiving` 显示进度；`awaiting_confirmation` 显示预览。
  - 桌面档案非空时不选就不能确认，选了以后带上 `profileChoice`。
  - `template_limit` 错误显示两个数字和跳转按钮。
  - `applied` 时显示「重试 / 不导入 AI 配置」，后者调用拒绝。
  - 拒绝需要二次确认。
  - 收到 `legacy-import-changed` 会重新查询；确认成功后触发模板列表、我的信息和 AI 设置刷新。
  - **界面上找不到 Key、`apiUrl` 路径或任何字段值。**
- [ ] 实现 `LegacyImport.tsx`，挂到简历页顶部。样式沿用简历页现有的卡片与按钮类。
- [ ] 提交 `feat(desktop): 简历页确认插件旧数据导入 (#130)`。

### Task 4：桌面侧小结

- [ ] `cd desktop && npm test`、`cargo test --locked`（src-tauri、archive-store、protocol）全绿。
- [ ] 用 `nm_host.rs` 的真实进程写法（Windows 限定，已有先例）或 `plugin_bridge` 测试发一整批合成导入，确认面板能拿到预览；这一步可以只做 Rust 集成测试。

### Task 5：`stripProfileSecrets`（PR 4 合入后从这里开始）

- [ ] 先 `git merge origin/main`。
- [ ] 测试（`tests/profile-fields.test.js`）：`values`、家庭成员、`custom` 三处各一条会被剔除的项和一条不会被剔除的项；`removed` 计数正确；输入不被修改。
- [ ] 实现并复制到 `desktop/src/resume/profile-fields.js`；`desktop/src/resume/profile-sync.test.ts` 通过。
- [ ] 提交 `feat(profile): 迁移前剔除我的信息里的密码类内容 (#130)`。

### Task 6：`link/legacy.mjs`：整理与发送

- [ ] 测试（新 `tests/link-legacy.test.js`，照 `link-outbox.test.js` 的假 `sendNative` 和假 `chrome.storage`）：
  - 无旧数据：不发任何消息。
  - 整理规则：空组丢弃；名称截断；`wasActive`；24 KiB 以上的模板进 `skipped`；超过 25 个时当前模板优先；没有 Key 不发 `aiConfig`；档案剔除后为空不发。
  - 清单的 `total` 与 `parts` 与实际分片一致，`sha256` 等于 `payloadBodySha256(body)`。
  - service worker 重启（重建模块、保留 storage）后，用同一 `importId` 和同一批摘要续发，已收到的分片重发得到原结果。
  - `conflict` 时安排 alarm，不清数据；`invalid_payload` 时停止，记录文案。
  - 发完后发一次 `ui.open {view:"resume"}`。
  - 发送的消息里**只有 `aiConfig` 分片带 `apiKey`**，其他任何消息与 `legacyImport` 状态里都没有 Key。
- [ ] 实现 `link/legacy.mjs`，在 `link/worker.mjs` 里接上 `onStartup` / `onInstalled` / alarm。
- [ ] 提交 `feat(link): 升级后把插件旧数据发到桌面等待确认 (#130)`。

### Task 7：轮询与清理

- [ ] 测试：设计第 5 条表格的每一行各一条；`skipped` 模板清理后仍在 `legacyUnmigratedTemplates`；`expired` 只自动重来一次；`rejected` 不自动重发，调用 `DESKTOP_LEGACY_RESEND` 才用新的 `importId` 重发；`DESKTOP_LEGACY_DISCARD` 删除四个键和 `legacyUnmigratedTemplates`（调用方负责二次确认）。
- [ ] 实现：`DESKTOP_LEGACY_STATUS` / `RESEND` / `DISCARD` 走 router；CSV 生成函数（UTF-8 BOM，字段里的逗号、引号、换行按 RFC 4180 转义）。
- [ ] 提交 `feat(link): 按桌面导入结果清理插件旧数据 (#130)`。

### Task 8：状态页替换管理页

- [ ] 测试（`tests/popup-status.test.js`，vm 加载 `popup.js`，注入假 `chrome`）：五种桌面模式的文案与按钮；迁移区各阶段的说明与按钮；「复制旧 API Key」只在 `imported_ai_dropped` 出现，并且需要点击才写剪贴板；「删除插件里的旧数据」要二次确认；CSV 下载的文件名与内容；源码静态断言 `popup.js` 不再出现 `templates` 写入、`xlsx`、`mammoth`、`pdfjs`、`fetch(`。
- [ ] 实现：重写 `popup.html/js/css`；删除设计第 10 条列出的文件和代码以及对应测试；更新 `manifest.json`、`plugin-release-assets.json`；`node desktop/scripts/check-plugin-release-allowlist.js` 通过。
- [ ] 侧栏与 `content.js` 加迁移中提示（设计第 9 条），各一条测试。
- [ ] 提交 `feat(plugin): 管理页精简为连接与迁移状态页，删除本地管理功能 (#130)`。

### Task 9：插件侧小结

- [ ] 全仓搜索：`rg -n "aiConfig|apiKey" --glob '!tests/**' --glob '!desktop/**' .`，只允许出现在 `link/legacy.mjs` 和 `popup.js` 的迁移区。`rg -n "chrome\.storage\.local\.(get|set)" popup.js sidepanel.js content.js link/` 里不再读写 `templates` / `profile`，迁移代码除外。
- [ ] 仓库根 `npm test`、`cd desktop && npm test` 全绿。

### Task 10：文档与版本

- [ ] `docs/desktop-mvp/adr-architecture.md` §5「数据服务职责边界」、§6「API / Interface Changes」：桌面是模板、我的信息、AI 配置的唯一来源；插件只填表；协议 v2 的五类消息。
- [ ] `docs/desktop-mvp/data-privacy.md`：
  - 插件 AI 一列改为「经桌面发往当前服务商，插件不持有 Key」，Key 只在 OS 凭据库；
  - 旧数据迁移一节写清发送范围、确认、清理条件、`aiConfigDropped`、未迁移模板与剔除项。
- [ ] `docs/privacy-policy.md`、`docs/store-listing.md`：
  - 去掉「不装主程序也能用」，写明需要桌面程序，平台限 macOS Apple 芯片和 Windows x64；
  - 权限说明对应删减后的实际用途；
  - 商店数据使用声明同步。
- [ ] `docs/desktop-mvp/install-and-update.md` §5「升级」：写老用户从 0.4.0 升级的步骤（先装桌面 → 插件自动发送 → 在桌面确认）。
- [ ] `README.md`：安装、使用、常见问题改为桌面加插件的统一口径，项目结构去掉已删文件。
- [ ] 版本按 `docs/release-sop.md`：根目录 `manifest.json` 的 `version` 手动改为 `0.4.1`（插件）；`node desktop/scripts/set-version.js 0.4.1` 同步 Tauri 配置、`Cargo.toml` 与 `Cargo.lock`（桌面）；`desktop/package.json` 与其 lock 一并改为 `0.4.1`。`cd desktop && npm run test:desktop-release` 通过。
- [ ] 提交 `docs: 统一后的文档口径，版本 0.4.1 (#130)`。

### Task 11：验收与开 PR

- [ ] 准备一份**合成的** 0.4.0 插件数据：`tests/fixtures/legacy-0.4.0-storage.json`，包含 3 个模板（其中一个超过 24 KiB）、含一项「邮箱密码」的我的信息、带合成 Key 的 AI 配置。自动化测试用它走一遍整理 → 发送 → `imported` → 清理。
- [ ] 真机走查（需要人，Chrome 与 Edge 各一次，用本 PR 的桌面开发版加插件；**不要用真实简历或真实 Key**）：
  1. 在 0.4.0 插件里装入合成数据，升级到本 PR → 桌面简历页出现横幅 → 确认 → 模板、我的信息、AI 服务商都到位 → 插件四个键被清空，状态页显示已迁移。
  2. 桌面已有我的信息时两种选择各走一次。
  3. 拒绝：插件数据原样保留；「重新发送」能再次走通。
  4. 让 AI 步骤失败（例如先在桌面加满服务商）→「不导入 AI 配置」→ 插件保留旧 Key，状态页能复制和删除。
  5. 超大模板 → 状态页能下载 CSV，桌面导入 CSV 成功。
  6. 发到一半关掉桌面 → 重新打开后能续完。
- [ ] 推送并开 PR（`feat: 旧数据迁移到桌面、插件精简与 0.4.1 (#130 PR 5)`，`Refs #130`），描述写明**与 PR 4 连着合、中间不发版**，以及发布顺序：桌面正式版可下载之后，插件才送审商店。

---

## 自检

- 覆盖拆分计划 PR 5 的四项：迁移（Task 1–3、5–7）、瘦身（Task 8）、文档（Task 10）、版本（Task 10）。
- 相对拆分计划的调整：
  - 「剔除几项在确认弹窗里说明」改为在插件状态页说明。清单格式不变，不用再改协议；桌面预览只显示剔除后的项数。
  - 新增「我的信息」选择与预览命令，因为 PR 3b 的存储层只会报冲突。
  - 新增未迁移模板的 CSV 下载，保证数据不丢。
  - `aiConfigDropped` 的处理按 #164 的约定。
- 数据不丢的底线：插件只在 `imported` 时删除，而且只删已经迁过去的部分。没发出去的模板和被桌面放弃的 Key 都留在插件里，状态页可以取回或删除。
