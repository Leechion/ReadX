import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export interface BackupRoots { data: string; profile: string }
interface Entry { name: string; size: number; sha256: string }
export interface BackupManifest {
  format: 'readx-backup'; version: 1; createdAt: string;
  roots: BackupRoots; folders: BackupRoots; files: Entry[];
  external?: Record<string, string>;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function samePath(left: string, right: string): boolean { return path.relative(path.resolve(left), path.resolve(right)) === ''; }
async function hash(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
// Cache and process locks are replaceable; all user content and configuration remain.
const transient = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'Crashpad']);
async function copyTree(source: string, target: string, files?: Entry[], prefix = ''): Promise<void> {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const item of await fs.readdir(source, { withFileTypes: true })) {
    if ((prefix === 'data' || prefix === 'profile') && transient.has(item.name)) continue;
    const from = path.join(source, item.name), to = path.join(target, item.name);
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error(`备份不支持符号链接，请先将文件移入数据目录：${from}`);
    if (item.isDirectory()) await copyTree(from, to, files, name);
    else if (item.isFile()) {
      await fs.copyFile(from, to);
      if (files) files.push({ name, size: (await fs.stat(to)).size, sha256: await hash(to) });
    } else throw new Error(`无法归档特殊文件：${from}`);
  }
}

export async function createBackup(archive: string, roots: BackupRoots, browserState: string): Promise<void> {
  archive = path.resolve(archive);
  const physicalArchive = path.join(await fs.realpath(path.dirname(archive)), path.basename(archive));
  for (const root of Object.values(roots)) {
    const physicalRoot = await fs.realpath(root);
    if (inside(physicalRoot, physicalArchive) || inside(physicalArchive, physicalRoot)) throw new Error('备份必须保存在数据目录和桌面配置目录之外');
  }
  if (await exists(archive)) throw new Error('备份目标已存在，请选择新文件夹');
  const staging = `${archive}.partial-${process.pid}`;
  await fs.mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    const files: Entry[] = [];
    const folders = { data: 'data', profile: samePath(roots.data, roots.profile) ? 'data' : 'profile' };
    await copyTree(roots.data, path.join(staging, 'data'), files, 'data');
    if (folders.profile !== 'data') await copyTree(roots.profile, path.join(staging, 'profile'), files, 'profile');
    await fs.copyFile(browserState, path.join(staging, 'browser-state.json'));
    files.push({ name: 'browser-state.json', size: (await fs.stat(browserState)).size, sha256: await hash(path.join(staging, 'browser-state.json')) });
    const external: Record<string, string> = {};
    const database = path.join(staging, 'data/app/data/v2/reader.db');
    if (await exists(database)) {
      // Fold any committed WAL left by a forced server shutdown into the copied DB.
      const db = new DatabaseSync(database);
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        for (const row of db.prepare("SELECT pdf_path FROM documents WHERE pdf_path != ''").all()) {
          const file = String(row.pdf_path);
          if (!(await fs.stat(file)).isFile()) throw new Error(`论文原文件不可读：${file}`);
          if (inside(roots.data, file) || inside(roots.profile, file)) continue;
          const extension = ['.pdf', '.epub'].includes(path.extname(file).toLowerCase()) ? path.extname(file).toLowerCase() : '.bin';
          const sha256 = await hash(file), name = `external/${sha256}${extension}`;
          await fs.mkdir(path.join(staging, 'external'), { recursive: true });
          await fs.copyFile(file, path.join(staging, name));
          external[file] = name;
          if (!files.some(entry => entry.name === name)) files.push({ name, sha256, size: (await fs.stat(file)).size });
        }
      } finally { db.close(); }
      for (let index = files.length - 1; index >= 0; index--) {
        const entry = files[index]!;
        if (entry.name === 'data/app/data/v2/reader.db') {
          entry.size = (await fs.stat(database)).size;
          entry.sha256 = await hash(database);
        } else if (['data/app/data/v2/reader.db-wal', 'data/app/data/v2/reader.db-shm', 'data/app/data/v2/reader.db-journal'].includes(entry.name)) {
          if (!await exists(path.join(staging, entry.name))) files.splice(index, 1);
          else { entry.size = (await fs.stat(path.join(staging, entry.name))).size; entry.sha256 = await hash(path.join(staging, entry.name)); }
        }
      }
    }
    const manifest: BackupManifest = { format: 'readx-backup', version: 1, createdAt: new Date().toISOString(), roots, folders, files, external };
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await verifyBackup(staging);
    await fs.rename(staging, archive);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyBackup(archive: string): Promise<BackupManifest> {
  const manifest = JSON.parse(await fs.readFile(path.join(archive, 'manifest.json'), 'utf8')) as BackupManifest;
  if (manifest.format !== 'readx-backup' || manifest.version !== 1 || !Array.isArray(manifest.files)
    || !manifest.roots || typeof manifest.roots.data !== 'string' || typeof manifest.roots.profile !== 'string'
    || !manifest.folders || manifest.folders.data !== 'data' || !['data', 'profile'].includes(manifest.folders.profile)) throw new Error('不是受支持的 ReadX 备份');
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (typeof entry.name !== 'string' || entry.name.includes('\\') || entry.name.split('/').some(part => !part || part === '.' || part === '..')
      || path.isAbsolute(entry.name) || seen.has(entry.name)) throw new Error('备份清单包含非法路径');
    seen.add(entry.name);
    const file = path.join(archive, entry.name);
    if (!inside(archive, file)) throw new Error('备份路径越界');
    let current = archive;
    for (const segment of entry.name.split('/')) {
      current = path.join(current, segment);
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('备份包含符号链接');
    }
    const info = await fs.stat(file);
    if (!info.isFile() || info.size !== entry.size || await hash(file) !== entry.sha256) throw new Error(`备份文件损坏或缺失：${entry.name}`);
  }
  if (!seen.has('browser-state.json')) throw new Error('备份缺少桌面存储');
  for (const name of Object.values(manifest.external ?? {})) {
    if (!/^external\/[a-f0-9]{64}\.[a-z0-9]+$/.test(name) || !seen.has(name)) throw new Error('备份外部附件清单无效');
  }
  // Validate the SQLite copy without modifying the archived database.
  const dbFile = path.join(archive, manifest.folders.data, 'app/data/v2/reader.db');
  if (await exists(dbFile)) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const result = db.prepare('PRAGMA integrity_check').all();
      if (result.length !== 1 || Object.values(result[0]!)[0] !== 'ok') throw new Error('备份数据库完整性校验失败');
    } finally { db.close(); }
  }
  return manifest;
}

