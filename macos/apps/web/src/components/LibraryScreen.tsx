import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import type { DesktopUpdateStatus } from '@cbct/shared';
import { statusLabel } from '@cbct/shared';
import type { Category, DocumentMeta } from '../api/client';
import { api, type SearchHit, type SearchResponse } from '../api/client';
import type { Filters, WorkspacePhase } from '../hooks/useWorkspace';
import { useDebouncedValue } from '../hooks/useWorkspace';
import type { useLibraryMeta } from '../hooks/useLibraryMeta';
import { CATEGORY_COLORS, categoryDot, categoryLabel } from '../categories';
import { LibraryCard } from './LibraryCard';
import { ShelfCover } from './ShelfCover';
import { LibraryProcessingControl } from './LibraryProcessingControl';
import { LibraryTrashButton } from './LibraryTrashButton';
import { EmptyTrashDialog } from './EmptyTrashDialog';
import { CitationExportDialog } from './CitationExportDialog';
import { ReadonlyShareDialog } from './ReadonlyShareDialog';
import { SyncSettingsDialog } from './SyncSettingsDialog';
import { DailyRecommendations } from './DailyRecommendations';
import { ResizeHandle } from './ResizeHandle';
import { WorkspaceIcon, type WorkspaceIconName } from './WorkspaceIcon';
import { STORAGE_KEYS } from '../lib/storage';
import { AppDialog } from './AppDialog';

type Layout = 'grid' | 'list' | 'table';
type SortKey = 'title' | 'year' | 'status';
type TableColumn = 'title' | 'author' | 'year' | 'status' | 'shelves';
type GridDensity = 'comfortable' | 'compact';

const RELEASE_NOTE_TAGS = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'div', 'span', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'blockquote', 'a']);
const RELEASE_NOTE_DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math']);

function releaseNoteNode(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (RELEASE_NOTE_DROP_TAGS.has(tag)) return null;
  const children = Array.from(element.childNodes).map((child, index) => releaseNoteNode(child, `${key}-${index}`));
  if (!RELEASE_NOTE_TAGS.has(tag)) return children;
  if (tag === 'br' || tag === 'hr') return createElement(tag, { key });
  if (tag === 'a') {
    const rawHref = element.getAttribute('href');
    if (!rawHref) return createElement('span', { key }, children);
    try {
      const href = new URL(rawHref, window.location.href);
      if (!['http:', 'https:', 'mailto:'].includes(href.protocol)) return createElement('span', { key }, children);
      return createElement('a', { key, href: href.href, target: '_blank', rel: 'noopener noreferrer' }, children);
    } catch {
      return createElement('span', { key }, children);
    }
  }
  return createElement(tag, { key }, children);
}

export function ReleaseNotesContent({ value }: { value: string }) {
  let source = value.replace(/\\(?=<\/?[a-z][^>]*>)/gi, '');
  // electron-updater/GitHub metadata can hand us an HTML body with its angle
  // brackets entity-escaped. Decode only when no real tags are present; the
  // result still goes through the element allowlist below.
  for (let pass = 0; pass < 2 && !/<\/?[a-z][^>]*>/i.test(source)
    && /(?:&lt;|&#0*60;|&#x0*3c;)\s*\/?[a-z]/i.test(source); pass += 1) {
    const decoder = document.createElement('textarea');
    decoder.innerHTML = source;
    source = decoder.value;
  }
  const template = document.createElement('template');
  // Some release editors escape the angle brackets with a preceding backslash.
  template.innerHTML = source;
  const isHtml = /<\/?[a-z][^>]*>/i.test(source);
  return <div className={`update-release-notes-content${isHtml ? ' is-html' : ''}`}>{Array.from(template.content.childNodes).map((node, index) => releaseNoteNode(node, `release-note-${index}`))}</div>;
}

/** 每日推荐的独立侧栏：开合与宽度都按用户上次的选择保存。 */
const DAILY_STORAGE = STORAGE_KEYS.libraryDaily;
const DAILY_DEFAULT_WIDTH = 316;
const DAILY_MIN_WIDTH = 260;
const DAILY_MAX_WIDTH = 720;

function readDailyPanel(): { open: boolean; width: number } {
  // 宽窗口默认展开（原来它常驻列表顶部），窄窗口默认收起，不挤占书库列表。
  const fallback = { open: typeof window !== 'undefined' && window.innerWidth >= 1280, width: DAILY_DEFAULT_WIDTH };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const value = JSON.parse(localStorage.getItem(DAILY_STORAGE) ?? 'null') as { open?: unknown; width?: unknown } | null;
    return {
      open: typeof value?.open === 'boolean' ? value.open : fallback.open,
      width: typeof value?.width === 'number' && Number.isFinite(value.width)
        ? Math.min(DAILY_MAX_WIDTH, Math.max(DAILY_MIN_WIDTH, value.width))
        : fallback.width,
    };
  } catch {
    return fallback;
  }
}

const LAYOUT_STORAGE = STORAGE_KEYS.libraryLayout;
const GRID_DENSITY_STORAGE = STORAGE_KEYS.libraryGridDensity;
const TABLE_STORAGE = STORAGE_KEYS.libraryTable;
const SIDEBAR_WIDTH_STORAGE = STORAGE_KEYS.librarySidebarWidth;
const DEFAULT_SIDEBAR_WIDTH = 238;
const MIN_SIDEBAR_WIDTH = 190;
const MAX_SIDEBAR_WIDTH = 420;
const DEFAULT_TABLE_COLUMNS: TableColumn[] = ['title', 'author', 'year', 'status', 'shelves'];

function readGridDensity(): GridDensity {
  try { return localStorage.getItem(GRID_DENSITY_STORAGE) === 'compact' ? 'compact' : 'comfortable'; }
  catch { return 'comfortable'; }
}

function readTablePreferences(): { sort: { key: SortKey; reverse: boolean }; columns: TableColumn[] } {
  try {
    const value = JSON.parse(localStorage.getItem(TABLE_STORAGE) ?? 'null') as { sort?: { key?: unknown; reverse?: unknown }; columns?: unknown } | null;
    const key = value?.sort?.key;
    const sort: { key: SortKey; reverse: boolean } = {
      key: key === 'year' || key === 'status' ? key : 'title',
      reverse: value?.sort?.reverse === true,
    };
    const savedColumns = value?.columns;
    const columns = Array.isArray(savedColumns)
      ? DEFAULT_TABLE_COLUMNS.filter((column) => savedColumns.includes(column))
      : DEFAULT_TABLE_COLUMNS;
    return { sort, columns: columns.length ? columns : ['title'] };
  } catch { return { sort: { key: 'title', reverse: false }, columns: DEFAULT_TABLE_COLUMNS }; }
}

function readSidebarWidth(): number {
  try {
    const width = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE));
    return Number.isFinite(width) && width > 0 ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width)) : DEFAULT_SIDEBAR_WIDTH;
  } catch { return DEFAULT_SIDEBAR_WIDTH; }
}

function readLayout(): Layout {
  if (typeof localStorage === 'undefined') return 'grid';
  const value = localStorage.getItem(LAYOUT_STORAGE);
  return value === 'list' || value === 'table' ? value : 'grid';
}

