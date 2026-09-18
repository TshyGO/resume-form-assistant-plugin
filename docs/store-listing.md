# Chrome Web Store 上架材料与权限说明

上架前要交的东西，以及**审核一定会问的那几条权限该怎么答**。清单的来源是
[#29 的评论](https://github.com/TshyGO/resume-form-assistant-plugin/issues/29)。

- 扩展 ID：`diagjmploldedipjdenmecmjokckelkl`（已建 item，状态 Draft）
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
相关简历片段发到用户自己配置的接口）外，不向第三方发送页面内容；不采集浏览历史。

### `tabs`

用来查找、复用并聚焦已经打开的 Resume Pro 管理标签页，避免每次从侧边栏进入都重复开页；
也用于打开用户主动点击的版本下载页。只读取标签页 URL 元数据来识别本扩展自己的管理页，
不读取其它标签页正文，也不采集浏览历史。

### `nativeMessaging`

和桌面程序通信。host 清单的 `allowed_origins` 里**只写了本扩展的 ID**，没有通配——
机器上别的扩展启动不了这个 host。

### `scripting` / `activeTab` / `storage` / `offscreen` / `alarms`

分别是：按用户点击注入填写逻辑、当前页交互、存简历模板与设置、在后台解析简历文件、
安排离线补传的重试。

---

## 2. `web_accessible_resources` 只留真正要暴露的

2026-09-17 收敛过一次。判断标准是「**这个文件是不是由网页那一侧发起加载的**」：

| 留下 | 为什么 |
| --- | --- |
| `link/extract.mjs`、`copy.mjs`、`fillrecords.mjs`、`snapshot.mjs` 及它们的静态依赖 | 内容脚本里 `import(chrome.runtime.getURL(...))` 动态加载；逐文件列出，不用目录通配 |
| `content.css` | 内容脚本 `fetch(chrome.runtime.getURL("content.css"))` |

移掉的那些（`popup.js`、`popup.css`、`xlsx.full.min.js`、`mammoth.browser.min.js`、
`ai-*.js`、`resume-utils.js`、`profile-fields.js`、`form-agent.js`、`vendor/pdfjs/*`、
`icons/*`）都是 `popup.html` 这个**扩展页面**自己的子资源。扩展页面加载同源资源不需要
`web_accessible_resources`；把它们列出来只有一个效果：任何网页都能加载它们，也能借此
探测出你装了这个扩展。

这一条列表由 `tests/manifest-war.test.js` 锁定，误把子资源重新暴露会让 CI 变红。
真实浏览器冒烟（Playwright Chromium/Edge，有头）见 `desktop/scripts/war_browser_check.py`：
扩展页能加载自己的 `popup.css`/`popup.js`/`xlsx`/PDF.js，普通网页只能加载上面这 3 类 WAR 文件，
其余全部被浏览器阻止。

**加载来源盘点（2026-09-17，全仓 `rg getURL` / `rg "url\\(" content.css`）：**

| 加载方 | 资源 | 要不要 WAR |
| --- | --- | --- |
| 内容脚本/页面侧 | `content.css`（`content_scripts.css` 注入 + `content.js` `fetch`）、`extract/copy/fillrecords/snapshot` 及其静态依赖（`content.js` 动态 `import`） | 要，已逐文件列在 manifest；`worker/chrome/transport` 等 service-worker 专用模块不暴露 |
| 扩展页/offscreen | `popup.js`、`popup.css`、`xlsx`、`mammoth`、`ai-*.js`、`resume-utils.js`、`profile-fields.js`、`form-agent.js`、`vendor/pdfjs/*`、`ai-host.html` | 不要，扩展源自己加载 |
| 浏览器 UI | `icons/*`（只在 `manifest.json` 的 `action`/`icons` 字段里） | 不要；没有任何内容脚本把它注入网页 |

`content.css` 里没有 `url(...)` 引用，因此没有漏掉的图片或字体。

**权限集合**：`manifest.json` 申报的是 `offscreen`、`storage`、`scripting`、`activeTab`、`tabs`、`nativeMessaging`、`alarms`，加上 `<all_urls>` host 权限；`privacy-policy.md` 的权限表逐条对应，没有未申报的权限。

**管理面板边界：** [#125](https://github.com/TshyGO/resume-form-assistant-plugin/issues/125) 已改成由扩展 service worker 打开新的扩展标签页，不再把 `popup.html` 暴露给网页。网页既不能 iframe 它，也不能用公开 URL 探测该页面。

---

## 3. 数据用途声明（后台表单要如实勾）

- **个人身份信息**：是。简历里的姓名、邮箱、电话。
- **是否传输给第三方**：**是**——用户自己配置 AI 接口之后，表单字段说明和相关简历片段会
  发到那家服务商。必须如实勾，不能因为「我们没有服务器」就当作没有传输。
- **是否出售或用于与功能无关的用途**：否。
- **是否用于判断信用**：否。
- **更新检查**：D13 #121 已实现为只读 GitHub releases、每天最多一次、可在设置里关闭；测试在 `desktop/src-tauri/src/update_check.rs`。
- 隐私政策链接：<https://github.com/TshyGO/resume-form-assistant-plugin/blob/main/docs/privacy-policy.md>（公开、无需登录）。

---

## 4. 列表页材料

- [x] 128×128 图标：`icons/icon128.png`
- [x] 1280×800 截图：[`store-assets/store-sidebar-1280x800.png`](store-assets/store-sidebar-1280x800.png)，只含合成公司、岗位与简历数据
- [x] 分类：`Productivity`
- [x] 语言：`中文（简体）`

**简短描述：** 求职网申场景的简历信息填写助手，支持本地模板、AI 辅助填写和桌面端岗位留档。

**详细描述：**

Resume Pro 帮你把重复的网申信息整理成可复用模板，并在招聘网站表单中按需填写。所有模板默认保存在浏览器本地；只有你主动点击填写、保存岗位或调用 AI 时才执行对应操作。

- 导入 Excel 或由本地文件解析生成简历模板；
- 在网申页面选择字段并填写，提交前始终由你检查；
- 可选连接 Resume Pro Desktop，在本机保存岗位、申请进度和填写快照；
- AI 接口完全由用户自行配置，扩展不提供也不代理模型服务；
- 支持导出/导入插件设置，API Key 默认不进入备份。

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
