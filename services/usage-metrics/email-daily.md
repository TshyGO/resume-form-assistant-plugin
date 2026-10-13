# 测试统计邮件日报（#280）

本PR交付配置保存、正文生成、完整性检查、发送状态管理，不部署、不发测试邮件、不启用正式日报。依赖#259的Worker代码；当前基于Worker阶段分支，合并前应在#270进入main后整理基线。

## 配置

同事已配置测试Worker resume-usage-metrics-test 的 METRICS_EMAIL。仓库wrangler.test.example.json及本地实际忽略配置均保存send_email绑定，使用已验证发件人及两位指定收件人，并在忽略的实际部署配置中限制邮件绑定地址；仓库示例不含个人邮箱，下一次部署可保留绑定。无需额外SMTP密码/第三方邮件Key。不是通过此PR证明域名验证、权限或实际投递已成功。

DAILY_EMAIL_FROM、DAILY_EMAIL_TO_0、DAILY_EMAIL_TO_1在实际环境填写；为空时不发送。DAILY_EMAIL_ENABLED默认false，独立于客户端METRICS_ENABLED（后者关闭不妨碍查询已有数据）。测试配置新增Cron `30 0 * * *`，即北京时间每日08:30；原维护任务 `10 0 * * *` 保留。本地wrangler.json不配置Cron。新Cron按controller.cron分流，不额外运行维护任务。邮件绑定和收件人固定，新增收件人需代码/配置评审；无公开发信接口。

## 日报

使用统计报告日为刚结束的UTC日（北京时间08:30发送），DAU/WAU/MAU与现有liveStatistics一致；系统/来源为报告日，来源可重叠；版本为近30天最后观察版本。邮件只含汇总和公共Release文件名，不含设备UUID/哈希/IP/简历/密钥。标题固定标注测试环境。

每轮检查summary/cleanup/downloads状态及成功时间在当日00:10 UTC之后、不晚于查询时间；最新下载观测须在本轮时间范围，downloadReport校验实际行数。报告日已开始收集时须有本轮生成的汇总；尚未开始收集不能假报0。状态陈旧、维护失败、汇总缺失时生成异常简报，不展示可能过时数字。数据库或快照完整性查询失败返回report_failed，不发送假正常报告。

下载明细逐资产保留existing status/increment与观测起止时间：首快照、缺口、计数下降等increment为空时显示不可计算，不转换为0。UTC样本日期与下载观测区间明确区分。关闭重开/离线删除未获确认可能生成多个样本，不代表人数。

## 去重及失败

先应用0003_email_delivery.sql，再启用代码。每个UTC报告日、收件人序号以D1唯一键INSERT OR IGNORE原子占位，并发/重复执行只一个调用拥有发送资格；不存邮箱地址、正文或设备标识。两个收件人独立处理，允许一方accepted、另一方unknown。

pending表示占位后尚未调用外部服务；调用前先落库unknown，发送返回成功后才变accepted。accepted只表示邮件服务接受，不能声称收件箱已到达。10秒等待超时或异常保留unknown、不自动重试；Promise超时不取消供应商投递，不据此重发。pending也不自动重放，崩溃时采取少发而非重复发的保守策略。failed为预留运维状态，当前不会自动标记供应商异常为确定失败。

记录不自动删除，避免删除占位后旧日报被重发；未来增加保留清理须配合历史发送门禁。可只读查询：

```sql
SELECT report_date, recipient_slot, status, updated_at, error_code
FROM email_delivery ORDER BY report_date DESC, recipient_slot;
```

slot0/1依次对应配置的两个邮箱。出现pending/unknown先人工核对Cloudflare投递记录及收件箱；不直接删除占位。查询失败发生在占位前，因此重复触发可重新查询但不会重复已保留的发送。发送后落库失败保留unknown。原维护结果与发信失败独立。

## 验证和上线余项

测试使用实际Miniflare/D1和合成邮件绑定，不调用真实send_email：覆盖默认关闭、缺失配置、UTC日期、陈旧状态、汇总缺失、快照缺行、并发/重复、双收件人部分成功、超时、崩溃占位、查询失败与Cron分流。

后续：评审合并、测试环境应用迁移/部署（确认仍默认关闭）、指定邮箱预览/测试投递、查收件箱与垃圾箱、确认原生绑定接口兼容、开启发送后验证真实08:30 Cron。正式环境需另配资源和发件身份，不复用测试标题与默认配置。当前未部署且没有实际邮件。
