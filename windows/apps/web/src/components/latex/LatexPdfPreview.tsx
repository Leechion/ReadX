import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import type { SyncTeXBox } from '@cbct/shared';
import { findMatchRanges, normalizeFindTextWithOffsets } from '../../lib/findMatches';
import {
  pdfPageLinks,
  pdfReferenceTargets,
  resolvePDFDestination,
  textCitationLinks,
  type PDFLinkTarget,
  type PDFLocation,
  type PDFSourceLink,
} from '../../lib/pdfReferences';
import { Icon } from '../ui/Icon';

GlobalWorkerOptions.workerSrc = workerURL;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Hit {
  page: number;
  rects: Rect[];
}

interface JumpRecord {
  page: number;
  scrollTop: number;
}

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  url: string | null;
  items: OutlineNode[];
}

type FitMode = 'width' | 'page' | 'custom';

export interface LatexPdfPreviewProps {
  /** 每次编译产物都不同：用 buildId 触发重新加载。 */
  buildId: string | null;
  /** 取字节流的函数（带认证）。 */
  load: (buildId: string) => Promise<ArrayBuffer>;
  syncTarget?: { page: number; boxes: SyncTeXBox[]; nonce: number } | null;
  onReverseSync?: (page: number, x: number, y: number) => void;
  onDownload: () => void;
  onError: (message: string) => void;
}

function findHitsInPage(content: TextContent, needle: string, pageNumber: number, rotation = 0): Hit[] {
  const normalizedTarget = normalizeFindTextWithOffsets(needle).text.trim();
  if (!normalizedTarget) return [];
  const items: { str: string; start: number; end: number; transform: number[]; width: number }[] = [];
  let text = '';
  for (const raw of content.items) {
    if (!('str' in raw) || !raw.str) continue;
    if (text) text += ' ';
    const start = text.length;
    text += raw.str;
    items.push({ str: raw.str, start, end: text.length, transform: raw.transform, width: raw.width });
  }
  if (!text) return [];

  const normalized = normalizeFindTextWithOffsets(text);
  const ranges = findMatchRanges(normalized.text, normalizedTarget, false);
  if (!ranges.length) return [];

  // rotation 目前仍基于 PDF 原始基线矩形，后续由 canvas render 内旋转同步。
  void rotation;
  const hits: Hit[] = [];
  for (const range of ranges) {
    const start = normalized.starts[range.start]!;
    const end = normalized.ends[range.end - 1]!;
    const rects: Rect[] = [];
    for (const item of items) {
      if (item.end <= start || item.start >= end) continue;
      const localStart = Math.max(start, item.start) - item.start;
      const localEnd = Math.min(end, item.end) - item.start;
      const length = Math.max(item.str.length, 1);
      const originX = item.transform[4] ?? 0;
      const originY = item.transform[5] ?? 0;
      const left = originX + (item.width * localStart) / length;
      const right = originX + (item.width * localEnd) / length;
      const height = Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) || 10;
      rects.push({ x: left, y: originY - height, width: Math.max(right - left, 1), height: height * 1.25 });
    }
    if (rects.length) hits.push({ page: pageNumber, rects });
  }
  return hits;
}

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
const EMPTY_HITS: Hit[] = [];
const EMPTY_SYNC_BOXES: SyncTeXBox[] = [];

/**
 * 完整 Google PDF（Chrome PDFium）体验的内置 LaTeX PDF 阅读器：
 * - HiDPI (>=2x) 锐利渲染 + 原生 TextLayer 段落选取复制
 * - 点击引用序号 `[1]` / `\cite` / `\ref` / 目录 / URL 精确跳转 + 一键「返回跳转前位置」
 * - 左侧可收起「缩略图 & PDF 大纲目录」边栏
 * - 页码输入框、适应宽度 / 适应整页 / 旋转 90°、Ctrl+F 悬浮查找框、打印与下载 PDF、SyncTeX 双击回跳
 */