function normalizePaperTitle(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function extractArxivId(value: string | undefined): string | null {
  if (!value) return null;
  return value.match(/(?:arxiv(?:\.org\/(?:abs|pdf)\/|:)\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z][a-z.-]*\/\d{7}(?:v\d+)?)/i)?.[1] ?? null;
}

const STATUS_TONE: Record<string, string> = {
  reading: 'bg-accent-soft text-accent',
  done: 'bg-good/10 text-good',
  queue: 'bg-surface-sunk text-ink-soft',
  archive: 'bg-surface-sunk text-ink-faint',
};

/** 左侧导航的视图项（复刻参考实现：全部文档 / 收藏 / 回收站）。 */
type ViewId = 'all' | 'favorite' | 'trash' | 'shelves' | 'calendar' | 'graph' | 'compare';

interface Props {
  phase: WorkspacePhase;
  /** 不受搜索影响的文献全集：侧栏计数与「自动补缺失 PDF」都按它算。 */
  allDocuments: DocumentSummary[];
  filters: Filters;
  setFilters: (next: Partial<Filters>) => void;
  selectedId: string | null;
  onOpenDocument: (id: string) => void;
  onOpenProcessing: (doc: DocumentSummary) => void;
  onRetranslate: (doc: DocumentSummary) => void;
  onOpenImport: () => void;
  onOpenAcademic: () => void;
  onOpenSettings: () => void;
  meta: ReturnType<typeof useLibraryMeta>;
  view: ViewId;
  onViewChange: (view: ViewId) => void;
  onOpenReproduction: (key: string) => void;
  onTrashEmptied: () => void;
  onReload: () => void;
  /** 打开某篇论文并跳到指定页，同时把搜索词带进阅读器的查找栏。 */
  onOpenAtPage: (key: string, page: number, query: string) => void;
}

/**
 * 书库全屏页：左侧边栏（视图导航 + 分类 + 底部导入/设置）+ 主区（顶部条 + 封面网格/列表/表格）。
 * 版式对齐参考实现（`.app` / `.library-sidebar` / `.library-main` / `.book-grid`），
 * 颜色映射到本仓库既有 token，因此三主题仍然生效。
 */
