# 网申快填图标来源

Issue [#198](https://github.com/TshyGO/resume-form-assistant-plugin/issues/198) 的附图是品牌原稿，仓库副本为 [`desktop/app-icon.png`](../../desktop/app-icon.png)（1254×1254）。图形是深色简历卡、青绿色人物和向右上方的箭头。

- 桌面端 `desktop/src-tauri/icons/` 的 PNG、ICO、ICNS 从原稿用 Tauri `icon` 命令生成。macOS/Windows 运行时和安装包都使用这些文件。
- 插件 48/128 像素图使用原稿缩放；16/32 像素图使用 [`icons/icon.svg`](../../icons/icon.svg) 的简化轮廓。小图省去原稿的柔和阴影，并加粗人物与箭头，以免浏览器工具栏里糊成一团。
- 这些图标属于同一品牌；更换图标时要同时更新两端并在 Chrome 工具栏、扩展管理页、商店详情、macOS Dock 和 Windows 任务栏检查实际效果。

图标源文件的像素摘要（SHA-256）：`c2087db20e3887ec12b2b92119d8db47ab425ad7758bf76a9bc003948625c944`。
