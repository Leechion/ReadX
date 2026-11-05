import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, safeStorage, screen, shell, systemPreferences, Tray, type OpenDialogOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { BootstrapInfo, DesktopUpdateStatus, ReadyInfo } from '@cbct/shared';
import { UpdateController } from './update-controller';
import { checkForUpdateStatus, LATEST_RELEASE_URL } from './update-check';
import { downloadVerifiedUpdate } from './update-download';
import { MacInstallerUpdater } from './mac-installer-update';
import { createUpdateFetcher } from './update-fetch';
import { DesktopLauncher } from './launcher';
import { verifyBackup } from './backup';
import { parseBrowserCapture } from './browser-capture';

/**
 * Electron 壳只做三件事：拉起 Go server、等就绪、把本地 token 交给渲染进程。
 * 业务逻辑一律在 server 与 web 里，壳保持可替换（这也是 v2 相对旧版的主要结构变化）。
 */

// 与 packages/shared 的 READY_PREFIX 同值。这里刻意不 import 运行时模块：
// 本文件编译为 CommonJS，而 shared 只发 ESM，类型用 import type、常量本地重复。
const READY_PREFIX = 'CBCT_V2_READY ';
const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 4_000;
const DEFAULT_WINDOW_BOUNDS = { width: 1440, height: 900 };
const MIN_WINDOW_BOUNDS = { width: 1100, height: 660 };
const APP_ICON = path.join(__dirname, '..', process.platform === 'darwin' ? 'icon.png' : 'icon.ico');

if (process.platform === 'win32') app.setAppUserModelId('com.readx.desktop');

