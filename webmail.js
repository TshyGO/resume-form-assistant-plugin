/* #333: provider adapters. Nothing is read until the side panel sends CAPTURE. */
(function (root) {
  const MAX_BYTES = 25 * 1024 * 1024;
  const MAX_EXCERPT = 1024 * 1024;
  function provider(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') return null;
      if (['mail.qq.com', 'wx.mail.qq.com'].includes(u.hostname)) return 'qq';
      if (['163', '126'].some(n => u.hostname === `mail.${n}.com` || u.hostname.endsWith(`.mail.${n}.com`))) return 'netease';
    } catch {}
    return null;
  }
  const adapters = {
    qq: {
      body: '#mailContentContainer, #mailContent, .mail-detail-content',
      subject: '#subject, .mail_subject, .mail-detail-subject',
      from: '#fromaddr, #mail_sender, .mail_sender, .mail-detail-sender',
      time: '#mail_date, #date, .mail_detail_date, .mail-detail-time',
      tools: '#toolbar, #mail_toolbar, .mail-toolbar, .mail-detail-toolbar'
    },
    netease: {
      body: '.nui-read-body, .nui-read-content, [id$="_readMain"] .mail-content',
      subject: '.nui-read-title, .nui-read-header .nui-read-txt, [id$="_readMain"] h1',
      from: '.nui-read-header .nui-addr-email, .nui-read-header .nui-addr, [id$="_readMain"] .mail-from',
      time: '.nui-read-header .nui-read-time, .nui-read-header .js-component-datetime, [id$="_readMain"] .mail-time',
      tools: '.nui-read-toolbar, .nui-toolbar, [id$="_readMain"] .mail-toolbar'
    }
  };
  function shown(node) {
    for (let n = node; n?.nodeType === 1; n = n.parentElement) {
      if (n.hidden || n.getAttribute('aria-hidden') === 'true') return false;
      const style = n.ownerDocument.defaultView?.getComputedStyle(n);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    }
    return true;
  }
  function first(doc, selector) { return [...doc.querySelectorAll(selector)].find(shown) || null; }
  function text(node) { return (node?.innerText ?? node?.textContent ?? '').trim(); }
  function bodyText(node) {
    const copy = node.cloneNode(true);
    for (const el of copy.querySelectorAll('script, style, noscript, [hidden], [aria-hidden="true"]')) el.remove();
    // Keep paragraph boundaries when textContent is the only available view.
    for (const el of copy.querySelectorAll('br, p, div, li, tr')) el.appendChild(copy.ownerDocument.createTextNode('\n'));
    return text(copy);
  }
  function documents(doc) {
    const all = [doc];
    for (let i = 0; i < all.length && all.length < 12; i++) {
      for (const frame of all[i].querySelectorAll('iframe')) {
        if (!shown(frame)) continue;
        try {
          const child = frame.contentDocument;
          if (child && !all.includes(child) && child.location.origin === doc.location.origin) all.push(child);
        } catch { /* Cross-origin frames are not inspected. */ }
      }
    }
    return all;
  }
  function readUrl(value, doc) {
    try {
      const u = new URL(value, doc.location.href);
      return u.origin === doc.location.origin && /^\/js[0-9]+\/read\/readhtml3\.jsp$/.test(u.pathname)
        && u.searchParams.get('mid') && !u.username && !u.password ? u : null;
    } catch { return null; }
  }
  function contexts(doc, body) {
    const frames = body.tagName === 'IFRAME' ? [body] : [...body.querySelectorAll('iframe')].filter(shown);
    const urls = [doc.location.href];
    for (const frame of frames) {
      if (frame.getAttribute('src')) urls.push(frame.src);
      try {
        const child = frame.contentDocument;
        if (child?.location.origin === doc.location.origin) urls.push(child.location.href);
      } catch { /* Do not inspect cross-origin documents. */ }
    }
    return [...new Set(urls)];
  }
  function neteaseReader(doc) {
    // Observed js6 layout: the heading is outside the message's readhtml3 iframe.
    // Pair them inside the same visible scroll pane, never by a global first match.
    const headings = [...doc.querySelectorAll('h1[id$="_h1Subject"]')].filter(shown);
    // null means this layout is absent; [] means it is present but cannot be paired safely.
    if (!headings.length) return null;
    const matches = [];
    for (const title of headings) {
      const header = title.closest('[id$="_dvReadHeadInfo"]');
      const pane = header?.closest('.frame-main-cont-body');
      if (!pane || !text(title) || headings.filter(h => pane.contains(h)).length !== 1) continue;
      const frames = [...pane.querySelectorAll('iframe')].filter(frame => {
        if (!shown(frame) || header.contains(frame)) return false;
        try { return Boolean(readUrl(frame.contentDocument?.location.href, doc)); } catch { return false; }
      });
      if (frames.length !== 1) continue;
      const body = frames[0];
      const content = body.contentDocument.querySelector('#content.netease_mail_readhtml');
      if (!content || !text(content)) continue;
      const sourceUrls = contexts(doc, body);
      const ids = new Set(sourceUrls.map(value => readUrl(value, doc)?.searchParams.get('mid')).filter(Boolean));
      if (ids.size !== 1) continue; // A frame can still be navigating to another message.
      const fromNode = first(header, '.nui-addr-email') || first(header, '.nui-addr');
      const data = { subject: text(title),
        from: (fromNode?.getAttribute('email') || fromNode?.getAttribute('addr') || text(fromNode)).trim(),
        sentTime: text(first(header, '.nui-read-time, .js-component-datetime')), body: bodyText(content) };
      // No command is taken from the email's own document.
      const links = [...pane.querySelectorAll('.nui-toolbar a[href], [role="toolbar"] a[href]')];
      matches.push({ doc, body, data, links, sourceUrls, fingerprint: JSON.stringify([data, [...ids]]) });
    }
    return matches;
  }
  function opened(doc, name) {
    const a = adapters[name];
    const matches = [];
    for (const d of documents(doc)) {
      if (name === 'netease') {
        const modern = neteaseReader(d);
        if (modern) { matches.push(...modern); continue; }
      }
      const bodies = [...d.querySelectorAll(a.body)].filter(shown);
      if (bodies.filter(n => !bodies.some(other => other !== n && other.contains(n))).length !== 1) continue;
      const body = bodies[0];
      const title = first(d, a.subject);
      if (!body || !title || !text(title)) continue;
      let bodyNode = body;
      if (body.tagName === 'IFRAME') {
        try { bodyNode = body.contentDocument?.body; } catch { continue; }
      } else {
        const frame = body.querySelector('iframe');
        if (frame) { try { bodyNode = frame.contentDocument?.body || body; } catch {} }
      }
      if (!bodyNode || !text(bodyNode)) continue;
      const fromNode = first(d, a.from);
      const from = (fromNode?.getAttribute('email') || fromNode?.getAttribute('addr') || text(fromNode)).trim();
      const data = { subject: text(title), from, sentTime: text(first(d, a.time)), body: bodyText(bodyNode) };
      // A message's own HTML never supplies a download command.
      const links = [...d.querySelectorAll(a.tools)].flatMap(tool => [...tool.querySelectorAll('a[href]')])
        .filter(link => !body.contains(link));
      const sourceUrls = contexts(d, body);
      const key = name === 'qq' ? 'mailid' : 'mid';
      const ids = sourceUrls.map(value => { try { return new URL(value).searchParams.get(key); } catch { return null; } }).filter(Boolean);
      const modernQQ = name === 'qq' && d.location.hostname === 'wx.mail.qq.com' && d.location.pathname === '/home/index';
      const pane = body.closest('.mail-list-page-reader-body') || body;
      const visibleIds = modernQQ ? [pane, title, fromNode, body].map(node => [node?.getAttribute('data-mailid'), node?.getAttribute('mailid')]) : [];
      matches.push({ doc: d, body, title, data, links, sourceUrls,
        fingerprint: JSON.stringify([data, ids, modernQQ ? d.location.href : '', visibleIds]) });
    }
    // Refuse an ambiguous page with two open message panes instead of choosing the wrong one.
    return matches.length === 1 ? matches[0] : null;
  }
  function rawUrl(link, name, origin) {
    let u;
    try { u = new URL(link.getAttribute('href'), link.ownerDocument.location.href); } catch { return null; }
    if (u.origin !== origin || u.protocol !== 'https:' || u.username || u.password) return null;
    if (name === 'qq') {
      if (u.pathname !== '/cgi-bin/readmail' || u.searchParams.get('t') !== 'download'
          || !u.searchParams.get('mailid') || !u.searchParams.get('sid')) return null;
    } else {
      if (!/^\/(?:js[0-9]+|m)\/read\/readdata\.jsp$/.test(u.pathname)
          || u.searchParams.get('mode') !== 'download' || !u.searchParams.get('mid')
          || !u.searchParams.get('sid') || u.searchParams.has('part')) return null;
    }
    return u.href;
  }
  function rawCandidates(ctx, name) {
    const origin = ctx.doc.location.origin;
    const sourceUrls = ctx.sourceUrls || contexts(ctx.doc, ctx.body);
    const urls = ctx.links.filter(link => /下载邮件|导出邮件|导出为\s*eml\s*文件|下载原文|保存邮件|download.*(?:mail|message)|original/i
      .test(`${text(link)} ${link.getAttribute('title') || ''}`))
      .map(link => rawUrl(link, name, origin)).filter(Boolean);
    // QQ's classic read view contains the exact mailid and login session in its own URL.
    // Reuse those only in the provider's fixed read/download endpoint, never send them to desktop.
    if (name === 'qq') {
      const current = new URL(ctx.doc.location.href);
      if (current.pathname === '/cgi-bin/readmail' && current.searchParams.get('mailid') && current.searchParams.get('sid')) {
        const u = new URL('/cgi-bin/readmail', origin);
        for (const key of ['sid', 'mailid']) u.searchParams.set(key, current.searchParams.get(key));
        u.searchParams.set('t', 'download');
        urls.push(u.href);
      }
    }
    if (name === 'netease') {
      const session = new URL(ctx.doc.location.href).searchParams.get('sid');
      for (const value of sourceUrls) {
        const current = new URL(value, ctx.doc.location.href);
        if (current.origin !== origin || !/^\/js[0-9]+\/read\//.test(current.pathname)
            || !current.searchParams.get('mid') || !(current.searchParams.get('sid') || session)) continue;
        const u = new URL(current.pathname.replace(/[^/]+$/, 'readdata.jsp'), origin);
        u.searchParams.set('mid', current.searchParams.get('mid'));
        u.searchParams.set('sid', current.searchParams.get('sid') || session);
        u.searchParams.set('mode', 'download'); urls.push(u.href);
      }
    }
    const idKey = name === 'qq' ? 'mailid' : 'mid';
    const currentIds = new Set(sourceUrls
      .map(value => { try { const u = new URL(value, ctx.doc.location.href); return u.origin === origin ? u.searchParams.get(idKey) : null; } catch { return null; } })
      .filter(Boolean));
    if (currentIds.size > 1) return [];
    const candidates = [...new Set(urls)].filter(value => !currentIds.size || currentIds.has(new URL(value).searchParams.get(idKey)));
    const linkedIds = new Set(candidates.map(value => new URL(value).searchParams.get(idKey)));
    return linkedIds.size === 1 ? candidates : [];
  }
  function base64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
  }
  async function readBounded(response) {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('too_large');
    if (!response.body?.getReader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_BYTES) throw new Error('too_large');
      return bytes;
    }
    const reader = response.body.getReader();
    const parts = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) throw new Error('too_large');
        parts.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
  }
  function looksLikeMail(bytes) {
    const start = new TextDecoder().decode(bytes.subarray(0, 65536));
    const headers = start.split(/\r?\n\r?\n/, 1)[0];
    return !/^\s*(?:<!doctype|<html)/i.test(start)
      && /^(?:From|Subject|Date):[^\r\n]+/im.test(headers)
      && (headers.match(/^(?:From|To|Subject|Date|Message-ID|MIME-Version|Content-Type):/gim) || []).length >= 2;
  }
  function qqModernOriginal(doc) {
    return new Promise(resolve => {
      const nonce = root.crypto.randomUUID();
      const finish = result => {
        clearTimeout(timer);
        doc.removeEventListener('resumepro:qq-export-response', answer);
        resolve(result);
      };
      function answer(event) {
        if (typeof event.detail !== 'string') return;
        let result;
        try { result = JSON.parse(event.detail); } catch { return; }
        if (result.nonce !== nonce) return;
        if (result.status === 'changed') { finish({ changed: true }); return; }
        if (result.status !== 'ok' || typeof result.mailId !== 'string' || !result.mailId || result.mailId.length > 512) {
          finish({}); return;
        }
        const current = new URL(doc.location.href);
        if (current.protocol !== 'https:' || current.hostname !== 'wx.mail.qq.com' || current.pathname !== '/home/index'
            || !current.searchParams.get('sid')) { finish({}); return; }
        const url = new URL('/read/readmail', current.origin);
        url.searchParams.set('func', '3');
        url.searchParams.set('mailid', result.mailId);
        url.searchParams.set('sid', current.searchParams.get('sid'));
        finish({ url: url.href });
      }
      const timer = setTimeout(() => finish({}), 1500);
      doc.addEventListener('resumepro:qq-export-response', answer);
      doc.dispatchEvent(new doc.defaultView.CustomEvent('resumepro:qq-export-request', { detail: JSON.stringify({ nonce }) }));
    });
  }
  async function capture(doc, fetcher = root.fetch.bind(root)) {
    const name = provider(doc.location.href);
    if (!name) return { status: 'unsupported' };
    const ctx = opened(doc, name);
    if (!ctx) {
      const selector = adapters[name].subject + (name === 'netease' ? ', h1[id$="_h1Subject"]' : '');
      const hasTitle = documents(doc).some(d => [...d.querySelectorAll(selector)].some(n => shown(n) && text(n)));
      return { status: hasTitle ? 'unrecognized_mail' : 'open_mail' };
    }
    const unchanged = () => {
      const current = opened(doc, name);
      return current?.fingerprint === ctx.fingerprint && current.body === ctx.body && current.title === ctx.title;
    };
    let reason = 'raw_unavailable';
    const candidates = rawCandidates(ctx, name);
    const current = new URL(doc.location.href);
    if (name === 'qq' && current.hostname === 'wx.mail.qq.com' && current.pathname === '/home/index') {
      const modern = await qqModernOriginal(doc);
      if (modern.changed || !unchanged()) return { status: 'changed' };
      if (modern.url) candidates.unshift(modern.url);
    }
    for (const url of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetcher(url, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
        if (!response.ok) continue;
        const bytes = await readBounded(response);
        if (!looksLikeMail(bytes)) continue; // Login/error pages are never called an original.
        if (!unchanged()) return { status: 'changed' };
        return { status: 'original', kind: 'eml', bytesBase64: base64(bytes), subject: ctx.data.subject };
      } catch (error) {
        if (error.message === 'too_large') reason = 'too_large';
      } finally { clearTimeout(timer); controller.abort(); }
    }
    if (!unchanged()) return { status: 'changed' };
    if (new TextEncoder().encode(ctx.data.body).length > MAX_EXCERPT || ctx.data.subject.length > 500
        || ctx.data.from.length > 500 || ctx.data.sentTime.length > 200) return { status: 'too_large' };
    // This is a proposal only. The user must explicitly accept saving an excerpt in the side panel.
    return { status: 'excerpt_offer', reason, excerpt: ctx.data };
  }
  const api = { provider, capture, opened, rawCandidates, looksLikeMail, readBounded, MAX_BYTES };
  root.ResumeProWebmail = api;
  if (typeof module === 'object') module.exports = api;
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && root.window === root && root.top === root && provider(root.location?.href)) {
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (message?.type !== 'WEBMAIL_CAPTURE') return false;
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('') + 'sidepanel.html') {
        reply({ status: 'forbidden' }); return false;
      }
      capture(document).then(reply, () => reply({ status: 'unavailable' }));
      return true;
    });
  }
})(typeof self === 'object' ? self : globalThis);
