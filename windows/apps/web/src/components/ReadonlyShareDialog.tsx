import { useEffect, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { api, authenticatedFetch, type LANShareStatus } from '../api/client';
import { AppDialog } from './AppDialog';

export function ReadonlyShareDialog({ documents, onClose }: { documents: DocumentSummary[]; onClose: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [original, setOriginal] = useState(false); const [notes, setNotes] = useState(false); const [readings, setReadings] = useState(false);
  const [ideas, setIdeas] = useState(false); const [comparisons, setComparisons] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [lanStatus, setLanStatus] = useState<LANShareStatus | null>(null);
  const [copiedUrl, setCopiedUrl] = useState('');

  useEffect(() => {
    void api.lanShareStatus().then(setLanStatus).catch(() => {});
  }, []);

  const payload = () => ({
    keys: [...selected],
    includeOriginal: original,
    includeNotes: notes,
    includeReadings: readings,
    includeIdeas: ideas,
    includeComparisons: comparisons,
  });

  const download = async () => {
    setBusy(true); setError('');
    try {
      const response = await authenticatedFetch('/v1/shares/readonly', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = 'ReadX-readonly-share.html'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  };

  const startLan = async () => {
    setBusy(true); setError('');
    try {
      const status = await api.startLANShare(payload());
      setLanStatus(status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const stopLan = async () => {
    setBusy(true); setError('');
    try {
      const status = await api.stopLANShare();
      setLanStatus(status);
      setCopiedUrl('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyLanUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
    } catch {
      setCopiedUrl(url);
    }
  };

  return <AppDialog open onClose={onClose} busy={busy}><header><h2>只读分享</h2><button disabled={busy} onClick={onClose}>关闭</button></header>
    <p>生成可离线打开的 HTML 文件，或开启临时局域网只读服务供平板/手机同一 Wi-Fi 下直接阅览。</p>
    <label><input type="checkbox" checked={original} disabled={busy} onChange={event => setOriginal(event.target.checked)} />包含原文（PDF 附件 / 章节文档正文，合计最多 64 MiB，请确认可分享）</label>
    <label><input type="checkbox" checked={notes} disabled={busy} onChange={event => setNotes(event.target.checked)} />包含个人批注、存疑和摘录</label>
    <label><input type="checkbox" checked={readings} disabled={busy} onChange={event => setReadings(event.target.checked)} />包含五重奏 AI 精读</label>
    <label><input type="checkbox" checked={ideas} disabled={busy} onChange={event => setIdeas(event.target.checked)} />包含证据关联所选论文的研究想法（含个人判断，请核对正文）</label>
    <label><input type="checkbox" checked={comparisons} disabled={busy} onChange={event => setComparisons(event.target.checked)} />包含已保存的七维对照数据</label>
    <p>不包含密钥、配置、聊天、源码或未选择的笔记。原文页码依赖接收者浏览器的 PDF 预览；未附原文时只展示证据标记。</p>
    <ul>{documents.map(doc => <li key={doc.key}><label><input type="checkbox" checked={selected.has(doc.key)} disabled={busy || (!selected.has(doc.key) && selected.size >= 10)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(doc.key); else next.delete(doc.key); return next; })} />{doc.title}</label></li>)}</ul>
    <div className="lan-share-actions">
      <button className="primary-button" disabled={busy || !selected.size} onClick={() => void download()}>生成分享文件（{selected.size} 篇）</button>
      <button type="button" disabled={busy || !selected.size} onClick={() => void startLan()}>开启局域网伴侣服务</button>
    </div>
    {lanStatus?.active ? (
      <div className="lan-share-box">
        <div className="lan-share-head">
          <strong>局域网伴侣服务已运行（端口 {lanStatus.port} · {lanStatus.docCount} 篇 · 4 小时有效）</strong>
          <button type="button" disabled={busy} onClick={() => void stopLan()}>停止服务</button>
        </div>
        <p className="lan-share-tip">在同一局域网的 iPad / 手机浏览器中打开下方带一次性口令的只读链接：</p>
        <ul className="lan-share-urls">
          {(lanStatus.urls ?? []).map((url) => (
            <li key={url}>
              <code>{url}</code>
              <button type="button" onClick={() => void copyLanUrl(url)}>{copiedUrl === url ? '已复制' : '复制'}</button>
            </li>
          ))}
        </ul>
      </div>
    ) : null}
    <p role="status">{error}</p>
  </AppDialog>;
}
