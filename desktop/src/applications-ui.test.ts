import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountApplications } from './applications-ui.ts';

type InvokeHandler = (name: string, args?: Record<string, unknown>) => unknown;

/** 假 DOM：只实现这个界面用到的那几样，别的一律不装懂。 */
class FakeNode {
  id: string;
  value = "";
  checked = false;
  open = false;
  disabled = false;
  hidden = false;
  innerHTML = "";
  textContent = "";
  dataset: Record<string, string> = {};
  listeners: Record<string, (event: unknown) => unknown> = {};
  classList = { toggle() {}, add() {}, remove() {} };

  private readonly ctx: {
    actions: Map<string, FakeNode>;
    actionList: FakeNode[];
    el: (id: string) => FakeNode;
  };

  constructor(
    id: string,
    ctx: { actions: Map<string, FakeNode>; actionList: FakeNode[]; el: (id: string) => FakeNode },
  ) {
    this.id = id;
    this.ctx = ctx;
  }

  addEventListener(type: string, fn: (event: unknown) => unknown) {
    this.listeners[type] = fn;
  }
  emit(type: string, event: Record<string, unknown> = {}) {
    return this.listeners[type]?.({ preventDefault() {}, ...event });
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  focus() {}
  querySelectorAll(selector: string): FakeNode[] {
    if (selector === "button[data-act]") {
      return [
        ...this.innerHTML.matchAll(/data-act="([^"]+)"(?:\s+data-(snapshot|evidence)="([^"]+)")?/g),
      ].map((m) => {
        const node = new FakeNode(m[1], this.ctx);
        node.dataset = { act: m[1], ...(m[2] ? { [m[2]]: m[3] } : {}) };
        this.ctx.actions.set(m[1], node);
        this.ctx.actionList.push(node);
        return node;
      });
    }
    if (selector === "tr") return [];
    const ids =
      this.id === "app-form"
        ? ["f-company", "f-title", "f-url", "f-location", "f-notes", "btn-save-app", "btn-cancel-app"]
        : ["progress-description", "progress-date", "progress-round", "progress-update", "progress-save", "progress-cancel"];
    return ids.map((id) => this.ctx.el(id));
  }
}

function harness(handler?: InvokeHandler) {
  const nodes = new Map<string, FakeNode>();
  const actions = new Map<string, FakeNode>();
  const actionList: FakeNode[] = [];
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  function el(id: string): FakeNode {
    if (!nodes.has(id)) nodes.set(id, new FakeNode(id, { actions, actionList, el }));
    return nodes.get(id) as FakeNode;
  }

  globalThis.document = { getElementById: el, addEventListener() {}, body: {} } as unknown as Document;
  globalThis.window = { confirm: () => true, prompt: () => null } as unknown as Window & typeof globalThis;
  el("app-stage").value = "all";
  el("app-recycle").value = "active";
  el("app-sort").value = "updatedAt";

  const view = (id: string) => ({
    application: {
      id,
      company: `Company-${id}`,
      title: "Engineer",
      current_stage: "saved",
      recycle_state: "active",
      notes: "keep",
    },
    events: [],
  });

  const invoke = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ name, args });
    const custom = handler?.(name, args);
    if (custom !== undefined) return custom as T;
    if (name === "get_application_cmd") return view(String(args?.id)) as T;
    if (name === "list_applications_cmd") {
      return { total: 2, items: [view("A").application, view("B").application] } as T;
    }
    return {} as T;
  };

  /** 渲染出来的某个操作按钮；不存在就当场失败。 */
  function action(act: string): FakeNode {
    const node = actions.get(act);
    if (!node) throw new Error(`界面上没有这个按钮：${act}`);
    return node;
  }

  /** 某个命令第一次被调用时收到的参数。 */
  function callArgs(name: string): Record<string, unknown> {
    const call = calls.find((entry) => entry.name === name);
    if (!call) throw new Error(`没有调用过命令：${name}`);
    return call.args ?? {};
  }

  const api = mountApplications(invoke);
  const select = async (id: string) => {
    el("apps-tbody").emit("click", { target: { closest: () => ({ dataset: { id } }) } });
    await tick();
  };
  return { el, actions, action, actionList, calls, callArgs, api, select, tick, view };
}

