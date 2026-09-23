# 维护者发版 SOP：浏览器插件与桌面端

本文是每次发新版时的操作清单。两条发布链路独立；先决定本次改了哪一端，再按对应小节操作。首次桌面 MVP 的实机验收仍须按 [D14 验收工作区](desktop-mvp/acceptance/README.md) 完成。

| 发布对象 | 版本号来源 | 触发动作 | GitHub 产物 | 用户如何得到新版 |
| --- | --- | --- | --- | --- |
| 浏览器插件 | 根目录 `manifest.json` | **发布正式** GitHub Release `vX.Y.Z` | `resume-pro-vX.Y.Z-chrome.zip` | Chrome 商店审核后手动上线；ZIP 可手动安装 |
| 桌面正式版 | `desktop/src-tauri/tauri.conf.json`、`Cargo.toml`、`Cargo.lock` | 推送标签 `desktop-vX.Y.Z` | Windows x64 EXE、macOS ARM64 DMG、各自 SHA-256、备用插件 ZIP | 工作流自动创建正式 GitHub Release；应用只提示下载，不自动安装 |
| 桌面测试版 | 由 `release-beta.js` 从 `main` 生成 `X.Y.Z-beta.N` | 推送标签 `desktop-vX.Y.Z-beta.N` | 同上 | 工作流自动创建 GitHub 预发布；正式版用户不会收到更新提示 |

**版本可以不同。** 例如桌面 `desktop-v0.4.0` 可以配插件 `v0.4.1`，但发版前要检查两者的 Native Messaging 协议与实际连接。根目录 `package.json` 的版本不用于插件发版；桌面 `desktop/package.json` 也不是安装包版本的权威来源。

## 每次发版共同检查

1. 功能、权限和文案已在 PR 中审完并合入 `main`；相应的 [Test](../.github/workflows/test.yml) 与 [Desktop](../.github/workflows/desktop.yml) CI 通过。发版只使用已合入的提交。
2. 确认本次目标版本和 tag 没用过；插件还要看商店是否已有该版本。**不要复用版本号或移动已经发布的 tag。**
3. 插件与桌面连接的改动，要用候选安装包和目标浏览器各做一次真实连接、填写和升级检查。CI 构建成功不能代替安装验收。
4. 记录发布 commit、tag、工作流链接、产物哈希、验收结果和已知限制。桌面首个正式版依照 [T4/T5/T6/T7](desktop-mvp/acceptance/README.md) 完成具名签收；**目前 T6 尚未接入发版工作流，维护者必须在推送正式 tag 前自行把关**。

## A. 发浏览器插件正式版

首次商店 API、服务账号、GitHub Secret 已配置。细节与故障处理见 [Chrome 商店发版说明](chrome-web-store-release.md)。

1. 在 PR 中把根目录 `manifest.json` 的 `version` 升为未使用的 `X.Y.Z`，合入 `main`。Chrome 扩展版本不用 `-beta`。商店的 `0.4.0` 已手动上线；首次自动送审从 `0.4.1` 或更高版本开始，**不要补建 `v0.4.0` 正式 Release**。
2. 在 Actions 手动运行 **Release Extension**，保持 `dry_run=true`、`release_staged=false`。它会检查、测试、打 ZIP，并留下临时 artifact；不会动商店或 GitHub Release。下载 ZIP 核对 `manifest.json`、版本、扩展 ID 和主要功能。这个试跑结果不是正式 Release 附件。
3. 更新本地 `main`，核对版本与准备发布的 commit，然后创建**正式** GitHub Release。只推 `vX.Y.Z` tag 不会启动插件商店工作流；创建草稿也不会，必须点 Publish release。不要勾 Pre-release。

```bash
git switch main
git pull --ff-only
git status --short
node desktop/scripts/chrome-web-store.js check-release --tag vX.Y.Z
gh release create vX.Y.Z --target "$(git rev-parse HEAD)" --title "vX.Y.Z" --generate-notes
```

