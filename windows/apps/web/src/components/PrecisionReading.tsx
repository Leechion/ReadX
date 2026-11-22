import { useEffect, useRef, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { api, type ReadingEntry, type GenerateProgress, type ReadingVisualAnalysis } from '../api/client';
import { parseExperimentEntries, useReadings } from '../hooks/useReadings';
import { usePaperVisuals } from '../hooks/usePaperVisuals';
import type { AIPreferences } from '../hooks/useAIPreferences';
import { ResearchNotesBlock, DetailedResultsBlock, ReproductionNotesBlock, EvidenceField, parseJSONPayload } from './DeepReadingBlocks';
import { ReproductionSection } from './ReproductionSection';
import { PaperVisualGallery } from './PaperVisualGallery';
import { AIModelControls } from './AIModelControls';
import { copyText } from './ChatWorkspace';
import { currentVisualAnalyses } from '../lib/readingVisuals';
import { preparePaperReading } from '../lib/paperReader';
import { READING_STEPS, type ReadingKind } from '../lib/readingSteps';
import { NarrativeReading } from './NarrativeReading';
import { ReadingVisuals } from './ReadingVisuals';
import type { ReactNode } from 'react';
import { downloadBlob } from '../lib/download';

const LABELS: Record<string, string> = { sections: '章节', fields: '证据条目', title: '标题', k: '要点', v: '事实', page: 'Page', excerpt: '逐字依据', formulas: '公式', latex: 'LaTeX', explanation: '解释与条件', dataset: '研究对象与数据', acquisition: '研究设计与条件', training: '实施流程', loss: '分析方法', metrics: '评价标准', baselines: '对照或基线', tables: '结果表', caption: '表题', header: '表头', protocol: '协议', columns: '指标列', rows: '结果行', method: '方法', cells: '数值', valueText: '原始数值', uncertaintyText: '误差', stability: '稳健性', ablation: '组件或分组分析', generalization: '外部验证与泛化', efficiency: '效率与成本', statistics: '统计报告', missing: '缺失信息', resources: '代码、数据与材料', environment: '环境', cost: '资源成本', risks: '风险', finding: '论文依据', assessment: '分析与推断', action: '核对行动', interpretation: '有条件的解读', evidence: '证据' };

function markdownValue(value: unknown, depth = 0): string {
  if (value == null) return '论文未说明';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map((v) => markdownValue(v, depth)).join('\n\n');
  const item = value as Record<string, unknown>;
  if (typeof item.k === 'string' && typeof item.v === 'string') return `- **${item.k}**：${item.v}${typeof item.page === 'number' ? ` (Page ${item.page})` : ''}${typeof item.excerpt === 'string' ? `\n  > ${item.excerpt.replace(/\n/g, '\n  > ')}` : ''}`;
  return Object.entries(item).filter(([key]) => !['id', 'tableID', 'visualID', 'primaryMethodID'].includes(key)).map(([key, v]) => `${'#'.repeat(Math.min(6, depth + 3))} ${LABELS[key] ?? key}\n\n${markdownValue(v, depth + 1)}`).join('\n\n');
}
function entryMarkdown(label: string, entry: ReadingEntry, visuals = entry.visuals ?? []): string {
  let body = entry.narrative || entry.value;
  if (!entry.narrative) try { body = markdownValue(JSON.parse(body)); } catch { /* Preserve legacy prose without truncation. */ }
  body = body.replace(/\[\[visual:([^\]\n]+)\]\]/g, (_, id: string) => { const visual = visuals.find((v) => v.id === id); return visual ? `**${visual.caption}** (Page ${visual.page})` : ''; });
  const visualText = visuals.filter((v) => v.step === READING_STEPS.find((s) => s.label === label)?.kind).map((v: ReadingVisualAnalysis) => '\n\n### ' + v.section + ' (Page ' + v.page + ')\n\n**' + v.caption + '**\n\n图内观察：' + v.observation + '\n\nAI 解读：' + v.analysis + (v.limitations ? '\n\n证据边界：' + v.limitations : '') + (v.evidence ? '\n\n> ' + v.evidence.excerpt : '')).join('');
  return `## ${label}\n\n生成：${entry.updatedAt || '旧版记录'} · ${entry.model || entry.provider || '未记录模型'} · ${entry.reasoningEffort || '默认推理强度'}\n\n${body}${visualText}`;
}

