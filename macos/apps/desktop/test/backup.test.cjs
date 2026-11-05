const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createBackup, verifyBackup, restoreBackup } = require('../dist/backup.js');

async function fixture(t, sameRoot = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readx-archive-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'source-data'), profile = sameRoot ? data : path.join(root, 'source-profile');
  await fs.mkdir(path.join(data, 'app/data/v2'), { recursive: true });
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(path.join(data, 'library'), { recursive: true });
  await fs.writeFile(path.join(data, 'library/paper.pdf'), '%PDF-original');
  const external = path.join(root, 'external.pdf');
  await fs.writeFile(external, '%PDF-external');
  const db = new DatabaseSync(path.join(data, 'app/data/v2/reader.db'));
  db.exec('CREATE TABLE documents(id TEXT PRIMARY KEY, pdf_path TEXT); CREATE TABLE app_state(key TEXT PRIMARY KEY, value_json TEXT)');
  db.prepare('INSERT INTO documents VALUES(?,?)').run('paper', path.join(data, 'library/paper.pdf'));
  db.prepare('INSERT INTO documents VALUES(?,?)').run('external', external);
  db.prepare('INSERT INTO app_state VALUES(?,?)').run('cache', JSON.stringify({ file: path.join(data, 'library/paper.pdf'), note: 'my research judgment' }));
  db.close();
  await fs.writeFile(path.join(data, 'app/config.json'), JSON.stringify({ root: data }));
  await fs.writeFile(path.join(profile, 'profile-marker'), 'browser profile');
  const browserState = path.join(root, 'browser.json');
  await fs.writeFile(browserState, JSON.stringify({ version: 1, local: { research: 'notes' }, databases: [] }));
  return { root, roots: { data, profile }, browserState, archive: path.join(root, 'archive') };
}

for (const sameRoot of [false, true]) test(`archive restores files, browser state and rebased SQLite paths (${sameRoot ? 'shared' : 'separate'} roots)`, async t => {
  const f = await fixture(t, sameRoot);
  await createBackup(f.archive, f.roots, f.browserState);
  const manifest = await verifyBackup(f.archive);
  assert.ok(manifest.files.length >= 5);
  const data = path.join(f.root, 'target-data'), profile = sameRoot ? data : path.join(f.root, 'target-profile');
  await fs.mkdir(data); await fs.writeFile(path.join(data, 'previous'), 'keep me');
  if (!sameRoot) await fs.mkdir(profile);
  await restoreBackup(f.archive, { data, profile });
  assert.equal(await fs.readFile(path.join(data, 'library/paper.pdf'), 'utf8'), '%PDF-original');
  assert.equal(await fs.readFile(path.join(profile, 'profile-marker'), 'utf8'), 'browser profile');
  assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'readx-browser-restore.json'), 'utf8')).local.research, 'notes');
  assert.equal(JSON.parse(await fs.readFile(path.join(data, 'app/config.json'), 'utf8')).root, data);
  const db = new DatabaseSync(path.join(data, 'app/data/v2/reader.db'));
  assert.equal(db.prepare("SELECT pdf_path FROM documents WHERE id='paper'").get().pdf_path, path.join(data, 'library/paper.pdf'));
  const external = db.prepare("SELECT pdf_path FROM documents WHERE id='external'").get().pdf_path;
  assert.equal(await fs.readFile(external, 'utf8'), '%PDF-external');
  assert.equal(JSON.parse(db.prepare("SELECT value_json FROM app_state").get().value_json).file, path.join(data, 'library/paper.pdf'));
  db.close();
  const checkpoint = (await fs.readdir(f.root)).find(name => name.startsWith('target-data.before-restore-'));
  assert.equal(await fs.readFile(path.join(f.root, checkpoint, 'previous'), 'utf8'), 'keep me');
  // Migration must leave the archive itself intact and reusable.
  await verifyBackup(f.archive);
});

test('damaged backups and destination recursion are rejected before current data changes', async t => {
  const f = await fixture(t);
  await assert.rejects(createBackup(path.join(f.roots.data, 'bad'), f.roots, f.browserState), /之外/);
  await createBackup(f.archive, f.roots, f.browserState);
  await fs.writeFile(path.join(f.archive, 'data/library/paper.pdf'), 'tampered');
  await assert.rejects(restoreBackup(f.archive, f.roots), /损坏/);
  assert.equal(await fs.readFile(path.join(f.roots.data, 'library/paper.pdf'), 'utf8'), '%PDF-original');
});

