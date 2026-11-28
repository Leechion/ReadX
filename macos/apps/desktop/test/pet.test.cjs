const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadPetModule(t) {
  const origLoad = Module._load;
  let hookStarts = 0;
  let hookStops = 0;
  const listeners = new Map();
  const fakeWindow = {
    setAlwaysOnTop() {},
    setVisibleOnAllWorkspaces() {},
    setMenu() {},
    setIgnoreMouseEvents() {},
    on() {},
    once() {},
    loadURL: () => Promise.resolve(),
    isVisible: () => true,
    isDestroyed: () => false,
    setBounds() {},
    getBounds: () => ({ x: 100, y: 100, width: 280, height: 300 }),
    showInactive() {},
    focus() {},
    destroy() {},
    webContents: { send() {}, on() {} },
  };
  const ipcHandlers = new Map();
  const ipcListeners = new Map();
  let menuPopups = 0;
  const fakeElectron = {
    BrowserWindow: function () { return fakeWindow; },
    clipboard: { readText: () => 'https://arxiv.org/abs/2401.00001' },
    Menu: {
      buildFromTemplate: () => ({ popup() { menuPopups++; } }),
    },
    ipcMain: {
      handle(ch, fn) { ipcHandlers.set(ch, fn); },
      removeHandler(ch) { ipcHandlers.delete(ch); },
      on(ch, fn) { ipcListeners.set(ch, fn); },
      removeListener(ch) { ipcListeners.delete(ch); },
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 200, y: 200 }),
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
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
  delete require.cache[require.resolve('../dist/hook-manager.js')];
  delete require.cache[require.resolve('../dist/pet.js')];
  const petMod = require('../dist/pet.js');
  return {
    petMod,
    stats: () => ({ hookStarts, hookStops, menuPopups, ipcHandlers: ipcHandlers.size, ipcListeners: ipcListeners.size }),
  };
}

test('clampPetPosition enforces screen bounds while allowing edge-peek margins', t => {
  const { petMod } = loadPetModule(t);
  const { clampPetPosition } = petMod;
  const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];

  const normal = clampPetPosition(1000, 600, 280, 300, displays);
  assert.deepEqual(normal, { x: 1000, y: 600, peekEdge: 'none' });

  const leftPeek = clampPetPosition(-300, 300, 280, 300, displays);
  assert.equal(leftPeek.x, -67);
  assert.equal(leftPeek.peekEdge, 'left');

  const rightPeek = clampPetPosition(2500, 300, 280, 300, displays);
  assert.equal(rightPeek.x, 1920 - 280 + 67);
  assert.equal(rightPeek.peekEdge, 'right');

  const topClamp = clampPetPosition(400, -200, 280, 300, displays);
  assert.equal(topClamp.y, -42);

  const bottomClamp = clampPetPosition(400, 1200, 280, 300, displays);
  assert.equal(bottomClamp.y, 1080 - 168);
});

test('clampPetScale, petWindowDimensions, normalizeSkin and target validation work properly', t => {
  const { petMod } = loadPetModule(t);
  assert.equal(petMod.clampPetScale(0.2), 0.55);
  assert.equal(petMod.clampPetScale(2.5), 1.4);
  assert.equal(petMod.clampPetScale(Number.NaN), 1);
  assert.deepEqual(petMod.petWindowDimensions(1.2), { width: 230, height: 250 });
  assert.equal(petMod.normalizeSkin('qwen'), 'kuro');
  assert.equal(petMod.normalizeSkin('unknown'), 'kuro');

  assert.equal(petMod.isValidPetNavigateTarget({ kind: 'screen', screen: 'latex' }), true);
  assert.equal(petMod.isValidPetNavigateTarget({ kind: 'document', key: 'doc-1' }), true);
  assert.equal(petMod.isValidPetNavigateTarget({ kind: 'focus', action: 'start25' }), true);
  assert.equal(petMod.isValidPetNavigateTarget({ kind: 'focus', action: 'invalid' }), false);
  assert.equal(petMod.isValidPetNavigateTarget({ kind: 'screen', screen: 'evil' }), false);
  assert.equal(petMod.isValidPetNavigateTarget(null), false);
  assert.equal(petMod.clampPetOpacity(0.1), 0.45);
  assert.equal(petMod.normalizeAccessory('gradcap'), 'gradcap');
  assert.equal(petMod.normalizeAccessory('unknown'), 'bowtie');
  assert.equal(petMod.normalizeWaterReminder(45), 45);
  assert.equal(petMod.normalizeWaterReminder(99), 0);
});

test('DesktopPet persists settings and manages hook lifecycle cleanly', t => {
  const { petMod, stats } = loadPetModule(t);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readx-pet-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const settingsFile = path.join(tmpDir, 'pet-settings.json');

  const pet = new petMod.DesktopPet({
    url: 'http://127.0.0.1:3000/',
    preload: 'preload.js',
    apiBase: 'http://127.0.0.1:3000',
    token: 'test-token',
    settingsFile,
    main: () => null,
    restore: () => {},
    showLauncher: () => {},
    log: () => {},
  });

  assert.equal(pet.isEnabled(), true);
  assert.equal(stats().hookStarts, 1);

  pet.updateSettings({ clickThrough: true, scale: 1.2 });
  assert.equal(pet.getSettings().skin, 'kuro');
  assert.equal(pet.getSettings().clickThrough, true);

  pet.showContextMenu();
  assert.equal(stats().menuPopups, 1);

  pet.setEnabled(false);
  assert.equal(pet.isEnabled(), false);
  assert.equal(stats().hookStops, 1);

  pet.dispose();
  assert.equal(stats().ipcHandlers, 0);
  assert.equal(stats().ipcListeners, 0);
  const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(saved.skin, 'kuro');
  assert.equal(saved.enabled, false);
});