export function LibraryScreen({
  phase,
  allDocuments,
  filters,
  setFilters,
  selectedId,
  onOpenDocument,
  onOpenProcessing,
  onRetranslate,
  onOpenImport,
  onOpenAcademic,
  onOpenSettings,
  meta,
  view,
  onViewChange,
  onOpenReproduction,
  onTrashEmptied,
  onReload,
  onOpenAtPage,
}: Props) {
  const [emptyTrashKeys, setEmptyTrashKeys] = useState<string[] | null>(null);
  const [input, setInput] = useState(filters.q);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [gridDensity, setGridDensity] = useState<GridDensity>(readGridDensity);
  const [tablePreferences, setTablePreferences] = useState(readTablePreferences);
  const { sort, columns: tableColumns } = tablePreferences;
  const [managingCategories, setManagingCategories] = useState(false);
  const [duplicates, setDuplicates] = useState<{ primaryKey: string; keys: string[] }[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [dailyOpen, setDailyOpen] = useState(() => readDailyPanel().open);
  const [dailyWidth, setDailyWidth] = useState(() => readDailyPanel().width);
  useEffect(() => {
    try {
      localStorage.setItem(DAILY_STORAGE, JSON.stringify({ open: dailyOpen, width: dailyWidth }));
    } catch { /* Storage may be disabled. */ }
  }, [dailyOpen, dailyWidth]);
  const [fetchingArxiv, setFetchingArxiv] = useState(false);
  const [arxivProgress, setArxivProgress] = useState('');
  const [arxivSummary, setArxivSummary] = useState('');
  const [citationOpen, setCitationOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [syncSettingsOpen, setSyncSettingsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMoreOpen(false);
      moreButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [moreOpen]);
  // 搜索分两档：题录（本地筛选，标题/作者/会场）与全文（服务端逐页正文匹配）。
  // 全文检索的覆盖面见 coverage：未索引的论文搜不到，必须显示出来。
  const [searchMode, setSearchMode] = useState<'meta' | 'fulltext'>('meta');
  const [fulltext, setFulltext] = useState<SearchResponse | null>(null);
  const [fulltextLoading, setFulltextLoading] = useState(false);
  const [fulltextError, setFulltextError] = useState('');
  const arxivController = useRef<AbortController | null>(null);
  const debounced = useDebouncedValue(input, 300);
  /** 全文模式下有关键词时，正文结果取代文献列表；空关键词仍然显示书库。 */
  const fulltextActive = searchMode === 'fulltext' && input.trim().length >= 2;

  useEffect(() => {
    // 全文模式下不再把关键词塞进题录筛选：两档各管一个搜索框，混在一起会互相打架。
    if (searchMode === 'meta' && debounced !== filters.q) setFilters({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, searchMode]);

  useEffect(() => {
    if (searchMode !== 'fulltext') {
      setFulltext(null);
      setFulltextError('');
      return;
    }
    const query = debounced.trim();
    if (query.length < 2) {
      setFulltext(null);
      setFulltextError('');
      return;
    }
    const controller = new AbortController();
    setFulltextLoading(true);
    setFulltextError('');
    api
      .search(query, controller.signal)
      .then((value) => setFulltext(value))
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setFulltextError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setFulltextLoading(false);
      });
    return () => controller.abort();
  }, [searchMode, debounced]);

  // 服务端按论文分组返回，这里只做相邻合并，保持后端给的顺序（命中多的在前）。
  const fulltextGroups = useMemo(() => {
    const groups: { key: string; title: string; year: number; hits: SearchHit[] }[] = [];
    for (const hit of fulltext?.hits ?? []) {
      const last = groups[groups.length - 1];
      if (last && last.key === hit.key) last.hits.push(hit);
      else groups.push({ key: hit.key, title: hit.title, year: hit.year, hits: [hit] });
    }
    return groups;
  }, [fulltext]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_STORAGE, layout);
    } catch {
      /* 隐私模式写不了：本次会话仍生效。 */
    }
  }, [layout]);

  useEffect(() => {
    try { localStorage.setItem(GRID_DENSITY_STORAGE, gridDensity); } catch { /* Storage may be disabled. */ }
  }, [gridDensity]);

  useEffect(() => {
    try { localStorage.setItem(TABLE_STORAGE, JSON.stringify({ sort, columns: tableColumns })); } catch { /* Storage may be disabled. */ }
  }, [sort, tableColumns]);

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_WIDTH_STORAGE, String(sidebarWidth)); } catch { /* Storage may be disabled. */ }
  }, [sidebarWidth]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .duplicates(controller.signal)
      .then((result) => setDuplicates(result.groups))
      .catch(() => undefined);
    return () => controller.abort();
  }, [phase.kind === 'ready' ? phase.meta.documentsTotal : 0]);

  const rawDocuments = phase.kind === 'ready' ? phase.documents.documents : [];
  const total = phase.kind === 'ready' ? phase.meta.documentsTotal : 0;
  // 计数基于全集：搜索只缩小列表，不该让「回收站/收藏」的数字跟着缩水。
  const trashCount = allDocuments.filter((doc) => meta.items[doc.key]?.deleted).length;
  const activeDocuments = rawDocuments.filter((doc) => !meta.items[doc.key]?.deleted);
  const favoriteCount = allDocuments.filter((doc) => meta.items[doc.key]?.favorite && !meta.items[doc.key]?.deleted).length;
  const toggleTrash = (key: string) => meta.patch(key, { deleted: !meta.items[key]?.deleted });
  const missingPDFs = useMemo(() => allDocuments.filter((doc) =>
    !meta.items[doc.key]?.deleted && doc.title.trim() && doc.format !== 'epub' && !(doc.hasPdf ?? Boolean(doc.pdfPath))),
  [allDocuments, meta.items]);

  const fetchMissingArxivPDFs = async () => {
    if (fetchingArxiv || missingPDFs.length === 0) return;
    const controller = new AbortController();
    arxivController.current = controller;
    setFetchingArxiv(true);
    setArxivSummary('');
    const saved: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    for (let index = 0; index < missingPDFs.length; index++) {
      const doc = missingPDFs[index]!;
      if (controller.signal.aborted) break;
      setArxivProgress(`正在检索 ${index + 1}/${missingPDFs.length}：${doc.title}`);
      try {
        const candidates = (await api.searchImport(doc.title, controller.signal)).results;
        const titleKey = normalizePaperTitle(doc.title);
        const exactMatches = candidates.filter((candidate) => normalizePaperTitle(candidate.title) === titleKey)
          .map((candidate) => ({ candidate, arxiv: extractArxivId(candidate.arxiv || candidate.url) }))
          .filter((item): item is { candidate: typeof candidates[number]; arxiv: string } => Boolean(item.arxiv));
        const uniqueMatches = [...new Map(exactMatches.map((item) => [item.arxiv.replace(/v\d+$/i, ''), item])).values()];
        if (uniqueMatches.length !== 1) {
          skipped.push(doc.title);
          continue;
        }
        const match = uniqueMatches[0]!;
        setArxivProgress(`正在下载 ${index + 1}/${missingPDFs.length}：${doc.title}`);
        await api.attachArxivPDF(doc.key, match.arxiv, controller.signal, (progress) => {
          const size = progress.total ? `（${(progress.received / 1048576).toFixed(1)}/${(progress.total / 1048576).toFixed(1)} MB）` : '';
          setArxivProgress(`正在下载 ${index + 1}/${missingPDFs.length}：${doc.title}${size}`);
        });
        saved.push(doc.title);
      } catch (cause) {
        if (controller.signal.aborted) break;
        failed.push(`${doc.title}：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    arxivController.current = null;
    setFetchingArxiv(false);
    setArxivProgress('');
    const stopped = controller.signal.aborted;
    const parts = [`已获取 ${saved.length} 篇`];
    if (skipped.length) parts.push(`${skipped.length} 篇未找到标题完全匹配的 arXiv 版本`);
    if (failed.length) parts.push(`${failed.length} 篇下载失败`);
    if (stopped) parts.push('已停止');
    setArxivSummary(`${parts.join('；')}${skipped.length ? `。未匹配：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? '等' : ''}` : ''}${failed.length ? `。失败：${failed.slice(0, 2).join('；')}` : ''}`);
    if (saved.length) onReload();
  };

  const documents = useMemo(() => {
    const filtered = rawDocuments.filter((doc) => {
      const item = meta.items[doc.key];
      if (view === 'trash') return Boolean(item?.deleted);
      if (item?.deleted) return false;
      if (view === 'favorite' && !item?.favorite) return false;
      if (categoryFilter && !(item?.categories ?? []).includes(categoryFilter)) return false;
      if (tagFilter && !(item?.tags ?? []).includes(tagFilter)) return false;
      return true;
    });
    const direction = sort.reverse ? -1 : 1;
    return [...filtered].sort((a, b) => {
      let delta = 0;
      if (sort.key === 'title') delta = a.title.localeCompare(b.title, 'zh');
      else if (sort.key === 'year') delta = (a.year ?? 0) - (b.year ?? 0);
      else delta = a.status.localeCompare(b.status);
      return delta !== 0 ? delta * direction : a.title.localeCompare(b.title, 'zh');
    });
  }, [rawDocuments, meta.items, view, categoryFilter, tagFilter, sort]);

  const toggleSort = (key: SortKey) =>
    setTablePreferences((current) => ({ ...current, sort: current.sort.key === key ? { key, reverse: !current.sort.reverse } : { key, reverse: false } }));

  const toggleTableColumn = (column: TableColumn) => setTablePreferences((current) => {
    const columns = current.columns.includes(column)
      ? current.columns.filter((item) => item !== column)
      : DEFAULT_TABLE_COLUMNS.filter((item) => current.columns.includes(item) || item === column);
    return { ...current, columns: columns.length ? columns : ['title'] };
  });

  // 导航项右边的数字有两种口径，别混：
  //   导航里的「书架」= **书架个数**（和「收藏」「回收站」并列的都是条目数）；
  //   下面「我的书架」每个书架右边的数字 = **该书架里的论文数**。
  // 原先导航用的是「已被归类的论文数」，读起来就是书架个数，两处数字又不一样，必然误导。
  const countInShelf = useCallback(
    (name: string) => activeDocuments.filter((doc) => (meta.items[doc.key]?.categories ?? []).includes(name)).length,
    [activeDocuments, meta.items],
  );

  const VIEWS: { id: ViewId; label: string; icon: WorkspaceIconName; count?: number; hint?: string }[] = [
    { id: 'all', label: '全部文档', icon: 'library', count: total - trashCount },
    { id: 'shelves', label: '书架', icon: 'shelves', count: meta.categories.length, hint: '书架个数' },
    { id: 'favorite', label: '收藏', icon: 'star', count: favoriteCount },
    { id: 'trash', label: '回收站', icon: 'trash', count: trashCount },
    { id: 'graph', label: '知识图谱', icon: 'graph' },
    { id: 'compare', label: '跨文献对照', icon: 'panel' },
    { id: 'calendar', label: '阅读日历', icon: 'calendar' },
  ];

  const toolbarCommands = () => <>
    {missingPDFs.length > 0 ? (
      <button type="button" className="library-toolbar-command" disabled={fetchingArxiv} onClick={() => void fetchMissingArxivPDFs()}>
        {fetchingArxiv ? '正在自动获取…' : `自动获取缺失 PDF（${missingPDFs.length}）`}
      </button>
    ) : null}
    {fetchingArxiv ? <button type="button" className="library-toolbar-command danger" onClick={() => arxivController.current?.abort()}>停止获取</button> : null}
    {view === 'trash' ? (
      <button type="button" className="library-toolbar-command danger" disabled={!Object.values(meta.items).some(item => item.deleted)} onClick={() => setEmptyTrashKeys(Object.values(meta.items).filter(item => item.deleted).map(item => item.key))}>
        清空回收站
      </button>
    ) : null}
    {view !== 'trash' && view !== 'graph' && view !== 'calendar' ? (
      <button
        type="button"
        className="library-toolbar-command"
        title={categoryFilter ? `导出书架「${categoryFilter}」的书目` : '导出整库书目（不含回收站）'}
        onClick={() => setCitationOpen(true)}
      >
        导出书目
      </button>
    ) : null}
    {view !== 'trash' && <button type="button" className="library-toolbar-command" onClick={() => setShareOpen(true)}>只读分享</button>}
    <button
      type="button"
      onClick={() => setDailyOpen((value) => !value)}
      aria-pressed={dailyOpen}
      title="每日论文推荐单独占一个侧栏；宽度可拖拽，双击分隔线复位"
      className={`discovery-toggle${dailyOpen ? ' active' : ''}`}
    >
      <WorkspaceIcon name="sparkles" size={15} /><span>每日推荐</span>
    </button>
    {layout === 'grid' ? <div className="view-switch density-switch" role="group" aria-label="网格密度">
      {(['comfortable', 'compact'] as GridDensity[]).map((density) => <button key={density} type="button" aria-pressed={gridDensity === density} className={gridDensity === density ? 'active' : ''} onClick={() => setGridDensity(density)}>
        <span>{density === 'comfortable' ? '舒适' : '紧凑'}</span>
      </button>)}
    </div> : null}
  </>;

  return (
    <div className={`app-shell${dailyOpen ? ' daily-open' : ''}`}>
      <aside className={`library-sidebar${collapsed ? ' collapsed' : ''}`} style={{ width: sidebarWidth, '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
        <div className="sidebar-brand">
          <strong>工作区</strong>
          <span>READX WORKSPACE</span>
        </div>

        <div className="library-mode-nav" aria-label="工作区切换">
          <button type="button" className="nav-item active" aria-current="page" title="个人书库">
            <WorkspaceIcon name="library" /><span className="nav-label">个人书库</span>
          </button>
          <button type="button" className="nav-item" onClick={onOpenAcademic} title="学术工作台">
            <WorkspaceIcon name="graduation" /><span className="nav-label">学术工作台</span>
          </button>
        </div>
        <div className="library-view-heading">书库视图</div>

        <nav className="flex flex-col gap-1" aria-label="书库视图">
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (item.id === 'shelves') { setCategoryFilter(''); setTagFilter(''); }
                onViewChange(item.id);
              }}
              aria-current={view === item.id ? 'page' : undefined}
              title={item.hint ? `${item.label}（${item.hint}）` : item.label}
              className={`nav-item${view === item.id ? ' active' : ''}`}
            >
              <WorkspaceIcon name={item.icon} /><span className="nav-label">{item.label}</span>
              {item.count != null && item.count > 0 ? <span className="nav-count">{item.count}</span> : null}
            </button>
          ))}
        </nav>

        {meta.categories.length || managingCategories ? (
          <div className="sidebar-shelves flex flex-col gap-1 px-1">
              <span className="px-2 text-[10px] uppercase tracking-wide text-ink-faint">
                我的书架{meta.categories.length ? `（${meta.categories.length}）` : ''}
              </span>
            {meta.categories.map((item) => (
              <button
                key={item.name}
                type="button"
              onClick={() => { setCategoryFilter(categoryFilter === item.name ? '' : item.name); onViewChange('all'); }}
                className={`nav-item${categoryFilter === item.name ? ' active' : ''}`}
                style={{ minHeight: 32 }}
              >
                <span className="ann-color-dot" style={{ background: categoryDot(item.color) }} />
                <span className="min-w-0 flex-1 truncate text-left">{item.name}</span>
                {countInShelf(item.name) > 0 ? <span className="nav-count">{countInShelf(item.name)}</span> : null}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setManagingCategories((value) => !value)}
              className="px-2 py-1 text-left text-[11px] text-ink-faint hover:text-accent"
            >
              {managingCategories ? '收起书架管理' : '+ 管理书架'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setManagingCategories(true)}
            className="sidebar-shelves px-3 py-1 text-left text-[11px] text-ink-faint hover:text-accent"
          >
            + 新建书架
          </button>
        )}

        {managingCategories ? <CategoryManager meta={meta} onDone={() => setManagingCategories(false)} /> : null}

        <div className="sidebar-bottom">
          <UpdateControl />
          {/* 左下角：AI 助手设置。放在持久可见的侧栏底部，不再占顶栏空间。 */}
          <button type="button" className="nav-item" onClick={onOpenSettings} title="AI 助手设置">
            <WorkspaceIcon name="settings" /><span className="nav-label">AI 助手设置</span>
          </button>
          {meta.error ? <p className="px-3 text-[10px] leading-relaxed text-bad">{meta.error}</p> : null}
        </div>
      </aside>

      {!collapsed ? <ResizeHandle
        label="书架侧栏宽度"
        value={sidebarWidth}
        onStart={() => {
          const start = sidebarWidth;
          return (delta) => setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, start + delta)));
        }}
        onStep={(delta) => setSidebarWidth((value) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value + delta)))}
        onReset={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
      /> : null}

      <section className="library-main">
        <header className="library-topbar">
          <div className="library-heading">
            <button
              type="button"
              onClick={() => setCollapsed((value) => !value)}
              className="sidebar-toggle"
              title={collapsed ? '展开侧栏' : '收起侧栏'}
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!collapsed}
            >
              <WorkspaceIcon name="panel" size={17} />
            </button>
            <div className="min-w-0">
            <h1>
              {view === 'all' ? '全部文档' : view === 'favorite' ? '收藏' : view === 'trash' ? '回收站' : view === 'shelves' ? '我的书架' : view === 'graph' ? '知识图谱' : '阅读日历'}
            </h1>
            </div>
            {view !== 'trash' && view !== 'graph' && view !== 'calendar' ? (
              <button type="button" className="library-toolbar-command sync-command" onClick={() => setSyncSettingsOpen(true)} title="设置书库、阅读进度和笔记的跨设备同步">
                ⇄ 同步
              </button>
            ) : null}
          </div>
          <div className="library-view-actions">
            <div className="library-toolbar-inline">{toolbarCommands()}</div>
            <div className="view-switch" role="group" aria-label="文献布局">
            {(['grid', 'list', 'table'] as Layout[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setLayout(item)}
                aria-pressed={layout === item}
                className={layout === item ? 'active' : ''}
              >
                <WorkspaceIcon name={item} size={15} /><span>{item === 'grid' ? '网格' : item === 'list' ? '列表' : '表格'}</span>
              </button>
            ))}
            </div>
            <div className="library-more" ref={moreRef}>
              <button ref={moreButtonRef} type="button" className="library-more-trigger" aria-label="更多书库操作" aria-expanded={moreOpen} aria-controls="library-more-panel" onClick={() => setMoreOpen((value) => !value)}>⋯</button>
              {moreOpen ? <div id="library-more-panel" className="library-more-panel" aria-label="更多书库操作" onClickCapture={() => setMoreOpen(false)}>{toolbarCommands()}</div> : null}
            </div>
          </div>
        </header>

        <div className="library-content">
          {arxivProgress ? <p role="status" className="mb-2 rounded-md bg-accent-soft px-3 py-2 text-xs text-accent">{arxivProgress}</p> : null}
          {arxivSummary ? <p role="status" className="mb-2 rounded-md bg-surface-sunk px-3 py-2 text-xs text-ink-soft">{arxivSummary}</p> : null}
          {view === 'trash' ? <div className="mb-3 text-xs leading-relaxed text-ink-soft"><p>清空会删除 library 文件夹中未被其他论文引用的导入副本，原始位置文件保留。</p>{phase.kind === 'ready' ? <p className="break-all">导入副本位置：{phase.meta.dataRoot.replace(/[\\/]$/, '')}/library</p> : null}</div> : null}
          {!fulltextActive && phase.kind === 'ready' && view !== 'trash' ? (
            <div className="library-metrics" aria-label="当前列表概览">
              <div className="library-metric"><span className="metric-icon"><WorkspaceIcon name="file" /></span><strong>{documents.length}</strong><span>当前文献</span></div>
              <div className="library-metric"><span className="metric-icon"><WorkspaceIcon name="library" /></span><strong>{documents.filter(doc => doc.status === 'reading').length}</strong><span>正在阅读</span></div>
              <div className="library-metric"><span className="metric-icon"><WorkspaceIcon name="check" /></span><strong>{documents.filter(doc => doc.status === 'done').length}</strong><span>已精读</span></div>
            </div>
          ) : null}
          <div className="library-controls">
            <div className="view-switch" role="group" aria-label="搜索范围">
              {(['meta', 'fulltext'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={searchMode === item}
                  className={searchMode === item ? 'active' : ''}
                  title={item === 'meta' ? '按标题、作者、会场筛选' : '在已索引的逐页正文里检索'}
                  onClick={() => {
                    setSearchMode(item);
                    if (item === 'fulltext') setFilters({ q: '' });
                  }}
                >
                  {item === 'meta' ? '题录' : '全文'}
                </button>
              ))}
            </div>
            <label className="search-field">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={searchMode === 'meta' ? '搜索标题 / 作者 / 会场' : '在全文里找（至少 2 个字）'}
                aria-label={searchMode === 'meta' ? '搜索文献标题、作者或会场' : '在全库正文里检索'}
              />
            </label>
            <LibraryProcessingControl documents={allDocuments} onOpenDocument={onOpenDocument} onReload={onReload} />
            <span style={{ flex: 1 }} />
            {meta.tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setTagFilter(tagFilter === tag ? '' : tag)}
                className={`rounded-pill px-2 py-1 text-[11px] transition ${tagFilter === tag ? 'bg-accent-soft font-medium text-accent' : 'bg-surface-sunk text-ink-soft hover:text-ink'}`}
              >
                {tag}
              </button>
            ))}
          </div>

          {fulltextActive ? (
            <section className="fulltext-results" aria-label="全文检索结果">
              {fulltextError ? (
                <p className="text-bad" role="alert">{fulltextError}</p>
              ) : fulltextLoading && !fulltext ? (
                <p role="status" className="text-[13px] text-ink-soft">正在检索正文…</p>
              ) : fulltext ? (
                <>
                  <p className="fulltext-summary">
                    命中 <strong>{fulltext.matches}</strong> 处，分布在 {fulltext.documents} 篇论文
                    {fulltext.truncated ? '（结果已截断，请用更具体的关键词）' : ''}
                  </p>
                  {/* 覆盖度必须显示：未索引的论文搜不到，不能让人以为库里没有。 */}
                  <p className="fulltext-coverage">
                    已索引 {fulltext.coverage.indexedDocuments} / {fulltext.coverage.documents} 篇 ·{' '}
                    {fulltext.coverage.indexedPages} 页
                    {fulltext.coverage.unindexedDocuments > 0
                      ? ` · ${fulltext.coverage.unindexedDocuments} 篇还没有正文索引（未翻译且没在阅读器里打开过，或整篇是扫描页）`
                      : ''}
                  </p>
                  {!fulltextGroups.length ? (
                    <p className="text-[13px] leading-relaxed text-ink-soft">
                      已索引的正文里没有「{fulltext.query}」。可以换关键词，或把这篇论文导入翻译后再搜。
                    </p>
                  ) : null}
                  <ul className="fulltext-groups">
                    {fulltextGroups.map((group) => (
                      <li key={group.key}>
                        <div className="fulltext-group-head">
                          <button type="button" onClick={() => onOpenAtPage(group.key, group.hits[0]!.page, fulltext.query)}>
                            {group.title}
                          </button>
                          {group.year ? <span className="tabular-nums">{group.year}</span> : null}
                          <span>{group.hits.length} 页命中</span>
                        </div>
                        <ul className="fulltext-hits">
                          {group.hits.map((hit) => (
                            <li key={`${hit.key}-${hit.page}`}>
                              <button type="button" onClick={() => onOpenAtPage(hit.key, hit.page, fulltext.query)}>
                                <span className="fulltext-page">P{hit.page}</span>
                                <span className="fulltext-snippet">
                                  {hit.before}
                                  <mark>{hit.match}</mark>
                                  {hit.after}
                                </span>
                                {hit.count > 1 ? <span className="fulltext-count">本页 {hit.count} 处</span> : null}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-[13px] text-ink-soft">输入至少 2 个字开始全文检索。</p>
              )}
            </section>
          ) : null}

          {!fulltextActive && phase.kind === 'loading' ? <SkeletonGrid /> : null}
          {!fulltextActive && phase.kind === 'error' ? (
            <p className="py-6 text-[13px] leading-relaxed text-ink-soft">{phase.message}</p>
          ) : null}

          {!fulltextActive && phase.kind === 'ready' && documents.length === 0 ? (
            <div className="empty-state">
              {view === 'trash' ? (
                <>
                  <h2>回收站为空</h2>
                  <p>点击文章右上角的垃圾桶即可移入，移入后可以恢复到书库。</p>
                </>
              ) : total === 0 ? (
                <>
                  <h2>库里还没有论文</h2>
                  <p>
                    点右上「＋ 导入 PDF / EPUB」选择本地文件，或从每日推荐卡片一键导入公开全文。
                    <br />
                    导入时会先识别题目、作者、期刊/会议与中文题名，并完成全文翻译再入库。
                  </p>
                  <button
                    type="button"
                    onClick={onOpenImport}
                    className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-surface shadow-sm transition hover:brightness-105"
                  >
                    导入 PDF / EPUB
                  </button>
                </>
              ) : (
                <>
                  <h2>没有符合条件的文档</h2>
                  <p>调整搜索或清空书架/标签筛选后再看。</p>
                </>
              )}
            </div>
          ) : null}

          {!fulltextActive && view === 'shelves' && phase.kind === 'ready' ? (
            <ShelfOverview
              documents={documents}
              categories={meta.categories}
              meta={meta.items}
              selectedId={selectedId}
              onSelect={onOpenDocument}
              onOpenProcessing={onOpenProcessing}
              onRetranslate={onRetranslate}
              onOpenReproduction={onOpenReproduction}
              onToggleTrash={toggleTrash}
              onSetShelves={(key, categories) => meta.patch(key, { categories })}
            />
          ) : null}

          {!fulltextActive && view !== 'shelves' && phase.kind === 'ready' && documents.length > 0 && layout === 'grid' ? (
            <div className={`book-grid density-${gridDensity}`}>
              {documents.map((doc) => (
                <LibraryCard
                  key={doc.id}
                  doc={doc}
                  meta={meta.items[doc.key]}
                  categories={meta.categories}
                  selected={doc.id === selectedId}
                  onSelect={() => onOpenDocument(doc.id)}
                  onOpenProcessing={() => onOpenProcessing(doc)}
                  onRetranslate={() => onRetranslate(doc)}
                  onOpenReproduction={onOpenReproduction}
                  onToggleTrash={() => toggleTrash(doc.key)}
                  onSetShelves={(categories) => meta.patch(doc.key, { categories })}
                />
              ))}
            </div>
          ) : null}

          {!fulltextActive && view !== 'shelves' && phase.kind === 'ready' && documents.length > 0 && layout === 'list' ? (
            <ul className="flex flex-col gap-1.5">
              {documents.map((doc) => (
                <ListRow
                  key={doc.id}
                  doc={doc}
                  meta={meta.items[doc.key]}
                  categories={meta.categories}
                  selected={doc.id === selectedId}
                  onSelect={() => onOpenDocument(doc.id)}
                  onOpenProcessing={() => onOpenProcessing(doc)}
                  onRetranslate={() => onRetranslate(doc)}
                  onOpenReproduction={onOpenReproduction}
                  onToggleFavorite={() => void meta.patch(doc.key, { favorite: !meta.items[doc.key]?.favorite }).catch(() => undefined)}
                  onToggleTrash={() => toggleTrash(doc.key)}
                />
              ))}
            </ul>
          ) : null}

          {!fulltextActive && view !== 'shelves' && phase.kind === 'ready' && documents.length > 0 && layout === 'table' ? (
            <DocumentTable
              documents={documents}
              meta={meta.items}
              selectedId={selectedId}
              sort={sort}
              columns={tableColumns}
              onSort={toggleSort}
              onToggleColumn={toggleTableColumn}
              onSelect={onOpenDocument}
              onOpenProcessing={onOpenProcessing}
              onRetranslate={onRetranslate}
              onOpenReproduction={onOpenReproduction}
              onToggleTrash={toggleTrash}
            />
          ) : null}

          {!fulltextActive && duplicates.length > 0 ? (
            <p className="mt-4 rounded-lg bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
              检测到 {duplicates.length} 组疑似重复（arXiv 号 / DOI / 标题+作者）。仅提示，不自动合并——逐篇核对后再手动取舍。
            </p>
          ) : null}
        </div>
      </section>

      {dailyOpen ? (
        <>
          <ResizeHandle
            label="每日推荐栏宽度"
            value={dailyWidth}
            onStart={() => {
              const start = dailyWidth;
              return (delta: number) => setDailyWidth(Math.min(DAILY_MAX_WIDTH, Math.max(DAILY_MIN_WIDTH, start - delta)));
            }}
            onStep={(delta: number) => setDailyWidth((value) => Math.min(DAILY_MAX_WIDTH, Math.max(DAILY_MIN_WIDTH, value - delta)))}
            onReset={() => setDailyWidth(DAILY_DEFAULT_WIDTH)}
          />
          <aside className="daily-sidebar" style={{ width: dailyWidth }} aria-label="每日论文推荐">
            <header className="daily-sidebar-head">
              <span className="flex items-center gap-2 truncate text-[14px] font-semibold text-ink"><WorkspaceIcon name="sparkles" size={17} />每日论文推荐</span>
              <button
                type="button"
                onClick={() => setDailyOpen(false)}
                className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-soft transition hover:text-ink"
                title="收起每日推荐侧栏"
              >
                »
              </button>
            </header>
            <div className="daily-sidebar-body">
              <DailyRecommendations documents={rawDocuments} onReload={onReload} embedded />
            </div>
          </aside>
        </>
      ) : null}
      {emptyTrashKeys ? <EmptyTrashDialog keysToDelete={emptyTrashKeys} onClose={() => setEmptyTrashKeys(null)} onCleared={async () => { setEmptyTrashKeys(null); onTrashEmptied(); await meta.reload(); }} /> : null}
      {citationOpen ? (
        <CitationExportDialog
          category={categoryFilter || undefined}
          scopeLabel={categoryFilter ? `书架：${categoryFilter}` : '全部文献（不含回收站）'}
          onClose={() => setCitationOpen(false)}
        />
      ) : null}
      {syncSettingsOpen ? <SyncSettingsDialog onClose={() => setSyncSettingsOpen(false)} onSyncComplete={onReload} /> : null}
      {shareOpen ? <ReadonlyShareDialog documents={allDocuments.filter(doc => !meta.items[doc.key]?.deleted)} onClose={() => setShareOpen(false)} /> : null}
    </div>
  );
}

export function UpdateControl() {
  const [status, setStatus] = useState<DesktopUpdateStatus>(() => (
    window.__READX_DESKTOP_UPDATES__
      ? { state: 'idle' }
      : { state: 'unsupported', message: '应用内更新仅在 Windows 或 macOS 桌面安装版中提供。' }
  ));
  const [confirmingUpdate, setConfirmingUpdate] = useState(false);
  const dismissedVersion = useRef<string | null>(null);
  const bridge = window.__READX_DESKTOP_UPDATES__;

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let receivedStatus = false;
    const unsubscribe = bridge.onStatus(next => {
      receivedStatus = true;
      if (active) setStatus(next);
    });
    // Subscribe first, so a slow initial snapshot cannot overwrite a new event.
    void bridge.getStatus().then(next => {
      if (active && !receivedStatus) setStatus(next);
    }).catch(() => {
      if (active && !receivedStatus) setStatus({ state: 'error', message: '无法读取更新状态，请重试或重新启动 ReadX。' });
    });
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  useEffect(() => {
    if (status.state !== 'available') {
      setConfirmingUpdate(false);
      return;
    }
    if (status.state === 'available' && status.version && dismissedVersion.current !== status.version) {
      setConfirmingUpdate(true);
    }
  }, [status.state, status.version]);
  const postpone = () => {
    if (status.version) dismissedVersion.current = status.version;
    setConfirmingUpdate(false);
  };

  const run = async () => {
    if (!bridge) return;
    try {
      if (status.state === 'available' || (status.state === 'error' && status.operation === 'download')) {
        setConfirmingUpdate(false);
        setStatus({ ...status, state: 'downloading', percent: 0 });
        setStatus(await bridge.download());
      } else if (status.state === 'downloaded' || (status.state === 'error' && status.operation === 'install')) {
        setStatus(await bridge.install());
      } else {
        setStatus({ ...status, state: 'checking' });
        setStatus(await bridge.check());
      }
    } catch {
      setStatus({ ...status, state: 'error', operation: 'check', message: '无法完成更新操作，请重试或重新启动 ReadX。' });
    }
  };

  const busy = status.state === 'checking' || status.state === 'downloading';
  const label = status.state === 'checking' ? '正在检查更新…'
    : status.state === 'current' ? (status.version === status.currentVersion
      ? `已是最新版本 · v${status.version}`
      : `当前版本 · v${status.currentVersion}`)
      : status.state === 'available' ? `下载更新 · v${status.version}`
        : status.state === 'downloading' ? `正在下载 · ${Math.round(status.percent ?? 0)}%`
          : status.state === 'downloaded' ? `${status.installMode === 'manual-dmg' ? '打开安装包' : '重启并安装'}${status.version ? ` · v${status.version}` : ''}`
            : status.state === 'error' ? '更新失败 · 点击重试'
              : status.state === 'unavailable' ? (status.version ? `最新发布 · v${status.version}` : '暂无此平台更新 · 点击重查')
                : status.state === 'unsupported' ? '桌面版更新'
                  : '检查更新';
  const detail = status.installMode === 'manual-dmg' && status.message
    ? status.message
    : status.state === 'unavailable'
    ? `${status.currentVersion ? `当前版本 v${status.currentVersion}。` : ''}${status.message ?? ''}`
    : status.state === 'current' && status.version !== status.currentVersion
      ? `更新源最新版本 v${status.version}；当前版本 v${status.currentVersion}。`
      : status.state === 'error' || status.state === 'unsupported' ? status.message : undefined;
  const disabled = !bridge || busy;

  return (
    <>
      <div className={`sidebar-update${busy ? ' is-busy' : ''}`}>
        <button
          type="button"
          className="nav-item sidebar-update-button"
          onClick={() => void run()}
          disabled={disabled}
          title={detail ?? label}
          aria-label={detail ? `${label}：${detail}` : label}
        >
          <WorkspaceIcon name="reset" />
          <span className="nav-label">{label}</span>
        </button>
        {status.state === 'downloading' ? <div className="sidebar-update-progress" role="progressbar" aria-valuenow={Math.round(status.percent ?? 0)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.round(status.percent ?? 0)}%` }} /></div> : null}
        {detail ? <p className="sidebar-update-detail nav-label" title={detail}>{detail}</p> : null}
      </div>
      <AppDialog open={confirmingUpdate} onClose={postpone} className="update-confirm-dialog" aria-labelledby="update-confirm-title">
        <header>
          <div>
            <p className="section-eyebrow">READX UPDATE</p>
            <h2 id="update-confirm-title">发现新版本</h2>
          </div>
          {status.version ? <span className="update-version-chip">v{status.version}</span> : null}
        </header>
        <section className="update-release-notes" aria-label="本次更新功能说明">
          <h3>本次更新</h3>
          <ReleaseNotesContent value={status.releaseNotes || '此版本暂未附更新说明。'} />
        </section>
        {status.installMode === 'manual-dmg' ? <p role="note">下载并校验安装包后，退出 ReadX，将 DMG 中的新版 ReadX 拖入 Applications 覆盖，再重新打开。</p> : null}
        <footer>
          <button type="button" className="update-later-button" onClick={postpone}>暂不更新</button>
          <button type="button" className="update-primary-button" onClick={() => void run()}>{status.installMode === 'manual-dmg' ? '下载安装包' : '立即更新'}</button>
        </footer>
      </AppDialog>
    </>
  );
}

