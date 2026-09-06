# Resume Pro Desktop（D02 壳）

最小可运行桌面程序：导航、设置、用户数据目录、单实例、窗口生命周期。浏览器插件仍在仓库根目录，安装方式不变。

给 D03/D06 的宿主接口见 [HOST.md](HOST.md)。

## 依赖

- Node.js 22+ 与 npm（使用已提交的 `package-lock.json`：`npm ci`）
- Rust：crate 声明 `rust-version = 1.77.2`（Tauri 2.11 锁定依赖的最低声明）。本仓库 Windows 已用 **rustc 1.94.0** 验证。不承诺未在本仓库跑过的更低或中间版本。
- Windows：WebView2 Runtime（Windows 11 通常已带）
- macOS 11+：Xcode 命令行工具

## 命令（在 `desktop/` 下）

```bash
npm install
npm test                 # 宿主/应用单测 + 前端构建 + ZIP 白名单
npm run desktop:dev      # 开发启动真实 Tauri 窗口
npm run desktop:build    # 本地打包（不签名、不上架）
```

探针（不打开窗口，打印解析后的目录）：

```bash
# 开发二进制
cargo run --manifest-path src-tauri/Cargo.toml -- --probe

# 隐藏启动（同一唯一写入者，供后续 D06）
cargo run --manifest-path src-tauri/Cargo.toml -- --hidden

# 让已运行的唯一写入者退出（不会再开第二个宿主）
cargo run --manifest-path src-tauri/Cargo.toml -- --quit
```

Windows 产物大致在：

`src-tauri/target/release/resume-pro-desktop.exe`

以及 NSIS 安装包（per-user，不要求管理员）。**不要用浏览器直接打开 `index.html` 当作验收。**

## 数据目录

| 平台 | 用户数据 | 缓存 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\ResumePro\` | 同一根下 `cache\` |
| macOS | `~/Library/Application Support/ResumePro/` | `~/Library/Caches/ResumePro/` |

目录不可写时会在设置页给出错误码，不会改用临时目录。重装或再次启动不会删除已有档案目录。

开发覆盖（必须是绝对路径），需导出后再启动同一进程：

PowerShell：

```powershell
$env:RESUMEPRO_DATA_DIR = "D:\tmp\Resume Pro Data"
$env:RESUMEPRO_CACHE_DIR = "D:\tmp\Resume Pro Cache"
npm run desktop:dev
```

macOS / bash：

```bash
export RESUMEPRO_DATA_DIR="$HOME/tmp/Resume Pro Data"
export RESUMEPRO_CACHE_DIR="$HOME/tmp/Resume Pro Cache"
npm run desktop:dev
```

## 生命周期

- 关闭窗口：隐藏到托盘（Windows）或菜单栏（macOS），进程仍是唯一写入者
- 托盘/菜单「打开」或第二次启动：唤起已有窗口
- 「退出」：结束进程
- **没有**开机启动、计划任务或常驻服务
- **没有**系统提醒（D10）；不要把托盘驻留理解成提醒可用

## 验证状态

Windows（本机已跑过真实 `resume-pro-desktop.exe`，不是浏览器打开前端）：

- `--probe` 解析到 `%LOCALAPPDATA%\ResumePro`，与程序目录分离
- 中文/空格目录可作为 `RESUMEPRO_DATA_DIR`
- 把数据根指向普通文件时返回 `DIR_CREATE_FAILED` / `DIR_NOT_WRITABLE`，不改用临时目录
- `--hidden` 后第二次启动仍只有一个进程；`--quit` 结束宿主
- 关闭窗口后进程仍在；设置页显示版本、数据目录、日志目录、运行状态
- 不创建 `archive.db` / `current.json`

macOS：代码按 Application Support / Caches 分支；WKWebView 数据目录与应用缓存目录不是同一处。CI 上的 macOS 作业只做构建/单测，**不是实机 UI 验收**。尚未完成实机启动、单实例、隐藏/恢复、Application Support 与实际 WebView 位置验证。不能把 Windows 跑通或 CI 编译说成 Mac 已验收。

## 插件回归

仓库根目录：

```bash
node --test tests/*.test.js
```

GitHub Release 工作流仍然只打包插件运行文件，不会把 `/desktop` 打进 ZIP。
