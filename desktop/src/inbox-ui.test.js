import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountInbox } from './inbox-ui.js';

/** 与 applications-ui.test.js 同一套假 DOM：只有 id 查询、innerHTML 与监听器。 */
function harness(handler, options = {}) {
  const nodes = new Map();
  const calls = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  class Node {
    constructor(id) {
      this.id = id;
      this.value = '';
      this.innerHTML = '';
      this.dataset = {};
      this.textContent = '';
      this.listeners = {};
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    emit(type, event = {}) {
      return this.listeners[type]?.({ preventDefault() {}, ...event });
    }
    querySelectorAll(selector) {
      const attribute = selector.includes('data-evidence') ? 'data-evidence' : 'data-act';
      const pattern = new RegExp(`${attribute}="([^"]+)"`, 'g');
      return [...this.innerHTML.matchAll(pattern)].map((match) => {
        const node = new Node(match[1]);
        node.dataset =
          attribute === 'data-evidence' ? { evidence: match[1] } : { act: match[1] };
        buttons.set(`${attribute}:${match[1]}`, node);
        return node;
      });
    }
  }

  const buttons = new Map();
  function el(id) {
    if (!nodes.has(id)) nodes.set(id, new Node(id));
    return nodes.get(id);
  }
  globalThis.document = { getElementById: el, addEventListener() {} };

  const invoke = async (name, args) => {
    calls.push({ name, args });
    const custom = handler?.(name, args);
    if (custom !== undefined) return custom;
    if (name === 'list_inbox_cmd') return [];
    if (name === 'list_applications_cmd') return { total: 0, items: [] };
    return {};
  };

  const api = mountInbox(invoke, options);
  return { el, buttons, calls, api, tick };
}

const MAIL = {
  id: 'e1',
  applicationId: null,
  kind: 'eml',
  mime: 'message/rfc822',
  sizeBytes: 2048,
  originalFilename: '面试邀请.eml',
  importedAt: '2026-09-12T09:00:00.000Z',
  subject: '面试邀请',
  fromAddr: 'hr@example.test',
  sentAt: '2026-09-12T08:00:00.000Z',
  replyClass: null,
  sendMode: null,
  sameBytesAs: [],
};

test('an empty inbox explains itself without claiming nobody replied', async () => {
  const h = harness();
  await h.api.refresh();
  assert.match(h.el('inbox-list').innerHTML, /没有待处理的证据/);
  assert.doesNotMatch(h.el('inbox-list').innerHTML, /未回复|没有回复/);
});

test('dropped files are imported by path and the result is reported', async () => {
  let dropped = null;
  const h = harness(
    (name) => {
      if (name === 'import_evidence_cmd') {
        return { imported: [MAIL], duplicates: [], failed: [{ name: 'invite.msg', code: 'unsupported' }] };
      }
      if (name === 'list_inbox_cmd') return [MAIL];
      return undefined;
    },
    { listenDrop: (fn) => { dropped = fn; } },
  );

  await dropped(['C:/Users/me/面试邀请.eml', 'C:/Users/me/invite.msg']);
  await h.tick();

  const call = h.calls.find((entry) => entry.name === 'import_evidence_cmd');
  assert.deepEqual(call.args.args.paths, ['C:/Users/me/面试邀请.eml', 'C:/Users/me/invite.msg']);
  assert.match(h.el('inbox-status').textContent, /已导入 1 条，待分类/);
  assert.match(h.el('inbox-status').textContent, /invite\.msg/);
  assert.match(h.el('inbox-list').innerHTML, /面试邀请/);
});

test('a mail body is shown escaped, and nothing remote can be referenced', async () => {
  const h = harness((name) => {
    if (name === 'list_inbox_cmd') return [MAIL];
    if (name === 'get_evidence_preview_cmd') {
      return {
        ...MAIL,
        bodyExtract: '请点击 <img src=x onerror=alert(1)> 这里 <https://tracker.example.test/x>',
        imageDataUrl: null,
        note: null,
      };
    }
    return undefined;
  });
  await h.api.refresh();
  h.buttons.get('data-evidence:e1').emit('click');
  await h.tick();

  const html = h.el('inbox-preview').innerHTML;
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /src="http/);
  assert.match(html, /hr@example\.test/);
});

test('a screenshot is shown from a data URL, a PDF offers the system viewer instead', async () => {
  const shot = { ...MAIL, id: 'e2', kind: 'screenshot', subject: null, originalFilename: 'shot.png' };
  const h = harness((name, args) => {
    if (name === 'list_inbox_cmd') return [shot];
    if (name === 'get_evidence_preview_cmd' && args.evidenceId === 'e2') {
      return { ...shot, bodyExtract: null, imageDataUrl: 'data:image/png;base64,AAAA', note: null };
    }
    return undefined;
  });
  await h.api.refresh();
  h.buttons.get('data-evidence:e2').emit('click');
  await h.tick();
  assert.match(h.el('inbox-preview').innerHTML, /src="data:image\/png;base64,AAAA"/);

  const pdf = { ...MAIL, id: 'e3', kind: 'pdf', subject: null, originalFilename: 'offer.pdf' };
  const g = harness((name, args) => {
    if (name === 'list_inbox_cmd') return [pdf];
    if (name === 'get_evidence_preview_cmd' && args.evidenceId === 'e3') {
      return { ...pdf, bodyExtract: null, imageDataUrl: null, note: 'PDF 不在应用内渲染。' };
    }
    return undefined;
  });
  await g.api.refresh();
  g.buttons.get('data-evidence:e3').emit('click');
  await g.tick();
  assert.match(g.el('inbox-preview').innerHTML, /PDF 不在应用内渲染/);
  await g.buttons.get('data-act:open').emit('click');
  await g.tick();
  assert.ok(g.calls.some((call) => call.name === 'open_evidence_cmd'));
});

test('two applications at the same company are both offered and neither is preselected', async () => {
  const h = harness((name) => {
    if (name === 'list_inbox_cmd') return [MAIL];
    if (name === 'get_evidence_preview_cmd') return { ...MAIL, bodyExtract: '正文', imageDataUrl: null, note: null };
    if (name === 'list_applications_cmd') {
      return {
        total: 2,
        items: [
          { id: 'app-1', company: '星河科技', title: '后端开发' },
          { id: 'app-2', company: '星河科技', title: '数据平台' },
        ],
      };
    }
    return undefined;
  });
  await h.api.refresh();
  h.buttons.get('data-evidence:e1').emit('click');
  await h.tick();

  const html = h.el('inbox-preview').innerHTML;
  assert.match(html, /后端开发/);
  assert.match(html, /数据平台/);
  assert.doesNotMatch(html, /<option value="app-[^"]*" selected/, '两条都不预选，必须自己点');
  assert.match(html, /不会替你猜/);

  // 没选就点关联：不发命令，只提醒。
  h.el('inbox-application').value = '';
  await h.buttons.get('data-act:associate').emit('click');
  await h.tick();
  assert.equal(h.calls.some((call) => call.name === 'associate_evidence_cmd'), false);
  assert.match(h.el('inbox-status').textContent, /请先选中一条申请/);

  h.el('inbox-application').value = 'app-2';
  await h.buttons.get('data-act:associate').emit('click');
  await h.tick();
  const call = h.calls.find((entry) => entry.name === 'associate_evidence_cmd');
  assert.deepEqual(call.args, { evidenceId: 'e1', applicationId: 'app-2' });
  assert.match(h.el('inbox-status').textContent, /已导入，待分类/);
});

test('classification sends both fields and never turns an invite into a human', async () => {
  const h = harness((name) => {
    if (name === 'list_inbox_cmd') return [MAIL];
    if (name === 'get_evidence_preview_cmd') return { ...MAIL, bodyExtract: '正文', imageDataUrl: null, note: null };
    if (name === 'classify_evidence_cmd') return { ...MAIL, replyClass: 'interview_invite', sendMode: 'unknown' };
    return undefined;
  });
  await h.api.refresh();
  h.buttons.get('data-evidence:e1').emit('click');
  await h.tick();

  h.el('inbox-reply-class').value = 'interview_invite';
  h.el('inbox-send-mode').value = 'unknown';
  await h.buttons.get('data-act:classify').emit('click');
  await h.tick();

  const call = h.calls.find((entry) => entry.name === 'classify_evidence_cmd');
  assert.deepEqual(call.args, { evidenceId: 'e1', replyClass: 'interview_invite', sendMode: 'unknown' });
  assert.match(h.el('inbox-status').textContent, /面试邀请/);
  assert.match(h.el('inbox-status').textContent, /未知/);
  assert.doesNotMatch(h.el('inbox-status').textContent, /人工/);
});

test('pasted text is imported as text and the box is cleared', async () => {
  const h = harness((name) => (name === 'import_evidence_cmd'
    ? { imported: [{ ...MAIL, kind: 'paste' }], duplicates: [], failed: [] }
    : undefined));
  h.el('inbox-paste').value = '他们说下周二面试。';
  await h.el('inbox-paste-save').emit('click');
  await h.tick();
  const call = h.calls.find((entry) => entry.name === 'import_evidence_cmd');
  assert.deepEqual(call.args.args, { text: '他们说下周二面试。' });
  assert.equal(h.el('inbox-paste').value, '');
});

test('a preview that answers late cannot replace the one selected after it', async () => {
  let releaseFirst;
  const h = harness((name, args) => {
    if (name === 'list_inbox_cmd') return [MAIL, { ...MAIL, id: 'e9', subject: '第二封' }];
    if (name === 'get_evidence_preview_cmd' && args.evidenceId === 'e1') {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ ...MAIL, bodyExtract: '第一封的正文', imageDataUrl: null, note: null });
      });
    }
    if (name === 'get_evidence_preview_cmd' && args.evidenceId === 'e9') {
      return { ...MAIL, id: 'e9', subject: '第二封', bodyExtract: '第二封的正文', imageDataUrl: null, note: null };
    }
    return undefined;
  });
  await h.api.refresh();
  h.buttons.get('data-evidence:e1').emit('click');
  await h.tick();
  h.buttons.get('data-evidence:e9').emit('click');
  await h.tick();
  releaseFirst();
  await h.tick();
  assert.match(h.el('inbox-preview').innerHTML, /第二封的正文/);
  assert.doesNotMatch(h.el('inbox-preview').innerHTML, /第一封的正文/);
});
