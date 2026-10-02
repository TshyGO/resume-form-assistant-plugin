// Runs only in extension-owned pages. No inline handlers, HTML from reports or secrets.
(() => {
  const root = document.getElementById('feedback-root');
  if (!root) return;
  const core = self.ResumeProFeedback;
  const send = async data => { try { return await chrome.runtime.sendMessage(data); } catch { return { ok: false, reason: 'unavailable' }; } };
  root.innerHTML = `
    <section class="feedback-card" id="feedback-consent" hidden aria-label="错误报告选择">
      <h2>帮助改进填写</h2><p>出错时自动发送匿名错误报告？包含错误类型、代码位置、版本、系统和出错网站的域名；一键填写有字段没填上时，还会附上填写诊断（字段名和控件结构）。不含简历、填写内容和完整网址。</p>
      <button type="button" id="feedback-enable">开启</button> <button type="button" id="feedback-decline">暂不</button>
    </section>
    <section class="feedback-card" aria-label="问题反馈">
      <label><input type="checkbox" id="feedback-toggle" disabled>自动发送匿名错误报告</label>
      <p class="feedback-note">仅在你开启后发送；可随时关闭。插件与桌面分别设置。</p>
      <button type="button" id="feedback-open">反馈问题</button>
      <form id="feedback-form" hidden>
        <label for="feedback-description">问题描述（请勿填写姓名、简历、账号或密钥）</label>
        <textarea id="feedback-description" maxlength="1400" rows="4"></textarea>
        <label><input type="checkbox" id="feedback-attach" checked>附上最近一次填写诊断</label>
        <p class="feedback-note">发送至 Cloudflare 中转，由 Muse 脱敏整理为 GitHub issue；最长暂存 90 天。发送前请核对下方全部内容。</p>
        <button type="button" id="feedback-preview-button">预览将发送的内容</button>
        <pre id="feedback-preview" tabindex="0" hidden></pre>
        <button type="submit" id="feedback-send" disabled>确认发送</button>
        <button type="button" id="feedback-close">取消</button>
      </form>
      <button type="button" id="feedback-retry" hidden>重新读取设置</button>
      <p id="feedback-status" role="status" aria-live="polite"></p>
    </section>`;
  const $ = id => document.getElementById(`feedback-${id}`);
  const hasDiagnostics = location.pathname.endsWith('/sidepanel.html');
  if (!hasDiagnostics) {
    $('attach').checked = false; $('attach').disabled = true;
    $('attach').parentElement.append('（请在侧栏附上填写诊断）');
  }
  let token = null;
  let previewTabId;
  let revision = 0;
  let busy = false;
  let preparing = false;
  let coolUntil = 0;
  const invalidate = () => { revision++; token = null; previewTabId = undefined; $('send').disabled = true; $('preview').hidden = true; };
  const status = text => { $('status').textContent = text; };
  function renderConsent(result) {
    $('consent').hidden = result.consent !== null;
    $('toggle').checked = result.consent === true;
    $('toggle').disabled = result.consent === undefined;
    $('retry').hidden = result.consent !== undefined;
    if (result.consent === undefined) status('无法读取反馈设置，请重新读取。');
  }
  async function consent(enabled) {
    $('toggle').disabled = true;
    const result = await send({ type: 'FEEDBACK_CONSENT', enabled });
    renderConsent(result);
    status(result.consent === undefined ? '设置未保存，请重试。' : enabled ? '已开启匿名错误报告。' : '已关闭自动上报，安装标识已删除。');
  }
  $('retry').onclick = () => send({ type: 'FEEDBACK_STATUS' }).then(renderConsent);
  $('enable').onclick = () => consent(true);
  $('decline').onclick = () => consent(false);
  $('toggle').onchange = () => consent($('toggle').checked);
  $('open').onclick = () => { $('form').hidden = false; $('description').focus(); };
  $('close').onclick = () => { if (busy) return; $('form').hidden = true; invalidate(); };
  $('description').oninput = invalidate;
  $('attach').onchange = invalidate;
  chrome.tabs?.onActivated?.addListener(() => { if (hasDiagnostics && $('attach').checked) invalidate(); });
  chrome.tabs?.onUpdated?.addListener((id, change) => { if (id === previewTabId && (change.url || change.status === 'loading')) invalidate(); });
  $('preview-button').onclick = async () => {
    if (busy || preparing) return;
    preparing = true; $('preview-button').disabled = true;
    invalidate(); const current = revision;
    let diagnostics = ''; let tabId;
    try {
      if ($('attach').checked && hasDiagnostics) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (current !== revision) return;
        tabId = tab?.id;
        previewTabId = tabId;
        if (Number.isInteger(tabId)) {
          const page = await chrome.tabs.sendMessage(tabId, { type: 'RESUME_PANEL_STATUS' }).catch(() => null);
          diagnostics = core.diagnostics(page?.diagnostics || '');
        }
      }
      const result = await send({ type: 'FEEDBACK_PREVIEW', description: $('description').value, diagnostics, tabId });
      if (current !== revision) return;
      if (!result.ok) { status('无法准备反馈，请重试。'); return; }
      token = result.token;
      $('preview').textContent = JSON.stringify(result.payload, null, 2);
      $('preview').hidden = false;
      $('send').disabled = Date.now() < coolUntil;
      status(diagnostics ? '请核对预览，确认后发送。' : '未附上填写诊断。请核对预览，确认后发送。');
    } catch { status('无法读取填写诊断，请重试或取消勾选。'); }
    finally { preparing = false; $('preview-button').disabled = busy; }
  };
  $('form').onsubmit = async event => {
    event.preventDefault();
    if (busy || !token || Date.now() < coolUntil) return;
    busy = true; const confirmed = token; token = null; $('send').disabled = true; $('preview-button').disabled = true;
    $('description').disabled = true; $('attach').disabled = true;
    coolUntil = Date.now() + 60000; status('正在发送…');
    const result = await send({ type: 'FEEDBACK_SEND', token: confirmed });
    if (result.reason === 'preview') coolUntil = 0;
    busy = false; $('preview-button').disabled = false; $('description').disabled = false; $('attach').disabled = !hasDiagnostics;
    status(result.ok ? `发送成功，编号：${result.id}` : result.reason === 'preview' ? '预览已过期或后台已重启，请重新预览后确认发送。' : result.reason === 'cooldown' ? '两次反馈请至少间隔 60 秒。' : '发送失败，没有自动重试。请稍后重新预览并发送。');
    setTimeout(() => { if (token && !busy) $('send').disabled = false; }, Math.max(0, coolUntil - Date.now()));
  };
  send({ type: 'FEEDBACK_STATUS' }).then(renderConsent);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.feedbackStateV1) send({ type: 'FEEDBACK_STATUS' }).then(renderConsent);
  });
})();
