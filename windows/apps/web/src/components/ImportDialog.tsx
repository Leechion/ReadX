import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type ImportCandidate,
  type ImportMetadataHint,
  type ImportedDocument,
} from '../api/client';
import { useImportProgress } from './ImportProgressPanel';
import { UploadShotStage, type ActiveImport } from './UploadShotStage';
import { DocumentJobDialog } from './DocumentJobDialog';
import { AppDialog } from './AppDialog';
import { zotero, type ZoteroSelection } from '../api/zotero';
import { ZoteroImportPanel } from './ZoteroImportPanel';
import { ScholarDiscoveryPanel } from './ScholarDiscoveryPanel';
import { CaptureInboxPanel } from './CaptureInboxPanel';
import { ZoteroNotesPanel } from './ZoteroNotesPanel';
import type { BatchShot } from './BatchShotVolley';

const MAX_PDF_BYTES = 512 * 1048576;
const MAX_EPUB_BYTES = 100 * 1048576;
const MAX_CONCURRENT_IMPORTS = 14;
const MAX_UPLOAD_BATCH_BYTES = 512 * 1048576;

export function ImportDialog({
  files,
  onClose,
  onImported,
  onOpenDocument,
}: {
  files: File[];
  onClose: () => void;
  onImported: () => void;
  onOpenDocument?: (id: string) => void;
}) {
  useEffect(() => () => controller.current?.abort(), []);
  const started = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState('');
  const [results, setResults] = useState<ImportedDocument[]>([]);
  const [batchItems, setBatchItems] = useState<Array<{ file: File; status: 'queued' | 'working' | 'done' | 'failed'; message: string }>>([]);
  const [batchShot, setBatchShot] = useState<BatchShot | null>(null);
  const batchShotId = useRef(0);
  const endBatchShot = useCallback((id: number) => setBatchShot(current => current?.id === id ? null : current), []);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [error, setError] = useState('');
  const [localOnly, setLocalOnly] = useState(false);
  const [zoteroQueuedKeys, setZoteroQueuedKeys] = useState<Set<string>>(() => new Set());
  // 弹弓式导入：选中的文件先落进队列，用户逐个投进篮筐才开始导入。
  const [queue, setQueue] = useState<File[]>([]);
  const [active, setActive] = useState<ActiveImport | null>(null);
  // 文件进篮筐就切到任务面板：先显示上传/准备，拿到 jobKey 后轮询 OCR/翻译/渲染。
  const [jobFile, setJobFile] = useState<File | null>(null);
  // 来源跟随具体文件对象，避免同名文件互相覆盖题录来源。
  const sources = useRef(new WeakMap<File, string>());
  const metadataHints = useRef(new WeakMap<File, ImportCandidate>());
  const activity = useImportProgress();
  // ref 同步加锁，阻止 React 更新 busy 前的重复提交。
  const startRequest = () => {
    if (controller.current) return null;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    return request;
  };
  const finishRequest = (request: AbortController) => {
    if (controller.current !== request) return;
    controller.current = null;
    setBusy(false);
  };

  const addZotero = async (selection: ZoteroSelection[]) => {
    const request = startRequest();
    if (!request) return;
    setJobFile(null);
    setActive(null);
    setError('');
    activity.begin('download', `正在读取 ${selection.length} 个 Zotero PDF`);
    let completed = 0;
    const failures: string[] = [];
    try {
      for (const { item, attachment } of selection) {
        request.signal.throwIfAborted();
        if (zoteroQueuedKeys.has(attachment.key)) continue;
        activity.update({ stage: 'download', message: `正在读取 ${attachment.name}`, completed, total: selection.length });
        try {
          const file = await zotero.file(attachment, request.signal);
          request.signal.throwIfAborted();
          const source = `zotero://select/library/items/${item.key}`;
          sources.current.set(file, source);
          metadataHints.current.set(file, { title: item.title, authors: item.authors, doi: item.doi, venue: item.venue, year: item.year, url: source });
          setQueue(items => [...items, file]);
          setZoteroQueuedKeys(current => new Set(current).add(attachment.key));
          completed++;
        } catch (cause) {
          request.signal.throwIfAborted();
          failures.push(`${attachment.name}：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      if (failures.length) setError(failures.join('\n'));
      activity.update({ stage: 'complete', message: `已将 ${completed} 个 Zotero PDF 加入导入队列${failures.length ? `，${failures.length} 个读取失败` : ''}`, completed, total: selection.length });
    } catch (cause) {
      const cancelled = request.signal.aborted;
      setError(cancelled ? '已取消；已加入队列的 PDF 会保留' : String(cause));
      activity.update({ stage: cancelled ? 'cancelled' : 'failed', message: cancelled ? '已停止读取 Zotero PDF' : '读取 Zotero PDF 失败', completed, total: selection.length });
    } finally { finishRequest(request); }
  };

  /** 投进一个：只导入这一篇，其余留在队列里。 */
  const upload = async (file: File) => {
    const request = startRequest();
    if (!request) return;
    setQueue((items) => items.filter((item) => item !== file));
    setActive({ file, result: null, cancelled: false });
    setError('');
    activity.begin('preparing', `正在检查 ${file.name}`);
    try {
      const isPDF = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
      if (file.size > (isPDF ? MAX_PDF_BYTES : MAX_EPUB_BYTES)) {
        throw new Error(isPDF ? 'PDF 文件不能超过 LeePDF 默认的 512 MB 上传上限' : '单个 EPUB 文件不超过 100 MB');
      }
      const fileIndex = 1;
      const files = 1;
      activity.update({ stage: 'upload', message: localOnly ? '正在上传原文，不调用 AI 或 OCR' : '正在准备上传，由 LeePDF 处理论文', name: file.name, file: fileIndex, files, completed: 0, total: 0 });
      const known = metadataHints.current.get(file);
      const hint: ImportMetadataHint = {
        localOnly,
        title: known?.title ?? '', author: known?.authors[0] ?? '', authors: known?.authors,
        doi: known?.doi ?? '', arxiv: known?.arxiv ?? '', venue: known?.venue, year: known?.year, firstPage: '',
      };
      const source = sources.current.get(file);
      if (source) {
        hint.source = source;
      }
      // PDF processing is delegated to LeePDF; EPUB keeps its chapter import flow.
      setJobFile(localOnly ? null : file);
      const result = await api.upload([file], request.signal, [hint], activity.receive);
      const imported = result.results[0];
      if (!imported) throw new Error('服务未返回导入结果，请刷新书库确认');
      setActive({ file, result: imported, cancelled: false });
      setResults((current) => [...current, ...result.results]);
      const failed = result.results.filter(item => item.error).length;
      activity.update({ stage: 'complete', message: failed ? '导入失败，原因见下方' : localOnly ? '原文已保存到书库' : 'LeePDF 译文已保存到书库', completed: 1, total: 1 });
    } catch (cause) {
      const cancelled = request.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError');
      const message = cancelled ? '已取消' : String(cause);
      activity.update({ stage: cancelled ? 'cancelled' : 'failed', message: cancelled ? '已停止当前请求；已经完成的论文保留在书库' : '导入未完成，请查看下方错误后重试', completed: 0, total: 0 });
      setActive({ file, result: { name: file.name, existing: false, error: message }, cancelled });
      setError(message);
    } finally {
      finishRequest(request);
      onImported();
    }
  };
  const startBatch = async () => {
    const pending = queue.slice();
    if (!pending.length) return;
    const request = startRequest();
    if (!request) return;
    setActive(null);
    setJobFile(null);
    const shotId = ++batchShotId.current;
    const shotFiles = pending.filter(file => file.size <= (/\.pdf$/i.test(file.name) || file.type === 'application/pdf' ? MAX_PDF_BYTES : MAX_EPUB_BYTES));
    setBatchShot(shotFiles.length ? { id: shotId, files: shotFiles } : null);
    setQueue([]);
    setBatchItems(pending.map((file) => ({ file, status: 'queued' as const, message: '等待处理' })));
    setError('');
    activity.begin('preparing', `准备并行导入 ${pending.length} 篇文献`);
    try {
      const importedResults: ImportedDocument[] = [];
      const batches: Array<Array<{ file: File; index: number }>> = [];
      let batchBytes = 0;
      for (const [index, file] of pending.entries()) {
        const isPDF = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
        if (file.size > (isPDF ? MAX_PDF_BYTES : MAX_EPUB_BYTES)) {
          const imported = { name: file.name, existing: false, error: `${file.name} 超出单文件大小限制` };
          importedResults[index] = imported;
          setResults((current) => [...current, imported]);
          setBatchItems((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, status: 'failed', message: imported.error } : item));
          continue;
        }
        let batch = batches[batches.length - 1];
        if (!batch || batch.length >= MAX_CONCURRENT_IMPORTS || batchBytes + file.size > MAX_UPLOAD_BATCH_BYTES) {
          batch = [];
          batches.push(batch);
          batchBytes = 0;
        }
        batch.push({ file, index });
        batchBytes += file.size;
      }
      for (const batch of batches) {
        request.signal.throwIfAborted();
        const indices = new Set(batch.map((item) => item.index));
        setBatchItems((items) => items.map((item, index) => indices.has(index) ? { ...item, status: 'working', message: '准备上传' } : item));
        const hints = batch.map(({ file }): ImportMetadataHint => {
          const known = metadataHints.current.get(file);
          return {
            localOnly,
            title: known?.title ?? '', author: known?.authors[0] ?? '', authors: known?.authors,
            doi: known?.doi ?? '', arxiv: known?.arxiv ?? '', venue: known?.venue, year: known?.year,
            firstPage: '', source: sources.current.get(file),
          };
        });
        let batchResults: ImportedDocument[];
        try {
          const result = await api.upload(batch.map((item) => item.file), request.signal, hints, (event) => {
            const progress = event.progress;
            const item = progress?.file ? batch[progress.file - 1] : undefined;
            activity.receive(item && progress ? { ...event, progress: { ...progress, file: item.index + 1, files: pending.length } } : event);
            if (!item || !progress) return;
            setBatchItems((items) => items.map((row, index) => index === item.index ? {
              ...row,
              status: progress.stage === 'done' ? 'done' : progress.stage === 'failed' || progress.stage === 'cancelled' ? 'failed' : 'working',
              message: progress.message || progress.stage,
            } : row));
          });
          batchResults = batch.map(({ file }, index) => result.results[index] ?? { name: file.name, existing: false, error: '服务未返回导入结果，请刷新书库确认' });
        } catch (cause) {
          request.signal.throwIfAborted();
          batchResults = batch.map(({ file }) => ({ name: file.name, existing: false, error: String(cause) }));
        }
        batch.forEach(({ index }, batchIndex) => { importedResults[index] = batchResults[batchIndex]!; });
        setResults((current) => [...current, ...batchResults]);
        setBatchItems((items) => items.map((item, index) => {
          const imported = importedResults[index];
          return indices.has(index) && imported ? { ...item, status: imported.error ? 'failed' : 'done', message: imported.error || (imported.existing ? '书库已有，已复用' : '导入完成') } : item;
        }));
      }
      request.signal.throwIfAborted();
      const failed = importedResults.filter((item) => item.error).length;
      activity.update({ stage: 'complete', message: `批量导入完成：${pending.length - failed} 篇成功，${failed} 篇失败`, completed: pending.length - failed, total: pending.length });
    } catch (cause) {
      const cancelled = request.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError');
      const message = cancelled ? '已取消' : String(cause);
      endBatchShot(shotId);
      setBatchItems((items) => items.map((item) => item.status === 'done' || item.status === 'failed' ? item : { ...item, status: 'failed', message }));
      setError(message);
      activity.update({ stage: cancelled ? 'cancelled' : 'failed', message, completed: 0, total: pending.length });
    } finally {
      finishRequest(request);
      onImported();
    }
  };
  useEffect(() => {
    if (files.length && !started.current) {
      started.current = true;
      setQueue(files);
    }
  }, [files]);
  const importLink = async (
    url: string,
    title?: string,
    metadata?: ImportCandidate,
  ) => {
    const request = startRequest();
    if (!request) return;
    activity.begin('download', '正在解析链接并下载公开全文，等待下载服务返回');
    setError('');
    try {
      const downloaded = await api.downloadPublication(url, title, request.signal, (received, total) => activity.update({ stage: 'download', message: '正在接收下载的论文全文', completed: received, total }));
      request.signal.throwIfAborted();
      // 下载件同样进队列：投进筐才开始导入，规则与手动选文件一致。
      sources.current.set(downloaded.file, downloaded.source);
      if (metadata) metadataHints.current.set(downloaded.file, metadata);
      setQueue((items) => [...items, downloaded.file]);
      activity.update({ stage: 'complete', message: `已下载《${downloaded.file.name}》，把它投进篮筐开始导入`, completed: 1, total: 1 });
    } catch (cause) {
      activity.update({ stage: request.signal.aborted ? 'cancelled' : 'failed', message: request.signal.aborted ? '已停止当前请求；已经完成的论文保留在书库' : '导入未完成，请查看下方错误后重试', completed: 0, total: 0 });
      setError(
        request.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')
          ? '已取消'
          : String(cause),
      );
    } finally {
      finishRequest(request);
      onImported();
    }
  };
  const search = async () => {
    const request = startRequest();
    if (!request) return;
    activity.begin('search', '正在检索标题 / DOI 并查找公开全文地址');
    setError('');
    setCandidates([]);
    try {
      const found = (await api.searchImport(value, request.signal)).results;
      request.signal.throwIfAborted();
      setCandidates(found);
      activity.update({ stage: 'complete', message: `检索完成，找到 ${found.length} 个候选结果`, completed: 1, total: 1 });
    } catch (cause) {
      activity.update({ stage: request.signal.aborted ? 'cancelled' : 'failed', message: request.signal.aborted ? '检索已取消' : '检索失败，请查看下方错误', completed: 0, total: 0 });
      setError(
        request.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')
          ? '已取消'
          : String(cause),
      );
    } finally {
      finishRequest(request);
    }
  };
  return (
    <>
    <AppDialog
      open
      onClose={onClose}
      className="import-dialog"
      onCancel={(event) => {
        event.preventDefault();
        controller.current?.abort();
        onImported();
        onClose();
      }}
    >
      <header>
        <div><p className="section-eyebrow">BUILD YOUR LIBRARY</p><h2>导入文档</h2><p className="import-subtitle">PDF / EPUB · 识别题录并保存全文翻译</p></div>
        <button
          onClick={() => {
            controller.current?.abort();
            onImported();
            onClose();
          }}
          aria-label="关闭导入"
        >
          ×
        </button>
      </header>
      <ol className="import-steps" aria-label="导入流程"><li><span>01</span>选择文件</li><li><span>02</span>加入待导入队列</li><li><span>03</span>识别题录并翻译</li></ol>
      <ZoteroImportPanel busy={busy} queuedKeys={zoteroQueuedKeys} onAdd={addZotero} />
      <ScholarDiscoveryPanel busy={busy} onDownload={importLink} />
      <CaptureInboxPanel busy={busy} onDownload={importLink} />
      <ZoteroNotesPanel busy={busy} />
      <label className="text-sm">
        <input type="checkbox" checked={localOnly} disabled={busy} onChange={event => setLocalOnly(event.target.checked)} />
        仅保存原文（无需 AI / OCR 配置）
        <small className="block text-ink-faint">适用于下方文件队列，不调用在线识别或翻译；可阅读原文、批注，配置服务后可在阅读器中重新翻译。扫描件暂不识别文字。</small>
      </label>
      <UploadShotStage
        queue={queue}
        active={active}
        current={activity.current}
        results={results}
        busy={busy}
        disabled={busy}
        batchShot={batchShot}
        batchBusy={busy && batchItems.some(item => item.status === 'queued' || item.status === 'working')}
        onBatchShotEnd={endBatchShot}
        onQueue={(selected) => setQueue((items) => [...items, ...selected])}
        onMake={(file) => void upload(file)}
      />
      {queue.length > 0 && (
        <button className="primary-button import-batch-button" disabled={busy} onClick={() => void startBatch()}>
          {`并行导入全部（最多同时处理 ${MAX_CONCURRENT_IMPORTS} 篇，${queue.length} 篇）`}
        </button>
      )}
      {batchItems.length > 0 && (
        <section className="import-batch-progress" aria-live="polite">
          <h3>批量处理进度</h3>
          <ul>
            {batchItems.map((item, index) => (
              <li key={`${item.file.name}-${index}`} data-state={item.status}>
                <span title={item.file.webkitRelativePath || item.file.name}>{item.file.name}</span>
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-ink-faint">
        PDF 最大 512 MB（LeePDF 服务会继续校验 OCR 限制）；EPUB 最大 100 MB。文件夹会递归收集 PDF / EPUB；选择后点击“并行导入全部”开始处理。
      </p>
      <label className="import-link-field">
        链接、arXiv 编号、DOI 或标题
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="https://… / 2209.14540 / 10.… / 论文标题"
          disabled={busy}
        />
      </label>
      <div className="dialog-actions">
        <button
          disabled={busy || !value.trim()}
          onClick={() => void importLink(value)}
        >
          从链接或编号导入
        </button>
        <button disabled={busy || !value.trim()} onClick={() => void search()}>
          按标题 / DOI 查找
        </button>
      </div>
      {error && (
        <p role="alert" className="text-bad whitespace-pre-line">
          {error}
        </p>
      )}
      {candidates.map((item, index) => (
        <article className="import-result" key={index}>
          <strong>{item.title}</strong>
          <p>{item.authors.slice(0, 4).join(' · ')}</p>
          <small>{[item.venue, item.year, item.doi].filter(Boolean).join(' · ')}</small>
          <button
            disabled={busy || !item.url}
            onClick={() => void importLink(item.url, item.title, item)}
          >
            {item.url ? '导入全文' : '未找到公开全文'}
          </button>
        </article>
      ))}
      {/* 上传行只显示文件名与进度；这里补上 AI 识别出的题录与失败原因，
          以及仅有服务端才知道的告警（例如译文不完整）。 */}
      {results.map((result, index) => (
        <p className={result.error ? 'text-bad' : 'text-good'} key={index}>
          {result.document?.title ?? result.name}：
          {result.error ?? (result.existing ? '书库已有此文件' : '已导入')}
          {result.warning && <small className="block text-amber-700">{result.warning}</small>}
          {result.document && <small className="block">{[result.document.translatedTitle, result.document.authors.join(' · '), result.document.venue, result.document.year].filter(Boolean).join(' / ')}</small>}
        </p>
      ))}
      <footer>
        {busy && (
          <button onClick={() => controller.current?.abort()}>取消请求</button>
        )}
        <button className="primary-button" disabled={busy} onClick={onClose}>
          完成
        </button>
      </footer>
    </AppDialog>
    {jobFile ? (
      <DocumentJobDialog
        document={{ key: activity.jobKey || '', title: active?.result?.document?.title || jobFile.name, authors: active?.result?.document?.authors || [], format: /\.epub$/i.test(jobFile.name) || jobFile.type === 'application/epub+zip' ? 'epub' : 'pdf' }}
        jobKey={activity.jobKey || null}
        coverFile={jobFile}
        importing={busy}
        pending={busy && !activity.jobKey}
        onClose={() => setJobFile(null)}
        onOpenReader={() => {
          const imported = active?.result?.document;
          if (!imported || !onOpenDocument) return;
          onOpenDocument(imported.id);
          onClose();
        }}
      />
    ) : null}
    </>
  );
}
