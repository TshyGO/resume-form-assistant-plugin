# D14 首发支持与验收矩阵

本矩阵定义 D14 需要证明的范围。产品对外承诺应以最终签收报告为准。

## 必测范围

| 项 | 状态 | 验收要求 |
| --- | --- | --- |
| Windows x64 普通用户 | REQUIRED | 使用 D13 产出的 per-user 安装包；记录最低受支持 Windows build 和实测 build |
| Chrome 正式版 | REQUIRED | 实际插件 ZIP/发行渠道安装，使用生产 Native Messaging allowlist 和安装后的 host |
| Edge 正式版 | REQUIRED | 与 Chrome 分开执行连接和最小闭环；不能由 Chromium mock 代替 |
| 桌面卸载后的插件填写 | REQUIRED | J08 必须使用卸载后的真实浏览器扩展验证 |
| 备份/恢复、升级/卸载 | REQUIRED | 使用实际候选产物及隔离档案执行 J06/J07 |

## 条件必测

| 项 | 当前决定 | 放行规则 |
| --- | --- | --- |
| macOS Apple Silicon | `PENDING_OWNER` | 若列入首个正式桌面 MVP，则必须补实际 `.app`/`.dmg`、Chrome/Edge、备份恢复、升级卸载和 Gatekeeper/签名状态证据；CI 编译不算实机验收 |
| Windows 最低版本 | `PENDING_D13` | D13 文档给出最低版本后，在对应真实系统或可信 VM 运行 J01、J07、J08 |
| 系统提醒能力 | `PENDING_D10_EVIDENCE` | 按最终支持的 OS 能力执行 F13；任何降级必须先同步产品承诺和支持文档 |
| 商店渠道 | `PENDING_RELEASE_CHANNEL` | 若纳入首发，补实际商店 ID、权限/隐私材料、设置迁移和生产 allowlist 验收 |
| 签名/公证 | `PENDING_D13` | 如无签名，产物、安装体验和发布说明必须如实一致；不得把本地开发签名写成正式签名 |

上述 `PENDING_*` 不阻止 T1/T2/T3 开发，但在最终报告中仍未决时阻止正式发布。负责人决定需填写 issue/PR 链接、决定人和日期。

## 明确不在 D14 默认范围

- Linux、Safari、Firefox。
- 邮箱自动同步、云同步、跨设备同步。
- MSI 或额外安装器格式，除非 D13 的批准范围改变。
- 静默安装、静默升级或浏览器扩展静默安装。
- 真实恶意软件样本、真实个人简历或真实求职邮件。

## 版本与环境记录

每轮必须记录：

- Windows edition/build、体系结构、账户类型和系统区域/时区。
- Chrome、Edge、WebView2 完整版本。
- 桌面版本、插件版本、`protocolVersion`、扩展 ID、插件来源。
- 安装包/ZIP 文件名、字节数、SHA-256、下载地址、被测源码 commit。
- 签名状态、实际安装路径、Native Messaging manifest 和运行中的 host 路径。
