# 网申快填桌面端

桌面端统一维护简历模板、「我的信息」、AI 设置和本地求职档案，通过 Native Messaging 与仓库根目录的浏览器扩展协作。

普通用户请从[项目首页](../README.md)下载正式安装包。本页面向开发者；首次拉起桌面与扩展，按[开发快速开始](../docs/dev-quickstart.md)操作。

## 当前模块

| 模块 | 职责 |
| --- | --- |
| 申请 | 岗位列表、搜索和筛选、阶段记录、时间线、回收与恢复 |
| 简历 | 多套模板、我的信息、表格导入导出、AI 简历解析、旧扩展数据迁移 |
| 证据收件箱 | 导入招聘邮件、截图、PDF 或文本，关联申请，手动分类与可选 AI 整理 |
| 待办 | 关联申请、到期时间、任务状态与平台提醒能力提示 |
| 设置 | 浏览器连接、AI 服务商、备份与恢复、回收站、更新检查和诊断 |
| 扩展协作 | 简历读写、AI 请求转发、岗位保存、投递确认、填写记录与简历快照 |

各模块的使用限制见[使用指南](../docs/user-guide.md)，数据流见[隐私政策](../docs/privacy-policy.md)。功能存在、自动化测试通过和某平台实机验收是不同的状态，平台验证以对应验收记录为准。

## 开发环境

与当前开发 SOP 对齐：Node.js 22、Rust 1.94.0。Windows 需要 MSVC 生成工具和 WebView2 Runtime；macOS 需要 Xcode Command Line Tools。安装包面向 Windows x64 与 macOS Apple Silicon。

在 `desktop/` 目录执行：

```bash
npm ci
npm run desktop:dev     # 启动真实 Tauri 窗口
npm run typecheck       # TypeScript 检查
npm test                # 按 package.json 执行桌面端测试链
npm run desktop:build   # 本地构建；正式发布另走发布流程
```

正式 Windows 包使用 MSVC target，签名、安装、升级、卸载与资产校验按[构建、安装与升级](../docs/desktop-mvp/install-and-update.md)及[发版 SOP](../docs/release-sop.md)执行。仅用浏览器打开前端不能替代 Tauri 或安装包验收。

扩展本身无需构建，加载仓库根目录后还需完成开发用 Native Messaging 注册。参见[连接注册说明](DEV-NATIVE-MESSAGING.md)。

## 代码导航

```text
src/                    TypeScript 前端，包含旧视图与 React 组件
src/react/              React 基础组件和挂载支持
src/ai/                 AI 设置与整理结果交互
src/resume/             简历管理界面
src-tauri/              Tauri / Rust 应用、命令与平台集成
crates/                 数据服务、档案存储、协议、AI 与导入等模块
scripts/                开发注册、检查、打包和验收脚本
index.html              页面骨架与导航
package.json            当前开发、检查和测试入口
```

宿主接口见 [HOST.md](HOST.md)，浏览器侧的数据流和协议副本规则见[扩展开发说明](../docs/extension-development.md)。

## 数据目录与开发隔离

| 平台 | 用户数据 | 缓存 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\ResumePro\` | 同一根目录下的 `cache\` |
| macOS | `~/Library/Application Support/ResumePro/` | `~/Library/Caches/ResumePro/` |

应用显示名已变更为「网申快填」，现有 `ResumePro` 数据目录仍保留以兼容旧档案。不要为统一名称直接改动目录或底层二进制名。

开发时使用独立的绝对路径，并在启动进程前设置：

```powershell
# Windows PowerShell
$env:RESUMEPRO_DATA_DIR = "D:\tmp\wangshen-dev-data"
$env:RESUMEPRO_CACHE_DIR = "D:\tmp\wangshen-dev-cache"
npm run desktop:dev
```

```bash
# macOS
export RESUMEPRO_DATA_DIR="$HOME/tmp/wangshen-dev-data"
export RESUMEPRO_CACHE_DIR="$HOME/tmp/wangshen-dev-cache"
npm run desktop:dev
```

配合独立浏览器 Profile，避免测试迁移、恢复或队列操作影响真实求职资料。目录不可写会报告错误，不应静默改用临时数据库。

## 生命周期与提醒

关闭窗口会隐藏到托盘或菜单栏，进程继续运行；再次启动会唤起已有实例。主动退出会结束应用，并按当前提醒实现处理已安排的通知。

待办提醒已有相应模块与界面，但系统权限、平台支持和应用状态会影响可用性。开发及验收应检查应用实际显示的能力、退出提示与生命周期说明。不能把托盘驻留、Windows 验证通过或 macOS CI 构建通过当作另一平台提醒已完成实机验收。

## 前端与测试约定

新界面使用 React，经 `InvokeContext` 调用命令，通过 `mountReact` 挂入页面容器。原有视图与 React 组件并存，不要仅为改文档或修局部问题进行无关的大范围迁移。

| 测试文件 | 命令 | 用途 |
| --- | --- | --- |
| `src/**/*.test.ts` | `npm run test:ui` | 状态计算、文案和入参等纯逻辑 |
| `src/**/*.test.tsx` | `npm run test:react` | React 组件与交互 |
| 桌面整体 | `npm test` | 当前 package.json 中的完整测试链 |

业务判断优先放在可独立测试的 `.ts` 中，组件测试关注交互与呈现。变更脚本后确认相关测试确实接入整体测试链。

扩展回归在仓库根目录执行：

```bash
node --test tests/*.test.js
```

发布包与实机安装验收不能由单元测试、Vite 预览或 CI 编译替代。历史 D02 / D04 等阶段说明应结合对应提交和验收记录阅读，不应作为当前功能清单。
