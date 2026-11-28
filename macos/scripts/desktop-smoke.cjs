// Exercise the real Electron main/preload + Go binary + production React bundle.
// Uses a generated PDF and an isolated legacy library; never calls paid models.
const { app, dialog, BrowserWindow } = require('electron');
const errorDialogs = [];
dialog.showMessageBox = async options => { if (options.type === 'error') errorDialogs.push(options.message); return { response: 0 }; };
dialog.showErrorBox = (title, detail) => errorDialogs.push(`${title}: ${detail}`);
app.on('will-quit', () => { if (errorDialogs.length) { console.error(errorDialogs); app.exit(1); } });
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const root = path.resolve(__dirname, '..');
const workspace = path.join(root, '.tmp-smoke', `desktop-${process.pid}`);
process.env.CBCT_DATA_ROOT = workspace;
app.setAppPath(path.join(root, 'apps', 'desktop'));
app.setPath('userData', path.join(workspace, 'electron'));
let tested = false;
const timeout = setTimeout(() => { console.error('Desktop smoke timed out'); app.exit(1); }, 60000);
async function waitFor(window, expression) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await Promise.race([window.webContents.executeJavaScript(expression), new Promise(resolve => setTimeout(() => resolve(false), 1000))]);
    if (result) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`UI did not become ready: ${expression}`);
}
async function api(window, route, method = 'GET', body) {
  const result = await window.webContents.executeJavaScript(`(async()=>{try{
    const {apiBase,token}=window.__CBCT_V2__;
    const response=await fetch(apiBase+${JSON.stringify(route)}, {method:${JSON.stringify(method)},signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))}});
    if(!response.ok) throw new Error('HTTP '+response.status+' '+await response.text());
    return await response.json();
    }catch(error){return {__smokeError:String(error?.message||error)};}
  })()`);
  if (result?.__smokeError) throw new Error(`${method} ${route}: ${result.__smokeError}`);
  return result;
}
app.on('browser-window-created', (_event, window) => {
  if (tested) return;
  tested = true;
  window.webContents.once('did-finish-load', async () => {
    let stage = 'initial reader readiness';
    try {
      await waitFor(window, '!!window.__CBCT_V2__ && !!document.querySelector(".library-sidebar")');
      stage = 'unauthenticated API rejection';
      const unauthorized = await window.webContents.executeJavaScript('fetch("/v1/documents").then(r=>r.status)');
      assert.equal(unauthorized, 401);
      stage = 'legacy fixture import';
      await api(window, '/v1/import', 'POST', {});
      const documents = await api(window, '/v1/documents');
      assert.equal(documents.total, 1);
      stage = 'render runtime';
      const rendering = await api(window, '/v1/render/status');
      assert.equal(rendering.available, true, JSON.stringify(rendering));
      stage = 'desktop update bridge';
      const updates = await window.webContents.executeJavaScript('window.__READX_DESKTOP_UPDATES__.check()');
      assert.equal(updates.state, 'unsupported');
      stage = 'reload and open imported document';
      await window.reload();
      await waitFor(window, '!!document.querySelector(".book-cover")');
      await window.webContents.executeJavaScript('document.querySelector(".book-cover").click()');
      await waitFor(window, '!!document.querySelector(".pdf-reader canvas")');
      stage = 'reader toolbar menus';
      const clickTool = async (selector, label) => {
        const clicked = await window.webContents.executeJavaScript(`(() => {
          const button = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find(item => item.firstElementChild?.textContent === ${JSON.stringify(label)});
          if (!button || button.disabled) return false;
          button.click();
          return true;
        })()`);
        assert(clicked, `Reader tool unavailable: ${label}`);
      };
      const category = label => clickTool('.reader-tool-trigger', label);
      const menuItem = label => clickTool('.reader-tool-item', label);
      await waitFor(window, 'document.querySelectorAll(".reader-tool-trigger:not(:disabled)").length === 3');
      assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".reader-tool-menu").length'), 0);
      await category('阅读');
      await waitFor(window, 'document.querySelector(".reader-tool-menu [aria-checked=true]")?.firstElementChild.textContent === "仅原文"');
      await menuItem('原文译文');
      await waitFor(window, '!!document.querySelector(".translation-divider") && !document.querySelector(".reader-tool-menu")');
      await category('阅读');
      await menuItem('仅原文');
      await waitFor(window, '!document.querySelector(".translation-divider")');
      await category('文献工具');
      await waitFor(window, '!!document.querySelector(".reader-tool-menu")');
      await menuItem('查找');
      await waitFor(window, 'document.activeElement?.getAttribute("aria-label") === "查找内容"');
      await window.webContents.executeJavaScript('document.querySelector("button[aria-label=关闭查找]").click()');
      await category('阅读辅助');
      await waitFor(window, 'document.querySelector(".reader-tool-menu")?.textContent.includes("精读五重奏")');
      await window.webContents.executeJavaScript('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
      await waitFor(window, '!document.querySelector(".reader-tool-menu") && document.activeElement?.firstElementChild?.textContent === "阅读辅助"');
      stage = 'read-aloud player and sentence tracking';
      await window.webContents.executeJavaScript(`(() => {
        window.readAloudUtterances = [];
        window.speechSynthesis.speak = utterance => { window.readAloudUtterances.push(utterance); };
        window.speechSynthesis.pause = () => {};
        window.speechSynthesis.resume = () => {};
      })()`);
      const clickListening = label => window.webContents.executeJavaScript(`[...document.querySelectorAll('.listening-dialog button, .listening-player button')]
        .find(button => button.textContent === ${JSON.stringify(label)} || button.getAttribute('aria-label') === ${JSON.stringify(label)}).click()`);
      const speechEvent = (index, event) => window.webContents.executeJavaScript(`window.readAloudUtterances[${index}].dispatchEvent(new Event(${JSON.stringify(event)}))`);
      const hasSentence = sentence => `[...(CSS.highlights.get('readx-speaking-sentence') ?? [])][0]?.toString() === ${JSON.stringify(sentence)}`;
      await category('阅读辅助');
      await menuItem('语音速听');
      await waitFor(window, '!!document.querySelector(".listening-dialog[open]")');
      await clickListening('开始朗读');
      await waitFor(window, '!!document.querySelector(".listening-player") && !document.querySelector(".listening-dialog[open]") && window.readAloudUtterances.length === 1');
      await speechEvent(0, 'start');
      await waitFor(window, hasSentence('Research paper.'));
      await clickListening('暂停');
      await waitFor(window, `document.querySelector('.listening-player [role=status]').textContent.includes('已暂停') && (${hasSentence('Research paper.')})`);
      await clickListening('继续');
      await speechEvent(0, 'end');
      await waitFor(window, 'window.readAloudUtterances.length === 2');
      await speechEvent(1, 'start');
      await waitFor(window, hasSentence('Introduction.'));
      await clickListening('停止');
      await waitFor(window, '!CSS.highlights.has("readx-speaking-sentence")');
      await clickListening('关闭播放器');
      stage = 'read aloud a repeated selected sentence';
      const selectedSentence = await window.webContents.executeJavaScript(`(() => {
        const layer = document.querySelector('[data-rendered-page="1"] .textLayer');
        const text = layer.querySelector('span').firstChild;
        const start = text.data.lastIndexOf('Research paper.');
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + 'Research paper.'.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        layer.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return selection.toString();
      })()`);
      assert.equal(selectedSentence, 'Research paper.');
      await waitFor(window, '!![...document.querySelectorAll("button")].find(button => button.textContent === "朗读选区")');
      await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button => button.textContent === "朗读选区").click()');
      await waitFor(window, 'document.querySelector(".listening-dialog select")?.value === "selection"');
      await clickListening('开始朗读');
      await waitFor(window, 'window.readAloudUtterances.length === 3');
      await speechEvent(2, 'start');
      await waitFor(window, `(${hasSentence('Research paper.')}) &&
        [...CSS.highlights.get('readx-speaking-sentence')][0].startOffset > 0`);
      await speechEvent(2, 'end');
      await waitFor(window, '!CSS.highlights.has("readx-speaking-sentence") && document.querySelector(".listening-player [role=status]").textContent === "朗读结束"');
      await clickListening('关闭播放器');
      stage = 'page text and next-page navigation';
      const source = await api(window, '/v1/documents/mac-smoke/pages/1');
      assert.match(JSON.stringify(source), /Research paper/);
      await waitFor(window, '!!document.querySelector("button[aria-label=下一页]:not(:disabled)")');
      await window.webContents.executeJavaScript('document.querySelector("button[aria-label=下一页]").click()');
      await waitFor(window, 'document.querySelector("input[aria-label=页码]").value === "2"');
      const locationDeadline = Date.now() + 5000;
      while ((await api(window, '/v1/documents/mac-smoke/location')).location?.page !== 2) {
        if (Date.now() > locationDeadline) throw new Error('Reading location did not persist');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const screenshot = await window.webContents.capturePage();
      stage = 'backend crash recovery';
      fs.writeFileSync(path.join(workspace, 'reader.png'), screenshot.toPNG());
      const beforeRestart = await api(window, '/v1/meta');
      process.kill(beforeRestart.pid, 'SIGKILL');
      const deadline = Date.now() + 15000;
      let recovered = false;
      while (Date.now() < deadline) {
        try {
          const afterRestart = await api(window, '/v1/meta');
          if (afterRestart.pid !== beforeRestart.pid) { recovered = true; break; }
        } catch { /* expected during the restart */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      console.log('Crash recovery request loop completed');
      assert(recovered, 'Go server must recover after an unexpected exit');
      assert.equal((await api(window, '/v1/documents/mac-smoke/location')).location.page, 2);
      assert.equal(errorDialogs.length, 0, 'Automatic recovery must not close the reader');
      stage = 'close-to-tray and window restoration';
      window.close();
      await new Promise(resolve => setTimeout(resolve, 200));
      assert(!window.isDestroyed(), 'Closing must preserve the main window');
      assert(!window.isVisible(), 'Closing must hide the main window to the tray');
      app.emit('activate');
      await waitFor(window, '!!window.__CBCT_V2__ && !!document.querySelector(".library-sidebar, .pdf-reader")');
      assert(window.isVisible(), 'Activation must restore the main window');
      assert(!window.isMinimized(), 'Activation must restore the main window');
      assert.equal((await api(window, '/v1/documents')).total, 1);
      console.log('Desktop smoke OK: real main/preload, auth, SQLite import, PDF reader, sentence tracking, render resources, update bridge, reading location, backend crash recovery and Dock activation.');
      console.log(`Evidence: ${path.join(workspace, 'reader.png')}`);
      clearTimeout(timeout);
      app.quit();
    } catch (error) {
      console.error(`Desktop smoke failed during ${stage}`);
      console.error(error);
      clearTimeout(timeout);
      app.once('will-quit', () => app.exit(1));
      app.quit();
    }
  });
});
(async () => {
  fs.mkdirSync(path.join(workspace, 'library'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'library', 'text'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'library', 'text', 'mac-smoke-v3.txt'), '=== Page 1 ===\nResearch paper. Introduction. A generated PDF for local testing.\n=== Page 2 ===\nMethods and results. No remote services are used.');
  fs.writeFileSync(path.join(workspace, 'queue.json'), JSON.stringify({ papers: [{ id: 'mac-smoke', title: 'ReadX macOS parity smoke', authors: ['ReadX test fixture'] }] }));
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of ['Research paper. Introduction. Research paper. A generated PDF for local testing.', 'Methods and results. No remote services are used.']) {
    pdf.addPage([595, 842]).drawText(text, { x: 35, y: 760, size: 12, font });
  }
  fs.writeFileSync(path.join(workspace, 'library', 'mac-smoke.pdf'), await pdf.save());
  // Legacy text is intentionally optional; PDF.js writes its extracted text back.
  require(path.join(root, 'apps', 'desktop', 'dist', 'main.js'));
})().catch(error => { console.error(error); app.exit(1); });
