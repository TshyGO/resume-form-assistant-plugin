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

用来把「刚才保存的那个岗位」和当前标签页对上（`chrome.tabs.query` 需要读 URL 和标题）。
只读 URL 和标题元数据，不读取标签页正文。`activeTab` 给不了这个：它只覆盖用户点击的
那一次交互，跨标签页的对应关系就断了。

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
| `link/*.mjs`、`link/protocol/*.mjs` | 内容脚本里 `import(chrome.runtime.getURL(...))` 动态加载 |
| `popup.html` | 以 iframe 注入到网申页面里，由页面发起加载 |
| `content.css` | 内容脚本 `fetch(chrome.runtime.getURL("content.css"))` |

移掉的那些（`popup.js`、`popup.css`、`xlsx.full.min.js`、`mammoth.browser.min.js`、
`ai-*.js`、`resume-utils.js`、`profile-fields.js`、`form-agent.js`、`vendor/pdfjs/*`、
`icons/*`）都是 `popup.html` 这个**扩展页面**自己的子资源。扩展页面加载同源资源不需要
`web_accessible_resources`；把它们列出来只有一个效果：任何网页都能加载它们，也能借此
探测出你装了这个扩展。

这一条列表由 `tests/manifest-war.test.js` 锁定，误把子资源重新暴露会让 CI 变红。
真实浏览器冒烟（Playwright Chromium，有头）见 `desktop/scripts/war_browser_check.py`：
扩展页能加载自己的 `popup.css`/`popup.js`/`xlsx`/PDF.js，普通网页只能加载上面这 4 个 WAR 文件，
其余全部被浏览器阻止。

**`popup.html` 的跨源边界：** 它是扩展源页面，任何网页都能 iframe 它；页面无法跨源读取
其中的内容，仓库里也没有 `window.postMessage` 通道。它只在用户点击「打开管理面板」后显示，
面板内的操作仍由用户点击触发。残留风险是点击劫持和扩展存在性探测，这是 iframe 架构的固有
代价；后续若做商店版，优先评估 `use_dynamic_url` 或最小权限的 `panel.html`。

---

## 3. 数据用途声明（后台表单要如实勾）

- **个人身份信息**：是。简历里的姓名、邮箱、电话。
- **是否传输给第三方**：**是**——用户自己配置 AI 接口之后，表单字段说明和相关简历片段会
  发到那家服务商。必须如实勾，不能因为「我们没有服务器」就当作没有传输。
- **是否出售或用于与功能无关的用途**：否。
- **是否用于判断信用**：否。
- 隐私政策链接：`docs/privacy-policy.md`（上架时换成 GitHub Pages 的公开地址）。

---

## 4. 列表页材料

- [ ] 128×128 图标（包里已有 `icons/icon128.png`）
- [ ] 1280×800 截图若干（至少一张网申页面的填写过程）
- [ ] 简短描述与详细描述
- [ ] 分类、语言

---

## 5. 上架前还没做完的事

- **Chrome Web Store 发布动作**：item 已建（Draft，ID `diagjmploldedipjdenmecmjokckelkl`），包可以上传。
  `manifest.json` 里的公钥已经固定了这个 ID，本地 unpacked 与 Chrome 商店版是同一个扩展 ID；
  原先担心的「换 ID 会丢 `chrome.storage.local`」因此不再存在，**不需要为上架单独做插件设置的导出 / 导入**。
- **Edge Add-ons（可选）**：Edge 商店是另一个商店。以后如果要从 Edge 商店发行，先核实 Edge 对同一份公钥 / ID 的处理；
  没有把握时继续让 Edge 用户从 Chrome 商店安装即可（Edge 支持「允许来自其他应用商店的扩展」），host 注册已经覆盖这条路径。
- **列表材料**：128×128 图标、1280×800 截图、简短/详细描述、分类与语言。
