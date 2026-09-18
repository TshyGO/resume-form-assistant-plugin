# T3 中断、恢复与隐私故障矩阵

机器可校验的逐项映射见 [t3-fault-matrix.json](t3-fault-matrix.json)。每一项都记录精确测试名、测试层级和仍需补的高层证据，禁止只写一个文件名就宣称整项通过。

## 本轮新增的防线

- F07：备份 ZIP 发布前，附件数和快照数必须与数据库一致性快照中的计数一致。快照形成后文件被删除时，备份失败并保留上一份完整文件。
- F10：AI 提取层现在校验真实日历和钟表范围；`2026-02-30`、`24:00:00`、非法偏移不会进入建议待办。
- F10：`d14-v1` 的非法 JSON、非法枚举、越界候选和非法日期直接经过真实解析器，验证失败或安全降级。
- F11：`d14-v1` 的全部禁采标记贯穿 URL 脱敏、快照和发布文件扫描；插件 ZIP 的审定文件中不得出现夹具、测试或任一标记。
- F11：无 ATS 规则的裸 `code` 被建模为 URL 查询参数，而不是通知正文；原件正文应可追溯，URL 凭据必须在进入意图前删除。

## 状态解释

- F01–F12：`automationStatus=COVERED` 只表示已有精确、已执行的自动化覆盖，不等于验收报告的 `PASS`；表中列出的浏览器、安装器、真实服务、候选产物或隔离磁盘证据仍由 T4–T7 补充。
- F13：只完成调度和界面语义自动化，正式状态保持 `PARTIAL`。杀进程、跨次日、休眠、重启和主动退出必须在真实 Windows 环境执行，不能用单元测试替代。
- 因 F13 和 F08 的真实 OS/磁盘证据尚未执行，T3 的正式签收仍是 `AUTOMATION_COMPLETE_REAL_OS_PENDING`，不能把报告模板中的 case 改为 `PASS`。

## 本地验证结果与边界

- 插件 Node 回归：582 项通过；桌面纯 TypeScript：151 项通过；根目录 TypeScript 检查通过。
- `ai-extract`：13 项通过；`backup`：28 项通过；`archive-store`：63 项通过。
- `src-tauri` 在本机 GNU 工具链上完整编译成功，但测试进程启动时报 Windows `STATUS_ENTRYPOINT_NOT_FOUND`。PR #127 的标准 Windows MSVC 与 macOS CI 已通过，为其中映射的恢复、AI 命令和待办测试提供标准工具链证据；本地 GNU 结果仍只记为编译成功。
- F08 的真实磁盘满和 F13 的真实生命周期动作仍属于 T5，不在本轮伪造结果。
- F07 的数量门禁负责阻止缺件/孤儿文件残包；数据库引用的精确路径与 SHA-256 对 ZIP manifest 的逐项绑定仍保留给 T6 发布门禁。

## 执行命令

```powershell
node docs/desktop-mvp/acceptance/fixtures/d14-v1/generate.mjs --check
node --test tests/*.test.js
node --test --experimental-strip-types "desktop/src/**/*.test.ts"
cargo test --manifest-path desktop/crates/ai-extract/Cargo.toml --locked
cargo test --manifest-path desktop/crates/archive-store/Cargo.toml --locked
cargo test --manifest-path desktop/crates/backup/Cargo.toml --locked
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked --lib
```
