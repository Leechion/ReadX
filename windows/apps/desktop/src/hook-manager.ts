import { systemPreferences } from 'electron';
import type {
  UiohookKeyboardEvent,
  UiohookMouseEvent,
  UiohookWheelEvent,
} from 'uiohook-napi';

export interface GlobalHookHandlers {
  onKeyDown?: (event: UiohookKeyboardEvent) => void;
  onKeyUp?: (event: UiohookKeyboardEvent) => void;
  onMouseMove?: (event: UiohookMouseEvent) => void;
  onMouseDown?: (event: UiohookMouseEvent) => void;
  onWheel?: (event: UiohookWheelEvent) => void;
}

type HookMod = typeof import('uiohook-napi');

let hookMod: HookMod | null = null;
let started = false;
const subscribers = new Set<GlobalHookHandlers>();

function loadHook(): HookMod {
  if (!hookMod) {
    hookMod = require('uiohook-napi') as HookMod;
  }
  return hookMod;
}

const dispatchKeyDown = (event: UiohookKeyboardEvent) => {
  for (const sub of subscribers) sub.onKeyDown?.(event);
};
const dispatchKeyUp = (event: UiohookKeyboardEvent) => {
  for (const sub of subscribers) sub.onKeyUp?.(event);
};
const dispatchMouseMove = (event: UiohookMouseEvent) => {
  for (const sub of subscribers) sub.onMouseMove?.(event);
};
const dispatchMouseDown = (event: UiohookMouseEvent) => {
  for (const sub of subscribers) sub.onMouseDown?.(event);
};
const dispatchWheel = (event: UiohookWheelEvent) => {
  for (const sub of subscribers) sub.onWheel?.(event);
};

export function canStartGlobalHook(): boolean {
  return process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false);
}

/**
 * 统一托管 uiohook-napi 单例生命周期，避免快速轮盘与桌面伴侣各自启停钩子冲突。
 */
export function subscribeGlobalHook(
  handlers: GlobalHookHandlers,
  onError?: (error: unknown) => void,
): (() => void) | null {
  if (!canStartGlobalHook()) return null;
  const first = subscribers.size === 0;
  subscribers.add(handlers);

  if (first && !started) {
    try {
      const { uIOhook } = loadHook();
      uIOhook.on('keydown', dispatchKeyDown);
      uIOhook.on('keyup', dispatchKeyUp);
      uIOhook.on('mousemove', dispatchMouseMove);
      uIOhook.on('mousedown', dispatchMouseDown);
      uIOhook.on('wheel', dispatchWheel);
      uIOhook.start();
      started = true;
    } catch (error) {
      subscribers.delete(handlers);
      onError?.(error);
      return null;
    }
  }

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    subscribers.delete(handlers);
    if (subscribers.size === 0 && started) {
      try {
        const { uIOhook } = loadHook();
        uIOhook.removeListener('keydown', dispatchKeyDown);
        uIOhook.removeListener('keyup', dispatchKeyUp);
        uIOhook.removeListener('mousemove', dispatchMouseMove);
        uIOhook.removeListener('mousedown', dispatchMouseDown);
        uIOhook.removeListener('wheel', dispatchWheel);
        uIOhook.stop();
      } catch {
        // Ignore hook teardown errors during app shutdown.
      } finally {
        started = false;
      }
    }
  };
}
