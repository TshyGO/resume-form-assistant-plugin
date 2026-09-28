# 网申快填图标来源

Issue [#198](https://github.com/TshyGO/resume-form-assistant-plugin/issues/198) 的附图是品牌原稿，仓库副本为 [`desktop/app-icon.png`](../../desktop/app-icon.png)（1254×1254）。图形是深色简历卡、青绿色人物和向右上方的箭头。

- 桌面端 `desktop/src-tauri/icons/` 的图标取自原稿。macOS 的 ICNS 和 PNG 将原稿中的圆角方形放在透明画布中央，四周各留约 10% 空间；Windows ICO 仍沿用原图。这样 Dock 中的外框大小与其他应用接近，四角不会出现白色方块。
- 插件 128 像素图使用原稿缩放；16/32/48 像素图使用 [`icons/icon.svg`](../../icons/icon.svg) 的简化轮廓。小图放大了卡片、人物与箭头，侧栏页头也不再额外给图标加内边距。
- 这些图标属于同一品牌；更换图标时要同时更新两端并在 Chrome 工具栏、扩展管理页、商店详情、macOS Dock 和 Windows 任务栏检查实际效果。

图标源文件的像素摘要（SHA-256）：`c2087db20e3887ec12b2b92119d8db47ab425ad7758bf76a9bc003948625c944`。
