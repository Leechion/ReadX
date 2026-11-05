import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopLauncherBridge, DesktopSyncBridge, DesktopUpdateBridge, DesktopUpdateStatus } from '@cbct/shared';

/**
 * 唯一的渲染进程入口凭据通道：主进程用 additionalArguments 传进来，
 * 这里转成 window.__CBCT_V2__ 供 API 客户端读取。不暴露任何 Node 能力。
 */
function readArg(prefix: string): string {
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

const apiBase = readArg('--cbct-api-base=');
const token = readArg('--cbct-token=');

if (token) {
  contextBridge.exposeInMainWorld('__CBCT_V2__', { apiBase, token });
}

const updateBridge: DesktopUpdateBridge = {
  getStatus: () => ipcRenderer.invoke('readx-updates:status') as Promise<DesktopUpdateStatus>,
  check: () => ipcRenderer.invoke('readx-updates:check') as Promise<DesktopUpdateStatus>,
  download: () => ipcRenderer.invoke('readx-updates:download') as Promise<DesktopUpdateStatus>,
  install: () => ipcRenderer.invoke('readx-updates:install') as Promise<DesktopUpdateStatus>,
  onStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: DesktopUpdateStatus) => callback(status);
    ipcRenderer.on('readx-updates:status', listener);
    return () => ipcRenderer.removeListener('readx-updates:status', listener);
  },
};
contextBridge.exposeInMainWorld('__READX_DESKTOP_UPDATES__', updateBridge);

const syncBridge: DesktopSyncBridge = {
  chooseFolder: () => ipcRenderer.invoke('readx-sync:choose-folder') as Promise<string | null>,
  getNutstorePassword: () => ipcRenderer.invoke('readx-sync:get-nutstore-password') as Promise<string>,
  setNutstorePassword: (password) => ipcRenderer.invoke('readx-sync:set-nutstore-password', password) as Promise<void>,
};
contextBridge.exposeInMainWorld('__READX_SYNC__', syncBridge);
contextBridge.exposeInMainWorld('__READX_CAPTURE__', { enable: () => ipcRenderer.invoke('readx-capture:enable') });
contextBridge.exposeInMainWorld('__READX_BACKUP__', {
  prepare: (action: 'create' | 'restore') => ipcRenderer.invoke('readx-backup:prepare', action),
  cancel: () => ipcRenderer.invoke('readx-backup:cancel'),
  run: (action: 'create' | 'restore', browserState: string) => ipcRenderer.invoke('readx-backup:run', action, browserState),
  pendingBrowserState: () => ipcRenderer.invoke('readx-backup:browser-state'),
  acknowledgeBrowserState: () => ipcRenderer.invoke('readx-backup:acknowledge'),
});

const launcherBridge: DesktopLauncherBridge = {
  ready: () => ipcRenderer.send('readx-launcher:ready'),
  publish: (catalog) => ipcRenderer.send('readx-launcher:catalog', catalog),
  activate: (target) => ipcRenderer.send('readx-launcher:activate', target),
  dismiss: () => ipcRenderer.send('readx-launcher:dismiss'),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: Parameters<typeof callback>[0]) => callback(value);
    ipcRenderer.on('readx-launcher:event', listener);
    return () => ipcRenderer.removeListener('readx-launcher:event', listener);
  },
  onRequestCatalog: (callback) => {
    ipcRenderer.on('readx-launcher:request-catalog', callback);
    return () => ipcRenderer.removeListener('readx-launcher:request-catalog', callback);
  },
  onNavigate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: Parameters<typeof callback>[0]) => callback(value);
    ipcRenderer.on('readx-launcher:navigate', listener);
    return () => ipcRenderer.removeListener('readx-launcher:navigate', listener);
  },
};
contextBridge.exposeInMainWorld('__READX_LAUNCHER__', launcherBridge);