test('progress cancel and Escape never dispatch writes for any outcome',async()=>{
 const h=harness();await h.select('A');
 for(const kind of ['interview','assessment','offer','rejected','withdrawn','closed']){
   await h.action(kind).emit('click');assert.equal(h.el('progress-dialog').open,true);
   h.el('progress-cancel').emit('click');assert.equal(h.el('progress-dialog').open,false);
   await h.action(kind).emit('click');h.el('progress-dialog').emit('cancel');
 }
 assert.equal(h.calls.filter(c=>c.name.startsWith('record_')).length,0);
});

test('progress form defaults to history, transmits date and interview round',async()=>{
 const h=harness();await h.select('A');await h.action('interview').emit('click');
 assert.equal(h.el('progress-update').checked,false);h.el('progress-round').value='2';h.el('progress-date').value='2026-08-21';
 await h.el('progress-form').emit('submit');
 const args=h.callArgs('record_interview_cmd').args as Record<string,unknown>;
 assert.equal(args.round,2);assert.equal(args.updateProgress,false);assert.deepEqual(args.occurred,{precision:'date',value:{date:'2026-08-21',time_zone:null}});
});

test('stale detail success and error cannot replace current selection',async()=>{
 type Pending={id:unknown;resolve:(value:unknown)=>void;reject:(reason?:unknown)=>void};
 const pending:Pending[]=[];
 const h=harness((name,args)=>name==='get_application_cmd'?new Promise((resolve,reject)=>pending.push({id:args?.id,resolve,reject})):undefined);
 await h.select('A');await h.select('B');pending[1].resolve(h.view('B'));await h.tick();pending[0].resolve(h.view('A'));await h.tick();
 assert.equal(h.api.ctl.selectedId,'B');assert.match(h.el('app-detail').innerHTML,/Company-B/);assert.doesNotMatch(h.el('app-detail').innerHTML,/Company-A/);
 await h.select('A');await h.select('B');pending[3].resolve(h.view('B'));await h.tick();pending[2].reject(new Error('old failure'));await h.tick();assert.match(h.el('app-detail').innerHTML,/Company-B/);
});

test('edit clearing sends empty strings, save locks fields and Escape cannot discard inflight input',async()=>{
 const failure:{reject:((reason?:unknown)=>void)|null}={reject:null};
 const h=harness(name=>name==='update_application_cmd'?new Promise((_,reject)=>{failure.reject=reject;}):undefined);
 await h.select('A');await h.action('edit').emit('click');
 for(const id of ['f-url','f-location','f-notes'])h.el(id).value='';
 h.el('app-form').emit('input');const pending=h.el('app-form').emit('submit');
 assert.equal(h.el('f-company').disabled,true);h.el('app-form-dialog').emit('cancel');assert.equal(h.el('app-form-dialog').open,true);
 await h.el('app-form').emit('submit');assert.equal(h.calls.filter(c=>c.name==='update_application_cmd').length,1);
 const args=h.callArgs('update_application_cmd').args as Record<string,unknown>;assert.equal(args.notes,'');assert.equal(args.location,'');assert.equal(args.sourceUrl,'');
 failure.reject?.(new Error('write failed'));await pending;assert.equal(h.el('app-form-dialog').open,true);assert.equal(h.el('f-company').disabled,false);assert.equal(h.el('f-notes').value,'');
 globalThis.window.confirm=()=>false;h.el('app-form-dialog').emit('cancel');assert.equal(h.el('app-form-dialog').open,true);
});

test('list falls back from an empty last page before rendering page count',async()=>{
 const h=harness((name,args)=>name==='list_applications_cmd'?{total:20,items:(args?.args as {offset?:number})?.offset?[]:[{id:'A',company:'A',title:'x'}]}:undefined);
 h.api.ctl.setOffset(20);await h.api.refreshList();assert.equal(h.api.ctl.offset,0);assert.equal(h.el('apps-page').textContent,'1 / 1');
});

