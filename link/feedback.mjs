import '../feedback-core.js';

export const ENDPOINT = 'https://app-feedback-relay.nebula-lab.workers.dev/feedback';
export const STORAGE_KEY = 'feedbackStateV1';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const core = globalThis.ResumeProFeedback;
const empty = () => ({ consent: null, noticeSeen: false, anonymousId: null, recent: {}, hourly: [], backoff: 0, manualAt: 0 });

export function createFeedback({ storage, fetchImpl = fetch, now = Date.now, uuid = () => crypto.randomUUID(), version, os, timeoutMs = 5000 }) {
  let serial = Promise.resolve();
  let stopped = false;
  const active = new Set();
  const locked = fn => { const next = serial.then(fn); serial = next.catch(() => {}); return next; };
  const save = state => storage.set({ [STORAGE_KEY]: state });
  const read = async () => {
    const stored = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
    const state = { ...empty(), ...stored };
    // Only missing/undecided preferences adopt the default. Never undo an opt-out.
    if (state.consent === null || state.consent === undefined) {
      state.consent = true; state.noticeSeen = false; state.anonymousId = uuid();
      await save(state); // A failed write must not enable automatic network traffic.
    } else if (stored?.noticeSeen === undefined) {
      state.noticeSeen = true; // An earlier explicit choice already acknowledged reporting.
    }
    return state;
  };
  const view = state => ({ consent: state.consent === true, noticeSeen: state.noticeSeen === true });
  function build(input, host, id) {
    const kind = ['fill_failed', 'fill_partial', 'manual'].includes(input.kind) ? input.kind : 'exception';
    const errorType = kind === 'exception' ? (['Error','TypeError','ReferenceError','SyntaxError','RangeError','URIError','EvalError','AggregateError'].includes(input.name) ? input.name : 'Error') : kind;
    const stack = kind === 'exception' ? String(input.stack || '').split('\n').filter(line => /^(?:[a-z][a-z0-9-]*\.js|link\/(?:[a-z][a-z0-9-]*\/)*[a-z][a-z0-9-]*\.mjs):\d{1,6}:\d{1,6}$/.test(line)).slice(0, 20).join('\n') : '';
    const details = core.diagnostics(input.diagnostics);
    const description = kind === 'manual' ? core.redact(input.description, 1400) : kind === 'exception' ? `${errorType}: ${input.source === 'unhandledrejection' ? '未处理的 Promise 拒绝' : '未处理的代码异常'}` : '';
    return { app: 'resume-form-assistant-plugin', app_version: version, os, error_type: errorType,
      error_stack: stack, user_description: `${description}${description ? '\n' : ''}--- 诊断信息 ---\n版本: ${version} / 系统: ${os}${host ? `\n网站: ${host}` : ''}${details ? `\n${details}` : ''}`.slice(0, 5000),
      anonymous_id: id, timestamp: new Date(now()).toISOString() };
  }
  async function transmit(payload, automatic) {
    const controller = new AbortController();
    if (automatic) active.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (automatic && stopped) return { ok: false, reason: 'disabled' };
      const response = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), credentials: 'omit', redirect: 'error', signal: controller.signal });
      if (response.status === 429 || response.status >= 500) await locked(async () => {
        const state = await read(); state.backoff = now() + HOUR; await save(state);
      });
      if (!response.ok) return { ok: false, reason: 'server' };
      // A bounded, credential-free response. Never render provider/relay error bodies.
      const reader = response.body?.getReader();
      if (!reader) return { ok: false, reason: 'response' };
      let bytes = 0; let text = ''; const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > 4096) { await reader.cancel(); return { ok: false, reason: 'response' }; }
        text += decoder.decode(value, { stream: true });
      }
      const result = JSON.parse(text + decoder.decode());
      return result?.ok === true && typeof result.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(result.id)
        ? { ok: true, id: result.id } : { ok: false, reason: 'response' };
    } catch { return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network' }; }
    finally { clearTimeout(timer); active.delete(controller); }
  }
  return {
    status: () => locked(async () => view(await read())),
    setConsent(enabled) {
      stopped = enabled !== true;
      if (stopped) for (const controller of active) controller.abort();
      return locked(async () => {
        const state = await read(); state.consent = enabled === true; state.noticeSeen = true;
        state.anonymousId = enabled === true ? state.anonymousId || uuid() : null;
        await save(state); return view(state);
      });
    },
    acknowledgeNotice: () => locked(async () => {
      const state = await read(); state.noticeSeen = true; await save(state); return view(state);
    }),
    preview(input, host = '') { return build({ ...input, kind: 'manual' }, host, uuid()); },
    async automatic(input, host = '') {
      const payload = await locked(async () => {
        const state = await read(); const time = now();
        if (state.consent !== true || stopped || time < state.backoff) return null;
        const body = build(input, host, state.anonymousId || uuid());
        const signature = input.kind?.startsWith('fill_') ? `${body.error_type}|${host}` : `${body.error_type}|${body.user_description.split('\n')[0]}|${body.error_stack.split('\n')[0]}`;
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature)))].map(x => x.toString(16).padStart(2, '0')).join('');
        state.hourly = state.hourly.filter(t => time - t < HOUR);
        state.recent = Object.fromEntries(Object.entries(state.recent).filter(([, t]) => time - t < DAY));
        if (state.hourly.length >= 5 || state.recent[hash] !== undefined) return null;
        state.anonymousId = body.anonymous_id; state.hourly.push(time); state.recent[hash] = time;
        await save(state); return body;
      });
      return payload ? transmit(payload, true) : { ok: false, reason: 'suppressed' };
    },
    async manual(input, host = '', previewed = null) {
      const payload = await locked(async () => {
        const state = await read(); const time = now();
        if (state.manualAt && time - state.manualAt < 60000) return null;
        state.manualAt = time; await save(state);
        return previewed || build({ ...input, kind: 'manual' }, host, uuid());
      });
      return payload ? transmit(payload, false) : { ok: false, reason: 'cooldown' };
    }
  };
}

