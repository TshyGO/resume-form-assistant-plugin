import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountApplications } from './applications-ui.ts';
import { findMatchRanges, highlightHtml } from './search-highlight.ts';

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
  classes = new Set<string>();
  classList = {
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name); else this.classes.delete(name);
      return on;
    },
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
  };

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
    if (["[data-detail-tab]", "[data-detail-panel]", ".action-menu"].includes(selector)) return [];
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

function harness(handler?: InvokeHandler, options: { searchDebounceMs?: number; coalesceMs?: number } = {}) {
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

  let onChanged: ((event: { payload?: unknown }) => void) | null = null;
  const api = mountApplications(invoke, {
    listen: (_name, fn) => { onChanged = fn; },
    searchDebounceMs: options.searchDebounceMs ?? 40,
    coalesceMs: options.coalesceMs ?? 30,
  });
  const select = async (id: string) => {
    el("apps-tbody").emit("click", { target: { closest: () => ({ dataset: { id } }) } });
    await tick();
  };
  return {
    el, actions, action, actionList, calls, callArgs, api, select, tick, view,
    emitChanged(payload: unknown) { onChanged?.({ payload }); },
  };
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function listCalls(h: ReturnType<typeof harness>) {
  return h.calls.filter((call) => call.name === "list_applications_cmd");
}

function queryOf(call: { args?: Record<string, unknown> }) {
  return (call.args?.args ?? {}) as { query?: string | null; stage?: string; recycle?: string; offset?: number; sort?: string };
}

test("search debounces typing, clears immediately, and keeps the other filters", async () => {
  const h = harness();
  h.el("app-stage").value = "interview";
  h.el("app-recycle").value = "active";
  h.el("app-sort").value = "company";
  h.el("app-search").value = "甲";
  h.el("app-search").emit("input");
  h.el("app-search").value = "甲乙";
  h.el("app-search").emit("input");
  await wait(15);
  assert.equal(listCalls(h).length, 0);
  await wait(50);
  assert.equal(listCalls(h).length, 1);
  assert.equal(queryOf(listCalls(h)[0]).query, "甲乙");
  assert.equal(queryOf(listCalls(h)[0]).stage, "interview");
  assert.equal(queryOf(listCalls(h)[0]).sort, "company");

  h.el("app-search").value = "";
  h.el("app-search").emit("search");
  await h.tick();
  const cleared = queryOf(listCalls(h).at(-1)!);
  assert.equal(cleared.query, null);
  assert.equal(cleared.offset, 0);
  assert.equal(cleared.stage, "interview");
  assert.equal(cleared.recycle, "active");
  assert.equal(cleared.sort, "company");
});

test("composition holds the query until the candidate is confirmed, and Enter searches now", async () => {
  const h = harness();
  h.el("app-search").emit("compositionstart");
  h.el("app-search").value = "岗";
  h.el("app-search").emit("input");
  await h.el("app-search").emit("keydown", { key: "Enter", isComposing: true });
  await wait(60);
  assert.equal(listCalls(h).length, 0);
  h.el("app-search").emit("compositionend");
  await wait(60);
  assert.equal(queryOf(listCalls(h).at(-1)!).query, "岗");

  h.el("app-search").value = "后端";
  await h.el("app-search").emit("keydown", { key: "Enter" });
  await h.tick();
  assert.equal(queryOf(listCalls(h).at(-1)!).query, "后端");
});

test("a slow search cannot overwrite the list restored by clearing the box", async () => {
  let release = () => {};
  const h = harness(async (name, args) => {
    if (name !== "list_applications_cmd") return undefined;
    if (queryOf({ args }).query === "慢") {
      await new Promise<void>((resolve) => { release = resolve; });
      return { total: 1, items: [{ id: "SLOW", company: "SlowCo", title: "慢", current_stage: "saved" }] };
    }
    return { total: 1, items: [{ id: "ALL", company: "AllCo", title: "全部", current_stage: "saved" }] };
  });
  h.el("app-search").value = "慢";
  h.el("app-search").emit("input");
  await wait(50);
  h.el("app-search").value = "";
  h.el("app-search").emit("input");
  await h.tick();
  await h.tick();
  release();
  await h.tick();
  await h.tick();
  assert.match(h.el("apps-tbody").innerHTML, /AllCo/);
  assert.doesNotMatch(h.el("apps-tbody").innerHTML, /SlowCo/);
});

test("a committed plugin write refreshes the open list from the query", async () => {
  const h = harness((name) => name === "list_applications_cmd"
    ? { total: 1, items: [{ id: "NEW", company: "金发科技股份有限公司", title: "研发工程师-化工工艺研究方向", current_stage: "saved" }] }
    : undefined);
  h.emitChanged({ reason: "draft", applicationId: "NEW", company: "不该出现" });
  await wait(50);
  assert.equal(listCalls(h).length, 0);

  h.emitChanged({ reason: "committed", messageType: "job.save", applicationId: "NEW", company: "金发科技股份有限公司", title: "研发工程师-化工工艺研究方向", stage: "saved", recycleState: "active" });
  h.emitChanged({ reason: "committed", messageType: "job.save", applicationId: "NEW", company: "金发科技股份有限公司", title: "研发工程师-化工工艺研究方向", stage: "saved", recycleState: "active" });
  await wait(10);
  assert.equal(listCalls(h).length, 0);
  await wait(40);
  await h.tick();
  assert.equal(listCalls(h).length, 1);
  assert.match(h.el("apps-tbody").innerHTML, /金发科技股份有限公司/);
  assert.equal(h.el("apps-fresh").hidden, true);
});

test("a committed row hidden by the current filter is not inserted and does not clear the filter", async () => {
  const h = harness((name) => name === "list_applications_cmd" ? { total: 0, items: [] } : undefined);
  h.el("app-stage").value = "interview";
  h.el("app-search").value = "其他";
  h.emitChanged({
    reason: "committed",
    messageType: "job.save",
    applicationId: "NEW",
    company: "金发科技股份有限公司",
    title: "研发工程师-化工工艺研究方向",
    stage: "saved",
    recycleState: "active",
  });
  await wait(50);
  await h.tick();
  assert.equal(h.el("app-stage").value, "interview");
  assert.equal(h.el("app-search").value, "其他");
  assert.equal(h.el("apps-fresh").hidden, false);
  assert.doesNotMatch(h.el("apps-tbody").innerHTML, /金发科技股份有限公司/);

  await h.el("apps-fresh-clear").emit("click");
  await h.tick();
  assert.equal(h.el("app-stage").value, "all");
  assert.equal(h.el("app-search").value, "");
  assert.equal(queryOf(listCalls(h).at(-1)!).query, null);
  assert.equal(queryOf(listCalls(h).at(-1)!).stage, "all");
  assert.equal(queryOf(listCalls(h).at(-1)!).offset, 0);
});

test("an update to an existing application refreshes without claiming there is a new one", async () => {
  const h = harness((name) => name === "list_applications_cmd" ? { total: 0, items: [] } : undefined);
  h.el("app-search").value = "其他";
  h.emitChanged({ reason: "committed", messageType: "fill.submit", applicationId: "EXISTING" });
  await wait(50);
  await h.tick();
  assert.equal(listCalls(h).length, 1);
  assert.equal(h.el("apps-fresh").hidden, true);
});

// ---------------------------------------------------------------------------
// Issue #176：搜索命中高亮、独立无结果状态、被筛掉的旧详情
// ---------------------------------------------------------------------------

const MARK = (text: string) => `<mark class="search-match">${text}</mark>`;
const hl = highlightHtml;

test('highlight: company, title and location mark the characters that matched', () => {
  assert.equal(hl('company', '金发科技', '发'), `金${MARK('发')}科技`);
  assert.equal(hl('title', '研发工程师', '发'), `研${MARK('发')}工程师`);
  assert.equal(hl('title', '研发工程师', '工程'), `研发${MARK('工程')}师`);
  assert.equal(hl('location', '上海市浦东新区', '浦东'), `上海市${MARK('浦东')}新区`);
  assert.equal(hl('location', 'Shanghai', 'HAI'), `Shang${MARK('hai')}`);
});

test('highlight: the same keyword marks company and title, and every occurrence in a field', () => {
  const row = { company: '金发科技', title: '研发工程师' };
  assert.match(hl('company', row.company, '发'), /<mark/);
  assert.match(hl('title', row.title, '发'), /<mark/);
  assert.equal(hl('company', '中化集团', '发'), '中化集团');
  assert.equal(hl('title', '发发科技发', '发'), `${MARK('发')}${MARK('发')}科技${MARK('发')}`);
  assert.equal(hl('title', 'abcABCabc', 'abc'), `${MARK('abc')}${MARK('ABC')}${MARK('abc')}`);
});

test('highlight: Latin case is ignored but the displayed text is untouched', () => {
  assert.equal(hl('title', 'Software ENGINEER', 'engin'), `Software ${MARK('ENGIN')}EER`);
  assert.equal(hl('company', 'OpenAI', 'AI'), `Open${MARK('AI')}`);
  assert.equal(hl('location', 'BeiJing', 'JING'), `Bei${MARK('Jing')}`);
});

test('highlight: no keyword, no mark', () => {
  for (const query of [null, undefined, '', '   ', '\u3000']) {
    for (const field of ['company', 'title', 'location'] as const) {
      assert.doesNotMatch(hl(field, '金发科技 <b>', query), /<mark/);
      assert.deepEqual(findMatchRanges(field, '金发科技', query), []);
    }
  }
  assert.equal(hl('title', '', '发'), '');
  assert.equal(hl('location', null, '发'), '');
});

test('highlight: company follows normalize_company, so the stripped suffix never lights up', () => {
  // 库里存的是去掉后缀后的值：“公司”“Inc.” 在后端根本搜不到，界面也不该高亮。
  assert.equal(hl('company', '星河科技有限公司', '科技'), `星河${MARK('科技')}有限公司`);
  assert.equal(hl('company', '星河科技有限公司', '公司'), '星河科技有限公司');
  assert.equal(hl('company', '星河科技有限公司', '星河科技有限公司'), `${MARK('星河科技')}有限公司`);
  assert.equal(hl('company', 'Acme Inc.', 'inc'), 'Acme Inc.');
  assert.equal(hl('company', 'Acme Inc.', 'ACME'), `${MARK('Acme')} Inc.`);
  // 后缀判断按 UTF-8 字节数：“星有限公司”会去后缀，单独的“有限公司”不会。
  assert.equal(hl('company', '星有限公司', '星有限公司'), `${MARK('星')}有限公司`);
  assert.equal(hl('company', '星有限公司', '有限公司'), '星有限公司');
  // 尾部的 ASCII 标点也被后端去掉。
  assert.equal(hl('company', '金发科技', '科技.'), `金发${MARK('科技')}`);
  // 岗位不去后缀。
  assert.equal(hl('title', '有限公司专员', '公司'), `有限${MARK('公司')}专员`);
});

test('highlight: full-width, half-width and collapsed whitespace follow each field\'s backend rule', () => {
  assert.equal(hl('company', 'ＡＢＣ 公司', 'abc'), `${MARK('ＡＢＣ')} 公司`);
  assert.equal(hl('company', 'abc公司', 'ＡＢＣ'), `${MARK('abc')}公司`);
  assert.equal(hl('title', 'Ｒｕｓｔ　工程师', 'rust 工'), `${MARK('Ｒｕｓｔ　工')}程师`);
  assert.equal(hl('title', 'Senior   Rust', 'senior rust'), MARK('Senior   Rust'));
  assert.equal(hl('title', 'Senior Rust', 'senior    rust'), MARK('Senior Rust'));
  assert.equal(hl('title', '  前端  ', '前端'), `  ${MARK('前端')}  `);
  // 地点只有 ASCII 小写：不折叠全角，也不压缩空白。
  assert.equal(hl('location', 'ＡＢＣ', 'abc'), 'ＡＢＣ');
  assert.equal(hl('location', 'ABC路', 'abc'), `${MARK('ABC')}路`);
  assert.equal(hl('location', 'a  b', 'a b'), 'a  b');
  assert.equal(hl('location', 'a b', 'a b'), MARK('a b'));
  // SQLite lower() 只处理 ASCII，“É” 不会变成 “é”，所以后端搜不到，这里也不高亮。
  assert.equal(hl('location', 'É', 'é'), 'É');
  assert.equal(hl('title', 'É', 'é'), MARK('É'));
});

test('highlight: LIKE wildcards behave like the backend, and non-matching fields stay plain', () => {
  assert.equal(hl('title', 'React Native', 'r_act'), `${MARK('React')} Native`);
  assert.equal(hl('title', 'React Native', 're%ive'), `${MARK('Re')}act Nat${MARK('ive')}`);
  assert.equal(hl('title', 'React Native', 'ive%re'), 'React Native');
  assert.equal(hl('title', 'React Native', '%'), 'React Native');
  assert.equal(hl('company', 'React', '.'), 'React');
});

test('highlight: never splits surrogate pairs or expanded lower-case characters', () => {
  assert.equal(hl('title', '𠮷野家 Engineer', '野'), `𠮷${MARK('野')}家 Engineer`);
  assert.equal(hl('title', '𠮷野家', '𠮷'), `${MARK('𠮷')}野家`);
  assert.equal(hl('location', '😀东京', '东'), `😀${MARK('东')}京`);
  // “İ” 小写后是两个码点（i + U+0307），命中其中一部分时高亮整个原字符。
  assert.equal(hl('title', 'İstanbul', 'stanbul'), `İ${MARK('stanbul')}`);
  assert.equal(hl('title', 'İstanbul', 'i\u0307'), `${MARK('İ')}stanbul`);
  // 词尾 Σ 按整串小写规则变 ς，和后端一致。
  assert.equal(hl('title', 'ΑΣ', 'ας'), MARK('ΑΣ'));
});

test('highlight: user text is escaped, and only the fixed mark tag can appear', () => {
  const hostile = [
    ['title', '<script>alert(1)</script>', '<script>'],
    ['company', '"><img src=x onerror=alert(1)>', 'onerror'],
    ['company', `A&B <Co> "q" 'p'`, '&'],
    ['title', `A&B <Co> "q" 'p'`, `'`],
    ['title', `A&B <Co> "q" 'p'`, '"'],
    ['location', '<b>bold</b>', '<b>'],
    ['location', '&lt;script&gt;', '&lt;'],
    ['title', 'plain', '<img src=x onerror=alert(1)>'],
  ] as const;
  for (const [field, text, query] of hostile) {
    const html = hl(field, text, query);
    const rest = html.replaceAll('<mark class="search-match">', '').replaceAll('</mark>', '');
    assert.doesNotMatch(rest, /[<>]/, html);
    assert.doesNotMatch(rest, /["']/, html);
    assert.doesNotMatch(html, /<script|<img|onerror=/, html);
    assert.equal(html.replace(/<\/?mark[^>]*>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&'), text);
  }
  assert.equal(hl('title', '<script>alert(1)</script>', '<script>'), `${MARK('&lt;script&gt;')}alert(1)&lt;/script&gt;`);
  assert.equal(hl('company', `A&B "q" 'p'`, 'a&b'), `${MARK('A&amp;B')} &quot;q&quot; &#39;p&#39;`);
  assert.equal(hl('title', `A&B "q" 'p'`, '&'), `A${MARK('&amp;')}B &quot;q&quot; &#39;p&#39;`);
  // 公司查询会被后端去掉尾部标点，只剩标点的查询规范化为空：命中所有行，但没有具体位置可标。
  assert.equal(hl('company', `A&B`, '&'), 'A&amp;B');
});

const rowsFor = (query: string | null) => query === '发'
  ? [
    { id: 'A', company: '金发科技', title: '研发工程师', location: 'Shanghai', current_stage: 'saved', updated_at: '2026-09-01T00:00:00Z' },
    { id: 'B', company: '中化集团', title: '研发专员', location: '上海', current_stage: 'saved', updated_at: '2026-09-02T00:00:00Z' },
    { id: 'C', company: '星河公司', title: '研发经理', location: null, current_stage: 'saved', updated_at: '2026-09-03T00:00:00Z' },
  ]
  : [];

function searchBackend(name: string, args?: Record<string, unknown>) {
  if (name !== 'list_applications_cmd') return undefined;
  const query = queryOf({ args }).query ?? null;
  if (query === null) {
    const items = rowsFor('发');
    return { total: items.length, items };
  }
  const items = rowsFor(query);
  return { total: items.length, items };
}

const hidden = (h: ReturnType<typeof harness>, id: string) => h.el(id).classList.contains('hidden');

test('the list highlights company, title and location for the query that produced it', async () => {
  const h = harness(searchBackend);
  h.el('app-search').value = '发';
  await h.el('app-search').emit('keydown', { key: 'Enter' });
  await h.tick();
  const html = h.el('apps-tbody').innerHTML;
  assert.match(html, new RegExp(`<strong>金${MARK('发')}科技</strong><span>研${MARK('发')}工程师</span>`));
  assert.match(html, new RegExp(`<strong>中化集团</strong><span>研${MARK('发')}专员</span>`));
  assert.match(html, new RegExp(`<strong>星河公司</strong><span>研${MARK('发')}经理</span>`));
  assert.equal((html.match(/<mark/g) ?? []).length, 4);
  // 阶段、更新时间不高亮。
  assert.doesNotMatch(html, /stage-badge[^>]*>[^<]*<mark/);
  assert.doesNotMatch(html, /app-updated[^>]*>[^<]*<mark/);
  // 悬停提示是纯文本，不带标签。
  assert.match(html, /title="金发科技 · 研发工程师"/);
});

test('location matches are highlighted in the location column only', async () => {
  const h = harness(() => ({ total: 1, items: [{ id: 'A', company: '甲公司', title: '工程师', location: 'Shanghai Pudong', current_stage: 'saved' }] }));
  h.el('app-search').value = 'pudong';
  await h.el('app-search').emit('keydown', { key: 'Enter' });
  await h.tick();
  const html = h.el('apps-tbody').innerHTML;
  assert.match(html, new RegExp(`<td class="app-location" title="Shanghai Pudong">Shanghai ${MARK('Pudong')}</td>`));
  assert.equal((html.match(/<mark/g) ?? []).length, 1);
});

test('an empty search shows the list with no highlight, and a missing location stays a dash', async () => {
  const h = harness(searchBackend);
  await h.api.refreshList();
  const html = h.el('apps-tbody').innerHTML;
  assert.doesNotMatch(html, /<mark/);
  assert.match(html, /<td class="app-location" title="—">—<\/td>/);
});

test('hostile company, title and location render as text in the list', async () => {
  const h = harness(() => ({ total: 1, items: [{
    id: 'X', company: '<img src=x onerror=alert(1)>&Co', title: `"><script>alert(1)</script>'`, location: '<script>&</script>', current_stage: 'saved',
  }] }));
  h.el('app-search').value = '<script>';
  await h.el('app-search').emit('keydown', { key: 'Enter' });
  await h.tick();
  const html = h.el('apps-tbody').innerHTML;
  const rest = html.replaceAll('<mark class="search-match">', '').replaceAll('</mark>', '');
  assert.doesNotMatch(rest, /<img|<script|<b>/);
  assert.match(html, /<strong>&lt;img src=x onerror=alert\(1\)&gt;&amp;Co<\/strong>/);
  assert.match(html, /<span>&quot;&gt;<mark class="search-match">&lt;script&gt;<\/mark>alert\(1\)&lt;\/script&gt;&#39;<\/span>/);
  assert.match(html, /<td class="app-location" title="[^"]*"><mark class="search-match">&lt;script&gt;<\/mark>&amp;&lt;\/script&gt;<\/td>/);
});

test('a search with no results shows its own empty state, not a table row', async () => {
  const h = harness(searchBackend);
  h.el('app-search').value = '不存在';
  await h.el('app-search').emit('keydown', { key: 'Enter' });
  await h.tick();
  assert.equal(hidden(h, 'apps-no-results'), false);
  assert.equal(hidden(h, 'apps-empty'), true);
  assert.equal(hidden(h, 'apps-layout'), true);
  assert.equal(h.el('apps-tbody').innerHTML, '');
  assert.doesNotMatch(h.el('apps-tbody').innerHTML, /<tr|没有符合筛选条件/);
  assert.equal(h.el('apps-msg').textContent, '');
  assert.equal(h.el('btn-prev-page').disabled, true);
  assert.equal(h.el('btn-next-page').disabled, true);
  // 搜索框和筛选器没有被禁用。
  for (const id of ['app-search', 'app-stage', 'app-recycle', 'app-sort']) assert.equal(h.el(id).disabled, false, id);
});

test('an archive that is genuinely empty and a filter with no results use different states', async () => {
  const none = () => ({ total: 0, items: [] });
  const fresh = harness(none);
  await fresh.api.refreshList();
  assert.equal(hidden(fresh, 'apps-empty'), false);
  assert.equal(hidden(fresh, 'apps-no-results'), true);
  assert.equal(hidden(fresh, 'apps-layout'), true);

  for (const set of [
    (h: ReturnType<typeof harness>) => { h.el('app-search').value = '某'; },
    (h: ReturnType<typeof harness>) => { h.el('app-stage').value = 'interview'; },
    (h: ReturnType<typeof harness>) => { h.el('app-recycle').value = 'recycled'; },
  ]) {
    const h = harness(none);
    set(h);
    await h.api.refreshList();
    assert.equal(hidden(h, 'apps-empty'), true);
    assert.equal(hidden(h, 'apps-no-results'), false);
    assert.equal(hidden(h, 'apps-layout'), true);
  }
});

test('the empty-state copy lives in its own container in index.html', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const block = html.match(/<div id="apps-no-results"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(block, '缺少 #apps-no-results');
  assert.match(block[1], /没有相关投递记录/);
  assert.match(block[1], /请尝试其他关键词或调整筛选条件/);
  assert.match(html, /<div id="apps-no-results" class="empty hidden"/);
  assert.doesNotMatch(block[0], /<table|<tr|<td/);
  const empty = html.match(/<div id="apps-empty"[^>]*>([\s\S]*?)<\/div>/);
  assert.match(empty?.[1] ?? '', /还没有申请记录/);
  assert.doesNotMatch(empty?.[1] ?? '', /没有相关投递记录/);
  const source = readFileSync(new URL('./applications-ui.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /没有符合筛选条件的申请|list-no-results/);
});

test('a search with no results clears the selection and any in-flight detail', async () => {
  type Pending = { resolve: (value: unknown) => void };
  const pending: Pending[] = [];
  const h = harness((name, args) => {
    if (name === 'get_application_cmd') return new Promise((resolve) => pending.push({ resolve }));
    if (name === 'list_applications_cmd' && queryOf({ args }).query) return { total: 0, items: [] };
    return undefined;
  });
  await h.select('A');
  assert.equal(h.api.ctl.selectedId, 'A');
  h.el('app-search').value = '不存在';
  await h.el('app-search').emit('keydown', { key: 'Enter' });
  await h.tick();
  assert.equal(h.api.ctl.selectedId, null);
  assert.doesNotMatch(h.el('app-detail').innerHTML, /Company-A|加载中/);
  // 已经作废的详情请求晚到，也不能把旧详情画回来。
  pending[0].resolve(h.view('A'));
  await h.tick();
  assert.doesNotMatch(h.el('app-detail').innerHTML, /Company-A/);
  assert.equal(h.api.ctl.selectedId, null);
});

test('a selection filtered out while other results remain is cleared, not replaced', async () => {
  const h = harness((name, args) => {
    if (name === 'list_applications_cmd' && queryOf({ args }).query === '乙') {
      return { total: 1, items: [{ id: 'B', company: '乙公司', title: 'Engineer', current_stage: 'saved' }] };
    }
    return undefined;
  });
  await h.api.refreshList();
  await h.select('A');
  assert.match(h.el('app-detail').innerHTML, /Company-A/);
  const detailCalls = () => h.calls.filter((call) => call.name === 'get_application_cmd').length;
  const before = detailCalls();
  h.el('app-search').value = '乙';
  await h.el('app-search').emit('keydown', { key: 'Enter' });
  await h.tick();
  assert.equal(h.api.ctl.selectedId, null);
  assert.doesNotMatch(h.el('app-detail').innerHTML, /Company-A/);
  assert.match(h.el('app-detail').innerHTML, /当前申请不在搜索结果中/);
  assert.equal(detailCalls(), before, '不能自动替用户选中另一条');
  assert.equal(hidden(h, 'apps-no-results'), true);
  assert.equal(hidden(h, 'apps-layout'), false);
});

test('clearing the search brings the full list back and selection works again', async () => {
  const h = harness((name, args) => {
    if (name === 'list_applications_cmd' && queryOf({ args }).query) return { total: 0, items: [] };
    return undefined;
  });
  await h.select('A');
  h.el('app-search').value = '不存在';
  await h.el('app-search').emit('keydown', { key: 'Enter' });
  await h.tick();
  assert.equal(hidden(h, 'apps-no-results'), false);

  h.el('app-search').value = '';
  h.el('app-search').emit('search');
  await h.tick();
  assert.equal(hidden(h, 'apps-no-results'), true);
  assert.equal(hidden(h, 'apps-layout'), false);
  assert.match(h.el('apps-tbody').innerHTML, /Company-A/);
  assert.match(h.el('apps-tbody').innerHTML, /Company-B/);
  assert.doesNotMatch(h.el('apps-tbody').innerHTML, /<mark/);
  assert.equal(h.el('apps-msg').textContent, '共 2 条');
  assert.doesNotMatch(h.el('app-detail').innerHTML, /当前申请不在搜索结果中|Company-A/);
  await h.select('B');
  assert.match(h.el('app-detail').innerHTML, /Company-B/);
});

test('a slow search cannot repaint highlights or the empty state over the cleared list', async () => {
  let release = () => {};
  const h = harness(async (name, args) => {
    if (name !== 'list_applications_cmd') return undefined;
    if (queryOf({ args }).query === '慢') {
      await new Promise<void>((resolve) => { release = resolve; });
      return { total: 0, items: [] };
    }
    return { total: 1, items: [{ id: 'ALL', company: 'AllCo', title: '全部', current_stage: 'saved' }] };
  });
  h.el('app-search').value = '慢';
  h.el('app-search').emit('input');
  await wait(50);
  h.el('app-search').value = '';
  h.el('app-search').emit('input');
  await h.tick();
  await h.tick();
  release();
  await h.tick();
  await h.tick();
  assert.match(h.el('apps-tbody').innerHTML, /AllCo/);
  assert.doesNotMatch(h.el('apps-tbody').innerHTML, /<mark/);
  assert.equal(hidden(h, 'apps-no-results'), true);
  assert.equal(hidden(h, 'apps-layout'), false);
});

test('highlight style uses theme variables, not glaring hard-coded colours', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.search-match\s*\{([^}]*)\}/);
  assert.ok(rule, '缺少 .search-match');
  const body = rule[1];
  assert.match(body, /background:\s*var\(--accent-[a-z-]+\)/);
  assert.match(body, /color:\s*var\(--accent-[a-z-]+\)/);
  assert.match(body, /padding:\s*0 2px/);
  assert.match(body, /border-radius:\s*[34]px/);
  assert.match(body, /font-weight:\s*650/);
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(yellow|red|lime|magenta)\b/i);
  const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(root, /--accent:\s*#36756b/);
  for (const name of ['--accent-strong', '--accent-mark']) assert.match(root, new RegExp(`${name}:\\s*#[0-9a-f]{6}`), name);
  assert.doesNotMatch(css, /list-no-results/);
});

test('location highlight is asymmetric on purpose: it mirrors what SQLite actually matches', () => {
  // 下面每一行都和真实后端（Rust to_lowercase 的模式 vs SQLite ASCII-only lower() 的文本）核对过。
  assert.equal(hl('location', 'É', 'É'), 'É');
  assert.equal(hl('location', 'É', 'é'), 'É');
  assert.equal(hl('location', 'é', 'é'), MARK('é'));
  assert.equal(hl('location', 'é', 'É'), MARK('é'));
  assert.equal(hl('location', 'İstanbul', 'İ'), 'İstanbul');
  assert.equal(hl('location', 'ABC', 'abc'), MARK('ABC'));
  assert.equal(hl('location', 'abc', 'ABC'), MARK('abc'));
  // 公司、岗位仍是 Unicode 小写。
  assert.equal(hl('title', 'É', 'é'), MARK('É'));
  assert.equal(hl('company', 'É', 'é'), MARK('É'));
});

function pagedBackend(name: string, args?: Record<string, unknown>) {
  if (name !== 'list_applications_cmd') return undefined;
  const { offset, query, stage } = queryOf({ args });
  if (query === '乙' || stage === 'interview') {
    return { total: 1, items: [{ id: 'B', company: 'Company-B', title: 'Engineer', current_stage: 'saved' }] };
  }
  const total = 30;
  return offset
    ? { total, items: [{ id: 'C', company: 'Company-C', title: 'Engineer', current_stage: 'saved' }] }
    : { total, items: [{ id: 'A', company: 'Company-A', title: 'Engineer', current_stage: 'saved' }, { id: 'B', company: 'Company-B', title: 'Engineer', current_stage: 'saved' }] };
}

test('paging away from the selected application clears the detail without claiming it left the results', async () => {
  const h = harness(pagedBackend);
  await h.api.refreshList();
  await h.select('A');
  assert.match(h.el('app-detail').innerHTML, /Company-A/);
  const detailCalls = () => h.calls.filter((call) => call.name === 'get_application_cmd').length;
  const before = detailCalls();
  await h.el('btn-next-page').emit('click');
  await h.tick();
  assert.equal(queryOf(listCalls(h).at(-1)!).offset, 20);
  assert.equal(h.api.ctl.selectedId, null);
  assert.doesNotMatch(h.el('app-detail').innerHTML, /Company-A/);
  assert.match(h.el('app-detail').innerHTML, /选择一条申请查看详情与时间线/);
  assert.doesNotMatch(h.el('app-detail').innerHTML, /当前申请不在搜索结果中/);
  assert.equal(detailCalls(), before, '翻页不能自动选中别的申请');
});

test('a sort change that moves the selection off the page does not claim it left the results', async () => {
  const h = harness((name, args) => {
    if (name !== 'list_applications_cmd') return undefined;
    return queryOf({ args }).sort === 'company'
      ? { total: 1, items: [{ id: 'B', company: 'Company-B', title: 'Engineer', current_stage: 'saved' }] }
      : undefined;
  });
  await h.api.refreshList();
  await h.select('A');
  h.el('app-sort').value = 'company';
  await h.el('app-sort').emit('change');
  await h.tick();
  assert.equal(h.api.ctl.selectedId, null);
  assert.doesNotMatch(h.el('app-detail').innerHTML, /Company-A/);
  assert.match(h.el('app-detail').innerHTML, /选择一条申请查看详情与时间线/);
  assert.doesNotMatch(h.el('app-detail').innerHTML, /当前申请不在搜索结果中/);
});

test('changing the stage filter or the recycle state that drops the selection says it left the results', async () => {
  const onlyB = { total: 1, items: [{ id: 'B', company: 'Company-B', title: 'Engineer', current_stage: 'saved' }] };
  for (const change of [
    (h: ReturnType<typeof harness>) => { h.el('app-stage').value = 'interview'; return h.el('app-stage').emit('change'); },
    (h: ReturnType<typeof harness>) => { h.el('app-recycle').value = 'recycled'; return h.el('app-recycle').emit('change'); },
  ]) {
    const h = harness((name, args) => {
      if (name !== 'list_applications_cmd') return undefined;
      const { stage, recycle } = queryOf({ args });
      return stage === 'interview' || recycle === 'recycled' ? onlyB : pagedBackend(name, args);
    });
    await h.api.refreshList();
    await h.select('A');
    await change(h);
    await h.tick();
    assert.equal(h.api.ctl.selectedId, null);
    assert.doesNotMatch(h.el('app-detail').innerHTML, /Company-A/);
    assert.match(h.el('app-detail').innerHTML, /当前申请不在搜索结果中/);
  }
});

test('a refresh with unchanged filters that drops the selection does not claim a filter removed it', async () => {
  let gone = false;
  const h = harness((name, args) => {
    if (name !== 'list_applications_cmd') return undefined;
    return gone ? { total: 1, items: [{ id: 'B', company: 'Company-B', title: 'Engineer', current_stage: 'saved' }] } : pagedBackend(name, args);
  });
  await h.api.refreshList();
  await h.select('A');
  gone = true;
  await h.api.refreshList();
  assert.equal(h.api.ctl.selectedId, null);
  assert.doesNotMatch(h.el('app-detail').innerHTML, /Company-A/);
  assert.match(h.el('app-detail').innerHTML, /选择一条申请查看详情与时间线/);
  assert.doesNotMatch(h.el('app-detail').innerHTML, /当前申请不在搜索结果中/);
});
