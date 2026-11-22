import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DesktopUpdateStatus, DocumentSummary } from '@cbct/shared';
import { formatBadgeLabel, isSectionFormat, statusLabel } from '@cbct/shared';
import type { Category, DocumentMeta } from '../api/client';
import { api, type DocumentProcessingJob, type SearchHit, type SearchResponse } from '../api/client';
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
import { FlashcardsDialog } from './FlashcardsDialog';
import { LibraryChatDialog } from './LibraryChatDialog';
import { ReadonlyShareDialog } from './ReadonlyShareDialog';
import { SyncSettingsDialog } from './SyncSettingsDialog';
import { DailyRecommendations } from './DailyRecommendations';
import { ResizeHandle } from './ResizeHandle';
import { Icon } from './ui/Icon';
import { Button, Chip, EmptyState, IconButton, ProgressBar, SearchInput, Segmented, Skeleton, Tabs } from './ui/Primitives';
import { STORAGE_KEYS } from '../lib/storage';
import { AppDialog } from './AppDialog';
import { jobStatus } from './processingJobs';

type Layout = 'list' | 'grid' | 'table';
type SortKey = 'title' | 'year' | 'status';
type TableColumn = 'title' | 'author' | 'year' | 'status' | 'shelves';
type GridDensity = 'comfortable' | 'compact';
type StatusFilter = '' | 'reading' | 'unread' | 'done';
type InspectorTab = 'detail' | 'discover' | 'jobs';

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
  for (let pass = 0; pass < 2 && !/<\/?[a-z][^>]*>/i.test(source)
    && /(?:&lt;|&#0*60;|&#x0*3c;)\s*\/?[a-z]/i.test(source); pass += 1) {
    const decoder = document.createElement('textarea');
    decoder.innerHTML = source;
    source = decoder.value;
  }
  const template = document.createElement('template');
  template.innerHTML = source;
  const isHtml = /<\/?[a-z][^>]*>/i.test(source);
  return <div className={`update-release-notes-content${isHtml ? ' is-html' : ''}`}>{Array.from(template.content.childNodes).map((node, index) => releaseNoteNode(node, `release-note-${index}`))}</div>;
}

const DAILY_STORAGE = STORAGE_KEYS.libraryDaily;
const DAILY_DEFAULT_WIDTH = 320;
const DAILY_MIN_WIDTH = 280;
const DAILY_MAX_WIDTH = 560;

function readInspectorPanel(): { open: boolean; width: number } {
  const fallback = { open: typeof window !== 'undefined' && window.innerWidth >= 1100, width: DAILY_DEFAULT_WIDTH };
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
const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 190;
const MAX_SIDEBAR_WIDTH = 380;
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
  if (typeof localStorage === 'undefined') return 'list';
  const value = localStorage.getItem(LAYOUT_STORAGE);
  return value === 'grid' || value === 'table' || value === 'list' ? value : 'list';
}

function normalizePaperTitle(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function extractArxivId(value: string | undefined): string | null {
  if (!value) return null;
  return value.match(/(?:arxiv(?:\.org\/(?:abs|pdf)\/|:)\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z][a-z.-]*\/\d{7}(?:v\d+)?)/i)?.[1] ?? null;
}

type ViewId = 'all' | 'favorite' | 'trash' | 'shelves' | 'calendar' | 'graph' | 'compare';

