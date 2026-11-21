import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GraphEdge,
  GraphEvidence,
  GraphNode,
  GraphPaper,
  KnowledgeGraphResponse,
} from '../api/client';
import { api } from '../api/client';
import type { WorkspacePhase } from '../hooks/useWorkspace';
import { Graph3DCloud } from './Graph3DCloud';

/** 三类实体的展示名与配色（配色走既有 token，随主题生效）。 */
const KIND_META: Record<string, { label: string; tone: string; hex: string }> = {
  concept: { label: '概念', tone: 'graph-kind-concept', hex: 'var(--color-accent)' },
  method: { label: '方法', tone: 'graph-kind-method', hex: 'var(--color-good)' },
  conclusion: { label: '结论', tone: 'graph-kind-conclusion', hex: 'var(--color-warn)' },
};

const KIND_ORDER = ['concept', 'method', 'conclusion'] as const;

type ViewId = 'cloud' | 'matrix' | 'network' | 'conclusions' | 'timeline';

function shortLabel(value: string, max = 26): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 实体检索用的宽松匹配：忽略大小写与空白，中英都适用。 */
function matchesQuery(label: string, aliases: string[] | undefined, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase().replace(/\s+/g, '');
  const haystacks = [label, ...(aliases ?? [])];
  return haystacks.some((item) => item.toLowerCase().replace(/\s+/g, '').includes(needle));
}

interface Props {
  phase: WorkspacePhase;
  onBack?: () => void;
  /** 点某条关系的原文依据时跳到阅读器对应页（App 里的 cite 通路）。 */
  onCite: (target: { key: string; page: number }) => void;
  documents: { id: string; key: string; title: string; year?: number | null }[];
}

/**
 * 知识图谱。
 *
 * 默认视图是**三维点云**（双环同心）：内环是跨文献共享的实体、外圈是单篇实体、最外层是论文。
 * 它回答的是「这堆论文里的知识长成什么形状」——一团向心的云，每个点都能点开看它的连线与原文依据。
 * 点云视图铺满整个内容区（工具栏与详情面板是浮层），因为一团云被挤在小格子里就没法看了。
 *
 * 保留另外两个视图，因为它们回答不同的问题：
 *  - **对照表（矩阵）**：实测两篇 CT 重建论文抽出 102 节点、却只有 2 个跨文献合并节点时，
 *    点云会显得很稀；矩阵把「共有 / 仅各篇」逐条列清楚，比形状更精确。
 *  - **结论**：论证链数据太稀（conclusion 占比低）时不画链条，退化为按结论分组的列表。
 * 所以点云负责「看形状」，矩阵负责「读交集」，两者都给跨文献实体数与关系数，
 * 不用一张漂亮的图暗示不存在的结构。
 *
 * 硬要求不变：每条关系都有逐字、页锚定的原文依据，点依据回到阅读器对应页。
 */