function ExperimentBlock({ entry, onCite, renderVisuals }: { entry: ReadingEntry; onCite: (page: number) => void; renderVisuals?: (section: string) => ReactNode }) {
  const groups = parseExperimentEntries(entry.value);
  if (!groups) return <ResearchNotesBlock entry={entry} onCite={onCite} renderVisuals={renderVisuals} />;
  return <>{groups.filter((group) => group.group !== '结果').map((group) => <section className="reading-section" key={group.group}><h3>{group.group}</h3>{group.fields.length ? group.fields.map((field, i) => <EvidenceField key={i} field={field} onCite={onCite} />) : <p className="precision-muted">暂无配置</p>}{renderVisuals?.(group.group)}</section>)}</>;
}

export function PrecisionReading({ apiKey, onCite, onAsk, disabled, document, pdfDocument, enabled, preferences }: {
  apiKey: string | null; onCite: (page: number) => void; onAsk: (text: string) => void; disabled: boolean; document?: DocumentSummary | null;
  pdfDocument?: PDFDocumentProxy | null; enabled: boolean; preferences: AIPreferences;
}) {
  const reading = useReadings(apiKey);
  const [visualsEnabled, setVisualsEnabled] = useState(enabled);
  useEffect(() => { if (enabled) setVisualsEnabled(true); }, [enabled]);
  // Keep extracted object URLs alive while the user follows a note into chat.
  const { visuals, progress: visualProgress, error: visualError, unlocated, ignoredCount, dismissVisual, restoreIgnored, saveSelection, resetSelection, redetect } = usePaperVisuals(pdfDocument ?? null, visualsEnabled, apiKey);
  const [textOnly, setTextOnly] = useState(false);
  const [active, setActive] = useState<ReadingKind>('motivation');
  const [batch, setBatch] = useState(false);
  const batchLock = useRef(false);
  const batchEpoch = useRef(0);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [repositoryURL, setRepositoryURL] = useState('');
  const [repositoryRetryPending, setRepositoryRetryPending] = useState(false);
  useEffect(() => { ++batchEpoch.current; batchLock.current = false; setBatch(false); setActive('motivation'); setTextOnly(false); setNotice(''); setRepositoryURL(''); setRepositoryRetryPending(false); return () => { ++batchEpoch.current; }; }, [apiKey]);
  const step = READING_STEPS.find((s) => s.kind === active)!;
  const index = READING_STEPS.indexOf(step);
  const entry = reading.entries[active];
  const waitingPDF = enabled && !pdfDocument;
  const preparationBlocked = disabled || !apiKey || preferences.saving || reading.loading || batch || (!textOnly && (!!visualProgress || waitingPDF));
  const blocked = preparationBlocked || !!reading.generating[active];
  const anyGenerating = Object.values(reading.generating).some(Boolean);
  const savedCount = Object.keys(reading.entries).length;
  const readingLabel = (kind: ReadingKind) => reading.generating[kind] ? '正在生成…' : reading.jobErrors[kind] ? '生成失败' : reading.notices[kind]?.skipped ? '已跳过' : reading.entries[kind]?.readerStatus === 'partial' ? '部分已保存' : reading.entries[kind] ? reading.entries[kind]!.validationError ? '待核对' : '已完成' : '尚未生成';
  const remaining = READING_STEPS.filter((s) => (!reading.entries[s.kind] || reading.entries[s.kind]?.readerStatus === 'partial') && !reading.notices[s.kind]?.skipped && !reading.generating[s.kind]);
  const visualReferences = async (signal: AbortSignal, report: (value: GenerateProgress) => void) => ({ ...(await preparePaperReading(apiKey!, pdfDocument ?? null, visuals, textOnly, signal, report)), repositoryURL: repositoryURL.trim() || undefined });
  const retryReproduction = () => { setRepositoryRetryPending(false); setNotice(''); void reading.generate('reproduction', visualReferences); };
  const runningSteps = READING_STEPS.filter((s) => reading.generating[s.kind]);
  const sharedAnalyses = currentVisualAnalyses(entry?.visuals ?? reading.visualAnalysis?.visuals, visuals);
  const inlineItems = sharedAnalyses.filter((item) => item.step === active);
  let sectionNames: string[] = [];
  try {
    const parsed = parseJSONPayload(entry?.value || '{}');
    const raw = (parsed.ok ? parsed.value : {}) as Record<string, unknown>;
    if (active === 'motivation' || active === 'method') sectionNames = Array.isArray(raw.sections) ? raw.sections.filter((s) => s && typeof s.title === 'string' && Array.isArray(s.fields) && s.fields.every((f: { k?: unknown; v?: unknown } | null) => f && typeof f.k === 'string' && typeof f.v === 'string')).map((s: { title: string }) => s.title) : [];
    else if (active === 'experiment') sectionNames = parseExperimentEntries(entry?.value || '')?.filter((g) => g.group !== '结果').map((g) => g.group) ?? [];
    else if (active === 'results' && Array.isArray(raw.tables)) sectionNames = ['结果表', '稳健性', '组件或分组分析', '外部验证与泛化', '效率与成本', '统计报告', '缺失与待核对'];
    else if (active === 'reproduction' && Array.isArray(raw.resources)) sectionNames = ['代码、数据与材料', '环境与依赖', '资源成本', '实现缺失', '风险与评估协议'];
  } catch { /* Older prose receives an illustrated supplement below it. */ }
  const renderVisuals = (section: string) => <ReadingVisuals items={inlineItems.filter((item) => item.section === section)} visuals={visuals} onCite={onCite} />;
  const unplacedSections = entry?.narrative ? [] : [...new Set(inlineItems.filter((item) => !sectionNames.includes(item.section)).map((item) => item.section))];
  const generateRemaining = async () => {
    if (preparationBlocked || batchLock.current) return;
    const pending = remaining;
    if (!pending.length) return;
    const epoch = batchEpoch.current;
    batchLock.current = true; setBatch(true); setNotice('');
    try {
      const preparation = new AbortController();
      const prepared = await visualReferences(preparation.signal, () => undefined);
      if (epoch !== batchEpoch.current) return;
      let sectionInput = prepared;
      if (!textOnly && prepared.visuals.length > 0) {
        const visualsReady = await reading.generate('visuals', prepared);
        if (!visualsReady) setNotice('共享图表分析未完成，继续生成五节正文；可稍后单独重试图表分析。');
        sectionInput = { ...prepared, visuals: [] };
      }
      if (epoch !== batchEpoch.current) return;
      setBatch(false);
      await Promise.all(pending.map((s) => reading.generate(s.kind, sectionInput)));
    } catch (cause) {
      if (epoch === batchEpoch.current) setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally { if (epoch === batchEpoch.current) { batchLock.current = false; setBatch(false); } }
  };
  const exportAll = () => {
    const text = `# ${document?.title || '论文'} · 精读五重奏\n\n${READING_STEPS.map((s) => reading.entries[s.kind] ? entryMarkdown(s.label, reading.entries[s.kind]!, sharedAnalyses) : `## ${s.label}\n\n尚未生成。`).join('\n\n---\n\n')}`;
    downloadBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), `${(document?.title || '精读五重奏').replace(/[\\/:*?"<>|]/g, '_').slice(0, 90)}.md`);
  };
  const saveChecklist = async () => {
    if (!apiKey || !entry || saveLock.current) return;
    saveLock.current = true; setSaving(true); setNotice('');
    try { await api.analyzeReproduction(apiKey, entry.value); setRevision((n) => n + 1); setChecklistOpen(true); setNotice('已保存复现核对清单'); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { saveLock.current = false; setSaving(false); }
  };

  return (
    <div className="precision-workspace" aria-label="五重奏精读">
      {/* 左侧主阅读区：顶栏 + ≤720px 居中散文柱 */}
      <main className="precision-content" role="tabpanel" id={`reading-panel-${active}`} aria-labelledby={`reading-tab-${active}`}>
        <header className="precision-topbar">
          <div className="precision-topbar-crumb">
            <span>0{index + 1} · {step.label}</span>
            <small>{readingLabel(active)}</small>
          </div>
          <div className="precision-topbar-spacer" />
          <div className="precision-topbar-tools">
            <AIModelControls preferences={preferences} compact />
            <button
              type="button"
              className="precision-button primary"
              style={{ minHeight: 30, padding: '4px 10px' }}
              disabled={blocked}
              onClick={() => {
                if (active === 'reproduction' && repositoryURL.trim()) retryReproduction();
                else { setNotice(''); void reading.generate(active, visualReferences); }
              }}
            >
              {reading.generating[active] ? '生成中…' : active === 'reproduction' && repositoryURL.trim() ? '用链接生成' : entry?.readerStatus === 'partial' ? '继续本节' : entry ? '重新生成本节' : '生成本节'}
            </button>
            <button
              type="button"
              className="precision-button"
              style={{ minHeight: 30, padding: '4px 10px' }}
              disabled={!entry}
              onClick={() => entry && void copyText(entryMarkdown(step.label, entry, sharedAnalyses)).then(setNotice)}
            >
              复制
            </button>
          </div>
        </header>

        <div className="precision-doc-pane">
          <div className="precision-doc-col">
            <header className="precision-heading">
              <span className="precision-overline">0{index + 1} / 05 · PAPER WORKBOOK</span>
              <h2>{step.label}</h2>
            </header>

            <div className="precision-actions">
              <button
                type="button"
                className="precision-button"
                disabled={!entry}
                onClick={() => entry && onAsk(`请针对「${step.label}」精读笔记继续分析。\n\n${entryMarkdown(step.label, entry!, sharedAnalyses).slice(0, 12000)}\n\n我的问题：${step.questions[0]}`)}
              >
                向助教追问 ↗
              </button>
            </div>

            {active === 'reproduction' && (
              <div className="precision-repository-input">
                <label htmlFor="precision-repository-url">
                  <span>代码仓库链接 <small>自动识别失败时粘贴 GitHub HTTPS 地址</small></span>
                </label>
                <input
                  id="precision-repository-url"
                  type="url"
                  value={repositoryURL}
                  onChange={(event) => { setRepositoryURL(event.target.value); setRepositoryRetryPending(true); }}
                  placeholder="https://github.com/owner/repository"
                  aria-label="代码仓库链接"
                />
                <button type="button" className="precision-button" disabled={blocked || !repositoryURL.trim()} onClick={retryReproduction}>
                  用此链接重试
                </button>
              </div>
            )}

            {(waitingPDF || visualProgress) && (
              <p className="precision-muted" role="status">
                {waitingPDF ? '正在准备 PDF…' : `正在识别图表 · Page ${visualProgress!.page} / ${visualProgress!.total}`}
              </p>
            )}
            {visualError && <div className="precision-alert" role="alert">{visualError}</div>}
            {(waitingPDF || visualProgress || visualError || textOnly) && (
              <label className="precision-text-mode">
                <input type="checkbox" checked={textOnly} disabled={anyGenerating || batch} onChange={(e) => setTextOnly(e.target.checked)} />
                <span>仅依据正文先生成</span>
              </label>
            )}

            {(batch || anyGenerating) && (
              <div className="precision-progress" role="status" aria-label="精读并行任务进度">
                {batch && !reading.generating.visuals && (
                  <div><strong>正在准备五节并行任务</strong><span>共享论文记忆与图表分析</span></div>
                )}
                {reading.generating.visuals && (
                  <div className="precision-job-progress">
                    <strong>共享图表分析</strong>
                    <span>{reading.progress.visuals?.message || '正在整理图表…'}</span>
                    <progress value={reading.progress.visuals?.percent ?? 0} max={100} aria-label="共享图表分析进度" />
                    <button type="button" className="precision-button" onClick={() => reading.cancel('visuals')}>停止准备</button>
                  </div>
                )}
                {runningSteps.map((item) => (
                  <div className="precision-job-progress" key={item.kind}>
                    <strong>{item.label}</strong>
                    <span>{reading.progress[item.kind]?.message || '正在生成…'}</span>
                    <progress value={reading.progress[item.kind]?.percent ?? 0} max={100} aria-label={`${item.label}进度`} />
                    <button type="button" className="precision-button" onClick={() => reading.cancel(item.kind)}>停止本节</button>
                  </div>
                ))}
                {runningSteps.length > 1 && (
                  <button type="button" className="precision-button" onClick={() => reading.cancel()}>停止全部</button>
                )}
              </div>
            )}

            {reading.error && <div className="precision-alert" role="alert">{reading.error}</div>}
            {notice && <p className="precision-notice" role="status">{notice}</p>}
            {reading.jobErrors[active] && <div className="precision-alert" role="alert">{reading.jobErrors[active]}</div>}
            {reading.notices[active] && !reading.notices[active]!.saved && (
              <div className="precision-alert" role="alert">
                本节未完成，已保留原记录。
                {reading.notices[active]!.validationError && <details><summary>错误详情</summary>{reading.notices[active]!.validationError}</details>}
              </div>
            )}
            {reading.notices[active]?.skipped && !(active === 'reproduction' && repositoryURL.trim() && repositoryRetryPending) && (
              <p className="precision-notice" role="status">{reading.notices[active]!.message || '摘要末句没有代码仓库链接，已跳过代码复现。'}</p>
            )}
            {entry && (
              <p className="precision-provenance">
                {entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '旧版记录'} · {entry.model || entry.provider || '模型未记录'} · {entry.reasoningEffort || '默认推理强度'}
              </p>
            )}
            {reading.loading && <p className="precision-muted">读取已保存的精读记录…</p>}
            {!entry && !reading.loading && !reading.notices[active]?.skipped && (
              <section className="precision-empty">
                <span>0{index + 1}</span>
                <h3>尚未生成</h3>
                <ul>{step.outline.map((item) => <li key={item}>{item}</li>)}</ul>
                {waitingPDF || visualProgress ? <small>正在准备 PDF 与图表目录…</small> : null}
              </section>
            )}

            {entry?.narrative && <NarrativeReading entry={entry} analyses={inlineItems} visuals={visuals} onCite={onCite} />}
            {entry && !entry.narrative && (active === 'motivation' || active === 'method') && <ResearchNotesBlock entry={entry} onCite={onCite} renderVisuals={renderVisuals} />}
            {entry && !entry.narrative && active === 'experiment' && <ExperimentBlock entry={entry} onCite={onCite} renderVisuals={renderVisuals} />}
            {entry && active === 'results' && (!entry.narrative
              ? <DetailedResultsBlock entry={entry} onCite={onCite} renderVisuals={renderVisuals} />
              : entry.value.trim().startsWith('{') && <details className="precision-checklist"><summary>结果数据与对比</summary><DetailedResultsBlock entry={entry} onCite={onCite} /></details>)}
            {active === 'reproduction' && (
              <>
                {entry && (
                  <>
                    {!entry.narrative && <ReproductionNotesBlock entry={entry} onCite={onCite} renderVisuals={renderVisuals} />}
                    {entry.value.trim().startsWith('{') && (
                      <button type="button" className="precision-button primary" disabled={!!entry.validationError || saving} onClick={() => void saveChecklist()}>
                        {saving ? '保存中…' : '保存为复现核对清单'}
                      </button>
                    )}
                  </>
                )}
                {document && (
                  <details className="precision-checklist" open={checklistOpen} onToggle={(e) => setChecklistOpen(e.currentTarget.open)}>
                    <summary>复现核对清单 · 追踪行动进度</summary>
                    <ReproductionSection document={document} documents={[document]} onPick={() => undefined} refreshToken={revision} />
                  </details>
                )}
              </>
            )}

            {!!entry?.readerIssues?.length && (
              <details className="precision-local-issues">
                <summary>未完成的页面或小节 · {entry.readerIssues.length}</summary>
                <ul>{entry.readerIssues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
              </details>
            )}
            {unplacedSections.map((section) => <section className="reading-section" key={section}><h3>{section}</h3>{renderVisuals(section)}</section>)}

            <details className="precision-visual-catalog" id="reading-visual-catalog">
              <summary>图表区 · 全部 {visuals.length} 项 · 识别与选区管理</summary>
              <PaperVisualGallery
                documentKey={apiKey ?? undefined}
                visuals={visuals}
                analyses={sharedAnalyses}
                activeStep={active}
                progress={visualProgress}
                error={visualError}
                waitingPDF={waitingPDF}
                onCite={onCite}
                unlocated={unlocated}
                ignoredCount={ignoredCount}
                onDismiss={dismissVisual}
                onRestoreIgnored={restoreIgnored}
                pdfDocument={pdfDocument}
                onSaveSelection={saveSelection}
                onResetSelection={resetSelection}
                onRedetect={redetect}
              />
            </details>

            <footer className="precision-step-footer">
              <button type="button" className="precision-button" disabled={index === 0} onClick={() => setActive(READING_STEPS[index - 1]!.kind)}>← 上一节</button>
              <span>{index + 1} / 5</span>
              <button type="button" className="precision-button" disabled={index === 4} onClick={() => setActive(READING_STEPS[index + 1]!.kind)}>下一节 →</button>
            </footer>
          </div>
        </div>
      </main>

      {/* 右侧步骤轨道：01 实验动机 .. 05 代码复现 + 进度条 + 导出全部章节 */}
      <nav className="precision-rail" aria-label="精读步骤">
        <div className="precision-rail-ctx">
          <span>精读五重奏 · 进度</span>
          <strong title={document?.title || '当前文献'}>{document?.title || '当前文献'}</strong>
        </div>

        <div className="precision-step-list" role="tablist">
          {READING_STEPS.map((s, i) => {
            const isRunning = !!reading.generating[s.kind];
            const isSkipped = !!reading.notices[s.kind]?.skipped;
            const entryItem = reading.entries[s.kind];
            const isPartial = entryItem?.readerStatus === 'partial';
            const isDone = Boolean(entryItem && !isPartial && !entryItem.validationError && !isRunning);
            const rowClasses = [
              'precision-step-row',
              active === s.kind ? 'is-active' : '',
              isDone ? 'is-done' : '',
              isRunning ? 'is-running' : '',
            ].filter(Boolean).join(' ');

            return (
              <div key={s.kind} className={rowClasses}>
                <button
                  type="button"
                  id={`reading-tab-${s.kind}`}
                  role="tab"
                  aria-selected={active === s.kind}
                  aria-controls={`reading-panel-${s.kind}`}
                  tabIndex={active === s.kind ? 0 : -1}
                  className="precision-step-tab"
                  onClick={() => setActive(s.kind)}
                  onKeyDown={(e) => {
                    if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
                      e.preventDefault();
                      const next = e.key === 'Home' ? 0 : e.key === 'End' ? 4 : (i + (['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : 4)) % 5;
                      setActive(READING_STEPS[next]!.kind);
                      window.document.getElementById(`reading-tab-${READING_STEPS[next]!.kind}`)?.focus();
                    }
                  }}
                >
                  <span className="precision-step-num" aria-hidden="true">
                    {isDone ? '✓' : isSkipped ? '–' : isPartial ? '◐' : entryItem?.validationError ? '!' : i + 1}
                  </span>
                  <span className="precision-step-meta">
                    <b>{s.label}</b>
                    <small>{readingLabel(s.kind)}</small>
                  </span>
                </button>
                {!entryItem && !isRunning && !isSkipped ? (
                  <button
                    type="button"
                    className="precision-step-gen"
                    disabled={preparationBlocked}
                    onClick={() => {
                      setActive(s.kind);
                      setNotice('');
                      void reading.generate(s.kind, visualReferences);
                    }}
                  >
                    生成
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="precision-rail-foot">
          <div className="precision-rail-progress">
            <div className="precision-rail-progress-head">
              <span>已完成</span>
              <span>{savedCount} / 5</span>
            </div>
            <div className="precision-rail-track">
              <i style={{ width: `${(savedCount / 5) * 100}%` }} />
            </div>
          </div>
          <div className="precision-rail-actions">
            <button
              type="button"
              className="precision-button primary"
              disabled={preparationBlocked || !remaining.length}
              onClick={() => void generateRemaining()}
            >
              生成剩余 {remaining.length} 项
            </button>
            <button
              type="button"
              className="precision-button"
              disabled={remaining.length === 5}
              onClick={exportAll}
            >
              导出全部章节 ↓
            </button>
          </div>
        </div>
      </nav>
    </div>
  );
}
