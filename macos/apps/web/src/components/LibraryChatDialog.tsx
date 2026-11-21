import { Fragment, useMemo, useRef, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { streamLibraryChat, type LibraryChatSource, type SearchCoverage } from '../api/client';
import { AppDialog } from './AppDialog';

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources?: LibraryChatSource[];
  coverage?: SearchCoverage;
  error?: string;
}

const CITE_PATTERN = /\[([^\]·\n]+?)\s*·\s*p\.(\d+)\]/g;

function renderCitedText(
  text: string,
  sources: LibraryChatSource[] | undefined,
  onOpenAtPage: (key: string, page: number, query: string) => void,
) {
  const byKey = new Map((sources ?? []).map((s) => [s.key, s]));
  const nodes: React.ReactNode[] = [];
  let last = 0;
  CITE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = CITE_PATTERN.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(<Fragment key={`t-${idx++}`}>{text.slice(last, match.index)}</Fragment>);
    }
    const key = match[1]!.trim();
    const page = Number(match[2]);
    const source = byKey.get(key);
    nodes.push(
      <button
        key={`c-${idx++}`}
        type="button"
        className="library-rag-cite"
        title={source ? `跳转到《${source.title}》第 ${page} 页` : `跳转到 ${key} 第 ${page} 页`}
        onClick={() => onOpenAtPage(key, page, '')}
      >
        {source ? `${source.title.slice(0, 18)}${source.title.length > 18 ? '…' : ''} · p.${page}` : `${key} · p.${page}`}
      </button>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    nodes.push(<Fragment key={`t-${idx++}`}>{text.slice(last)}</Fragment>);
  }
  return nodes;
}

