# T7 首发教程、限制披露与最终签收

T7 只在 T1–T6、D08/D11/D13 签收和真实环境验收全部通过后完成。本文提前固定首发材料与签收顺序，不把模板或本地构建写成正式 Release。

## 用户教程入口

- 桌面构建、Windows/macOS 安装、哈希核对、浏览器连接、升级、回滚、卸载与数据位置：[install-and-update.md](../install-and-update.md)。
- 备份内容、排除项、敏感数据和恢复身份规则：[data-privacy.md](../data-privacy.md)。
- 插件安装、AI 配置、简历导入与日常填写：仓库根目录 [README.md](../../../README.md)。
- 首发支持平台与条件必测项目：[support-matrix.md](support-matrix.md)。

正式 Release 说明必须直接链接这些文档，不能复制一份随后失去同步的简化教程。

## 发布前必须完成

1. 确认 `support-matrix.md` 中所有 `PENDING_*` 已有具名决定、日期和 issue/证据链接。
2. 从候选下载位置重新取得 EXE/ZIP，运行 T6 门禁；不得使用构建目录里的原文件代替下载副本。
3. 确认 Chrome、Edge 两份报告的 J01–J08、F01–F13 和 T5 16 项全部通过、证据可访问、无阻断缺陷。
4. 确认 D08/D11/D13 的签收人与验收证据完整，并与浏览器报告中的依赖记录一致。
5. 确认最终发布 commit、版本、协议、权限、文档和候选字节一致；代码或产物变化时按影响重验。
6. 将本次非阻断限制填入 [known-limitations-template.md](known-limitations-template.md)，每条包含影响、规避、负责人和后续 issue。
7. 从 [release-record-template.json](release-record-template.json) 生成不可覆盖的本次发行记录，并由具名负责人批准。

## 发布后复验

1. 从正式 Release 下载 EXE、ZIP 和校验文件。
2. 比较文件名、长度与 SHA-256，重新执行 T6 门禁。
3. 在干净普通 Windows 账户完成最小安装、Chrome/Edge 连接和一次合成填写；实际运行文件必须来自安装目录。
4. 核对 Release 页面版本、协议、签名状态、支持范围、限制和教程链接。
5. 将下载地址、哈希、复验时间、机器环境和结果写入发行记录；失败时停止推广并创建阻断缺陷。

## 用户反馈模板

问题反馈使用 [feedback-template.md](feedback-template.md)。公开反馈不得附 API Key、真实简历、邮件正文、Cookie、带 token 的 URL、完整档案库或未打码截图。需要诊断时只上传产品允许导出的脱敏信息。

## T7 完成条件

- 正式 Release 与发行记录存在，Release 中的字节经发布后重新下载复验；
- 安装/升级/备份恢复教程、支持矩阵和非阻断限制与实际产物一致；
- 用户反馈入口可用且包含隐私提醒和必要版本字段；
- 最终签收人、时间、决定及零阻断缺陷写入发行记录；
- #27/#39/#128 回填同一组证据链接后，才可将 D14 标为完成。
