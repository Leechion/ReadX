import { useEffect, useRef, useState } from 'react';
import { request, type ImportCandidate } from '../api/client';
interface Hit extends ImportCandidate { source: string; sourceId: string; sources: string[]; existingKey?: string }
interface Search { id: string; sessionId?: string; parentId?: string; at: string; page: number; runs: { source: string; query: string; total: number; retrieved: number; error?: string }[]; results: Hit[]; disclosure: string }
interface Session { id: string; parentId?: string; pages: Search[]; results: Hit[]; disclosure: string }
const sources = ['pubmed', 'openalex', 'crossref'] as const;
const identity = (hit: Hit) => hit.doi ? hit.doi.toLowerCase().replace(/^https?:\/\/doi.org\//, '') : `${hit.source}:${hit.sourceId}`;
export function ScholarDiscoveryPanel({ busy, onDownload }: { busy: boolean; onDownload: (url: string, title?: string, metadata?: ImportCandidate) => Promise<void> }) {
  const [query, setQuery] = useState(''); const [expressions, setExpressions] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState<Record<string, boolean>>({ pubmed: true, openalex: true });
  const [result, setResult] = useState<Search | null>(null); const [history, setHistory] = useState<Search[]>([]); const [queued, setQueued] = useState<Hit[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set()); const [notice, setNotice] = useState(''); const [working, setWorking] = useState(false);
  const [doi, setDOI] = useState(''); const [direction, setDirection] = useState('references');
  const [parentId, setParentId] = useState('');
  const [session, setSession] = useState<Session | null>(null); const [allPages, setAllPages] = useState(false);
  const [sessions, setSessions] = useState<{ id: string; query: string; pages: number; count: number }[]>([]);
  const controller = useRef<AbortController | null>(null);
  const refresh = () => {
    void request<{ searches: Search[] }>('/v1/scholar/history').then(value => setHistory(value.searches)).catch(error => setNotice(String(error)));
    void request<{ records: Hit[] }>('/v1/scholar/queue').then(value => setQueued(value.records)).catch(error => setNotice(String(error)));
    void request<{ sessions: { id: string; query: string; pages: number; count: number }[] }>('/v1/scholar/sessions').then(value => setSessions(value.sessions)).catch(error => setNotice(String(error)));
  };
  useEffect(() => { refresh(); return () => controller.current?.abort(); }, []);
  useEffect(() => {
    setSession(null); setAllPages(false);
    if (!result?.sessionId) return;
    const abort = new AbortController();
    void request<Session>(`/v1/scholar/sessions/${encodeURIComponent(result.sessionId)}`, { signal: abort.signal }).then(setSession).catch(error => { if (!abort.signal.aborted) setNotice(String(error)); });
    return () => abort.abort();
  }, [result]);
  const hits = allPages && session ? session.results : result?.results ?? [];
  const run = async (page: number, snowball = false, previous?: Search) => {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort; setWorking(true); setNotice('');
    try {
      const queries = previous && !snowball ? Object.fromEntries(previous.runs.map(run => [run.source, run.query])) : Object.fromEntries(sources.filter(source => enabled[source]).map(source => [source, expressions[source]?.trim() || query.trim()]));
      const prior = previous?.runs[0]?.query;
      const anchor = snowball && prior ? { doi: prior.slice(prior.indexOf(':') + 1), direction: prior.slice(0, prior.indexOf(':')), page } : { doi, direction, page };
      const found = await request<Search>(snowball ? '/v1/scholar/snowball' : '/v1/scholar/search', { method: 'POST', body: snowball ? { ...anchor, sessionId: previous?.sessionId, parentId: previous ? previous.parentId ?? '' : parentId } : { queries, page, sessionId: previous?.sessionId }, signal: abort.signal });
      setResult(found); setSelected(new Set()); refresh();
    } catch (error) { setNotice(abort.signal.aborted ? '已停止检索' : String(error)); }
    finally { if (controller.current === abort) controller.current = null; setWorking(false); }
  };
  const enqueue = async () => {
    setWorking(true);
    try {
      const chosen = hits.filter(hit => selected.has(identity(hit)));
      const saved = await request<{ records: Hit[] }>('/v1/scholar/queue', { method: 'POST', body: { records: chosen } });
      setQueued(saved.records); window.dispatchEvent(new CustomEvent('readx:reading-candidates', { detail: chosen }));
      setNotice('题录已保存，并加入科研工作台阅读任务；全文尚未下载或验证。');
    }
    catch (error) { setNotice(String(error)); } finally { setWorking(false); }
  };
  const saveRecord = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(session ?? result, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `ReadX-search-${result.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <details className="ai-card"><summary>多源学术检索、引文扩展与待读题录</summary>
    <label>主题或默认检索词<input value={query} onChange={event => setQuery(event.target.value)} placeholder="例如 sparse-view CBCT" disabled={working || busy} /></label>
    {sources.map(source => <label key={source}><span><input type="checkbox" checked={!!enabled[source]} onChange={event => setEnabled(current => ({ ...current, [source]: event.target.checked }))} disabled={working || busy} />{source}</span><input value={expressions[source] ?? ''} onChange={event => setExpressions(current => ({ ...current, [source]: event.target.value }))} disabled={!enabled[source] || working || busy} placeholder={source === 'crossref' ? '该来源关键词（不转换布尔表达式）' : '该来源实际检索式；留空用主题词'} /></label>)}
    <button type="button" disabled={working || busy || !sources.some(source => enabled[source])} onClick={() => void run(1)}>执行逐源检索</button>
    <label>引文扩展锚点 DOI／OpenAlex 标识<input value={doi} onChange={event => { setDOI(event.target.value); setParentId(''); }} placeholder="10.… 或 W123…" disabled={working || busy} /></label>
    {parentId && <p>下一次扩展将保留与当前结果的来源关系。</p>}
    <select value={direction} disabled={working || busy} onChange={event => setDirection(event.target.value)}><option value="references">它引用了谁（前作）</option><option value="citations">谁引用了它（后续工作）</option></select>
    <button type="button" disabled={working || busy || !doi.trim()} onClick={() => void run(1, true)}>扩展一层</button>
    {working && <button type="button" onClick={() => controller.current?.abort()}>停止查询</button>}
    {history.length > 0 && <label>已保存的检索记录<select value={result?.id ?? ''} onChange={event => { setResult(history.find(item => item.id === event.target.value) ?? null); setSelected(new Set()); }}><option value="">选择记录</option>{history.map(item => <option key={item.id} value={item.id}>{new Date(item.at).toLocaleString()} · {item.runs.map(run => run.query).join(' / ')}</option>)}</select></label>}
    {sessions.length > 0 && <label>跨页检索会话<select value={session?.id ?? ''} disabled={working} onChange={event => { const id = event.target.value; if (!id) return; void request<Session>(`/v1/scholar/sessions/${encodeURIComponent(id)}`).then(value => { setResult(value.pages[value.pages.length - 1] ?? null); setSelected(new Set()); }).catch(error => setNotice(String(error))); }}><option value="">选择会话</option>{sessions.map(item => <option key={item.id} value={item.id}>{item.query} · {item.pages} 页 · {item.count} 条</option>)}</select></label>}
    {result && <section><p>{result.disclosure}</p><ul>{result.runs.map(run => <li key={run.source}>{run.source}：{run.query} · 来源报告 {run.total} 条，本页 {run.retrieved} 条 {run.error && `· 失败：${run.error}`}</li>)}</ul>
      <p>当前页去重后 {result.results.length} 条；不代表全量唯一命中数。</p>
      {session && <><p>{session.disclosure}</p><label><input type="checkbox" checked={allPages} onChange={event => { setAllPages(event.target.checked); setSelected(new Set()); }} />查看本会话所有已抓取页</label></>}
      {result.parentId && <button type="button" onClick={() => void request<Search>(`/v1/scholar/records/${encodeURIComponent(result.parentId!)}`).then(setResult).catch(error => setNotice(String(error)))}>返回上一步发现路径</button>}
      <button type="button" onClick={saveRecord}>导出本次检索记录</button>
      <button type="button" disabled={working || !selected.size} onClick={() => void enqueue()}>所选加入待读和工作台（{selected.size}）</button>
      <ul>{hits.map(hit => <li key={identity(hit)}><label><input type="checkbox" checked={selected.has(identity(hit))} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(identity(hit)); else next.delete(identity(hit)); return next; })} />{hit.title}</label><small>{hit.existingKey && '已在书库 · '}{[hit.venue, hit.year, hit.doi, hit.sources.join(' / ')].filter(Boolean).join(' · ')}</small><div><button type="button" disabled={busy || working} onClick={() => void onDownload((hit.doi && !/\.pdf(?:[?#]|$)/i.test(hit.url) ? hit.doi : hit.url || hit.doi), hit.title, hit)}>尝试下载至导入队列</button>{(hit.doi || hit.source === 'openalex') && <button type="button" onClick={() => { setDOI(hit.doi || hit.sourceId); setParentId(result.id); }}>用作下一层锚点</button>}</div></li>)}</ul>
      <button type="button" disabled={working || busy || result.page <= 1} onClick={() => void run(result.page - 1, result.runs[0]?.query.startsWith('references:') || result.runs[0]?.query.startsWith('citations:'), result)}>上一页</button>
      <span>第 {result.page} 页</span><button type="button" disabled={working || busy || result.runs.every(run => run.total <= result.page * 20)} onClick={() => void run(result.page + 1, result.runs[0]?.query.startsWith('references:') || result.runs[0]?.query.startsWith('citations:'), result)}>下一页</button>
    </section>}
    <details><summary>待读题录（{queued.length}）</summary><ul>{queued.map(hit => <li key={identity(hit)}>{hit.title} <button type="button" disabled={busy || working} onClick={() => void onDownload((hit.doi && !/\.pdf(?:[?#]|$)/i.test(hit.url) ? hit.doi : hit.url || hit.doi), hit.title, hit)}>尝试下载全文</button></li>)}</ul></details>
    <p role="status">{notice}</p>
  </details>;
}