test('new selection survives completion of an earlier action',async()=>{
 const done:{resolve:((value?:unknown)=>void)|null}={resolve:null};
 const h=harness(name=>name==='confirm_submit_cmd'?new Promise(resolve=>{done.resolve=resolve;}):undefined);
 await h.select('A');const pending=h.action('submit').emit('click');await h.select('B');done.resolve?.({});await pending;
 assert.equal(h.api.ctl.selectedId,'B');assert.match(h.el('app-detail').innerHTML,/Company-B/);
});

const fillEvent = (snapshot: string) => ({ id: 'e1', event_sequence: 2, event_type: 'fill_partial', occurred: { precision: 'unknown' }, recorded_at: '2026-09-12T08:00:00Z',
  payload: { kind: 'fill_event', outcome: 'partial', field_count: 12, filled_count: 9, unconfirmed_count: 3, template_name: '合成模板', snapshot_id: snapshot } });

test('a fill event with a stored snapshot opens it, with the disclaimer, escaped', async () => {
  const S = '66666666-6666-4666-8666-666666666666';
  const h = harness((name, args) => {
    if (name === 'get_application_cmd') return { ...h.view(String(args?.id)), events: [fillEvent(S)], snapshotStates: { [S]: 'stored' },
      snapshots: [{ snapshot_id: S, template_name: '合成模板', created_at: '2026-09-12T08:00:00Z', byte_size: 344 }] };
    if (name === 'get_snapshot_cmd') return { snapshotId: S, templateName: '合成模板', capturedAt: '2026-09-12T08:00:00.000Z', omittedFieldCount: 2,
      groups: [{ name: '基本信息', fields: [{ key: '姓名', value: '合成' }, { key: '备注', value: '<img src=x onerror=alert(1)>' }] }] };
    return undefined;
  });
  await h.select('A');
  const html = h.el('app-detail').innerHTML;
  assert.match(html, /已写入网页 9\/12 项/);
  assert.match(html, /data-act="snapshot" data-snapshot="66666666-6666-4666-8666-666666666666"/);
  assert.doesNotMatch(html, /简历快照尚未接入|简历快照和待办尚未接入/);
  await h.action('snapshot').emit('click');
  await h.tick();
  assert.deepEqual(h.callArgs('get_snapshot_cmd'), { snapshotId: S });
  assert.equal(h.el('snapshot-dialog').open, true);
  const body = h.el('snapshot-body').innerHTML;
  assert.match(body, /不能/);
  assert.match(body, /姓名/);
  assert.match(body, /2 个疑似密码/);
  assert.doesNotMatch(body, /<img/);
  assert.match(body, /&lt;img/);
});

test('a snapshot still uploading or missing is described, not offered', async () => {
  const cases: Array<[string, RegExp]> = [['uploading', /上传中/], ['missing', /不可用/]];
  for (const [state, pattern] of cases) {
    const S = '77777777-7777-4777-8777-777777777777';
    const h = harness((name, args) => name === 'get_application_cmd'
      ? { ...h.view(String(args?.id)), events: [fillEvent(S)], snapshotStates: { [S]: state }, snapshots: [] } : undefined);
    await h.select('A');
    const html = h.el('app-detail').innerHTML;
    assert.match(html, pattern, state);
    assert.doesNotMatch(html, /data-act="snapshot"/, state);
  }
});

test('a snapshot that cannot be read says so instead of showing part of it', async () => {
  const S = '66666666-6666-4666-8666-666666666666';
  const h = harness((name, args) => {
    if (name === 'get_application_cmd') return { ...h.view(String(args?.id)), events: [fillEvent(S)], snapshotStates: { [S]: 'stored' }, snapshots: [] };
    if (name === 'get_snapshot_cmd') return Promise.reject({ code: 'VALIDATION', message: 'file digest mismatch' });
    return undefined;
  });
  await h.select('A');
  await h.action('snapshot').emit('click');
  await h.tick();
  assert.match(h.el('snapshot-body').innerHTML, /无法读取/);
  assert.doesNotMatch(h.el('snapshot-body').innerHTML, /姓名/);
});

