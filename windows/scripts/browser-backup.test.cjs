const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require('fake-indexeddb/auto');

// Compile the production browser module; exercise it with an IndexedDB implementation.
const moduleExports = {};
const source = fs.readFileSync(path.join(__dirname, '../apps/web/src/lib/browserBackup.ts'), 'utf8');
new Function('exports', ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(moduleExports);
const { captureBrowserBackup, restoreBrowserBackup } = moduleExports;
global.localStorage = {
  clear() { for (const key of Object.keys(this)) delete this[key]; },
  setItem(key, value) { this[key] = value; },
};
// Match Storage's enumerable keys: methods are on its prototype.
Object.setPrototypeOf(global.localStorage, { clear: global.localStorage.clear, setItem: global.localStorage.setItem });
delete global.localStorage.clear; delete global.localStorage.setItem;
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

test('browser backup restores notes, Blob assets, indexes and out-of-line keys after an origin change', async () => {
  localStorage.setItem('readx-research-workbench-v1', JSON.stringify({ notes: '研究判断' }));
  const opening = indexedDB.open('readx-slack', 3);
  opening.onupgradeneeded = () => {
    const items = opening.result.createObjectStore('items', { keyPath: 'id' });
    items.createIndex('title', 'title');
    opening.result.createObjectStore('assets');
  };
  const db = await request(opening);
  const tx = db.transaction(['items', 'assets'], 'readwrite');
  tx.objectStore('items').put({ id: 'paper', title: 'A paper', readAt: new Date('2026-11-05T00:00:00Z') });
  const blob = new Blob([new Uint8Array([0, 128, 255, 42])], { type: 'image/png' });
  tx.objectStore('assets').put({ blob, binary: new Uint8Array([1, 2, 3]).buffer }, 'image');
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = reject; });
  db.close();
  const saved = await captureBrowserBackup();
  await request(indexedDB.deleteDatabase('readx-slack'));
  localStorage.clear();
  localStorage.setItem('new-device', 'temporary');
  await restoreBrowserBackup(saved);
  assert.equal(localStorage['new-device'], undefined);
  assert.equal(JSON.parse(localStorage['readx-research-workbench-v1']).notes, '研究判断');
  const restored = await request(indexedDB.open('readx-slack'));
  assert.equal(restored.version, 3);
  const read = restored.transaction(['items', 'assets'], 'readonly');
  const item = await request(read.objectStore('items').index('title').get('A paper'));
  // Open another transaction after awaiting a request, as the previous one may have completed.
  const asset = await request(restored.transaction('assets').objectStore('assets').get('image'));
  assert.equal(item.id, 'paper');
  assert.equal(item.readAt.toISOString(), '2026-11-05T00:00:00.000Z');
  assert.equal(asset.blob.type, 'image/png');
  assert.deepEqual(new Uint8Array(await asset.blob.arrayBuffer()), new Uint8Array([0, 128, 255, 42]));
  assert.deepEqual(new Uint8Array(asset.binary), new Uint8Array([1, 2, 3]));
  restored.close();
  // Retry after an interrupted acknowledgement must be safe.
  await restoreBrowserBackup(saved);
});
