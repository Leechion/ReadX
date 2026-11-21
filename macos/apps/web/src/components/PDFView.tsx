import { useEffect, useRef, useState } from 'react';
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import { fitPDFWidth, paragraphAt, mergePaperHeadings, type PaperHeading, type PDFLayout } from '@cbct/shared';
import { headingsFromPDFPage } from '../api/pdfOutline';
import { loadPDFParagraphLayout } from '../api/pdfParagraphs';
import type { SelectedParagraph } from './ParagraphActions';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { api, type Annotation, type NewAnnotation } from '../api/client';
import { findMatchRanges, normalizeFindTextWithOffsets } from '../lib/findMatches';
import { pdfPageLinks, pdfReferenceTargets, resolvePDFDestination, textCitationLinks, type PDFLinkTarget, type PDFLocation, type PDFSourceLink } from '../lib/pdfReferences';
import { MarginNote } from './MarginNote';
import type { AnnotationRect, AnnotationStroke } from '../api/client';

GlobalWorkerOptions.workerSrc = workerURL;
export type PDFOutline = PaperHeading;
export interface PendingSelection {
  annotation: NewAnnotation;
  top: number;
  left: number;
  marginAllowed?: boolean;
  pageAspect?: number;
}

/** 阅读器查找：命中所在的页与页内命中数（按页码升序）。 */
export interface PDFFindHitPage {
  page: number;
  count: number;
}

/**
 * 查找报告。scanning 非空表示还在逐页取文本，此时 pages 是「已扫到的部分」——
 * 界面必须显示扫描进度而不是把部分结果当成最终结果。
 * failed 是取文本失败的页数：这些页没有参与匹配，不能让它们看起来像「没有命中」。
 */
export interface PDFFindReport {
  pages: PDFFindHitPage[];
  scanning: { done: number; total: number } | null;
  failed: number;
}

/**
 * 查找态。
 *
 * query/caseSensitive 是「拿什么去扫」，必须在**还没有命中**时就传给视图，
 * 否则扫描无从开始（曾经把整份状态都挂在上一次扫描的结果上，导致查找永远扫不出东西）。
 * activePage/activeOccurrence 才是「跳到第几处命中」，没有命中时为 undefined。
 */
export interface PDFFindState {
  query: string;
  caseSensitive: boolean;
  activePage?: number;
  activeOccurrence?: number;
  nonce: number;
}

export function textFromPDF(content: TextContent): string {
  return content.items
    .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
    .join('')
    .trim();
}

/**
 * 查找用的整本扫描文本：按「item 之间补一个空格」拼接，与页内文本层的拼接规则一致
 * （textFromPDF 会插入换行，偏移和文本层对不上，不能拿来做命中计数）。
 */
export function findItemsText(content: TextContent): string {
  return content.items
    .map((item) => ('str' in item ? item.str : ''))
    .filter((value) => value.trim())
    .join(' ');
}

/**
 * 清理上一次查找留下的 mark，把文本节点还原（相邻文本节点合并，避免反复查找后碎片化）。
 */
function clearFindMarks(container: HTMLElement): void {
  for (const mark of Array.from(container.querySelectorAll('mark.pdf-find-hit'))) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(window.document.createTextNode(mark.textContent ?? ''), mark);
    parent.normalize();
  }
}

/**
 * 在文本层里标注 query 的全部命中，返回当前命中（activeOccurrence）对应的元素。
 *
 * 文本层是 pdf.js 生成的绝对定位 span：文字是透明的，只有背景可见，
 * 所以这里只包 <mark> 改背景，不碰任何排版属性。
 */
function applyFindMarks(
  container: HTMLElement,
  query: string,
  caseSensitive: boolean,
  activeOccurrence: number | null,
): HTMLElement | null {
  clearFindMarks(container);
  if (query.trim().length < 2) return null;

  const nodes: Text[] = [];
  const walker = window.document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    if (text.trim()) nodes.push(node as Text);
  }
  if (!nodes.length) return null;

  const joined = nodes.map((node) => node.nodeValue ?? '').join(' ');
  const normalized = normalizeFindTextWithOffsets(joined);
  const ranges = findMatchRanges(normalized.text, query, caseSensitive).map((range) => ({
    start: normalized.starts[range.start] ?? range.start,
    end: normalized.ends[range.end - 1] ?? range.end,
  }));
  if (!ranges.length) return null;

  let active: HTMLElement | null = null;
  let offset = 0;
  for (const node of nodes) {
    const text = node.nodeValue ?? '';
    const nodeStart = offset;
    offset += text.length + 1; // +1 是拼接时插入的分隔空格
    const local = ranges
      .map((range, index) => ({
        order: index + 1,
        start: Math.max(range.start - nodeStart, 0),
        end: Math.min(range.end - nodeStart, text.length),
      }))
      .filter((item) => item.end > item.start);
    if (!local.length) continue;

    const fragment = window.document.createDocumentFragment();
    let cursor = 0;
    for (const item of local) {
      if (item.start > cursor)
        fragment.appendChild(window.document.createTextNode(text.slice(cursor, item.start)));
      const mark = window.document.createElement('mark');
      mark.className = 'pdf-find-hit';
      mark.textContent = text.slice(item.start, item.end);
      if (activeOccurrence === item.order) {
        mark.classList.add('pdf-find-hit-active');
        active = mark;
      }
      fragment.appendChild(mark);
      cursor = item.end;
    }
    if (cursor < text.length)
      fragment.appendChild(window.document.createTextNode(text.slice(cursor)));
    node.parentNode?.replaceChild(fragment, node);
  }
  return active;
}

export function usePDFData(data: ArrayBuffer | null) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let task: ReturnType<typeof getDocument> | undefined;
    let cancelled = false;
    setDocument(null);
    setError('');
    if (!data) return;
    task = getDocument({
      data: data.slice(0),
      isEvalSupported: false,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
    });
    void task.promise.then((loaded) => {
      if (cancelled) return;
      setDocument(loaded);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [data]);
  return { document, error };
}

type PDFMarkRect = { x: number; y: number; width: number; height: number };

function visualAt(layout: PDFLayout, x: number, y: number): number | null {
  const px = x * layout.width, py = y * layout.height;
  let index: number | null = null;
  for (let i = 0; i < (layout.visuals?.length ?? 0); i++) {
    const block = layout.visuals![i]!;
    if (px < block.x || px > block.x + block.width || py < block.y || py > block.y + block.height) continue;
    const previous = index === null ? null : layout.visuals![index]!;
    if (!previous || block.width * block.height < previous.width * previous.height) index = i;
  }
  return index;
}

