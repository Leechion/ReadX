import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import type { SyncTeXBox } from '@cbct/shared';

// 与阅读器用同一个 pdfjs-dist 与同一个 worker 资源：
// 复用「渲染并查找 PDF」这项能力，但不把阅读器的标注/译文状态带进 LaTeX 工作区。
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

/**
 * 在某一页的文字里找出所有命中，并算出它们在页面坐标系（scale=1）里的矩形。
 *
 * 坐标系用 getViewport({scale:1})：矩形与渲染时的缩放无关，
 * 渲染时统一乘当前缩放即可，这样改缩放不用重新扫描。
 */
function findHitsInPage(content: TextContent, needle: string, pageNumber: number): Hit[] {
  // 与阅读器的拼接规则一致：item 之间补一个空格（PDF 的文本块本来就不是连续字符串）。
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

  const lowered = text.toLowerCase();
  const target = needle.toLowerCase();
  const hits: Hit[] = [];
  let from = 0;
  for (;;) {
    const index = lowered.indexOf(target, from);
    if (index < 0) break;
    const matchEnd = index + target.length;
    const rects: Rect[] = [];
    for (const item of items) {
      if (item.end <= index || item.start >= matchEnd) continue;
      const localStart = Math.max(index, item.start) - item.start;
      const localEnd = Math.min(matchEnd, item.end) - item.start;
      const length = Math.max(item.str.length, 1);
      // PDF.js 的 item.width 是页面单位下的宽度；这里不涉及缩放。
      const originX = item.transform[4] ?? 0;
      const originY = item.transform[5] ?? 0;
      const left = originX + (item.width * localStart) / length;
      const right = originX + (item.width * localEnd) / length;
      const height = Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) || 10;
      // 页面坐标（左下原点）转成画布坐标由调用方按 viewport 处理，
      // 这里只给出「基线 + 高度」的盒子。
      rects.push({ x: left, y: originY - height, width: Math.max(right - left, 1), height: height * 1.25 });
    }
    if (rects.length) hits.push({ page: pageNumber, rects });
    from = matchEnd;
  }
  return hits;
}

/**
 * 编译产物预览。
 *
 * 四个必须做对的细节：
 *   - **重新编译后保持阅读位置**：缩放与页码留在 state 里，只有换产物才重载文档；
 *   - **渲染可取消**：快速翻页/缩放时旧渲染必须作废，否则会出现后一页盖住前一页；
 *   - **加载中/失败都有明确状态**，不留空白让人以为没产物；
 *   - **查找如实报数**：扫描进度、扫不出来的页数都显示出来，不把「没扫到」说成「没有」。
 */
