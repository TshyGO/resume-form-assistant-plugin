# 正式使用统计服务

正式环境使用独立 Worker `resume-usage-metrics` 和独立 D1 `resume-usage-metrics`，不得复用测试数据库、HMAC Key 或限流命名空间。公开活动地址为 `https://resume-usage-metrics.nebula-lab.workers.dev/v1/activity`。

## 安全上线顺序

1. 从 `wrangler.production.example.json` 生成被忽略的 `wrangler.production.json`，填写正式资源 ID 和已验证邮件地址；`METRICS_ENABLED`、`DAILY_EMAIL_ENABLED` 均保持 `false`。
2. 应用全部 D1 迁移；配置独立随机 `INSTALLATION_HMAC_KEY` 和只读公开 Release 的 `GITHUB_TOKEN` Secret。
3. 部署经审核代码，检查 health 为配置就绪但活动关闭；手动维护、虚构活动/删除和邮件预览只在明确验收窗口执行。
4. 先开启 Worker 接收，再发布带正式 endpoint 的受控桌面构建。回退时先将 `METRICS_ENABLED=false`，无需等待客户端更新。
5. 报表必须标注“启用统计的活跃安装样本”；关闭/重新开启可能生成新编号，不能解释为唯一人数。

## 构建门禁

桌面端只有非 debug/test 构建，且同时具有 `RESUME_USAGE_METRICS_READY=1` 与合法 HTTPS endpoint 时才可发送。CI 环境还必须显式设置 `RESUME_USAGE_METRICS_RELEASE_BUILD=1`；普通 CI 不具备该值。发布工作流把这三个值限制在安装包构建步骤。

## 停收、恢复与核验

- 紧急停收：将正式 Worker `METRICS_ENABLED=false` 并部署配置；DELETE 仍可用。
- 邮件停发：单独将 `DAILY_EMAIL_ENABLED=false`。
- 回退 Worker：在 Cloudflare Deployments 选择前一已知正常版本，同时保持活动关闭，验证 health 后再决定开启。
- D1 的 Time Travel 恢复窗口按账户方案为 7 天或 30 天；对外按“最长 30 天”披露。恢复前先关闭活动。能够导出时，优先把逻辑备份导入新的验证数据库；必须使用 Time Travel 原地恢复时，先记录当前书签并导出当前库中仍有效的 `revoked_installations`。
- 所选恢复时间点之后发生的 DELETE 不在旧快照内。切换恢复库或重新开放流量前，必须从当前库导出或独立加密保存的删除增量中补入这些仍有效的撤销哈希；该文件只允许维护者访问，仍不得保存原始安装编号。
- 恢复后执行全部迁移与 45/365 天清理，再用一个在备份时间点之后删除的虚构编号验证 POST 返回 410。若无法证明删除增量完整，保持活动关闭，清空恢复出的带标识活动明细并轮换 HMAC，不能带着可能复活的明细直接恢复收集。证据记录在 #259。

## 正式环境验收记录

- Worker：`resume-usage-metrics`，公开 health 与活动地址使用 `resume-usage-metrics.nebula-lab.workers.dev`。
- D1：`resume-usage-metrics`，与测试库隔离；迁移 `0001` 至 `0003` 已应用。
- Cron：北京时间 08:10 执行汇总、清理与 GitHub 下载快照；08:30 在日报开关开启后向两个已验证邮箱发送日报。
- 初始部署保持活动与日报关闭。虚构 Windows 活动 POST、DELETE、HMAC 去重、D1 清理均已验证；测试活动和撤销记录随后清除。
- 手动 08:10 维护验证三项任务均成功，正式库生成 2026-10-14 的首个公开下载快照，共 32 个附件；未发送邮件。
- 逻辑备份已导出并恢复到临时 D1：10 张表、32 条下载明细、1 次快照和 3 项维护状态一致，活动与撤销记录均为 0；验证后删除临时库和本机导出。
- Worker 已从当前版本回退到前一个健康版本并恢复到当前版本；两次 health 均保持“配置就绪、活动关闭”。
