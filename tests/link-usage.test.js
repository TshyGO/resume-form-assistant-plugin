const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

async function setup() {
 const { createUsage } = await import('../link/usage.mjs');
 const requests=[]; let date=new Date('2026-10-12T00:00:00Z');
 const service=createUsage({store:{clientInstanceId:async()=> '11111111-1111-4111-8111-111111111111'},uuid:()=> '22222222-2222-4222-8222-222222222222',now:()=>date,
 send:async(message,options)=>{requests.push({message,options});return{status:'retryable'};}});
 return{service,requests,setDate:value=>date=new Date(value)};
}
test('old/unknown desktop skips usage and supported desktop gets one empty v3 signal without retries',async()=>{
 const {service,requests,setDate}=await setup();
 await service.touch();service.observe({mode:'ready',capabilities:['resume.read']});await service.touch();assert.equal(requests.length,0);
 service.observe({mode:'ready',capabilities:['usage.touch']});await Promise.all(Array.from({length:100},()=>service.touch()));
 assert.equal(requests.length,1);const {message,options}=requests[0];assert.equal(message.protocolVersion,3);assert.deepEqual(message.payload,{});
 assert.equal('archiveId' in message,false);assert.equal('installation_id' in message,false);assert.equal(options.retry,false);
 await service.touch();assert.equal(requests.length,1);setDate('2026-10-13T00:00:00Z');await service.touch();assert.equal(requests.length,2);
});
test('usage protocol rejects content, archive identity and unnegotiated v2 envelopes',async()=>{
 const {service,requests}=await setup();service.observe({mode:'ready',capabilities:['usage.touch']});await service.touch();
 const {validateRequest}=await import('../link/protocol/validate.mjs');const message=requests[0].message;await validateRequest(message);
 for(const modified of [{...message,protocolVersion:2},{...message,payload:{url:'https://private.test'}},{...message,archiveId:'11111111-1111-4111-8111-111111111111'}])await assert.rejects(validateRequest(modified));
});
test('plugin UI signals ignore initialization, hidden/synthetic input and send no field values',()=>{
 const handlers={};const calls=[];class Element{closest(){return null;}}
 const document={visibilityState:'visible',hasFocus:()=>true,addEventListener:(name,fn)=>handlers[name]=fn};
 vm.runInNewContext(readFileSync(require.resolve('../usage-signals.js'),'utf8'),{document,Element,chrome:{runtime:{sendMessage:async m=>calls.push(m)}}});
 assert.equal(calls.length,0);handlers.pointerdown({isTrusted:false});assert.equal(calls.length,0);
 handlers.keydown({isTrusted:true,target:new Element(),privateValue:'resume secret'});assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{type:'DESKTOP_USAGE_TOUCH'}]);
 document.visibilityState='hidden';handlers.pointerdown({isTrusted:true});assert.equal(calls.length,1);
});
test('worker accepts only extension UI origins and no additional message fields',async()=>{
 const {isUsageSender}=await import('../link/usage.mjs');const api={runtime:{id:'ours',getURL:path=>'chrome-extension://ours/'+path}};
 const message={type:'DESKTOP_USAGE_TOUCH'};
 for(const page of ['sidepanel.html','popup.html'])assert.equal(isUsageSender(api,message,{id:'ours',url:api.runtime.getURL(page)}),true);
 for(const sender of [{id:'ours',url:'https://private.test'},{id:'ours',url:api.runtime.getURL('ai-host.html')},{id:'other',url:api.runtime.getURL('sidepanel.html')},{}])assert.equal(isUsageSender(api,message,sender),false);
 assert.equal(isUsageSender(api,{...message,url:'private'}, {id:'ours',url:api.runtime.getURL('sidepanel.html')}),false);
});
