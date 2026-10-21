# D15：云备份发布与按设备保留（#305）

基准 main：`44ce0cc756a14647d0a9a115bc75aa4b90184915`；实施日期：2026-10-18。
父任务 #139，基础接口来自 #302–#304 / PR #308。

## 发布契约

```text
<配置根路径>/ResumePro/<archiveId>/<deviceId>/<YYYY-MM>/
  <YYYYMMDDTHHMMSSZ>-<完整随机 UUID>.rpbak.age  # 或显式明文 .rpbak
  <同一个 stem>.meta.json
```

时间和月份按 UTC。ID 必须为规范的小写完整 UUID，目录按段编码。
元数据的 `format=resume-pro.cloud-backup`、`formatVersion=1`，其余字段为
`backupId/createdAt/archiveId/deviceId/package/sizeBytes/packageSha256/encryptionFormat`。
不接受未知字段、路径片段、绝对 URL、不匹配的月份/设备/文件名或不合法摘要。
业务计数、公司名、附件名和 entries 在明文及加密模式下都不进入元数据。

`deviceId` 保存在机器本地 `data_root/cloud-backup-state/state.json`，不进入 .rpbak。
恢复其他设备的档案只继承 archiveId，不继承其删除权限。本地状态丢失且目录中已有内容时
拒绝重新初始化，避免凭空建立不可信的删除权限。

默认使用唯一正式文件名 PUT，然后最后 PUT 元数据。设置 `preferMove=true` 时先在本作业
记录的 UUID 测试目录中探测 MOVE 与禁止覆盖；两者通过才走 `.part → MOVE → 元数据`。
探测失败则降级到唯一文件名 PUT。失败/取消探测目录可从作业 ID 定位，按 #303 约定对账；
取消后不使用新 token 绕过取消继续发请求。未确认的探测清理会成为独立警告。

每次写入前持久记录 intent。响应丢失后不自动重发写操作；用户重试沿用原 backupId、
UTC 时间、文件名和完整候选字节。先用 PROPFIND Depth 0 查对象；已有包会流式下载到任务目录并校验实际 SHA-256，
已有元数据必须结构化解析且与本作业完全一致。发现冲突/损坏元数据时停止并保留候选，
不覆盖已有对象，也不新建另一个 ID 掩盖未知结果。服务商若保留半份 PUT 元数据，
该 JSON 不会出现在成功列表；需要先人工对账，不能以自动覆盖来“修好”未知对象。

远端包存在且大小相符、元数据可完整读回且匹配后才原子更新本地 latest，并启动清理。
正常发布确认只做 PROPFIND 长度检查（实测坚果云 HEAD 对完整文件报 0，不可用，#316），不冒称验证了云端包的内容哈希；重试对账及恢复下载才
完整读取包。明文元数据摘要不能作为防恶意服务器篡改的信任锚。

## 本地任务、空间与恢复

- 一个应用实例只允许一个云操作（上传、重试、列表或下载）；不会并发清理自己的在传对象。
  启动在 DataHost 唯一写入者锁后准备 workspace，再打开持久 journal。
- 作业阶段为 `packing/encrypting/uploading/confirming/succeeded/cleanupWarning/failed/cancelled/interrupted`。
  `published` 表示已确认远端提交；清理失败保留备份成功，单独报告 warning。
- SQLite 快照与附件打包复用 #302，在 store 锁内保持一致性。随后释放 store 锁，才执行
  KDF、哈希和全部网络请求；上传期间业务写入不受该锁阻挡。打包与 KDF 在阻塞线程池执行。
- 临时文件位于 `cloud-backup-work/job-<随机串>`，RAII 清理；进程退出后下次启动清理。
  完整候选位于 `cloud-backup-state/<backupId>/{local.rpbak,payload}`，不会被 workspace 清理误删。
