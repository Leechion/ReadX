import { BrowserWindow, ipcMain, screen } from 'electron';
import type { LauncherCatalog, LauncherEvent, LauncherTarget } from '@cbct/shared';
import { AltHold } from './alt-hold';
import { canStartGlobalHook, subscribeGlobalHook } from './hook-manager';

const WORKSPACES = ['library', 'research', 'presentation', 'latex', 'slack'];
export function validLauncherTarget(value: unknown): value is LauncherTarget {
  if (!value || typeof value !== 'object') return false;
  const target = value as LauncherTarget;
  return WORKSPACES.includes(target.workspace) && (target.id === undefined || (typeof target.id === 'string' && target.id.length <= 512));
}

export class DesktopLauncher {
  private window: BrowserWindow;
  private catalog: LauncherCatalog = { current: 'library', groups: [] };
  private ready = false;
  private disposed = false;
  private enabled = true;
  private stopHook: (() => void) | null = null;
  private lastMove = 0;
  private origin = { x: 0, y: 0 };
  private hold: AltHold;

  constructor(private options: {
    url: string; preload: string; apiBase: string; token: string; enabled?: boolean;
    main: () => BrowserWindow | null; restore: () => void; log: (message: string) => void;
  }) {
    this.enabled = options.enabled ?? true;
    this.window = new BrowserWindow({
      width: 720, height: 720, show: false, frame: false, transparent: true,
      resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true,
      hasShadow: false, fullscreenable: false, minimizable: false, maximizable: false,
      title: 'ReadX · 快速轮盘',
      webPreferences: {
        preload: options.preload, contextIsolation: true, nodeIntegration: false,
        sandbox: true, spellcheck: false, backgroundThrottling: false,
        additionalArguments: [`--cbct-api-base=${options.apiBase}`, `--cbct-token=${options.token}`],
      },
    });
    this.window.setAlwaysOnTop(true, 'pop-up-menu');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.setMenu(null);
    this.hold = new AltHold({
      show: () => this.show(), release: () => {
        const cursor = screen.getCursorScreenPoint();
        if (Math.hypot(cursor.x - this.origin.x, cursor.y - this.origin.y) < 8) this.hide();
        else this.send({ type: 'release', ...this.pointer() });
      }, cancel: () => this.hide(),
    });
    this.window.on('blur', () => { this.hold.cancel(); this.hide(); });

    ipcMain.on('readx-launcher:ready', this.onReady);
    ipcMain.on('readx-launcher:catalog', this.onCatalog);
    ipcMain.on('readx-launcher:activate', this.onActivate);
    ipcMain.on('readx-launcher:dismiss', this.onDismiss);
    const url = new URL(options.url);
    url.searchParams.set('readxWindow', 'launcher');
    void this.window.loadURL(url.toString()).catch(error => options.log(`轮盘加载失败：${String(error)}`));
    if (this.enabled) this.enableHook();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(next: boolean): void {
    this.enabled = next;
    if (next) this.enableHook();
    else this.disableHook();
  }

  disableHook(): void {
    this.hold.cancel();
    this.hide();
    if (this.stopHook) {
      this.stopHook();
      this.stopHook = null;
    }
  }

  enableHook(): void {
    if (!this.enabled || this.stopHook || this.disposed) return;
    // macOS needs Accessibility permission before libuiohook can observe Option/Alt.
    if (!canStartGlobalHook()) return;
    try {
      const { UiohookKey } = require('uiohook-napi') as typeof import('uiohook-napi');
      const alts = new Set<number>();
      this.stopHook = subscribeGlobalHook({
        onKeyDown: (event) => {
          if (event.keycode === UiohookKey.Alt || event.keycode === UiohookKey.AltRight) {
            alts.add(event.keycode);
            this.hold.press(event.ctrlKey || event.metaKey || event.shiftKey);
          } else this.hold.cancel();
        },
        onKeyUp: (event) => {
          alts.delete(event.keycode);
          if ((event.keycode === UiohookKey.Alt || event.keycode === UiohookKey.AltRight) && !alts.size) this.hold.release();
        },
        onMouseMove: () => {
          if (!this.window.isVisible() || Date.now() - this.lastMove < 16) return;
          this.lastMove = Date.now();
          this.send({ type: 'pointer', ...this.pointer() });
        },
        onMouseDown: () => {
          if (!this.window.isVisible()) { this.hold.cancel(); return; }
          const { x, y } = this.pointer();
          const { width, height } = this.window.getBounds();
          if (x < 0 || y < 0 || x > width || y > height) this.hold.cancel();
        },
        onWheel: (event) => {
          if (this.window.isVisible()) this.send({ type: 'wheel', delta: event.rotation });
        },
      }, (error) => this.options.log(`无法启用 Alt 轮盘：${String(error)}`));
    } catch (error) { this.options.log(`无法启用 Alt 轮盘：${String(error)}`); }
  }

  /** Tray entry also makes the wheel available without holding a key. */
  show(): void {
    if (!this.enabled || !this.ready || this.disposed) return;
    const cursor = screen.getCursorScreenPoint();
    this.origin = cursor;
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const size = Math.min(720, area.width, area.height);
    this.window.setBounds({
      width: size, height: size,
      x: Math.round(Math.max(area.x, Math.min(cursor.x - size / 2, area.x + area.width - size))),
      y: Math.round(Math.max(area.y, Math.min(cursor.y - size / 2, area.y + area.height - size))),
    });
    this.send({ type: 'show', catalog: this.catalog, ...this.pointer() });
    this.options.main()?.webContents.send('readx-launcher:request-catalog');
    this.window.showInactive();
  }

  private pointer(): { x: number; y: number } {
    const cursor = screen.getCursorScreenPoint();
    const bounds = this.window.getBounds();
    return { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
  }
  private send(event: LauncherEvent): void {
    if (!this.disposed && !this.window.isDestroyed()) this.window.webContents.send('readx-launcher:event', event);
  }
  hide(): void { this.send({ type: 'hide' }); if (!this.window.isDestroyed()) this.window.hide(); }
  private onReady = (event: Electron.IpcMainEvent) => {
    if (event.sender === this.window.webContents) this.ready = true;
  };
  private onCatalog = (event: Electron.IpcMainEvent, catalog: LauncherCatalog) => {
    if (event.sender !== this.options.main()?.webContents) return;
    this.catalog = catalog;
    if (this.window.isVisible()) this.send({ type: 'catalog', catalog });
  };
  private onActivate = (event: Electron.IpcMainEvent, target: unknown) => {
    if (event.sender !== this.window.webContents || !this.window.isVisible() || !validLauncherTarget(target)) return;
    if (target.id && !this.catalog.groups.some(group => group.workspace === target.workspace && group.projects.some(project => project.id === target.id))) return;
    this.hold.cancel();
    this.hide();
    this.options.restore();
    this.options.main()?.webContents.send('readx-launcher:navigate', target);
  };
  private onDismiss = (event: Electron.IpcMainEvent) => {
    if (event.sender === this.window.webContents) { this.hold.cancel(); this.hide(); }
  };
  dispose(): void {
    this.hold.dispose();
    this.stopHook?.();
    this.disposed = true;
    ipcMain.removeListener('readx-launcher:ready', this.onReady);
    ipcMain.removeListener('readx-launcher:catalog', this.onCatalog);
    ipcMain.removeListener('readx-launcher:activate', this.onActivate);
    ipcMain.removeListener('readx-launcher:dismiss', this.onDismiss);
    this.window.destroy();
  }
}
