# T4 Windows Chrome / Edge 安装闭环

T4 只接受 **D13 候选安装包 + 候选插件 ZIP + 真实 Chrome/Edge + 安装后的生产注册**。源码目录、开发注册脚本、Playwright 自带 Chromium、直接运行 `target/release` 二进制都只能作为补充诊断，不能把 J01–J08 改成 `PASS`。

## 当前前置状态

- D13 实现 PR #116–#122、#126 已合入 `main`，但仓库尚无 `desktop-v*` Release，`desktop.yml` 也不上传安装包 artifact。
- 因此必须先从同一源码 commit 生成并保存候选 NSIS 安装包与插件 ZIP，提供不会变化的下载地址，再开始本清单。
- D11/D13 的人工真机项仍在 #128；这些依赖证据未签收时，T4 即使局部通过也不能放行首发。

## 1. 准备隔离环境和候选字节

使用可回滚的干净 Windows x64 VM 或备用机、普通非管理员账户、正式版 Chrome 和 Edge。不要在含真实求职档案或日常浏览器 Profile 的环境执行。

从候选存储下载安装包和 ZIP 后运行：

```powershell
python desktop/scripts/d14_acceptance_check.py prepare `
  --installer "C:\candidate\Resume Pro Desktop_0.1.0_x64-setup.exe" `
  --extension-zip "C:\candidate\resume-pro-v0.4.0.zip" `
  --run-dir "docs\desktop-mvp\acceptance\runs\2026-09-19-rc1" `
  --source-commit "<40 位源码 SHA>" `
  --desktop-version "0.1.0" `
  --desktop-url "<候选安装包下载地址>" `
  --extension-url "<候选 ZIP 下载地址>"
```

脚本会：

- 复算两个产物的 SHA-256 和字节数；
- 要求插件 ZIP 与发布 allowlist 完全一致、固定公钥导出的 ID 为 `diagjmploldedipjdenmecmjokckelkl`、且不含 `D14_SYNTHETIC_*`；
- 记录 Windows、Chrome、Edge、WebView2、时区和标准用户身份；
- 分别创建 `chrome/report.json` 与 `edge/report.json`，所有 case 保持 `NOT_RUN`。

任何重建都会改变哈希，必须创建新 run，不能覆盖旧证据。

## 2. 安装和生产注册

1. 通过普通用户可见的安装入口安装候选 NSIS；记录安装提示、未签名状态、安装目录和是否出现意外提权。
2. 解压候选 ZIP；Chrome 与 Edge 分别以该目录加载扩展。禁止改动解压内容。正式版 Chrome 137+ 不再支持 `--load-extension`，须在专用隔离 Profile 的 `chrome://extensions` 中人工“加载已解压的扩展程序”；后续烟测会核对该 Profile 的固定 ID、版本和目录。
3. 启动桌面程序一次，让产品自身写入并自愈 Native Messaging 注册；不要用 `nm-dev-register.mjs`。
4. 记录安装后的可执行文件绝对路径，然后分别执行：

```powershell
python desktop/scripts/d14_acceptance_check.py inspect-installed `
  --run-dir "docs\desktop-mvp\acceptance\runs\2026-09-19-rc1" `
  --browser chrome `
  --installed-exe "$env:LOCALAPPDATA\Resume Pro Desktop\resume-pro-desktop.exe" `
  --installer "C:\candidate\Resume Pro Desktop_0.1.0_x64-setup.exe" `
  --extension-zip "C:\candidate\resume-pro-v0.4.0.zip"

python desktop/scripts/d14_acceptance_check.py inspect-installed `
  --run-dir "docs\desktop-mvp\acceptance\runs\2026-09-19-rc1" `
  --browser edge `
  --installed-exe "$env:LOCALAPPDATA\Resume Pro Desktop\resume-pro-desktop.exe" `
  --installer "C:\candidate\Resume Pro Desktop_0.1.0_x64-setup.exe" `
  --extension-zip "C:\candidate\resume-pro-v0.4.0.zip"
```

检查器要求两个 HKCU 注册项都存在、清单 `path` 精确指向安装目录、`type=stdio`，并且 `allowed_origins` 只有固定商店 ID。它不会把 J01 自动标成通过，因为“无终端闪窗、安装文案、实际点击路径”仍需人看。

## 3. 安装后真实浏览器烟测

安装 Python Playwright 1.58.0 和对应浏览器驱动后，对两个浏览器分别执行。`--extension-dir` 必须是上述 ZIP 的原样解压目录：

