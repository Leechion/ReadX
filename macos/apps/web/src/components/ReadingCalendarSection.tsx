import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatBadgeLabel, isSectionFormat } from '@cbct/shared';
import type { CalendarDay, CalendarPaper, CalendarResponse, StatsResponse, TrendsResponse } from '../api/client';
import { api } from '../api/client';
import type { WorkspacePhase } from '../hooks/useWorkspace';
import { Icon } from './ui/Icon';
import { Segmented } from './ui/Primitives';
import { WorkspaceIcon } from './WorkspaceIcon';
import { LibraryStatsPanel } from './LibraryStatsPanel';

/**
 * 阅读日历 —— GitHub 贡献热力图形态（对齐 #s-cal）。
 *
 * 口径（后端 basis 字段，照实展示）：一篇论文落在它**最近一次**被阅读的那天。
 * 数据库只存最新阅读位置，没有完整流水；热力图呈现的是这份聚合结果，不采集页面停留时长。
 */

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const;
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'] as const;

const LEVELS = [0, 1, 2, 3, 4] as const;
function levelOf(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  return 4;
}

function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function todayKey(): string {
  return dayKeyOf(new Date());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** 滚动最近 52 周（从约 52 周前的周一开始，到本周周日结束）。 */
function buildRecentWeeks(): Date[][] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thisMonday = addDays(today, -((today.getDay() + 6) % 7));
  const start = addDays(thisMonday, -51 * 7);
  const end = addDays(thisMonday, 6);
  const weeks: Date[][] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 7)) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d += 1) week.push(addDays(cursor, d));
    weeks.push(week);
  }
  return weeks;
}

/** 自然年周列：从 targetYear 的第一天所在周的周一开始，到最后一天所在周的周日结束。 */
function buildYearWeeks(year: number): Date[][] {
  const first = new Date(year, 0, 1);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const last = new Date(year, 11, 31);
  const end = addDays(last, 6 - ((last.getDay() + 6) % 7));
  const weeks: Date[][] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 7)) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d += 1) week.push(addDays(cursor, d));
    weeks.push(week);
  }
  return weeks;
}

function isFuture(date: Date): boolean {
  const now = new Date();
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return a > b;
}

interface Props {
  phase: WorkspacePhase;
  onBack?: () => void;
  /** 点某篇文献 → 打开它（沿用 App 的 openDocument 通路）。 */
  onOpenDocument: (id: string) => void;
  documents: { id: string; key: string; title: string }[];
}

