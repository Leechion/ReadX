import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './ui/Icon';
import { ProgressRing } from './ui/Primitives';
import type { ThemeChoice } from '../hooks/useTheme';

export type ScreenId =
  | 'library'
  | 'reader'
  | 'compare'
  | 'graph'
  | 'reproduction'
  | 'presentation'
  | 'latex'
  | 'calendar'
  | 'research';

export const RAIL_ITEMS: ReadonlyArray<{
  id: ScreenId;
  label: string;
  icon: IconName;
  shortcut: string;
}> = [
  { id: 'library', label: '书库', icon: 'library', shortcut: 'Ctrl+1' },
  { id: 'reader', label: '阅读器', icon: 'book', shortcut: 'Ctrl+2' },
  { id: 'compare', label: '对照', icon: 'compare', shortcut: 'Ctrl+3' },
  { id: 'graph', label: '知识图谱', icon: 'graph', shortcut: 'Ctrl+4' },
  { id: 'reproduction', label: '代码复现', icon: 'flask', shortcut: 'Ctrl+5' },
  { id: 'presentation', label: '演示稿', icon: 'slides', shortcut: 'Ctrl+6' },
  { id: 'latex', label: 'LaTeX Studio', icon: 'code', shortcut: 'Ctrl+7' },
  { id: 'calendar', label: '阅读日历', icon: 'cal', shortcut: 'Ctrl+8' },
  { id: 'research', label: '研究工作台', icon: 'desk', shortcut: 'Ctrl+9' },
];

const THEME_LABELS: Record<ThemeChoice, string> = {
  light: '浅色',
  dark: '深色',
  paper: '纸张',
  system: '跟随系统',
};

export function ActivityRail({
  screen,
  onScreen,
  onImport,
  onSettings,
  onReload,
  onToggleCommandPalette,
  theme,
  onThemeChange,
  connected,
  activeJobCount = 0,
  onOpenJobs,
}: {
  screen: ScreenId;
  onScreen: (next: ScreenId) => void;
  onImport: () => void;
  onSettings: () => void;
  onReload: () => void;
  onToggleCommandPalette?: () => void;
  theme: ThemeChoice;
  onThemeChange: (next: ThemeChoice) => void;
  connected: boolean;
  activeJobCount?: number;
  onOpenJobs?: () => void;
}) {
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!themeMenuRef.current?.contains(event.target as Node)) setThemeMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setThemeMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [themeMenuOpen]);

  return (
    <nav className="rx-rail" aria-label="ReadX 工作区导航">
      <button
        type="button"
        className="rx-mark"
        onClick={() => onScreen('library')}
        title="ReadX — 返回书库"
        aria-label="ReadX，返回书库"
      >
        <img src="/icon.svg" alt="ReadX" draggable={false} />
      </button>

      <button
        type="button"
        className="rx-rail-add"
        onClick={onImport}
        aria-label="导入 PDF / EPUB"
        title="导入 PDF / EPUB"
      >
        <Icon name="plus" size={18} />
      </button>

      {RAIL_ITEMS.map((item) => {
        const active = screen === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className="rx-rail-nav"
            aria-current={active ? 'page' : undefined}
            aria-label={`${item.label}（${item.shortcut}）`}
            onClick={() => onScreen(item.id)}
          >
            <Icon name={item.icon} size={19} />
            <span className="rx-tip">
              {item.label} <span className="opacity-70">{item.shortcut}</span>
            </span>
          </button>
        );
      })}

      <div className="rx-rail-spacer" />

      {onToggleCommandPalette ? (
        <button
          type="button"
          className="rx-rail-nav"
          onClick={onToggleCommandPalette}
          aria-label="命令面板（Ctrl+K）"
        >
          <Icon name="search" size={18} />
          <span className="rx-tip">命令面板 Ctrl+K</span>
        </button>
      ) : null}

      {activeJobCount > 0 && onOpenJobs ? (
        <button
          type="button"
          className="rx-rail-sync"
          onClick={onOpenJobs}
          title={`后台处理任务：${activeJobCount} 个进行中`}
          aria-label={`后台处理任务：${activeJobCount} 个进行中`}
        >
          <ProgressRing value={45} max={100} />
          <span className="num">{activeJobCount}</span>
        </button>
      ) : null}

      <button
        type="button"
        className="rx-rail-nav"
        onClick={onReload}
        aria-label={connected ? '后端已连接，点按重连' : '后端未连接，点按重试'}
      >
        <span className={`rx-rail-sync-dot${connected ? ' ready' : ''}`} />
        <span className="rx-tip">{connected ? '后端已连接 · 点击刷新' : '后端未连接 · 点击重试'}</span>
      </button>

      <div className="rx-rail-menu-wrap" ref={themeMenuRef}>
        <button
          type="button"
          className="rx-rail-nav"
          onClick={() => setThemeMenuOpen((open) => !open)}
          aria-label={`切换主题（当前：${THEME_LABELS[theme]}）`}
          aria-expanded={themeMenuOpen}
        >
          <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={18} />
          <span className="rx-tip">主题：{THEME_LABELS[theme]}</span>
        </button>
        {themeMenuOpen ? (
          <div className="rx-rail-popover" role="menu" aria-label="界面主题">
            {(['light', 'dark', 'paper', 'system'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="menuitemradio"
                aria-checked={theme === item}
                className="rx-menu-item"
                onClick={() => {
                  onThemeChange(item);
                  setThemeMenuOpen(false);
                }}
              >
                <Icon name={item === 'dark' ? 'moon' : item === 'system' ? 'sliders' : 'sun'} size={14} />
                <span className="flex-1">{THEME_LABELS[item]}</span>
                {theme === item ? <Icon name="check" size={14} /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        className="rx-rail-nav"
        onClick={onSettings}
        aria-label="设置"
      >
        <Icon name="sliders" size={18} />
        <span className="rx-tip">设置</span>
      </button>
    </nav>
  );
}
