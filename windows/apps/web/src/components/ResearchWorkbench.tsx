import { useEffect, useRef, useState } from 'react';
import type { DocumentSummary, LauncherOpenRequest } from '@cbct/shared';
import { focusSeconds, formatFocusClock, isFocusRunning, localDay, totalFocusMinutes, type WorkbenchTab } from '../lib/researchWorkbench';
import { useFocusClock, type ResearchWorkbenchController } from '../hooks/useResearchWorkbench';
import { ResearchDaily } from './research/ResearchDaily';
import { ResearchAcademics } from './research/ResearchAcademics';
import { ResearchNews } from './research/ResearchNews';
import { Icon } from './ui/Icon';
import { Button, Segmented } from './ui/Primitives';
import './research-workbench.css';

export function ResearchWorkbench({ documents, onOpenDocument, onReload, onOpenLibrary, controller, launchRequest }: {
  documents: DocumentSummary[]; onOpenDocument: (id: string) => void; onReload: () => void; onOpenLibrary: () => void;
  controller: ResearchWorkbenchController;
  launchRequest?: LauncherOpenRequest | null;
}) {
  const { data, setData } = controller;
  const now = useFocusClock(data.focusSession);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pageRef = useRef<HTMLElement>(null);
  const tab = data.activeTab;
  const session = data.focusSession;
  const day = localDay(new Date(now));
  const todayMinutes = totalFocusMinutes(data.logs.filter(log => log.day === day));
  const activeCount = data.todos.filter(todo => !todo.done).length;

  useEffect(() => { pageRef.current?.scrollTo({ top: 0 }); }, [tab]);

  const selectTab = (activeTab: WorkbenchTab) => setData(current => ({ ...current, activeTab }));
  const clock = session ? formatFocusClock(focusSeconds(session, now)) : '';

  return (
    <div className="rw-layout">
      <header className="rx-topbar">
        <h1 className="rx-topbar-title">研究工作台</h1>
        <Segmented
          ariaLabel="研究工作台视图"
          value={tab}
          onChange={selectTab}
          options={[
            { value: 'daily', label: activeCount > 0 ? `科研日常 (${activeCount})` : '科研日常' },
            { value: 'academics', label: '学业看板' },
            { value: 'news', label: data.savedArticles.length > 0 ? `资讯追踪 (${data.savedArticles.length})` : '资讯追踪' },
          ]}
        />
        <span className="rx-spacer" />
        <button
          type="button"
          className={`rx-chip${session ? ' info' : ''}`}
          onClick={() => selectTab('daily')}
          title={session ? (isFocusRunning(session) ? '专注进行中' : '专注已暂停') : '今日已累计专注时长'}
        >
          <Icon name="timer" size={13} />
          <span className="tabular-nums">
            {session ? `${isFocusRunning(session) ? '专注中' : '已暂停'} · ${clock}` : `今日专注 · ${todayMinutes} 分钟`}
          </span>
        </button>
        {tab === 'academics' && (
          <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
            <Icon name="sliders" size={14} />
            <span>编辑培养信息</span>
          </Button>
        )}
      </header>
      <main className="rw-desk-scroll" ref={pageRef}>
        {tab === 'daily' ? (
          <ResearchDaily
            data={data}
            setData={setData}
            now={now}
            documents={documents}
            onOpenDocument={onOpenDocument}
            onOpenLibrary={onOpenLibrary}
            launchRequest={launchRequest}
          />
        ) : tab === 'academics' ? (
          <ResearchAcademics
            data={data}
            setData={setData}
            now={now}
            settingsOpen={settingsOpen}
            onCloseSettings={() => setSettingsOpen(false)}
          />
        ) : (
          <ResearchNews
            data={data}
            setData={setData}
            documents={documents}
            onReload={onReload}
          />
        )}
      </main>
    </div>
  );
}
