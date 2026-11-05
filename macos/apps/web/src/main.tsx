import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { restoreBrowserBackup } from './lib/browserBackup';
import { ProcessingConsentDialog } from './components/ProcessingConsentDialog';

const LauncherWheel = lazy(() => import('./components/LauncherWheel').then(module => ({ default: module.LauncherWheel })));
const App = lazy(() => import('./App'));
const isLauncher = new URLSearchParams(window.location.search).get('readxWindow') === 'launcher';
if (isLauncher) document.documentElement.classList.add('readx-launcher-window');

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 挂载点，index.html 被改坏了');

async function mount(): Promise<void> {
  if (!isLauncher && window.__READX_BACKUP__) {
    const pending = await window.__READX_BACKUP__.pendingBrowserState();
    if (pending) {
      await restoreBrowserBackup(pending);
      await window.__READX_BACKUP__.acknowledgeBrowserState();
    }
  }
  createRoot(container!).render(
  <StrictMode>
    <ProcessingConsentDialog />
    <Suspense fallback={null}>{isLauncher ? <LauncherWheel /> : <App />}</Suspense>
  </StrictMode>,
);
}
void mount().catch(error => {
  container.textContent = `恢复桌面存储失败，快照仍保留，可重启重试：${error instanceof Error ? error.message : String(error)}`;
});
