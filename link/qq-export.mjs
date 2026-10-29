// Serialized by chrome.scripting: keep this function self-contained. No DOM event
// reply or page global carries the result back to the extension.
export async function qqExportCurrentMail(expected) {
  const root = window;
  if (root.top !== root || root.location.protocol !== 'https:' || root.location.hostname !== 'wx.mail.qq.com'
      || root.location.pathname !== '/home/index') return { status: 'unavailable' };
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
    if (!before || before.value !== expected) return { status: 'changed' };
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
  try { return await exportId(); }
  catch { return { status: 'unavailable' }; }
}

export function createQQExporter(api) {
  const pending = new Set();
  return async (message, sender) => {
    let url;
    try { url = new URL(sender?.url); } catch { return { status: 'forbidden' }; }
    if (sender?.id !== api.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || sender.tab.id < 0
        || typeof sender.documentId !== 'string' || !sender.documentId
        || url.protocol !== 'https:' || url.hostname !== 'wx.mail.qq.com' || url.pathname !== '/home/index' || url.username || url.password) {
      return { status: 'forbidden' };
    }
    if (typeof message.stamp !== 'string' || message.stamp.length > 2 * 1024 * 1024) return { status: 'unavailable' };
    const key = `${sender.tab.id}:${sender.documentId}`;
    if (pending.has(key)) return { status: 'unavailable' };
    pending.add(key);
    try {
      const results = await api.scripting.executeScript({
        target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
        world: 'MAIN', func: qqExportCurrentMail, args: [message.stamp],
      });
      if (results?.length !== 1 || results[0].frameId !== 0 || results[0].documentId !== sender.documentId) return { status: 'unavailable' };
      const result = results[0].result;
      if (result?.status === 'changed') return { status: 'changed' };
      return result?.status === 'ok' && typeof result.mailId === 'string' && result.mailId.length > 0 && result.mailId.length <= 512
        ? { status: 'ok', mailId: result.mailId } : { status: 'unavailable' };
    } catch { return { status: 'unavailable' }; }
    finally { pending.delete(key); }
  };
}
