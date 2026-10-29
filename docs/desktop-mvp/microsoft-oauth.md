# 微软邮箱授权（#354）

## 当前范围和交付状态

本实现依赖 #353 / PR #362 的来源账号模型。提供微软官方登录、系统凭据保存、重启读取、自动刷新、重新授权、取消和本机断开。#355 的 Graph 邮件扫描、增量位置、候选下载尚未接入；界面明确显示当前版本尚未启用微软邮箱自动收取。现有 IMAP 扫描、确认入档流程保持使用原入口。

截至 2026-10-29，维护者尚未注册 Entra 应用，没有真实微软账号验收。下述自动化测试使用本机 HTTP 服务和内存凭据库，不能证明个人账号或学校租户已经可用；本任务不能据此关闭真实验收要求。

## 维护者注册与发布配置

普通用户只点击“使用微软账号连接”，不需要创建开发者应用。

1. 在 Microsoft Entra 管理中心的“应用注册”创建项目维护的应用。支持账号类型选择“任何组织目录中的账号及个人 Microsoft 账号”，对应 `signInAudience: AzureADandPersonalMicrosoftAccount`。维护应用名称、支持联系人、隐私政策及发布者信息；机构是否要求已验证发布者取决于其策略。
2. 配置为“移动和桌面应用”公共客户端。注册**完整且精确**的本机回调：

   ```text
   http://127.0.0.1:53682/microsoft/callback
   ```

   不要配置成 Web/SPA 回调。若门户界面拒绝添加 HTTP IP 回环地址，按照微软文档在应用清单中维护公共客户端的回调（Microsoft Graph 格式为 `publicClient.redirectUris`）。不要依赖任意端口匹配：当前实现固定监听 IPv4 127.0.0.1:53682，端口占用会明确失败，不会改监听公网或退回不受保护的回调。
3. 使用委托权限 `Mail.Read` 和 `User.Read`，登录请求同时包含 `offline_access`。`User.Read` 仅用于 `/me?$select=id,mail,userPrincipalName` 获取稳定账号标识和显示邮箱；不解析未验证的 ID token 或 access token 声明。没有发信、修改邮件、应用级全邮箱权限，也没有 client secret。不要向本项目提供 secret。
4. 复制公开的 Application (client) ID。仓库 Actions 变量设置 `RESUME_MICROSOFT_CLIENT_ID`；安装包工作流将此变量交给 Rust 编译。开发时在启动 Tauri 的环境设置同名变量，例如：

   ```sh
   RESUME_MICROSOFT_CLIENT_ID='<应用的公开 GUID>' npm run desktop:dev
   ```

   此值在**构建时**写入程序；给已经构建的程序追加运行时环境变量不会启用登录。更改变量需重新构建。没有配置、空值、非 GUID 或全零 GUID 时，点击连接会说明该版本未配置，并提供手动导入选项；不会让用户自行注册应用，也不会使用其他产品的 Client ID。
5. 使用下表的个人账号及目标组织完成实测，再宣称支持或发布为可用。不要将 Client ID 已配置等同于微软已同意访问。

仅使用微软全球云的 `login.microsoftonline.com` 与 `graph.microsoft.com`；不承诺世纪互联、政府云、企业私有部署或所有学校账号。学校 MX 指向 `*.mail.protection.outlook.com` 只提示选择微软入口，不证明用户拥有 Exchange Online 邮箱或组织已允许第三方应用。

## 登录与安全边界

