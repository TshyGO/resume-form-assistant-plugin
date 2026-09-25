// #172: "保存岗位到桌面端" lives on the native side panel's 填写 view, and the whole review
// happens there. These tests run the real sidepanel.js against the real content.js message
// listener, so the panel's clicks travel the same path they do in Chrome and Edge.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
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
      ResumeProResumeData: require('../resume-data.js'),
      ResumeProProfile: require('../profile-fields.js'),
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
    hooks, desktopCalls, storageWrites, ai,
    async ready() {
      const [saveFlow, copy] = await Promise.all([import('../link/save-flow.mjs'), import('../link/copy.mjs')]);
      hooks.setDesktopModules({ extract: { extractJobFields: () => structuredClone(extraction) }, saveFlow, copy });
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
    id, listeners, attributes, dataset: {}, hidden: id.startsWith('job-save-') && id !== 'job-save-button',
    disabled: false, value: '', textContent: '', className: '', title: '', focused: false,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, listener) { listeners[type] = listener; },
    setAttribute(name, value) { attributes[name] = String(value); },
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

async function openPanel({ extraction = RELIABLE_JOB, desktop = () => ({ status: 'saved' }), browser = 'chrome' } = {}) {
  const page = loadPage({ extraction, desktop, userAgent: USER_AGENTS[browser] });
  await page.ready();
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
      query: async () => [{ id: 7 }],
      sendMessage: async (tabId, message) => { pageMessages.push(message); return page.deliver(message); },
      create: async () => {},
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} }
    }
  };
  const context = vm.createContext({
    document, chrome,
    navigator: { userAgent: USER_AGENTS[browser], clipboard: { writeText: async () => {} } },
    self: { ResumeProProfile: require('../profile-fields.js'), ResumeProResumeData: require('../resume-data.js') },
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
    url: get('job-save-url'),
    async click(id) { await get(id).listeners.click({ target: get(id) }); await settle(); },
    async submit() { await get('job-save-form').listeners.submit({ preventDefault() {} }); await settle(); },
    async poll() { await poll(); await settle(); },
    saves: () => page.desktopCalls.filter(message => message.type === 'DESKTOP_SAVE_JOB'),
    toast: () => get('panel-toast').textContent
  };
  return panel;
}

test('the 填写 view shows the save-job button itself, not only inside the ··· menu', () => {
  const html = read('sidepanel.html');
  const fillView = html.slice(html.indexOf('id="fill-view"'), html.indexOf('id="fields-view"'));
  const menu = html.slice(html.indexOf('class="dock-tools__menu"'), html.indexOf('</details>'));
  assert.match(fillView, /<button[^>]*id="job-save-button"[^>]*>保存岗位到桌面端<\/button>/);
  assert.doesNotMatch(menu, /保存岗位到桌面端/, 'the ··· menu no longer hides the entry');
  assert.doesNotMatch(menu, /data-advanced="save"/);
  // The review form: editable company and title, a read-only URL, confirm and cancel.
  assert.match(fillView, /<input id="job-save-company"[^>]*required/);
  assert.match(fillView, /<input id="job-save-title"[^>]*required/);
  assert.match(fillView, /<input id="job-save-url"[^>]*readonly/);
  assert.match(fillView, /id="job-save-confirm" type="submit">确定保存</);
  assert.match(fillView, /id="job-save-cancel" type="button">取消</);
});

test('clicking the button shows company, title and redacted URL in the panel, and saves only on confirm', async () => {
  const panel = await openPanel();
  assert.equal(panel.button.hidden, false);
  assert.equal(panel.button.disabled, false);
  await panel.click('job-save-button');
  assert.equal(panel.form.hidden, false);
  assert.equal(panel.button.hidden, true);
  assert.equal(panel.company.value, '星河科技');
  assert.equal(panel.title.value, '后端开发工程师');
  assert.equal(panel.url.value, 'https://jobs.example.com/123', 'the URL is the redacted one, not the address bar');
  assert.equal(panel.saves().length, 0, 'nothing is written before confirming');
  assert.equal(panel.pageMessages.some(message => message.type === 'RESUME_PANEL_ADVANCED'), false, 'the old page overlay is not used');

  // The user corrects the title; a status poll meanwhile must not undo the edit.
  panel.title.value = 'Java 后端开发工程师';
  await panel.poll();
  assert.equal(panel.title.value, 'Java 后端开发工程师');
  // The URL field is read-only and is never read back: changing it does nothing.
  panel.url.value = 'https://jobs.example.com/123?token=secret';

  await panel.submit();
  assert.equal(panel.saves().length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(panel.saves()[0].fields)), {
    company: '星河科技', title: 'Java 后端开发工程师', location: '',
    sourceUrl: 'https://jobs.example.com/123', dedupeUrl: 'https://jobs.example.com/123'
  });
  assert.equal(panel.form.hidden, true);
  assert.equal(panel.get('job-save-result').hidden, false);
  assert.match(panel.get('job-save-result-text').textContent, /桌面已保存/);
  assert.equal(panel.page.storageWrites.length, 0, 'the draft never reaches extension storage');

  await panel.click('job-save-dismiss');
  assert.equal(panel.get('job-save-result').hidden, true);
  assert.equal(panel.button.hidden, false);
});

