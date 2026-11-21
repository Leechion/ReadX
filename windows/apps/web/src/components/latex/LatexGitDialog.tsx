import { useCallback, useEffect, useState } from 'react';
import { api, type LatexGitStatus } from '../../api/client';
import { AppDialog } from '../AppDialog';

export function LatexGitDialog({
  open,
  projectId,
  projectTitle,
  onClose,
  onSyncComplete,
}: {
  open: boolean;
  projectId: string;
  projectTitle: string;
  onClose: () => void;
  onSyncComplete?: () => void;
}) {
  const [status, setStatus] = useState<LatexGitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await api.latexGitStatus(projectId);
      setStatus(next);
      setRemoteUrl(next.remoteUrl || '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setNotice('');
    void refresh();
  }, [open, refresh]);

  const initRepo = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await api.latexGitInit(projectId, 'main');
      setStatus(next);
      setNotice('已初始化 Git 仓库并生成 LaTeX 默认 .gitignore。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const commitNow = async () => {
    const msg = commitMessage.trim() || `Update ${projectTitle}`;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await api.latexGitCommit(projectId, msg);
      setStatus(next);
      setCommitMessage('');
      setNotice('已创建本地 Git 提交。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveRemote = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await api.latexGitSetRemote(projectId, remoteUrl.trim());
      setStatus(next);
      setNotice('已更新 origin 远程仓库地址。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const syncRemote = async (mode: 'pull' | 'push' | 'both') => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api.latexGitSync(projectId, mode, commitMessage.trim() || undefined);
      setStatus(res.status);
      if (res.committed) setCommitMessage('');
      setNotice(res.output || `已完成 Git ${mode === 'pull' ? '拉取' : mode === 'push' ? '推送' : '双向同步'}。`);
      if (mode === 'pull' || mode === 'both') onSyncComplete?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      busy={busy}
      closeOnBackdrop
      className="ai-settings latex-git-dialog"
      aria-labelledby="latex-git-title"
    >
      <header className="ai-settings-head">
        <button type="button" className="ai-back" onClick={onClose} disabled={busy} aria-label="关闭 Git 对话框">←</button>
        <h2 id="latex-git-title">Git 版本管理 · {projectTitle}</h2>
      </header>
      <div className="latex-git-body">
        <p className="ai-hint">在项目源码目录内进行本地提交、远程仓库关联与协作同步（自动忽略 .aux/.log 等编译产物）</p>
        {loading ? <p className="ai-hint">正在检测 Git 仓库状态…</p> : null}
        {error ? <p className="latex-alert error" role="alert">{error}</p> : null}
        {notice ? <p className="latex-alert ok" role="status">{notice}</p> : null}

        {status && !status.available ? (
          <p className="ai-hint">当前机器未检测到 <code>git</code> 命令行工具，安装 Git 并加入 PATH 后即可使用仓库提交与远程同步。</p>
        ) : null}

        {status && status.available && !status.initialized ? (
          <div className="latex-git-empty">
            <p className="ai-hint">当前项目尚未初始化 Git 仓库。初始化后会生成适合 Overleaf / GitHub 的 LaTeX <code>.gitignore</code>。</p>
            <button type="button" className="ai-save-button" disabled={busy} onClick={() => void initRepo()}>
              {busy ? '初始化中…' : '初始化 Git 仓库 (main)'}
            </button>
          </div>
        ) : null}

        {status && status.available && status.initialized ? (
          <>
            <div className="latex-git-meta">
              <span>分支：<strong>{status.branch || 'main'}</strong></span>
              <span>工作区：<strong>{status.clean ? '干净' : `${status.changes.length} 项未提交变更`}</strong></span>
              {(status.ahead > 0 || status.behind > 0) ? (
                <span>远端差异：↑{status.ahead} / ↓{status.behind}</span>
              ) : null}
              <button type="button" disabled={busy || loading} onClick={() => void refresh()}>刷新</button>
            </div>
            {status.lastCommit ? <p className="ai-hint">最近提交：{status.lastCommit}</p> : null}

            {status.changes.length > 0 ? (
              <ul className="latex-git-changes">
                {status.changes.map((c) => (
                  <li key={`${c.indexStatus}${c.worktreeStatus}-${c.path}`}>
                    <span className="latex-git-badge">{c.summary}</span>
                    <code>{c.path}</code>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="latex-git-section">
              <label>
                提交说明
                <input
                  value={commitMessage}
                  disabled={busy}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder={`例如：修订方法章节公式（默认：Update ${projectTitle}）`}
                />
              </label>
              <div className="latex-git-actions">
                <button type="button" className="ai-save-button" disabled={busy || status.clean} onClick={() => void commitNow()}>
                  提交更改 (Commit)
                </button>
              </div>
            </div>

            <div className="latex-git-section">
              <label>
                远程仓库 (origin)
                <div className="latex-git-remote-row">
                  <input
                    value={remoteUrl}
                    disabled={busy}
                    onChange={(e) => setRemoteUrl(e.target.value)}
                    placeholder="https://github.com/user/repo.git 或 git@github.com:user/repo.git"
                  />
                  <button type="button" disabled={busy || !remoteUrl.trim()} onClick={() => void saveRemote()}>
                    保存远端
                  </button>
                </div>
              </label>
              <div className="latex-git-actions">
                <button type="button" disabled={busy || !status.remoteUrl} onClick={() => void syncRemote('pull')}>
                  拉取 (Pull)
                </button>
                <button type="button" disabled={busy || !status.remoteUrl} onClick={() => void syncRemote('push')}>
                  推送 (Push)
                </button>
                <button type="button" className="ai-save-button" disabled={busy || !status.remoteUrl} onClick={() => void syncRemote('both')}>
                  {busy ? '同步中…' : '一键同步 (Commit + Pull + Push)'}
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
      <footer className="ai-settings-foot">
        <button type="button" className="ai-save-button" disabled={busy} onClick={onClose}>关闭</button>
      </footer>
    </AppDialog>
  );
}
