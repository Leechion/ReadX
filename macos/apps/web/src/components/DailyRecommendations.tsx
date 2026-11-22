import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { api, type DailyRecommendation, type DailyRecommendationRules } from '../api/client';
import { STORAGE_KEYS } from '../lib/storage';

const CACHE_KEY = STORAGE_KEYS.dailyRecommendations;
const RULES_KEY = STORAGE_KEYS.dailyRecommendationRules;
type RuleDraft = Omit<DailyRecommendationRules, 'keywords' | 'exclude' | 'venues'> & { keywords: string; exclude: string; venues: string };
type DailyCache = { day: string; rulesKey: string; fetchedAt: string; papers: DailyRecommendation[] };

function dayKey() {
  return new Date().toLocaleDateString('en-CA');
}

function normalizedTitle(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function splitLines(value: string) {
  return value.split(/[\n\r;]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeRules(value: RuleDraft | DailyRecommendationRules): DailyRecommendationRules {
  const asLines = (input: string | string[]) => Array.isArray(input) ? input.map((item) => item.trim()).filter(Boolean) : splitLines(input);
  return {
    field: value.field.trim(),
    keywords: asLines(value.keywords),
    exclude: asLines(value.exclude),
    venues: asLines(value.venues),
    years: [1, 2, 3, 5].includes(value.years) ? value.years : 2,
  };
}

function rulesKey(value: DailyRecommendationRules) {
  return JSON.stringify({ ...value, field: value.field.toLowerCase(), keywords: value.keywords.map((item) => item.toLowerCase()), exclude: value.exclude.map((item) => item.toLowerCase()), venues: value.venues.map((item) => item.toLowerCase()) });
}

function hasSearchRules(value: DailyRecommendationRules) {
  return Boolean(value.field || value.keywords.length);
}

function draftFromRules(value: DailyRecommendationRules): RuleDraft {
  return { ...value, keywords: value.keywords.join('\n'), exclude: value.exclude.join('\n'), venues: value.venues.join('\n') };
}

function readRules(): DailyRecommendationRules {
  try {
    const value = JSON.parse(localStorage.getItem(RULES_KEY) ?? 'null') as RuleDraft | DailyRecommendationRules | null;
    return value ? normalizeRules(value) : { field: '', keywords: [], exclude: [], venues: [], years: 2 };
  } catch {
    return { field: '', keywords: [], exclude: [], venues: [], years: 2 };
  }
}

function readCache(rules: DailyRecommendationRules): DailyCache | null {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as DailyCache | null;
    return value?.day === dayKey() && value.rulesKey === rulesKey(rules) && Array.isArray(value.papers) ? value : null;
  } catch {
    return null;
  }
}

export function DailyRecommendations({ documents, onReload, embedded = false, onVisibleCountChange }: { documents: DocumentSummary[]; onReload: () => void; embedded?: boolean; onVisibleCountChange?: (count: number) => void }) {
  const [rules, setRules] = useState(readRules);
  const [draft, setDraft] = useState(() => draftFromRules(readRules()));
  const [rulesOpen, setRulesOpen] = useState(() => !hasSearchRules(readRules()));
  const [papers, setPapers] = useState<DailyRecommendation[]>(() => readCache(readRules())?.papers ?? []);
  const [fetchedAt, setFetchedAt] = useState(() => readCache(readRules())?.fetchedAt ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState('');
  const [progress, setProgress] = useState('');
  const loaded = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const configured = hasSearchRules(rules);
  const load = async (force = false, activeRules = rules) => {
    if (loading) return;
    if (!hasSearchRules(activeRules)) {
      setError('请先设置研究领域或检索词');
      return;
    }
    const cached = readCache(activeRules);
    if (!force && cached) {
      setPapers(cached.papers);
      setFetchedAt(cached.fetchedAt);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await api.dailyRecommendations(activeRules);
      setPapers(result.papers);
      setFetchedAt(result.fetchedAt);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ day: dayKey(), rulesKey: rulesKey(activeRules), ...result } satisfies DailyCache)); } catch { /* Private browsing may disable storage. */ }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    if (configured && !readCache(rules)) void load();
  }, []);

  useEffect(() => () => {
    // 收起侧栏会卸载本组件：必须中止仍在跑的下载/导入，否则它会继续跑满服务端允许的
    // 30 分钟，并在卸载后 setState，用户也再找不到「取消导入」按钮。
    controller.current?.abort();
    controller.current = null;
  }, []);

  const visible = useMemo(() => {
    const titles = new Set(documents.map((doc) => normalizedTitle(doc.title)));
    const dois = new Set(documents.map((doc) => doc.doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, '')));
    return papers.filter((paper) => !titles.has(normalizedTitle(paper.title)) && (!paper.doi || !dois.has(paper.doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, '')))).slice(0, 5);
  }, [documents, papers]);

  useEffect(() => {
    onVisibleCountChange?.(visible.length);
  }, [visible.length, onVisibleCountChange]);

  const saveRules = () => {
    const next = normalizeRules(draft);
    setRules(next);
    setDraft(draftFromRules(next));
    setRulesOpen(false);
    setPapers([]);
    setFetchedAt('');
    setError('');
    try { localStorage.setItem(RULES_KEY, JSON.stringify(next)); } catch { /* Private browsing may disable storage. */ }
    if (!hasSearchRules(next)) {
      setError('请填写研究领域或至少一个检索词');
      setRulesOpen(true);
      return;
    }
    void load(true, next);
  };

  /** 推荐论文下载后走 ReadX 的本地 OCR、翻译与排版流程。 */
  const importPaper = async (paper: DailyRecommendation) => {
    if (!paper.pdfUrl) return;
    // 同一个按钮兼任取消：一次导入要跑完识别＋全文翻译，必须能中途停下。
    if (importing === paper.id) {
      controller.current?.abort();
      return;
    }
    if (importing) return;
    const current = new AbortController();
    controller.current = current;
    setImporting(paper.id);
    setProgress(`正在下载：${paper.title}`);
    try {
      const downloaded = await api.downloadPublication(paper.pdfUrl, paper.title, current.signal, (received, total) => {
        setProgress(total > 0 ? `正在下载：${Math.round((received / total) * 100)}%` : `正在下载：${Math.round(received / 1048576)} MB`);
      });
      setProgress('正在交给 LeePDF 处理全文…');
      const hint = {
        title: paper.title,
        author: paper.authors.join(', '),
        authors: paper.authors,
        venue: paper.venue,
        year: paper.year,
        doi: paper.doi,
        arxiv: paper.arxiv ?? '',
        firstPage: '',
        source: downloaded.source,
      };
      const result = await api.upload([downloaded.file], current.signal, [hint], (event) => {
        if (event.progress?.message) setProgress(event.progress.message);
      });
      const failed = result.results.find((item) => item.error);
      if (failed?.error) throw new Error(failed.error);
      const imported = result.results[0];
      setProgress(
        imported?.existing
          ? '论文已在书库中，译文已就绪'
          : `已导入书库：LeePDF 译文已保存${imported?.warning ? `（${imported.warning}）` : ''}`,
      );
      onReload();
    } catch (cause) {
      setProgress(
        current.signal.aborted
          ? '已取消导入；已经完成的部分保留在书库'
          : cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      if (controller.current === current) controller.current = null;
      setImporting('');
    }
  };

  return (
    // 侧栏里由外层提供卡片外观与滚动，这里只要一列铺满高度；嵌在列表里时仍是原来的卡片。
    <section className={embedded ? 'recommendations embedded flex h-full min-h-0 flex-col' : 'recommendations mb-4 rounded-xl border border-line bg-surface p-3'}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          {!embedded ? <h2 className="text-sm font-semibold text-ink">每日论文推荐</h2> : null}
          <p className="m-0 text-xs text-ink-faint">{configured ? `按「${rules.field || rules.keywords[0]}」推荐近 ${rules.years} 年论文${rules.venues.length ? ` · ${rules.venues.join('、')}` : ' · 不限来源'}` : '设置研究领域与关键词以发现相关论文'}</p>
        </div>
        {fetchedAt ? <span className="text-xs text-ink-faint num">{fetchedAt.slice(0, 16).replace('T', ' ')}</span> : null}
        <button type="button" onClick={() => { setDraft(draftFromRules(rules)); setRulesOpen((value) => !value); }} className="rx-btn sm ghost">规则</button>
        {configured ? <button type="button" onClick={() => void load(true)} disabled={loading} className="rx-btn sm secondary">{loading ? '检索中…' : '刷新'}</button> : null}
      </div>
      {rulesOpen ? (
        <div className="mt-3 grid gap-2.5 rounded-lg border border-line bg-surface-sunk p-3">
          <label className="grid gap-1 text-xs text-ink-soft">研究领域
            <input value={draft.field} onChange={(event) => setDraft((value) => ({ ...value, field: event.target.value }))} placeholder="例如：计算机视觉、医学影像重建" className="rx-field-control text-xs" />
          </label>
          <label className="grid gap-1 text-xs text-ink-soft">检索词（每行一个，任一命中即可）
            <textarea value={draft.keywords} onChange={(event) => setDraft((value) => ({ ...value, keywords: event.target.value }))} rows={3} placeholder={'例如：\nobject detection\nvision-language model\nmedical image segmentation'} className="resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-xs text-ink" />
          </label>
          <label className="grid gap-1 text-xs text-ink-soft">排除词（可选，每行一个）
            <textarea value={draft.exclude} onChange={(event) => setDraft((value) => ({ ...value, exclude: event.target.value }))} rows={2} placeholder="例如：survey、editorial" className="resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-xs text-ink" />
          </label>
          <label className="grid gap-1 text-xs text-ink-soft">限定会议 / 期刊（可选；留空不限来源）
            <textarea value={draft.venues} onChange={(event) => setDraft((value) => ({ ...value, venues: event.target.value }))} rows={2} placeholder={'例如：\nCVPR\nIEEE TMI'} className="resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-xs text-ink" />
          </label>
          <label className="flex items-center justify-between gap-2 text-xs text-ink-soft">检索时间范围
            <select value={draft.years} onChange={(event) => setDraft((value) => ({ ...value, years: Number(event.target.value) }))} className="rx-field-control h-8 text-xs">
              {[1, 2, 3, 5].map((year) => <option key={year} value={year}>近 {year} 年</option>)}
            </select>
          </label>
          <button type="button" onClick={saveRules} disabled={loading} className="rx-btn primary justify-center">保存规则并检索</button>
        </div>
      ) : null}
      {loading && !papers.length ? <p role="status" className="mt-3 text-xs text-ink-soft">正在按自定义规则检索论文…</p> : null}
      {error ? <p role="status" className="mt-3 text-xs text-bad">{error}</p> : null}
      {!configured && !rulesOpen ? <p className="mt-3 text-xs text-ink-soft">先设置研究领域和检索词，再查看匹配论文。</p> : null}
      {!loading && configured && !error && visible.length === 0 ? <p className="mt-3 text-xs text-ink-soft">当前规则下没有未入库的匹配论文。</p> : null}
      {progress ? <p role="status" className="mt-2 text-xs text-accent">{progress}</p> : null}
      <div className={`mt-2.5 grid gap-2.5${embedded ? '' : ' xl:grid-cols-2'}`}>
        {visible.map((paper) => (
          <article key={paper.id} className="rx-rec">
            <span className="rx-rec-venue">{paper.venue || '推荐'}{paper.year ? ` ${paper.year}` : ''}</span>
            <h5>{paper.title}</h5>
            <p>{paper.authors.slice(0, 4).join(', ')}{paper.authors.length > 4 ? ' 等' : ''}</p>
            {paper.abstract ? <p className="mt-1 line-clamp-3">{paper.abstract}</p> : null}
            <div className="rx-rec-acts">
              {paper.pdfUrl ? (
                <button
                  type="button"
                  onClick={() => void importPaper(paper)}
                  disabled={Boolean(importing) && importing !== paper.id}
                  title="与本地导入同一条管线：下载后 AI 识别题录并翻译全文，再入库"
                  className="rx-btn sm secondary"
                >
                  {importing === paper.id ? '取消导入' : '+ 加入书库'}
                </button>
              ) : null}
              {paper.url ? <a href={paper.url} target="_blank" rel="noreferrer" className="rx-btn sm ghost no-underline">原文链接 ↗</a> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
