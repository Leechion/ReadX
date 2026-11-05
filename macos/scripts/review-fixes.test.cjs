const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(relative, dependencies) {
 const exports = {};
 const source = fs.readFileSync(path.join(__dirname, '../apps/web/src', relative),'utf8');
 const code = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 new Function('exports','require',code)(exports,name => dependencies[name] ?? {});
 return exports;
}
const client = load('api/client.ts',{'@cbct/shared':{isApiFailure: x => typeof x?.error === 'string'},'./processingConsent':load('api/processingConsent.ts',{})});
function stream(text) {
 let cancelled = false;
 const body = new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(text));},cancel(){cancelled=true;}});
 return { response:new Response(body), cancelled:()=>cancelled };
}
test('SSE propagates callback errors and cancels the upstream reader',async t=>{
 const previous=global.fetch;t.after(()=>global.fetch=previous);
 const input=stream('data: {"done":true,"text":"done"}\n');global.fetch=async()=>input.response;
 const cause=new Error('callback failure');
 await assert.rejects(client.streamChat({key:'p',question:'q'},()=>{throw cause;}),error=>error===cause);
 assert.equal(input.cancelled(),true);
});
test('SSE skips malformed JSON and returns on terminal frame without waiting for EOF',async t=>{
 const previous=global.fetch;t.after(()=>global.fetch=previous);
 const input=stream('data: broken\ndata: {"done":true,"text":"done"}\ndata: {"delta":"too late"}\n');global.fetch=async()=>input.response;
 const events=[];
 await client.streamChat({key:'p',question:'q'},event=>events.push(event));
 assert.equal(events.length,1);assert.equal(events[0].text,'done');assert.equal(input.cancelled(),true);
});
test('generate preserves HTTP errors instead of reporting transport failure',async t=>{
 const previous=global.fetch;t.after(()=>global.fetch=previous);
 global.fetch=async()=>new Response(JSON.stringify({error:'model unavailable'}),{status:503});
 await assert.rejects(client.api.generate('paper','method'),error=>error.status===503 && error.message==='model unavailable');
});

function hookHarness() {
 const slots=[]; let cursor=0,pending=[];
 const same=(a,b)=>a && b && a.length===b.length && a.every((item,i)=>Object.is(item,b[i]));
 const react={
  useState(initial){const i=cursor++;if(!slots[i])slots[i]={value:typeof initial==='function'?initial():initial};return [slots[i].value,next=>slots[i].value=typeof next==='function'?next(slots[i].value):next];},
  useRef(value){const i=cursor++;return slots[i]??(slots[i]={current:value});},
  useCallback(fn,deps){const i=cursor++;if(!same(slots[i]?.deps,deps))slots[i]={value:fn,deps};return slots[i].value;},
  useEffect(fn,deps){const i=cursor++;if(!same(slots[i]?.deps,deps))pending.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()};});},
 };
 const values=new Map();global.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 const hooks=load('hooks/useChat.ts',{'react':react,'../api/client':{api:{setStatus:async()=>{}}},'../lib/storage':{STORAGE_KEYS:{chatSessions:key=>'chat:'+key}}});
 const transport=async(_,chunk,signal)=>{chunk({delta:'partial answer'});await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));};
 return {
  values,
  render(key){cursor=0;pending=[];const hook=hooks.useChat(key,transport,false);pending.forEach(fn=>fn());return hook;},
  unmount(){slots.forEach(slot=>slot?.cleanup?.());},
 };
}
test('chat unmount preserves partial output marked incomplete',async()=>{
 const h=hookHarness();h.render('A');const hook=h.render('A');const running=hook.send('question');h.render('A');h.unmount();await running;
 const turns=JSON.parse(h.values.get('chat:A')).conversations.flatMap(c=>c.turns);
 assert.equal(turns[1].text,'partial answer');assert.equal(turns[1].completed,false);assert.match(turns[1].error,/已停止/);
});
test('switching papers flushes the old key without overwriting the new history',async()=>{
 const h=hookHarness();h.render('A');const hook=h.render('A');
 h.values.set('chat:B',JSON.stringify({active:'B',conversations:[{id:'B',title:'existing B',turns:[{id:'b',role:'user',text:'B question'}]}]}));
 const running=hook.send('A question');h.render('A');h.render('B');h.render('B');await running;
 assert.equal(JSON.parse(h.values.get('chat:A')).conversations[0].turns[1].text,'partial answer');
 assert.equal(JSON.parse(h.values.get('chat:B')).conversations[0].turns[0].text,'B question');h.unmount();
});
