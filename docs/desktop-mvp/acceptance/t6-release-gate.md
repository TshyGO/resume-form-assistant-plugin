# T6 候选产物与验收证据发布门禁

T6 只校验证据与字节是否满足放行条件，不替代 T4/T5 的真实执行和具名审阅。输入中的任一候选 SHA、版本、协议、报告绑定、依赖签收或最终下载字节不一致都会失败关闭。

## 输入

复制 [release-gate-template.json](release-gate-template.json) 到本次 run，填写相对路径：

- `candidateManifest`：T4 `prepare` 生成的 `artifacts.json`；
- `dependencies`：D08、D11、D13 的签收文件；
- `reports.chrome`、`reports.edge`：T4 两份完整且已审阅报告；
- `reports.t5`：T5 完整且已审阅报告；
- `releaseArtifacts.desktop`、`releaseArtifacts.extension`：从将要提升为正式 Release 的下载位置重新取回的实际文件；
- `requiredSourceCommit`：最终发布源码的完整 40 位 SHA；
- `review`：发布负责人、时间、`APPROVED` 和空的 `blockingDefects`。

所有报告必须绑定同一 `fixtureVersion`、源码 SHA、桌面/插件版本、协议版本、文件名、稳定无凭据下载地址与 SHA-256。Chrome/Edge 的 J01–J08、F01–F13 必须各出现一次、全部 `PASS` 且证据字符串非空；环境必须是普通用户，生产注册和安装后烟测均已通过，签名策略和扩展 manifest/源码树哈希与候选一致；T5 的 16 项必须全部 `PASS`；D08/D11/D13 必须具名签收且与两份浏览器报告内的依赖记录一致。

## 执行

```powershell
node desktop/scripts/check-release-acceptance.mjs `
  "docs\desktop-mvp\acceptance\runs\2026-09-19-rc1\release-gate.json"
```

门禁会重新读取最终 EXE/ZIP，比较文件名、字节数和 SHA-256。若发布流水线重新构建导致字节变化，必须登记新候选并按影响重验，不能改报告里的哈希蒙混通过。

正式发布后，从正式下载地址再次下载同一组文件，更新 `releaseArtifacts` 指向下载副本并重新运行。两次都通过，才证明候选提升和正式下载未换字节。

## 失败即阻断

- 任一 J01–J08、F01–F13 或 T5 检查为 `FAIL / BLOCKED / NOT_RUN / NOT_APPLICABLE`，或 case 重复/缺失；
- 报告未具名审阅、决定不是 `APPROVED`、存在阻断缺陷；
- 硬依赖未签收或没有验收证据；
- 报告与候选 manifest 不一致；
- 最终下载文件名、长度或 SHA-256 与候选不同；
- 候选下载地址不是无凭据/无查询参数的稳定 HTTPS、签名策略无效、固定扩展 ID 或 manifest/源码树哈希不一致、源码 SHA 不完整。

## 与 D13 发布流水线的接入点

当前仓库尚无已登记候选，也没有 T4/T5 运行报告，因此门禁**暂不接入** `.github/workflows/release.yml` 与 `desktop-release.yml`：在没有证据文件的情况下接进去，会让每一次插件或桌面 tag 都失败，而不是拦住不该发的版本。

候选登记完成后的接入方式：

1. 把某一次 run 目录作为唯一证据源提交（`docs/desktop-mvp/acceptance/runs/<run-id>/`），其中包含 `artifacts.json`、`chrome/`、`edge/`、`t5/`、`dependencies.json` 和 `release-gate.json`。
2. 桌面 tag 流水线在 `Check what is about to be published` 之后、`Create release` 之前增加一步：

```yaml
      - name: Release acceptance gate
        run: node desktop/scripts/check-release-acceptance.mjs "docs/desktop-mvp/acceptance/runs/<run-id>/release-gate.json"
```

3. 插件 tag 流水线同样把这条放在 `Create Release` 之前。若本次正式发布只发插件、不发桌面，则把 `release-gate.json` 里的 `releaseArtifacts.desktop` 指向本次复验的桌面候选；不能让插件 tag 绕过联合门禁。
4. 门禁必须读取流水线自己下载回来的文件，而不是构建目录里的同一份；`releaseArtifacts` 就指向下载副本，`assertReleaseFile` 会重新算哈希。

接入前必须先有一次真实通过；接入后如需临时跳过，只能显式删除证据文件，不允许加 `continue-on-error`。
