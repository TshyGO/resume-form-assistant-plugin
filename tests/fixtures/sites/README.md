# 深度分析评测语料（#224）

每个目录是一份页面：

- `outline.txt`：插件会发给强模型的脱敏页面大纲，用 `scripts/capture-outline.mjs` 从本机保存的 HTML 生成，**再人工检查一遍**，确认没有姓名、联系方式、证件号、网址、凭据或任何真实简历内容。
- `expected.json`：人工标注的期望说明书。`fields` 是应当识别出的字段（编号、题目、分组、控件类型）；`notFields` 是容易误认成字段的候选（页头搜索等）；`preActions` 是填写前必须先点的按钮；`forbiddenRefs` 是绝不能出现在说明书里的编号（提交、删除、跨页链接）。
- `page.html`：只有合成页面才带，资料全部虚构。真实网站只保留脱敏后的 `outline.txt`，不保存网页原文。

| 目录 | 来源 | 说明 |
| --- | --- | --- |
| `beisen-application` | `tests/fixtures/field-scan/beisen-application.html` | 北森网申页结构，自定义下拉、日期、多段经历 |
| `aria-custom` | `tests/fixtures/control-adapters/custom-aria.html` | ARIA 下拉与级联 |
| `view-mode-profile` | 合成 | 查看状态的在线简历：没有输入框，要先点「编辑」 |
| `injection-labels` | 合成 | 题目和提示文字里夹着给 AI 的指令 |
| `shadow-iframe` | 合成（大纲取自真机） | 表单在开放 Shadow DOM 和同源 iframe 里，普通扫描为 0 个字段 |

## 评测

模拟模型（不联网、不花钱，CI 里也跑）：

```bash
node scripts/eval-deep-analysis.mjs --mock expected
```

真实模型**会产生费用**，只在改提示词或更新推荐模型时手动运行，不进 CI。Key 只从环境变量读，不写进命令行历史或结果文件：

```bash
RESUME_PRO_EVAL_API_KEY=... node scripts/eval-deep-analysis.mjs --base-url https://api.example.com/v1 --model some-model --confirm-paid --out eval-result.json
```

输出每份语料和合计的：字段召回率、字段准确率、控件类型准确率、非法输出比例（说明书没通过插件校验）、触碰禁止按钮的次数、耗时，以及服务商返回的 token 用量（拿不到时为空）。
