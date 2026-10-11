# 使用统计 Worker（Issue #259 第二阶段）

本目录实现接收、D1 存储、去重、删除、下载快照、汇总和清理。依赖第一阶段的 `desktop/scripts/usage-metrics/downloads.mjs`。仓库内开发和测试可以独立完成，**Cloudflare 资源最初由协作者准备；用户后续已授权使用所提供的测试环境 Token，从本地执行测试配置、部署与联调**。没有桌面或插件上报接入，没有自动部署。

## 1. 已提供的功能

- `POST /v1/activity`：严格校验五字段、512 字节上限、UUIDv4、系统/来源和 SemVer；原始编号不落库。每天同一安装一条，来源取 OR，版本取最后观察值。
- `DELETE /v1/activity`：两字段、幂等删除，事务中同时登记短期撤销状态。晚到的旧编号返回 410，重复删除不延长有效撤销记录的保留期限。
- `GET /health`：检查数据库、HMAC Secret 和限流器是否配置就绪。`activity_enabled`是采集开关，`activity_config_ready`是活动/删除所需配置是否就绪，`activity_ready`仅在配置就绪且开关开启时为 true。配置正确但主动停收时仍为 200；配置缺失或数据库检查失败为 503。检查不消耗限流额度，也不提供密钥、设备或统计数据。根地址不提供页面。
- Cron：汇总已结束的 UTC 日，清理过期记录，完整分页取得 GitHub Release/附件后一次事务保存下载快照。
- 管理报表：通过维护者的 Wrangler/D1 权限查询，无公开管理 HTTP API；输出总数、版本分布、采集起点、任务状态和下载增量。

当前默认配置 `METRICS_ENABLED=false`。活动写入停用时 POST 返回 503；DELETE 仍可处理。DB、限流绑定或至少 32 字节的 HMAC Secret 缺失时不接收活动。不把部署 API Token 当 HMAC Key，也不把两者交给客户端。

## 2. 本地开发（不用真实密钥）

需要 Node.js 22+，在本目录运行：

```sh
npm ci
npm test
cp dev-vars.example .dev.vars
WRANGLER_SEND_METRICS=false npm run migrate:local
WRANGLER_SEND_METRICS=false npm run dev
```

`.dev.vars` 使用虚构密钥并仅用于本地，可被 Wrangler 读取；文件已忽略。默认 Wrangler 配置是本地占位配置，数据库 ID 为零，不作为可直接部署的环境。

打开 `http://localhost:8787/health`。测试活动（全部为虚构数据）：

```sh
curl -i http://localhost:8787/v1/activity -H 'Content-Type: application/json' -H 'CF-Connecting-IP: 192.0.2.1' --data '{"schema_version":1,"installation_id":"11111111-1111-4111-8111-111111111111","platform":"windows","app_version":"0.4.3","surface":"desktop"}'
curl -i -X DELETE http://localhost:8787/v1/activity -H 'Content-Type: application/json' -H 'CF-Connecting-IP: 192.0.2.1' --data '{"schema_version":1,"installation_id":"11111111-1111-4111-8111-111111111111"}'
```

两次操作返回 204。删除后再使用旧编号 POST 返回 410。创建其他虚构编号模拟重新开启。

上面的来源头仅用于本机测试，192.0.2.1 是虚构测试地址。生产桌面不自行设置来源头，由 Cloudflare 直连接收路径提供。缺失/空来源头时 POST/DELETE 返回 `503 client_source_unavailable`，不进入限流或写库；不要配置转发或移除来源头。没有全局 unknown 回退桶，也不使用安装编号或随机值绕过来源限流。

查看汇总（另一个终端，本目录）：

```sh
node scripts/report.mjs --local
```

支持 `--window 7` 或 `--window 30` 的版本观察窗口。DAU/WAU/MAU 始终分别按 1/7/30 个 UTC 日计算。`--date YYYY-MM-DD` 仅接受今天及前 15 天，以保证完整 30 日窗口仍在 45 天明细内；更早的历史只读取已存汇总，不能重算版本分布。今日标为未结束；无采集起点表示尚无成功上报，不代表全量产品用户为零。

报表先检查日期和窗口，再读取配置/调用数据库工具。不存在的日期（包括 2026-02-30、2026-13-01）、不支持的窗口和超出可重算范围的日期各有固定提示；失败不输出报表，不回显参数、配置路径、Token、SQL 错误或堆栈。

