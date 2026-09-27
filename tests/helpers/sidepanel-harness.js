// Shared by the side-panel tests: the real sidepanel.js running against the real content.js
// message listener, so a panel click travels the same path it does in Chrome and Edge.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

const USER_AGENTS = {
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
};

const RELIABLE_JOB = {
  company: '星河科技', title: '后端开发工程师', location: '', reliable: true,
  sourceUrl: 'https://jobs.example.com/123', dedupeUrl: 'https://jobs.example.com/123'
};
const UNRELIABLE_JOB = {
  company: '金发科技股份有限公司', title: '', location: '', reliable: false, assistReasons: ['missing_title'],
  sourceUrl: 'https://kingfa.zhiye.com/apply?job=42', dedupeUrl: 'https://kingfa.zhiye.com/apply?job=42',
  fragments: [
    { id: 1, source: 'beisen-company', role: 'company', text: '金发科技股份有限公司' },
    { id: 2, source: 'beisen-apply-title', role: 'job-title', text: '你正在投递职位：研发工程师-化工工艺研究方向' }
  ]
};

// --- The page half: content.js with just enough of a page around it. ----------------------

function loadPage({ extraction, desktop, userAgent }) {
  const listeners = [];
  const desktopCalls = [];
  const storageWrites = [];
  const ai = { sent: [], cancelled: [], answer: null };
  const document = {
    readyState: 'loading', body: { appendChild() {} },
    addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => []
  };
  const window = {
    innerWidth: 1200, innerHeight: 900, addEventListener() {}, setTimeout() { return 0; }, clearTimeout() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
  };
  window.top = window;
  let ids = 0;
  const context = {
    console, document, window,
    location: { href: 'https://jobs.example.com/123?token=secret' },
    navigator: { userAgent, clipboard: { writeText: async () => {} } },
    crypto: { randomUUID: () => `draft-${++ids}` },
    CSS: { escape: value => String(value) },
    Event: class {}, MouseEvent: class {}, FocusEvent: class {}, HTMLElement: class {}, HTMLInputElement: class {},
    HTMLSelectElement: class {}, HTMLTextAreaElement: class {}, HTMLLabelElement: class {},
    setTimeout, clearTimeout,
    chrome: {
      runtime: {
        id: 'diagjmploldedipjdenmecmjokckelkl',
        getURL: name => `chrome-extension://test/${name}`,
        onMessage: { addListener(handler) { listeners.push(handler); } },
        sendMessage: async message => {
          desktopCalls.push(message);
          if (message.type === 'DESKTOP_LIST_QUEUE') return { intents: [], outbox: [], fillRecords: [] };
          return desktop(message, desktopCalls);
        }
      },
      storage: {
        local: { get: async () => ({}), set: async values => { storageWrites.push(values); } },
        onChanged: { addListener() {} }
      }
    },
    self: {
      __RESUME_PRO_TEST__: true,
      ResumeProResumeData: require('../../resume-data.js'),
      ResumeProProfile: require('../../profile-fields.js'),
      ResumeProAIClient: {
        send: message => { ai.sent.push(message); return new Promise(resolve => { ai.answer = resolve; }); },
        cancel: async requestId => { ai.cancelled.push(requestId); return { cancelled: true }; }
      }
    }
  };
  context.globalThis = context;
  context.self.window = window;
  window.document = document;
  vm.runInNewContext(read('sidebar-state.js'), context);
  vm.runInNewContext(read('content.js'), context);
  const hooks = context.self.ResumeProHighlightTest;
  // The page controller is mounted but its overlay stays closed: the side panel does the work.
  const fillButton = { disabled: false, textContent: '一键 AI 填写' };
  hooks.setShadowRoot({ querySelector: selector => selector === '#resume-pro-ai-fill' ? fillButton : null });
  return {
    hooks, desktopCalls, storageWrites, ai, location: context.location,
    async ready(copyOverride = {}) {
      const [saveFlow, copy] = await Promise.all([import('../../link/save-flow.mjs'), import('../../link/copy.mjs')]);
      hooks.setDesktopModules({ extract: { extractJobFields: () => structuredClone(extraction) }, saveFlow, copy: { ...copy, ...copyOverride } });
    },
    deliver(message) {
      return new Promise(resolve => {
        const handled = listeners[0](message, { id: 'diagjmploldedipjdenmecmjokckelkl' }, value => resolve(JSON.parse(JSON.stringify(value ?? null))));
        if (handled === false && message.type !== 'RESUME_PANEL_STATUS') resolve(null);
      });
    }
  };
}

// --- The panel half: sidepanel.js with a small DOM. --------------------------------------

