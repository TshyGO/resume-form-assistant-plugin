# M2 macOS Apple Silicon 候选取得与登记

M2 只把将要验收的 DMG、插件 ZIP、源码 commit 和下载来源绑定成不可含糊的候选身份，不声称安装或业务验收已经通过。

## 当前前置状态

- 2026-09-20 只读核对远端 `main` 为 `ad565e5ae96d562ce70dd205ad3023c0f6b7e2ad`。
- 远端没有 `desktop-v*` 标签或桌面 Release。存在一轮成功的旧分支手动运行 [#35291751037](https://github.com/TshyGO/resume-form-assistant-plugin/actions/runs/35291751037)，但它绑定 `5c1b289898d542830b7bdc456a78fb4c8aedcc0e`，不是当前 `main`，且 artifact 下载需要登录，因此不能登记为本轮候选。
- `.github/workflows/desktop-release.yml` 已包含 `macos-15`、`aarch64-apple-darwin` 和 `dmg` 构建；手动 `workflow_dispatch` 会上传 `macos-arm64` artifact，但不会创建 Release。
- 桌面版本为 `0.1.0`，插件 manifest 版本为 `0.4.0`。实际登记仍以被测源码 commit 和下载文件为准。

## 1. 取得候选字节

在 GitHub Actions 中对准备验收的 commit 手动运行 `Release Desktop`。必须确认运行页面显示的 commit 与候选计划一致；不要从另一个 workflow run 拼接 DMG。

下载：

- `macos-arm64` artifact 中唯一的 `.dmg` 及其 `.sha256`；
- 同一源码 commit 按 `.github/workflows/release.yml` 的精确 `git archive` 文件清单生成的插件 ZIP。

候选文件保存在受控制品存储，不提交到仓库。下载链接不得含账号、token、查询参数或 fragment；若 GitHub Actions artifact URL 需要登录或会过期，先复制到项目批准的稳定 HTTPS 候选存储，再登记。

## 2. 登记

明确批准当前未签名、未公证策略后运行：

```bash
python3 desktop/scripts/d14_macos_acceptance_check.py prepare-candidate \
  --dmg "/path/to/Resume Pro Desktop_0.1.0_aarch64.dmg" \
  --extension-zip "/path/to/resume-pro-v0.4.0.zip" \
  --output "docs/desktop-mvp/acceptance/runs/2026-09-20-macos-rc1/artifacts.json" \
  --source-commit "<40 位源码 SHA>" \
  --workflow-run-url "https://github.com/TshyGO/resume-form-assistant-plugin/actions/runs/<run-id>" \
  --desktop-version "0.1.0" \
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
- 记录实际 `codesign` 类型及严格校验结果；`adhoc/linker-signed` 仍按未签名发布策略处理，不能写成 Developer ID 签名或已公证；
- 复算 DMG/ZIP 的字节数与 SHA-256；
- 验证 URL 为无凭据、无 query/fragment 的 HTTPS 地址；
- 检查插件 ZIP 没有路径穿越、重复文件、额外/缺失文件或 `D14_SYNTHETIC_*` 标记；
- 核对 manifest 版本、固定扩展 ID，并记录 manifest 与包内容树哈希；
- 固定 `platform=macos-arm64`、`buildTarget=aarch64-apple-darwin` 和 `evidencePurpose=RELEASE_CANDIDATE`。

登记后再次以原文件校验：

```bash
python3 desktop/scripts/d14_macos_acceptance_check.py verify-candidate \
  --candidate "docs/desktop-mvp/acceptance/runs/2026-09-20-macos-rc1/artifacts.json" \
  --dmg "/path/to/the-same.dmg" \
  --extension-zip "/path/to/the-same.zip"
```

## 3. M2 完成标准

- `artifacts.json.status=REGISTERED`，来源 commit、workflow run、版本、协议、URL、文件名、长度和 SHA-256 均非空。
- DMG 通过容器校验，插件 ZIP 通过发布文件集合与固定 ID 检查。
- 未签名/未公证状态有具名批准，不冒充签名或公证。
- Chrome、Edge 和生命周期报告尚未执行，仍保持 `NOT_RUN`。
- 文件变化、重新构建或源码 commit 变化时创建新的 run，不修改旧 manifest 的哈希。
