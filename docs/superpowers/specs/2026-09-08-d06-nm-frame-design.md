# D06 第一片：Native Messaging 帧层与 health 端到端

| 字段 | 值 |
| --- | --- |
| 标题 | Native Messaging 帧编解码与最小 health 回路 |
| 日期 | 2026-09-08 |
| 上级 | [D06 #24](https://github.com/TshyGO/resume-form-assistant-plugin/issues/24) · [Roadmap #39](https://github.com/TshyGO/resume-form-assistant-plugin/issues/39) |
| 状态 | 已确认，待实现 |
| 基线 | `53ea509` |

D06 要把浏览器插件接到桌面的唯一数据写入服务上。本片只做**最靠外的一层**：把浏览器的字节流变成经过校验的消息，并回一条合规响应。不碰数据库，不拉应用进程，不做安装注册。

issue #24 明确要求「保持范围单一，可拆多个小 PR」，本片是第一个。

## 1. 已确认的三项选择

| 决策 | 选定 | 理由 |
| --- | --- | --- |
| host 形态 | **同一个二进制** | D01 把「薄 host 或同二进制」列为待验证。选同二进制：D13 只需签名公证一个可执行文件，代码天然共享，且项目已有 `--probe` / `--hidden` / `--quit` 先例。代价是必须保证这条路径绝不往 stdout 写非协议内容，本片用测试钉死这一点 |
| 本片范围 | **帧层 + health 端到端** | 纯库虽然更好审，但合并后看不到任何实际效果，浏览器侧的风险一点没验。做成能跑的竖切片，把「stdout 纯不纯」这个 NM 最容易翻车的问题提前暴露 |
| 验证方式 | **模拟 stdio，不碰浏览器与注册表** | 进程级测试直接向二进制 stdin 灌帧、读 stdout，双平台都能进 CI，零系统痕迹。真实浏览器注册留到后续片或 D13 |

## 2. 如何进入 NM 模式

**浏览器无法传入自定义参数。** Native Messaging 的注册 manifest 只有 `name` / `description` / `path` / `type` / `allowed_origins`，没有 `args` 字段 —— 只能指定可执行文件路径。

浏览器实际这样启动 host（[ADR §3.7](../../desktop-mvp/adr-architecture.md)）：

```
argv[0]  可执行文件路径
argv[1]  chrome-extension://<扩展 ID>/     调用方 origin
argv[2]  --parent-window=<句柄>            仅 Windows
```

因此进入 NM 模式必须**扫描 argv 找 origin token**（前缀 `chrome-extension://` 或 `moz-extension://`），而不是靠自定义参数。ADR 特别警告：**`argv[0]` 是可执行路径，不得拿去比对 origin** —— 安装路径中若含相似字样会造成误判。

`--nm-host` 仍然保留，但定位是**测试专用入口**：进程级测试借它进入服务循环，不必伪造一个 origin。两条路进入同一个 `serve` 循环，行为一致。

这个设计一度写成「靠 `--nm-host` 参数进入」。那样单测与进程测试都会全绿，接上真实浏览器却收不到任何消息，且失败是静默的。此处记录以免后续片重蹈。

### origin 的处理范围

本片**提取并记录** origin（写 stderr），但**不做授权**：`allowed_origins` 白名单来自配对流程，属于后续片与 D13。D05 已导出 `origin_allowed(origin, &allowed)`，接上是一行的事，但没有白名单可比对之前接上没有意义。

## 3. 结构

新建 `crates/nm-frame`，纯库，不依赖 Tauri：

```
read_frame(reader)          -> Result<Option<Vec<u8>>, FrameError>
write_frame(writer, bytes)  -> Result<(), FrameError>
```

`src-tauri` 侧新增两处：`cli.rs` 增加第 2 节的两条进入方式（扫 argv 找 origin，加测试用的 `--nm-host`），新建 `nm.rs` 把帧层接到 D05 校验上。

分层理由：`nm-frame` 只认字节，不认识 JSON；`nm.rs` 只负责把字节交给 D05 并组织回复；进入方式的判定留在 `cli.rs`，与其余参数解析同处一地。三者可各自单测，且帧层不需要拉起 Tauri 就能测。

不放进 `protocol` crate：D05 是**契约**，帧是**传输**，其 README 明写 “Not a Native Messaging host”。放进去会破坏它自己声明的边界。

## 4. 帧格式与三条硬规则

Chrome 的 Native Messaging 规定：**4 字节长度前缀（本机字节序）+ UTF-8 JSON 正文**。

1. **绝不按声称的长度预分配。** 长度前缀是对端完全可控的输入。声称 4 GiB 就分配 4 GiB 是最典型的拒绝服务路径。超过上限时直接拒绝，不读取也不分配。
2. **干净 EOF 是正常退出。** 读长度前缀时读到 0 字节表示浏览器关闭了端口，`read_frame` 返回 `Ok(None)`，进程正常结束，不算错误。
3. **半截帧只能终止连接。** 长度前缀流一旦错位就无法重新同步，继续读只会把后续字节误当成长度。读到部分帧即返回错误并关闭。

上限取 D05 的信封上限 `MAX_ENVELOPE_BYTES`（65536），不另立一套数字。Chrome 自身允许更大的帧，但超出 D05 上限的消息本就会被契约层拒绝，在帧层提前拒可以避免无谓的分配。

## 5. stdout 纯净度与二进制安全

这是本片最关键的约束。**往 stdout 写一个字节的非协议内容，整条通道立即失效**，而且症状是浏览器侧莫名其妙的断连，极难定位。

现有 `prepare_stdio()` 会为 `--probe` / `--help` / `--apps-loop` 附加控制台。`--nm-host` **必须不走这条路径**。所有诊断、错误、日志一律只进 stderr。

这一条写成断言：进程级测试会检查整个会话的 stdout 只包含协议帧，多一个字节即失败。不依赖开发者自觉。

**二进制安全。** ADR §3.7 要求 stdout 为 `O_BINARY`：文本模式下 `0x0A` 会被翻译成 `0x0D 0x0A`，帧正文损坏且长度与前缀对不上。已实测确认 Rust 的 `std::io::stdout()` 在 Windows 上不走 CRT 文本模式翻译，写入 `41 0a 42 0a 43 0a` 原样产出 6 字节，因此**无需额外设置**。仍加一条测试：让帧正文含真实 `0x0A` 走完整进程往返，若日后有人改用会做翻译的写法，测试立刻拦下。

## 6. 本片的应答语义

| 收到 | 回复 |
| --- | --- |
| `health` | D05 规范的成功响应 |
| 其他通过 D05 校验的请求 | D05 错误 `unavailable` |
| JSON 可解析、未通过 D05 校验，且顶层 `messageId` 是合法 UUID | 带 `correlationId` 的 D05 错误，错误码取自校验结果 |
| JSON 无法解析，或取不到合法 `messageId` | 无法构造合规响应，写 stderr 后关闭连接 |

第二行是**本片的临时行为**，需要在代码注释和 PR 中写明。写入服务尚未接上时如实回 `unavailable`（D05 中唯一默认可重试的错误码），而不是假报成功。后续片接上应用进程后，这一行会被真实转发取代。

第三行的错误码直接沿用 D05 校验返回的码，不另行归类，这样插件侧看到的错误语义与直接调用校验器一致。

第四行的处理是被动的：D05 的响应信封要求 `correlationId`，取不到 `messageId` 就无法构造合规响应。此时关闭连接比发一条不合规的响应更好 —— 后者会让插件侧的校验器同样拒绝，反而掩盖真实原因。关闭前必须向 stderr 写明原因。

`handshake` 不在本片范围内：它需要应用进程提供的 `archiveId` / `restoreEpoch`，而本片不连应用进程。

## 7. 测试

- **帧层单测**：0 长度、恰好 65536、65537、截断前缀、截断正文、干净 EOF、超大长度前缀（断言不分配）
- **进程级测试**：用 `std::process::Command` 拉起真实二进制，向 stdin 灌帧并读 stdout。双平台可在 CI 运行，不产生系统痕迹
- **stdout 纯净断言**：整个会话的 stdout 逐字节等于预期的协议帧序列
- **请求样例复用 D05 的 fixture**，不新造一套
- **origin 识别**：argv 含真实 `chrome-extension://` token 时进入 NM 模式；含相似字样的 `argv[0]`（如安装路径带该字样）不得被误判为 origin
- **二进制安全**：帧正文含 `0x0A` 的往返，断言 stdout 字节原样

新 crate 需同步加入 `.github/workflows/desktop.yml` 的测试步骤与 Rust 缓存 workspace 列表 —— D05 曾因未接入 CI 而使全部契约测试长期只在开发机运行，不重复该疏漏。

## 8. 明确不做

不碰数据库；不拉起或连接应用进程；不写 Windows 注册表或 macOS NativeMessagingHosts 目录；不实现握手；不做安装、注册或卸载（归 D13）；不改插件侧任何代码（归 D07）。

通过本片的校验既不是写入许可，也不是持久化确认 —— 这一点与 D05 的既有声明一致。

## 9. 后续片

1. origin 授权：接上配对产生的 `allowed_origins` 白名单，用 D05 的 `origin_allowed` 拒绝未授权来源
2. 握手与身份校验（需要应用进程提供当前 `archiveId` / `restoreEpoch`）
3. 按需拉起应用进程，host 与应用之间的 IPC 及其访问限制
4. 白名单操作转发到 D03 事务接口，落盘后再应答
5. 真实浏览器的隔离注册验证 —— 需要稳定的扩展 ID，而未打包扩展的 ID 由加载路径哈希派生，故依赖配对流程先落地

D06 的完整验收标准以 issue #24 为准，本片不替代其中任何一条。
