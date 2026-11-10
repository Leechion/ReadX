import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { inferDocumentFormat, isSectionFormat } from '@cbct/shared';
import { api, type DocumentProcessingJob, type JobStage } from '../api/client';
import { AppDialog } from './AppDialog';
import { WorkspaceIcon } from './WorkspaceIcon';
import './LibraryProcessingControl.css';
import { jobStatus, reprocessStoppedJobs, stoppedDocumentJobs } from './processingJobs';

const DocumentJobDialog = lazy(() => import('./DocumentJobDialog').then(module => ({ default: module.DocumentJobDialog })));

const STATUS_LABEL: Record<string, string> = {
  pending: '等待中', running: '处理中', done: '已完成', failed: '失败',
  skipped: '已跳过', cancelled: '已取消', interrupted: '已中断',
};

function StageProgress({ stage, title }: { stage: JobStage; title: string }) {
  const complete = stage.status === 'done' || stage.status === 'skipped';
  const known = stage.total > 0;
  const value = complete ? 1 : known ? Math.min(1, Math.max(0, stage.completed / stage.total)) : stage.status === 'running' ? undefined : 0;
  return (
    <span className="processing-stage" data-status={stage.status} title={stage.message}>
      <span className="processing-stage-heading"><span>{stage.label}</span><span>{STATUS_LABEL[stage.status] ?? stage.status}</span></span>
      <progress value={value} max={1} aria-label={`${title} · ${stage.label}进度`} />
      {known ? <span className="processing-stage-count">{Math.max(0, stage.completed)} / {stage.total} {stage.unit || (stage.key === 'translate' ? '段' : stage.key === 'memory' ? '份' : '页')}</span> : null}
    </span>
  );
}

