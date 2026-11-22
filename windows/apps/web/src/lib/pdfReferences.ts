import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import { normalizeFindTextWithOffsets } from './findMatches';

export interface PDFLocation {
  page: number;
  x?: number;
  y?: number;
}

export type PDFLinkTarget =
  | { kind: 'destination'; destination: string | unknown[] }
  | { kind: 'citation'; number: number };

export interface PDFSourceLink {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  target?: PDFLinkTarget;
  url?: string;
}

export async function resolvePDFDestination(document: PDFDocumentProxy, destination: string | unknown[], rotation = 0): Promise<PDFLocation> {
  const dest = typeof destination === 'string' ? await document.getDestination(destination) : destination;
  if (!dest) throw new Error('PDF 中没有这个引用目标');
  const ref: unknown = dest[0];
  let index: number;
  if (typeof ref === 'number' && Number.isInteger(ref)) index = ref;
  else if (ref && typeof ref === 'object' && 'num' in ref && 'gen' in ref && typeof ref.num === 'number' && typeof ref.gen === 'number')
    index = await document.getPageIndex({ num: ref.num, gen: ref.gen });
  else throw new Error('PDF 引用目标的页码无效');
  if (index < 0 || index >= document.numPages) throw new Error('PDF 引用目标超出文档页数');
  const page = await document.getPage(index + 1);
  const viewport = page.getViewport({ scale: 1, rotation });
  const mode = dest[1]?.name;
  const left = mode === 'XYZ' || mode === 'FitR' || mode === 'FitV' || mode === 'FitBV' ? dest[2] : null;
  const top = mode === 'XYZ' ? dest[3] : mode === 'FitR' ? dest[5] : mode === 'FitH' || mode === 'FitBH' ? dest[2] : null;
  if (typeof top !== 'number' && typeof left !== 'number') return { page: index + 1 };
  const [x, y] = viewport.convertToViewportPoint(typeof left === 'number' ? left : page.view[0]!, typeof top === 'number' ? top : page.view[3]!);
  return { page: index + 1, x: Math.max(0, Math.min(1, x / viewport.width)), y: Math.max(0, Math.min(1, y / viewport.height)) };
}

export async function pdfPageLinks(page: PDFPageProxy, rotation = 0): Promise<PDFSourceLink[]> {
  const viewport = page.getViewport({ scale: 1, rotation });
  const annotations = await page.getAnnotations({ intent: 'display' });
  return annotations.flatMap((annotation, index) => {
    if (annotation.subtype !== 'Link' || !Array.isArray(annotation.rect) || annotation.rect.length !== 4) return [];
    const destination = annotation.dest;
    const target: PDFLinkTarget | undefined = typeof destination === 'string' || Array.isArray(destination)
      ? { kind: 'destination', destination } : undefined;
    const url = typeof annotation.url === 'string' && /^(https?:|mailto:)/i.test(annotation.url) ? annotation.url : undefined;
    if (!target && !url) return [];
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
    const width = Math.abs(x2 - x1) / viewport.width, height = Math.abs(y2 - y1) / viewport.height;
    if (!Number.isFinite(width + height + x1 + y1) || width <= 0 || height <= 0) return [];
    return [{ id: `native-${index}`, x: Math.min(x1, x2) / viewport.width, y: Math.min(y1, y2) / viewport.height, width, height, label: target ? '跳转到参考文献或文内目标' : `打开链接：${url}`, target, url }];
  });
}

