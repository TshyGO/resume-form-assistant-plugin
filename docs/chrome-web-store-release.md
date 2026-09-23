# Chrome 扩展：从 GitHub Release 到商店送审

维护者文档。日常 push 和 PR 只跑 CI（`.github/workflows/test.yml`），不会碰 Chrome Web Store。正式发布从你创建的 **GitHub Release** 开始，由 `.github/workflows/release.yml` 完成检查、打包、把同一个 ZIP 挂到这个 Release，再上传商店并送审。

扩展本身没有编译步骤。正式「构建」就是仓库已有的 `node desktop/scripts/pack-plugin.js`：按允许清单从 Git 树打 ZIP，不包含 `desktop/`、`node_modules`、测试和 `.env`。版本号只看 `manifest.json`。根目录 `package.json` 的 `version` 是类型检查工具自己的版本，不参与商店发布。

商店 API 使用当前的 [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api)。v2 不能新建条目，只能更新已经在 Developer Dashboard 里创建好的 item。审核通过后默认 **不自动公开**：流水线使用 `STAGED_PUBLISH`。你确认之后再上线。

## 1. 首次配置

先确认 Developer Dashboard 里这几件事已经做好，否则 API 会失败：

- Google 账号打开了两步验证。
- 商店条目已经存在。本仓库的扩展 ID 是 `diagjmploldedipjdenmecmjokckelkl`（由 `manifest.json` 的 `key` 算出，测试锁着这个值）。
- Store listing 和 Privacy 页按 [store-listing.md](store-listing.md) 填过。流水线不改这些文案。

### 推荐：服务账号

官方把服务账号作为 CI 里调用这个 API 的方式：不用在流水线里保存个人 refresh token。

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，新建或选中一个项目。
2. 启用 **Chrome Web Store API**。
3. 创建一个服务账号。这一步不用给它项目里的其他 IAM 角色。
4. 给这个服务账号建一把 JSON key。
5. 打开 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/) → Account，把服务账号邮箱加进去。
6. 在同一页的 Publisher → Settings 复制 **Publisher ID**。

### 备选：OAuth refresh token

没有服务账号时，流水线才会使用 refresh token。步骤以官方说明为准：

1. 同样先启用 Chrome Web Store API，并配好 OAuth 同意屏幕。
2. 创建类型为 Web application 的 OAuth Client，把 `https://developers.google.com/oauthplayground` 加进已授权的重定向 URI。
3. 打开 [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)，用自己的 client id / secret，scope 填 `https://www.googleapis.com/auth/chromewebstore`，换出 refresh token。
4. 用来授权的 Google 账号必须是这个商店条目的发布者。

两种凭据都配了的话，流水线只用服务账号。

## 2. GitHub Secrets

仓库 Settings → Secrets and variables → Actions。名字必须一致，值不要写进仓库、日志或 ZIP。

| Secret | 何时需要 | 内容 |
| --- | --- | --- |
| `CHROME_EXTENSION_ID` | 始终 | `diagjmploldedipjdenmecmjokckelkl` |
| `CHROME_PUBLISHER_ID` | 始终 | Dashboard 里的 Publisher ID |
| `CHROME_WEB_STORE_CREDENTIALS` | 推荐 | 服务账号 JSON key 的全文 |
| `CHROME_CLIENT_ID` | 只有不用服务账号时 | OAuth client id |
| `CHROME_CLIENT_SECRET` | 只有不用服务账号时 | OAuth client secret |
| `CHROME_REFRESH_TOKEN` | 只有不用服务账号时 | Playground 换出的 refresh token |

`GITHUB_TOKEN` 由 Actions 自己提供，用来把 ZIP 挂到 Release，不用另外建。

## 3. 发一个正式版

1. 只改 `manifest.json` 的 `version`，写成新的 `1.2.3`。Chrome 不接受带 `-beta` 的扩展版本号。
2. 把这个提交放进 `main`。不在 `main` 历史上的 tag，流水线会拒绝送审。
3. 创建 **正式** GitHub Release，tag 必须是 `v` 加这个版本号，例如版本 `0.4.1` 就用 tag `v0.4.1`。不要勾 Pre-release，也不要只推 tag 而不建 Release。

