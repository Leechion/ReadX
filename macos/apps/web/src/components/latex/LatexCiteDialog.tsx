import { useEffect, useMemo, useState } from 'react';
import type { DocumentSummary, LatexCiteLibraryResult, LatexNode } from '@cbct/shared';
import { statusLabel } from '@cbct/shared';
import { api } from '../../api/client';
import { AppDialog } from '../AppDialog';

export function LatexCiteDialog({
  open,
  projectId,
  documents,
  nodes,
  onClose,
  onInserted,
}: {
  open: boolean;
  projectId: string;
  documents: DocumentSummary[];
  nodes: LatexNode[];
  onClose: () => void;
  onInserted: (result: LatexCiteLibraryResult) => Promise<void> | void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [bibFile, setBibFile] = useState('references.bib');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const bibOptions = useMemo(() => {
    const existing = nodes.filter((node) => node.kind === 'bib').map((node) => node.path);
    if (existing.length > 0) return existing;
    return ['references.bib'];
  }, [nodes]);

  useEffect(() => {
    if (!open) return;
    setError('');
    setSelected([]);
    setQuery('');
    const preferred =
      bibOptions.find((item) => item.toLowerCase() === 'references.bib') ??
      bibOptions.find((item) => item.toLowerCase() === 'refs.bib') ??
      bibOptions[0] ??
      'references.bib';
    setBibFile(preferred);
  }, [bibOptions, open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return documents;
    return documents.filter((doc) => {
      const haystack = [
        doc.title,
        doc.translatedTitle ?? '',
        doc.authors.join(' '),
        doc.venue,
        doc.year ? String(doc.year) : '',
        doc.key,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [documents, query]);

  const toggleKey = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const submit = async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.latexCiteLibrary(projectId, selected, bibFile);
      await onInserted(result);
      onClose();
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
      className="latex-cite-dialog"
      aria-labelledby="latex-cite-dialog-title"
    >
      <div className="latex-cite-dialog-body">
        <header className="latex-cite-dialog-head">
          <div>
            <h2 id="latex-cite-dialog-title">从 ReadX 书库插入引用</h2>
            <p>自动生成 BibTeX 写入项目文献库（已存在条目自动复用键名），并在当前光标处插入 \cite{'{...}'}。</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="latex-cite-controls">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按标题、作者、年份、会议/期刊检索书库…"
            aria-label="检索书库文献"
            autoFocus
          />
          <label className="latex-field">
            目标 .bib
            <select value={bibFile} onChange={(event) => setBibFile(event.target.value)} disabled={busy}>
              {bibOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>

        <ul className="latex-cite-list" aria-label="书库文献列表">
          {filtered.length ? (
            filtered.map((doc) => {
              const checked = selected.includes(doc.id);
              return (
                <li key={doc.id}>
                  <label className={`latex-cite-item${checked ? ' checked' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleKey(doc.id)}
                      disabled={busy}
                    />
                    <div className="latex-cite-item-main">
                      <strong>{doc.title || doc.key}</strong>
                      {doc.translatedTitle ? <span className="latex-cite-sub">{doc.translatedTitle}</span> : null}
                      <span className="latex-cite-meta">
                        {[doc.authors.slice(0, 3).join(', '), doc.year, doc.venue, statusLabel(doc.status)]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </div>
                  </label>
                </li>
              );
            })
          ) : (
            <li className="latex-cite-empty">
              {documents.length ? '没有匹配的书库文献。' : '书库里还没有可用文献，先导入论文即可在此直接引用。'}
            </li>
          )}
        </ul>

        {error ? (
          <p className="latex-alert error" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="latex-cite-footer">
          <span>已选 {selected.length} 篇</span>
          <div className="latex-cite-footer-actions">
            <button type="button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              disabled={!selected.length || busy}
              onClick={() => void submit()}
            >
              {busy ? '正在写入…' : `写入 ${bibFile} 并插入 \\cite`}
            </button>
          </div>
        </footer>
      </div>
    </AppDialog>
  );
}
