# 数据归属、隐私与备份规则

| 字段 | 值 |
| --- | --- |
| 标题 | 本地档案所有权、敏感分级与备份恢复 |
| 作者 | D01 design PR |
| 日期 | 2026-09-06 |
| 状态 | Draft / Ready for review |
| 上级 | [README.md](README.md) · [D01 #17](https://github.com/TshyGO/resume-form-assistant-plugin/issues/17) |
| 并列 | [product-requirements.md](product-requirements.md) · [adr-architecture.md](adr-architecture.md) · [downstream-decisions.md](downstream-decisions.md) |

本文回答：数据在哪、谁能写、什么永远不能存、离线快照字节放哪、备份装了什么、恢复如何隔离旧队列。物理 schema 仍归 D03；备份格式版本归 D12。目录与凭据有平台适配；档案文件格式跨平台。

---

## 1. Overview

求职档案（申请、事件、附件、简历快照、待办、已确认的 AI 建议结果）**归用户本机上的桌面档案目录所有**。浏览器插件不是权威源：它持有可编辑的活模板和自己的 AI Key，并可在用户同意后向桌面投递岗位/填写事件。

没有云账号、没有多设备同步。使用用户配置的云端模型时，必须展示外发范围；不得宣传「装了本地应用 = AI 全部在本地」。

---

## 2. 所有权与信任边界

| 数据 | 所有者 | 权威副本 | 允许的副本 |
| --- | --- | --- | --- |
| 申请 / 事件 / 待办 / 证据 / 快照 | 用户 | Tauri 后端（`data-service` 库）管理的 archive 目录 | 用户导出的备份文件 |
| 插件模板、`activeTemplateId` | 用户 | `chrome.storage.local` | 填写归档时生成的 **不可变快照** |
| 插件 `aiConfig.apiKey` | 用户 | 仅扩展存储（今天明文） | **禁止**复制到桌面档案或备份 |
| 桌面模型 Key（D11） | 用户 | OS 凭据库：Windows Credential Manager / DPAPI；macOS Keychain | **禁止**进 SQLite、附件、备份、日志 |
| 保存意图 / 绑定 outbox | 用户 | `chrome.storage.local` 新 key | 不得含 Key；绑定项恢复后按 **restoreEpoch** 暂停 |
| 离线快照字节 | 用户 | 扩展源 **IndexedDB**（SW/offscreen/扩展页） | ACK 后删除；不得写在 content script 的页面源 |

写入者：仅 **应用进程**（`data-service` 库）。插件、WebView 子进程、NM host 都是客户端。从未配对时，插件不得把申请档案写进扩展存储冒充桌面库，也不得堆积意图。曾经配对但桌面不可用时，只允许 SaveIntent + IndexedDB 快照暂存，不得显示已保存。

---

## 3. 目录布局

安装目录 ≠ 用户数据目录 ≠ 缓存目录。档案必须与程序文件分离，避免升级覆盖或卸载误删。

**禁止**把开发机绝对路径写进产品。设置页展示解析后的真实路径（中文/空格用户名）。目录不可写时失败，**禁止**静默改用临时目录。

Windows（Known Folder `FOLDERID_LocalAppData`）：

```text
%LOCALAPPDATA%\ResumePro\
  archive\             current 档案
    archive.db
    attachments\
    snapshots\
    tmp\
    meta.json          archiveId, schemaVersion（不含 restoreEpoch）
  current.json         机器本地指针：archiveDir, archiveId, restoreEpoch
  archives-retired\
  logs\
  cache\               WebView2 用户数据等
```

macOS（`NSApplicationSupportDirectory` / `NSCachesDirectory`）：

```text
~/Library/Application Support/ResumePro/
  archive\  ... 同上结构 ...
  current.json
  archives-retired\
  logs\
~/Library/Caches/ResumePro/     缓存，卸载策略可更激进
```

`restoreEpoch` **只**在 `current.json`（或等价指针文件），**不**进备份包、**不**进 `archive/meta.json` 的「可移植身份」。备份可以记录「当时指针曾是什么」作诊断，恢复时必须忽略并新铸。

WebView 用户数据放在上述 cache/数据根下，不要用安装目录旁的默认文件夹。

相对路径入库；拒绝 `..`、盘符、UNC。附件文件名冲突时加后缀，不覆盖（D09）。

---

## 4. 敏感分级

与 [字段目录](product-requirements.md#8-逻辑对象与字段目录) 一致，三类：

| 级 | 含义 | 例子 | 存储 |
| --- | --- | --- | --- |
| `public-meta` | 流程元数据 | UUID、stage code、计数、耗时、插件版本 | 可进 DB/日志（日志仍截断） |
| `PII` | 能识别求职者或雇主沟通内容 | 公司、姓名备注、邮件正文、简历快照、地点、发件人 | 可进档案与备份；**默认不进日志**；导出备份必须警告 |
| `secret-forbidden` | 能造成账户接管 | 见下表 | **任何层都不得保存** |

### 4.1 永远不得出现在档案、事件、快照、日志、备份、诊断导出中

- 密码、支付口令
- OTP / 短信验证码 / 邮箱验证码
- API Key（插件与桌面）
- Cookie、`Set-Cookie`
- `Authorization` 头及其值
- URL 中的令牌类查询参数（见 §7.1）
- NM host 的机器专属绝对路径（备份排除；诊断可含「已配置/未配置」）
- 网页密码框、`autocomplete=one-time-code` 的控件值

插件填写路径已尽量不扫 `type=hidden|file|button|submit`；桌面留档仍要再剥一层。不确定是否为 secret 时：**丢弃该字段，不得「先存再看」。**

### 4.2 插件活模板 vs 桌面快照

- 活模板：仅 `chrome.storage.local`，用户可随时「重新导入 Excel」覆盖。
- 快照：填写归档确认时拷贝，之后 **immutable**。桌面不可用时字节进扩展源 IndexedDB；重试发原字节，禁止从活模板重生成。见 [产品需求 §8.5](product-requirements.md#85-resumesnapshot)。
- 不得为了「方便同步」把活模板全量写入桌面，除非用户在某次归档中明确保存快照。

---

## 5. 删除、回收与永久清除

| 操作 | 申请行 | 事件 | 附件 blob | 可恢复 |
| --- | --- | --- | --- | --- |
| 列表归档 `archivedAt` | 保留，列表默认隐藏 | 保留 | 保留 | 是 |
| 回收 `recycleState=recycled` | 保留 | **保留** | **保留** | 是（D12） |
| 永久删除（二次确认） | 删除或墓碑 | 随申请移除 | **仅当引用计数为 0** 才删文件 | 否 |
| 卸载程序 | 不触碰 archive | — | — | 档案仍在磁盘 |

孤立附件检查可在维护任务中列出，**不自动删除**不确定项（D12）。永久删除文案必须写清：不可从本应用撤销；若有备份可从备份恢复。

---

## 6. 备份与恢复

### 6.1 完整备份包含

- SQLite **一致性快照**（备份前 checkpoint 或使用 SQLite backup API，D12 定）
- `attachments/`、`snapshots/`
- 事件、待办所在表（随 DB）
- 非秘密设置（UI 偏好、是否允许浏览器连接）
- `manifest`：格式版本、`archiveId`、`schemaVersion`、文件清单、每文件 sha256。**不含** `restoreEpoch`、机器 IPC 路径、凭据

### 6.2 明确排除

- API Key、OS 凭据副本、任何 auth cache
- 调试日志、诊断包
- 机器专属 native-host 路径、注册表路径
- `tmp/`、WebView2 cache、安装器自身

### 6.3 加密

**MVP 备份不加密。** 导出 UI 必须警告：文件含简历与邮件等 PII，应放在用户自己控制的位置。不得在发布说明或界面宣传「已加密」。若未来要加密，另开 issue，不在 D12 悄悄加上。

### 6.4 写入与失败

写到临时目录，校验哈希后原子改名发布。失败不得覆盖已有有效备份。磁盘满：保留原档案 + 至少一个旧有效备份。

### 6.5 恢复

```mermaid
sequenceDiagram
  participant U as 用户
  participant UI as Desktop UI
  participant APP as 应用进程
  participant P as 插件绑定队列
  U->>UI: 选择备份文件
  UI->>APP: 校验大小/路径穿越/哈希/版本
  APP-->>UI: 预览（申请数/事件数/附件数）
  U->>UI: 确认恢复
  APP->>APP: current 档案移到 archives-retired
  APP->>APP: 解压到新 archive 目录
  APP->>APP: 新铸 restoreEpoch，写入 current.json
  APP-->>UI: 成功；旧目录可回滚
  P->>APP: handshake
  APP-->>P: 同一 archiveId + 新 restoreEpoch
  Note over P: 握手成功；比较绑定队列盖章后暂停
  U->>P: 关联 / 丢弃 / 另存
```

规则：

1. 先预览再确认。
2. 恢复到 **新档案目录** 再切换；**MVP 不做逐行 merge**。
3. 旧档案保留为回滚点，直到用户显式删除。
4. 损坏、截断、不支持版本、路径穿越：拒绝，**current.json 不变**（旧 epoch 仍有效）。
5. **保留 backup 的 `archiveId`。每次成功切换 current 指针新铸 `restoreEpoch`（UUID）。** 不从备份读取 epoch，不用 `generation+1`。握手 **成功** 并返回新 `(archiveId, restoreEpoch)`。绑定队列盖章不符则暂停。意图无 epoch，恢复后重新候选。
6. 再次恢复 **同一** 备份：再铸新 UUID，与上一次不同（走查 10.8 / 10.12）。
7. 回滚到 retired 目录：视为一次新的指针切换，**再铸** epoch，不复用失败前的值。
8. 桌面幂等 `(clientInstanceId, messageId, restoreEpoch)`。epoch 不符 → `restore_epoch_mismatch`，禁止当成功重放。
9. 恢复后不得瞬间重放全部待办通知；按产品 §5.4 重新登记系统调度。

存储量粗估（单用户一季）：DB 数 MB；每封 eml/PDF 数十 KB–数 MB；简历快照常见为数十–数百 KiB，产品上限 **2 MiB**（超过则拒绝，走桌面导入）。备份大小 ≈ DB + 附件 + 快照。不在 D01 承诺压缩比。

---

## 7. 插件采集边界

只记录 **用户主动** 的：保存岗位、确认投递、确认填写留档。不监听全部输入、不装全局键盘记录、不保存整页 HTML、不保存浏览历史、不保存用户未点保存的页面。

### 7.1 URL 脱敏与去重 URL

去掉 `https://user:pass@host/` 用户信息与 fragment。

**始终剥离**（大小写不敏感；写入 `sourceUrl` 与 `dedupeUrl`）：

`token`、`access_token`、`refresh_token`、`id_token`、`session`、`sessionid`、`sid`、`auth`、`authorization`、`api_key`、`apikey`、`password`、`pwd`、`secret`、`signature`、`sig`。

**单独的 `code` / `key` 不当成秘密**，除非同时出现上述令牌类邻居（例如同 URL 已有 `access_token` 或 `client_id`+`grant`）。许多 ATS 用 `?code=REQ42` / `?key=job-7` 表示岗位号；剥掉它们会让 10.4 精确层失效，或把不同岗位撞在同一 `dedupeUrl`。

- `sourceUrl`：展示与存储；剥秘密，**保留**岗位号 `code`/`key`。
- `dedupeUrl`：身份规范化（host 小写、无 userinfo、无 fragment、剥秘密列表）；同样 **保留** 裸 `code`/`key`。

合成例：

```text
https://jobs.example.com/apply?code=REQ42&utm_source=mail&access_token=abc
sourceUrl  = https://jobs.example.com/apply?code=REQ42&utm_source=mail
dedupeUrl  = https://jobs.example.com/apply?code=REQ42&utm_source=mail
```

`utm_*` 是否从 `dedupeUrl` 再剥留给 D07 实现，但 **不得**剥 `code=REQ42`。令牌类不确定时仍宁可多剥。

### 7.2 填写留档

默认事件元数据见 [产品需求 §8.8](product-requirements.md#88-填写留档默认范围)。逐字段值默认关。用户拒绝留档：填表照常，不向桌面发送采集 payload。

---

## 8. AI 外发

两条互不相通的 Key：

| | 插件填写/解析 | 桌面通知整理（D11） |
| --- | --- | --- |
| 配置位置 | `chrome.storage.local.aiConfig`（今天明文） | Windows：Credential Manager / DPAPI；macOS：Keychain |
| 发往 | 用户填的 `apiUrl` | 用户另配的桌面接口 |
| 内容 | 表单字段描述 + 相关简历分组（现有逻辑） | 证据正文/片段 + **最少**候选申请元数据 |
| 确认 | 用户主动点「一键 AI 填写」即同意该次填写外发 | 发送前预览范围、服务商、模型 |

共同规则：

- 不把完整档案库送给模型。
- 不把另一条申请的快照当作上下文，除非用户在消歧中选中。
- 模型返回只是建议 JSON；正文里的「忽略以上指令」不得变成工具权限（D11）。
- 网络慢可取消；不自动重复计费重试。
- 失败不影响本地证据与手动阶段。

插件 Key **永不**因「桌面也要用 AI」而被复制。用户若在桌面再配一次，那是第二条凭据。

---

## 9. 日志与诊断

格式：`timestamp utc | errorCode | component | redactedContext`。

允许：stage code、UUID、字节数、耗时、HTTP 状态码（桌面出站）、NM 拒绝原因（`origin_forbidden`、`oversize`、`unknown_type`）。

禁止：简历字段值、邮件正文、主题可考虑截断哈希而非原文、Key、Cookie、完整 URL（只用剥过的 host+path 或 hash）。

用户导出诊断：日志 + 版本 + 档案元数据 + 队列长度。默认不含附件。导出同样警告可能残留 PII（公司名等若曾入上下文）。

现有插件诊断 [`formatFillDiagnostics`](../../content.js) 已用错误类别 allowlist；桌面应对齐该纪律。

---

## 10. 升级、卸载、多浏览器

- 升级覆盖 INSTDIR，不碰 `archive\`；迁移前自动备份 DB（D03/D12）。
- 卸载默认留档案；注册表 NM 项指向已删除 EXE 时必须清掉，避免「host not found」残留（D13）。
- D13 **始终**写 Chrome **和** Edge 的 HKCU `NativeMessagingHosts` 键（见 ADR §2）。不得只写 Chrome 键再指望 Edge fallback。配对在桌面 UI 粘贴 ID，分别写入对应 manifest。
- 无云同步：换电脑 = 备份恢复。恢复后握手成功并返回新 `restoreEpoch`；插件暂停盖着旧 epoch 的绑定队列，不得静默写入。
- macOS 卸载 `.app` 默认不动 `~/Library/Application Support/ResumePro/`。

---

## 11. 威胁模型（简表）

| 威胁 | 严重度 | 缓解 |
| --- | --- | --- |
| 恶意扩展进入 allowed_origins | 高 | 无通配；生产不写任意 ID；host 扫描 argv 中的 origin token（不是 argv[0]） |
| 本机其他用户读 named pipe | 高 | DACL 仅当前 SID |
| 备份文件被上传到网盘 | 中 | 明文警告；不宣传加密 |
| 日志泄漏简历 | 中 | allowlist；诊断默认无附件 |
| 路径穿越写入 archive 外 | 高 | 相对路径规范化；拒绝 `..` |
| HTML 邮件 XSS / 跟踪像素 | 中 | 清洗、不执行脚本、不加载远程图（D09） |
| 模型提示注入 | 中 | 无工具权限；确认后才写库 |
| 卸载误删档案 | 高 | 默认保留；单独确认 |

---

## 12. Observability 与合规口径

- 不做云遥测。
- 当前插件仓库以 MIT 发布（[`LICENSE`](../../LICENSE)）。测试夹具必须合成或脱敏。后续桌面模块的产品许可 **尚未定案**，本文不把 MIT 写成未来所有模块的承诺。
- 不宣称 GDPR 认证；产品是单机工具。若未来加云，另开 Epic。

---

## 13. Open Questions

备份是否加密、填写留档是否默认含字段值：见 [downstream-decisions.md](downstream-decisions.md#需要项目负责人选择)。本文按 **不加密、默认仅元数据** 撰写。

---

## 14. References

- KNOWNFOLDERID `FOLDERID_LocalAppData`: https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid
- SQLite 单文件格式: https://www.sqlite.org/onefile.html
- Chrome NM `allowed_origins` 无通配符: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- Credential Manager / DPAPI：D11 对照 Windows `CredWrite` / `CryptProtectData`（本 D01 不实现）
- macOS Keychain：D11 对照 Keychain Services；本 D01 不实现
- 扩展 IndexedDB：https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies
- Epic #15 规则 5–8；D08 #22、D09 #21、D12 #28、D13 #29
- [`content.js`](../../content.js) `STORAGE_KEYS`、`formatFillDiagnostics`；[`popup.js`](../../popup.js) `aiConfig`
