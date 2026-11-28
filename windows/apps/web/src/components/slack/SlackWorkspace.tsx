import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThemeChoice } from '../../hooks/useTheme';
import { useSlackLibrary } from '../../hooks/useSlackLibrary';
import { readString, writeString, STORAGE_KEYS } from '../../lib/storage';
import { BookFinder } from './BookFinder';
import { CountdownWidget } from './CountdownWidget';
import { GAME_TABS, GameHub } from './GameHub';
import { SlackLibrary, type SlackFilter } from './SlackLibrary';
import { SlackReader } from './SlackReader';
import { recordReading, weekStats, type SlackStatsWeek } from './stats';
import type { SlackItem } from './types';
import type { LauncherOpenRequest } from '@cbct/shared';

export function SlackWorkspace({
  onExit,
  theme,
  onThemeChange,
  launchRequest,
}: {
  onExit: () => void;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  launchRequest?: LauncherOpenRequest | null;
}) {
  const {
    items,
    ready,
    error,
    jobs,
    addFiles,
    importDownloadedBook,
    importWebNovel,
    loadWebChapter,
    refreshWebToc,
    remove,
    saveProgress,
    open,
    dismissJobs,
    setError,
  } = useSlackLibrary();
  const [openId, setOpenId] = useState<string | null>(null);
  const [section, setSection] = useState<'shelf' | 'find' | 'game'>('shelf');
  const [countdownHidden, setCountdownHidden] = useState(() => readString(STORAGE_KEYS.slackCountdownOff, '') === '1');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SlackFilter>('all');
  const [confirmItem, setConfirmItem] = useState<SlackItem | null>(null);
  const [dragging, setDragging] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const handledLaunch = useRef<number | null>(null);
  useEffect(() => {
    if (!launchRequest || !ready || handledLaunch.current === launchRequest.nonce) return;
    handledLaunch.current = launchRequest.nonce;
    if (launchRequest.id === 'section:game' || launchRequest.id === 'section:find') {
      setOpenId(null); setSection(launchRequest.id === 'section:game' ? 'game' : 'find');
    } else if (launchRequest.id && items.some(item => item.id === launchRequest.id)) {
      setSection('shelf'); setOpenId(launchRequest.id); void open(launchRequest.id);
    } else { setOpenId(null); setSection('shelf'); }
  }, [launchRequest, ready, items, open]);

  const current = useMemo(() => items.find((item) => item.id === openId) ?? null, [items, openId]);

  // 摸鱼周报：回到书架时重算（current 变化必然触发），阅读中每 30 秒记一次时长。
  const stats: SlackStatsWeek = useMemo(() => weekStats(), [current, section, items.length]);
  useEffect(() => {
    if (!current) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) recordReading(30);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [current]);

  const hideCountdown = () => {
    writeString(STORAGE_KEYS.slackCountdownOff, '1');
    setCountdownHidden(true);
  };
  const showCountdown = () => {
    writeString(STORAGE_KEYS.slackCountdownOff, '');
    setCountdownHidden(false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.defaultPrevented) return;
      if (confirmItem) {
        event.preventDefault();
        setConfirmItem(null);
        return;
      }
      // Esc 分层退出：小游戏先回书架，再按才离开摸鱼界面。
      if (section === 'game') {
        event.preventDefault();
        setSection('shelf');
        return;
      }
      event.preventDefault();
      onExit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirmItem, onExit, section]);

  const handleOpen = (id: string) => {
    setOpenId(id);
    void open(id);
  };

  const handleDelete = async (item: SlackItem) => {
    if (openId === item.id) setOpenId(null);
    await remove(item.id);
  };

  return (
    <div
      className="slack-workspace"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length) void addFiles(files);
      }}
    >
      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        accept=".txt,.md,.markdown,.epub,.zip,.cbz,image/*"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) void addFiles(files);
        }}
      />

      <header className="slack-topbar">
        <button
          type="button"
          className="slack-brand"
          onClick={() => {
            setOpenId(null);
            setSection('shelf');
          }}
          title="回到资料书架"
        >
          <span className="slack-brand__mark" aria-hidden="true">◈</span>
          <span>
            <strong>ReadX</strong>
          </span>
        </button>

        <div className="slack-topbar__title">
          {current ? (
            <>
              <button type="button" className="slack-topbar__back" onClick={() => setOpenId(null)}>
                ← 文库
              </button>
              <span className="slack-topbar__divider" aria-hidden="true" />
              <strong>{current.title}</strong>
              <small>{current.kind === 'comic' ? '漫画' : '小说'}</small>
            </>
          ) : (
            <>
              <nav className="slack-section-nav" aria-label="摸鱼界面导航">
                <button type="button" className={section === 'shelf' ? 'active' : ''} aria-current={section === 'shelf' ? 'page' : undefined} onClick={() => setSection('shelf')}>我的书架</button>
                <button type="button" className={section === 'find' ? 'active' : ''} aria-current={section === 'find' ? 'page' : undefined} onClick={() => setSection('find')}>找书</button>
                <button type="button" className={section === 'game' ? 'active' : ''} aria-current={section === 'game' ? 'page' : undefined} onClick={() => setSection('game')}>小游戏</button>
              </nav>
              <small>{section === 'find' ? '多书源 · 直接导入本地' : section === 'game' ? `${GAME_TABS.length} 款桌面小游戏` : '本地书架'}</small>
            </>
          )}
        </div>

        <div className="slack-topbar__actions">
          {current ? null : (
            <select
              className="slack-theme"
              aria-label="界面主题"
              value={theme}
              onChange={(event) => onThemeChange(event.target.value as ThemeChoice)}
            >
              <option value="light">浅色</option>
              <option value="dark">深色</option>
              <option value="paper">纸张</option>
              <option value="system">跟随系统</option>
            </select>
          )}
          <button type="button" className="slack-boss" onClick={onExit} title="立即返回科研工作台（Ctrl+Shift+M / Esc）">
            ← 返回工作区
          </button>
        </div>
      </header>

      <div className="slack-main">
        {current ? (
          <SlackReader
            key={current.id}
            item={current}
            onProgress={(progress) => void saveProgress(current.id, progress)}
            onLoadChapter={(chapter) => loadWebChapter(current.id, chapter)}
            onRefreshToc={() => refreshWebToc(current.id)}
          />
        ) : section === 'find' ? (
          <BookFinder
            items={items}
            onOpen={handleOpen}
            onUpload={() => uploadInput.current?.click()}
            onImport={async (file, metadata) => {
              const item = await importDownloadedBook(file, metadata);
              setSection('shelf');
              setOpenId(item.id);
              void open(item.id);
            }}
            onImportWebNovel={async (source, book) => {
              const item = await importWebNovel(source, book);
              setSection('shelf');
              setOpenId(item.id);
              void open(item.id);
            }}
          />
        ) : section === 'game' ? (
          <GameHub onEscape={() => setSection('shelf')} />
        ) : (
          <SlackLibrary
            items={items}
            ready={ready}
            query={query}
            onQuery={setQuery}
            filter={filter}
            onFilter={setFilter}
            onOpen={handleOpen}
            onDelete={setConfirmItem}
            onUpload={() => uploadInput.current?.click()}
            onFind={() => setSection('find')}
            stats={stats}
            countdownHidden={countdownHidden}
            onShowCountdown={showCountdown}
          />
        )}
      </div>

      {countdownHidden ? null : <CountdownWidget onClose={hideCountdown} />}

      {dragging ? (
        <div className="slack-drop" aria-hidden="true">
          <div>
            <span>＋</span>
            <strong>松手就加入本地书架</strong>
            <small>TXT / EPUB / 图片 / ZIP / CBZ</small>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="slack-error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="关闭提示">×</button>
        </div>
      ) : null}

      {jobs.length ? (
        <div className="slack-jobs" role="status" aria-live="polite">
          <header>
            <strong>导入队列</strong>
            <button type="button" onClick={dismissJobs}>收起</button>
          </header>
          <ul>
            {jobs.map((job) => (
              <li key={job.id} data-status={job.status}>
                <span className="slack-jobs__dot" aria-hidden="true" />
                <div>
                  <strong>{job.name}</strong>
                  <small>{job.message}</small>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {confirmItem ? (
        <div
          className="slack-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="slack-delete-title"
          onClick={() => setConfirmItem(null)}
        >
          <div className="slack-modal__card" onClick={(event) => event.stopPropagation()}>
            <h2 id="slack-delete-title">删除《{confirmItem.title}》？</h2>
            <p>只会从本机浏览器里删除，服务端和原文件都不受影响。此操作无法撤销。</p>
            <div className="slack-modal__actions">
              <button type="button" onClick={() => setConfirmItem(null)}>取消</button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  const target = confirmItem;
                  setConfirmItem(null);
                  void handleDelete(target);
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
