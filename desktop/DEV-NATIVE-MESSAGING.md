# 开发期 Native Messaging 注册

只用于本机开发调试。**生产安装、正式扩展 ID 注册与卸载属于 D13**，不要把这里的脚本当成安装器。

## 前提

1. 先构建桌面二进制（host 与应用是同一个可执行文件）：

```bash
cargo build --manifest-path src-tauri/Cargo.toml
```

2. 在浏览器里以「加载已解压的扩展程序」装好插件，记下它的扩展 ID（32 个 a–p 字母）。

## 注册

```bash
node scripts/nm-dev-register.mjs register --extension-id <你的扩展ID>
```

默认同时注册 Chrome 与 Edge，二进制默认取 `src-tauri/target/debug/`。可选参数：

- `--binary <绝对路径>`：指定别的可执行文件（例如 release 构建）。
- `--browser chrome | edge | both`：只注册其中一个。
- `--extension-id`：可重复，Chrome 与 Edge 的 ID 不同就都写上。
- `--dry-run`：只打印将要写什么，不落盘。

写入位置：

| 平台 | manifest | 指针 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\ResumePro\dev-nm\<浏览器>-com.resumepro.desktop.json` | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.resumepro.desktop` 与 Edge 对应键 |
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.resumepro.desktop.json`、`~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/...` | 无 |

Chrome 与 Edge 分别注册，不依赖 Edge 回退到 Chromium 键。

## 取消注册

```bash
node scripts/nm-dev-register.mjs unregister
```

## 这个脚本不会做什么

- **不覆盖不是它写的 manifest。** 目标位置已经有别人的注册时会跳过并报告，因为 unregister 无法还原一个它从没见过的文件。要替换请自己先删掉。
- **不按文件名删除。** 注册时把每个改动连同内容摘要记到 receipt（Windows 在 `%LOCALAPPDATA%\ResumePro\dev-nm\receipt.json`，macOS 在 `~/Library/Application Support/ResumePro/dev-nm/receipt.json`），unregister 只删摘要仍然吻合的文件；注册后被手改过的会留下并说明原因。
- **不删掉别人的注册表值。** 键在注册前已经指向别处时，unregister 恢复原值而不是删键。
- **不接受通配 origin。** `allowed_origins` 只接受形如 `chrome-extension://<32位ID>/` 的条目，其余一律拒绝写入。

## 验证

注册后不需要先打开桌面窗口：插件发出的第一条消息会由 host 唤起应用进程。可以用设置页的「Native Messaging」一项确认状态，或直接在插件里发一条 `handshake`。

## 真实浏览器验收

```bash
python scripts/nm_browser_check.py
```

需要先 `pip install playwright && python -m playwright install chromium`，以及一个已构建的桌面二进制（`--binary` 可指定路径）。**手工运行，不进 CI**：它要有头浏览器、会真的写一次 Native Messaging 注册、会启动桌面进程。

它自己造一个临时 MV3 探针扩展，全程用临时 `RESUMEPRO_DATA_DIR`（由浏览器传给它启动的 host），临时浏览器配置目录，跑完按 receipt 取消注册、退出应用、删掉临时目录。依次核对：

1. 未配对的扩展被 `identity_not_allowed` 拒绝；
2. 写入 `settings.json` 配对后握手成功，并带回 `archiveId` / `restoreEpoch`；
3. `job.save` 成功并返回 `resultId`——**全程没有打开过桌面窗口**；
4. 同一 `messageId` 再发一次，返回同一个 `resultId`，不会多出一条申请；
5. `application.queryCandidates` 能查回刚存的那条。

冷启动可能超过 host 的 10 秒预算，这时 host 返回可重试的 `unavailable`，脚本按插件应有的方式重试。这是设计中的行为，不是失败。

关闭顺序有讲究：**先让应用退出，再关浏览器**。host 是浏览器的子进程，应用又是 host 的子进程，浏览器的管道被这个孙进程持有，先关浏览器会一直等下去。
