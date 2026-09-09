# D07 保存岗位与离线补传 PR 拆分计划

> **For agentic workers:** 本文是 **PR 级拆分**，不是可直接执行的任务清单。每个 PR 开工时先用 superpowers:writing-plans 为该 PR 写 bite-sized 实现计划（存到 `docs/superpowers/plans/YYYY-MM-DD-d07-prN-<name>.md`），再用 superpowers:subagent-driven-development 或 superpowers:executing-plans 执行。

**Goal:** 让用户在招聘页点一次「保存岗位到本地」，字段确认后无论桌面是否在线都不丢，桌面可用时恰好产生一条申请。

**Architecture:** 插件侧新增 `link/` 目录，全部逻辑是可被 `node --test` 直接 import 的 ES module，`chrome.*` 只经由注入的 `deps` 对象接触。Service worker 改为 `type: module`，独占 Native Messaging 与两条队列；content.js 只做侧边栏 UI，通过 `chrome.runtime.sendMessage` 与 SW 通信（content script 拿不到 `chrome.runtime.connectNative` / `sendNativeMessage`）。D05 的 JS 校验器以 vendored 副本进插件，用测试锁住与源文件一致。

**Tech Stack:** MV3（`minimum_chrome_version` 116）、原生 ES module、Web Crypto（`crypto.subtle`）、`chrome.storage.local`、`chrome.alarms`、`node --test`。无打包器、无新增第三方依赖。

