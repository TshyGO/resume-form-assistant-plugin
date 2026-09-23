# Resume Pro Desktop（D02 壳 + D04 申请管理）

最小可运行桌面程序：导航、设置、用户数据目录、单实例，以及不依赖 AI 的申请管理（列表、编辑、阶段与时间线）。浏览器插件仍在仓库根目录，安装方式不变。

本分支的开发基线临时整合了未合并的 D02 `f37b9e1` 与 D03 `05843ae`。这不表示上游已验收或已合并。

给 D03/D06 的宿主接口见 [HOST.md](HOST.md)。

## 依赖

- Node.js 22+ 与 npm（使用已提交的 `package-lock.json`：`npm ci`）
- Rust：crate 声明 `rust-version = 1.77.2`（Tauri 2.11 锁定依赖的最低声明）。本仓库 Windows 已用 **rustc 1.94.0** 验证。不承诺未在本仓库跑过的更低或中间版本。
- Windows：WebView2 Runtime（Windows 11 通常已带）
- macOS 11+：Xcode 命令行工具

## 命令（在 `desktop/` 下）

```bash
npm install
npm test                 # 宿主/应用单测 + 前端构建 + ZIP 白名单
npm run desktop:dev      # 开发启动真实 Tauri 窗口
npm run desktop:build    # 本地打包（不签名、不上架）
```

探针（不打开窗口，打印解析后的目录）：

```bash
# 开发二进制
cargo run --manifest-path src-tauri/Cargo.toml -- --probe

# 申请管理闭环（隔离临时目录，不写真实档案）
cargo run --manifest-path src-tauri/Cargo.toml -- --apps-loop

# 隐藏启动（同一唯一写入者，供后续 D06）
cargo run --manifest-path src-tauri/Cargo.toml -- --hidden

# 让已运行的唯一写入者退出（不会再开第二个宿主）
cargo run --manifest-path src-tauri/Cargo.toml -- --quit
```

Windows 产物大致在：

`src-tauri/target/release/resume-pro-desktop.exe`

以及 NSIS 安装包（per-user，不要求管理员）。**不要用浏览器直接打开 `index.html` 当作验收。**

## 数据目录

