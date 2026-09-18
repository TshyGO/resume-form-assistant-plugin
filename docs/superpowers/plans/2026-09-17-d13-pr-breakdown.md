# D13 安装与升级交付 PR 拆分计划

- **Issue：** [#29](https://github.com/TshyGO/resume-form-assistant-plugin/issues/29)（2026-09-17 重新打开）
- **基线：** `0bf72b5`（D11 合完之后的 `main`）
- **硬依赖状态：** D02 ✅、D06 ✅、D07 ✅、D12 代码已合（#28 的六条验收里五条 ✅，剩下那条 ⚠️「卸载不得自动删用户数据」正是本计划 PR 4）
- **后续：** [D14 #27](https://github.com/TshyGO/resume-form-assistant-plugin/issues/27) 端到端验收与首发门禁

一句话范围：**让一个普通 Windows 账户装上桌面程序、连上浏览器插件、升级不丢数据、卸载不删档案。** 上架商店本身归 D14 之后的发版动作，这里只把它需要的产物和材料备齐。

---

## 已核实的外部事实（实现时直接用，不必再查）

**已经真打了一次包（2026-09-17，本机 Windows 11，`npm run tauri build -- --bundles nsis`）：**

- 产物：`desktop/src-tauri/target/release/bundle/nsis/Resume Pro Desktop_0.1.0_x64-setup.exe`，5.99 MB，release 编译 3 分 35 秒。**工具链是通的，NSIS 由 Tauri 自己拉。**
- 生成的 `target/release/nsis/x64/installer.nsi` 把几件事写死了，实现时按它来：
  - per-user 模式 `RequestExecutionLevel user`，安装目录 `$LOCALAPPDATA\${PRODUCTNAME}` = `%LOCALAPPDATA%\Resume Pro Desktop`——**带空格**，host 清单里的 `path` 正好要过这一关。
  - 四个钩子宏都在：`NSIS_HOOK_PREINSTALL` / `POSTINSTALL` / `PREUNINSTALL` / `POSTUNINSTALL`，`installerHooks` 这条路可行。
  - 卸载器自带一个「删除应用数据」勾选框，但它删的是 `$APPDATA\${BUNDLEID}` 和 `$LOCALAPPDATA\${BUNDLEID}`（`com.resumepro.desktop`，WebView 的那份），**碰不到我们的 `%LOCALAPPDATA%\ResumePro`**。所以：档案默认就是安全的，而「删注册项和 host 清单」必须自己在钩子里做。
  - WebView2 默认 `downloadBootstrapper`：装之前先查 HKLM/HKCU 的 EdgeUpdate 键，已有就整段跳过，没有才去 `go.microsoft.com` 下。Win11 自带，不会多下一次（Q4 的依据）。

**打包现状：**

- `desktop/src-tauri/tauri.conf.json`：`productName` = `Resume Pro Desktop`，`identifier` = `com.resumepro.desktop`，`version` = `0.1.0`，`bundle.targets` = `"all"`，Windows NSIS `installMode: currentUser`，macOS `minimumSystemVersion: 11.0`。
- **CI 从来没有构建过安装包。** `.github/workflows/desktop.yml` 只跑 per-crate 测试；`release.yml` 只在 `v*.*.*` tag 上打**插件** ZIP，版本号取自 `manifest.json`。
- 三处版本号互不相干：`manifest.json` `0.4.0`（插件）、`tauri.conf.json` `0.1.0`、`src-tauri/Cargo.toml` `0.1.0`。D01 说插件与桌面共享 `protocolVersion`、版本号不要求相等——**但 tag 命名空间必须分开**，否则桌面的 tag 会触发现有的插件 release。

**扩展 ID 已经固定，这是本轮最大的简化：**

- `manifest.json` 里有 `key`（commit `462f548` 写进去的商店公钥），所以**本地 unpacked 和商店版是同一个 ID**：`diagjmploldedipjdenmecmjokckelkl`。用那段公钥算 SHA-256 前 16 字节映射 a–p，结果和商店里那条一模一样，已核对。
- 因此 host 清单的 `allowed_origins` 只需要写死一条 `chrome-extension://diagjmploldedipjdenmecmjokckelkl/`，产品里「到桌面粘贴 32 位扩展 ID」这一步可以删掉（开发模式的额外 ID 仍要能加）。

**Native Messaging 现状：**

- host 就是同一个可执行文件：`cli.rs` 扫 argv，看到 `chrome-extension://` 开头的 origin（或 `--nm-host`）就进 stdio host 模式。清单没有 `args` 字段可用，所以 `path` 必须是安装后 exe 的绝对路径。
- `desktop/scripts/nm-dev-register.mjs` 已经把语义趟通了：Chrome/Edge 两条 HKCU 注册表路径、macOS 两个用户级目录、`manifestFor()` 生成清单、**receipt 机制**（不覆盖别人写的清单；卸载按回执还原而不是按名字删）。这套语义直接搬进 Rust，脚本本身保留给开发用。
- `RuntimeStatus.nativeMessagingRegistered` 现在是硬编码 `false`（`lib.rs:247`、`lib.rs:333`），界面上写着「未注册，属 D06/D13」。
- **Edge 也必须写。** Edge 用户可以从 Chrome 商店装这个扩展（「允许来自其他应用商店的扩展」），那时扩展跑在 Edge 里，只注册 Chrome 路径会连不上（#29 评论，2026-09-12）。

**已经拍过板的产品决定（#29 评论，2026-09-12 实测）：**

- **不做静默安装。** 写 `HKCU\...\Extensions\<id>` 让浏览器自动装扩展，在 Edge 149 与 Chromium 1223 上实测**完全没反应**；微软文档指向 HKLM，用户态拿不到。桌面改为提供「连接浏览器」按钮打开商店页，由用户点「添加至 Chrome」。`tauri-plugin-opener` 已经在依赖里并且初始化过了（`lib.rs:1103`）。

**数据位置（卸载时一个字节都不能碰）：**

- Windows `%LOCALAPPDATA%\ResumePro`，macOS `~/Library/Application Support/ResumePro`（`data-service/src/paths.rs`，`DATA_DIR_NAME = "ResumePro"`）。备份默认也在档案目录下的 `backups/`。

**D12 转过来的那条验收：** 「不会因程序卸载而自动删除用户备份或数据」——#28 里标着 ⚠️「文档已写，落实在 D13」。

**上架前置清单**（#29 评论）：`<all_urls>` 收敛、`web_accessible_resources` 收敛、`tabs` 权限、数据用途声明 + 可公开访问的隐私政策页、列表材料。**扩展 ID 已由 `manifest.json` 的公钥固定**：本地 unpacked 与 Chrome 商店版是同一个 ID（已用公钥算出的 ID 与商店 item 核对一致），原先担心的 `chrome.storage.local` 迁移问题不再存在，不需要为上架单独做插件设置的导出/导入。

---

## 架构决策

### 已定（PR 内落地；反对请在对应 PR 评论提）

1. **只做 NSIS per-user，不出 MSI。** D01 §4.5 的推荐；求职者个人机，MSI/WiX 的测试矩阵不值得。
2. **NM 注册由应用在启动时写并自愈，安装器只负责卸载时清理。** 安装器写的话，用户移动安装目录、从压缩包直接跑、或者换个通道重装，清单里的 `path` 就指向不存在的文件；应用每次启动核对一次能自己修好。这也让开发、便携、正式三种情况共用同一套代码。
3. **`allowed_origins` 默认只有商店那一条 ID。** 开发模式加的 ID 单独存，写清单时合并，正式默认值里不出现。任何情况下都不写通配。
4. **不做静默更新。** 首发只做「检查有没有新版本 → 说清楚版本号和下载地址 → 用户自己装」。
5. **未签名如实说。** Windows SmartScreen 与 macOS Gatekeeper 的提示原样写进发布说明；macOS 只写 Apple 自己的「右键打开」路径，不教用户关安全设置，也不宣传「已签名」。
6. **卸载默认保留档案目录。** 删数据要在卸载器里额外勾一次，文案写明删的是哪个目录、里面是什么。
7. **tag 命名空间分开：** 桌面 `desktop-v*`，插件继续 `v*.*.*`。`release.yml` 不动，另开一个 workflow。

### 需负责人确认（开工前拍板；未拍板按「推荐」执行）

- **Q1 首发平台。** 推荐 Windows x64 + macOS Apple Silicon 都出包，macOS 明确标「未签名未公证」。只做 Windows 也行（这是 V7 写好的降级路径），但 D01 修订说过「Mac 承诺不能只停在口头」。
- **Q2 更新检查做到哪一步。** 推荐最小版：关于页一个「检查更新」按钮 + 每天最多一次的后台检查（可关），只提示不下载。不做的话首发就是纯手动，用户不会知道有新版。
- **Q3 插件设置的导出/导入（已核实，不需要）。** 结论：`manifest.json` 的公钥把扩展 ID 固定成 `diagjmploldedipjdenmecmjokckelkl`，本地 unpacked 与 Chrome 商店版是同一个 ID，不会因为上架而丢 `chrome.storage.local`。因此不再把它列为上架前置；如果以后改公钥或换商店，再按新 ID 重新评估。
- **Q4 WebView2 分发方式。** 推荐 Tauri 默认的 `downloadBootstrapper`（安装包小，Win11 自带 Runtime 时不下载）。离线机器在发布说明里给微软官方离线包链接。这条对应 V6。

---

## File Structure

```
desktop/src-tauri/src/
  nm_register.rs          新：生产环境的 host 清单注册与自愈（Windows 注册表 + macOS 目录）
  nm_register_tests.rs    新：路径、清单内容、回执、自愈的回归
  lib.rs                  改：启动时注册、nativeMessagingRegistered 变真值、新命令
desktop/src-tauri/
  tauri.conf.json         改：版本号来源、NSIS 钩子、WebView2 安装方式
  installer/
    hooks.nsi             新：卸载钩子（删注册项与清单，默认保留档案）
desktop/src/
  pairing-form.ts         改：固定 ID 之后不再强制粘贴，改成「连接浏览器」
  update-check.ts         新：更新检查的纯逻辑（版本比较、提示文案）
.github/workflows/
  desktop-release.yml     新：desktop-v* tag → 构建未签名安装包 + SHA-256 + Release
docs/desktop-mvp/
  install-and-update.md   新：发布说明与安装、升级、回滚、卸载、插件重载
```

---

## PR 1 · 构建与产物口径

**只做：** 让「一条命令构建出可分发的安装包，并且 CI 也能构建出同样的东西」这件事成立。**不改应用行为。**

**改动：** `desktop-release.yml`（`desktop-v*` tag 触发，Windows x64 必出，macOS 按 Q1；产物带 SHA-256 清单，Release 说明里写明未签名）；版本号单一来源（`tauri.conf.json` 与 `Cargo.toml` 对齐，tag 与版本号不一致就让 workflow 失败，照抄 `release.yml` 里插件那条校验的写法）；`install-and-update.md` 先落一节「可复现构建命令」。

**测试：** tag 与版本号不一致时 workflow 失败（用一个能本地跑的校验脚本 + 它的单测，别把逻辑埋在 YAML 里）；产物清单里不含 `.pdb`、测试夹具、开发 profile；SHA-256 由 workflow 自己算并贴进 Release。

**验收关联：** #29「本地和 CI 都有可复现构建命令与 SHA-256 校验信息」「安装包、ZIP 不含真实简历、密钥、测试数据、调试 profile」。

---

## PR 2 · 生产环境的 Native Messaging 注册

**只做：** 应用启动时把 host 清单写对、写全、写到两个浏览器，并且能自愈。**不碰界面。**

**改动：** `nm_register.rs`：Windows 写 `%LOCALAPPDATA%\ResumePro\nm\<browser>-com.resumepro.desktop.json` 并把路径写进 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.resumepro.desktop` 与 Edge 对应键；macOS 写 `~/Library/Application Support/{Google/Chrome,Microsoft Edge}/NativeMessagingHosts/`。清单内容照 `manifestFor()`：`name`/`description`/`path`（当前可执行文件的绝对路径）/`type: stdio`/`allowed_origins`。沿用回执语义：**不覆盖不是自己写的清单**，回执记下被替换的内容。启动时核对一次，`path` 指向不存在的文件或指向别的目录就重写。`RuntimeStatus.native_messaging_registered` 改成真值，顺带报出「写到哪几个浏览器」「上次失败的原因」。新增 `register_native_messaging_cmd`（手动重试用）。

**测试：** 清单内容与 `allowed_origins` 精确匹配（只有商店那条 ID，没有通配）；路径含空格和中文时仍是合法 JSON 且能被解析回来；别人写的同名清单不被覆盖（回执里记着「没动」）；`path` 失效时自愈重写；注册表写失败（权限被策略限制）时返回可读原因而不是 panic；macOS 与 Windows 两套路径都在各自 runner 上跑。

**验收关联：** #29「注册 Chrome/Edge native host manifest 与允许的扩展 ID，不用通配来源」「应用/host 路径含空格或中文时可启动」「旧 host 注册不残留指向不存在文件」。

---

## PR 3 · 「连接浏览器」与配对收口

**只做：** 把「粘贴 32 位 ID」从正常路径里拿掉，换成一个按钮。

**改动：** 配对页改成：① 一句话说明「桌面和插件要连上才会同步」②「连接浏览器」按钮（`opener` 打开商店页）③ 连接状态（用 PR 2 的真值：清单写了没有、扩展握过手没有）④ 折叠起来的「开发模式：手动添加扩展 ID」入口。握手版本不兼容时给出可诊断的话：双方版本号、该升哪一个。配对成功后按 V3 的结论提示「重载扩展或重启浏览器」。

**测试：** 纯逻辑（状态 → 文案）走 `node --test`；界面走 Vitest；未连接、清单没写、扩展没装、版本不兼容四种状态各有各的话；开发模式加的 ID 不会写进正式默认值。

**验收关联：** #29「开发模式 ID 不稳定时提供明确安全的开发注册流程，不修改正式 allowlist 接受任意扩展」；V3。

---

## PR 4 · 卸载、升级与数据安全

**只做：** 装了能卸干净，卸了不丢档案，升级不丢数据。

**改动：** NSIS 卸载钩子（`installer/hooks.nsi`，`tauri.conf.json` 里 `nsis.installerHooks` 指过去）：删两个浏览器的注册表项与清单文件、删快捷方式与程序目录；**默认保留 `%LOCALAPPDATA%\ResumePro`**；卸载器上加一个默认不勾的「同时删除我的求职档案」，勾了才删，文案写明目录路径和里面有什么。升级：保留数据目录；**迁移之前先调 D12 的备份**（`archive-store` 的迁移已经会自动备份，这里要把「升级」这条路径也接上并在界面上说一声）；不兼容的旧 host 注册在 PR 2 的自愈里已经处理。

**测试：** 卸载钩子的脚本本身用一个能本地跑的校验（NSIS 脚本没法单测，那就把「要删哪些键、哪些文件、不删哪些目录」做成一份清单 + 守卫测试，像 D12 的 `exclude.rs` 那样）；升级路径：旧版本目录 + 新版本二进制 → 迁移前有备份、迁移后计数一致；「删数据」没勾时档案目录仍在。

**验收关联：** #29「卸载移除本应用注册项、快捷方式和程序文件，默认保留求职档案；删除数据必须独立明确确认」「vN 升级至 vN+1 后原数据与附件可用；失败有恢复路径」「卸载/重装不丢数据」；#28 那条 ⚠️。

---

## PR 5 · 更新检查（按 Q2）

**只做：** 告诉用户有新版本，给下载地址。**不下载、不安装、不静默。**

**改动：** `update-check.ts`（纯逻辑：版本比较、上次检查时间、文案）+ 一个 Rust 命令去取 Release 的 `latest`（只读，失败就安静退回）；关于页一个「检查更新」按钮；每天最多一次的后台检查，设置里能关。

**测试：** 版本比较（相等、更新、更旧、脏版本号）；离线/超时/接口变形时不打扰用户也不刷屏日志；「今天已经查过」不会重复查；关掉之后一次都不查。

**验收关联：** #29「首版更新可采用『检查并提示用户下载、手动安装』，不强行实现静默更新」。

---

## PR 6 · 发布说明、文档与商店材料

**只做：** 把用户和审核员要看的东西写出来。

**改动：** `docs/desktop-mvp/install-and-update.md`：后台进程是什么、最小系统版本、要哪些权限、数据存在哪、怎么升级怎么回滚、插件怎么重载、未签名会看到什么提示、SHA-256 怎么核对。插件侧的上架收敛（#29 评论那四条）：`host_permissions`/`content_scripts` 的 `<all_urls>` 能不能换成 `activeTab` + `optional_host_permissions`，不能就写出理由；`web_accessible_resources` 收到真正需要暴露的那几个；`tabs` 权限能去就去；隐私政策页（仓库里一页 Markdown + GitHub Pages 链接即可）。

**测试：** 收敛之后插件的既有测试全绿（`tests/*.test.js`）；`check-plugin-release-allowlist.js` 跟着更新；文档里写的路径与代码里的常量对得上（加一条守卫测试，别让文档自己漂）。

**验收关联：** #29「发布说明解释后台进程、最小系统版本、权限、数据位置、升级/回滚和插件重载方法」；上架前置清单。

---

## 验收对照表（写 PR 描述时直接引用）

| #29 验收 | 落在哪 | 证据形式 |
| --- | --- | --- |
| 干净 Windows 普通账户走完「装主程序→装插件→确认连接→保存岗位」 | PR 2、PR 3 + 人工走查 | 自动化只能到「清单写对了」，整条链路必须人工跑一遍 |
| 主界面未打开时按需启动通信服务，不弹终端窗口 | PR 2（D06 已实现按需启动，这里只验证安装后的路径） | 人工走查 + 清单 `path` 指向正确二进制的测试 |
| vN → vN+1 数据与附件可用，失败有恢复路径 | PR 4 | 升级夹具测试 + 迁移前备份 |
| 卸载/重装不丢数据；旧 host 注册不残留 | PR 2、PR 4 | 卸载清单守卫 + 自愈测试 |
| 安装包不含简历、密钥、测试数据、调试 profile | PR 1 | 产物清单守卫 |
| 可复现构建命令与 SHA-256 | PR 1 | workflow 产出 + 文档 |

---

## 风险

**装出来的东西只能靠人工验。** 单测能保证清单内容和卸载清单，保证不了「双击安装包之后真的能用」。干净虚拟机里的走查是 D13 关闭的硬条件，做不了自动化就老实写进 issue，别拿测试数量充数。

**未签名的第一印象。** SmartScreen 的蓝色拦截页会让相当一部分用户直接放弃。这是既定代价（没有签名证书），但发布说明要写在最前面，而不是藏在末尾。

**商店身份迁移风险已解除，但发布动作尚未完成。** 公钥固定让本地与商店版共用同一个 ID，`chrome.storage.local` 不会因为上架而丢；公开隐私政策使用 <https://github.com/TshyGO/resume-form-assistant-plugin/blob/main/docs/privacy-policy.md>。商店 item 仍是 Draft，提交审核与审核结果属于尚未完成的发布动作。若以后更换公钥或改用另一家商店，再按新 ID 重新评估迁移。

**D14 卡在人工走查上，不是卡在代码上。** D11 和 D10 的真机走查都还欠着（真实 Key、断网、提示注入、两个平台的凭据库、提醒调度）。D13 做完也关不掉 D14。

**平台矩阵。** V7（Windows ARM64、macOS Intel）按降级路径收缩为 Win x64 + Apple Silicon；V11（公证）没有条件，只能如实说明。这两条不要在实现里悄悄扩大。
