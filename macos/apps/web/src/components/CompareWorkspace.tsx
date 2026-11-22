import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { ReadingField } from '../hooks/useReadings';
import { STORAGE_KEYS } from '../lib/storage';

/**
 * 跨文献对照：把 2–4 篇论文的「实验配置」精读抽取并排成一张表。
 *
 * 为什么用它而不是新造一套抽取 schema：
 *   库里已经有七个分组（研究对象与数据 / 研究设计与条件 / 实施流程 / 分析方法 /
 *   对照或基线 / 评价标准 / 结果）的抽取，每个字段都带页码与逐字依据，并且由
 *   internal/validate 校验过「论文明说未提及」与「证据必须能在原文里找到」。
 *   再发明一套只会得到两份会互相漂移的数据。
 *
 * 三种状态必须分开显示，这是这张表最容易骗人的地方：
 *   未抽取  —— 这篇还没生成实验配置，表格里不能写成「未提及」；
 *   未提及  —— 抽取结果里明确写了「论文未说明」这类断言；
 *   有内容  —— 给出字段与页码，可点回原文核对。
 */

const GROUPS = [
  { id: 'dataset', label: '研究对象与数据' },
  { id: 'acquisition', label: '研究设计与条件' },
  { id: 'training', label: '实施流程' },
  { id: 'loss', label: '分析方法' },
  { id: 'baselines', label: '对照或基线' },
  { id: 'metrics', label: '评价标准' },
  { id: 'results', label: '结果' },
] as const;

const MAX_PAPERS = 4;
const SELECTION_KEY = STORAGE_KEYS.compareSelection;

function readSelection(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((key): key is string => typeof key === 'string'))].slice(0, MAX_PAPERS) : [];
  } catch {
    return [];
  }
}

/** 抽取结果里的「明说没有」断言：与后端 UnknownValues 同一批词。 */
const UNKNOWN_VALUES = new Set([
  '当前文本无法核实', '论文未说明', '论文中未说明', '论文中未找到', '未报告', '论文未报告',
  '论文未提及', '未提及', '原文未说明', '文中未提及', '论文中没有说明',
]);

type CardPhase =
  | { kind: 'loading' }
  | { kind: 'ready'; groups: Record<string, ReadingField[]>; updatedAt?: string }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

function parseExperimentCard(value: string): Record<string, ReadingField[]> | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || !GROUPS.some((group) => Array.isArray(parsed[group.id]))) return null;
    const out: Record<string, ReadingField[]> = {};
    for (const group of GROUPS) {
      const raw = parsed[group.id];
      if (!Array.isArray(raw)) {
        out[group.id] = [];
        continue;
      }
      out[group.id] = raw.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        const k = typeof record.k === 'string' ? record.k : '';
        const v = typeof record.v === 'string' ? record.v : '';
        if (!k && !v) return [];
        const field: ReadingField = { k, v };
        if (typeof record.page === 'number') field.page = record.page;
        if (typeof record.excerpt === 'string') field.excerpt = record.excerpt;
        return [field];
      });
    }
    return out;
  } catch {
    return null;
  }
}

interface Props {
  documents: { id: string; key: string; title: string; year?: number | null }[];
  onBack?: () => void;
  /** 打开某篇的某一页（点单元格里的页码回原文核对）。 */
  onOpenAtPage: (key: string, page: number, query: string) => void;
  onOpenDocument: (id: string) => void;
}

