import { BrowserWindow, clipboard, ipcMain, Menu, screen, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type {
  PetAccessory,
  PetActionCommand,
  PetAppState,
  PetHostEvent,
  PetNavigateTarget,
  PetPeekEdge,
  PetSettings,
  PetSkinId,
} from '@cbct/shared';
import { subscribeGlobalHook } from './hook-manager';

export const PET_BASE_WIDTH = 192;
export const PET_BASE_HEIGHT = 208;
export const PET_MIN_SCALE = 0.55;
export const PET_MAX_SCALE = 1.4;
export const PET_MIN_OPACITY = 0.45;
export const PET_MAX_OPACITY = 1.0;

export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const VALID_ACCESSORIES: readonly PetAccessory[] = ['bowtie', 'gradcap', 'glasses', 'scarf', 'none'];
const VALID_WATER_INTERVALS = [0, 30, 45, 60];

const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: true,
  skin: 'kuro',
  clickThrough: false,
  scale: 1,
  opacity: 1,
  accessory: 'bowtie',
  soundEnabled: true,
  waterReminderMin: 0,
  x: null,
  y: null,
  peekEdge: 'none',
};

export function clampPetScale(scale: unknown): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return 1;
  return Math.round(Math.min(PET_MAX_SCALE, Math.max(PET_MIN_SCALE, scale)) * 100) / 100;
}

export function clampPetOpacity(opacity: unknown): number {
  if (typeof opacity !== 'number' || !Number.isFinite(opacity)) return 1;
  return Math.round(Math.min(PET_MAX_OPACITY, Math.max(PET_MIN_OPACITY, opacity)) * 100) / 100;
}

export function normalizeAccessory(value: unknown): PetAccessory {
  return VALID_ACCESSORIES.includes(value as PetAccessory) ? (value as PetAccessory) : 'bowtie';
}

export function normalizeWaterReminder(value: unknown): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
  return VALID_WATER_INTERVALS.includes(num) ? num : 0;
}

export function petWindowDimensions(scale: number): { width: number; height: number } {
  const s = clampPetScale(scale);
  return {
    width: Math.round(PET_BASE_WIDTH * s),
    height: Math.round(PET_BASE_HEIGHT * s),
  };
}

export function normalizeSkin(_skin: unknown): PetSkinId {
  return 'kuro';
}

/**
 * 约束桌宠窗口在多屏工作区内的位置，同时允许左右留出 24% 做贴边偷看（Edge-Peek），
 * 并保证主体始终有足够面积可抓回。
 */
export function clampPetPosition(
  x: number,
  y: number,
  winWidth: number,
  winHeight: number,
  displays: readonly DisplayRect[],
): { x: number; y: number; peekEdge: PetPeekEdge } {
  const valid = displays.filter((d) => d.width > 0 && d.height > 0);
  const rects = valid.length ? valid : [{ x: 0, y: 0, width: 1280, height: 800 }];

  const cx = x + winWidth / 2;
  const cy = y + winHeight / 2;
  let nearest = rects[0]!;
  let bestDist = Infinity;
  for (const rect of rects) {
    const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.width));
    const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.height));
    const dist = Math.hypot(cx - nx, cy - ny);
    if (dist < bestDist) {
      bestDist = dist;
      nearest = rect;
    }
  }

  let unionLeft = Infinity;
  let unionTop = Infinity;
  let unionRight = -Infinity;
  let unionBottom = -Infinity;
  for (const rect of rects) {
    unionLeft = Math.min(unionLeft, rect.x);
    unionTop = Math.min(unionTop, rect.y);
    unionRight = Math.max(unionRight, rect.x + rect.width);
    unionBottom = Math.max(unionBottom, rect.y + rect.height);
  }

  const sideMargin = Math.round(winWidth * 0.24);
  const topHeadroom = Math.round(winHeight * 0.14);
  const minVisibleH = Math.round(winHeight * 0.56);

  const minX = unionLeft - sideMargin;
  const maxX = Math.max(minX, unionRight - winWidth + sideMargin);
  const minY = unionTop - topHeadroom;
  const maxY = Math.max(minY, unionBottom - minVisibleH);

  const clampedX = Math.round(Math.max(minX, Math.min(x, maxX)));
  const clampedY = Math.round(Math.max(minY, Math.min(y, maxY)));

  let peekEdge: PetPeekEdge = 'none';
  if (clampedX <= nearest.x - Math.round(winWidth * 0.12)) {
    peekEdge = 'left';
  } else if (clampedX + winWidth >= nearest.x + nearest.width + Math.round(winWidth * 0.12)) {
    peekEdge = 'right';
  }

  return { x: clampedX, y: clampedY, peekEdge };
}