interface ServerHandle {
  info: ReadyInfo;
  child: ChildProcessWithoutNullStreams | null;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let launcher: DesktopLauncher | null = null;
let windowStateSaveTimer: NodeJS.Timeout | null = null;
let server: ServerHandle | null = null;
let allowedOrigin = '';
let stopping = false;
let stopRequested = false;
let recoveringServer = false;
let fatalServerDialog = false;
const restartTimes: number[] = [];
const pendingBrowserCaptures: string[] = process.argv.filter(arg => arg.startsWith('readx-capture:')).slice(0, 10);
app.on('open-url', (event, url) => { if (url.startsWith('readx-capture:')) { event.preventDefault(); pendingBrowserCaptures.push(url); void receiveBrowserCaptures(); } });
async function receiveBrowserCaptures(): Promise<void> {
  if (!server || !mainWindow) return;
  for (const raw of pendingBrowserCaptures.splice(0, 10)) {
    try {
      const capture = parseBrowserCapture(raw);
      const response = await net.fetch(originOf(startUrl(server)) + '/v1/capture/inbox', { method: 'POST', headers: { Authorization: `Bearer ${server.info.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(capture) });
      if (!response.ok) throw new Error('本地服务未保存采集信息');
      restoreMainWindow();
      await dialog.showMessageBox(mainWindow, { message: '采集已保存', detail: '打开「导入文档 → 浏览器采集收件箱」即可查看来源并选择下载。尚未发送至题录或 AI 服务。' });
    } catch (error) { dialog.showErrorBox('浏览器采集失败', describe(error)); }
  }
}

// Keep source launches and the packaged macOS app on the same persistent library.
if (process.platform === 'darwin' && !process.env.CBCT_DATA_ROOT) {
  app.setName('ReadX');
  app.setPath('userData', path.join(app.getPath('appData'), 'ReadX'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    pendingBrowserCaptures.push(...argv.filter(arg => arg.startsWith('readx-capture:')).slice(0, 10));
    void receiveBrowserCaptures();
    restoreMainWindow();
  });
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  setupUpdater();
  setupBackup();
  ipcMain.handle('readx-capture:enable', event => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('只允许主窗口启用采集');
    return app.isPackaged ? app.setAsDefaultProtocolClient('readx-capture') : app.setAsDefaultProtocolClient('readx-capture', process.execPath, [app.getAppPath()]);
  });
  const resultArg = process.argv.find(arg => arg.startsWith('--readx-backup-result='));
  if (resultArg) {
    const file = resultArg.slice('--readx-backup-result='.length);
    try {
      const result = JSON.parse(fs.readFileSync(file, 'utf8')) as { message: string };
      await dialog.showMessageBox({ message: 'ReadX 备份与恢复', detail: result.message });
      fs.unlinkSync(file);
    } catch (error) { dialog.showErrorBox('读取备份结果失败', describe(error)); }
  }

  // 页面内的应用内跳转一律拦回本地阅读页；但指向外部的 http(s) 链接
  // （如每日推荐的「论文来源」）交给系统浏览器打开——原先 setWindowOpenHandler
  // 一律 deny，导致 target="_blank" 的外链点了完全没反应（连提示都没有）。
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedReaderPopup(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1440,
            height: 900,
            minWidth: MIN_WINDOW_BOUNDS.width,
            minHeight: MIN_WINDOW_BOUNDS.height,
            title: 'ReadX · 阅读',
            icon: APP_ICON,
            backgroundColor: '#f6f2ea',
            webPreferences: {
              preload: path.join(__dirname, 'preload.js'),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              spellcheck: false,
              additionalArguments: server ? [`--cbct-api-base=${allowedOrigin}`, `--cbct-token=${server.info.token}`] : [],
            },
          },
        };
      }
      // 外链（target="_blank"）走系统浏览器；其余一律不开新窗口。
      if (isExternalHTTP(url) && !sameOrigin(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, target) => {
      if (sameOrigin(target)) return;
      event.preventDefault();
      // 外链交给系统浏览器，别把阅读页导航走；非 http(s) 仍然只做拦截提示。
      if (isExternalHTTP(target)) {
        void shell.openExternal(target);
        return;
      }
      void dialog.showMessageBox({
        type: 'warning',
        message: '已阻止离开本地阅读页的跳转',
        detail: target,
      });
    });
  });

  try {
    server = await startServer();
    allowedOrigin = originOf(startUrl(server));
  } catch (error) {
    dialog.showErrorBox('ReadX 启动失败', describe(error));
    app.quit();
    return;
  }

  createWindow();
  void receiveBrowserCaptures();
  setupLauncher();

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    restoreMainWindow();
  });
  app.on('before-quit', (event) => {
    stopping = true;
    launcher?.dispose();
    launcher = null;
    tray?.destroy();
    tray = null;
    if (!server || stopRequested) return;
    // 先拦住退出：子进程没关干净就 quit，会留下占着 SQLite 与端口的孤儿进程。
    event.preventDefault();
    stopRequested = true;
    stopping = true;
    void stopServer().finally(() => {
      stopping = true;
      app.quit();
    });
  });
}

function restoreMainWindow(): void {
  if (!mainWindow && server) createWindow();
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function setupLauncher(): void {
  if (!server) return;
  launcher = new DesktopLauncher({
    url: startUrl(server), preload: path.join(__dirname, 'preload.js'),
    apiBase: allowedOrigin, token: server.info.token,
    main: () => mainWindow, restore: restoreMainWindow, log: logLifecycle,
  });
  tray = new Tray(nativeImage.createFromPath(APP_ICON).resize({ width: 18, height: 18 }));
  tray.setToolTip('ReadX · 按住 Alt 呼出轮盘');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 ReadX', click: restoreMainWindow },
    { label: '打开快速轮盘', click: () => launcher?.show() },
    ...(process.platform === 'darwin' ? [{ label: '启用 Alt 轮盘（辅助功能权限）', click: () => {
      systemPreferences.isTrustedAccessibilityClient(true);
      launcher?.enableHook();
    } }] : []),
    { type: 'separator' },
    { label: '退出 ReadX', click: () => app.quit() },
  ]));
  tray.on('double-click', restoreMainWindow);
  if (process.platform !== 'darwin') tray.on('click', restoreMainWindow);
}

function setupUpdater(): void {
  const macUpdater = process.platform === 'darwin' ? new MacInstallerUpdater({
    currentVersion: app.getVersion(),
    arch: process.arch,
    cacheDir: path.join(app.getPath('userData'), 'updates'),
    fetch: createUpdateFetcher(net),
    openInstaller: file => shell.openPath(file),
    progress: percent => updates.onProgress(percent),
  }) : undefined;
  if (!macUpdater) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
  }

  const updates = new UpdateController({
    currentVersion: app.getVersion(),
    supported: app.isPackaged && ['win32', 'darwin'].includes(process.platform),
    check: () => macUpdater ? macUpdater.check() : checkForUpdateStatus(app.getVersion(), () => autoUpdater.checkForUpdates(), async () => {
      const response = await net.fetch(LATEST_RELEASE_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Release metadata HTTP ${response.status}`);
      return response.json();
    }),
    download: () => macUpdater ? macUpdater.download() : downloadVerifiedUpdate(autoUpdater),
    install: () => macUpdater ? macUpdater.install() : autoUpdater.quitAndInstall(true, true),
    publish: publishUpdateStatus,
  });
  if (!macUpdater) {
    autoUpdater.on('download-progress', progress => updates.onProgress(progress.percent));
    autoUpdater.on('error', error => updates.onError(error));
  }

  ipcMain.handle('readx-updates:status', () => updates.getStatus());
  ipcMain.handle('readx-updates:check', () => updates.check());
  ipcMain.handle('readx-updates:download', () => updates.download());
  ipcMain.handle('readx-updates:install', () => updates.install());
  ipcMain.handle('readx-sync:choose-folder', async () => {
    const options: OpenDialogOptions = {
      title: '选择 ReadX 同步文件夹',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('readx-sync:get-nutstore-password', () => {
    const file = path.join(app.getPath('userData'), 'sync-nutstore-secret.bin');
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(file)) return '';
    try { return safeStorage.decryptString(fs.readFileSync(file)); } catch { return ''; }
  });
  ipcMain.handle('readx-sync:set-nutstore-password', (_event, password: unknown) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储暂不可用');
    const file = path.join(app.getPath('userData'), 'sync-nutstore-secret.bin');
    if (typeof password !== 'string' || !password) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    }
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, safeStorage.encryptString(password), { mode: 0o600 });
    fs.renameSync(temporary, file);
  });
}