function ShelfOverview({
  documents, categories, meta, selectedId, onSelect, onOpenProcessing, onRetranslate, onOpenReproduction, onToggleTrash, onSetShelves,
}: {
  documents: DocumentSummary[];
  categories: Category[];
  meta: Record<string, DocumentMeta>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenProcessing: (doc: DocumentSummary) => void;
  onRetranslate: (doc: DocumentSummary) => void;
  onOpenReproduction: (key: string) => void;
  onToggleTrash: (key: string) => Promise<unknown>;
  onSetShelves: (key: string, categories: string[]) => Promise<unknown>;
}) {
  const groups = categories.map((shelf) => ({
    name: shelf.name,
    color: shelf.color,
    docs: documents.filter((doc) => (meta[doc.key]?.categories ?? []).includes(shelf.name)),
  }));

  if (!documents.length) return <div className="empty-state"><h2>书架里还没有论文</h2><p>在全部文档中给论文选择所属书架，按研究领域整理阅读。</p></div>;

  return (
    <div className="space-y-5">
      {!categories.length ? <p className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-soft">先在左侧点击「+ 新建书架」，再用论文卡片上的「归入书架」整理同领域论文。</p> : null}
      {groups.map((shelf, index) => (
        <section key={shelf.name} className="shelf-collection">
          <ShelfCover name={shelf.name} color={shelf.color} documents={shelf.docs} index={index} />
          <div className="shelf-collection-body">
          {shelf.docs.length ? <div className="book-grid">
            {shelf.docs.map((doc) => <LibraryCard
              key={`${shelf.name}-${doc.id}`}
              doc={doc}
              meta={meta[doc.key]}
              categories={categories}
              selected={doc.id === selectedId}
              onSelect={() => onSelect(doc.id)}
              onOpenProcessing={() => onOpenProcessing(doc)}
              onRetranslate={() => onRetranslate(doc)}
              onOpenReproduction={onOpenReproduction}
              onToggleTrash={() => onToggleTrash(doc.key)}
              onSetShelves={(names) => onSetShelves(doc.key, names)}
            />)}
          </div> : <p className="text-xs text-ink-faint">这个书架还没有论文，可以在全部文档卡片上选择该书架。</p>}
          </div>
        </section>
      ))}
    </div>
  );
}

function ListRow({
  doc,
  meta,
  categories,
  selected,
  onSelect,
  onOpenProcessing,
  onRetranslate,
  onOpenReproduction,
  onToggleFavorite,
  onToggleTrash,
}: {
  doc: DocumentSummary;
  meta: DocumentMeta | undefined;
  categories: Category[];
  selected: boolean;
  onSelect: () => void;
  onOpenProcessing: () => void;
  onRetranslate: (doc: DocumentSummary) => void;
  onOpenReproduction: (key: string) => void;
  onToggleFavorite: () => void;
  onToggleTrash: () => Promise<unknown>;
}) {
  const tone = STATUS_TONE[doc.status] ?? 'bg-surface-sunk text-ink-soft';
  return (
    <li
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 transition ${selected ? 'border-accent/40 bg-accent-soft/60' : 'border-line hover:bg-surface-sunk'}`}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
        <p className="truncate text-[13px] font-medium text-ink">{doc.title || '（无标题）'}</p>
        {doc.translatedTitle && <p className="truncate text-xs text-ink-faint">{doc.translatedTitle}</p>}
        <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
          <span className={`rounded-pill px-1.5 py-0.5 font-medium ${tone}`}>{statusLabel(doc.status)}</span>
          <span className="truncate">{doc.authors[0] ?? '作者未知'}{doc.authors.length > 1 ? ' 等' : ''}{doc.year ? ` · ${doc.year}` : ''}</span>
        </p>
        {meta?.categories.length ? (
          <p className="mt-1 flex flex-wrap gap-1">
            {meta.categories.map((name) => {
              const definition = categories.find((item) => item.name === name);
              return (
                <span key={name} className="flex items-center gap-1 rounded-pill bg-surface-sunk px-1.5 py-0.5 text-[10px] text-ink-soft">
                  <span className="ann-color-dot" style={{ background: categoryDot(definition?.color ?? 'slate') }} />
                  {name}
                </span>
              );
            })}
          </p>
        ) : null}
      </button>
      <span className="flex shrink-0 items-center gap-1 text-[11px]">
        <button type="button" onClick={onToggleFavorite} className={meta?.favorite ? 'text-accent' : 'text-ink-faint hover:text-ink'}>
          {meta?.favorite ? '★' : '☆'}
        </button>
        {doc.format !== 'epub' && doc.hasPdf && doc.paperMemoryStatus && doc.paperMemoryStatus !== 'done' ? <button type="button" onClick={onOpenProcessing} className="text-accent hover:underline" title={doc.paperMemoryMessage || '查看论文记忆处理进度'}>处理</button> : null}
        {doc.format !== 'epub' && doc.hasPdf ? <button type="button" onClick={() => onRetranslate(doc)} className="text-ink-faint hover:text-accent">重新翻译</button> : null}
        <button type="button" onClick={() => onOpenReproduction(doc.key)} className="text-ink-faint hover:text-accent">
          复现
        </button>
        <LibraryTrashButton title={doc.title || doc.key} deleted={Boolean(meta?.deleted)} onToggle={onToggleTrash} />
      </span>
    </li>
  );
}

function DocumentTable({
  documents,
  meta,
  selectedId,
  sort,
  columns,
  onSort,
  onToggleColumn,
  onSelect,
  onOpenProcessing,
  onRetranslate,
  onOpenReproduction,
  onToggleTrash,
}: {
  documents: DocumentSummary[];
  meta: Record<string, DocumentMeta>;
  selectedId: string | null;
  sort: { key: SortKey; reverse: boolean };
  columns: TableColumn[];
  onSort: (key: SortKey) => void;
  onToggleColumn: (column: TableColumn) => void;
  onSelect: (id: string) => void;
  onOpenProcessing: (doc: DocumentSummary) => void;
  onRetranslate: (doc: DocumentSummary) => void;
  onOpenReproduction: (key: string) => void;
  onToggleTrash: (key: string) => Promise<unknown>;
}) {
  const arrow = (key: SortKey) => (sort.key === key ? (sort.reverse ? ' ↓' : ' ↑') : '');
  const visible = (column: TableColumn) => columns.includes(column);
  const labels: Record<TableColumn, string> = { title: '标题', author: '作者', year: '年份', status: '状态', shelves: '书架' };
  return (
    <div className="library-table-wrap">
    <div className="library-table-options" role="group" aria-label="表格列显示">
      <span>显示列</span>
      {DEFAULT_TABLE_COLUMNS.map((column) => <label key={column}>
        <input type="checkbox" checked={visible(column)} disabled={visible(column) && columns.length === 1} onChange={() => onToggleColumn(column)} />{labels[column]}
      </label>)}
    </div>
    <table className="w-full border-collapse text-left text-[12px]">
      <thead>
        <tr className="border-b border-line text-[11px] text-ink-faint">
          {visible('title') ? <th className="cursor-pointer px-2 py-2 font-medium hover:text-ink" onClick={() => onSort('title')}>标题{arrow('title')}</th> : null}
          {visible('author') ? <th className="px-2 py-2 font-medium">作者</th> : null}
          {visible('year') ? <th className="cursor-pointer px-2 py-2 font-medium hover:text-ink" onClick={() => onSort('year')}>年份{arrow('year')}</th> : null}
          {visible('status') ? <th className="cursor-pointer px-2 py-2 font-medium hover:text-ink" onClick={() => onSort('status')}>状态{arrow('status')}</th> : null}
          {visible('shelves') ? <th className="px-2 py-2 font-medium">书架</th> : null}
          <th className="px-2 py-2 font-medium" />
        </tr>
      </thead>
      <tbody>
        {documents.map((doc) => {
          const item = meta[doc.key];
          return (
            <tr
              key={doc.id}
              className={`border-b border-line/60 align-top transition ${doc.id === selectedId ? 'bg-accent-soft/50' : 'hover:bg-surface-sunk'}`}
            >
              {visible('title') ? <td className="px-2 py-2">
                <button type="button" onClick={() => onSelect(doc.id)} className="text-left font-medium text-ink hover:text-accent">
                  {item?.favorite ? <span className="mr-1 text-accent">★</span> : null}
                  {doc.title || '（无标题）'}
                  {doc.translatedTitle && <small className="block text-ink-faint">{doc.translatedTitle}</small>}
                </button>
              </td> : null}
              {visible('author') ? <td className="px-2 py-2 text-ink-soft">{doc.authors[0] ?? '作者未知'}{doc.authors.length > 1 ? ' 等' : ''}</td> : null}
              {visible('year') ? <td className="px-2 py-2 tabular-nums text-ink-soft">{doc.year ?? '—'}</td> : null}
              {visible('status') ? <td className="px-2 py-2">
                <span className={`rounded-pill px-1.5 py-0.5 text-[10px] font-medium ${STATUS_TONE[doc.status] ?? 'bg-surface-sunk text-ink-soft'}`}>
                  {statusLabel(doc.status)}
                </span>
              </td> : null}
              {visible('shelves') ? <td className="px-2 py-2">
                {(item?.categories ?? []).length ? (
                  <span className="flex flex-wrap gap-1">
                    {(item?.categories ?? []).map((name) => (
                      <span key={name} className="rounded-pill bg-surface-sunk px-1.5 py-0.5 text-[10px] text-ink-soft">{name}</span>
                    ))}
                  </span>
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </td> : null}
              <td className="px-2 py-2">
                <div className="flex items-center gap-2">
                {doc.format !== 'epub' && doc.hasPdf && doc.paperMemoryStatus && doc.paperMemoryStatus !== 'done' ? <button type="button" onClick={() => onOpenProcessing(doc)} title={doc.paperMemoryMessage || '查看论文记忆处理进度'} className="rounded-md border border-accent/30 bg-accent-soft/40 px-2 py-0.5 text-[10px] text-accent transition hover:border-accent">处理</button> : null}
                {doc.format !== 'epub' && doc.hasPdf ? <button type="button" onClick={() => onRetranslate(doc)} className="rounded-md border border-line bg-surface px-2 py-0.5 text-[10px] text-ink-soft transition hover:border-accent hover:text-accent">重新翻译</button> : null}
                <button
                  type="button"
                  onClick={() => onOpenReproduction(doc.key)}
                  className="rounded-md border border-line bg-surface px-2 py-0.5 text-[10px] text-ink-soft transition hover:border-accent hover:text-accent"
                >
                  复现
                </button>
                <LibraryTrashButton title={doc.title || doc.key} deleted={Boolean(item?.deleted)} onToggle={() => onToggleTrash(doc.key)} />
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

function CategoryManager({ meta, onDone }: { meta: ReturnType<typeof useLibraryMeta>; onDone: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(CATEGORY_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await meta.upsertCategory(name.trim(), color);
      setName('');
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-2 rounded-lg border border-line bg-surface-sunk/50 px-2 py-2">
      <div className="flex items-center gap-1">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create();
          }}
          placeholder="领域书架名称（如：图像重建）"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-[12px] focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || !name.trim()}
          className="rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-surface disabled:opacity-40"
        >
          添加
        </button>
      </div>
      <div className="mt-1 flex items-center gap-1">
        {CATEGORY_COLORS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setColor(value)}
            aria-label={categoryLabel(value)}
            title={categoryLabel(value)}
            className={`ann-color-choice${color === value ? ' ann-color-current' : ''}`}
          >
            <span className="ann-color-dot" style={{ background: categoryDot(value) }} />
          </button>
        ))}
      </div>
      {meta.categories.length ? (
        <ul className="mt-1.5 space-y-1">
          {meta.categories.map((item) => (
            <li key={item.name} className="flex items-center gap-1.5 text-[11px]">
              <span className="ann-color-dot" style={{ background: categoryDot(item.color) }} />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void meta.deleteCategory(item.name).catch(() => undefined)}
                className="text-ink-faint hover:text-bad"
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="mt-1 text-[11px] text-bad">{error}</p> : null}
      <button type="button" onClick={onDone} className="mt-1 text-[11px] text-ink-faint underline">
        完成
      </button>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="book-grid">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div key={index}>
          <div className="h-[263px] animate-pulse rounded-[7px] bg-surface-sunk" />
          <div className="mt-3 h-3 w-3/4 animate-pulse rounded bg-surface-sunk" />
        </div>
      ))}
    </div>
  );
}
