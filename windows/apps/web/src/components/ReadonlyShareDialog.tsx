import { useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { authenticatedFetch } from '../api/client';
import { AppDialog } from './AppDialog';
export function ReadonlyShareDialog({ documents, onClose }: { documents: DocumentSummary[]; onClose: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [original, setOriginal] = useState(false); const [notes, setNotes] = useState(false); const [readings, setReadings] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const download = async () => {
    setBusy(true); setError('');
    try {
      const response = await authenticatedFetch('/v1/shares/readonly', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [...selected], includeOriginal: original, includeNotes: notes, includeReadings: readings }) });
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = 'ReadX-readonly-share.html'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  };
  return <AppDialog open onClose={onClose} busy={busy}><header><h2>只读分享</h2><button disabled={busy} onClick={onClose}>关闭</button></header>
    <p>生成可离线打开的 HTML 文件。默认只分享题录；请选择允许给接收者查看的材料。</p>
    <label><input type="checkbox" checked={original} disabled={busy} onChange={event => setOriginal(event.target.checked)} />包含 PDF 原文（合计最多 64 MiB，请确认可分享）</label>
    <label><input type="checkbox" checked={notes} disabled={busy} onChange={event => setNotes(event.target.checked)} />包含个人批注、存疑和摘录</label>
    <label><input type="checkbox" checked={readings} disabled={busy} onChange={event => setReadings(event.target.checked)} />包含五重奏 AI 精读</label>
    <p>不包含密钥、配置、聊天、源码或未选择的笔记。原文页码依赖接收者浏览器的 PDF 预览；未附原文时只展示证据标记。</p>
    <ul>{documents.map(doc => <li key={doc.key}><label><input type="checkbox" checked={selected.has(doc.key)} disabled={busy || (!selected.has(doc.key) && selected.size >= 10)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(doc.key); else next.delete(doc.key); return next; })} />{doc.title}</label></li>)}</ul>
    <button className="primary-button" disabled={busy || !selected.size} onClick={() => void download()}>生成分享文件（{selected.size} 篇）</button><p role="status">{error}</p>
  </AppDialog>;
}