```bash
git checkout main
git pull
# manifest.json 的 version 已经是 0.4.1，并且这个提交就在 HEAD
gh release create v0.4.1 --target main --title "v0.4.1" --generate-notes
```

`release.yml` 随后会：

1. 跑和 CI 同一套语法检查、`npm run typecheck`、`npm test`，以及 `check-plugin-release-allowlist.js`。
2. 核对 tag、`manifest.json` 版本，以及这个提交在 `main` 上。
3. 打出 `resume-pro-v0.4.1-chrome.zip`，再拆开核对里面的 `manifest.json`。
4. 把这个 ZIP 挂到刚创建的 Release。
5. 调 v2 `upload`。如果返回「仍在处理」，就轮询 `fetchStatus`，直到成功或失败。
6. 核对商店收到的版本。对不上就停止，不会送审。
7. 用 `publishType=STAGED_PUBLISH` 送审，再读一次 `fetchStatus`，确认待审版本就是这一版，状态是 `PENDING_REVIEW` 或 `STAGED`。

任一步失败，后面的步骤不会跑。测试失败时不会打 ZIP，也不会上传商店。

桌面 Release 的 tag 是 `desktop-v*`，这条工作流直接跳过。

## 4. 审核通过之后再上线

送审成功只表示进入审核或已暂存，用户还收不到更新。状态变成 `STAGED` 之后，二选一：

- Developer Dashboard 里对这个暂存版本点发布。
- 或者在 **打这个 tag 的提交** 上手动跑 Actions，勾上 `release_staged`（`dry_run` 保持默认即可）。它不会上传新 ZIP，只会在商店状态已经是 `STAGED` 且版本与当前 `manifest.json` 一致时调用 `DEFAULT_PUBLISH`。

本地也可以，凭据放在环境变量里，不要写进 shell 历史可以记下的文件：

```bash
node desktop/scripts/chrome-web-store.js release-staged
```

还在 `PENDING_REVIEW` 时这个命令会失败，不会提前公开。

## 5. 只在本地打 ZIP

不需要商店凭据，也不会联网：

```bash
node desktop/scripts/chrome-web-store.js zip-name
node desktop/scripts/pack-plugin.js --output resume-pro-v0.4.0-chrome.zip
node desktop/scripts/chrome-web-store.js verify-zip --zip resume-pro-v0.4.0-chrome.zip
node desktop/scripts/chrome-web-store.js publish --zip resume-pro-v0.4.0-chrome.zip --dry-run
```

把版本换成 `manifest.json` 里的实际值。`--dry-run` 只检查 ZIP，不换 token，不上传。

想在 Actions 里试同一条流水线：Actions → Release Extension → Run workflow，保持 `dry_run` 为 true。它会跑检查并上传一份名为 `chrome-extension-zip` 的 artifact，不修改 Release，也不接触商店。

## 6. 失败之后怎么重试

先看失败的那一步，修完再重跑 **同一次** workflow run。重跑会覆盖同名的 Release 附件。商店侧有这些保护：

- 同一时间只有一个会改商店的运行；后来的排队，不会取消正在上传的那次。dry-run 不占这把锁。
- 这个版本如果已经是线上版本，或已经处于 `PENDING_REVIEW` / `STAGED`，脚本拒绝再次上传。
- 商店还报告有进行中的上传时，脚本停止。
- 上传或送审失败后，先到 Dashboard 确认商店草稿及其内容。上传接口只报告「版本已存在」时，流水线无法确认那份草稿与本次 Release 的 ZIP 相同，因此会停止，不会自动送审旧草稿。确认后可在 Dashboard 手动送审；需要重新走自动流水线时，修复问题、递增版本号，再建新 Release。
- 送审后读回来的版本对不上，脚本会尝试 `cancelSubmission`，然后失败。

不要为了重试去建第二个同版本 Release。版本号已经用过且被商店拒绝时，先把 `manifest.json` 的版本号升上去，再发下一个 Release。

## 7. 查看商店里现在的版本

```bash
node desktop/scripts/chrome-web-store.js status
```

输出只有已发布版本、待审版本、待审状态和最近一次上传状态，不打印 token。Dashboard 的状态页是同一份数据的界面。

`takenDown: true` 时不要继续发版，先处理下架原因。
