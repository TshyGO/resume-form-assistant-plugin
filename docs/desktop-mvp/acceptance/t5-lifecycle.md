# T5 提醒、恢复、升级卸载与独立填写

T5 使用 T4 已批准的同一组候选字节，补齐真实 Windows 生命周期证据。自动化只能记录与校验结果；重启、休眠、杀进程、跨次日真实等待、安装器交互和卸载后填写必须在隔离机器上实际执行。

## 创建报告

T4 的 Chrome 或 Edge 基线报告必须已在普通用户环境完成 J01–J08、F01–F13，生产注册和安装后烟测均通过，并经过具名 `APPROVED` 审阅：

```powershell
python desktop/scripts/d14_t5_check.py prepare `
  --candidate "docs\desktop-mvp\acceptance\runs\2026-09-19-rc1\artifacts.json" `
  --baseline-report "docs\desktop-mvp\acceptance\runs\2026-09-19-rc1\chrome\report.json" `
  --run-dir "docs\desktop-mvp\acceptance\runs\2026-09-19-rc1\t5"
```

生成的 `report.json` 含 16 个 `NOT_RUN` 检查项；脚本不会自动标记通过。

## 文件一致性证据

在重启、升级、默认卸载、恢复前后对合成档案目录取只含相对路径、字节数和 SHA-256 的快照：

```powershell
python desktop/scripts/d14_t5_check.py snapshot `
  --root "$env:LOCALAPPDATA\ResumePro\archive" `
  --output ".\before-upgrade.json" --label before-upgrade

python desktop/scripts/d14_t5_check.py snapshot `
  --root "$env:LOCALAPPDATA\ResumePro\archive" `
  --output ".\after-upgrade.json" --label after-upgrade

python desktop/scripts/d14_t5_check.py compare `
  --before ".\before-upgrade.json" --after ".\after-upgrade.json" `
  --output ".\upgrade-compare.json" --mode preserved
```

`equal` 要求文件集合与字节完全相同；`preserved` 允许新增文件，但不允许原文件丢失或变字节。只对合成测试档案运行，不提交真实简历、附件或档案路径。

## 实机顺序

1. 使用 T4 基线建立待办，分别验证关窗、重启、休眠唤醒、杀进程、主动退出；跨次日用真实等待，不改系统时钟。记录 OS 通知与应用内待办，确认无重复投递。
2. 导出完整备份，核对 ZIP 清单、附件和快照哈希；用新的 `RESUMEPRO_DATA_DIR` 恢复，再恢复同一备份。核对业务内容、`eventSequence` 与每次不同的 `restoreEpoch`。
3. 保留带旧 epoch 消息的插件 Profile，恢复后连接，确认旧队列暂停并只读对账，不自动重放。
4. 在隔离卷制造真实磁盘满，验证失败时旧档案目录与 `current.json` 不变；另测损坏 ZIP 和路径穿越包。
5. 使用明确记录源码 SHA/版本/哈希的旧候选升级到本次候选；核对迁移前备份、数据、附件、生产 Native Messaging 注册及协议兼容/不兼容诊断。
6. 默认卸载后重装，确认档案与备份保留、仅本应用注册被清理；再在独立 run 中显式勾选删除并完成二次确认，验证数据被删除。
7. 卸载桌面后，用原候选插件在 Chrome、Edge 各填写一次；提示应为桌面不可用，且从未配对的 Profile 不建立长期离线队列。

每项在 T5 报告中填写实际结果、证据链接和缺陷。`BLOCKED` 不能放行。

## 完成门禁

```powershell
python desktop/scripts/d14_t5_check.py verify `
  --candidate "docs\desktop-mvp\acceptance\runs\2026-09-19-rc1\artifacts.json" `
  --report "docs\desktop-mvp\acceptance\runs\2026-09-19-rc1\t5\report.json" `
  --require-complete
```

16 项必须全部 `PASS` 且各有证据，审阅者与审阅时间非空，决定为 `APPROVED`，无阻断缺陷。
