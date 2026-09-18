# 桌面端的构建、安装与升级

面向两类读者：要自己构建的人（第 1 节），和拿到安装包的用户（第 2 节起）。
本文随 [D13 #29](https://github.com/TshyGO/resume-form-assistant-plugin/issues/29) 一起长出来，先落构建与发布口径，安装、升级、卸载的细节随后续 PR 补齐。

---

## 1. 自己构建

工具链和 CI 一致：**Node 22**、**Rust 1.94.0**。`cargo fetch --locked` 会在 `Cargo.lock` 过期时失败——「可复现构建」的前提是锁文件说了算。

```bash
cd desktop
npm ci
npm run tauri build -- --bundles nsis      # Windows
npm run tauri build -- --bundles dmg       # macOS
```

产物在 `desktop/src-tauri/target/release/bundle/` 下（带 `--target` 构建时是 `target/<triple>/release/bundle/`，CI 走的是后者）：

| 平台 | 文件 |
| --- | --- |
| Windows x64 | `nsis/Resume Pro Desktop_<版本>_x64-setup.exe` |
| macOS Apple Silicon | `dmg/Resume Pro Desktop_<版本>_aarch64.dmg` |

参考机（Windows 11，本机）上一次干净构建约 3 分 35 秒，安装包约 6 MB——是量级参考，不是承诺。NSIS 由 Tauri 自己下载，不用预装。

发版前先跑一遍检查——版本号、tag、打包配置：

```bash
node desktop/scripts/check-desktop-release.js desktop-v0.1.0
```

还有两道：`--dist desktop/dist` 检查前端产物里没有 sourcemap、`.env`、测试夹具；`--assets <目录>`（不带 `--write-checksums`）在发布前**复算一遍校验和**，因为构建机写的和发布机手上的是两份文件。

第一条会拦住这些：`tauri.conf.json` 与 `Cargo.toml` 版本号不一致、版本号不是 `1.2.3` 的样子、tag 与版本号对不上、`bundle` 里夹带了额外文件、`frontendDist` 指到了源码或测试目录。

上传前还有一道，CI 里跑的就是它——顺便把校验和也算了（用 Node，不依赖 `sha256sum`）：

```bash
node desktop/scripts/check-desktop-release.js --assets dist-release --write-checksums
```

它要求目录里只有安装包和**一一配套**的 `.sha256`，多一个 `.pdb`、少一份校验和都不放行。

Windows 真安装/卸载验收要从**非提升权限**的 PowerShell 运行，而且机器上不能已有安装：

```powershell
./desktop/scripts/d13_install_acceptance.ps1 `
  -Installer "./desktop/src-tauri/target/release/bundle/nsis/Resume Pro Desktop_0.1.0_x64-setup.exe"
```

要验 `vN → vN+1`，再传一个不同版本的测试安装包；脚本会在两次安装之间放入附件哨兵，
升级后逐字节核对，再用新版启动并复查 Native Messaging：

```powershell
./desktop/scripts/d13_install_acceptance.ps1 `
  -Installer "./Resume Pro Desktop_0.1.0_x64-setup.exe" `
  -UpgradeInstaller "./Resume Pro Desktop_0.1.1_x64-setup.exe"
```

脚本会真实静默安装、启动应用、核对 Chrome/Edge Native Messaging 清单、静默卸载，
并确认程序目录与注册项已清理、用户档案和一次性数据哨兵未被删除。它拒绝覆盖已有安装，
测试应用数据也放在单独临时目录中。

发版前想先试一遍构建，不必真打 tag：在 Actions 里手动触发 `Release Desktop`（`workflow_dispatch`），它照样构建、照样校验，只是不建 Release。

### 1.1 版本号与 tag

桌面和插件**各发各的**，版本号不要求一致（D01：共享的是 `protocolVersion`，不是版本号）：

| | tag | 版本号来源 | 工作流 |
| --- | --- | --- | --- |
| 浏览器插件 | `v0.4.0` | `manifest.json` | `release.yml` |
| 桌面 | `desktop-v0.1.0` | `tauri.conf.json` + `Cargo.toml` | `desktop-release.yml` |

两个命名空间不能重叠，否则一次桌面发版会顺手把插件也发出去。这条有测试盯着（`check-desktop-release.test.js`）。

### 1.2 WebView2（Windows）

安装器会先查注册表里有没有 WebView2 Runtime，有就整段跳过；没有才去微软的地址下载引导程序。Windows 11 自带，通常不会多下一次。完全离线的机器请先装微软的
[WebView2 Runtime 离线包](https://developer.microsoft.com/microsoft-edge/webview2/)，再装本程序。

---

## 2. 安装包没有签名

我们还没有代码签名证书。这意味着：

- **Windows**：SmartScreen 会拦一次，要点「更多信息 → 仍要运行」。
- **macOS**（目前只出 Apple Silicon 的包）：
  1. 在访达里右键点 DMG，选「打开」；
  2. 把 App 拖进「应用程序」；
  3. **第一次启动还要再右键点 App 选一次「打开」**——拖进去的 App 仍带着隔离属性。较新的 macOS 会把这个入口放在「系统设置 → 隐私与安全性」里的「仍要打开」。

不要去执行 `xattr -dr com.apple.quarantine` 这类命令：它降低的是整台机器的安全性，不只是这一个 App。

这不是绕过系统保护的窍门，而是未签名软件本来的样子。介意的话，请等有签名的版本，不要去关系统的安全设置。

### 2.1 核对下载到的文件

校验和与安装包放在同一个 Release 里。它能说明文件没在下载途中损坏或被替换，**不能证明发布者身份**——那要靠代码签名，我们还没有。

每个安装包旁边都有一份 `.sha256`，由 CI 在构建机上生成：

```powershell
Get-FileHash "Resume Pro Desktop_0.1.0_x64-setup.exe"    # Windows
```

```bash
shasum -a 256 "Resume Pro Desktop_0.1.0_aarch64.dmg"     # macOS
```

对不上就别装。

---

## 3. 数据放在哪

| 平台 | 求职档案（数据库、附件、备份） |
| --- | --- |
| Windows | `%LOCALAPPDATA%\ResumePro` |
| macOS | `~/Library/Application Support/ResumePro` |

安装、升级都不动这个目录里的求职档案；卸载会清掉应用自己写的 Native Messaging 清单，
但档案本身默认保留，只有用户额外勾选并再次确认才会删（见下面的「卸载」一节）。
备份与恢复的口径见 [data-privacy.md §6](data-privacy.md)。

---

## 4. 装好之后：连接浏览器

桌面程序每次启动都会核对一次 Native Messaging 注册——往 Chrome 和 Edge 各写一份 host 清单，
Windows 上还要把清单位置记进 `HKCU\Software\{Google\Chrome,Microsoft\Edge}\NativeMessagingHosts\`。
移动过安装目录、换过通道重装之后它会自己修好，不用手动折腾。

清单里的 `allowed_origins` **只写了本扩展那一个 ID**（`diagjmploldedipjdenmecmjokckelkl`），
没有通配：通配意味着机器上任何一个扩展都能启动这个 host、读到整本求职档案。

设置页的「连接浏览器」会告诉你现在缺哪一步：

| 界面说什么 | 意思 |
| --- | --- |
| 还没核对过 | 点「重试注册」，让桌面写一次清单 |
| 桌面这边准备好了 | 去浏览器里装扩展 |
| 一个都没注册上 | 先解决提示里那个原因（多半是组策略挡了注册表），装了扩展也连不上 |

**装完扩展要重新加载一次扩展或重启浏览器**：浏览器不保证立刻重读 host 清单。

## 5. 升级

下载新版本直接装，不用先卸载。数据目录原样保留。

数据库结构有变化时，桌面会在迁移**之前**自动备份一份到档案目录的 `backups/` 下，
迁移失败可以从它恢复。设置页的运行状态里会写明这次启动有没有做过迁移备份、备份在哪。
这个提示只在真正发生迁移的那一次启动出现；备份路径是进程内状态，重启后不会继续显示。

回滚步骤：设置页「备份与恢复」→ 选 `backups/` 下那份迁移备份 → 预览并确认恢复。
恢复过程会暂停当前档案写入并完成切换；恢复前应用会先把当前档案留成一个回滚点。

## 6. 卸载

卸载会删掉：程序文件、开始菜单快捷方式、Chrome 与 Edge 的 Native Messaging 注册项，
以及桌面写进数据目录的那几份 host 清单。

档案目录本身不动：只清掉应用自己写的 `nm/` 清单；申请记录、附件、待办和备份都留在原处。

**不会删**：`%LOCALAPPDATA%\ResumePro`（Windows）/ `~/Library/Application Support/ResumePro`（macOS）——
也就是你的申请记录、附件、待办和备份。

macOS 上 host 清单在 `~/Library/Application Support/{Google/Chrome, Microsoft Edge}/NativeMessagingHosts/`；
卸载只删这两份清单，档案目录原样保留。

真要一起删：在卸载器里勾上「删除应用数据」，之后会**再问一次**，问句里写着具体目录和里面
有什么。那一步不可撤销。升级和静默卸载走的也是同一个卸载器，那两种情况下既不会问、也不会删。

卸载钩子实现在 `desktop/src-tauri/installer/hooks.nsi`；「要删哪些键、哪些文件、绝对不能裸删哪个目录」由 `desktop/scripts/check-uninstall-hooks.js` 守卫。

## 7. 后台进程与系统要求

- 关掉窗口不等于退出：程序留在托盘里，为的是浏览器扩展随时能连上来保存岗位，以及到点弹提醒。
  真要退出走托盘菜单的「退出」——退出之后提醒不会响，待办还在。
- 浏览器发消息时，如果程序没在运行，系统会按 host 清单把它拉起来，不会弹出终端窗口（`cli::tests::native_messaging_mode_never_attaches_a_console` 锁住这条）。
- 最低系统版本：Windows 10 1809 或更新（需要 WebView2 Runtime）；macOS 11。

## 8. 插件怎么重载

改过扩展或换过版本之后：浏览器的扩展页 →「重新加载」，或者干脆重启浏览器。
桌面程序不用重启——host 清单的路径没变。