function mergePDFMarkRects(rects: PDFMarkRect[]): PDFMarkRect[] {
  const rows: { top: number; bottom: number; rects: PDFMarkRect[] }[] = [];
  for (const rect of [...rects]
    .filter((item) => Number.isFinite(item.x + item.y + item.width + item.height) && item.width > 0 && item.height > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x)) {
    const bottom = rect.y + rect.height;
    const center = rect.y + rect.height / 2;
    const row = rows.find((candidate) => {
      const overlap = Math.max(0, Math.min(bottom, candidate.bottom) - Math.max(rect.y, candidate.top));
      const minHeight = Math.min(rect.height, candidate.bottom - candidate.top);
      const rowCenter = (candidate.top + candidate.bottom) / 2;
      return overlap / minHeight >= 0.55 || Math.abs(center - rowCenter) <= minHeight * 0.32;
    });
    if (row) {
      row.top = Math.min(row.top, rect.y);
      row.bottom = Math.max(row.bottom, bottom);
      row.rects.push(rect);
    } else rows.push({ top: rect.y, bottom, rects: [rect] });
  }

  return rows.flatMap((row) => {
    const merged: PDFMarkRect[] = [];
    for (const rect of row.rects.sort((a, b) => a.x - b.x)) {
      const previous = merged[merged.length - 1];
      if (previous && rect.x <= previous.x + previous.width + 0.0025) {
        const right = Math.max(previous.x + previous.width, rect.x + rect.width);
        const top = Math.min(previous.y, rect.y);
        const bottom = Math.max(previous.y + previous.height, rect.y + rect.height);
        previous.x = Math.min(previous.x, rect.x);
        previous.width = right - previous.x;
        previous.y = top;
        previous.height = bottom - top;
      } else merged.push({ ...rect });
    }
    return merged;
  });
}

function pdfSelectionRects(range: Range, bounds: DOMRect): PDFMarkRect[] {
  const rects = Array.from(range.getClientRects()).flatMap((rect) => {
    const left = Math.max(bounds.left, rect.left);
    const top = Math.max(bounds.top, rect.top);
    const right = Math.min(bounds.right, rect.right);
    const bottom = Math.min(bounds.bottom, rect.bottom);
    if (right - left <= 1 || bottom - top <= 1) return [];
    return [{
      x: (left - bounds.left) / bounds.width,
      y: (top - bounds.top) / bounds.height,
      width: (right - left) / bounds.width,
      height: (bottom - top) / bounds.height,
    }];
  });
  return mergePDFMarkRects(rects);
}

export function usePDF(key: string | null, translated = false) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [outline, setOutline] = useState<PDFOutline[]>([]);
  const [error, setError] = useState('');
  const [indexing, setIndexing] = useState('');
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    let task: ReturnType<typeof getDocument> | undefined;
    setDocument(null);
    setOutline([]);
    setError('');
    setIndexing('');
    void (async () => {
      try {
        let data!: ArrayBuffer;
        if (translated) {
          // Import writes translated pages before assembling the final PDF.
          // Keep checking so a reader opened mid-import switches to the complete
          // document as soon as LeePDF finishes its render stage.
          while (!controller.signal.aborted) {
            try {
              data = await api.translatedFile(key, controller.signal);
              break;
            } catch {
              if (controller.signal.aborted) return;
              await new Promise<void>((resolve) => {
                const timer = window.setTimeout(resolve, 2500);
                controller.signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true });
              });
            }
          }
          if (controller.signal.aborted) return;
        } else {
          data = await api.file(key, controller.signal);
        }
        if (controller.signal.aborted) return;
        task = getDocument({
          data,
          isEvalSupported: false,
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs/standard_fonts/',
        });
        const doc = await task.promise;
        if (controller.signal.aborted) return;
        setDocument(doc);
        const tree = await doc.getOutline();
        const entries: PDFOutline[] = [];
        const visit = async (
          items: NonNullable<typeof tree>,
          depth: number,
        ) => {
          for (const item of items) {
            try {
              const dest =
                typeof item.dest === 'string'
                  ? await doc.getDestination(item.dest)
                  : item.dest;
              if (dest?.[0] != null) {
                const page =
                  typeof dest[0] === 'number'
                    ? dest[0] + 1
                    : (await doc.getPageIndex(dest[0])) + 1;
                const mode = dest[1]?.name;
                const top = mode === 'XYZ' ? dest[3] : mode === 'FitH' || mode === 'FitBH' ? dest[2] : mode === 'FitR' ? dest[5] : undefined;
                let y: number | undefined;
                if (typeof top === 'number') {
                  const viewport = (await doc.getPage(page)).getViewport({ scale: 1 });
                  const left = mode === 'XYZ' && typeof dest[2] === 'number' ? dest[2] : 0;
                  y = Math.max(0, Math.min(1, viewport.convertToViewportPoint(left, top)[1]! / viewport.height));
                }
                entries.push({ title: item.title, page, depth, y });
              }
            } catch {
              /* An invalid PDF destination should not prevent reading. */
            }
            await visit(item.items, depth + 1);
          }
        };
        if (tree) await visit(tree, 0);
        if (!controller.signal.aborted) setOutline(entries);
        if (translated) {
          if (!controller.signal.aborted) setIndexing('');
          return;
        }
        const cached = new Set(
          (await api.pages(key, controller.signal)).pages.map(
            (item) => item.page,
          ),
        );
        let empty = 0;
        const inferred: PDFOutline[] = [];
        for (let page = 1; page <= doc.numPages; page++) {
          if (controller.signal.aborted) return;
          const pdfPage = await doc.getPage(page);
          const content = await pdfPage.getTextContent();
          if (controller.signal.aborted) return;
          inferred.push(...headingsFromPDFPage(pdfPage, content));
          setOutline(mergePaperHeadings(entries, inferred));
          if (cached.has(page)) { await new Promise((resolve) => setTimeout(resolve, 0)); continue; }
          setIndexing(`正在提取正文与目录 ${page}/${doc.numPages}`);
          const text = textFromPDF(content);
          if (controller.signal.aborted) return;
          if (text) await api.putPage(key, page, text, controller.signal);
          else empty++;
        }
        if (!controller.signal.aborted)
          setIndexing(
            empty
              ? `${empty} 页是扫描页；OCR 与译文由 LeePDF 处理，可切换到译文查看`
              : '',
          );
      } catch (cause) {
        if (!controller.signal.aborted) {
          const message =
            cause instanceof Error ? cause.message : String(cause);
          if (task) setIndexing(`正文提取未完成：${message}`);
          else setError(message);
        }
      }
    })();
    return () => {
      controller.abort();
      void task?.destroy();
    };
  }, [key, translated]);
  return { document, outline, error, indexing };
}

