import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountApplications } from './applications-ui.js';

function harness(handler) {
  const nodes = new Map(), actions = new Map(), calls = [];
  const tick = () => new Promise(resolve => setImmediate(resolve));
  class Node {
    constructor(id) { this.id=id;this.value='';this.checked=false;this.open=false;this.disabled=false;this.innerHTML='';this.listeners={};this.classList={toggle(){},add(){},remove(){}}; }
    addEventListener(type,fn){this.listeners[type]=fn;}
    emit(type,event={}){return this.listeners[type]?.({preventDefault(){},...event});}
    showModal(){this.open=true;} close(){this.open=false;} focus(){}
    querySelectorAll(selector){
      if(selector==='button[data-act]')return [...this.innerHTML.matchAll(/data-act="([^"]+)"/g)].map(m=>{const n=new Node(m[1]);n.dataset={act:m[1]};actions.set(m[1],n);return n;});
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
  return {el,actions,calls,api,select,tick,view};
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
