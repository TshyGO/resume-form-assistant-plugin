/* #333: native side-panel only. Tab events inspect URL metadata, never email contents. */
(function () {
  const card = document.getElementById('mail-save');
  if (!card) return;
  const button = document.getElementById('mail-save-button');
  const status = document.getElementById('mail-save-status');
  const offer = document.getElementById('mail-excerpt-offer');
  const accept = document.getElementById('mail-excerpt-accept');
  const cancel = document.getElementById('mail-excerpt-cancel');
  const company = document.getElementById('mail-company');
  const search = document.getElementById('mail-find-application');
  const application = document.getElementById('mail-application');
  const label = document.getElementById('mail-save-label');
  const context = document.getElementById('mail-context');
  const contextTitle = document.getElementById('mail-context-title');
  const contextHint = document.getElementById('mail-context-hint');
  const domain = document.getElementById('mail-context-domain');
  let current = null;
  let supported = false;
  let revision = 0;
  let busy = false;
  let busyAction = 'save';
  let pending = null;
  const errors = {
    open_mail: '请先在邮箱里打开一封邮件，再点击保存。',
    unrecognized_mail: '检测到邮件标题，但无法确认当前邮件的完整阅读区域。请等待加载完成后重试；仍失败时可下载 .eml 在桌面导入。',
    changed: '读取期间邮件已切换，请重新点击保存。',
    archive_changed: '桌面档案已恢复或切换，请重新选择申请后保存。',
    too_large: '邮件超过 25 MiB 或正文过长，本次未保存。可以下载原件后处理。',
    incompatible: '桌面版本尚不支持存邮件，请更新桌面程序后重试。',
    not_installed: '请先安装并连接网申快填桌面程序。',
    not_paired: '请先在桌面程序中配对这个浏览器。',
    never_paired: '请先打开桌面程序并完成浏览器连接。',
    unavailable: '尚未确认保存成功。请检查桌面连接后重试，重复的原件会自动查重。'
  };
  function say(text, tone = 'idle') { status.textContent = text; status.hidden = !text; status.dataset.tone = tone; }
  function setBusy(value, action = 'save') {
    busy = value;
    busyAction = action;
    for (const el of [button, accept, cancel, company, search, application]) el.disabled = value || !supported;
    label.textContent = value && action === 'save' ? '正在保存…' : pending ? '重试取得原件' : '保存到桌面';
    search.textContent = value && action === 'search' ? '查找中…' : '查找申请';
    card.setAttribute('aria-busy', String(value));
  }
  function clearOffer() {
    pending = null; offer.hidden = true; card.dataset.excerptOffer = 'false';
    if (!busy) label.textContent = '保存到桌面';
  }
  async function refresh() {
    const tick = ++revision;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tick !== revision) return;
    supported = Boolean(self.ResumeProWebmail.provider(tab?.url));
    const changed = tab?.id !== current?.id || tab?.url !== current?.url;
    current = tab || null;
    context.dataset.supported = String(supported);
    domain.hidden = !supported;
    if (supported) {
      const host = new URL(tab.url).hostname;
      contextTitle.textContent = host.endsWith('qq.com') ? 'QQ 邮箱' : host.endsWith('163.com') ? '163 邮箱' : '126 邮箱';
      domain.textContent = host;
      contextHint.textContent = '先在邮箱打开一封邮件，再点击保存。';
    } else {
      domain.textContent = '';
      contextTitle.textContent = '请先打开网页邮箱';
      contextHint.textContent = '支持 QQ、163、126 网页邮箱。切换到邮箱页面后，即可保存当前打开的邮件。';
    }
    setBusy(busy, busyAction);
    if (changed) {
      clearOffer();
      application.replaceChildren(new Option('不关联，存入招聘通知', ''));
      company.value = '';
      if (!busy) say('');
    }
  }
  async function send(kind, data, applicationId) {
    return chrome.runtime.sendMessage({ type: 'DESKTOP_SAVE_MAIL', kind, ...data, applicationId: applicationId || null });
  }
  function saved(result, kind) {
    if (result?.status === 'saved') {
      say(result.duplicate ? '这封邮件已在档案中，未重复保存。'
        : kind === 'eml' ? '已保存完整邮件原件（包含邮件内嵌附件）。可到桌面「招聘通知」查看。'
          : '已保存网页摘录，未保存邮件原件及附件。可到桌面「招聘通知」查看。', 'ok');
      clearOffer();
    } else say(errors[result?.status] || errors.unavailable, 'error');
  }
  button.addEventListener('click', async () => {
    if (busy || !supported) return;
    clearOffer();
    const selected = application.value;
    setBusy(true); say('正在读取当前邮件并尝试取得原件…');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || tab.id !== current?.id || tab.url !== current?.url) { await refresh(); say(errors.changed); return; }
      const capture = await chrome.tabs.sendMessage(tab.id, { type: 'WEBMAIL_CAPTURE' }, { frameId: 0 });
      const [front] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (front?.id !== tab.id || front?.url !== tab.url) { say(errors.changed); return; }
      if (capture?.status === 'original') {
        say('正在传给桌面并保存原件…');
        saved(await send('eml', { bytesBase64: capture.bytesBase64 }, selected), 'eml');
      } else if (capture?.status === 'excerpt_offer') {
        pending = { excerpt: capture.excerpt, applicationId: selected };
        document.getElementById('mail-excerpt-subject').textContent = capture.excerpt.subject;
        offer.hidden = false;
        card.dataset.excerptOffer = 'true';
        say(capture.reason === 'too_large' ? '原件超过 25 MiB，可改存网页摘录。' : '未能取得邮件原件，可改存网页摘录。', 'error');
      } else say(errors[capture?.status] || errors.unavailable, 'error');
    } catch { say('无法读取当前邮箱页面。请刷新邮箱后重试，或下载 .eml 在桌面导入。', 'error'); }
    finally { setBusy(false); }
  });
  accept.addEventListener('click', async () => {
    if (!pending || busy || !supported) return;
    const chosen = pending;
    setBusy(true); say('正在保存网页摘录…');
    try { saved(await send('excerpt', { excerpt: chosen.excerpt }, chosen.applicationId), 'excerpt'); }
    catch { say(errors.unavailable, 'error'); }
    finally { setBusy(false); }
  });
  cancel.addEventListener('click', () => { clearOffer(); say('已取消保存摘录。'); });
  search.addEventListener('click', async () => {
    const name = company.value.trim();
    if (busy || !supported) return;
    if (!name) { say('请填写申请中的公司名称后查找。', 'error'); return; }
    const tick = revision;
    setBusy(true, 'search'); say('正在查找该公司的申请…');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'DESKTOP_CANDIDATES_FOR', fields: { company: name, title: '' } });
      if (tick !== revision) { say('当前网页已切换，请重新查找申请。'); return; }
      if (result?.status !== 'ok') { say('无法读取桌面申请，请检查桌面连接。'); return; }
      const seen = new Set();
      application.replaceChildren(new Option('不关联，存入招聘通知', ''));
      for (const item of [...(result.exact || []), ...(result.sameCompany || [])]) {
        if (seen.has(item.applicationId)) continue;
        seen.add(item.applicationId);
        application.add(new Option(`${item.company} · ${item.title}`, item.applicationId));
      }
      say(seen.size ? '请选择要关联的申请，也可以不关联直接保存。' : '未找到该公司的申请，可以先保存到收件箱。');
    } catch { say('无法读取桌面申请，请检查桌面连接。'); }
    finally { setBusy(false); }
  });
  chrome.tabs.onActivated.addListener(() => { void refresh(); });
  chrome.tabs.onUpdated.addListener((id, change) => { if (id === current?.id && (change.url || change.status === 'complete')) void refresh(); });
  void refresh();
})();