function defaultPetPosition(
  winWidth: number,
  winHeight: number,
  area: DisplayRect,
): { x: number; y: number } {
  return {
    x: Math.round(area.x + area.width - winWidth - 28),
    y: Math.round(area.y + area.height - winHeight - 24),
  };
}

export function isValidPetNavigateTarget(value: unknown): value is PetNavigateTarget {
  if (!value || typeof value !== 'object') return false;
  const target = value as PetNavigateTarget;
  switch (target.kind) {
    case 'document':
      return (target.key === undefined || (typeof target.key === 'string' && target.key.length <= 256))
        && (target.id === undefined || (typeof target.id === 'string' && target.id.length <= 256));
    case 'screen':
      return ['library', 'research', 'presentation', 'latex', 'compare', 'graph', 'calendar', 'reproduction'].includes(target.screen);
    case 'mode':
      return target.mode === 'research' || target.mode === 'slack';
    case 'focus':
      return ['start25', 'start45', 'toggle', 'stop'].includes(target.action);
    case 'import':
    case 'launcher':
      return true;
    default:
      return false;
  }
}

export class DesktopPet {
  private window: BrowserWindow | null = null;
  private ready = false;
  private disposed = false;
  private settings: PetSettings;
  private interactive = false;
  private altHeld = false;
  private lastAppState: PetAppState = {};
  private stopHook: (() => void) | null = null;
  private lastPointerAt = 0;
  private lastPointerPoint = { x: -9999, y: -9999 };
  private lastKeyPulseAt = 0;
  private lastMenuAt = 0;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private options: {
    url: string;
    preload: string;
    apiBase: string;
    token: string;
    settingsFile: string;
    main: () => BrowserWindow | null;
    restore: () => void;
    showLauncher: () => void;
    onSettingsChange?: (settings: PetSettings) => void;
    log: (message: string) => void;
  }) {
    this.settings = this.readSettings();
    this.registerIpc();
    if (this.settings.enabled) {
      this.openWindow();
      this.enableHook();
    }
  }

  getSettings(): PetSettings {
    return { ...this.settings };
  }

  isEnabled(): boolean {
    return this.settings.enabled;
  }

  setEnabled(next: boolean): PetSettings {
    return this.updateSettings({ enabled: Boolean(next) });
  }

  updateSettings(patch: Partial<PetSettings>): PetSettings {
    const prev = this.settings;
    const scale = patch.scale !== undefined ? clampPetScale(patch.scale) : prev.scale;
    const opacity = patch.opacity !== undefined ? clampPetOpacity(patch.opacity) : clampPetOpacity(prev.opacity);
    const accessory = patch.accessory !== undefined ? normalizeAccessory(patch.accessory) : normalizeAccessory(prev.accessory);
    const soundEnabled = patch.soundEnabled !== undefined ? Boolean(patch.soundEnabled) : (prev.soundEnabled !== false);
    const waterReminderMin = patch.waterReminderMin !== undefined
      ? normalizeWaterReminder(patch.waterReminderMin)
      : normalizeWaterReminder(prev.waterReminderMin);
    const skin = patch.skin !== undefined ? normalizeSkin(patch.skin) : prev.skin;
    const enabled = patch.enabled !== undefined ? Boolean(patch.enabled) : prev.enabled;
    const clickThrough = patch.clickThrough !== undefined ? Boolean(patch.clickThrough) : prev.clickThrough;

    let x = patch.x === null ? null : typeof patch.x === 'number' && Number.isFinite(patch.x) ? Math.round(patch.x) : prev.x;
    let y = patch.y === null ? null : typeof patch.y === 'number' && Number.isFinite(patch.y) ? Math.round(patch.y) : prev.y;
    let peekEdge: PetPeekEdge = prev.peekEdge ?? 'none';

    const dims = petWindowDimensions(scale);
    if (x !== null && y !== null) {
      const clamped = clampPetPosition(x, y, dims.width, dims.height, this.allDisplayRects());
      x = clamped.x;
      y = clamped.y;
      peekEdge = clamped.peekEdge;
    }

    this.settings = {
      enabled,
      skin,
      clickThrough,
      scale,
      opacity,
      accessory,
      soundEnabled,
      waterReminderMin,
      x,
      y,
      peekEdge,
    };
    this.scheduleSaveSettings();

    if (enabled && !this.window) {
      this.openWindow();
      this.enableHook();
    } else if (!enabled && this.window) {
      this.disableHook();
      this.closeWindow();
    } else if (this.window && !this.window.isDestroyed()) {
      const bounds = this.resolveTargetBounds();
      this.window.setBounds(bounds);
      this.applyMouseIgnore();
      this.sendHost({ type: 'settings', settings: this.getSettings() });
    }

    this.broadcastSettings();
    return this.getSettings();
  }

  triggerAction(action: PetActionCommand): void {
    this.sendHost({ type: 'action', action });
  }

  enableHook(): void {
    if (!this.settings.enabled || this.stopHook || this.disposed) return;
    try {
      const { UiohookKey } = require('uiohook-napi') as typeof import('uiohook-napi');
      const alts = new Set<number>();
      this.stopHook = subscribeGlobalHook({
        onKeyDown: (event) => {
          if (event.keycode === UiohookKey.Alt || event.keycode === UiohookKey.AltRight) {
            alts.add(event.keycode);
            if (!this.altHeld) {
              this.altHeld = true;
              this.applyMouseIgnore();
              this.sendHost({ type: 'alt', held: true });
            }
            return;
          }
          const now = Date.now();
          if (now - this.lastKeyPulseAt >= 85) {
            this.lastKeyPulseAt = now;
            this.sendHost({ type: 'keyPulse' });
          }
        },
        onKeyUp: (event) => {
          if (event.keycode === UiohookKey.Alt || event.keycode === UiohookKey.AltRight) {
            alts.delete(event.keycode);
            if (!alts.size && this.altHeld) {
              this.altHeld = false;
              this.applyMouseIgnore();
              this.sendHost({ type: 'alt', held: false });
            }
          }
        },
        onMouseMove: () => {
          if (!this.window || this.window.isDestroyed() || !this.window.isVisible()) return;
          const now = Date.now();
          if (now - this.lastPointerAt < 32) return;
          const cursor = screen.getCursorScreenPoint();
          if (Math.hypot(cursor.x - this.lastPointerPoint.x, cursor.y - this.lastPointerPoint.y) < 2) return;
          this.lastPointerAt = now;
          this.lastPointerPoint = cursor;
          const bounds = this.window.getBounds();
          const relX = cursor.x - bounds.x;
          const relY = cursor.y - bounds.y;
          const inside = relX >= 0 && relY >= 0 && relX <= bounds.width && relY <= bounds.height;
          const overBody = inside
            && relX >= bounds.width * 0.14
            && relX <= bounds.width * 0.86
            && relY >= bounds.height * 0.08
            && relY <= bounds.height * 0.94;
          if (overBody !== this.interactive) {
            this.interactive = overBody;
            this.applyMouseIgnore();
          }
          this.sendHost({ type: 'pointer', x: relX, y: relY, inside, altHeld: this.altHeld });
        },
      }, (error) => this.options.log(`桌面伴侣全局监听启动失败：${String(error)}`));
    } catch (error) {
      this.options.log(`桌面伴侣全局监听不可用：${String(error)}`);
    }
  }

  disableHook(): void {
    if (this.stopHook) {
      this.stopHook();
      this.stopHook = null;
    }
    this.altHeld = false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.writeSettingsNow();
    }
    this.disableHook();
    this.closeWindow();
    ipcMain.removeHandler('readx-pet:get-settings');
    ipcMain.removeHandler('readx-pet:update-settings');
    ipcMain.removeHandler('readx-pet:move-to');
    ipcMain.removeHandler('readx-pet:read-clipboard');
    ipcMain.removeListener('readx-pet:ready', this.onReady);
    ipcMain.removeListener('readx-pet:set-interactive', this.onSetInteractive);
    ipcMain.removeListener('readx-pet:show-context-menu', this.onShowContextMenu);
    ipcMain.removeListener('readx-pet:navigate-main', this.onNavigateMain);
    ipcMain.removeListener('readx-pet:library-updated', this.onLibraryUpdated);
    ipcMain.removeListener('readx-pet:publish-app-state', this.onPublishAppState);
  }

  private openWindow(): void {
    if (this.window || this.disposed) return;
    const bounds = this.resolveTargetBounds();
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: 'ReadX · 桌面伴侣',
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
        additionalArguments: [`--cbct-api-base=${this.options.apiBase}`, `--cbct-token=${this.options.token}`],
      },
    });

    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setMenu(null);
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.on('context-menu', (event) => {
      event.preventDefault();
      this.showContextMenu();
    });
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.showInactive();
    });
    win.on('closed', () => {
      if (this.window === win) {
        this.window = null;
        this.ready = false;
      }
    });

    this.window = win;
    const url = new URL(this.options.url);
    url.searchParams.set('readxWindow', 'pet');
    void win.loadURL(url.toString()).catch((error) => {
      this.options.log(`桌面伴侣加载失败：${String(error)}`);
    });
  }

  private closeWindow(): void {
    this.ready = false;
    const win = this.window;
    this.window = null;
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
  }

  private allDisplayRects(): DisplayRect[] {
    return screen.getAllDisplays().map((d) => d.workArea);
  }

  private resolveTargetBounds(): { x: number; y: number; width: number; height: number } {
    const dims = petWindowDimensions(this.settings.scale);
    const displays = this.allDisplayRects();
    if (this.settings.x === null || this.settings.y === null) {
      const primary = screen.getPrimaryDisplay().workArea;
      const fallback = defaultPetPosition(dims.width, dims.height, primary);
      const clamped = clampPetPosition(fallback.x, fallback.y, dims.width, dims.height, displays);
      this.settings.x = clamped.x;
      this.settings.y = clamped.y;
      this.settings.peekEdge = clamped.peekEdge;
      return { x: clamped.x, y: clamped.y, width: dims.width, height: dims.height };
    }
    const clamped = clampPetPosition(this.settings.x, this.settings.y, dims.width, dims.height, displays);
    this.settings.x = clamped.x;
    this.settings.y = clamped.y;
    this.settings.peekEdge = clamped.peekEdge;
    return { x: clamped.x, y: clamped.y, width: dims.width, height: dims.height };
  }

  private applyMouseIgnore(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const allowMouse = (!this.settings.clickThrough && this.interactive) || (this.altHeld && this.interactive);
    if (allowMouse) {
      this.window.setIgnoreMouseEvents(false);
    } else {
      this.window.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  private sendHost(event: PetHostEvent): void {
    if (!this.ready || !this.window || this.window.isDestroyed()) return;
    this.window.webContents.send('readx-pet:host-event', event);
  }

  private broadcastSettings(): void {
    const snapshot = this.getSettings();
    this.options.onSettingsChange?.(snapshot);
    const mainWin = this.options.main();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('readx-pet:settings-changed', snapshot);
    }
  }

  private isPetOrMainSender(sender: Electron.WebContents): boolean {
    return (this.window && !this.window.isDestroyed() && sender === this.window.webContents)
      || (this.options.main() !== null && sender === this.options.main()?.webContents);
  }

  private registerIpc(): void {
    ipcMain.handle('readx-pet:get-settings', (event) => {
      if (!this.isPetOrMainSender(event.sender)) throw new Error('无权读取伴侣设置');
      return this.getSettings();
    });

    ipcMain.handle('readx-pet:update-settings', (event, patch: unknown) => {
      if (!this.isPetOrMainSender(event.sender)) throw new Error('无权修改伴侣设置');
      if (!patch || typeof patch !== 'object') return this.getSettings();
      return this.updateSettings(patch as Partial<PetSettings>);
    });

    ipcMain.handle('readx-pet:move-to', (event, rawX: unknown, rawY: unknown) => {
      if (!this.window || event.sender !== this.window.webContents) throw new Error('仅伴侣窗口可移动位置');
      const dims = petWindowDimensions(this.settings.scale);
      const x = typeof rawX === 'number' && Number.isFinite(rawX) ? rawX : (this.settings.x ?? 0);
      const y = typeof rawY === 'number' && Number.isFinite(rawY) ? rawY : (this.settings.y ?? 0);
      const clamped = clampPetPosition(x, y, dims.width, dims.height, this.allDisplayRects());
      const changedEdge = clamped.peekEdge !== this.settings.peekEdge;
      this.settings.x = clamped.x;
      this.settings.y = clamped.y;
      this.settings.peekEdge = clamped.peekEdge;
      if (!this.window.isDestroyed()) {
        this.window.setBounds({ x: clamped.x, y: clamped.y, width: dims.width, height: dims.height });
      }
      this.scheduleSaveSettings();
      if (changedEdge) {
        this.sendHost({ type: 'settings', settings: this.getSettings() });
      }
      return clamped;
    });

    ipcMain.handle('readx-pet:read-clipboard', async (event) => {
      if (!this.window || event.sender !== this.window.webContents) throw new Error('仅伴侣窗口可读取剪贴板');
      return (await clipboard.readText()).trim();
    });

    ipcMain.on('readx-pet:ready', this.onReady);
    ipcMain.on('readx-pet:set-interactive', this.onSetInteractive);
    ipcMain.on('readx-pet:show-context-menu', this.onShowContextMenu);
    ipcMain.on('readx-pet:navigate-main', this.onNavigateMain);
    ipcMain.on('readx-pet:library-updated', this.onLibraryUpdated);
    ipcMain.on('readx-pet:publish-app-state', this.onPublishAppState);
  }

  showContextMenu(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const now = Date.now();
    if (now - this.lastMenuAt < 180) return;
    this.lastMenuAt = now;

    const scaleChoices = [
      { label: '60%（迷你）', value: 0.6 },
      { label: '80%（小巧）', value: 0.8 },
      { label: '100%（标准）', value: 1.0 },
      { label: '120%（偏大）', value: 1.2 },
      { label: '140%（大号）', value: 1.4 },
    ];
    const opacityChoices = [
      { label: '100%（完全清晰）', value: 1.0 },
      { label: '85%（柔和）', value: 0.85 },
      { label: '70%（半透明）', value: 0.7 },
      { label: '50%（极简护眼）', value: 0.5 },
    ];
    const accessoryChoices: Array<{ label: string; value: PetAccessory }> = [
      { label: '墨绿书房领结', value: 'bowtie' },
      { label: '博士学士帽', value: 'gradcap' },
      { label: '学者金丝眼镜', value: 'glasses' },
      { label: '暖红小围巾', value: 'scarf' },
      { label: '无配饰（原生态）', value: 'none' },
    ];
    const waterChoices = [
      { label: '关闭提醒', value: 0 },
      { label: '每 30 分钟', value: 30 },
      { label: '每 45 分钟（推荐）', value: 45 },
      { label: '每 60 分钟', value: 60 },
    ];

    const isSlack = this.lastAppState.workspaceMode === 'slack';
    const focusRunning = Boolean(this.lastAppState.focusRunning);
    const recentDocs = (this.lastAppState.recentDocs ?? []).slice(0, 5);
    const recentItems: MenuItemConstructorOptions[] = recentDocs.length
      ? recentDocs.map((doc) => ({
          label: doc.title.length > 28 ? `${doc.title.slice(0, 27)}…` : doc.title,
          click: () => this.dispatchNavigate({ kind: 'document', id: doc.id, key: doc.key }),
        }))
      : [{ label: '暂无在读论文', enabled: false }];

    const currentOpacity = clampPetOpacity(this.settings.opacity);
    const currentAccessory = normalizeAccessory(this.settings.accessory);
    const currentWater = normalizeWaterReminder(this.settings.waterReminderMin);

    const menu = Menu.buildFromTemplate([
      {
        label: '打开 ReadX 主窗口',
        click: () => this.dispatchNavigate({ kind: 'screen', screen: 'library' }),
      },
      {
        label: '继续阅读',
        submenu: recentItems,
      },
      {
        label: '切换工作区',
        submenu: [
          { label: '文献库', click: () => this.dispatchNavigate({ kind: 'screen', screen: 'library' }) },
          { label: '科研工作台（待办与专注）', click: () => this.dispatchNavigate({ kind: 'screen', screen: 'research' }) },
          { label: 'LaTeX Studio', click: () => this.dispatchNavigate({ kind: 'screen', screen: 'latex' }) },
          { label: '知识图谱点云', click: () => this.dispatchNavigate({ kind: 'screen', screen: 'graph' }) },
          { label: '跨文献对照', click: () => this.dispatchNavigate({ kind: 'screen', screen: 'compare' }) },
          { label: '论文演示稿 PPT', click: () => this.dispatchNavigate({ kind: 'screen', screen: 'presentation' }) },
          { label: '阅读日历与统计', click: () => this.dispatchNavigate({ kind: 'screen', screen: 'calendar' }) },
          { type: 'separator' },
          {
            label: isSlack ? '拉幕返回科研界面' : '拉幕切换摸鱼界面',
            click: () => this.dispatchNavigate({ kind: 'mode', mode: isSlack ? 'research' : 'slack' }),
          },
          { label: '呼出快速轮盘（长按 Alt）', click: () => this.options.showLauncher() },
        ],
      },
      { type: 'separator' },
      {
        label: '从剪贴板导入论文（arXiv / DOI / URL）',
        click: () => this.triggerAction('clipboard_import'),
      },
      {
        label: focusRunning
          ? `专注番茄钟（进行中 ${this.lastAppState.focusClock ?? ''}）`
          : '专注番茄钟',
        submenu: [
          {
            label: '开始 25 分钟番茄专注',
            click: () => this.dispatchNavigate({ kind: 'focus', action: 'start25' }),
          },
          {
            label: '开始 45 分钟深度精读',
            click: () => this.dispatchNavigate({ kind: 'focus', action: 'start45' }),
          },
          { type: 'separator' },
          {
            label: focusRunning ? '暂停专注' : '继续专注',
            click: () => this.dispatchNavigate({ kind: 'focus', action: 'toggle' }),
          },
          {
            label: '结束并记录本次专注',
            click: () => this.dispatchNavigate({ kind: 'focus', action: 'stop' }),
          },
        ],
      },
      {
        label: '今日科研简报（书库 + 下班倒计时）',
        click: () => this.triggerAction('briefing'),
      },
      { type: 'separator' },
      {
        label: '小猫互动',
        submenu: [
          { label: '摸摸头（呼噜呼噜）', click: () => this.triggerAction('pet') },
          { label: '哄它打盹午睡', click: () => this.triggerAction('nap') },
          { label: '叫醒它', click: () => this.triggerAction('wake') },
          { label: '举杯提醒喝水', click: () => this.triggerAction('drink_reminder') },
        ],
      },
      {
        label: '书房配饰',
        submenu: accessoryChoices.map((choice) => ({
          label: choice.label,
          type: 'radio' as const,
          checked: currentAccessory === choice.value,
          click: () => this.updateSettings({ accessory: choice.value }),
        })),
      },
      {
        label: currentWater > 0 ? `护眼喝水提醒（每 ${currentWater} 分钟）` : '护眼喝水提醒',
        submenu: waterChoices.map((choice) => ({
          label: choice.label,
          type: 'radio' as const,
          checked: currentWater === choice.value,
          click: () => this.updateSettings({ waterReminderMin: choice.value }),
        })),
      },
      {
        label: '呼噜与提示音效',
        type: 'checkbox',
        checked: this.settings.soundEnabled !== false,
        click: (item) => this.updateSettings({ soundEnabled: item.checked }),
      },
      {
        label: `缩放大小（当前 ${Math.round(this.settings.scale * 100)}%）`,
        submenu: scaleChoices.map((choice) => ({
          label: choice.label,
          type: 'radio' as const,
          checked: Math.abs(this.settings.scale - choice.value) < 0.05,
          click: () => this.updateSettings({ scale: choice.value }),
        })),
      },
      {
        label: `不透明度（当前 ${Math.round(currentOpacity * 100)}%）`,
        submenu: opacityChoices.map((choice) => ({
          label: choice.label,
          type: 'radio' as const,
          checked: Math.abs(currentOpacity - choice.value) < 0.04,
          click: () => this.updateSettings({ opacity: choice.value }),
        })),
      },
      { type: 'separator' },
      {
        label: '锁定鼠标穿透（按住 Alt 可拖动）',
        type: 'checkbox',
        checked: this.settings.clickThrough,
        click: (item) => this.updateSettings({ clickThrough: item.checked }),
      },
      {
        label: '回到屏幕右下角',
        click: () => this.updateSettings({ x: null, y: null }),
      },
      {
        label: '隐藏桌面伴侣',
        click: () => this.setEnabled(false),
      },
    ]);
    this.window.focus();
    menu.popup({ window: this.window });
  }

  private dispatchNavigate(target: PetNavigateTarget): void {
    if (target.kind === 'launcher') {
      this.options.showLauncher();
      return;
    }
    // 专注番茄钟在后台静默开关，不打断用户当前阅读或写作窗口
    if (target.kind !== 'focus') {
      this.options.restore();
    }
    const mainWin = this.options.main();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('readx-pet:navigate-main', target);
    }
  }

  private onReady = (event: Electron.IpcMainEvent) => {
    if (!this.window || event.sender !== this.window.webContents) return;
    this.ready = true;
    this.sendHost({ type: 'settings', settings: this.getSettings() });
    if (Object.keys(this.lastAppState).length) {
      this.sendHost({ type: 'appState', state: this.lastAppState });
    }
  };

  private onSetInteractive = (event: Electron.IpcMainEvent, next: unknown) => {
    if (!this.window || event.sender !== this.window.webContents) return;
    const interactive = Boolean(next);
    if (interactive === this.interactive) return;
    this.interactive = interactive;
    this.applyMouseIgnore();
  };

  private onShowContextMenu = (event: Electron.IpcMainEvent) => {
    if (!this.window || event.sender !== this.window.webContents) return;
    this.showContextMenu();
  };

  private onNavigateMain = (event: Electron.IpcMainEvent, target: unknown) => {
    if (!this.window || event.sender !== this.window.webContents || !isValidPetNavigateTarget(target)) return;
    this.dispatchNavigate(target);
  };

  private onLibraryUpdated = (event: Electron.IpcMainEvent) => {
    if (!this.window || event.sender !== this.window.webContents) return;
    const mainWin = this.options.main();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('readx-pet:library-updated');
    }
  };

  private onPublishAppState = (event: Electron.IpcMainEvent, state: unknown) => {
    const mainWin = this.options.main();
    if (!mainWin || event.sender !== mainWin.webContents || !state || typeof state !== 'object') return;
    this.lastAppState = { ...this.lastAppState, ...(state as PetAppState) };
    this.sendHost({ type: 'appState', state: this.lastAppState });
  };

  private readSettings(): PetSettings {
    try {
      const rawText = fs.readFileSync(this.options.settingsFile, 'utf8').replace(/^\uFEFF/, '');
      const raw = JSON.parse(rawText) as Partial<PetSettings>;
      return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_PET_SETTINGS.enabled,
        skin: normalizeSkin(raw.skin),
        clickThrough: typeof raw.clickThrough === 'boolean' ? raw.clickThrough : DEFAULT_PET_SETTINGS.clickThrough,
        scale: clampPetScale(raw.scale),
        opacity: clampPetOpacity(raw.opacity),
        accessory: normalizeAccessory(raw.accessory),
        soundEnabled: typeof raw.soundEnabled === 'boolean' ? raw.soundEnabled : DEFAULT_PET_SETTINGS.soundEnabled,
        waterReminderMin: normalizeWaterReminder(raw.waterReminderMin),
        x: typeof raw.x === 'number' && Number.isFinite(raw.x) ? Math.round(raw.x) : null,
        y: typeof raw.y === 'number' && Number.isFinite(raw.y) ? Math.round(raw.y) : null,
        peekEdge: raw.peekEdge === 'left' || raw.peekEdge === 'right' ? raw.peekEdge : 'none',
      };
    } catch {
      return { ...DEFAULT_PET_SETTINGS };
    }
  }

  private scheduleSaveSettings(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeSettingsNow();
    }, 250);
  }

  private writeSettingsNow(): void {
    try {
      const dir = path.dirname(this.options.settingsFile);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.options.settingsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 2), 'utf8');
      fs.renameSync(tmp, this.options.settingsFile);
    } catch (error) {
      this.options.log(`保存桌面伴侣设置失败：${String(error)}`);
    }
  }
}
