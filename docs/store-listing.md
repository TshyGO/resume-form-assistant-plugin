# Chrome Web Store 上架材料与权限说明

上架前要交的东西，以及**审核一定会问的那几条权限该怎么答**。清单的来源是
[#29 的评论](https://github.com/TshyGO/resume-form-assistant-plugin/issues/29)。

- 扩展 ID：`diagjmploldedipjdenmecmjokckelkl`（已建 item，状态 Draft）
- 正式发布的构建、打包和送审见 [chrome-web-store-release.md](chrome-web-store-release.md)。这份材料仍然要在 Developer Dashboard 里填好，流水线不会替你创建商店条目，也不会自动把审核通过的版本公开给所有用户。
- 发布者账号与 Edge 商店的情况见 #29，这里不重复。
- **ID 固定证据**：`manifest.json` 的 `key` 是 SPKI DER 公钥的 base64；对它的字节做 SHA-256、取前 16 字节并按 a–p 映射，得到上面的 ID。仓库测试 `tests/extension-id.test.js` 会在 CI 重新计算并断言，Rust host 白名单与本文件也被同一测试锁定。

---

## 1. 权限：每一条都得说得出理由

审核对 `<all_urls>` 最较真。下面是我们的答法，**不是模板话，是这个产品真实的工作方式**。

### `host_permissions: ["<all_urls>"]` 与 `<all_urls>` 的内容脚本

**为什么不能换成 `activeTab` + `optional_host_permissions`：**

网申表单遍布各家公司自己的招聘域名（`careers.某公司.com`、各家 ATS 的二级域名、
以及大量一次性的活动页），事先列不出一份域名清单，用户也不该为了填一次表单先去
「添加这个网站」。

扩展在页面上做的第一件事是**判断这一页是不是网申表单**——那必须在页面加载后就能读到
DOM。`activeTab` 只在用户点击扩展图标之后才给权限，那时候「这一页有没有表单、要不要
提示」已经错过了。

**实际读写的范围仍然很窄：** 内容脚本会在所有网站注入，用来在本地判断当前页是不是网申表单；
只有你主动使用填写功能时才读写当前页的表单字段。除用户主动触发的 AI 填写（把字段说明和
相关简历片段交给本机桌面程序，由桌面发到用户自己配置的接口）外，不向第三方发送页面内容；不采集浏览历史。

### `tabs`

用来识别用户当前标签页、向该页的内容脚本发送填表操作消息；也用于查找、复用并聚焦已经打开的 Resume Pro 状态页，或打开用户主动点击的桌面程序下载页。扩展不采集浏览历史；只有用户主动使用填写功能时，内容脚本才读取和写入当前页表单字段。

### `sidePanel`

浏览器工具栏图标打开原生侧边栏，显示桌面里的当前模板、填表进度和可搜索的简历字段。侧边栏作为扩展页面，通过扩展消息请求当前标签页的内容脚本执行填写；它不是对网页开放的 `web_accessible_resources`。

### `nativeMessaging`

和桌面程序通信。**这是扩展的核心依赖**：简历模板、「我的信息」和 AI 设置都在桌面程序里，扩展经 Native Messaging 读取简历、写回「我的信息」、请桌面转发 AI 请求、保存岗位与投递记录。host 清单的 `allowed_origins` 里**只写了本扩展的 ID**，没有通配——
机器上别的扩展启动不了这个 host。

### `storage` / `offscreen` / `alarms`

分别是：存侧栏界面状态、待同步队列与旧数据迁移状态（不存简历和 Key）；在离屏文档的专用 Worker 中组装
用户主动触发的 AI 填写与 AI 辅助新增条目的提示词并校验结果（请求由桌面程序发出）；安排离线补传与迁移状态查询的重试。

当前填写功能由 manifest 中静态声明的内容脚本承载，没有调用 `chrome.scripting`，也没有依赖
`activeTab` 的临时授权。因此商店提交版本移除了这两项历史遗留权限；静态内容脚本及主机权限保持不变。

---

## 2. `web_accessible_resources` 只留真正要暴露的

2026-09-17 收敛过一次。判断标准是「**这个文件是不是由网页那一侧发起加载的**」：

| 留下 | 为什么 |
| --- | --- |
| `link/extract.mjs`、`copy.mjs`、`fillrecords.mjs`、`snapshot.mjs` 及它们的静态依赖 | 内容脚本里 `import(chrome.runtime.getURL(...))` 动态加载；逐文件列出，不用目录通配 |
| `content.css` | 内容脚本 `fetch(chrome.runtime.getURL("content.css"))` |

移掉的那些（`popup.js`、`popup.css`、`ai-*.js`、`resume-utils.js`、`profile-fields.js`、`form-agent.js`、
`icons/*`）都是扩展页面自己的子资源。0.4.1 起 `xlsx.full.min.js`、`mammoth.browser.min.js`、`vendor/pdfjs/*` 已从扩展里删除（简历解析与 Excel 导入导出搬到了桌面程序）。扩展页面加载同源资源不需要
`web_accessible_resources`；把它们列出来只有一个效果：任何网页都能加载它们，也能借此
探测出你装了这个扩展。

这一条列表由 `tests/manifest-war.test.js` 锁定，误把子资源重新暴露会让 CI 变红。
真实浏览器冒烟（Playwright Chromium/Edge，有头）见 `desktop/scripts/war_browser_check.py`：
扩展页能加载自己的 `popup.css`/`popup.js`，普通网页只能加载上面这 3 类 WAR 文件，
其余全部被浏览器阻止。

**加载来源盘点（2026-09-17，全仓 `rg getURL` / `rg "url\\(" content.css`）：**

| 加载方 | 资源 | 要不要 WAR |
| --- | --- | --- |
| 内容脚本/页面侧 | `content.css`（`content_scripts.css` 注入 + `content.js` `fetch`）、`extract/copy/fillrecords/snapshot` 及其静态依赖（`content.js` 动态 `import`） | 要，已逐文件列在 manifest；`worker/chrome/transport` 等 service-worker 专用模块不暴露 |
| 扩展页/offscreen | `popup.html/css/js`（状态页）、`sidepanel.html/css/js`、`resume-data.js`、`ai-*.js`、`resume-utils.js`、`profile-fields.js`、`form-agent.js`、`ai-host.html` | 不要，扩展源自己加载 |
| 浏览器 UI | `icons/*`（只在 `manifest.json` 的 `action`/`icons` 字段里） | 不要；没有任何内容脚本把它注入网页 |

`content.css` 里没有 `url(...)` 引用，因此没有漏掉的图片或字体。

**权限集合**：`manifest.json` 申报的是 `offscreen`、`storage`、`tabs`、`sidePanel`、`nativeMessaging`、`alarms`，加上 `<all_urls>` host 权限；`privacy-policy.md` 的权限表逐条对应，没有未申报的权限。

**状态页边界：** [#125](https://github.com/TshyGO/resume-form-assistant-plugin/issues/125) 起 `popup.html` 只在扩展自己的标签页打开（0.4.1 起它是状态页，也作为 `options_ui` 的选项页），不暴露给网页。网页既不能 iframe 它，也不能用公开 URL 探测该页面。

---

## 3. 数据用途声明（后台表单要如实勾）

- **个人身份信息**：是。简历里的姓名、邮箱、电话。
- **是否传输给第三方**：**是**——用户主动使用 AI 填写时，表单字段说明和相关简历片段经本机桌面程序发往用户自行配置的 AI 接口，
  请求由桌面程序用用户配置的 API Key 认证。必须如实声明，不能因为「我们没有服务器」就当作没有传输。
  （AI 简历解析在桌面程序里进行，不经过扩展。）
- **网站内容**：AI 填写涉及当前网申页面的字段说明和内容，应按后台定义如实声明。
- **身份验证信息**：0.4.1 起扩展不保存 AI API Key（Key 在桌面程序的系统凭据库里）。从 0.4.0 升级时，旧 Key 会经本机 Native Messaging 交给桌面一次；桌面没能导入时旧 Key 留在扩展本地存储，用户可在状态页删除。按后台定义如实声明。
- **是否出售或用于与功能无关的用途**：否。
- **是否用于判断信用**：否。
- **更新检查**：D13 #121 已实现为只读 GitHub releases、每天最多一次、可在设置里关闭；测试在 `desktop/src-tauri/src/update_check.rs`。
- 隐私政策链接：<https://github.com/TshyGO/resume-form-assistant-plugin/blob/main/docs/privacy-policy.md>（公开、无需登录）。

---

## 4. 列表页材料

- [x] 128×128 图标：`icons/icon128.png`
- [ ] 新版侧栏与状态页截图：原截图若仍显示旧悬浮面板，发布前应更新并重新核对商店权限说明
- [x] 1280×800 截图：[`store-assets/store-sidebar-1280x800.png`](store-assets/store-sidebar-1280x800.png)，只含合成公司、岗位与简历数据
- [x] 分类：`Productivity`
- [x] 语言：`中文（简体）`

**简短描述：** 求职网申填写助手，配合 Resume Pro 桌面程序使用：简历在桌面管理，扩展在网页上填写。

**详细描述：**

Resume Pro 帮你把重复的网申信息整理成可复用模板，并在招聘网站表单中按需填写。**需要同时安装 Resume Pro 桌面程序**（支持 macOS Apple 芯片与 Windows x64）：简历模板、「我的信息」和 AI 设置都在桌面程序里管理，数据只保存在你自己的电脑上；扩展负责在网页上填写。

- 在浏览器侧边栏选择桌面里的简历模板，一键 AI 填写或逐个字段填写，提交前始终由你检查；
- AI 请求由桌面程序发往你自行配置的 OpenAI 兼容接口，扩展不保存 API Key，也不提供或代理模型服务；
- 保存岗位、确认投递和填写留档写进桌面程序的申请记录；
- 从旧版升级时，扩展里原有的模板和设置会在你于桌面确认后迁入桌面。

扩展不会自动提交网申，也不会把简历上传到作者服务器。隐私政策公开说明了本地存储、第三方 AI 请求和桌面通信边界。

---

## 5. 上架前还没做完的事

- **Chrome Web Store 发布动作**：item 已建（Draft，ID `diagjmploldedipjdenmecmjokckelkl`），包可以上传。
  `manifest.json` 里的公钥已经固定了这个 ID，本地 unpacked 与 Chrome 商店版是同一个扩展 ID；
  原先担心的「换 ID 会丢 `chrome.storage.local`」因此不再存在，**不需要为上架单独做插件设置的导出 / 导入**。
- **Edge Add-ons（可选）**：Edge 商店是另一个商店。以后如果要从 Edge 商店发行，先核实 Edge 对同一份公钥 / ID 的处理；
  没有把握时继续让 Edge 用户从 Chrome 商店安装即可（Edge 支持「允许来自其他应用商店的扩展」），host 注册已经覆盖这条路径。
- **列表材料**：已备齐，见第 4 节；截图只使用合成数据。
- **隐私政策的公开地址**：<https://github.com/TshyGO/resume-form-assistant-plugin/blob/main/docs/privacy-policy.md>。
- **首次发布后复核扩展 ID**：公钥推导和商店 Draft item 现在一致；首次真正发布后再核对一次，若 Edge 或商店换了 ID，就恢复插件设置的导出/导入兜底，不要直接让用户从零开始。
- **D14 保留 storage.local 分区验证**：首次从商店安装后确认扩展存储分区与 unpacked 一致；若不一致，恢复导出/导入兜底。
