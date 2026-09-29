# 浏览器扩展架构与调试

[返回项目首页](../README.md) · [开发快速开始](dev-quickstart.md) · [桌面端开发说明](../desktop/README.md)

本页承接原首页的扩展实现细节。用户操作、限制与故障排查见[使用指南](user-guide.md)。D05、D07、D08 等编号用于关联历史设计与验收文档。

## 模块导航

```text
manifest.json          扩展清单与固定公钥
popup.html/css/js      状态页、连接状态、旧数据迁移和取回
sidepanel.html/css/js  原生侧栏、填写、字段搜索、辅助新增条目
content.js/css         页面注入、字段识别、填表执行与高级控件
sidebar-state.js       侧栏位置、折叠状态和可视区域规则
background.js          扩展动作和隐藏请求进程启动
ai-host.html/js        隐藏文档及消息转发
ai-worker.js           提示词、分批与结果校验
ai-client.js           请求进程准备及客户端取消顺序
ai-helpers.js          匹配、清洗和辅助规则
form-agent.js          受限新增计划、分组识别与执行检查
resume-utils.js        与桌面共用的字段整理和错误提示
resume-data.js         桌面简历数据视图和降级文案
link/                  桌面程序连接：简历读写、AI 转发、旧数据迁移、保存岗位和待同步队列
link/protocol/         桌面协议校验器的 vendored 副本
tests/                 扩展单元与回归测试
icons/                 扩展图标
```

## 本地开发

扩展没有构建步骤，可在 Chrome 或 Edge 的扩展管理页开启开发者模式，加载仓库根目录。网页填写同时依赖桌面端；只加载扩展不能替代桌面启动和 Native Messaging 注册。

按[开发快速开始](dev-quickstart.md)启动桌面、注册连接，再重新加载扩展或重启浏览器。修改内容脚本后还需刷新被注入的网页。建议使用隔离的数据目录和独立浏览器 Profile，避免测试数据进入真实档案。

扩展回归在仓库根目录运行：

```bash
node --test tests/*.test.js
```

桌面测试与构建命令见[桌面端开发说明](../desktop/README.md)，发布操作见[发版 SOP](release-sop.md)。

## 桌面连接与申请选择

扩展通过 Native Messaging 读取简历、转发 AI 请求、保存岗位和留档，API Key 由桌面管理。桌面不可用时，简历字段与 AI 填写不可用；离线保存意图和待同步队列按界面状态处理。

保存岗位先在侧栏确认公司和岗位，网址只读且已脱敏。需要 AI 回退时，发送的是限定的页面文字片段。重复岗位由用户选择关联或另存；取消不写入。

「确认已投递」和填写留档都要求用户明确选择申请，即使候选只有一条也不预选。无候选时引导先保存岗位。确认投递只更新本地状态，不触发招聘网站的提交操作。

改这块代码前先看这几条，它们都有测试守着：

