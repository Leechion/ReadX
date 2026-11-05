import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { AppDialog } from './AppDialog';
import { captureBrowserBackup } from '../lib/browserBackup';

type SyncProvider = 'folder' | 'jianguoyun';

export function SyncSettingsDialog({ onClose, onSyncComplete }: { onClose: () => void; onSyncComplete: () => void }) {
  const [provider, setProvider] = useState<SyncProvider>('folder');
  const [folderPath, setFolderPath] = useState('');
  const [webdavUsername, setWebdavUsername] = useState('');
  const [password, setPassword] = useState('');
  const [lastSync, setLastSync] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const backup = async (action: 'create' | 'restore') => {
    if (busy || !window.__READX_BACKUP__) return;
    setBusy(true);
    setNotice('正在准备本地存储快照…');
    try {
      if (!await window.__READX_BACKUP__.prepare(action)) { setNotice('操作已取消'); return; }
      const state = await captureBrowserBackup();
      const started = await window.__READX_BACKUP__.run(action, state);
      setNotice(started ? '应用即将关闭，完成后会自动重新启动。' : '操作已取消');
    } catch (error) {
      await window.__READX_BACKUP__.cancel();
      setNotice(error instanceof Error ? error.message : String(error));
    }
    finally { setBusy(false); }
  };

  useEffect(() => {
    let active = true;
    void api.syncSettings().then(async (settings) => {
      if (!active) return;
      setProvider(settings.provider === 'jianguoyun' ? 'jianguoyun' : 'folder');
      setFolderPath(settings.provider === 'folder' ? settings.folderPath : '');
      setWebdavUsername(settings.webdavUsername);
      setLastSync(settings.lastSync);
      const savedPassword = await window.__READX_SYNC__?.getNutstorePassword();
      if (active && savedPassword) setPassword(savedPassword);
    }).catch((cause) => {
      if (active) setNotice(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, []);

  const chooseFolder = async () => {
    try {
      const selected = await window.__READX_SYNC__?.chooseFolder();
      if (selected) {
        setFolderPath(selected);
        setNotice('');
      }
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const saveSettings = async () => {
    if (busy) return;
    if (provider === 'jianguoyun' && (!webdavUsername.trim() || !password)) {
      setNotice('请输入坚果云账号邮箱和应用密码。');
      return;
    }
    if (provider === 'folder' && !folderPath.trim()) {
      setNotice('请选择同步文件夹。');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      await api.saveSyncSettings({
        provider,
        ...(provider === 'folder' ? { folderPath: folderPath.trim() } : { webdavUsername: webdavUsername.trim() }),
      });
      if (provider === 'jianguoyun') await window.__READX_SYNC__?.setNutstorePassword(password);
      else await window.__READX_SYNC__?.setNutstorePassword('');
      setNotice(provider === 'jianguoyun' ? '坚果云设置已保存。点击“立即同步”验证连接并合并书库、阅读进度和笔记。' : '同步文件夹设置已保存。');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    if (busy) return;
    if (provider === 'jianguoyun' && (!webdavUsername.trim() || !password)) {
      setNotice('请先填写坚果云账号邮箱和应用密码。');
      return;
    }
    if (provider === 'folder' && !folderPath.trim()) {
      setNotice('请先选择同步文件夹。');
      return;
    }
    setBusy(true);
    setNotice('正在合并书库、阅读进度和笔记…');
    try {
      const saved = await api.syncSettings();
      const sameConnection = provider === saved.provider && (
        provider === 'jianguoyun'
          ? webdavUsername.trim() === saved.webdavUsername
          : folderPath.trim() === saved.folderPath
      );
      if (!sameConnection) {
        await api.saveSyncSettings({
          provider,
          ...(provider === 'folder' ? { folderPath: folderPath.trim() } : { webdavUsername: webdavUsername.trim() }),
        });
      }
      const result = await api.syncNow({ password: provider === 'jianguoyun' ? password : undefined });
      if (provider === 'jianguoyun') await window.__READX_SYNC__?.setNutstorePassword(password);
      setLastSync(result.lastSync);
      setNotice(`同步完成：${result.documents} 篇文档、${result.readingPositions} 条阅读位置、${result.annotations} 条笔记。`);
      window.dispatchEvent(new Event('readx-sync-complete'));
      onSyncComplete();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog open onClose={onClose} busy={busy} className="ai-settings" aria-labelledby="sync-settings-title">
      <header className="ai-settings-head">
        <button type="button" className="ai-back" onClick={onClose} aria-label="关闭同步设置">←</button>
        <h2 id="sync-settings-title">跨设备同步</h2>
        <span className={`ai-chip${provider === 'jianguoyun' ? ' ok' : ''}`}>{provider === 'jianguoyun' ? '坚果云' : '本地目录'}</span>
      </header>
      <div className="ai-settings-body">
        {window.__READX_BACKUP__ && <section className="ai-card">
          <header>完整备份与恢复</header>
          <p className="ai-hint">保存论文、数据库、译文、LaTeX 项目、聊天、研究工作台及独立文库。备份在应用关闭后执行，完成后自动重启；恢复前校验文件并保留当前数据。备份可能包含服务密钥，请妥善保管。</p>
          <div className="ai-ocr-actions">
            <button type="button" disabled={busy} onClick={() => void backup('create')}>创建完整备份</button>
            <button type="button" disabled={busy} onClick={() => void backup('restore')}>从备份恢复</button>
          </div>
        </section>}
        <section className="ai-card">
          <header><span className="ai-card-icon" aria-hidden="true">⇄</span>选择同步服务商</header>
          <label>
            服务商
            <select value={provider} disabled={busy} onChange={(event) => { setProvider(event.target.value as SyncProvider); setNotice(''); }}>
              <option value="jianguoyun">坚果云（WebDAV）</option>
              <option value="folder">本地 / 已同步文件夹</option>
              <option value="onedrive" disabled>OneDrive（等待 Client ID）</option>
            </select>
          </label>
          {provider === 'jianguoyun' ? (
            <>
              <p className="ai-hint">使用坚果云的 WebDAV 服务。请先在坚果云网页端创建专用的应用密码；ReadX 会把密码加密保存在本机，不会同步到其他设备。</p>
              <label>坚果云账号邮箱<input type="email" autoComplete="username" value={webdavUsername} disabled={busy} onChange={(event) => setWebdavUsername(event.target.value)} placeholder="用于登录坚果云的邮箱" /></label>
              <label>坚果云应用密码<input type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} placeholder="在坚果云安全选项中生成" /></label>
              <p className="ai-hint"><a href="https://help.jianguoyun.com/?p=2064" target="_blank" rel="noopener noreferrer">查看坚果云 WebDAV 应用密码说明</a></p>
            </>
          ) : (
            <>
              <p className="ai-hint">选择两台设备都能访问的同一个同步目录，例如 OneDrive 或其他网盘客户端的本地同步目录。</p>
              <label>
                同步文件夹
                <div className="ai-sync-folder">
                  <input value={folderPath} disabled={busy} onChange={(event) => setFolderPath(event.target.value)} placeholder="选择本机的网盘同步文件夹" aria-label="同步文件夹路径" />
                  {window.__READX_SYNC__ ? <button type="button" disabled={busy} onClick={() => void chooseFolder()}>选择文件夹</button> : null}
                </div>
              </label>
            </>
          )}
          <div className="ai-ocr-actions">
            <button type="button" className="ai-save-button" disabled={busy} onClick={() => void saveSettings()}>{busy ? '处理中…' : '保存连接'}</button>
            <button type="button" className="ai-save-button" disabled={busy} onClick={() => void syncNow()}>{busy ? '同步中…' : '立即同步'}</button>
          </div>
          {lastSync ? <p className="ai-hint">上次同步：{new Date(lastSync).toLocaleString()}</p> : null}
          {notice ? <p role="status" className={`ai-result${notice.includes('完成') || notice.includes('连接') ? ' ok' : ''}`}>{notice}</p> : null}
        </section>
      </div>
      <footer className="ai-settings-foot">
        <button type="button" className="ai-save-button" disabled={busy} onClick={onClose}>完成</button>
      </footer>
    </AppDialog>
  );
}
