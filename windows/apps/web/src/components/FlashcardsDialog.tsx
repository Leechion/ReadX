import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Flashcard } from '../api/client';
import { AppDialog } from './AppDialog';

const SOURCE_LABELS: Record<Flashcard['source'], string> = {
  glossary: '术语表',
  reading: '精读要点',
  annotation: '高亮与批注',
};

const QUALITY_OPTIONS: { quality: 0 | 1 | 2 | 3; label: string; hint: string; tone: string }[] = [
  { quality: 0, label: '重来', hint: '1 天后', tone: 'bad' },
  { quality: 1, label: '困难', hint: '较短间隔', tone: 'warn' },
  { quality: 2, label: '掌握', hint: '按 SM-2 推进', tone: 'accent' },
  { quality: 3, label: '轻松', hint: '加倍延后', tone: 'good' },
];

export function FlashcardsDialog({
  open,
  documentKey,
  documentTitle,
  onClose,
  onOpenAtPage,
}: {
  open: boolean;
  documentKey?: string;
  documentTitle?: string;
  onClose: () => void;
  onOpenAtPage?: (key: string, page: number, query: string) => void;
}) {
  const [scope, setScope] = useState<'due' | 'all'>('due');
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [total, setTotal] = useState(0);
  const [dueCount, setDueCount] = useState(0);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.flashcards(scope, documentKey);
      setCards(res.cards);
      setTotal(res.total);
      setDueCount(res.dueCount);
      setIndex(0);
      setFlipped(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [documentKey, open, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = useMemo(() => cards[index] ?? null, [cards, index]);

  const rate = async (quality: 0 | 1 | 2 | 3) => {
    if (!current || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.reviewFlashcard(current.id, quality);
      setFlipped(false);
      if (scope === 'due') {
        const remaining = cards.filter((c) => c.id !== current.id);
        setCards(remaining);
        setDueCount((d) => Math.max(0, d - 1));
        setIndex((i) => Math.min(i, Math.max(0, remaining.length - 1)));
      } else {
        setCards((list) =>
          list.map((c) => (c.id === current.id ? { ...c, due: false, schedule: result.schedule } : c)),
        );
        setIndex((i) => (i + 1 < cards.length ? i + 1 : 0));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const exportFile = async (format: 'anki' | 'markdown') => {
    setBusy(true);
    setError('');
    try {
      await api.exportFlashcards(format, documentKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      busy={busy}
      closeOnBackdrop
      className="flashcards-dialog"
      aria-labelledby="flashcards-dialog-title"
    >
      <div className="flashcards-body">
        <header className="flashcards-head">
          <div>
            <h2 id="flashcards-dialog-title">
              记忆闪卡（SM-2 间隔重复）{documentTitle ? ` · ${documentTitle.slice(0, 24)}` : ''}
            </h2>
            <p>
              共 {total} 张卡片 · 今日待复习 <strong>{dueCount}</strong> 张（来自术语表、精读要点与批注）
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="flashcards-toolbar">
          <div className="view-switch" role="group" aria-label="复习队列筛选">
            <button
              type="button"
              className={scope === 'due' ? 'active' : ''}
              onClick={() => setScope('due')}
              disabled={busy}
            >
              待复习 ({dueCount})
            </button>
            <button
              type="button"
              className={scope === 'all' ? 'active' : ''}
              onClick={() => setScope('all')}
              disabled={busy}
            >
              全部 ({total})
            </button>
          </div>
          <div className="flashcards-export-actions">
            <button type="button" disabled={busy || !total} onClick={() => void exportFile('anki')}>
              导出 Anki (.tsv)
            </button>
            <button type="button" disabled={busy || !total} onClick={() => void exportFile('markdown')}>
              导出 Markdown
            </button>
          </div>
        </div>

        {error ? (
          <p className="latex-alert error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flashcards-stage">
          {loading ? (
            <p className="flashcards-empty">正在整理复习卡片…</p>
          ) : !current ? (
            <div className="flashcards-empty">
              <p>
                {total === 0
                  ? '还没有可用卡片：在术语表添加译名、给论文做高亮批注或生成精读要点后即可开始复习。'
                  : '今日待复习卡片已全部完成！可以切换到「全部」继续自由浏览。'}
              </p>
            </div>
          ) : (
            <div className="flashcard-card">
              <div className="flashcard-meta">
                <span className="flashcard-badge">{SOURCE_LABELS[current.source]}</span>
                {current.documentTitle ? <span className="flashcard-doc">{current.documentTitle}</span> : null}
                {current.page && current.documentKey && onOpenAtPage ? (
                  <button
                    type="button"
                    className="flashcard-page-link"
                    onClick={() => {
                      onClose();
                      onOpenAtPage(current.documentKey!, current.page!, '');
                    }}
                  >
                    第 {current.page} 页 ↗
                  </button>
                ) : null}
                <span className="flashcard-progress">
                  {index + 1} / {cards.length}
                </span>
              </div>

              <div className="flashcard-face">
                <h3>{current.front}</h3>
                {flipped ? (
                  <div className="flashcard-back">{current.back}</div>
                ) : (
                  <button
                    type="button"
                    className="flashcard-reveal"
                    onClick={() => setFlipped(true)}
                  >
                    点击显示答案 / 笔记
                  </button>
                )}
              </div>

              {current.schedule ? (
                <p className="flashcard-sched">
                  已复习 {current.schedule.repetitions} 次 · 当前间隔 {current.schedule.intervalDays} 天 · 难度系数{' '}
                  {current.schedule.easeFactor}
                </p>
              ) : null}
            </div>
          )}
        </div>

        {current ? (
          <footer className="flashcards-footer">
            {flipped ? (
              <div className="flashcards-ratings">
                {QUALITY_OPTIONS.map((opt) => (
                  <button
                    key={opt.quality}
                    type="button"
                    className={`flashcard-rate ${opt.tone}`}
                    disabled={busy}
                    onClick={() => void rate(opt.quality)}
                  >
                    <strong>{opt.label}</strong>
                    <small>{opt.hint}</small>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flashcards-nav">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => {
                    setIndex((i) => Math.max(0, i - 1));
                    setFlipped(false);
                  }}
                >
                  ← 上一张
                </button>
                <button type="button" className="primary" onClick={() => setFlipped(true)}>
                  显示答案
                </button>
                <button
                  type="button"
                  disabled={index + 1 >= cards.length}
                  onClick={() => {
                    setIndex((i) => Math.min(cards.length - 1, i + 1));
                    setFlipped(false);
                  }}
                >
                  下一张 →
                </button>
              </div>
            )}
          </footer>
        ) : null}
      </div>
    </AppDialog>
  );
}
