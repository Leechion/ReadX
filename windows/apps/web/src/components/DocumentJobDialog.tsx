import { useEffect, useState } from 'react';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { formatBadgeLabel, isSectionFormat, sectionDownloadInfo } from '@cbct/shared';
import { api, type DocumentJob, type JobStage } from '../api/client';
import { AppDialog } from './AppDialog';
import { downloadBlob } from '../lib/download';

GlobalWorkerOptions.workerSrc = workerURL;

interface JobDocument {
  key: string;
  title: string;
  translatedTitle?: string;
  authors?: string[];
  venue?: string;
  year?: number | null;
  doi?: string;
  format?: string;
  hasPdf?: boolean;
  addedAt?: string;
}

const STATUS_LABEL: Record<string, string> = {
  running: '处理中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

const STAGE_LABEL: Record<string, string> = {
  pending: '等待中',
  running: '处理中',
  done: '已完成',
  failed: '失败',
  skipped: '跳过',
  cancelled: '已取消',
  interrupted: '已中断',
};

type Tab = 'overview' | 'progress' | 'files';

function stageOf(job: DocumentJob | null, key: string): JobStage | undefined {
  return job?.stages.find((stage) => stage.key === key);
}

function stageCount(stage: JobStage | undefined) {
  if (!stage || stage.total <= 0) return '';
  return `${Math.max(0, stage.completed)} / ${stage.total}`;
}

function stageUnit(stage: JobStage | undefined) {
  if (stage?.unit) return stage.unit;
  if (stage?.key === 'translate') return '段';
  return stage?.key === 'memory' ? '份' : '页';
}

/**
 * 文档任务面板：对齐 LeePDF 的 OCR → 翻译 → 渲染 进度页。
 *
 * 左侧是原页封面、题录与下载；右侧分「概览 / 进度 / 文件」三个标签。
 * 任务数据来自导入时持久化的 job，运行中每隔 1.2s 轮询，可随时取消。
 */
export function DocumentJobDialog({
  document,
  fileKey,
  jobKey,
  coverFile,
  importing = false,
  pending = false,
  errorMessage = '',
  onClose,
  onOpenReader,
}: {
  document: JobDocument;
  /** Original library key when jobKey identifies a retranslation attempt. */
  fileKey?: string;
  /** 导入过程中文档尚未入库：用服务端提前返回的任务键轮询任务。 */
  jobKey?: string | null;
  /** 导入中的封面直接用本地文件渲染，避免请求还不存在的文档文件。 */
  coverFile?: File;
  importing?: boolean;
  pending?: boolean;
  errorMessage?: string;
  onClose: () => void;
  onOpenReader: () => void;
}) {
  // 重新处理后改追新的任务键（retranslate-*）：任务键会变，但资源永远属于文档。
  const [restartJobKey, setRestartJobKey] = useState<string | null>(null);
  const [resolvedLibraryKey, setResolvedLibraryKey] = useState('');
  const activeJobKey = restartJobKey ?? jobKey ?? null;
  const effectiveKey = pending && !jobKey ? '' : activeJobKey || document.key;
  // 追 retranslate 任务时不能用任务键找文件：原版 PDF 与封面都在文档名下。
  const assetKey = fileKey || (restartJobKey ? document.key : effectiveKey);
  const [tab, setTab] = useState<Tab>('progress');
  const [job, setJob] = useState<DocumentJob | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [cover, setCover] = useState('');
  const [notice, setNotice] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // 历史导入任务可能仍显示「正在导入」，但同编号论文实际上已在书库里。
  // 查证后才能提供重新翻译，不能把尚未入库的任务键直接当作文档键。
  useEffect(() => {
    setResolvedLibraryKey('');
    const candidate = fileKey || document.key;
    if (!importing || !candidate || !job || !['interrupted', 'failed', 'cancelled'].includes(job.status)) return;
    let cancelled = false;
    void api.document(candidate).then((detail) => {
      if (!cancelled && detail.document.format === 'pdf' && detail.document.hasPdf) setResolvedLibraryKey(detail.document.key);
    }).catch(() => { /* 尚未入库时保留原状态，不显示不可用的操作。 */ });
    return () => { cancelled = true; };
  }, [importing, fileKey, document.key, job?.status]);

  useEffect(() => {
    if (!effectiveKey) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await api.documentJob(effectiveKey);
        if (cancelled) return;
        setJob(response.available ? response.job ?? null : null);
        setLoaded(true);
        if (response.job?.status === 'running' || response.job?.stages.some((stage) => stage.status === 'running')) {
          timer = window.setTimeout(load, 1200);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [effectiveKey, refreshKey]);

  // 封面用原 PDF 第一页渲染；导入中直接用本地文件，失败时退回纯色封面。
  useEffect(() => {
    let cancelled = false;
    setCover('');
    if (isSectionFormat(document.format)) return;
    if (!coverFile && !assetKey) return;
    if (!coverFile && importing && !fileKey) return;
    void (async () => {
      const data = coverFile ? await coverFile.arrayBuffer() : await api.file(assetKey);
      if (cancelled) return;
      const pdf = await getDocument({ data: new Uint8Array(data) }).promise;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const width = 260;
      const viewport = page.getViewport({ scale: width / base.width });
      const canvas = window.document.createElement('canvas');
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      await page.render({ canvasContext: context, viewport }).promise;
      if (!cancelled) setCover(canvas.toDataURL('image/png'));
    })().catch((error) => {
      // 封面只是装饰：失败时退回纯色封面，但保留日志便于排查。
      console.error('job cover failed', error);
    });
    return () => {
      cancelled = true;
    };
  }, [coverFile, assetKey, document.format, importing, fileKey]);

  const copyKey = async () => {
    if (!effectiveKey) return;
    try {
      await navigator.clipboard.writeText(effectiveKey);
      setNotice('已复制文档编号');
    } catch {
      setNotice('复制失败，请手动选择文本');
    }
    window.setTimeout(() => setNotice(''), 1600);
  };

  const download = (blob: Blob, name: string) => {
    downloadBlob(blob, name);
  };

  const downloadOriginal = async () => {
    if (!assetKey) return;
    setNotice('');
    try {
      const data = await api.file(assetKey);
      const section = isSectionFormat(document.format) ? sectionDownloadInfo(document.format!) : null;
      download(new Blob([data], { type: section?.mime ?? 'application/pdf' }), `${effectiveKey}.${section?.suffix.slice(1) ?? 'pdf'}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const downloadTranslated = async () => {
    if (!assetKey) return;
    setNotice('');
    try {
      download(await api.downloadTranslatedPDF(assetKey), `${assetKey}-translated.pdf`);
    } catch {
      setNotice('还没有生成译文 PDF：先在阅读器里“导出译文 PDF”。');
    }
  };

  const cancel = async () => {
    if (!effectiveKey) return;
    setNotice('');
    try {
      const result = await api.cancelDocumentJob(effectiveKey);
      setNotice(result.cancelled ? '已请求取消任务' : '任务已经结束，无需取消');
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * 一键重新处理：中断/失败/取消之后，点一下就把处理任务重新提交。
   *
   * 走的是书库里「重新翻译」的同一条接口：有可复用的识别结果就直接续着翻，
   * 没有就如实把服务端的原因带回来（例如需要先重新识别），绝不假装成功。
   */
  const restart = async () => {
    if (!libraryKey || restarting) return;
    setRestarting(true);
    setNotice('');
    try {
      const result = await api.retranslate(libraryKey);
      setRestartJobKey(result.jobKey);
      setNotice('已重新提交处理任务，正在跟踪新的进度。');
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestarting(false);
    }
  };

  const status = job?.status ?? '';
  const jobRunning = status === 'running' || pending;
  const pages = job?.pages || 0;
  const ocrStage = stageOf(job, 'ocr');
  const translateStage = stageOf(job, 'translate');
  const renderStage = stageOf(job, 'render');
  const memoryStage = stageOf(job, 'memory');
  const memoryRunning = memoryStage?.status === 'running';
  const tracking = jobRunning || memoryRunning;
  const translationUnit = stageUnit(translateStage);
  const renderingUnit = stageUnit(renderStage);
  const translationCompleted = Math.max(0, translateStage?.completed ?? 0);
  const translationTotal = Math.max(0, translateStage?.total ?? 0);
  const processedPages = Math.max(0, renderStage?.completed ?? 0);
  const ocrPages = Math.max(0, ocrStage?.completed ?? 0);
  const ocrTotalPages = Math.max(0, ocrStage?.total || pages);
  const renderTotal = Math.max(0,
    renderStage?.total || (renderStage?.status === 'pending' && ocrStage?.status === 'done' ? ocrTotalPages : 0),
  );
  const statusText = memoryRunning && status === 'done'
    ? '入库完成，论文记忆处理中'
    : status ? STATUS_LABEL[status] ?? status : pending ? '处理中' : '还没有任务记录';
  const activeMessage = tracking ? job?.stages.find((stage) => stage.status === 'running' && stage.message)?.message : '';
  const statusDetail = job
    ? isSectionFormat(document.format)
      ? '按章节结构保存；无需 OCR 和 PDF 版面渲染'
      : activeMessage
      ? activeMessage
      : translationTotal > 0
      ? `已处理 ${translationCompleted} / ${translationTotal} ${translationUnit} · 排版 ${processedPages} / ${renderTotal || '—'} ${renderingUnit}`
      : `排版 ${processedPages} / ${renderTotal || '—'} ${renderingUnit}`
    : pending
      ? isSectionFormat(document.format) ? '正在上传文件，任务创建后显示章节导入状态' : '正在上传文件，任务创建后显示 OCR 进度'
      : isSectionFormat(document.format) ? '导入后这里会显示章节导入状态。' : '导入后这里会显示 LeePDF 的 OCR、翻译与渲染进度。';
  const openDisabled = importing || !effectiveKey || job?.status === 'failed' || job?.status === 'cancelled';
  // 能否一键重新处理：文档已入库（PDF）、当前没有在跑的任务、且翻译这一段确实停在中途。
  const translateInterrupted = translateStage
    ? ['interrupted', 'failed', 'cancelled'].includes(translateStage.status)
    : false;
  const libraryKey = fileKey || resolvedLibraryKey || (!importing ? document.key : '');
  const reprocessable = Boolean(job) && Boolean(libraryKey) && (!importing || Boolean(fileKey || resolvedLibraryKey)) && !pending
    && !tracking && !isSectionFormat(document.format)
    && (['interrupted', 'failed', 'cancelled'].includes(status) || translateInterrupted);

  return (
    <AppDialog open onClose={onClose} className="job-dialog" aria-label="文档任务">
      <header className="job-dialog-header">
        <div>
          <p className="precision-overline">{importing ? '正在导入' : '文档处理'}</p>
          <h2>{document.title || '未命名文档'}</h2>
        </div>
        <div className="job-header-tools">
          {tracking ? <span className="job-header-state"><i /> {memoryRunning && !jobRunning ? '论文记忆处理中' : '正在处理'}</span> : null}
          <button type="button" onClick={onClose} aria-label="关闭任务面板">×</button>
        </div>
      </header>

      <div className="job-layout">
        <aside className="job-side">
          <div className={`job-cover${cover ? ' has-image' : ''}`}>
            {cover ? <img src={cover} alt="文档封面" /> : <span>{document.title || '未命名文档'}</span>}
          </div>
          <div className="job-document-heading">
            <span className="job-document-type">{(document.format || 'PDF').toUpperCase()} 文档</span>
            <h3>{document.title || '未命名文档'}</h3>
          </div>
          {document.translatedTitle ? <p className="job-subtitle">{document.translatedTitle}</p> : null}
          <p className="job-author">
            <span aria-hidden="true">◉</span>
            {document.authors?.length ? document.authors.join('，') : '未知作者'}
          </p>
          <button type="button" className="job-id" onClick={copyKey} title="复制文档编号">
            <span aria-hidden="true">#</span> {effectiveKey || '任务创建中…'}
            <span aria-hidden="true">⧉</span>
          </button>
          <button type="button" className="job-primary" onClick={() => { if (!openDisabled) onOpenReader(); }} disabled={openDisabled}>
            <span aria-hidden="true">◉</span> 查看原版
          </button>
          <div className="job-downloads" aria-label="文件下载">
            <p className="job-side-label">文件与阅读</p>
            <div>
              <button type="button" onClick={downloadOriginal} disabled={openDisabled} title="下载原文件" aria-label="下载原文件">⇩</button>
              <button type="button" onClick={() => { if (!openDisabled) onOpenReader(); }} disabled={openDisabled} title="在阅读器中打开" aria-label="在阅读器中打开">▤</button>
              {!isSectionFormat(document.format) ? <button type="button" onClick={downloadTranslated} disabled={openDisabled} title="下载译文 PDF" aria-label="下载译文 PDF">Aa</button> : null}
            </div>
          </div>
        </aside>

        <section className="job-main">
          <nav className="job-tabs" role="tablist" aria-label="任务视图">
            {([
              ['overview', '概览'],
              ['progress', '进度'],
              ['files', '文件'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                <span aria-hidden="true">{id === 'overview' ? '▤' : id === 'progress' ? '◔' : '▣'}</span>
                {label}
              </button>
            ))}
          </nav>

          {tab === 'progress' ? (
            <div className="job-progress">
              <div className="job-progress-heading">
                <div>
                  <span className="job-eyebrow">处理工作区</span>
                  <h3>{statusText}</h3>
                  <p>{statusDetail}</p>
                </div>
                <div className="job-progress-summary">
                  <span>{isSectionFormat(document.format) ? '章节' : `翻译进度（${translationUnit}）`}</span>
                  <strong>{isSectionFormat(document.format) ? '章节导入' : `${translationCompleted}`}<small>{isSectionFormat(document.format) ? '' : ` / ${translationTotal || '—'}`}</small></strong>
                  {!isSectionFormat(document.format) ? <div className="job-meter" role="progressbar" aria-label="翻译进度" aria-valuemin={0} aria-valuemax={translationTotal || 1} aria-valuenow={translationCompleted}><span style={{ width: `${translationTotal ? Math.min(100, (translationCompleted / translationTotal) * 100) : 0}%` }} /></div> : null}
                </div>
              </div>

              <section className="job-card job-pipeline-card">
                <div className="job-status">
                  <span className={`job-spinner${tracking ? ' running' : ''}`} aria-hidden="true">{tracking ? '↻' : status === 'done' ? '✓' : '!'}</span>
                  <div>
                    <strong>处理流程</strong>
                    <p>{activeMessage || (isSectionFormat(document.format) ? '保留原章节结构并准备阅读' : '识别原文、翻译段落并生成可读译文')}</p>
                  </div>
                </div>

                <ol className="job-stages job-stages-horizontal" aria-label="导入阶段">
                  {(job?.stages ?? [
                    { key: 'ocr', label: 'OCR', status: 'pending', message: '', completed: 0, total: 0 },
                    { key: 'translate', label: '翻译', status: 'pending', message: '', completed: 0, total: 0 },
                    { key: 'render', label: '渲染', status: 'pending', message: '', completed: 0, total: 0 },
                    { key: 'memory', label: '论文记忆', status: 'pending', message: '', completed: 0, total: 0 },
                  ]).map((stage, index, list) => (
                    <li key={stage.key} data-status={stage.status}>
                      <span className="job-stage-dot" aria-hidden="true">{stage.status === 'done' ? '✓' : stage.status === 'running' ? <i /> : index + 1}</span>
                      <div>
                        <p>
                          <strong>{stage.label}</strong>
                          <span className="job-chip">{STAGE_LABEL[stage.status] ?? stage.status}</span>
                        </p>
                        {stageCount(stage) ? <span className="job-stage-count">{stageCount(stage)} {stageUnit(stage)}</span> : null}
                        {stage.message ? <small>{stage.message}</small> : null}
                      </div>
                      {index < list.length - 1 ? <span className="job-stage-line" aria-hidden="true" /> : null}
                    </li>
                  ))}
                </ol>
              </section>

              <button type="button" className="job-live" onClick={() => { if (!openDisabled) onOpenReader(); }} disabled={openDisabled}>
                <span aria-hidden="true">↗</span>
                <div>
                  <strong>{isSectionFormat(document.format) ? '打开文档阅读器' : '打开译文阅读器'}</strong>
                  <small>{importing ? '处理完成后可打开' : isSectionFormat(document.format) ? '保留原章节结构' : '查看 ReadX 生成的译文 PDF'}</small>
                </div>
                <span className="job-live-shortcut">打开</span>
              </button>

              <div className="job-actions">
                {jobRunning ? (
                  <button type="button" className="job-cancel" onClick={cancel}>取消任务</button>
                ) : (
                  <>
                    {reprocessable ? (
                      <button
                        type="button"
                        className="job-restart"
                        onClick={() => void restart()}
                        disabled={restarting}
                        title="重新提交处理任务：复用已有识别结果继续翻译与排版；缺少可复用结果时会如实说明"
                      >
                        <span aria-hidden="true">↻</span> {restarting ? '正在提交…' : '重新处理'}
                      </button>
                    ) : null}
                    <span className="job-action-note">{memoryRunning ? '译文已入库，论文记忆后台整理中' : job ? `任务${STATUS_LABEL[status] ?? status}` : '尚无运行中的任务'}</span>
                  </>
                )}
                <span className="job-meta">{isSectionFormat(document.format) ? `${formatBadgeLabel(document.format)} · 章节结构` : `OCR · ${job?.stages.find((stage) => stage.key === 'ocr')?.status === 'done' ? '已识别' : '未完成'}`}</span>
                <button type="button" onClick={() => setDetailsOpen((value) => !value)}>
                  {detailsOpen ? '收起' : '详情'}
                </button>
              </div>

              {detailsOpen ? (
                <section className="job-card job-details">
                  <p className="job-side-label">任务详情</p>
                  <dl className="job-detail">
                    <dt>开始时间</dt><dd>{job ? new Date(job.startedAt).toLocaleString([], { hour12: false }) : '—'}</dd>
                    <dt>最后更新</dt><dd>{job ? new Date(job.updatedAt).toLocaleString([], { hour12: false }) : '—'}</dd>
                    <dt>页数</dt><dd>{pages || '—'}</dd>
                    <dt>状态</dt><dd>{STATUS_LABEL[status] ?? (status || '—')}</dd>
                    {job?.stages.map((stage) => (
                      <div key={stage.key} className="job-detail-row">
                        <dt>{stage.label}</dt>
                        <dd>{stage.status} · {stage.message || '—'}（{Math.max(0, stage.completed)}/{Math.max(0, stage.total)} {stageUnit(stage)}）</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}

              {notice ? <p className="job-notice" role="status">{notice}</p> : null}
              {errorMessage ? <p className="job-error" role="alert">{errorMessage}</p> : null}

              {isSectionFormat(document.format) ? (
                <section className="job-card" aria-label="章节导入进度">
                  <p className="job-side-label">章节文档处理方式</p>
                  <p>按原章节结构保存并在阅读器中打开；无需 OCR 和 PDF 版面渲染。</p>
                </section>
              ) : <section className="job-progress-metrics" aria-label="翻译和排版进度">
                <article className="job-card job-metric-card">
                  <div className="job-metric-heading"><span className="job-metric-icon">文</span><span>翻译进度</span></div>
                  <strong>{translationCompleted}<small> / {translationTotal || '—'} {translationUnit}</small></strong>
                  <div className="job-meter" role="progressbar" aria-label="翻译进度" aria-valuemin={0} aria-valuemax={translationTotal || 1} aria-valuenow={translationCompleted}>
                    <span style={{ width: `${translationTotal ? Math.min(100, (translationCompleted / translationTotal) * 100) : 0}%` }} />
                  </div>
                  <small className="job-metric-foot">
                    {translateStage?.resultCount
                      ? `已缓存 ${translateStage.resultCount} ${translateStage.resultUnit || '段'}译文 · OCR 已识别 ${ocrPages} / ${ocrTotalPages || '—'} 页`
                      : `OCR 已识别 ${ocrPages} / ${ocrTotalPages || '—'} 页`}
                  </small>
                </article>
                <article className="job-card job-metric-card">
                  <div className="job-metric-heading"><span className="job-metric-icon">页</span><span>译文页面排版</span></div>
                  <strong>{processedPages}<small> / {renderTotal || '—'} {renderingUnit}</small></strong>
                  <div className="job-meter" role="progressbar" aria-label="排版进度" aria-valuemin={0} aria-valuemax={renderTotal || 1} aria-valuenow={processedPages}>
                    <span style={{ width: `${renderTotal ? Math.min(100, (processedPages / renderTotal) * 100) : 0}%` }} />
                  </div>
                  <small className="job-metric-foot">{renderStage?.message || '等待翻译段落处理完成'}</small>
                </article>
              </section>}

              <section className="job-card">
                <p className="job-side-label">任务记录 共 {job?.runs.length ?? 0} 次</p>
                <ol className="job-runs">
                  {(job?.runs ?? []).slice().reverse().map((run) => (
                    <li key={run.id}>
                      <strong>{STATUS_LABEL[run.status] ?? run.status}</strong>
                      <span>{new Date(run.startedAt).toLocaleString([], { hour12: false })}</span>
                      {isSectionFormat(document.format) ? <span>{formatBadgeLabel(document.format)}</span> : <span>{run.pages} 页</span>}
                      {run.error ? <small>{run.error}</small> : null}
                    </li>
                  ))}
                  {!job?.runs.length ? <li className="job-runs-empty">还没有任务记录。</li> : null}
                </ol>
              </section>
            </div>
          ) : null}

          {tab === 'overview' ? (
            <div className="job-progress">
              <section className="job-card">
                <dl className="job-detail">
                  <dt>标题</dt><dd>{document.title || '—'}</dd>
                  <dt>中文题名</dt><dd>{document.translatedTitle || '—'}</dd>
                  <dt>作者</dt><dd>{document.authors?.join('，') || '—'}</dd>
                  <dt>期刊/会议</dt><dd>{document.venue || '—'}</dd>
                  <dt>年份</dt><dd>{document.year || '—'}</dd>
                  <dt>DOI</dt><dd>{document.doi || '—'}</dd>
                  <dt>格式</dt><dd>{(document.format || 'pdf').toUpperCase()}</dd>
                  <dt>文档编号</dt><dd className="job-mono">{effectiveKey || '任务创建中…'}</dd>
                </dl>
              </section>
              {job?.error ? <p className="job-error" role="alert">{job.error}</p> : null}
            </div>
          ) : null}

          {tab === 'files' ? (
            <div className="job-progress">
              <section className="job-card job-files">
                <button type="button" onClick={downloadOriginal} disabled={openDisabled}>
                  <span aria-hidden="true">▣</span>
                  <div><strong>{isSectionFormat(document.format) ? `原版 ${formatBadgeLabel(document.format)}` : '原版 PDF'}</strong><small>导入时保存的原始文件</small></div>
                  <span aria-hidden="true">⇩</span>
                </button>
                {!isSectionFormat(document.format) ? <button type="button" onClick={downloadTranslated} disabled={openDisabled}>
                  <span aria-hidden="true">Aa</span>
                  <div><strong>译文 PDF</strong><small>ReadX 排版完成后提供</small></div>
                  <span aria-hidden="true">⇩</span>
                </button> : null}
              </section>
              {!isSectionFormat(document.format) ? <p className="job-action-note">PDF 的 OCR、段落整理、翻译与排版由 ReadX 本地处理。</p> : <p className="job-action-note">文档保留原章节结构，在阅读器中打开。</p>}
            </div>
          ) : null}

          {!loaded ? <p className="job-notice">正在读取任务状态…</p> : null}
        </section>
      </div>
    </AppDialog>
  );
}
