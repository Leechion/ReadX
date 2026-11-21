import { useEffect, type RefObject } from 'react';
import { listeningMatchChar, type ListeningCue, type ListeningPane } from '../lib/listening';

const highlightName = 'readx-speaking-sentence';
const highlightLayerClass = 'listening-highlight-layer';

export interface ReaderSpeakingPosition {
  pane: ListeningPane;
  page: number;
  cue: ListeningCue;
}

export interface ListeningHighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PixelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  height: number;
}

export function mergeListeningRects(
  clientRects: Iterable<DOMRectReadOnly>,
  bounds: DOMRectReadOnly,
): ListeningHighlightRect[] {
  if (bounds.width <= 0 || bounds.height <= 0) return [];
  const raw: PixelRect[] = [];
  for (const rect of clientRects) {
    if (rect.width < 1 || rect.height < 1) continue;
    const left = Math.max(0, rect.left - bounds.left);
    const top = Math.max(0, rect.top - bounds.top);
    const right = Math.min(bounds.width, rect.right - bounds.left);
    const bottom = Math.min(bounds.height, rect.bottom - bounds.top);
    if (right - left < 1 || bottom - top < 1) continue;
    raw.push({ left, top, right, bottom, height: bottom - top });
  }
  if (raw.length === 0) return [];

  raw.sort((a, b) => a.top - b.top || a.left - b.left);

  // Group fragments that sit on the same visual line, then merge adjacent spans.
  const lines: PixelRect[][] = [];
  for (const rect of raw) {
    const centerY = (rect.top + rect.bottom) / 2;
    let matchedLine: PixelRect[] | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      const anchor = line[0]!;
      const anchorCenterY = (anchor.top + anchor.bottom) / 2;
      const minH = Math.min(rect.height, anchor.height);
      const overlapY = Math.min(rect.bottom, anchor.bottom) - Math.max(rect.top, anchor.top);
      if (Math.abs(centerY - anchorCenterY) <= minH * 0.6 || overlapY >= minH * 0.45) {
        matchedLine = line;
        break;
      }
    }
    if (matchedLine) matchedLine.push(rect);
    else lines.push([rect]);
  }

  const merged: PixelRect[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.left - b.left);
    let current = { ...line[0]! };
    for (let i = 1; i < line.length; i++) {
      const next = line[i]!;
      const minH = Math.min(current.height, next.height);
      const gap = next.left - current.right;
      if (gap <= Math.max(minH * 0.85, 12)) {
        current.left = Math.min(current.left, next.left);
        current.top = Math.min(current.top, next.top);
        current.right = Math.max(current.right, next.right);
        current.bottom = Math.max(current.bottom, next.bottom);
        current.height = current.bottom - current.top;
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
  }

  const padX = 3;
  const padY = 1.5;
  return merged.map((rect) => {
    const left = Math.max(0, rect.left - padX);
    const top = Math.max(0, rect.top - padY);
    const right = Math.min(bounds.width, rect.right + padX);
    const bottom = Math.min(bounds.height, rect.bottom + padY);
    return {
      x: left / bounds.width,
      y: top / bounds.height,
      width: (right - left) / bounds.width,
      height: (bottom - top) / bounds.height,
    };
  });
}

function renderHighlightLayer(
  container: HTMLElement,
  rects: ListeningHighlightRect[],
  isProse: boolean,
): HTMLElement | null {
  if (rects.length === 0) return null;
  const layer = document.createElement('div');
  layer.className = isProse
    ? `${highlightLayerClass} ${highlightLayerClass}--prose`
    : highlightLayerClass;
  layer.setAttribute('aria-hidden', 'true');

  const first = rects[0]!;
  const pin = document.createElement('span');
  pin.className = 'listening-highlight-pin';
  pin.style.left = `${first.x * 100}%`;
  pin.style.top = `${first.y * 100}%`;
  pin.style.height = `${first.height * 100}%`;
  layer.appendChild(pin);

  rects.forEach((rect, index) => {
    const line = document.createElement('span');
    line.className = 'listening-highlight-line';
    line.style.left = `${rect.x * 100}%`;
    line.style.top = `${rect.y * 100}%`;
    line.style.width = `${rect.width * 100}%`;
    line.style.height = `${rect.height * 100}%`;
    line.style.setProperty('--listening-line-index', String(Math.min(index, 8)));
    layer.appendChild(line);
  });

  container.appendChild(layer);
  return layer;
}

function isInternalHighlightNode(node: Node): boolean {
  return node instanceof HTMLElement && node.classList.contains(highlightLayerClass);
}

function isInternalMutation(mutations: MutationRecord[]): boolean {
  return mutations.every((mutation) => {
    if (mutation.type === 'childList') {
      const targetIsLayer = mutation.target instanceof HTMLElement && mutation.target.closest(`.${highlightLayerClass}`);
      if (targetIsLayer) return true;
      const addedOnlyLayer = Array.from(mutation.addedNodes).every(isInternalHighlightNode);
      const removedOnlyLayer = Array.from(mutation.removedNodes).every(isInternalHighlightNode);
      return addedOnlyLayer && removedOnlyLayer;
    }
    return false;
  });
}