export function CompareWorkspace({ documents, onBack, onOpenAtPage, onOpenDocument }: Props) {
  const [selected, setSelected] = useState<string[]>(readSelection);
  const [cards, setCards] = useState<Record<string, CardPhase>>({});
  const [filter, setFilter] = useState('');
  const [generating, setGenerating] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [jobRevision, setJobRevision] = useState(0);
  const submitting = useRef(new Set<string>());

  useEffect(() => {
    try { localStorage.setItem(SELECTION_KEY, JSON.stringify(selected)); } catch { /* Keep the session selection when storage is unavailable. */ }
  }, [selected]);

  useEffect(() => {
    if (!documents.length) return;
    const known = new Set(documents.map((doc) => doc.key));
    setSelected((current) => current.every((key) => known.has(key)) ? current : current.filter((key) => known.has(key)));
  }, [documents]);

  const loadCard = useCallback(async (key: string, signal: AbortSignal) => {
    setCards((current) => current[key] ? current : { ...current, [key]: { kind: 'loading' } });
    try {
      const response = await api.readings(key, signal);
      if (signal.aborted) return;
      let groups: Record<string, ReadingField[]> | null = null;
      let updatedAt: string | undefined;
      for (const kind of ['comparisonExperiment', 'experiment', 'experimentJSON']) {
        const raw = response.entries[kind];
        const entry = typeof raw === 'string' ? { value: raw, updatedAt: '' } : raw as { value?: string; updatedAt?: string } | undefined;
        groups = typeof entry?.value === 'string' ? parseExperimentCard(entry.value) : null;
        if (groups) { updatedAt = entry?.updatedAt; break; }
      }
      setCards((current) => ({
        ...current,
        [key]: groups
          ? { kind: 'ready', groups, updatedAt }
          : { kind: 'empty' },
      }));
    } catch (cause) {
      if (signal.aborted) return;
      setCards((current) => ({
        ...current,
        [key]: { kind: 'error', message: cause instanceof Error ? cause.message : String(cause) },
      }));
    }
  }, []);

  // Leaving this page only stops polling; the server owns the generation job.
  useEffect(() => {
    const controller = new AbortController();
    const active = new Set<string>();
    let timer: number | undefined;
    const refresh = async (initial: boolean) => {
      const running = await Promise.all(selected.map(async (key) => {
        try {
          const job = await api.comparisonExperimentJob(key, controller.signal);
          if (controller.signal.aborted) return false;
          const wasActive = active.has(key);
          if (job.status === 'running') active.add(key);
          else active.delete(key);
          setGenerating((current) => {
            const next = { ...current };
            if (job.status === 'running') next[key] = `${job.message} ${job.percent}%`;
            else delete next[key];
            return next;
          });
          if (initial || (wasActive && job.status === 'completed')) await loadCard(key, controller.signal);
          if (!controller.signal.aborted && job.status === 'failed') {
            setCards((current) => ({ ...current, [key]: { kind: 'error', message: job.error || job.message } }));
          }
          return job.status === 'running';
        } catch (cause) {
          if (!controller.signal.aborted) {
            setCards((current) => ({ ...current, [key]: { kind: 'error', message: cause instanceof Error ? cause.message : String(cause) } }));
          }
          return active.has(key);
        }
      }));
      if (!controller.signal.aborted && running.some(Boolean)) timer = window.setTimeout(() => void refresh(false), 1500);
    };
    void refresh(true);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [selected, jobRevision, loadCard]);

  const toggle = (key: string) => {
    setNotice('');
    setSelected((current) => {
      if (current.includes(key)) return current.filter((item) => item !== key);
      if (current.length >= MAX_PAPERS) {
        setNotice(`最多同时对照 ${MAX_PAPERS} 篇：先取消一篇再选。`);
        return current;
      }
      return [...current, key];
    });
  };

  /** Start or reattach to one server job per paper; completed indices are reused. */
  const generate = async (key: string) => {
    if (submitting.current.has(key) || generating[key]) return;
    submitting.current.add(key);
    setGenerating((current) => ({ ...current, [key]: '正在提交后台任务…' }));
    try {
      const job = await api.startComparisonExperiment(key);
      setNotice(job.status === 'completed' ? '已载入保存的实验配置。' : '实验配置正在后台生成，切换界面后仍会继续。');
      setJobRevision((current) => current + 1);
    } catch (cause) {
      setNotice(`生成失败：${cause instanceof Error ? cause.message : String(cause)}`);
      setGenerating((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    } finally {
      submitting.current.delete(key);
    }
  };

  const visible = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return documents.filter(
      (doc) => !needle || doc.title.toLocaleLowerCase().includes(needle) || doc.key.includes(needle),
    );
  }, [documents, filter]);

  const columns = selected
    .map((key) => documents.find((doc) => doc.key === key))
    .filter((doc): doc is NonNullable<typeof doc> => Boolean(doc));

  return (
    <div className="compare-section">
      <header className="compare-header">
        <div className="compare-heading">
          {onBack ? (
            <button type="button" className="heat-back" onClick={onBack} aria-label="返回书库">←</button>
          ) : null}
          <div>
            <p className="section-eyebrow">CROSS-PAPER COMPARISON</p>
            <h1>跨文献对照</h1>
            <p className="compare-description">并排阅读实验配置，沿着证据回到原文。</p>
          </div>
        </div>
        <div className="compare-header-meta"><strong>2–4 <small>篇论文</small></strong><span>7 个对照维度 · 原文证据直达</span></div>
      </header>

      <div className="compare-body">
        <aside className="compare-picker" aria-label="选择对照论文">
          <div className="compare-picker-heading"><h2>选择论文</h2><span>{selected.length} / {MAX_PAPERS}</span></div>
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="搜索标题或论文键"
            aria-label="搜索要对照的论文"
          />
          <p className="compare-picker-hint">{visible.length} 篇论文{filter.trim() ? '符合搜索' : '可选'} · 至少选择 2 篇</p>
          <ul>
            {visible.map((doc) => {
              const checked = selected.includes(doc.key);
              return (
                <li key={doc.key}>
                  <label className={checked ? 'selected' : ''}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(doc.key)} />
                    <span className="compare-picker-copy">
                      <span className="compare-picker-title" title={doc.title}>{doc.title || doc.key}</span>
                      <span className="compare-picker-meta">{doc.year || '年份未标注'}{checked ? ' · 已加入对照' : ''}</span>
                    </span>
                    {checked ? <span className="compare-picker-order" aria-hidden="true">{selected.indexOf(doc.key) + 1}</span> : null}
                  </label>
                </li>
              );
            })}
          </ul>
          {!visible.length ? <p className="compare-picker-empty">{documents.length ? '没有找到相关论文，换个关键词试试。' : '书库中还没有论文，先返回书库导入。'}</p> : null}
          <p className="compare-picker-footer">选择后自动对照，最多同时展开 4 篇。</p>
        </aside>

        <div className="compare-main">
          <div className="compare-main-heading">
            <div><h2>对照工作台</h2><p>{columns.length >= 2 ? `${columns.length} 篇论文 · 7 个维度` : '从左侧论文列表开始选择'}</p></div>
            {selected.length ? <button type="button" className="compare-clear" onClick={() => { setSelected([]); setNotice(''); }}>清空选择</button> : null}
          </div>
          {columns.length ? <div className="compare-selected" aria-label="已选论文">{columns.map((doc, order) => (
            <button type="button" key={doc.key} onClick={() => toggle(doc.key)} aria-label={`移除对照论文：${doc.title || doc.key}`} title={doc.title || doc.key}>
              <b>{order + 1}</b><span>{doc.title || doc.key}</span><i aria-hidden="true">×</i>
            </button>
          ))}</div> : null}
          {notice ? <p className="compare-notice" role="status">{notice}</p> : null}

          {columns.length < 2 ? (
            <section className="compare-empty" aria-label="开始文献对照">
              <svg className="compare-empty-icon" viewBox="0 0 80 64" fill="none" aria-hidden="true"><rect x="6" y="6" width="29" height="48" rx="5" /><rect x="45" y="10" width="29" height="48" rx="5" /><path d="M14 19h13M14 27h13M14 35h8M53 23h13M53 31h13M53 39h8M35 32h10m-6-4 4 4-4 4" /></svg>
              <h3>{columns.length ? '再选一篇，就能开始对照' : '把论文放在一起看'}</h3>
              <p>选择 2–4 篇论文，并排梳理研究设计、实验配置与结果。<br />每个字段的页码都能带你回到原文。</p>
              <div className="compare-dimensions"><span>对照涵盖</span><div>{GROUPS.map((group) => <span key={group.id}>{group.label}</span>)}</div></div>
              <small>已有的实验配置会直接载入，未抽取的论文可在表格中生成。</small>
            </section>
          ) : (
            <div className="compare-scroll">
              <table className="compare-table" style={{ minWidth: `${164 + columns.length * 290}px` }}>
                <thead>
                  <tr>
                    <th scope="col">维度</th>
                    {columns.map((doc) => {
                      const phase = cards[doc.key];
                      return (
                        <th scope="col" key={doc.key}>
                          <button
                            type="button"
                            className="compare-column-title"
                            onClick={() => onOpenDocument(doc.id)}
                            title="打开这篇论文"
                          >
                            {doc.title || doc.key}
                          </button>
                          {generating[doc.key] ? (
                            <span className="compare-chip">后台生成中</span>
                          ) : phase?.kind === 'ready' ? (
                            <span className="compare-chip ready">已抽取</span>
                          ) : phase?.kind === 'empty' ? (
                            <span className="compare-chip missing">未抽取</span>
                          ) : phase?.kind === 'error' ? (
                            <span className="compare-chip error">读取失败</span>
                          ) : (
                            <span className="compare-chip">读取中…</span>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {GROUPS.map((group) => (
                    <tr key={group.id}>
                      <th scope="row">{group.label}</th>
                      {columns.map((doc) => {
                        const phase = cards[doc.key];
                        return (
                          <td key={`${doc.key}-${group.id}`}>
                            {phase?.kind === 'ready' ? (
                              <GroupCell
                                fields={phase.groups[group.id] ?? []}
                                onCite={(page) => onOpenAtPage(doc.key, page, '')}
                              />
                            ) : phase?.kind === 'empty' ? (
                              <div className="compare-cell-actions">
                                <span className="compare-none">{generating[doc.key] ? '⏳ 后台生成中…' : '◌ 未抽取'}</span>
                                <button
                                  type="button"
                                  disabled={Boolean(generating[doc.key])}
                                  onClick={() => void generate(doc.key)}
                                >
                                  {generating[doc.key] ?? '生成实验配置'}
                                </button>
                              </div>
                            ) : phase?.kind === 'error' ? (
                              <div className="compare-cell-actions">
                                <span className="compare-none text-bad">{phase.message}</span>
                                <button type="button" disabled={Boolean(generating[doc.key])} onClick={() => void generate(doc.key)}>{generating[doc.key] || '重试生成配置'}</button>
                              </div>
                            ) : (
                              <span className="compare-none">读取中…</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {columns.length >= 2 ? (
            <details className="compare-help"><summary>数据与引用说明</summary><ul className="compare-disclosure">
              <li>数据来自各篇「精读 · 实验配置」的抽取结果：字段带页码与逐字依据，由服务端校验证据能在原文里找到。</li>
              <li>「未抽取」表示这篇还没生成实验配置，不等于论文没写；「未提及」是抽取结果里明确写下的断言。</li>
              <li>只覆盖实验配置相关的七个维度；方法公式、结果分析与代码复现是另外的精读章节，未并入此表。</li>
              <li>抽取本身可能漏字段：发现缺项请回该篇的「精读 · 实验配置」重新生成。</li>
            </ul></details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function GroupCell({ fields, onCite }: { fields: ReadingField[]; onCite: (page: number) => void }) {
  const declaredUnknown = fields.filter((field) => !field.page && UNKNOWN_VALUES.has(field.v.trim()));
  const known = fields.filter((field) => !declaredUnknown.includes(field));
  if (!fields.length) {
    return <span className="compare-none">这一组没有字段</span>;
  }
  return (
    <div className="compare-cell">
      {known.map((field, index) => (
        <div className="compare-field" key={`${field.k}-${index}`}>
          {field.k ? <span className="compare-field-key">{field.k}</span> : null}
          <span className="compare-field-value">{field.v}</span>
          {field.page ? (
            <button type="button" className="compare-page" onClick={() => onCite(field.page as number)} title="跳到原文这一页">
              P{field.page}
            </button>
          ) : null}
        </div>
      ))}
      {declaredUnknown.length ? (
        <p className="compare-declared">
          — {declaredUnknown.map((field) => field.v.trim()).join(' / ')}
        </p>
      ) : null}
    </div>
  );
}
