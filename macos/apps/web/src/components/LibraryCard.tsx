import type { DocumentSummary } from '@cbct/shared';
import { formatBadgeLabel, isSectionFormat, statusLabel } from '@cbct/shared';
import type { Category, DocumentMeta } from '../api/client';
import { categoryDot } from '../categories';
import { LibraryTrashButton } from './LibraryTrashButton';
import { PaperLineArt } from './PaperLineArt';

/** 封面四色循环：复刻参考实现的 cover-0..3 配色与几何装饰。 */
function coverIndex(key: string): number {
  let sum = 0;
  for (let i = 0; i < key.length; i++) sum = (sum + key.charCodeAt(i)) % 4;
  return sum;
}

/**
 * 书库封面卡：参考实现的书卡布局（大封面 + 标题行 + 状态行 + 进度条）。
 * 文献封面根据题名、标签和已有首页正文选择线稿。
 */
export function LibraryCard({
  doc,
  meta,
  categories,
  selected,
  onSelect,
  onOpenProcessing,
  onRetranslate,
  onOpenReproduction,
  onToggleTrash,
  onSetShelves,
}: {
  doc: DocumentSummary;
  meta: DocumentMeta | undefined;
  categories: Category[];
  selected: boolean;
  onSelect: () => void;
  onOpenProcessing: () => void;
  onRetranslate: () => void;
  onOpenReproduction: (key: string) => void;
  onToggleTrash: () => Promise<unknown>;
  onSetShelves: (categories: string[]) => Promise<unknown>;
}) {
  const cover = coverIndex(doc.key);
  const displayTitle = doc.title || doc.translatedTitle || '（无标题）';
  const assigned = meta?.categories ?? [];
  return (
    <article
      className="book-card"
      data-selected={selected ? 'true' : undefined}
    >
      <div className="book-cover-container">
      <button
        type="button"
        onClick={onSelect}
        className={`book-cover cover-${cover}`}
        title={doc.title || doc.key}
      >
        <PaperLineArt doc={doc} meta={meta} />
        <span className="cover-top">
          <span>{formatBadgeLabel(doc.format)}</span>
          <span>{doc.year ?? ''}</span>
        </span>
        <span className="cover-text">
          <span className="cover-title">{displayTitle}</span>
          <span className="cover-author">
            {doc.authors[0] ?? '作者未知'}
            {doc.authors.length > 1 ? ' 等' : ''}
          </span>
        </span>
        <span className="cover-bottom">
        </span>
      </button>
      <LibraryTrashButton title={doc.title || doc.key} deleted={Boolean(meta?.deleted)} onToggle={onToggleTrash} className="book-trash-button" />
      </div>

      <div className="book-meta">
        <span className="book-title" title={displayTitle}>{displayTitle}</span>
        <span className="flex items-center gap-1">
          {meta?.favorite ? <span className="text-accent">★</span> : null}
          <button
            type="button"
            onClick={() => onOpenReproduction(doc.key)}
            className="rounded-md px-1 text-[10px] text-ink-faint transition hover:text-accent"
            title="复现准备"
          >
            复现
          </button>
        </span>
      </div>

      <div className="book-status">
        <span className="book-status-badge" data-status={doc.status}>{statusLabel(doc.status)}</span>
        <span title={doc.venue}>{doc.venue || ''}</span>
      </div>

      {categories.length ? (
        <details className="relative mt-1.5">
          {/* 已归入书架的论文：标签本身就是可点按的入口，不再重复显示「＋ 归入书架」。
              未归入的才需要这个提示。 */}
          <summary
            className={`w-fit cursor-pointer list-none ${assigned.length ? 'flex flex-wrap gap-1' : 'rounded-md border border-line px-2 py-1 text-[10px] text-ink-faint hover:text-accent'}`}
            title={assigned.length ? '点按调整所属书架' : '归入书架'}
          >
            {assigned.length ? (
              assigned.map((name) => {
                const definition = categories.find((item) => item.name === name);
                return (
                  <span
                    key={name}
                    className="flex items-center gap-1 rounded-pill border border-line bg-surface-sunk px-1.5 py-0.5 text-[10px] text-ink-soft hover:text-accent"
                  >
                    <span
                      className="ann-color-dot"
                      style={{
                        background: categoryDot(definition?.color ?? 'slate'),
                      }}
                    />
                    {name}
                  </span>
                );
              })
            ) : (
              '＋ 归入书架'
            )}
          </summary>
          <div className="absolute left-0 top-full z-20 mt-1 min-w-40 rounded-lg border border-line bg-surface p-2 shadow-lg">
            {categories.map((shelf) => (
              <label key={shelf.name} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11px] text-ink hover:bg-surface-sunk">
                <input
                  type="checkbox"
                  checked={assigned.includes(shelf.name)}
                  onChange={(event) => {
                    const next = event.target.checked ? [...assigned, shelf.name] : assigned.filter((name) => name !== shelf.name);
                    void onSetShelves(next);
                  }}
                />
                <span className="ann-color-dot" style={{ background: categoryDot(shelf.color) }} />
                {shelf.name}
              </label>
            ))}
          </div>
        </details>
      ) : null}

      {!isSectionFormat(doc.format) && doc.hasPdf ? (
        <div className="book-card-footer">
          {doc.paperMemoryStatus && doc.paperMemoryStatus !== 'done' ? (
            <button type="button" className="book-process-button" onClick={onOpenProcessing} title={doc.paperMemoryMessage || '查看论文记忆处理进度'}>
              <span aria-hidden="true">◷</span> 处理
            </button>
          ) : null}
          <button type="button" className="book-retranslate-button" onClick={onRetranslate}>
            <span aria-hidden="true">↻</span> 重新翻译
          </button>
        </div>
      ) : null}

    </article>
  );
}
