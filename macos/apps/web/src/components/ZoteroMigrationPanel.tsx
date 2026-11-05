import { useEffect, useRef, useState } from 'react';
import { authenticatedFetch, request } from '../api/client';

interface Mirror { kind: string; key: string; version: number; revision: number; local: Record<string, unknown>; documentKeys: string[] }
interface Migration { id: string; serverId: string; status: string; at: string; objects: Record<string, Mirror>; files: { key: string; name: string; size: number; error?: string }[]; disclosure: string; snapshot?: { collections: { key: string; data: { name?: string; parentCollection?: string | false } }[] } }
interface PlanEntry { objectId: string; state: string; local: Record<string, unknown>; remote?: Record<string, unknown>; documentKeys: string[]; error?: string }
interface Plan { id: string; entries: PlanEntry[]; disclosure: string }
const stateLabels: Record<string, string> = { unchanged: '两端一致', push: '本地有改动', pull: 'Zotero 有改动', conflict: '双边冲突', 'local-conflict': '多个本地视图冲突', 'remote-missing': '远端缺失，保留本地', error: '读取失败' };
export function ZoteroMigrationPanel({ busy, onImported }: { busy: boolean; onImported: () => void }) {
  const [records, setRecords] = useState<{ id: string; at: string; status: string; files: number }[]>([]);
  const [migration, setMigration] = useState<Migration | null>(null), [plan, setPlan] = useState<Plan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set()), [objectId, setObjectId] = useState(''), [editor, setEditor] = useState('');
  const [notice, setNotice] = useState(''), [working, setWorking] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const refresh = async () => { const result = await request<{ migrations: typeof records }>('/v1/zotero/migrations'); setRecords(result.migrations); };
  useEffect(() => { void refresh().catch(error => setNotice(String(error))); return () => controller.current?.abort(); }, []);
  const act = async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (controller.current) return; const abort = new AbortController(); controller.current = abort; setWorking(true); setNotice('');
    try { await operation(abort.signal); } catch (error) { if (!abort.signal.aborted) setNotice(String(error)); else setNotice('已停止；已迁入数据保留，可再次迁移或核对。'); }
    finally { if (controller.current === abort) controller.current = null; setWorking(false); }
  };
  const load = async (id: string, signal?: AbortSignal) => { const value = await request<Migration>(`/v1/zotero/migrations?id=${encodeURIComponent(id)}`, { signal }); setMigration(value); return value; };
  const migrate = () => act(async signal => {
    const snapshot = await request<{ serverId: string }>('/v1/zotero/snapshot', { signal });
    if (!snapshot.serverId) throw new Error('请先在上方读取本机集合／笔记快照');
    const value = await request<Migration>('/v1/zotero/migrations', { method: 'POST', body: { serverId: snapshot.serverId }, signal });
    setMigration(value); setPlan(null); setNotice(value.disclosure); await refresh(); onImported();
  });
  const download = () => act(async signal => {
    if (!migration) return;
    const response = await authenticatedFetch(`/v1/zotero/migrations/${encodeURIComponent(migration.id)}/archive`, { signal });
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a'); link.href = url; link.download = 'ReadX-Zotero-migration.zip'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const reconcile = () => act(async signal => {
    if (!migration) return;
    const value = await request<Plan>('/v1/zotero/reconcile', { method: 'POST', body: { migrationId: migration.id, objects: [...selected] }, signal }); setPlan(value);
  });
  const apply = (entry: PlanEntry, choice: string) => act(async signal => {
    if (!plan || !migration) return;
    const response = await request<{ disclosure: string }>('/v1/zotero/reconcile/apply', { method: 'POST', body: { planId: plan.id, objectId: entry.objectId, choice, documentKeys: entry.documentKeys ?? [] }, signal });
    await load(migration.id, signal); setNotice(response.disclosure); setPlan(current => current ? { ...current, entries: current.entries.filter(item => item !== entry) } : null); onImported();
  });
  const locked = busy || working;
  const objects = Object.entries(migration?.objects ?? {});
  return <details className="ai-card"><summary>Zotero 个人库迁移与双向核对</summary>
    <p>先读取上方快照，再复制本机附件。PDF／EPUB 原文入库；其他附件、集合层级、笔记及批注原始坐标保存在可导出的档案。缺失文件会列为部分完成，不调用 OCR 或 AI。</p>
    <button type="button" disabled={locked} onClick={() => void migrate()}>迁入／重试当前快照</button>
    {working && <button type="button" onClick={() => controller.current?.abort()}>停止</button>}
    <label>本机迁移记录<select disabled={locked} value={migration?.id ?? ''} onChange={event => { if (event.target.value) void act(async signal => { await load(event.target.value, signal); setPlan(null); setSelected(new Set()); }); }}><option value="">选择迁移记录</option>{records.map(item => <option key={item.id} value={item.id}>{item.at} · {item.status} · {item.files} 个附件</option>)}</select></label>
    {migration && <section><p>状态：{migration.status} · {objects.length} 个对象 · {migration.files.length} 个附件</p><p>{migration.disclosure}</p>
      <button type="button" disabled={locked} onClick={() => void download()}>导出完整迁移档案 ZIP（含私人笔记，请妥善保管）</button>
      <ul>{migration.files.map(file => <li key={file.key}>{file.name} · {(file.size / 1048576).toFixed(2)} MiB {file.error && <strong> · 未完成：{file.error}</strong>}</li>)}</ul>
      <details><summary>原始集合层级</summary><ul>{migration.snapshot?.collections.map(item => <li key={item.key}>{item.data.name} · 上级：{item.data.parentCollection ? migration.snapshot?.collections.find(parent => parent.key === item.data.parentCollection)?.data.name || item.data.parentCollection : '顶层'}</li>)}</ul></details>
      <p>每次最多核对 100 个对象。仅核对会读取 Zotero，应用选择才修改数据；不自动同步或传播删除，也不反向覆盖原文件。</p>
      <ul>{objects.map(([key, item]) => <li key={key}><label><input type="checkbox" disabled={locked || (!selected.has(key) && selected.size >= 100)} checked={selected.has(key)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(key); else next.delete(key); return next; })} />{item.kind} · {String(item.local.title || item.local.name || item.local.itemType || item.key)}</label><button type="button" disabled={locked} onClick={() => { setObjectId(key); setEditor(JSON.stringify(item.local, null, 2)); }}>编辑本地镜像</button></li>)}</ul>
      {objectId && migration.objects[objectId] && <details open><summary>本地镜像编辑（尚未写入 Zotero）</summary><textarea aria-label="Zotero 本地对象 JSON" rows={12} value={editor} disabled={locked} onChange={event => setEditor(event.target.value)} /><button type="button" disabled={locked} onClick={() => void act(async signal => {
        const data = JSON.parse(editor) as Record<string, unknown>; const object = migration.objects[objectId];
        if (!object) throw new Error('对象已变化，请重新选择');
        await request('/v1/zotero/mirror', { method: 'PATCH', body: { migrationId: migration.id, objectId, revision: object.revision, data }, signal }); await load(migration.id, signal); setPlan(null); setNotice('本地镜像已保存，尚未发送至 Zotero；请执行核对再选择应用。');
      })}>保存本地修改</button></details>}
      <button type="button" disabled={locked || !selected.size} onClick={() => void reconcile()}>核对所选对象（{selected.size}）</button>
      <button type="button" disabled={locked} onClick={() => void act(async signal => { await request('/v1/zotero/authorize', { method: 'POST', body: {}, signal }); setNotice('已获得 Zotero 本机写入授权；单次授权用完需重新申请。'); })}>申请 Zotero 写入授权</button>
    </section>}
    {plan && <section><p>{plan.disclosure}</p>{plan.entries.map(entry => <details key={entry.objectId}><summary>{entry.objectId} · {stateLabels[entry.state] || entry.state}</summary>{entry.error && <p>{entry.error}</p>}<p>ReadX 当前内容</p><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(entry.local, null, 2)}</pre><p>Zotero 当前内容</p><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(entry.remote, null, 2)}</pre>
      {!['unchanged', 'error', 'remote-missing'].includes(entry.state) && <><button type="button" disabled={locked} onClick={() => void apply(entry, 'pull')}>采用 Zotero，更新本地映射</button><button type="button" disabled={locked || entry.state === 'local-conflict'} onClick={() => void apply(entry, 'push')}>采用 ReadX，确认写回 Zotero</button></>}
    </details>)}</section>}
    <p role="status">{notice}</p>
  </details>;
}