export function LibraryChatDialog({
  open,
  documents,
  categories,
  activeCategory,
  onClose,
  onOpenAtPage,
}: {
  open: boolean;
  documents: DocumentSummary[];
  categories: string[];
  activeCategory: string;
  onClose: () => void;
  onOpenAtPage: (key: string, page: number, query: string) => void;
}) {
  const [scope, setScope] = useState<'all' | 'category' | 'keys'>(() => (activeCategory ? 'category' : 'all'));
  const [category, setCategory] = useState(activeCategory || categories[0] || '');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [keyFilter, setKeyFilter] = useState('');
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const filteredDocs = useMemo(() => {
    const needle = keyFilter.trim().toLowerCase();
    if (!needle) return documents;
    return documents.filter((d) =>
      `${d.title} ${d.translatedTitle ?? ''} ${d.authors.join(' ')} ${d.year ?? ''}`.toLowerCase().includes(needle),
    );
  }, [documents, keyFilter]);

  const toggleKey = (id: string) => {
    setSelectedKeys((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= 6) return cur;
      return [...cur, id];
    });
  };

  const ask = async (promptText?: string) => {
    const q = (promptText ?? question).trim();
    if (!q || busy) return;
    if (scope === 'category' && !category) return;
    if (scope === 'keys' && !selectedKeys.length) return;

    const userTurn: Turn = { id: `u-${Date.now()}`, role: 'user', text: q };
    const assistantId = `a-${Date.now()}`;
    const history = turns.map((t) => ({ role: t.role, text: t.text }));
    setTurns((cur) => [...cur, userTurn, { id: assistantId, role: 'assistant', text: '' }]);
    if (!promptText) setQuestion('');

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    let streamSources: LibraryChatSource[] | undefined;
    let streamCoverage: SearchCoverage | undefined;
    try {
      await streamLibraryChat(
        {
          question: q,
          scope,
          category: scope === 'category' ? category : undefined,
          keys: scope === 'keys' ? selectedKeys : undefined,
          history,
        },
        (chunk) => {
          if (chunk.meta) {
            streamSources = chunk.meta.sources;
            streamCoverage = chunk.meta.coverage;
            setTurns((cur) =>
              cur.map((t) => (t.id === assistantId ? { ...t, sources: streamSources, coverage: streamCoverage } : t)),
            );
          } else if (chunk.delta) {
            setTurns((cur) =>
              cur.map((t) => (t.id === assistantId ? { ...t, text: t.text + chunk.delta } : t)),
            );
          } else if (chunk.error) {
            setTurns((cur) =>
              cur.map((t) =>
                t.id === assistantId
                  ? { ...t, text: t.text || chunk.partial || '', error: chunk.error }
                  : t,
              ),
            );
          } else if (chunk.done) {
            setTurns((cur) =>
              cur.map((t) =>
                t.id === assistantId
                  ? {
                      ...t,
                      text: chunk.text ?? t.text,
                      sources: chunk.sources ?? streamSources,
                      coverage: streamCoverage,
                    }
                  : t,
              ),
            );
          }
        },
        controller.signal,
      );
    } catch (cause) {
      if (!controller.signal.aborted) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        setTurns((cur) => cur.map((t) => (t.id === assistantId ? { ...t, error: msg } : t)));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const jump = (key: string, page: number) => {
    onClose();
    onOpenAtPage(key, page, '');
  };

  return (
    <AppDialog
      open={open}
      onClose={() => {
        abortRef.current?.abort();
        onClose();
      }}
      busy={busy}
      closeOnBackdrop
      className="library-rag-dialog"
      aria-labelledby="library-rag-title"
    >
      <div className="library-rag-body">
        <header className="library-rag-head">
          <div>
            <h2 id="library-rag-title">跨文献 AI 问答（RAG）</h2>
            <p>基于 FTS5 检索与已存精读沉淀回答跨论文问题，结论附页码可直跳原文核对。</p>
          </div>
          <button
            type="button"
            onClick={() => {
              abortRef.current?.abort();
              onClose();
            }}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="library-rag-scope">
          <div className="view-switch" role="group" aria-label="问答范围">
            {([
              { id: 'all', label: '全库已索引' },
              { id: 'category', label: '按书架' },
              { id: 'keys', label: '指定文献' },
            ] as const).map((item) => (
              <button
                key={item.id}
                type="button"
                className={scope === item.id ? 'active' : ''}
                aria-pressed={scope === item.id}
                disabled={busy}
                onClick={() => setScope(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {scope === 'category' ? (
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              disabled={busy || !categories.length}
              aria-label="选择书架"
            >
              {categories.length ? (
                categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))
              ) : (
                <option value="">暂无书架</option>
              )}
            </select>
          ) : null}

          {turns.length ? (
            <button type="button" className="library-rag-clear" disabled={busy} onClick={() => setTurns([])}>
              清空对话
            </button>
          ) : null}
        </div>

        {scope === 'keys' ? (
          <div className="library-rag-picker">
            <input
              type="search"
              value={keyFilter}
              onChange={(event) => setKeyFilter(event.target.value)}
              placeholder={`筛选论文（已选 ${selectedKeys.length}/6 篇）…`}
            />
            <ul>
              {filteredDocs.slice(0, 30).map((doc) => {
                const checked = selectedKeys.includes(doc.id);
                return (
                  <li key={doc.id}>
                    <label className={checked ? 'checked' : undefined}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && selectedKeys.length >= 6}
                        onChange={() => toggleKey(doc.id)}
                      />
                      <span>{doc.title || doc.key}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        <div className="library-rag-turns">
          {!turns.length ? (
            <div className="library-rag-welcome">
              <p>可以这样问：</p>
              <div className="library-rag-prompts">
                {[
                  '这些论文在核心方法与网络结构上有哪些主要差异？',
                  '汇总各篇论文使用的数据集、评价指标与实验结果对比。',
                  '目前书库文献共同关注哪些局限性或尚未解决的问题？',
                ].map((sample) => (
                  <button key={sample} type="button" onClick={() => void ask(sample)}>
                    {sample}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((turn) => (
              <article key={turn.id} className={`library-rag-turn ${turn.role}`}>
                <div className="library-rag-text">
                  {turn.role === 'assistant'
                    ? renderCitedText(turn.text || (busy ? '正在检索并整理多篇证据…' : ''), turn.sources, jump)
                    : turn.text}
                </div>
                {turn.error ? <p className="latex-alert error">{turn.error}</p> : null}
                {turn.role === 'assistant' && turn.sources?.length ? (
                  <footer className="library-rag-sources">
                    <span>引用依据（{turn.sources.length} 篇）：</span>
                    {turn.sources.map((src) => (
                      <button
                        key={src.key}
                        type="button"
                        onClick={() => jump(src.key, src.pages[0] ?? 1)}
                        title={src.title}
                      >
                        {src.title.slice(0, 22)}
                        {src.title.length > 22 ? '…' : ''}
                        {src.pages.length ? ` (p.${src.pages.join(',')})` : ''}
                      </button>
                    ))}
                    {turn.coverage ? (
                      <small>
                        索引覆盖：{turn.coverage.indexedDocuments}/{turn.coverage.documents} 篇
                      </small>
                    ) : null}
                  </footer>
                ) : null}
              </article>
            ))
          )}
        </div>

        <form
          className="library-rag-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="输入跨文献研究问题，回车发送…"
            disabled={busy}
          />
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()}>
              停止
            </button>
          ) : (
            <button
              type="submit"
              className="primary"
              disabled={
                !question.trim() ||
                (scope === 'category' && !category) ||
                (scope === 'keys' && !selectedKeys.length)
              }
            >
              提问
            </button>
          )}
        </form>
      </div>
    </AppDialog>
  );
}
