# D15 云备份基础接口（#302–#304）

基准：main `1a8bbcad7b633fcc765e1846e3eae6906971073a`。实施日期：2026-10-18。
父任务 #139；上传与保留编排在 #305，界面及真实服务商/设备验收在 #306。

## 本地档案与任务协调

- `ArchiveStore::archive_dir()` 是导出数据库和引用文件的统一来源。启动读取
  `current.json`，恢复/回滚后刷新 HostPaths；无效指针或丢失目录报错，不新建空档案替代。
- 所有 UI/IPC 写入、导出、恢复和回滚共享 store mutex。切换全程持锁，成功直接
  安装已经打开的新句柄；失败恢复原指针字节与 epoch，再打开旧库。
- 关闭前将原指针同步写到 `current.restore-previous`。切换窗口崩溃且 current 缺失时，
  下次启动先恢复这个指针。若 current 已存在，以它为准。恢复失败保留数据并报告两段错误。
- 锁顺序为 paths → store；读取 paths 后释放再执行备份。网络、KDF 与加解密不持
  store 锁。导出快照、打包、预览、恢复及回滚从 Tauri 阻塞线程池执行。
- 本地快照/恢复 staging 在 data_root 下，独立于可替换的 archive。云任务使用
  `PreparedWorkspace::new_task()` 返回的 TaskDirectory，先完成一致性导出，释放 store 锁，再加密/传输。
  AppState 只在启动清理成功后保存 PreparedWorkspace；失败时为 None，不能创建任务。
  #305 应通过此句柄创建任务；重试 prepare 仅在持有 host 唯一写入者锁且无任务时运行。

## age 格式与资源上限

- `.rpbak` 保持现有明文格式；`.rpbak.age` 使用固定 `age = 0.12.1` 的 age v1
  口令模式：scrypt + 流式认证加密，**不是 Argon2id 或自定义加密外壳**。
- 上层云配置默认加密；明文上传必须由用户明确选择（#306 接界面）。本 PR 不提供上传 UI。
- 标准工作因子 log N=18（scrypt r=8，约 256 MiB），解密拒绝更高因子。
  头部最多 64 KiB；输入和输出最多 8 GiB + 4 MiB，上层可调低；缓冲 64 KiB。
  KDF 调用自身无法中途打断，取消在调用前后和每块之间检查。
- `encrypt_file` / `decrypt_file` 使用 SecretString，原样保留口令中的空格和 Unicode。
  解密读到最终认证块和 EOF 后才 sync + 原子发布。错口令、截断、篡改、重排、拼接、
  多余尾部失败；已有目的文件不会被覆盖。失败/取消移除当前临时文件。
- reader 和 writer 的 manifest 上限均为 32 MiB，条目数最多 199,999 个（另加 manifest），
  展开总量最多 8 GiB，继续检查路径、长度和 SHA-256，拒绝重复/保留清单路径。
- 任务目录在 `data_root/cloud-backup-work/job-<32位随机字符>`；正常退出自动删除，
  启动持 host 锁后清理遗留任务。拒绝 workspace 根目录链接/Windows reparse point。
  Unix 目录 0700、临时文件 0600；Windows 继承应用数据目录 ACL。
  本地保留的 `.rpbak` 仍是明文；普通删除不等于安全擦除。

## 凭据隔离与界面契约

- 原生 Credential Manager / Keychain，不降级写入文件。WebDAV 应用密码和备份口令
  是两种独立项；账号键含 connection UUID 及 HTTPS endpoint + username 的 SHA-256。
  换账号或地址后不会沿用旧凭据；旧项可用原连接描述显式清除。
- 前端仅有 `set_cloud_backup_credential`、`clear_cloud_backup_credential` 和
  `cloud_backup_credential_status`（两个 bool）。没有读取秘密的 Tauri 命令。
  Rust 后续后台任务可通过注入 CredentialStore 读取 SecretString。
- 秘密不进入 SQLite、设置、备份、诊断、错误正文或日志；系统凭据库失败明确报错。
- #306 的配置/恢复提示必须说明：备份口令独立于坚果云应用密码，换机须重新输入，
  本机钥匙串不是恢复保障，遗失无法找回。修改口令只影响新包；旧包仍需要当时的口令。

## WebDAV 传输与能力档案

- 坚果云预设 `https://dav.jianguoyun.com/dav/`。生产接口仅 HTTPS，不跟随跳转，
  不接受 URL 凭据。RemotePath 是逐段编码的相对路径，不接受外部 URL。
  href 校验 origin、根路径、Depth:1、编码斜杠及 dot segment；不将元数据变成任意请求地址。
- MKCOL、PROPFIND、HEAD、GET、流式 PUT、DELETE，MOVE 为可选能力。
  PUT 显式 Content-Length + If-None-Match: *；MOVE 使用 Overwrite: F。
  上层仍需使用唯一自有文件名，并依探测结果决定发布流程。