// PDFs without link annotations still expose their bracketed citations as text.
// Geometry comes from the rendered text layer, so it follows rotation and zoom.
export function textCitationLinks(layer: HTMLElement, bounds: DOMRect, native: PDFSourceLink[]): PDFSourceLink[] {
  const nodes: Text[] = [];
  const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const offsets: number[] = [];
  let joined = '';
  let previousSpan: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const span = node.parentElement?.closest('span') ?? null;
    if (!node.nodeValue || !(span?.textContent ?? node.nodeValue).trim()) continue;
    // Find highlights can split one pdf.js span into several text nodes.
    // Their characters remain adjacent; only distinct PDF spans add a space.
    if (joined && span !== previousSpan) joined += ' ';
    offsets.push(joined.length);
    nodes.push(node as Text);
    joined += node.nodeValue;
    previousSpan = span;
  }
  const normalized = normalizeFindTextWithOffsets(joined);
  const links: PDFSourceLink[] = [];
  for (const match of normalized.text.matchAll(/\[\s*(\d{1,4})(?:\s*[,;–—-]\s*\d{1,4})*\s*\]/g)) {
    for (const citation of match[0].matchAll(/\d{1,4}/g)) {
      const numberStart = match.index + citation.index;
      const start = normalized.starts[numberStart]!, end = normalized.ends[numberStart + citation[0].length - 1]!;
      const first = nodes.findIndex((node, i) => start >= offsets[i]! && start < offsets[i]! + node.length);
      const last = nodes.findIndex((node, i) => end > offsets[i]! && end <= offsets[i]! + node.length);
      if (first < 0 || last < 0) continue;
      const range = layer.ownerDocument.createRange();
      range.setStart(nodes[first]!, start - offsets[first]!);
      range.setEnd(nodes[last]!, end - offsets[last]!);
      for (const [index, rect] of Array.from(range.getClientRects()).entries()) {
        if (rect.width <= 0 || rect.height <= 0 || bounds.width <= 0 || bounds.height <= 0) continue;
        const x = (rect.left - bounds.left) / bounds.width, y = (rect.top - bounds.top) / bounds.height;
        const width = rect.width / bounds.width, height = rect.height / bounds.height;
        if (native.some((link) => x + width / 2 >= link.x && x + width / 2 <= link.x + link.width && y + height / 2 >= link.y && y + height / 2 <= link.y + link.height)) continue;
        links.push({ id: `citation-${numberStart}-${index}`, x, y, width, height, label: `跳转到参考文献 [${citation[0]}]`, target: { kind: 'citation', number: Number(citation[0]) } });
      }
    }
  }
  return links;
}

interface PDFTextLine {
  text: string;
  x: number;
  y: number;
}

function pdfTextLines(page: PDFPageProxy, content: TextContent): PDFTextLine[] {
  const viewport = page.getViewport({ scale: 1 });
  const lines: PDFTextLine[] = [];
  let text = '', x = 0, y = 0, baseline = 0;
  const flush = () => { if (text.trim()) lines.push({ text: text.trim(), x, y }); text = ''; };
  for (const item of content.items) {
    if (!('str' in item)) continue;
    if (text && Math.abs(item.transform[5]! - baseline) > Math.max(3, item.height * 0.6)) flush();
    if (!text) {
      const point = viewport.convertToViewportPoint(item.transform[4]!, item.transform[5]! + item.height);
      x = Math.max(0, Math.min(1, point[0] / viewport.width));
      y = Math.max(0, Math.min(1, (point[1] - 8) / viewport.height));
      baseline = item.transform[5]!;
    }
    text += item.str + ' ';
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

const referenceIndexes = new WeakMap<PDFDocumentProxy, Promise<Map<number, PDFLocation>>>();

export function pdfReferenceTargets(document: PDFDocumentProxy): Promise<Map<number, PDFLocation>> {
  const cached = referenceIndexes.get(document);
  if (cached) return cached;
  const pending = (async () => {
    const targets = new Map<number, PDFLocation>();
    let inReferences = false;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      for (const line of pdfTextLines(page, await page.getTextContent())) {
        if (/^(?:\d+(?:\.\d+)*[.\s]+)?(?:references|bibliography|literature cited|参考文献)\s*[:：]?$/i.test(line.text)) { inReferences = true; continue; }
        if (!inReferences) continue;
        if (/^(?:(?:appendix|supplementary)\b|附录)/i.test(line.text)) { inReferences = false; continue; }
        const match = /^\s*(?:\[\s*(\d{1,4})\s*\]|(\d{1,4})[.)])(?:\s|$)/.exec(line.text);
        if (!match) continue;
        const citation = Number(match[1] ?? match[2]);
        if (!targets.has(citation)) targets.set(citation, { page: number, x: line.x, y: line.y });
      }
    }
    return targets;
  })();
  referenceIndexes.set(document, pending);
  void pending.catch(() => referenceIndexes.delete(document));
  return pending;
}
