import { useEffect, useState } from 'react';
import { api, type StatsResponse, type TrendsResponse } from '../api/client';

interface LibraryStatsPanelProps {
  stats?: StatsResponse | null;
  trends?: TrendsResponse | null;
  loading?: boolean;
  error?: string;
}

/** 书库统计面板（#s-cal 下半区：处理耗时 + 书库分布，使用水平条形对比）。 */
export function LibraryStatsPanel({
  stats: statsProp,
  trends: trendsProp,
  loading: loadingProp,
  error: errorProp,
}: LibraryStatsPanelProps = {}) {
  const controlled = statsProp !== undefined || loadingProp !== undefined;
  const [localStats, setLocalStats] = useState<StatsResponse | null>(null);
  const [localTrends, setLocalTrends] = useState<TrendsResponse | null>(null);
  const [localError, setLocalError] = useState('');
  const [localLoading, setLocalLoading] = useState(!controlled);

  useEffect(() => {
    if (controlled) return;
    const controller = new AbortController();
    setLocalLoading(true);
    setLocalError('');
    Promise.all([
      api.stats(controller.signal),
      api.trends(controller.signal).catch(() => null),
    ])
      .then(([value, trendValue]) => {
        setLocalStats(value);
        setLocalTrends(trendValue);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setLocalError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLocalLoading(false);
      });
    return () => controller.abort();
  }, [controlled]);

  const stats = controlled ? (statsProp ?? null) : localStats;
  const trends = controlled ? (trendsProp ?? null) : localTrends;
  const loading = controlled ? Boolean(loadingProp) : localLoading;
  const error = controlled ? (errorProp ?? '') : localError;

  if (loading && !stats) return <p className="rx-src" role="status">读取统计…</p>;
  if (error && !stats) return <p className="rx-src text-bad" role="alert">{error}</p>;
  if (!stats) return null;

  const { library, reading, processing, distribution } = stats;
  const supported = (trends?.findings ?? []).filter((item) => item.IsSupported).slice(0, 6);
  const unsupported = (trends?.findings ?? []).filter((item) => !item.IsSupported);

  // 处理耗时：优先用单页平均耗时，缺失时退回中位耗时。
  const stageMetrics = processing.stages.map((stage) => {
    const ms = stage.perPageMs ?? stage.medianMs;
    return {
      key: stage.key,
      label: stage.label || stage.key,
      ms,
      display: stage.perPageMs != null ? `${formatRate(stage.perPageMs)}/页` : formatDuration(stage.medianMs),
      runs: stage.runs,
    };
  });
  const maxStageMs = stageMetrics.reduce((acc, s) => Math.max(acc, s.ms), 0);

  // 书库分布：优先按书架分类，若没有书架则展示年份分布。
  const distItems = distribution.shelves.length ? distribution.shelves : distribution.years;
  const topDist = distItems.slice(0, 6);
  const maxDistCount = topDist.reduce((acc, item) => Math.max(acc, item.count), 0);

  return (
    <section className="rx-cal-two" aria-label="书库与处理统计">
      <div className="rx-cal-col">
        <h4 className="rx-cal-h4">处理耗时（中位 / 单页）</h4>
        {stageMetrics.length ? (
          <div>
            {stageMetrics.map((stage) => {
              const ratio = maxStageMs > 0 ? Math.max(0.06, stage.ms / maxStageMs) : 0;
              const isMax = maxStageMs > 0 && stage.ms === maxStageMs;
              return (
                <div key={stage.key} className={`rx-hbar${isMax ? ' hi' : ''}`} title={`共运行 ${stage.runs} 次`}>
                  <span className="rx-hbar-name">{stage.label}</span>
                  <div className="tr"><i style={{ width: `${ratio * 100}%` }} /></div>
                  <span className="v">{stage.display}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="rx-cal-empty">还没有带时间戳的处理记录。</p>
        )}
        <div className="rx-cal-foot-meta">
          <span>精读记录 <b>{reading.readingNotes}</b> 篇</span>
          <span>正文索引 <b>{reading.indexedDocuments}</b> 篇 · <b>{reading.indexedPages}</b> 页</span>
          <span>收藏 <b>{library.favorite}</b> · 回收站 <b>{library.trashed}</b></span>
        </div>
      </div>

      <div className="rx-cal-col">
        <h4 className="rx-cal-h4">
          {distribution.shelves.length ? '书架分类分布' : '发表年份分布'}
        </h4>
        {topDist.length ? (
          <div>
            {topDist.map((item) => {
              const ratio = maxDistCount > 0 ? Math.max(0.06, item.count / maxDistCount) : 0;
              const isMax = maxDistCount > 0 && item.count === maxDistCount;
              return (
                <div key={item.name} className={`rx-hbar${isMax ? ' hi' : ''}`}>
                  <span className="rx-hbar-name">{item.name}</span>
                  <div className="tr"><i style={{ width: `${ratio * 100}%` }} /></div>
                  <span className="v">{item.count} 篇</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="rx-cal-empty">书库里还没有分类统计数据。</p>
        )}
        <p className="rx-src">
          来源：共 {library.shelves} 个书架，当前展示样本量最大的 {topDist.length} 组。
        </p>

        {supported.length ? (
          <ul className="rx-cal-findings" aria-label="题录关键词趋势">
            {supported.map((item) => (
              <li key={item.Topic}>
                <strong>{item.Claim}</strong>
                <span>{item.Caveat}</span>
              </li>
            ))}
            {unsupported.length ? (
              <li className="rx-src" style={{ borderTop: 0, paddingTop: 2 }}>
                另有 {unsupported.length} 个主题样本不足 {trends?.minimum ?? 5} 篇，未在此列出。
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function formatRate(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
}

/** 秒级以下不显示小数：处理耗时看的是量级。 */
function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)} 分`;
  return `${(minutes / 60).toFixed(1)} 小时`;
}
