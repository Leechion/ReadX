/**
 * Windows native acceptance fixture: run `node scripts/acceptance-runtime.mjs`
 * after `npm run build` and installing the project's Electron runtime.
 * Creates a new synthetic library/profile on every run. Close the test window
 * or create the run's stop-electron marker to stop its services. It does not
 * install Zotero, register protocols, or attach to a user's existing library.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('This native acceptance fixture requires Windows.');
for (const required of ['apps/server/bin/server.exe', 'apps/web/dist/index.html', 'apps/desktop/dist/main.js', 'node_modules/electron/dist/electron.exe']) {
  await fs.access(path.join(root, required));
}
const base = path.resolve(root, '../implement-stage/acceptance-2026-11-05');
await fs.mkdir(base, { recursive: true });
const run = await fs.mkdtemp(path.join(base, 'run-'));
const data = path.join(run, 'readx-data'), profile = path.join(run, 'electron-profile');
const fixtures = path.join(run, 'fixtures'), exports = path.join(run, 'exports');
for (const directory of [data, profile, fixtures, exports]) await fs.mkdir(directory, { recursive: true });
const pdf = await PDFDocument.create(); pdf.setTitle('ReadX Acceptance Paper'); pdf.setAuthor('Synthetic QA');
const font = await pdf.embedFont(StandardFonts.Helvetica);
const pages = ['The synthetic experiment uses 50 projection views.', 'This fixture reports a synthetic reconstruction result.'];
for (const [index, text] of pages.entries()) {
  const page = pdf.addPage([600, 800]);
  page.drawText('ReadX Acceptance Paper', { x: 50, y: 740, font, size: 22, color: rgb(0.1, 0.2, 0.4) });
  page.drawText(text, { x: 50, y: 670, font, size: 12 }); page.drawText(`PDF page ${index + 1}`, { x: 50, y: 40, font, size: 10 });
}
const pdfBytes = await pdf.save(), pdfFile = path.join(fixtures, 'acceptance-paper.pdf');
await fs.writeFile(pdfFile, pdfBytes);
const epub = new JSZip();
epub.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
epub.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
epub.file('book.opf', '<package><metadata><title>ReadX Acceptance EPUB</title><creator>Synthetic QA</creator></metadata><manifest><item id="one" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>');
epub.file('chapter.xhtml', '<html><body><h1>Acceptance Chapter</h1><p>A source-grounded note must retain its chapter context.</p><p>This EPUB contains only synthetic acceptance material.</p></body></html>');
const epubBytes = await epub.generateAsync({ type: 'nodebuffer' });
await fs.writeFile(path.join(fixtures, 'acceptance-book.epub'), epubBytes);
await fs.writeFile(path.join(fixtures, 'zotero-fixture.ris'), `TY  - JOUR\nTI  - ReadX Zotero Acceptance Paper\nAU  - QA, Synthetic\nJO  - Synthetic Acceptance Journal\nPY  - 2026\nN1  - Original Zotero acceptance note. Synthetic data only.\nL1  - ${pdfFile}\nER  - \n`);

const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|CBCT_AI|OPENAI|ANTHROPIC|MINERU|PADDLE|WORKBUDDY|ELECTRON_RUN_AS_NODE|NODE_OPTIONS/i.test(name)));
const server = spawn(path.join(root, 'apps/server/bin/server.exe'), ['--data-root', data, '--static', path.join(root, 'apps/web/dist'), '--exit-on-stdin-eof'], { cwd: data, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
server.stderr.on('data', bytes => process.stderr.write(bytes));
const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Server readiness timed out')), 30000);
  const lines = readline.createInterface({ input: server.stdout });
  lines.on('line', line => { if (line.startsWith('CBCT_V2_READY ')) { clearTimeout(timer); lines.close(); resolve(JSON.parse(line.slice(14))); } });
  server.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
});
const apiBase = `http://127.0.0.1:${ready.port}`;
const api = async (route, method = 'GET', body) => {
  const headers = { Authorization: `Bearer ${ready.token}` };
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(apiBase + route, { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const result = await response.json(); if (!response.ok) throw new Error(`${route}: ${response.status} ${result.error}`); return result;
};
const uploaded = new FormData(); uploaded.append('files', new Blob([pdfBytes], { type: 'application/pdf' }), 'acceptance-paper.pdf');
uploaded.append('files', new Blob([epubBytes], { type: 'application/epub+zip' }), 'acceptance-book.epub');
uploaded.append('metadata', JSON.stringify([{ localOnly: true, title: 'ReadX Acceptance Paper', authors: ['Synthetic QA'], venue: 'Synthetic Acceptance Journal', year: 2026 }, { localOnly: true }]));
const imported = await api('/v1/import/files', 'POST', uploaded);
if (imported.results.some(item => item.error)) throw new Error('Synthetic fixture import failed');
const documents = (await api('/v1/documents')).documents;
const paper = documents.find(item => item.format === 'pdf'), book = documents.find(item => item.format === 'epub');
for (const [index, text] of pages.entries()) await api(`/v1/documents/${paper.key}/pages/${index + 1}`, 'PUT', { text });
await api('/v1/categories', 'POST', { name: 'Acceptance Shelf', color: 'sky' });
await api(`/v1/documents/${paper.key}/meta`, 'PATCH', { categories: ['Acceptance Shelf'] });
await api(`/v1/annotations/${paper.key}`, 'POST', { page: 1, kind: 'question', quote: pages[0], note: 'Synthetic question: can this evidence be traced?' });
await api(`/v1/annotations/${book.key}`, 'POST', { page: null, kind: 'highlight', quote: 'A source-grounded note must retain its chapter context.', locator: { kind: 'epub', href: 'chapter.xhtml', blockStart: 1, blockEnd: 1, startOffset: 0, endOffset: 53 } });
await api('/v1/ideas', 'POST', { question: 'Acceptance hypothesis only', observation: 'A synthetic reading observation.', status: 'Idea', evidence: [{ id: 'qa-evidence', paperKey: paper.key, paperTitle: paper.title, origin: '个人笔记', page: 1, excerpt: 'Synthetic personal judgment.' }] });

const requests = [], receiverCalls = [];
const receiver = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  receiverCalls.push({ method: req.method, path: req.url, bytes: Buffer.concat(chunks).length });
  res.setHeader('Content-Type', 'application/json');
  if (req.url?.endsWith('/models')) res.end(JSON.stringify({ data: [{ id: 'acceptance-model' }] }));
  else res.end(JSON.stringify({ id: 'qa-completion', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
const receiverBase = `http://127.0.0.1:${receiver.address().port}/v1`;
let proxyBase = '';
const proxy = http.createServer((req, res) => {
  if ((req.headers.origin && req.headers.origin !== proxyBase) || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end(); return; }
  const upstream = http.request(apiBase + req.url, { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${ready.port}`, authorization: `Bearer ${ready.token}` } }, response => {
    requests.push({ method: req.method, route: req.url.split('?')[0], status: response.statusCode });
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  }); upstream.on('error', () => res.writeHead(502).end()); req.pipe(upstream);
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
proxyBase = `http://127.0.0.1:${proxy.address().port}`;
const runner = path.join(run, 'electron-runner'); await fs.mkdir(runner);
await fs.writeFile(path.join(runner, 'package.json'), JSON.stringify({ name: 'readx-acceptance', version: '1.0.3', main: 'bootstrap.cjs' }));
const stopFile = path.join(run, 'stop-electron');
await fs.writeFile(path.join(runner, 'bootstrap.cjs'), `const {app}=require('electron');const fs=require('node:fs');const log=${JSON.stringify(path.join(run,'bootstrap.log'))};app.setName('ReadX Acceptance');app.setPath('userData',${JSON.stringify(profile)});app.setPath('downloads',${JSON.stringify(exports)});const lock=app.requestSingleInstanceLock.bind(app);app.requestSingleInstanceLock=(...args)=>{const result=lock(...args);fs.appendFileSync(log,JSON.stringify({singleInstance:result}));return result;};setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopFile)}))app.quit()},500).unref();app.on('browser-window-created',(_event,window)=>window.webContents.on('did-finish-load',()=>window.setTitle('ReadX · 独立验收')));require(${JSON.stringify(path.join(root, 'apps/desktop/dist/main.js'))});`);
const desktop = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [runner], { cwd: runner, env: { ...environment, CBCT_DATA_ROOT: data, CBCT_V2_BROWSER_PROXY: proxyBase, ELECTRON_START_URL: proxyBase }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });
const log = await fs.open(path.join(run, 'electron.log'), 'a');
for (const stream of [desktop.stdout, desktop.stderr]) stream.on('data', bytes => void log.appendFile(bytes));
const status = { run, data, profile, fixtures, exports, proxyBase, receiverBase, serverPID: server.pid, desktopPID: desktop.pid, documents: documents.map(({ key, title, format }) => ({ key, title, format })) };
await fs.writeFile(path.join(base, 'latest.json'), JSON.stringify(status, null, 2));
const saveAudit = () => fs.writeFile(path.join(run, 'requests.json'), JSON.stringify({ requests, receiverCalls }, null, 2));
const auditTimer = setInterval(() => void saveAudit(), 500);
console.log(JSON.stringify(status, null, 2));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; clearInterval(auditTimer); await saveAudit(); await fs.writeFile(stopFile,'stop'); server.stdin.end(); proxy.close(); receiver.close(); setTimeout(() => process.exit(0), 1500).unref(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
desktop.on('exit', () => void stop());
