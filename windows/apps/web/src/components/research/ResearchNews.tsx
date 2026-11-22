import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { api, type ResearchFeedItem } from '../../api/client';
import type { WorkbenchData } from '../../lib/researchWorkbench';
import { DailyRecommendations } from '../DailyRecommendations';
import { Icon } from '../ui/Icon';
import { Button, EmptyState, IconButton, SearchInput } from '../ui/Primitives';

type Source = 'arxiv' | 'journals' | 'weekly' | 'saved' | 'recommendations';
const sources = {
  arxiv: { label: '计算机视觉 · cs.CV', icon: 'rss' as const },
  journals: { label: '期刊 RSS 更新', icon: 'rss' as const },
  weekly: { label: '科技爱好者周刊', icon: 'rss' as const },
  recommendations: { label: '论文发现', icon: 'search' as const },
  saved: { label: '稍后阅读', icon: 'star' as const },
};

function publishedDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '';
}

export function ResearchNews({ data, setData, documents, onReload }: {
  data: WorkbenchData; setData: Dispatch<SetStateAction<WorkbenchData>>; documents: DocumentSummary[]; onReload: () => void;
}) {
  const [source, setSource] = useState<Source>('arxiv');
  const [items, setItems] = useState<ResearchFeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [fetchedAt, setFetchedAt] = useState('');
  const [translating, setTranslating] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);

  useEffect(() => {
    setError('');
    if (source === 'saved' || source === 'recommendations') { setLoading(false); return; }
    const controller = new AbortController();
    setItems([]); setLoading(true); setFetchedAt('');
    void api.researchFeed(source, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setItems(result.items); setFetchedAt(result.fetchedAt);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [source, revision]);

  const translate = async (item: ResearchFeedItem) => {
    if (translating.includes(item.id)) return;
    setTranslating(current => [...current, item.id]); setError('');
    try {
      const result = await api.translateResearchTitle(item.title);
      setData(current => ({ ...current, translations: { ...current.translations, [item.id]: result.translation } }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setTranslating(current => current.filter(id => id !== item.id)); }
  };

  const toggleSaved = (item: ResearchFeedItem) => setData(current => ({
    ...current,
    savedArticles: current.savedArticles.some(article => article.id === item.id)
      ? current.savedArticles.filter(article => article.id !== item.id)
      : [item, ...current.savedArticles],
  }));

  const markRead = (id: string) => setData(current =>
    current.readArticleIds.includes(id) ? current : { ...current, readArticleIds: [...current.readArticleIds, id] },
  );

  const list = (source === 'saved' ? data.savedArticles : items).filter(item =>
    !query.trim() || `${item.title} ${data.translations[item.id] ?? ''} ${item.summary} ${item.source}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

  return (
    <div className="rx-desk">
      <div className="rx-desk-col">
        {source === 'recommendations' ? (
          <DailyRecommendations documents={documents} onReload={onReload} />
        ) : (
          <>
            <div className="rx-desk-hd" style={{ marginBottom: 8 }}>
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder="搜索标题、摘要或关键词"
                aria-label="搜索当前资讯"
                style={{ flex: 1 }}
              />
              {source !== 'saved' ? (
                <Button variant="secondary" size="sm" disabled={loading} onClick={() => setRevision(value => value + 1)}>
                  <Icon name="sync" size={14} />
                  <span>{loading ? '更新中…' : '刷新'}</span>
                </Button>
              ) : null}
            </div>

            <div className="flex items-center justify-between text-[12px] text-ink-faint mb-2">
              <span>{sources[source].label} · <span className="tabular-nums">{loading ? '获取中' : list.length}</span> 条</span>
              {fetchedAt && source !== 'saved' ? (
                <span className="tabular-nums">更新于 {new Date(fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
              ) : null}
            </div>

            {error ? (
              <div className="rx-banner bad mb-3" role="alert">
                <Icon name="alert" size={15} />
                <span className="flex-1">{error}</span>
                {source !== 'saved' ? (
                  <Button variant="ghost" size="sm" onClick={() => setRevision(v => v + 1)}>重试</Button>
                ) : null}
              </div>
            ) : null}

            {loading ? (
              <div className="flex flex-col gap-3 py-3" aria-busy="true">
                {[0, 1, 2].map(n => <div key={n} className="rx-skel" style={{ height: 64 }} />)}
              </div>
            ) : list.length > 0 ? (
              <div className="rx-feed">
                {list.map(item => {
                  const saved = data.savedArticles.some(article => article.id === item.id);
                  const read = data.readArticleIds.includes(item.id);
                  const translated = data.translations[item.id];
                  const isTranslating = translating.includes(item.id);
                  const isExpanded = expanded.includes(item.id);

                  return (
                    <article key={item.id} className={`rx-feed-item${read ? ' read' : ''}`}>
                      <h5>
                        <a href={item.url} target="_blank" rel="noreferrer" onClick={() => markRead(item.id)}>
                          {item.title}
                        </a>
                      </h5>
                      <div className="acts">
                        <IconButton
                          size="sm"
                          icon="star"
                          label={saved ? '取消收藏' : '稍后阅读'}
                          className={saved ? 'rx-star-on' : ''}
                          aria-pressed={saved}
                          onClick={() => toggleSaved(item)}
                        />
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => markRead(item.id)}
                          aria-label="阅读原文"
                          title="阅读原文"
                          className="rx-ibtn sm"
                        >
                          <Icon name="ext" size={14} />
                        </a>
                      </div>

                      <div className="zh">
                        {translated ? (
                          <>
                            <span>{translated}</span>
                            <span className="rx-chip" style={{ height: 20, marginLeft: 6 }}>
                              <Icon name="translate" size={12} /> 已译为中文
                            </span>
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isTranslating}
                            onClick={() => void translate(item)}
                            style={{ height: 24, padding: '0 6px' }}
                          >
                            <Icon name="translate" size={13} />
                            <span>{isTranslating ? '翻译中…' : '翻译标题'}</span>
                          </Button>
                        )}
                      </div>

                      {item.summary && isExpanded ? (
                        <p className="rx-feed-summary">{item.summary}</p>
                      ) : null}

                      <div className="mt2">
                        <span>{item.source}</span>
                        <span>{publishedDate(item.published)}</span>
                        {read ? <span className="rx-chip" style={{ height: 18 }}>已读</span> : null}
                        {item.summary ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            style={{ height: 20, padding: '0 4px' }}
                            onClick={() => setExpanded(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])}
                          >
                            {isExpanded ? '收起摘要' : '展开摘要'}
                          </Button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                icon={source === 'saved' ? 'star' : 'search'}
                title={query ? '没有找到匹配内容' : source === 'saved' ? '还没有收藏资讯' : '暂时没有更新'}
                description={query ? '尝试更换关键词或清空搜索。' : source === 'saved' ? '点击资讯右侧星标即可收入稍后阅读。' : '请稍后刷新或切换其他订阅来源。'}
                action={query ? <Button variant="secondary" size="sm" onClick={() => setQuery('')}>清空搜索</Button> : undefined}
              />
            )}
          </>
        )}
      </div>

      <aside className="rx-desk-side" aria-label="订阅来源与阅读空间">
        <div>
          <div className="rx-ctx-label" style={{ padding: '0 0 6px' }}>订阅来源</div>
          {(['arxiv', 'journals', 'weekly', 'recommendations'] as const).map(id => (
            <button
              key={id}
              type="button"
              className="rx-ctx-item"
              aria-current={source === id ? 'page' : undefined}
              onClick={() => setSource(id)}
            >
              <Icon name={sources[id].icon} size={15} />
              <span>{sources[id].label}</span>
              {source === id && id !== 'recommendations' ? <span className="rx-ctx-count tabular-nums">{items.length}</span> : null}
            </button>
          ))}
        </div>

        <div>
          <div className="rx-ctx-label" style={{ padding: '0 0 6px' }}>阅读空间</div>
          <button
            type="button"
            className="rx-ctx-item"
            aria-current={source === 'saved' ? 'page' : undefined}
            onClick={() => setSource('saved')}
          >
            <Icon name="star" size={15} />
            <span>稍后阅读</span>
            <span className="rx-ctx-count tabular-nums">{data.savedArticles.length}</span>
          </button>
        </div>

        <div className="rx-privacy">
          标题按需翻译：只有你点了「翻译标题」的那一条会发送到 Google 翻译，译文保存在本机。
        </div>
      </aside>
    </div>
  );
}