function publishUpdateStatus(status: DesktopUpdateStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('readx-updates:status', status);
}

function setupBackup(): void {
  const pending = path.join(app.getPath('userData'), 'readx-browser-restore.json');
  const checkSender = (event: Electron.IpcMainInvokeEvent) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('只允许主窗口执行备份操作');
  };
  ipcMain.handle('readx-backup:browser-state', event => {
    checkSender(event);
    return fs.existsSync(pending) ? fs.readFileSync(pending, 'utf8') : null;
  });
  ipcMain.handle('readx-backup:acknowledge', event => {
    checkSender(event);
    if (fs.existsSync(pending)) fs.unlinkSync(pending);
  });
  let busy = false;
  let prepared: { action: 'create' | 'restore'; archive: string } | null = null;
  ipcMain.handle('readx-backup:cancel', event => { checkSender(event); if (!busy) prepared = null; });
  ipcMain.handle('readx-backup:prepare', async (event, action: unknown) => {
    checkSender(event);
    if (busy || prepared) throw new Error('备份操作正在准备中');
    if (!server?.child || !server.child.pid) throw new Error('请使用独立桌面模式执行备份；当前后端由其他进程管理');
    if (action !== 'create' && action !== 'restore') throw new Error('未知备份操作');
    busy = true;
    try {
      const selection = await dialog.showOpenDialog(mainWindow!, { title: action === 'create' ? '选择备份保存位置（将在其中新建备份文件夹）' : '选择包含 manifest.json 的备份文件夹', properties: ['openDirectory', ...(action === 'create' ? ['createDirectory' as const] : [])] });
      if (selection.canceled || !selection.filePaths[0]) return false;
      const archive = action === 'create' ? path.join(selection.filePaths[0], `ReadX-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`) : selection.filePaths[0];
      if (action === 'restore') await verifyBackup(archive);
      const answer = await dialog.showMessageBox(mainWindow!, {
        type: 'warning', buttons: ['取消', action === 'create' ? '关闭应用并备份' : '关闭应用并恢复'], defaultId: 0, cancelId: 0,
        message: action === 'create' ? '创建完整备份' : '使用备份替换当前数据',
        detail: `${archive}\n操作会关闭应用，完成后自动重新启动。${action === 'create' ? '备份包含论文、笔记、聊天、独立文库和配置，可能包含服务密钥，请妥善保管。' : '当前数据会保留在原目录旁的检查点文件夹。恢复不是合并；跨设备的加密密码可能需要重新填写。'}`,
      });
      if (answer.response !== 1) return false;
      prepared = { action, archive };
      return true;
    } finally { busy = false; }
  });
  ipcMain.handle('readx-backup:run', async (event, action: unknown, browserState: unknown) => {
    checkSender(event);
    if (busy || !prepared || action !== prepared.action) throw new Error('请先选择并确认备份操作');
    if (!server?.child || !server.child.pid) throw new Error('本地服务已退出，请重启后再操作');
    if (typeof browserState !== 'string' || JSON.parse(browserState).version !== 1) throw new Error('桌面存储快照无效');
    const { archive } = prepared;
    prepared = null;
    busy = true;
    let launched = false;
    try {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readx-backup-'));
      const stateFile = path.join(directory, 'browser-state.json');
      fs.writeFileSync(stateFile, browserState, { mode: 0o600 });
      const result = path.join(os.tmpdir(), `readx-backup-result-${Date.now()}.json`);
      const plan = path.join(directory, 'plan.json');
      fs.writeFileSync(plan, JSON.stringify({ action, archive, roots: { data: server.info.dataRoot, profile: app.getPath('userData') }, browserState: stateFile,
        parents: [process.pid, server.child.pid], executable: process.execPath,
        args: app.isPackaged ? [] : [app.getAppPath()], result }), { mode: 0o600 });
      await mainWindow!.webContents.session.flushStorageData();
      const worker = spawn(process.execPath, [path.join(__dirname, 'backup-worker.js'), plan], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); });
      worker.unref();
      launched = true;
      setTimeout(() => app.quit(), 100);
      return true;
    } finally { if (!launched) busy = false; }
  });
}