- 系统浏览器 Authorization Code + PKCE S256。每次登录重新生成随机 state 和 verifier；先绑定本机端口，再打开浏览器。回调校验 HTTP 方法、Host、路径、单一 state、单一 code/error。错误或旧 state 不能消费当前尝试；3 分钟内没有有效回调会超时。
- 回调页面没有脚本或外部资源，不回显授权码、state、邮箱或微软错误原文；设置 no-store 和 no-referrer。收到回调只说明返回桌面完成连接，不提前宣称凭据已保存。
- Rust 通过 HTTPS 换取令牌，再读取 `/me` 的身份信息。显示邮箱可以变化；稳定 Graph ID 决定账号身份。相同显示地址、不同稳定身份保持独立；“重新授权”强制绑定原本机账号，选错账号会拒绝替换。
- HTTP 不跟随重定向；每次请求 30 秒超时，响应上限 128 KiB。微软错误只映射为固定中文错误，不把 error_description、响应体、请求 URL 或令牌放进日志或 IPC。
- access/refresh token 作为一个版本化凭据逻辑单元，全部存于 macOS Keychain / Windows Credential Manager。考虑 Windows 单条密码的 UTF-16 容量限制，内容编码后分成每条最多 1000 ASCII 字符，根条目保存代际指针、块数和摘要。新代写完才切换活动指针；旧代清理失败时保留引用供断开重试。数据库、档案、备份、诊断与 WebView 不保存令牌。
- 整个应用的登录、刷新、断开共用操作锁。刷新先读取当前活动代，再交换并保存轮换后的 refresh token；其他并发刷新会读到新令牌。若服务端没有轮换 refresh token，保留此前值。取消与最终提交互斥，成功提交之后的取消不会错误报告“未保存”。
- 启动及后续周期检查恢复凭据，访问令牌剩余不足 120 秒时刷新，授权有效时不会重复交换。后台从不打开浏览器。永久授权错误、组织拒绝或凭据错误暂停；网络故障沿用本机退避和失败暂停。授权检查不更新“最近成功检查邮件”的时间。
- 断开先暂停账号，再清除活动/待清理凭据代，最后删除本机账号及其级联候选、忽略记录和同步位置。凭据清除失败保留暂停账号以便重试，不误报断开成功。正式证据保留。本机断开不撤销微软侧授权；界面提示用户到微软账号应用授权管理另行撤销。

## 自动化与人工验收

自动化覆盖：PKCE 规范向量、配置缺失、回调 state/Host/路径/重复参数、授权拒绝与组织策略、取消及超时、真实本机 HTTP 授权码交换、仅读取身份而不取邮件、凭据失败不注册账号、别名与重新授权身份隔离、重启重读凭据、轮换和不轮换刷新、并发刷新只交换一次、失效暂停、安全错误、原生容量限制下的分块/回滚/断开，以及断开保留入档证据和删除失败保留暂停账号。界面测试覆盖独立微软入口、取消、配置缺失、组织拒绝、学校提示、重新授权账号绑定与断开说明。

| 场景 | 要求 | 当前状态 |
| --- | --- | --- |
| 个人 Outlook/Hotmail/Live/MSN | 至少一个真实账号连接、关闭并重启恢复、自然到期或受控过期后刷新、断开 | 待注册应用后实测 |
| macOS 系统凭据库 | 真实 Keychain 持久化、锁定/拒绝、断开后的代际条目清理 | 待实测 |
| Windows 系统凭据库 | 实际令牌长度、Credential Manager 持久化、轮换、断开、拒绝写入 | 待实测 |
| 学校/机构 | 指定租户、实际许可、同意策略/条件访问阻止的真实行为 | 未验证，不宣称可用 |
| 发布包 | Client ID、回调、请求权限、取消、断开与配置缺失文案 | 代码就绪，待真实包验收 |
| Graph 招聘邮件自动拉取 | 元数据、待确认、确认后 MIME、限流/增量恢复 | #355 范围，尚未实现 |

本轮本地验证：微软相关后端 17 项、邮箱命令 34 项、邮箱底层 54 项、邮箱界面 66 项、TypeScript 单元测试 239 项通过；类型检查和前端构建通过。后端计数有交叉（断开测试同时匹配微软与邮箱命令），不能直接相加。Rust 使用 macOS 15.4 SDK；Windows 与真实凭据库尚未验收。

人工验收时记录应用版本/提交、操作系统、账号类型和目标租户、日期、结果，不记录令牌、授权码或账号密码。系统凭据库拒绝读写或删除时必须如实标记失败；不能把内存测试替代真实系统凭据验收。

## 官方依据

- [桌面应用注册](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration)
- [授权码与 PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [回调限制与 IP 回环地址](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)
- [Microsoft Graph 应用清单](https://learn.microsoft.com/en-us/entra/identity-platform/reference-microsoft-graph-app-manifest)
- [Graph 委托权限](https://learn.microsoft.com/en-us/graph/permissions-reference)
- [获取当前用户的最小权限及字段选择](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0)
