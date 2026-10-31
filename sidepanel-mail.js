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
  const searchStatus = document.getElementById('mail-application-status');
  const destination = document.getElementById('mail-destination');
  const associationState = document.getElementById('mail-association-state');
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
  let candidates = [];
  let selectedApplication = null;
  let lookupVersion = 0;
  const errors = {
    open_mail: '请先在邮箱里打开一封邮件，再点击保存。',
    multiple_messages: '当前会话展开了多封邮件，请只展开要保存的一封后重试。',
    message_clipped: '正文被 Gmail 截断，不能保存为完整摘录。请在该封邮件菜单打开“显示原始邮件”后保存原件，或下载 .eml 在桌面导入。',
    account_unavailable: '无法确认当前 Gmail 账号。请回到普通阅读页或“查看完整邮件”页保存；也可下载 .eml 在桌面导入。',
    original_unavailable: '未取得完整邮件原件，请使用 Gmail 的下载原始邮件后在桌面导入。',
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
  function say(text, tone = 'idle') {
    status.textContent = text; status.hidden = !text; status.dataset.tone = tone;
    if (text && !document.getElementById('mail-view').hidden) status.scrollIntoView?.({ block: 'nearest' });
  }
  function saySearch(text, tone = 'idle') { searchStatus.textContent = text; searchStatus.dataset.tone = tone; }
  function saveLabel() { return selectedApplication ? '保存并关联' : '暂不关联并保存'; }
  function showSelection() {
    const id = selectedApplication?.applicationId || '';
    for (const row of application.querySelectorAll('.mail-application-option')) {
      const input = row.querySelector('input');
      input.checked = input.value === id;
      row.classList.toggle('is-selected', input.checked);
    }
    associationState.textContent = selectedApplication ? '已选择' : '可选';
    if (!busy && !pending) label.textContent = saveLabel();
    destination.textContent = selectedApplication
      ? `将关联到：${selectedApplication.company} · ${selectedApplication.title}`
      : '当前不关联，保存到桌面「招聘通知」。';
  }
  function renderCandidates() {
    const legend = document.createElement('legend'); legend.className = 'sr-only'; legend.textContent = '选择关联申请';
    application.replaceChildren(legend);
    for (const item of [...candidates, null]) {
      const row = document.createElement('label'); row.className = 'mail-application-option';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'mail-associated-application';
      radio.value = item?.applicationId || '';
      const text = document.createElement('span'); text.className = 'mail-application-option__text';
      const title = document.createElement('strong'); title.textContent = item?.company || '暂不关联';
      const detail = document.createElement('small'); detail.textContent = item?.title || '保存到桌面「招聘通知」';
      text.append(title, detail); row.append(radio, text); application.append(row);
    }
    showSelection();
  }
  function resetAssociation() {
    lookupVersion += 1; candidates = []; selectedApplication = null;
    renderCandidates();
  }
  function setBusy(value, action = 'save') {
    busy = value;
    busyAction = action;
    for (const el of [button, accept, cancel, company, search, application]) el.disabled = value || !supported;
    label.textContent = value && action === 'save' ? '正在保存…' : pending ? '重试取得原件' : saveLabel();
    search.textContent = value && action === 'search' ? '查找中…' : '查找申请';
    card.setAttribute('aria-busy', String(value));
  }
  function clearOffer() {
    const abandoned = pending;
    pending = null;
    if (abandoned?.target) {
      // Drop the content script's matching snapshot without reading mail again.
      void chrome.tabs.sendMessage(abandoned.tab.id, { type: 'WEBMAIL_DISCARD', target: abandoned.target }, { frameId: 0 }).catch(() => {});
    }
    offer.hidden = true; card.dataset.excerptOffer = 'false';
    if (!busy) label.textContent = saveLabel();
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
      contextTitle.textContent = self.ResumeProWebmail.provider(tab.url) === 'gmail' ? 'Gmail' : host.endsWith('qq.com') ? 'QQ 邮箱' : host.endsWith('163.com') ? '163 邮箱' : '126 邮箱';
      domain.textContent = host;
      contextHint.textContent = self.ResumeProWebmail.provider(tab.url) === 'gmail'
        ? '只展开要保存的一封邮件，再点击保存；也可在该封邮件菜单打开“显示原始邮件”后保存原件。'
        : '先在邮箱打开一封邮件，再点击保存。';
    } else {
      domain.textContent = '';
      contextTitle.textContent = '请先打开网页邮箱';
      contextHint.textContent = '支持 QQ、163、126、Gmail 网页邮箱。切换到邮箱页面后，即可保存当前打开的邮件。';
    }
    setBusy(busy, busyAction);
    if (changed) {
      clearOffer();
      resetAssociation();
      company.value = '';
      saySearch('按回车或点击「查找申请」。');
      if (!busy) say('');
    }
  }
  async function send(kind, data, applicationId) {
    return chrome.runtime.sendMessage({ type: 'DESKTOP_SAVE_MAIL', kind, ...data, applicationId: applicationId || null });
  }
  async function validateTarget(tab, capture, consume = true) {
    if (self.ResumeProWebmail.provider(tab.url) !== 'gmail') return true;
    if (typeof capture.target !== 'string' || !capture.target) return false;
    const result = await chrome.tabs.sendMessage(tab.id, { type: consume ? 'WEBMAIL_VALIDATE' : 'WEBMAIL_CHECK', target: capture.target }, { frameId: 0 });
    const [front] = await chrome.tabs.query({ active: true, currentWindow: true });
    return front?.id === tab.id && front?.url === tab.url && result?.status === 'current';
  }
  function saved(result, kind) {
    if (result?.status === 'saved') {
      say(result.duplicate ? '这封邮件已在档案中，未重复保存。可到桌面「招聘通知」或回收站查看。'
        : kind === 'eml' ? '已保存完整邮件原件（包含邮件内嵌附件）。可到桌面「招聘通知」查看。'
          : '已保存网页摘录，未保存邮件原件及附件。可到桌面「招聘通知」查看。', 'ok');
      clearOffer();
    } else say(errors[result?.status] || errors.unavailable, 'error');
  }
  function excerptFailed(result) {
    // Acceptance consumed the binding before transfer. Never leave a retry
    // button wired to that spent target, or revive a potentially stale snapshot.
    clearOffer();
    const reason = result?.status !== 'unavailable' ? errors[result?.status] : '';
    say(`${reason || '尚未确认摘录保存成功，请检查桌面连接。'} 请点击「${saveLabel()}」重新读取邮件后重试。`, 'error');
  }
  button.addEventListener('click', async () => {
    if (busy || !supported) return;
    clearOffer();
    const selected = selectedApplication?.applicationId || null;
    setBusy(true); say('正在读取当前邮件并尝试取得原件…');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || tab.id !== current?.id || tab.url !== current?.url) { await refresh(); say(errors.changed); return; }
      let capture = await chrome.tabs.sendMessage(tab.id, { type: 'WEBMAIL_CAPTURE' }, { frameId: 0 });
      const [front] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (front?.id !== tab.id || front?.url !== tab.url) { say(errors.changed); return; }
      if (capture?.status === 'gmail_source') {
        const source = capture;
        capture = await self.ResumeProGmailDownload.resolveSource(source, consume => validateTarget(tab, source, consume));
      }
      if (capture?.status === 'original') {
        if (!await validateTarget(tab, capture)) { say(errors.changed, 'error'); return; }
        say('正在传给桌面并保存原件…');
        saved(await send('eml', { bytesBase64: capture.bytesBase64 }, selected), 'eml');
      } else if (capture?.status === 'excerpt_offer') {
        pending = { excerpt: capture.excerpt, target: capture.target, tab };
        document.getElementById('mail-excerpt-subject').textContent = capture.excerpt.subject;
        offer.hidden = false;
        card.dataset.excerptOffer = 'true';
        offer.scrollIntoView?.({ block: 'nearest' });
        say(capture.reason === 'too_large' ? '原件超过 25 MiB，可改存网页摘录。' : (self.ResumeProWebmail.provider(tab.url) === 'gmail' ? '当前页面未提供可用原件。可在 Gmail 单封邮件菜单打开“显示原始邮件”后重试，或确认保存网页摘录。' : '未能取得邮件原件，可改存网页摘录。'), 'error');
      } else say(errors[capture?.status] || errors.unavailable, 'error');
    } catch { say('无法读取当前邮箱页面。请刷新邮箱后重试，或下载 .eml 在桌面导入。', 'error'); }
    finally { setBusy(false); }
  });
  accept.addEventListener('click', async () => {
    if (!pending || busy || !supported) return;
    const chosen = pending;
    const selected = selectedApplication?.applicationId || null;
    setBusy(true); say('正在保存网页摘录…');
    try {
      const [front] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (front?.id !== chosen.tab.id || front?.url !== chosen.tab.url || !await validateTarget(chosen.tab, chosen) || pending !== chosen) {
        clearOffer(); say(errors.changed, 'error'); return;
      }
      const result = await send('excerpt', { excerpt: chosen.excerpt }, selected);
      if (result?.status === 'saved') saved(result, 'excerpt');
      else excerptFailed(result);
    }
    catch { excerptFailed(); }
    finally { setBusy(false); }
  });
  cancel.addEventListener('click', () => { clearOffer(); say('已取消保存摘录。'); });
  async function findApplications() {
    const name = company.value.trim();
    if (busy || !supported) return;
    if (!name) { saySearch('请填写公司名称后查找。', 'error'); company.focus(); return; }
    resetAssociation();
    const lookup = lookupVersion;
    const previousFocus = document.activeElement;
    setBusy(true, 'search'); saySearch('正在查找该公司的申请…');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'DESKTOP_CANDIDATES_FOR', fields: { company: name, title: '' } });
      if (lookup !== lookupVersion) return;
      if (result?.status !== 'ok') { saySearch('无法读取桌面申请，请检查桌面连接后重新查找。', 'error'); return; }
      const seen = new Set();
      for (const item of [...(result.exact || []), ...(result.sameCompany || [])]) {
        if (seen.has(item.applicationId)) continue;
        seen.add(item.applicationId);
        candidates.push(item);
      }
      renderCandidates();
      saySearch(seen.size ? `找到 ${seen.size} 条申请，点击岗位即可选中。` : '未找到该公司的申请。可修改名称重试，或暂不关联直接保存。');
      if (!document.getElementById('mail-view').hidden) application.scrollIntoView?.({ block: 'nearest' });
    } catch { if (lookup === lookupVersion) saySearch('无法读取桌面申请，请检查桌面连接后重新查找。', 'error'); }
    finally {
      setBusy(false);
      if (lookup === lookupVersion && !document.getElementById('mail-view').hidden
          && [company, search].includes(previousFocus) && [document.body, previousFocus].includes(document.activeElement)) {
        previousFocus.focus({ preventScroll: true });
      }
    }
  }
  search.addEventListener('click', () => { void findApplications(); });
  company.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault(); void findApplications();
  });
  company.addEventListener('input', () => {
    resetAssociation();
    saySearch('公司名称已更改，按回车或点击「查找申请」。');
  });
  application.addEventListener('change', event => {
    if (busy || !supported || !event.target.matches('input[name="mail-associated-application"]')) return;
    selectedApplication = candidates.find(item => item.applicationId === event.target.value) || null;
    showSelection();
  });
  renderCandidates();
  chrome.tabs.onActivated.addListener(() => { void refresh(); });
  chrome.tabs.onUpdated.addListener((id, change) => { if (id === current?.id && (change.url || change.status === 'complete')) void refresh(); });
  void refresh();
})();