export function installFeedback(api) {
  const origin = api.runtime.getURL('');
  const service = createFeedback({ storage: api.storage.local, version: api.runtime.getManifest().version, os: core.os(navigator.userAgent) });
  const trustedPages = new Set(['sidepanel.html', 'popup.html'].map(p => api.runtime.getURL(p)));
  // Each preview is held only in worker memory, bound to the requesting document. Sending
  // consumes it; switching tabs or editing the draft requires a new visible preview.
  const previews = new Map();
  api.runtime.onMessage.addListener((message, sender, reply) => {
    if (!message?.type?.startsWith('FEEDBACK_')) return false;
    const page = sender?.id === api.runtime.id && trustedPages.has(sender.url);
    const content = sender?.id === api.runtime.id && Boolean(core.hostname(sender.url)) && Number.isInteger(sender.tab?.id);
    const owner = `${sender?.documentId || ''}|${sender?.url || ''}`;
    const handle = async () => {
      if (message.type === 'FEEDBACK_AUTO') {
        if (!content && !(sender?.id === api.runtime.id && (trustedPages.has(sender.url) || sender.url === api.runtime.getURL('ai-host.html')))) return { ok: false };
        const data = message.report;
        if (!data || !['exception','fill_failed','fill_partial'].includes(data.kind) || (content && data.kind === 'exception' && !data.stack)) return { ok: false };
        return service.automatic(data, content ? core.hostname(sender.url) : '');
      }
      if (!page) return { ok: false, reason: 'forbidden' };
      if (message.type === 'FEEDBACK_STATUS') return service.status();
      if (message.type === 'FEEDBACK_NOTICE_SEEN') return service.acknowledgeNotice();
      if (message.type === 'FEEDBACK_CONSENT') return service.setConsent(message.enabled === true);
      if (message.type === 'FEEDBACK_PREVIEW') {
        const input = { description: core.redact(message.description, 1400), diagnostics: core.diagnostics(message.diagnostics) };
        let host = '';
        if (Number.isInteger(message.tabId)) {
          const tab = await api.tabs.get(message.tabId).catch(() => null); host = core.hostname(tab?.url);
        }
        const token = crypto.randomUUID();
        for (const [key, item] of previews) if (Date.now() - item.time > 600000 || item.owner === owner) previews.delete(key);
        if (previews.size >= 20) previews.delete(previews.keys().next().value);
        const payload = service.preview(input, host);
        previews.set(token, { payload, owner, time: Date.now() });
        return { ok: true, token, payload };
      }
      if (message.type === 'FEEDBACK_SEND') {
        const item = previews.get(message.token); previews.delete(message.token);
        if (!item || item.owner !== owner || Date.now() - item.time > 600000) return { ok: false, reason: 'preview' };
        return service.manual({}, '', item.payload);
      }
      return { ok: false };
    };
    handle().then(reply).catch(() => reply({ ok: false, reason: 'unavailable' }));
    return true;
  });
  core.install(data => service.automatic(data).catch(() => {}), { origin });
  return service;
}
