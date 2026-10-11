# 下载与活跃安装统计：口径和第一阶段使用说明

关联 [Issue #259](https://github.com/TshyGO/resume-form-assistant-plugin/issues/259)。以 2026-10-11 的沟通为准：Cloudflare Workers + D1；独立使用统计开关默认开启、用户可关闭；分阶段在功能分支实现。

第一阶段交付本地下载快照工具；第二阶段云端源码与操作说明见 [Worker README](../services/usage-metrics/README.md)。**已部署隔离测试云端；第三阶段新增桌面开关、状态、告知与主动使用客户端，默认/开发/测试/CI 构建仍禁用外发，插件尚未接入，也未开始采集真实用户数据。**桌面验证和发布条件见 [第三阶段说明](usage-metrics-desktop.md)；第二阶段实际结果和未通过的自动 Cron 验收见 [测试验收记录](../services/usage-metrics/test-acceptance.md)。隐私政策已同步描述客户端启用后的行为及当前停发边界。

## 1. 阶段与分工

1. 本阶段：指标规则、接口契约、Cloudflare 配置交接、本地下载快照/增量及测试。
2. 云端：Worker 源码、D1 迁移、公开下载量分页抓取、定时采集/清理及接口测试；资源配置和部署交协作者执行。
3. 桌面：独立设置、状态文件、可见主动使用、发送和关闭逻辑、隐私说明。
4. 插件：本机使用信号、新旧协议兼容、同机去重。
5. 报表：受保护的查询、真机联调、商店披露、发布和运维。

本地可以写全部仓库代码和 mock 测试；Cloudflare 资源、Secret 与部署由协作者负责，按 [交接文档](usage-metrics-cloudflare-handoff.md) 提供非敏感对接信息。所有代码在功能分支审核，不直接提交 main。

## 2. 指标说明

统一用 UTC 自然日，北京时间上午 8 点进入新统计日。当前日标注“进行中”，所有图表注明数据来源、采集起点和覆盖范围。

| 指标 | 定义 | 限制 |
| --- | --- | --- |
| Release 累计下载请求 | 每个 asset_id 的 download_count，按 tag、附件、平台和发布渠道分组 | 重复下载也计数，不等于安装成功或用户数 |
| 快照区间新增下载请求 | 同一 asset_id 两次完整观测的累计计数之差 | 展示实际起止时间，不能称为精确的自然日下载日志 |
| DAU | 当天有明确使用、统计开启且成功上报的去重桌面安装数 | 使用“已启用统计的活跃安装样本”，不是全部人数 |
| WAU / MAU | 今天及前 6 / 29 个 UTC 日内的不同安装数 | 跨天去重，不能把 DAU 相加 |
| 版本分布 | 窗口内每个安装最后成功观察到的桌面版本，再分组 | 同日上报后升级可能要到下一次上报才更新 |
| 系统分布 | Windows / macOS | 不收集精确系统、硬件或地理位置 |
| 使用来源 | desktop / extension，标志可同时为真 | 同安装同一天桌面、Chrome、Edge 合计只算 1 |

下载统计只读取 GitHub 公开元数据，与活动数据分开。Chrome 商店分发不会计入 Release 附件计数；不能把不同来源数字相加宣传为总用户数。Release 渠道是所在 Release 的渠道，桌面 beta Release 可能携带正式插件 ZIP，不据此认定插件本身为 beta。

同一人多设备、多人共用一个安装、重装或关闭后重新开启均会影响计数。默认开启仍存在退出、断网和上报失败造成的漏报；没有全量分母就不计算启用率。

## 3. 后续客户端必须遵守的规则

- 首次初始化且无旧选择时默认开启。用户关闭选择持久化，重启、升级、配置迁移不能覆盖。状态损坏或无法可靠读写时停止发送。
- 统计开关、编号、状态文件与错误报告完全独立。默认值不是用户主动同意的证据。
- 首次外发前显著说明默认开启、用途、字段、保留和关闭入口；不补传告知前或关闭期间活动。发布前核对适用商店要求，必要时等待规定的明确同意动作。
- 发送条件满足才生成独立 UUIDv4；不进入简历库、档案备份、导出、诊断报告或 GitHub issue。
- 只统计主动打开/聚焦可见主窗口、可见 UI 交互及插件显式操作。隐藏进程、更新检查、预取、握手、同步、提醒和后台唤醒不算活跃。
- 每安装、每来源、每 UTC 日最多尝试 1 次，失败也消耗当天额度。并发触发先占用额度；服务端再次去重。
- 异步发送，建议超时 3 秒；不跟随意外重定向，不引入离线队列、心跳或后台重试。统计失败不影响主功能。
- 关闭立即停发并尽力取消请求，持久保存关闭选择，清除编号/发送记录。短暂保留原编号尝试云端删除，失败不阻塞关闭，也不宣称已即时删除。
- 再次手动开启使用新编号，不补发旧活动。开发/测试/CI 构建禁用外发，通过 mock 或虚构请求脚本测试。

保留：在线去重明细 45 天，无安装标识的汇总及每天生成的滚动指标快照 365 天。超出明细窗口不提供任意历史去重重算。删除明细可能改变可重算指标，已脱离编号的历史汇总保留。短期撤销元数据及平台备份留存须披露，恢复备份不能复活已关闭采集。细节见交接文档。

## 4. 本地下载工具

依赖 Node.js 22 或以上，无运行依赖，无 Cloudflare 网络请求。CLI 只读取 JSON 文件、向 stdout 输出结果；它不下载安装包、不定时运行、不自动抓取网络数据。

- `desktop/scripts/usage-metrics/downloads.mjs`：纯函数，后续运行端可以复用。
- `desktop/scripts/usage-metrics/snapshot.mjs`：本地 CLI。
- `tests/usage-download-metrics.test.js`：测试，已纳入现有 `npm test`。

在仓库根目录运行：

```sh
npm run test:usage-metrics
node desktop/scripts/usage-metrics/snapshot.mjs --help
```

### 不联网的完整示例

两个夹具都是虚构数据，Windows 附件从 100 次变成 108 次。

```sh
mkdir -p output/usage-metrics
node desktop/scripts/usage-metrics/snapshot.mjs --input tests/fixtures/usage-metrics/releases-baseline.json --at 2026-10-10T00:10:00Z > output/usage-metrics/baseline.json
node desktop/scripts/usage-metrics/snapshot.mjs --input tests/fixtures/usage-metrics/releases-next.json --previous output/usage-metrics/baseline.json --at 2026-10-11T00:10:00Z > output/usage-metrics/next.json
```

结果为 `{ "snapshot": ..., "report": ... }`。第一次所有附件都是 `baseline`，increment 为 null；第二次 Windows 附件为 `adjacent_day`，increment 为 8，macOS 和插件增量为 0，校验文件不会出现。

`--previous` 可以直接使用上一次 CLI 的完整输出，也可以使用其中的 standalone snapshot 对象；不要把 report 对象当成快照。每次写入不同文件名，不把同一文件同时用作输入和重定向输出。执行失败退出码为 1、stdout 无报表，不能保存成成功快照或在数据库里写零。

输入附件编号和下载计数分别校验。CLI 对这两种情况显示固定的字段提示，不回显文件内容、文件路径或任意异常文本；其他错误保留通用失败提示。

`--at` 是观测时间（ISO 格式，含 Z 或时区偏移），用于夹具或外部采集时间；不能将今天取得的累计数填成过去某天以伪造历史。生产应保留实际取数时间。未提供时使用当前时间，规范化为 UTC 毫秒格式。软件发布时间不能晚于观测时间：生成快照和加载旧快照都检查绝对时间，包括时区偏移；恰好相等允许。这项校验拒绝明显矛盾的时间，不能证明人为回填的累计数真实对应历史观测。

### 使用公开 Release 数据

已安装并配置 GitHub CLI 的维护者可手动完整取数；确认命令成功后再运行本地工具：

```sh
gh api --paginate --slurp 'repos/TshyGO/resume-form-assistant-plugin/releases?per_page=100' > output/usage-metrics/releases.json
node desktop/scripts/usage-metrics/snapshot.mjs --input output/usage-metrics/releases.json > output/usage-metrics/observed.json
```

输入接受 releases 数组或 `--paginate --slurp` 的分页数组。完整性由采集端负责：不能仅取第一页，不能把失败页/限流/缺失 assets 当空数组。库能拒绝结构错误、重复 ID 和非法计数，但无法仅凭一个合法数组识别遗漏的页面。新增加大量附件时，云端采集也须核对资产列表完整性。

输入会排除 draft、未完成上传及 .sha256；识别当前/历史 Windows EXE、macOS DMG、项目插件 ZIP，其他附件保留为 other。插件 ZIP 用项目命名识别，不把任意 ZIP 当插件。正式/预发布取 Release 标记或版本 tag 的预发布后缀。

## 5. 快照与增量契约

snapshot 包含 `schema_version: 1`、固定 repository、observed_at、date_utc 和 assets。每附件仅保留 asset_id、release_id、tag_name、file_name、published_at、download_count、release_family、release_channel、artifact_kind。不保留作者、发布说明、完整 API 对象或凭证。

report 保留实际观测起止时间、跨 UTC 日数和附件行。increment 可以为 0，但以下情况使用 null，不能当 0：

| status | 含义 | increment |
| --- | --- | --- |
| baseline | 首次观测 | null |
| new_asset | 本次新增 ID，尚无区间基线 | null |
| adjacent_day | 相邻 UTC 日观测 | 两次计数之差 |
| same_day | 同一天内观测 | 两次计数之差，不称日新增 |
| gap | 跨过缺采日 | 区间增量，不塞进某一天 |
| count_decreased | 计数下降 | null，需排查 |
| metadata_changed | 同 ID 的附件名、tag 或分类等变化 | null，需排查 |
| missing_asset | 旧快照有，本次没有 | null，当前累计也为 null；不证明永久删除 |

旧附件和重传后的新 ID 不拼接。当前快照必须晚于上一快照；仓库、结构、时间或分类不合法时报错。发布时间实际变化也标为 metadata_changed，表示同一时刻的不同 ISO 时区写法不会误报。正常元数据更新导致的异常作为新的观测起点保留，并显著标注，后续恢复正常时再计算新区间。GitHub open 或失败残留 starter 附件不计入。

快照校验用于识别格式和内部矛盾，不提供对本地文件的真实性认证。普通版本 tag 也可能由 GitHub 标为预发布，不能仅凭 tag 推断 release_channel；合法渠道标记和计数被人一起修改无法仅靠这份 JSON 检出。运行端必须直接完整采集官方 API，并控制数据库写权限。

## 6. 第一阶段验收

- 离线示例得到 Windows 100→108 的区间新增 8，首次快照没有假日增量。
- 正式/预发布、桌面/插件 tag、项目历史命名、其他附件和校验文件分类正确。
- 同日、漏采、重传、计数下降、UTC 跨月/跨年及闰日有测试；软件发布前的观测时间和旧快照会被拒绝，CLI 不输出错误报表。
- CLI 自己生成的结果可连续作为 --previous 使用；非法输入非零退出且不输出假报表。
- 使用公开 Release 数据进行一次真实格式检查；没有发送活动请求。
- 全部新增逻辑测试、现有根目录测试和类型检查通过。
- Cloudflare 交接文档明确请求/返回、资源配置、需要提供的信息和分阶段验收；第一阶段不需要资源已部署。

官方字段参考：[GitHub Releases API](https://docs.github.com/en/rest/releases/releases#list-releases)、[Release assets API](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)。