test('cancel in the panel saves nothing', async () => {
  const panel = await openPanel();
  await panel.click('job-save-button');
  await panel.click('job-save-cancel');
  assert.equal(panel.form.hidden, true);
  assert.equal(panel.button.hidden, false);
  assert.equal(panel.saves().length, 0);
  assert.equal(panel.page.desktopCalls.some(message => /^DESKTOP_(SAVE_JOB|BIND)$/.test(message.type)), false);
});

test('an empty company or title is refused in the panel with a clear prompt', async () => {
  const panel = await openPanel();
  await panel.click('job-save-button');
  panel.company.value = '   ';
  await panel.submit();
  assert.equal(panel.saves().length, 0);
  assert.equal(panel.get('job-save-error').hidden, false);
  assert.equal(panel.get('job-save-error').textContent, '请补全公司名称后再保存。');
  assert.equal(panel.company.attributes['aria-invalid'], 'true');
  assert.equal(panel.company.focused, true);
  assert.equal(panel.form.hidden, false);
});

test('a double click on confirm saves once', async () => {
  let release;
  const panel = await openPanel({ desktop: message => message.type === 'DESKTOP_SAVE_JOB'
    ? new Promise(resolve => { release = () => resolve({ status: 'saved' }); }) : {} });
  await panel.click('job-save-button');
  const submit = panel.get('job-save-form').listeners.submit;
  const first = submit({ preventDefault() {} });
  await tick();
  assert.equal(panel.get('job-save-confirm').disabled, true);
  assert.equal(panel.get('job-save-confirm').textContent, '正在保存…');
  await submit({ preventDefault() {} });
  await panel.poll();
  await submit({ preventDefault() {} });
  release();
  await first;
  await settle();
  assert.equal(panel.saves().length, 1);
});

test('AI recognition shows progress and a cancel button in the panel; a late answer is ignored', async () => {
  const panel = await openPanel({ extraction: UNRELIABLE_JOB });
  const clicking = panel.get('job-save-button').listeners.click();
  await settle();
  await panel.poll();
  assert.equal(panel.get('job-save-progress').hidden, false);
  assert.equal(panel.get('job-save-progress-text').textContent, '正在识别岗位…');
  assert.match(panel.get('job-save-progress-count').textContent, /发送 2 段页面文字/);
  assert.match(panel.get('job-save-fragments').innerHTML, /研发工程师-化工工艺研究方向/);
  assert.equal(panel.get('job-save-stop').textContent, '取消识别');
  assert.equal(panel.form.hidden, true);

  await panel.click('job-save-stop');
  assert.equal(panel.page.ai.cancelled.length, 1);
  assert.equal(panel.get('job-save-progress').hidden, true);
  assert.equal(panel.form.hidden, false, 'the user can finish by hand');
  assert.equal(panel.company.value, '金发科技股份有限公司');
  assert.equal(panel.title.value, '');

  panel.title.value = '工艺工程师';
  panel.page.ai.answer({ status: 'ok', reliable: true, fields: { company: 'wrong', title: 'wrong' } });
  await clicking;
  await panel.poll();
  assert.equal(panel.company.value, '金发科技股份有限公司', 'a late AI answer does not refill the form');
  assert.equal(panel.title.value, '工艺工程师');
  assert.equal(panel.saves().length, 0);
});

test('cancelling the whole save during recognition keeps the form closed when the AI answers late', async () => {
  const panel = await openPanel({ extraction: UNRELIABLE_JOB });
  const clicking = panel.get('job-save-button').listeners.click();
  await settle();
  await panel.poll();
  const draftId = JSON.parse(JSON.stringify(panel.page.hooks.panelJobSnapshot())).draftId;
  await panel.page.deliver({ type: 'RESUME_PANEL_SAVE_CANCEL', draftId, scope: 'draft' });
  panel.page.ai.answer({ status: 'ok', reliable: true, fields: { company: '金发科技股份有限公司', title: '研发工程师' } });
  await clicking;
  await panel.poll();
  assert.equal(panel.form.hidden, true);
  assert.equal(panel.get('job-save-progress').hidden, true);
  assert.equal(panel.button.hidden, false);
  assert.equal(panel.saves().length, 0);
});

