import '../feedback-core.js';

export const ENDPOINT = 'https://app-feedback-relay.nebula-lab.workers.dev/feedback';
export const STORAGE_KEY = 'feedbackStateV1';
// The explanation the user agreed to. Raise it when automatic reports start carrying something
// the notice does not describe: earlier grants then count as undecided and the user is asked again.
// 2 (#301): install type, how a fill was started and whether the page had focus, the AI tier,
// whether an unfilled select's popup opened and had any option, and a report when the AI request fails;
// #299 adds how long the AI service took to start answering and where a timeout stopped, before any
// release carried version 2, so it stays 2.
export const CONSENT_VERSION = 2;
// chrome.management.getSelf().installType; getSelf needs no "management" permission.
const INSTALL_TYPES = ['normal', 'development', 'sideload', 'admin', 'other'];
const HOUR = 3600000;
const DAY = 24 * HOUR;
// Per installation, per rolling hour. Code errors can repeat in a loop, so they stay tight. Fill
// reports are already once a day per site and type; their cap only matters when someone fills many
// different sites in one sitting, and it should not cut those off after five.
const ERRORS_PER_HOUR = 5;
const FILLS_PER_HOUR = 20;
const core = globalThis.ResumeProFeedback;
const empty = () => ({ consent: null, consentVersion: 0, anonymousId: null, recent: {}, hourly: [], fillHourly: [], backoff: 0, manualAt: 0 });

