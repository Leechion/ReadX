import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A sandbox-labelled workspace executable starts with Low integrity on Windows.
// Create an ordinary user-cache file rather than copying the source ACL/label.
// Content-addressed paths allow updates while the previous server is running.
export function prepareServerRuntime(source) {
  if (process.platform !== 'win32') return source;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const runtimeRoot = path.join(local, 'CBCTReading', 'runtime');
  const cacheMetaPath = path.join(runtimeRoot, 'latest-runtime.json');
  const stat = fs.statSync(source);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheMetaPath, 'utf8'));
    if (
      cached &&
      cached.source === source &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      typeof cached.target === 'string' &&
      fs.existsSync(cached.target)
    ) {
      return cached.target;
    }
  } catch {
    // Recompute content hash on cache miss.
  }

  const body = fs.readFileSync(source);
  const hash = createHash('sha256').update(body).digest('hex');
  const dir = path.join(runtimeRoot, hash);
  const target = path.join(dir, 'server.exe');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(target)) {
    const staging = path.join(dir, `server-${process.pid}.tmp`);
    try {
      fs.writeFileSync(staging, body, { flag: 'wx' });
      fs.renameSync(staging, target);
    } finally {
      if (fs.existsSync(staging)) fs.unlinkSync(staging);
    }
  }
  try {
    fs.writeFileSync(
      cacheMetaPath,
      JSON.stringify({ source, size: stat.size, mtimeMs: stat.mtimeMs, target }),
      'utf8',
    );
  } catch {
    // Cache metadata is optional.
  }
  return target;
}
