# D06 第三片：host 与应用进程之间的本地 IPC

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-09-08 |
| 上级 | [D06 #24](https://github.com/TshyGO/resume-form-assistant-plugin/issues/24) · [Roadmap #39](https://github.com/TshyGO/resume-form-assistant-plugin/issues/39) |
| 前两片 | [帧层与 health](2026-09-08-d06-nm-frame-design.md)（#41）· [origin 授权](2026-09-08-d06-origin-auth-design.md)（#42） |
| 基线 | `7ad6ca0` |

把 NM host 接到应用进程上。这是 D06 的核心难点：验收标准 1、2、5 都取决于它。

```
浏览器 ──stdio 帧──> NM host 进程 ──本地 IPC──> 应用进程（唯一写入者）──> SQLite
        （可多个）                    （恰好一个）
```

## 1. 已确认的三项选择

| 决策 | 选定 | 理由 |
| --- | --- | --- |
| 底层实现 | **手写，不加新依赖** | macOS 用 std 自带的 `UnixListener`；Windows 用已有的 `windows-sys` 调 `CreateNamedPipe`。安全描述符必须完全掌握在自己手里 —— ADR 要求管道 DACL 限当前用户，若交给第三方 crate 而它不暴露该能力，就违反了硬要求。也符合本仓库极克制的依赖风格 |
| 内部协议 | **原样转发 D05 帧** | 复用 `nm-frame` 的长度前缀编解码，只维护一套格式。应用侧可直接再跑一遍 D05 校验作为纵深防御 |
| 冷启动 | **拉起并等，超时回 `unavailable`** | 验收标准 1 明写「应用窗口未开时仍能可靠保存岗位」。D02 的 `--hidden` 现成可用 |

## 2. 新 crate `local-ipc`

只做「监听 / 连接 / 收发帧」，**不认识 D05**：

```rust
pub fn listen(endpoint: &Endpoint) -> Result<Listener, IpcError>
pub fn connect(endpoint: &Endpoint) -> Result<Stream, IpcError>
```

平台差异完全封在 crate 内，对外一个 API。

已用编译探针核实所需的 `windows-sys` feature 与符号位置（0.59）：`ConnectNamedPipe` 因签名含 `OVERLAPPED` 而额外需要 `Win32_System_IO`；`PIPE_ACCESS_DUPLEX` 位于 `Win32::Storage::FileSystem` 而非 `Win32::System::Pipes`。两处按直觉书写都会编译失败。

`local-ipc` **只提供实现了 `Read + Write` 的字节流，不依赖 `nm-frame`**，帧的收发由调用方在流之上套 `nm-frame`。这样传输与帧格式各自独立可测，`local-ipc` 的测试不需要构造任何协议帧。

## 2.1 分两个 PR 实现

本 spec 覆盖整片，但落地拆成两个 PR，理由不是体量而是风险隔离：

| PR | 内容 |
| --- | --- |
| A | `local-ipc` crate 本身：两个平台的端点、权限、抢占检测，**不接线** |
| B | 应用侧监听、host 侧连接与冷启动、端到端 |

Windows 命名管道的安全描述符是本片风险最高的部分，且完全可独立测试。单独成 PR 便于集中审查，也避免它和接线逻辑的问题混在一起难以定位。

## 3. 端点与权限

ADR §3.4 第 7 条：**不因为「本机」就信任**。

### macOS

端点为 `<data_root>/host.sock`，与 `host.lock`、`current.json` 同处一地 —— 该目录本身已是用户私有。

- 绑定后立即 `chmod 0600`
- **路径长度**：`sun_path` 上限 104 字节。典型路径 `/Users/<name>/Library/Application Support/ResumePro/host.sock` 约 63 字符，余量充足；但 `RESUMEPRO_DATA_DIR` 可指向任意深度。超长时必须**给出明确错误**，而不是让 `bind` 报一个难以理解的失败
- **陈旧 socket 文件**：进程崩溃会留下文件。因为监听以持有 `host.lock` 为前提（见第 4 节），持锁者可以安全地 `unlink` 后重新绑定

### Windows

端点为 `\.\pipeesume-pro-<当前用户 SID 字符串>`，例如 `\.\pipeesume-pro-S-1-5-21-…-1001`。

- 直接用 SID 字符串而非其哈希：SID 只含 `S`、数字与连字符，在管道名中合法，且无碰撞、可读、便于排障。管道名上限 256 字符，SID 约 50，余量充足
- 名称含用户标识：同一台机器上的两个用户各自有独立管道，不会撞名
- `CreateNamedPipe` 时附安全描述符，**DACL 只含当前用户 SID**
- 使用 `FILE_FLAG_FIRST_PIPE_INSTANCE`：名称已被占用时**创建失败并报错**，而不是默默加入他人已建的管道

### 管道抢占（Windows 残余风险）

同机的恶意本地用户可以抢先用我们预期的名称创建管道。DACL 保护的是「谁能连我们的管道」，挡不住「我们连上了别人的管道」。

缓解：客户端连上后调用 `GetNamedPipeServerProcessId`，再用 `QueryFullProcessImageNameW` 取该进程的映像路径，**与自身可执行文件路径比对**，不符即断开并报错。

这不是完备防护（映像路径可被同名副本仿冒），但能挡住最直接的抢占。完备方案需比对服务端进程的用户 SID，留待后续。**本片必须实现上述比对，并在文档中如实标注其边界**，不得声称已完全解决。

macOS 无此问题：socket 路径在用户私有目录下，他人无法在其中创建文件。

## 4. 「恰好一个写入者」如何保证

**不新造互斥机制。** D02 的 `host.lock`（fslock）已经是唯一写入者的凭据，已在 macOS 真机验证：第二个实例拿不到锁。

规则：**谁持有 `host.lock`，谁才监听 IPC 端点。**

- 应用进程在 `DataHost::initialize_with` 成功之后才开始 `listen`
- 释放锁时必须**同步关闭端点**（macOS 还需 unlink socket 文件）

这样「唯一写入者」与「唯一监听者」是同一件事，不存在两个可能打架的真相来源。代价是 IPC 与数据层的生命周期被绑定，这是刻意的取舍。

## 5. 冷启动

```
host 收到需要应用处理的请求
  → connect
  → 成功：转发
  → 失败：以 --hidden 拉起应用，轮询重连，上限 10 秒
      → 成功：转发
      → 超时：回 unavailable（D05 唯一默认可重试的码），stderr 写明原因
```

### 重入

浏览器可能同时拉起多个 host（每条 `sendNativeMessage` 一个；Chrome 与 Edge 各一）。它们会同时发现应用未运行并同时尝试拉起。

**不需要额外互斥**：D02 的单实例保证多余进程自行退出，第一个赢家取得 `host.lock` 并开始监听，其余 host 在轮询中自然连上它。

### 拉起失败

可执行文件缺失、被安全软件拦截、启动即崩 —— 一律归入超时路径，回 `unavailable` 并在 stderr 说明。host **不得**因拉起失败而崩溃或挂死。

## 6. 转发语义

host 收到帧 → D05 校验 → 转发 → **等应用回包** → 原样转回浏览器。

**host 不自行编造成功响应。** `health` 是唯一例外，它不需要数据层。验收标准 3「应答发出前数据已持久化」因此落在应用进程身上，host 只是管道。

应用进程收到帧后**再跑一次 D05 校验**：纵深防御，不因「来自我们自己的 host」而跳过。

## 7. 测试

均无需浏览器，零系统痕迹，双平台可进 CI。

- **crate 单测**：端点建立、连接、收发、对端关闭、重复监听被拒
- **权限**：macOS 断言 socket 模式为 `0600`；Windows 断言管道 DACL 仅含当前用户 SID
- **路径超长**：macOS 用超过 `sun_path` 上限的 `RESUMEPRO_DATA_DIR`，断言得到明确错误而非 bind 失败
- **陈旧 socket**：预先放一个无人监听的 socket 文件，断言持锁者能重新绑定
- **单实例**：两个应用进程抢锁，断言只有一个在监听
- **端到端**：真实应用进程（`--hidden` + 隔离数据目录）+ 真实 host 进程，喂 `health` 帧，断言链路通
- **冷启动**：不预先起应用，只起 host，断言它把应用拉起并完成转发
- **超时**：把拉起用的可执行路径指向不存在的文件，断言超时后回 `unavailable` 而非卡死

新 crate 与新进程测试**在创建时即接入 CI**。

## 8. 明确不做

不实现握手（下一片，需应用返回 `archiveId` / `restoreEpoch`）；不把写入转发到 D03 事务接口（再下一片）；不做安装注册（D13）；不改插件（D07）。

本片之后，`health` 会真正经由应用进程往返，但业务写入仍返回 `unavailable`。
