import { useEffect, useState } from 'react';
import { request } from '../api/client';
type Mode = 'ask' | 'deny' | 'allow';
interface Policy { revision: number; library: Mode; documents: Record<string, Mode>; projects: Record<string, Mode>; shelves: Record<string, Mode>; restoredAt?: string }
const choices = <><option value="ask">每次发送前确认</option><option value="deny">禁止外部发送（敏感材料）</option><option value="allow">允许发送，不逐次询问</option></>;
export function ProcessingPolicySettings() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [scope, setScope] = useState('library'); const [key, setKey] = useState(''); const [mode, setMode] = useState<Mode>('ask');
  const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const [documents, setDocuments] = useState<{ key: string; title: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; title: string }[]>([]);
  const [shelves, setShelves] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { void request<Policy>('/v1/processing/policy').then(setPolicy).catch(error => setNotice(String(error))); }, []);
  useEffect(() => {
    void request<{ documents: { key: string; title: string }[] }>('/v1/documents').then(result => setDocuments(result.documents)).catch(error => setNotice(String(error)));
    void request<{ projects: { id: string; title: string }[] }>('/v1/latex/projects').then(result => setProjects(result.projects)).catch(error => setNotice(String(error)));
    void request<{ categories: { id: string; name: string }[] }>('/v1/categories').then(result => setShelves(result.categories)).catch(error => setNotice(String(error)));
  }, []);
  const save = async () => {
    setBusy(true);
    try { const saved = await request<Policy>('/v1/processing/policy', { method: 'PATCH', body: { scope, key: key.trim(), mode } }); setPolicy(saved); setNotice('权限已保存；原有授权失效，受控在途处理已请求取消。'); }
    catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  };
  return <section className="ai-card">
    <header>外部服务与材料发送权限</header>
    {policy?.restoredAt && <p role="status">刚从备份恢复：禁止规则已保留，原先允许发送的规则已改为每次确认。请核对当前服务后重新保存所需权限。</p>}
    <p className="ai-hint">默认逐次确认。禁止规则优先；单篇允许不能覆盖整库禁止。API Key 或本机 CLI 登录不等于授权发送材料。本地代理／CLI 仍可能联网。</p>
    <p>当前整库：{policy?.library === 'deny' ? '禁止发送' : policy?.library === 'allow' ? '允许发送' : '每次确认'}</p>
    <label>范围<select value={scope} disabled={busy} onChange={event => { setScope(event.target.value); setKey(''); }}><option value="library">整个书库</option><option value="shelf">书架／分类</option><option value="document">指定论文</option><option value="project">LaTeX 项目</option></select></label>
    {scope !== 'library' && <label>选择对象<select value={key} disabled={busy} onChange={event => setKey(event.target.value)}><option value="">请选择</option>{scope === 'shelf' ? shelves.map(item => <option key={item.id} value={item.id}>{item.name}</option>) : scope === 'document' ? documents.map(item => <option key={item.key} value={item.key}>{item.title}</option>) : projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
    <label>处理方式<select value={mode} disabled={busy} onChange={event => setMode(event.target.value as Mode)}>{choices}</select></label>
    <button disabled={busy || (scope !== 'library' && !key.trim())} onClick={() => void save()}>保存权限</button>
    {!!policy && Object.keys(policy.documents).length > 0 && <details><summary>论文规则</summary><ul>{Object.entries(policy.documents).map(([id, value]) => <li key={id}>{documents.find(item => item.key === id)?.title || '已移除文献'}：{value === 'deny' ? '禁止发送' : value === 'ask' ? '逐次确认' : '允许发送'}</li>)}</ul></details>}
    {!!policy && Object.keys(policy.projects).length > 0 && <details><summary>项目规则</summary><ul>{Object.entries(policy.projects).map(([id, value]) => <li key={id}>{projects.find(item => item.id === id)?.title || '已移除项目'}：{value === 'deny' ? '禁止发送' : value === 'ask' ? '逐次确认' : '允许发送'}</li>)}</ul></details>}
    {!!policy && Object.keys(policy.shelves).length > 0 && <details><summary>书架规则</summary><ul>{Object.entries(policy.shelves).map(([id, value]) => <li key={id}>{shelves.find(item => item.id === id)?.name || '已移除书架'}：{value === 'deny' ? '禁止发送' : value === 'ask' ? '逐次确认' : '允许发送'}</li>)}</ul></details>}
    <p>删除禁止发送的书架会将禁止规则保留到原成员论文；不会因移除分类而自动授权外发。</p>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
