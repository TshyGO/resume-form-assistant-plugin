# D02 宿主接口（给 D03 / D06）

D02 只交付唯一写入者进程、目录布局和窗口生命周期。**不**创建 `archive.db`，**不**写 `current.json` 的 restoreEpoch，**不**实现 Native Messaging。

## D03 应使用的接口

Rust crate：`desktop/crates/data-service`

| 符号 | 用途 |
| --- | --- |
| `DataHost::initialize()` / `initialize_with(paths)` | 成为该用户数据目录的唯一写入者。第二个进程会得到 `INSTANCE_LOCK_FAILED`。 |
| `DataHost::paths() -> &HostPaths` | 解析后的目录。相对路径入库时以这些根为准。 |
| `HostPaths::archive_dir` | D03 在此创建 `archive.db` 与 `meta.json`。 |
| `HostPaths::current_pointer` | D03 写入 `current.json`（含 `restoreEpoch`）。D02 不创建该文件。 |
| `HostPaths::attachments_dir` / `snapshots_dir` / `tmp_dir` | 附件与快照；D02 只建空目录。 |
| `HostPaths::archives_retired_dir` | 退役档案。D02 不删除已有数据。 |
| `HostPaths::logs_dir` | 日志与诊断导出。不要把简历/邮件正文、Key、Cookie 写进来。 |
| `HostPaths::cache_dir` | 应用缓存根。Windows 在数据根下 `cache\`；macOS 为 `~/Library/Caches/ResumePro`。 |
| `webview_storage()` | Windows：WebView2 用户数据实际写在 `cache_dir/webview`（`WEBVIEW2_USER_DATA_FOLDER`）。macOS：当前 Tauri/wry 的 WKWebView **没有** `data_directory`，网站数据留在 identifier `com.resumepro.desktop` 的系统默认存储（常见为 `~/Library/WebKit`），设置页不得把应用缓存目录说成 WebView 配置目录。 |
| `DataHost::is_writable()` | 目录不可写时返回 `DIR_NOT_WRITABLE`，**不会**改用临时目录。 |

测试/开发可用环境变量 `RESUMEPRO_DATA_DIR`、`RESUMEPRO_CACHE_DIR`（必须是绝对路径）。这不是生产静默回退。

程序目录与用户数据目录分离：设置页同时展示二者。不要把 SQLite 放到安装目录。

## D06 应使用的接口

同一产品二进制，同一 `DataHost`：

| 入口 | 行为 |
| --- | --- |
| 默认启动 | 唯一写入者 + 显示主窗口 |
| `--hidden` | 同一宿主，不显示主窗口。供后续 NM host 按需拉起 |
| `--probe` | 打印 JSON 后退出，不长期占有写入锁 |
| 第二次启动 | `tauri-plugin-single-instance` 激活已有窗口；不创建第二个写入者 |
| 关闭窗口 | 隐藏到托盘/菜单栏，进程仍在 |
| 托盘「退出」或设置页「退出应用」 | 结束唯一写入者 |

D06 不要再开一个写数据库的进程。本地 IPC（named pipe / unix socket）仍属 D06；D02 只用单实例锁保证唯一写入者。

D02 **没有**注册 Chrome/Edge Native Messaging，也没有生产 host stdout 协议。设置页的扩展 ID 只写入 `settings.json` 草稿。

## 错误码

`PATH_INVALID` · `DIR_CREATE_FAILED` · `DIR_NOT_WRITABLE` · `INSTANCE_LOCK_FAILED` · `LOG_WRITE_FAILED`

## 明确未做

- 申请 CRUD / schema / 迁移（D03）
- Native Messaging 协议与注册（D05/D06/D13）
- 系统通知 / 开机启动（D10/D13）
- 代码签名、公证、商店上架
