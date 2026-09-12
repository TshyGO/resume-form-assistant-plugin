import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountInbox } from './inbox-ui.ts';

/** 与 applications-ui.test.ts 同一套假 DOM：只有 id 查询、innerHTML 与监听器。 */
type InvokeHandler = (name: string, args?: Record<string, unknown>) => unknown;

class FakeNode {
  id: string;
  value = "";
  innerHTML = "";
  textContent = "";
  dataset: Record<string, string> = {};
  listeners: Record<string, (event: unknown) => unknown> = {};
  private readonly buttons: Map<string, FakeNode>;

  constructor(id: string, buttons: Map<string, FakeNode>) {
    this.id = id;
    this.buttons = buttons;
  }

  addEventListener(type: string, fn: (event: unknown) => unknown) {
    this.listeners[type] = fn;
  }

  emit(type: string, event: Record<string, unknown> = {}) {
    return this.listeners[type]?.({ preventDefault() {}, ...event });
  }

  querySelectorAll(selector: string): FakeNode[] {
    const attribute = selector.includes("data-evidence") ? "data-evidence" : "data-act";
    const pattern = new RegExp(`${attribute}="([^"]+)"`, "g");
    return [...this.innerHTML.matchAll(pattern)].map((match) => {
      const node = new FakeNode(match[1], this.buttons);
      node.dataset = attribute === "data-evidence" ? { evidence: match[1] } : { act: match[1] };
      this.buttons.set(`${attribute}:${match[1]}`, node);
      return node;
    });
  }
}