test('an offline desktop is shown as pending sync in the panel, not as saved', async () => {
  const panel = await openPanel({ desktop: message => message.type === 'DESKTOP_SAVE_JOB'
    ? { status: 'queued', mode: 'unavailable', intent: { intentId: 'i-1' } } : {} });
  await panel.click('job-save-button');
  await panel.submit();
  const text = panel.get('job-save-result-text').textContent;
  assert.match(text, /待同步/);
  assert.doesNotMatch(text, /桌面已保存/);
  assert.equal(panel.get('job-save-result').className, 'job-card is-pending');

  const unpaired = await openPanel({ desktop: message => message.type === 'DESKTOP_SAVE_JOB'
    ? { status: 'not_queued', mode: 'not_paired', extensionId: 'diagjmploldedipjdenmecmjokckelkl' } : {} });
  await unpaired.click('job-save-button');
  await unpaired.submit();
  assert.match(unpaired.get('job-save-result-text').textContent, /这次没有保存/);
  assert.equal(unpaired.get('job-save-copy-id').hidden, false);
});

test('a possible duplicate is chosen in the panel: link the existing job or save a new one', async () => {
  const exact = [{ applicationId: 'app-1', company: '星河科技', title: '后端开发工程师', stage: '' }];
  const desktop = message => {
    if (message.type === 'DESKTOP_SAVE_JOB') return { status: 'needs_choice', intent: { intentId: 'intent-3' }, exact };
    if (message.type === 'DESKTOP_BIND') return { status: 'saved' };
    return {};
  };
  const panel = await openPanel({ desktop });
  await panel.click('job-save-button');
  await panel.submit();
  assert.equal(panel.get('job-save-choice').hidden, false);
  assert.equal(panel.form.hidden, true);
  const [row] = panel.get('job-save-candidates').children;
  assert.equal(row.textContent, '关联已有：星河科技 · 后端开发工程师');
  await panel.get('job-save-candidates').listeners.click({ target: row });
  await settle();
  const binds = panel.page.desktopCalls.filter(message => message.type === 'DESKTOP_BIND');
  assert.deepEqual(JSON.parse(JSON.stringify(binds)), [{ type: 'DESKTOP_BIND', intentId: 'intent-3', applicationId: 'app-1' }]);
  assert.equal(panel.get('job-save-choice').hidden, true);
  assert.match(panel.get('job-save-result-text').textContent, /桌面已保存/);

  const other = await openPanel({ desktop });
  await other.click('job-save-button');
  await other.submit();
  await other.click('job-save-new');
  const newBind = other.page.desktopCalls.filter(message => message.type === 'DESKTOP_BIND');
  assert.equal(newBind.length, 1);
  assert.equal(newBind[0].applicationId, null);

  const later = await openPanel({ desktop });
  await later.click('job-save-button');
  await later.submit();
  await later.click('job-save-later');
  assert.equal(later.page.desktopCalls.some(message => message.type === 'DESKTOP_BIND'), false);
  assert.match(later.get('job-save-result-text').textContent, /尚未写入桌面/);
});

test('Chrome and Edge run the same save flow and send the same messages', async () => {
  const run = async browser => {
    const panel = await openPanel({ browser });
    await panel.click('job-save-button');
    panel.title.value = 'Java 后端开发工程师';
    await panel.submit();
    return {
      page: panel.pageMessages.filter(message => message.type !== 'RESUME_PANEL_STATUS')
        .map(message => ({ ...message, draftId: message.draftId ? 'draft' : undefined })),
      desktop: JSON.parse(JSON.stringify(panel.saves())),
      result: panel.get('job-save-result-text').textContent
    };
  };
  const chrome = await run('chrome');
  const edge = await run('edge');
  assert.deepEqual(edge, chrome);
  assert.equal(chrome.desktop.length, 1);
  // Neither half branches on the browser.
  for (const file of ['sidepanel.js', 'content.js']) {
    assert.doesNotMatch(read(file), /userAgent|Edg\//, `${file} must not special-case a browser`);
  }
});

test('the panel never submits the job application page', () => {
  const panel = read('sidepanel.js');
  const saveMessages = [...panel.matchAll(/type: "(RESUME_PANEL_[A-Z_]+)"/g)].map(([, type]) => type);
  assert.ok(saveMessages.includes('RESUME_PANEL_SAVE_DRAFT'));
  assert.ok(saveMessages.includes('RESUME_PANEL_SAVE_CONFIRM'));
  assert.ok(saveMessages.includes('RESUME_PANEL_SAVE_CANCEL'));
  assert.ok(saveMessages.includes('RESUME_PANEL_SAVE_CHOICE'));
  const content = read('content.js');
  const section = content.slice(content.indexOf('// --- Saving a job from the native side panel'), content.indexOf('function setDesktopStatus('));
  assert.ok(section.length > 500);
  assert.doesNotMatch(section, /\.submit\(|requestSubmit|\.click\(\)|chrome\.storage/, 'the side panel path only reads the page and talks to the desktop');
});
