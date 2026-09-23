# M2 macOS Apple Silicon 候选取得与登记

M2 只把将要验收的 DMG、插件 ZIP、源码 commit 和下载来源绑定成不可含糊的候选身份，不声称安装或业务验收已经通过。

## 当前前置状态

- 桌面 beta Release 已能同时发布 macOS DMG、Windows 安装包和同 commit 的插件 ZIP。
- 验收只使用准备冻结的最新 `desktop-v0.4.0-beta.N` 预发布；旧 beta 或 Actions 临时 artifact 不得混用。
- 桌面和插件版本均以 Release 资产及其 tag commit 为准；登记时使用 tag 指向的完整 40 位 commit。

## 1. 取得候选字节

从准备冻结的同一个 GitHub beta Release 下载全部候选。必须确认 Release 的 tag commit 与候选计划一致；不要从另一轮 workflow 或本地目录拼接文件。

下载：

- Apple Silicon `.dmg` 及其 `.sha256`；
- 同一 Release 中的 `resume-pro-plugin-<manifest 版本>.zip` 及其 `.sha256`。新工作流的插件文件名跟随 `manifest.json`，与桌面 beta 版本可以不同；早期 beta.1–beta.3 的历史资产曾用桌面 beta 版本命名，验收旧版时以该 Release 的实际文件名和包内 manifest 为准。不要混用其它 tag 的插件包，也不要再手工 `git archive`。

候选文件保存在受控制品存储，不提交到仓库。下载链接不得含账号、token、查询参数或 fragment；若 GitHub Actions artifact URL 需要登录或会过期，先复制到项目批准的稳定 HTTPS 候选存储，再登记。

## 2. 登记

明确批准当前“完整 ad-hoc 签名、无 Developer ID、未公证”策略后运行：

```bash
python3 desktop/scripts/d14_macos_acceptance_check.py prepare-candidate \
  --dmg "/path/to/Resume.Pro.Desktop_0.4.0-beta.N_aarch64.dmg" \
  --extension-zip "/path/to/resume-pro-plugin-0.4.0.zip" \
  --output "docs/desktop-mvp/acceptance/runs/<run-id>/artifacts.json" \
  --source-commit "<40 位源码 SHA>" \
  --workflow-run-url "https://github.com/TshyGO/resume-form-assistant-plugin/actions/runs/<run-id>" \
  --desktop-version "0.4.0-beta.N" \
  --extension-version "0.4.0" \
  --protocol-version "1" \
  --dmg-url "https://<稳定候选地址>/<file>.dmg" \
  --extension-url "https://<稳定候选地址>/<file>.zip" \
  --unsigned-approval "<决定人、日期与 issue/PR 链接>" \
  --registered-by "<登记人>"
```

脚本会拒绝覆盖既有 manifest，并执行：

- `hdiutil verify` 验证 DMG 容器完整性；
- 只读挂载 DMG，要求恰好一个 `.app`，并核对 `arm64`、`com.resumepro.desktop`、桌面版本和最低系统版本；
- 要求整个 App bundle 为完整 `ADHOC_SIGNED`，并通过 `codesign --verify --deep --strict`；只有链接器临时签名的旧包会被拒绝；
- 复算 DMG/ZIP 的字节数与 SHA-256；
- 验证 URL 为无凭据、无 query/fragment 的 HTTPS 地址；
- 检查插件 ZIP 没有路径穿越、重复文件、额外/缺失文件或 `D14_SYNTHETIC_*` 标记；
- 核对 manifest 版本、固定扩展 ID，并记录 manifest 与包内容树哈希；
- 固定 `platform=macos-arm64`、`buildTarget=aarch64-apple-darwin` 和 `evidencePurpose=RELEASE_CANDIDATE`。

登记后再次以原文件校验：

```bash
python3 desktop/scripts/d14_macos_acceptance_check.py verify-candidate \
  --candidate "docs/desktop-mvp/acceptance/runs/<run-id>/artifacts.json" \
  --dmg "/path/to/the-same.dmg" \
  --extension-zip "/path/to/the-same.zip"
```

## 3. M2 完成标准

- `artifacts.json.status=REGISTERED`，来源 commit、workflow run、版本、协议、URL、文件名、长度和 SHA-256 均非空。
- DMG 通过容器校验，插件 ZIP 通过发布文件集合与固定 ID 检查。
- ad-hoc/未公证状态有具名批准，不冒充 Developer ID 签名或公证。
- Chrome、Edge 和生命周期报告尚未执行，仍保持 `NOT_RUN`。
- 文件变化、重新构建或源码 commit 变化时创建新的 run，不修改旧 manifest 的哈希。