- connect 10 秒、控制请求 60 秒；文件传输总期限按 64 KiB/s + 60 秒预算，最大文件约 128 分钟，
  下载等待响应头及相邻数据块停滞上限各 60 秒，上传受按大小计算的总期限及取消约束。
  共享客户端克隆之间默认 3 秒请求间隔；安全读取至多重试两次，
  Retry-After 支持秒数/HTTP 日期，超过 60 秒直接返回给上层，不能缩短后盲重试。
  401 与 403 分开；另区分 404、409/412、413、429、507、网络及超时。
  写操作不自动重试，网络/超时/5xx 等结果未知时标记 outcome_unknown，上层先对账。
- 单文件限制保守为最终文件 **500,000,000 字节**；下载检查声明长度且对实际流量计数、
  有界写盘，完整后发布新任务文件并返回实际 SHA-256。ETag 仅作不透明服务端 token。
- XML 最多 1 MiB、200,000 节点、1,000 response，禁止 DTD。坚果云目录响应达到
  750 项（含自身）/缺少自身/出现 continuation 信号时返回 PossiblyTruncated；
  低于边界也返回 UnverifiedServer，因为尚无真实账号列表完整性证据。只有 Complete 可供上层清理使用；
  当前生产接口不产生 Complete，须 #306 建立可验证的列表契约后再由 #305 启用保留清理。
  目前无经验证分页协议，不能把单页当全集清理。
- `probe_capabilities(parent, recorded_uuid, cancel)` 只使用新建 UUID 测试目录和合成内容，
  观察条件 PUT、MOVE/Overwrite、长度/ETag、列表与清理结果。先记录 UUID，未知结果可按
  此目录对账；取消后不发更多请求。MOVE 不支持时 #305 使用唯一包 PUT + 最后发布元数据。

## 验证与边界

自动测试覆盖：恢复后附件导出/回滚/重启、失败重开与二次失败、锁互斥、旧 epoch 拒绝；
恶意 manifest；age 官方 scrypt 测试向量、直接 age 读取输出、块边界/多块、损坏及资源上限；
真实本地 HTTP socket 的 WebDAV 方法/路径/长度、状态码、有限重试、不重试写入、截断/超限、
能力探测与清理范围；模拟凭据库的连接绑定与口令保真。

CI 在 Windows x64 / macOS arm64 跑新 crate 与现有主程序回归。本地原生钥匙串的合成项测试
是显式 ignored 测试，必须单独执行。2026-10-18 Windows 上已显式运行，跨 adapter 保存/读取/清除通过。
进程重启、交互界面和真实账号验证在 #306 记录；
这些自动测试不代表坚果云兼容已验收，也不代表真实 macOS Keychain 已验收。

服务商限制参考（2026-10-18 复核的方案）：[授权与限制](https://help.jianguoyun.com/?p=2064)、
[流量说明](https://help.jianguoyun.com/?p=29)。免费/付费每半小时 600/1500 请求、目录 750 项、
免费每月上传 1 GB/下载 3 GB，重置按账号周期；实际账号能力须 #306 探测，不为测试边界消耗大额流量。

## 第一轮自动审查处理

- 采纳：区分 age 认证读取错误、真实读写 I/O 与加密大小上限；增加故障 writer/reader 和
  头部/正文限额测试。只读异常状态码不标记为写入结果未知。
- 采纳：低于官方目录上限仍不足以证明真实账号列表完整，生产列表继续禁止保留清理。
  任务目录清理跳过同名普通文件/链接，继续清理自有目录。
- 自查追加：永久删除申请/孤立附件从持锁的 store 取目录，避免恢复并发时使用路径快照。
- 未采纳 Windows rename 目的存在必失败的判断：Windows 实测已有目标可原子替换，
  新增遗留恢复文件后再恢复的回归通过；不引入先删除目标造成的新窗口。
- 未采纳失败探测未清理的判断：DELETE 的 await 发生在 result.map 之前；新增 HTTP 测试
  验证内部 PUT 返回 403 后仍只删除自建目录一次。不会按建议重复 DELETE。
- 未采纳无空格 `---` 是合法 age footer 的判断：age v1 footer 包含 `---`、空格及 MAC。
  缺少 MAC 的行不是合法文件，保留格式校验与官方向量测试。
- 保留无效 current 时的恢复文件，供人工恢复；不在无法确认状态时删除唯一恢复证据。
  打开的 store 却丢失 current 时明确失败并保持旧库打开；新机器先 open 创建指针，
  独立的空白目标恢复回归也通过。解包/切换期间保守串行，未在锁内执行网络或 KDF。
- CodeRabbit 后续反馈：文件传输不再受统一 60 秒总超时限制，下载保留响应头/数据块停滞检查；
  已验证持续传输能超过控制请求期限。XML 节点上限调至 200,000，仍受 1 MiB 字节上限，
  新增含空白节点的 750 项目录回归，返回不完整且禁止清理。

第二轮追加：manifest 在有界 writer 中序列化，超限途中即停止；所有恢复指针读取限制 64 KiB。
恢复证据延后到真正关闭旧库前写入，无效包不触碰已有证据。指针及恢复文件都丢失但发现恢复/
退休档案时，启动明确失败，避免创建新空库。清理成功才生成 PreparedWorkspace 句柄并存入 AppState。
不宣称系统断电时目录项已持久落盘；当前验证针对进程退出/重启与原子发布，完整掉电耐久性需另做平台验证。
