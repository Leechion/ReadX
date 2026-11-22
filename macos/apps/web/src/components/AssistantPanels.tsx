/**
 * 阅读页右侧助读面板（对话 / 精读 / 批注）。
 * 从旧三栏工作区的 SideColumn 原样迁移——交互与文案保持一致，
 * 只是把「对照」面板换成了阅读页工具栏上的双栏模式切换。
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { useAnnotations } from '../hooks/useAnnotations';
import type { DocumentSummary } from '@cbct/shared';
import type { ParagraphQuestion } from './ParagraphActions';
import type { PDFDocumentProxy } from 'pdfjs-dist';

import { useAIPreferences } from '../hooks/useAIPreferences';
import { ChatWorkspace } from './ChatWorkspace';
import { PrecisionReading } from './PrecisionReading';

export type AssistantTab = 'chat' | 'reading' | 'notes';

const ASSISTANT_TABS: { id: AssistantTab; label: string }[] = [
  { id: 'chat', label: '对话' },
  { id: 'reading', label: '精读' },
  { id: 'notes', label: '批注' },
];

/** 助读面板：tab 条 + 面板本体。AI 状态由这里自取（与旧 SideColumn 相同）。 */
export function AssistantSidebar({
  apiKey,
  onCite,
  annotations,
  onFocusAnnotation,
  tab,
  onTabChange,
  format = 'pdf',
  paragraphQuestion,
  document,
  pdfDocument,
}: {
  apiKey: string | null;
  onCite: (page: number) => void;
  annotations: ReturnType<typeof useAnnotations>;
  onFocusAnnotation: (id: string, page: number | null) => void;
  tab: AssistantTab;
  onTabChange: (tab: AssistantTab) => void;
  format?: 'pdf' | 'epub';
  document?: DocumentSummary | null;
  pdfDocument?: PDFDocumentProxy | null;
  paragraphQuestion?: ParagraphQuestion | null;
}) {
  const preferences = useAIPreferences();
  const status = preferences.settings?.status;
  const [followup, setFollowup] = useState<{ text: string; nonce: number } | null>(null);
  const [quote, setQuote] = useState<{ text: string; nonce: number } | null>(null);
  useEffect(() => {
    const accept = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; text: string }>)
        .detail;
      // 同一句原文可以反复点「问 AI」：必须带 nonce，否则 setQuote 同值被 React 跳过，
      // ChatWorkspace 的 quote effect 不会重跑，输入框看起来"没反应"。
      if (detail.key === apiKey) {
        setQuote((current) => ({
          text: detail.text,
          nonce: (current?.nonce ?? 0) + 1,
        }));
      }
    };
    window.addEventListener('cbct-quote', accept);
    return () => window.removeEventListener('cbct-quote', accept);
  }, [apiKey]);


  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div
        className="flex shrink-0 items-center gap-1 border-b border-line px-3"
        style={{ height: 48 }}
      >
        {ASSISTANT_TABS.filter(
          (item) => format !== 'epub' || item.id !== 'reading',
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onTabChange(item.id)}
            aria-current={item.id === tab ? 'true' : undefined}
            className={[
              'rounded-full px-3 py-1.5 text-[12px] transition',
              item.id === tab
                ? 'bg-accent-soft font-medium text-accent'
                : 'text-ink-soft hover:text-ink',
            ].join(' ')}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-auto max-w-[140px] truncate pr-1 text-[12px] text-ink-faint">
          {status?.configured ? status.model || status.provider : '未配置'}
        </span>
      </div>

      {status && !status.configured ? (
        <p className="border-b border-line bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
          {status.error ?? '未配置 API Key'}
          ——对话与精读生成暂不可用，其余功能不受影响。
        </p>
      ) : null}

      <div
        className={tab === 'chat' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
      >
        <ChatWorkspace
          documentKey={apiKey}
          title={document?.title || ''}
          preferences={preferences}
          followup={followup}
          onReading={format === 'pdf' ? () => onTabChange('reading') : undefined}
          onCite={onCite}
          disabled={!status?.configured}
          quote={quote}
          paragraphQuestion={paragraphQuestion}
        />
      </div>
      {format !== 'epub' && <div className={tab === 'reading' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <PrecisionReading
          preferences={preferences}
          onAsk={(text) => { setFollowup({ text, nonce: Date.now() }); onTabChange('chat'); }}
          document={document}
          pdfDocument={pdfDocument}
          enabled={tab === 'reading'}
          apiKey={apiKey}
          onCite={onCite}
          disabled={!status?.configured}
        />
      </div>}
      {tab === 'notes' ? (
        <NotesPane
          apiKey={apiKey}
          state={annotations}
          onFocus={onFocusAnnotation}
          onCite={onCite}
        />
      ) : null}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  highlight: '高亮',
  underline: '下划线',
  question: '问题',
  margin: '页边笔记',
};

const COLOR_LABEL: Record<string, string> = {
  amber: '琥珀',
  rose: '玫红',
  sky: '天蓝',
  green: '青绿',
  violet: '紫罗兰',
};

const COLOR_DOT: Record<string, string> = {
  amber: '#d99a2b',
  rose: '#e0756b',
  sky: '#5b9fe8',
  green: '#5aa877',
  violet: '#9b7fd4',
};

const COLOR_CHOICES = ['amber', 'rose', 'sky', 'green', 'violet'] as const;

const NOTE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'highlight', label: '高亮' },
  { id: 'underline', label: '下划线' },
  { id: 'question', label: '问题' },
  { id: 'margin', label: '页边笔记' },
] as const;

