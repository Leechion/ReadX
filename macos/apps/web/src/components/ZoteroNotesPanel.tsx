import { useEffect, useState } from 'react';
import { request } from '../api/client';
interface ObjectRecord { key: string; version: number; data: { itemType?: string; title?: string; name?: string; note?: string } }
interface Snapshot { serverId: string; at?: string; collections: ObjectRecord[]; items: ObjectRecord[]; disclosure: string }
export function ZoteroNotesPanel({ busy }: { busy: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null); const [documents, setDocuments] = useState<{ key: string; title: string }[]>([]);
  const [documentKey, setDocumentKey] = useState(''); const [parent, setParent] = useState(''); const [text, setText] = useState('');
  const [version, setVersion] = useState(0); const [remote, setRemote] = useState(''); const [notice, setNotice] = useState(''); const [working, setWorking] = useState(false);
  useEffect(() => { void request<Snapshot>('/v1/zotero/snapshot').then(setSnapshot).catch(error => setNotice(String(error))); void request<{ documents: { key: string; title: string }[] }>('/v1/documents').then(result => setDocuments(result.documents)).catch(error => setNotice(String(error))); }, []);
  const act = async (operation: () => Promise<void>) => { if (working) return; setWorking(true); setNotice(''); try { await operation(); } catch (error) { setNotice(String(error)); } finally { setWorking(false); } };
  const pull = () => act(async () => {
    const note = await request<{ linked: boolean; parent?: string; version?: number; localText?: string; remoteHTML?: string; changed?: boolean }>(`/v1/zotero/note?documentKey=${encodeURIComponent(documentKey)}`);
    if (!note.linked) { setNotice('尚无 ReadX 子笔记映射，首次写回将创建专属子笔记。'); setVersion(0); return; }
    setParent(note.parent ?? ''); setVersion(note.version ?? 0); setRemote(note.remoteHTML ?? '');
    setNotice(note.changed ? '远端自上次写入后有变化。请对照下方远端原文，人工决定编辑内容，再确认写回。' : '已读取远端版本；写回时使用该版本防止覆盖并发编辑。');
  });
  return <details className="ai-card"><summary>Zotero 集合／笔记快照与受控回写（开发版）</summary>
    <p>要求支持 Server-ID 和写授权的新版本 Zotero。本机读取的快照包含集合关系与笔记原始数据，不含附件二进制；这不是完整文库迁移或全对象持续双向同步。</p>
    <button type="button" disabled={busy || working} onClick={() => void act(async () => { const value = await request<Snapshot>('/v1/zotero/snapshot', { method: 'POST', body: {} }); setSnapshot(value); setNotice(value.disclosure); })}>读取本机集合／笔记快照</button>
    {snapshot?.serverId && <p>已保存 {snapshot.collections.length} 个集合、{snapshot.items.length} 个对象，其中 {snapshot.items.filter(item => item.data.itemType === 'note').length} 条笔记；{snapshot.at}</p>}
    <label>ReadX 文献<select disabled={busy || working} value={documentKey} onChange={event => { setDocumentKey(event.target.value); setVersion(0); setRemote(''); setText(''); }}><option value="">选择文献</option>{documents.map(doc => <option key={doc.key} value={doc.key}>{doc.title}</option>)}</select></label>
    <label>Zotero 父条目<select disabled={busy || working} value={parent} onChange={event => { setParent(event.target.value); setVersion(0); }}><option value="">从快照选择父条目</option>{snapshot?.items.filter(item => !['note', 'attachment', 'annotation'].includes(item.data.itemType ?? '')).map(item => <option key={item.key} value={item.key}>{item.data.title || item.key}</option>)}</select></label>
    <button type="button" disabled={busy || working || !documentKey} onClick={() => void act(async () => { const value = await request<{ draft: string }>(`/v1/zotero/draft?documentKey=${encodeURIComponent(documentKey)}`); setText(value.draft); })}>从批注与精读生成本地草稿</button>
    <button type="button" disabled={busy || working || !documentKey} onClick={() => void pull()}>读取／核对远端 ReadX 子笔记</button>
    <textarea rows={8} value={text} disabled={busy || working} onChange={event => setText(event.target.value)} aria-label="确认写回的研究笔记" />
    {remote && <details><summary>远端内容（HTML 源码只读显示，不执行）· 版本 {version}</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{remote}</pre></details>}
    <button type="button" disabled={busy || working} onClick={() => void act(async () => { const result = await request<{ disclosure: string }>('/v1/zotero/authorize', { method: 'POST', body: {} }); setNotice(result.disclosure); })}>请求 Zotero 本机写入授权</button>
    <button type="button" disabled={busy || working || !documentKey || !parent || !text.trim()} onClick={() => void act(async () => { const result = await request<{ version: number; disclosure: string }>('/v1/zotero/note', { method: 'POST', body: { documentKey, parent, text, version } }); setVersion(result.version); setNotice(result.disclosure); })}>确认写回 ReadX 专属子笔记</button>
    <p>不会自动覆盖原有笔记、附件或传播删除。写入本机 Zotero 后，Zotero 自己的同步可能将内容上传。版本冲突会拒绝写入；请先读取并核对。</p><p role="status">{notice}</p>
  </details>;
}
