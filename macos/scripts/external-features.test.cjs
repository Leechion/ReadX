const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(relative) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  new Function('exports', code)(exports);
  return exports;
}
const consent = load('apps/web/src/api/processingConsent.ts');
const capture = load('apps/desktop/src/browser-capture.ts');
const link = data => 'readx-capture://collect?data=' + encodeURIComponent(Buffer.from(JSON.stringify(data)).toString('base64'));
const challenge = {requestId:'plan-1',processing:{action:'test',documents:[],projects:[],materials:['private'],destinations:['example']}};
test('capture preserves Unicode metadata and excludes unknown fields', () => {
  const parsed = capture.parseBrowserCapture(link({url:'https://example.com/paper',title:'稀疏视角 CBCT',authors:['作者'],cookie:'secret'}));
  assert.equal(parsed.title,'稀疏视角 CBCT'); assert.equal(parsed.cookie,undefined);
  for (const data of [{url:'javascript:alert(1)'},{url:'https://user:pass@example.com/'},{url:'https://example.com',pdfUrl:'file:///private'},{url:'https://example.com',authors:[4]}]) assert.throws(()=>capture.parseBrowserCapture(link(data)));
  assert.throws(()=>capture.parseBrowserCapture(link({url:'https://example.com'}).replace('//collect','//other')));
});
test('cancelling consent never approves or replays the request', async t => {
  const oldFetch=global.fetch,oldWindow=global.window; t.after(()=>{global.fetch=oldFetch;global.window=oldWindow;});
  global.window={location:{href:'http://127.0.0.1:3000/'}};
  const calls=[]; global.fetch=async (url,init)=>{calls.push({url,init});return new Response(JSON.stringify(challenge),{status:428});};
  const unregister=consent.registerProcessingDecision(async()=>false);t.after(unregister);
  await assert.rejects(consent.processingFetch('http://127.0.0.1:3000/v1/ai/chat',{method:'POST',body:'private'}),error=>error.name==='AbortError');
  assert.equal(calls.length,1);
});
test('consent retries the same body once with grant and authentication', async t => {
  const oldFetch=global.fetch,oldWindow=global.window;t.after(()=>{global.fetch=oldFetch;global.window=oldWindow;});
  global.window={location:{href:'http://127.0.0.1:3000/'}};
  const calls=[]; global.fetch=async(url,init)=>{calls.push({url,init});return calls.length===1?new Response(JSON.stringify(challenge),{status:428}):calls.length===2?new Response(JSON.stringify({grant:'grant-1'})):new Response('ok');};
  const unregister=consent.registerProcessingDecision(async()=>true);t.after(unregister);
  const body=JSON.stringify({question:'private'});
  const response=await consent.processingFetch('http://127.0.0.1:3000/v1/ai/chat',{method:'POST',headers:{Authorization:'Bearer local'},body});
  assert.equal(response.status,200);assert.equal(calls.length,3);assert.match(calls[1].url,/processing\/approve$/);
  assert.equal(calls[2].init.body,body);assert.equal(calls[2].init.headers.get('X-ReadX-Processing-Grant'),'grant-1');assert.equal(calls[2].init.headers.get('Authorization'),'Bearer local');
});
test('denied policy is returned without asking for approval', async t => {
  const old=global.fetch;t.after(()=>global.fetch=old);
  global.fetch=async()=>new Response('denied',{status:403});
  const unregister=consent.registerProcessingDecision(async()=>{assert.fail('policy deny must not prompt');});t.after(unregister);
  assert.equal((await consent.processingFetch('/v1/ai/chat')).status,403);
});
