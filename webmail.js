/* #333/#357: provider adapters. Nothing is read until the side panel sends CAPTURE. */
(function (root) {
  const MAX_BYTES = 25 * 1024 * 1024;
  const MAX_EXCERPT = 1024 * 1024;
  function provider(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') return null;
      if (['mail.qq.com', 'wx.mail.qq.com'].includes(u.hostname)) return 'qq';
      if (['mail.google.com', 'mail.googlemail.com'].includes(u.hostname) && /^\/mail\/u\/\d{1,3}\/?$/.test(u.pathname)) return 'gmail';
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
  // Gmail message cards and the native "Show original" page are separate
  // surfaces. Never treat an entire conversation or a quoted card as one mail.
  let gmailTarget = null;
  function gmailRoute(doc) {
    try {
      const url = new URL(doc.location.href);
      const path = /^\/mail\/u\/(\d{1,3})\/?$/.exec(url.pathname);
      return provider(url.href) === 'gmail' && path ? { url, index: path[1], path: `/mail/u/${path[1]}/` } : null;
    } catch { return null; }
  }
  function gmailIds(node) {
    const raw = node.getAttribute('data-message-id') || '';
    const perm = /^#?msg-[af]:[\w-]{1,128}$/.test(raw) ? raw.replace(/^#/, '') : '';
    const legacy = node.getAttribute('data-legacy-message-id') || '';
    return { perm, legacy: /^[a-f0-9]{12,32}$/i.test(legacy) ? legacy.toLowerCase() : '' };
  }
  function gmailMessageIds(ids) {
    const found = new Set(ids.legacy ? [ids.legacy] : []);
    if (/^msg-f:\d+$/.test(ids.perm)) {
      const legacy = BigInt(ids.perm.slice(6)).toString(16);
      if (ids.legacy && legacy !== ids.legacy) return null;
      found.add(legacy);
    }
    return found;
  }
  function gmailRawUrl(link, ctx) {
    let url;
    try { url = new URL(link.getAttribute('href'), ctx.doc.location.href); } catch { return null; }
    const route = gmailRoute(ctx.doc);
    if (!route || url.origin !== route.url.origin || url.pathname.replace(/\/$/, '') + '/' !== route.path || url.username || url.password) return null;
    const allowed = new Set(['ui', 'ik', 'view', 'th', 'permmsgid', 'authuser', 'attid', 'disp', 'safe', 'zw', 'd']);
    const counts = new Set();
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || counts.has(key)) return null;
      counts.add(key);
    }
    const user = url.searchParams.get('authuser');
    if (user && user !== route.index && user.toLowerCase() !== ctx.account) return null;
    // Only the message's raw source, never a single attachment or an action.
    const view = url.searchParams.get('view');
    if (view !== 'att' || url.searchParams.get('attid') !== '0' || url.searchParams.get('disp') !== 'comp') return null;
    const ids = gmailMessageIds(ctx.ids);
    if (!ids) return null;
    const legacy = url.searchParams.get('th');
    const perm = url.searchParams.get('permmsgid');
    if ((!legacy && !perm) || (legacy && !ids.has(legacy.toLowerCase())) || (perm && perm !== ctx.ids.perm)) return null;
    // Gmail's own no-slash link 301s to this equivalent same-account path.
    // Normalize it before the restricted extension downloader handles redirects.
    url.pathname = route.path;
    return url.href;
  }
  function gmailAccount(doc, main) {
    // Read only the mailbox's own account control, outside all message HTML.
    const accounts = new Set();
    for (const link of doc.querySelectorAll('header a[href], [role="banner"] a[href]')) {
      if (main.contains(link)) continue;
      let url;
      try { url = new URL(link.href); } catch { continue; }
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.pathname !== '/SignOutOptions') continue;
      const label = link.getAttribute('aria-label') || link.getAttribute('title') || '';
      const addresses = label.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
      for (const address of addresses) accounts.add(address.toLowerCase());
    }
    return accounts.size === 1 ? [...accounts][0] : null;
  }
  function gmailFullMessage(doc, route) {
    const legacy = route.url.searchParams.get('th') || '', perm = route.url.searchParams.get('permmsgid') || '';
    const ids = { legacy: /^[a-f0-9]{12,32}$/i.test(legacy) ? legacy.toLowerCase() : '', perm: /^msg-[af]:[\w-]{1,128}$/.test(perm) ? perm : '' };
    if ((!ids.legacy && !ids.perm) || !gmailMessageIds(ids)) return { status: 'unrecognized_mail' };
    const mains = [...doc.querySelectorAll('body > .bodycontainer > .maincontent')].filter(shown);
    if (mains.length !== 1) return { status: 'unrecognized_mail' };
    const main = mains[0], tables = [...main.children].filter(node => node.tagName === 'TABLE');
    const messages = tables.filter(node => node.classList.contains('message') && shown(node));
    if (messages.length > 1) return { status: 'multiple_messages' };
    const titleTables = tables.filter(node => !node.classList.contains('message'));
    if (messages.length !== 1 || titleTables.length !== 1) return { status: 'unrecognized_mail' };
    const title = titleTables[0].querySelector('font[size="+1"]'), message = messages[0];
    const header = message.rows[0]?.cells, cell = message.rows[2]?.cells[0];
    if (!title || !text(title) || header?.length !== 2 || header[1].getAttribute('align') !== 'right' || !cell) return { status: 'unrecognized_mail' };
    const layout = [...cell.children].filter(node => node.tagName === 'TABLE' && node.getAttribute('cellpadding') === '12');
    const content = layout.length === 1 ? layout[0].rows[0]?.cells[0] : null;
    const bodies = content ? [...content.children].filter(node => node.tagName === 'DIV' && node.style.overflow === 'hidden') : [];
    if (bodies.length !== 1 || !text(bodies[0])) return { status: 'unrecognized_mail' };
    const owner = doc.querySelector('body > .bodycontainer > table');
    const accounts = new Set((text(owner).match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(x => x.toLowerCase()));
    if (accounts.size !== 1) return { status: 'account_unavailable' };
    const account = [...accounts][0], body = bodies[0];
    const data = { subject: text(title), from: text(header[0]), sentTime: text(header[1]), body: bodyText(body) };
    const ctx = { doc, body, title, ids, account, data, links: [], clipped: false };
    ctx.fingerprint = JSON.stringify([route.url.href, account, ids, data]);
    return { ctx };
  }
  function inspectGmail(doc) {
    const route = gmailRoute(doc);
    if (!route) return { status: 'unrecognized_mail' };
    if (route.url.searchParams.get('view') === 'lg') return gmailFullMessage(doc, route);
    if (route.url.searchParams.get('view') === 'om') {
      const legacy = route.url.searchParams.get('th') || '';
      const perm = route.url.searchParams.get('permmsgid') || '';
      const ids = { legacy: /^[a-f0-9]{12,32}$/i.test(legacy) ? legacy.toLowerCase() : '', perm: /^msg-[af]:[\w-]{1,128}$/.test(perm) ? perm : '' };
      if ((!ids.legacy && !ids.perm) || !gmailMessageIds(ids)) return { status: 'unrecognized_mail' };
      const links = [...doc.querySelectorAll('a[href]')].filter(link => shown(link) && !link.closest('pre, textarea, .raw_message, .a3s')
        && (link.hasAttribute('download') || /download\s+original|下载原始邮件|下載原始郵件|下载原文|下載原文/i.test(text(link))));
      const ctx = { doc, body: doc.body, title: doc.body, ids, account: route.index, originalPage: true,
        data: { subject: 'Gmail 邮件原件', from: '', sentTime: '', body: '' }, links };
      ctx.fingerprint = JSON.stringify([route.url.href, links.map(link => link.getAttribute('href'))]);
      return { ctx };
    }
    // Search the unique visible Gmail reading surface, not inbox rows, drafts,
    // hidden cached conversations, or HTML nested inside a received message.
    const mains = [...doc.querySelectorAll('main, [role="main"]')].filter(shown);
    if (mains.length !== 1) return { status: 'open_mail' };
    const main = mains[0];
    const titles = [...main.querySelectorAll('h2.hP, h2[data-thread-perm-id]')].filter(node => shown(node) && !node.closest('.a3s'));
    if (titles.length !== 1 || !text(titles[0])) return { status: 'open_mail' };
    const cards = [...main.querySelectorAll('.adn[data-message-id], .adn[data-legacy-message-id]')].filter(node => shown(node) && !node.closest('.a3s'));
    const expanded = cards.map(card => ({ card, bodies: [...card.querySelectorAll('.a3s')].filter(body => shown(body)
      && body.closest('.adn[data-message-id], .adn[data-legacy-message-id]') === card && !body.closest('[contenteditable="true"]')) }))
      .filter(item => item.bodies.length);
    if (expanded.length > 1) return { status: 'multiple_messages' };
    if (expanded.length !== 1 || expanded[0].bodies.length !== 1) return { status: 'unrecognized_mail' };
    const { card, bodies: [body] } = expanded[0];
    const ids = gmailIds(card);
    if ((!ids.perm && !ids.legacy) || !gmailMessageIds(ids)) return { status: 'unrecognized_mail' };
    const outsideBody = selector => [...card.querySelectorAll(selector)].filter(node => !body.contains(node) && !node.closest('.a3s') && shown(node));
    const from = outsideBody('.gD[email]');
    const times = outsideBody('.g3');
    const account = gmailAccount(doc, main);
    if (!account) return { status: 'account_unavailable' };
    if (from.length !== 1 || times.length !== 1 || !text(body)) return { status: 'unrecognized_mail' };
    const links = [...card.querySelectorAll('.gE a[href]'), ...doc.querySelectorAll('[role="menu"] a[href]')]
      .filter(link => shown(link) && !link.closest('.a3s') && (link.hasAttribute('download') || /download.*(?:message|original)|show original|下载邮件|下載郵件|显示原始邮件|顯示原始郵件/i.test(text(link))));
    const data = { subject: text(titles[0]), from: from[0].getAttribute('email').trim(),
      sentTime: times[0].getAttribute('title') || text(times[0]), body: bodyText(body) };
    const messageIds = gmailMessageIds(ids);
    const clipped = [...card.querySelectorAll('a[href]')].some(link => {
      if (!shown(link)) return false;
      try {
        const url = new URL(link.href, doc.location.href);
        if (url.origin !== route.url.origin || url.pathname.replace(/\/$/, '') + '/' !== route.path || url.searchParams.get('view') !== 'lg') return false;
        const perm = url.searchParams.get('permmsgid'), legacy = url.searchParams.get('th');
        return Boolean((perm && perm === ids.perm) || (legacy && messageIds.has(legacy.toLowerCase())));
      } catch { return false; }
    });
    const ctx = { doc, body, title: titles[0], data, ids, account, links, clipped };
    ctx.fingerprint = JSON.stringify([route.url.href, account, ids, data, clipped]);
    return { ctx };
  }
  function rememberGmail(ctx, result) {
    const target = ctx.doc.defaultView.crypto.randomUUID();
    gmailTarget = { doc: ctx.doc, target, fingerprint: ctx.fingerprint, body: ctx.body, title: ctx.title };
    return { ...result, target };
  }
  function validateGmail(doc, target, consume = true) {
    if (!gmailTarget || gmailTarget.doc !== doc || gmailTarget.target !== target) return { status: 'changed' };
    const snapshot = gmailTarget;
    if (consume) gmailTarget = null; // Acceptance consumes the one-use binding.
    const current = inspectGmail(doc).ctx;
    return { status: current && current.body === snapshot.body && current.title === snapshot.title
      && current.fingerprint === snapshot.fingerprint ? 'current' : 'changed' };
  }
  function discardGmail(doc, target) {
    if (gmailTarget?.doc === doc && gmailTarget.target === target) gmailTarget = null;
    return { status: 'discarded' };
  }
  function opened(doc, name) {
    if (name === 'gmail') return inspectGmail(doc).ctx || null;
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
    if (name === 'gmail') {
      const urls = ctx.links.map(link => gmailRawUrl(link, ctx)).filter(Boolean);
      const ids = gmailMessageIds(ctx.ids), route = gmailRoute(ctx.doc);
      if (route && ids?.size === 1) {
        // Native Gmail's verified whole-message download route. It needs only
        // this card's message ID/account path, never a Cookie or hidden token.
        const url = new URL(route.path, route.url.origin);
        url.search = new URLSearchParams({ view: 'att', th: [...ids][0], attid: '0', disp: 'comp', safe: '1', zw: '' }).toString();
        urls.push(url.href);
      }
      return [...new Set(urls)];
    }
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
    // An HTML fragment may display real RFC headers inside <pre>/<textarea>.
    // Keep the original bytes; never mistake that display wrapper for MIME.
    return !/^\s*</.test(start)
      && /^(?:From|Subject|Date):[^\r\n]+/im.test(headers)
      && (headers.match(/^(?:From|To|Subject|Date|Message-ID|MIME-Version|Content-Type):/gim) || []).length >= 2;
  }
  async function qqModernOriginal(doc, request) {
    const unique = selector => {
      const nodes = [...doc.querySelectorAll(selector)].filter(shown);
      return nodes.length === 1 ? nodes[0] : null;
    };
    const subject = unique('.mail-detail-subject'), basic = unique('.mail-detail-basic'), body = unique('.mail-detail-content');
    if (!subject || !basic || !body) return {};
    const pane = body.closest('.mail-list-page-reader-body') || body;
    const ids = [pane, subject, basic, body].map(node => [node.getAttribute('data-mailid'), node.getAttribute('mailid')]);
    const stamp = JSON.stringify([doc.location.href, ids, subject.textContent, basic.textContent, body.textContent]);
    try {
      const result = await request({ type: 'WEBMAIL_QQ_EXPORT', stamp });
      if (result?.status === 'changed') return { changed: true };
      if (result?.status !== 'ok' || typeof result.mailId !== 'string' || !result.mailId || result.mailId.length > 512) return {};
      const current = new URL(doc.location.href);
      if (current.protocol !== 'https:' || current.hostname !== 'wx.mail.qq.com' || current.pathname !== '/home/index'
          || !current.searchParams.get('sid')) return {};
      const url = new URL('/read/readmail', current.origin);
      url.searchParams.set('func', '3');
      url.searchParams.set('mailid', result.mailId);
      url.searchParams.set('sid', current.searchParams.get('sid'));
      return { url: url.href };
    } catch { return {}; }
  }
  async function capture(doc, fetcher = root.fetch.bind(root), requestQQ = message => root.chrome.runtime.sendMessage(message)) {
    const name = provider(doc.location.href);
    if (!name) return { status: 'unsupported' };
    if (name === 'gmail') gmailTarget = null;
    const inspection = name === 'gmail' ? inspectGmail(doc) : null;
    if (inspection?.status) return { status: inspection.status };
    const ctx = inspection?.ctx || opened(doc, name);
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
    if (name === 'gmail' && candidates.length) {
      const fits = new TextEncoder().encode(ctx.data.body).length <= MAX_EXCERPT && ctx.data.subject.length <= 500
        && ctx.data.from.length <= 500 && ctx.data.sentTime.length <= 200;
      const fallback = ctx.originalPage ? 'original_unavailable' : ctx.clipped ? 'message_clipped' : fits ? 'excerpt_offer' : 'too_large';
      return rememberGmail(ctx, { status: 'gmail_source', originals: candidates.slice(0, 3), subject: ctx.data.subject,
        fallback, excerpt: fallback === 'excerpt_offer' ? ctx.data : undefined });
    }
    const current = new URL(doc.location.href);
    if (name === 'qq' && current.hostname === 'wx.mail.qq.com' && current.pathname === '/home/index') {
      const modern = await qqModernOriginal(doc, requestQQ);
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
        const result = { status: 'original', kind: 'eml', bytesBase64: base64(bytes), subject: ctx.data.subject };
        return name === 'gmail' ? rememberGmail(ctx, result) : result;
      } catch (error) {
        if (error.message === 'too_large') reason = 'too_large';
      } finally { clearTimeout(timer); controller.abort(); }
    }
    if (!unchanged()) return { status: 'changed' };
    if (ctx.originalPage) return { status: 'original_unavailable' };
    if (ctx.clipped) return { status: 'message_clipped' };
    if (new TextEncoder().encode(ctx.data.body).length > MAX_EXCERPT || ctx.data.subject.length > 500
        || ctx.data.from.length > 500 || ctx.data.sentTime.length > 200) return { status: 'too_large' };
    // This is a proposal only. The user must explicitly accept saving an excerpt in the side panel.
    const result = { status: 'excerpt_offer', reason, excerpt: ctx.data };
    return name === 'gmail' ? rememberGmail(ctx, result) : result;
  }
  const api = { provider, capture, opened, rawCandidates, looksLikeMail, readBounded, base64, validateGmail, discardGmail, MAX_BYTES };
  root.ResumeProWebmail = api;
  try {
    if (typeof module === 'object' && module && typeof module.exports === 'object') module.exports = api;
  } catch { /* A page element or cross-origin frame may be named module (#275). */ }
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && root.window === root && root.top === root && provider(root.location?.href)) {
    if (provider(root.location.href) === 'gmail') {
      root.addEventListener?.('pagehide', () => { gmailTarget = null; });
      root.addEventListener?.('hashchange', () => { gmailTarget = null; });
    }
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (!['WEBMAIL_CAPTURE', 'WEBMAIL_VALIDATE', 'WEBMAIL_DISCARD', 'WEBMAIL_CHECK'].includes(message?.type)) return false;
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('') + 'sidepanel.html') {
        reply({ status: 'forbidden' }); return false;
      }
      if (message.type === 'WEBMAIL_DISCARD') {
        reply(discardGmail(document, message.target)); return false;
      }
      if (message.type === 'WEBMAIL_CHECK') {
        reply(validateGmail(document, message.target, false)); return false;
      }
      if (message.type === 'WEBMAIL_VALIDATE') {
        reply(validateGmail(document, message.target)); return false;
      }
      capture(document).then(reply, () => reply({ status: 'unavailable' }));
      return true;
    });
  }
})(typeof self === 'object' ? self : globalThis);
