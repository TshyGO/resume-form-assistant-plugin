// One view model for both the native side panel and the page's hidden fill controller.
(function attachResumeData(root) {
  const DOWNLOAD_URL = 'https://19991107.xyz/tools/wangshen-kuaitian/download/';
  const STATES = {
    not_installed: { message: '这台浏览器还没有连接桌面程序。安装桌面后才能使用简历条目和 AI 填写。', action: '去下载', kind: 'download' },
    not_paired: { message: '桌面程序尚未与这个插件配对。请在桌面设置中粘贴扩展 ID。', action: '复制扩展 ID', kind: 'pair' },
    never_paired: { message: '尚未完成桌面配对。请在桌面设置中粘贴扩展 ID。', action: '复制扩展 ID', kind: 'pair' },
    incompatible: { message: '桌面程序版本太旧，请更新桌面后重试。', action: '去下载', kind: 'download' },
    unavailable: { message: '桌面程序已退出或暂时没有响应。打开桌面后可恢复简历条目和 AI。', action: '打开桌面', kind: 'home' },
    empty: { message: '桌面里还没有简历模板或「我的信息」。', action: '打开桌面简历', kind: 'resume' }
  };

  function modeCopy(mode) { return STATES[mode] || STATES.unavailable; }
  function normalize(payload) {
    const activeTemplate = payload?.activeTemplate || null;
    const templates = Array.isArray(payload?.templates)
      ? payload.templates.map(item => ({ id: item.id, name: item.name, fieldCount: item.fieldCount }))
      : [];
    return {
      templates,
      activeTemplateId: activeTemplate?.id || '',
      activeTemplate,
      profile: payload?.profile || { values: {}, family: [], custom: [] },
      profileRevision: Number.isInteger(payload?.profileRevision) ? payload.profileRevision : 0
    };
  }
  const api = { DOWNLOAD_URL, modeCopy, normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ResumeProResumeData = api;
})(typeof self !== 'undefined' ? self : globalThis);
