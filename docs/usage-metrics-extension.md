# 第四阶段：插件主动使用信号

插件侧栏和状态页仅在浏览器可信的可见主动输入时向 service worker 发送 `DESKTOP_USAGE_TOUCH`，不读取输入值、网页或浏览器标识，不新增远程请求/权限。

service worker 仅接受本扩展 sidepanel.html / popup.html 的单字段消息；content script、offscreen 页面、其他扩展或附加字段不能触发。只使用先前业务请求已经成功的握手结果，没有握手则忽略，不为统计启动/探测桌面。内存按 UTC 日最多一次本机尝试，失败不重试、不进 outbox，也不影响填写。

协议保持已有业务 envelope=2，握手在 v2 envelope 内提供 min=2/max=3。旧桌面仍可在 v2 正常工作，不宣布 usage.touch 时跳过。新桌面仅向明确声明支持 v3 的插件宣布 usage.touch，旧 v1/v2 插件收到原能力列表。usage.touch 使用 v3 envelope，payload 必须为空且不能带 archiveId/restoreEpoch；请求和响应都经 Rust/JS schema 验证。Native host 对此消息只连接已经存在的桌面 IPC，不 cold-start 或解除退出状态。

桌面用已有统计服务、同一随机编号，新增 extension_attempt_date；desktop/extension 两种来源分别每 UTC 日一次持久额度。Chrome/Edge 都消费同一个 extension 额度，服务端原有每日安装主键 OR 来源后仍计一台。同日业务用户交互不会传入任意 JS 数据，HTTP 五字段白名单不变。关闭清除两种额度并取消请求；首次告知升级为版本 2，已有开启用户需重新查看新增来源说明，旧关闭选择不变。

当前默认/debug/test/CI 构建继续硬禁用外发。代码测试不是实际发行启用或 Windows/macOS/Chrome/Edge 真机验收；后续还需隔离正式包联调和商店披露核对。插件信号只是尽力样本，握手前的点击不保存或补发，不能称全量用户数。

验证包含旧桌面跳过、v3 空负载/身份拒绝、可信可见输入、100 次触发单次发送、失败消耗额度、两个浏览器/桌面持久去重、取消/关闭/再开与无 cold-start 回归。新脚本及 link 模块已加入插件打包白名单。

本地验收：根测试 1281、桌面 Rust 384（1 项已有忽略）、协议 Rust 49、React 263、插件发布白名单 23、桌面发布 66 项通过；根/桌面类型检查、Vite build 和实际插件 ZIP 打包通过。新增测试覆盖来源白名单、旧桌面忽略、v3 空负载、可见可信输入、桌面/双浏览器共用编号与持久额度、能力协商和不启动桌面。尚未进行 Windows/macOS + Chrome/Edge 正式包云端真机验收。
