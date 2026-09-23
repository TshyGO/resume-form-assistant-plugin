# #130 插件与桌面统一 PR 拆分计划

> **For agentic workers:** 本文是 **PR 级拆分**，不是可直接执行的任务清单。每个 PR 开工时先用 superpowers:writing-plans 为该 PR 写 bite-sized 实现计划（存到 `docs/superpowers/plans/YYYY-MM-DD-u130-prN-<name>.md`），再用 superpowers:subagent-driven-development 或 superpowers:executing-plans 执行。

**Goal:** 桌面成为简历模板、「我的信息」、AI 服务商配置和 API Key 的唯一来源，插件只负责在网页里识别字段和填写。插件不再保存这些数据，也不再直接向 AI 服务商发请求。

**Architecture:** 桌面档案库新增模板与档案两张表，桌面界面接手插件弹窗的全部管理功能。协议升到 v2，新增读取简历数据、写入「我的信息」补充字段、AI 转发、打开桌面指定页面、旧数据导入五类消息。插件侧边栏和 AI worker 改为经 service worker → Native Messaging → 桌面取数据、发请求；插件弹窗精简为连接状态页。

**Tech Stack:** Rust（`archive-store`、`protocol`、`src-tauri`）、`reqwest`、`keyring`、Tauri 2、React 19 + TypeScript、Vitest；插件为原生 MV3 JS（无构建步骤）、`node --test`。

