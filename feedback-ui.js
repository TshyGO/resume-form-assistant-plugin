// Runs only in extension-owned pages. No inline handlers, HTML from reports or secrets.
// Two independent features share this file: 自动错误报告 (off until the user agrees, then set on
// the status page) and 手动反馈问题 (a draft previewed and confirmed in the side panel only).
// Neither changes the other.
(() => {
  const noticeRoot = document.getElementById('feedback-notice-root');
  const autoRoot = document.getElementById('feedback-auto-root');
  const manualRoot = document.getElementById('feedback-manual-root');
  if (!autoRoot) return;
  const core = self.ResumeProFeedback;
  const send = async data => { try { return await chrome.runtime.sendMessage(data); } catch { return { ok: false, reason: 'unavailable' }; } };
  // The side panel shows the preference as one line plus the choice of its own while the user has
  // not chosen. The status page owns the switch and unfolds the same explanation inside its card.
  const compact = autoRoot.dataset.variant === 'compact';
  const explanation = `
      <p>我们在用户群和社交平台上收到过不少反馈，但很多只有一句「填不上」「用不了」，看不出是哪个网站、卡在哪一步，很难找到原因。开启自动错误报告后，插件出错或一键填写有字段没填上时，会把当时的技术情况发给我们，帮我们更快找到问题、把它修好。</p>
      <p class="feedback-note">报告里只有技术信息：错误类型、出错的代码位置、插件版本、系统、发送时间和一个随机生成的安装编号。网页上出的问题还会带上网站域名和这次填写的统计，比如页面路径（其中的编号会去掉）、字段和控件的数量与类型、填上了多少、用时、卡在哪一步。不包含你的简历、填写的内容、页面上的文字、完整网址、Cookie 或密钥。</p>
      <p class="feedback-note">发送前会先去掉可能的个人信息。报告最多保存 90 天；其中的网站域名和填写统计可能会公开在网申快填的 GitHub 项目里，方便复现问题，公开的内容会长期保留；安装编号不会公开。</p>
      <p class="feedback-note">你同意后才开始发送，同意前出的错不会补发。可以随时关闭，关闭后停止发送并删除安装编号，不影响填写。插件和桌面程序分开设置。</p>
      <p class="feedback-note">遇到问题也可以在${compact ? '' : '侧栏的'}「手动反馈问题」里自己写，预览确认后才会发送。</p>`;
  if (compact && noticeRoot) noticeRoot.innerHTML = `
    <section class="feedback-card feedback-notice" id="feedback-consent" hidden aria-labelledby="feedback-notice-title">
      <h2 id="feedback-notice-title">帮我们改进网申快填</h2>${explanation}
      <p class="feedback-note">以后可以到「插件状态」更改。</p>
      <div class="feedback-actions">
        <button type="button" id="feedback-enable">同意并开启</button>
        <button type="button" id="feedback-decline">暂不开启</button>
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
      <p class="feedback-note">你同意后才会开启。关闭后删除安装编号，不影响侧栏里的「手动反馈问题」。插件和桌面程序分开设置。</p>
      <div class="feedback-actions">
        <button type="button" id="feedback-about" aria-expanded="false" aria-controls="feedback-details" hidden>查看完整说明</button>
        <button type="button" id="feedback-retry" hidden>重新读取设置</button>
      </div>
      <div id="feedback-details" class="feedback-details" role="region" aria-label="完整说明" hidden>${explanation}
        <p class="feedback-note" id="feedback-details-hint"></p>
        <div class="feedback-actions">
          <button type="button" id="feedback-enable" hidden>同意并开启</button>
          <button type="button" id="feedback-decline" hidden>暂不开启</button>
        </div>
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
        <p class="feedback-note">只有点「确认发送」才会发送。报告最多保存 90 天；可能会公开在网申快填的 GitHub 项目里，公开的内容会长期保留。发送前请核对下方全部内容。</p>
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
    const known = typeof result.consent === 'boolean' && typeof result.decided === 'boolean';
    // Not chosen yet: nothing is sent, and the choice stays on screen until the user makes one.
    const undecided = known && !result.decided;
    if (compact) {
      // Side panel: the choice only. Re-reading and changing the setting happen on the status page.
      if ($('consent')) { $('consent').hidden = !undecided; noticeRoot.hidden = !undecided; }
    } else {
      // Status page: the explanation unfolds inside the card. While undecided it stays open with the
      // two choices; afterwards 「查看完整说明」 / 「收起说明」 toggles it.
      const open = undecided || aboutOpen;
      $('details').hidden = !open;
      // Hidden until the settings are known, so an early click cannot render a failure state.
      $('about').hidden = undecided || !known;
      $('about').textContent = open ? '收起说明' : '查看完整说明';
      $('about').setAttribute('aria-expanded', String(open));
      $('enable').hidden = !undecided; $('decline').hidden = !undecided;
      $('details-hint').textContent = undecided
        ? '以后也可以用上方的「开启自动错误报告」更改。'
        : '如需开启或关闭，勾选或取消勾选上方「开启自动错误报告」即可。';
      $('toggle').checked = result.consent === true; $('toggle').disabled = !known || savingConsent;
    }
    const state = !known ? '无法读取设置' : undecided ? '未开启' : result.consent ? '已开启' : '已关闭';
    $('auto-state').textContent = compact ? `自动错误报告：${state}${known ? '（在「插件状态」中设置）' : ''}`
      : !known ? '无法读取设置。' : undecided ? '未开启：你选择之前不会自动发送任何报告。'
      : result.consent ? '已开启：插件检测到自身异常或字段没填上时，会自动发送脱敏诊断。' : '已关闭：不会自动发送任何报告。';
    $('retry').hidden = known;
    if (!known) autoStatus('无法读取反馈设置，请重新读取。');
  }
  const controls = () => ['enable', 'decline', 'toggle'].map($).filter(Boolean);
  async function consent(enabled) {
    if (savingConsent) return;
    savingConsent = true;
    controls().forEach(control => { control.disabled = true; });
    const result = await send({ type: 'FEEDBACK_CONSENT', enabled });
    savingConsent = false;
    controls().forEach(control => { control.disabled = false; });
    const saved = typeof result.consent === 'boolean' && typeof result.decided === 'boolean';
    // A failed save changes nothing, so the choice (or the switch's last saved state) stays as it was.
    renderConsent(saved ? result : settings);
    autoStatus(!saved ? '设置未保存，请重试。'
      : result.consent ? '已开启自动错误报告，谢谢。' : '自动错误报告没有开启，不会自动发送任何报告。手动反馈问题不受影响。');
  }
  const refresh = () => send({ type: 'FEEDBACK_STATUS' }).then(renderConsent);
  $('retry').onclick = refresh;
  if ($('enable')) $('enable').onclick = () => { aboutOpen = false; consent(true); };
  if ($('decline')) $('decline').onclick = () => { aboutOpen = false; consent(false); };
  if ($('toggle')) $('toggle').onchange = () => {
    // Choosing with the switch while undecided: keep the explanation open, it is being read.
    if (settings.decided === false) aboutOpen = true;
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