export function createFeedback({ storage, fetchImpl = fetch, now = Date.now, uuid = () => crypto.randomUUID(), version, os, install = () => '', timeoutMs = 5000 }) {
  let serial = Promise.resolve();
  let stopped = false;
  // Counts the user's choices. A report that arrived before the latest one belongs to the earlier choice
  // and is dropped, also while it still waits for the install type below (#301): never sent after agreeing.
  let choices = 0;
  const active = new Set();
  // How the browser installed the extension (store, unpacked, policy...), looked up once. Unknown,
  // failed or slow lookups leave it out; reports never wait on it for more than a second.
  let installType = '';
  let installTimer;
  const installKnown = Promise.race([
    Promise.resolve().then(install),
    new Promise(resolve => { installTimer = setTimeout(resolve, 1000, ''); })
  ]).then(value => { if (INSTALL_TYPES.includes(value)) installType = value; }, () => {})
    .finally(() => clearTimeout(installTimer));
  const locked = fn => { const next = serial.then(fn); serial = next.catch(() => {}); return next; };
  const save = state => storage.set({ [STORAGE_KEY]: state });
  const read = async () => {
    const { noticeSeen, ...stored } = (await storage.get(STORAGE_KEY))[STORAGE_KEY] || {};
    const state = { ...empty(), ...stored };
    if (state.consent !== true && state.consent !== false) state.consent = null;
    // Nothing is sent until the user agrees. Builds before #247 wrote consent: true by default and
    // their 「知道了」 only folded the notice, so a grant without the current version is no grant.
    // An opt-out is kept whatever wrote it.
    if (state.consent === true && state.consentVersion !== CONSENT_VERSION) {
      // A grant under an older notice (not a pre-#247 default): the choice says the notice changed.
      Object.assign(state, { consent: null, consentVersion: 0, anonymousId: null, renewed: state.consentVersion >= 1 && state.consentVersion < CONSENT_VERSION });
      await save(state).catch(() => {}); // Undecided in memory either way; the next choice rewrites it.
    }
    if (state.consent !== true) state.anonymousId = null;
    for (const key of ['hourly', 'fillHourly']) if (!Array.isArray(state[key])) state[key] = [];
    return state;
  };
  const view = state => ({ consent: state.consent === true, decided: state.consent !== null,
    ...(state.consent === null && state.renewed === true ? { renewed: true } : {}) });
  function build(input, host, id) {
    const kind = ['fill_failed', 'fill_partial', 'manual'].includes(input.kind) ? input.kind : 'exception';
    const errorType = kind === 'exception' ? (['Error','TypeError','ReferenceError','SyntaxError','RangeError','URIError','EvalError','AggregateError'].includes(input.name) ? input.name : 'Error') : kind;
    const stack = kind === 'exception' ? String(input.stack || '').split('\n').filter(line => /^(?:[a-z][a-z0-9-]*\.js|link\/(?:[a-z][a-z0-9-]*\/)*[a-z][a-z0-9-]*\.mjs):\d{1,6}:\d{1,6}$/.test(line)).slice(0, 20).join('\n') : '';
    // Only manual feedback, which the user previews, may carry the job flow's [岗位] (#301).
    const details = core.diagnostics(input.diagnostics, { manual: kind === 'manual' });
    const description = kind === 'manual' ? core.redact(input.description, 1400) : kind === 'exception' ? `${errorType}: ${input.source === 'unhandledrejection' ? '未处理的 Promise 拒绝' : '未处理的代码异常'}` : '';
    // Diagnostics block v1. Only the worker writes [来源]; core.diagnostics() drops it from page input.
    const source = ['[来源]', `app_version: ${version}`, `os: ${os}`, ...(installType ? [`install: ${installType}`] : []),
      ...(host ? [`host: ${host}`] : [])].join('\n');
    return { app: 'resume-form-assistant-plugin', app_version: version, os, error_type: errorType,
      error_stack: stack, user_description: `${description}${description ? '\n' : ''}--- 诊断信息 v1 ---\n${source}${details ? `\n\n${details}` : ''}`.slice(0, 5000),
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
    // Settles once the install type is known (or left out); preview() reads it as it stands.
    ready: () => installKnown,
    status: () => locked(async () => view(await read())),
    setConsent(enabled) {
      choices += 1;
      stopped = enabled !== true;
      if (stopped) for (const controller of active) controller.abort();
      return locked(async () => {
        const state = await read(); state.consent = enabled === true;
        state.consentVersion = enabled === true ? CONSENT_VERSION : 0; delete state.renewed;
        state.anonymousId = enabled === true ? state.anonymousId || uuid() : null;
        await save(state); return view(state);
      });
    },
    preview(input, host = '') { return build({ ...input, kind: 'manual' }, host, uuid()); },
    async automatic(input, host = '') {
      // Manual feedback goes through its own preview; nothing sent automatically is one (#301 [岗位]).
      if (input?.kind === 'manual') return { ok: false, reason: 'suppressed' };
      const choice = choices;
      await installKnown;
      const prepared = await locked(async () => {
        const state = await read(); const time = now();
        if (state.consent !== true || stopped || choice !== choices || time < state.backoff) return null;
        const body = build(input, host, state.anonymousId || uuid());
        // A failed AI request (timeout or service error, #301 U1) with no field left unfilled has its own
        // daily slot per site, so it never holds back that day's report of fields the site did not take.
        // One that also lists unfilled fields is such a report and takes the usual slot.
        const aiFailed = /^error_category: (?:timeout|service_error)$/m.test(body.user_description)
          && !/^\[未填字段\]$/m.test(body.user_description);
        const signature = input.kind?.startsWith('fill_') ? `${body.error_type}|${host}${aiFailed ? '|ai' : ''}` : `${body.error_type}|${body.user_description.split('\n')[0]}|${body.error_stack.split('\n')[0]}`;
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature)))].map(x => x.toString(16).padStart(2, '0')).join('');
        state.hourly = state.hourly.filter(t => time - t < HOUR);
        state.fillHourly = state.fillHourly.filter(t => time - t < HOUR);
        state.recent = Object.fromEntries(Object.entries(state.recent).filter(([, t]) => time - t < DAY));
        const slots = body.error_type.startsWith('fill_') ? 'fillHourly' : 'hourly';
        const [sent, limit] = [state[slots], slots === 'fillHourly' ? FILLS_PER_HOUR : ERRORS_PER_HOUR];
        if (sent.length >= limit || state.recent[hash] !== undefined) return null;
        state.anonymousId = body.anonymous_id; sent.push(time); state.recent[hash] = time;
        await save(state); return { body, hash, time, slots };
      });
      if (!prepared) return { ok: false, reason: 'suppressed' };
      if (choice === choices) return transmit(prepared.body, true);
      // Turned off and on again while the report was being written down: it still belongs to the earlier
      // choice. It was never sent, so it gives back its daily and hourly slots.
      await locked(async () => {
        const state = await read();
        if (state.recent[prepared.hash] === prepared.time) delete state.recent[prepared.hash];
        const at = state[prepared.slots].indexOf(prepared.time);
        if (at >= 0) state[prepared.slots].splice(at, 1);
        await save(state);
      }).catch(() => {});
      return { ok: false, reason: 'suppressed' };
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
  // Without the API (or when it fails) the [来源] section simply has no install line.
  const install = async () => (await api.management?.getSelf?.())?.installType;
  const service = createFeedback({ storage: api.storage.local, version: api.runtime.getManifest().version, os: core.os(navigator.userAgent), install });
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
      if (message.type === 'FEEDBACK_CONSENT') return service.setConsent(message.enabled === true);
      if (message.type === 'FEEDBACK_PREVIEW') {
        const input = { description: core.redact(message.description, 1400), diagnostics: core.diagnostics(message.diagnostics, { manual: true }) };
        let host = '';
        if (Number.isInteger(message.tabId)) {
          const tab = await api.tabs.get(message.tabId).catch(() => null); host = core.hostname(tab?.url);
        }
        const token = crypto.randomUUID();
        for (const [key, item] of previews) if (Date.now() - item.time > 600000 || item.owner === owner) previews.delete(key);
        if (previews.size >= 20) previews.delete(previews.keys().next().value);
        await service.ready();
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
  // Ask right away instead of waiting for the user to find the setting: after an install, or an
  // update, that leaves the choice unanswered, open the status page, which shows the choice.
  // Registered synchronously, as MV3 requires for events that wake the worker.
  api.runtime.onInstalled?.addListener(details => {
    if (details?.reason !== 'install' && details?.reason !== 'update') return;
    service.status()
      .then(view => view.decided ? null : api.tabs.create({ url: api.runtime.getURL('popup.html') }))
      .catch(() => {});
  });
  core.install(data => service.automatic(data).catch(() => {}), { origin });
  return service;
}