| 平台 | 用户数据 | 缓存 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\ResumePro\` | 同一根下 `cache\` |
| macOS | `~/Library/Application Support/ResumePro/` | `~/Library/Caches/ResumePro/` |

目录不可写时会在设置页给出错误码，不会改用临时目录。重装或再次启动不会删除已有档案目录。

## AI 配置

设置里的「AI」可以保存多份接口。字段顺序是接口地址、API Key、模型名称。填完后点「保存并使用」才会加入列表并成为当前配置；没填完不会启用。每份配置的 Key 单独存在系统凭据库（服务名 `com.resumepro.desktop`，账户名 `ai-api-key:<配置 id>`）。界面和命令返回值只说明配过没有，不返回 Key 原文。`ai-settings.json` 只有地址、模型名和当前 id。

旧版只有一份地址/模型和一条固定凭据（账户名 `ai-api-key`）时，启动后会变成一份已保存配置，并把那条 Key 迁到它自己的账户，之后不再用固定账户当回退。切换时只读当前这份的 Key。删除正在使用的配置时，必须另选一份或明确进入未配置。

「获取模型」由桌面进程请求服务商的 `/models`，地址识别、过滤和错误分类与插件 `ai-models.js` 相同。刚输入、尚未保存的地址和 Key 也可以拉取；地址对不上已保存的配置时，不会把那份 Key 发出去。拉取失败仍可手填模型并保存，也不会改掉已经选中的模型。

桌面备份不包含 `ai-settings.json`，也不包含任何 Key。

开发覆盖（必须是绝对路径），需导出后再启动同一进程：

PowerShell：

```powershell
$env:RESUMEPRO_DATA_DIR = "D:\tmp\Resume Pro Data"
$env:RESUMEPRO_CACHE_DIR = "D:\tmp\Resume Pro Cache"
npm run desktop:dev
```

macOS / bash：

```bash
export RESUMEPRO_DATA_DIR="$HOME/tmp/Resume Pro Data"
export RESUMEPRO_CACHE_DIR="$HOME/tmp/Resume Pro Cache"
npm run desktop:dev
```

## 生命周期

- 关闭窗口：隐藏到托盘（Windows）或菜单栏（macOS），进程仍是唯一写入者
- 托盘/菜单「打开」或第二次启动：唤起已有窗口
- 「退出」：结束进程
- **没有**开机启动、计划任务或常驻服务
- **没有**系统提醒（D10）；不要把托盘驻留理解成提醒可用

## 验证状态

Windows（本机已跑过真实 `resume-pro-desktop.exe`，不是浏览器打开前端）：

- `--probe` 解析到 `%LOCALAPPDATA%\ResumePro`，与程序目录分离
- 中文/空格目录可作为 `RESUMEPRO_DATA_DIR`
- 把数据根指向普通文件时返回 `DIR_CREATE_FAILED` / `DIR_NOT_WRITABLE`，不改用临时目录
- `--hidden` 后第二次启动仍只有一个进程；`--quit` 结束宿主
- 关闭窗口后进程仍在；设置页显示版本、数据目录、日志目录、运行状态
- 申请管理会在档案目录创建 `archive.db` 与 `current.json`（D03 数据层）。初始化失败会明确报错，不会改用临时库。

## D04 可用操作

- 新增/编辑申请（公司、岗位、链接、地点、备注）
- 搜索、阶段过滤、排序、分页
- 确认已投递、记录测评/面试/结果、纠正阶段、备注
- 回收与恢复（无永久删除）
- 关闭后重开，资料与时间线保留

进度记录使用独立的保存/取消对话框；取消或 Escape 不写入事件。
默认仅补录历史，只有勾选「同时更新当前进度」才改变阶段。可填写面试轮次和发生日期，
日期留空记为未知，不用记录当天冒充发生日期。编辑时清空链接、地点或备注会实际清除旧值。

2026-09-07 Windows 补充验收：真实 Tauri WebView 创建、清空字段、取消/Escape、
第二轮面试与历史日期保存、重启后回读通过。全套桌面测试通过（宿主 23、存储 34、
命令 9、前端 15、允许列表 5），插件回归 109 项通过。测试使用独立目录，不触碰真实档案。
日志脱敏回归覆盖编码秘密参数在日志/诊断中的移除和普通值保留；异常多重编码直接脱敏。
岗位 URL 会丢弃不确定的嵌套跳转/编码参数，保留普通岗位标识；此规则不追溯改写旧档案。
诊断包含档案是否可用及脱敏后的打开错误。插件生成的事件保留消息 ID，重复归档不新增事件。
发布前展开 Git 树并验证固定文件清单；实际插件 ZIP 的 195 个文件已核对通过。

未实现：附件导入、简历快照、待办提醒、浏览器通信、AI。

macOS：代码按 Application Support / Caches 分支；WKWebView 数据目录与应用缓存目录不是同一处。CI 上的 macOS 作业只做构建/单测，**不是实机 UI 验收**。尚未完成实机启动、单实例、隐藏/恢复、Application Support 与实际 WebView 位置验证。不能把 Windows 跑通或 CI 编译说成 Mac 已验收。

## 证据收件箱（D09）

把回复邮件（`.eml`）、截图（PNG/JPEG）或 PDF 拖进窗口，或者用「选择文件…」，或者直接粘贴一段文本。原件被复制进 `attachments/<年>/<月>/`，之后你把原文件移走、改名、删掉都不影响查看。

- **导入不代表对方回复了什么**，也不会改变申请阶段。关联到某条申请之后，那条申请的状态是「已导入，待分类」——分类由你确认。
- **同一家公司的多条申请不会自动归并**：关联时两条都列出来，都不预选。
- **重复导入**同一份内容不会重复占空间，但你仍然可以把它关联到另一条申请。
- **预览是安全的**：邮件正文在 Rust 侧就被压成纯文本，脚本、样式、远程图片和跟踪像素都不会进到界面；`javascript:` 链接只作为文字显示。截图内嵌显示（≤ 8 MiB），**PDF 不在应用内渲染**，可以「用系统程序打开本机副本」——那会离开这个应用。
- **不支持**：Outlook 的 `.msg` 与虚拟拖拽对象（请在邮件客户端另存为 `.eml`，或粘贴正文）、邮箱账号直连收信。单份上限 25 MiB，一次最多 20 个文件。
- OCR 与自动分类不属于 D09（见 D11）。

代码：`desktop/crates/evidence-import`（安全文件名、嗅探、`.eml` 解析、原子落盘）、`desktop/src-tauri/src/evidence_commands.rs`（命令层）、`desktop/src/inbox*.js`（界面）。

## 前端约定（D11 起）

界面分两套写法，正在逐步统一：

- **新界面用 React**（`src/react/`、`src/ai/` 等 `.tsx`）。组件经 `InvokeContext` 调命令，不直接摸 `window.__TAURI__`；挂到旧页面的容器上用 `mountReact`，容器从此归 React 管。
- **旧视图**（申请、收件箱、待办、备份）仍是 `mountXxx()` + 模板字符串，D11 期间不迁，之后另开 issue 逐个迁。

测试也是两套，**CI 两套都跑**：

| 放哪 | 跑什么 | 测什么 |
| --- | --- | --- |
| `src/**/*.test.ts` | `npm run test:ui`（`node --test`） | 纯逻辑：状态计算、文案、入参组装 |
| `src/**/*.test.tsx` | `npm run test:react`（Vitest + jsdom） | 组件画出来的东西和交互 |

组件里不写业务判断，判断放 `.ts` 里测。`src/react-wiring.test.ts` 盯着两套都真的挂在 `npm test` 和 CI 上——D10 时 `test:ui` 没写成 glob，29 个前端测试一直没在 CI 跑（#90）。

## 插件回归

仓库根目录：

```bash
node --test tests/*.test.js
```

GitHub Release 工作流仍然只打包插件运行文件，不会把 `/desktop` 打进 ZIP。