test('restore retains denied rules and requires confirmation for previous allows', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(path.join(f.roots.data, 'app/data/v2/reader.db'));
  db.prepare('INSERT INTO app_state VALUES(?,?)').run('processing.policy.v1', JSON.stringify({revision:9,library:'allow',documents:{private:'deny',public:'allow'},shelves:{s1:'deny',s2:'allow'},projects:{p:'allow'}}));
  db.close();
  await createBackup(f.archive, f.roots, f.browserState);
  const data = path.join(f.root, 'new-data'), profile = path.join(f.root, 'new-profile');
  await restoreBackup(f.archive, {data,profile});
  const restored = new DatabaseSync(path.join(data, 'app/data/v2/reader.db'));
  const policy = JSON.parse(restored.prepare("SELECT value_json FROM app_state WHERE key='processing.policy.v1'").get().value_json);
  restored.close();
  assert.equal(policy.library,'ask');assert.equal(policy.documents.private,'deny');assert.equal(policy.documents.public,'ask');assert.equal(policy.shelves.s1,'deny');assert.equal(policy.shelves.s2,'ask');assert.equal(policy.projects.p,'ask');assert.equal(policy.revision,10);assert.ok(policy.restoredAt);
});

test('committed WAL data is checkpointed into the archive without losing recent records', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(path.join(f.roots.data, 'app/data/v2/reader.db'));
  db.exec('PRAGMA journal_mode=WAL');
  db.prepare('INSERT INTO app_state VALUES(?,?)').run('wal-note', JSON.stringify({ note: 'latest committed judgment' }));
  try { await createBackup(f.archive, f.roots, f.browserState); } finally { db.close(); }
  await verifyBackup(f.archive);
  const saved = new DatabaseSync(path.join(f.archive, 'data/app/data/v2/reader.db'), { readOnly: true });
  try { assert.equal(JSON.parse(saved.prepare("SELECT value_json FROM app_state WHERE key='wal-note'").get().value_json).note, 'latest committed judgment'); }
  finally { saved.close(); }
});

test('unlisted files are not installed during restore', async t => {
  const f = await fixture(t);
  await createBackup(f.archive, f.roots, f.browserState);
  await fs.writeFile(path.join(f.archive, 'data/unlisted.txt'), 'not in manifest');
  const data = path.join(f.root, 'restored'), profile = path.join(f.root, 'restored-profile');
  await restoreBackup(f.archive, { data, profile });
  await assert.rejects(fs.access(path.join(data, 'unlisted.txt')));
});

test('failed second directory installation rolls back both current directories', async t => {
  const f = await fixture(t);
  await createBackup(f.archive, f.roots, f.browserState);
  const data = path.join(f.root, 'rollback-data'), profile = path.join(f.root, 'rollback-profile');
  await fs.mkdir(data); await fs.mkdir(profile);
  await fs.writeFile(path.join(data, 'current'), 'current data');
  await fs.writeFile(path.join(profile, 'current'), 'current profile');
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (from === `${profile}.restore-${process.pid}` && to === profile) throw new Error('simulated installation failure');
    return rename(from, to);
  };
  try { await assert.rejects(restoreBackup(f.archive, { data, profile }), /simulated/); }
  finally { fs.rename = rename; }
  assert.equal(await fs.readFile(path.join(data, 'current'), 'utf8'), 'current data');
  assert.equal(await fs.readFile(path.join(profile, 'current'), 'utf8'), 'current profile');
});

test('offline worker waits for the application to exit, archives, and relaunches with its result', async t => {
  const f = await fixture(t);
  const planDir = path.join(f.root, 'plan');
  await fs.mkdir(planDir);
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)'], { stdio: 'ignore', windowsHide: true });
  const result = path.join(f.root, 'result.json'), marker = path.join(f.root, 'relaunched');
  await fs.writeFile(path.join(planDir, 'plan.json'), JSON.stringify({
    action: 'create', archive: f.archive, roots: f.roots, browserState: f.browserState,
    parents: [parent.pid], executable: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'restarted')`, '--'], result,
  }));
  const worker = spawn(process.execPath, ['--experimental-sqlite', path.join(__dirname, '../dist/backup-worker.js'), path.join(planDir, 'plan.json')], { stdio: 'pipe', windowsHide: true });
  let errors = '';
  worker.stderr.on('data', chunk => errors += chunk);
  const exited = new Promise((resolve, reject) => { worker.on('exit', resolve); worker.on('error', reject); });
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(fs.access(f.archive));
  assert.equal(await exited, 0, errors);
  await verifyBackup(f.archive);
  assert.match(JSON.parse(await fs.readFile(result, 'utf8')).message, /备份已完成/);
  for (let i = 0; i < 30; i++) {
    try { if (await fs.readFile(marker, 'utf8') === 'restarted') return; } catch { /* The detached child is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('worker did not relaunch the application');
});
