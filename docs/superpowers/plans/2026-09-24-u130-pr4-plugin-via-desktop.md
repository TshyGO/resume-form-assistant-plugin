# #130 PR 4：插件改为经桌面取数据、发 AI 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 每个任务先写失败测试，再实现，一个任务一个提交，提交信息末尾加 `Co-Authored-By: <你的模型署名>`。

**Goal:** 插件侧边栏的简历条目、切换模板、「加到我的信息」改为向桌面读写；「一键 AI 填写」「AI 辅助新增条目」的请求改由桌面代发。插件本地不再读写 `templates`、`activeTemplateId`、`profile`、`aiConfig`，插件里不再有任何直连 AI 服务商的 `fetch`。桌面不可用时按 #130 定下的降级表提示，不能填写。

**Architecture:** 数据流全部走现有的「content script → service worker（`link/`）→ Native Messaging → 桌面」这条链：
- **简历数据**：`link/` 新增 `resume.mjs`，封装 `resume.read` / `resume.update`；侧边栏经 `chrome.runtime.sendMessage` 调它。
- **AI**：提示词、本地规则匹配、结果解析仍在 `ai-worker.js`（offscreen 文档里的 Worker）；只把 `fetch(服务商)` 换成「Worker → offscreen 宿主 → service worker → `connectNative` 长连接 → 桌面 `ai.complete`」。取消 = 断开这条长连接。
- **协议版本**：插件改为只支持 v2（`MIN = MAX = 2`），旧桌面握手无交集 → 提示「请更新桌面」。

**Tech Stack:** 原生 MV3 JS（无构建步骤）、`node --test`（仓库根 `tests/`）、协议校验器副本 `link/protocol/`。