export function KnowledgeGraphSection({ phase, onBack, onCite, documents }: Props) {
  const [graph, setGraph] = useState<KnowledgeGraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>('cloud');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [focusPaper, setFocusPaper] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.graph();
      setGraph(result);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Esc 收起详情面板：找东西的时候不必再去够那个小 ×。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (selectedEdge) setSelectedEdge(null);
      else if (selectedEntity) setSelectedEntity(null);
      else if (focusPaper) setFocusPaper(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedEdge, selectedEntity, focusPaper]);

  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const papers = graph?.papers ?? [];

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const titleByKey = useMemo(
    () => new Map([...documents.map((doc) => [doc.key, doc.title] as const), ...papers.map((paper) => [paper.key, paper.title] as const)]),
    [documents, papers],
  );
  const extractedKeys = useMemo(() => new Set(papers.map((paper) => paper.key)), [papers]);
  const pending = documents.filter((doc) => !extractedKeys.has(doc.key));

  const filteredNodes = useMemo(
    () =>
      nodes.filter(
        (node) =>
          (kindFilter === 'all' || node.kind === kindFilter) &&
          matchesQuery(node.label, node.aliases, query),
      ),
    [nodes, kindFilter, query],
  );

  const filteredIds = useMemo(() => new Set(filteredNodes.map((node) => node.id)), [filteredNodes]);
  const filteredEdges = useMemo(
    () => edges.filter((edge) => filteredIds.has(edge.from) && filteredIds.has(edge.to)),
    [edges, filteredIds],
  );

  // 跨文献＝同一实体出现在多篇；这是整个视图要回答的第一等问题。
  const sharedNodes = useMemo(
    () => filteredNodes.filter((node) => node.docs.length > 1),
    [filteredNodes],
  );
  const crossPaperEdges = useMemo(
    () => filteredEdges.filter((edge) => edge.docs.length > 1),
    [filteredEdges],
  );

  /** 每篇文献独有的实体（矩阵里「仅 A」「仅 B」那几组）。 */
  const paperGroups = useMemo(
    () =>
      papers.map((paper) => ({
        paper,
        nodes: filteredNodes.filter(
          (node) => node.docs.length === 1 && node.docs.includes(paper.key),
        ),
      })),
    [papers, filteredNodes],
  );

  const relationsOf = useCallback(
    (entityId: string, paperKey: string | null) =>
      edges.filter(
        (edge) =>
          (edge.from === entityId || edge.to === entityId) &&
          (!paperKey || edge.docs.includes(paperKey)),
      ),
    [edges],
  );

  const extract = async (key: string, force: boolean) => {
    setBusyKey(key);
    setNotice(null);
    setError(null);
    try {
      const result = await api.graphExtract(key, force);
      setNotice(
        result.skipped
          ? '已有图谱结果，未重复调用模型（点「重抽取」才会重跑）。'
          : `已抽取：节点 ${result.paper.nodeCount}、关系 ${result.paper.relationCount}${
              result.paper.dropped ? `，丢弃无依据条目 ${result.paper.dropped}` : ''
            }`,
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (key: string) => {
    setBusyKey(key);
    try {
      await api.graphRemove(key);
      setSelectedEdge(null);
      setSelectedEntity(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyKey(null);
    }
  };

  const pickEntity = (entityId: string, paperKey: string | null) => {
    setSelectedEntity(entityId);
    setSelectedEdge(null);
    setFocusPaper(paperKey);
  };

  const hasGraph = papers.length > 0 && nodes.length > 0;
  /**
   * 图谱有数据、只是被筛选筛空：与「库里根本没抽过」是两件事，提示语必须分开——
   * 否则用户会跑去重抽已经抽过的论文。注意判断要基于**筛选后**的点数：
   * 用未筛选的 nodes 判断会让筛空时仍然走进视图分支，提示语永远显示不出来。
   */
  const filterMatchedNothing = hasGraph && filteredNodes.length === 0;

  return (
    <div className={`graph-section${view === 'cloud' && hasGraph && !filterMatchedNothing && !manageOpen ? ' cloud-fullbleed' : ''}`}>
      <header className="graph-toolbar">
        <div className="graph-toolbar-row">
          {onBack ? (
            <button type="button" className="graph-back" onClick={onBack} title="返回书库">
              ←
            </button>
          ) : null}
          <h1 className="text-[15px] font-medium">知识图谱</h1>
          <span className="text-[11px] text-ink-faint" title="跨文献实体＝同一概念/方法被多篇论文提到">
            {graph
              ? `${papers.length}/${graph.totalDocuments} 篇已抽取 · ${nodes.length} 节点 · 跨文献实体 ${sharedNodes.length}`
              : '加载中…'}
          </span>
          <button
            type="button"
            className={`graph-chip ml-auto${manageOpen ? ' active' : ''}`}
            onClick={() => setManageOpen((value) => !value)}
          >
            抽取管理{pending.length ? ` (${pending.length})` : ''}
          </button>
        </div>

        <div className="graph-toolbar-row">
          <span className="graph-tabs" role="tablist">
            {(
              [
                { id: 'cloud', label: '点云' },
                { id: 'matrix', label: '对照表' },
                { id: 'network', label: '关系网络' },
                { id: 'conclusions', label: '结论' },
                { id: 'timeline', label: '脉络与空白' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={view === item.id}
                className={`graph-tab${view === item.id ? ' active' : ''}`}
                onClick={() => setView(item.id)}
              >
                {item.label}
              </button>
            ))}
          </span>

          <input
            ref={searchRef}
            className="graph-search"
            value={query}
            placeholder="搜实体（支持别名，如 PSNR / 稀疏视角）"
            onChange={(event) => setQuery(event.target.value)}
          />

          <span className="graph-chip-group">
            {(['all', ...KIND_ORDER] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className={`graph-chip${kindFilter === kind ? ' active' : ''}`}
                onClick={() => setKindFilter(kind)}
              >
                {kind === 'all' ? '全部' : KIND_META[kind]?.label ?? kind}
              </button>
            ))}
          </span>
        </div>
      </header>

      {error ? <p className="graph-banner bad">{error}</p> : null}
      {notice ? <p className="graph-banner good">{notice}</p> : null}

      {manageOpen ? (
        <PapersPanel
          pending={pending}
          papers={papers}
          busyKey={busyKey}
          onExtract={extract}
          onRemove={remove}
          onClose={() => setManageOpen(false)}
        />
      ) : null}

      <div className={`graph-body${selectedEntity || selectedEdge || focusPaper ? '' : ' bare'}`}>
        <div className="graph-main">
          {!hasGraph ? (
            <p className="graph-empty">
              {phase.kind === 'ready'
                ? '还没有图谱数据。点右上角「抽取管理」，对论文逐篇抽取：AI 只输出结构（概念/方法/结论与关系），展示的每一句都来自 PDF 正文并标了页码。'
                : '加载中…'}
            </p>
          ) : filterMatchedNothing ? (
            <p className="graph-empty">
              当前筛选下没有匹配的实体
              {query.trim() ? `（关键词「${query.trim()}」）` : ''}
              {kindFilter !== 'all' ? `（类型：${KIND_META[kindFilter]?.label ?? kindFilter}）` : ''}
              ：清空搜索或切回「全部」即可看到完整图谱。
            </p>
          ) : view === 'cloud' ? (
            <Graph3DCloud
              nodes={filteredNodes}
              edges={filteredEdges}
              papers={papers}
              selectedId={selectedEntity}
              onPick={(id) => {
                // 论文点点击＝聚焦那篇；实体点点击＝打开实体详情。
                if (id.startsWith('paper:')) {
                  const key = id.slice('paper:'.length);
                  setSelectedEntity(null);
                  setSelectedEdge(null);
                  setFocusPaper(key);
                  return;
                }
                pickEntity(id, null);
              }}
            />
          ) : view === 'matrix' ? (
            <MatrixView
              papers={papers}
              sharedNodes={sharedNodes}
              paperGroups={paperGroups}
              titleByKey={titleByKey}
              selectedEntity={selectedEntity}
              focusPaper={focusPaper}
              relationCount={(id, paperKey) => relationsOf(id, paperKey).length}
              onPick={pickEntity}
            />
          ) : view === 'network' ? (
            <NetworkView
              sharedNodes={sharedNodes}
              paperGroups={paperGroups}
              edges={filteredEdges}
              crossPaperEdges={crossPaperEdges}
              nodeById={nodeById}
              selectedEntity={selectedEntity}
              onPick={pickEntity}
              onPickEdge={(edgeId) => {
                setSelectedEdge(edgeId);
                setSelectedEntity(null);
              }}
            />
          ) : view === 'timeline' ? (
            <TimelineAndGapsView
              papers={papers}
              documents={documents}
              nodes={filteredNodes}
              edges={filteredEdges}
              titleByKey={titleByKey}
              onPick={pickEntity}
              onPickEdge={(edgeId) => {
                setSelectedEdge(edgeId);
                setSelectedEntity(null);
              }}
            />
          ) : (
            <ConclusionsView
              nodes={filteredNodes.filter((node) => node.kind === 'conclusion')}
              edges={edges}
              nodeById={nodeById}
              titleByKey={titleByKey}
              onPick={pickEntity}
              onCite={onCite}
            />
          )}
        </div>

        {selectedEdge ? (
          <aside className="graph-side">
            <EdgeDetail
              edge={edges.find((edge) => edge.id === selectedEdge) ?? null}
              nodeById={nodeById}
              onClose={() => setSelectedEdge(null)}
              onCite={onCite}
            />
          </aside>
        ) : selectedEntity ? (
          <aside className="graph-side">
            <EntityDetail
              node={nodeById.get(selectedEntity) ?? null}
              relations={relationsOf(selectedEntity, focusPaper)}
              allRelations={relationsOf(selectedEntity, null)}
              focusPaper={focusPaper}
              focusPaperTitle={focusPaper ? titleByKey.get(focusPaper) ?? focusPaper : null}
              nodeById={nodeById}
              titleByKey={titleByKey}
              onClearPaper={() => setFocusPaper(null)}
              onPickEdge={(edgeId) => {
                setSelectedEdge(edgeId);
                setSelectedEntity(null);
              }}
              onCite={onCite}
              onClose={() => {
                setSelectedEntity(null);
                setFocusPaper(null);
              }}
            />
          </aside>
        ) : focusPaper ? (
          <aside className="graph-side">
            <PaperDetail
              paper={papers.find((paper) => paper.key === focusPaper) ?? null}
              titleByKey={titleByKey}
              nodes={filteredNodes.filter((node) => node.docs.includes(focusPaper))}
              onPick={(entityId) => pickEntity(entityId, focusPaper)}
              onClose={() => setFocusPaper(null)}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------- 对照表（默认视图） ---------------- */

/**
 * 三分组对照表：共有置顶，然后每篇文献独有的各自成组。
 *
 * 行排序照搬 seriation 的用意——让相似行聚成肉眼可见的块；
 * 这里的分组键是「出现在哪些文献」，所以「共有」这一组就是跨文献比较的落点。
 */
function MatrixView({
  papers,
  sharedNodes,
  paperGroups,
  titleByKey,
  selectedEntity,
  focusPaper,
  relationCount,
  onPick,
}: {
  papers: GraphPaper[];
  sharedNodes: GraphNode[];
  paperGroups: { paper: GraphPaper; nodes: GraphNode[] }[];
  titleByKey: Map<string, string>;
  selectedEntity: string | null;
  focusPaper: string | null;
  relationCount: (id: string, paperKey: string | null) => number;
  onPick: (id: string, paperKey: string | null) => void;
}) {
  if (!papers.length) return <p className="graph-empty">还没有已抽取的文献。</p>;

  return (
    <div className="graph-matrix-wrap">
      <table className="graph-matrix">
        <thead>
          <tr>
            <th className="graph-matrix-corner">实体</th>
            {papers.map((paper) => (
              <th key={paper.key} title={titleByKey.get(paper.key) ?? paper.title}>
                {shortLabel(titleByKey.get(paper.key) ?? paper.title, 18)}
              </th>
            ))}
            <th className="graph-matrix-note">依据</th>
          </tr>
        </thead>
        <tbody>
          <tr className="graph-matrix-group">
            <td colSpan={papers.length + 2}>
              共有实体 {sharedNodes.length}
              <span className="graph-matrix-group-hint">
                {sharedNodes.length
                  ? '同一概念/方法出现在多篇文献里 —— 跨文献比较看这一组'
                  : '两篇没有共有的概念/方法；说明它们的术语体系不重叠，这本身就是结论'}
              </span>
            </td>
          </tr>
          {sharedNodes.map((node) => (
            <MatrixRow
              key={node.id}
              node={node}
              papers={papers}
              selected={selectedEntity === node.id && focusPaper == null}
              onPick={onPick}
              relationCount={relationCount}
            />
          ))}

          {paperGroups.map((group) =>
            group.nodes.length ? (
              <Fragment key={group.paper.key}>
                <tr className="graph-matrix-group">
                  <td colSpan={papers.length + 2}>
                    仅《{shortLabel(titleByKey.get(group.paper.key) ?? group.paper.title, 40)}》{group.nodes.length}
                    <span className="graph-matrix-group-hint">只有这篇提出的概念/方法</span>
                  </td>
                </tr>
                {group.nodes.map((node) => (
                  <MatrixRow
                    key={node.id}
                    node={node}
                    papers={papers}
                    selected={selectedEntity === node.id && focusPaper === group.paper.key}
                    onPick={onPick}
                    relationCount={relationCount}
                  />
                ))}
              </Fragment>
            ) : null,
          )}
        </tbody>
      </table>
      <p className="graph-hint">
        行是实体、列是文献；实心点表示这篇提到了它。点格子看该实体在这篇里的关系与原文依据，点实体名看它跨全部文献的关系。
      </p>
    </div>
  );
}

function MatrixRow({
  node,
  papers,
  selected,
  onPick,
  relationCount,
}: {
  node: GraphNode;
  papers: GraphPaper[];
  selected: boolean;
  onPick: (id: string, paperKey: string | null) => void;
  relationCount: (id: string, paperKey: string | null) => number;
}) {
  return (
    <tr className={selected ? 'graph-matrix-selected' : undefined}>
      <th scope="row">
        <button
          type="button"
          className="graph-matrix-entity"
          onClick={() => onPick(node.id, null)}
          title={node.aliases?.length ? `${node.label}（别名：${node.aliases.join('、')}）` : node.label}
        >
          <span className={`graph-dot ${KIND_META[node.kind]?.tone ?? ''}`} />
          <span className="graph-matrix-label">{node.label}</span>
          <span className={`graph-kind-tag ${KIND_META[node.kind]?.tone ?? ''}`}>
            {KIND_META[node.kind]?.label ?? node.kind}
          </span>
          {node.docs.length > 1 ? <span className="graph-matrix-shared">跨 {node.docs.length} 篇</span> : null}
        </button>
      </th>
      {papers.map((paper) => {
        const present = node.docs.includes(paper.key);
        const count = present ? relationCount(node.id, paper.key) : 0;
        return (
          <td key={paper.key} className="graph-matrix-cell">
            {present ? (
              <button
                type="button"
                className={`graph-cell-dot${count ? '' : ' lonely'}`}
                onClick={() => onPick(node.id, paper.key)}
                title={`${node.label} · 该篇里有 ${count} 条关系有原文依据`}
              >
                <span />
                {count ? <em>{count}</em> : null}
              </button>
            ) : (
              <span className="graph-cell-empty" title="这篇没有提到">
                ·
              </span>
            )}
          </td>
        );
      })}
      <td className="graph-matrix-note">{relationCount(node.id, null)}</td>
    </tr>
  );
}

/* ---------------- 关系网络（按文献成簇） ---------------- */

const BAND_WIDTH = 900;
const BAND_MIN = 132;
const NODE_R = 7;

interface Placement {
  x: number;
  y: number;
}

/**
 * 按文献成簇的布局：每篇文献一个横向条带（Group-in-a-Box 的线性 meta-layout），
 * 条带内独立跑力导向，跨条带的边画成贝塞尔曲线。
 *
 * 不做全局力导向是有意的：全局布局会让两篇不相干的文献互相挤成一团，
 * 看不出「谁和谁在一篇里」，而簇的边界恰好承载了这个信息。
 */
function useBandLayout(
  bands: { key: string; nodes: GraphNode[] }[],
  edges: GraphEdge[],
): { placements: Map<string, Placement>; bandTops: Map<string, number>; heights: number[]; total: number } {
  const [, setTick] = useState(0);
  const store = useRef<{ placements: Map<string, Placement>; bandTops: Map<string, number>; heights: number[]; total: number }>({
    placements: new Map(),
    bandTops: new Map(),
    heights: [],
    total: 0,
  });

  const signature = bands.map((band) => `${band.key}:${band.nodes.length}`).join('|') + `#${edges.length}`;

  useEffect(() => {
    let raf = 0;
    const placements = new Map<string, Placement>();
    const bandTops = new Map<string, number>();
    const heights = bands.map((band) => Math.max(BAND_MIN, Math.min(420, 56 + band.nodes.length * 13)));
    let top = 0;
    for (let i = 0; i < bands.length; i += 1) {
      const band = bands[i];
      const height = heights[i];
      if (!band || height == null) continue;
      bandTops.set(band.key, top);
      top += height + 14;
    }
    const total = Math.max(160, top);

    const local: { id: string; x: number; y: number; vx: number; vy: number }[] = [];
    const index = new Map<string, number>();
    bands.forEach((band, bandIndex) => {
      const height = heights[bandIndex] ?? BAND_MIN;
      const bandTop = bandTops.get(band.key) ?? 0;
      band.nodes.forEach((node, i) => {
        const angle = i * 2.399963;
        const radius = 26 + Math.sqrt(i) * 26;
        index.set(node.id, local.length);
        local.push({
          id: node.id,
          x: BAND_WIDTH / 2 + Math.cos(angle) * radius * 1.8,
          y: bandTop + height / 2 + Math.sin(angle) * radius * 0.7,
          vx: 0,
          vy: 0,
        });
      });
    });

    // 只把带内边当作弹簧；跨带的边用曲线表达，不参与受力，
    // 否则两篇的节点会被互相拖拽、簇就散了。
    const springs: [number, number][] = [];
    for (const edge of edges) {
      const a = index.get(edge.from);
      const b = index.get(edge.to);
      if (a == null || b == null || a === b) continue;
      const bandA = bands.findIndex((band) => band.nodes.some((node) => node.id === edge.from));
      const bandB = bands.findIndex((band) => band.nodes.some((node) => node.id === edge.to));
      if (bandA === bandB) springs.push([a, b]);
    }

    const bandOf = new Map<string, number>();
    bands.forEach((band, bandIndex) => band.nodes.forEach((node) => bandOf.set(node.id, bandIndex)));

    let step = 0;
    const iterate = () => {
      for (let i = 0; i < local.length; i += 1) {
        const a = local[i];
        if (!a) continue;
        const bandA = bandOf.get(a.id) ?? 0;
        const height = heights[bandA] ?? BAND_MIN;
        const bandTop = bandTops.get(bands[bandA]?.key ?? '') ?? 0;
        for (let j = i + 1; j < local.length; j += 1) {
          const b = local[j];
          if (!b) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy) || 0.01;
          const repulsion = 3600 / (dist * dist);
          const fx = (dx / dist) * repulsion;
          const fy = (dy / dist) * repulsion;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
        // 带内重力：把节点压在各自条带的水平中线上。
        const midY = bandTop + height / 2;
        a.vy += (midY - a.y) * 0.06;
        a.vx += (BAND_WIDTH / 2 - a.x) * 0.0012;
      }
      for (const [i, j] of springs) {
        const a = local[i];
        const b = local[j];
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const pull = (dist - 92) * 0.02;
        const fx = (dx / dist) * pull;
        const fy = (dy / dist) * pull;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
      for (const item of local) {
        const bandIndex = bandOf.get(item.id) ?? 0;
        const height = heights[bandIndex] ?? BAND_MIN;
        const bandTop = bandTops.get(bands[bandIndex]?.key ?? '') ?? 0;
        item.vx *= 0.84;
        item.vy *= 0.84;
        item.x = Math.max(NODE_R + 30, Math.min(BAND_WIDTH - NODE_R - 30, item.x + Math.max(-16, Math.min(16, item.vx))));
        item.y = Math.max(bandTop + 22, Math.min(bandTop + height - 22, item.y + Math.max(-16, Math.min(16, item.vy))));
      }
      step += 1;
      if (step < 260) {
        raf = requestAnimationFrame(iterate);
        if (step % 8 === 0) {
          for (const item of local) placements.set(item.id, { x: item.x, y: item.y });
          store.current = { placements: new Map(placements), bandTops, heights, total };
          setTick((value) => value + 1);
        }
      } else {
        for (const item of local) placements.set(item.id, { x: item.x, y: item.y });
        store.current = { placements, bandTops, heights, total };
        setTick((value) => value + 1);
      }
    };
    raf = requestAnimationFrame(iterate);
    return () => cancelAnimationFrame(raf);
    // 布局只在「哪些节点在哪个带里」或边集变化时重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return store.current;
}

function NetworkView({
  sharedNodes,
  paperGroups,
  edges,
  crossPaperEdges,
  nodeById,
  selectedEntity,
  onPick,
  onPickEdge,
}: {
  sharedNodes: GraphNode[];
  paperGroups: { paper: GraphPaper; nodes: GraphNode[] }[];
  edges: GraphEdge[];
  crossPaperEdges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
  selectedEntity: string | null;
  onPick: (id: string, paperKey: string | null) => void;
  onPickEdge: (edgeId: string) => void;
}) {
  const bands = useMemo(() => {
    const list: { key: string; label: string; nodes: GraphNode[]; shared: boolean }[] = [];
    if (sharedNodes.length) list.push({ key: '__shared__', label: '共有实体', nodes: sharedNodes, shared: true });
    for (const group of paperGroups) {
      if (group.nodes.length) list.push({ key: group.paper.key, label: group.paper.title, nodes: group.nodes, shared: false });
    }
    return list;
  }, [sharedNodes, paperGroups]);

  const { placements, bandTops, heights, total } = useBandLayout(
    bands.map((band) => ({ key: band.key, nodes: band.nodes })),
    edges,
  );

  if (!bands.length) return <p className="graph-empty">当前筛选下没有节点。</p>;

  return (
    <div className="graph-network-wrap">
      {sharedNodes.length === 0 ? (
        <p className="graph-network-note">
          没有共有实体：这些论文之间连术语层面的重合都没有。分成互不相连的两簇是如实呈现，
          而不是把两篇硬凑成一张网 —— 真正的比较结论就是「它们不共享概念」。
        </p>
      ) : crossPaperEdges.length === 0 ? (
        <p className="graph-network-note soft">
          {sharedNodes.length} 个共有实体把各篇连了起来（虚线），但还没有一条关系本身被两篇共同引用。
          跨文献的关联先看这些共有实体。
        </p>
      ) : null}
      <svg className="graph-network" viewBox={`0 0 ${BAND_WIDTH} ${total}`} width="100%" style={{ height: total }}>
        <defs>
          {KIND_ORDER.map((kind) => (
            <marker
              key={kind}
              id={`band-arrow-${kind}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={KIND_META[kind]?.hex ?? 'var(--color-accent)'} />
            </marker>
          ))}
        </defs>

        {bands.map((band) => {
          const top = bandTops.get(band.key) ?? 0;
          const height = heights[bands.findIndex((item) => item.key === band.key)] ?? BAND_MIN;
          return (
            <g key={band.key}>
              <rect
                className={`graph-band${band.shared ? ' shared' : ''}`}
                x={8}
                y={top}
                width={BAND_WIDTH - 16}
                height={height}
                rx={10}
              />
              <text className="graph-band-title" x={20} y={top + 20}>
                {band.shared ? `共有实体（${band.nodes.length}）` : `${shortLabel(band.label, 52)}（${band.nodes.length}）`}
              </text>
            </g>
          );
        })}

        {/* 先画跨带曲线，再画带内边，最后画节点——保证节点压在线上方。 */}
        {edges.map((edge) => {
          const a = placements.get(edge.from);
          const b = placements.get(edge.to);
          if (!a || !b) return null;
          const bandA = bands.findIndex((band) => band.nodes.some((node) => node.id === edge.from));
          const bandB = bands.findIndex((band) => band.nodes.some((node) => node.id === edge.to));
          const cross = bandA !== bandB;
          const midY = (a.y + b.y) / 2;
          const d = cross
            ? `M ${a.x} ${a.y} C ${a.x} ${midY} ${b.x} ${midY} ${b.x} ${b.y}`
            : `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
          const kind = nodeById.get(edge.from)?.kind ?? 'concept';
          return (
            <g key={edge.id}>
              <path
                className={`graph-band-edge${cross ? ' cross' : ''}`}
                d={d}
                markerEnd={`url(#band-arrow-${kind})`}
              />
              <path
                className="graph-band-edge-hit"
                d={d}
                onClick={() => onPickEdge(edge.id)}
                data-cross={cross ? 'true' : undefined}
              />
            </g>
          );
        })}

        {bands.map((band) =>
          band.nodes.map((node) => {
            const point = placements.get(node.id);
            if (!point) return null;
            const active = selectedEntity === node.id;
            return (
              <g
                key={node.id}
                className={`graph-band-node ${KIND_META[node.kind]?.tone ?? ''}${active ? ' active' : ''}`}
                transform={`translate(${point.x} ${point.y})`}
                onClick={() => onPick(node.id, band.shared ? null : band.key)}
              >
                <title>{node.label}</title>
                <circle r={node.docs.length > 1 ? NODE_R + 2 : NODE_R} />
                <text y={-NODE_R - 5}>{shortLabel(node.label, 16)}</text>
              </g>
            );
          }),
        )}
      </svg>
      <p className="graph-hint">每篇文献一簇，簇内是它自己的概念/方法/结论；跨簇曲线才是跨文献关联。点节点或连线看原文依据。</p>
    </div>
  );
}

/* ---------------- 结论（论证链退化形态） ---------------- */

/**
 * 不画「概念→方法→结论」链条：实测 conclusion 只占 4%、≥2 跳链条仅 1 条，
 * 画出来是个空壳。退化成按结论分组的列表——结论、它的关系、原文依据。
 */
function ConclusionsView({
  nodes,
  edges,
  nodeById,
  titleByKey,
  onPick,
  onCite,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
  titleByKey: Map<string, string>;
  onPick: (id: string, paperKey: string | null) => void;
  onCite: (target: { key: string; page: number }) => void;
}) {
  if (!nodes.length) {
    return (
      <p className="graph-empty">
        没有抽到结论类实体。结论是「这篇论文得出了什么」的落点，值得在抽取时专门要求；
        现在可以回「抽取管理」重抽某篇试试。
      </p>
    );
  }
  return (
    <div className="graph-conclusions">
      {nodes.map((node) => {
        const incoming = edges.filter((edge) => edge.to === node.id);
        const papers = node.docs;
        return (
          <section key={node.id} className="graph-conclusion">
            <header>
              <span className="graph-dot graph-kind-conclusion" />
              <button type="button" className="graph-conclusion-title" onClick={() => onPick(node.id, null)}>
                {node.label}
              </button>
              <span className="graph-evidence-count">
                {papers.map((key) => shortLabel(titleByKey.get(key) ?? key, 22)).join('、')}
              </span>
            </header>
            {incoming.length ? (
              <ul className="graph-conclusion-relations">
                {incoming.map((edge) => {
                  const from = nodeById.get(edge.from);
                  return (
                    <li key={edge.id}>
                      <p className="graph-conclusion-relation">
                        <span className={`graph-kind-tag ${KIND_META[from?.kind ?? '']?.tone ?? ''}`}>
                          {KIND_META[from?.kind ?? '']?.label ?? from?.kind}
                        </span>
                        <button type="button" onClick={() => onPick(edge.from, null)}>
                          {from?.label ?? edge.from}
                        </button>
                        <span className="text-ink-faint">{edge.label}→</span>
                        <span>本结论</span>
                      </p>
                      <EvidenceList evidence={edge.evidence} onCite={onCite} compact />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[11px] text-ink-faint">这条结论没有带证据的入边（可能是抽取时只列了结论）。</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* ---------------- 时间脉络与交叉研究空白 ---------------- */

function TimelineAndGapsView({
  papers,
  documents,
  nodes,
  edges,
  titleByKey,
  onPick,
  onPickEdge,
}: {
  papers: GraphPaper[];
  documents: { id: string; key: string; title: string; year?: number | null }[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  titleByKey: Map<string, string>;
  onPick: (id: string, paperKey: string | null) => void;
  onPickEdge: (edgeId: string) => void;
}) {
  const yearByKey = useMemo(
    () => new Map(documents.map((doc) => [doc.key, doc.year ?? null] as const)),
    [documents],
  );

  const yearGroups = useMemo(() => {
    const groups = new Map<number, GraphPaper[]>();
    for (const paper of papers) {
      const year = yearByKey.get(paper.key) ?? 0;
      const list = groups.get(year) ?? [];
      list.push(paper);
      groups.set(year, list);
    }
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === 0) return 1;
      if (b === 0) return -1;
      return a - b;
    });
  }, [papers, yearByKey]);

  const topMethods = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === 'method')
        .sort((a, b) => b.docs.length - a.docs.length || a.label.localeCompare(b.label, 'zh'))
        .slice(0, 6),
    [nodes],
  );
  const topConcepts = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === 'concept')
        .sort((a, b) => b.docs.length - a.docs.length || a.label.localeCompare(b.label, 'zh'))
        .slice(0, 6),
    [nodes],
  );

  const pairEdges = useMemo(() => {
    const lookup = new Map<string, GraphEdge[]>();
    for (const edge of edges) {
      for (const pairKey of [`${edge.from}::${edge.to}`, `${edge.to}::${edge.from}`]) {
        const list = lookup.get(pairKey) ?? [];
        list.push(edge);
        lookup.set(pairKey, list);
      }
    }
    return lookup;
  }, [edges]);

  return (
    <div className="graph-timeline-wrap">
      <section className="graph-timeline-section">
        <header className="graph-timeline-head">
          <h2>按年份技术演进脉络</h2>
          <span>仅统计已抽取图谱的 {papers.length} 篇论文</span>
        </header>
        <div className="graph-timeline-list">
          {yearGroups.map(([year, groupPapers]) => (
            <div key={year} className="graph-timeline-year">
              <div className="graph-timeline-badge">{year > 0 ? year : '年份未标注'}</div>
              <div className="graph-timeline-papers">
                {groupPapers.map((paper) => {
                  const paperNodes = nodes
                    .filter((n) => n.docs.includes(paper.key))
                    .sort((a, b) => b.docs.length - a.docs.length)
                    .slice(0, 8);
                  return (
                    <article key={paper.key} className="graph-timeline-card">
                      <h3>{titleByKey.get(paper.key) ?? paper.title}</h3>
                      <div className="graph-timeline-chips">
                        {paperNodes.map((node) => (
                          <button
                            key={node.id}
                            type="button"
                            className={`graph-chip ${KIND_META[node.kind]?.tone ?? ''}${node.docs.length > 1 ? ' shared' : ''}`}
                            onClick={() => onPick(node.id, paper.key)}
                            title={node.docs.length > 1 ? `跨 ${node.docs.length} 篇共享` : '本篇实体'}
                          >
                            {shortLabel(node.label, 22)}
                            {node.docs.length > 1 ? ` · ${node.docs.length}篇` : ''}
                          </button>
                        ))}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="graph-timeline-section">
        <header className="graph-timeline-head">
          <h2>方法 × 概念/问题 交叉空白矩阵</h2>
          <span>无直接证据连线的格子代表当前已抽取文献中的潜在研究空白</span>
        </header>
        {topMethods.length && topConcepts.length ? (
          <div className="graph-matrix-wrap">
            <table className="graph-matrix graph-gap-matrix">
              <thead>
                <tr>
                  <th className="graph-matrix-corner">方法 \ 概念与问题</th>
                  {topConcepts.map((concept) => (
                    <th key={concept.id}>
                      <button type="button" onClick={() => onPick(concept.id, null)}>
                        {shortLabel(concept.label, 18)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topMethods.map((method) => (
                  <tr key={method.id}>
                    <th>
                      <button type="button" onClick={() => onPick(method.id, null)}>
                        {shortLabel(method.label, 20)}
                      </button>
                    </th>
                    {topConcepts.map((concept) => {
                      const hits = pairEdges.get(`${method.id}::${concept.id}`) ?? [];
                      if (!hits.length) {
                        return (
                          <td key={concept.id} className="graph-gap-empty">
                            未连接
                          </td>
                        );
                      }
                      const first = hits[0]!;
                      return (
                        <td key={concept.id} className="graph-gap-hit">
                          <button type="button" onClick={() => onPickEdge(first.id)}>
                            {first.label} ({hits.length})
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="graph-hint">需要同时存在「方法」与「概念」类实体，才能生成交叉矩阵。</p>
        )}
      </section>
    </div>
  );
}

/* ---------------- 详情面板 ---------------- */

function EntityDetail({
  node,
  relations,
  allRelations,
  focusPaper,
  focusPaperTitle,
  nodeById,
  titleByKey,
  onClearPaper,
  onPickEdge,
  onCite,
  onClose,
}: {
  node: GraphNode | null;
  relations: GraphEdge[];
  allRelations: GraphEdge[];
  focusPaper: string | null;
  focusPaperTitle: string | null;
  nodeById: Map<string, GraphNode>;
  titleByKey: Map<string, string>;
  onClearPaper: () => void;
  onPickEdge: (edgeId: string) => void;
  onCite: (target: { key: string; page: number }) => void;
  onClose: () => void;
}) {
  if (!node) {
    return (
      <div className="graph-detail">
        <p className="text-[11px] text-ink-faint">这个实体已不在图谱里（可能被重抽覆盖）。</p>
        <button type="button" className="graph-chip" onClick={onClose}>
          关闭
        </button>
      </div>
    );
  }
  return (
    <div className="graph-detail">
      <div className="graph-detail-head">
        <span className={`graph-kind-tag ${KIND_META[node.kind]?.tone ?? ''}`}>
          {KIND_META[node.kind]?.label ?? node.kind}
        </span>
        <button type="button" className="graph-close" onClick={onClose} title="关闭（Esc）">
          ×
        </button>
      </div>
      <h2>{node.label}</h2>
      {node.aliases?.length ? (
        <p className="graph-alias">别名：{node.aliases.join('、')}</p>
      ) : null}
      <p className="graph-detail-meta">
        出现在 {node.docs.length} 篇：
        {node.docs.map((key) => shortLabel(titleByKey.get(key) ?? key, 24)).join('、')}
      </p>

      {focusPaper ? (
        <p className="graph-focus">
          只看《{shortLabel(focusPaperTitle ?? focusPaper, 30)}》
          <button type="button" onClick={onClearPaper}>
            看全部 {allRelations.length} 条
          </button>
        </p>
      ) : null}

      <p className="graph-section-label">
        关系 {relations.length} 条{relations.length ? '（每条都有原文依据）' : ''}
      </p>
      {relations.length ? (
        <ul className="graph-evidence-list">
          {relations.map((edge) => {
            const otherId = edge.from === node.id ? edge.to : edge.from;
            const other = nodeById.get(otherId);
            const outgoing = edge.from === node.id;
            return (
              <li key={edge.id}>
                <button
                  type="button"
                  className="graph-relation-head"
                  onClick={() => onPickEdge(edge.id)}
                  title="看这条关系的全部原文依据"
                >
                  <span className={`graph-dot ${KIND_META[other?.kind ?? '']?.tone ?? ''}`} />
                  <span className="graph-relation-text">
                    {outgoing ? '' : '被 '}
                    {other?.label ?? otherId}
                    {outgoing ? ` ${edge.label} →` : ` ${edge.label} → 本实体`}
                  </span>
                  <span className="graph-evidence-count">{edge.evidence.length} 条依据</span>
                </button>
                <EvidenceList evidence={edge.evidence} onCite={onCite} compact />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[11px] text-ink-faint">这篇里它没有带证据的关系。</p>
      )}
    </div>
  );
}

function EdgeDetail({
  edge,
  nodeById,
  onClose,
  onCite,
}: {
  edge: GraphEdge | null;
  nodeById: Map<string, GraphNode>;
  onClose: () => void;
  onCite: (target: { key: string; page: number }) => void;
}) {
  if (!edge) {
    return (
      <div className="graph-detail">
        <p className="text-[11px] text-ink-faint">这条关系已不在图谱里。</p>
        <button type="button" className="graph-chip" onClick={onClose}>
          关闭
        </button>
      </div>
    );
  }
  const from = nodeById.get(edge.from);
  const to = nodeById.get(edge.to);
  return (
    <div className="graph-detail">
      <div className="graph-detail-head">
        <span className="text-[11px] text-ink-faint">关系</span>
        <button type="button" className="graph-close" onClick={onClose} title="关闭（Esc）">
          ×
        </button>
      </div>
      <p className="graph-relation-line">
        <span className={KIND_META[from?.kind ?? '']?.tone}>{from?.label ?? edge.from}</span>
        <span className="mx-1 text-ink-faint">—{edge.label}→</span>
        <span className={KIND_META[to?.kind ?? '']?.tone}>{to?.label ?? edge.to}</span>
      </p>
      <p className="graph-detail-meta">
        出现在 {edge.docs.length} 篇文献 · {edge.evidence.length} 条原文依据
      </p>
      <p className="graph-section-label">原文依据</p>
      <EvidenceList evidence={edge.evidence} onCite={onCite} />
    </div>
  );
}

/** 证据列表：每条都能点回原文那一页，这是整个视图的硬要求。 */
function EvidenceList({
  evidence,
  onCite,
  compact,
}: {
  evidence: GraphEvidence[];
  onCite: (target: { key: string; page: number }) => void;
  compact?: boolean;
}) {
  if (!evidence.length) return null;
  const shown = compact ? evidence.slice(0, 1) : evidence;
  return (
    <ul className="graph-evidence-list">
      {shown.map((item, index) => (
        <li key={`${item.paperKey}-${item.page}-${index}`}>
          <button
            type="button"
            className="graph-evidence-jump"
            onClick={() => onCite({ key: item.paperKey, page: item.page })}
            title="跳到原文这一页"
          >
            <span className="graph-evidence-head">
              <span className="graph-evidence-title">{item.paperTitle || item.paperKey}</span>
              <span className="graph-page">第 {item.page} 页</span>
            </span>
            <blockquote className="graph-quote">{item.excerpt}</blockquote>
          </button>
        </li>
      ))}
      {compact && evidence.length > 1 ? (
        <li className="graph-evidence-more">另有 {evidence.length - 1} 条同类依据</li>
      ) : null}
    </ul>
  );
}

/* ---------------- 抽取管理 ---------------- */

function PaperDetail({
  paper,
  titleByKey,
  nodes,
  onPick,
  onClose,
}: {
  paper: GraphPaper | null;
  titleByKey: Map<string, string>;
  nodes: GraphNode[];
  onPick: (entityId: string) => void;
  onClose: () => void;
}) {
  if (!paper) return null;
  return (
    <div className="graph-detail">
      <div className="graph-detail-head">
        <span className="graph-section-label">论文</span>
        <button type="button" className="graph-close" onClick={onClose} aria-label="关闭论文详情">×</button>
      </div>
      <h2 className="graph-detail-title">{titleByKey.get(paper.key) ?? paper.title ?? paper.key}</h2>
      <p className="graph-detail-summary">包含 {nodes.length} 个图谱实体。选择一个实体查看关系和原文依据。</p>
      <ul className="graph-pending-list">
        {nodes.map((node) => (
          <li key={node.id}>
            <button type="button" className="graph-chip" onClick={() => onPick(node.id)}>
              {node.label}
            </button>
            <span className="graph-evidence-count">{KIND_META[node.kind]?.label ?? node.kind}</span>
          </li>
        ))}
        {!nodes.length ? <li className="text-[11px] text-ink-faint">当前筛选下没有实体。</li> : null}
      </ul>
    </div>
  );
}

/* ---------------- 抽取管理 ---------------- */

function PapersPanel({
  pending,
  papers,
  busyKey,
  onExtract,
  onRemove,
  onClose,
}: {
  pending: { key: string; title: string }[];
  papers: GraphPaper[];
  busyKey: string | null;
  onExtract: (key: string, force: boolean) => Promise<void>;
  onRemove: (key: string) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <div className="graph-papers">
      <div className="graph-papers-head">
        <span className="graph-section-label">抽取管理</span>
        <button type="button" className="graph-close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="graph-papers-cols">
        <div>
          <p className="graph-section-label">未抽取 {pending.length}</p>
          {pending.length ? (
            <ul className="graph-pending-list">
              {pending.map((doc) => (
                <li key={doc.key}>
                  <span className="graph-pending-title" title={doc.title}>
                    {doc.title}
                  </span>
                  <button
                    type="button"
                    className="graph-chip"
                    disabled={busyKey === doc.key}
                    onClick={() => void onExtract(doc.key, false)}
                  >
                    {busyKey === doc.key ? '抽取中…' : '抽取'}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-ink-faint">库里有正文缓存的文献都已抽取。</p>
          )}
        </div>
        <div>
          <p className="graph-section-label">已抽取 {papers.length}</p>
          <ul className="graph-pending-list">
            {papers.map((paper) => (
              <li key={paper.key}>
                <span className="graph-pending-title" title={paper.title}>
                  {paper.title}
                </span>
                <span className="graph-evidence-count">
                  {paper.nodeCount} 节点 · {paper.relationCount} 关系
                  {paper.dropped ? ` · 丢弃 ${paper.dropped}` : ''}
                </span>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    className="graph-chip"
                    disabled={busyKey === paper.key}
                    onClick={() => void onExtract(paper.key, true)}
                  >
                    {busyKey === paper.key ? '…' : '重抽取'}
                  </button>
                  <button
                    type="button"
                    className="graph-chip danger"
                    disabled={busyKey === paper.key}
                    onClick={() => void onRemove(paper.key)}
                  >
                    移除
                  </button>
                </span>
              </li>
            ))}
            {!papers.length ? <li className="text-[11px] text-ink-faint">暂无</li> : null}
          </ul>
        </div>
      </div>
    </div>
  );
}