export function LatexPdfPreview({ buildId, load, syncTarget = null, onReverseSync, onDownload, onError }: LatexPdfPreviewProps) {
  const stage = useRef<HTMLDivElement>(null);
  const pageElements = useRef(new Map<number, HTMLDivElement>());
  const document_ = useRef<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [stageWidth, setStageWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [hitIndex, setHitIndex] = useState(-1);
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null);
  const [unreadablePages, setUnreadablePages] = useState(0);

  // 加载文档
  useEffect(() => {
    let cancelled = false;
    if (!buildId) {
      setStatus('idle');
      setPages(0);
      return;
    }
    setStatus('loading');
    setMessage('');
    setHits([]);
    setHitIndex(-1);
    void (async () => {
      try {
        const data = await load(buildId);
        if (cancelled) return;
        const pdf = await getDocument({ data: new Uint8Array(data) }).promise;
        if (cancelled) {
          void pdf.destroy();
          return;
        }
        document_.current = pdf;
        setPages(pdf.numPages);
        setPage((current) => Math.min(Math.max(current, 1), pdf.numPages));
        setStatus('ready');
        requestAnimationFrame(() => stage.current?.scrollTo({ top: 0, behavior: 'auto' }));
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
    };
    // 只在产物变化时重新加载：切换缩放/页码不该重新下载整份 PDF。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId]);

  /** 整本扫描：进度与「有页读不出文字」都要如实反映。 */
  const runSearch = useCallback(
    async (needle: string) => {
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
          collected.push(...findHitsInPage(content, needle.trim(), number));
        } catch {
          // 整页扫描的页面拿不到文字层：如实计数，不能让它们看起来像「没有命中」。
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
    },
    [],
  );

  const goToHit = useCallback(
    (index: number) => {
      if (!hits.length) return;
      const wrapped = ((index % hits.length) + hits.length) % hits.length;
      setHitIndex(wrapped);
      const targetPage = hits[wrapped]!.page;
      setPage(targetPage);
      pageElements.current.get(targetPage)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [hits],
  );

  // PDF 整本连续显示，页面宽度随预览区调整；滚动时按顶部可见页更新页码。
  useEffect(() => {
    const pdf = document_.current;
    const host = stage.current;
    if (!pdf || !host || status !== 'ready') return;
    const measure = () => setStageWidth(Math.max(240, host.clientWidth - 48));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [pages, status]);

  const handleScroll = useCallback(() => {
    const host = stage.current;
    if (!host) return;
    const top = host.getBoundingClientRect().top + 16;
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

  const hitsByPage = useMemo(() => {
    const grouped = new Map<number, Hit[]>();
    for (const hit of hits) grouped.set(hit.page, [...(grouped.get(hit.page) ?? []), hit]);
    return grouped;
  }, [hits]);
  const activeHit = hitIndex >= 0 ? hits[hitIndex] : undefined;

  useEffect(() => {
    if (status === 'ready') handleScroll();
  }, [handleScroll, pages, status, zoom]);

  useEffect(() => {
    if (!syncTarget || status !== 'ready') return;
    const targetPage = Math.min(Math.max(syncTarget.page, 1), Math.max(pages, 1));
    setPage(targetPage);
    pageElements.current.get(targetPage)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [pages, status, syncTarget]);

  const hitLabel = useMemo(() => {
    if (scan) return `扫描 ${scan.done}/${scan.total} 页…`;
    if (!query.trim()) return '';
    if (!hits.length) return unreadablePages ? '没有命中（部分页面读不出文字）' : '没有命中';
    return `第 ${hitIndex + 1} / ${hits.length} 处`;
  }, [hitIndex, hits.length, query, scan, unreadablePages]);

  if (!buildId) {
    return (
      <div className="latex-preview-empty">
        <h2>还没有编译产物</h2>
        <p>
          点「编译」用本机 TeX 发行版排版；成功后会在这里显示 PDF，
          并保留页码与缩放，便于改一处看一处。
        </p>
      </div>
    );
  }

  return (
    <div className="latex-preview">
      <div className="latex-preview-bar">
        <span className="latex-preview-page">
          {page} / {pages || '…'}
        </span>
        <button type="button" onClick={() => setZoom((current) => Math.max(0.5, Number((current - 0.15).toFixed(2))))} title="缩小">
          −
        </button>
        <span className="latex-preview-zoom">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((current) => Math.min(3, Number((current + 0.15).toFixed(2))))} title="放大">
          ＋
        </button>
        <button type="button" onClick={() => setZoom(1)} title="回到适应宽度">
          适应宽度
        </button>
        <span className="latex-preview-find">
          <input
            value={query}
            placeholder="在产物里查找"
            aria-label="在 PDF 里查找"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (hits.length && query.trim()) goToHit(hitIndex + (event.shiftKey ? -1 : 1));
                else void runSearch(query);
              }
              if (event.key === 'Escape') {
                setQuery('');
                void runSearch('');
              }
            }}
          />
          <button type="button" onClick={() => void runSearch(query)} title="扫描整份 PDF">
            查找
          </button>
          <button type="button" disabled={!hits.length} onClick={() => goToHit(hitIndex - 1)} title="上一处">
            ↑
          </button>
          <button type="button" disabled={!hits.length} onClick={() => goToHit(hitIndex + 1)} title="下一处">
            ↓
          </button>
          {hitLabel ? <span className="latex-preview-hit">{hitLabel}</span> : null}
        </span>
        <button type="button" onClick={onDownload} title="下载 PDF">
          下载
        </button>
        {onReverseSync ? <span className="latex-preview-sync-hint">双击页面跳回源码</span> : null}
      </div>
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
                  width={stageWidth}
                  zoom={zoom}
                  hits={hitsByPage.get(pageNumber) ?? EMPTY_HITS}
                  activeHit={activeHit?.page === pageNumber ? activeHit : undefined}
                  syncBoxes={syncTarget?.page === pageNumber ? syncTarget.boxes : EMPTY_SYNC_BOXES}
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
  );
}

const EMPTY_HITS: Hit[] = [];
const EMPTY_SYNC_BOXES: SyncTeXBox[] = [];

function LatexPdfPage({
  pdf,
  page,
  width,
  zoom,
  hits,
  activeHit,
  syncBoxes,
  onReverseSync,
  register,
  onError,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  width: number;
  zoom: number;
  hits: Hit[];
  activeHit?: Hit;
  syncBoxes: SyncTeXBox[];
  onReverseSync?: (page: number, x: number, y: number) => void;
  register: (element: HTMLDivElement | null) => void;
  onError: (message: string) => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const baseSize = useRef<{ width: number; height: number } | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [nearViewport, setNearViewport] = useState(false);
  const [ratio, setRatio] = useState(1.414);

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
    const host = canvasHost.current;
    if (!nearViewport || !host || width <= 0) return;
    host.replaceChildren();
    void (async () => {
      try {
        const target = await pdf.getPage(page);
        if (cancelled) return;
        const base = target.getViewport({ scale: 1 });
        baseSize.current = { width: base.width, height: base.height };
        setRatio(base.height / base.width);
        const scale = (width / base.width) * zoom;
        const viewport = target.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.className = 'latex-pdf-canvas';
        const context = canvas.getContext('2d');
        if (!context) return;
        task = target.render({ canvasContext: context, viewport }) as unknown as { cancel: () => void };
        await (task as unknown as { promise: Promise<void> }).promise;
        if (cancelled) return;
        const scaleRatio = viewport.width / base.width;
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
          context.save();
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
          context.restore();
        }
        host.replaceChildren(canvas);
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : '';
        if (!cancelled && name !== 'RenderingCancelledException') {
          onErrorRef.current(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [activeHit, hits, nearViewport, page, pdf, syncBoxes, width, zoom]);

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
    </div>
  );
}
