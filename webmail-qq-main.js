/* #333: QQ's own export menu runs in the page world. Installed only on QQ; idle
 * installation reads no mail. An explicit side-panel capture asks for one export URL.
 * window.open is replaced only for the synchronous native export click, then restored.
 */
(function (root) {
  const REQUEST = 'resumepro:qq-export-request';
  const RESPONSE = 'resumepro:qq-export-response';
  let busy = false;
  function visible(node) {
    for (let n = node; n?.nodeType === 1; n = n.parentElement) {
      if (n.hidden || n.getAttribute('aria-hidden') === 'true') return false;
      const s = root.getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    }
    return true;
  }
  function unique(selector) {
    const items = [...document.querySelectorAll(selector)].filter(visible);
    return items.length === 1 ? items[0] : null;
  }
  function stamp() {
    const subject = unique('.mail-detail-subject');
    const basic = unique('.mail-detail-basic');
    const body = unique('.mail-detail-content');
    if (!subject || !basic || !body) return null;
    const pane = body.closest('.mail-list-page-reader-body') || body;
    const ids = [pane, subject, basic, body].map(node => [node.getAttribute('data-mailid'), node.getAttribute('mailid')]);
    return { subject, basic, body, value: JSON.stringify([root.location.href, ids, subject.textContent, basic.textContent, body.textContent]) };
  }
  function unchanged(before) {
    const after = stamp();
    return after && after.subject === before.subject && after.basic === before.basic
      && after.body === before.body && after.value === before.value;
  }
  function exportItem() {
    const items = [...document.querySelectorAll('.xmail-ui-panel .xmail-ui-panel-item')]
      .filter(el => visible(el) && !el.closest('.mail-detail-content') && el.textContent.trim() === '导出为 eml 文件');
    return items.length === 1 ? items[0] : null;
  }
  async function exportId() {
    const before = stamp();
    if (!before) return { status: 'unavailable' };
    let item = exportItem();
    if (!item) {
      const more = unique('.mail-detail-basic-action-bar .more-btn');
      if (!more) return { status: 'unavailable' };
      more.click();
      // QQ/React may paint its portal after the handler has returned. No polling of
      // other messages, no global application state, no automatic menu clicks at idle.
      for (let i = 0; i < 10 && !item; i++) {
        await new Promise(resolve => root.setTimeout(resolve, 25));
        if (!unchanged(before)) return { status: 'changed' };
        item = exportItem();
      }
    }
    if (!item || !unchanged(before)) return { status: item ? 'changed' : 'unavailable' };
    let mailId = null;
    let ambiguous = false;
    const originalOpen = root.open;
    function captureOpen(value) {
      try {
        const u = new URL(value, root.location.href);
        const current = new URL(root.location.href);
        if (u.origin === current.origin && u.pathname === '/read/readmail'
            && u.searchParams.get('func') === '3' && u.searchParams.get('sid') === current.searchParams.get('sid')
            && !u.username && !u.password && u.searchParams.get('mailid')?.length <= 512) {
          const id = u.searchParams.get('mailid');
          if (id) {
            if (mailId && mailId !== id) ambiguous = true;
            mailId = id;
          }
        }
      } catch { /* Ignore anything outside the one read-only original export. */ }
      // No popup/download is opened. Isolated content code fetches the original
      // itself with its size, timeout and mail-change checks.
      return null;
    }
    try {
      root.open = captureOpen;
      if (root.open !== captureOpen) return { status: 'unavailable' };
      item.click();
    } finally {
      if (root.open === captureOpen) root.open = originalOpen;
    }
    if (!unchanged(before)) return { status: 'changed' };
    return mailId && !ambiguous ? { status: 'ok', mailId } : { status: 'unavailable' };
  }
  document.addEventListener(REQUEST, async event => {
    if (root.top !== root || root.location.protocol !== 'https:' || root.location.hostname !== 'wx.mail.qq.com'
        || root.location.pathname !== '/home/index' || typeof event.detail !== 'string') return;
    let nonce;
    try { nonce = JSON.parse(event.detail).nonce; } catch { return; }
    if (typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(nonce)) return;
    function reply(result) {
      document.dispatchEvent(new CustomEvent(RESPONSE, { detail: JSON.stringify({ nonce, ...result }) }));
    }
    if (busy) { reply({ status: 'unavailable' }); return; }
    busy = true;
    try { reply(await exportId()); }
    catch { reply({ status: 'unavailable' }); }
    finally { busy = false; }
  });
})(window);
