/* #357: Google redirects raw mail to its attachment host. Fetch only in the
 * packaged child page, whose connect-src fences every redirect before network
 * access. No Cookie API, persistent queue, URL logging or rendered mail HTML. */
(function (root) {
  const MAIL_HOSTS = new Set(['mail.google.com', 'mail.googlemail.com']);
  const REQUEST_KEYS = new Set(['ui', 'ik', 'view', 'th', 'permmsgid', 'authuser', 'attid', 'disp', 'safe', 'zw', 'd']);
  const ATTACHMENT_KEYS = new Set(['view', 'th', 'attid', 'disp', 'safe', 'zw', 'saddbat']);
  function parameters(url, allowed) {
    const found = new Set();
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || found.has(key)) return false;
      found.add(key);
    }
    return true;
  }
  function requestContext(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    const path = /^\/mail\/u\/(\d{1,3})\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || !MAIL_HOSTS.has(url.hostname) || url.port || url.username || url.password || !path || !parameters(url, REQUEST_KEYS)) return null;
    const user = url.searchParams.get('authuser');
    if (user && user !== path[1]) return null;
    const view = url.searchParams.get('view');
    if (view !== 'att' || url.searchParams.get('attid') !== '0' || url.searchParams.get('disp') !== 'comp') return null;
    const th = url.searchParams.get('th'), perm = url.searchParams.get('permmsgid');
    if ((!th && !perm) || (th && !/^[a-f0-9]{12,32}$/i.test(th)) || (perm && !/^msg-[af]:[\w-]{1,128}$/.test(perm))) return null;
    const ids = new Set(th ? [th.toLowerCase()] : []);
    if (perm && /^msg-f:\d+$/.test(perm)) {
      const legacy = BigInt(perm.slice(6)).toString(16);
      if (th && legacy !== th.toLowerCase()) return null;
      ids.add(legacy);
    }
    url.pathname = `/mail/u/${path[1]}/`;
    return { url: url.href, account: path[1], ids, perm };
  }
  function finalMatches(value, expected) {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
    if (MAIL_HOSTS.has(url.hostname)) {
      const actual = requestContext(url.href);
      return Boolean(actual && actual.account === expected.account
        && [...actual.ids].every(id => expected.ids.has(id))
        && (!actual.perm || !expected.perm || actual.perm === expected.perm)
        && (actual.ids.size > 0 || (actual.perm && actual.perm === expected.perm)));
    }
    return url.hostname === 'mail-attachment.googleusercontent.com'
      && url.pathname === `/attachment/u/${expected.account}/` && parameters(url, ATTACHMENT_KEYS)
      && url.searchParams.get('view') === 'att' && url.searchParams.get('attid') === '0'
      && url.searchParams.get('disp') === 'comp' && expected.ids.has((url.searchParams.get('th') || '').toLowerCase());
  }
  async function fetchOriginal(value, fetcher = root.fetch.bind(root), helpers = root.ResumeProWebmail, timeout = 20000) {
    const expected = requestContext(value);
    if (!expected || !helpers) return { status: 'unavailable' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const abort = () => controller.abort();
    root.addEventListener?.('pagehide', abort, { once: true });
    try {
      const response = await fetcher(expected.url, { credentials: 'include', redirect: 'follow', cache: 'no-store', signal: controller.signal });
      // Check the final resource before reading its body. The child page's CSP
      // restricts network redirects; this additionally binds the actual mail.
      if (!response.ok || !finalMatches(response.url, expected)) return { status: 'unavailable' };
      const bytes = await helpers.readBounded(response);
      if (!helpers.looksLikeMail(bytes)) return { status: 'unavailable' };
      return { status: 'original', kind: 'eml', bytesBase64: helpers.base64(bytes) };
    } catch (error) {
      return { status: error?.message === 'too_large' ? 'too_large' : 'unavailable' };
    } finally {
      clearTimeout(timer); controller.abort(); root.removeEventListener?.('pagehide', abort);
    }
  }
  async function resolveSource(source, downloadOriginal, validate) {
    if (!await validate(false)) return { status: 'changed' };
    let original = null, reason = 'raw_unavailable';
    for (const url of (source.originals || []).slice(0, 3)) {
      const result = await downloadOriginal(url);
      if (result.status === 'original') { original = result; break; }
      if (result.status === 'too_large') { reason = 'too_large'; break; }
    }
    if (!await validate(false)) return { status: 'changed' };
    if (original) return { ...original, target: source.target };
    if (source.fallback !== 'excerpt_offer') await validate(true);
    return { status: source.fallback, excerpt: source.excerpt, target: source.target, reason };
  }
  function download(value, env = root) {
    if (!requestContext(value)) return Promise.resolve({ status: 'unavailable' });
    return new Promise(resolve => {
      const frame = env.document.createElement('iframe');
      frame.hidden = true;
      frame.src = env.chrome.runtime.getURL('gmail-download.html');
      const id = env.crypto.randomUUID(), origin = env.location.origin;
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true; clearTimeout(timer); env.removeEventListener('message', receive); frame.remove(); resolve(result);
      };
      const receive = event => {
        if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.type !== 'GMAIL_DOWNLOAD_RESULT' || event.data.id !== id) return;
        const data = event.data;
        if (data.status === 'original' && typeof data.bytesBase64 === 'string' && data.bytesBase64.length > 0
            && data.bytesBase64.length <= Math.ceil(25 * 1024 * 1024 / 3) * 4) {
          finish({ status: 'original', kind: 'eml', bytesBase64: data.bytesBase64 });
        } else finish({ status: data.status === 'too_large' ? 'too_large' : 'unavailable' });
      };
      const timer = setTimeout(() => finish({ status: 'unavailable' }), 25000);
      env.addEventListener('message', receive);
      frame.onload = () => frame.contentWindow?.postMessage({ type: 'GMAIL_DOWNLOAD_START', id, url: value }, origin);
      frame.onerror = () => finish({ status: 'unavailable' });
      try { env.document.body.appendChild(frame); } catch { finish({ status: 'unavailable' }); }
    });
  }
  if (root.window === root && root.location?.protocol === 'chrome-extension:') {
    if (root.location.pathname === '/gmail-download.html' && root.parent !== root) {
      let used = false;
      root.addEventListener('message', async event => {
        if (used || event.source !== root.parent || event.origin !== root.location.origin || event.data?.type !== 'GMAIL_DOWNLOAD_START'
            || typeof event.data.id !== 'string' || event.data.id.length > 100) return;
        used = true;
        const id = event.data.id;
        const result = await fetchOriginal(event.data.url);
        root.parent.postMessage({ type: 'GMAIL_DOWNLOAD_RESULT', id, ...result }, root.location.origin);
      });
    } else root.ResumeProGmailDownload = { download, resolveSource: (source, validate) => resolveSource(source, download, validate) };
  }
  try { if (typeof module === 'object' && module && typeof module.exports === 'object') module.exports = { requestContext, finalMatches, fetchOriginal, resolveSource, download }; } catch {}
})(typeof self === 'object' ? self : globalThis);
