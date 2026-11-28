// Real Chromium rendering, isolated library, fake model: no user data or paid API calls.
// Run: node_modules/electron/dist/electron.exe scripts/reader-smoke.cjs <paper.pdf>
const { app, BrowserWindow, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cbct-reader-smoke-'));
app.setPath('userData', path.join(workspace, 'electron-profile'));
if (!process.argv[2]) throw new Error('请提供本地带文本层的 PDF 路径：electron scripts/reader-smoke.cjs <paper.pdf>（论文文件不随代码发布）');
const fixture = path.resolve(process.argv[2]);
const originalPaperBytes = fs.readFileSync(fixture);
let server, upstream, window;

async function waitFor(expression, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`UI timeout: ${expression}`);
}
const click = (text) => window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})?.click()`);

app.whenReady().then(async () => {
  try {
    let modelCalls = 0;
    let releaseMetadata, releaseTranslation;
    const metadataGate = new Promise(resolve => { releaseMetadata = resolve; });
    const translationGate = new Promise(resolve => { releaseTranslation = resolve; });
    let blockNextMetadata = false, observeModelAbort, observeMetadataBlocked;
    const modelAborted = new Promise(resolve => { observeModelAbort = resolve; });
    const metadataBlocked = new Promise(resolve => { observeMetadataBlocked = resolve; });
    const chatRequests = [];
    upstream = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const user = input.messages.find((message) => message.role === 'user').content;
      const translating = input.messages[0].content.includes('逐段翻译');
      modelCalls++;
      if (input.stream) {
        chatRequests.push(input);
        response.setHeader('Content-Type', 'text/event-stream');
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '这段的核心假设需要结合原文理解。(Page 1)' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (!translating && blockNextMetadata) {
        blockNextMetadata = false;
        observeMetadataBlocked();
        await new Promise(resolve => response.once('close', resolve));
        observeModelAbort();
        return;
      }
      await (translating ? translationGate : metadataGate);
      const task = user.match(/「(motivation|method|reproduction)」/u)?.[1];
      if (task) {
        const finding = { k: '待核对设置', v: '论文未说明', page: null, excerpt: null };
        const content = task === 'reproduction'
          ? Object.fromEntries(['resources', 'environment', 'cost', 'missing', 'risks'].map(group => [group, [{ finding: { ...finding, k: group }, assessment: '仍需核对', action: '核对论文与仓库文档' }]]))
          : { sections: [{ title: task === 'motivation' ? '实验设计动机' : '模块与公式', fields: [finding] }] };
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
        return;
      }
      const content = translating ? { items: [...user.matchAll(/^\[(\d+)\] (.*)$/gm)].map((match) => ({ i: Number(match[1]), t: '这是用于核对原论文排版的中文译文。'.repeat(Math.max(1, Math.ceil(match[2].length / 50))) })) } : {
        title: 'Neural Attenuation Fields for Sparse-View CBCT Reconstruction',
        translatedTitle: '用于稀疏视角 CBCT 重建的神经衰减场', authors: ['Test Author'], venue: 'MICCAI', year: 2022,
      };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    fs.mkdirSync(path.join(workspace, 'app'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'app/config.json'), JSON.stringify({ model: 'fake-model', apiKey: 'test-only', baseURL: `http://127.0.0.1:${upstream.address().port}` }));
    const serverBin = process.platform === 'win32' ? 'server.exe' : 'server';
    server = spawn(path.join(root, 'apps/server/bin', serverBin), ['--data-root', workspace, '--static', path.join(root, 'apps/web/dist'), '--exit-on-stdin-eof'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const info = await new Promise((resolve, reject) => {
      let buffer = '';
      server.stdout.on('data', (chunk) => {
        buffer += chunk;
        const match = buffer.match(/CBCT_V2_READY (.+)\r?\n/);
        if (match) resolve(JSON.parse(match[1]));
      });
      server.once('error', reject);
      server.once('exit', (code) => reject(new Error(`server exit ${code}`)));
    });
    const origin = `http://127.0.0.1:${info.port}`;
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.url.startsWith(origin + '/v1/')) details.requestHeaders.Authorization = `Bearer ${info.token}`;
      callback({ requestHeaders: details.requestHeaders });
    });
    window = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    const errors = [];
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await window.loadURL(origin);
    await waitFor(`document.body.textContent.includes('已连接')`);
    const loaded = await window.webContents.executeJavaScript(`performance.getEntriesByType('resource').map(r => r.name)`);
    assert(!loaded.some((url) => url.includes('/ReaderScreen-') || url.includes('/pdf.worker')), 'library startup must not load PDF runtime');
    await click('＋ 导入 PDF / EPUB');
    await waitFor(`!!document.querySelector('input[type=file]')`);
    window.webContents.debugger.attach('1.3');
    const { root: dom } = await window.webContents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await window.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: dom.nodeId, selector: 'input[type=file]' });
    await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [fixture] });
    window.webContents.debugger.detach();
    await waitFor(`document.querySelector('.import-progress')?.dataset.stage === 'metadata'`);
    assert(await window.webContents.executeJavaScript(`!document.querySelector('.import-progress progress').hasAttribute('value')`), 'AI wait must not show a fake percentage');
    await new Promise(resolve => setTimeout(resolve, 2300));
    assert(await window.webContents.executeJavaScript(`document.querySelector('.import-progress').textContent.includes('服务连接正常') && /已用时 [2-9] 秒/.test(document.querySelector('.import-progress').textContent)`), 'elapsed time and live connection must update while model is waiting');
    fs.writeFileSync(path.join(workspace, 'import-metadata-progress.png'), (await window.webContents.capturePage()).toPNG());
    releaseMetadata();
    await waitFor(`document.querySelector('.import-progress')?.dataset.stage === 'translation' && document.querySelector('.import-progress progress')?.max > 0`);
    const translationTotal = await window.webContents.executeJavaScript(`document.querySelector('.import-progress progress').max`);
    assert(translationTotal > 0);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.import-progress progress').value`), 0, 'pending translation must not count as complete');
    assert.equal(await window.webContents.executeJavaScript(`fetch('/v1/documents').then(r => r.json()).then(r => r.total)`), 0, 'progress must appear before the document is committed');
    fs.writeFileSync(path.join(workspace, 'import-translation-progress.png'), (await window.webContents.capturePage()).toPNG());
    releaseTranslation();
    await waitFor(`!!document.querySelector('.app-dialog .text-good')`, 60000);
    await waitFor(`document.querySelector('.import-progress')?.dataset.stage === 'complete'`);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.import-progress progress').value / document.querySelector('.import-progress progress').max`), 1);
    assert(modelCalls > 1, 'import must recognize metadata and translate full text');
    await click('完成');
    await waitFor(`!!document.querySelector('.book-cover')`);
    assert(await window.webContents.executeJavaScript(`document.body.textContent.includes('用于稀疏视角 CBCT 重建的神经衰减场')`));
    const selectLibraryView = (label) => window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.library-sidebar nav button')).find(b => b.textContent.startsWith(${JSON.stringify(label)})).click()`);
    for (const layoutName of ['网格', '列表', '表格']) {
      await click(layoutName);
      await waitFor(`!!document.querySelector('[data-library-action="trash"]')`);
      await window.webContents.executeJavaScript(`document.querySelector('[data-library-action="trash"]').click()`);
      await waitFor(`!document.querySelector('[data-library-action="trash"]') && Array.from(document.querySelectorAll('.library-sidebar nav button')).some(b => b.textContent === '回收站1')`);
      assert(!(await window.webContents.executeJavaScript(`!!document.querySelector('.pdf-reader')`)), 'trash button must not open the reader');
      if (layoutName === '网格') {
        await window.reload();
        await waitFor(`Array.from(document.querySelectorAll('.library-sidebar nav button')).some(b => b.textContent === '回收站1') && !document.querySelector('[data-library-action="trash"]')`);
      }
      await selectLibraryView('回收站');
      await waitFor(`!!document.querySelector('[data-library-action="restore"]')`);
      await window.webContents.executeJavaScript(`document.querySelector('[data-library-action="restore"]').click()`);
      await waitFor(`!document.querySelector('[data-library-action="restore"]') && document.body.textContent.includes('回收站为空')`);
      await selectLibraryView('全部文档');
      await waitFor(`!!document.querySelector('[data-library-action="trash"]')`);
    }
    await window.reload();
    await waitFor(`!!document.querySelector('[data-library-action="trash"]')`);
    await click('网格');
    await waitFor(`!!document.querySelector('.book-cover')`);
    fs.writeFileSync(path.join(workspace, 'library-trash.png'), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`document.querySelector('.book-cover').click()`);
    await waitFor(`!!document.querySelector('.pdf-paper canvas') && !document.querySelector('button')?.disabled`);
    await click('原文译文');
    await waitFor(`document.querySelectorAll('.pdf-translated-block').length > 0`);
    const callsAfterImport = modelCalls;
    const samples = [];
    fs.writeFileSync(path.join(workspace, 'stage.txt'), 'resize-sampling');
    for (const width of [1280, 1920, 1536, 1920]) {
      window.setSize(width, 1080);
      await waitFor(`Array.from(document.querySelectorAll('.pdf-scroll')).every(s => { const c = s.querySelector('canvas'); return c && Math.abs(parseFloat(c.style.width) - Math.max(1, Math.floor(s.clientWidth - 40))) < 1; })`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const sample = await window.webContents.executeJavaScript(`new Promise(resolve => {
        setTimeout(() => resolve(['sampling-timeout']), 5000);
        const sizes = new Set(); let frames = 0;
        const sample = () => {
          sizes.add(Array.from(document.querySelectorAll('.pdf-paper canvas')).map(c => c.width + 'x' + c.height).join('|'));
          if (++frames === 90) resolve([...sizes]); else setTimeout(sample, 16);
        }; setTimeout(sample, 16);
      })`);
      assert.notEqual(sample[0], 'sampling-timeout');
      assert.equal(sample.length, 1, `fit-width oscillates at window width ${width}: ${sample}`);
      samples.push({ width, stableCanvas: sample[0] });
    }
    await waitFor(`Array.from(document.querySelectorAll('.toc-item')).some(b => /Introduction/i.test(b.textContent))`);
    const headings = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.toc-item')).map(b => b.textContent)`);
    assert(headings.length > 3, 'must infer sections beyond the title bookmark');
    await window.webContents.executeJavaScript(`document.querySelector('.pdf-reader').querySelectorAll('.reader-format-tools button')[1].click()`);
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.toc-item')).find(b => /Introduction/i.test(b.textContent)).click()`);
    await waitFor(`document.querySelector('.pdf-heading-focus') && document.querySelector('.pdf-scroll').scrollTop > 0`);
    await window.webContents.executeJavaScript(`Array.from(document.querySelector('.pdf-reader').querySelectorAll('button')).find(b => b.textContent === '适合宽度').click()`);
    const dragPanel = async (label, delta) => {
      const bounds = await window.webContents.executeJavaScript(`(() => { const r = document.querySelector('[aria-label="${label}"]').getBoundingClientRect(); return { x: r.x+r.width/2, y:r.y+r.height/2 }; })()`);
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...bounds, button: 'left', clickCount: 1 });
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bounds.x+delta, y:bounds.y, button:'left', buttons:1 });
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x:bounds.x+delta, y:bounds.y, button:'left', clickCount:1 });
      window.webContents.debugger.detach();
    };
    await dragPanel('调整目录宽度', 80);
    await waitFor(`Math.abs(document.querySelector('.reader-sidebar').getBoundingClientRect().width - 300) < 2`);
    await dragPanel('调整助读宽度', -100);
    await waitFor(`Math.abs(document.querySelector('.assistant-sidebar').getBoundingClientRect().width - 460) < 2`);
    await dragPanel('调整目录宽度', -1000);
    await waitFor(`document.querySelector('.reader-sidebar').dataset.open === 'false'`);
    await click('目录');
    await waitFor(`document.querySelector('.reader-sidebar').getBoundingClientRect().width >= 290`);
    const savedPanels = await window.webContents.executeJavaScript(`JSON.parse(localStorage.getItem('cbct.reader.panels'))`);
    assert.equal(savedPanels.toc, 300);
    assert.equal(savedPanels.assistant, 460);
    await window.webContents.executeJavaScript(`for (const label of ['调整目录宽度', '调整助读宽度']) document.querySelector('[aria-label="'+label+'"]').dispatchEvent(new MouseEvent('dblclick', { bubbles:true }));`);
    await waitFor(`Array.from(document.querySelectorAll('.pdf-scroll')).every(s => { const c=s.querySelector('canvas'); return c && Math.abs(parseFloat(c.style.width) - Math.max(1,Math.floor(s.clientWidth-40))) < 1; })`);
    assert.equal(modelCalls, callsAfterImport, 'reading cached translations must not call the model again');
    const fontMetrics = () => window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.pdf-translated-block')).map(b => { const t=b.querySelector('.pdf-translated-text'); return {role:b.dataset.role,fontSize:parseFloat(getComputedStyle(t).fontSize),lineHeight:parseFloat(getComputedStyle(t).lineHeight),overflow:b.dataset.overflow==='true',height:t.clientHeight,scrollHeight:t.scrollHeight}; })`);
    const typography = await fontMetrics();
    const bodyFonts = typography.filter(b => b.role === 'body').map(b => b.fontSize);
    assert(bodyFonts.length > 0, 'must recognize scientific body paragraphs');
    assert(Math.max(...bodyFonts)/Math.min(...bodyFonts) <= 1.15, 'body font sizes should be consistent across paragraphs');
    assert(typography.every(b => b.overflow || b.scrollHeight <= b.height+1), 'truncated text must expose a full-text action');
    const canvasBeforeFontChange = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.pdf-paper canvas')).map(c=>c.width+'x'+c.height).join('|')`);
    await window.webContents.executeJavaScript(`(() => { const select=document.querySelector('[aria-label="译文字号"]');select.value='1.2';select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await waitFor(`document.querySelector('[aria-label="译文字号"]').value === '1.2' && !!document.querySelector('.pdf-translation-expand')`);
    const larger = (await fontMetrics()).filter(b=>b.role==='body').map(b=>b.fontSize);
    assert(larger.every((size,index)=>size > bodyFonts[index]*1.05), 'translation size control should enlarge text without resizing the source');
    assert.equal(await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.pdf-paper canvas')).map(c=>c.width+'x'+c.height).join('|')`), canvasBeforeFontChange);
    await window.webContents.executeJavaScript(`document.querySelector('.pdf-translation-expand').click()`);
    await waitFor(`!!document.querySelector('[aria-label="段落译文"]')`);
    assert.equal(modelCalls,callsAfterImport,'expanding a translation must reuse existing translated text');
    assert.equal(await window.webContents.executeJavaScript(`parseFloat(getComputedStyle(document.querySelector('.paragraph-target')).fontSize)`),14);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭段落操作"]').click(); const select=document.querySelector('[aria-label="译文字号"]');select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));`);
    await waitFor(`!document.querySelector('[aria-label="段落操作"]') && document.querySelector('[aria-label="译文字号"]').value === '1'`);
    await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    fs.writeFileSync(path.join(workspace,'translation-layout.png'),(await window.webContents.capturePage()).toPNG());
    const layout = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.pdf-translated-block')).map(b => ({ left: b.offsetLeft, top: b.offsetTop, width: b.offsetWidth, height: b.offsetHeight, fontSize: getComputedStyle(b).fontSize }))`);
    assert(layout.length > 5, 'translation must preserve spatial text blocks');
    await waitFor(`Array.from(document.querySelector('.pdf-paper').querySelectorAll('.textLayer span')).some(s => s.textContent.length > 50)`);
    const coverage = await window.webContents.executeJavaScript(`(() => {
      const papers = [...document.querySelectorAll('.pdf-paper')];
      const source = papers[0].getBoundingClientRect(), target = papers[1].getBoundingClientRect();
      const boxes = [...papers[1].querySelectorAll('.pdf-translated-block')].map(b => b.getBoundingClientRect());
      const lines = [...papers[0].querySelectorAll('.textLayer span')].filter(s => s.textContent.length > 20 && s.getBoundingClientRect().width > s.getBoundingClientRect().height * 2);
      return lines.filter(s => {
        const r = s.getBoundingClientRect();
        const x = (r.left + r.right) / 2 - source.left + target.left;
        const y = (r.top + r.bottom) / 2 - source.top + target.top;
        return boxes.some(b => x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2);
      }).length / lines.length;
    })()`);
    assert(coverage >= 0.95, `missing translated text regions: ${(coverage * 100).toFixed(1)}% coverage`);
    await window.webContents.executeJavaScript(`(() => {
      const span = [...document.querySelector('.pdf-paper').querySelectorAll('.textLayer span')].find(s => s.textContent.length > 50);
      const range = document.createRange(); range.selectNodeContents(span);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const r = span.getBoundingClientRect();
      const options = { bubbles: true, clientX: (r.left+r.right)/2, clientY: (r.top+r.bottom)/2 };
      span.dispatchEvent(new MouseEvent('mouseup', options));
      span.dispatchEvent(new MouseEvent('click', options));
    })()`);
    await waitFor(`!!document.querySelector('[aria-label="选区批注"]')`);
    assert(!await window.webContents.executeJavaScript(`!!document.querySelector('[aria-label="段落操作"]')`), 'drag selection must not open paragraph actions');
    await window.webContents.executeJavaScript(`(() => {
      [...document.querySelector('[aria-label="选区批注"]').querySelectorAll('button')].find(b => b.textContent === '关闭').click();
      window.getSelection().removeAllRanges();
    })()`);
    await window.webContents.executeJavaScript(`(() => {
      const paper = document.querySelector('.pdf-paper');
      const span = [...paper.querySelectorAll('.textLayer span')].find(s => s.textContent.length > 50);
      const r = span.getBoundingClientRect();
      const options = { bubbles: true, clientX: (r.left+r.right)/2, clientY: (r.top+r.bottom)/2 };
      span.dispatchEvent(new MouseEvent('mousemove', options));
      span.dispatchEvent(new MouseEvent('click', options));
    })()`);
    await waitFor(`!!document.querySelector('[aria-label="段落操作"]') && !!document.querySelector('.pdf-paragraph-hover')`);
    const selectedParagraph = await window.webContents.executeJavaScript(`document.querySelector('.paragraph-source').textContent`);
    assert(selectedParagraph.length > 50);
    await click('翻译此段');
    await waitFor(`!!document.querySelector('[aria-label="段落译文"]')`);
    assert.equal(modelCalls, callsAfterImport, 'paragraph translation should reuse the imported cache');
    await click('就此段提问');
    await waitFor(`!!document.querySelector('[aria-label="提问段落"]')`);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.chat-paragraph-context p').textContent`), selectedParagraph);
    await click('发送');
    await waitFor(`document.body.textContent.includes('这段的核心假设需要结合原文理解。')`);
    assert.equal(chatRequests.length, 1);
    const question = chatRequests[0].messages.at(-1).content;
    assert(question.includes(selectedParagraph) && question.includes('Page 1'), 'paragraph question must include original source and correct page');
    await window.webContents.executeJavaScript(`(() => {
      const picker = document.querySelector('[aria-label="选择段落"]');
      picker.value = '1'; picker.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(`!!document.querySelector('[aria-label="段落操作"]')`);
    await click('下一页');
    await waitFor(`document.querySelector('input[aria-label="页码"]').value === '2' && !document.querySelector('[aria-label="段落操作"]')`);
    const callsBeforeFigurePage = modelCalls;
    await click('下一页');
    await waitFor(`document.querySelector('input[aria-label="页码"]').value === '3' && document.querySelectorAll('.pdf-paper[data-page="3"]').length === 2 && !!document.querySelector('.pdf-translation-mask')`);
    await waitFor(`Array.from(document.querySelectorAll('.pdf-scroll')).every(s => {const c=s.querySelector('canvas');return c && Math.abs(parseFloat(c.style.width)-Math.floor(s.clientWidth-40))<1;})`);
    await waitFor(`document.querySelectorAll('.pdf-paper[data-rendered-page="3"][data-rendering="false"]').length === 2`);
    await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    fs.writeFileSync(path.join(workspace,'translation-figures.png'),(await window.webContents.capturePage()).toPNG());
    assert.equal(modelCalls,callsBeforeFigurePage,'figure-page typography must reuse imported translations');
    await click('上一页');
    await waitFor(`document.querySelector('input[aria-label="页码"]').value === '2' && document.querySelectorAll('.pdf-paper[data-page="2"]').length === 2 && !!document.querySelector('.pdf-translation-mask')`);
    await click('精读');
    await waitFor(`!!document.querySelector('[aria-label="五重奏精读"]')`);
    const steps = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[aria-label="精读步骤"] [role=tab]')).map(b=>b.textContent)`);
    assert.equal(steps.length,5);
    await click('生成实验动机');
    await waitFor(`document.body.textContent.includes('实验设计动机') && document.body.textContent.includes('重新生成实验动机')`);
    await click('2. 方法公式');
    await click('生成方法公式');
    await waitFor(`document.body.textContent.includes('模块与公式') && document.body.textContent.includes('重新生成方法公式')`);
    await click('3. 实验配置');
    await waitFor(`document.body.textContent.includes('生成实验配置')`);
    await click('4. 结果分析');
    await waitFor(`document.body.textContent.includes('生成结果分析')`);
    await click('5. 代码复现');
    await click('生成代码复现');
    await waitFor(`document.body.textContent.includes('保存为复现核对清单') && document.body.textContent.includes('重新生成代码复现')`);
    await click('保存为复现核对清单');
    await waitFor(`document.body.textContent.includes('分析版本')`);
    await click('1. 实验动机');
    await waitFor(`document.querySelector('[aria-label="精读步骤"] [aria-selected="true"]').textContent.includes('实验动机') && document.body.textContent.includes('实验设计动机')`);
    assert.equal(errors.length, 0, errors.join('\n'));
    fs.writeFileSync(path.join(workspace, 'parallel.png'), (await window.webContents.capturePage()).toPNG());
    await click('书库');
    await waitFor(`!!document.querySelector('[data-library-action="trash"]')`);
    await window.webContents.executeJavaScript(`document.querySelector('[data-library-action="trash"]').click()`);
    await waitFor(`!document.querySelector('[data-library-action="trash"]')`);
    await selectLibraryView('回收站');
    await waitFor(`!!document.querySelector('[data-library-action="restore"]')`);
    const savedPaperFiles = fs.readdirSync(path.join(workspace, 'library')).filter(name => /\.(pdf|epub)$/i.test(name)).map(name => ({ file: path.join(workspace, 'library', name), bytes: fs.readFileSync(path.join(workspace, 'library', name)) }));
    assert(savedPaperFiles.length > 0, 'must check a real imported copy');
    await click('清空回收站');
    await waitFor(`!!document.querySelector('dialog[open] #empty-trash-title')`);
    assert(await window.webContents.executeJavaScript(`document.querySelector('dialog[open]').textContent.includes('原始位置的 PDF / EPUB 文件保留')`));
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.writeFileSync(path.join(workspace, 'empty-trash-confirm.png'), (await window.webContents.capturePage()).toPNG());
    await click('取消');
    await waitFor(`!document.querySelector('dialog[open]') && !!document.querySelector('[data-library-action="restore"]')`);
    await click('清空回收站');
    await waitFor(`!!document.querySelector('dialog[open] #empty-trash-title')`);
    await click('确认清空');
    await waitFor(`!document.querySelector('dialog[open]') && document.body.textContent.includes('回收站为空') && !document.querySelector('[data-library-action="restore"]')`);
    assert(await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === '清空回收站').disabled`));
    await window.reload();
    await waitFor(`document.body.textContent.includes('库里还没有论文')`);
    for (const saved of savedPaperFiles) assert.deepEqual(fs.readFileSync(saved.file), saved.bytes, 'clear trash must preserve the imported copy');
    assert.deepEqual(fs.readFileSync(fixture), originalPaperBytes, 'clear trash must preserve the original paper');
    blockNextMetadata = true;
    await click('＋ 导入 PDF / EPUB');
    await waitFor(`!!document.querySelector('input[type=file]')`);
    const selectFixtureAgain = async () => {
      window.webContents.debugger.attach('1.3');
      const { root: currentDOM } = await window.webContents.debugger.sendCommand('DOM.getDocument');
      const { nodeId: inputID } = await window.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: currentDOM.nodeId, selector: 'input[type=file]' });
      await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: inputID, files: [fixture] });
      window.webContents.debugger.detach();
    };
    await selectFixtureAgain();
    await waitFor(`document.querySelector('.import-progress')?.dataset.stage === 'metadata'`);
    await metadataBlocked;
    await click('取消请求');
    await waitFor(`document.querySelector('.import-progress')?.dataset.stage === 'cancelled'`);
    await Promise.race([modelAborted, new Promise((_, reject) => setTimeout(() => reject(new Error('cancel did not stop the model request')), 5000))]);
    assert.equal(await window.webContents.executeJavaScript(`fetch('/v1/documents').then(r => r.json()).then(r => r.total)`), 0, 'cancelled import must not leave a library entry');
    await selectFixtureAgain();
    await waitFor(`document.querySelector('.import-progress')?.dataset.stage === 'complete' && !!document.querySelector('.app-dialog .text-good')`, 60000);
    await click('完成');
    const report = { passed: true, modelCalls, outlineHeadings: headings.length, resizablePanels: savedPanels, quintetSteps: steps, paragraphActions: true, textSelectionPreserved: true, paragraphQuestions: chatRequests.length, translatedBlocks: layout.length, coverage, samples, screenshot: path.join(workspace, 'parallel.png') };
    report.trashRoundTripLayouts = ['grid', 'list', 'table'];
    report.trashPersistsAfterReload = true;
    report.importProgress = { liveBeforeCommit: true, modelWaitIndeterminate: true, elapsedAndHeartbeat: true, translationSegments: translationTotal, completion: true, cancellationAndRetry: true };
    report.translationTypography = {bodyFontMin:Math.min(...bodyFonts),bodyFontMax:Math.max(...bodyFonts),consistentBodyText:true,fontControl:true,fullTextExpansion:true,noExtraModelCalls:true};
    report.emptyTrash = { cancelPreservesEntries: true, clearedAfterReload: true, originalAndImportedFilesPreserved: true };
    fs.writeFileSync(path.join(workspace, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(workspace, 'error.txt'), String(error.stack || error));
    console.error(error);
    if (window) fs.writeFileSync(path.join(workspace, 'failure.png'), (await window.webContents.capturePage()).toPNG());
    console.error('Smoke workspace:', workspace);
    app.exit(1);
  } finally {
    server?.stdin.end();
    upstream?.close();
  }
});