type NoteFilterId = (typeof NOTE_FILTERS)[number]['id'];

/**
 * 批注面板：列表 + 筛选 + 就地编辑/改色/删除 + 导出 Markdown。
 *
 * 批注是用户自己的笔记，任何一步失败都要如实显示（不能静默吞掉）——
 * 所以每条卡片的写操作都带 pending 状态，失败把错误挂在卡片上。
 */
function NotesPane({
  apiKey,
  state,
  onFocus,
  onCite,
}: {
  apiKey: string | null;
  state: ReturnType<typeof useAnnotations>;
  onFocus: (id: string, page: number | null) => void;
  onCite: (page: number) => void;
}) {
  const [filter, setFilter] = useState<NoteFilterId>('all');
  const [color, setColor] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setQuery(''), [apiKey]);

  const items = state.items;
  const colors = useMemo(() => {
    const seen = new Set<string>();
    for (const item of items) if (item.color) seen.add(item.color);
    return seen.size > 1 ? [...seen] : [];
  }, [items]);
  const activeColor = colors.includes(color) ? color : '';

  const counts = useMemo(() => {
    const out: Record<string, number> = {
      all: items.length,
      highlight: 0,
      underline: 0,
      question: 0,
    };
    for (const item of items) out[item.kind] = (out[item.kind] ?? 0) + 1;
    return out;
  }, [items]);

  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          (filter === 'all' || item.kind === filter) &&
          (!activeColor || item.color === activeColor) &&
          (!needle ||
            `${item.quote} ${item.note} ${item.tags.join(' ')}`
              .toLocaleLowerCase()
              .includes(needle)),
      ),
    [items, filter, activeColor, needle],
  );

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setRowError(null);
    try {
      await action();
    } catch (cause) {
      setRowError({
        id,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(null);
    }
  };

  const saveNote = (id: string) =>
    run(id, async () => {
      await state.update(id, { note: draft });
      setEditing(null);
    });

  const exportMarkdown = async () => {
    if (!apiKey) return;
    setNotice(null);
    try {
      const filename = await api.exportAnnotations(apiKey);
      setNotice(`已导出 ${filename}`);
    } catch (cause) {
      setNotice(
        `导出失败：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

  if (!apiKey) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <p className="max-w-[26ch] text-center text-[13px] leading-relaxed text-ink-soft">
          先在左侧选一篇论文。
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="搜索批注内容"
          placeholder="搜索批注内容"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void exportMarkdown()}
          disabled={!items.length}
          title={items.length ? '导出为 Markdown' : '还没有批注可导出'}
          className="shrink-0 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink-soft shadow-sm transition hover:border-accent hover:text-accent disabled:opacity-40"
        >
          导出
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
        {NOTE_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setFilter(item.id)}
            aria-pressed={filter === item.id}
            className={[
              'rounded-pill px-2 py-0.5 text-[11px] transition',
              filter === item.id
                ? 'bg-accent-soft font-medium text-accent'
                : 'text-ink-soft hover:text-ink',
            ].join(' ')}
          >
            {item.label}
            {item.id !== 'all' && counts[item.id] ? (
              <span className="ml-1 text-ink-faint">{counts[item.id]}</span>
            ) : null}
          </button>
        ))}
        {colors.length ? (
          <>
            <span className="mx-1 h-3.5 w-px bg-line" />
            {colors.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setColor(activeColor === value ? '' : value)}
                aria-label={`只看${COLOR_LABEL[value] ?? value}`}
                title={COLOR_LABEL[value] ?? value}
                className={`flex h-5 w-5 items-center justify-center rounded-pill border transition ${
                  activeColor === value ? 'border-accent' : 'border-transparent'
                }`}
              >
                <span
                  className="ann-color-dot"
                  style={{ background: COLOR_DOT[value] ?? value }}
                />
              </button>
            ))}
          </>
        ) : null}
      </div>

      {notice ? (
        <p className="border-b border-line bg-surface-sunk px-3 py-2 text-[12px] leading-relaxed text-ink-soft">
          {notice}
        </p>
      ) : null}
      {state.error ? (
        <p className="border-b border-line bg-bad/10 px-3 py-2 text-[12px] leading-relaxed text-bad">
          {state.error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {state.loading ? (
          <p className="text-[13px] text-ink-soft">读取批注…</p>
        ) : null}
        {!state.loading && !items.length ? (
          <div className="pt-6 text-center">
            <p className="text-[13px] leading-relaxed text-ink-soft">
              还没有批注
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
              选中原文可以加批注，或选择「写笔记」把想法留在页边。
            </p>
          </div>
        ) : null}
        {!state.loading && items.length > 0 && !visible.length ? (
          <p className="pt-6 text-center text-[13px] text-ink-soft">
            {needle ? '没有匹配的批注' : '没有这类批注'}
          </p>
        ) : null}

        {visible.map((item) => {
          const isEditing = editing === item.id;
          const isBusy = busy === item.id;
          return (
            <article
              key={item.id}
              className="rounded-lg border border-line bg-surface px-2.5 py-2"
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`rounded-pill px-1.5 py-0.5 text-[10px] font-medium ann-${item.kind}-${item.color}`}
                >
                  {KIND_LABEL[item.kind] ?? item.kind}
                </span>
                {item.page != null ? (
                  <button
                    type="button"
                    onClick={() => onCite(item.page as number)}
                    className="rounded-pill bg-surface-sunk px-1.5 py-0.5 text-[10px] tabular-nums text-ink-soft hover:bg-accent-soft hover:text-accent"
                  >
                    P{item.page}
                  </button>
                ) : (
                  <span className="rounded-pill bg-surface-sunk px-1.5 py-0.5 text-[10px] text-ink-faint">
                    {item.locator?.kind === 'epub' ? '章节批注' : '未归页'}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1">
                  {COLOR_CHOICES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      disabled={isBusy || value === item.color}
                      onClick={() =>
                        void run(item.id, () =>
                          state.update(item.id, { color: value }),
                        )
                      }
                      aria-label={`改为${COLOR_LABEL[value]}色`}
                      title={COLOR_LABEL[value]}
                      className={`ann-color-choice${value === item.color ? ' ann-color-current' : ''}`}
                    >
                      <span
                        className="ann-color-dot"
                        style={{ background: COLOR_DOT[value] }}
                      />
                    </button>
                  ))}
                </span>
              </div>

              <button
                type="button"
                onClick={() => onFocus(item.id, item.page)}
                className="mt-1.5 block w-full text-left text-[12px] leading-snug text-ink-soft hover:text-ink"
                title="跳到正文对应位置"
              >
                <span
                  className={`ann-${item.kind}-${item.color} inline rounded-[3px] px-0.5`}
                >
                  {item.kind === 'margin' && !item.quote ? '查看页边位置' : item.quote.length > 120
                    ? `${item.quote.slice(0, 120)}…`
                    : item.quote}
                </span>
              </button>

              {item.tags.length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {item.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-pill bg-surface-sunk px-1.5 py-0.5 text-[10px] text-ink-faint"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}

              {isEditing ? (
                <div className="mt-1.5">
                  <textarea
                    autoFocus
                    rows={3}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditing(null);
                    }}
                    aria-label="批注内容"
                    className="w-full resize-none rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] focus:border-accent focus:outline-none"
                  />
                  <div className="mt-1 flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="rounded-md px-2 py-1 text-[11px] text-ink-faint"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void saveNote(item.id)}
                      className="rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-surface disabled:opacity-40"
                    >
                      {isBusy ? '保存中…' : '保存'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-1.5 flex items-start gap-1.5">
                  <p className="min-w-0 flex-1 whitespace-pre-wrap text-[12px] leading-relaxed text-ink">
                    {item.note || (
                      <span className="text-ink-faint">（无批注正文）</span>
                    )}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(item.note);
                      setEditing(item.id);
                    }}
                    className="shrink-0 text-[11px] text-ink-faint hover:text-accent"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() =>
                      void run(item.id, () => state.remove(item.id))
                    }
                    className="shrink-0 text-[11px] text-ink-faint hover:text-bad disabled:opacity-40"
                  >
                    删除
                  </button>
                </div>
              )}

              {rowError?.id === item.id ? (
                <p className="mt-1 text-[11px] leading-relaxed text-bad">
                  {rowError.message}
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