interface Props {
  phase: WorkspacePhase;
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
  onOpenAtPage: (key: string, page: number, query: string) => void;
}

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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [gridDensity, setGridDensity] = useState<GridDensity>(readGridDensity);
  const [tablePreferences, setTablePreferences] = useState(readTablePreferences);
  const { sort, columns: tableColumns } = tablePreferences;
  const [managingCategories, setManagingCategories] = useState(false);
  const [duplicates, setDuplicates] = useState<{ primaryKey: string; keys: string[] }[]>([]);
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1100);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [inspectorOpen, setInspectorOpen] = useState(() => readInspectorPanel().open);
  const [inspectorWidth, setInspectorWidth] = useState(() => readInspectorPanel().width);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('discover');
  const [inspectedDocId, setInspectedDocId] = useState<string | null>(selectedId);
  const [jobs, setJobs] = useState<DocumentProcessingJob[]>([]);
  const [discoverCount, setDiscoverCount] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(DAILY_STORAGE, JSON.stringify({ open: inspectorOpen, width: inspectorWidth }));
    } catch { /* Storage may be disabled. */ }
  }, [inspectorOpen, inspectorWidth]);

  useEffect(() => {
    const onToggleSidebar = () => setCollapsed((v) => !v);
    const onToggleInspector = () => setInspectorOpen((v) => !v);
    const onOpenJobs = () => {
      setInspectorOpen(true);
      setInspectorTab('jobs');
    };
    const onFindShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'f') {
        const inputEl = document.getElementById('library-search-input');
        if (inputEl) {
          event.preventDefault();
          inputEl.focus();
        }
      }
    };
    window.addEventListener('readx-toggle-sidebar', onToggleSidebar);
    window.addEventListener('readx-toggle-inspector', onToggleInspector);
    window.addEventListener('readx-open-jobs', onOpenJobs);
    window.addEventListener('keydown', onFindShortcut);
    return () => {
      window.removeEventListener('readx-toggle-sidebar', onToggleSidebar);
      window.removeEventListener('readx-toggle-inspector', onToggleInspector);
      window.removeEventListener('readx-open-jobs', onOpenJobs);
      window.removeEventListener('keydown', onFindShortcut);
    };
  }, []);

  useEffect(() => {
    if (typeof api.documentJobs !== 'function') return;
    const controller = new AbortController();
    let timer: number | undefined;
    const loadJobs = async () => {
      try {
        const res = await api.documentJobs(controller.signal);
        if (!controller.signal.aborted) setJobs(res.jobs);
      } catch {
        /* ignore background polling errors */
      }
      if (!controller.signal.aborted) timer = window.setTimeout(loadJobs, inspectorOpen && inspectorTab === 'jobs' ? 1500 : 5000);
    };
    void loadJobs();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [inspectorOpen, inspectorTab]);

  const [fetchingArxiv, setFetchingArxiv] = useState(false);
  const [arxivProgress, setArxivProgress] = useState('');
  const [arxivSummary, setArxivSummary] = useState('');
  const [citationOpen, setCitationOpen] = useState(false);
  const [ragOpen, setRagOpen] = useState(false);
  const [flashcardsOpen, setFlashcardsOpen] = useState(false);
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

  const [searchMode, setSearchMode] = useState<'meta' | 'fulltext'>('meta');
  const [fulltextQueryMode, setFulltextQueryMode] = useState<'phrase' | 'terms'>('terms');
  const [fulltext, setFulltext] = useState<SearchResponse | null>(null);
  const [fulltextLoading, setFulltextLoading] = useState(false);
  const [fulltextError, setFulltextError] = useState('');
  const arxivController = useRef<AbortController | null>(null);
  const debounced = useDebouncedValue(input, 300);
  const fulltextActive = searchMode === 'fulltext' && input.trim().length >= 2;

  useEffect(() => {
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
      .search(query, controller.signal, {
        mode: fulltextQueryMode,
        category: categoryFilter || undefined,
      })
      .then((value) => setFulltext(value))
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setFulltextError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setFulltextLoading(false);
      });
    return () => controller.abort();
  }, [searchMode, debounced, fulltextQueryMode, categoryFilter]);

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
    try { localStorage.setItem(LAYOUT_STORAGE, layout); } catch { /* ignore */ }
  }, [layout]);
  useEffect(() => {
    try { localStorage.setItem(GRID_DENSITY_STORAGE, gridDensity); } catch { /* ignore */ }
  }, [gridDensity]);
  useEffect(() => {
    try { localStorage.setItem(TABLE_STORAGE, JSON.stringify({ sort, columns: tableColumns })); } catch { /* ignore */ }
  }, [sort, tableColumns]);
  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_WIDTH_STORAGE, String(sidebarWidth)); } catch { /* ignore */ }
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
  const trashCount = allDocuments.filter((doc) => meta.items[doc.key]?.deleted).length;
  const activeDocuments = rawDocuments.filter((doc) => !meta.items[doc.key]?.deleted);
  const favoriteCount = allDocuments.filter((doc) => meta.items[doc.key]?.favorite && !meta.items[doc.key]?.deleted).length;
  const toggleTrash = (key: string) => meta.patch(key, { deleted: !meta.items[key]?.deleted });

  const missingPDFs = useMemo(() => allDocuments.filter((doc) =>
    !meta.items[doc.key]?.deleted && doc.title.trim() && !isSectionFormat(doc.format) && !(doc.hasPdf ?? Boolean(doc.pdfPath))),
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
      if (statusFilter === 'reading' && doc.status !== 'reading') return false;
      if (statusFilter === 'done' && doc.status !== 'done') return false;
      if (statusFilter === 'unread' && (doc.status === 'reading' || doc.status === 'done')) return false;
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
  }, [rawDocuments, meta.items, view, categoryFilter, tagFilter, statusFilter, sort]);

  const inspectedDoc = useMemo(
    () => documents.find((d) => d.id === inspectedDocId) ?? documents.find((d) => d.id === selectedId) ?? documents[0] ?? null,
    [documents, inspectedDocId, selectedId],
  );

  const toggleSort = (key: SortKey) =>
    setTablePreferences((current) => ({ ...current, sort: current.sort.key === key ? { key, reverse: !current.sort.reverse } : { key, reverse: false } }));

  const toggleTableColumn = (column: TableColumn) => setTablePreferences((current) => {
    const columns = current.columns.includes(column)
      ? current.columns.filter((item) => item !== column)
      : DEFAULT_TABLE_COLUMNS.filter((item) => current.columns.includes(item) || item === column);
    return { ...current, columns: columns.length ? columns : ['title'] };
  });

  const countInShelf = useCallback(
    (name: string) => activeDocuments.filter((doc) => (meta.items[doc.key]?.categories ?? []).includes(name)).length,
    [activeDocuments, meta.items],
  );

  const jobsByDocKey = useMemo(() => {
    const map = new Map<string, DocumentProcessingJob>();
    for (const j of jobs) map.set(j.documentKey || j.key, j);
    return map;
  }, [jobs]);

  const runningJobsCount = jobs.filter((j) => jobStatus(j) === 'running').length;
  const readingCount = activeDocuments.filter((d) => d.status === 'reading').length;
  const doneCount = activeDocuments.filter((d) => d.status === 'done').length;

  const titleLabel =
    categoryFilter
      ? categoryFilter
      : view === 'all'
        ? '全部文档'
        : view === 'favorite'
          ? '收藏'
          : view === 'trash'
            ? '回收站'
            : '我的书架';

  return (
    <div className="flex flex-1 min-w-0 min-h-0 relative overflow-hidden">
      <aside className={`rx-ctx${collapsed ? ' collapsed' : ''}`} style={{ width: collapsed ? 0 : sidebarWidth }} aria-label="书库上下文侧栏">
        <div className="rx-ctx-head">
          <span>个人书库</span>
          <IconButton
            size="sm"
            icon="plus"
            label="管理书架"
            onClick={() => setManagingCategories((v) => !v)}
          />
        </div>

        <div className="rx-ctx-group">
          <button
            type="button"
            className="rx-ctx-item"
            aria-current={view === 'all' && !categoryFilter && statusFilter === '' ? 'true' : undefined}
            onClick={() => { setCategoryFilter(''); setTagFilter(''); setStatusFilter(''); onViewChange('all'); }}
          >
            <Icon name="file" size={15} />
            <span>全部文档</span>
            <span className="rx-count">{Math.max(0, total - trashCount)}</span>
          </button>
          <button
            type="button"
            className="rx-ctx-item"
            aria-current={view === 'all' && statusFilter === 'reading' ? 'true' : undefined}
            onClick={() => { setCategoryFilter(''); setStatusFilter(statusFilter === 'reading' ? '' : 'reading'); onViewChange('all'); }}
          >
            <Icon name="book" size={15} />
            <span>在读</span>
            <span className="rx-count">{readingCount}</span>
          </button>
          <button
            type="button"
            className="rx-ctx-item"
            aria-current={view === 'favorite' ? 'true' : undefined}
            onClick={() => { setCategoryFilter(''); setStatusFilter(''); onViewChange('favorite'); }}
          >
            <Icon name="star" size={15} />
            <span>收藏</span>
            <span className="rx-count">{favoriteCount}</span>
          </button>
          <button
            type="button"
            className="rx-ctx-item"
            aria-current={view === 'shelves' ? 'true' : undefined}
            onClick={() => { setCategoryFilter(''); setTagFilter(''); onViewChange('shelves'); }}
          >
            <Icon name="folder" size={15} />
            <span>书架总览</span>
            <span className="rx-count">{meta.categories.length}</span>
          </button>
        </div>

        <div className="rx-ctx-group">
          <div className="rx-ctx-label">书架</div>
          {meta.categories.map((item) => (
            <button
              key={item.name}
              type="button"
              className="rx-ctx-item"
              aria-current={categoryFilter === item.name ? 'true' : undefined}
              onClick={() => { setCategoryFilter(categoryFilter === item.name ? '' : item.name); onViewChange('all'); }}
            >
              <span className="rx-dot" style={{ background: categoryDot(item.color) }} />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {countInShelf(item.name) > 0 ? <span className="rx-count">{countInShelf(item.name)}</span> : null}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setManagingCategories((value) => !value)}
            className="rx-ctx-item text-ink-faint"
          >
            <Icon name="plus" size={14} />
            <span>{managingCategories ? '收起管理' : '管理书架'}</span>
          </button>
        </div>

        {managingCategories ? <CategoryManager meta={meta} onDone={() => setManagingCategories(false)} /> : null}

        <div className="rx-ctx-foot">
          <button type="button" className="rx-ctx-item" onClick={onOpenImport}>
            <Icon name="import" size={15} />
            <span>Zotero / 链接导入</span>
          </button>
          <button
            type="button"
            className="rx-ctx-item"
            aria-current={view === 'trash' ? 'true' : undefined}
            onClick={() => { setCategoryFilter(''); onViewChange('trash'); }}
          >
            <Icon name="trash" size={15} />
            <span>回收站</span>
            <span className="rx-count">{trashCount}</span>
          </button>
          <UpdateControl />
          {meta.error ? <p className="px-2 py-1 text-xs text-bad">{meta.error}</p> : null}
        </div>
      </aside>

      {!collapsed ? (
        <ResizeHandle
          label="书架侧栏宽度"
          value={sidebarWidth}
          onStart={() => {
            const start = sidebarWidth;
            return (delta) => setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, start + delta)));
          }}
          onStep={(delta) => setSidebarWidth((value) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value + delta)))}
          onReset={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
        />
      ) : null}

      <main className="rx-main">
        <header className="rx-topbar">
          <IconButton
            size="md"
            icon="sidebar"
            label={collapsed ? '展开侧栏 (Ctrl+\\)' : '折叠侧栏 (Ctrl+\\)'}
            active={!collapsed}
            onClick={() => setCollapsed((v) => !v)}
          />
          <h3>{titleLabel}</h3>

          <SearchInput
            id="library-search-input"
            value={input}
            onChange={setInput}
            placeholder={searchMode === 'meta' ? '搜索标题、作者或标签' : '全文正文检索（多词或短语）'}
            shortcut="Ctrl F"
            className="w-[300px] max-w-[36vw]"
            aria-label={searchMode === 'meta' ? '搜索文献标题、作者或标签' : '在全库正文里检索'}
          />

          <Segmented
            ariaLabel="搜索范围"
            value={searchMode}
            onChange={(item) => {
              setSearchMode(item);
              if (item === 'fulltext') setFilters({ q: '' });
            }}
            options={[
              { value: 'meta', label: '元信息', title: '按标题、作者、会场筛选' },
              { value: 'fulltext', label: '全文', title: '在已索引的逐页正文里检索' },
            ]}
          />

          <div className="rx-grow" />

          {view === 'trash' ? (
            <Button
              variant="danger"
              disabled={!Object.values(meta.items).some((item) => item.deleted)}
              onClick={() => setEmptyTrashKeys(Object.values(meta.items).filter((item) => item.deleted).map((item) => item.key))}
            >
              <Icon name="trash" size={14} />清空回收站
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => setCitationOpen(true)}
                title={categoryFilter ? `导出书架「${categoryFilter}」的书目` : '导出整库书目（不含回收站）'}
              >
                <Icon name="export" size={14} />导出书目
              </Button>
              <IconButton
                size="md"
                icon="sync"
                label="跨设备同步设置"
                onClick={() => setSyncSettingsOpen(true)}
              />
            </>
          )}

          <div className="relative" ref={moreRef}>
            <IconButton
              ref={moreButtonRef}
              size="md"
              icon="more"
              label="更多书库工具"
              active={moreOpen}
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
            />
            {moreOpen ? (
              <div className="rx-menu absolute right-0 top-[calc(100%+6px)] z-40 min-w-[210px]" role="menu" onClick={() => setMoreOpen(false)}>
                <button type="button" className="rx-menu-item" onClick={() => setRagOpen(true)}>
                  <Icon name="chat" size={14} /><span>跨库 RAG 问答</span>
                </button>
                <button type="button" className="rx-menu-item" onClick={() => setFlashcardsOpen(true)}>
                  <Icon name="star" size={14} /><span>记忆闪卡复习</span>
                </button>
                <button type="button" className="rx-menu-item" onClick={() => void api.exportMarkdownVault(categoryFilter ? { category: categoryFilter } : undefined)}>
                  <Icon name="export" size={14} /><span>导出笔记库 ZIP</span>
                </button>
                <button type="button" className="rx-menu-item" onClick={() => setShareOpen(true)}>
                  <Icon name="link" size={14} /><span>只读分享 / 局域网浏览</span>
                </button>
                {missingPDFs.length > 0 ? (
                  <button type="button" className="rx-menu-item" disabled={fetchingArxiv} onClick={() => void fetchMissingArxivPDFs()}>
                    <Icon name="import" size={14} /><span>{fetchingArxiv ? '正在获取缺失 PDF…' : `自动补全缺失 PDF（${missingPDFs.length}）`}</span>
                  </button>
                ) : null}
                {fetchingArxiv ? (
                  <button type="button" className="rx-menu-item text-bad" onClick={() => arxivController.current?.abort()}>
                    <Icon name="x" size={14} /><span>停止自动获取</span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          <IconButton
            size="md"
            icon="panel"
            label={inspectorOpen ? '关闭检查器 (Ctrl+.)' : '打开检查器 (Ctrl+.)'}
            active={inspectorOpen}
            onClick={() => setInspectorOpen((v) => !v)}
          />
        </header>

        {!fulltextActive && phase.kind === 'ready' && view !== 'trash' ? (
          <div className="rx-lib-summary num" aria-label="书库概览">
            <span><b>{activeDocuments.length}</b>在库</span>
            <span><b>{runningJobsCount}</b>处理中</span>
            <span><b>{doneCount}</b>已精读</span>
            <span><b>{readingCount}</b>在读</span>
          </div>
        ) : null}

        <div className="rx-lib-filters">
          {searchMode === 'fulltext' ? (
            <Segmented
              ariaLabel="全文匹配模式"
              value={fulltextQueryMode}
              onChange={setFulltextQueryMode}
              options={[
                { value: 'terms', label: '多词匹配' },
                { value: 'phrase', label: '完整短语' },
              ]}
            />
          ) : (
            <Segmented
              ariaLabel="阅读状态筛选"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: '', label: '全部' },
                { value: 'reading', label: '在读' },
                { value: 'unread', label: '未读' },
                { value: 'done', label: '已精读' },
              ]}
            />
          )}

          <span className="rx-sep" />

          {meta.tags.length > 0 ? (
            <select
              aria-label="标签筛选"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              className="rx-menu-btn bg-transparent border-0 outline-0 cursor-pointer"
            >
              <option value="">全部标签</option>
              {meta.tags.map((tag) => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
          ) : null}

          <select
            aria-label="排序方式"
            value={`${sort.key}:${sort.reverse ? 'desc' : 'asc'}`}
            onChange={(e) => {
              const [k, dir] = e.target.value.split(':');
              setTablePreferences((cur) => ({ ...cur, sort: { key: k as SortKey, reverse: dir === 'desc' } }));
            }}
            className="rx-menu-btn bg-transparent border-0 outline-0 cursor-pointer"
          >
            <option value="title:asc">标题 A–Z</option>
            <option value="year:desc">最新年份</option>
            <option value="year:asc">最早年份</option>
            <option value="status:asc">按阅读状态</option>
          </select>

          <div className="flex-1" />

          {layout === 'grid' ? (
            <Segmented
              ariaLabel="封面密度"
              value={gridDensity}
              onChange={setGridDensity}
              options={[
                { value: 'comfortable', label: '舒适' },
                { value: 'compact', label: '紧凑' },
              ]}
            />
          ) : null}

          <Segmented
            ariaLabel="视图模式"
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'list', label: <><Icon name="list" size={14} /><span>列表</span></> },
              { value: 'grid', label: <><Icon name="grid" size={14} /><span>封面</span></> },
              { value: 'table', label: <><Icon name="compare" size={14} /><span>表格</span></> },
            ]}
          />
        </div>

        <div className="rx-lib-body">
          {arxivProgress ? <p role="status" className="mx-5 mt-3 rounded-md bg-accent-soft px-3 py-2 text-xs text-accent">{arxivProgress}</p> : null}
          {arxivSummary ? <p role="status" className="mx-5 mt-3 rounded-md bg-surface-sunk px-3 py-2 text-xs text-ink-soft">{arxivSummary}</p> : null}
          {view === 'trash' ? (
            <div className="mx-5 mt-3 rounded-lg bg-surface-sunk px-3 py-2 text-xs leading-relaxed text-ink-soft">
              <p className="m-0">清空会删除 library 文件夹中未被其他论文引用的导入副本，原始位置文件保留。</p>
              {phase.kind === 'ready' ? <p className="m-0 break-all">导入副本位置：{phase.meta.dataRoot.replace(/[\\/]$/, '')}/library</p> : null}
            </div>
          ) : null}

          {fulltextActive ? (
            <section className="fulltext-results" aria-label="全文检索结果">
              {fulltextError ? (
                <p className="text-bad" role="alert">{fulltextError}</p>
              ) : fulltextLoading && !fulltext ? (
                <p role="status" className="text-sm text-ink-soft">正在检索正文…</p>
              ) : fulltext ? (
                <>
                  <p className="fulltext-summary">
                    命中 <strong>{fulltext.matches}</strong> 处，分布在 <span className="num">{fulltext.documents}</span> 篇论文
                    {fulltext.truncated ? '（结果已截断，请用更具体的关键词）' : ''}
                  </p>
                  <p className="fulltext-coverage num">
                    已索引 {fulltext.coverage.indexedDocuments} / {fulltext.coverage.documents} 篇 · {fulltext.coverage.indexedPages} 页
                    {fulltext.coverage.unindexedDocuments > 0
                      ? ` · ${fulltext.coverage.unindexedDocuments} 篇还没有正文索引（未翻译且没在阅读器里打开过，或整篇是扫描页）`
                      : ''}
                  </p>
                  {!fulltextGroups.length ? (
                    <p className="text-sm leading-relaxed text-ink-soft">
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
                          {group.year ? <span className="num">{group.year}</span> : null}
                          <span className="num">{group.hits.length} 页命中</span>
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
                                {hit.count > 1 ? <span className="fulltext-count num">本页 {hit.count} 处</span> : null}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-sm text-ink-soft">输入至少 2 个字开始全文检索。</p>
              )}
            </section>
          ) : null}

          {!fulltextActive && phase.kind === 'loading' ? <SkeletonList /> : null}
          {!fulltextActive && phase.kind === 'error' ? (
            <p className="p-6 text-sm leading-relaxed text-ink-soft">{phase.message}</p>
          ) : null}

          {!fulltextActive && phase.kind === 'ready' && documents.length === 0 ? (
            view === 'trash' ? (
              <EmptyState title="回收站为空" description="点击文章右侧的删除按钮即可移入，移入后可以随时恢复到书库。" />
            ) : total === 0 ? (
              <EmptyState
                title="这个书库还没有论文"
                description="拖入 PDF 或 EPUB 到窗口任意位置，也可以用 arXiv 编号、DOI 或链接导入。"
                action={<Button variant="primary" onClick={onOpenImport}><Icon name="plus" size={14} />导入论文</Button>}
              />
            ) : (
              <EmptyState
                title="没有符合条件的文档"
                description="调整状态筛选、清空书架或更换关键词后再看。"
                action={<Button variant="secondary" onClick={() => { setInput(''); setStatusFilter(''); setCategoryFilter(''); setTagFilter(''); }}>重置筛选</Button>}
              />
            )
          ) : null}

          {!fulltextActive && view === 'shelves' && phase.kind === 'ready' ? (
            <div className="p-5">
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
            </div>
          ) : null}

          {!fulltextActive && view !== 'shelves' && phase.kind === 'ready' && documents.length > 0 && layout === 'list' ? (
            <ul className="rx-lib-list">
              {documents.map((doc) => (
                <ListRow
                  key={doc.id}
                  doc={doc}
                  job={jobsByDocKey.get(doc.key)}
                  meta={meta.items[doc.key]}
                  categories={meta.categories}
                  selected={doc.id === (inspectedDoc?.id ?? selectedId)}
                  onInspect={() => setInspectedDocId(doc.id)}
                  onOpen={() => onOpenDocument(doc.id)}
                  onOpenProcessing={() => onOpenProcessing(doc)}
                  onRetranslate={() => onRetranslate(doc)}
                  onOpenReproduction={onOpenReproduction}
                  onToggleFavorite={() => void meta.patch(doc.key, { favorite: !meta.items[doc.key]?.favorite }).catch(() => undefined)}
                  onToggleTrash={() => toggleTrash(doc.key)}
                />
              ))}
            </ul>
          ) : null}

          {!fulltextActive && view !== 'shelves' && phase.kind === 'ready' && documents.length > 0 && layout === 'grid' ? (
            <div className={`book-grid density-${gridDensity}`}>
              {documents.map((doc) => (
                <LibraryCard
                  key={doc.id}
                  doc={doc}
                  meta={meta.items[doc.key]}
                  categories={meta.categories}
                  selected={doc.id === (inspectedDoc?.id ?? selectedId)}
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
            <p className="mx-5 my-4 rounded-lg bg-warn-soft px-3 py-2 text-xs leading-relaxed text-warn">
              检测到 {duplicates.length} 组疑似重复（arXiv 号 / DOI / 标题+作者）。仅提示，不自动合并——逐篇核对后再手动取舍。
            </p>
          ) : null}
        </div>
      </main>

      {inspectorOpen ? (
        <>
          <ResizeHandle
            label="检查器宽度"
            value={inspectorWidth}
            onStart={() => {
              const start = inspectorWidth;
              return (delta: number) => setInspectorWidth(Math.min(DAILY_MAX_WIDTH, Math.max(DAILY_MIN_WIDTH, start - delta)));
            }}
            onStep={(delta: number) => setInspectorWidth((value) => Math.min(DAILY_MAX_WIDTH, Math.max(DAILY_MIN_WIDTH, value - delta)))}
            onReset={() => setInspectorWidth(DAILY_DEFAULT_WIDTH)}
          />
          <aside className="rx-inspector rx-inspector--drawer" style={{ width: inspectorWidth }} aria-label="书库检查器">
            <div className="flex items-center border-b border-line pr-2">
              <div className="flex-1 min-w-0">
                <Tabs
                  value={inspectorTab}
                  onChange={setInspectorTab}
                  ariaLabel="书库检查器标签"
                  className="border-b-0"
                  items={[
                    { value: 'detail', label: '详情' },
                    { value: 'discover', label: '发现', badge: discoverCount },
                    { value: 'jobs', label: '任务', badge: runningJobsCount },
                  ]}
                />
              </div>
              <IconButton size="sm" icon="x" label="关闭检查器" onClick={() => setInspectorOpen(false)} />
            </div>

            <div className="rx-insp-body">
              {inspectorTab === 'discover' ? (
                <DailyRecommendations
                  documents={rawDocuments}
                  onReload={onReload}
                  embedded
                  onVisibleCountChange={setDiscoverCount}
                />
              ) : inspectorTab === 'jobs' ? (
                <div className="flex flex-col gap-3">
                  <p className="rx-insp-hint">后台文档识别、翻译与论文记忆任务</p>
                  <LibraryProcessingControl documents={allDocuments} onOpenDocument={onOpenDocument} onReload={onReload} />
                  {jobs.length === 0 ? (
                    <p className="text-xs text-ink-faint">暂无后台处理任务记录。</p>
                  ) : (
                    <ul className="flex flex-col gap-2 m-0 p-0 list-none">
                      {jobs.slice(0, 12).map((job) => {
                        const st = jobStatus(job);
                        const doc = allDocuments.find((d) => d.key === (job.documentKey || job.key));
                        const tone = st === 'done' ? 'good' : st === 'running' ? 'info' : st === 'failed' ? 'bad' : 'mute';
                        return (
                          <li key={job.key} className="rx-card p-3 flex flex-col gap-2">
                            <div className="flex items-start justify-between gap-2">
                              <strong className="text-xs font-medium text-ink line-clamp-2">{doc?.title || job.name || job.key}</strong>
                              <Chip tone={tone} icon={st === 'done' ? 'check' : st === 'running' ? 'loader' : st === 'failed' ? 'alert' : 'queue'} spin={st === 'running'}>
                                {st === 'done' ? '完成' : st === 'running' ? '处理中' : st === 'failed' ? '失败' : st === 'interrupted' ? '中断' : '队列'}
                              </Chip>
                            </div>
                            {doc ? (
                              <div className="flex gap-2">
                                <Button size="sm" variant="secondary" onClick={() => onOpenProcessing(doc)}>查看详情</Button>
                                <Button size="sm" variant="ghost" onClick={() => onOpenDocument(doc.id)}>打开阅读</Button>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : inspectedDoc ? (
                <div className="flex flex-col gap-4">
                  <div>
                    <span className="rx-tag">{formatBadgeLabel(inspectedDoc.format)}</span>
                    <h4 className="mt-2 mb-1 text-base font-semibold leading-snug text-ink">{inspectedDoc.title || '（无标题）'}</h4>
                    {inspectedDoc.translatedTitle ? <p className="m-0 text-xs text-ink-soft">{inspectedDoc.translatedTitle}</p> : null}
                  </div>
                  <dl className="grid grid-cols-[64px_1fr] gap-y-2 gap-x-2 text-xs m-0">
                    <dt className="text-ink-faint">作者</dt>
                    <dd className="m-0 text-ink-soft">{inspectedDoc.authors.join(' · ') || '—'}</dd>
                    <dt className="text-ink-faint">来源</dt>
                    <dd className="m-0 text-ink-soft">{[inspectedDoc.venue, inspectedDoc.year].filter(Boolean).join(' · ') || '—'}</dd>
                    <dt className="text-ink-faint">状态</dt>
                    <dd className="m-0 text-ink-soft">{statusLabel(inspectedDoc.status)}</dd>
                    {inspectedDoc.doi ? (
                      <>
                        <dt className="text-ink-faint">DOI</dt>
                        <dd className="m-0 text-ink-soft break-all">{inspectedDoc.doi}</dd>
                      </>
                    ) : null}
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" size="sm" onClick={() => onOpenDocument(inspectedDoc.id)}>
                      <Icon name="book" size={14} />打开阅读
                    </Button>
                    {!isSectionFormat(inspectedDoc.format) && inspectedDoc.hasPdf ? (
                      <>
                        <Button variant="secondary" size="sm" onClick={() => onOpenProcessing(inspectedDoc)}>处理详情</Button>
                        <Button variant="ghost" size="sm" onClick={() => onRetranslate(inspectedDoc)}>重新翻译</Button>
                      </>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => onOpenReproduction(inspectedDoc.key)}>代码复现</Button>
                  </div>
                  {meta.categories.length > 0 ? (
                    <div className="border-t border-line pt-3">
                      <p className="m-0 mb-2 text-xs font-medium text-ink-soft">所属书架</p>
                      <div className="flex flex-wrap gap-1.5">
                        {meta.categories.map((cat) => {
                          const assigned = (meta.items[inspectedDoc.key]?.categories ?? []).includes(cat.name);
                          return (
                            <button
                              key={cat.name}
                              type="button"
                              onClick={() => {
                                const cur = meta.items[inspectedDoc.key]?.categories ?? [];
                                const next = assigned ? cur.filter((x) => x !== cat.name) : [...cur, cat.name];
                                void meta.patch(inspectedDoc.key, { categories: next });
                              }}
                              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${
                                assigned ? 'border-accent bg-accent-soft text-accent font-medium' : 'border-line bg-surface text-ink-soft hover:border-line-strong'
                              }`}
                            >
                              <span className="ann-color-dot" style={{ background: categoryDot(cat.color) }} />
                              <span>{cat.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="rx-insp-hint">从左侧列表中选择一篇论文查看详情。</p>
              )}
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
      {ragOpen ? (
        <LibraryChatDialog
          open={ragOpen}
          documents={allDocuments.filter((doc) => !meta.items[doc.key]?.deleted)}
          categories={meta.categories.map((cat) => cat.name)}
          activeCategory={categoryFilter}
          onClose={() => setRagOpen(false)}
          onOpenAtPage={onOpenAtPage}
        />
      ) : null}
      {flashcardsOpen ? (
        <FlashcardsDialog
          open={flashcardsOpen}
          onClose={() => setFlashcardsOpen(false)}
          onOpenAtPage={onOpenAtPage}
        />
      ) : null}
      {shareOpen ? <ReadonlyShareDialog documents={allDocuments.filter(doc => !meta.items[doc.key]?.deleted)} onClose={() => setShareOpen(false)} /> : null}
    </div>
  );
}

export function UpdateControl() {
  const [status, setStatus] = useState<DesktopUpdateStatus>(() => (
    window.__READX_DESKTOP_UPDATES__
      ? { state: 'idle' }
      : { state: 'unsupported', message: '应用内更新仅在桌面安装版中提供。' }
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
    : status.state === 'current' ? `已是最新 · v${status.version ?? status.currentVersion}`
      : status.state === 'available' ? `下载更新 · v${status.version}`
        : status.state === 'downloading' ? `正在下载 · ${Math.round(status.percent ?? 0)}%`
          : status.state === 'downloaded' ? `${status.installMode === 'manual-dmg' ? '打开安装包' : '重启并安装'}`
            : status.state === 'error' ? '更新失败 · 重试'
              : status.state === 'unavailable' ? '检查更新'
                : status.state === 'unsupported' ? '桌面版更新'
                  : '检查更新';
  const detail = status.installMode === 'manual-dmg' && status.message
    ? status.message
    : status.state === 'error' || status.state === 'unsupported' ? status.message : undefined;
  const disabled = !bridge || busy;

  return (
    <>
      <div className={`sidebar-update${busy ? ' is-busy' : ''}`}>
        <button
          type="button"
          className="rx-ctx-item sidebar-update-button"
          onClick={() => void run()}
          disabled={disabled}
          title={detail ?? label}
        >
          <Icon name="sync" size={15} />
          <span>{label}</span>
        </button>
        {status.state === 'downloading' ? (
          <div className="sidebar-update-progress" role="progressbar" aria-valuenow={Math.round(status.percent ?? 0)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.round(status.percent ?? 0)}%` }} />
          </div>
        ) : null}
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

  if (!documents.length) return <EmptyState title="书架里还没有论文" description="在全部文档中给论文选择所属书架，按研究领域整理阅读。" />;

  return (
    <div className="space-y-5">
      {!categories.length ? <p className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-soft">先在左侧点击「管理书架」，再用论文卡片上的「归入书架」整理同领域论文。</p> : null}
      {groups.map((shelf, index) => (
        <section key={shelf.name} className="shelf-collection">
          <ShelfCover name={shelf.name} color={shelf.color} documents={shelf.docs} index={index} />
          <div className="shelf-collection-body">
            {shelf.docs.length ? (
              <div className="book-grid p-0">
                {shelf.docs.map((doc) => (
                  <LibraryCard
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
                  />
                ))}
              </div>
            ) : <p className="text-xs text-ink-faint">这个书架还没有论文。</p>}
          </div>
        </section>
      ))}
    </div>
  );
}

function ListRow({
  doc,
  job,
  meta,
  categories,
  selected,
  onInspect,
  onOpen,
  onOpenProcessing,
  onRetranslate,
  onOpenReproduction,
  onToggleFavorite,
  onToggleTrash,
}: {
  doc: DocumentSummary;
  job?: DocumentProcessingJob;
  meta: DocumentMeta | undefined;
  categories: Category[];
  selected: boolean;
  onInspect: () => void;
  onOpen: () => void;
  onOpenProcessing: () => void;
  onRetranslate: (doc: DocumentSummary) => void;
  onOpenReproduction: (key: string) => void;
  onToggleFavorite: () => void;
  onToggleTrash: () => Promise<unknown>;
}) {
  const jStatus = job ? jobStatus(job) : '';
  const translateStage = job?.stages.find((s) => s.key === 'translate');
  const pct = translateStage && translateStage.total > 0 ? Math.round((translateStage.completed / translateStage.total) * 100) : 0;

  const statusChip =
    jStatus === 'running' ? (
      <>
        <Chip tone="info" icon="loader" spin>
          <span className="num">
            {translateStage && translateStage.total > 0 ? `${translateStage.completed}/${translateStage.total} 段` : '处理中'}
          </span>
        </Chip>
        {translateStage && translateStage.total > 0 ? (
          <div className="w-16"><ProgressBar value={pct} /></div>
        ) : null}
      </>
    ) : jStatus === 'failed' || jStatus === 'interrupted' ? (
      <>
        <Chip tone="bad" icon="alert">{jStatus === 'failed' ? '处理失败' : '已中断'}</Chip>
        <Button size="sm" variant="secondary" onClick={onOpenProcessing}>重新处理</Button>
      </>
    ) : doc.status === 'done' ? (
      <Chip tone="good" icon="check">已精读</Chip>
    ) : doc.status === 'reading' ? (
      <Chip tone="accent" icon="book">在读</Chip>
    ) : (
      <Chip tone="mute" icon="queue">{statusLabel(doc.status)}</Chip>
    );

  return (
    <li
      className="rx-lib-row"
      aria-selected={selected ? 'true' : undefined}
      onClick={onInspect}
    >
      <div className="rx-fmt">{formatBadgeLabel(doc.format)}</div>

      <button type="button" onClick={onOpen} className="rx-lib-row-main">
        <h4>{doc.title || '（无标题）'}</h4>
        {doc.translatedTitle ? <p className="rx-lib-row-sub">{doc.translatedTitle}</p> : null}
        <div className="rx-lib-row-meta">
          <span>{doc.authors[0] ?? '作者未知'}{doc.authors.length > 1 ? ' 等' : ''}</span>
          {doc.venue || doc.year ? <span className="num">{[doc.venue, doc.year].filter(Boolean).join(' ')}</span> : null}
          {(meta?.categories ?? []).map((name) => {
            const definition = categories.find((item) => item.name === name);
            return (
              <span key={name} className="rx-tag gap-1">
                <span className="ann-color-dot" style={{ background: categoryDot(definition?.color ?? 'slate') }} />
                {name}
              </span>
            );
          })}
        </div>
      </button>

      <div className="rx-lib-row-end">
        {statusChip}
        <div className="rx-lib-row-hover-acts">
          <IconButton
            size="sm"
            icon="star"
            label={meta?.favorite ? '取消收藏' : '收藏'}
            active={Boolean(meta?.favorite)}
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
          />
          {!isSectionFormat(doc.format) && doc.hasPdf ? (
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onRetranslate(doc); }}>
              重新翻译
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onOpenReproduction(doc.key); }}>
            复现
          </Button>
          <LibraryTrashButton title={doc.title || doc.key} deleted={Boolean(meta?.deleted)} onToggle={onToggleTrash} />
        </div>
      </div>
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
        {DEFAULT_TABLE_COLUMNS.map((column) => (
          <label key={column}>
            <input type="checkbox" checked={visible(column)} disabled={visible(column) && columns.length === 1} onChange={() => onToggleColumn(column)} />{labels[column]}
          </label>
        ))}
      </div>
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line-strong text-xs text-ink-faint">
            {visible('title') ? <th className="cursor-pointer px-3 py-2 font-medium hover:text-ink" onClick={() => onSort('title')}>标题{arrow('title')}</th> : null}
            {visible('author') ? <th className="px-3 py-2 font-medium">作者</th> : null}
            {visible('year') ? <th className="cursor-pointer px-3 py-2 font-medium hover:text-ink" onClick={() => onSort('year')}>年份{arrow('year')}</th> : null}
            {visible('status') ? <th className="cursor-pointer px-3 py-2 font-medium hover:text-ink" onClick={() => onSort('status')}>状态{arrow('status')}</th> : null}
            {visible('shelves') ? <th className="px-3 py-2 font-medium">书架</th> : null}
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => {
            const item = meta[doc.key];
            return (
              <tr
                key={doc.id}
                className={`border-b border-line align-top transition ${doc.id === selectedId ? 'bg-accent-soft/50' : 'hover:bg-surface-hover'}`}
              >
                {visible('title') ? (
                  <td className="px-3 py-2.5">
                    <button type="button" onClick={() => onSelect(doc.id)} className="text-left font-medium text-ink hover:text-accent">
                      {item?.favorite ? <span className="mr-1 text-accent">★</span> : null}
                      {doc.title || '（无标题）'}
                      {doc.translatedTitle ? <small className="block text-xs text-ink-faint">{doc.translatedTitle}</small> : null}
                    </button>
                  </td>
                ) : null}
                {visible('author') ? <td className="px-3 py-2.5 text-xs text-ink-soft">{doc.authors[0] ?? '作者未知'}{doc.authors.length > 1 ? ' 等' : ''}</td> : null}
                {visible('year') ? <td className="px-3 py-2.5 num text-xs text-ink-soft">{doc.year ?? '—'}</td> : null}
                {visible('status') ? (
                  <td className="px-3 py-2.5">
                    <Chip tone={doc.status === 'done' ? 'good' : doc.status === 'reading' ? 'accent' : 'mute'}>{statusLabel(doc.status)}</Chip>
                  </td>
                ) : null}
                {visible('shelves') ? (
                  <td className="px-3 py-2.5">
                    {(item?.categories ?? []).length ? (
                      <span className="flex flex-wrap gap-1">
                        {(item?.categories ?? []).map((name) => (
                          <span key={name} className="rx-tag">{name}</span>
                        ))}
                      </span>
                    ) : <span className="text-ink-faint">—</span>}
                  </td>
                ) : null}
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    {doc.format !== 'epub' && doc.hasPdf && doc.paperMemoryStatus && doc.paperMemoryStatus !== 'done' ? <Button size="sm" variant="secondary" onClick={() => onOpenProcessing(doc)}>处理</Button> : null}
                    {doc.format !== 'epub' && doc.hasPdf ? <Button size="sm" variant="ghost" onClick={() => onRetranslate(doc)}>重译</Button> : null}
                    <Button size="sm" variant="ghost" onClick={() => onOpenReproduction(doc.key)}>复现</Button>
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
    <div className="mt-2 rounded-lg border border-line bg-surface p-2.5">
      <div className="flex items-center gap-1.5">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void create(); }}
          placeholder="书架名称"
          className="rx-field-control h-7 min-w-0 flex-1 text-xs"
        />
        <Button size="sm" variant="primary" onClick={() => void create()} disabled={busy || !name.trim()}>添加</Button>
      </div>
      <div className="mt-2 flex items-center gap-1">
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
        <ul className="mt-2 space-y-1">
          {meta.categories.map((item) => (
            <li key={item.name} className="flex items-center gap-1.5 text-xs">
              <span className="ann-color-dot" style={{ background: categoryDot(item.color) }} />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <button type="button" disabled={busy} onClick={() => void meta.deleteCategory(item.name).catch(() => undefined)} className="text-ink-faint hover:text-bad">
                删除
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="mt-1 text-xs text-bad">{error}</p> : null}
      <button type="button" onClick={onDone} className="mt-2 text-xs text-ink-faint underline">完成</button>
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="p-5 flex flex-col gap-4">
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className="flex items-center gap-4 border-b border-line pb-4">
          <div className="h-11 w-9 rounded bg-surface-sunk" />
          <div className="flex-1 flex flex-col gap-2">
            <Skeleton width="68%" />
            <Skeleton width="42%" />
          </div>
        </div>
      ))}
    </div>
  );
}