async function startServer(previous?: ReadyInfo): Promise<ServerHandle> {
  // A browser-mode library may already be serving this data root. Reuse its
  // authenticated local Vite proxy instead of running two job workers on one DB.
  if (!app.isPackaged && process.env.CBCT_V2_BROWSER_PROXY) {
    const proxy = new URL(process.env.CBCT_V2_BROWSER_PROXY);
    if (proxy.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname)
      || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) {
      throw new Error('浏览器兼容服务必须使用本机 HTTP 根地址');
    }
    const response = await net.fetch(new URL('/v1/meta', proxy).toString(), { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`现有书库服务返回 HTTP ${response.status}`);
    const meta = await response.json() as ReadyInfo & { app: string };
    if (meta.app !== 'cbct-reading-v2' || typeof meta.dataRoot !== 'string'
      || path.resolve(meta.dataRoot).toLowerCase() !== path.resolve(process.env.CBCT_DATA_ROOT || '').toLowerCase()) {
      throw new Error('现有服务的数据目录与桌面启动目录不一致');
    }
    return { info: { host: proxy.hostname, port: Number(proxy.port || 80), token: '', dataRoot: meta.dataRoot, dbPath: meta.dbPath, pid: meta.pid }, child: null };
  }
  // attached 模式：dev.mjs 已经起了 server（Vite proxy 要读它的 dev-info.json），壳只连接。
  if (process.env.CBCT_V2_ATTACH === '1') {
    const info = readDevInfo();
    if (!info) {
      throw new Error('CBCT_V2_ATTACH=1 但缺少 apps/server/dev-info.json，请用 npm run dev 启动。');
    }
    return { info, child: null };
  }

  const binary = serverBinary();
  const args: string[] = ['--exit-on-stdin-eof'];
  if (previous) args.push('--port', String(previous.port));
  // Packaged installs keep the user's library/config outside Program Files;
  // development still defaults to the repository root via the Go server.
  const dataRoot = process.env.CBCT_DATA_ROOT || app.getPath('userData');
  args.push('--data-root', dataRoot);

  fs.mkdirSync(dataRoot, { recursive: true });
  const webDist = app.isPackaged
    ? path.join(process.resourcesPath, 'web', 'dist')
    : path.resolve(app.getAppPath(), '..', 'web', 'dist');
  // dev 下前端由 Vite 提供；只有直接跑壳（npm start / 打包）才让 server 托管静态页。
  if (!process.env.ELECTRON_START_URL && fs.existsSync(webDist)) args.push('--static', webDist);

  const child = spawn(binary, args, {
    cwd: dataRoot ?? app.getAppPath(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...renderEnvironment(), CBCT_DATA_ROOT: dataRoot, CBCT_SERVER_TOKEN: previous?.token || '' },
  });

  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
    process.stderr.write(`[server] ${chunk}`);
  });
  child.stdout?.setEncoding('utf8');
  child.on('error', (error) => {
    logLifecycle(`后端进程错误：${error.message}`);
  });

  let info: ReadyInfo;
  try {
    info = await waitForReady(child);
  } catch (error) {
    child.kill();
    await waitForExit(child, SHUTDOWN_GRACE_MS);
    throw error;
  }
  child.on('exit', (code, signal) => {
    if (stopping || stopRequested) return;
    void recoverServer(child, `Go server 意外退出（code=${code ?? 'null'} signal=${signal ?? 'none'}）\n${stderrTail.trim()}`);
  });
  return { info, child };
}

