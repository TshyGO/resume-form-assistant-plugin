# D06 第二片：按配对设置授权调用方 origin

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-09-08 |
| 上级 | [D06 #24](https://github.com/TshyGO/resume-form-assistant-plugin/issues/24) · [Roadmap #39](https://github.com/TshyGO/resume-form-assistant-plugin/issues/39) |
| 前一片 | [帧层与 health 回路](2026-09-08-d06-nm-frame-design.md)（PR #41，`7a536f7`） |
| 基线 | `7a536f7` |

上一片提取了调用方 origin 但**不做授权**，理由是「白名单来自配对流程」。该理由已不成立：D02 早已把 `chromeExtensionId` / `edgeExtensionId` 存进 `settings.json`。本片接上授权。

## 1. 白名单从哪来

`data-service` 的 `PairingDraft` 已有两个字段，由 D02 的配对表单写入 `settings.json`。把非空的 ID 各构造成一条 origin：

```
chrome_extension_id → chrome-extension://<id>/
edge_extension_id   → chrome-extension://<id>/
```

Edge 是 Chromium 内核，其扩展 origin 同样是 `chrome-extension://` 方案，因此两个字段产出同一形式。

`allowed_origins` 禁止通配符（[ADR §3.7](../../desktop-mvp/adr-architecture.md)、威胁模型第 5 条）。D05 的 `origin_allowed` 已经内建这一点：含 `*` 的 origin 与含 `*` 的白名单项都不匹配，直接复用，不另写比对逻辑。

## 2. 读取必须无副作用

**不能用 `DataHost`。** `DataHost::initialize_with` 会调用 `ensure_layout()` 建目录，并 `acquire_lock()` 抢实例锁 —— 而实例锁属于应用进程。NM host 是翻译器，不是写入者（D01 决策 3）。

因此在 `data-service` 增加一个只读入口：

```rust
pub fn read_pairing_draft_at(settings_file: &Path) -> PairingDraft
```

它只读文件，不建目录、不取锁、不写日志。`HostPaths::resolve()` 本身不建目录（建目录是独立的 `ensure_layout`），可以安全调用。

设置文件缺失或无法解析时返回默认值（两个 ID 均为空），等同于「未配对」。

## 3. 三种调用方状态

```rust
pub enum Caller {
    /// 未提供 origin：测试入口 --nm-host。
    Unidentified,
    /// origin 在配对设置中。
    Authorised(String),
    /// 提供了 origin 但与配对不符。
    Rejected(String),
}
```

| 状态 | 行为 |
| --- | --- |
| `Authorised` | 按上一片的语义正常应答 |
| `Rejected` | **逐条**回 `identity_not_allowed`，保持连接 |
| `Unidentified` | 正常应答（测试入口，无 origin 可授权） |

`Rejected` 选择逐条应答而非直接退出：直接退出在插件侧表现为「连接莫名其妙断了」，正是这几片一直在避免的难查失败。回一个合规的 D05 错误，插件能明确知道原因并提示用户去配对。未授权方反复发消息也拿不到任何东西，且浏览器本就不会为未注册的 origin 拉起 host。

`identity_not_allowed` 是 D05 既有错误码，不新增。

## 4. 明确不做

不写 `settings.json`；不建目录；不取实例锁；不写注册表或 NM manifest（归 D13）；不实现握手；不连接应用进程；不改配对界面。

授权通过**不是**写入许可 —— 本片之后仍然什么都写不了。

## 5. 测试

- `read_pairing_draft_at`：正常读取、文件缺失、内容损坏均返回可用结果；**断言调用后目录未被创建、锁文件未出现**
- `allowed_origins_from`：两个 ID 都在、只有一个、都为空
- `authorise`：命中 Chrome ID、命中 Edge ID、未命中、未配对、无 origin、带 `*` 的 origin
- 进程级：已授权 origin 得到 health 成功；未授权 origin 逐条得到 `identity_not_allowed` 且连接不断
