import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBuilt } from './ensure-built.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveElectronRuntime() {
  try {
    const pkgPath = path.join(root, 'node_modules', 'electron', 'package.json');
    const sourceExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const runtimeDir = path.join(localAppData, 'ReadX', 'runtime', `electron-${pkg.version}-x64`);
    const stagedExe = path.join(runtimeDir, 'electron.exe');
    const stampFile = path.join(runtimeDir, '.readx-runtime-source');
    if (fs.existsSync(stagedExe) && fs.existsSync(stampFile) && fs.existsSync(sourceExe)) {
      const sourceStat = fs.statSync(sourceExe);
      const stagedStat = fs.statSync(stagedExe);
      if (stagedStat.size === sourceStat.size && fs.statSync(stampFile).mtimeMs >= sourceStat.mtimeMs) {
        return stagedExe;
      }
    }
  } catch {
    // Fall through to PowerShell staging script.
  }
  const prepared = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/prepare-electron-runtime.ps1')],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  if (prepared.status !== 0) throw new Error(prepared.stderr || '无法准备桌面运行时');
  return prepared.stdout.trim();
}

function isLocalPortOpen(port, timeoutMs = 60) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

ensureBuilt();
const executable = resolveElectronRuntime();
const env = { ...process.env, CBCT_DATA_ROOT: process.env.CBCT_DATA_ROOT || path.resolve(root, '..') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_START_URL;
delete env.CBCT_V2_ATTACH;
delete env.CBCT_V2_BROWSER_PROXY;

const vitePort = Number(process.env.CBCT_VITE_PORT ?? 5183);
if (await isLocalPortOpen(vitePort)) {
  const proxy = `http://127.0.0.1:${vitePort}`;
  const meta = await fetch(`${proxy}/v1/meta`, { signal: AbortSignal.timeout(400) })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  if (meta?.app === 'cbct-reading-v2' && path.resolve(meta.dataRoot).toLowerCase() === path.resolve(env.CBCT_DATA_ROOT).toLowerCase()) {
    env.CBCT_V2_BROWSER_PROXY = proxy;
    console.log('复用正在运行的本机书库服务。');
  }
}

const child = spawn(executable, [path.join(root, 'apps', 'desktop')], {
  cwd: root,
  env,
  detached: true,
  windowsHide: false,
  stdio: 'ignore',
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.unref();
console.log(`ReadX 桌面版已启动（PID ${child.pid}）。`);
