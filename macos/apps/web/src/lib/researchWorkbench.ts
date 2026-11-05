import type { ResearchFeedItem } from '../api/client';

export type Todo = {
  id: string; title: string; priority: 'high' | 'medium' | 'low'; due: string; done: boolean;
  notes?: string; createdAt?: string; completedAt?: string;
};

export interface ReadingCandidate { title: string; doi?: string; url?: string; source?: string; sourceId?: string }
export function addReadingTasks(data: WorkbenchData, papers: ReadingCandidate[]): WorkbenchData {
  const ids = new Set(data.todos.map(todo => todo.id));
  const added: Todo[] = [];
  for (const paper of papers) {
    const identity = paper.doi?.toLowerCase().replace(/^https?:\/\/doi.org\//, '') || paper.url || `${paper.source}:${paper.sourceId}`;
    const id = `scholar-reading:${identity}`;
    if (!paper.title || ids.has(id)) continue;
    ids.add(id); added.push({ id, title: `阅读：${paper.title}`, priority: 'medium', due: '', done: false, createdAt: new Date().toISOString(), notes: `待获取／核验全文\n${paper.doi || ''}\n${paper.url || ''}` });
  }
  return { ...data, todos: [...data.todos, ...added] };
}
export type LogEntry = { id: string; day: string; text: string; minutes: number; seconds?: number };
export type Requirement = { id: string; title: string; due: string; done: boolean };
export type PaperStatus = 'draft' | 'submitted' | 'revision' | 'accepted' | 'published';
export type PaperRecord = { id: string; title: string; venue: string; year: string; role: string; status: PaperStatus };
export type FocusMode = 'countdown' | 'stopwatch';
export type FocusSession = {
  id: string; minutes: number; remaining: number; endsAt: number | null; todoId: string;
  mode?: FocusMode; elapsedMs?: number; startedAt?: number | null;
};
export type WorkbenchTab = 'daily' | 'academics' | 'news';
export type TodoFilter = 'active' | 'today' | 'week' | 'done';
export type WorkbenchData = {
  todos: Todo[]; logs: LogEntry[]; enrollment: string; programYears: number;
  publicationTarget: number; publicationBaseline: number; papers: PaperRecord[];
  requirementItems: Requirement[]; focusSession: FocusSession | null; focusMode: FocusMode;
  savedArticles: ResearchFeedItem[]; readArticleIds: string[]; translations: Record<string, string>;
  activeTab: WorkbenchTab;
};
type LegacyData = { publications?: number; publicationRecords?: string; requirements?: string };

export const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export const dayDistance = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
export const paperStatuses: Record<PaperStatus, string> = { draft: '撰写中', submitted: '已投稿', revision: '修改中', accepted: '已录用', published: '已发表' };
export const priorityLabels: Record<Todo['priority'], string> = { high: '高优先级', medium: '中优先级', low: '低优先级' };
export const isPublished = (paper: PaperRecord) => paper.status === 'accepted' || paper.status === 'published';
export const publicationCount = (data: WorkbenchData) => data.publicationBaseline + data.papers.filter(isPublished).length;

export function normalizeWorkbench(value: Partial<WorkbenchData> & LegacyData = {}): WorkbenchData {
  const papers = value.papers ?? (value.publicationRecords ?? '').split('\n').filter(line => line.trim()).map((line, index): PaperRecord => {
    const [title = '', venue = '', year = '', role = ''] = line.split(/[|｜]/).map(part => part.trim());
    return { id: `legacy-paper-${index}`, title, venue, year, role, status: 'published' };
  });
  return {
    ...value,
    todos: value.todos ?? [], logs: value.logs ?? [], enrollment: value.enrollment ?? '',
    programYears: value.programYears ?? 4, publicationTarget: value.publicationTarget ?? 1,
    publicationBaseline: value.publicationBaseline ?? Math.max(0, (value.publications ?? 0) - papers.filter(isPublished).length),
    papers,
    requirementItems: value.requirementItems ?? (value.requirements ?? '').split('\n').filter(line => line.trim()).map((title, index) => ({ id: `legacy-requirement-${index}`, title: title.trim(), due: '', done: false })),
    focusSession: value.focusSession ?? null, focusMode: value.focusMode ?? value.focusSession?.mode ?? 'countdown', savedArticles: value.savedArticles ?? [],
    readArticleIds: value.readArticleIds ?? [], translations: value.translations ?? {},
    activeTab: value.activeTab ?? 'daily',
  };
}

export function isFocusRunning(session: FocusSession | null): boolean {
  return Boolean(session && (session.mode === 'stopwatch' ? session.startedAt != null : session.endsAt != null));
}

export function focusSeconds(session: FocusSession, now: number): number {
  if (session.mode === 'stopwatch') {
    return Math.floor(((session.elapsedMs ?? 0) + (session.startedAt != null ? Math.max(0, now - session.startedAt) : 0)) / 1000);
  }
  return session.endsAt != null ? Math.max(0, Math.ceil((session.endsAt - now) / 1000)) : session.remaining;
}

export function formatFocusClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function startFocusSession(mode: FocusMode, minutes: number, todoId: string, now: number, id = newId()): FocusSession {
  return mode === 'stopwatch'
    ? { id, mode, minutes: 0, remaining: 0, endsAt: null, todoId, elapsedMs: 0, startedAt: now }
    : { id, mode, minutes, remaining: minutes * 60, endsAt: now + minutes * 60000, todoId };
}

export function toggleFocusSession(data: WorkbenchData, now: number): WorkbenchData {
  const session = data.focusSession;
  if (!session) return data;
  if (session.mode === 'stopwatch') {
    return { ...data, focusSession: session.startedAt != null
      ? { ...session, elapsedMs: (session.elapsedMs ?? 0) + Math.max(0, now - session.startedAt), startedAt: null }
      : { ...session, startedAt: now } };
  }
  if (session.endsAt != null && session.endsAt <= now) return finishFocusSession(data, now);
  return { ...data, focusSession: session.endsAt != null
    ? { ...session, remaining: focusSeconds(session, now), endsAt: null }
    : { ...session, endsAt: now + session.remaining * 1000 } };
}

export const logFocusSeconds = (log: LogEntry) => log.seconds ?? log.minutes * 60;
export const totalFocusMinutes = (logs: LogEntry[]) => Math.floor(logs.reduce((sum, log) => sum + logFocusSeconds(log), 0) / 60);
export function logFocusLabel(log: LogEntry): string {
  const seconds = logFocusSeconds(log);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分钟${seconds % 60 ? ` ${seconds % 60} 秒` : ''}` : `${seconds} 秒`;
}

export function finishFocusSession(data: WorkbenchData, now: number, force = false): WorkbenchData {
  const session = data.focusSession;
  if (!session) return data;
  const expired = session.mode !== 'stopwatch' && session.endsAt != null && session.endsAt <= now;
  if (!force && !expired) return data;
  const seconds = session.mode === 'stopwatch' ? focusSeconds(session, now)
    : expired ? session.minutes * 60 : Math.max(0, session.minutes * 60 - focusSeconds(session, now));
  const finishedAt = expired ? session.endsAt! : now;
  const title = data.todos.find(todo => todo.id === session.todoId)?.title;
  return {
    ...data, focusSession: null,
    logs: [{ id: `focus-${session.id}`, day: localDay(new Date(finishedAt)), text: title ? `专注完成：${title}` : '完成一段自由专注', minutes: Math.floor(seconds / 60), seconds }, ...data.logs],
  };
}

export function selectTodos(todos: Todo[], filter: TodoFilter, day: string): Todo[] {
  return todos.filter(todo => {
    if (filter === 'done') return todo.done;
    if (todo.done) return false;
    if (filter === 'today') return Boolean(todo.due && todo.due <= day);
    if (filter === 'week') return Boolean(todo.due && dayDistance(day, todo.due) >= 0 && dayDistance(day, todo.due) <= 6);
    return true;
  }).sort((a, b) => {
    const urgency = (todo: Todo) => todo.due && todo.due < day ? 0 : todo.due === day ? 1 : 2;
    return urgency(a) - urgency(b)
      || ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority])
      || (a.due || '9999').localeCompare(b.due || '9999');
  });
}

export function weekActivity(logs: LogEntry[], day: string) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${day}T12:00:00`);
    date.setDate(date.getDate() - 6 + index);
    const key = localDay(date);
    return { day: key, label: ['日', '一', '二', '三', '四', '五', '六'][date.getDay()]!, minutes: totalFocusMinutes(logs.filter(log => log.day === key)) };
  });
}

export function studyProgress(enrollment: string, years: number, now = new Date()) {
  if (!enrollment) return null;
  const start = new Date(`${enrollment}T00:00:00`);
  if (!Number.isFinite(start.getTime()) || years <= 0) return null;
  const totalMonths = Math.round(years * 12);
  const finish = new Date(start);
  finish.setDate(1);
  finish.setMonth(finish.getMonth() + totalMonths);
  finish.setDate(Math.min(start.getDate(), new Date(finish.getFullYear(), finish.getMonth() + 1, 0).getDate()));
  const elapsedMonths = Math.max(0, (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth() - (now.getDate() < start.getDate() ? 1 : 0));
  return {
    start, finish, totalMonths, elapsedMonths,
    percent: Math.max(0, Math.min(100, Math.round((now.getTime() - start.getTime()) / (finish.getTime() - start.getTime()) * 100))),
    remainingDays: Math.max(0, dayDistance(localDay(now), localDay(finish))),
    currentYear: now < start ? 0 : Math.min(Math.ceil(years), Math.floor(elapsedMonths / 12) + 1),
  };
}
