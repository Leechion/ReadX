import { Activity, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
const ReaderScreen = lazy(() => import('./components/ReaderScreen').then((module) => ({ default: module.ReaderScreen })));
const ReproductionSection = lazy(() => import('./components/ReproductionSection').then((module) => ({ default: module.ReproductionSection })));
import { LibraryScreen } from './components/LibraryScreen';
import type { DocumentSummary, LauncherOpenRequest, LauncherTarget, LauncherWorkspace } from '@cbct/shared';
const KnowledgeGraphSection = lazy(() => import('./components/KnowledgeGraphSection').then((module) => ({ default: module.KnowledgeGraphSection })));
const ReadingCalendarSection = lazy(() => import('./components/ReadingCalendarSection').then((module) => ({ default: module.ReadingCalendarSection })));
import { useAnnotations } from './hooks/useAnnotations';
import { useDocument } from './hooks/useDocument';
import { useLibraryMeta } from './hooks/useLibraryMeta';
import { useTheme } from './hooks/useTheme';
import { useWorkspace } from './hooks/useWorkspace';
import { ActivityRail, RAIL_ITEMS, type ScreenId } from './components/ActivityRail';
import { CommandPalette } from './components/CommandPalette';
import { Icon } from './components/ui/Icon';
const ImportDialog = lazy(() => import('./components/ImportDialog').then((module) => ({ default: module.ImportDialog })));
const RetranslateDialog = lazy(() => import('./components/RetranslateDialog').then((module) => ({ default: module.RetranslateDialog })));
const DocumentJobDialog = lazy(() => import('./components/DocumentJobDialog').then((module) => ({ default: module.DocumentJobDialog })));
const AISettingsDialog = lazy(() => import('./components/AISettingsDialog').then((module) => ({ default: module.AISettingsDialog })));
const PresentationWorkspace = lazy(() => import('./components/PresentationWorkspace').then((module) => ({ default: module.PresentationWorkspace })));
const CompareWorkspace = lazy(() => import('./components/CompareWorkspace').then((module) => ({ default: module.CompareWorkspace })));
const LatexStudio = lazy(() => import('./components/latex/LatexStudio').then((module) => ({ default: module.LatexStudio })));
const SlackWorkspace = lazy(() => import('./components/slack/SlackWorkspace').then((module) => ({ default: module.SlackWorkspace })));
import { ModePendant, type WorkspaceMode } from './components/slack/ModePendant';
import './components/slack/slack.css';
import { STORAGE_KEYS } from './lib/storage';
import { ResearchWorkbench } from './components/ResearchWorkbench';
import { FocusPendant } from './components/research/FocusPendant';
import { useResearchWorkbench } from './hooks/useResearchWorkbench';
import { useLauncherCatalog } from './hooks/useLauncherCatalog';
import { api } from './api/client';

type Screen = ScreenId;

const MODE_KEY = STORAGE_KEYS.workspaceMode;

function readReaderPopupTarget(): { documentId: string; page: number | null } | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get('readxWindow') !== 'reader') return null;
  const documentId = params.get('documentId') ?? '';
  if (!/^[\w-]{1,128}$/.test(documentId)) return null;
  const pageValue = params.get('page');
  const page = pageValue && /^\d{1,5}$/.test(pageValue) && Number(pageValue) > 0 ? Number(pageValue) : null;
  return { documentId, page };
}

function readWorkspaceMode(): WorkspaceMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'slack' ? 'slack' : 'research';
  } catch {
    return 'research';
  }
}

