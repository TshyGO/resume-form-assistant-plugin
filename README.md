# 简历灵填助手

面向网申场景的浏览器插件。核心用法：在 Excel 里维护你的简历数据，打开招聘网站的申请页面后，点一下"AI 填写"，插件会调用大模型把字段一一对应到表单里。AI 能处理大多数基础信息，遇到它填错或填不了（比如日期选择器）的地方，手动补上就好。

## 主要功能

- **多套模板**：导入多份 Excel，填不同岗位前切换对应模板
- **AI 辅助填写**：点一次按钮，让模型帮你把简历字段匹配到网页表单
- **简历解析**：上传 PDF / Word / TXT，AI 提取结构化信息并生成 Excel 模板
- **接口自定义**：支持 OpenAI 兼容的任意接口，自带 API URL、模型名、Key 配置

填写准确率取决于网站 DOM 结构和模型能力，基础信息（姓名、手机、邮箱等）通常没问题。时间选择器、级联下拉等特殊控件目前无法程序化填写，需要手动操作。

## 安装（开发者模式）

1. 打开浏览器扩展管理页（Chrome 地址栏输入 `chrome://extensions`）
2. 开启右上角的**开发者模式**
3. 点击**加载已解压的扩展程序**
4. 选择本项目文件夹（包含 `manifest.json` 的那一层）

目前没有上架应用商店，分发时把整个文件夹打包成 zip 发给对方，解压后按上述步骤加载即可。

## 使用流程

1. 在 Excel 里按模板格式维护简历数据（`一级分类 / 字段名 / 值` 三列）
2. 点击插件图标，在**模板管理**里导入 `.xlsx` 文件
3. 在 **AI 配置**里填好接口地址、模型名、API Key 并保存
4. 打开目标网站的申请表单，页面右侧会出现悬浮助手
5. 选好模板，点 **AI 填写**，等结果出来后检查一遍，手动补全填错或漏填的字段

如果手头只有 PDF/Word 格式的简历，可以用**AI 解析简历**功能先提取成 Excel，再导入使用。

## 目录结构

```
manifest.json          插件清单
popup.html/css/js      弹窗界面
content.js/css         页面注入脚本（侧边栏、字段识别、填写）
background.js          后台服务，负责 AI 接口调用和消息路由
ai-helpers.js          字段匹配和数据清洗
tests/                 单元测试
icons/                 插件图标
```

## 本地测试

```bash
node --test tests/ai-helpers.test.js
```

## 已知问题

- `icons/icon-render.html` 是开发时生成图标用的调试页面，不应出现在生产仓库里，下个版本会清理
- 时间选择器、级联下拉等控件暂不支持自动填写

## 隐私说明

仓库里不包含任何真实简历数据，测试数据均为匿名示例。

## 许可证

MIT License — 见 [LICENSE](LICENSE) 文件。

---

## English Summary

Resume Form Assistant is a Chrome extension for filling job application forms. You maintain your resume data in an Excel file, then click "AI Fill" on any job application page — the extension calls a configurable LLM to match your resume fields to the form. Standard fields (name, phone, email, etc.) usually work well; date pickers and complex controls still need manual input.

**Install (Developer Mode):** Load the unpacked folder containing `manifest.json` via `chrome://extensions`.

**Configure:** Enter your OpenAI-compatible API URL, model name, and key in the AI Settings tab.

**Run tests:** `node --test tests/ai-helpers.test.js`

MIT License.
