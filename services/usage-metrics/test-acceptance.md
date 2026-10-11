# Cloudflare 测试环境验收（2026-10-11）

目标：隔离测试 Worker `resume-usage-metrics-test` 和其 `DB`。用户明确授权使用共享管理 Token 从本机配置及部署。初始源代码版本 `e9f524b`，随后补充本文所述重定向修复及 Workerd 原生网络回归测试；main 未改动，PR #268 保持独立。

测试入口：[health](https://resume-usage-metrics-test.nebula-lab.workers.dev/health)。配置 ID 和 Secret 只留在受限临时文件/已忽略本机配置中，不写入仓库或公开记录。HMAC 使用新生成的随机 32 字节密钥，与管理 Token 独立。

## 已验证

- 管理 Token 可读取目标测试 Worker 和指定 D1；现有绑定 `DB` 指向正确数据库。
- 原测试库只有平台内部表；已成功应用 `0001_metrics.sql`，未修改其他数据库或 /feedback 服务。
- Worker 已替换占位版本，绑定 DB、HMAC Secret、原生限流器和 METRICS_ENABLED。
- 真实 HTTPS health 返回 200。停收时 POST 返回 503。
- 同一虚构安装 20 次 POST，只生成一条每日记录，大小写 UUID 统一、两个来源都为真，最后观察版本更新成功。
- 数据库只存安装 HMAC，未存原始 UUID。
- 非法字段/平台/UUID/JSON 返回 400；513 字节请求返回 413；错误 Content-Type 返回 415。
- DELETE 返回 204，重复 DELETE 成功，旧编号晚到 POST 返回 410。
- 直接在测试库放入虚构历史行进行窗口检查，得到 DAU=2、WAU=3、MAU=4；这些数字仅用于测试。
- 原生限流器实际返回 429。
- 维护者只读远端 CLI 成功查询相同的汇总数字，不暴露安装哈希。

## Cron 与最终状态

- 已通过官方远端开发模式手动触发 scheduled：summary、cleanup、downloads 全部成功，真实下载快照包含 32 个附件。
- 实际远端 D1 验证了过期活动和撤销记录删除、45 天内边界记录保留及闭合日汇总。
- 修复了线上发现的运行环境差异：Workers fetch 不支持 redirect=error，导致请求尚未发出就 TypeError。现在改为 manual，并拒绝非 2xx（包括重定向）。新增 2 项回归，当前 18 项 Worker/D1 测试全部通过；其中一项使用 Workerd 原生 fetch 和虚构 outbound 响应执行完整维护函数。
- 测试期间临时使用每分钟 Cron；两次有界观察窗口内都没有确认自动执行。手动维护成功之后约 17 分钟内 last_attempt_at 未再次更新，GraphQL 指标也只显示已知调用，不能声明自动 Cron 已通过。
- 最终已恢复 `10 0 * * *`（每天北京时间 08:10），采集开关 false。health=200、暂停时 POST=503。
- 活动明细、撤销夹具及测试产生的数值汇总均已清理；仅保留真实公开 GitHub 下载快照和任务状态。远端只读报表再次成功，DAU/WAU/MAU 均为 0，下载行 32。
- 最终 Cloudflare 版本为 `fdc59a22-7604-4078-8560-494232e1630f`，检查时间为 2026-10-11 21:36（北京时间）。

仍待核验：下一次每日 Cron 后，运行维护者报表确认三个任务的 last_attempt_at/last_success_at 均更新。若没有更新，在 Cloudflare 控制台检查 Cron Events 和调度状态；数据库绑定、scheduled 入口和手动维护已验证。无需开启活动采集就能验证 Cron 和下载统计。自动 Cron 验收保持未勾选。

## 运行限制与后续

- 网络测试期间出现 TLS/连接重置/超时，部署传播期间部分请求短暂返回旧版本的 metrics_disabled。测试客户端做有界重试；客户端产品的“不重试活动上报”规则没有改变。
- Worker 业务代码不输出请求体/编号；部署关闭 observability，API 读取结果为 observability=null、logpush=false、无 tail consumers。Cloudflare 基础设施仍会处理常规 HTTP 元数据。
- 尚未接入桌面/插件或生产环境，没有真实用户数据采集。测试配置只涉及指定 Worker/D1，未修改 /feedback 服务。
- 告警渠道、费用上限操作、实际备份恢复演练仍为正式上线前的运维任务；不能将测试部署视为全部生产条件完成。
