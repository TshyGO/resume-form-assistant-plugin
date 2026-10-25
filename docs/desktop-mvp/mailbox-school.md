# #332 更多邮箱及学校邮箱接入

基于 #331 的只读筛选与待确认流程扩展。本分支来自 `feat/331-mailbox-import` 的 `7a5c463`；另一个 chat 的后续 #331 修复仍独立，不覆盖其工作目录。

实现已可本地审查；每家真实账号及至少一所学校的真实登录尚未验收，不能关闭 #332 或宣称所有邮箱已实测连通。

## 用户流程

1. 招聘通知 → 连接邮箱 / 设置 → 邮箱，输入地址。
2. 常见邮箱与已知学校直接填写配置；未知域名在离开地址框时尝试 DNS，总预算 3 秒。也可点击重新识别。DNS 返回期间允许手填，迟到结果不会覆盖另一邮箱或手动修改。
3. 核对或修改服务器域名、端口、TLS / STARTTLS、登录账号；默认完整地址，可以改为学校要求的短用户名。网易企业邮等可勾选发送客户端标识。不支持明文或跳过证书验证。
4. 根据对应教程填写授权码 / 应用专用密码 / 学校要求的密码，点击测试连接并保存。失败不保存。成功后复用 #331 最近 30 天、运行期间增量检查、先信头待确认、确认才下载原文的流程。
5. 连不上可点“改用导入邮件文件”，进入招聘通知页导入 .eml；学校可能没有开放 IMAP、要求校园网或毕业后回收邮箱，属于尽量支持。

## 识别与维护

- 内置精确域名预设：QQ / foxmail、163、126、Gmail / googlemail、iCloud / me / mac、新浪（com / cn 及 vip）、搜狐、阿里个人邮箱、139。
- 学校预设首批收录清华 `mails.tsinghua.edu.cn`（学生）与 `mail.tsinghua.edu.cn`（教工），分别使用同名主机、993/TLS，要求客户端专用密码。配置来自学校文档，尚不代表真实账号连通验收。
- 未命中时，以系统 DNS 配置查完整邮箱域名的 `_imaps._tcp` / `_imap._tcp` SRV；按优先级与权重选择，显式禁用不回退到同一服务。查询 MX 只用于腾讯 / 网易企业邮的服务商线索，IMAP 地址来自已知映射，绝不直接使用投递服务器。学校自建 Coremail 不根据名称猜主机。
- 查不到或超时展开手动配置；不抓网页、不调用 AI。查询只使用域名，不包含完整邮箱地址、登录账号、凭据或邮件。
- DNS 识别是建议，服务器始终可见、可改，点击测试连接才登录。已保存配置仅在本机，凭据只在系统凭据库。
- 已有账号通过“修改连接 / 更新凭据”载入真实保存配置；同配置更新凭据保留游标，修改连接配置原子清除该账号的候选 / 忽略 / 游标，避免旧 UID 指向另一个邮箱。正式入档邮件不受影响。
- `mailboxes.sqlite` 增加可空 connection JSON 列，旧账号在读取时沿用原先预设；档案 schema 和备份格式不变。
- Outlook / Hotmail / Live / MSN 的个人域名明确提示微软授权另做，不用应用密码反复尝试。

## 配置依据（2026-10-25 核对）

| 邮箱 | 预设 IMAP | 官方配置 / 凭据资料 |
| --- | --- | --- |
| Gmail | imap.gmail.com:993 TLS | [Google IMAP](https://developers.google.com/workspace/gmail/imap/imap-smtp)、[应用密码](https://support.google.com/mail/answer/185833?hl=zh-Hans) |
| iCloud | imap.mail.me.com:993 TLS | [Apple 服务器设置](https://support.apple.com/zh-cn/102525)、[App 专用密码](https://support.apple.com/zh-cn/102654) |
| 新浪 | 按域名分别 imap.sina.com / imap.sina.cn / imap.vip.sina.com / imap.vip.sina.cn:993 TLS | [服务器参数](https://help.sina.com.cn/comquestiondetail/view/160/)、[授权码](https://help.sina.com.cn/comquestiondetail/view/1566/) |
| 搜狐 | imap.sohu.com:993 TLS | [邮箱入口](https://mail.sohu.com/)、[Lexmark 客户端独立密码说明](https://publications.lexmark.com/publications/lexmark_hardware/MB2442_MB2546_MX421_MX521_MX522_XM1242_XM1246/UG/html/en/configuring-smtp-server-for-e-mail-topic.html)；IMAP 主机待真实账号核对 |
| 阿里个人邮箱 | imap.aliyun.com:993 TLS | [阿里个人邮箱参数](https://mailhelp.aliyun.com/freemail/detail.htm?knoId=20119715)；企业邮箱按管理员教程手填 |
| 139 | imap.139.com:993 TLS | [服务器参数](https://help.mail.10086.cn/statichtml/1/Content/858.html)、[授权设置](https://help.mail.10086.cn/statichtml/1/Content/3837.html) |
| 清华 | mails.tsinghua.edu.cn / mail.tsinghua.edu.cn:993 TLS | [学校安全提示及客户端专用密码](https://mails.tsinghua.edu.cn/coremail/help/notice.html)、[客户端设置](https://mail.tsinghua.edu.cn/coremail/help/clientoption.jsp?locale=zh_CN) |
| DNS 发现 | SRV 定位访问服务，MX 仅服务商线索 | [RFC 6186](https://www.rfc-editor.org/rfc/rfc6186.html)、[华为云企业邮箱 DNS 示例](https://support.huaweicloud.com/dns_faq/zh-cn_topic_0136779269.html) |

## 验证与人工审查

本机按 [开发期 SOP](../dev-quickstart.md)运行真实 `tauri dev`。独立标识 `com.resumepro.dev.issue332`，端口 1422，数据根目录 `local-dev-332/data`，不与 #331 共用数据。此项是桌面邮箱能力，不需要加载插件或改动全局 Native Messaging 注册。

本轮验证（macOS）：邮箱模块 30 项、宿主邮箱边界 11 项、完整前端界面 357 项及纯逻辑 239 项通过，类型检查和生产构建通过。新增覆盖精确域名、学校学生 / 教工分离、MX 标签边界、旧账号迁移、手动配置持久化、配置变化清空旧定位、凭据只进系统库、迟到查询不覆盖表单、修改账号载入真实配置以及 STARTTLS 被拒时不发送登录。首次完整界面测试因跨工作目录依赖符号链接导致 PDF worker 加载失败；改为独立依赖目录后完整重跑通过，无需改产品 PDF 代码。

布局用本地前端预览检查；该预览不提供 Tauri IPC，不能当作真实登录验收。真实 `tauri dev` 启动日志已确认本轮隔离 host socket 正常监听。窗口与真实账号的最终人工审查由用户继续。

验证记录和启动脚本见工作区 `local-dev-332/README.md`。自动测试不替代真实账号验证，发布前需每家至少一个账号及至少一所学校完整走查连接、新信、只读、忽略、重复、重启增量、凭据失效与断网恢复。真实凭据只由用户在本机界面输入，不写入测试记录。