**Spec 来源：** [#130](https://github.com/TshyGO/resume-form-assistant-plugin/issues/130)（2026-09-23 补全版）· [#15 「插件强制依赖桌面」决策](https://github.com/TshyGO/resume-form-assistant-plugin/issues/15) · [ADR](../../desktop-mvp/adr-architecture.md) · [data-privacy](../../desktop-mvp/data-privacy.md) · [D11 拆分计划](2026-09-15-d11-pr-breakdown.md)

**基线：** `69d754c`（main，含发版 SOP #149）

---

## 负责人已定（2026-09-23）

1. **只支持 OpenAI 兼容的 Chat Completions。** PR #146 里的 Responses / Anthropic 协议支持不进入本线。
2. **多服务商只在桌面做。** 插件不再有任何配置界面。
3. **平台只做 Windows x64 与 macOS Apple Silicon。** Intel Mac、Linux 不支持，在商店说明与下载页写清楚。
4. **直接发统一版，不先发过渡提示版。** 新版插件首次打开即引导安装桌面。
5. **桌面没有响应时插件不能填写，只提示重试。** 不在插件里缓存档案，保持 ADR §6「桌面档案不镜像进 `chrome.storage`」。
6. **下一个正式版为 0.4.1，插件与桌面一起发。不单独发 `desktop-v0.4.0`**，桌面首个正式版就是统一后的 `desktop-v0.4.1`，#132 / #133 的验收在统一版候选上执行。本线 PR 直接合入 `main`。
7. **侧边栏的填写能力全部保留**：简历条目点选填写（含添加/替换）、切换模板、一键 AI 填写、AI 辅助新增条目、加到我的信息、保存岗位、确认已投递、留档。AI 填不完整时用户仍靠条目手动补。变的只是数据来源（改读桌面）和 AI 请求出口（改由桌面发）。
8. **管理功能全部搬到桌面**：模板、我的信息、简历解析、AI 配置。插件管理页只剩连接状态、「打开桌面」和更新提示；插件 JSON 备份删除，由桌面备份覆盖。侧边栏「打开管理面板」改为「打开桌面」，「上传简历 / 导入模板」改为打开桌面的「简历」页。

## 其他

- #145（文本输入校验生命周期，P0）与本线无冲突，照常先合入。

---

## 已核实的现状（基线 69d754c，实现时直接用，不必再查）

### 插件数据

- `chrome.storage.local` 四个键：`templates`、`activeTemplateId`、`aiConfig`、`profile`（`popup.js:1` `DEFAULT_STORE`）。
- **模板**：`{ id, name, groups: [{ name, fields: [{ key, value }] }] }`，规范化见 `popup.js` `normalizeTemplate`（空组丢弃、空 key 丢弃、缺 id 补 UUID）。
- **「我的信息」**：`{ values: { <fieldId>: string }, family: [...], custom: [...] }`，字段定义与规范化在 `profile-fields.js`（`PROFILE_SCHEMA`、`normalizeProfile`、`addPendingFields`）。`id` 是存储键，改了会丢数据。
- **AI 配置**：`{ apiUrl, model, apiKey }`，Key 明文。
- 侧边栏（`content.js`）的读写：
  - 读：`StorageService.getState()` 取全部四个键（`content.js:57-64`），并监听 `storage.onChanged` 实时刷新（`content.js:295`）。**`aiConfig` 含 Key 会进入 content script 上下文。**
  - 写：切换当前模板写 `activeTemplateId`（`content.js:75`）；「加到我的信息」写 `profile`（`content.js:1588-1597`，`addPendingFields`）；侧边栏位置与折叠状态（`sidebar-state.js`，纯界面状态）。
- AI：侧边栏发 `AI_FILL` / `AI_PLAN_REPEAT`，弹窗发 `PARSE_RESUME`，经 `ai-host.html`（offscreen 文档）转给 `ai-worker.js`（Web Worker）直接 `fetch` 服务商。offscreen 存在的原因是避开 service worker 的请求时长限制（`background.js:30`）。
- 弹窗三块：模板列表（含 Excel 导入导出、JSON 备份导入导出）、我的信息、AI 配置（含获取模型 `ai-models.js`）。另有简历解析：`pdf.js`（`vendor/pdfjs`）+ `mammoth.browser.min.js` 抽文本 → `PARSE_RESUME` → 存成新模板并可下载 Excel（`xlsx.full.min.js`）。

### 插件 ↔ 桌面通信

- 插件用 **一次性 `chrome.runtime.sendNativeMessage`**（`link/chrome.mjs:14`），每条消息浏览器拉起一次 `--nm-host` 进程；host 经 `local-ipc` 转发给正在运行的主程序，主程序不在就以 `--hidden` 拉起（`ipc_client.rs`，冷启动预算 10 秒）。
- 主程序 `ipc_server.rs` 每个连接一个线程，同步调用 `plugin_bridge::apply`（`plugin_bridge.rs:32`）按 `messageType` 分发。
- `link/transport.mjs` 把结果分为 `ok / not_installed / not_paired / retryable / fatal`，`not_installed` 靠 Chrome 的 “host not found” 文案识别。**第 4 节降级表直接复用这套分类。**
- 协议 v1（`desktop/crates/protocol/rules.json`）：信封 ≤ 64 KiB；`health`/`handshake` 禁带身份，其余 6 类必须带 `archiveId`+`restoreEpoch`；Secrets 层拒绝 Key/Bearer 类键值与带凭据的 URL；握手按 `min/maxProtocolVersion` 求交集（`link/session.mjs:37`）。Schema 是 JSON 源（`schemas/payloads`、`schemas/responses`），`link/protocol/` 是插件侧副本，测试锁死一致。
- content script 不能直连 native，所有桌面操作都经 service worker（`link/messages.mjs` 注释、ADR §6）。

### 桌面

- 档案库 `archive-store`：`SCHEMA_VERSION = 3`，迁移在 `schema.rs` 的 `MIGRATIONS` 里追加，单事务、迁移前自动备份（`migration.rs`）。现有表只有申请、事件、证据、快照、待办、AI 建议等，**没有模板和档案**。`archive.db` 整体进 D12 备份，新表自动被备份覆盖。
- AI：`ai_settings.rs`（`ai-settings.json`，单个 `apiUrl`+`model`，不含 Key）、`ai_credentials.rs`（`keyring`，固定 `SERVICE=com.resumepro.desktop`、`ACCOUNT=ai-api-key`，**只能存一把 Key**）、`ai_client.rs`（Chat Completions，不重试、硬超时、日志只记主机名）。
- 前端：四个主视图（申请、收件箱、待办、设置）是 `index.html` 里的静态 `<section>`；新界面一律用 React 写，经 `mountReact` 挂到容器（`desktop/src/react/mount.tsx`，示例 `desktop/src/ai/mount.tsx`）。依赖只有 `@tauri-apps/api`、`react`、`react-dom`。
- 测试命令：`npm run test:store`、`npm run test:app`、`npm run test:ui`、`npm run typecheck`（在 `desktop/`）；插件 `npm test`（仓库根）。`.github/workflows/desktop.yml` 是 CI 步骤的权威口径。

### 可复用

- PR #146 的桌面「获取模型」实现（`a09db3d` 为止的四个提交，只改桌面）：`ai_models.rs`、`list_ai_models_cmd`、`AiSettings.tsx` 候选下拉。评审遗留两点要在本线补：报错不回显服务商正文（`38d7e84` 的桌面半边）、未保存的新地址不能使用已存 Key。

---

## 架构决策（PR 内落地；反对请在对应 PR 评论提）

**1. 模板与档案存进 `archive.db`，用 JSON 列，不拆成字段表。**
`resume_templates(id, name, groups_json, position, created_at, updated_at)`；`resume_profile(singleton, profile_json, updated_at)`；「当前模板」存 `archive_meta` 一行。字段结构沿用插件现有形状，迁移与导入零转换，规范化规则从 `popup.js` / `profile-fields.js` 原样移植到 Rust 并用同一批用例锁死。

**2. 「当前模板」归桌面，插件可切换。**
侧边栏切换模板发写消息，不在插件本地另存，避免两处「当前」不一致。

**3. 协议升 v2，新增五类消息。**

| messageType | 方向 | 身份 | 说明 |
| --- | --- | --- | --- |
| `resume.read` | 插件→桌面 | 必须 | 返回模板摘要列表（id、name、字段数）、当前模板全文、档案。单个模板 > 48 KiB 时拒绝保存（桌面端校验），保证一次返回装得下 |
| `resume.update` | 插件→桌面 | 必须 | 只允许两种操作：切换当前模板；把侧边栏「加到我的信息」的字段追加进档案（复用 `addPendingFields` 规则） |
| `ai.complete` | 插件→桌面 | 禁止（同 health） | `{ system, user, purpose: fill \| plan }` → `{ text }`；桌面用当前服务商配置和 Key 发出，返回正文。不重试，超时按 `ai_client` |
| `ui.open` | 插件→桌面 | 禁止（同 health） | `{ view: resume \| settings-ai \| home }`：把桌面主窗口拉到前台并切到指定页面。主程序没在跑时由 host 正常（非 `--hidden`）拉起 |
| `legacy.import` | 插件→桌面 | 必须 | 旧版数据一次导入，按 `importId` 分片（模板逐个、档案、AI 配置各一条）。**唯一允许携带 `apiKey` 的消息**，Secrets 层按类型放行；桌面永远不回传 Key |

`maxProtocolVersion` 升到 2。新插件遇到只支持 v1 的桌面，握手无交集 → 提示「请更新桌面」；旧插件（v1）遇到新桌面仍能握手，原有 6 类消息行为不变。

**4. 提示词仍在插件拼，桌面只做薄转发。**
`ai-worker.js` 的提示词、结果解析、诊断全部保留，只把 `fetch(config.apiUrl)` 换成经 service worker 发 `ai.complete`。桌面不理解填表业务。简历解析的提示词随解析功能整体搬到桌面（见 PR 2）。

**5. 简历解析与 Excel 搬到桌面：文本抽取在前端，AI 与 Excel 在 Rust。**
- PDF / DOCX 抽文本：桌面前端用 `pdfjs-dist` 与 `mammoth` 的 npm 包，和插件现用库一致，结果不漂移。
- Excel 模板导入导出：Rust `calamine`（读）+ `rust_xlsxwriter`（写），表头沿用 `["一级分类", "字段名", "值"]`，可 `cargo test`。不引入 SheetJS。
- 解析提示词与结果规范化从 `ai-worker.js` / `resume-utils.js` 移植到 Rust `resume_parse.rs`，经桌面 `ai_client` 发出。

**6. 多服务商：配置列表 + 当前使用，Key 按服务商分别存。**
`ai-settings.json` 改为 `{ providers: [{ id, name, apiUrl, model }], activeProviderId }`（仍不含 Key）；凭据账户改为 `ai-api-key:<providerId>`。首次加载把旧的单配置迁成一条「默认」服务商，旧 Key 移到新账户。编辑时主机名变化即清空该服务商的 Key。内置预设：DeepSeek、通义、Kimi、智谱、豆包、OpenRouter、OpenAI、自定义。

**7. `ai.complete` 的长请求走 `connectNative` 端口，不走一次性消息。**
service worker 在一次性 `sendNativeMessage` 等待 30–60 秒期间可能被回收；Chrome 对打开着的 native 端口会保持 service worker 存活。PR 4 第一步做 spike 验证，结论写进该 PR 计划；spike 失败再评估改由 offscreen 文档持有端口（offscreen 只能用 `runtime` 消息，需经 service worker 中转）。

**8. 旧数据导入的确认在桌面。**
桌面收到 `legacy.import` 后先存为「待确认导入」，界面弹窗确认；插件轮询导入状态，桌面确认持久化后插件再清本地四个键。导入失败或用户拒绝，插件本地数据原样保留。桌面已有档案时不合并，导入的模板作为新模板追加，档案冲突时由用户在桌面选择保留哪份。

---

## PR 拆分

依赖关系：`PR1 → PR2`，`PR1 + PR3 → PR4`，`PR2 + PR4 → PR5`。PR1 与 PR3 可并行。

### PR 1：桌面接手模板与「我的信息」（数据 + 界面）

- `archive-store`：迁移 v4 建 `resume_templates`、`resume_profile`；CRUD、排序、当前模板；Rust 版 `normalize_template` / `normalize_profile`，用例从 `tests/profile-*.test.js`、`popup.js` 规范化行为逐条移植。
- `src-tauri`：模板与档案的 Tauri 命令；Excel 导入导出（`calamine` / `rust_xlsxwriter`），表头与插件一致。
- 前端：新增主视图「简历」（React）：模板列表、模板编辑、我的信息表单（按 `PROFILE_SCHEMA` 渲染，schema 复制进 `desktop/src/resume/profile-schema.ts` 并加一致性测试直接读 `profile-fields.js` 比对）、Excel 导入导出。
- **验收：** 在桌面能完成插件弹窗里模板与我的信息的全部操作；导出的 Excel 能被旧插件导入（兼容性回归）。

### PR 2：桌面多服务商 AI 配置 + 获取模型 + 简历解析

- `ai_settings.rs` 改为服务商列表；`ai_credentials.rs` 按服务商存取 Key；旧配置与旧 Key 自动迁移（单测覆盖：无旧配置、有旧配置无 Key、有旧配置有 Key）。
- 移植 #146 桌面部分（`a09db3d`）+ 报错不回显正文 + 「只有同一主机才用已存 Key」；`ai_client` 读当前服务商。
- 简历解析：前端抽文本（`pdfjs-dist`、`mammoth`），`resume_parse.rs` 发请求、规范化、存为新模板并设为当前。
- 设置页 AI 区改为服务商列表 UI，预设见决策 6。
- **验收：** 两个服务商之间切换后，收件箱 AI 整理与简历解析都走当前服务商；删除服务商会删掉其 Key。PR #146 关闭并注明由本 PR 取代。

### PR 3：协议 v2

- `rules.json`、JSON Schema（5 个 payload + 5 个 response）、Rust 校验、`link/protocol/` 副本与一致性测试；Secrets 层对 `legacy.import` 的 `apiKey` 放行、其余类型照旧拒绝；正反测试向量（含真实简历样本不被误判为密钥）。
- `plugin_bridge::apply` 接入五类消息：`resume.read`、`resume.update` 调 PR1 的存储；`ui.open` 发 Tauri 事件切换视图并聚焦窗口；`ai.complete` 调 PR2 的当前服务商（`ipc_server` 连接线程里用 Tauri 异步运行时 `block_on`，不持档案库锁发请求）；`legacy.import` 存待确认。
- **验收：** 用 `--nm-host` + fixture 帧跑通五类消息；v1 插件对新桌面行为不变（现有 D14 自动化用例全绿）。

### PR 4：插件改为经桌面取数据、发 AI

- spike：`connectNative` 端口承载 60 秒请求时 service worker 是否存活（决策 7）。
- `link/`：新增 `resume` 与 `ai` 两个模块；`messages.mjs` 增加侧边栏消息类型；`router.mjs` 分发。
- `content.js`：`StorageService` 改为经 service worker 读 `resume.read`；去掉对 `aiConfig` 的一切读取；切换模板、加到我的信息改发 `resume.update`；页面重新可见时刷新（替代 `storage.onChanged`）。
- `ai-worker.js`：`fetch` 换成 `ai.complete`，取消即断开端口；错误文案按 `transport.mjs` 分类。
- 侧边栏「打开管理面板」→「打开桌面」，「上传简历 / 导入模板」→ `ui.open { view: resume }`；管理页「打开桌面」同理。
- 降级（#130 第 4 节）：`not_installed` → 引导安装页；`retryable` / 握手超时 → 「桌面没有响应」+ 重试 + 打开桌面；档案为空 → 引导去桌面新建或导入。
- **验收：** 侧边栏条目点选、添加/替换、切换模板在桌面数据上行为与 0.4.0 一致（现有侧边栏测试改为注入桌面数据后全绿）；插件本地不再读写 `templates`、`profile`、`aiConfig`、`activeTemplateId`（加一条测试扫描源码锁死）；Chrome、Edge 各跑一遍填写、AI 填写、重复项规划、取消。

### PR 5：旧数据迁移、插件瘦身、文档

- `legacy.import`：插件升级后首次握手成功即检测本地旧数据并发起导入；桌面确认弹窗；插件轮询、确认后清本地。
- 删除弹窗里模板、我的信息、AI 配置、备份、简历解析界面与相关代码；删除 `xlsx.full.min.js`、`mammoth.browser.min.js`、`vendor/pdfjs`、`ai-models.js` 及对应测试；弹窗改为连接状态 + 「打开桌面」+ 更新提示。`desktop/scripts/plugin-release-assets.json` 同步。
- 文档：ADR §5/§6、data-privacy（插件列改为「经桌面发往所选服务商」、Key 只在凭据库）、`store-listing.md`（去掉「不装主程序也能用」，写明平台范围）、Chrome 商店数据使用声明、`install-and-update.md`、README。
- 版本：插件 `manifest.json` 与桌面三处版本升到 `0.4.1`（`node desktop/scripts/set-version.js 0.4.1`）。
- **验收：** 用一份真实的 0.4.0 插件数据（含模板、档案、Key）走完升级 → 导入 → 清理；拒绝导入与导入失败两条路径数据不丢。

### 发布

按 [release-sop.md](../../release-sop.md)：先出 `desktop-v0.4.1-beta.N` 做 D14 候选验收（#132 / #133 的清单在统一版上执行），双平台通过后推 `desktop-v0.4.1`，并创建插件正式 Release `v0.4.1` 送审商店。**插件商店版本上线要晚于桌面正式版可下载**，否则自动升级的用户找不到桌面安装包。

---

## 明确不做

- Responses、Anthropic 等非 Chat Completions 协议。
- 插件侧任何配置界面、配置同步、Key 回传。
- 插件本地缓存档案（桌面无响应即不能填）。
- 插件直连与桌面转发两条 AI 路径并存。
- Intel Mac、Linux 构建。
- Electron 或内置浏览器方案。