```powershell
python desktop/scripts/d14_acceptance_check.py installed-smoke `
  --run-dir "docs\desktop-mvp\acceptance\runs\2026-09-19-rc1" `
  --browser chrome `
  --installed-exe "$env:LOCALAPPDATA\Resume Pro Desktop\resume-pro-desktop.exe" `
  --extension-zip "C:\candidate\resume-pro-v0.4.0.zip" `
  --extension-dir "C:\candidate\extension" `
  --browser-profile "C:\candidate\chrome-profile"

python desktop/scripts/d14_acceptance_check.py installed-smoke `
  --run-dir "docs\desktop-mvp\acceptance\runs\2026-09-19-rc1" `
  --browser edge `
  --installed-exe "$env:LOCALAPPDATA\Resume Pro Desktop\resume-pro-desktop.exe" `
  --extension-zip "C:\candidate\resume-pro-v0.4.0.zip" `
  --extension-dir "C:\candidate\extension"
```

此烟测使用临时 Profile 与临时合成档案，但不覆盖生产注册：真实浏览器通过安装后的 host 完成握手、保存岗位、绑定、确认投递，并确认队列清空。结果写入各浏览器的 `installed-smoke.json`。它只作为 J01/J03 的机器证据之一，不自动修改 case 状态。

`war_browser_check.py`、`d07_browser_check.py`、`d08_browser_check.py` 支持 `--browser chromium|edge --extension-dir <候选解压目录>`；其中 Chromium 是 Chrome for Testing，不是正式版 Chrome。它们会使用隔离的开发注册或临时二进制，适合补充回归，不能替代上面的生产注册烟测。

## 4. J01–J08 人工清单（Chrome、Edge 各一份）

每一步都在对应 `report.json` 记录 expected、actual、evidence 和 defect。截图只证明界面；数据结果需引用烟测 JSON、档案查询、附件哈希或备份清单。

| Case | 实际用户操作 | 必查证据 |
| --- | --- | --- |
| J01 | 安装桌面、加载候选 ZIP、关闭主界面后由浏览器连接 | 安装路径、两份生产注册、固定 ID、握手、无终端闪窗；先装插件/先装桌面各一次；中文/空格路径另列 run |
| J02 | 桌面服务真正不可用时保存岗位并用 v1 填写留档；改 v2，重启 SW/浏览器，再恢复 | 只补传一次、历史仍是 v1、完整 ACK 前 IDB 原字节存在；仅关闭窗口不算离线 |
| J03 | 填写后查看阶段，再明确确认投递，随后改模板 | 填写不自动投递；确认才写事件；历史快照不变 |
| J04 | 导入回执/测评/面试，预览、分析、暂存、重启、修改、确认两次 | 原件可回看；确认前正式字段不变；确认原子幂等；ATS 自动面试不标人工回复 |
| J05 | 同公司 A/B 的模糊通知人工选 B、修改建议、再分析；Offer 后补录旧测评 | 不自动误选；只更新批准对象；模型建议/最终决定/原件/时间线可追溯；Offer 不回退 |
| J06 | 建待办并重启/休眠；备份后恢复新库，再恢复同一备份，连接旧队列插件 | 时间/附件/快照/顺序一致；每次新 epoch；旧队列暂停对账，不自动重放 |
| J07 | 从可追溯旧候选升级；测试兼容/不兼容插件；默认卸载后重装 | 迁移前备份；数据附件可读；不兼容拒绝写入且有诊断；只清本应用注册；默认保留档案 |
| J08 | 卸载桌面后继续用同一扩展填写 | 填写可用；提示准确；未安装/从未配对不积累长期离线队列 |

J04/J05 的真实 AI 走查如果需要 API Key，应引用 #128 会话 C 的独立证据；Key 不进入报告、截图或抓包。

## 5. 完整性检查

工作过程中可运行非完成门禁，检查哈希、字段、注册和状态语义：

```powershell
python desktop/scripts/d14_acceptance_check.py verify `
  --run-dir "docs\desktop-mvp\acceptance\runs\2026-09-19-rc1" `
  --installer "C:\candidate\Resume Pro Desktop_0.1.0_x64-setup.exe" `
  --extension-zip "C:\candidate\resume-pro-v0.4.0.zip"
```

具名审阅人确认 Chrome 与 Edge 的 J01–J08 都有真实证据并设为 `PASS` 后，再运行：

```powershell
python desktop/scripts/d14_acceptance_check.py verify `
  --run-dir "docs\desktop-mvp\acceptance\runs\2026-09-19-rc1" `
  --installer "C:\candidate\Resume Pro Desktop_0.1.0_x64-setup.exe" `
  --extension-zip "C:\candidate\resume-pro-v0.4.0.zip" `
  --require-complete
```

`BLOCKED`、`NOT_RUN`、缺下载地址、缺版本、缺证据、注册未核实、产物哈希变化都会使完成门禁失败。
