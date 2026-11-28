// Real Electron/Go/React integration. Hook events are synthetic by default;
// READX_TEST_REAL_KEYS=1 opts into native Alt/Tab/Escape input. Never moves the mouse.
const { app, BrowserWindow, dialog, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const root = path.resolve(__dirname, '..');
const workspace = path.join(root, '.tmp-smoke', `launcher-${process.pid}`);
fs.mkdirSync(workspace, { recursive: true });
process.env.CBCT_DATA_ROOT = workspace;
app.setAppPath(path.join(root, 'apps/desktop'));
app.setPath('userData', path.join(workspace, 'electron'));
const errors = [];
dialog.showErrorBox = (title, detail) => errors.push(`${title}: ${detail}`);
dialog.showMessageBox = async options => { if (options.type === 'error') errors.push(options.message); return { response: 0 }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Launcher smoke timed out'); app.exit(1); }, 60000);
async function until(fn, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(60); }
  const states = await Promise.all(BrowserWindow.getAllWindows().map(async window => ({
    url: window.webContents.getURL(),
    text: await window.webContents.executeJavaScript('document.body.innerText.slice(0,1500)').catch(() => ''),
  })));
  throw new Error(`${message}\n${JSON.stringify(states, null, 2)}`);
}
const js = (window, expression) => window.webContents.executeJavaScript(expression);
async function api(window, route, method = 'GET', body) {
  return js(window, `(async()=>{const {apiBase,token}=window.__CBCT_V2__;const r=await fetch(apiBase+${JSON.stringify(route)},{method:${JSON.stringify(method)},headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))}});if(!r.ok)throw new Error(await r.text());return r.json()})()`);
}
function key(type, keycode, modifiers = {}) {
  if (process.env.READX_TEST_REAL_KEYS === '1') uIOhook.keyToggle(keycode, type === 'keydown' ? 'down' : 'up');
  else uIOhook.emit(type, { keycode, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, ...modifiers });
}
require(path.join(root, 'apps/desktop/dist/main.js'));
(async () => {
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows().length === 2, 'main and wheel windows not created');
  const main = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'ReadX');
  const wheel = BrowserWindow.getAllWindows().find(window => window !== main);
  assert(main && wheel);
  await until(() => js(main, '!!document.querySelector(".library-sidebar")'), 'library not ready');
  await until(() => js(wheel, '!!document.querySelector(".readx-wheel-center")'), 'wheel renderer not ready');
  assert.equal(wheel.isVisible(), false);
  assert(uIOhook.listenerCount('keydown') > 0, 'native keyboard hook must be installed');
  const area = screen.getPrimaryDisplay().workArea;
  let cursor = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  screen.getCursorScreenPoint = () => cursor;

  main.close();
  await until(() => !main.isVisible(), 'close must hide the main window');
  assert.equal(main.isDestroyed(), false);
  assert((await api(main, '/v1/meta')).pid > 0, 'server must stay running after close');
  key('keydown', UiohookKey.Alt); await delay(100); key('keyup', UiohookKey.Alt); await delay(300);
  assert.equal(wheel.isVisible(), false, 'a tap must not open the wheel');
  key('keydown', UiohookKey.Alt); key('keydown', UiohookKey.Tab); await delay(350); key('keyup', UiohookKey.Tab); key('keyup', UiohookKey.Alt);
  assert.equal(wheel.isVisible(), false, 'Alt+Tab must not open the wheel');

  const show = async () => { key('keydown', UiohookKey.Alt); await until(() => wheel.isVisible(), 'Alt hold did not open wheel'); };
  await show();
  assert.equal(main.isVisible(), false, 'showing the wheel must not restore the main window');
  assert.equal(await js(wheel, 'document.querySelectorAll(".readx-wheel-workspace").length'), 5);
  const screenshot = await wheel.webContents.capturePage();
  fs.writeFileSync(path.join(workspace, 'wheel.png'), screenshot.toPNG());
  // Release over the LaTeX inner sector. Coordinates use the actual window scale.
  const bounds = wheel.getBounds();
  const scale = bounds.width / 720;
  const angle = 126 * Math.PI / 180;
  cursor = { x: bounds.x + (360 + Math.cos(angle) * 122) * scale, y: bounds.y + (360 + Math.sin(angle) * 122) * scale };
  key('keyup', UiohookKey.Alt);
  await until(() => !wheel.isVisible() && main.isVisible(), 'release must restore main and dismiss wheel');
  await until(() => js(main, '!!document.querySelector(".latex-empty, .latex-projects")'), 'LaTeX list not opened');

  const project = await api(main, '/v1/latex/projects', 'POST', { title: '轮盘集成项目', engine: 'xelatex' });
  await show();
  await until(() => js(wheel, 'document.body.textContent.includes("轮盘集成项目")'), 'new LaTeX project not refreshed in outer ring');
  fs.writeFileSync(path.join(workspace, 'wheel-projects.png'), (await wheel.webContents.capturePage()).toPNG());
  await js(wheel, 'Array.from(document.querySelectorAll(".readx-wheel-project")).find(b=>b.textContent.includes("轮盘集成项目")).click()');
  key('keyup', UiohookKey.Alt);
  await until(() => js(main, '!!document.querySelector(".latex-workspace")'), 'outer ring project did not open');
  assert.equal((await api(main, `/v1/latex/projects/${project.id}`)).title, '轮盘集成项目');
  const pick = async selector => {
    await show();
    await js(wheel, `document.querySelector(${JSON.stringify(selector)}).click()`);
    await until(() => !wheel.isVisible(), 'wheel activation did not dismiss');
    key('keyup', UiohookKey.Alt);
  };
  await pick('button[aria-label="打开学术工作台"]');
  await until(() => js(main, '!!document.querySelector(".rw-layout")'), 'research workspace did not open');
  await show();
  await until(() => js(wheel, 'document.body.textContent.includes("学业看板")'), 'workbench entries not listed');
  await js(wheel, 'Array.from(document.querySelectorAll(".readx-wheel-project")).find(b=>b.textContent.includes("学业看板")).click()');
  await until(() => !wheel.isVisible(), 'workbench project did not activate'); key('keyup', UiohookKey.Alt);
  await until(() => js(main, 'document.querySelector(".rw-page-heading h1")?.textContent.includes("学业看板")'), 'workbench tab not selected');
  await pick('button[aria-label="打开PPT"]');
  await until(() => js(main, '!!document.querySelector(".presentation-studio")'), 'PPT workspace did not open');
  await pick('button[aria-label="打开摸鱼"]');
  await until(() => js(main, '!!document.querySelector(".slack-workspace")'), 'slack workspace did not open');
  await show();
  await until(() => js(wheel, 'document.body.textContent.includes("2048")'), 'slack entries not listed');
  await js(wheel, 'Array.from(document.querySelectorAll(".readx-wheel-project")).find(b=>b.textContent.includes("2048")).click()');
  await until(() => !wheel.isVisible(), 'game project did not activate'); key('keyup', UiohookKey.Alt);
  await until(() => js(main, '!!document.querySelector(".slack-game")'), 'game did not open');
  await pick('button[aria-label="打开个人书库"]');
  await until(() => js(main, '!!document.querySelector(".library-sidebar") && !document.querySelector(".slack-workspace")'), 'library did not reopen');
  await show(); key('keydown', UiohookKey.Escape); key('keyup', UiohookKey.Escape); key('keyup', UiohookKey.Alt);
  await until(() => !wheel.isVisible(), 'Escape must cancel wheel');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Launcher smoke OK: close-to-minimize, background server, Alt tap/hold/Tab/Escape, all five workspace routes, release navigation, live project refresh, LaTeX projects, workbench tabs and slack games.');
  console.log(`Evidence: ${path.join(workspace, 'wheel.png')}`);
  clearTimeout(timeout); app.quit();
})().catch(error => { for (const keycode of [UiohookKey.Alt, UiohookKey.Tab, UiohookKey.Escape]) if (process.env.READX_TEST_REAL_KEYS === '1') uIOhook.keyToggle(keycode, 'up'); console.error(error); clearTimeout(timeout); app.once('will-quit', () => app.exit(1)); app.quit(); });