export function LibraryProcessingControl({ documents, onOpenDocument, onReload }: {
  documents: DocumentSummary[];
  onOpenDocument: (id: string) => void;
  onReload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<DocumentProcessingJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<DocumentProcessingJob | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  // 一键重新处理：提交中标记 + 如实的结果提示（成功或服务端拒绝的原因）。
  const [restartingKey, setRestartingKey] = useState<string | null>(null);
  const [batchRestarting, setBatchRestarting] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');
  const restartLock = useRef(false);
  const [restartNotice, setRestartNotice] = useState('');
  const tracking = open || selectedJob !== null;

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await api.documentJobs(controller.signal);
        if (controller.signal.aborted) return;
        setJobs(response.jobs);
        setError('');
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (controller.signal.aborted) return;
      setLoaded(true);
      timer = window.setTimeout(load, tracking ? 1200 : 5000);
    };
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [tracking, revision]);

  const unfinishedJobs = jobs.filter(job => jobStatus(job) !== 'done');
  const running = unfinishedJobs.filter(job => jobStatus(job) === 'running').length;
  const stopped = unfinishedJobs.filter(job => ['failed', 'interrupted', 'cancelled'].includes(jobStatus(job))).length;
  const selectedTask = jobs.find(job => job.key === selectedJob?.key) ?? selectedJob;
  const selectedDocument = selectedTask
    ? documents.find(doc => doc.key === (selectedTask.documentKey || selectedTask.key))
    : undefined;

  /**
   * 一键重新处理停在中途的任务（中断/失败/取消）。
   *
   * 走书库里「重新翻译」的同一条接口：有可复用的识别结果就续着翻，
   * 没有就把服务端的原因原样带回来（例如要先重新识别），不假装成功。
   * 只有已入库的 PDF 能走这条路：还在导入中的文档没有库键，EPUB 不参与翻译。
   */
  const restartJob = async (job: DocumentProcessingJob) => {
    const documentKey = job.documentKey || job.key;
    const document = documents.find(doc => doc.key === documentKey);
    if (!document || restartLock.current) return;
    restartLock.current = true;
    setRestartingKey(job.key);
    setRestartNotice('');
    try {
      await api.retranslate(document.key);
      setRestartNotice(`已重新提交「${document.title || document.key}」的处理任务。`);
      setRevision(value => value + 1);
    } catch (cause) {
      setRestartNotice(`重新处理失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      restartLock.current = false;
      setRestartingKey(null);
    }
  };

  const restartStopped = async () => {
    if (restartLock.current) return;
    restartLock.current = true;
    setBatchRestarting(true);
    setBatchProgress('正在检查任务…');
    setRestartNotice('');
    try {
      // Reload before submitting so a task that has since started is never retried from a stale list.
      const current = await api.documentJobs();
      setJobs(current.jobs);
      setError('');
      const result = await reprocessStoppedJobs(current.jobs, key => api.retranslate(key), (finished, total) => setBatchProgress(`正在提交 ${finished}/${total}…`));
      if (!result.total) setRestartNotice('没有需要重新处理的失败或中断任务。');
      else {
        const failures = result.failures.map(item => `「${item.title}」：${item.message}`).join('\n');
        setRestartNotice(`已提交 ${result.submitted} 个任务${result.failures.length ? `，${result.failures.length} 个未能提交：\n${failures}` : '。'}`);
      }
      setRevision(value => value + 1);
      onReload();
    } catch (cause) {
      setRestartNotice(`无法检查处理任务：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      restartLock.current = false;
      setBatchRestarting(false);
      setBatchProgress('');
    }
  };

  const restartable = (job: DocumentProcessingJob, status: string) => {
    if (!['failed', 'interrupted', 'cancelled'].includes(status)) return false;
    const document = documents.find(doc => doc.key === (job.documentKey || job.key));
    return Boolean(document && !isSectionFormat(document.format));
  };

  useEffect(() => {
    if (selectedTask && !selectedDocument && (selectedTask.documentKey || selectedTask.status === 'done')) onReload();
  }, [selectedTask?.key, selectedTask?.documentKey, selectedTask?.status, selectedDocument?.id, onReload]);

  return (
    <>
      <button type="button" className="library-processing-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls="library-processing-panel" onClick={() => setOpen(true)} title="查看未完成文档的处理进度">
        <WorkspaceIcon name="list" size={16} /><span>处理</span>
        {running > 0 ? <span className="processing-running-count" aria-label={`${running} 篇文档处理中`}>{running}</span> : null}
      </button>
      <AppDialog open={open} onClose={() => setOpen(false)} className="processing-panel" aria-labelledby="library-processing-title" closeOnBackdrop>
        <div id="library-processing-panel">
          <header className="processing-panel-header">
            <div><h2 id="library-processing-title">处理面板</h2><p>仅显示未完成的文档，点击文档进入处理详情。</p></div>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭处理面板"><WorkspaceIcon name="close" size={18} /></button>
          </header>
          <div className="processing-panel-summary">
            <span>未完成 <strong>{unfinishedJobs.length}</strong></span><span>处理中 <strong>{running}</strong></span><span>已停止 <strong>{stopped}</strong></span>
            <button type="button" disabled={batchRestarting || Boolean(restartingKey) || !loaded || (!error && stoppedDocumentJobs(jobs).length === 0)} onClick={() => void restartStopped()} title="重新处理失败或中断的文档，不影响正在处理的任务">{batchRestarting ? batchProgress : '重新处理'}</button>
          </div>
          {error ? <p className="processing-panel-error" role="alert">进度更新失败：{error}，面板会自动重试。</p> : null}
          {restartNotice ? <p className="processing-panel-notice" role="status">{restartNotice}</p> : null}
          {!loaded ? <p className="processing-panel-empty" role="status">正在加载处理任务…</p> : unfinishedJobs.length === 0 && !error ? <p className="processing-panel-empty">暂无未完成的处理任务。</p> : null}
          <ul className="processing-task-list" aria-label="未完成文档处理进度">
            {unfinishedJobs.map(job => {
              const document = documents.find(doc => doc.key === (job.documentKey || job.key));
              const title = document?.title || job.name || '未命名文档';
              const status = jobStatus(job);
              const active = job.stages.filter(stage => stage.status === 'running');
              const message = job.error || active.map(stage => stage.message).filter(Boolean).join(' · ') || job.stages.find(stage => stage.status === 'failed')?.message;
              return (
                <li key={job.key}>
                  <button type="button" className="processing-task" data-status={status} onClick={() => { setOpen(false); setSelectedJob(job); onReload(); }} aria-label={`查看${title}的处理详情`}>
                    <span className="processing-task-heading"><WorkspaceIcon name="file" size={18} /><strong title={title}>{title}</strong><span className="processing-task-status">{STATUS_LABEL[status] ?? status}</span><WorkspaceIcon name="chevronRight" size={16} /></span>
                    <span className="processing-task-stages">{job.stages.map(stage => <StageProgress key={stage.key} stage={stage} title={title} />)}</span>
                    {message ? <span className="processing-task-message" title={message}>{message}</span> : null}
                  </button>
                  {restartable(job, status) ? (
                    <div className="processing-task-actions">
                      <button
                        type="button"
                        className="processing-task-restart"
                        disabled={batchRestarting || Boolean(restartingKey)}
                        onClick={() => void restartJob(job)}
                        title="重新提交处理任务：复用已有识别结果继续翻译与排版；缺少可复用结果时会如实说明"
                      >
                        <span aria-hidden="true">↻</span> {restartingKey === job.key ? '正在提交…' : '重新处理'}
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </AppDialog>
      {selectedTask ? <Suspense fallback={null}>
        <DocumentJobDialog
          key={selectedTask.key}
          document={selectedDocument ?? { key: selectedTask.key, title: selectedTask.name, format: inferDocumentFormat(selectedTask.name) }}
          jobKey={selectedTask.key}
          fileKey={selectedDocument?.key || selectedTask.documentKey}
          importing={!selectedDocument}
          onClose={() => { setSelectedJob(null); onReload(); }}
          onOpenReader={() => {
            if (!selectedDocument) return;
            setSelectedJob(null);
            onOpenDocument(selectedDocument.id);
          }}
        />
      </Suspense> : null}
    </>
  );
}
