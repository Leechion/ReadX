import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = path.join(root, '.build-fingerprint');
const excluded = new Set(['node_modules', 'dist', 'bin', 'pdfjs', '.git', '.tmp-smoke']);
const sourcePattern = /\.(?:tsx?|css|html|json|mjs|go|mod|sum|sql|svg|png|ico|ttf)$/;

const watchedEntries = [
  'apps/web/src',
  'apps/web/public',
  'apps/web/index.html',
  'apps/web/package.json',
  'apps/web/vite.config.ts',
  'apps/web/tsconfig.json',
  'apps/web/tsconfig.node.json',
  'apps/desktop/src',
  'apps/desktop/package.json',
  'apps/desktop/tsconfig.json',
  'apps/server/cmd',
  'apps/server/internal',
  'apps/server/go.mod',
  'apps/server/go.sum',
  'packages/shared/src',
  'packages/shared/package.json',
  'packages/shared/tsconfig.json',
  'scripts',
  'package.json',
  'package-lock.json',
];

const outputs = [
  'apps/web/dist/index.html',
  'apps/desktop/dist/main.js',
  'packages/shared/dist/index.js',
  `apps/server/bin/server${process.platform === 'win32' ? '.exe' : ''}`,
];

function collectSources() {
  const files = [];
  let maxMtimeMs = 0;
  const maxByGroup = { web: 0, desktop: 0, shared: 0, server: 0 };

  function recordGroupMtime(relative, mtimeMs) {
    if (relative.startsWith('apps/web/') || relative.startsWith('apps\\web\\')) {
      if (mtimeMs > maxByGroup.web) maxByGroup.web = mtimeMs;
    } else if (relative.startsWith('apps/desktop/') || relative.startsWith('apps\\desktop\\')) {
      if (mtimeMs > maxByGroup.desktop) maxByGroup.desktop = mtimeMs;
    } else if (relative.startsWith('packages/shared/') || relative.startsWith('packages\\shared\\')) {
      if (mtimeMs > maxByGroup.shared) maxByGroup.shared = mtimeMs;
    } else if (relative.startsWith('apps/server/') || relative.startsWith('apps\\server\\')) {
      if (mtimeMs > maxByGroup.server) maxByGroup.server = mtimeMs;
    }
  }

  function visit(relative) {
    const absolute = path.join(root, relative);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        if (!excluded.has(name)) visit(path.join(relative, name));
      }
    } else if (sourcePattern.test(relative)) {
      files.push({ relative, absolute });
      if (stat.mtimeMs > maxMtimeMs) maxMtimeMs = stat.mtimeMs;
      recordGroupMtime(relative, stat.mtimeMs);
    }
  }

  for (const entry of watchedEntries) visit(entry);
  return { files, maxMtimeMs, maxByGroup };
}

function computeFingerprint(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relative);
    hash.update(fs.readFileSync(file.absolute));
  }
  return hash.digest('hex');
}

function outputsFreshEnough(maxByGroup) {
  try {
    const webOut = fs.statSync(path.join(root, outputs[0])).mtimeMs;
    const desktopOut = fs.statSync(path.join(root, outputs[1])).mtimeMs;
    const sharedOut = fs.statSync(path.join(root, outputs[2])).mtimeMs;
    const serverOut = fs.statSync(path.join(root, outputs[3])).mtimeMs;
    return (
      webOut >= maxByGroup.web &&
      desktopOut >= maxByGroup.desktop &&
      sharedOut >= maxByGroup.shared &&
      serverOut >= maxByGroup.server
    );
  } catch {
    return false;
  }
}

export function ensureBuilt() {
  const allOutputsExist = outputs.every((file) => fs.existsSync(path.join(root, file)));
  const { files, maxMtimeMs, maxByGroup } = collectSources();

  if (allOutputsExist && fs.existsSync(stamp)) {
    const stampStat = fs.statSync(stamp);
    if (stampStat.mtimeMs >= maxMtimeMs) {
      console.log('CBCT: build is up to date.');
      return;
    }
  }

  const fingerprint = computeFingerprint(files);
  if (allOutputsExist && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === fingerprint) {
    const now = new Date();
    try { fs.utimesSync(stamp, now, now); } catch {}
    console.log('CBCT: build is up to date.');
    return;
  }

  // If manual `npm run build` already updated all output binaries/bundles after the latest source edit,
  // record the fingerprint without forcing another 15s full build on desktop launch.
  if (allOutputsExist && outputsFreshEnough(maxByGroup)) {
    fs.writeFileSync(stamp, fingerprint);
    console.log('CBCT: build outputs are newer than sources; fingerprint updated.');
    return;
  }

  console.log('CBCT: source changed; building once…');
  const result = spawnSync(process.platform === 'win32' ? 'npm run build' : 'npm', process.platform === 'win32' ? [] : ['run', 'build'], {
    cwd: root, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const refreshed = collectSources();
  fs.writeFileSync(stamp, computeFingerprint(refreshed.files));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureBuilt();
}
