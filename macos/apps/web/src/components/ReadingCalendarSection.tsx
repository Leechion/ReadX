import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatBadgeLabel, isSectionFormat } from '@cbct/shared';
import type { CalendarDay, CalendarPaper, CalendarResponse } from '../api/client';
import { api } from '../api/client';
import type { WorkspacePhase } from '../hooks/useWorkspace';
import { WorkspaceIcon } from './WorkspaceIcon';
import { LibraryStatsPanel } from './LibraryStatsPanel';

/**
 * 阅读日历 —— GitHub 贡献热力图形态。
 *
 * 结构：列=周（Mon 起头），行=周一..周日；格子颜色深浅编码「该天读了多少篇」。
 * 与 GitHub 一致的做法：全年一张图、横向滚动、月份标在顶部按列对齐、
 * 悬停给出当天摘要，点某天在右侧看论文清单并可跳回文献。
 *
 * 口径（后端 basis 字段，照实展示）：一篇论文落在它**最近一次**被阅读的那天。
 * 数据库只存最新阅读位置，没有完整流水；热力图呈现的是这份聚合结果，
 * 不假装它是精确历史。
 */

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const;
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'] as const;

/** 颜色档位（与 GitHub 相同的 5 档思路）：0 / 1 / 2 / 3 / ≥4 篇。 */
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

/**
 * 热力图的周列：从 targetYear 的第一天所在周的周一开始，
 * 到 targetYear 最后一天所在周的周日结束（与 GitHub 全年图一致）。
 */
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

