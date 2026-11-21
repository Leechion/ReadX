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
import { WorkspaceIcon } from './components/WorkspaceIcon';
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
type Screen = 'library' | 'reader' | 'graph' | 'reproduction' | 'calendar' | 'presentation' | 'compare' | 'latex' | 'research';

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

/**
 * 视觉版式 v2（对齐 cynicalight/reader 的布局结构，token 映射到本仓库暖色系）：
 *
 *   书库   LibraryScreen   左侧边栏 + 封面网格/列表/表格（全屏，无边框工作区）
 *   阅读   ReaderScreen    顶部工具栏 + 左目录 + 原文·译文双栏（可切单栏/交换）
 *   图谱   KnowledgeGraphSection  概念 / 方法 / 结论 连成网络，跨文献合并，每条关系回到原文依据
 *   复现   ReproductionSection  分析校验 + 五组核对项 + R-11 仓库核对
 *
 * 书库点封面 → 进入阅读页（selected 决定）；阅读页「←」回书库。
 * 知识图谱/复现是独立入口，从书库侧栏进入。
 */
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
  const [retranslateDocument, setRetranslateDocument] = useState<DocumentSummary | null>(null);
  const [processingDocument, setProcessingDocument] = useState<DocumentSummary | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [launcherRequest, setLauncherRequest] = useState<LauncherOpenRequest | null>(null);
  const [launcherError, setLauncherError] = useState('');
  const [libraryView, setLibraryView] = useState<'all' | 'favorite' | 'trash' | 'shelves'>(
    'all',
  );
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
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, returnToResearch, switchMode]);

  // documents 只用于书库列表渲染（跟随搜索/筛选）；跨页跳转必须用不受筛选影响的全集，
  // 否则搜索状态下从图谱点「原文依据」会找不到目标论文、继续用上一篇的 selectedId。
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
  // 后端从「未连接」变为「已连接」时重取库元数据：首次请求可能在 token 注入前发出并留下错误。
  const [page, setPage] = useState<number | null>(() => popupTarget?.page ?? null);
  const [cite, setCite] = useState<{ page: number; nonce: number } | null>(
    () => popupTarget?.page != null ? { page: popupTarget.page, nonce: 1 } : null,
  );
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(
    null,
  );
  // 从全文检索点进来时带着关键词：阅读器打开查找栏并定位到那一页的命中。
  const [pendingFind, setPendingFind] = useState<{
    query: string;
    page: number;
    nonce: number;
  } | null>(null);
  const lastScreen = useRef<string>('library');

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
        // A temporary cloud-folder delay is retried on the next focus/interval;
        // the manual sync control reports errors directly in Settings.
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
    // pages 只列出已缓存文本页，阅读位置可能指向尚未索引的有效 PDF 页。
    // 只在页面尚未初始化时选首个缓存页，不用缓存列表把恢复位置弹回第一页。
    if (pages.length) setPage((current) => current ?? pages[0] ?? null);
  }, [pages.join(',')]);

  // 离开阅读页时把出处焦点清掉，回来不残留上次的闪烁。
  useEffect(() => {
    if (screen !== 'reader' && lastScreen.current === 'reader') setCite(null);
    lastScreen.current = screen;
  }, [screen]);



  const citePage = useCallback((target: number) => {
    setPage(target);
    setCite((current) => ({ page: target, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  // 图谱里点某条关系的原文依据：选定该文献 → 进阅读页 → 跳到那一页并闪一下出处。
  const citeInDocument = useCallback(
    (target: { key: string; page: number }) => {
      const doc = navigationDocuments.find((item) => item.key === target.key);
      if (doc) setSelectedId(doc.id);
      setPage(target.page);
      setCite((current) => ({ page: target.page, nonce: (current?.nonce ?? 0) + 1 }));
      setScreen('reader');
    },
    [navigationDocuments],
  );

  const focusAnnotation = useCallback(
    (id: string, page: number | null) => {
      setFocusedAnnotationId(id);
      if (page != null) citePage(page);
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
  }, []);

  /** 按论文键打开（引用关系里跳转用）：键与 id 不总是相同，所以按 key 查回 id。 */
  const openDocumentByKey = useCallback(
    (key: string) => {
      const doc = navigationDocuments.find((item) => item.key === key);
      if (doc) openDocument(doc.id);
    },
    [navigationDocuments, openDocument],
  );

  /** 从全文检索结果点进某篇的某一页：页码直接给定，并把关键词交给阅读器的查找栏。 */
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
    [navigationDocuments],
  );

  const openReproduction = useCallback(
    (key: string) => {
      const target = navigationDocuments.find((doc) => doc.key === key);
      if (target) setSelectedId(target.id);
      setScreen('reproduction');
    },
    [navigationDocuments],
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
      onDragOver={(event) => {
        if (mode !== 'research') return;
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (mode !== 'research') return;
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
      <HeaderBar
        phase={phase}
        screen={screen}
        onScreen={setScreen}
        onPresentation={() => setScreen('presentation')}
        onReload={reload}
        onImport={() => setImportFiles([])}
        theme={theme.choice}
        onThemeChange={theme.setTheme}
      />

      <Suspense fallback={<p className="p-6" role="status">加载中…</p>}>
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
      {/* 对话框各自一个边界：首次加载 chunk 时只让弹窗区域回退，绝不卸载整页
          （否则滚动位置、面板本地状态与已发出的列表请求都会重来一遍）。 */}
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
          <AISettingsDialog onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
      {phase.kind === 'error' ? (
        <footer className="shrink-0 border-t border-bad/30 bg-bad/5 px-5 py-2">
          <p className="text-[12px] leading-relaxed text-bad">
            {phase.message}
            <span className="mx-2 text-line-strong">|</span>
            {phase.hint}
          </p>
        </footer>
      ) : null}
      </Activity>
      {researchWorkbench.data.focusSession && (screen !== 'research' || mode !== 'research') && (
        <FocusPendant controller={researchWorkbench} onOpenWorkbench={() => {
          researchWorkbench.setData(current => ({ ...current, activeTab: 'daily' }));
          returnToResearch();
          setScreen('research');
        }} />
      )}
      <ModePendant mode={mode} onMode={switchMode} />
      {launcherError && <div role="alert" className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-xl border border-bad/30 bg-surface px-4 py-3 text-sm text-bad shadow-lg">{launcherError}<button type="button" onClick={() => setLauncherError('')} aria-label="关闭提示">×</button></div>}
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

/**
 * 全局工作区导航：书库、PPT、LaTeX Studio 与主题、导入入口在各页面保持一致。
 */
function HeaderBar({
  phase,
  screen,
  onScreen,
  onPresentation,
  onReload,
  onImport,
  theme,
  onThemeChange,
}: {
  phase: ReturnType<typeof useWorkspace>['phase'];
  screen: 'library' | 'reader' | 'graph' | 'reproduction' | 'calendar' | 'presentation' | 'compare' | 'latex' | 'research';
  onScreen: (screen: 'library' | 'reader' | 'graph' | 'reproduction' | 'calendar' | 'presentation' | 'compare' | 'latex' | 'research') => void;
  onPresentation: () => void;
  onReload: () => void;
  onImport: () => void;
  theme: string;
  onThemeChange: (theme: 'light' | 'dark' | 'paper' | 'system') => void;
}) {
  const ready = phase.kind === 'ready';
  return (
    <header className="app-header">
      <button type="button" className="app-brand" onClick={() => onScreen('library')} aria-label="ReadX，返回书库">
        <span className="brand-mark" aria-hidden="true">◈</span><span>ReadX</span>
      </button>
      <nav className="app-navigation" aria-label="工作区导航">
      <button
        type="button"
        onClick={() => onScreen('library')}
        aria-current={['library', 'reader', 'graph', 'calendar', 'compare', 'reproduction', 'research'].includes(screen) ? 'page' : undefined}
        className={['library', 'reader', 'graph', 'calendar', 'compare', 'reproduction', 'research'].includes(screen) ? 'active' : ''}
      >
        <WorkspaceIcon name="library" size={16} /><span>工作台</span>
      </button>
      <button type="button" onClick={onPresentation} aria-current={screen === 'presentation' ? 'page' : undefined} className={screen === 'presentation' ? 'active' : ''} title="从书库选择论文生成演示稿">
        <WorkspaceIcon name="file" size={16} /><span>PPT</span>
      </button>
      <button
        type="button"
        onClick={() => onScreen('latex')}
        aria-current={screen === 'latex' ? 'page' : undefined}
        className={screen === 'latex' ? 'active' : ''}
        title="LaTeX Studio：本地论文写作工作区（项目、编辑、编译、PDF 预览）"
      >
        <WorkspaceIcon name="code" size={16} /><span>LaTex Studio</span>
      </button>
      </nav>
      <div className="app-header-actions">
        <div className="theme-switch" role="group" aria-label="界面主题">
          {(['light', 'dark', 'paper', 'system'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onThemeChange(item)}
              aria-pressed={theme === item}
              className={theme === item ? 'active' : ''}
            >
              {
                {
                  light: '浅色',
                  dark: '深色',
                  paper: '纸张',
                  system: '跟随系统',
                }[item]
              }
            </button>
          ))}
        </div>
        <select className="theme-select" aria-label="界面主题" value={theme} onChange={event => onThemeChange(event.target.value as 'light' | 'dark' | 'paper' | 'system')}>
          <option value="light">浅色</option><option value="dark">深色</option><option value="paper">纸张</option><option value="system">跟随系统</option>
        </select>
        <button
          type="button"
          onClick={onReload}
          className={`connection-button${ready ? ' ready' : ''}`}
          title={ready ? '后端已连接，点按重连' : '后端未连接，点按重试'}
        >
          <span aria-hidden="true" />{ready ? '已连接' : '未连接 · 重试'}
        </button>
        <button type="button" className="primary-button global-import" onClick={onImport}>
          <span>＋ 导入 PDF / EPUB</span>
        </button>
      </div>
    </header>
  );
}