export default function App() {
  const researchWorkbench = useResearchWorkbench();
  const popupTarget = useMemo(readReaderPopupTarget, []);
  const {
    phase,
    allDocuments,
    filters,
    setFilters,
    reload,
  } = useWorkspace();
  const [screen, commitScreen] = useState<Screen>(() => popupTarget ? 'reader' : 'library');
  const currentScreen = useRef(screen);
  currentScreen.current = screen;
  const latexBeforeLeave = useRef<(() => Promise<boolean>) | null>(null);
  const registerLatexBeforeLeave = useCallback((guard: (() => Promise<boolean>) | null) => {
    latexBeforeLeave.current = guard;
  }, []);
  const setScreen = useCallback((next: Screen) => {
    const guard = latexBeforeLeave.current;
    if (currentScreen.current === 'latex' && next !== 'latex' && guard) {
      void guard().then((saved) => { if (saved) commitScreen(next); });
    } else {
      commitScreen(next);
    }
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(() => popupTarget?.documentId ?? null);
  const [importFiles, setImportFiles] = useState<File[] | null>(null);
  const [dragHover, setDragHover] = useState(false);
  const dragDepth = useRef(0);
  const [retranslateDocument, setRetranslateDocument] = useState<DocumentSummary | null>(null);
  const [processingDocument, setProcessingDocument] = useState<DocumentSummary | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [activeJobCount, setActiveJobCount] = useState(0);
  const [launcherRequest, setLauncherRequest] = useState<LauncherOpenRequest | null>(null);
  const [launcherError, setLauncherError] = useState('');
  const [libraryView, setLibraryView] = useState<'all' | 'favorite' | 'trash' | 'shelves'>('all');
  const [mode, setMode] = useState<WorkspaceMode>(readWorkspaceMode);
  const [curtain, setCurtain] = useState<{ target: WorkspaceMode; phase: 'closing' | 'opening' } | null>(null);
  const changingMode = useRef(false);

  const switchMode = useCallback((next: WorkspaceMode) => {
    if (changingMode.current || next === mode) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setMode(next);
      return;
    }
    changingMode.current = true;
    setCurtain({ target: next, phase: 'closing' });
  }, [mode]);

  const returnToResearch = useCallback(() => {
    changingMode.current = false;
    setCurtain(null);
    setMode('research');
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* 隐私模式下写不了 localStorage：本次会话仍然生效。 */
    }
    document.documentElement.dataset.workspace = mode;
  }, [mode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && changingMode.current) {
        event.preventDefault();
        returnToResearch();
        return;
      }
      if (event.ctrlKey && event.shiftKey && (event.key === 'M' || event.key === 'm')) {
        event.preventDefault();
        switchMode(mode === 'slack' ? 'research' : 'slack');
        return;
      }
      if (mode !== 'research' || popupTarget) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.shiftKey && !event.altKey) {
        const lower = event.key.toLowerCase();
        if (lower === 'k') {
          event.preventDefault();
          setCommandOpen((open) => !open);
          return;
        }
        if (event.key === '\\') {
          event.preventDefault();
          window.dispatchEvent(new CustomEvent('readx-toggle-sidebar'));
          return;
        }
        if (event.key === '.') {
          event.preventDefault();
          window.dispatchEvent(new CustomEvent('readx-toggle-inspector'));
          return;
        }
        const digit = Number(event.key);
        if (digit >= 1 && digit <= 9) {
          const target = RAIL_ITEMS[digit - 1];
          if (target) {
            event.preventDefault();
            setScreen(target.id);
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, popupTarget, returnToResearch, setScreen, switchMode]);

  const documents = phase.kind === 'ready' ? phase.documents.documents : [];
  const navigationDocuments = useMemo(
    () => (allDocuments.length ? allDocuments : documents),
    [allDocuments, documents],
  );
  const selected = useMemo(
    () => navigationDocuments.find((doc) => doc.id === selectedId) ?? null,
    [navigationDocuments, selectedId],
  );
  const detail = useDocument(
    screen === 'reader' ? (selected?.key ?? null) : null,
  );
  const annotations = useAnnotations(
    screen === 'reader' ? (selected?.key ?? null) : null,
  );
  const libraryMeta = useLibraryMeta();
  const theme = useTheme();
  const [page, setPage] = useState<number | null>(() => popupTarget?.page ?? null);
  const [cite, setCite] = useState<{ page: number; nonce: number } | null>(
    () => popupTarget?.page != null ? { page: popupTarget.page, nonce: 1 } : null,
  );
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);
  const [pendingFind, setPendingFind] = useState<{
    query: string;
    page: number;
    nonce: number;
  } | null>(null);
  const lastScreen = useRef<string>('library');

  useEffect(() => {
    if (popupTarget || typeof api.documentJobs !== 'function') return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const res = await api.documentJobs(controller.signal);
        if (controller.signal.aborted) return;
        const count = res.jobs.filter((job) => job.status === 'running' || job.stages?.some((s) => s.status === 'running')).length;
        setActiveJobCount(count);
      } catch {
        /* ignore background polling errors */
      }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 5000);
    };
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [popupTarget]);

  useEffect(() => {
    if (popupTarget) return;
    let running = false;
    const syncIfConfigured = async () => {
      if (running || document.visibilityState !== 'visible') return;
      running = true;
      try {
        const settings = await api.syncSettings();
        if (!settings.enabled) return;
        const password = settings.provider === 'jianguoyun' ? await window.__READX_SYNC__?.getNutstorePassword() : '';
        if (settings.provider === 'jianguoyun' && !password) return;
        await api.syncNow({ password });
        window.dispatchEvent(new Event('readx-sync-complete'));
        reload();
      } catch {
        // Temporary cloud-folder delay is retried on next focus/interval.
      } finally {
        running = false;
      }
    };
    void syncIfConfigured();
    const timer = window.setInterval(() => { void syncIfConfigured(); }, 120_000);
    window.addEventListener('focus', syncIfConfigured);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', syncIfConfigured);
    };
  }, [popupTarget, reload]);

  const pages =
    detail.phase.kind === 'ready'
      ? detail.phase.detail.pages.map((item) => item.page)
      : [];

  useEffect(() => {
    if (pages.length) setPage((current) => current ?? pages[0] ?? null);
  }, [pages.join(',')]);

  useEffect(() => {
    if (screen !== 'reader' && lastScreen.current === 'reader') setCite(null);
    lastScreen.current = screen;
  }, [screen]);

  const citePage = useCallback((target: number) => {
    setPage(target);
    setCite((current) => ({ page: target, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  const citeInDocument = useCallback(
    (target: { key: string; page: number }) => {
      const doc = navigationDocuments.find((item) => item.key === target.key);
      if (doc) setSelectedId(doc.id);
      setPage(target.page);
      setCite((current) => ({ page: target.page, nonce: (current?.nonce ?? 0) + 1 }));
      setScreen('reader');
    },
    [navigationDocuments, setScreen],
  );

  const focusAnnotation = useCallback(
    (id: string, targetPage: number | null) => {
      setFocusedAnnotationId(id);
      if (targetPage != null) citePage(targetPage);
    },
    [citePage],
  );

  const openDocument = useCallback((id: string) => {
    setPage(null);
    setCite(null);
    setFocusedAnnotationId(null);
    setPendingFind(null);
    setSelectedId(id);
    setScreen('reader');
  }, [setScreen]);

  const openDocumentByKey = useCallback(
    (key: string) => {
      const doc = navigationDocuments.find((item) => item.key === key);
      if (doc) openDocument(doc.id);
    },
    [navigationDocuments, openDocument],
  );

  const openSearchHit = useCallback(
    (key: string, target: number, query: string) => {
      const doc = navigationDocuments.find((item) => item.key === key);
      if (doc) setSelectedId(doc.id);
      setCite(null);
      setFocusedAnnotationId(null);
      setPage(target);
      setPendingFind((current) => ({
        query,
        page: target,
        nonce: (current?.nonce ?? 0) + 1,
      }));
      setScreen('reader');
    },
    [navigationDocuments, setScreen],
  );

  const openReproduction = useCallback(
    (key: string) => {
      const target = navigationDocuments.find((doc) => doc.key === key);
      if (target) setSelectedId(target.id);
      setScreen('reproduction');
    },
    [navigationDocuments, setScreen],
  );

  const pickForReproduction = useCallback(
    (key: string) => {
      const target = navigationDocuments.find((doc) => doc.key === key);
      if (target) setSelectedId(target.id);
    },
    [navigationDocuments],
  );

  const launcherDocuments = useMemo(() => navigationDocuments.filter(doc => !libraryMeta.items[doc.key]?.deleted), [navigationDocuments, libraryMeta.items]);
  const navigateFromLauncher = useCallback((target: LauncherTarget) => {
    void (async () => {
      try {
        if (currentScreen.current === 'latex' && latexBeforeLeave.current && !await latexBeforeLeave.current()) return;
        setLauncherError('');
        setLauncherRequest(current => ({ ...target, nonce: (current?.nonce ?? 0) + 1 }));
        changingMode.current = false;
        setCurtain(null);
        if (target.workspace === 'slack') { setMode('slack'); return; }
        setMode('research');
        if (target.workspace === 'library') {
          if (target.id) openDocument(target.id);
          else { setLibraryView('all'); commitScreen('library'); }
        } else if (target.workspace === 'research') {
          const tab = target.id?.startsWith('tab:') ? target.id.slice(4) : 'daily';
          if (tab === 'daily' || tab === 'academics' || tab === 'news') researchWorkbench.setData(current => ({ ...current, activeTab: tab }));
          commitScreen('research');
        } else commitScreen(target.workspace);
      } catch (error) { setLauncherError(error instanceof Error ? error.message : '打开工作区失败'); }
    })();
  }, [openDocument, researchWorkbench.setData]);
  useLauncherCatalog({
    current: mode === 'slack' ? 'slack' : (['library', 'research', 'presentation', 'latex'].includes(screen) ? screen as LauncherWorkspace : 'library'),
    documents: launcherDocuments, workbench: researchWorkbench.data, onNavigate: navigateFromLauncher,
    enabled: !popupTarget,
  });

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onDragEnter={(event) => {
        if (mode !== 'research') return;
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          dragDepth.current += 1;
          setDragHover(true);
        }
      }}
      onDragOver={(event) => {
        if (mode !== 'research') return;
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDragLeave={() => {
        if (mode !== 'research') return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragHover(false);
      }}
      onDrop={(event) => {
        if (mode !== 'research') return;
        dragDepth.current = 0;
        setDragHover(false);
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          setImportFiles(Array.from(event.dataTransfer.files));
        }
      }}
    >
      {mode === 'slack' ? (
        <Suspense fallback={<p className="p-6" role="status">加载中…</p>}>
          <SlackWorkspace
            onExit={returnToResearch}
            theme={theme.choice}
            onThemeChange={theme.setTheme}
            launchRequest={launcherRequest?.workspace === 'slack' ? launcherRequest : null}
          />
        </Suspense>
      ) : null}

      <Activity mode={mode === 'research' ? 'visible' : 'hidden'}>
        <div className="rx-shell">
          {!popupTarget ? (
            <ActivityRail
              screen={screen}
              onScreen={setScreen}
              onImport={() => setImportFiles([])}
              onSettings={() => setSettingsOpen(true)}
              onReload={reload}
              onToggleCommandPalette={() => setCommandOpen(true)}
              theme={theme.choice}
              onThemeChange={theme.setTheme}
              connected={phase.kind === 'ready'}
              activeJobCount={activeJobCount}
              onOpenJobs={() => {
                setLibraryView('all');
                setScreen('library');
                window.dispatchEvent(new CustomEvent('readx-open-jobs'));
              }}
            />
          ) : null}

          <div className="rx-workspace-slot">
            <Suspense fallback={<p className="p-6 text-sm text-ink-soft" role="status">加载中…</p>}>
              {screen === 'library' ? (
                <LibraryScreen
                  phase={phase}
                  allDocuments={navigationDocuments}
                  filters={filters}
                  setFilters={setFilters}
                  selectedId={selectedId}
                  onOpenDocument={openDocument}
                  onRetranslate={setRetranslateDocument}
                  onOpenProcessing={setProcessingDocument}
                  onOpenImport={() => setImportFiles([])}
                  onOpenAcademic={() => setScreen('research')}
                  onOpenSettings={() => setSettingsOpen(true)}
                  meta={libraryMeta}
                  view={libraryView}
                  onViewChange={(view) => {
                    if (view === 'all' || view === 'favorite' || view === 'trash' || view === 'shelves')
                      setLibraryView(view);
                    setScreen(
                      view === 'graph'
                        ? 'graph'
                        : view === 'calendar'
                          ? 'calendar'
                          : view === 'compare'
                            ? 'compare'
                            : 'library',
                    );
                  }}
                  onOpenReproduction={openReproduction}
                  onTrashEmptied={() => { setSelectedId(null); reload(); }}
                  onReload={reload}
                  onOpenAtPage={openSearchHit}
                />
              ) : screen === 'presentation' ? (
                <PresentationWorkspace documents={launcherDocuments} onBack={() => setScreen('library')} launchRequest={launcherRequest?.workspace === 'presentation' ? launcherRequest : null} />
              ) : screen === 'compare' ? (
                <CompareWorkspace
                  documents={navigationDocuments.filter((doc) => !libraryMeta.items[doc.key]?.deleted)}
                  onBack={() => setScreen('library')}
                  onOpenAtPage={openSearchHit}
                  onOpenDocument={openDocument}
                />
              ) : screen === 'latex' ? (
                <LatexStudio documents={launcherDocuments} registerBeforeLeave={registerLatexBeforeLeave} launchRequest={launcherRequest?.workspace === 'latex' ? launcherRequest : null} />
              ) : screen === 'reader' ? (
                <ReaderScreen
                  key={selected?.id ?? 'empty'}
                  detail={detail.phase}
                  selected={selected}
                  page={page}
                  onPage={setPage}
                  onBack={() => setScreen('library')}
                  onPopout={() => {
                    if (!selected) return;
                    const params = new URLSearchParams({ readxWindow: 'reader', documentId: selected.id });
                    if (page != null) params.set('page', String(page));
                    window.open(`${window.location.origin}/?${params.toString()}`, '_blank');
                  }}
                  cite={cite}
                  onCite={citePage}
                  annotations={annotations}
                  onFocusAnnotation={focusAnnotation}
                  focusedAnnotationId={focusedAnnotationId}
                  pendingFind={pendingFind}
                  onOpenDocument={openDocumentByKey}
                />
              ) : screen === 'graph' ? (
                <KnowledgeGraphSection
                  phase={phase}
                  documents={navigationDocuments}
                  onBack={() => setScreen('library')}
                  onCite={citeInDocument}
                />
              ) : screen === 'calendar' ? (
                <ReadingCalendarSection
                  phase={phase}
                  documents={navigationDocuments}
                  onBack={() => setScreen('library')}
                  onOpenDocument={openDocument}
                />
              ) : screen === 'research' ? (
                <ResearchWorkbench controller={researchWorkbench} documents={launcherDocuments} onOpenDocument={openDocument} onReload={reload} onOpenLibrary={() => setScreen('library')} launchRequest={launcherRequest?.workspace === 'research' ? launcherRequest : null} />
              ) : (
                <ReproductionSection
                  document={selected}
                  documents={navigationDocuments}
                  onPick={pickForReproduction}
                  onBack={() => setScreen('library')}
                />
              )}
            </Suspense>

            {phase.kind === 'error' ? (
              <footer className="absolute inset-x-0 bottom-0 z-30 border-t border-bad/30 bg-bad-soft px-5 py-2">
                <p className="text-xs leading-relaxed text-bad">
                  {phase.message}
                  <span className="mx-2 text-line-strong">|</span>
                  {phase.hint}
                </p>
              </footer>
            ) : null}
          </div>
        </div>

        {importFiles !== null && (
          <Suspense fallback={null}>
            <ImportDialog
              files={importFiles}
              onClose={() => setImportFiles(null)}
              onImported={reload}
              onOpenDocument={openDocument}
            />
          </Suspense>
        )}
        {retranslateDocument ? (
          <Suspense fallback={null}>
            <RetranslateDialog
              document={retranslateDocument}
              onClose={() => setRetranslateDocument(null)}
              onComplete={reload}
              onOpenReader={() => {
                const id = retranslateDocument.id;
                setRetranslateDocument(null);
                openDocument(id);
              }}
            />
          </Suspense>
        ) : null}
        {processingDocument ? (
          <Suspense fallback={null}>
            <DocumentJobDialog
              document={processingDocument}
              jobKey={processingDocument.key}
              importing={false}
              pending={false}
              onClose={() => {
                setProcessingDocument(null);
                reload();
              }}
              onOpenReader={() => {
                const id = processingDocument.id;
                setProcessingDocument(null);
                openDocument(id);
              }}
            />
          </Suspense>
        ) : null}
        {settingsOpen && (
          <Suspense fallback={null}>
            <AISettingsDialog
              onClose={() => setSettingsOpen(false)}
              appearance={{
                theme: theme.choice,
                onThemeChange: theme.setTheme,
                density: theme.density,
                readingFont: theme.readingFont,
                readingSize: theme.readingSize,
                onAppearanceChange: theme.setAppearance,
              }}
            />
          </Suspense>
        )}
        {commandOpen && !popupTarget ? (
          <CommandPalette
            open={commandOpen}
            onClose={() => setCommandOpen(false)}
            documents={launcherDocuments}
            onOpenDocument={openDocument}
            onScreen={setScreen}
            onImport={() => setImportFiles([])}
            onSettings={() => setSettingsOpen(true)}
            onThemeChange={theme.setTheme}
          />
        ) : null}
      </Activity>

      {dragHover && mode === 'research' ? (
        <div className="rx-drop-overlay" aria-hidden="true">
          <div className="rx-drop-overlay-box">
            <Icon name="import" size={28} className="text-accent" />
            <strong>松开以导入 PDF / EPUB</strong>
            <span>支持拖入多篇论文，自动加入书库处理队列</span>
          </div>
        </div>
      ) : null}

      {researchWorkbench.data.focusSession && (screen !== 'research' || mode !== 'research') && (
        <FocusPendant controller={researchWorkbench} onOpenWorkbench={() => {
          researchWorkbench.setData(current => ({ ...current, activeTab: 'daily' }));
          returnToResearch();
          setScreen('research');
        }} />
      )}
      <ModePendant mode={mode} onMode={switchMode} />
      {launcherError && (
        <div role="alert" className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-xl border border-bad/30 bg-surface-raised px-4 py-3 text-sm text-bad shadow-lg">
          {launcherError}
          <button type="button" onClick={() => setLauncherError('')} aria-label="关闭提示">×</button>
        </div>
      )}
      {curtain ? (
        <div className={`mode-curtain mode-curtain--${curtain.phase}`} aria-hidden="true">
          <div
            className="mode-curtain__panel mode-curtain__panel--left"
            onAnimationEnd={() => {
              if (curtain.phase === 'closing') {
                setMode(curtain.target);
                setCurtain({ ...curtain, phase: 'opening' });
              } else {
                changingMode.current = false;
                setCurtain(null);
              }
            }}
          />
          <div className="mode-curtain__panel mode-curtain__panel--right" />
          <div className="mode-curtain__valance" />
        </div>
      ) : null}
    </div>
  );
}
