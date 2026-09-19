# D14 首发验收工作区

本目录实现 [D14 实施 spec](../../superpowers/specs/2026-09-17-d14-release-acceptance-spec.md) 的验收输入与自动化映射。T1 固定范围、数据和证据格式；T2 使用同一数据集补业务闭环回归；T3 固定故障矩阵；T4 提供候选字节与真实浏览器验收工具。这里不把自动化结果冒充 T4/T5 的实机验收，也不预先修改报告模板状态。

## 目录

| 文件 | 用途 |
| --- | --- |
| [support-matrix.md](support-matrix.md) | 首发支持范围、必测环境和仍待负责人决定的项目 |
| [cases.md](cases.md) | J01–J08、F01–F13 的动作、断言、测试层与证据要求 |
| [existing-coverage.md](existing-coverage.md) | 已有自动化/脚本能证明什么，以及仍缺什么 |
| [t2-business-regression.md](t2-business-regression.md) | T2 新增的跨层业务回归、精确测试名和执行命令 |
| [t3-fault-matrix.md](t3-fault-matrix.md) | T3 的故障防线、自动化范围和实机限制 |
| [t3-fault-matrix.json](t3-fault-matrix.json) | F01–F13 的机器可校验精确测试映射与剩余证据 |
| [t4-windows-browser.md](t4-windows-browser.md) | T4 候选产物、生产注册、Chrome/Edge 烟测与 J01–J08 实机清单 |
| [fixtures/d14-v1/](fixtures/d14-v1/) | 可重复生成的合成岗位、简历、通知、附件和模型返回 |
| [report-template.json](report-template.json) | 单次候选验收报告模板；所有 case 初始为 `NOT_RUN` |
| [dependencies.json](dependencies.json) | D08、D11、D13 的验收签收表 |
| [candidate-artifacts.json](candidate-artifacts.json) | 被测桌面安装包和插件 ZIP 的身份及哈希表 |

## 使用顺序

1. 执行 `node docs/desktop-mvp/acceptance/fixtures/d14-v1/generate.mjs --check`，确认提交的生成物没有漂移。
2. 为一次候选验收复制 `report-template.json` 到 `runs/<run-id>/report.json`；大截图、录像和安装包保存在制品存储，只在报告里链接。
3. 填入本次真正安装的候选文件及 SHA-256，并同步 `candidate-artifacts.json`。从候选下载位置重新下载后再算一次，不能只使用 CI 显示的名称。
4. 按 [cases.md](cases.md) 执行。只有实际断言和证据齐全时才能把 `NOT_RUN` 改为 `PASS`。
5. 在 [dependencies.json](dependencies.json) 中记录每个硬依赖的实现 PR、验收证据与具名签收。GitHub issue 已关闭不能替代签收。

T4 开始前先按 [t4-windows-browser.md](t4-windows-browser.md) 用候选 EXE/ZIP 创建 Chrome、Edge 两份不可覆盖的运行报告。仓库源码或开发注册结果不能代替候选安装证据。

## 状态语义

case 只允许以下状态：

- `PASS`：本报告指定的环境、源码和产物已执行并满足断言，且有证据。
- `FAIL`：已执行但至少一个断言失败。
- `BLOCKED`：因环境、依赖或缺陷不能完成；必测项不能据此放行。
- `NOT_RUN`：尚未执行，也是模板的唯一初始状态。
- `NOT_APPLICABLE`：已有批准的范围决定，并在 `scopeDecision` 中给出链接。

T1 的所有报告项必须保持 `NOT_RUN`。自动化测试通过后，也要在具体运行报告中引用测试运行，不能回填模板为 `PASS`。

## 证据规则

- 报告必须写明 `fixtureVersion=d14-v1`、被测源码 commit、桌面/插件版本、`protocolVersion`、操作系统与浏览器完整版本。
- 界面截图只能证明界面当时显示的内容；数据一致性还要给出数据库、备份清单、附件哈希或测试断言。
- 动态 UUID 在报告中用夹具逻辑名（如 `application-a`）映射；不得把另一轮运行的 UUID 写成固定期望。
- 故障注入必须记录发生在 mock、进程、浏览器或真实 OS 哪一层。较低层证据不能冒充实机安装证据。
- 不提交真实简历、邮件、密钥、浏览器 Profile、档案库、安装包或含个人信息的日志。

## 数据与安全

`d14-v1` 仅使用虚构身份、`.test` 保留域名和可搜索的 `D14_SYNTHETIC_*` 标记。所谓“恶意附件”是无执行能力的文本夹具，用于检查文件名、正文提示注入和路径处理；它不是恶意软件样本。

验收运行应使用隔离的普通用户账户或可回滚 VM、临时浏览器 Profile 和专用数据目录。任何注册或清理操作都应根据本次运行生成的回执定位目标。

## T1 完成定义

- J01–J08、F01–F13 均在 case 目录、报告模板和生成校验中出现且只出现一次。
- `d14-v1` 能由固定基准时间与固定 ID 重建，生成两次得到相同字节。
- 合成数据包含同公司两个岗位、另一公司岗位、模板 v1/v2、各类通知、歧义、历史补录、提示注入和错误模型返回。
- 支持范围明确区分必测、条件必测和不在范围；未定项会阻断正式放行。
- 硬依赖和候选产物表存在，但没有虚构签收或产物。
- 已有测试被登记为“已有/部分覆盖”，实机、安装包和真实 OS 缺口仍清楚可见。