`npm test` 使用官方 Miniflare/Workerd 和实际 D1 SQL 引擎；不调用 Cloudflare 远端或 GitHub。依赖版本锁定，Miniflare v5 的 alpha 版本来自当前 Wrangler 官方依赖，使用其 V4 选项转换器。CI 独立运行这些测试、迁移、报表和部署 dry-run。

## 3. 维护者：测试环境部署顺序

1. 先确认代码评审版本和目标资源。第一阶段 PR #267 仍未合并时，第二阶段分支依赖其提交；正式合入按第一阶段→第二阶段顺序处理。
2. 将 `wrangler.test.example.json` 复制为已忽略的 `wrangler.test.json`，填入共享条目的非敏感 account_id、database_id，核对 Worker/D1 名称和 `DB` 绑定。保持 `METRICS_ENABLED=false`。
3. 为 ACTIVITY_LIMITER 选择账号内未与其他服务共用的数字 namespace_id；测试/生产不同。默认 60 次/分钟/来源 IP 的短期键是近似、每个 Cloudflare 位置的限流，不是全球精确额度，也不是费用硬上限。
4. 维护者通过自己的安全登录/环境配置使用管理 Token，不把值填进配置文件。先应用业务迁移，再设置独立随机 HMAC Key，然后部署经审核的源码。

在本目录由持有指定测试环境权限的维护者执行：

```sh
WRANGLER_SEND_METRICS=false npx wrangler d1 migrations apply DB --remote --config wrangler.test.json
WRANGLER_SEND_METRICS=false npx wrangler secret put INSTALLATION_HMAC_KEY --config wrangler.test.json
WRANGLER_SEND_METRICS=false npx wrangler deploy --config wrangler.test.json
```

secret put 使用交互输入，由维护者生成高熵密钥（建议随机 32 字节以上）；不要复制本地示例密钥。该命令会更新并部署 Worker 版本，执行前再次确认测试 Worker，不操作原 /feedback 服务。

5. 测试 `/health` 应为 200、activity_enabled=false、activity_config_ready=true、activity_ready=false；POST 应为 503，DELETE 配置仍就绪，确认代码已替换旧占位程序。查看根地址的 404 不作为健康测试。
6. 核对日志自动采集已关闭、无 Tail/Trace 记录请求体或标识；D1 写入权限与数据库指向符合目标。管理 Token 属于管理权限，不用于活动请求。
7. 仅在隔离测试环境把 METRICS_ENABLED 改为 true 并重新部署，使用虚构数据验证 POST/DELETE、同机去重、410、非法字段、超大请求与 429。部署后自测地址必须普通 HTTPS 客户端可访问，不能要求管理员 Access 登录或浏览器验证码。
8. Cron 配置为 `10 0 * * *`（北京时间 08:10）。先让一次任务成功，或通过维护者测试方法触发；核对 maintenance_state 的 summary、cleanup、downloads。
9. 返回测试地址、部署提交、DB/Secret/限流/Cron 的配置确认和不含真实编号的测试证据。当前已知测试地址为 `https://resume-usage-metrics-test.nebula-lab.workers.dev`。测试服务部署后 `/health` 已返回 200；部署传播期间不同请求可能暂时命中旧版本，测试须区分旧版本的 metrics_disabled 响应与新版本功能缺陷。网络连接失败不等于业务接口失败。

只读远端报表由维护者执行：

```sh
node scripts/report.mjs --remote --config wrangler.test.json
```

脚本要求明确选择 local/remote，remote 要求提供有效配置；不使用默认零 ID。输出不含逐设备标识。失败时非零退出且不输出报表，不回显 API Token、SQL 错误或请求内容。

### 定时任务的远端诊断与手动恢复

需要验证维护函数时，维护者可以在指定测试配置上运行官方远端开发模式；它使用远端执行环境和该配置的 D1，不是只在本地模拟。务必确认数据库目标，并仅使用虚构数据。

```sh
WRANGLER_SEND_METRICS=false npx wrangler dev --remote --test-scheduled --config wrangler.test.json --port 8789
```

另一个终端触发一次：

```sh
curl -i 'http://127.0.0.1:8789/__scheduled?cron=*+*+*+*+*'
```

随后查询 maintenance_state，要求 summary、cleanup、downloads 都成功。结束后关闭远端开发进程。这个手动验证不等于自动 Cron 已触发；自动调度另外按 last_attempt_at 的后续更新核验。测试用每分钟 Cron 结束后必须恢复每日配置，并停收/清理虚构活动。

线上曾发现 Workers 原生 fetch 不支持 redirect=error；下载采集现在使用 manual 并拒绝非 2xx（含重定向），不会把凭证跟随到其他站点。回归测试通过 Workerd 原生 fetch 及虚构 outbound 响应执行维护函数，避免仅用 Node mock 漏掉这种运行环境差异。

