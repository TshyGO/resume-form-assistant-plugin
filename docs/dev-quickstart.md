# 开发期拉起 SOP（Windows / macOS）

功能和界面测试用这份，**不需要打包、不需要安装、不需要等商店过审**。插件是零构建的，桌面端用 `tauri dev` 跑源码。

## 什么时候不能用这份

要验证**安装、升级、卸载、生产注册、SmartScreen / Gatekeeper、WebView2 依赖**这些行为时，dev 模式一律不作数，走 [#39](https://github.com/TshyGO/resume-form-assistant-plugin/issues/39) 的候选安装包验收流程。dev 注册脚本自己也写着：生产安装、正式扩展 ID 注册与卸载属于 D13，它不是安装器。

分界线很简单：**测产品做什么，用 dev；测产品怎么装进来的，用安装包。**

## 一次性准备

| | Windows | macOS |
| --- | --- | --- |
| Node | 22（与 CI 一致） | 22 |
| Rust | 1.94.0 | 1.94.0 |
| 平台依赖 | MSVC 生成工具、WebView2 Runtime（Win11 自带） | Xcode Command Line Tools |

```bash
cd desktop
npm ci
```

## 每次拉起：四步

### 1. 起桌面端

```bash
cd desktop
npm run desktop:dev
```

Windows 上如果报 `EACCES 127.0.0.1:1420`，看下面「端口被系统占了」。

前端改动热更新，**改了 Rust 代码会自动重编**，等它编完再操作。

### 2. 装插件

插件**零构建**：不用 npm、不用打包、不用等商店过审，直接把仓库目录加载进去就行。

| | Chrome | Edge |
| --- | --- | --- |
| 扩展管理页 | `chrome://extensions` | `edge://extensions` |
| 开发者模式开关 | 页面右上角 | 左侧栏底部 |
| 加载按钮 | 「加载已解压的扩展程序」 | 「加载解压缩的扩展」 |

选择的目录是**仓库根目录**，也就是 `manifest.json` 所在那一层：

```text
<仓库根目录>/          ← 选这里
├── manifest.json
├── content.js
├── popup.html
├── link/
├── desktop/           ← 不是这里
└── docs/
```

选错成 `desktop/` 或某个子目录会提示找不到 manifest。

两个浏览器可以同时装，注册脚本默认两边都写，互不干扰。

**扩展 ID 是固定的。** `manifest.json` 里带了 `key` 字段，ID 由它算出来，恒等于：

```text
diagjmploldedipjdenmecmjokckelkl
```

和 Chrome 商店那份一致。换机器、换 Profile、删了重装、目录换个位置，都不会变——所以第 3 步的注册命令可以照抄，不用每次去扩展页抄 ID。

**建议用独立的浏览器 Profile**（Chrome 的「添加」新用户，或命令行 `--user-data-dir=<任意空目录>`），别装在日常用的 Profile 上：插件用 `chrome.storage.local` 存模板和队列，测试数据和你自己的真实档案混在一起不好收拾。

**卸载**就在扩展管理页点「移除」。dev 加载的扩展不会从 GitHub 自动更新。

### 3. 注册连接

```bash
cd desktop
node scripts/nm-dev-register.mjs register --extension-id diagjmploldedipjdenmecmjokckelkl
```

默认同时注册 Chrome 和 Edge，默认指向 `src-tauri/target/debug/` 下的二进制——正好是 `tauri dev` 在跑的那个，不用传 `--binary`。

只要一个浏览器就加 `--browser chrome` 或 `--browser edge`。

### 4. 重新加载扩展

在扩展管理页点一次「重新加载」，或重启浏览器。**不做这步新写的注册不生效**，会表现成「装了但连不上」。

## 确认连上了

- 插件侧边栏出现「保存岗位到本地」和「确认已投递」；
- 桌面窗口能看到数据进来；
- 桌面端设置页的「Native Messaging」一项显示已注册。

桌面窗口关着也没关系——插件发的第一条消息会把 host 进程唤起来。

## 改了代码怎么生效

| 改了哪里 | 怎么生效 |
| --- | --- |
| `desktop/src/`、`desktop/index.html` | vite 热更新，存盘即可 |
| `desktop/src-tauri/`、`desktop/crates/` | `tauri dev` 自动重编并重启应用，等它编完 |
| `popup.*`、`background.js`、`link/` | 扩展管理页点「重新加载」 |
| `content.js`、`content.css` | 「重新加载」之后，**还要刷新被注入的那个网页**，已打开的标签页用的仍是旧脚本 |
| `manifest.json` | 「重新加载」。**不要改 `key` 字段**——ID 会跟着变，连接注册立刻失效 |

## 收尾（重要）

```bash
cd desktop
npm run nm:unregister
```

**测完必须清掉。** 正式验收的环境预检会把「机器上存在 NM 注册项」判成 blocker，不清掉以后跑真机验收会被直接拦下。

`unregister` 按 receipt 里的内容摘要删，只删自己写的那份；注册前那里本来有别人的注册，它会恢复原值而不是删键。

## 常见问题

### 端口被系统占了（Windows 特有）

现象：`error when starting dev server: Error: listen EACCES: permission denied 127.0.0.1:1420`

原因是 Hyper-V / WinNAT 把一整段端口保留了，vite 又配了 `strictPort: true`。查一下 1420 是不是落在保留段里：

```bash
netsh interface ipv4 show excludedportrange protocol=tcp
```

**不改仓库文件的绕法**，换个没被保留的端口跑：

```bash
npx tauri dev --config '{"build":{"beforeDevCommand":"npm run dev -- --port 5173","devUrl":"http://localhost:5173"}}'
```

（PowerShell 里把外层单引号换成双引号、内层双引号转义。）

想一劳永逸就以管理员身份重启 WinNAT 释放保留段（`net stop winnat` / `net start winnat`），但重启机器后可能又被占上。

macOS 没这个问题。

### 「开始解析」直接失败

简历解析走 AI（`ai-worker.js` 的 `PARSE_RESUME`），弹窗里得先配好 API Key。解析入口接受 `.pdf`、`.docx`、`.txt`。

### 扩展 ID 对不上

正常情况下不会——`manifest.json` 有 `key`，ID 是从它算出来的。如果真对不上，说明加载的不是仓库根目录。

### 改了协议校验器没生效

`link/protocol/` 是 `desktop/crates/protocol/js/` 的副本。改源文件后要重新复制过去，`tests/protocol-vendor.test.js` 锁死两边一致。

## 平台差异一览

| | Windows | macOS |
| --- | --- | --- |
| 拉起命令 | 相同 | 相同 |
| 注册命令 | 相同 | 相同 |
| 二进制 | `target/debug/resume-pro-desktop.exe` | `target/debug/resume-pro-desktop` |
| 清单写到 | `%LOCALAPPDATA%\ResumePro\dev-nm\<浏览器>-com.resumepro.desktop.json` | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.resumepro.desktop.json`（Edge 同理） |
| 额外指针 | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.resumepro.desktop` 及 Edge 对应键 | 无 |
| receipt | `%LOCALAPPDATA%\ResumePro\dev-nm\receipt.json` | `~/Library/Application Support/ResumePro/dev-nm/receipt.json` |
| 端口坑 | 可能撞上 WinNAT 保留段 | 无 |

## 相关文档

- 开发期 Native Messaging 注册的细节与安全边界：[`desktop/DEV-NATIVE-MESSAGING.md`](../desktop/DEV-NATIVE-MESSAGING.md)
- 真机验收（要安装包，不用这份 SOP）：[#39](https://github.com/TshyGO/resume-form-assistant-plugin/issues/39)、[#132](https://github.com/TshyGO/resume-form-assistant-plugin/issues/132)、[#133](https://github.com/TshyGO/resume-form-assistant-plugin/issues/133)