// Only absolute paths and JSON string values are rebased; prose is not rewritten.
function rebase(value: string, old: BackupRoots, roots: BackupRoots, external: Record<string, string> = {}): string {
  if (Object.hasOwn(external, value)) return path.join(roots.data, 'library', 'backup-assets', path.basename(external[value]!));
  const mappings: [keyof BackupRoots, string][] = [['data', old.data], ['profile', old.profile]];
  mappings.sort((a, b) => b[1].length - a[1].length);
  for (const [role, prefix] of mappings) {
    const normalized = value.replace(/\\/g, '/'), from = prefix.replace(/\\/g, '/').replace(/\/$/, '');
    const matches = /^[a-z]:/i.test(from) ? normalized.toLowerCase() : normalized;
    const expected = /^[a-z]:/i.test(from) ? from.toLowerCase() : from;
    if (matches === expected || matches.startsWith(expected + '/')) return path.join(roots[role], ...normalized.slice(from.length).split('/').filter(Boolean));
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return value;
    const visit = (item: unknown): unknown => typeof item === 'string' ? rebase(item, old, roots, external)
      : Array.isArray(item) ? item.map(visit)
      : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, visit(v)])) : item;
    return JSON.stringify(visit(parsed));
  } catch { return value; }
}

function migrateDatabase(file: string, old: BackupRoots, roots: BackupRoots, external: Record<string, string>): void {
  const db = new DatabaseSync(file);
  const quoted = (name: string) => '"' + name.replace(/"/g, '""') + '"';
  try {
    db.exec('BEGIN IMMEDIATE');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const table of tables) {
      const name = quoted(String(table.name));
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().filter(c => String(c.type).toUpperCase() === 'TEXT');
      for (const column of columns) {
        const field = quoted(String(column.name));
        const values = db.prepare(`SELECT DISTINCT ${field} AS value FROM ${name} WHERE typeof(${field})='text'`).all();
        for (const row of values) {
          const before = String(row.value), after = rebase(before, old, roots, external);
          if (after !== before) db.prepare(`UPDATE ${name} SET ${field}=? WHERE ${field}=?`).run(after, before);
        }
      }
    }
    if (tables.some(table => table.name === 'app_state')) {
      const row = db.prepare("SELECT value_json FROM app_state WHERE key='processing.policy.v1'").get();
      if (row) {
        const policy = JSON.parse(String(row.value_json)) as Record<string, unknown>;
        if (policy.library === 'allow') policy.library = 'ask';
        for (const scope of ['documents', 'projects', 'shelves']) {
          const rules = policy[scope] as Record<string, string> | undefined;
          if (rules) for (const key of Object.keys(rules)) if (rules[key] === 'allow') rules[key] = 'ask';
        }
        policy.revision = Number(policy.revision || 0) + 1;
        policy.restoredAt = new Date().toISOString();
        db.prepare("UPDATE app_state SET value_json=? WHERE key='processing.policy.v1'").run(JSON.stringify(policy));
      }
    }
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* The transaction may already have committed. */ }
    throw error;
  } finally { db.close(); }
}