## 4. 事务、时间和数据完整性

- POST 在一个 D1 batch 事务内分配序号、检查撤销、UPSERT、建立采集起点。DELETE 在事务中登记撤销并删除明细，避免检查与写入之间的竞争。每安装当天只一行。
- 版本先按服务端观察时间排序，同毫秒按 D1 分配的序号排序；晚到但时间较旧的操作不能覆盖较新版本，来源仍合并。
- HMAC 使用规范化的小写 UUID 和 `installation:` 前缀。限流用 `rate:` 前缀对 IP 生成临时键，只交给提供方短期限流桶，不把 IP 或其限流键写入 D1。
- GitHub 请求固定官方仓库地址，不跟随重定向，单次请求及读 body 超时 5 秒、单页上限 5 MiB、每轮最多 24 次请求。公开仓库通常无需 Token；需要更高 GitHub API 配额时可另配只读 `GITHUB_TOKEN` Secret，不能用 Cloudflare Token 代替。
- Release 列表与每个 Release 的附件都分页至结束；API/分页/格式失败不保存任何本轮快照。达到请求预算也是失败，维护者评估数据规模和 Cloudflare 套餐后再调整，不能接受不完整页。
- 云端每日仅保存一份完整下载快照；重复 Cron 不覆盖，多个并发采集者只一个事务获准写入。保留空的成功观测来区分“仓库无附件”和“采集失败”。
- 复用第一阶段的 UTC、基线、计数异常和漏采区间算法。历史日增量不回填；渠道随 Release 标志，不强迫普通 tag 必为正式版。

## 5. 保留、汇总与恢复

- 活动明细保留今天及前 44 个 UTC 日；撤销元数据从删除时起最长 45 天，有效期内重复删除不续期。
- 不含安装标识的 metrics_daily 和下载快照保留今天及前 364 个 UTC 日。dataset_info 和安全任务状态保留采集起点/最近任务情况，不含设备身份。
- Cron 先汇总再清理；只汇总已结束的日。可以补齐最近 15 个结束日内的缺失汇总，其 30 日窗口仍完整保留。超过可恢复窗口留下缺失，不能用不完整数据造零。
- 已完成的历史汇总不在删除后重算；仍可查询的活跃明细会受删除影响。服务停收/断网期间采集到的样本可能为零，不代表没人使用。原始 ID 已失去时无法再追溯到个人汇总贡献。
- summary/cleanup/downloads 分别记录无身份 success/failed 和最近成功时间；下载故障不会阻止清理。整轮任一任务失败会令 Cron 标记失败；需要外部运维告警监控失败和超过一天未成功清理，告警接入由协作者负责。
- 禁止在 Tail/Worker 日志中记录原始 UUID、IP、UA、请求体、业务档案或 Secret。配置 observability=false；Cloudflare 常规 HTTP 元数据处理仍须披露。

备份恢复：先暂停活动写入，保留当前尚有效的撤销记录到维护者受控恢复流程，再恢复备份；合并撤销记录、重跑删除和保留清理、检查迁移与密钥一致后才恢复采集。不要在聊天、公开 issue 或普通日志中导出明细。备份留存按实际 D1 Time Travel 套餐另行披露，在线删除不等于所有副本即时消失。

第一版使用固定 HMAC 密钥。计划轮换时先停收至少 45 天，继续清理并处理旧密钥下的删除，确认旧明细/撤销记录过期后换新密钥；接受这段停收造成的观察缺口。需要无间断轮换时必须先另行实现并测试双密钥识别和迁移，不能直接换 key 造成窗口内双计或删除失败。

## 6. 回退与第二阶段验收

本轮部署与真实测试记录见 [test-acceptance.md](test-acceptance.md)。

回退优先把 METRICS_ENABLED=false，仍允许删除；部署回退到上一个兼容 schema 的版本。不要回退到无法处理现有 schema 的占位版本来代替停收。不自动撤销迁移或删数据库。

代码与本地验收：100 次去重、双来源、大小写 UUID、校验失败、字节上限、停收后删除、删除竞争/事务回滚、版本排序、滚动统计、保留边界、分页失败、并发快照、任务失败隔离、迁移和受控报表。

云端验收由已获授权的维护者完成：资源隔离、Secret/绑定/限流配置、可访问测试接口、实际 Cron、日志/备份/告警核对及虚构数据联调。测试结果与尚未完成的运行条件分别记录在验收文件中；测试部署不代表正式开始采集。
