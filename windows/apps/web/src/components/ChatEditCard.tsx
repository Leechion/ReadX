import type { ChatEditRequest } from '../hooks/useChat';
import { WorkspaceIcon } from './WorkspaceIcon';

export function ChatEditCard({ request, disabled, onApprove, onReject, onRollbackSnapshot, onOpenFile }: {
  request: ChatEditRequest;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRollbackSnapshot?: (snapshotId: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const { proposal, proposals, status, notice, autoApplied, snapshotId } = request;
  const items = proposals && proposals.length > 0 ? proposals : [proposal];
  const labels = {
    pending: '等待批准',
    applying: '正在保存',
    applied: autoApplied ? '智能体已直改' : '已保存',
    rejected: '已取消',
  };
  const isMulti = items.length > 1;
  return (
    <section className="chat-edit-card" data-status={status} aria-label="文件修改请求">
      <header>
        <span className="chat-edit-icon"><WorkspaceIcon name={status === 'applied' ? 'check' : 'hand'} size={19} /></span>
        <div>
          <strong>
            {autoApplied ? '智能体已更新源码' : isMulti ? `修改 ${items.length} 个项目文件` : proposal.original ? '修改文件' : '新建文件'}
          </strong>
          <div className="chat-edit-files">
            {items.map((item) => (
              <code
                key={item.filePath}
                title={item.filePath}
                className={onOpenFile ? 'clickable' : undefined}
                onClick={() => onOpenFile?.(item.filePath)}
              >
                {item.filePath}
              </code>
            ))}
          </div>
        </div>
        <span className="chat-edit-status">{labels[status]}</span>
      </header>
      <p>{proposal.summary || '按你的要求更新项目文件。'}</p>
      {items.map((item) => (
        <details key={item.filePath} className="chat-edit-preview">
          <summary>
            查看修改内容 · <code>{item.filePath}</code>
            {item.summary && isMulti ? ` — ${item.summary}` : ''}
          </summary>
          {item.original ? (
            <div><span>修改前</span><pre>{item.original}</pre></div>
          ) : (
            <div><span>新建文件</span></div>
          )}
          <div><span>修改后</span><pre>{item.content}</pre></div>
        </details>
      ))}
      {notice ? <p className={'chat-edit-notice' + (status === 'pending' ? ' error' : '')} role={status === 'pending' ? 'alert' : 'status'}>{notice}</p> : null}
      {status === 'pending' || status === 'applying' ? (
        <footer>
          <button type="button" disabled={disabled || status === 'applying'} onClick={onReject}>取消修改</button>
          <button type="button" className="primary" disabled={disabled || status === 'applying'} onClick={onApprove}>
            {status === 'applying' ? '正在保存…' : isMulti ? `确认保存 (${items.length} 个文件)` : '确认修改'}
          </button>
        </footer>
      ) : status === 'applied' && snapshotId && onRollbackSnapshot ? (
        <footer>
          <button type="button" disabled={disabled} onClick={() => onRollbackSnapshot(snapshotId)}>
            回滚本次智能体修改
          </button>
        </footer>
      ) : null}
    </section>
  );
}