/**
 * Go server 需要知道渲染引擎、字体与脚本在哪；Electron 自带 Node 22，直接复用它，
 * 不要求用户另装 Node。仓库开发态下这些资源就在 windows/ 下；打包态同样按相对
 * 目录探测，找不到时不注入，server 会给出可执行的缺失提示。
 */
function renderEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.CBCT_NODE_BIN = process.execPath;
  env.CBCT_ELECTRON_AS_NODE = '1';
  // Bundled Python must not create bytecode inside the sealed application.
  if (app.isPackaged) env.PYTHONDONTWRITEBYTECODE = '1';
  if (process.resourcesPath) {
    env.READX_RESOURCES_DIR = process.resourcesPath;
    const portablePython = path.join(process.resourcesPath, 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));
    if (fs.existsSync(portablePython)) env.READX_PYTHON = portablePython;
    const bundledTypst = path.join(process.resourcesPath, 'typst', process.platform === 'win32' ? 'typst.exe' : 'typst');
    if (fs.existsSync(bundledTypst)) env.TYPST_BIN = bundledTypst;
  }
  const workspaceRoot = path.resolve(app.getAppPath(), '..', '..');
  // Finder launches omit Homebrew and user CLI locations. Preserve explicit PATH first.
  if (process.platform === 'darwin') {
    env.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin')].filter(Boolean).join(path.delimiter);
  }
  if (!env.READX_PYTHON && !app.isPackaged) {
    const python = path.join(workspaceRoot, '.retain-runtime', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3']));
    if (fs.existsSync(python)) env.READX_PYTHON = python;
  }
  env.READX_WORKSPACE_DIR = workspaceRoot;
  const devTypst = path.join(workspaceRoot, '.retain-runtime', 'typst', process.platform === 'win32' ? 'typst.exe' : 'typst');
  if (!env.TYPST_BIN && fs.existsSync(devTypst)) env.TYPST_BIN = devTypst;
  const candidates = [
    path.join(workspaceRoot, 'resources', 'rendering-engine'),
    path.join(process.resourcesPath ?? '', 'resources', 'rendering-engine'),
    path.join(process.resourcesPath ?? '', 'rendering-engine'),
  ];
  const engine = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'engine', 'bin', 'rpr-retain.js')),
  );
  if (!engine) return env;
  const resources = path.dirname(engine);
  env.CBCT_RENDER_ENGINE_DIR = engine;
  env.CBCT_TRANSLATED_PDF_FONT_DIR = path.join(resources, 'fonts');
  const packagedScript = path.join(process.resourcesPath ?? '', 'scripts', 'render-translated-pdf.cjs');
  const script = fs.existsSync(packagedScript)
    ? packagedScript
    : path.join(workspaceRoot, 'scripts', 'render-translated-pdf.cjs');
  if (fs.existsSync(script)) env.CBCT_RENDER_SCRIPT = script;
  return env;
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<ReadyInfo> {
  const stdout = child.stdout;
  if (!stdout) return Promise.reject(new Error('Go server 没有 stdout 管道，无法读取就绪信息'));

  return new Promise<ReadyInfo>((resolve, reject) => {
    const lines = readline.createInterface({ input: stdout, crlfDelay: Infinity });
    const timer = setTimeout(() => {
      lines.close();
      void (async () => {
        child.kill();
        await waitForExit(child, SHUTDOWN_GRACE_MS);
        reject(new Error(`等待就绪超时（${READY_TIMEOUT_MS / 1000}s）：检查 ${serverBinary()} 是否能独立运行`));
      })();
    }, READY_TIMEOUT_MS);

    const onClose = () => {
      clearTimeout(timer);
      reject(new Error('Go server 在打印就绪信息前就退出了，请查看 [server] 日志'));
    };
    stdout.once('close', onClose);
    child.once('error', reject);

    lines.on('line', (line) => {
      if (!line.startsWith(READY_PREFIX)) return;
      clearTimeout(timer);
      stdout.removeListener('close', onClose);
      child.removeListener('error', reject);
      lines.close();
      try {
        resolve(JSON.parse(line.slice(READY_PREFIX.length)) as ReadyInfo);
      } catch (error) {
        reject(new Error(`就绪信息不是合法 JSON：${describe(error)}`));
      }
    });
  });
}