/** Continuous document canvas. It preserves a single scroll surface and renders nearby pages lazily. */
export function PDFDocumentView({
  document,
  documentKey,
  page,
  onPage,
  annotations,
  focusedId,
  onSelect,
  onText,
  layout,
  paragraphMode = false,
  onParagraph,
  onAnnotationClick,
  navigationRequest,
  find = null,
  onFind,
  zoom,
  onZoomChange,
  onMarginNoteEdit,
  onMarginNoteGeometry,
  toolMode = 'select',
  inkColor = 'rose',
  onRegionSnip,
  onInkCommit,
}: {
  document: PDFDocumentProxy;
  documentKey?: string;
  page: number;
  onPage: (page: number) => void;
  annotations: Annotation[];
  focusedId: string | null;
  onSelect: (selection: PendingSelection) => void;
  onText: (text: string) => void;
  layout?: PDFLayout | null;
  paragraphMode?: boolean;
  onParagraph?: (paragraph: SelectedParagraph) => void;
  onAnnotationClick?: (annotation: Annotation, position: { top: number; left: number }) => void;
  navigationRequest?: { page: number; y?: number; viewportOffset?: number; nonce: number };
  find?: PDFFindState | null;
  /** 只有当前正在查找的那一栏会拿到 onFind，另一栏就不会重复扫描与标注。 */
  onFind?: (report: PDFFindReport) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onMarginNoteEdit?: (annotation: Annotation) => void;
  onMarginNoteGeometry?: (annotation: Annotation, rect: AnnotationRect) => Promise<void>;
  toolMode?: 'select' | 'snip' | 'ink';
  inkColor?: string;
  onRegionSnip?: (data: { page: number; imageBase64: string }) => void;
  onInkCommit?: (data: { page: number; strokes: AnnotationStroke[] }) => Promise<void> | void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const slots = useRef(new Map<number, HTMLDivElement>());
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  const activePageRef = useRef(page);
  activePageRef.current = page;
  const readingAnchor = useRef({ page, ratio: 0 });
  const geometry = useRef({ document, width: 0, zoom });
  const onFindRef = useRef(onFind);
  onFindRef.current = onFind;
  const findEnabled = Boolean(onFind);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const [nearPages, setNearPages] = useState<Set<number>>(() => new Set([page]));
  const [pageRatios, setPageRatios] = useState<number[]>([]);
  const [linkNavigation, setLinkNavigation] = useState<(PDFLocation & { nonce: number }) | null>(null);
  const [returnLocation, setReturnLocation] = useState<PDFLocation | null>(null);
  const [linkStatus, setLinkStatus] = useState('');
  const currentDocument = useRef(document);
  currentDocument.current = document;

  const openSourceLink = async (target: PDFLinkTarget) => {
    const sourcePage = activePageRef.current;
    const sourceSlot = slots.current.get(sourcePage);
    const origin: PDFLocation = { page: sourcePage };
    if (scrollRoot && sourceSlot) {
      origin.y = Math.max(0, (scrollRoot.getBoundingClientRect().top - sourceSlot.getBoundingClientRect().top) / sourceSlot.clientHeight);
      origin.x = Math.max(0, (scrollRoot.getBoundingClientRect().left - sourceSlot.getBoundingClientRect().left) / sourceSlot.clientWidth);
    }
    setLinkStatus(target.kind === 'citation' ? `正在定位参考文献 [${target.number}]…` : '正在定位文内目标…');
    try {
      const location = target.kind === 'destination'
        ? await resolvePDFDestination(document, target.destination)
        : (await pdfReferenceTargets(document)).get(target.number);
      if (currentDocument.current !== document) return;
      if (!location) throw new Error(`没有找到参考文献 [${target.kind === 'citation' ? target.number : ''}] 的条目位置`);
      setReturnLocation(origin);
      setLinkNavigation((previous) => ({ ...location, nonce: (previous?.nonce ?? 0) + 1 }));
      setNearPages((previous) => new Set([...previous, location.page]));
      onPageRef.current(location.page);
      setLinkStatus('');
    } catch (cause) {
      if (currentDocument.current === document)
        setLinkStatus(cause instanceof Error ? cause.message : '无法定位这个引用');
    }
  };

  useEffect(() => {
    if (!linkNavigation || !scrollRoot || pageRatios.length !== document.numPages) return;
    const slot = slots.current.get(linkNavigation.page);
    if (!slot) return;
    const bounds = slot.getBoundingClientRect(), rootBounds = scrollRoot.getBoundingClientRect();
    scrollRoot.scrollTo({
      top: Math.max(0, bounds.top - rootBounds.top + scrollRoot.scrollTop - 14 + (linkNavigation.y ?? 0) * slot.clientHeight),
      left: linkNavigation.x == null ? scrollRoot.scrollLeft : Math.max(0, bounds.left - rootBounds.left + scrollRoot.scrollLeft + linkNavigation.x * slot.clientWidth - 20),
      behavior: 'smooth',
    });
  }, [linkNavigation, scrollRoot, pageRatios.length, document.numPages]);

  // 逐页取文本算命中：防抖 + 可中断。整本重扫只在关键词或大小写开关变化时发生。
  useEffect(() => {
    const report = onFindRef.current;
    if (!report || !findEnabled) return;
    const query = find?.query.trim() ?? '';
    if (query.length < 2) {
      report({ pages: [], scanning: null, failed: 0 });
      return;
    }
    const caseSensitive = find?.caseSensitive ?? false;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const total = document.numPages;
        const pages: PDFFindHitPage[] = [];
        let failed = 0;
        report({ pages: [], scanning: { done: 0, total }, failed: 0 });
        for (let number = 1; number <= total; number++) {
          try {
            const pdfPage = await document.getPage(number);
            const content = await pdfPage.getTextContent();
            if (cancelled) return;
            const count = findMatchRanges(findItemsText(content), query, caseSensitive).length;
            if (count) pages.push({ page: number, count });
          } catch {
            // 单页取文本失败（损坏页）只跳过这一页，但必须计数：
            // 静默跳过会让「这一页搜不到」看起来像「这一页没有这个词」。
            failed++;
          }
          if (cancelled) return;
          if (number % 5 === 0 || number === total)
            report({
              pages: [...pages],
              scanning: number === total ? null : { done: number, total },
              failed,
            });
        }
      })();
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [document, findEnabled, find?.query, find?.caseSensitive]);

  useEffect(() => setScrollRoot(root.current), []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ratios = await Promise.all(
        Array.from({ length: document.numPages }, async (_, index) => {
          const pdfPage = await document.getPage(index + 1);
          const viewport = pdfPage.getViewport({ scale: 1 });
          return viewport.width / viewport.height;
        }).map((ratioPromise) => ratioPromise.catch(() => 0.707)),
      );
      if (!cancelled) setPageRatios(ratios);
    })();
    return () => { cancelled = true; };
  }, [document]);
  useEffect(() => {
    if (!scrollRoot || pageRatios.length !== document.numPages) return;
    const nearObserver = new IntersectionObserver((entries) => {
      setNearPages((previous) => {
        const next = new Set(previous);
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) next.add(pageNumber);
          else next.delete(pageNumber);
        }
        return next;
      });
    }, { root: scrollRoot, rootMargin: '1200px 0px' });
    for (const slot of slots.current.values()) {
      nearObserver.observe(slot);
    }
    let frame = 0;
    const restoreGeometry = () => {
      const width = scrollRoot.clientWidth;
      const previous = geometry.current;
      geometry.current = { document, width, zoom };
      if (previous.document !== document || previous.width === 0 || (previous.width === width && previous.zoom === zoom)) return;
      const anchor = readingAnchor.current;
      const slot = slots.current.get(anchor.page);
      if (!slot) return;
      cancelAnimationFrame(frame);
      scrollRoot.scrollTop += slot.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top + anchor.ratio * slot.clientHeight;
      activePageRef.current = anchor.page;
      onPageRef.current(anchor.page);
    };
    const sizeObserver = new ResizeObserver(restoreGeometry);
    sizeObserver.observe(scrollRoot);
    // Zoom changes the page-slot height without changing the scroll viewport.
    for (const slot of slots.current.values()) sizeObserver.observe(slot);
    const updateActivePage = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (geometry.current.width !== scrollRoot.clientWidth || geometry.current.zoom !== zoom) return;
        const rootBounds = scrollRoot.getBoundingClientRect();
        const marker = rootBounds.top + Math.min(96, rootBounds.height * 0.2);
        let nearestPage = 1;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const [pageNumber, slot] of slots.current) {
          const bounds = slot.getBoundingClientRect();
          if (bounds.top <= marker && bounds.bottom > marker) {
            nearestPage = pageNumber;
            nearestDistance = 0;
            break;
          }
          const distance = Math.min(Math.abs(bounds.top - marker), Math.abs(bounds.bottom - marker));
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestPage = pageNumber;
          }
        }
        if (nearestPage !== activePageRef.current) {
          activePageRef.current = nearestPage;
          onPageRef.current(nearestPage);
        }
        const activeSlot = slots.current.get(nearestPage);
        if (activeSlot) readingAnchor.current = {
          page: nearestPage,
          ratio: Math.max(0, Math.min(1, (rootBounds.top - activeSlot.getBoundingClientRect().top) / Math.max(1, activeSlot.clientHeight))),
        };
      });
    };
    scrollRoot.addEventListener('scroll', updateActivePage, { passive: true });
    updateActivePage();
    return () => {
      nearObserver.disconnect();
      sizeObserver.disconnect();
      scrollRoot.removeEventListener('scroll', updateActivePage);
      cancelAnimationFrame(frame);
    };
  }, [scrollRoot, document, pageRatios.length, zoom]);

  useEffect(() => {
    if (!scrollRoot || pageRatios.length !== document.numPages) return;
    const targetPage = navigationRequest?.page ?? page;
    const slot = slots.current.get(targetPage);
    if (!slot) return;
    const rootTop = scrollRoot.getBoundingClientRect().top;
    const top = slot.getBoundingClientRect().top - rootTop + scrollRoot.scrollTop - 14
      + Math.max(0, Math.min(1, navigationRequest?.y ?? 0)) * slot.clientHeight
      - Math.max(0, Math.min(scrollRoot.clientHeight, navigationRequest?.viewportOffset ?? 0));
    scrollRoot.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [navigationRequest?.nonce, scrollRoot, pageRatios.length, document.numPages]);

  return (
    <div className="pdf-reader pdf-document-reader">
      <div className="reader-format-tools">
        <button onClick={() => onZoomChange(Math.max(0.5, Math.round((zoom - 0.2) * 10) / 10))} disabled={zoom <= 0.5} aria-label="缩小">−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => onZoomChange(Math.min(3, Math.round((zoom + 0.2) * 10) / 10))} disabled={zoom >= 3} aria-label="放大">＋</button>
        <button onClick={() => onZoomChange(1)}>适合宽度</button>
        {returnLocation ? <button type="button" onClick={() => {
          setLinkNavigation((previous) => ({ ...returnLocation, nonce: (previous?.nonce ?? 0) + 1 }));
          onPageRef.current(returnLocation.page);
          setReturnLocation(null);
          setLinkStatus('');
        }}>返回引用处</button> : null}
      </div>
      {linkStatus ? <p className="pdf-link-status" role="status">{linkStatus}</p> : null}
      <div className="pdf-document-scroll" ref={root}>
        {pageRatios.length !== document.numPages ? (
          <p className="pdf-page-placeholder-status" role="status">正在准备连续阅读…</p>
        ) : Array.from({ length: document.numPages }, (_, index) => {
          const pageNumber = index + 1;
          return (
            <div
              className="pdf-page-slot"
              data-page={pageNumber}
              key={pageNumber}
              ref={(element) => {
                if (!element) { slots.current.delete(pageNumber); return; }
                slots.current.set(pageNumber, element);
              }}
              style={{ aspectRatio: `${(pageRatios[pageNumber - 1] ?? 0.707) / zoom}` }}
            >
              {nearPages.has(pageNumber) ? (
                <PDFPage
                  document={document}
                  documentKey={documentKey}
                  page={pageNumber}
                  annotations={annotations}
                  focusedId={focusedId}
                  onSelect={onSelect}
                  onText={onText}
                  layout={pageNumber === page ? layout : null}
                  paragraphMode={paragraphMode}
                  onParagraph={onParagraph}
                  onAnnotationClick={onAnnotationClick}
                  onMarginNoteEdit={onMarginNoteEdit}
                  onMarginNoteGeometry={onMarginNoteGeometry}
                  toolMode={toolMode}
                  inkColor={inkColor}
                  onRegionSnip={onRegionSnip}
                  onInkCommit={onInkCommit}
                  continuousPage
                  scrollRoot={scrollRoot}
                  zoomLevel={zoom}
                  onSourceLink={(target) => void openSourceLink(target)}
                  find={
                    find && find.query.trim().length >= 2
                      ? {
                          query: find.query,
                          caseSensitive: find.caseSensitive,
                          activeOccurrence:
                            find.activePage === pageNumber ? find.activeOccurrence ?? null : null,
                          nonce: find.activePage === pageNumber ? find.nonce : 0,
                        }
                      : null
                  }
                />
              ) : <span className="pdf-page-placeholder">{pageNumber}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PDFPage({
  document,
  documentKey,
  page,
  annotations,
  focusedId,
  onSelect,
  onText,
  layout,
  paragraphMode = false,
  onParagraph,
  onAnnotationClick,
  continuousPage = false,
  scrollRoot,
  zoomLevel,
  find = null,
  onSourceLink,
  onMarginNoteEdit,
  onMarginNoteGeometry,
  toolMode = 'select',
  inkColor = 'rose',
  onRegionSnip,
  onInkCommit,
}: {
  document: PDFDocumentProxy;
  documentKey?: string;
  page: number;
  annotations: Annotation[];
  focusedId: string | null;
  onSelect: (selection: PendingSelection) => void;
  onText: (text: string) => void;
  layout?: PDFLayout | null;
  paragraphMode?: boolean;
  onParagraph?: (paragraph: SelectedParagraph) => void;
  onAnnotationClick?: (annotation: Annotation, position: { top: number; left: number }) => void;
  continuousPage?: boolean;
  scrollRoot?: HTMLElement | null;
  zoomLevel?: number;
  find?: { query: string; caseSensitive: boolean; activeOccurrence: number | null; nonce: number } | null;
  onSourceLink?: (target: PDFLinkTarget) => void;
  onMarginNoteEdit?: (annotation: Annotation) => void;
  onMarginNoteGeometry?: (annotation: Annotation, rect: AnnotationRect) => Promise<void>;
  toolMode?: 'select' | 'snip' | 'ink';
  inkColor?: string;
  onRegionSnip?: (data: { page: number; imageBase64: string }) => void;
  onInkCommit?: (data: { page: number; strokes: AnnotationStroke[] }) => Promise<void> | void;
}) {
  const [loadedParagraphLayout, setLoadedParagraphLayout] = useState<{ document: PDFDocumentProxy; page: number; layout: PDFLayout | null } | null>(null);
  const paragraphLayout = documentKey
    ? loadedParagraphLayout?.document === document && loadedParagraphLayout.page === page ? loadedParagraphLayout.layout : null
    : layout;
  const container = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const previousRender = useRef<Promise<void>>(Promise.resolve());
  const [width, setWidth] = useState(600);
  const [zoom, setZoom] = useState(1);
  const activeZoom = zoomLevel ?? zoom;
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const [renderNonce, setRenderNonce] = useState(0);
  const [sourceLinks, setSourceLinks] = useState<PDFSourceLink[]>([]);
  const [snipBox, setSnipBox] = useState<{ startX: number; startY: number; curX: number; curY: number } | null>(null);
  const [inkDraft, setInkDraft] = useState<AnnotationStroke[]>([]);
  const [activeStroke, setActiveStroke] = useState<AnnotationStroke | null>(null);
  const [savingInk, setSavingInk] = useState(false);

  useEffect(() => {
    if (toolMode !== 'ink') {
      setActiveStroke(null);
    }
    if (toolMode !== 'snip') {
      setSnipBox(null);
    }
  }, [toolMode]);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState('');
  const [hoveredRegion, setHoveredRegion] = useState<{ kind: 'paragraph' | 'visual'; index: number } | null>(null);
  const hoverPointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!paragraphMode || !documentKey) return;
    let cancelled = false;
    void loadPDFParagraphLayout(document, documentKey, page).then((result) => {
      if (!cancelled) setLoadedParagraphLayout({ document, page, layout: result });
    }).catch(() => {
      if (!cancelled) setLoadedParagraphLayout({ document, page, layout: null });
    });
    return () => { cancelled = true; };
  }, [document, documentKey, page, paragraphMode, layout]);
  useEffect(() => {
    if (!paragraphMode || !paper.current) { setHoveredRegion(null); return; }
    let frame = 0;
    const update = () => {
      const pointer = hoverPointer.current;
      const element = paper.current;
      let region: { kind: 'paragraph' | 'visual'; index: number } | null = null;
      if (pointer && element && paragraphLayout) {
        const bounds = element.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0 && pointer.x >= bounds.left && pointer.x <= bounds.right
          && pointer.y >= bounds.top && pointer.y <= bounds.bottom
          && element.contains(window.document.elementFromPoint(pointer.x, pointer.y))) {
          const x = (pointer.x - bounds.left) / bounds.width;
          const y = (pointer.y - bounds.top) / bounds.height;
          const visual = visualAt(paragraphLayout, x, y);
          const paragraph = visual === null ? paragraphAt(paragraphLayout, x, y, 4 * paragraphLayout.width / bounds.width) : null;
          if (visual !== null) region = { kind: 'visual', index: visual };
          else if (paragraph !== null) region = { kind: 'paragraph', index: paragraph };
        }
      }
      setHoveredRegion((previous) => previous?.kind === region?.kind && previous?.index === region?.index ? previous : region);
    };
    const move = (event: MouseEvent) => { hoverPointer.current = { x: event.clientX, y: event.clientY }; update(); };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const clear = () => { hoverPointer.current = null; setHoveredRegion(null); };
    const leave = (event: MouseEvent) => { if (!event.relatedTarget) clear(); };
    window.addEventListener('mousemove', move, { passive: true });
    window.addEventListener('blur', clear);
    window.addEventListener('mouseout', leave);
    const root = scrollRoot ?? container.current;
    root?.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(paper.current);
    update();
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('blur', clear);
      window.removeEventListener('mouseout', leave);
      root?.removeEventListener('scroll', schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [page, paragraphLayout, paragraphMode, renderNonce, scrollRoot]);
  useEffect(() => {
    if (!container.current) return;
    let frame = 0;
    const measure = () => {
      if (!container.current) return;
      const next = fitPDFWidth(container.current.clientWidth, continuousPage ? 0 : 40);
      setWidth((current) => current === next ? current : next);
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    measure();
    observer.observe(container.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [continuousPage]);
  useEffect(() => {
    let cancelled = false;
    let render:
      | ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>
      | undefined;
    let layer: TextLayer | undefined;
    setError('');
    setRendering(true);
    setSourceLinks([]);
    void (async () => {
      try {
        await previousRender.current.catch(() => undefined);
        if (cancelled) return;
        const pdfPage = await document.getPage(page);
        if (
          cancelled ||
          !canvas.current ||
          !paper.current ||
          !textLayer.current
        )
          return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const scale = (width / natural.width) * activeZoom;
        const viewport = pdfPage.getViewport({ scale });
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        const element = canvas.current;
        element.width = Math.floor(viewport.width * ratio);
        element.height = Math.floor(viewport.height * ratio);
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        paper.current.style.width = `${viewport.width}px`;
        paper.current.style.height = `${viewport.height}px`;
        textLayer.current.replaceChildren();
        textLayer.current.style.setProperty('--scale-factor', String(scale));
        const context = element.getContext('2d');
        if (!context) throw new Error('无法创建 PDF 画布');
        render = pdfPage.render({
          canvasContext: context,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        });
        previousRender.current = render.promise.catch(() => undefined);
        const content = await pdfPage.getTextContent();
        if (cancelled) return;
        onTextRef.current(textFromPDF(content));
        layer = new TextLayer({
          textContentSource: content,
          container: textLayer.current,
          viewport,
        });
        const renderDone = Promise.allSettled([render.promise, layer.render()]).then((results) => {
          const failed = results.find((result) => result.status === 'rejected');
          if (failed?.status === 'rejected' && !cancelled) throw failed.reason;
        });
        previousRender.current = renderDone.catch(() => undefined);
        await renderDone;
        const nativeLinks = await pdfPageLinks(pdfPage).catch(() => []);
        if (!cancelled && textLayer.current && paper.current) {
          const citations = textCitationLinks(textLayer.current, paper.current.getBoundingClientRect(), nativeLinks);
          setSourceLinks([...nativeLinks, ...citations]);
          setRenderedPage(page);
          setRenderNonce((value) => value + 1);
          setRendering(false);
        }
      } catch (cause) {
        if (!cancelled) {
          setRendering(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
      render?.cancel();
      layer?.cancel();
    };
  }, [document, page, width, activeZoom]);
  useEffect(() => {
    if (!continuousPage) container.current?.scrollTo(0, 0);
  }, [page, continuousPage]);
  // 查找高亮：文本层每次重绘（缩放/翻页）都会被 replaceChildren 清空，
  // 所以用 renderNonce 而不是 renderedPage 触发重标；同一处命中只在 nonce 变化时滚动。
  const findScrolledNonce = useRef(-1);
  useEffect(() => {
    const layer = textLayer.current;
    if (!layer) return;
    const active = applyFindMarks(
      layer,
      find?.query ?? '',
      find?.caseSensitive ?? false,
      find?.activeOccurrence ?? null,
    );
    if (!active || !find || find.nonce === findScrolledNonce.current) return;
    findScrolledNonce.current = find.nonce;
    // 延后一拍：翻页滚动由父组件的 navigationRequest effect 发起，而子组件 effect 先跑；
    // 直接滚会被父组件的「滚到页首」覆盖掉，命中处就落在视野外了。
    window.setTimeout(() => {
      active.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 0);
  }, [renderNonce, find?.query, find?.caseSensitive, find?.activeOccurrence, find?.nonce]);
  useEffect(() => {
    if (!focusedId) return;
    (scrollRoot ?? container.current)
      ?.querySelector(`[data-annotation-id="${CSS.escape(focusedId)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusedId, page, scrollRoot]);
  const select = () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !paper.current) return;
    const range = selection.getRangeAt(0);
    if (!paper.current.contains(range.commonAncestorContainer)) return;
    const quote = selection.toString().trim();
    if (!quote) return;
    const bounds = paper.current.getBoundingClientRect();
    const rects = pdfSelectionRects(range, bounds);
    const anchor = range.getBoundingClientRect();
    onSelect({
      annotation: {
        page,
        quote,
        kind: 'highlight',
        locator: { kind: 'pdf', rects },
      },
      top: anchor.bottom,
      left: anchor.left,
      pageAspect: bounds.width / bounds.height,
    });
  };
  return (
    <div className={`pdf-reader${continuousPage ? ' pdf-reader-page' : ''}`}>
      {!continuousPage && <div className="reader-format-tools">
        <button onClick={() => setZoom((value) => Math.max(0.5, value - 0.2))}>
          −
        </button>
        <span>{Math.round(activeZoom * 100)}%</span>
        <button onClick={() => setZoom((value) => Math.min(3, value + 0.2))}>
          ＋
        </button>
        <button onClick={() => setZoom(1)}>适合宽度</button>
        {paragraphMode && paragraphLayout && <select aria-label="选择段落" className="paragraph-picker" value="" onChange={(event) => {
          if (!event.target.value) return;
          const index = Number(event.target.value) - 1;
          const block = paragraphLayout.blocks[index];
          if (!block) return;
          const anchor = event.currentTarget.getBoundingClientRect();
          const targetY = block.y / paragraphLayout.height;
          const viewportOffset = paper.current && scrollRoot
            ? paper.current.getBoundingClientRect().top + targetY * paper.current.getBoundingClientRect().height - scrollRoot.getBoundingClientRect().top
            : undefined;
          onParagraph?.({ text: block.text, position: page, index, targetY, viewportOffset, kind: 'pdf', top: anchor.bottom, left: anchor.left });
        }}><option value="">识别 {paragraphLayout.blocks.length} 段 · 点击原文或选择</option>
          {paragraphLayout.blocks.map((block, index) => <option key={index} value={index + 1}>第 {index + 1} 段：{block.text.slice(0, 60)}</option>)}
        </select>}
      </div>}
      <div className="pdf-scroll" ref={container}>
        {error && <p role="alert">PDF 渲染失败：{error}</p>}
        <div
          className="pdf-paper"
          data-page={page}
          data-rendered-page={renderedPage ?? undefined}
          data-rendering={rendering}
          ref={paper}
          onMouseUp={select}
          onMouseLeave={() => setHoveredRegion(null)}
          onClick={(event) => {
            if (event.detail > 1) return;
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed && selection.rangeCount && event.currentTarget.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height;
            const highlighted = annotations.filter((item) => item.page === page && item.kind === 'highlight').findLast((item) =>
              (item.locator?.rects ?? []).some((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height),
            );
            if (highlighted) {
              onAnnotationClick?.(highlighted, { top: event.clientY, left: event.clientX });
              return;
            }
            if (!paragraphMode || !paragraphLayout) return;
            const visualIndex = visualAt(paragraphLayout, x, y);
            if (visualIndex !== null) {
              const visual = paragraphLayout.visuals?.[visualIndex];
              if (visual?.kind === 'formula') {
                const rect = {
                  x: visual.x / paragraphLayout.width,
                  y: visual.y / paragraphLayout.height,
                  width: visual.width / paragraphLayout.width,
                  height: visual.height / paragraphLayout.height,
                };
                onSelect({
                  annotation: {
                    page,
                    quote: visual.text.trim() || '公式',
                    kind: 'highlight',
                    locator: { kind: 'pdf', rects: [rect] },
                  },
                  top: event.clientY,
                  left: event.clientX,
                });
              }
              return;
            }
            const index = paragraphAt(paragraphLayout, x, y, 4 * paragraphLayout.width / bounds.width);
            if (index === null) return;
            const block = paragraphLayout.blocks[index]!;
            const targetY = block.y / paragraphLayout.height;
            const viewportOffset = scrollRoot
              ? bounds.top + targetY * bounds.height - scrollRoot.getBoundingClientRect().top
              : undefined;
            onParagraph?.({ text: block.text, position: page, index, targetY, viewportOffset, kind: 'pdf', top: event.clientY, left: event.clientX });
          }}
          onKeyUp={(event) => {
            if (event.key === 'Shift') select();
          }}
        >
          <canvas ref={canvas} />
          <div className="textLayer" ref={textLayer} />
          <div className="pdf-source-links">
            {sourceLinks.map((link) => {
              const style = { left: `${link.x * 100}%`, top: `${link.y * 100}%`, width: `${link.width * 100}%`, height: `${link.height * 100}%` };
              return link.target ? (
                <button type="button" key={link.id} className="pdf-source-link" style={style} title={link.label} aria-label={link.label}
                  onMouseUp={(event) => event.stopPropagation()}
                  onClick={(event) => { event.stopPropagation(); onSourceLink?.(link.target!); }} />
              ) : (
                <a key={link.id} className="pdf-source-link" style={style} href={link.url} target="_blank" rel="noopener noreferrer" title={link.label} aria-label={link.label}
                  onMouseUp={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} />
              );
            })}
          </div>
          {paragraphMode && paragraphLayout && hoveredRegion !== null && (() => {
            const isVisual = hoveredRegion.kind === 'visual';
            const block = isVisual ? paragraphLayout.visuals?.[hoveredRegion.index] : paragraphLayout.blocks[hoveredRegion.index];
            return block && <div className={`pdf-paragraph-hover${isVisual ? ' pdf-visual-hover' : ''}`} aria-hidden="true" style={{ left: `${block.x / paragraphLayout.width * 100}%`, top: `${block.y / paragraphLayout.height * 100}%`, width: `${block.width / paragraphLayout.width * 100}%`, height: `${block.height / paragraphLayout.height * 100}%` }}>{isVisual && <span>{paragraphLayout.visuals?.[hoveredRegion.index]?.kind === 'table' ? 'OCR 表格' : paragraphLayout.visuals?.[hoveredRegion.index]?.kind === 'formula' ? 'OCR 公式 · 点击添加高亮' : 'OCR 图片'}</span>}</div>;
          })()}
          <div className="pdf-marks">
            {(() => {
              const pageAnnotations = annotations.filter((annotation) => annotation.page === page);
              const highlights = pageAnnotations.filter((item) => item.kind === 'highlight' || (item.kind === 'margin' && item.quote));
              return <>
                {highlights.map((annotation) => {
                  const paths: string[] = [];
                for (const rect of annotation.locator?.rects ?? []) {
                  if (Number.isFinite(rect.x + rect.y + rect.width + rect.height) && rect.width > 0 && rect.height > 0) {
                    paths.push(`M${rect.x} ${rect.y}h${rect.width}v${rect.height}h-${rect.width}Z`);
                  }
                }
                  return paths.length > 0 && (
                  <svg
                    key={`highlight-${annotation.id}`}
                    aria-hidden="true"
                    data-annotation-id={annotation.kind === 'margin' ? undefined : annotation.id}
                    className={`pdf-mark pdf-mark-highlight ann-highlight-${annotation.color}${focusedId === annotation.id ? ' ann-focused' : ''}`}
                    viewBox="0 0 1 1"
                    preserveAspectRatio="none"
                  >
                    <path d={paths.join('')} />
                  </svg>
                  );
                })}
                {pageAnnotations
                  .filter((annotation) => annotation.kind === 'ink' && annotation.locator?.strokes?.length)
                  .map((annotation) => (
                    <svg
                      key={`ink-${annotation.id}`}
                      data-annotation-id={annotation.id}
                      className={`pdf-mark pdf-mark-ink ann-ink-${annotation.color}${focusedId === annotation.id ? ' ann-focused' : ''}`}
                      viewBox="0 0 1 1"
                      preserveAspectRatio="none"
                    >
                      {(annotation.locator?.strokes ?? []).map((stroke, sIdx) => (
                        <polyline
                          key={sIdx}
                          fill="none"
                          strokeWidth={stroke.width ?? 0.003}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          points={stroke.points.map((pt) => `${pt.x},${pt.y}`).join(' ')}
                        />
                      ))}
                    </svg>
                  ))}
                {pageAnnotations
                  .filter((annotation) => annotation.kind !== 'highlight' && annotation.kind !== 'margin' && annotation.kind !== 'ink')
                  .flatMap((a) => mergePDFMarkRects(a.locator?.rects ?? []).map((rect, index) => (
                  <span
                    key={`${a.id}-${index}`}
                    data-annotation-id={a.id}
                    title={a.note || a.quote}
                    className={`pdf-mark ann-${a.kind}-${a.color}${focusedId === a.id ? ' ann-focused' : ''}`}
                    style={{
                      left: `${rect.x * 100}%`,
                      top: `${rect.y * 100}%`,
                      width: `${rect.width * 100}%`,
                      height: `${rect.height * 100}%`,
                    }}
                  />
                  )))}
              </>;
            })()}
          </div>
          {toolMode === 'snip' && onRegionSnip ? (
            <div
              className="pdf-snip-layer"
              onPointerDown={(event) => {
                event.stopPropagation();
                const bounds = paper.current?.getBoundingClientRect();
                if (!bounds) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
                const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
                setSnipBox({ startX: x, startY: y, curX: x, curY: y });
              }}
              onPointerMove={(event) => {
                if (!snipBox) return;
                const bounds = paper.current?.getBoundingClientRect();
                if (!bounds) return;
                const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
                const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
                setSnipBox((cur) => (cur ? { ...cur, curX: x, curY: y } : null));
              }}
              onPointerUp={(event) => {
                event.stopPropagation();
                if (!snipBox) return;
                const x = Math.min(snipBox.startX, snipBox.curX);
                const y = Math.min(snipBox.startY, snipBox.curY);
                const w = Math.abs(snipBox.curX - snipBox.startX);
                const h = Math.abs(snipBox.curY - snipBox.startY);
                setSnipBox(null);
                if (w < 0.015 || h < 0.015 || !canvas.current) return;
                const src = canvas.current;
                const sx = Math.max(0, Math.floor(x * src.width));
                const sy = Math.max(0, Math.floor(y * src.height));
                const sw = Math.max(8, Math.min(src.width - sx, Math.ceil(w * src.width)));
                const sh = Math.max(8, Math.min(src.height - sy, Math.ceil(h * src.height)));
                const crop = window.document.createElement('canvas');
                crop.width = sw;
                crop.height = sh;
                const ctx = crop.getContext('2d');
                if (!ctx) return;
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, sw, sh);
                ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
                onRegionSnip({ page, imageBase64: crop.toDataURL('image/png') });
              }}
            >
              {snipBox ? (
                <div
                  className="pdf-snip-rect"
                  style={{
                    left: `${Math.min(snipBox.startX, snipBox.curX) * 100}%`,
                    top: `${Math.min(snipBox.startY, snipBox.curY) * 100}%`,
                    width: `${Math.abs(snipBox.curX - snipBox.startX) * 100}%`,
                    height: `${Math.abs(snipBox.curY - snipBox.startY) * 100}%`,
                  }}
                />
              ) : null}
            </div>
          ) : null}
          {toolMode === 'ink' && onInkCommit ? (
            <>
              <svg
                className={`pdf-ink-layer ann-ink-${inkColor}`}
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  const bounds = paper.current?.getBoundingClientRect();
                  if (!bounds) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const x = Number(Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)).toFixed(4));
                  const y = Number(Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)).toFixed(4));
                  setActiveStroke({ width: 0.0032, points: [{ x, y }, { x, y }] });
                }}
                onPointerMove={(event) => {
                  if (!activeStroke) return;
                  const bounds = paper.current?.getBoundingClientRect();
                  if (!bounds) return;
                  const x = Number(Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)).toFixed(4));
                  const y = Number(Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)).toFixed(4));
                  setActiveStroke((cur) => {
                    if (!cur) return null;
                    const last = cur.points[cur.points.length - 1];
                    if (last && Math.hypot(x - last.x, y - last.y) < 0.0025) return cur;
                    if (cur.points.length >= 480) return cur;
                    return { ...cur, points: [...cur.points, { x, y }] };
                  });
                }}
                onPointerUp={(event) => {
                  event.stopPropagation();
                  if (!activeStroke) return;
                  const finalized = activeStroke;
                  setActiveStroke(null);
                  if (finalized.points.length >= 2) {
                    setInkDraft((cur) => [...cur.slice(-79), finalized]);
                  }
                }}
              >
                {inkDraft.map((stroke, idx) => (
                  <polyline
                    key={idx}
                    fill="none"
                    strokeWidth={stroke.width ?? 0.0032}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={stroke.points.map((pt) => `${pt.x},${pt.y}`).join(' ')}
                  />
                ))}
                {activeStroke ? (
                  <polyline
                    fill="none"
                    strokeWidth={activeStroke.width ?? 0.0032}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={activeStroke.points.map((pt) => `${pt.x},${pt.y}`).join(' ')}
                  />
                ) : null}
              </svg>
              {inkDraft.length ? (
                <div className="pdf-ink-actions" onMouseUp={(event) => event.stopPropagation()}>
                  <span>第 {page} 页 · {inkDraft.length} 笔</span>
                  <button type="button" disabled={savingInk} onClick={() => setInkDraft((cur) => cur.slice(0, -1))}>
                    撤销
                  </button>
                  <button type="button" disabled={savingInk} onClick={() => setInkDraft([])}>
                    清空
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={savingInk}
                    onClick={() => {
                      setSavingInk(true);
                      void Promise.resolve(onInkCommit({ page, strokes: inkDraft }))
                        .then(() => setInkDraft([]))
                        .finally(() => setSavingInk(false));
                    }}
                  >
                    {savingInk ? '保存中…' : '保存手写'}
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
          {onMarginNoteEdit && onMarginNoteGeometry && annotations.filter((item) => item.page === page && item.kind === 'margin' && item.locator?.kind === 'pdf' && item.locator.rects?.length).map((item) => <MarginNote key={item.id} item={item} focused={focusedId === item.id} fontSize={width * activeZoom * 0.022} pageAspect={paper.current?.clientHeight ? paper.current.clientWidth / paper.current.clientHeight : undefined} onEdit={onMarginNoteEdit} onGeometry={onMarginNoteGeometry} />)}
        </div>
      </div>
    </div>
  );
}