**Spec 来源：** [#20](https://github.com/TshyGO/resume-form-assistant-plugin/issues/20)（范围与验收）· [product-requirements.md §5.2 / §7 / §8.10 / §8.11 / §9](../../desktop-mvp/product-requirements.md) · [data-privacy.md §7.1](../../desktop-mvp/data-privacy.md) · [protocol/README.md](../../../desktop/crates/protocol/README.md) · [protocol/INTEGRATION.md](../../../desktop/crates/protocol/INTEGRATION.md)

**基线：** `47f21d7`（D06 四个 PR 已合入 `main`）

---

## 已核实的外部事实（基线 47f21d7，实现时直接用，不必再查）

**协议 JS 入口** `desktop/crates/protocol/js/`，四个文件自足、无 `node:` / `Buffer` 依赖，import 图是 `validate.mjs → time.mjs`、`schema-lite.mjs → {time.mjs, schema-data.mjs}`：

- `MAX_ENVELOPE_BYTES = 65536`、`MAX_RECONCILE_ITEMS = 32`、`MAX_CHUNK_COUNT = 128`、`MAX_SNAPSHOT_BYTES = 2097152`
- `async validateRequest(value)` · `async validateRequestBytes(bytes)` · `validateResponseForRequest(value, request)` · `checkCurrentIdentity(req, current)` · `async payloadBodySha256(payload)` · `checkUrl(raw)` · `originAllowed(origin, allowed)` · `utf8JsonLen(value)`
- 摘要用 `crypto.subtle.digest`，所以 `validateRequest` / `payloadBodySha256` 是 **async**。Node 18+ 有全局 `crypto.subtle`，`node --test` 可直接跑。

**信封形状**（`desktop/crates/protocol/fixtures/requests/*.json` 是权威样例）：

```json
{ "protocolVersion": 1, "messageId": "<uuidv4>", "clientInstanceId": "<uuidv4>",
  "messageType": "job.save", "occurredAt": "2026-09-06T12:00:00.000Z",
  "payload": { }, "archiveId": "<uuidv4>", "restoreEpoch": "<uuidv4>" }
```

- `health` / `handshake`：**禁止**信封 `archiveId` / `restoreEpoch`。
- `application.queryCandidates` / `job.save` / `fill.submit` / `snapshot.chunk` / `submit.confirm` / `outbox.reconcile`：**必须**带，且必须是 **最新握手的 current**。
- 写类型（`job.save` / `fill.submit` / `snapshot.chunk` / `submit.confirm`）的 payload 里另有 `sourceRestoreEpoch` 与 `payloadSha256`；`queryCandidates` 与 `outbox.reconcile` 的 payload **不接受**这两个字段（`additionalProperties: false`，多写即 `invalid_payload`）。
- `job.save` payload：必填 `sourceRestoreEpoch` / `payloadSha256` / `company` / `title`，可选 `sourceUrl` / `location` / `applicationId`。
- `application.queryCandidates` payload：必填 `company`，可选 `title` / `sourceUrl`；应答 `{ exact: [], sameCompany: [] }`，每项 `{applicationId, company, title, stage?, sourceUrl?, updatedAt?}`，各 ≤ 32 条。
- `submit.confirm` payload：必填 `sourceRestoreEpoch` / `payloadSha256` / `applicationId`，**没有**别的字段（`via` / `note` 是 D03 内部字段，不进信封）。
- `outbox.reconcile` payload：`items[]`，每项 `{clientInstanceId, messageId, sourceRestoreEpoch, payloadSha256}`，批次 ≤ 32；应答逐项回显身份并给 `applied` / `purged` / `not_found` / `conflict` / `unverifiable`，只有 `applied` 带已核实的 `resultId`。
- `occurredAt`：UTC `Z` 子集，`new Date().toISOString()` 合法（允许小数秒），必须是真实日历日期。
- 应答校验一律 `validateResponseForRequest(response, req)`；`validateResponse` 看不到请求，多条同类型在途时会把 A 的回复记到 B 头上。

**错误码：** `identity_missing` · `identity_not_allowed` · `restore_epoch_mismatch` · `protocol_incompatible` · `unknown_message_type` · `invalid_payload` · `payload_too_large` · `conflict` · `previously_purged` · `unavailable`（**唯一默认 retryable**） · `secret_forbidden`。`ok:true` 的写入必有 `resultId`；`ok:false` 一定没有。

**Host：** 名称 `com.resumepro.desktop`，开发期注册见 [desktop/DEV-NATIVE-MESSAGING.md](../../../desktop/DEV-NATIVE-MESSAGING.md)。`nm.rs::serve` 是「读帧直到管道关闭」的循环，长连接与一次性调用都支持。握手成功返回 `{appVersion, minProtocolVersion, maxProtocolVersion, archiveId, restoreEpoch, capabilities[]}`。

**D06 留给 D07 的三条实测行为：**

1. **冷启动可能超过 host 的 10 秒预算**，此时返回可重试的 `unavailable`。必须重试，不得报错给用户。
2. **`snapshot.chunk` 目前一律 `unavailable`**（字节存储属于 D08）。D07 不发快照；若队列里出现快照项按可重试处理。
3. 未配对的扩展被 `identity_not_allowed` 拒绝；配对写在桌面 `settings.json`，插件只负责把自己的 `chrome.runtime.id` 显示出来让用户去粘贴。

**插件现状：** `background.js` 是 classic service worker，只有 `chrome.action.onClicked → TOGGLE_MANAGER` 和 `ENSURE_AI_HOST`（offscreen）。permissions 为 `offscreen` / `storage` / `scripting` / `activeTab` / `tabs`，**没有** `nativeMessaging`、**没有** `alarms`。`chrome.storage.local` 已占用 `templates` / `activeTemplateId` / `aiConfig`（content.js:3）与 `resumeProUpdateCache` / `resumeProDismissedVersion`（popup.js）——D07 一个都不许碰。侧边栏在 shadow root 里由 `renderSidebar()`（content.js:241）渲染。插件没有任何岗位页信息抽取代码，这部分是新写的。

---

## 三个架构决策（已定，PR1 落地；反对请在 PR1 评论提）

**1. 传输用 `chrome.runtime.sendNativeMessage`，不是 `connectNative`。**
downstream-decisions.md 的风险 V4 已经预留了这个回落。一次性调用的语义与 D06 的 `serve` 循环、与 `nm_browser_check.py` 实测路径一致，也不需要处理 MV3 SW 在长连接上的存活争议。代价是每条消息拉起一次 host 进程（应用进程本身常驻，不重复拉起）。`link/transport.mjs` 只导出 `sendOnce(envelope)`，换成长连接时改这一个文件。

**2. D05 校验器 vendored 进插件，用测试锁一致性。**
`desktop/crates/protocol/js/` 在扩展根之外，MV3 加载不到。四个文件复制到 `link/protocol/`，`tests/protocol-vendor.test.js` 断言与源文件逐字节相同——源文件一改，插件测试立刻红。不引打包器，不写第二份校验逻辑。

**3. 所有 `link/*.mjs` 通过注入的 `deps` 接触宿主，不直接引用 `chrome`。**
`deps = { storage, sendNative, now, uuid, alarms }`。SW 在 `background.js` 里组装真实实现，node 测试传假实现。没有这条，`node --test` 覆盖不到队列与重试，D07 的验收只能靠手点。

**队列上限取 D01 的建议值：意图 100 条、绑定消息 100 条**，写成 `link/limits.mjs` 的常量。满了拒绝新增并提示，不丢旧项，不阻止填表。

**`urlAllowlist` 本轮发空。** data-privacy.md §7.1 要求任何岗位号保留规则必须有该站点的正反例（含同 host 的认证路径反例）才能进。D07 不假造站点名单；规则结构留好，条目为空。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `link/protocol/{validate,schema-lite,schema-data,time}.mjs` | D05 校验器的 vendored 副本，只读，不手改 |
| `link/limits.mjs` | 队列上限、退避参数、去重窗口等常量，单一出处 |
| `link/envelope.mjs` | 按 messageType 组装信封：身份该带不该带、写类型盖 `sourceRestoreEpoch` 与 `payloadSha256` |
| `link/transport.mjs` | `sendOnce(envelope)`；把 `lastError` 与错误应答分类成 `not_installed` / `not_paired` / `retryable` / `fatal` |
| `link/session.mjs` | 握手、版本协商、`desktopPairing` 缓存、模式判定（未安装 / 未配对 / 曾配对不可用 / 可用 / 协议不兼容） |
| `link/store.mjs` | `chrome.storage.local` 的四个新 key 读写与并发安全的读改写 |
| `link/redact.mjs` | URL 脱敏：`sourceUrl` 与 `dedupeUrl` |
| `link/normalize.mjs` | 公司 / 岗位 / URL 规范化，产出去重三元组 |
| `link/intents.mjs` | SaveIntent 生命周期：新增、去重、状态流转、删除、容量 |
| `link/outbox.mjs` | Bound outbox：铸 `messageId`、盖 epoch、发送、ACK 落库、回填 `applicationId` |
| `link/drain.mjs` | alarms 驱动的排空与有上限退避 |
| `link/reconcile.mjs` | epoch 不匹配的暂停、`outbox.reconcile` 批次、五种状态的处置 |
| `link/messages.mjs` | SW ↔ content 的消息名与形状常量 |
| `background.js` | 组装 `deps`、注册消息路由与 alarm 监听；保留现有 `onClicked` 与 `ENSURE_AI_HOST` |
| `content.js` | 侧边栏：保存入口、字段确认、候选选择、待同步面板、确认已投递 |
| `content.css` | 上述面板样式 |
| `manifest.json` | 加 `nativeMessaging` / `alarms` 权限，SW 改 `type: module` |
| `tests/*.test.js` | 每个 PR 自带的 node 测试 |

**`background.js` 的 `chrome.action.onClicked` 不得被覆盖**（README.md:51 明确点名）。改成 module 后现有 `ENSURE_AI_HOST` 行为必须逐字保持。

---

## PR 1 · 协议客户端与 Native Messaging 传输

**只做：** 让插件能对桌面发出一条合法信封并正确解读回复。没有任何 UI。

**文件：** `link/protocol/*`（vendored）、`link/limits.mjs`、`link/envelope.mjs`、`link/transport.mjs`、`link/session.mjs`、`link/store.mjs`、`manifest.json`、`background.js`、`tests/protocol-vendor.test.js`、`tests/link-envelope.test.js`、`tests/link-transport.test.js`、`tests/link-session.test.js`

**关键契约：**

- `manifest.json`：`permissions` 加 `nativeMessaging` 与 `alarms`；`background` 改成 `{"service_worker": "background.js", "type": "module"}`。
- `desktopClientInstanceId`：首次使用 `crypto.randomUUID()` 生成并持久化，之后不变；清存储后是新 ID（D01 §5.2.2）。
- `envelope.mjs` 按类型分流：`health` / `handshake` 不带信封身份；其余必带 current；写类型的 payload 先填 `sourceRestoreEpoch`，**再**算 `payloadSha256`（摘要是去掉该字段后、键排序的 compact JSON）。发送前 `utf8JsonLen(envelope) > MAX_ENVELOPE_BYTES` 就地失败为 `payload_too_large`，不发。
- `transport.mjs` 的分类表——这是整个 D07 降级文案的地基：

  | 观察到 | 分类 | 含义 |
  | --- | --- | --- |
  | `lastError` 提到 host not found | `not_installed` | 无 host 注册 |
  | `ok:false` + `identity_not_allowed` | `not_paired` | 装了但没配对 |
  | `lastError` 其它（管道断、启动失败） | `retryable` | 曾配对，此刻不可用 |
  | `ok:false` + `unavailable` | `retryable` | 含冷启动超 10 秒 |
  | `ok:false` + 其它码 | `fatal`（按码分别处置） | |

  `lastError.message` 的措辞随浏览器版本变，**不能**只靠字符串匹配定生死：匹配不上时按 `retryable` 处理，宁可重试一次也不要谎报「未安装」。
- `session.handshake()`：成功后写 `desktopPairing = {archiveId, restoreEpoch, appVersion, at}`（仅提示，**不是**提交凭证）；`minProtocolVersion`/`maxProtocolVersion` 与本地区间不交 → `protocol_incompatible`，不落 pairing。
- 冷启动：`sendOnce` 内部对 `retryable` 只重试 **一次**（间隔 1s）。多次重试归 PR5 的 drain，不在传输层重复实现。

**测试（`node --test tests/*.test.js`）：**

- vendored 四个文件与 `desktop/crates/protocol/js/` 逐字节相同。
- 用 `desktop/crates/protocol/fixtures/requests/*.json` 反向验证：`envelope.mjs` 造出的 `job.save` / `queryCandidates` / `handshake` / `outbox.reconcile` 都能过 vendored `validateRequest`。
- `health` / `handshake` 带上身份会被拒；`queryCandidates` 多塞 `payloadSha256` 会被拒（`invalid_payload`）。
- 超过 65536 字节在本地就失败，不调用 `sendNative`。
- 五种传输观察各自映射到正确分类；`lastError` 措辞不认识时归 `retryable`。
- 握手区间不交 → `protocol_incompatible` 且不写 pairing。

**覆盖 #20 的：**「协议不兼容」测试项的一半（另一半是 PR3 的文案）。

**不做：** UI、队列、任何写入的实际发送。

---

## PR 2 · URL 脱敏与去重规范化

**只做：** 两个纯函数模块，无 chrome、无网络。

**文件：** `link/redact.mjs`、`link/normalize.mjs`、`tests/link-redact.test.js`、`tests/link-normalize.test.js`

**关键契约（data-privacy.md §7.1 与 product-requirements.md §7）：**

- 一律去掉 `user:pass@` 用户信息与 fragment。
- 始终剥离（大小写不敏感，含百分号编码的参数名）：`token`、`access_token`、`refresh_token`、`id_token`、`session`、`sessionid`、`sid`、`auth`、`authorization`、`api_key`、`apikey`、`password`、`pwd`、`secret`、`signature`、`sig`，以及 **默认剥离** 的 `code`、`key`。
- `sourceUrl` 与 `dedupeUrl` 用同一套剥离策略；`dedupeUrl` 再去 `utm_*` 并把 host 小写。
- 脱敏必须发生在 **入意图队列之前**，不留原始副本。
- `urlAllowlist` 结构：`{host, pathPattern, param, valuePattern, version, reviewedAt}`，**本轮为空数组**。命中规则才可保留岗位号；登录 / 回调 / 重置 / 邀请 / 认证路径永不适用。
- 规范化三元组：公司去首尾空白 + 全半角折叠 + 有限后缀词表（「有限公司」「股份有限公司」「(中国)」等，词表写死在模块里并注释来源）；岗位去首尾空白 + 压缩内部空白；URL 用 `dedupeUrl`。**原始字符串始终保留**，规范化只用于比较。

**测试：**

- data-privacy.md §7.1 的三个合成例逐字对上（`jobs.example.com/apply?code=REQ42&utm_source=mail&access_token=abc` → `sourceUrl = https://jobs.example.com/apply?utm_source=mail`、`dedupeUrl = https://jobs.example.com/apply`）。
- 认证路径反例：`auth.example.com/callback?code=...`、`portal.example.com/reset?key=...` 一律剥光。
- 重复参数、大小写变化（`Access_Token`）、编码参数名（`access%5Ftoken`）、超长值、非法岗位号语法。
- **脱敏输出必须能过 PR1 vendored 的 `checkUrl`**——这条把两个 PR 焊死，防止「插件觉得干净、桌面照样拒」。
- 规范化：同公司不同后缀折叠成同一 key；不同公司不折叠成同一 key（防过度折叠）。

**覆盖 #20 的：**「URL 删除明确的登录凭据/令牌等秘密参数」。

**不做：** 页面抽取、任何存储。

---

## PR 3 · 保存入口、字段确认与 SaveIntent 队列（离线可用，不发送任何写入）

**只做：** 桌面完全不在也能把用户确认过的字段安全存下来，并且诚实地说「待同步」。

**文件：** `content.js`、`content.css`、`link/intents.mjs`、`link/messages.mjs`、`background.js`、`tests/link-intents.test.js`、`tests/link-extract.test.js`

**关键契约：**

- 侧边栏新增「保存岗位到本地」。点击后弹字段确认面板，展示 **抽取到的** 公司 / 岗位 / 地点 / 来源链接，缺项留空让用户手填。抽取只用确定性来源：`JobPosting` JSON-LD、`og:title` / `og:site_name`、`document.title`、`<h1>`。**抽不到就留空，不猜、不调 AI**（#20：「缺失字段可手动补充，不捏造」）。公司与岗位为空时不允许确认。
- URL 在 **content.js 交给 SW 之前** 就过 `redact.mjs`（§5.2 时序图明确画在 content 侧）。
- **只带走用户确认过的那几个字段**：不存整页 HTML、不存浏览历史、不对用户没主动保存的页面留任何记录（#20 隐私条款）。抽取只在用户点「保存岗位到本地」之后跑一次，不在页面加载时后台扫描。
- 模式判定（复用 PR1 `session.mjs`）决定确认后的行为：

  | 模式 | 行为 | 文案 |
  | --- | --- | --- |
  | 未安装 / 从未配对 | **不建意图、不建队列** | 「先安装桌面程序」/「到桌面粘贴扩展 ID：`<chrome.runtime.id>`」+ 一键复制 |
  | 已安装未配对 | **不建意图** | 只说配对，**不得**说「未安装」 |
  | 曾配对、桌面不可用 | **持久化 SaveIntent** | 「待同步（尚未绑定申请）」 |
  | 协议不兼容 | 保留已有意图，不新建绑定 | 提示升级 |

  配对成功后提示「重载扩展或重启浏览器」（downstream-decisions 风险 V3）。
- SaveIntent 字段严格照 §8.10：`intentId`、`clientInstanceId`、`company`、`title`、`sourceUrl`、`location`、`createdAt`、`lastSeenArchiveId`（仅提示）、`status ∈ {pending_desktop, pending_bind, cancelled}`。**没有** `messageId`、**没有**申请 UUID、**没有** `restoreEpoch`。
- 10 秒去重：同一页规范化三元组相同且已有 pending 意图 → 提示「已有待同步意图」，不写第二条；用户显式点「再存一次」才铸新 `intentId`。
- 容量 100：满了拒绝新增 + 提示处理，不丢旧项，**不影响填表**。
- 待同步面板：列出意图、显示状态、支持删除单条。
- 存储 key 只用 `desktopSaveIntents` / `desktopOutbox` / `desktopClientInstanceId` / `desktopPairing`。

**测试：**

- 抽取：JSON-LD 齐全 → 三项都填；只有 `<title>` → 公司留空而不是拿站点名充数；脏页面不抛异常。
- 桌面不可用时确认 → 意图落盘且 UI 文案 **不含**「已保存」（断言字符串）。
- 未安装 / 从未配对 → `desktopSaveIntents` 保持为空。
- 10 秒内同三元组重复点击只有一条；显式「再存一次」有两条。
- 第 101 条被拒且前 100 条完好。
- 现有 `templates` / `aiConfig` / `resumeProUpdateCache` 在整个流程后逐字节不变。

**覆盖 #20 的：**「新增显式保存入口」「缺失字段手动补充」「离线入队」「队列满」「未安装时现有功能仍可用」，以及验收 1 的前半。

**不做：** queryCandidates、绑定、发送。

---

## PR 4 · 候选查询、绑定与 job.save 成功路径

**只做：** 桌面在线时，从意图走到「桌面已保存」，且重放不重复建档。

**文件：** `link/outbox.mjs`、`content.js`、`content.css`、`background.js`、`tests/link-outbox.test.js`、`tests/link-candidates.test.js`

**关键契约：**

- 握手成功后才 `application.queryCandidates`（读，payload 只带 `company` / `title` / `sourceUrl`）。**不把整库同步给插件**——只用应答里的最小形状。
- 候选 UI 两层（§7）：`exact` 标「可能是同一岗位的重复投递」，`sameCompany` 标「同公司其他岗位」。**默认新建，永不自动绑定**。第三个选项「稍后再说」= 意图保持 pending，不写绑定项。
- 用户选定后写 Bound outbox（§8.10 字段），此刻才铸 `messageId`、盖 `sourceRestoreEpoch = 当时 current`、算 `payloadSha256`。**先落盘，再发送**——发送前进程被杀也不会丢身份。
- 发送 `job.save`，信封身份用 **最新握手的 current**。应答 `ok:true` → 记 `resultId`，「新建」路径把返回的 `applicationId` 回填一次，删除对应意图与队列项，UI 才显示「桌面已保存（stage=saved，不是已投递）」。
- 应答一律 `validateResponseForRequest(res, req)`。校验不过按 `retryable` 处理，不当成功。
- 重试沿用同一 `messageId`，绝不新铸——桌面据此返回原 `resultId`。

**测试：**

- 假 host 返回 `queryCandidates` 双层结果 → UI 分层正确、默认选中「新建」。
- 绑定项落盘在发送之前（在 `sendNative` 里断言 storage 已有该项）。
- 同一 `messageId` 重发，桌面返回同一 `resultId` → 队列删一次、不产生第二条申请、不重复触发 UI。
- `ok:false` 的应答带了 `resultId`（越权响应）→ 被 `validateResponseForRequest` 拒绝，不写成功态。
- 「稍后再说」→ 意图仍 pending，`desktopOutbox` 为空。
- 「桌面已保存」文案只在 `ok:true` 且已删队列项之后出现。

**覆盖 #20 的：** 验收 2、验收 3 的重放部分、验收 5 的默认阶段、「支持选择新建或绑定现有」「候选查询只取必要字段」。

---

## PR 5 · 重试、退避与用户可控的待同步队列

**只做：** 应答丢了、浏览器重启了、桌面十分钟后才开——最后仍然恰好一条。

**文件：** `link/drain.mjs`、`background.js`、`content.js`、`tests/link-drain.test.js`

**关键契约：**

- `chrome.alarms` 驱动排空（SW 会被回收，`setTimeout` 撑不过）。Chrome 对 alarm 周期有 ≥30 秒的下限，退避阶梯据此设计：1s / 5s / 30s / 2min / 10min / 30min，**有上限**，达上限转「需要手动重试」而不是无限重试。30 秒以内的那几档只在 SW 仍存活时用 `setTimeout` 走，跨越回收一律靠 alarm。
- 退避不产生新业务事件：**重试沿用原 `messageId` 与原 `sourceRestoreEpoch`**，只有信封身份换成最新 current。
- 浏览器重启后 SW 冷启动时挂一次排空；意图与绑定项都从 `chrome.storage.local` 读回。
- 待同步面板显示：待同步条数、每条的失败原因（用 PR1 的分类，不回显协议原文）、下次重试时间、**手动重试**、**用户取消**。
- 绑定队列容量 100，满了拒绝新增并提示，不丢旧项、不阻止填表。
- 排空串行：同一时刻只有一条在途，避免多条抢同一个 host 冷启动。

**测试：**

- 假时钟推进，断言退避阶梯与上限；达上限后不再自动发。
- 「应答丢失」：`sendNative` 超时不回 → 重试用同一 `messageId`；第二次桌面返回原 `resultId` → 只删一次。
- 冷启动 `unavailable` 连续两次后成功 → 用户全程只看到「待同步」，没有错误弹窗。
- 模拟浏览器重启（丢弃内存态、只留 storage）→ 队列完整、排空继续。
- 队列满：第 101 条被拒，填表功能仍可用（跑现有 `tests/form-agent.test.js` 断言无回归）。
- 用户取消：队列项消失、不再重试、不给桌面发任何东西。

**覆盖 #20 的：** 验收 1 完整、「持久化待发送队列、有上限退避」「显示待同步数、失败原因、手动重试与取消」，测试项里的「浏览器重启」「应答丢失后重发」「连接恢复」「队列满」。

---

## PR 6 · restoreEpoch 不匹配：暂停、对账与用户决定

**只做：** 桌面恢复过备份之后，旧队列不许静默重放。

**文件：** `link/reconcile.mjs`、`content.js`、`background.js`、`tests/link-reconcile.test.js`

**关键契约：**

- 每次握手成功后，逐条比较绑定项的 `sourceRestoreEpoch` 与新 current：不等 → 该项 **立即暂停**，不发任何写入。
- 暂停项 **只能** 发 `outbox.reconcile`：外层信封用当前握手身份，payload 每项带完整旧身份 `{clientInstanceId, messageId, sourceRestoreEpoch, payloadSha256}`，批次 ≤ 32（`MAX_RECONCILE_ITEMS`）。
- 五种状态的处置：

  | 状态 | 处置 |
  | --- | --- |
  | `applied` | 桌面已执行过；删除队列项，**不新增业务事件**，也不把它当成可重放的许可 |
  | `purged` | 对象已被永久删除；不重建，告知用户 |
  | `not_found` | **不代表从未执行**；不自动重写，交用户核对 |
  | `conflict` | 同身份摘要不符；拒绝自动处理 |
  | `unverifiable` | 无法核实；不自动重放 |

- 用户对暂停项只有三个出口：**关联**（绑到指定申请）/ **丢弃** / **另存**。「另存」= 铸新 `messageId` + 盖当前 epoch + 记录旧身份关联，**该转换必须先持久化再发送**，重试不得再生成第三个身份。
- 意图不盖 epoch，桌面恢复后 **重新走 queryCandidates**，不直接复用旧候选。
- `sourceRestoreEpoch` 一旦写入 **永不修改**（§8.10 明确 immutable）。

**测试：**

- 换 epoch 后握手 → 所有旧绑定项 status 变 paused，且 `sendNative` 再没收到过任何写类型。
- 五种对账状态各自的处置，逐个断言队列与 UI 结果。
- 「另存」在发送前已落盘；连续两次重试只有一个新 `messageId`。
- 33 条待对账 → 分两批，每批 ≤ 32。
- 旧信封（旧 epoch）在任何路径下都不会被发出（全局断言）。
- 意图在恢复后重新查候选，不复用旧 `exact` 结果。

**覆盖 #20 的：**「restoreEpoch 不匹配时暂停旧队列，由用户决定关联/丢弃/另存，不自动重放」，测试项里的「重复内容冲突」「恢复档案库后的旧队列」。

---

## PR 7 · 确认已投递、降级文案收口与回归

**只做：** 补上 `submit.confirm`，把九种降级模式的文案一次对齐，出 D07 的验收证据。

**文件：** `content.js`、`content.css`、`link/outbox.mjs`、`README.md`、`docs/desktop-mvp/`（如有契约偏差）、`tests/link-submit-confirm.test.js`、`tests/link-degradation.test.js`

**关键契约：**

- 「确认已投递」按钮 **与 AI 填写成功与否无关**（§5.2 第 5 条），只对已绑定申请可用。payload 只有 `applicationId`（+ `sourceRestoreEpoch` / `payloadSha256`）。走与 `job.save` 同一套 outbox / 退避 / 对账。
- 一次保存 ≠ 已投递：`job.save` 后阶段是 `saved`，只有用户点「确认已投递」才推进。
- 把 §9 降级矩阵九行的文案集中到一处并逐行测：「未安装」「已安装未配对」「曾配对不可用」「离线」「AI 不可用」「协议不兼容」「epoch 不匹配」各自说什么、**不**说什么。
- 全量回归：`node --test tests/*.test.js` 全绿，含 D07 之前就有的 8 个测试文件。
- 若实现中发现与 D05 / D01 契约的偏差，**先改 [#23](https://github.com/TshyGO/resume-form-assistant-plugin/issues/23) / [#17](https://github.com/TshyGO/resume-form-assistant-plugin/issues/17) 和受影响 issue**，不只改本模块（#20 完成条件第 3 条）。
- 用 `desktop/scripts/nm_browser_check.py` 的方式跑一次真实浏览器端到端，把证据贴回 #20。**关闭顺序：先让应用退出，再关浏览器。**

**覆盖 #20 的：** 验收 4、验收 5 完整，「当前插件完整回归」，完成条件三条。

---

## 依赖与并行

```text
PR1 ──> PR2 ──> PR3 ──> PR4 ──> PR5 ──> PR6 ──> PR7
```

PR1→PR4 严格串行：后一个都要用前一个的模块。PR5 与 PR6 都改待同步面板，建议顺序合并而不是并行开两个分支——谁先合谁不改，后者 rebase。PR2 唯一能提前的是它的纯函数部分，但收尾测试要用 PR1 的 `checkUrl`，所以仍排在 PR1 之后。

## #20 验收清单的覆盖

| #20 验收 | PR |
| --- | --- |
| 关闭主程序保存岗位，重启浏览器后队列仍在；恢复后只产生一条 | PR3（持久化）+ PR5（重启与排空） |
| 「桌面已保存」只在持久化应答后出现 | PR4（正路）+ PR3/PR7（反例文案） |
| 重复点击 / 消息重放不重复建档；同 URL 可显式新建 | PR3（10 秒去重）+ PR4（同 messageId 重放） |
| 未安装桌面程序时现有功能仍可用 | PR3（不建队列）+ PR5（队列满不阻塞）+ PR7（回归） |
| 一次保存不等于已投递，默认阶段 saved | PR4 + PR7 |

| #20 测试项 | PR |
| --- | --- |
| 离线入队 | PR3 |
| 浏览器重启 | PR5 |
| 应答丢失后重发 | PR5 |
| 重复内容冲突 | PR6（`conflict`） |
| 连接恢复 | PR5 + PR6 |
| 队列满 | PR3（意图）+ PR5（绑定） |
| 协议不兼容 | PR1（协商）+ PR3（文案） |
| 恢复档案库后的旧队列 | PR6 |
| 当前插件完整回归 | PR7 |

## 明确不在 D07 范围

- **快照字节与 IndexedDB 暂存**（D08 #22）。`snapshot.chunk` 在 D06 一律回 `unavailable`，D07 不发它。
- **`fill.submit` 填写留档**（D08 #22）。D07 只搭出 outbox 机制，不接填写事件。
- **生产环境的 host 注册与安装包**（D13 #29）。开发期用 `desktop/scripts/nm-dev-register.mjs`。
- **桌面侧的配对界面**（D06 已做）。插件只显示自己的扩展 ID。
- **备份恢复本身**（D12 #28）。D07 只处理恢复之后插件这一侧的对账。

## 风险登记（downstream-decisions.md）

| 编号 | 风险 | 本计划的处置 |
| --- | --- | --- |
| V2 | host 按需拉起应用 | PR1 的冷启动重试 + PR5 的退避；文案「请先打开一次桌面」 |
| V3 | 改 host manifest 后能否不重启就连上 | PR3 配对成功后强制提示「重载扩展或重启浏览器」 |
| V4 | MV3 SW 与 `connectNative` | 架构决策 1：直接用 `sendNativeMessage`，`transport.mjs` 留换实现的缝 |
| V12 | 扩展源 IndexedDB 在 SW 重启后能否读回 | D07 不碰 IDB；风险留给 D08 |
