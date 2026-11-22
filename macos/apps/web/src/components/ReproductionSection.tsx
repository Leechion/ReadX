import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import type { ReproductionChecklist, ReproductionItem, RepoCheck } from '../api/client';
import { api } from '../api/client';
import { downloadBlob } from '../lib/download';
import { AppDialog } from './AppDialog';
import { Icon, type IconName } from './ui/Icon';
import { Button, CiteBadge, EmptyState, IconButton, Tabs } from './ui/Primitives';

const GROUPS: { id: keyof ReproductionAnalysis; short: string; label: string; hint: string; icon: IconName }[] = [
  { id: 'resources', short: '资源', label: '资源', hint: '数据 / 代码 / 权重', icon: 'folder' },
  { id: 'environment', short: '环境', label: '环境', hint: '依赖 / 特殊算子', icon: 'code' },
  { id: 'cost', short: '资源成本', label: '资源成本', hint: '时间 / 设备 / 材料', icon: 'timer' },
  { id: 'missing', short: '关键缺失', label: '关键缺失', hint: '几何 / 预处理 / 参数', icon: 'help' },
  { id: 'risks', short: '风险', label: '风险', hint: '实现 / 评测协议', icon: 'alert' },
];

type ReproductionAnalysis = {
  resources: ReproductionItem[];
  environment: ReproductionItem[];
  cost: ReproductionItem[];
  missing: ReproductionItem[];
  risks: ReproductionItem[];
};

const TASK_STATUSES = [
  { id: 'todo', label: '待核对', icon: 'queue' as const },
  { id: 'verified', label: '已核对', icon: 'check' as const },
  { id: 'blocked', label: '受阻', icon: 'alert' as const },
] as const;

/** 核对项 id 与 v1 一致：`字段标题|页码或 unknown`——同一分析里字段+页码唯一。 */
function itemID(item: ReproductionItem): string {
  return `${item.finding.k}|${item.finding.page ?? 'unknown'}`;
}

function StatusSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const current = TASK_STATUSES.find((s) => s.id === value) ?? TASK_STATUSES[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="rx-stsel-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`rx-stsel ${current.id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={current.icon} size={13} />
        <span>{current.label}</span>
        <Icon name="down" size={12} />
      </button>
      {open ? (
        <div
          className="rx-menu absolute left-0 top-[calc(100%+4px)] z-30 min-w-[126px]"
          role="menu"
        >
          {TASK_STATUSES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="menuitemradio"
              aria-checked={s.id === current.id}
              className="rx-menu-item"
              onClick={() => {
                setOpen(false);
                if (s.id !== current.id) onChange(s.id);
              }}
            >
              <Icon name={s.icon} size={14} />
              <span className="flex-1 text-left">{s.label}</span>
              {s.id === current.id ? <Icon name="check" size={13} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 复现任务板（ui-mockup.html #s-repro）。
 *   - 独立工作区（传 onBack）呈 3 栏结构（左侧核对分组/筛选 + 中间 48px 顶栏/堆叠进度/平铺清单 + 右侧检查器：仓库依赖核对 / 分析版本）；
 *   - 内嵌在精读五重奏折叠面板内（无 onBack）时保持紧凑平面列表与规则扫描器。
 */
export function ReproductionSection({
  document,
  documents,
  onPick,
  onBack,
  refreshToken = 0,
}: {
  document: DocumentSummary | null;
  documents: DocumentSummary[];
  onPick: (key: string) => void;
  onBack?: () => void;
  refreshToken?: number;
}) {
  const key = document?.key ?? null;
  const [checklist, setChecklist] = useState<ReproductionChecklist | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [raw, setRaw] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState('');
  const [repoChecks, setRepoChecks] = useState<RepoCheck[]>([]);

  const [ctxOpen, setCtxOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<'repo' | 'versions'>('repo');
  const [activeGroup, setActiveGroup] = useState<keyof ReproductionAnalysis | 'all'>('all');
  const [itemFilter, setItemFilter] = useState<'all' | 'unknown' | 'blocked'>('all');
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!onBack) return;
    const onToggleSidebar = () => setCtxOpen((v) => !v);
    const onToggleInspector = () => setInspectorOpen((v) => !v);
    window.addEventListener('readx-toggle-sidebar', onToggleSidebar);
    window.addEventListener('readx-toggle-inspector', onToggleInspector);
    return () => {
      window.removeEventListener('readx-toggle-sidebar', onToggleSidebar);
      window.removeEventListener('readx-toggle-inspector', onToggleInspector);
    };
  }, [onBack]);

  const load = useCallback(async () => {
    if (!key) {
      setChecklist(null);
      return;
    }
    try {
      const response = await api.reproduction(key);
      setChecklist(response.checklist);
      const revisions = Object.keys(response.checklist.revisions);
      setRevision(revisions.length ? (revisions[revisions.length - 1] ?? null) : null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [key]);

  useEffect(() => {
    setRepoChecks([]);
    setSnapshot('');
    setMessage(null);
    setActiveGroup('all');
    setItemFilter('all');
    void load();
  }, [load]);
  useEffect(() => { if (refreshToken > 0) void load(); }, [refreshToken, load]);

  const analyze = async () => {
    if (!key || !raw.trim()) {
      setMessage('请先粘贴复现分析 JSON');
      return;
    }
    setBusy(true);
    setMessage('校验中…');
    try {
      const result = await api.analyzeReproduction(key, raw.trim());
      setMessage(`已保存 · 分析版本 ${result.revision.slice(0, 12)} · 共 ${result.groups.reduce((sum, group) => sum + group.count, 0)} 项，其中 ${result.unknownCount} 项未知`);
      setRaw('');
      setPasteOpen(false);
      await load();
    } catch (cause) {
      setMessage(`未保存：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const setTask = async (itemId: string, patch: { status?: string; note?: string }) => {
    if (!key || !revision) return;
    try {
      const { task } = await api.setReproductionTask(key, { revision, itemId, ...patch });
      setChecklist((current) => {
        if (!current) return current;
        const tasks = { ...(current.revisions[revision] ?? {}), [itemId]: task };
        return {
          ...current,
          revisions: { ...current.revisions, [revision]: tasks },
        };
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const scanRepo = async () => {
    setMessage(null);
    try {
      const files = parseSnapshot(snapshot);
      if (!files.length) {
        setMessage('代码快照格式不正确：顶格非空行是文件路径，紧接的缩进行是该文件内容。');
        return;
      }
      const result = await api.repoChecks(files);
      setRepoChecks(result.checks);
      setMessage(`识别出 ${result.checks.length} 项仓库核对项。`);
    } catch (cause) {
      setMessage(`扫描失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  const revisions = checklist ? Object.keys(checklist.revisions) : [];
  const analysis = revision && checklist?.analyses[revision] ? checklist.analyses[revision] : null;
  const tasks = revision ? (checklist?.revisions[revision] ?? {}) : {};
  const allItems = analysis ? GROUPS.flatMap((group) => (analysis[group.id] ?? [])) : [];
  const unknownCount = allItems.filter((item) => item.finding.page == null).length;
  const verifiedCount = allItems.filter((item) => (tasks[itemID(item)]?.status ?? 'todo') === 'verified').length;
  const blockedCount = allItems.filter((item) => (tasks[itemID(item)]?.status ?? 'todo') === 'blocked').length;
  const todoCount = Math.max(0, allItems.length - verifiedCount - blockedCount);

  const exportMarkdown = () => {
    if (!document || !analysis) return;
    const lines = [
      `# ${document.title} · 代码复现核对清单`,
      revision ? `分析版本：${revision}` : '',
      `整体进度：${verifiedCount} / ${allItems.length} 已核对 · ${blockedCount} 受阻 · ${unknownCount} 未知`,
      '',
    ];
    for (const g of GROUPS) {
      const items = analysis[g.id] ?? [];
      if (!items.length) continue;
      lines.push(`## ${g.label}（${g.hint}）`);
      for (const item of items) {
        const id = itemID(item);
        const t = tasks[id] ?? { status: 'todo', note: '' };
        const st = TASK_STATUSES.find((s) => s.id === t.status)?.label ?? '待核对';
        lines.push(`- [${t.status === 'verified' ? 'x' : ' '}] **${item.finding.k}**（${st}）`);
        lines.push(`  - 核对行动：${item.action}`);
        lines.push(`  - 原文依据：${item.finding.page != null ? `Page ${item.finding.page}` : '未知（论文未说明）'}`);
        if (t.note) lines.push(`  - 备注：${t.note}`);
      }
      lines.push('');
    }
    downloadBlob(
      new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }),
      `${(document.title || 'reproduction').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}-reproduction.md`,
    );
  };

  if (!document) {
    return (
      <main className="rx-main" style={{ justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <div className="max-w-lg w-full border border-line rounded-[12px] bg-surface p-6">
          <EmptyState
            icon="flask"
            title="选择一篇论文开始复现核对"
            description="把「能不能复现」拆成资源、环境、成本、关键缺失与风险五组核对清单。"
          />
          <div className="mt-4 flex max-h-64 flex-col gap-1.5 overflow-y-auto">
            {documents.map((doc) => (
              <button
                key={doc.id}
                type="button"
                onClick={() => onPick(doc.key)}
                className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2 text-left text-[13px] text-ink hover:border-accent hover:bg-surface-hover"
              >
                <span className="truncate">{doc.title || doc.key}</span>
                <Icon name="right" size={14} />
              </button>
            ))}
          </div>
        </div>
      </main>
    );
  }

  const filterItem = (item: ReproductionItem) => {
    const id = itemID(item);
    const task = tasks[id] ?? { status: 'todo', note: '', updatedAt: '' };
    if (itemFilter === 'unknown') return item.finding.page == null;
    if (itemFilter === 'blocked') return task.status === 'blocked';
    return true;
  };

  const renderChecklistContent = () => (
    <>
      {error ? (
        <div className="rx-banner bad m-4 mb-0" role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
      {message ? (
        <div className="rx-banner info m-4 mb-0" role="status">
          <span>{message}</span>
          <button type="button" className="ml-auto text-[12px] underline" onClick={() => setMessage(null)}>知道了</button>
        </div>
      ) : null}

      {analysis ? (
        <>
          <div className="rx-repro-head">
            <span className="text-[13px] text-ink">
              <b className="font-semibold tabular-nums">{verifiedCount}</b> / <span className="tabular-nums">{allItems.length}</span> 项已核对
            </span>
            <span className="rx-repro-stack" aria-hidden="true">
              <i style={{ width: `${allItems.length ? (verifiedCount / allItems.length) * 100 : 0}%`, background: 'var(--color-good)' }} />
              <i style={{ width: `${allItems.length ? (blockedCount / allItems.length) * 100 : 0}%`, background: 'var(--color-bad)' }} />
            </span>
            <span className="rx-repro-lgd">
              <span><i style={{ background: 'var(--color-good)' }} />已核对 {verifiedCount}</span>
              <span><i style={{ background: 'var(--color-bad)' }} />受阻 {blockedCount}</span>
              <span><i style={{ background: 'var(--color-surface-sunk)', boxShadow: 'inset 0 0 0 1px var(--color-line-strong)' }} />待核对 {todoCount}</span>
              <span><i style={{ border: '1px dashed var(--color-warn)' }} />未知 {unknownCount}</span>
            </span>
          </div>

          <div className="rx-repro-list">
            {GROUPS.filter((g) => activeGroup === 'all' || activeGroup === g.id).map((group) => {
              const items = (analysis[group.id] ?? []).filter(filterItem);
              if (!items.length) return null;
              return (
                <section key={group.id} className="rx-repro-grp">
                  <div className="rx-repro-grp-h">
                    <h4>{group.label}</h4>
                    <small>{group.hint} · <span className="tabular-nums">{items.length}</span> 项</small>
                  </div>
                  {items.map((item) => {
                    const id = itemID(item);
                    const task = tasks[id] ?? { status: 'todo', note: '', updatedAt: '' };
                    const unknown = item.finding.page == null;
                    return (
                      <article key={id} className="rx-repro-chk">
                        <StatusSelector
                          value={task.status}
                          onChange={(next) => void setTask(id, { status: next })}
                        />
                        <b>{item.finding.k}{item.assessment ? ` — ${item.assessment}` : ''}</b>
                        <div className="rx-repro-act">
                          <em>核对行动</em>
                          {item.action}
                        </div>
                        <div>
                          <p className="rx-repro-src">
                            {unknown ? (
                              <>
                                <span className="rx-repro-unknown">
                                  <Icon name="help" size={12} />
                                  未知
                                </span>
                                <span className="text-ink-faint">论文未说明，保持未知，不补造</span>
                              </>
                            ) : (
                              <>
                                <span className="text-ink-faint">原文</span>
                                <CiteBadge label={`Page ${item.finding.page}`} />
                                {item.finding.excerpt ? (
                                  <span className="text-ink-faint truncate max-w-[460px]" title={item.finding.excerpt}>
                                    {item.finding.excerpt}
                                  </span>
                                ) : null}
                              </>
                            )}
                          </p>
                          <div className={`rx-note-in${task.note ? ' has' : ''}`}>
                            <Icon name="pen" size={12} />
                            <input
                              defaultValue={task.note}
                              placeholder="添加备注"
                              aria-label={`${item.finding.k} 核对备注`}
                              onBlur={(event) => {
                                if (event.target.value !== task.note) {
                                  void setTask(id, { note: event.target.value });
                                }
                              }}
                            />
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </section>
              );
            })}
          </div>
        </>
      ) : (
        <div className="p-8">
          <EmptyState
            icon="flask"
            title="暂无复现清单"
            description="在阅读页「精读五重奏 · 代码复现」生成后可一键保存，或点击右上角粘贴 AI 产出的复现分析 JSON。"
            action={
              <Button variant="primary" size="sm" onClick={() => setPasteOpen(true)}>
                <Icon name="import" size={14} />
                <span>粘贴分析 JSON</span>
              </Button>
            }
          />
        </div>
      )}
    </>
  );

  // Embedded mode inside PrecisionReading <details>
  if (!onBack) {
    return (
      <div className="flex flex-col gap-3">
        {renderChecklistContent()}
        <div className="border-t border-line pt-3">
          <div className="text-[12px] font-semibold mb-1.5">仓库依赖核对（R-11）</div>
          <textarea
            value={snapshot}
            onChange={(event) => setSnapshot(event.target.value)}
            rows={4}
            placeholder={'requirements.txt\n  torch==2.1.0\n  tinycudann\ntrain.py\n  from tigre import Ax'}
            className="rx-code-in"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void scanRepo()}>
              <Icon name="search" size={13} />
              <span>扫描核对项</span>
            </Button>
            <span className="text-[12px] text-ink-faint">只做规则匹配，不执行仓库代码。</span>
          </div>
          {repoChecks.length ? (
            <div className="mt-2">
              {repoChecks.map((check) => (
                <div key={check.id} className="rx-repro-scan">
                  <span className="rx-chip info">{check.kind}</span>
                  <span className="grow">{check.detail}</span>
                  <code>{check.path}{check.line != null ? `:${check.line}` : ''}</code>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // Standalone 3-column workspace (4 columns total with ActivityRail)
  return (
    <div className="rx-repro-shell">
      <aside className={`rx-ctx${ctxOpen ? '' : ' collapsed'}`} aria-label="核对分组与筛选">
        <div className="rx-ctx-head">复现准备</div>
        <div className="rx-ctx-sub" title={document.title}>{document.title || document.key}</div>

        <div className="rx-ctx-group">
          <div className="rx-ctx-label">核对分组</div>
          <button
            type="button"
            className="rx-ctx-item"
            aria-current={activeGroup === 'all' && itemFilter === 'all' ? 'page' : undefined}
            onClick={() => { setActiveGroup('all'); setItemFilter('all'); }}
          >
            <Icon name="list" size={15} />
            <span>全部分组</span>
            <span className="rx-ctx-count">{verifiedCount}/{allItems.length}</span>
          </button>
          {GROUPS.map((g) => {
            const list = analysis?.[g.id] ?? [];
            const done = list.filter((item) => (tasks[itemID(item)]?.status ?? 'todo') === 'verified').length;
            return (
              <button
                key={g.id}
                type="button"
                className="rx-ctx-item"
                aria-current={activeGroup === g.id ? 'page' : undefined}
                onClick={() => { setActiveGroup(g.id); setItemFilter('all'); }}
              >
                <Icon name={g.icon} size={15} />
                <span>{g.short}</span>
                <span className="rx-ctx-count">{done}/{list.length}</span>
              </button>
            );
          })}
        </div>

        <div className="rx-ctx-group">
          <div className="rx-ctx-label">筛选</div>
          <button
            type="button"
            className="rx-ctx-item"
            aria-current={itemFilter === 'unknown' ? 'page' : undefined}
            onClick={() => { setActiveGroup('all'); setItemFilter((v) => (v === 'unknown' ? 'all' : 'unknown')); }}
          >
            <span className="inline-block w-2 h-2 rounded-full bg-warn shrink-0" />
            <span>只看未知项</span>
            <span className="rx-ctx-count">{unknownCount}</span>
          </button>
          <button
            type="button"
            className="rx-ctx-item"
            aria-current={itemFilter === 'blocked' ? 'page' : undefined}
            onClick={() => { setActiveGroup('all'); setItemFilter((v) => (v === 'blocked' ? 'all' : 'blocked')); }}
          >
            <span className="inline-block w-2 h-2 rounded-full bg-bad shrink-0" />
            <span>只看受阻</span>
            <span className="rx-ctx-count">{blockedCount}</span>
          </button>
        </div>

        <div className="rx-ctx-foot">
          <button type="button" className="rx-ctx-item" onClick={() => setPickerOpen(true)}>
            <Icon name="left" size={15} />
            <span>换一篇论文</span>
          </button>
        </div>
      </aside>

      <main className="rx-main">
        <header className="rx-topbar">
          <IconButton
            size="sm"
            icon="sidebar"
            label="开关左侧分组栏 (Ctrl+\)"
            active={ctxOpen}
            onClick={() => setCtxOpen((v) => !v)}
          />
          <h1 className="rx-topbar-title">复现清单</h1>
          {revision ? (
            <span className="rx-chip tabular-nums">分析版本 {revision.slice(0, 8)}</span>
          ) : null}
          <span className="rx-spacer" />
          <Button variant="secondary" size="sm" onClick={() => setPasteOpen(true)}>
            <Icon name="import" size={14} />
            <span>粘贴分析 JSON</span>
          </Button>
          <Button variant="ghost" size="sm" disabled={!analysis} onClick={exportMarkdown}>
            <Icon name="export" size={14} />
            <span>导出清单</span>
          </Button>
          <IconButton
            size="sm"
            icon="panel"
            label="开关右侧核对检查器 (Ctrl+.)"
            active={inspectorOpen}
            onClick={() => setInspectorOpen((v) => !v)}
          />
        </header>

        {renderChecklistContent()}
      </main>

      <aside className={`rx-inspector${inspectorOpen ? '' : ' collapsed'}`} aria-label="仓库依赖与版本检查器">
        <Tabs
          value={inspectorTab}
          onChange={setInspectorTab}
          items={[
            { value: 'repo', label: '仓库依赖核对' },
            { value: 'versions', label: '分析版本', badge: revisions.length || undefined },
          ]}
        />
        <div className="rx-inspector-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {inspectorTab === 'repo' ? (
            <>
              <div className="rx-field">
                <label htmlFor="rx-repo-snapshot">粘贴代码快照</label>
                <small>顶格的非空行是文件路径，下面缩进的行是这个文件的内容。</small>
                <textarea
                  id="rx-repo-snapshot"
                  value={snapshot}
                  onChange={(event) => setSnapshot(event.target.value)}
                  rows={6}
                  placeholder={'requirements.txt\n  torch==2.1.0\n  tinycudann\n  tigre>=2.4\ntrain.py\n  from tigre import Ax\n  ckpt = "weights/naf_init.pth"'}
                  className="rx-code-in"
                />
              </div>

              <Button variant="primary" onClick={() => void scanRepo()} style={{ justifyContent: 'center' }}>
                <Icon name="search" size={14} />
                <span>扫描核对项</span>
              </Button>

              <p className="text-[12px] text-ink-faint m-0 leading-relaxed">
                只做规则匹配，不执行仓库代码，也不发网络请求。
              </p>

              {repoChecks.length > 0 ? (
                <div>
                  <div className="rx-ctx-label" style={{ padding: '4px 0 6px' }}>识别出 {repoChecks.length} 项</div>
                  {repoChecks.map((check) => (
                    <div key={check.id} className="rx-repro-scan">
                      <span className={`rx-chip ${check.kind === 'weight' || check.kind === 'data' ? 'warn' : 'info'}`}>
                        {check.kind}
                      </span>
                      <span className="grow" title={check.detail}>{check.detail}</span>
                      <code>{check.path}{check.line != null ? `:${check.line}` : ''}</code>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="rx-repro-ver mt-auto">
                <Icon name="file" size={15} />
                <span>
                  <b>新分析不继承旧的核对结果。</b>按内容指纹归档，历史分析版本仍可切换查看。
                </span>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="rx-ctx-label" style={{ padding: '2px 0' }}>已归档版本</div>
              {revisions.length > 0 ? (
                revisions.slice().reverse().map((rev) => {
                  const revTasks = checklist?.revisions[rev] ?? {};
                  const revVerified = Object.values(revTasks).filter((t) => t.status === 'verified').length;
                  return (
                    <button
                      key={rev}
                      type="button"
                      className="rx-ctx-item"
                      aria-current={revision === rev ? 'page' : undefined}
                      onClick={() => setRevision(rev)}
                    >
                      <Icon name="file" size={14} />
                      <span className="font-mono text-[12px]">{rev.slice(0, 12)}</span>
                      <span className="rx-ctx-count">{revVerified} 已核对</span>
                    </button>
                  );
                })
              ) : (
                <p className="text-[12px] text-ink-faint m-0">还没有归档的分析版本。</p>
              )}
              <div className="rx-repro-ver mt-2">
                <Icon name="file" size={15} />
                <span>
                  <b>新分析不继承旧的核对结果。</b>按内容指纹归档，避免错把旧版本的核对勾到新分析上。
                </span>
              </div>
            </div>
          )}
        </div>
      </aside>

      {pasteOpen ? (
        <AppDialog open onClose={() => setPasteOpen(false)} className="app-dialog" aria-labelledby="rx-paste-json-title">
          <header>
            <h2 id="rx-paste-json-title">粘贴复现分析 JSON</h2>
            <IconButton size="sm" icon="x" label="关闭" onClick={() => setPasteOpen(false)} />
          </header>
          <div className="rx-field">
            <label htmlFor="rx-repro-json">JSON 内容（由 AI 产出，服务端会校验页码与原文证据）</label>
            <textarea
              id="rx-repro-json"
              autoFocus
              rows={8}
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              placeholder='{"resources":[...],"environment":[...],"cost":[...],"missing":[...],"risks":[...]}'
              className="rx-code-in"
              style={{ minHeight: 180 }}
            />
          </div>
          {message ? <p className="text-[12px] text-ink-soft mt-2 mb-0">{message}</p> : null}
          <footer>
            <Button variant="ghost" onClick={() => setPasteOpen(false)}>取消</Button>
            <Button variant="primary" disabled={busy || !raw.trim()} onClick={() => void analyze()}>
              {busy ? '校验中…' : '校验并保存'}
            </Button>
          </footer>
        </AppDialog>
      ) : null}

      {pickerOpen ? (
        <AppDialog open onClose={() => setPickerOpen(false)} className="app-dialog" aria-labelledby="rx-pick-doc-title">
          <header>
            <h2 id="rx-pick-doc-title">切换复现论文</h2>
            <IconButton size="sm" icon="x" label="关闭" onClick={() => setPickerOpen(false)} />
          </header>
          <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
            {documents.map((doc) => (
              <button
                key={doc.id}
                type="button"
                onClick={() => { onPick(doc.key); setPickerOpen(false); }}
                className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-[13px] ${
                  doc.key === key
                    ? 'border-accent bg-accent-soft text-accent font-medium'
                    : 'border-line bg-surface text-ink hover:border-line-strong'
                }`}
              >
                <span className="truncate">{doc.title || doc.key}</span>
                {doc.key === key ? <Icon name="check" size={14} /> : <Icon name="right" size={14} />}
              </button>
            ))}
          </div>
        </AppDialog>
      ) : null}
    </div>
  );
}

/**
 * 解析代码快照文本：不缩进的非空行是文件路径，紧接的缩进行是它的内容。
 * 这让用户能直接把 `tree`/`cat` 的输出粘进来，而不必手写 JSON。
 */
function parseSnapshot(text: string): { path: string; lines: string[] }[] {
  const files: { path: string; lines: string[] }[] = [];
  let current: { path: string; lines: string[] } | null = null;
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue;
    const indented = /^\s/.test(rawLine);
    if (!indented) {
      current = { path: rawLine.trim(), lines: [] };
      files.push(current);
    } else if (current) {
      current.lines.push(rawLine.replace(/^\s+/, ''));
    }
  }
  return files;
}
