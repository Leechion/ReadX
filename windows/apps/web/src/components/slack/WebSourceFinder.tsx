import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { searchWebSource } from './sources/web-engine';
import {
  loadWebSources,
  mergeWebSources,
  parseBookSources,
  saveWebSources,
  sourceHost,
} from './sources/web-store';
import { WEB_SOURCE_HELP, WEB_SOURCE_SAMPLE } from './sources/web-sample';
import type { WebBookSource, WebSearchResult } from './sources/web-types';

function WebCover({ url }: { url: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState('');

  useEffect(() => {
    const element = holder.current;
    if (!element || !url) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [url]);

  useEffect(() => {
    if (!visible || !url) return;
    let cancelled = false;
    let objectURL = '';
    void api
      .fetchWebSourceImage(url)
      .then((blob) => {
        if (cancelled) return;
        objectURL = URL.createObjectURL(blob);
        setSource(objectURL);
      })
      .catch(() => {
        /* 封面失败不影响书源结果。 */
      });
    return () => {
      cancelled = true;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [url, visible]);

  return (
    <div className="slack-finder__cover" ref={holder}>
      {source ? <img src={source} alt="" loading="lazy" /> : <span>READ</span>}
    </div>
  );
}

export function WebSourceFinder({
  onImport,
}: {
  onImport: (source: WebBookSource, book: WebSearchResult) => Promise<void>;
}) {
  const [sources, setSources] = useState<WebBookSource[]>(loadWebSources);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WebSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importingKey, setImportingKey] = useState('');
  const [manageOpen, setManageOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  const enabledCount = useMemo(() => sources.filter((source) => source.enabled).length, [sources]);

  useEffect(() => {
    if (sources.length === 0) {
      setSelectedId('');
      return;
    }
    if (sources.some((source) => source.id === selectedId && source.enabled)) return;
    setSelectedId(sources.find((source) => source.enabled)?.id ?? sources[0]?.id ?? '');
  }, [sources, selectedId]);

  const announce = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 4000);
  };

  const importText = (text: string) => {
    try {
      const parsed = parseBookSources(text);
      const merged = mergeWebSources(sources, parsed.sources);
      saveWebSources(merged);
      setSources(merged);
      setSelectedId(parsed.sources[0]?.id ?? selectedId);
      setPasteOpen(false);
      setPasteText('');
      setError(parsed.errors.join('；'));
      setManageOpen(true);
      announce(
        `已导入 ${parsed.sources.length} 个书源${parsed.errors.length ? `，${parsed.errors.length} 个失败` : ''}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const importFile = async (file: File) => {
    try {
      importText(await file.text());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const toggleSource = (id: string) => {
    const updated = sources.map((source) =>
      source.id === id ? { ...source, enabled: !source.enabled } : source,
    );
    saveWebSources(updated);
    setSources(updated);
    const source = updated.find((entry) => entry.id === id);
    if (source) announce(`${source.name} 已${source.enabled ? '启用' : '停用'}`);
  };

  const removeSource = (id: string) => {
    const source = sources.find((entry) => entry.id === id);
    const updated = sources.filter((entry) => entry.id !== id);
    saveWebSources(updated);
    setSources(updated);
    if (source) announce(`已删除「${source.name}」；已缓存的章节仍可阅读`);
  };

  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const source = sources.find((entry) => entry.id === selectedId);
    if (!source) {
      setError('先导入并选择一个书源');
      return;
    }
    const value = query.trim();
    if (!value) {
      setError('输入书名或作者再搜索');
      return;
    }
    const currentRequest = requestId.current + 1;
    requestId.current = currentRequest;
    setLoading(true);
    setError('');
    setResults([]);
    void searchWebSource(source, value, AbortSignal.timeout(60_000))
      .then((found) => {
        if (requestId.current !== currentRequest) return;
        setResults(found);
        if (!found.length) {
          setError('没有搜到结果：书源规则可能不匹配，或站点需要登录/验证。');
        }
      })
      .catch((cause: unknown) => {
        if (requestId.current !== currentRequest) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (requestId.current === currentRequest) setLoading(false);
      });
  };

  const addToShelf = async (book: WebSearchResult) => {
    const source = sources.find((entry) => entry.id === book.sourceId);
    if (!source) {
      setError('这个书源已被删除，请重新导入后再试');
      return;
    }
    setImportingKey(book.bookUrl);
    setError('');
    try {
      await onImport(source, book);
      announce(`《${book.title}》已加入书架`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImportingKey('');
    }
  };

  return (
    <section className="slack-web">
      <div className="slack-web__head">
        <div>
          <strong>中文连载书源</strong>
          <small>
            {sources.length
              ? `${sources.length} 个书源 · ${enabledCount} 个启用`
              : '还没有导入书源'}
          </small>
        </div>
        <div className="slack-web__actions">
          <button type="button" onClick={() => fileInput.current?.click()}>导入 JSON</button>
          <button type="button" onClick={() => setPasteOpen(true)}>粘贴 JSON</button>
          <button type="button" onClick={() => setTemplateOpen(true)}>示例</button>
          <button
            type="button"
            className={manageOpen ? 'active' : ''}
            onClick={() => setManageOpen((value) => !value)}
          >
            {manageOpen ? '收起管理' : '管理书源'}
          </button>
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".json,.txt,application/json,text/plain"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importFile(file);
        }}
      />

      {notice ? <p className="slack-web__notice" role="status">{notice}</p> : null}

      {manageOpen ? (
        <div className="slack-web__sources">
          {sources.length ? (
            sources.map((source) => (
              <article className="slack-web__source" key={source.id}>
                <div className="slack-web__source-copy">
                  <strong>{source.name}</strong>
                  <small>{sourceHost(source)} · {source.charset.toUpperCase()}</small>
                  {source.unsupported ? (
                    <span className="slack-web__badge">{source.unsupported}</span>
                  ) : null}
                </div>
                <div className="slack-web__source-actions">
                  <label>
                    <input
                      type="checkbox"
                      checked={source.enabled}
                      onChange={() => toggleSource(source.id)}
                    />
                    启用
                  </label>
                  <button type="button" onClick={() => removeSource(source.id)}>删除</button>
                </div>
              </article>
            ))
          ) : (
            <p className="slack-web__empty">还没有书源。点「导入 JSON」或「粘贴 JSON」加入一个 Legado 书源。</p>
          )}
        </div>
      ) : null}

      <form className="slack-web__search" onSubmit={search}>
        <select
          value={selectedId}
          onChange={(event) => setSelectedId(event.target.value)}
          disabled={!sources.length}
          aria-label="选择书源"
        >
          {sources.length ? null : <option value="">没有书源</option>}
          {sources.map((source) => (
            <option key={source.id} value={source.id} disabled={!source.enabled}>
              {source.name}{source.enabled ? '' : '（已停用）'}
            </option>
          ))}
        </select>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入书名或作者，例如：剑来、诡秘之主"
          aria-label="搜索连载小说"
        />
        <button type="submit" disabled={loading || !sources.length}>
          {loading ? '搜索中…' : '搜索'}
        </button>
      </form>

      {error ? <p className="slack-finder__error" role="alert">{error}</p> : null}
      {loading ? <p className="slack-loading" role="status">正在通过书源搜索…</p> : null}

      {results.length ? (
        <div className="slack-finder__grid slack-web__results">
          {results.map((book) => (
            <article className="slack-finder__card" key={`${book.sourceId}:${book.bookUrl}`}>
              <WebCover url={book.cover} />
              <div className="slack-finder__details">
                <div className="slack-finder__badges">
                  <span className="slack-finder__source-badge">
                    {book.sourceName}
                  </span>
                  {book.lastChapter ? (
                    <span className="slack-finder__format">{book.lastChapter}</span>
                  ) : null}
                </div>
                <h2>{book.title}</h2>
                <p className="slack-finder__author">{book.author || '作者未知'}</p>
                {book.intro ? <p className="slack-finder__description">{book.intro}</p> : null}
                <div className="slack-finder__actions">
                  <button
                    type="button"
                    className="slack-primary slack-finder__download"
                    disabled={importingKey !== ''}
                    onClick={() => void addToShelf(book)}
                  >
                    {importingKey === book.bookUrl ? '解析目录并加入中…' : '加入书架'}
                  </button>
                  {/^https?:\/\//i.test(book.bookUrl) ? (
                    <a
                      className="slack-finder__open"
                      href={book.bookUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      在网页中打开 ↗
                    </a>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {!sources.length ? (
        <div className="slack-finder__note">
          <span aria-hidden="true">✦</span>
          <p>
            导入 Legado 书源 JSON 后即可搜索中文连载小说。书源由你自己提供，ReadX 只负责按规则抓取和本地缓存。
          </p>
          <button type="button" className="slack-web__link" onClick={() => setTemplateOpen(true)}>
            查看规则示例
          </button>
        </div>
      ) : null}

      {pasteOpen ? (
        <div className="slack-modal" role="dialog" aria-modal="true" aria-labelledby="slack-web-paste-title" onClick={() => setPasteOpen(false)}>
          <div className="slack-modal__card slack-web__modal" onClick={(event) => event.stopPropagation()}>
            <h2 id="slack-web-paste-title">粘贴书源 JSON</h2>
            <p>支持单个书源、数组，或 <code>{'{"bookSources":[...]}'}</code>；也接受 Legado 的 `bookSourceName` / `ruleSearch` 字段。</p>
            <textarea
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              placeholder="在这里粘贴书源 JSON…"
              spellCheck={false}
            />
            <div className="slack-modal__actions">
              <button type="button" onClick={() => setPasteOpen(false)}>取消</button>
              <button
                type="button"
                className="slack-primary"
                disabled={!pasteText.trim()}
                onClick={() => importText(pasteText)}
              >
                导入
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {templateOpen ? (
        <div className="slack-modal" role="dialog" aria-modal="true" aria-labelledby="slack-web-template-title" onClick={() => setTemplateOpen(false)}>
          <div className="slack-modal__card slack-web__modal" onClick={(event) => event.stopPropagation()}>
            <h2 id="slack-web-template-title">书源规则示例</h2>
            <p className="slack-web__help">{WEB_SOURCE_HELP}</p>
            <pre className="slack-web__template">{WEB_SOURCE_SAMPLE}</pre>
            <div className="slack-modal__actions">
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(WEB_SOURCE_SAMPLE).catch(() => {})}
              >
                复制
              </button>
              <button type="button" onClick={() => setTemplateOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
