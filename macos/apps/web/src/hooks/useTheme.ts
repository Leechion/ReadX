import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEYS } from '../lib/storage';

export type ThemeChoice = 'light' | 'dark' | 'paper' | 'system';
export type InterfaceDensity = 'comfortable' | 'compact';
export type ReadingFont = 'sans' | 'serif';

const STORAGE_KEY = STORAGE_KEYS.theme;
const APPEARANCE_KEY = 'cbct-v2-appearance';
const CHOICES: ThemeChoice[] = ['light', 'dark', 'paper', 'system'];

interface AppearanceState {
  density: InterfaceDensity;
  readingFont: ReadingFont;
  readingSize: number;
}

const DEFAULT_APPEARANCE: AppearanceState = {
  density: 'comfortable',
  readingFont: 'sans',
  readingSize: 15,
};

function read(): ThemeChoice {
  if (typeof localStorage === 'undefined') return 'system';
  const stored = localStorage.getItem(STORAGE_KEY);
  return CHOICES.includes(stored as ThemeChoice) ? (stored as ThemeChoice) : 'system';
}

function readAppearance(): AppearanceState {
  if (typeof localStorage === 'undefined') return DEFAULT_APPEARANCE;
  try {
    const raw = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? 'null') as Partial<AppearanceState> | null;
    const density: InterfaceDensity = raw?.density === 'compact' ? 'compact' : 'comfortable';
    const readingFont: ReadingFont = raw?.readingFont === 'serif' ? 'serif' : 'sans';
    const size = typeof raw?.readingSize === 'number' && Number.isFinite(raw.readingSize)
      ? Math.min(18, Math.max(14, Math.round(raw.readingSize)))
      : 15;
    return { density, readingFont, readingSize: size };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function systemPrefersDark(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * 三主题 + 跟随系统 + 界面密度 / 译文字体 / 阅读字号偏好。
 * 主题写在 <html data-theme>，密度写在 <html data-density>，译文字体写在 <html data-reading>，
 * 阅读字号写在 --reading-font-size，CSS 变量据此统一切换。
 */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(read);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const [appearance, setAppearance] = useState<AppearanceState>(readAppearance);

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const listener = () => setSystemDark(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  const resolved = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.setAttribute('data-density', appearance.density);
    root.setAttribute('data-reading', appearance.readingFont);
    root.style.setProperty('--reading-font-size', `${appearance.readingSize}px`);
  }, [resolved, appearance]);

  const update = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* 隐私模式下写不了 localStorage：本次会话仍生效。 */
    }
  }, []);

  const updateAppearance = useCallback((patch: Partial<AppearanceState>) => {
    setAppearance((current) => {
      const next: AppearanceState = {
        density: patch.density ?? current.density,
        readingFont: patch.readingFont ?? current.readingFont,
        readingSize: patch.readingSize !== undefined
          ? Math.min(18, Math.max(14, Math.round(patch.readingSize)))
          : current.readingSize,
      };
      try {
        localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next));
      } catch {
        /* 隐私模式下写不了 localStorage：本次会话仍生效。 */
      }
      return next;
    });
  }, []);

  return {
    choice,
    resolved,
    setTheme: update,
    density: appearance.density,
    readingFont: appearance.readingFont,
    readingSize: appearance.readingSize,
    setAppearance: updateAppearance,
  };
}
