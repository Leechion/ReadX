import { useEffect, useState } from 'react';
import { registerProcessingDecision, type ProcessingChallenge } from '../api/processingConsent';
import { AppDialog } from './AppDialog';
interface Pending { challenge: ProcessingChallenge; answer: (allowed: boolean) => void }
export function ProcessingConsentDialog() {
  const [queue, setQueue] = useState<Pending[]>([]);
  useEffect(() => {
    const pending = new Set<Pending>();
    const unregister = registerProcessingDecision((challenge, signal) => new Promise<boolean>(resolve => {
      const item: Pending = { challenge, answer: allowed => {
        pending.delete(item); signal?.removeEventListener('abort', abort);
        setQueue(current => current.filter(candidate => candidate !== item)); resolve(allowed);
      } };
      const abort = () => item.answer(false);
      if (signal?.aborted) { resolve(false); return; }
      pending.add(item); signal?.addEventListener('abort', abort, { once: true });
      setQueue(current => [...current, item]);
    }));
    return () => { unregister(); for (const item of pending) item.answer(false); };
  }, []);
  const current = queue[0];
  if (!current) return null;
  const info = current.challenge.processing;
  return <AppDialog open onClose={() => current.answer(false)}>
    <header><h2>本次向外部服务发送什么</h2></header>
    <p><strong>{info.action}</strong></p>
    <h3>接收方</h3><ul>{info.destinations.map(item => <li key={item}>{item}</li>)}</ul>
    <h3>材料范围</h3><ul>{info.materials.map(item => <li key={item}>{item}</li>)}</ul>
    {!!info.files?.length && <p>文件：{info.files.join('、')}</p>}
    {!!info.documents.length && <p>文档：{info.documentNames?.join('、') || `${info.documents.length} 篇`}</p>}
    {!!info.projects.length && <p>项目：{info.projectNames?.join('、') || `${info.projects.length} 个`}</p>}
    <p>{info.disclosure}</p>
    <p>确认仅适用于本次请求及其后台处理。可在 AI 设置中禁止该库、文档或项目的外部发送。</p>
    <footer><button onClick={() => current.answer(false)}>取消，不发送</button><button className="primary-button" onClick={() => current.answer(true)}>允许本次发送</button></footer>
  </AppDialog>;
}
