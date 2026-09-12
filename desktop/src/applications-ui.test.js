import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountApplications } from './applications-ui.js';

function harness(handler) {
  const nodes = new Map(), actions = new Map(), actionList = [], calls = [];
  const tick = () => new Promise(resolve => setImmediate(resolve));
  class Node {
    constructor(id) { this.id=id;this.value='';this.checked=false;this.open=false;this.disabled=false;this.innerHTML='';this.listeners={};this.classList={toggle(){},add(){},remove(){}}; }
    addEventListener(type,fn){this.listeners[type]=fn;}
    emit(type,event={}){return this.listeners[type]?.({preventDefault(){},...event});}
    showModal(){this.open=true;} close(){this.open=false;} focus(){}
    querySelectorAll(selector){
      if(selector==='button[data-act]')return [...this.innerHTML.matchAll(/data-act="([^"]+)"(?:\s+data-snapshot="([^"]+)")?/g)].map(m=>{const n=new Node(m[1]);n.dataset={act:m[1],...(m[2]?{snapshot:m[2]}:{})};actions.set(m[1],n);actionList.push(n);return n;});
      if(selector==='tr')return [];
      const ids=this.id==='app-form'?['f-company','f-title','f-url','f-location','f-notes','btn-save-app','btn-cancel-app']:['progress-description','progress-date','progress-round','progress-update','progress-save','progress-cancel'];
      return ids.map(el);
    }
  }
  function el(id){if(!nodes.has(id))nodes.set(id,new Node(id));return nodes.get(id);}
  globalThis.document={getElementById:el,addEventListener(){},body:{}};
  globalThis.window={confirm:()=>true,prompt:()=>null};
  el('app-stage').value='all';el('app-recycle').value='active';el('app-sort').value='updatedAt';
  const view=id=>({application:{id,company:`Company-${id}`,title:'Engineer',current_stage:'saved',recycle_state:'active',notes:'keep'},events:[]});
  const invoke=async(name,args)=>{calls.push({name,args});const custom=handler?.(name,args);if(custom!==undefined)return custom;
    if(name==='get_application_cmd')return view(args.id);
    if(name==='list_applications_cmd')return {total:2,items:[view('A').application,view('B').application]};
    return {};
  };
  const api=mountApplications(invoke);
  const select=async id=>{el('apps-tbody').emit('click',{target:{closest:()=>({dataset:{id}})}});await tick();};
  return {el,actions,actionList,calls,api,select,tick,view};
}

test('progress cancel and Escape never dispatch writes for any outcome',async()=>{
 const h=harness();await h.select('A');
 for(const kind of ['interview','assessment','offer','rejected','withdrawn','closed']){
   await h.actions.get(kind).emit('click');assert.equal(h.el('progress-dialog').open,true);
   h.el('progress-cancel').emit('click');assert.equal(h.el('progress-dialog').open,false);
   await h.actions.get(kind).emit('click');h.el('progress-dialog').emit('cancel');
 }
 assert.equal(h.calls.filter(c=>c.name.startsWith('record_')).length,0);
});

test('progress form defaults to history, transmits date and interview round',async()=>{
 const h=harness();await h.select('A');await h.actions.get('interview').emit('click');
 assert.equal(h.el('progress-update').checked,false);h.el('progress-round').value='2';h.el('progress-date').value='2026-08-21';
 await h.el('progress-form').emit('submit');
 const args=h.calls.find(c=>c.name==='record_interview_cmd').args.args;
 assert.equal(args.round,2);assert.equal(args.updateProgress,false);assert.deepEqual(args.occurred,{precision:'date',value:{date:'2026-08-21',time_zone:null}});
});

test('stale detail success and error cannot replace current selection',async()=>{
 const pending=[];const h=harness((name,args)=>name==='get_application_cmd'?new Promise((resolve,reject)=>pending.push({id:args.id,resolve,reject})):undefined);
 await h.select('A');await h.select('B');pending[1].resolve(h.view('B'));await h.tick();pending[0].resolve(h.view('A'));await h.tick();
 assert.equal(h.api.ctl.selectedId,'B');assert.match(h.el('app-detail').innerHTML,/Company-B/);assert.doesNotMatch(h.el('app-detail').innerHTML,/Company-A/);
 await h.select('A');await h.select('B');pending[3].resolve(h.view('B'));await h.tick();pending[2].reject(new Error('old failure'));await h.tick();assert.match(h.el('app-detail').innerHTML,/Company-B/);
});

test('edit clearing sends empty strings, save locks fields and Escape cannot discard inflight input',async()=>{
 let fail;const h=harness(name=>name==='update_application_cmd'?new Promise((_,reject)=>{fail=reject;}):undefined);
 await h.select('A');await h.actions.get('edit').emit('click');
 for(const id of ['f-url','f-location','f-notes'])h.el(id).value='';
 h.el('app-form').emit('input');const pending=h.el('app-form').emit('submit');
 assert.equal(h.el('f-company').disabled,true);h.el('app-form-dialog').emit('cancel');assert.equal(h.el('app-form-dialog').open,true);
 await h.el('app-form').emit('submit');assert.equal(h.calls.filter(c=>c.name==='update_application_cmd').length,1);
 const args=h.calls.find(c=>c.name==='update_application_cmd').args.args;assert.equal(args.notes,'');assert.equal(args.location,'');assert.equal(args.sourceUrl,'');
 fail(new Error('write failed'));await pending;assert.equal(h.el('app-form-dialog').open,true);assert.equal(h.el('f-company').disabled,false);assert.equal(h.el('f-notes').value,'');
 globalThis.window.confirm=()=>false;h.el('app-form-dialog').emit('cancel');assert.equal(h.el('app-form-dialog').open,true);
});