export function ReadingCalendarSection({ phase, onBack, onOpenDocument, documents }: Props) {
  const currentYear = new Date().getFullYear();
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rangeMode, setRangeMode] = useState<'recent' | 'year'>('recent');
  const [year, setYear] = useState(() => currentYear);
  const [selected, setSelected] = useState<string | null>(() => todayKey());
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [trends, setTrends] = useState<TrendsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.calendar();
      setData(result);
      setError(null);
      setSelected((current) => {
        if (current && result.days.some((day) => day.date === current)) return current;
        return result.days.length ? result.days[result.days.length - 1]!.date : todayKey();
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    setStatsLoading(true);
    setStatsError('');
    Promise.all([
      api.stats(controller.signal),
      api.trends(controller.signal).catch(() => null),
    ])
      .then(([value, trendValue]) => {
        setStats(value);
        setTrends(trendValue);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setStatsError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setStatsLoading(false);
      });
    return () => controller.abort();
  }, []);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarDay>();
    for (const day of data?.days ?? []) map.set(day.date, day);
    return map;
  }, [data]);

  const weeks = useMemo(
    () => (rangeMode === 'recent' ? buildRecentWeeks() : buildYearWeeks(year)),
    [rangeMode, year],
  );

  const validDayKeys = useMemo(() => {
    const set = new Set<string>();
    for (const week of weeks) {
      for (const date of week) {
        if (!isFuture(date)) set.add(dayKeyOf(date));
      }
    }
    return set;
  }, [weeks]);

  /** 月份标签：按周列对齐。 */
  const monthLabels = useMemo(() => {
    const out: { week: number; name: string }[] = [];
    weeks.forEach((week, index) => {
      const first = week.find((date) =>
        date.getDate() === 1 && (rangeMode === 'recent' || date.getFullYear() === year),
      );
      if (first) out.push({ week: index, name: MONTHS[first.getMonth()]! });
    });
    return out;
  }, [weeks, rangeMode, year]);

  const rangeTotal = useMemo(
    () =>
      (data?.days ?? [])
        .filter((day) => (rangeMode === 'recent' ? validDayKeys.has(day.date) : day.date.startsWith(String(year))))
        .reduce((sum, day) => sum + day.count, 0),
    [data, rangeMode, validDayKeys, year],
  );

  const activeDays = useMemo(
    () =>
      (data?.days ?? []).filter((day) =>
        rangeMode === 'recent' ? validDayKeys.has(day.date) : day.date.startsWith(String(year)),
      ).length,
    [data, rangeMode, validDayKeys, year],
  );

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const today = node.querySelector('.heat-cell.today');
    if (today) {
      const target = today as HTMLElement;
      node.scrollTo({ left: Math.max(0, target.offsetLeft - node.clientWidth / 2), behavior: 'auto' });
    }
  }, [rangeMode, year]);

  const selectedDay = selected ? byDate.get(selected) ?? null : null;
  const idByKey = useMemo(() => new Map(documents.map((doc) => [doc.key, doc.id])), [documents]);

  const openPaper = (paper: CalendarPaper) => {
    const id = idByKey.get(paper.key);
    if (id) onOpenDocument(id);
  };

  return (
    <div className="heat-section">
      <header className="rx-topbar">
        {onBack ? (
          <button
            type="button"
            className="rx-btn rx-btn-icon rx-btn-ghost"
            onClick={onBack}
            aria-label="返回书库"
            title="返回书库"
          >
            <Icon name="left" size={14} />
          </button>
        ) : null}
        <h1 className="rx-topbar-title">阅读日历</h1>

        <Segmented<'recent' | 'year'>
          ariaLabel="阅读日历范围"
          value={rangeMode}
          onChange={setRangeMode}
          options={[
            { value: 'recent', label: '近一年' },
            { value: 'year', label: String(year) },
          ]}
        />

        {rangeMode === 'year' ? (
          <div className="heat-year-nav" role="group" aria-label="切换年份">
            <button
              type="button"
              className="rx-btn rx-btn-icon rx-btn-ghost"
              title="上一年"
              aria-label="上一年"
              onClick={() => setYear((v) => v - 1)}
            >
              ‹
            </button>
            <button
              type="button"
              className="rx-btn rx-btn-icon rx-btn-ghost"
              title="下一年"
              aria-label="下一年"
              disabled={year >= currentYear}
              onClick={() => setYear((v) => v + 1)}
            >
              ›
            </button>
          </div>
        ) : null}

        <div className="rx-topbar-spacer" />
        <span className="rx-cal-notice">不统计阅读时长：页面停留时间没有采集</span>
      </header>

      {error ? <p className="heat-banner">{error}</p> : null}

      <div className="heat-body">
        <div className="rx-cal-body">
          {/* 顶行 KPI：#s-cal .statline + .vr */}
          <div className="rx-statline" aria-label="阅读记录概览">
            <div>
              <b>{stats ? stats.library.active : '—'}</b>
              <span>在库</span>
            </div>
            <div className="vr" />
            <div>
              <b>{stats ? stats.library.reading : '—'}</b>
              <span>在读</span>
            </div>
            <div className="vr" />
            <div>
              <b>{stats ? stats.library.done : '—'}</b>
              <span>已精读</span>
            </div>
            <div className="vr" />
            <div>
              <b>{stats ? stats.reading.activeMonth : (data ? rangeTotal : '—')}</b>
              <span>最近 30 天读过的论文</span>
            </div>
            <div className="vr" />
            <div>
              <b>{stats ? stats.reading.annotations : '—'}</b>
              <span>批注与笔记</span>
            </div>
          </div>

          {/* 平铺 5 级热力图 */}
          <section className="heat-block" aria-label="阅读热力图">
            <h4 className="rx-cal-h4">
              <span>{rangeMode === 'recent' ? '近一年每天打开过的论文' : `${year} 年每天打开过的论文`}</span>
              <span className="rx-cal-sub">
                {data ? `共 ${rangeTotal} 篇 · 活跃 ${activeDays} 天 · 点击日期查看清单` : '加载中…'}
              </span>
            </h4>

            <div className="heat-scroll" ref={scrollRef}>
              <div className="heat-table">
                <div className="heat-months" style={{ gridTemplateColumns: `repeat(${weeks.length}, var(--heat-cell-size))` }}>
                  {monthLabels.map((item) => (
                    <span key={`${item.week}-${item.name}`} className="heat-month" style={{ gridColumn: item.week + 1 }}>
                      {item.name}
                    </span>
                  ))}
                </div>
                <div className="heat-grid-row">
                  <div className="heat-weekdays">
                    {WEEKDAYS.map((name, index) => (
                      <span key={name} className="heat-weekday" style={{ gridRow: index + 1 }}>
                        {index % 2 === 0 ? name : ''}
                      </span>
                    ))}
                  </div>
                  <div className="heat-grid" style={{ gridTemplateColumns: `repeat(${weeks.length}, var(--heat-cell-size))` }}>
                    {weeks.map((week, weekIndex) =>
                      week.map((date, dayIndex) => {
                        const key = dayKeyOf(date);
                        if (isFuture(date)) {
                          return <span key={key} className="heat-cell future" style={{ gridColumn: weekIndex + 1, gridRow: dayIndex + 1 }} />;
                        }
                        const day = byDate.get(key);
                        const level = levelOf(day?.count ?? 0);
                        const isSelected = key === selected;
                        const isToday = key === todayKey();
                        return (
                          <button
                            key={key}
                            type="button"
                            className={[
                              'heat-cell',
                              `l${level}`,
                              isSelected ? 'selected' : '',
                              isToday ? 'today' : '',
                            ].filter(Boolean).join(' ')}
                            style={{ gridColumn: weekIndex + 1, gridRow: dayIndex + 1 }}
                            onClick={() => setSelected(key)}
                            title={`${key} · 读了 ${day?.count ?? 0} 篇`}
                            aria-label={`${key}，${day?.count ?? 0} 篇`}
                            aria-pressed={isSelected}
                          />
                        );
                      }),
                    )}
                  </div>
                </div>

                <div className="heat-legend">
                  <span>少</span>
                  {LEVELS.map((level) => (
                    <span key={level} className={`heat-cell l${level} static`} />
                  ))}
                  <span>多</span>
                  <span className="heat-legend-note">· 每格是一天打开过的论文数</span>
                </div>
              </div>
            </div>
          </section>

          {/* 选中日期的论文清单 */}
          <section className="heat-detail" aria-label="当日阅读清单">
            <div className="heat-detail-head">
              <h2>{formatDayTitle(selected)}</h2>
              {selectedDay ? <span className="rx-cal-sub">{selectedDay.count} 篇</span> : null}
            </div>
            {selectedDay ? (
              <ul className="heat-papers">
                {selectedDay.papers.map((paper) => (
                  <li key={paper.key}>
                    <button
                      type="button"
                      className="heat-paper"
                      disabled={!idByKey.get(paper.key)}
                      onClick={() => openPaper(paper)}
                      title={idByKey.get(paper.key) ? '打开这篇文献' : '书库里没有这篇文献'}
                    >
                      <span className="heat-paper-icon"><WorkspaceIcon name="file" size={16} /></span>
                      <span className="heat-paper-body">
                        <span className="heat-paper-title">{paper.title || paper.key}</span>
                        <span className="heat-paper-meta">
                          {new Date(paper.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                          {' · '}
                          {isSectionFormat(paper.format) ? formatBadgeLabel(paper.format) : `第 ${paper.page || 1} 页`}
                          {paper.hasReading ? ' · 精读' : ''}
                          {paper.hasAnnotation ? ' · 批注' : ''}
                        </span>
                      </span>
                      <WorkspaceIcon name="arrow" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="heat-detail-empty">这一天没有阅读记录。</p>
            )}
          </section>

          <p className="rx-src" style={{ marginTop: -12 }}>
            {data?.basis || `口径说明：每篇论文按最近一次阅读的时间归入当天（全部年份累计 ${data?.totalPapers ?? 0} 篇），非逐日完整流水。`}
          </p>

          <LibraryStatsPanel stats={stats} trends={trends} loading={statsLoading} error={statsError} />

          {phase.kind !== 'ready' ? <p className="rx-src">书库尚未就绪。</p> : null}
        </div>
      </div>
    </div>
  );
}

function formatDayTitle(date: string | null): string {
  if (!date) return '选择一天';
  const [y, m, d] = date.split('-').map(Number);
  const weekday = WEEKDAYS[(new Date(y!, m! - 1, d!).getDay() + 6) % 7];
  return `${m} 月 ${d} 日 · 周${weekday}`;
}
