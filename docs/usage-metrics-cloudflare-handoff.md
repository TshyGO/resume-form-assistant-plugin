# Cloudflare 使用统计：协作者交接清单

关联 [Issue #259](https://github.com/TshyGO/resume-form-assistant-plugin/issues/259) 和 [统计口径/本地工具](usage-metrics.md)。本文是后续云端阶段的接口契约和资源要求，**当前第一阶段无需创建资源或返回配置**。

## 1. 分工与需要返回的信息

仓库开发者负责：接口说明、源码、D1 迁移、测试、本地工具、桌面和插件接入；Cloudflare 协作者负责：资源创建、绑定、Secret、云端部署、日志/访问控制配置和运行验证。云端源码在第二阶段提供，不能只建一个 Hello World Worker 就视为接口已完成。

第二阶段先部署隔离测试服务，用虚构数据验证；正式发布阶段再准备生产服务。

请协作者返回：

| 信息 | 示例/用途 | 何时需要 |
| --- | --- | --- |
| 测试 HTTPS 基础地址 | `https://resume-usage-metrics-test.<账号子域>.workers.dev` | 云端联调 |
| POST/DELETE 路径与实现状态 | 均为 `/v1/activity`，请求/返回符合下文 | 云端联调 |
| 部署版本 | 仓库 commit SHA 和 schema_version=1 | 对齐代码 |
| 配置确认 | 测试 D1 绑定成功、Secret 已设置、限流/日志/清理已配置 | 云端联调 |
| 测试证据 | 虚构编号去重、删除、清理、非法输入拒绝；不含真实编号 | 云端验收 |
| 生产 HTTPS 基础地址与启用状态 | 独立生产环境，启用前完成发布核对 | 正式发布 |
| 管理查询入口和访问方式 | 初期可用维护者受控脚本；网页须身份认证 | 报表阶段 |

客户端不需要 Cloudflare 账号 Token、HMAC Secret 或 D1 访问密钥。Worker 名称和 D1 ID 仅作为部署标识按需要写到服务配置，客户端只使用确认过的 HTTPS 地址；Secret 留在部署方的 Secret 管理中。

## 2. 建议的 Cloudflare 配置

| 项目 | 配置 |
| --- | --- |
| 测试资源 | 独立 Worker `resume-usage-metrics-test`、D1 `resume-usage-metrics-test` |
| 生产资源 | 与测试分开的 Worker、D1、Secret；不复用现有 /feedback 处理链 |
| 数据库绑定 | 变量名 `DB`；第二阶段使用仓库 migrations 建表，记录迁移版本 |
| Secret | `INSTALLATION_HMAC_KEY`，高熵随机密钥；测试/生产不同，不打印或提交 |
| 服务开关 | 非敏感设置 `METRICS_ENABLED` 控制活动写入；上线前关闭，测试环境按测试需要开启 |
| Cron | 建议 `10 0 * * *`，每日 UTC 00:10（北京时间 08:10），执行下载快照、汇总、清理 |
| 方法与大小 | POST/DELETE，application/json，请求体最大 512 字节；禁止把客户端共享 token 当秘密 |
| 传输 | HTTPS，无交互验证码/浏览器挑战/管理员登录要求；桌面 reqwest 要能够直接调用活动接口 |
| 运维 | 限流、无身份错误计数、最近 Cron 成功时间、数据库读写量和费用预警；明确故障联系人及停收操作 |
| 管理入口 | 维护者认证，网页可用 Cloudflare Access；覆盖所有备用域名/入口，按实际接入方式验证身份 |

Cron 当天只看到此前下载累计，报告按实际快照起止时间展示。缺采不能伪装完整自然日。数据库发生错误的那次运行标为失败，不生成假零数据。预算预警不等于费用硬上限，应同时制定停收操作。

## 3. POST /v1/activity（协议 v1）

Content-Type：`application/json`。严格只接受下列五字段，无 Cookie、客户端时间、网页/简历/操作内容；拒绝额外字段。

```json
{
  "schema_version": 1,
  "installation_id": "11111111-1111-4111-8111-111111111111",
  "platform": "windows",
  "app_version": "0.4.3",
  "surface": "desktop"
}
```

| 字段 | 规则 |
| --- | --- |
| schema_version | JSON 整数，值为 1 |
| installation_id | UUIDv4，校验版本位和 RFC variant，允许十六进制大小写；计算 HMAC 前转小写 |
| platform | windows 或 macos |
| app_version | 最长 64 个 ASCII 字符，三段非负整数版本，可包含合法的预发布和构建后缀；不能只白名单当前版本 |
| surface | desktop 或 extension |

版本格式规则：基础版本不带多余前导零；可选 `-` 预发布后缀和 `+` 构建后缀，点分隔的标识仅含 ASCII 字母、数字、连字符，预发布中的纯数字标识不能带多余前导零。接受 `0.4.3`、`0.4.3-beta.1`、`0.4.3+build.7`。版本是最后观察值，不据此推测安装时长。

服务端取 UTC 时间，HMAC-SHA256 后存入 D1。以日期+哈希唯一约束，重复/并发请求 UPSERT：来源标志取 OR，版本及最后观察时间按收到的顺序更新。同一天两来源最多两次请求，整体活跃仍为 1。服务端不能靠客户端节流保证去重。

## 4. DELETE /v1/activity（协议 v1）

相同基础地址和 Content-Type，仅接受两字段，最大 512 字节：

```json
{
  "schema_version": 1,
  "installation_id": "11111111-1111-4111-8111-111111111111"
}
```

UUID 按相同规则规范化后定位哈希，删除所有关联活动明细。不存在的编号也返回成功，避免泄漏安装是否存在。重复删除必须幂等。

先确保客户端已停止活动，再尝试删除。服务端通过原子写入/删除和短期撤销状态处理晚到请求，删除成功之后的旧编号不能恢复活动明细。建议撤销表仅存哈希和 expires_at，最长 45 天；清理和隐私说明同时覆盖该表。重新手动开启使用新 UUID。

不能要求仍保存统计编号或持续重试才允许关闭：断网、超时、服务器失败均不阻塞客户端关闭。云端明细此时最多按在线保留期限继续留存；界面如实说明。

## 5. 返回值与客户端处理

| HTTP 状态 | 含义 | 客户端行为 |
| --- | --- | --- |
| 204 | 写入或删除完成；无响应 body，包含重复合法请求 | POST 不重复发送；DELETE 可提示在线明细已删除，保留备份说明 |
| 400 | JSON/字段/UUID/版本/协议等不合法 | 本次失败，不自动重试，不影响功能 |
| 405 | 方法不支持 | 本次失败 |
| 410 | POST 的旧编号已撤销 | 不自动换编号或重新启用；标记该编号不可继续上报，用户手动重新开启才生成新编号 |
| 413 | 请求体超限 | 本次失败 |
| 415 | Content-Type 不支持 | 本次失败 |
| 429 | 限流 | 本次失败，当天该来源不自动重试 |
| 500 / 503 | 数据库/服务错误或活动写入停用 | 本次失败，不自动重试 |

失败 body 可为空；如提供 JSON，仅使用稳定错误代码（例如 `{"error":"invalid_request"}`），不回显编号、请求体、数据库信息或堆栈。网络超时等价失败。DELETE 不受活动写入停收开关阻止，数据库可用时仍处理删除。未完成 D1 持久写入不能返回假成功。

桌面 HTTP 调用无浏览器 CORS 前置需求；浏览器插件只发送本机信号，不直接访问 Worker。不把活动接收接口放在管理员 Access 登录之后；管理查询独立保护。

## 6. 数据生命周期与日志

- 原始 UUID 只在处理期间短暂存在，HMAC 规范化后落库；不进应用日志/追踪。
- 活动明细主库保留 45 天，短期撤销元数据最长 45 天，无安装编号的历史汇总和每日滚动指标快照 365 天。
- 原始请求体、IP、完整 User-Agent、Referer、网页、个人资料和 API Key 不进入统计业务库或业务日志。基础设施仍处理 HTTP 元数据，按实际平台配置披露。
- 主表删除不表示所有备份同刻删除。核对 D1 Time Travel 和实际导出备份；政策分开说明期限。恢复前运行保留清理并按有期限的撤销记录处理已删除安装。
- 保持 HMAC 密钥跨统计窗口稳定，轮换前设计重叠/迁移及删除处理，不能直接换 key 导致双计或无法删除。
- 不提供公开逐设备查询，不把活动数据送入 /feedback→Muse→GitHub Issues。

## 7. 第二阶段联调验收清单

- [ ] 测试和生产资源隔离；部署版本与仓库代码一致。
- [ ] 虚构同安装同日 100 次或两个来源的请求，数据库只有一条活动记录。
- [ ] UTC 跨日、7/30 日去重及每安装最后版本查询正确。
- [ ] POST/DELETE 请求格式及全部失败返回符合上表。
- [ ] 删除后旧编号的晚到 POST 不恢复明细，重复删除成功。
- [ ] 关闭采集服务不妨碍 DELETE；数据库错误不回复假成功。
- [ ] 存储和日志无原始编号/请求体/IP/UA；清理按期限运行并可观察最近成功时间。
- [ ] 下载分页完整，失败不写零，首次/新附件基线和漏采区间明确。
- [ ] 管理入口认证，普通访客或备用域名不能读取逐设备信息。
- [ ] 桌面候选包和虚构数据联调通过；生产启用另做发布核对。

官方参考：[D1 绑定](https://developers.cloudflare.com/d1/get-started/)、[Worker Secret](https://developers.cloudflare.com/workers/configuration/secrets/)、[Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[D1 备份](https://developers.cloudflare.com/d1/reference/time-travel/)、[Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)。