function readingRange(element: Element, cue: ListeningCue, page: HTMLElement | null): Range | null {
  const needle = Array.from(cue.text, listeningMatchChar).join('');
  if (!needle) return null;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const offsets: { node: Text; start: number; end: number }[] = [];
  let text = '';
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    let start = 0;
    for (const char of node.data) {
      const normalized = listeningMatchChar(char);
      const end = start + char.length;
      text += normalized;
      for (let i = 0; i < normalized.length; i++) offsets.push({ node, start, end });
      start = end;
    }
  }
  const bounds = cue.box && page?.getBoundingClientRect();
  let occurrence = 0;
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) {
    if (index < (cue.startOffset ?? 0)) continue;
    const first = offsets[index]!;
    const last = offsets[index + needle.length - 1]!;
    const range = document.createRange();
    range.setStart(first.node, first.start);
    range.setEnd(last.node, last.end);
    if (bounds && cue.box) {
      const rect = range.getClientRects()[0];
      if (!rect || !bounds.width || !bounds.height) continue;
      const x = (rect.left + rect.width / 2 - bounds.left) / bounds.width;
      const y = (rect.top + rect.height / 2 - bounds.top) / bounds.height;
      const { x: left, y: top, width, height } = cue.box;
      if (x < left - 0.025 || x > left + width + 0.025 || y < top - 0.025 || y > top + height + 0.025) continue;
    }
    if (occurrence++ === cue.occurrence) return range;
  }
  return null;
}

function revealSpeakingLine(element: Element, rect: DOMRect | DOMRectReadOnly) {
  const scroll = element.closest<HTMLElement>('.pdf-document-scroll, .epub-scroll, .translation-document');
  if (!scroll || !rect.height) return;
  const viewport = scroll.getBoundingClientRect();
  const margin = 24;
  const topOverflow = rect.top - viewport.top - margin;
  const bottomOverflow = Math.min(rect.bottom, rect.top + viewport.height / 2) - viewport.bottom + margin;
  const delta = topOverflow < 0 ? topOverflow : Math.max(0, bottomOverflow);
  if (delta) {
    scroll.scrollBy({ top: delta, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
}

export function useListeningHighlight(root: RefObject<HTMLDivElement | null>, speaking: ReaderSpeakingPosition | null) {
  useEffect(() => {
    const host = root.current;
    if (!host || !speaking) return;
    const { pane, page, cue } = speaking;
    let frame = 0;
    let fallback: HTMLElement | null = null;
    let activeLayer: HTMLElement | null = null;
    let activeBlock: Element | null = null;
    let revealed = false;
    const clear = () => {
      CSS.highlights?.delete(highlightName);
      activeLayer?.remove();
      activeLayer = null;
      activeBlock?.removeAttribute('data-listening-block-focused');
      activeBlock = null;
      fallback?.removeAttribute('data-listening-block-active');
      fallback = null;
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        clear();
        const scope = host.querySelector<HTMLElement>(`[data-listening-pane="${pane}"]`);
        if (!scope) return;
        const singlePage = scope.dataset.listeningSinglePage;
        if (singlePage && singlePage !== String(page)) return;
        const renderedPage = singlePage ? 1 : page;
        const pdf = scope.querySelector<HTMLElement>(`.pdf-paper[data-rendered-page="${renderedPage}"][data-rendering="false"]`);
        const chapter = scope.querySelector<HTMLElement>(`.epub-chapter[data-listening-page="${page}"]`);
        const preview = scope.querySelector<HTMLElement>(`.live-translation-preview[data-listening-page="${page}"]`);
        const prose = chapter ?? preview;
        const block = cue.block === undefined ? prose : prose?.querySelector(`[data-listening-block="${cue.block}"], [data-block="${cue.block}"]`);
        const target = pdf?.querySelector('.textLayer') ?? block;
        const range = target && readingRange(target, cue, pdf);
        if (target && range && CSS.highlights && typeof Highlight === 'function') {
          CSS.highlights.set(highlightName, new Highlight(range));
          const container = pdf ?? prose;
          if (container) {
            const rects = mergeListeningRects(range.getClientRects(), container.getBoundingClientRect());
            activeLayer = renderHighlightLayer(container, rects, !pdf);
            if (!pdf && block && block !== prose) {
              activeBlock = block;
              block.setAttribute('data-listening-block-focused', '');
            }
          }
          if (!revealed) {
            revealed = true;
            revealSpeakingLine(target, range.getBoundingClientRect());
          }
        } else if (pdf && cue.box) {
          // Scanned pages have only paragraph coordinates. Mark the verified block.
          const { x, y, width, height } = cue.box;
          fallback = pdf;
          pdf.style.setProperty('--listening-block-x', `${x * 100}%`);
          pdf.style.setProperty('--listening-block-y', `${y * 100}%`);
          pdf.style.setProperty('--listening-block-width', `${width * 100}%`);
          pdf.style.setProperty('--listening-block-height', `${height * 100}%`);
          pdf.setAttribute('data-listening-block-active', '');
          if (!revealed) {
            revealed = true;
            const rect = pdf.getBoundingClientRect();
            revealSpeakingLine(pdf, new DOMRect(rect.left + x * rect.width, rect.top + y * rect.height, width * rect.width, height * rect.height));
          }
        }
      });
    };
    const observer = new MutationObserver((mutations) => {
      if (isInternalMutation(mutations)) return;
      update();
    });
    observer.observe(host, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['data-rendered-page', 'data-rendering', 'data-listening-page', 'data-listening-single-page'],
    });
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    resizeObserver?.observe(host);
    update();
    return () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      cancelAnimationFrame(frame);
      clear();
    };
  }, [root, speaking]);
}