export async function restoreBackup(archive: string, roots: BackupRoots, currentBrowserState?: string): Promise<void> {
  const manifest = await verifyBackup(archive);
  const physicalArchive = await fs.realpath(archive);
  for (const root of Object.values(roots)) {
    const physicalRoot = await exists(root) ? await fs.realpath(root) : path.resolve(root);
    if (inside(physicalRoot, physicalArchive) || inside(physicalArchive, physicalRoot)) throw new Error('备份源不能位于恢复目标中');
  }
  // Stage outer roots once; this also supports a custom data root nested in userData.
  const distinctRoots = Object.values(roots).map(root => path.resolve(root)).filter((root, i, all) => all.findIndex(other => samePath(root, other)) === i);
  const targets = distinctRoots.filter(root => !distinctRoots.some(other => !samePath(root, other) && inside(other, root)));
  const staged = targets.map(target => ({ target, stage: `${target}.restore-${process.pid}`, previous: `${target}.before-restore-${Date.now()}`, moved: false, installed: false }));
  try {
    for (const item of staged) {
      await fs.mkdir(item.stage, { recursive: false, mode: 0o700 });
      for (const role of ['profile', 'data'] as const) {
        if (!inside(item.target, roots[role])) continue;
        const destination = path.join(item.stage, path.relative(item.target, roots[role]));
        await fs.mkdir(destination, { recursive: true, mode: 0o700 });
        // Copy only files covered by the verified manifest, never unlisted archive content.
        const prefix = manifest.folders[role] + '/';
        for (const entry of manifest.files.filter(entry => entry.name.startsWith(prefix))) {
          const to = path.join(destination, ...entry.name.slice(prefix.length).split('/'));
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.copyFile(path.join(archive, entry.name), to);
          if (await hash(to) !== entry.sha256) throw new Error(`恢复文件校验失败：${entry.name}`);
        }
      }
    }
    const dataStage = staged.find(item => inside(item.target, roots.data))!;
    const restoredData = path.join(dataStage.stage, path.relative(dataStage.target, roots.data));
    for (const name of new Set(Object.values(manifest.external ?? {}))) {
      const destination = path.join(restoredData, 'library', 'backup-assets', path.basename(name));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(archive, name), destination);
      if (await hash(destination) !== manifest.files.find(entry => entry.name === name)!.sha256) throw new Error(`恢复外部附件校验失败：${name}`);
    }
    const dbFile = path.join(restoredData, 'app/data/v2/reader.db');
    if (await exists(dbFile)) migrateDatabase(dbFile, manifest.roots, roots, manifest.external ?? {});
    const migrateJSON = async (directory: string): Promise<void> => {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name);
        if (item.isDirectory()) await migrateJSON(file);
        else if (item.name.endsWith('.json')) {
          const before = await fs.readFile(file, 'utf8'), after = rebase(before, manifest.roots, roots, manifest.external ?? {});
          if (before !== after) await fs.writeFile(file, after);
        }
      }
    };
    await migrateJSON(restoredData);
    // Browser-origin storage is replayed into the new reader origin on next launch.
    const profileStage = staged.find(item => inside(item.target, roots.profile))!;
    const replay = path.join(profileStage.stage, path.relative(profileStage.target, roots.profile), 'readx-browser-restore.json');
    const browserState = await fs.readFile(path.join(archive, 'browser-state.json'), 'utf8');
    await fs.writeFile(replay, rebase(browserState, manifest.roots, roots, manifest.external ?? {}), { mode: 0o600 });
    for (const item of staged) {
      if (await exists(item.target)) { await fs.rename(item.target, item.previous); item.moved = true; }
      await fs.rename(item.stage, item.target); item.installed = true;
    }
    if (currentBrowserState && profileStage.moved) {
      const previousProfile = path.join(profileStage.previous, path.relative(profileStage.target, roots.profile));
      await fs.copyFile(currentBrowserState, path.join(previousProfile, 'readx-browser-restore.json'));
    }
    // Keep previous directories as a recoverable checkpoint, including all original browser data.
  } catch (error) {
    for (const item of [...staged].reverse()) {
      if (item.installed) await fs.rename(item.target, item.stage);
      if (item.moved) await fs.rename(item.previous, item.target);
    }
    throw error;
  } finally {
    for (const item of staged) await fs.rm(item.stage, { recursive: true, force: true });
  }
}
