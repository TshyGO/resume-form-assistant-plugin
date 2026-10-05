// Runs only in extension-owned pages. No inline handlers, HTML from reports or secrets.
// Two independent features share this file: 自动错误报告 (a preference, default on, set on the
// status page) and 手动反馈问题 (a draft previewed and confirmed in the side panel only).
// Neither changes the other.
(() => {
  const noticeRoot = document.getElementById('feedback-notice-root');
  const autoRoot = document.getElementById('feedback-auto-root');
  const manualRoot = document.getElementById('feedback-manual-root');
  if (!autoRoot) return;
  const core = self.ResumeProFeedback;
  const send = async data => { try { return await chrome.runtime.sendMessage(data); } catch { return { ok: false, reason: 'unavailable' }; } };
  // The side panel shows the preference as one line plus a first-use notice of its own. The
  // status page owns the switch and unfolds the same explanation inside its card.
  const compact = autoRoot.dataset.variant === 'compact';
  const explanation = `
      <p>网申快填有两种互相独立的方式帮助改进：</p>
      <ul class="feedback-ways">
        <li><strong>自动错误报告</strong>（默认开启）：插件检测到自身异常，或一键填写后有字段没填上时，自动发送一份脱敏诊断。关闭它不影响手动反馈问题。</li>
        <li><strong>手动反馈问题</strong>：由你${compact ? '' : '在侧栏'}填写描述，预览全部内容并确认后才发送。</li>
      </ul>
      <p class="feedback-note">用途是定位问题、改进填写兼容性。报告仅含错误类别、本插件代码位置、版本、系统，以及出错页域名和经过筛选的填写诊断；不上传简历、填写值、页面正文、完整网址、Cookie 或密钥。自动错误报告使用随机安装标识，关闭即删除。发送前先脱敏，经 Cloudflare 中转（最长暂存 90 天），由 Muse 再次脱敏整理为可能公开的 GitHub issue。插件与桌面分别设置。</p>`;
  if (compact && noticeRoot) noticeRoot.innerHTML = `
    <section class="feedback-card feedback-notice" id="feedback-consent" hidden aria-labelledby="feedback-notice-title">
      <h2 id="feedback-notice-title">错误报告与问题反馈</h2>${explanation}
      <p class="feedback-note">点「知道了」只收起本说明，自动错误报告保持开启。以后如需关闭，或想重看本说明，请到「插件状态」。</p>
      <div class="feedback-actions">
        <button type="button" id="feedback-enable" class="feedback-primary">知道了</button>
        <button type="button" id="feedback-decline" hidden>关闭自动错误报告</button>
      </div>
    </section>`;
  autoRoot.innerHTML = compact ? `
    <div class="feedback-auto-line">
      <span id="feedback-auto-state">自动错误报告：正在读取…</span>
      <button type="button" id="feedback-retry" class="feedback-link" hidden>重新读取设置</button>
      <p id="feedback-auto-status" role="status" aria-live="polite"></p>
    </div>` : `
    <section class="feedback-card" aria-labelledby="feedback-auto-title">
      <h2 id="feedback-auto-title">自动错误报告</h2>
      <label class="feedback-switch"><input type="checkbox" id="feedback-toggle" disabled>开启自动错误报告</label>
      <p id="feedback-auto-state" class="feedback-state">正在读取设置…</p>
      <p class="feedback-note">默认开启。关闭会删除随机安装标识，不影响侧栏里的「手动反馈问题」。插件与桌面分别设置。</p>
      <div class="feedback-actions">
        <button type="button" id="feedback-about" aria-expanded="false" aria-controls="feedback-details" hidden>查看完整说明</button>
        <button type="button" id="feedback-retry" hidden>重新读取设置</button>
      </div>
      <div id="feedback-details" class="feedback-details" role="region" aria-label="完整说明" hidden>${explanation}
        <p class="feedback-note" id="feedback-details-hint"></p>
        <div class="feedback-actions"><button type="button" id="feedback-enable" class="feedback-primary" hidden>知道了</button></div>
      </div>
      <p id="feedback-auto-status" role="status" aria-live="polite"></p>
    </section>`;
  if (manualRoot) manualRoot.innerHTML = `
    <section class="feedback-card feedback-manual" aria-labelledby="feedback-manual-title">
      <div class="feedback-head">
        <h2 id="feedback-manual-title">手动反馈问题</h2>
        <button type="button" id="feedback-expand" aria-expanded="false" aria-controls="feedback-form">展开</button>
      </div>
      <p id="feedback-summary" class="feedback-summary" role="status" aria-live="polite"></p>
      <form id="feedback-form" hidden>
        <label for="feedback-description">问题描述（请勿填写姓名、简历、账号或密钥）</label>
        <textarea id="feedback-description" maxlength="1400" rows="4"></textarea>
        <label><input type="checkbox" id="feedback-attach" checked>附上最近一次填写诊断</label>
        <p class="feedback-note">只有点「确认发送」才会发送：经 Cloudflare 中转，由 Muse 脱敏整理为 GitHub issue；最长暂存 90 天。发送前请核对下方全部内容。</p>
        <button type="button" id="feedback-preview-button">预览将发送的内容</button>
        <pre id="feedback-preview" tabindex="0" hidden></pre>
        <button type="submit" id="feedback-send" class="feedback-primary" disabled>确认发送</button>
        <p id="feedback-status" role="status" aria-live="polite"></p>
      </form>
    </section>`;
  const $ = id => document.getElementById(`feedback-${id}`);

  // ---- 自动错误报告 and the explanation of both features ----
  let settings = {};
  let aboutOpen = false;
  let savingConsent = false;
  const autoStatus = text => { $('auto-status').textContent = text; };
  function renderConsent(result = settings) {
    settings = result;
    const known = result.consent === true || result.consent === false;
    const firstUse = result.noticeSeen === false;
    if (compact) {
      // Side panel: a first-use notice only. Re-reading and changing the setting happen on the status page.
      if ($('consent')) {
        $('consent').hidden = !firstUse; noticeRoot.hidden = !firstUse;
        $('decline').hidden = !(firstUse && result.consent === true);
      }
    } else {
      // Status page: the explanation unfolds inside the card. On first use it starts open and
      // only 「知道了」 folds it; afterwards 「查看完整说明」 / 「收起说明」 toggles it.
      const open = firstUse || aboutOpen;
      $('details').hidden = !open;
      // Hidden until the settings are known, so an early click cannot render a failure state.
      $('about').hidden = firstUse || !known;
      $('about').textContent = open ? '收起说明' : '查看完整说明';
      $('about').setAttribute('aria-expanded', String(open));
      $('enable').hidden = !firstUse;
      $('details-hint').textContent = firstUse
        ? '点「知道了」只收起说明，自动错误报告保持开启。如需关闭，取消勾选上方「开启自动错误报告」即可。'
        : '如需开启或关闭，勾选或取消勾选上方「开启自动错误报告」即可。';
      $('toggle').checked = result.consent === true; $('toggle').disabled = !known || savingConsent;
    }
    const state = !known ? '无法读取设置' : result.consent ? '已开启' : '已关闭';
    $('auto-state').textContent = compact ? `自动错误报告：${state}${known ? '（在「插件状态」中设置）' : ''}`
      : !known ? '无法读取设置。' : result.consent ? '已开启：插件检测到自身异常或字段没填上时，会自动发送脱敏诊断。' : '已关闭：不会自动发送任何报告。';
    $('retry').hidden = known;
    if (!known) autoStatus('无法读取反馈设置，请重新读取。');
  }
  const controls = () => ['enable', 'decline', 'toggle'].map($).filter(Boolean);
  async function consent(enabled) {
    if (savingConsent) return;
    savingConsent = true;
    controls().forEach(control => { control.disabled = true; });
    const result = await send(enabled === undefined ? { type: 'FEEDBACK_NOTICE_SEEN' } : { type: 'FEEDBACK_CONSENT', enabled });
    savingConsent = false;
    controls().forEach(control => { control.disabled = false; });
    const saved = result.consent === true || result.consent === false;
    renderConsent(result);
    autoStatus(!saved ? '设置未保存，请重试。'
      : enabled === undefined ? `已收起说明，自动错误报告保持${result.consent ? '开启' : '关闭'}。`
      : result.consent ? '已开启自动错误报告。' : '已关闭自动错误报告，随机安装标识已删除。手动反馈问题不受影响。');
  }
  const refresh = () => send({ type: 'FEEDBACK_STATUS' }).then(renderConsent);
  $('retry').onclick = refresh;
  if ($('enable')) $('enable').onclick = () => { aboutOpen = false; consent(); };
  if ($('decline')) $('decline').onclick = () => consent(false);
  if ($('toggle')) $('toggle').onchange = () => {
    // Choosing on first use counts as having read the explanation; keep it open while reading.
    if (settings.noticeSeen === false) aboutOpen = true;
    consent($('toggle').checked);
  };
  if ($('about')) $('about').onclick = () => { aboutOpen = !aboutOpen; renderConsent(); };

  // ---- 手动反馈问题 (side panel only) ----
  if (manualRoot) {
    let token = null;
    let previewTabId;
    let revision = 0;
    let busy = false;
    let preparing = false;
    let coolUntil = 0;
    let expanded = false;
    let message = '';
    let sent = false; // The compact 发送成功 line is kept only until a new draft is opened.
    function renderManual() {
      $('form').hidden = !expanded;
      $('expand').textContent = expanded ? '收起' : '展开';
      $('expand').setAttribute('aria-expanded', String(expanded));
      const draft = $('description').value.trim() !== '' || !$('preview').hidden;
      $('summary').hidden = expanded;
      $('summary').textContent = expanded ? '' : message || (draft ? '草稿已保留，展开后可继续编辑。' : '由你填写描述、预览并确认后才发送。');
      $('status').textContent = expanded ? message : '';
    }
    const status = text => { message = text; sent = false; renderManual(); };
    const invalidate = () => {
      revision++; token = null; previewTabId = undefined;
      $('send').disabled = true; $('preview').hidden = true; $('preview').textContent = '';
    };
    // Folding never clears the draft and never cancels a send that is already on its way.
    $('expand').onclick = () => {
      expanded = !expanded;
      if (expanded && sent) { message = ''; sent = false; }
      renderManual();
      if (expanded && !busy) $('description').focus();
    };
    $('description').oninput = invalidate;
    $('attach').onchange = invalidate;
    chrome.tabs?.onActivated?.addListener(() => { if ($('attach').checked) invalidate(); });
    chrome.tabs?.onUpdated?.addListener((id, change) => { if (id === previewTabId && (change.url || change.status === 'loading')) invalidate(); });
    $('preview-button').onclick = async () => {
      if (busy || preparing) return;
      preparing = true; $('preview-button').disabled = true;
      invalidate(); const current = revision;
      let diagnostics = ''; let tabId;
      try {
        if ($('attach').checked) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (current !== revision) return;
          tabId = tab?.id;
          previewTabId = tabId;
          if (Number.isInteger(tabId)) {
            const page = await chrome.tabs.sendMessage(tabId, { type: 'RESUME_PANEL_STATUS' }).catch(() => null);
            // The v1 block (#215), not the sidebar's human-readable text; the worker filters it again.
            diagnostics = core.diagnostics(page?.diagnosticsReport || '');
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
      busy = false; $('preview-button').disabled = false; $('description').disabled = false; $('attach').disabled = false;
      if (result.ok) {
        // A sent report leaves nothing behind: the next report starts as a new, unreviewed draft.
        $('description').value = ''; $('attach').checked = true; invalidate();
        expanded = false; status(`发送成功，编号：${result.id}`); sent = true;
      } else {
        // The draft stays for the user to edit; the consumed preview must be made again.
        invalidate();
        status(result.reason === 'preview' ? '预览已过期或后台已重启，草稿已保留。请重新预览后确认发送。'
          : result.reason === 'cooldown' ? '两次反馈请至少间隔 60 秒，草稿已保留。'
          : '发送失败，没有自动重试，草稿已保留。请稍后重新预览并发送。');
      }
      setTimeout(() => { if (token && !busy) $('send').disabled = false; }, Math.max(0, coolUntil - Date.now()));
    };
    renderManual();
  }

  refresh();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.feedbackStateV1) refresh();
  });
})();