export function LatexPdfPreview({ buildId, load, syncTarget = null, onReverseSync, onDownload, onError }: LatexPdfPreviewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const pageElements = useRef(new Map<number, HTMLDivElement>());
  const document_ = useRef<PDFDocumentProxy | null>(null);
  const pdfBlobUrlRef = useRef<string | null>(null);

  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [basePageSize, setBasePageSize] = useState<{ width: number; height: number }>({ width: 595, height: 842 });
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({ width: 480, height: 640 });
  const [fitMode, setFitMode] = useState<FitMode>('width');
  const [customZoom, setCustomZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [message, setMessage] = useState('');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'thumbnails' | 'outline'>('thumbnails');
  const [outline, setOutline] = useState<OutlineNode[]>([]);

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [hitIndex, setHitIndex] = useState(-1);
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null);
  const [unreadablePages, setUnreadablePages] = useState(0);

  const [jumpHistory, setJumpHistory] = useState<JumpRecord[]>([]);
  const [linkStatus, setLinkStatus] = useState('');
  const [targetHighlight, setTargetHighlight] = useState<{ page: number; x?: number; y?: number; nonce: number } | null>(null);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  // 加载编译产物 PDF
  useEffect(() => {
    let cancelled = false;
    if (pdfBlobUrlRef.current) {
      URL.revokeObjectURL(pdfBlobUrlRef.current);
      pdfBlobUrlRef.current = null;
    }
    if (!buildId) {
      setStatus('idle');
      setPages(0);
      setOutline([]);
      setJumpHistory([]);
      return;
    }
    setStatus('loading');
    setMessage('');
    setHits([]);
    setHitIndex(-1);
    setJumpHistory([]);
    setLinkStatus('');
    setTargetHighlight(null);

    void (async () => {
      try {
        const data = await load(buildId);
        if (cancelled) return;
        const copyForPrint = new Uint8Array(data).slice();
        const blobUrl = URL.createObjectURL(new Blob([copyForPrint], { type: 'application/pdf' }));
        pdfBlobUrlRef.current = blobUrl;

        const pdf = await getDocument({ data: new Uint8Array(data) }).promise;
        if (cancelled) {
          void pdf.destroy();
          return;
        }
        document_.current = pdf;
        const firstPage = await pdf.getPage(1);
        if (cancelled) return;
        const vp = firstPage.getViewport({ scale: 1 });
        setBasePageSize({ width: vp.width, height: vp.height });
        setPages(pdf.numPages);
        setPage((current) => Math.min(Math.max(current, 1), pdf.numPages));

        const rawOutline = await pdf.getOutline().catch(() => null);
        if (!cancelled) {
          setOutline(Array.isArray(rawOutline) ? (rawOutline as unknown as OutlineNode[]) : []);
        }
        setStatus('ready');
      } catch (cause) {
        if (cancelled) return;
        const text = cause instanceof Error ? cause.message : String(cause);
        setStatus('failed');
        setMessage(text);
        onError(`预览失败：${text}`);
      }
    })();

    return () => {
      cancelled = true;
      void document_.current?.destroy();
      document_.current = null;
      if (pdfBlobUrlRef.current) {
        URL.revokeObjectURL(pdfBlobUrlRef.current);
        pdfBlobUrlRef.current = null;
      }
    };
    // 只在产物变化时重新加载，切换缩放/页码/旋转不重新拉取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId]);

  // 监测舞台尺寸（计算适应宽度 / 适应页面缩放）
  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    const measure = () => {
      setStageSize({
        width: Math.max(240, host.clientWidth - 40),
        height: Math.max(240, host.clientHeight - 32),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [status, drawerOpen]);

  // 根据旋转后的自然尺寸计算实际每页 CSS 宽度 & zoom
  const rotatedNatural = useMemo(() => {
    const swapped = rotation % 180 !== 0;
    return swapped
      ? { width: basePageSize.height, height: basePageSize.width }
      : basePageSize;
  }, [basePageSize, rotation]);

  const effectiveZoom = useMemo(() => {
    if (fitMode === 'width') return 1;
    if (fitMode === 'page') {
      const widthBaseScale = stageSize.width / Math.max(rotatedNatural.width, 1);
      const fitHeightScale = stageSize.height / Math.max(rotatedNatural.height, 1);
      const fitWidthScale = stageSize.width / Math.max(rotatedNatural.width, 1);
      const minScale = Math.min(fitHeightScale, fitWidthScale);
      return Math.max(0.35, Math.min(3, minScale / Math.max(widthBaseScale, 0.01)));
    }
    return customZoom;
  }, [customZoom, fitMode, rotatedNatural.height, rotatedNatural.width, stageSize.height, stageSize.width]);

  const scrollToLocation = useCallback((loc: PDFLocation, recordHistory = true) => {
    const host = stage.current;
    const targetEl = pageElements.current.get(loc.page);
    if (!host) return;
    if (recordHistory) {
      setJumpHistory((prev) => [...prev.slice(-19), { page, scrollTop: host.scrollTop }]);
    }
    setPage(loc.page);
    if (targetEl) {
      const hostRect = host.getBoundingClientRect();
      const pageRect = targetEl.getBoundingClientRect();
      const offsetRatio = typeof loc.y === 'number' ? Math.max(0, Math.min(0.95, loc.y)) : 0;
      const offsetInPage = offsetRatio * targetEl.clientHeight;
      const nextScrollTop = Math.max(
        0,
        host.scrollTop + (pageRect.top - hostRect.top) + offsetInPage - host.clientHeight * 0.18,
      );
      host.scrollTo({ top: nextScrollTop, behavior: 'smooth' });
    }
    if (typeof loc.y === 'number') {
      setTargetHighlight({ page: loc.page, x: loc.x, y: loc.y, nonce: Date.now() });
    }
  }, [page]);

  const jumpBack = useCallback(() => {
    setJumpHistory((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1]!;
      const host = stage.current;
      if (host) {
        host.scrollTo({ top: last.scrollTop, behavior: 'smooth' });
      }
      setPage(last.page);
      setTargetHighlight(null);
      return prev.slice(0, -1);
    });
  }, []);

  const handleLinkTarget = useCallback(async (target: PDFLinkTarget) => {
    const pdf = document_.current;
    if (!pdf) return;
    setLinkStatus('');
    try {
      const location =
        target.kind === 'destination'
          ? await resolvePDFDestination(pdf, target.destination, rotation)
          : (await pdfReferenceTargets(pdf)).get(target.number);
      if (document_.current !== pdf) return;
      if (!location) {
        setLinkStatus(`未找到参考文献 [${target.kind === 'citation' ? target.number : ''}] 位置`);
        return;
      }
      scrollToLocation(location, true);
    } catch (cause) {
      setLinkStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rotation, scrollToLocation]);

  const handleOutlineClick = useCallback(async (node: OutlineNode) => {
    if (node.url && /^(https?:|mailto:)/i.test(node.url)) {
      window.open(node.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!node.dest) return;
    await handleLinkTarget({ kind: 'destination', destination: node.dest });
  }, [handleLinkTarget]);

  const runSearch = useCallback(async (needle: string) => {
    const pdf = document_.current;
    if (!pdf || !needle.trim()) {
      setHits([]);
      setHitIndex(-1);
      setScan(null);
      setUnreadablePages(0);
      return;
    }
    const collected: Hit[] = [];
    let unreadable = 0;
    setScan({ done: 0, total: pdf.numPages });
    for (let number = 1; number <= pdf.numPages; number += 1) {
      try {
        const content = await pdf.getPage(number).then((target) => target.getTextContent());
        collected.push(...findHitsInPage(content, needle.trim(), number, rotation));
      } catch {
        unreadable += 1;
      }
      setScan({ done: number, total: pdf.numPages });
    }
    setUnreadablePages(unreadable);
    setScan(null);
    setHits(collected);
    if (collected.length) {
      setHitIndex(0);
      setPage(collected[0]!.page);
      pageElements.current.get(collected[0]!.page)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      setHitIndex(-1);
    }
  }, [rotation]);

  const goToHit = useCallback((index: number) => {
    if (!hits.length) return;
    const wrapped = ((index % hits.length) + hits.length) % hits.length;
    setHitIndex(wrapped);
    const targetPage = hits[wrapped]!.page;
    setPage(targetPage);
    pageElements.current.get(targetPage)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hits]);

  const handleScroll = useCallback(() => {
    const host = stage.current;
    if (!host) return;
    const top = host.getBoundingClientRect().top + 24;
    let current = 1;
    let closest = Number.POSITIVE_INFINITY;
    for (const [number, element] of pageElements.current) {
      const distance = Math.abs(element.getBoundingClientRect().top - top);
      if (distance < closest) {
        closest = distance;
        current = number;
      }
    }
    setPage(current);
  }, []);

  const jumpToPageNumber = useCallback((nextPage: number) => {
    if (!pages) return;
    const clamped = Math.min(Math.max(1, Math.round(nextPage)), pages);
    setPage(clamped);
    setPageInput(String(clamped));
    pageElements.current.get(clamped)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [pages]);

  const printPdf = useCallback(() => {
    const url = pdfBlobUrlRef.current;
    if (!url) return;
    const frame = document.createElement('iframe');
    frame.style.position = 'fixed';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    frame.src = url;
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } finally {
        window.setTimeout(() => frame.remove(), 60_000);
      }
    };
    document.body.appendChild(frame);
  }, []);

  const hitsByPage = useMemo(() => {
    const grouped = new Map<number, Hit[]>();
    for (const hit of hits) grouped.set(hit.page, [...(grouped.get(hit.page) ?? []), hit]);
    return grouped;
  }, [hits]);
  const activeHit = hitIndex >= 0 ? hits[hitIndex] : undefined;

  useEffect(() => {
    if (status === 'ready') handleScroll();
  }, [handleScroll, pages, status, effectiveZoom, rotation]);

  useEffect(() => {
    if (!syncTarget || status !== 'ready') return;
    const targetPage = Math.min(Math.max(syncTarget.page, 1), Math.max(pages, 1));
    setPage(targetPage);
    pageElements.current.get(targetPage)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [pages, status, syncTarget]);

  // 淡出高亮靶点提示
  useEffect(() => {
    if (!targetHighlight) return;
    const timer = window.setTimeout(() => setTargetHighlight(null), 2400);
    return () => window.clearTimeout(timer);
  }, [targetHighlight]);

  const hitLabel = useMemo(() => {
    if (scan) return `扫描 ${scan.done}/${scan.total}`;
    if (!query.trim()) return '';
    if (!hits.length) return unreadablePages ? '0/0（扫描页不可读）' : '0/0';
    return `${hitIndex + 1}/${hits.length}`;
  }, [hitIndex, hits.length, query, scan, unreadablePages]);

  const stepZoom = (delta: number) => {
    setFitMode('custom');
    setCustomZoom(Number(Math.min(3, Math.max(0.35, effectiveZoom + delta)).toFixed(2)));
  };

  if (!buildId) {
    return (
      <div className="latex-preview-empty">
        <h2>还没有编译产物</h2>
        <p>点击工具栏「编译」生成 PDF。</p>
      </div>
    );
  }

  return (
    <div
      className="latex-preview"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          event.stopPropagation();
          setFindOpen(true);
          requestAnimationFrame(() => {
            findInputRef.current?.focus();
            findInputRef.current?.select();
          });
        } else if (event.altKey && event.key === 'ArrowLeft' && jumpHistory.length > 0) {
          event.preventDefault();
          jumpBack();
        }
      }}
    >
      {/* Google Chrome PDFium 风格控制条 */}
      <div className="latex-pdf-chrome-bar">
        <div className="latex-pdf-bar-left">
          <button
            type="button"
            className={`latex-pdf-tool-btn${drawerOpen ? ' active' : ''}`}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((v) => !v)}
            title="目录大纲与缩略图"
            aria-label="切换目录与缩略图边栏"
          >
            <Icon name="sidebar" size={14} />
          </button>

          <div className="latex-pdf-pager" aria-label="页码跳转">
            <button
              type="button"
              className="latex-pdf-tool-btn"
              disabled={page <= 1}
              onClick={() => jumpToPageNumber(page - 1)}
              title="上一页"
              aria-label="上一页"
            >
              <Icon name="up" size={12} />
            </button>
            <input
              className="latex-pdf-page-input"
              value={pageInput}
              aria-label="当前页码"
              onChange={(e) => setPageInput(e.target.value.replace(/[^\d]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const num = Number(pageInput);
                  if (Number.isFinite(num) && num >= 1) jumpToPageNumber(num);
                  else setPageInput(String(page));
                }
              }}
              onBlur={() => {
                const num = Number(pageInput);
                if (Number.isFinite(num) && num >= 1 && num !== page) jumpToPageNumber(num);
                else setPageInput(String(page));
              }}
            />
            <span className="latex-pdf-page-total">/ {pages || '—'}</span>
            <button
              type="button"
              className="latex-pdf-tool-btn"
              disabled={page >= pages}
              onClick={() => jumpToPageNumber(page + 1)}
              title="下一页"
              aria-label="下一页"
            >
              <Icon name="down" size={12} />
            </button>
          </div>

          {jumpHistory.length > 0 ? (
            <button
              type="button"
              className="latex-pdf-back-jump"
              onClick={jumpBack}
              title={`返回第 ${jumpHistory[jumpHistory.length - 1]!.page} 页（Alt + ←）`}
            >
              <Icon name="undo" size={12} />
              <span>返回 P.{jumpHistory[jumpHistory.length - 1]!.page}</span>
            </button>
          ) : null}
        </div>

        <div className="latex-pdf-bar-center">
          <button
            type="button"
            className="latex-pdf-tool-btn"
            onClick={() => stepZoom(-0.15)}
            title="缩小"
            aria-label="缩小"
          >
            <Icon name="minus" size={12} />
          </button>

          <select
            className="latex-pdf-zoom-select"
            aria-label="缩放比例"
            value={fitMode === 'width' ? 'fit-width' : fitMode === 'page' ? 'fit-page' : String(customZoom)}
            onChange={(e) => {
              const val = e.target.value;
              if (val === 'fit-width') setFitMode('width');
              else if (val === 'fit-page') setFitMode('page');
              else {
                const n = Number(val);
                if (Number.isFinite(n)) {
                  setFitMode('custom');
                  setCustomZoom(n);
                }
              }
            }}
          >
            <option value="fit-width">适应宽度 ({Math.round(effectiveZoom * 100)}%)</option>
            <option value="fit-page">适应整页</option>
            {!ZOOM_PRESETS.includes(customZoom) && fitMode === 'custom' ? (
              <option value={String(customZoom)}>{Math.round(customZoom * 100)}%</option>
            ) : null}
            {ZOOM_PRESETS.map((z) => (
              <option key={z} value={String(z)}>{Math.round(z * 100)}%</option>
            ))}
          </select>

          <button
            type="button"
            className="latex-pdf-tool-btn"
            onClick={() => stepZoom(0.15)}
            title="放大"
            aria-label="放大"
          >
            <Icon name="plus" size={12} />
          </button>

          <span className="latex-pdf-bar-sep" aria-hidden="true" />

          <button
            type="button"
            className={`latex-pdf-tool-btn${fitMode === 'page' ? ' active' : ''}`}
            onClick={() => setFitMode((prev) => (prev === 'page' ? 'width' : 'page'))}
            title={fitMode === 'page' ? '切换为适应宽度' : '适应整页显示'}
            aria-label="切换适应宽度或整页"
          >
            <Icon name="panel" size={13} />
          </button>

          <button
            type="button"
            className="latex-pdf-tool-btn"
            onClick={() => setRotation((r) => (r + 90) % 360)}
            title="顺时针旋转 90°"
            aria-label="顺时针旋转 90°"
          >
            <Icon name="sync" size={13} />
          </button>
        </div>

        <div className="latex-pdf-bar-right">
          <button
            type="button"
            className={`latex-pdf-tool-btn${findOpen ? ' active' : ''}`}
            onClick={() => {
              setFindOpen((v) => {
                const next = !v;
                if (next) {
                  requestAnimationFrame(() => {
                    findInputRef.current?.focus();
                    findInputRef.current?.select();
                  });
                }
                return next;
              });
            }}
            title="查找文本 (Ctrl+F)"
            aria-label="在 PDF 中查找"
          >
            <Icon name="search" size={13} />
          </button>

          <button
            type="button"
            className="latex-pdf-tool-btn"
            disabled={status !== 'ready'}
            onClick={printPdf}
            title="打印 PDF"
            aria-label="打印 PDF"
          >
            <Icon name="file" size={13} />
          </button>

          <button
            type="button"
            className="latex-pdf-tool-btn"
            onClick={onDownload}
            title="下载 PDF"
            aria-label="下载 PDF"
          >
            <Icon name="import" size={13} />
          </button>
        </div>
      </div>

      {/* 主体：左侧大纲/缩略图边栏 + 右侧连续滚动 PDF 舞台 + 悬浮查找栏 */}
      <div className="latex-pdf-shell">
        {drawerOpen ? (
          <aside className="latex-pdf-sidenav" aria-label="PDF 导航侧栏">
            <div className="latex-pdf-sidenav-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={drawerTab === 'thumbnails'}
                className={drawerTab === 'thumbnails' ? 'active' : ''}
                onClick={() => setDrawerTab('thumbnails')}
              >
                缩略图
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={drawerTab === 'outline'}
                className={drawerTab === 'outline' ? 'active' : ''}
                onClick={() => setDrawerTab('outline')}
              >
                目录 ({outline.length})
              </button>
            </div>
            <div className="latex-pdf-sidenav-body">
              {drawerTab === 'outline' ? (
                outline.length ? (
                  <ul className="latex-pdf-outline">
                    {outline.map((item, idx) => (
                      <OutlineTreeItem
                        key={`${item.title}-${idx}`}
                        node={item}
                        depth={0}
                        onPick={(n) => void handleOutlineClick(n)}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="latex-pdf-sidenav-empty">该 PDF 暂无内嵌目录。</p>
                )
              ) : (
                <div className="latex-pdf-thumbs">
                  {document_.current &&
                    Array.from({ length: pages }, (_, i) => i + 1).map((pNum) => (
                      <ThumbnailItem
                        key={`${buildId}-thumb-${pNum}`}
                        pdf={document_.current!}
                        page={pNum}
                        active={pNum === page}
                        rotation={rotation}
                        onClick={() => jumpToPageNumber(pNum)}
                      />
                    ))}
                </div>
              )}
            </div>
          </aside>
        ) : null}

        <div className="latex-pdf-viewport-wrap">
          {findOpen ? (
            <div className="latex-pdf-find-popover" role="search" aria-label="查找 PDF 内容">
              <input
                ref={findInputRef}
                value={query}
                placeholder="查找文档内容…"
                aria-label="在 PDF 里查找"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (hits.length && query.trim()) goToHit(hitIndex + (e.shiftKey ? -1 : 1));
                    else void runSearch(query);
                  } else if (e.key === 'Escape') {
                    setFindOpen(false);
                    setQuery('');
                    void runSearch('');
                  }
                }}
              />
              {hitLabel ? <span className="latex-pdf-find-count tabular-nums">{hitLabel}</span> : null}
              <button type="button" onClick={() => void runSearch(query)} title="查找" aria-label="执行查找">
                <Icon name="search" size={12} />
              </button>
              <button type="button" disabled={!hits.length} onClick={() => goToHit(hitIndex - 1)} title="上一个">
                <Icon name="up" size={12} />
              </button>
              <button type="button" disabled={!hits.length} onClick={() => goToHit(hitIndex + 1)} title="下一个">
                <Icon name="down" size={12} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setFindOpen(false);
                  setQuery('');
                  void runSearch('');
                }}
                title="关闭查找"
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          ) : null}

          {linkStatus ? (
            <div className="latex-pdf-link-toast" role="status">
              <span>{linkStatus}</span>
              <button type="button" onClick={() => setLinkStatus('')}>×</button>
            </div>
          ) : null}

          <div className="latex-preview-stage" ref={stage} onScroll={handleScroll}>
            {status === 'loading' ? <p className="latex-preview-note">正在载入 PDF…</p> : null}
            {status === 'failed' ? <p className="latex-alert error">{message}</p> : null}
            {status === 'ready' && document_.current
              ? Array.from({ length: pages }, (_, index) => {
                  const pageNumber = index + 1;
                  return (
                    <LatexPdfPage
                      key={`${buildId}-${pageNumber}`}
                      pdf={document_.current!}
                      page={pageNumber}
                      width={stageSize.width}
                      zoom={effectiveZoom}
                      rotation={rotation}
                      hits={hitsByPage.get(pageNumber) ?? EMPTY_HITS}
                      activeHit={activeHit?.page === pageNumber ? activeHit : undefined}
                      syncBoxes={syncTarget?.page === pageNumber ? syncTarget.boxes : EMPTY_SYNC_BOXES}
                      targetPulse={targetHighlight?.page === pageNumber ? targetHighlight : null}
                      onLinkTarget={handleLinkTarget}
                      onReverseSync={onReverseSync}
                      register={(element) => {
                        if (element) pageElements.current.set(pageNumber, element);
                        else pageElements.current.delete(pageNumber);
                      }}
                      onError={onError}
                    />
                  );
                })
              : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function OutlineTreeItem({
  node,
  depth,
  onPick,
}: {
  node: OutlineNode;
  depth: number;
  onPick: (node: OutlineNode) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = Array.isArray(node.items) && node.items.length > 0;
  return (
    <li>
      <div className="latex-pdf-outline-row" style={{ paddingLeft: 6 + depth * 12 }}>
        {hasChildren ? (
          <button
            type="button"
            className="latex-pdf-outline-toggle"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? '收起' : '展开'}
          >
            <Icon name={expanded ? 'down' : 'right'} size={11} />
          </button>
        ) : (
          <span className="latex-pdf-outline-spacer" />
        )}
        <button
          type="button"
          className="latex-pdf-outline-label"
          onClick={() => onPick(node)}
          title={node.title}
        >
          {node.title || '（无标题）'}
        </button>
      </div>
      {hasChildren && expanded ? (
        <ul className="latex-pdf-outline">
          {node.items.map((child, i) => (
            <OutlineTreeItem key={`${child.title}-${i}`} node={child} depth={depth + 1} onPick={onPick} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ThumbnailItem({
  pdf,
  page,
  active,
  rotation,
  onClick,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  active: boolean;
  rotation: number;
  onClick: () => void;
}) {
  const slotRef = useRef<HTMLButtonElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setVisible(true);
    }, { rootMargin: '250px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !canvasHost.current) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    const host = canvasHost.current;
    void (async () => {
      try {
        const target = await pdf.getPage(page);
        if (cancelled) return;
        const base = target.getViewport({ scale: 1, rotation });
        const thumbWidth = 116;
        const scale = thumbWidth / Math.max(base.width, 1);
        const viewport = target.getViewport({ scale, rotation });
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        task = target.render({ canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, 0, 0] }) as unknown as { cancel: () => void };
        await (task as unknown as { promise: Promise<void> }).promise;
        if (!cancelled) host.replaceChildren(canvas);
      } catch {
        // 缩略图加载失败保持占位格
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [page, pdf, rotation, visible]);

  return (
    <button
      ref={slotRef}
      type="button"
      className={`latex-pdf-thumb${active ? ' active' : ''}`}
      onClick={onClick}
      aria-label={`跳转到第 ${page} 页`}
    >
      <div className="latex-pdf-thumb-canvas" ref={canvasHost} />
      <span className="tabular-nums">{page}</span>
    </button>
  );
}

function LatexPdfPage({
  pdf,
  page,
  width,
  zoom,
  rotation,
  hits,
  activeHit,
  syncBoxes,
  targetPulse,
  onLinkTarget,
  onReverseSync,
  register,
  onError,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  width: number;
  zoom: number;
  rotation: number;
  hits: Hit[];
  activeHit?: Hit;
  syncBoxes: SyncTeXBox[];
  targetPulse: { x?: number; y?: number; nonce: number } | null;
  onLinkTarget: (target: PDFLinkTarget) => Promise<void>;
  onReverseSync?: (page: number, x: number, y: number) => void;
  register: (element: HTMLDivElement | null) => void;
  onError: (message: string) => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textLayerHost = useRef<HTMLDivElement>(null);
  const baseSize = useRef<{ width: number; height: number } | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [nearViewport, setNearViewport] = useState(false);
  const [ratio, setRatio] = useState(1.414);
  const [sourceLinks, setSourceLinks] = useState<PDFSourceLink[]>([]);

  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setNearViewport(entry.isIntersecting);
    }, {
      root: element.parentElement,
      rootMargin: '900px 0px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    let layer: TextLayer | null = null;
    const host = canvasHost.current;
    const textHost = textLayerHost.current;
    const pageEl = slot.current;
    if (!nearViewport || !host || !textHost || width <= 0) {
      setSourceLinks([]);
      return;
    }
    host.replaceChildren();
    textHost.replaceChildren();
    setSourceLinks([]);
    void (async () => {
      try {
        const target = await pdf.getPage(page);
        if (cancelled) return;
        const base = target.getViewport({ scale: 1, rotation });
        baseSize.current = { width: base.width, height: base.height };
        setRatio(base.height / base.width);
        const scale = (width / base.width) * zoom;
        const viewport = target.getViewport({ scale, rotation });

        const dpr = window.devicePixelRatio || 1;
        const desiredRatio = zoom >= 1.75 ? dpr : Math.max(dpr, 2);
        const maxSideRatio = Math.max(1, 4096 / Math.max(viewport.width, viewport.height, 1));
        const renderScale = Math.min(3, desiredRatio, maxSideRatio);

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width * renderScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * renderScale));
        canvas.className = 'latex-pdf-canvas';
        const context = canvas.getContext('2d');
        if (!context) return;

        textHost.style.setProperty('--scale-factor', String(scale));
        task = target.render({
          canvasContext: context,
          viewport,
          transform: [renderScale, 0, 0, renderScale, 0, 0],
        }) as unknown as { cancel: () => void };

        const contentPromise = target.getTextContent();
        const nativeLinksPromise = pdfPageLinks(target, rotation).catch(() => [] as PDFSourceLink[]);

        await (task as unknown as { promise: Promise<void> }).promise;
        if (cancelled) return;

        const scaleRatio = viewport.width / base.width;
        context.save();
        context.scale(renderScale, renderScale);
        for (const hit of hits) {
          context.fillStyle = hit === activeHit ? 'rgba(255,145,0,.42)' : 'rgba(255,214,0,.32)';
          for (const rect of hit.rects) {
            context.fillRect(
              rect.x * scaleRatio,
              viewport.height - (rect.y + rect.height) * scaleRatio,
              rect.width * scaleRatio,
              rect.height * scaleRatio,
            );
          }
        }
        if (syncBoxes.length) {
          context.fillStyle = 'rgba(47, 111, 89, 0.24)';
          context.strokeStyle = 'rgba(47, 111, 89, 0.85)';
          context.lineWidth = Math.max(1.5, scaleRatio * 1.1);
          for (const box of syncBoxes) {
            const bx = box.x * scaleRatio;
            const by = box.y * scaleRatio;
            const bw = Math.max(box.width * scaleRatio, 10);
            const bh = Math.max(box.height * scaleRatio, 8);
            context.fillRect(bx, by, bw, bh);
            context.strokeRect(bx, by, bw, bh);
          }
        }
        context.restore();
        host.replaceChildren(canvas);

        const [textContent, nativeLinks] = await Promise.all([contentPromise, nativeLinksPromise]);
        if (cancelled) return;
        layer = new TextLayer({
          textContentSource: textContent,
          container: textHost,
          viewport,
        });
        await layer.render();
        if (cancelled) return;

        const bounds = (pageEl ?? canvas).getBoundingClientRect();
        const fallbackCitations = textCitationLinks(textHost, bounds, nativeLinks);
        setSourceLinks([...nativeLinks, ...fallbackCitations]);
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : '';
        if (!cancelled && name !== 'RenderingCancelledException' && name !== 'AbortException') {
          onErrorRef.current(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
      textHost.replaceChildren();
    };
  }, [activeHit, hits, nearViewport, page, pdf, rotation, syncBoxes, width, zoom]);

  const displayWidth = width * zoom;
  return (
    <div
      className="latex-pdf-page"
      data-page={page}
      ref={(element) => {
        slot.current = element;
        register(element);
      }}
      style={{ width: displayWidth, aspectRatio: `1 / ${ratio}` }}
      aria-label={`第 ${page} 页`}
      onDoubleClick={(event) => {
        const canvas = canvasHost.current?.querySelector('canvas');
        if (!canvas || !baseSize.current || !onReverseSync) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const x = ((event.clientX - rect.left) / rect.width) * baseSize.current.width;
        const y = ((event.clientY - rect.top) / rect.height) * baseSize.current.height;
        onReverseSync(page, x, y);
      }}
    >
      <div className="latex-pdf-page-canvas" ref={canvasHost} />
      <div className="textLayer" ref={textLayerHost} />
      <div className="pdf-source-links">
        {sourceLinks.map((link) => {
          const style = {
            left: `${link.x * 100}%`,
            top: `${link.y * 100}%`,
            width: `${link.width * 100}%`,
            height: `${link.height * 100}%`,
          };
          if (link.target) {
            return (
              <button
                type="button"
                key={link.id}
                className="pdf-source-link"
                style={style}
                title={link.label}
                aria-label={link.label}
                onClick={(event) => {
                  // 若刚刚进行了文本拖选，不误触发跳转。
                  if (window.getSelection()?.toString().trim()) return;
                  event.stopPropagation();
                  void onLinkTarget(link.target!);
                }}
              />
            );
          }
          return (
            <a
              key={link.id}
              className="pdf-source-link"
              style={style}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              title={link.label}
              aria-label={link.label}
              onClick={(event) => {
                if (window.getSelection()?.toString().trim()) {
                  event.preventDefault();
                  return;
                }
                event.stopPropagation();
              }}
            />
          );
        })}
      </div>
      {targetPulse && typeof targetPulse.y === 'number' ? (
        <div
          key={targetPulse.nonce}
          className="latex-pdf-target-pulse"
          style={{
            top: `${targetPulse.y * 100}%`,
            left: `${(targetPulse.x ?? 0.06) * 100}%`,
          }}
        />
      ) : null}
    </div>
  );
}