4. 查看 Actions → **Release Extension**。它会再次检查、从 tag 的 Git 树打包，把同一份 ZIP 挂到该 GitHub Release，上传 Chrome Web Store，并以 `STAGED_PUBLISH` 送审。检查工作流成功、Release 附件存在、商店的待审版本与 tag 相同。**GitHub Release 和 ZIP 此时已公开，插件内的 GitHub 更新提示也可能出现；商店用户仍要等审核与手动上线。** 失败先查具体步骤和商店草稿，按 [故障处理](chrome-web-store-release.md#6-失败之后怎么重试)处理；不要另建同版本 Release 反复上传。
5. 审核通过、状态变成 `STAGED` 后，决定上线时在商店后台发布；也可在**该插件 tag** 上运行以下命令。它只公开已暂存的版本，不上传新包：

```bash
gh workflow run release.yml --ref vX.Y.Z -f dry_run=false -f release_staged=true
```

6. 回到商店页面和扩展内核对公开版本、安装和更新。送审成功不等于用户已收到新版。

## B. 发桌面测试版（供验收）

当 `main` 上的桌面版本已设为即将发布的正式 `X.Y.Z` 时，从仓库根目录运行：

```bash
node desktop/scripts/release-beta.js          # 只预览下一枚 beta tag
node desktop/scripts/release-beta.js --push   # 确认后推 tag，触发 Release Desktop
```

脚本从远端 `main` 创建临时提交，把三处桌面版本改成 `X.Y.Z-beta.N`，推送 tag 后清理临时分支；`main` 不留 beta 版本提交。工作流生成 Windows EXE、macOS DMG、校验文件与备用插件 ZIP，并创建预发布。用**同一预发布**的文件做真实安装与 [D14 候选验收](desktop-mvp/acceptance/README.md)；不要把不同 beta 或临时 artifact 拼成一组候选。

## C. 发桌面正式版

1. 在 PR 中运行 `node desktop/scripts/set-version.js X.Y.Z`，它会同步 Tauri 配置、Cargo manifest 与锁文件；合入 `main`。如果同步维护 `desktop/package.json` 的开发元数据，也要同步其 lock，但它们不决定安装包版本。
2. 在 Actions 手动运行 **Release Desktop**，选择 `main`。此试跑会分别构建 Windows/macOS 安装包并校验，但**不会创建 Release**。Windows runner 上的安装启动只算诊断，不能代替普通用户机器上的安装验收。
3. 按 [D14 验收](desktop-mvp/acceptance/README.md) 完成所需 Windows、macOS、Chrome、Edge 和升级/恢复检查，确认无阻断缺陷。正式 tag 会重新构建，候选文件与最终文件必须按实际 SHA-256 核对；字节变化不能靠修改旧报告里的哈希放行。
4. 在干净且与远端一致的 `main` 上校验版本、打并推送正式 tag。**只推 tag**；`Release Desktop` 会在双平台构建通过后自动创建 GitHub Release，不需要先手工建。

```bash
git switch main
git pull --ff-only
git status --short
node desktop/scripts/check-desktop-release.js desktop-vX.Y.Z
git tag desktop-vX.Y.Z "$(git rev-parse HEAD)"
git push origin desktop-vX.Y.Z
```

5. 查看 Actions → **Release Desktop**，确认两个平台构建成功。再到该 tag 的 Release 核对 EXE、DMG、每个文件的 `.sha256`、插件 ZIP 和发布说明；从 Release 重新下载并复算哈希，做正式包的安装/连接复验并完成发行记录。工作流目前直接发布 Release；若验收未完成，**不要先推正式 tag**。

## 插件 ZIP 保留规则

- **保留插件正式 Release 的 ZIP。** 它是送商店的同一份包，也给 Edge、手动安装和故障排查提供下载入口。由 CI 从 tag 的 Git 树生成，作为 Release 附件；**不要把 ZIP 二进制提交进 Git 仓库**。
- **现阶段保留桌面 Release 的备用 ZIP。** 桌面设置页的“下载插件包”目前指向该桌面 Release。它是该桌面 tag 的插件源码快照，文件名按 `manifest.json` 的**插件版本**命名，不代表桌面版本，也不自动等同于另一枚插件 Release 或商店已审核的字节。发桌面版时要核对包内版本、兼容性和来源 commit。
- 长期可在桌面下载入口改为定位对应的**插件正式 Release** 后，移除桌面 Release 的重复 ZIP。那之前直接删掉会让现有下载按钮失效。不要使用仓库通用的 `/releases/latest` 找插件：桌面正式版可能成为整个仓库的 latest。