/** 未来不画：GitHub 也会把今天之后的格子留白。 */
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
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [selected, setSelected] = useState<string | null>(() => todayKey());
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.calendar();
      setData(result);
      setError(null);
      // 默认选中最近有阅读的一天；没有就选今天。
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

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarDay>();
    for (const day of data?.days ?? []) map.set(day.date, day);
    return map;
  }, [data]);

  const weeks = useMemo(() => buildYearWeeks(year), [year]);

  /** 月份标签：按列对齐（这一列里出现该月的第一天就标一次，与 GitHub 相同）。 */
  const monthLabels = useMemo(() => {
    const out: { week: number; name: string }[] = [];
    weeks.forEach((week, index) => {
      const first = week.find(date => date.getFullYear() === year && date.getDate() === 1);
      if (first) out.push({ week: index, name: MONTHS[first.getMonth()]! });
    });
    return out;
  }, [weeks, year]);

  /** 年度汇总：GitHub 图右上角的「N 篇 in X」。 */
  const yearTotal = useMemo(
    () =>
      (data?.days ?? [])
        .filter((day) => day.date.startsWith(String(year)))
        .reduce((sum, day) => sum + day.count, 0),
    [data, year],
  );
  const activeDays = useMemo(
    () => (data?.days ?? []).filter((day) => day.date.startsWith(String(year))).length,
    [data, year],
  );

  /** 今天在图里滚动到可视区（挂载后一次性）。 */
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const today = node.querySelector('.heat-cell.today');
    if (today) {
      const target = today as HTMLElement;
      node.scrollTo({ left: Math.max(0, target.offsetLeft - node.clientWidth / 2), behavior: 'auto' });
    }
  }, [year]);

  const selectedDay = selected ? byDate.get(selected) ?? null : null;
  const idByKey = useMemo(() => new Map(documents.map((doc) => [doc.key, doc.id])), [documents]);

  /** 点格子：选中当天；点文献：打开。 */
  const openPaper = (paper: CalendarPaper) => {
    const id = idByKey.get(paper.key);
    if (id) onOpenDocument(id);
  };

  return (
    <div className="heat-section">
      <header className="heat-toolbar">
        <div className="heat-heading">
          {onBack ? (
            <button type="button" className="heat-back" onClick={onBack} aria-label="返回书库">←</button>
          ) : null}
          <div><p className="section-eyebrow">READING ACTIVITY</p><h1>阅读日历</h1><p className="library-description">回看阅读足迹，找到下一条研究线索。</p></div>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" className="heat-nav" title="上一年" onClick={() => setYear((value) => value - 1)}>‹</button>
          <span className="heat-year">{year}</span>
          <button
            type="button"
            className="heat-nav"
            title="下一年"
            disabled={year >= new Date().getFullYear()}
            onClick={() => setYear((value) => value + 1)}
          >
            ›
          </button>
        </div>
      </header>

      {error ? <p className="heat-banner">{error}</p> : null}

      <div className="heat-body">
        <div className="heat-main">
          <div className="heat-metrics" aria-label="阅读记录概览">
            <div><WorkspaceIcon name="file" /><strong>{data ? yearTotal : '—'}<small>篇</small></strong><span>{year} 年覆盖文献</span></div>
            <div><WorkspaceIcon name="calendar" /><strong>{data ? activeDays : '—'}<small>天</small></strong><span>当年有阅读记录</span></div>
            <div><WorkspaceIcon name="library" /><strong>{data ? data.totalPapers : '—'}<small>篇</small></strong><span>全部年份覆盖文献</span></div>
          </div>
          <div className="heat-card">
            <div className="heat-summary">
              <h2>年度阅读分布</h2>
              <span>每个格子代表一天 · 每篇计入最近一次阅读当天</span>
            </div>

            <div className="heat-scroll" ref={scrollRef}>
              <div className="heat-table">
                {/* 月份行：按周列对齐 */}
                <div className="heat-months" style={{ gridTemplateColumns: `repeat(${weeks.length}, var(--heat-cell-size))` }}>
                  {monthLabels.map((item) => (
                    <span key={`${item.week}-${item.name}`} className="heat-month" style={{ gridColumn: item.week + 1 }}>
                      {item.name}
                    </span>
                  ))}
                </div>
                <div className="heat-grid-row">
                  {/* 星期标签列 */}
                  <div className="heat-weekdays">
                    {WEEKDAYS.map((name, index) => (
                      <span key={name} className="heat-weekday" style={{ gridRow: index + 1 }}>
                        {index % 2 === 0 ? name : ''}
                      </span>
                    ))}
                  </div>
                  {/* 格子：列=周，行=星期 */}
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
                              isSelected ? ' selected' : '',
                              isToday ? ' today' : '',
                            ].join(' ')}
                            style={{ gridColumn: weekIndex + 1, gridRow: dayIndex + 1 }}
                            onClick={() => setSelected(key)}
                            title={`${key} · 读了 ${day?.count ?? 0} 篇`}
                            aria-label={`${key}，${day?.count ?? 0} 篇`}
                            aria-pressed={isSelected}
                          >
                            <span className="heat-cell-dot" />
                          </button>
                        );
                      }),
                    )}
                  </div>
                </div>
                {/* 图例 */}
                <div className="heat-legend">
                  <span>少</span>
                  {LEVELS.map((level) => (
                    <span key={level} className={`heat-cell l${level} static`}>
                      <span className="heat-cell-dot" />
                    </span>
                  ))}
                  <span>多</span>
                </div>
              </div>
            </div>
          </div>

          {/* 选中那天的论文清单（横排在图下方，避免右侧再竖一栏挤占热力图宽度） */}
          <div className="heat-detail">
            <div className="heat-detail-head">
              <h2>{formatDayTitle(selected)}</h2>
              {selectedDay ? <span className="text-[11px] text-ink-faint">{selectedDay.count} 篇</span> : null}
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
                      <span className="heat-paper-icon"><WorkspaceIcon name="file" size={22} /></span>
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
                      <WorkspaceIcon name="arrow" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11.5px] text-ink-faint">这一天没有阅读记录。</p>
            )}
          </div>
          <p className="heat-basis">{data?.basis || '按每篇论文最近一次阅读的时间归入当天；这里展示最新阅读位置快照，并非完整历史。'}</p>
          {/* 日历回答「哪天读了什么」，统计回答「整体读了多少、处理花了多久」。 */}
          <LibraryStatsPanel />
        </div>
      </div>
      {phase.kind !== 'ready' ? <p className="heat-basis">书库尚未就绪。</p> : null}
    </div>
  );
}

function formatDayTitle(date: string | null): string {
  if (!date) return '选择一天';
  const [y, m, d] = date.split('-').map(Number);
  const weekday = WEEKDAYS[(new Date(y!, m! - 1, d!).getDay() + 6) % 7];
  return `${m} 月 ${d} 日 · 周${weekday}`;
}