async function stopServer(): Promise<void> {
  const child = server?.child;
  if (!child) return;
  // 关 stdin 触发 server 的 --exit-on-stdin-eof，走优雅关闭（flush SQLite）。
  child.stdin?.end();
  const exited = await waitForExit(child, SHUTDOWN_GRACE_MS);
  if (!exited) child.kill('SIGTERM');
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function logLifecycle(message: string): void {
  // Never log READY/stdout: it contains the ephemeral bearer token.
  console.error(`[desktop] ${message}`);
  try {
    const logDir = path.join(process.env.CBCT_DATA_ROOT || app.getPath('userData'), 'app', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, 'desktop.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      fs.renameSync(file, `${file}.previous`);
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch { /* Logging must never take down the desktop process. */ }
}

async function recoverServer(child: ChildProcessWithoutNullStreams, reason: string): Promise<void> {
  if (stopping || stopRequested || recoveringServer || server?.child !== child) return;
  recoveringServer = true;
  logLifecycle(reason);
  const previous = server.info;
  mainWindow?.setTitle('ReadX · 正在重新连接本地服务');
  try {
    while (!stopping && !stopRequested) {
      const now = Date.now();
      while (restartTimes.length && now - restartTimes[0]! > 60_000) restartTimes.shift();
      if (restartTimes.length >= 3) break;
      restartTimes.push(now);
      await new Promise(resolve => setTimeout(resolve, 300 * restartTimes.length));
      if (stopping || stopRequested) return;
      try {
        // Preserve the origin/token so the open reader can continue using its API.
        const replacement = await startServer(previous);
        if (stopping || stopRequested) {
          replacement.child?.stdin.end();
          return;
        }
        server = replacement;
        mainWindow?.setTitle('ReadX');
        logLifecycle('本地服务已自动恢复');
        return;
      } catch (error) {
        logLifecycle(`重启后端失败：${describe(error)}`);
      }
    }
  } finally {
    recoveringServer = false;
  }
  if (stopping || stopRequested || fatalServerDialog) return;
  fatalServerDialog = true;
  logLifecycle('一分钟内已尝试重启三次，停止自动重试');
  await dialog.showMessageBox({
    type: 'error', message: '本地服务连续退出',
    detail: `${reason}\n已尝试自动恢复。请重新启动应用；退出信息保存在数据目录 app/logs/desktop.log。`,
  });
  app.quit();
}

function createWindow(): void {
  if (!server) return;
  const url = startUrl(server);
  const injected: BootstrapInfo = { apiBase: originOf(url), token: server.info.token };
  const saved = readWindowState();

  mainWindow = new BrowserWindow({
    ...saved.bounds,
    minWidth: MIN_WINDOW_BOUNDS.width,
    minHeight: MIN_WINDOW_BOUNDS.height,
    show: false,
    backgroundColor: '#f6f2ea',
    title: 'ReadX',
    // Read the packaged multi-resolution icon for the current display's DPI.
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // token 只经主进程进渲染进程，不进 URL、不落磁盘。
      backgroundThrottling: false,
      additionalArguments: [`--cbct-api-base=${injected.apiBase}`, `--cbct-token=${injected.token}`],
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  if (saved.maximized) mainWindow.maximize();
  const persist = () => scheduleWindowStateSave(mainWindow);
  mainWindow.on('resize', persist);
  mainWindow.on('move', persist);
  mainWindow.on('maximize', persist);
  mainWindow.on('unmaximize', persist);
  if (process.platform !== 'darwin') mainWindow.setMenu(null);
  mainWindow.on('close', (event) => {
    if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
    saveWindowState(mainWindow);
    if (!stopping && !stopRequested) {
      event.preventDefault();
      mainWindow?.minimize();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(url);
}

interface SavedWindowState {
  bounds: { x?: number; y?: number; width: number; height: number };
  maximized: boolean;
}

function windowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState(): SavedWindowState {
  const fallback: SavedWindowState = { bounds: DEFAULT_WINDOW_BOUNDS, maximized: false };
  try {
    const value = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')) as Partial<SavedWindowState>;
    const bounds = value.bounds;
    if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
      || bounds.width < MIN_WINDOW_BOUNDS.width || bounds.height < MIN_WINDOW_BOUNDS.height) return fallback;
    const restored = {
      x: Number.isFinite(bounds.x) ? bounds.x : undefined,
      y: Number.isFinite(bounds.y) ? bounds.y : undefined,
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
    if (restored.x !== undefined && restored.y !== undefined) {
      const visible = screen.getAllDisplays().some(({ workArea }) =>
        restored.x! >= workArea.x && restored.x! + restored.width <= workArea.x + workArea.width
        && restored.y! >= workArea.y && restored.y! + restored.height <= workArea.y + workArea.height);
      if (!visible) return { bounds: { width: restored.width, height: restored.height }, maximized: value.maximized === true };
    }
    return { bounds: restored, maximized: value.maximized === true };
  } catch {
    return fallback;
  }
}

function scheduleWindowStateSave(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    saveWindowState(window);
  }, 300);
}

function saveWindowState(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  try {
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    const value: SavedWindowState = {
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      maximized: window.isMaximized(),
    };
    const target = windowStatePath();
    const temporary = `${target}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(value), 'utf8');
    fs.renameSync(temporary, target);
  } catch (error) {
    logLifecycle(`保存窗口状态失败：${describe(error)}`);
  }
}

function isAllowedReaderPopup(target: string): boolean {
  if (!sameOrigin(target)) return false;
  try {
    const url = new URL(target);
    if (url.pathname !== '/' || url.hash) return false;
    const params = url.searchParams;
    if (params.get('readxWindow') !== 'reader') return false;
    const documentId = params.get('documentId') ?? '';
    if (!/^[\w-]{1,128}$/.test(documentId)) return false;
    const page = params.get('page');
    if (page !== null && (!/^\d{1,5}$/.test(page) || Number(page) < 1)) return false;
    return [...params.keys()].every((key) => key === 'readxWindow' || key === 'documentId' || key === 'page');
  } catch {
    return false;
  }
}

function startUrl(handle: ServerHandle): string {
  return process.env.ELECTRON_START_URL || (!app.isPackaged && process.env.CBCT_V2_BROWSER_PROXY) || `http://${handle.info.host}:${handle.info.port}/`;
}

function sameOrigin(target: string): boolean {
  try {
    return originOf(target) === allowedOrigin;
  } catch {
    return false;
  }
}

/**
 * 只把 http/https 当作可以交给系统浏览器的外链。
 * 白名单而非黑名单：file:、javascript: 等一律不外发，避免把危险协议交给 ShellExecute。
 */
function isExternalHTTP(target: string): boolean {
  try {
    const { protocol } = new URL(target);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function originOf(value: string): string {
  const parsed = new URL(value);
  return `${parsed.protocol}//${parsed.host}`;
}

function serverBinary(): string {
  const name = process.platform === 'win32' ? 'server.exe' : 'server';
  const candidates = [
    process.env.CBCT_V2_SERVER,
    path.resolve(app.getAppPath(), '..', 'server', 'bin', name),
    process.resourcesPath ? path.join(process.resourcesPath, 'server', 'bin', name) : '',
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', name) : '',
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return prepareServerRuntime(candidate);
  }
  throw new Error(`找不到 Go server 可执行文件。请先执行 npm run build:go，或设置 CBCT_V2_SERVER。\n已尝试：\n${candidates.join('\n')}`);
}

function prepareServerRuntime(source: string): string {
  if (process.platform !== 'win32') return source;
  const body = fs.readFileSync(source);
  const hash = createHash('sha256').update(body).digest('hex');
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(local, 'CBCTReading', 'runtime', hash);
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
  return target;
}

function readDevInfo(): ReadyInfo | null {
  const file = path.resolve(app.getAppPath(), '..', 'server', 'dev-info.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReadyInfo>;
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string' || typeof parsed.host !== 'string') {
      return null;
    }
    return parsed as ReadyInfo;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
