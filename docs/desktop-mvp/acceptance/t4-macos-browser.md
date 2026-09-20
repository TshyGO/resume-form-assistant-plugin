# T4-macOS Apple Silicon Chrome / Edge 安装闭环

本清单先积累 macOS 实机证据，不改变 D14 原有 Windows x64 必测范围。macOS 全部通过时，总状态仍为 `PARTIAL_PLATFORM_ACCEPTANCE`，Windows 保持 `NOT_RUN`，不能据此关闭 D14。

## 0. 主机预检（正式走查前）

创建 run 目录或登记候选之前，先确认这台 Mac 能不能当正式证据机：

```bash
python3 desktop/scripts/d14_macos_acceptance_check.py probe-host \
  --output docs/desktop-mvp/acceptance/runs/<run-id>/host-probe.json \
  --dedicated-test-account
```

`--dedicated-test-account` 表示操作者确认：当前是隔离测试账户、浏览器用独立测试 Profile、只用 `d14-v1` 合成数据、不会把日常系统盘写满。没有这条声明时，结论只能是 `BLOCKED`。

`READY` 还要求 Apple Silicon `arm64`、`spctl --status` 为 `assessments enabled`、已装正式版 Chrome 和 Edge、普通标准用户、没有现成的 ResumePro 档案。Gatekeeper 关闭的开发机不能当 T4/T5 证据机；本机 `spctl accepted` 也不能当作 Gatekeeper 通过。

`probe-host` 不安装 DMG、不写 Native Messaging、不把任何 J/F case 标成 `PASS`。结论为 `BLOCKED` 时先换隔离账户或打开评估，再进入 M1/M2。

## 1. 固定范围

- 目标为 `aarch64-apple-darwin`，分发格式为 DMG；Intel Mac、Safari、Firefox 不在本轮范围。
- 使用发布工作流下载的候选 DMG 和同一源码 commit 对应的插件 ZIP。源码目录、`target/release`、开发注册和 CI 编译成功都不能代替安装证据。
- 当前候选允许明确批准的未签名、未公证状态，但报告、安装体验和发布说明必须一致。首次启动只走 macOS 提供的“右键打开”或“隐私与安全性 → 仍要打开”；不得使用 `xattr` 或关闭系统安全机制。
- Chrome、Edge 使用独立的测试 Profile 和合成档案；不使用日常浏览器 Profile、真实简历、真实邮件或真实 API Key 作为证据附件。
- 配置声明最低 macOS 11.0。若本轮只在当前系统执行，只能声明当前系统版本已验证，`minimumVersionActuallyTested` 必须保持 `false`。

## 2. 创建运行目录

M1 只创建空白证据结构，不登记候选、不自动标记通过：

```bash
python3 desktop/scripts/d14_macos_acceptance_check.py init-run \
  --run-dir docs/desktop-mvp/acceptance/runs/2026-09-20-macos-rc1
```

生成：

```text
<run-dir>/
├── macos-environment.json
├── chrome/report.json
├── edge/report.json
└── lifecycle/report.json
```

执行前可检查结构仍为原始状态：

```bash
python3 desktop/scripts/d14_macos_acceptance_check.py verify-scaffold \
  --run-dir docs/desktop-mvp/acceptance/runs/2026-09-20-macos-rc1 \
  --require-pristine
```

`init-run` 拒绝覆盖已有目录。大截图、录像、DMG、ZIP、浏览器 Profile 和档案库应放在受控制品存储，只在 JSON 报告中引用脱敏链接。

## 3. 候选与环境预检

M2 登记候选后，开始业务走查前必须记录并核对：

1. DMG 与插件 ZIP 的稳定 HTTPS 下载地址、文件名、字节数和 SHA-256。
2. 完整 40 位源码 commit、桌面版本、插件版本、`protocolVersion` 和固定扩展 ID。
3. 硬件型号、Apple Silicon 芯片、`arm64` 架构、macOS 产品版本/build、时区、区域和普通测试账户。
4. DMG 能挂载并将 `Resume Pro Desktop.app` 拖入 `/Applications`；bundle identifier 为 `com.resumepro.desktop`，版本与候选一致。
5. 实际 Gatekeeper 提示、签名和公证检查结果。未知或与批准策略不一致时不得继续签收。
6. 应用启动后由产品自身生成生产 Native Messaging 清单；不得使用 `nm-dev-register.mjs` 代替：

   - `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.resumepro.desktop.json`
   - `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.resumepro.desktop.json`

7. 两份清单的 `path` 指向 `/Applications` 内实际 App 的可执行文件，`type=stdio`，`allowed_origins` 只有固定扩展 ID，没有通配来源。
8. Chrome、Edge 分别从候选 ZIP 的原样解压目录加载扩展；版本、ID、文件集合和哈希与候选一致。

预检结果写入 `macos-environment.json` 和每个浏览器报告的 `t4Preflight`。预检通过也不会自动把 J/F case 改成 `PASS`。

## 4. 浏览器闭环

Chrome、Edge 各自完整执行一遍，不能共享结果：

| Case | 实际用户操作 | 必查证据 |
| --- | --- | --- |
| J01 | 安装 App、加载候选 ZIP、关闭主窗口后从浏览器连接并保存岗位 | DMG/APP 身份、Gatekeeper、两份生产注册、握手、实际 host 路径 |
| J02 | 桌面服务确实不可用时保存岗位并用 v1 填写留档；切换 v2、重启浏览器后恢复 | ACK 前 IDB 原字节、只补传一次、历史快照仍为 v1 |
| J03 | 填写后查看阶段，明确确认投递，再修改模板 | 填写不自动投递；确认才写事件；历史快照不变 |
| J04 | 导入通知，执行预览、分析、暂存、重启、修改、确认两次 | 原件可回看；确认前正式字段不变；确认原子且幂等 |
| J05 | 同公司 A/B 岗位消歧，人工选 B；Offer 后补录旧测评 | 不自动误选；只更新批准对象；Offer 不回退 |
| J06 | 建立待办、备份、恢复新库、重复恢复并连接旧队列插件 | 时间、附件、快照、事件顺序、restore epoch 和对账结果 |
| J07 | 从可追溯旧 DMG 升级；测试兼容/不兼容插件；移除后重装 | 升级前后哈希、协议诊断、档案保留、注册自愈 |
| J08 | 移除桌面 App 后继续用原候选插件填写 | 填写仍可用；提示准确；未配对 Profile 不积累长期队列 |

F01–F12 复用 [cases.md](cases.md) 的断言，并补真实浏览器、生产 Native Messaging、钥匙串、候选制品与隔离磁盘证据。F13 以及 J06/J07 的完整生命周期结果记录在 [t5-macos-lifecycle.md](t5-macos-lifecycle.md)。

## 5. 报告状态

- `PASS` 必须同时填写 `actual` 和至少一条非空证据；截图不能替代档案、哈希或协议结果。
- `NOT_APPLICABLE` 必须引用已批准范围决定；必测项不能用它绕过。
- `BLOCKED`、`FAIL`、`NOT_RUN` 都不能放行 Mac 候选。
- Chrome、Edge 报告必须绑定同一候选、源码 commit、环境文件和依赖签收。
- 具名审阅只批准 macOS 平台；总状态继续为 `PARTIAL_PLATFORM_ACCEPTANCE`。

