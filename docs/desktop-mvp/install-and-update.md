# 桌面端的构建、安装与升级

面向两类读者：要自己构建的人（第 1 节），和拿到安装包的用户（第 2 节起）。
本文随 [D13 #29](https://github.com/TshyGO/resume-form-assistant-plugin/issues/29) 一起长出来，先落构建与发布口径，安装、升级、卸载的细节随后续 PR 补齐。

---

## 1. 自己构建

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

它会拦住这些：`tauri.conf.json` 与 `Cargo.toml` 版本号不一致、版本号不是 `1.2.3` 的样子、tag 与版本号对不上、`bundle` 里夹带了额外文件、`frontendDist` 指到了源码或测试目录。

上传前还有一道，CI 里跑的就是它——顺便把校验和也算了（用 Node，不依赖 `sha256sum`）：

```bash
node desktop/scripts/check-desktop-release.js --assets dist-release --write-checksums
```

它要求目录里只有安装包和**一一配套**的 `.sha256`，多一个 `.pdb`、少一份校验和都不放行。

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

安装、升级、卸载都不动这个目录（卸载时要删得另外明确勾选，见后续 PR）。
备份与恢复的口径见 [data-privacy.md §6](data-privacy.md)。
