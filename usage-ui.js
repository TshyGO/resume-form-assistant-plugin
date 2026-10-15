// Shared usage-statistics notice and switch for extension-owned pages.
// The desktop owns the only setting and identifier; this page never stores a second choice.
(() => {
  const settingsRoot = document.getElementById('usage-settings-root');
  const noticeRoot = document.getElementById('usage-notice-root');
  const compactRoot = document.getElementById('usage-compact-root');
  if (!settingsRoot && !noticeRoot && !compactRoot) return;

  const SEEN_KEY = 'usageNoticeSeenV1';
  const send = async action => {
    try { return await chrome.runtime.sendMessage({ type: 'DESKTOP_USAGE_SETTINGS', action }); }
    catch { return { ok: false, code: 'unavailable' }; }
  };
  let status = null;
  let busy = false;

  const shortText = '每天最多发送一次桌面和一次插件使用信号，只含随机编号、版本、系统类型和来源；不含简历、网页或具体操作。关闭不影响功能。';
  if (settingsRoot) settingsRoot.innerHTML = `
    <section class="feedback-card usage-card" data-usage-settings aria-labelledby="usage-settings-title">
      <div class="feedback-auto-head">
        <span class="card-icon usage-icon" aria-hidden="true">#</span>
        <div class="feedback-auto-heading"><h2 id="usage-settings-title">使用数量统计</h2><p class="feedback-sub">由桌面统一保存，插件和桌面使用同一个开关</p></div>
        <label class="feedback-switch"><input type="checkbox" id="usage-toggle" disabled>分享使用数量统计</label>
      </div>
      <p class="feedback-state" id="usage-state">正在读取桌面设置…</p>
      <p class="feedback-note feedback-box">${shortText}</p>
      <p class="feedback-note">完整字段、保留时间和删除规则见隐私政策。自动错误报告是另一项独立设置。</p>
      <button type="button" id="usage-retry" hidden>重新读取设置</button>
      <p id="usage-result" role="status" aria-live="polite"></p>
    </section>`;
  if (compactRoot) compactRoot.innerHTML = `
    <div class="feedback-auto-line" data-usage-settings>
      <span id="usage-compact-state">使用数量统计：正在读取…</span>
      <button type="button" id="usage-open-status" class="feedback-link">在「插件状态」中设置</button>
    </div>`;
  if (noticeRoot) noticeRoot.innerHTML = `
    <section class="feedback-card feedback-notice usage-notice" data-usage-settings hidden aria-labelledby="usage-notice-title">
      <h2 id="usage-notice-title">使用数量统计</h2>
      <p>${shortText}</p>
      <p class="feedback-note">统计由桌面统一发送和保存，这里更改的是桌面和插件共用的同一个开关。</p>
      <div class="feedback-actions">
        <button type="button" id="usage-disable">关闭使用统计</button>
        <button type="button" id="usage-ack" class="feedback-primary">知道了，保持开启</button>
      </div>
      <p id="usage-notice-result" role="status" aria-live="polite"></p>
    </section>`;

  const byId = id => document.getElementById(id);
  const messageFor = value => !value ? '未连接桌面程序，启动或更新桌面后才能管理。'
    : !value.available ? '桌面无法可靠保存统计设置，当前已停止发送。'
    : value.enabled ? '已开启：桌面和插件共用这一选择。' : '已关闭：桌面和插件都不会发送使用信号。';
  async function render(value = status) {
    status = value;
    const known = Boolean(value && typeof value.enabled === 'boolean');
    const toggle = byId('usage-toggle');
    if (toggle) { toggle.checked = known && value.enabled; toggle.disabled = busy || !known || !value.available; }
    const state = byId('usage-state');
    if (state) { state.textContent = messageFor(known ? value : null); state.dataset.tone = known && value.enabled ? 'on' : known ? 'off' : 'unknown'; }
    const compact = byId('usage-compact-state');
    if (compact) compact.textContent = known ? `使用数量统计：${value.enabled ? '已开启' : '已关闭'}（与桌面同步）` : '使用数量统计：桌面未连接';
    if (byId('usage-retry')) byId('usage-retry').hidden = known;
    if (noticeRoot) {
      const stored = await chrome.storage.local.get(SEEN_KEY);
      const show = !stored[SEEN_KEY];
      const card = noticeRoot.querySelector('.usage-notice');
      if (card) card.hidden = !show;
      noticeRoot.hidden = !show;
      if (byId('usage-disable')) byId('usage-disable').hidden = known && !value.enabled;
      if (byId('usage-ack')) byId('usage-ack').textContent = known && !value.enabled ? '知道了' : '知道了，保持开启';
      for (const id of ['usage-disable', 'usage-ack']) if (byId(id)) byId(id).disabled = busy || !known || !value.available;
      if (show && !known) byId('usage-notice-result').textContent = '请先启动或更新桌面程序，再选择是否开启。';
    }
  }
  async function refresh() {
    const result = await send('status');
    await render(result?.ok ? result.status : null);
  }
  async function change(action) {
    if (busy) return;
    busy = true; await render();
    const result = await send(action);
    busy = false;
    if (!result?.ok) {
      const text = '设置未能保存，请确认桌面程序正在运行并已更新。';
      if (byId('usage-result')) byId('usage-result').textContent = text;
      if (byId('usage-notice-result')) byId('usage-notice-result').textContent = text;
      await refresh(); return;
    }
    status = result.status;
    if (action === 'disable' || action === 'acknowledge') await chrome.storage.local.set({ [SEEN_KEY]: true });
    if (byId('usage-result')) byId('usage-result').textContent = action === 'disable' ? '已关闭桌面和插件的使用数量统计。' : action === 'enable' ? '已开启桌面和插件的使用数量统计。' : '';
    await render(status);
  }
  if (byId('usage-toggle')) byId('usage-toggle').onchange = event => void change(event.target.checked ? 'enable' : 'disable');
  if (byId('usage-disable')) byId('usage-disable').onclick = () => void change('disable');
  if (byId('usage-ack')) byId('usage-ack').onclick = () => void change('acknowledge');
  if (byId('usage-retry')) byId('usage-retry').onclick = () => void refresh();
  if (byId('usage-open-status')) byId('usage-open-status').onclick = () => chrome.runtime.openOptionsPage?.();
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[SEEN_KEY]) void render(); });
  void refresh();
})();