- **「待同步」不等于「桌面已保存」。** 只有桌面持久化并回了 `resultId`，界面才允许说已保存。文案集中在 [`link/copy.mjs`](../link/copy.mjs)，[`tests/link-degradation.test.js`](../tests/link-degradation.test.js) 按降级矩阵逐行核对。用户可见的离线规则见[使用指南](user-guide.md#待同步记录)，改文案时两边保持一致。
- **「未安装」和「未配对」是两件事。** 装了但没配对时要说去桌面粘贴扩展 ID，不能说没装。
- **队列有两层。** 桌面当时不在，或精确重复还没选定 → `SaveIntent`（没有 `messageId`、没有申请 UUID、没有 epoch）。桌面在线且没有精确重复时，同一次保存会立刻写成 Bound outbox 并发送 `job.save`（新建，阶段是已保存，不是已投递）；有精确重复才问「使用已有 / 新建一条」，同公司的另一个岗位直接新建。Bound outbox 铸 `messageId`，盖当时的 `sourceRestoreEpoch`。两者都存在 `chrome.storage.local`，使用 `desktopSaveIntents`、`desktopOutbox`、`desktopClientInstanceId`、`desktopPairing` 四个 key；填写留档再加 `desktopFillRecords`（未选申请的留档意图）和 `desktopFillReceipts`（最近 200 次已处理填写的 ID 与结果，用于防止重复留档，不含填写值）。`fill.submit` 的 `messageId` 固定为本次填写的 `recordId`。
- **`sourceRestoreEpoch` 盖上就不改。** 重试时信封换成最新握手身份，载荷不换。桌面恢复过备份之后，旧 epoch 的消息一律暂停，只能走 `outbox.reconcile`，由用户决定关联、丢弃或另存。
- **重试沿用原 `messageId`。** 换 ID 就是第二条申请。
- **留档不等于投递。** 任何留档文案都不说投递；投递之后仍然要点「确认已投递」。

协议的源文件位于 `desktop/crates/protocol/js/`，`link/protocol/` 为副本。修改源文件后重新复制，由 `tests/protocol-vendor.test.js` 校验一致性。`resume-utils.js` 的扩展与桌面副本也需保持一致。

开发注册细节见 [DEV-NATIVE-MESSAGING.md](../desktop/DEV-NATIVE-MESSAGING.md)。更改 host 注册后重新加载扩展或重启浏览器。

## AI 请求与诊断

提示词在隐藏文档中的独立 Worker 组装，经 service worker 使用一条可断开的 Native Messaging 长连接交给桌面，再由桌面请求服务商。取消会断开该连接，包括正在读取响应体的请求；不保证上游停止计算或计费。

等待超过 90 秒仅显示慢响应提示。浏览器退出、扩展重载、网络和上游故障仍可能中断任务。HTTP、网络、用户取消、返回格式错误分别提示；AI 失败或主动取消时继续使用已验证的本地匹配结果，并明确标注部分完成，不自动重试或更改配置。

明确的教育、工作、项目字段只发送相关的完整简历分组，保留多段经历及其关联。含糊、跨领域或没有相关候选时回退全量，自定义未知分组始终保留；不使用固定 Top N 截断。

诊断区分扫描、匹配往返、API（含响应体读取）、填写和总耗时，并记录字段数量、提示词字节数。未执行或未取得的阶段不能记成零耗时。摘要不得包含接口地址、Key、简历内容或上游错误原文。

当前未采用本地立即填写、AI 异步补齐的方式。简历解析请求不随本轮匹配优化改变。请求字节数下降不能直接推导真实延迟或准确率变化，应在同一模型、接口和表单上比较。

## 受限新增条目

`form-agent.js` 只允许枚举到的新增按钮与本地数量上限。AI 不得提供可执行代码、任意选择器、导航、提交或删除操作，页面文本只作为数据。

当前识别要求 `section` 或 `role=group` 分组、匹配标题、独立 `fieldset` 条目，以及唯一 `button[type=button]` 新增按钮。预览状态需要绑定标签页、地址、模板和网页分组，变化后计划失效。

每次最多新增 5 条，逐次检查新输入框出现；2.5 秒内未确认新增则停止。只填新分组的空文本框或文本域，写入前再检查已有值，短时等待并读回。短时读回不能证明服务端已保存，停止后不自动删除已新增条目。

用户可见的限制和操作流程见[AI 辅助新增条目](user-guide.md#ai-辅助新增条目)。

## 填写记录、快照与队列

留档记录结果摘要与计数，不记录网页实际填写值；可附带填写开始时冻结的简历模板快照。用户取消留档不建记录、不暂存快照。从未配对的用户不显示留档卡片，也不为该流程暂存数据。

快照可先存扩展 IndexedDB，桌面可用后分片上传，收到持久化完成确认后再清理。填写记录使用 `recordId` 去重，重复点击或消息不得生成多条 `fill.submit`。只有桌面返回持久化结果才能显示「已留档到桌面」。

侧栏「待同步 N 条」展示现有 worker 队列 `DESKTOP_LIST_QUEUE`，支持选择申请、重试、删除和丢弃过期快照。关闭网页后仍可继续处理；不支持原生侧栏的浏览器保留旧网页控件路径，产品支持范围仍以首页为准。

| 模块 | 职责 |
| --- | --- |
| `link/fillrecords.mjs` | 留档意图与 allowlist |
| `link/snapshot.mjs` | 快照格式 |
| `link/staging.mjs` | IndexedDB 暂存 |
| `link/uploads.mjs` | 分片上传、游标和修复 |

改动前参考 [D08 分拆计划](superpowers/plans/2026-09-11-d08-pr-breakdown.md)。真实浏览器端到端检查：

```bash
python desktop/scripts/d08_browser_check.py
```

隐私和恢复后的队列语义需同步核对[隐私政策](privacy-policy.md)及[数据与隐私说明](desktop-mvp/data-privacy.md)。
