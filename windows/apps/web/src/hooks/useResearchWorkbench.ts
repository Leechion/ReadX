import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { readJSON, STORAGE_KEYS, writeJSON } from '../lib/storage';
import { addReadingTasks, finishFocusSession, isFocusRunning, normalizeWorkbench, type FocusSession, type WorkbenchData, type ReadingCandidate } from '../lib/researchWorkbench';

export type ResearchWorkbenchController = { data: WorkbenchData; setData: Dispatch<SetStateAction<WorkbenchData>> };

/** The application owns the session so completion still runs outside the workbench. */
export function useResearchWorkbench(): ResearchWorkbenchController {
  const [data, setData] = useState(() => finishFocusSession(normalizeWorkbench(readJSON(STORAGE_KEYS.researchWorkbench, {})), Date.now()));
  useEffect(() => { writeJSON(STORAGE_KEYS.researchWorkbench, data); }, [data]);
  useEffect(() => {
    const receive = (event: Event) => { const papers = (event as CustomEvent<ReadingCandidate[]>).detail; if (Array.isArray(papers)) setData(current => addReadingTasks(current, papers)); };
    window.addEventListener('readx:reading-candidates', receive);
    return () => window.removeEventListener('readx:reading-candidates', receive);
  }, []);
  const end = data.focusSession?.endsAt;
  useEffect(() => {
    if (end == null) return;
    const complete = () => setData(current => finishFocusSession(current, Date.now()));
    const timeout = window.setTimeout(complete, Math.max(0, end - Date.now()));
    window.addEventListener('focus', complete);
    document.addEventListener('visibilitychange', complete);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('focus', complete);
      document.removeEventListener('visibilitychange', complete);
    };
  }, [end]);
  return { data, setData };
}

/** Only timer views repaint each second; document readers keep their own render cadence. */
export function useFocusClock(session: FocusSession | null): number {
  const [now, setNow] = useState(Date.now);
  const running = isFocusRunning(session);
  useEffect(() => {
    const sync = () => setNow(Date.now());
    sync();
    const timer = window.setInterval(sync, running ? 1000 : 60000);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [running, session?.id, session?.endsAt, session?.startedAt]);
  return now;
}
