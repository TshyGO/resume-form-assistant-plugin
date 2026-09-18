# T2 业务闭环回归映射

T2 使用同一份 `fixtures/d14-v1/dataset.json` 和 `expected-results.json`，把插件、AI 提取、审核草稿与档案存储四层串在同一个业务预期下。这里登记的是确定性自动化；它不能替代 T4/T5 的真实安装和浏览器证据。

状态：**已完成**。实现已同步到最新 `origin/main` 基线，并在 Windows GNU Rust 工具链上执行通过。生成 JSON 由仓库 `.gitattributes` 固定为 LF，避免 Windows checkout 把行尾转换误报成夹具漂移。

## 新增回归

| 层级 | 测试 | 覆盖的业务断言 |
| --- | --- | --- |
| plugin/link | `tests/d14-business-regression.test.js` — `D14 T2: offline job and v1 fill become one application, immutable snapshot, then explicit submission` | J02/J03：离线保存与留档只创建一次；v1 原字节在完整 ACK 前留在 IDB；修改当前模板后仍上传 v1；填写不等于投递；重复明确投递不产生第二次业务写入 |
| plugin/link | `tests/d14-business-regression.test.js` — `D14 T2: same-company postings stay distinct and candidate lookup does not choose for the user` | J05：同公司 A/B 分开保存；候选查询不创建、不选择、不合并申请 |
| AI extract | `desktop/crates/ai-extract/tests/d14_business_regression.rs` — `d14_ambiguous_notice_keeps_both_candidates_for_user_choice` | J05：`c1/c2` 都映射回本地候选；正文缺职位名时保留歧义，不让模型凭空指定唯一岗位 |
| review logic | `desktop/src/ai/d14-business-regression.test.ts` — 三条 `D14 T2` 测试 | J04/J05：多候选必须选；用户修改后的分类、发送方式、阶段和待办才进入确认参数；ATS 面试保持 `automated`；更新进度默认关闭 |
| archive store | `desktop/crates/archive-store/tests/d14_business_regression.rs` — `d14_notice_review_is_explicit_idempotent_and_never_rolls_offer_back` | J04/J05：确认前正式分类、阶段和待办不变；确认时关联/分类/事件/待办原子写入；重复确认幂等；只更新用户选择的 B；Offer 后补录旧测评不回退阶段 |

## 固定数据契约

T2 将 `d14-v1` 的模型返回改为 D11 实际允许的字段和值：

- 候选使用 `candidates: ["c1", "c2"]`，不向模型暴露本地 UUID。
- 分类使用 `auto_ack / assessment_invite / interview_invite / action_required / offer / reject / other / unknown`。
- 发送方式使用 `sendMode`；待办使用 `todos[].due/timeZone`。
- 越界候选使用不存在的标签 `c99`，由提取层整体拒绝。

生成器仍是唯一数据源；修改后必须执行 `generate.mjs --check`，不能直接手改生成的 JSON。

## 执行命令

```powershell
node docs/desktop-mvp/acceptance/fixtures/d14-v1/generate.mjs --check
node --test tests/d14-acceptance.test.js tests/d14-business-regression.test.js
node --test --experimental-strip-types "desktop/src/**/*.test.ts"
cargo test --manifest-path desktop/crates/ai-extract/Cargo.toml --locked --test d14_business_regression
cargo test --manifest-path desktop/crates/archive-store/Cargo.toml --locked --test d14_business_regression
```

完整回归仍按根目录 `npm test` 和 `.github/workflows/desktop.yml` 执行。报告引用测试结果时必须记录源码 commit 和运行链接；源码文件路径本身不算执行证据。

本地闭环结果：插件 Node 回归 579 项、桌面纯 TypeScript 回归 151 项、`ai-extract` 11 项、`archive-store` 63 项全部通过；根目录 TypeScript 检查通过。

## T2 不证明什么

- 不证明安装包、Native Messaging 生产注册、Chrome/Edge 实装链路；这些属于 T4。
- 不证明恢复、升级卸载和真实 OS 提醒；这些属于 T5。
- 不把 F01–F13 的故障注入视为全部完成；T3 会在本回归之上补齐并登记故障矩阵。
