import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { AppDialog } from './AppDialog';
import { RAIL_ITEMS, type ScreenId } from './ActivityRail';
import { Icon } from './ui/Icon';
import type { ThemeChoice } from '../hooks/useTheme';

interface PaletteAction {
  id: string;
  group: string;
  label: string;
  meta?: string;
  onSelect: () => void;
}

export function CommandPalette({
  open,
  onClose,
  documents,
  onOpenDocument,
  onScreen,
  onImport,
  onSettings,
  onOpenOnboarding,
  onThemeChange,
}: {
  open: boolean;
  onClose: () => void;
  documents: DocumentSummary[];
  onOpenDocument: (id: string) => void;
  onScreen: (screen: ScreenId) => void;
  onImport: () => void;
  onSettings: () => void;
  onOpenOnboarding?: () => void;
  onThemeChange: (next: ThemeChoice) => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const actions = useMemo<PaletteAction[]>(() => {
    const q = query.trim().toLowerCase();
    const list: PaletteAction[] = [];

    for (const item of RAIL_ITEMS) {
      list.push({
        id: `nav-${item.id}`,
        group: '工作区',
        label: `切换到 ${item.label}`,
        meta: item.shortcut,
        onSelect: () => { onScreen(item.id); onClose(); },
      });
    }

    list.push(
      { id: 'cmd-import', group: '操作', label: '导入 PDF / EPUB 论文', onSelect: () => { onImport(); onClose(); } },
      { id: 'cmd-settings', group: '操作', label: '打开设置（AI / 同步 / 外观）', onSelect: () => { onSettings(); onClose(); } },
      ...(onOpenOnboarding ? [{ id: 'cmd-onboarding', group: '操作', label: '打开新手配置引导', onSelect: () => { onOpenOnboarding(); onClose(); } }] : []),
      { id: 'theme-light', group: '主题', label: '切换主题：浅色', onSelect: () => { onThemeChange('light'); onClose(); } },
      { id: 'theme-dark', group: '主题', label: '切换主题：深色', onSelect: () => { onThemeChange('dark'); onClose(); } },
      { id: 'theme-paper', group: '主题', label: '切换主题：纸张', onSelect: () => { onThemeChange('paper'); onClose(); } },
      { id: 'theme-system', group: '主题', label: '切换主题：跟随系统', onSelect: () => { onThemeChange('system'); onClose(); } },
    );

    const matchedDocs = q
      ? documents.filter((doc) => `${doc.title} ${doc.translatedTitle ?? ''} ${(doc.authors ?? []).join(' ')}`.toLowerCase().includes(q)).slice(0, 12)
      : documents.slice(0, 6);

    for (const doc of matchedDocs) {
      list.push({
        id: `doc-${doc.id}`,
        group: '论文',
        label: doc.title || doc.key,
        meta: [(doc.authors ?? [])[0], doc.year ? String(doc.year) : ''].filter(Boolean).join(' · ') || '打开阅读',
        onSelect: () => { onOpenDocument(doc.id); onClose(); },
      });
    }

    if (!q) return list;
    return list.filter((item) => `${item.group} ${item.label} ${item.meta ?? ''}`.toLowerCase().includes(q));
  }, [documents, onClose, onImport, onOpenDocument, onOpenOnboarding, onScreen, onSettings, onThemeChange, query]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  if (!open) return null;

  return (
    <AppDialog open onClose={onClose} closeOnBackdrop className="rx-dialog-md p-0 overflow-hidden" aria-label="命令面板">
      <div className="flex flex-col max-h-[70vh]">
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-line bg-surface">
          <Icon name="search" size={16} className="text-ink-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((i) => Math.min(actions.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter' && actions[cursor]) {
                e.preventDefault();
                actions[cursor].onSelect();
              }
            }}
            placeholder="搜索论文标题、切换工作区或执行命令…"
            className="flex-1 min-w-0 bg-transparent border-0 outline-0 text-sm text-ink placeholder:text-ink-faint"
          />
          <span className="rx-kbd">Esc</span>
        </div>
        <div className="overflow-y-auto p-2 flex-1">
          {actions.length === 0 ? (
            <p className="p-6 text-center text-xs text-ink-faint">没有匹配的论文或命令</p>
          ) : (
            actions.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                onClick={item.onSelect}
                onMouseEnter={() => setCursor(idx)}
                className={`flex items-center justify-between gap-3 w-full px-3 py-2 rounded-md text-left text-sm transition-colors ${
                  idx === cursor ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-surface-hover'
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="rx-tag shrink-0">{item.group}</span>
                  <span className="truncate font-medium">{item.label}</span>
                </span>
                {item.meta ? <span className="text-xs text-ink-faint shrink-0 num">{item.meta}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </AppDialog>
  );
}
