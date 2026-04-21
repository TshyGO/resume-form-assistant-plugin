# 简历灵填助手（Resume Form Assistant）

一款面向网申场景的浏览器插件：支持导入 Excel 模板、解析简历（PDF/Word/TXT）并智能填写网页表单。

## 功能亮点

- 模板管理：支持多套 Excel 模板导入和切换
- 智能填写：依据字段语义匹配网页表单
- AI 解析简历：上传 PDF / DOCX / TXT，提取结构化信息
- AI 可配置：支持 OpenAI 兼容接口（自定义 API URL、模型名、API Key）
- 隐私优先：高风险基础信息字段采用保守策略，低置信度留空

## 安装方式（开发者模式）

1. 打开浏览器扩展管理页面
2. 打开开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择本项目目录（即包含 `manifest.json` 的目录）

## 使用说明

1. 点击插件图标，打开弹窗
2. 在“模板管理”页导入 Excel 模板（`.xlsx` / `.csv`）
3. 可选：点击“AI 解析简历”，上传 `.pdf` / `.docx` / `.txt` 自动提取信息
4. 在“AI 配置”页填写以下信息并保存：
   - API URL（OpenAI 兼容接口）
   - 模型名称
   - API Key
5. 打开目标招聘表单页面，开始自动填写

## 目录结构

- `manifest.json`：插件清单
- `popup.html` / `popup.css` / `popup.js`：插件弹窗界面与交互
- `content.js` / `content.css`：页面字段识别与填写逻辑
- `background.js`：后台服务与消息路由
- `ai-helpers.js`：AI 匹配与数据清洗辅助
- `tests/ai-helpers.test.js`：核心辅助逻辑测试
- `icons/`：插件图标

## 本地测试

当前仓库使用 Node 内置测试框架，可在项目目录执行：

```bash
node --test tests/ai-helpers.test.js
```

## 隐私与安全

- 本仓库不包含任何真实个人简历数据
- 测试数据均为匿名示例
- 发布时已排除本地调试浏览器配置等非必要文件

## 许可证

建议使用 MIT License（可按你的实际需求调整）。

---

## English

Resume Form Assistant is a browser extension for job application forms. It helps you import resume templates, parse resume files, and auto-fill web forms with structured data.

### Features

- Template management with multiple Excel templates
- Smart field matching for web forms
- Resume parsing for PDF / DOCX / TXT files
- Configurable AI settings (OpenAI-compatible endpoint)
- Privacy-first behavior for high-risk personal fields

### Installation (Developer Mode)

1. Open your browser extension management page
2. Enable Developer Mode
3. Click Load unpacked extension
4. Select this project folder (the one containing `manifest.json`)

### Usage

1. Open the extension popup
2. Import your Excel template (`.xlsx` / `.csv`) in Template Management
3. (Optional) Use AI Resume Parsing to extract data from `.pdf` / `.docx` / `.txt`
4. Configure AI settings (API URL, model, API key)
5. Open a target job form page and start auto-filling

### Run Tests

```bash
node --test tests/ai-helpers.test.js
```

### Privacy

- No real personal resume data is included in this repository
- Test data is anonymized
- Local debug/browser profile files are excluded from version control