function harness(handler?: InvokeHandler, options: Parameters<typeof mountInbox>[1] = {}) {
  const nodes = new Map<string, FakeNode>();
  const buttons = new Map<string, FakeNode>();
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  function el(id: string): FakeNode {
    if (!nodes.has(id)) nodes.set(id, new FakeNode(id, buttons));
    return nodes.get(id) as FakeNode;
  }
  globalThis.document = { getElementById: el, addEventListener() {} } as unknown as Document;

  const invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ name, args });
    const custom = handler?.(name, args);
    if (custom !== undefined) return custom as T;
    if (name === "list_inbox_cmd") return [] as T;
    if (name === "list_applications_cmd") return { total: 0, items: [] } as T;
    return {} as T;
  };

  /** 渲染出来的某个按钮；不存在就直接失败，测试信息比空指针清楚。 */
  function button(key: string): FakeNode {
    const node = buttons.get(key);
    if (!node) throw new Error(`界面上没有这个按钮：${key}`);
    return node;
  }

  /** 某个命令第一次被调用时收到的参数。 */
  function callArgs(name: string): Record<string, unknown> {
    const call = calls.find((entry) => entry.name === name);
    if (!call) throw new Error(`没有调用过命令：${name}`);
    return call.args ?? {};
  }

  const api = mountInbox(invoke, options);
  return { el, buttons, button, callArgs, calls, api, tick };
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
  // 放在对象里：TS 的控制流分析看不到回调何时执行，直接用局部变量会被收窄成 never。
  const drop: { handle: ((paths: string[]) => void) | null } = { handle: null };
  const h = harness(
    (name) => {
      if (name === 'import_evidence_cmd') {
        return { imported: [MAIL], duplicates: [], failed: [{ name: 'invite.msg', code: 'unsupported' }] };
      }
      if (name === 'list_inbox_cmd') return [MAIL];
      return undefined;
    },
    { listenDrop: (fn: (paths: string[]) => void) => { drop.handle = fn; } },
  );

  drop.handle?.(['C:/Users/me/面试邀请.eml', 'C:/Users/me/invite.msg']);
  await h.tick();
  await h.tick();

  const args = h.callArgs('import_evidence_cmd').args as { paths: string[] };
  assert.deepEqual(args.paths, ['C:/Users/me/面试邀请.eml', 'C:/Users/me/invite.msg']);
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
  h.button('data-evidence:e1').emit('click');
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
    if (name === 'get_evidence_preview_cmd' && args?.evidenceId === 'e2') {
      return { ...shot, bodyExtract: null, imageDataUrl: 'data:image/png;base64,AAAA', note: null };
    }
    return undefined;
  });
  await h.api.refresh();
  h.button('data-evidence:e2').emit('click');
  await h.tick();
  assert.match(h.el('inbox-preview').innerHTML, /src="data:image\/png;base64,AAAA"/);

  const pdf = { ...MAIL, id: 'e3', kind: 'pdf', subject: null, originalFilename: 'offer.pdf' };
  const g = harness((name, args) => {
    if (name === 'list_inbox_cmd') return [pdf];
    if (name === 'get_evidence_preview_cmd' && args?.evidenceId === 'e3') {
      return { ...pdf, bodyExtract: null, imageDataUrl: null, note: 'PDF 不在应用内渲染。' };
    }
    return undefined;
  });
  await g.api.refresh();
  g.button('data-evidence:e3').emit('click');
  await g.tick();
  assert.match(g.el('inbox-preview').innerHTML, /PDF 不在应用内渲染/);
  await g.button('data-act:open').emit('click');
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
  h.button('data-evidence:e1').emit('click');
  await h.tick();

  const html = h.el('inbox-preview').innerHTML;
  assert.match(html, /后端开发/);
  assert.match(html, /数据平台/);
  assert.doesNotMatch(html, /<option value="app-[^"]*" selected/, '两条都不预选，必须自己点');
  assert.match(html, /不会替你猜/);

  // 没选就点关联：不发命令，只提醒。
  h.el('inbox-application').value = '';
  await h.button('data-act:associate').emit('click');
  await h.tick();
  assert.equal(h.calls.some((call) => call.name === 'associate_evidence_cmd'), false);
  assert.match(h.el('inbox-status').textContent, /请先选中一条申请/);

  h.el('inbox-application').value = 'app-2';
  await h.button('data-act:associate').emit('click');
  await h.tick();
  const args = h.callArgs('associate_evidence_cmd');
  assert.deepEqual(args, { evidenceId: 'e1', applicationId: 'app-2' });
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
  h.button('data-evidence:e1').emit('click');
  await h.tick();

  h.el('inbox-reply-class').value = 'interview_invite';
  h.el('inbox-send-mode').value = 'unknown';
  await h.button('data-act:classify').emit('click');
  await h.tick();

  const args = h.callArgs('classify_evidence_cmd');
  assert.deepEqual(args, { evidenceId: 'e1', replyClass: 'interview_invite', sendMode: 'unknown' });
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
  assert.deepEqual(h.callArgs('import_evidence_cmd').args, { text: '他们说下周二面试。' });
  assert.equal(h.el('inbox-paste').value, '');
});

test('a preview that answers late cannot replace the one selected after it', async () => {
  let releaseFirst: (() => void) | undefined;
  const h = harness((name, args) => {
    if (name === 'list_inbox_cmd') return [MAIL, { ...MAIL, id: 'e9', subject: '第二封' }];
    if (name === 'get_evidence_preview_cmd' && args?.evidenceId === 'e1') {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ ...MAIL, bodyExtract: '第一封的正文', imageDataUrl: null, note: null });
      });
    }
    if (name === 'get_evidence_preview_cmd' && args?.evidenceId === 'e9') {
      return { ...MAIL, id: 'e9', subject: '第二封', bodyExtract: '第二封的正文', imageDataUrl: null, note: null };
    }
    return undefined;
  });
  await h.api.refresh();
  h.button('data-evidence:e1').emit('click');
  await h.tick();
  h.button('data-evidence:e9').emit('click');
  await h.tick();
  releaseFirst?.();
  await h.tick();
  assert.match(h.el('inbox-preview').innerHTML, /第二封的正文/);
  assert.doesNotMatch(h.el('inbox-preview').innerHTML, /第一封的正文/);
});