- 保留一份最近成功的本地明文包和最多一份失败候选；有候选时必须重试或显式放弃才能新建。
  加密任务同时保留密文 payload，明文任务优先用同卷硬链接，文件系统不支持时回退有界复制。
  不会自动轮换旧候选 ID。
  latest 指针更新后才删除旧成功目录；旧目录删除失败会阻止继续积累新任务。
- 取消打包在扫描/导出边界响应，导出中不打断 SQLite/ZIP 的一致性操作；scrypt 本身不能中断，
  在 KDF 前后及分块间响应。网络取消不抹掉已有完整候选。失败记录只保存错误码，不保存秘密。
- 导出前根据本地数据体积预留快照、ZIP、加密空间，另留 64 MiB；加密和下载/展开前再检查空间。
  最终实际上传字节上限默认 500,000,000，可向下配置。超限在任何上传前拒绝；无分卷或增量。
  磁盘空间估算是本机预检，不能保证并发进程不会用完磁盘；不估算坚果云账号的全局额度。
- journal 上限 512 KiB，归属回执最多 256 个；旧回执淘汰后相应远端对象不再获准自动删除。
  原子写临时文件有独立命名空间，启动只清理受控的普通临时文件，拒绝链接/reparse 目录。
- Unix 状态/任务目录为 0700，临时文件 0600；Windows 继承应用数据 ACL。普通删除不是安全擦除。
  Unix journal 原子替换后同步父目录，确保开始远端写入前提交意图的目录项也已同步。
  文件 sync + 原子替换验证进程退出/重启行为，不宣称完成系统掉电耐久性验收。

## 列表与清理

按明确的 archiveId/deviceId 读取月份目录，最多 120 个月，每个月份目录最多 1024 项（#322）。
列表只用 PROPFIND：不逐份读元数据，也不下载包。一行 = 本应用格式的 `<时间>-<backupId>.meta.json`
文件名 + 同名且唯一的 `.rpbak` 或 `.rpbak.age` 包（列表里有长度）+ 文件名月份与所在目录一致；
未知文件、`.part`、只有包或只有元数据的都不是行。按整月从新到旧返回，直到至少 10 份，
`next` 是最后读到的月份，下一页只读更早的月份；每个月份只列一次。返回 `contentHashVerified=false`。
预览时才直接读取该行的远端元数据：解析失败或与列表行（ID、档案、设备、包名、长度、加密方式）不符即拒绝，
内容哈希取自元数据，下载后校验。坚果云每次请求间隔 3 秒，第一页通常是 2 次请求。

默认在同 archiveId/deviceId 下跨月份共保留最近 5 份，`keepLast=null` 禁用所有自动删除。
清理不依赖列表完整（#322）：服务商列表可能漏项，但不会凭空多出文件。所以只用「列表里看得到」做正面证据：

1. 候选只来自本机回执（同连接 scope、根路径、档案、设备，非孤儿、非删除中），按创建时间从新到旧；
2. 依次读取回执所在的月份目录，元数据文件在、包长度与回执一致的才算「已保留」，凑够 `keepLast` 份；
3. 更早且同样在列表里看得到的才删除：删除前直接重读元数据并与回执完全一致，先删元数据并确认不可见，再删包；
4. 列表里看不到的回执既不计入保留、也不删除；元数据和包都不在时忘掉该回执（忘掉不授予任何删除权）。

因此列表漏掉最新的几份时，结果是多留几份旧的，不会多删。没有回执的对象（其他设备、用户文件、
未知 `.part`）一律不动。当前作业和最近成功的备份不会被删。每次最多删除 10 份（约 50 次请求），
长期积累的旧备份分几次备份清完。中断、响应丢失、元数据变动只产生清理警告；
预期内的「不需要删除」「看不到所以保留」不是警告。

孤儿只处理有本机回执的对象；从最近操作/显式放弃起至少 24 小时，且不存在发布元数据、
包大小与完整内容哈希都匹配后才删。回执持久记录正在删除的对象，以便下一次安全对账。
当前作业、最近成功包不进入孤儿删除集合。宽限期内的对象不会被当成垃圾。
本机最多保留 256 条回执；更早的回执被遗忘后，对应云端备份不会再被自动删除。

