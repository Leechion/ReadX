import { useEffect, useRef, useState } from 'react';
import { api, type Annotation, type EPUBSection } from '../api/client';
import type { PendingSelection } from './PDFView';
import type { SelectedParagraph } from './ParagraphActions';

function BookImage({
  documentKey,
  path,
}: {
  documentKey: string;
  path: string;
}) {
  const [url, setURL] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let objectURL = '';
    void api
      .resource(documentKey, path, controller.signal)
      .then((blob) => {
        if (!controller.signal.aborted) {
          objectURL = URL.createObjectURL(blob);
          setURL(objectURL);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(String(cause));
      });
    return () => {
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [documentKey, path]);
  return url ? (
    <img className="epub-image" src={url} alt="文档内图片" />
  ) : (
    <p className="text-ink-faint">
      {error ? '此图片格式无法显示' : '加载图片…'}
    </p>
  );
}

export function EPUBView({
  documentKey,
  section,
  annotations,
  focusedId,
  onSelect,
  paragraphMode = false,
  onParagraph,
}: {
  documentKey: string;
  section: EPUBSection;
  annotations: Annotation[];
  focusedId: string | null;
  onSelect: (selection: PendingSelection) => void;
  paragraphMode?: boolean;
  onParagraph?: (paragraph: SelectedParagraph) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [fontSize, setFontSize] = useState(18);
  const [serif, setSerif] = useState(true);
  useEffect(() => {
    root.current?.scrollTo(0, 0);
  }, [section.href]);
  useEffect(() => {
    if (focusedId)
      root.current
        ?.querySelector(`[data-annotation-id="${CSS.escape(focusedId)}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusedId, section.href]);
  const select = () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !root.current) return;
    const range = selection.getRangeAt(0);
    if (!root.current.contains(range.commonAncestorContainer)) return;
    const elementFor = (node: Node) =>
      (node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement
      )?.closest<HTMLElement>('[data-block]');
    const start = elementFor(range.startContainer);
    const end = elementFor(range.endContainer);
    const quote = selection.toString().trim();
    if (!start || !end || !quote) return;
    const offset = (element: HTMLElement, node: Node, index: number) => {
      const before = document.createRange();
      before.selectNodeContents(element);
      before.setEnd(node, index);
      return before.toString().length;
    };
    const anchor = range.getBoundingClientRect();
    onSelect({
      annotation: {
        page: null,
        kind: 'highlight',
        quote,
        locator: {
          kind: 'epub',
          href: section.href,
          blockStart: Number(start.dataset.block),
          blockEnd: Number(end.dataset.block),
          startOffset: offset(start, range.startContainer, range.startOffset),
          endOffset: offset(end, range.endContainer, range.endOffset),
        },
      },
      top: anchor.bottom,
      left: anchor.left,
    });
  };
  return (
    <div className="epub-reader">
      <div className="reader-format-tools">
        <button onClick={() => setFontSize((value) => Math.max(12, value - 2))}>
          A−
        </button>
        <span>{fontSize}</span>
        <button onClick={() => setFontSize((value) => Math.min(32, value + 2))}>
          A＋
        </button>
        <button onClick={() => setSerif((value) => !value)}>
          {serif ? '衬线字体' : '无衬线字体'}
        </button>
      </div>
      <div
        ref={root}
        className="epub-scroll"
        style={{
          fontSize,
          fontFamily: serif ? 'Georgia, "Noto Serif SC", serif' : 'inherit',
        }}
        onMouseUp={select}
        onKeyUp={(event) => {
          if (event.key === 'Shift') select();
        }}
      >
        <article className={`epub-chapter${paragraphMode ? ' paragraph-mode' : ''}`} data-listening-page={section.index} onClick={(event) => {
          if (!paragraphMode || event.detail > 1) return;
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed && selection.rangeCount && event.currentTarget.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
          const blockElement = (event.target as Element).closest<HTMLElement>('[data-block]');
          if (!blockElement) return;
          const index = Number(blockElement.dataset.block);
          const text = section.blocks[index]?.text?.trim();
          if (text) onParagraph?.({ text, position: section.index, index, kind: 'epub', top: event.clientY, left: event.clientX });
        }}>
          {section.blocks.map((block, index) => {
            if (block.kind === 'image' && block.src)
              return (
                <BookImage
                  key={index}
                  documentKey={documentKey}
                  path={block.src}
                />
              );
            const text = block.text ?? '';
            const ranges = annotations.filter(
              (a) =>
                a.locator?.kind === 'epub' &&
                a.locator.href === section.href &&
                index >= (a.locator.blockStart ?? 0) &&
                index <= (a.locator.blockEnd ?? 0),
            );
            const breaks = new Set([0, text.length]);
            const intervals = ranges.map((a) => {
              const loc = a.locator!;
              const start =
                index === loc.blockStart ? (loc.startOffset ?? 0) : 0;
              const end =
                index === loc.blockEnd
                  ? (loc.endOffset ?? text.length)
                  : text.length;
              breaks.add(start);
              breaks.add(end);
              return { a, start, end };
            });
            const points = [...breaks]
              .filter((value) => value >= 0 && value <= text.length)
              .sort((a, b) => a - b);
            const content = points.slice(0, -1).map((start, n) => {
              const end = points[n + 1]!;
              const marks = intervals.filter(
                (item) => item.start <= start && item.end >= end,
              );
              const marked =
                marks.find((item) => item.a.id === focusedId) ?? marks[0];
              return marked ? (
                <mark
                  key={start}
                  data-annotation-id={marked.a.id}
                  title={marked.a.note}
                  className={`ann-${marked.a.kind}-${marked.a.color}${focusedId === marked.a.id ? ' ann-focused' : ''}`}
                >
                  {text.slice(start, end)}
                </mark>
              ) : (
                <span key={start}>{text.slice(start, end)}</span>
              );
            });
            if (/^h[1-6]$/.test(block.kind))
              return (
                <h2 data-block={index} key={index}>
                  {content}
                </h2>
              );
            return (
              <p
                data-block={index}
                className={`epub-${block.kind}`}
                key={index}
              >
                {content}
              </p>
            );
          })}
        </article>
      </div>
    </div>
  );
}
