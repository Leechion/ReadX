const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const { AltHold } = require('../dist/alt-hold.js');

function gesture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const hold = new AltHold({ show: () => calls.push('show'), release: () => calls.push('release'), cancel: () => calls.push('cancel') });
  t.after(() => hold.dispose());
  return { calls, hold, tick: ms => t.mock.timers.tick(ms) };
}
test('holding Alt opens once and releasing selects once', t => {
  const { calls, hold, tick } = gesture(t);
  hold.press(); tick(259); assert.deepEqual(calls, []);
  hold.press(); tick(1); assert.deepEqual(calls, ['show']);
  hold.release(); hold.release(); assert.deepEqual(calls, ['show', 'release']);
});
test('a tap and Alt+Tab do not launch; a fresh hold still works', t => {
  const { calls, hold, tick } = gesture(t);
  hold.press(); tick(100); hold.release(); tick(400);
  hold.press(); hold.cancel(); tick(400); hold.release();
  assert.deepEqual(calls, []);
  hold.press(); tick(260); hold.release();
  assert.deepEqual(calls, ['show', 'release']);
});
test('Escape or another shortcut cancels a visible wheel without selecting', t => {
  const { calls, hold, tick } = gesture(t);
  hold.press(); tick(260); hold.cancel(); hold.release();
  assert.deepEqual(calls, ['show', 'cancel']);
});
test('Alt pressed with Ctrl/Shift/Meta never starts a timer', t => {
  const { calls, hold, tick } = gesture(t);
  hold.press(true); tick(500); hold.release(); assert.deepEqual(calls, []);
});
test('disposing a pending gesture cancels its delayed popup', t => {
  const { calls, hold, tick } = gesture(t);
  hold.press(); hold.dispose(); tick(500); assert.deepEqual(calls, []);
});
const geometry = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../web/src/lib/launcherGeometry.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, geometry);
test('all five inner sectors resolve to their workspace; center and gap cancel', () => {
  const { WHEEL_WORKSPACES, wheelPoint, innerWorkspaceAt } = geometry.exports;
  WHEEL_WORKSPACES.forEach((workspace, index) => {
    const point = wheelPoint(-90 + index * 72, 122);
    assert.equal(innerWorkspaceAt(point.x, point.y), workspace.id);
  });
  assert.equal(innerWorkspaceAt(360, 360), null);
  assert.equal(innerWorkspaceAt(540, 360), null);
});
test('outer ring selection follows project sectors for full and partial pages', () => {
  const { projectPlacement, projectSlotAt } = geometry.exports;
  for (const count of [1, 2, 3, 8]) {
    for (let index = 0; index < count; index++) {
      const point = projectPlacement(index, count);
      assert.equal(projectSlotAt(point.x, point.y, count), index);
    }
  }
  assert.equal(projectSlotAt(360, 360, 8), null);
  assert.equal(projectSlotAt(530, 360, 8), null);
  assert.equal(projectSlotAt(640, 360, 8), null);
  assert.equal(projectSlotAt(360, 107, 0), null);
});

test('DesktopLauncher respects enabled flag and toggles uIOhook/window visibility', t => {
  const Module = require('node:module');
  const origLoad = Module._load;
  let hookStarts = 0;
  let hookStops = 0;
  let windowShown = false;
  const listeners = new Map();
  const fakeWindow = {
    setAlwaysOnTop() {},
    setVisibleOnAllWorkspaces() {},
    setMenu() {},
    on() {},
    loadURL: () => Promise.resolve(),
    isVisible: () => windowShown,
    isDestroyed: () => false,
    setBounds() {},
    getBounds: () => ({ x: 0, y: 0, width: 720, height: 720 }),
    showInactive() { windowShown = true; },
    hide() { windowShown = false; },
    destroy() {},
    webContents: { send() {} },
  };
  let readyCb = null;
  const fakeElectron = {
    BrowserWindow: function () { return fakeWindow; },
    ipcMain: {
      on(ch, fn) { if (ch === 'readx-launcher:ready') readyCb = fn; },
      removeListener() {},
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 400, y: 400 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    systemPreferences: { isTrustedAccessibilityClient: () => true },
  };
  const fakeUiohook = {
    UiohookKey: { Alt: 56, AltRight: 3640 },
    uIOhook: {
      on(ev, fn) { listeners.set(ev, fn); },
      removeListener(ev) { listeners.delete(ev); },
      start() { hookStarts++; },
      stop() { hookStops++; },
    },
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (request === 'uiohook-napi') return fakeUiohook;
    return origLoad.apply(this, arguments);
  };
  t.after(() => { Module._load = origLoad; });
  delete require.cache[require.resolve('../dist/launcher.js')];
  const { DesktopLauncher } = require('../dist/launcher.js');
  const inst = new DesktopLauncher({
    url: 'http://127.0.0.1:8080',
    preload: 'preload.js',
    apiBase: 'http://127.0.0.1:8080',
    token: 'tok',
    enabled: false,
    main: () => null,
    restore() {},
    log() {},
  });
  t.after(() => inst.dispose());
  readyCb({ sender: fakeWindow.webContents });

  assert.equal(inst.isEnabled(), false);
  assert.equal(hookStarts, 0);
  inst.show();
  assert.equal(windowShown, false);

  inst.setEnabled(true);
  assert.equal(inst.isEnabled(), true);
  assert.equal(hookStarts, 1);
  inst.show();
  assert.equal(windowShown, true);

  inst.setEnabled(false);
  assert.equal(inst.isEnabled(), false);
  assert.equal(hookStops, 1);
  assert.equal(windowShown, false);
});