function element(id) {
  const listeners = {};
  const attributes = {};
  const node = {
    id, listeners, attributes, dataset: {},
    hidden: (id.startsWith('job-save-') && id !== 'job-save-button')
      || (id.startsWith('submit-confirm-') && id !== 'submit-confirm-button'),
    disabled: false, value: '', textContent: '', className: '', title: '', focused: false,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, listener) { listeners[type] = listener; },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return name in attributes ? attributes[name] : null; },
    removeAttribute(name) { delete attributes[name]; },
    focus() { node.focused = true; },
    querySelector() { return { textContent: '' }; },
    querySelectorAll() { return node.children || []; }
  };
  let html = '';
  Object.defineProperty(node, 'innerHTML', {
    get: () => html,
    set(value) {
      html = String(value);
      // Enough of a parser for the candidate buttons the panel renders.
      node.children = [...html.matchAll(/data-application-id="([^"]*)"[^>]*>([^<]*)</g)].map(([, applicationId, text]) => ({
        dataset: { applicationId }, textContent: text, disabled: false,
        closest(selector) { return selector === '[data-application-id]' ? this : null; }
      }));
    }
  });
  return node;
}

async function openPanel({ extraction = RELIABLE_JOB, desktop = () => ({ status: 'saved' }), browser = 'chrome', copyOverride } = {}) {
  const page = loadPage({ extraction, desktop, userAgent: USER_AGENTS[browser] });
  await page.ready(copyOverride);
  let activeTabId = 7;
  // Tab 7 is the page under test; further tabs (each its own page controller) are added by tests.
  const pages = new Map([[7, page]]);
  let statusGate = null;
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  const toasts = [];
  const pageMessages = [];
  let poll;
  const html = read('sidepanel.html');
  const document = {
    hidden: false,
    getElementById: get,
    querySelectorAll: selector => {
      if (selector === '[data-advanced]') {
        return [...html.matchAll(/data-advanced="([^"]+)"/g)].map(([, action]) => Object.assign(element(`advanced-${action}`), { dataset: { advanced: action } }));
      }
      return [];
    },
    querySelector: () => ({ click() {}, open: false }),
    addEventListener() {},
    createElement: () => element('scratch'),
    body: { appendChild() {} }
  };
  const chrome = {
    runtime: {
      id: 'diagjmploldedipjdenmecmjokckelkl',
      sendMessage: async message => message.type === 'DESKTOP_RESUME_READ'
        ? { status: 'ok', data: { templates: [], activeTemplate: null, profile: { values: {}, family: [], custom: [] }, profileRevision: 0 } }
        : { status: 'ok' },
      openOptionsPage() {}
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    tabs: {
      query: async () => [{ id: activeTabId }],
      // A tab that is not in `pages` is a page without the helper.
      sendMessage: async (tabId, message) => {
        const target = pages.get(tabId);
        if (!target) throw new Error('no receiver');
        pageMessages.push(message);
        const answer = target.deliver(message);
        if (message.type === 'RESUME_PANEL_STATUS' && statusGate && statusGate.tab === tabId) {
          // The page has already answered; the answer just takes its time to arrive.
          const gate = statusGate;
          statusGate = null;
          const value = await answer;
          await gate.opened;
          return value;
        }
        return answer;
      },
      create: async () => {},
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} }
    }
  };
  const context = vm.createContext({
    document, chrome,
    navigator: { userAgent: USER_AGENTS[browser], clipboard: { writeText: async () => {} } },
    self: {
      ResumeProProfile: require('../../profile-fields.js'),
      ResumeProResumeData: require('../../resume-data.js'),
      ResumeProCompose: require('../../sidepanel-compose.js')
    },
    setTimeout: () => 1, clearTimeout() {}, setInterval: listener => { poll = listener; }
  });
  vm.runInContext(read('sidepanel.js'), context);
  await settle();
  const panel = {
    page, get, pageMessages, toasts,
    button: get('job-save-button'),
    form: get('job-save-form'),
    company: get('job-save-company'),
    title: get('job-save-title'),
    location: get('job-save-location'),
    url: get('job-save-url'),
    async click(id) { await get(id).listeners.click({ target: get(id) }); await settle(); },
    async submit() { await get('job-save-form').listeners.submit({ preventDefault() {} }); await settle(); },
    async poll() { await poll(); await settle(); },
    setTab(id) { activeTabId = id; },
    async addPage(tabId, options = {}) {
      const other = loadPage({ extraction: RELIABLE_JOB, desktop: () => ({ status: 'saved' }), userAgent: USER_AGENTS[browser], ...options });
      await other.ready();
      pages.set(tabId, other);
      return other;
    },
    // The next status answer from `tabId` is delayed until the returned function is called.
    holdNextStatus(tabId) {
      let open;
      statusGate = { tab: tabId, opened: new Promise(resolve => { open = resolve; }) };
      return open;
    },
    saves: () => page.desktopCalls.filter(message => message.type === 'DESKTOP_SAVE_JOB'),
    candidateQueries: () => page.desktopCalls.filter(message => message.type === 'DESKTOP_CANDIDATES_FOR'),
    confirms: () => page.desktopCalls.filter(message => message.type === 'DESKTOP_CONFIRM_SUBMIT'),
    toast: () => get('panel-toast').textContent
  };
  return panel;
}

module.exports = { read, tick, settle, USER_AGENTS, RELIABLE_JOB, UNRELIABLE_JOB, loadPage, element, openPanel };
