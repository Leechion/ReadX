import { useEffect, useState } from 'react';
import { request, type ImportCandidate } from '../api/client';
interface Capture { id: string; url: string; pdfUrl: string; title: string; doi: string; authors: string[]; at: string }
export function CaptureInboxPanel({ busy, onDownload }: { busy: boolean; onDownload: (url: string, title?: string, metadata?: ImportCandidate) => Promise<void> }) {
  const [records, setRecords] = useState<Capture[]>([]); const [notice, setNotice] = useState('');
  const refresh = () => { void request<{ records: Capture[] }>('/v1/capture/inbox').then(result => setRecords(result.records)).catch(error => setNotice(String(error))); };
  useEffect(() => { refresh(); }, []);
  const enable = async () => { try { const enabled = await window.__READX_CAPTURE__?.enable(); setNotice(enabled ? '浏览器接收已启用。安装项目附带的扩展后，点击采集，再在这里确认。' : '未能注册采集协议；开发模式或当前平台可能不支持，请使用已安装版本。'); } catch (error) { setNotice(String(error)); } };
  return <details className="ai-card"><summary>浏览器采集收件箱（{records.length}）</summary><p>只保存你点击采集的页面来源和题录，不读取 Cookie。下载、题录补全与 AI 处理另行授权；不保证能获取订阅全文。</p>
    {window.__READX_CAPTURE__ && <button type="button" disabled={busy} onClick={() => void enable()}>启用浏览器接收</button>}<button type="button" onClick={refresh}>刷新收件箱</button>
    <ul>{records.map(item => <li key={item.id}><strong>{item.title || item.url}</strong><small> · {new Date(item.at).toLocaleString()}</small><p>{item.url}</p><button type="button" disabled={busy} onClick={() => void onDownload(item.pdfUrl || item.doi || item.url, item.title, { title: item.title, authors: item.authors ?? [], doi: item.doi, url: item.url })}>尝试下载到导入队列</button></li>)}</ul><p role="status">{notice}</p>
  </details>;
}