**上级计划：** [2026-09-23-u130-pr-breakdown.md](2026-09-23-u130-pr-breakdown.md)（PR 4、决策 3、4、5、7）· [#130](https://github.com/TshyGO/resume-form-assistant-plugin/issues/130) · 协议契约见 [2026-09-24-u130-pr3-protocol-v2.md](2026-09-24-u130-pr3-protocol-v2.md) 与 `desktop/crates/protocol/README.md`

**依赖：** PR 3b（桌面接收 v2 五类消息、`SERVED_MAX_PROTOCOL_VERSION = 2`）合入 `main` 后开工；Task 1（长连接验证）可以先做。**PR 4 与 PR 5 要一起准备好、连着合入**：只合 PR 4 时插件已改为读桌面，但老用户的数据还在插件本地、要到 PR 5 才迁移。PR 4 合入到 PR 5 合入之间**不发版**。

---

## 已核实的现状（基线 `b1911ef`，PR 3a 已合入；PR 3b 合入后复核一次）

**侧边栏 `content.js`（约 2960 行）：**
- `STORAGE_KEYS = ["templates", "activeTemplateId", "aiConfig", "profile"]`；`StorageService.getState()` / `ensureDefaults()`（约 67–72 行）从 `chrome.storage.local` 读四个键，`normalizeStore`（约 1870 行）整理成 `{ templates, activeTemplateId, aiConfig, profile }` 存进 `state.currentStore`；`bindStorageSync()`（约 305 行）监听 `storage.onChanged` 刷新。
- 用到数据的地方：模板下拉（约 330–340 行，列 `templates` 名称，`activeTemplateId` 选中）；`getActiveTemplate(state.currentStore)`（条目渲染、AI 填写、辅助新增）；`profileResumeFields()`（约 1850 行，`profileToResumeFields(profile)`）；「加到我的信息」`addUnansweredToProfile`（约 1920–1945 行，读 `profile` → `addPendingFields` → 写回 → `openManager("profile")`）；切换模板 `StorageService.setActiveTemplate`（约 85、277 行）。
- AI：`handleAiFillClick`（约 795 行起）与 `handleRepeatFillClick`（约 710 行起）检查 `aiConfig.apiUrl/model/apiKey` 后，经 `ResumeProAIClient.send({ type: "AI_FILL" | "AI_PLAN_REPEAT", …, aiConfig })` 发请求；90 秒后提示「上游较慢」、可手动取消（`CANCEL_AI_FILL`）。
- 「打开管理面板」按钮（约 229、283 行）与无模板时的「上传简历 / 导入模板」（约 349、380 行）都调 `openManager()`（约 1998 行，`OPEN_MANAGER` 打开插件管理页）。
- 侧边栏已有桌面连接状态与岗位保存、填写留档的界面（`bindDesktopEvents`，约 2305 行起），经 `DESKTOP_*` 消息走 `link/router.mjs`。
- 测试钩子：文件末尾 `self.__RESUME_PRO_TEST__` 分支导出 `setCurrentStore` 等；`tests/sidebar-content.test.js`、`tests/fill-highlight.test.js`、`tests/ai-performance.test.js` 等用它注入数据。

**AI 链路：**
- `ai-client.js`：`ResumeProAIClient.send(message)` 先 `ENSURE_AI_HOST`（service worker 创建 offscreen 文档 `ai-host.html`）再 `chrome.runtime.sendMessage(message)`；`cancel(requestId)` 发 `CANCEL_AI_FILL`。
- `ai-host.js`：offscreen 文档里起一个 `Worker("ai-worker.js")`，把 `AI_FILL` / `AI_PLAN_REPEAT` / `CANCEL_AI_FILL` / `PARSE_RESUME` 转给 Worker。offscreen 文档只能用 `chrome.runtime` 消息，**不能用 `nativeMessaging`**。
- `ai-worker.js`：`handleAiFill`（本地规则 `buildRuleBasedMatches` → 剩余字段 `selectResumeCandidates` → **一次性** `buildUserPrompt(remainingFormFields, candidates)` → `fetch(aiConfig.apiUrl)` → `normalizeMatches` → `filterValidMatches`，带 `diagnostics`）；`handleRepeatPlan`（`fetch` 后 `ResumeProFormAgent.validatePlan`）；`handleParseResume`（弹窗用，PR 5 删界面）。
- `background.js`：`installDesktopLink(chrome)`（`link/worker.mjs`）+ `OPEN_MANAGER`、`ENSURE_AI_HOST`。

**插件 ↔ 桌面：**
- `link/chrome.mjs` 的 `nativeSender` 用一次性 `chrome.runtime.sendNativeMessage`；`link/transport.mjs` `sendOnce` 把结果分为 `ok / not_installed / not_paired / retryable / fatal`，冷启动失败自动重试一次。
- `link/session.mjs` `probe()` 握手，模式 `ready / incompatible / not_installed / not_paired / unavailable / never_paired`；`PLUGIN_VERSION = '0.4.0'` 写死。
- `link/envelope.mjs`：`PROTOCOL_VERSION = MIN = MAX = 1`；`buildEnvelope` 负责身份、摘要、64 KiB 检查。
- `link/router.mjs` + `link/messages.mjs`（`MSG`、`DESKTOP_MESSAGE_TYPES`）是侧边栏与 service worker 之间的消息表。
- `manifest.json`：`minimum_chrome_version: "116"`——**Chrome 116 起，打开着的 `connectNative` 端口会让 service worker 保持存活**（Chrome 扩展文档的 service worker 生命周期说明）。

**协议 v2（PR 3a 已定，PR 3b 实现）：** `resume.read`（空 payload → `{ templates:[{id,name,fieldCount}], activeTemplate|null, profile, profileRevision }`，信封必带身份）；`resume.update`（`{op:"setActiveTemplate", templateId}` 或 `{op:"saveProfile", profile, expectedRevision}` → `{ activeTemplateId, profileRevision }`，版本不符 `conflict`）；`ai.complete`（`{ purpose:"fill"|"plan", system ≤8000, user ≤60000 }`，**不带身份** → `{status:"ok", text}` 或 `{status:"failed", reason, httpStatus?, host?}`，reason ∈ `not_configured|credential_unavailable|auth|rate_limited|timeout|network|http|bad_response|input_too_large|response_too_large`）；`ui.open`（`{view:"resume"|"settings-ai"|"home"}`，不带身份）。v2 消息信封 `protocolVersion` 必须为 2。`ai.complete` 的 `user` 里若出现「password: xxx」这类「键名 + 冒号 + 值」会被 Secrets 层拒绝（`secret_forbidden`）。

---

## 已定的设计

1. **长请求走 `connectNative`。** `ai.complete` 用一条专用的 `chrome.runtime.connectNative(HOST_NAME)` 端口：发一帧、收一帧、断开。依据：Chrome 116+ 对打开的 native 端口保持 service worker 存活，插件最低版本正是 116。其余消息继续用一次性 `sendNativeMessage`，不动现有队列与重试逻辑。Task 1 只是在真机上确认，不是二选一。
2. **取消 = 断开端口。** 桌面那端会把请求跑完（结果写不回来），与既有口径「取消不保证对方停止计费」一致。
3. **提示词仍在 Worker 里拼**，Worker 只把「发给服务商」换成「经宿主转给 service worker」。Worker 不直接接触 `chrome.*`。
4. **按信封大小分批。** 单次 `ai.complete` 的 `user` 按 UTF-8 算不超过 `AI_USER_BUDGET = 48 * 1024` 字节（给信封、系统提示词、JSON 转义留余量）。剩余字段超预算时按字段顺序切成若干批，每批单独 `selectResumeCandidates` 并发一次请求，**串行**发送、结果合并；任一批失败按现有「部分成功」语义返回 `warning`。单个字段加它的候选就超预算（极端情况）时跳过该字段并计入 `diagnostics.skippedOversized`。
5. **组提示词时去掉密码类表单字段。** `inputType === "password"` 或标签命中插件 `profile-fields.js` 的 `SECRET_LABEL` 的表单字段不进提示词（本来也不该填），避免被协议的 Secrets 层整批拒掉。
6. **插件只认 v2。** `link/envelope.mjs` 改为 `PROTOCOL_VERSION = MIN = MAX = 2`；所有消息（含原有 6 类）都用 v2 信封。旧桌面（只到 v1）握手无交集 → 模式 `incompatible` → 侧边栏提示「请更新桌面」。`PLUGIN_VERSION` 改为读 `chrome.runtime.getManifest().version`。
7. **不在插件里缓存简历数据**（#130 负责人已定第 5 条）。侧边栏每次需要时实时 `resume.read`：侧边栏初始化、页面重新可见（`visibilitychange`）、展开侧边栏、切换模板或写回之后。
8. **侧边栏「打开」类按钮改为 `ui.open`。** 「打开管理面板」→「打开桌面」（`home`）；「上传简历 / 导入模板」→ `resume`；「加到我的信息」成功后 → `resume`；AI 未配置 → `settings-ai`。桌面没装或没响应时按钮给出与降级表一致的提示。
9. **降级表**（沿用 `session.probe()` 的模式）：

| 模式 | 侧边栏文案 | 操作 |
| --- | --- | --- |
| `not_installed` / `never_paired` | 「需要先安装 Resume Pro 桌面程序，简历和 AI 设置都在桌面里。」 | 「去下载」按钮打开 `DESKTOP_DOWNLOAD_URL`（桌面 Release 页）；已装但没配对时附一句「装好后在桌面『设置 → 浏览器』里配对」 |
| `not_paired` | 「这个浏览器还没和桌面配对。」 | 「怎么配对」说明（沿用现有配对文案） |
| `incompatible` | 「桌面版本太旧，请更新桌面程序。」 | 「去下载」 |
| `unavailable` | 「桌面没有响应。」 | 「重试」「打开桌面」 |
| `ready` 但没有模板且档案为空 | 「桌面里还没有简历。」 | 「打开桌面的简历页」 |

   降级时简历条目区、一键 AI 填写、辅助新增都不可用（按钮置灰并说明原因）；「保存岗位」「确认已投递」「留档」维持现有离线队列语义不变。

---

## 文件结构

| 文件 | 改动 |
| --- | --- |
| `link/envelope.mjs`、`link/session.mjs` | 只认 v2；插件版本读 manifest |
| `link/chrome.mjs` | 新增 `nativePort(api)`：`connectNative` 一问一答、可断开 |
| `link/resume.mjs`（新） | `read()`、`setActiveTemplate(id)`、`saveProfile(profile, revision)` |
| `link/ai.mjs`（新） | `complete({ purpose, system, user, signal })`，走 `nativePort`，映射失败原因 |
| `link/messages.mjs`、`link/router.mjs`、`link/worker.mjs` | 新消息：`DESKTOP_RESUME_READ`、`DESKTOP_RESUME_UPDATE`、`DESKTOP_AI_COMPLETE`、`DESKTOP_AI_CANCEL`、`DESKTOP_OPEN_VIEW` |
| `ai-host.js` | 转发 Worker 发来的 `desktop-complete` / `desktop-cancel` 给 service worker |
| `ai-worker.js` | 去掉全部 `fetch`；新增 `sendToDesktop()`；分批；过滤密码类字段；失败原因 → 中文提示；`PARSE_RESUME` 改为返回「简历解析已搬到桌面」 |
| `ai-client.js` | 不再携带 `aiConfig` |
| `content.js` | `StorageService` 改为经 `DESKTOP_RESUME_*`；去掉 `aiConfig` 与 `storage.onChanged` 里的数据键；降级表 UI；「打开」按钮改 `ui.open`；「加到我的信息」带版本号写回并在冲突时重读重算一次 |
| `background.js` | 保留 `OPEN_MANAGER`（插件管理页在 PR 5 精简）与 `ENSURE_AI_HOST` |
| `tests/*` | 见各任务 |

---

### Task 1：`connectNative` 长连接验证（可先于 PR 3b 做）

- [ ] 在 `docs/superpowers/spikes/2026-09-xx-connectnative-keepalive.md` 记录：用开发注册脚本（`desktop/scripts/nm-dev-register.mjs` 的做法）注册一个**测试用 host 名**（不要覆盖 `com.resumepro.desktop`），host 是一个 Node 脚本：读一帧后 `sleep 120s` 再回一帧。
- [ ] 写一个一次性的测试扩展（放在 spike 文档里，不进仓库运行时文件），service worker 里分别用 `sendNativeMessage` 与 `connectNative` 发一帧，记录是否在 30 秒 / 5 分钟前被回收、回包是否收到。在 **Chrome 与 Edge** 各跑一次，记录浏览器版本。
- [ ] 结论写进 spike 文档；预期 `connectNative` 可行（Chrome 116+ 行为）。若不可行，停下来在 #130 下说明，改为「offscreen 文档持有端口 + service worker 中转」再议，不要自行换方案继续做。

### Task 2：协议版本与插件版本

- [ ] 测试（`tests/link-envelope.test.js`、`tests/link-session.test.js`）：信封 `protocolVersion === 2`；握手 payload `min = max = 2`；桌面宣告 `1..1` → 模式 `incompatible`；`1..2` → `ready`；`PLUGIN_VERSION` 等于 manifest 版本（测试里注入 `getManifest`）。
- [ ] 实现：`link/envelope.mjs` 三个常量改为 2；`link/session.mjs` 的插件版本改为构造参数，`link/worker.mjs` 传 `api.runtime.getManifest().version`。跑仓库根 `npm test`，现有 link 测试里写死 `protocolVersion: 1` 的期望一并改为 2（这是有意的行为变化，逐个确认不是在掩盖问题）。
- [ ] 提交 `feat(link): 插件只认协议 v2，版本号读 manifest (#130)`。

### Task 3：`link/resume.mjs` 与消息路由

- [ ] 测试（新 `tests/link-resume.test.js`，照 `link-outbox.test.js` 的假 `sendNative` 写法）：
  - `read()` 在 `ready` 时发 `resume.read`（v2、带身份），返回 `{ status: "ok", data }`；非 `ready` 时不发请求，返回 `{ status: <模式> }`。
  - `setActiveTemplate(id)` 发 `{op:"setActiveTemplate"}`；`invalid_payload` → `{ status: "missing_template" }`。
  - `saveProfile(profile, revision)`：`conflict` → `{ status: "conflict" }`；`secret_forbidden` → `{ status: "secret" }`。
  - 响应不通过 `validateResponseForRequest` → `{ status: "unavailable" }`（不向侧边栏抛异常）。
- [ ] 实现 `link/resume.mjs`；`messages.mjs` 加 `resumeRead: "DESKTOP_RESUME_READ"`、`resumeUpdate: "DESKTOP_RESUME_UPDATE"`、`openView: "DESKTOP_OPEN_VIEW"`；`router.mjs` 分发（`openView` 发 `ui.open`，不需要握手身份，但仍先 `probe()` 以便按模式返回）；`worker.mjs` 组装。
- [ ] 提交 `feat(link): 经桌面读写简历数据与打开桌面页面 (#130)`。

### Task 4：`link/ai.mjs`（长连接）

- [ ] 测试（新 `tests/link-ai.test.js`，假 `connectNative`：记录 `postMessage`、可手动触发 `onMessage` / `onDisconnect`）：
  - 发 v2 `ai.complete`（无身份），收 `{status:"ok", text}` → `{ ok: true, text }`，随后端口被 `disconnect()`。
  - `status:"failed"` 各原因 → `{ ok: false, reason, httpStatus?, host? }`。
  - `signal` 触发 → 端口被断开、返回 `{ ok: false, reason: "cancelled" }`。
  - 端口先断开（`chrome.runtime.lastError` 含 host not found）→ `not_installed`；其他断开 → `unavailable`。
  - 协议错误帧 `secret_forbidden` → `{ ok: false, reason: "secret_in_prompt" }`；`payload_too_large` → `input_too_large`；`protocol_incompatible` → `incompatible`。
- [ ] 实现：`link/chrome.mjs` 新增

```js
/** 一问一答的长连接：Chrome 116+ 在端口打开期间保持 service worker 存活（长 AI 请求用）。 */
export function nativePort(api) {
  return (hostName, message, { signal } = {}) => new Promise(resolve => {
    const port = api.runtime.connectNative(hostName);
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch {}
      resolve(result);
    };
    port.onMessage.addListener(response => finish({ response }));
    port.onDisconnect.addListener(() => {
      const lastError = api.runtime.lastError;
      finish({ lastError: lastError?.message ?? 'disconnected' });
    });
    signal?.addEventListener('abort', () => finish({ cancelled: true }), { once: true });
    port.postMessage(message);
  });
}
```

  `link/ai.mjs` 用 `buildEnvelope`（v2、无身份）+ `nativePort` + `validateResponseForRequest`，按上面的表映射；**不做自动重试**（重复计费）。`messages.mjs` 加 `aiComplete: "DESKTOP_AI_COMPLETE"`、`aiCancel: "DESKTOP_AI_CANCEL"`；`router.mjs` 按 `requestId` 持有 `AbortController`，`aiCancel` 触发它。
- [ ] 提交 `feat(link): AI 请求经桌面代发，长连接可取消 (#130)`。

### Task 5：Worker 改为经桌面发 AI

- [ ] 测试（`tests/ai-performance.test.js` 等现有 Worker 测试的做法：在 vm 里加载 `ai-worker.js`，注入假的 `sendToDesktop`）：
  - `handleAiFill` 不再要求 `aiConfig`；调 `sendToDesktop({ purpose:"fill", system: AI_SYSTEM_PROMPT, user })`，返回正文后照旧解析、合并本地规则结果。
  - 分批：构造剩余字段使 `user` 超过 `AI_USER_BUDGET`，断言拆成多次、每次 `user` 的 UTF-8 字节 ≤ 预算、结果合并；某一批失败时其余批的结果保留并带 `warning`。
  - 密码类表单字段（`inputType:"password"`，或标签「登录密码」「验证码」）不出现在任何一次 `user` 里。
  - 失败原因到中文提示的映射（逐条断言）：`not_configured` →「桌面还没有配置 AI 服务商，或当前服务商没有 Key。」并返回 `openView: "settings-ai"`；`credential_unavailable` →「桌面读不出系统凭据库里的 Key，请在桌面设置里重新保存。」；`auth` →「AI 服务商拒绝了 Key（HTTP 401/403），请在桌面设置里检查。」；`rate_limited` →「AI 服务商限流了，请稍后再试。」；`timeout` →「AI 服务商长时间没有返回。」；`network` →「桌面连不上 AI 服务商，请检查网络或代理。」；`http` →「AI 服务商返回 HTTP {httpStatus}。」；`bad_response` →「AI 返回的内容无法使用。」；`input_too_large` →「这次要发给 AI 的内容太多了。」；`response_too_large` →「AI 返回的内容过长，没有采用。」；`secret_in_prompt` →「表单里有像密码的内容，没有发给 AI。」；`cancelled` → 现有取消文案；`not_installed` / `unavailable` / `incompatible` → 降级表文案。
  - `handleRepeatPlan` 同样走 `sendToDesktop({ purpose:"plan", … })`。
  - `PARSE_RESUME` 返回 `{ success:false, error:"简历解析已搬到桌面程序的「简历」页。", openView:"resume" }`。
  - 一条静态测试：`ai-worker.js` 源码里不再出现 `fetch(`。
- [ ] 实现：`ai-worker.js` 删 `normalizeAiConfig` 与 `fetch`，新增 `sendToDesktop`（向宿主 `postMessage({ kind:"desktop-complete", callId, purpose, system, user })`，等宿主回 `{ kind:"desktop-result", callId, … }`；`AbortController` 取消时发 `{ kind:"desktop-cancel", callId }`）。`ai-host.js` 把 `desktop-complete` 转为 `chrome.runtime.sendMessage({ type:"DESKTOP_AI_COMPLETE", requestId: callId, purpose, system, user })`、`desktop-cancel` 转为 `DESKTOP_AI_CANCEL`，把结果回投 Worker。`ai-client.js` 与 `content.js` 不再传 `aiConfig`。
- [ ] 提交 `feat(ai): 填表与辅助新增的 AI 请求改由桌面代发，按信封大小分批 (#130)`。

### Task 6：侧边栏改读桌面

- [ ] 测试（`tests/sidebar-content.test.js` 及新 `tests/sidebar-desktop-data.test.js`，给 content 的 vm 注入假的 `chrome.runtime.sendMessage`）：
  - 初始化发 `DESKTOP_RESUME_READ`，把 `{ templates, activeTemplate, profile, profileRevision }` 转成侧边栏内部的 `state.currentStore`（形状：`{ templates:[{id,name,fieldCount}], activeTemplateId, activeTemplate, profile, profileRevision }`），条目区按 `activeTemplate.groups` 渲染、下拉按 `templates` 列名称。
  - `visibilitychange` 变为可见时重读；`storage.onChanged` 里不再处理 `templates / activeTemplateId / aiConfig / profile`（侧边栏位置状态照旧）。
  - 切换模板发 `DESKTOP_RESUME_UPDATE {op:"setActiveTemplate"}` 后重读；`missing_template` 时提示「这个模板在桌面里已经删掉了」并重读。
  - 「加到我的信息」：用当前 `profile` 与 `profileRevision` 调 `addPendingFields` 后发 `saveProfile`；`conflict` 时重读、用最新档案**重算一次**再发，仍冲突则提示「我的信息刚在别处改过，请再点一次」；成功后发 `DESKTOP_OPEN_VIEW {view:"resume"}`。
  - 降级表五种情况各一条：文案、按钮、条目区与 AI 按钮置灰。
  - 「打开桌面」「上传简历 / 导入模板」发 `DESKTOP_OPEN_VIEW`；桌面没装时显示「去下载」而不是打开插件管理页。
  - 源码静态断言：`content.js` 不再读写 `chrome.storage.local` 的 `templates`、`activeTemplateId`、`aiConfig`、`profile`（只剩侧边栏界面状态键）。
- [ ] 实现：`StorageService` 改名为 `ResumeData`（或保留名字但内部改为 `sendMessage`），`normalizeStore` 改为整理 `resume.read` 的结果；`getActiveTemplate` 读 `state.currentStore.activeTemplate`；删 `aiConfig` 相关检查（AI 是否配置由桌面在请求时说明）；降级 UI 复用现有桌面连接状态区的样式；`DESKTOP_DOWNLOAD_URL = "https://github.com/TshyGO/resume-form-assistant-plugin/releases?q=desktop-v&expanded=true"`。测试钩子 `setCurrentStore` 保留（改为新形状），现有依赖它的测试更新注入数据。
- [ ] 提交 `feat(sidebar): 简历条目、切换模板与我的信息改为向桌面读写，桌面不可用时按降级表提示 (#130)`。

### Task 7：收尾

- [ ] 全仓搜索残留：`rg -n "aiConfig|apiKey|storage\.local\.(get|set)\(.*(templates|profile|activeTemplateId)" content.js ai-*.js link/ background.js` 只允许出现在 `popup.js`（管理页，PR 5 删）与测试里。
- [ ] `desktop/scripts/plugin-release-assets.json` 若运行时文件有增减（`link/resume.mjs`、`link/ai.mjs`）同步；`cd desktop && node scripts/check-plugin-release-allowlist.js` 通过；`tests/link-manifest.test.js` / `tests/manifest-war.test.js` 通过。
- [ ] 仓库根 `npm test`、`cd desktop && npm test` 全绿。
- [ ] 真机走查（需要人，**用 PR 3b 之后的桌面开发版 + 本 PR 的插件**，Chrome 与 Edge 各一次）：
  1. 桌面里有模板和我的信息 → 侧边栏条目正确、切换模板生效、点条目填写。
  2. 一键 AI 填写与辅助新增：成功；AI 未配置时提示并能打开桌面 AI 设置；等待 90 秒以上不被中断；取消有效。
  3. 大表单（字段很多）能分批完成。
  4. 「加到我的信息」写回桌面并打开简历页；桌面同时改了我的信息时不丢数据。
  5. 关掉桌面程序 → 浏览器能按需拉起；卸载或未配对 / 旧版桌面时，降级文案正确。
- [ ] 推送、开 PR（`feat(plugin): 插件经桌面读取简历与代发 AI (#130 PR 4)`，`Refs #130`），**标明与 PR 5 连着合、中间不发版**。

---

## 自检

- 覆盖拆分计划 PR 4：spike（Task 1）、`link/` 新模块与路由（Task 3、4）、`content.js` 读写与降级（Task 6）、`ai-worker.js` 改走桌面（Task 5）、验收（Task 7）。
- 与拆分计划的差异：决策 7 的 spike 从「二选一」改为「确认」，依据是插件最低 Chrome 116 与该版本起的端口保活行为；新增「按信封分批」与「过滤密码类字段」两条，来自 PR 3a 审查时发现的 64 KiB 信封与 Secrets 规则约束。
- 不在本 PR：插件管理页（模板、我的信息、AI 配置、备份、简历解析界面）的删除，旧数据导入，文档与版本号——都在 PR 5。
