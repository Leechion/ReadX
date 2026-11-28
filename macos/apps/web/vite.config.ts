import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { ReadyInfo } from '@cbct/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const devInfoPath = path.resolve(here, '../server/dev-info.json');
const execFileAsync = promisify(execFile);

interface UpstreamResult {
  ok: boolean;
  status: number;
  contentType: string;
  body: Buffer;
}

async function fetchBookSource(url: string): Promise<UpstreamResult> {
  if (process.platform === 'win32') {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$response = Invoke-WebRequest -Uri $env:READX_UPSTREAM_URL -TimeoutSec 120 -UseBasicParsing
$stream = $response.RawContentStream
$memory = [System.IO.MemoryStream]::new()
$buffer = [byte[]]::new(65536)
while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
  if ($memory.Length + $read -gt 67108864) { throw '书籍文件超过 64 MiB' }
  $memory.Write($buffer, 0, $read)
}
$contentType = if ($response.Headers['Content-Type']) { $response.Headers['Content-Type'] } else { 'application/octet-stream' }
$payload = @{ status = [int]$response.StatusCode; contentType = $contentType; body = [Convert]::ToBase64String($memory.ToArray()) } | ConvertTo-Json -Compress
[Console]::Out.Write($payload)
`;
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: { ...process.env, READX_UPSTREAM_URL: url },
        windowsHide: true,
        maxBuffer: 90 * 1024 * 1024,
        encoding: 'utf8',
      },
    );
    const payload = JSON.parse(stdout) as { status: number; contentType: string; body: string };
    return {
      ok: payload.status >= 200 && payload.status < 300,
      status: payload.status,
      contentType: payload.contentType,
      body: Buffer.from(payload.body, 'base64'),
    };
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > 64 * 1024 * 1024) throw new Error('书籍文件超过 64 MiB');
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('书籍文件超过 64 MiB');
      }
      chunks.push(value);
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size),
  };
}

/**
 * 读取 Go server 写出的 dev-info.json：Vite dev proxy 用它把 /v1 转到本机 server，
 * 并在服务端注入 bearer token——这样 token 不必出现在渲染进程的 URL / 全局变量里，
 * 纯浏览器 dev（不带 Electron）也能直接联调。
 */
function readDevInfo(): ReadyInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(devInfoPath, 'utf8')) as Partial<ReadyInfo>;
    if (typeof raw.port !== 'number' || typeof raw.token !== 'string' || raw.token.length < 32) return null;
    return raw as ReadyInfo;
  } catch {
    return null;
  }
}

const info = readDevInfo();

function booksDevelopmentProxy(): Plugin {
  return {
    name: 'readx-books-development-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const requestURL = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (requestURL.pathname !== '/v1/books/search' && requestURL.pathname !== '/v1/books/download') {
          next();
          return;
        }
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end();
          return;
        }

        const upstreamURL = requestURL.pathname.endsWith('/search')
          ? checkedGutendexPage(requestURL.searchParams.get('page') ?? '')
          : checkedGutenbergDownload(requestURL.searchParams.get('url') ?? '');
        if (!upstreamURL) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: '书籍来源地址无效' }));
          return;
        }

        void fetchBookSource(upstreamURL)
          .then((response) => {
            res.statusCode = response.ok ? 200 : 502;
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Type', requestURL.pathname.endsWith('/search')
              ? 'application/json; charset=utf-8'
              : response.contentType || 'application/octet-stream');
            if (response.ok) {
              res.end(response.body);
              return;
            }
            res.end(JSON.stringify({ error: `书籍服务返回 HTTP ${response.status}` }));
          })
          .catch(() => {
            if (res.writableEnded) return;
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: '书籍服务暂时无法连接，请检查网络代理或稍后重试' }));
          });
      });
    },
  };
}

function checkedGutendexPage(value: string): string | null {
  try {
    const url = new URL(value);
    const search = url.searchParams.get('search') ?? '';
    if (url.protocol !== 'https:' || url.hostname !== 'gutendex.com' || url.pathname !== '/books/' ||
      url.username || url.password || !search || search.length > 120) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function checkedGutenbergDownload(value: string): string | null {
  try {
    const url = new URL(value);
    const validPath = url.pathname.startsWith('/ebooks/') &&
      (url.pathname.endsWith('.epub3.images') || url.pathname.endsWith('.txt.utf-8'));
    if (url.protocol !== 'https:' || !['www.gutenberg.org', 'gutenberg.org'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !validPath) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isAllowedDevOrigin(originHeader: string, devPort: number): boolean {
  try {
    const parsed = new URL(originHeader);
    if (parsed.protocol !== 'http:') return false;
    const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
    const effectivePort = parsed.port || '80';
    return allowedHosts.has(parsed.hostname) && effectivePort === String(devPort);
  } catch {
    return false;
  }
}

function devProxyOriginGuard(): Plugin {
  return {
    name: 'readx-dev-proxy-origin-guard',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (!pathname.startsWith('/v1/') && pathname !== '/v1' && pathname !== '/healthz') {
          next();
          return;
        }
        const devPort = server.config.server.port ?? 5183;
        const fetchSite = req.headers['sec-fetch-site'];
        const origin = req.headers.origin;
        if (
          (typeof fetchSite === 'string' && fetchSite === 'cross-site') ||
          (typeof origin === 'string' && origin.length > 0 && !isAllowedDevOrigin(origin, devPort))
        ) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: '拒绝跨站本地开发代理请求' }));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devProxyOriginGuard(), booksDevelopmentProxy()],
  server: {
    port: 5183,
    strictPort: true,
    host: '127.0.0.1',
    proxy: info
      ? {
          '/v1': {
            target: `http://127.0.0.1:${info.port}`,
            changeOrigin: false,
            headers: { Authorization: `Bearer ${info.token}` },
          },
          '/healthz': { target: `http://127.0.0.1:${info.port}`, changeOrigin: false },
        }
      : {},
  },
  build: {
    target: 'chrome120',
    outDir: 'dist',
    // 生产构建默认不带 sourcemap：本地发布包没必要携带完整源码映射。
    // 需要排查问题时用 CBCT_SOURCEMAP=1 构建。
    sourcemap: process.env.CBCT_SOURCEMAP === '1',
    // pdf.js worker 走独立 chunk，主包不内联，保证 CSP script-src 'self' 可守。
    chunkSizeWarningLimit: 900,
  },
  envPrefix: 'CBCT_',
});
