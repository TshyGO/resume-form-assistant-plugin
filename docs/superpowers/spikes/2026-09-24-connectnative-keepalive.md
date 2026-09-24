# PR4 Native Messaging 长连接验证（2026-09-24）

## 实测

Windows 11 上用独立浏览器配置目录、一次性扩展 ID `diagjmploldedipjdenmecmjokckelkl` 和测试 host `com.resumepro.keepalive_spike`。测试 host 读取一帧后等待 120 秒再回帧；没有注册或覆盖正式 `com.resumepro.desktop`，测试结束后移除了两个测试注册项。扩展将收到的结果回报给本机 `127.0.0.1:19826`，未使用用户档案或 AI Key。

| 浏览器 | 版本 | `connectNative` | `sendNativeMessage` |
| --- | --- | --- | --- |
| Microsoft Edge | 149.0.4022.52 | 120.271 秒收到回包 | 120.277 秒收到回包 |
| Playwright Chromium（Chrome 内核） | 148.0 | 120.313 秒收到回包 | 120.323 秒收到回包 |
| Google Chrome 便携版 | 147.0.7727.56 | 未测成 | 未测成 |

Google Chrome 147 日志明确报告 `--disable-extensions-except is not allowed in Google Chrome, ignoring.`；命令行加载的一次性扩展没有启动。该项是测试工具受限，**不能**据此断言 Chrome 的 Native Messaging 失败。PR4 的 Chrome 原生侧栏真机走查仍需在可加载测试扩展的环境完成。Edge 和 Chromium 的 120 秒实测支持选用 `connectNative`；一次性调用在这两个版本也存活了 120 秒，因此本次没有测出两者的保活差异。实现仍用长连接，以便 AI 请求取消时主动断开端口。

## 复现用一次性扩展

在隔离目录建立下面的 `manifest.json`，`key` 使用仓库 `manifest.json` 的公钥以固定扩展 ID；只授予测试 host 和本机回报服务。不要在正式浏览器配置目录安装。

```json
{
  "manifest_version": 3,
  "name": "PR4 keepalive spike",
  "version": "0.0.1",
  "key": "<仓库 manifest.json 的 key>",
  "permissions": ["nativeMessaging"],
  "host_permissions": ["http://127.0.0.1/*"],
  "background": { "service_worker": "worker.js" }
}
```

`worker.js` 在 `runtime.onInstalled` 同时发一次性请求与长连接请求，记录起点和回包时间：

```js
const started = Date.now();
function report(channel, data) {
  fetch('http://127.0.0.1:19826/result', {
    method: 'POST', headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ channel, elapsedMs: Date.now() - started, data })
  }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(() => {
  report('started', { version: navigator.userAgent, id: chrome.runtime.id });
  chrome.runtime.sendNativeMessage('com.resumepro.keepalive_spike', { mode: 'one-shot' }, response => {
    report('sendNativeMessage', { response, error: chrome.runtime.lastError?.message });
  });
  const port = chrome.runtime.connectNative('com.resumepro.keepalive_spike');
  port.onMessage.addListener(response => { report('connectNative', { response }); port.disconnect(); });
  port.onDisconnect.addListener(() => report('connectNativeDisconnect', { error: chrome.runtime.lastError?.message }));
  port.postMessage({ mode: 'port' });
});
```

Windows 测试 host 是一个临时 Rust 可执行文件：从 stdin 读 4 字节 little-endian 长度及 JSON，`sleep(120s)` 后把 `{"ok":true,"received":<原请求>}` 按同一帧格式写到 stdout。注册清单的 `allowed_origins` 只含上述扩展 ID；分别在 Chrome、Chromium 或 Edge 的用户级 `NativeMessagingHosts` 测试键登记，结束后核对并删除测试键。实测脚本和隔离配置目录位于本机忽略的 `output/pr4-spike/`，不进入插件包。