## #306 的调用接口

TypeScript：`desktop/src/cloud-backup-api.ts`；Tauri 命令：

| 命令 | 作用 |
|---|---|
| `cloud_backup_start(connection, options)` | 返回持久化作业后在后台执行；默认加密 |
| `cloud_backup_status()` | 查询本机 deviceId、作业状态、重试包及最新本地明文包位置 |
| `cloud_backup_cancel()` | 取消当前云操作 |
| `cloud_backup_retry(connection, options)` | 同一连接/账号/根目录/加密模式重试原候选；无需重新加密 |
| `cloud_backup_discard()` | 明确放弃候选；保留远端归属证据，保留 latest |
| `cloud_backup_list(connection, options, archiveId, deviceId, before)` | 按整月读取某设备的备份列表（只读目录）；`before` 为上一页的 `next` |
| `cloud_backup_config()` / `cloud_backup_save_config(config)` | 读取/保存本机非秘密配置，保存后保持手动模式 |
| `cloud_backup_test(connection, options)` | 只读测试所填根目录，不承诺上传权限 |
| `cloud_backup_discover(connection, options)` | 返回 sources 与 warnings；无需旧设备 ID，部分目录失败保留可用来源 |
| `cloud_backup_preview(connection, options, entry)` | 读取并核对该行远端元数据，完整下载校验后返回 token、有效期与业务差异，不返回本地临时路径 |
| `cloud_backup_clear_preview()` | 作废预览并检查临时明文清理结果 |
| `cloud_backup_restore(token)` | 单次消费绑定令牌，返回 report 与 cleanupWarning，不把清理失败当作恢复失败 |

connection 与 #304 凭据命令使用同一 connectionId/HTTPS endpoint/username；口令由 Rust
从系统凭据库读取，不加入任务记录或命令结果。默认 encrypted=true；false 必须是 UI 中的明确选择。
上传上限和 keepLast 的取值校验在 Rust 侧，不能仅靠 UI 校验。
重试可调整 keepLast 和上传上限（新上限不能小于现有包），不强迫重新打包；
preferMove 也可更新，但已有传输意图时继续使用记录的发布路径，避免切换策略产生重复对象。

下载先直接重读元数据，再检查实际字节数/SHA-256、age 最终认证和包内每个条目哈希。
生产包留在后台私有任务目录，返回十分钟有效、单次消费的随机 token 和只读差异预览。
用户明确确认后只传 token；后台检查同一任务文件哈希、准备隔离恢复、再次检查哈希与期限，
再持久化关闭自动备份门禁并切换活动档案。新选择、取消、过期或重启均使 token 失效。
正常结束显式检查临时目录删除结果，异常退出在启动时清理；恢复成功后的清理失败返回警告。
固定 `verified-download.rpbak` 仅是 #305 底层测试适配器，不存在对应生产 IPC。
口令更改影响新备份，下载旧包须在凭据库中提供对应旧口令；遗失无找回。

## 验证范围

自动验证覆盖发布步骤前后断网/响应丢失、MOVE 与直接 PUT、进程直接退出后重启、
取消、跨月保留顺序、同账号同 archiveId 两设备并发、用户文件/伪造元数据/不完整列表、
孤儿宽限及归属、明文和 age 完整上传下载、候选上限与旧包保护。
fake Remote 注入与生产共用同一发布/保留代码；底层真实 HTTP socket 合约由 #303 测试覆盖。
这不是一次真实坚果云账号兼容性验证，也不替代 #306 的界面/凭据库实机验收。


**#306 接入更新**：初期路径式 `cloud_backup_download` IPC 已由 `cloud_backup_preview` 返回单次、有时限的绑定令牌替代；确认仅使用 `cloud_backup_restore(token)`。工作明文不发布到固定下载路径，结束后清理。最终用户流程与真实验收状态见 [手动云备份验收](d15-manual-cloud-acceptance.md)。