test('a snapshot opened after another one is not overwritten when the first answers late', async () => {
  const A = '66666666-6666-4666-8666-666666666666';
  const B = '99999999-9999-4999-8999-999999999999';
  const first: { release: (() => void) | null } = { release: null };
  const h = harness((name, args) => {
    if (name === 'get_application_cmd') return { ...h.view(String(args?.id)), events: [], snapshotStates: {},
      snapshots: [{ snapshot_id: A, template_name: '旧模板', created_at: '2026-09-12T08:00:00Z' }, { snapshot_id: B, template_name: '新模板', created_at: '2026-09-12T09:00:00Z' }] };
    if (name === 'get_snapshot_cmd' && args?.snapshotId === A) return new Promise(resolve => { first.release = () => resolve(snapshotDoc('旧的内容')); });
    if (name === 'get_snapshot_cmd' && args?.snapshotId === B) return snapshotDoc('新的内容');
    return undefined;
  });
  await h.select('A');
  const button = (id: string) => {
    const node = h.actionList.filter((item) => item.dataset.snapshot === id).at(-1);
    if (!node) throw new Error(`界面上没有这份快照的按钮：${id}`);
    return node;
  };
  button(A).emit('click');
  await h.tick();
  await button(B).emit('click');
  await h.tick();
  assert.match(h.el('snapshot-body').innerHTML, /新的内容/);
  first.release?.();
  await h.tick();
  assert.match(h.el('snapshot-body').innerHTML, /新的内容/);
  assert.doesNotMatch(h.el('snapshot-body').innerHTML, /旧的内容/);
});

function snapshotDoc(value: string) {
  return { templateName: '合成模板', capturedAt: '2026-09-12T08:00:00.000Z', omittedFieldCount: 0,
    groups: [{ name: '经历', fields: [{ key: '描述', value }] }] };
}

test('the detail lists its evidence, opens it read-only and can take it back out', async () => {
  const E = 'ev-1';
  const h = harness((name, args) => {
    if (name === 'get_application_cmd') {
      return {
        ...h.view(String(args?.id)),
        events: [],
        snapshots: [],
        snapshotStates: {},
        evidence: [{ id: E, kind: 'eml', subject: '面试邀请', fromAddr: 'hr@example.test', replyClass: null, sendMode: null }],
      };
    }
    if (name === 'get_evidence_preview_cmd') {
      return { id: E, kind: 'eml', replyClass: null, sendMode: null, bodyExtract: '<script>alert(1)</script> 正文', imageDataUrl: null, note: null };
    }
    return undefined;
  });
  await h.select('A');
  const html = h.el('app-detail').innerHTML;
  assert.match(html, /回复证据（1）/);
  assert.match(html, /面试邀请/);
  assert.match(html, /待分类/);
  assert.doesNotMatch(html, /附件和待办尚未接入/);

  await h.action('evidence').emit('click');
  await h.tick();
  assert.equal(h.el('evidence-dialog').open, true);
  const body = h.el('evidence-body').innerHTML;
  assert.match(body, /&lt;script&gt;/);
  assert.doesNotMatch(body, /<script/);

  await h.action('unassociate').emit('click');
  await h.tick();
  assert.deepEqual(h.callArgs('unassociate_evidence_cmd'), { evidenceId: E });
});

test('an application with no evidence says so without claiming silence from the other side', async () => {
  const h = harness((name, args) => (name === 'get_application_cmd'
    ? { ...h.view(String(args?.id)), events: [], snapshots: [], snapshotStates: {}, evidence: [] }
    : undefined));
  await h.select('A');
  const html = h.el('app-detail').innerHTML;
  assert.match(html, /回复证据（0）/);
  assert.match(html, /不代表对方没有回复/);
});