test('list falls back from an empty last page before rendering page count',async()=>{
 const h=harness((name,args)=>name==='list_applications_cmd'?{total:20,items:args.args.offset?[]:[{id:'A',company:'A',title:'x'}]}:undefined);
 h.api.ctl.setOffset(20);await h.api.refreshList();assert.equal(h.api.ctl.offset,0);assert.equal(h.el('apps-page').textContent,'1 / 1');
});

test('new selection survives completion of an earlier action',async()=>{
 let complete;const h=harness(name=>name==='confirm_submit_cmd'?new Promise(resolve=>{complete=resolve;}):undefined);
 await h.select('A');const pending=h.actions.get('submit').emit('click');await h.select('B');complete({});await pending;
 assert.equal(h.api.ctl.selectedId,'B');assert.match(h.el('app-detail').innerHTML,/Company-B/);
});

const fillEvent = (snapshot) => ({ id: 'e1', event_sequence: 2, event_type: 'fill_partial', occurred: { precision: 'unknown' }, recorded_at: '2026-09-12T08:00:00Z',
  payload: { kind: 'fill_event', outcome: 'partial', field_count: 12, filled_count: 9, unconfirmed_count: 3, template_name: '合成模板', snapshot_id: snapshot } });

test('a fill event with a stored snapshot opens it, with the disclaimer, escaped', async () => {
  const S = '66666666-6666-4666-8666-666666666666';
  const h = harness((name, args) => {
    if (name === 'get_application_cmd') return { ...h.view(args.id), events: [fillEvent(S)], snapshotStates: { [S]: 'stored' },
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
  await h.actions.get('snapshot').emit('click');
  await h.tick();
  const call = h.calls.find(c => c.name === 'get_snapshot_cmd');
  assert.deepEqual(call.args, { snapshotId: S });
  assert.equal(h.el('snapshot-dialog').open, true);
  const body = h.el('snapshot-body').innerHTML;
  assert.match(body, /不能/);
  assert.match(body, /姓名/);
  assert.match(body, /2 个疑似密码/);
  assert.doesNotMatch(body, /<img/);
  assert.match(body, /&lt;img/);
});

test('a snapshot still uploading or missing is described, not offered', async () => {
  for (const [state, pattern] of [['uploading', /上传中/], ['missing', /不可用/]]) {
    const S = '77777777-7777-4777-8777-777777777777';
    const h = harness((name, args) => name === 'get_application_cmd'
      ? { ...h.view(args.id), events: [fillEvent(S)], snapshotStates: { [S]: state }, snapshots: [] } : undefined);
    await h.select('A');
    const html = h.el('app-detail').innerHTML;
    assert.match(html, pattern, state);
    assert.doesNotMatch(html, /data-act="snapshot"/, state);
  }
});

test('a snapshot that cannot be read says so instead of showing part of it', async () => {
  const S = '66666666-6666-4666-8666-666666666666';
  const h = harness((name, args) => {
    if (name === 'get_application_cmd') return { ...h.view(args.id), events: [fillEvent(S)], snapshotStates: { [S]: 'stored' }, snapshots: [] };
    if (name === 'get_snapshot_cmd') return Promise.reject({ code: 'VALIDATION', message: 'file digest mismatch' });
    return undefined;
  });
  await h.select('A');
  await h.actions.get('snapshot').emit('click');
  await h.tick();
  assert.match(h.el('snapshot-body').innerHTML, /无法读取/);
  assert.doesNotMatch(h.el('snapshot-body').innerHTML, /姓名/);
});

test('a snapshot opened after another one is not overwritten when the first answers late', async () => {
  const A = '66666666-6666-4666-8666-666666666666';
  const B = '99999999-9999-4999-8999-999999999999';
  let releaseA;
  const h = harness((name, args) => {
    if (name === 'get_application_cmd') return { ...h.view(args.id), events: [], snapshotStates: {},
      snapshots: [{ snapshot_id: A, template_name: '旧模板', created_at: '2026-09-12T08:00:00Z' }, { snapshot_id: B, template_name: '新模板', created_at: '2026-09-12T09:00:00Z' }] };
    if (name === 'get_snapshot_cmd' && args.snapshotId === A) return new Promise(resolve => { releaseA = () => resolve(snapshotDoc('旧的内容')); });
    if (name === 'get_snapshot_cmd' && args.snapshotId === B) return snapshotDoc('新的内容');
    return undefined;
  });
  await h.select('A');
  const button = id => h.actionList.filter(node => node.dataset.snapshot === id).at(-1);
  button(A).emit('click');
  await h.tick();
  await button(B).emit('click');
  await h.tick();
  assert.match(h.el('snapshot-body').innerHTML, /新的内容/);
  releaseA();
  await h.tick();
  assert.match(h.el('snapshot-body').innerHTML, /新的内容/);
  assert.doesNotMatch(h.el('snapshot-body').innerHTML, /旧的内容/);
});

function snapshotDoc(value) {
  return { templateName: '合成模板', capturedAt: '2026-09-12T08:00:00.000Z', omittedFieldCount: 0,
    groups: [{ name: '经历', fields: [{ key: '描述', value }] }] };
}
