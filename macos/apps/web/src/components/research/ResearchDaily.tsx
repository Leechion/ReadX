import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { DocumentSummary, LauncherOpenRequest } from '@cbct/shared';
import {
  dayDistance,
  localDay,
  logFocusLabel,
  newId,
  priorityLabels,
  selectTodos,
  startFocusSession,
  totalFocusMinutes,
  weekActivity,
  type Todo,
  type TodoFilter,
  type WorkbenchData,
} from '../../lib/researchWorkbench';
import { AppDialog } from '../AppDialog';
import { Icon } from '../ui/Icon';
import { Button, EmptyState, IconButton, Segmented } from '../ui/Primitives';
import { ResearchFocus } from './ResearchFocus';

function DueLabel({ due, day }: { due: string; day: string }) {
  if (!due) return <span>未设截止日期</span>;
  const days = dayDistance(day, due);
  return (
    <span className={days < 0 ? 'od' : days === 0 ? 'today' : ''}>
      {days < 0 ? `逾期 ${-days} 天` : days === 0 ? '今天截止' : days === 1 ? '明天截止' : `${due.slice(5).replace('-', ' 月 ')} 日截止`}
    </span>
  );
}

export function ResearchDaily({ data, setData, now, documents, onOpenDocument, onOpenLibrary, launchRequest }: {
  data: WorkbenchData; setData: Dispatch<SetStateAction<WorkbenchData>>; now: number;
  documents: DocumentSummary[]; onOpenDocument: (id: string) => void; onOpenLibrary: () => void;
  launchRequest?: LauncherOpenRequest | null;
}) {
  const day = localDay(new Date(now));
  const [filter, setFilter] = useState<TodoFilter>('active');
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Todo['priority']>('medium');
  const [due, setDue] = useState('');
  const [editing, setEditing] = useState<Todo | null>(null);
  const [logDraft, setLogDraft] = useState('');
  const logDay = day;
  const [allLogs, setAllLogs] = useState(false);
  const [selectedTodo, setSelectedTodo] = useState(data.focusSession?.todoId ?? '');
  const handledLaunch = useRef<number | null>(null);

  useEffect(() => {
    if (!launchRequest?.id?.startsWith('todo:') || handledLaunch.current === launchRequest.nonce) return;
    handledLaunch.current = launchRequest.nonce;
    const todo = data.todos.find(item => item.id === launchRequest.id!.slice(5));
    if (todo) { setEditing({ ...todo }); setSelectedTodo(todo.id); }
  }, [launchRequest, data.todos]);

  const active = selectTodos(data.todos, 'active', day);
  const doneCount = data.todos.filter(todo => todo.done).length;
  const visible = selectTodos(data.todos, filter, day);
  const overdue = active.filter(todo => todo.due && todo.due < day).length;
  const activity = weekActivity(data.logs, day);
  const weekMinutes = activity.reduce((sum, item) => sum + item.minutes, 0);
  const todayLogs = data.logs.filter(log => log.day === day);
  const session = data.focusSession;
  const recent = [...documents]
    .sort((a, b) => Number(b.status === 'reading') - Number(a.status === 'reading') || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 3);
  const logs = [...data.logs].sort((a, b) => b.day.localeCompare(a.day));
  const shownLogs = allLogs ? logs : logs.slice(0, 5);
  const maxWeekMinutes = Math.max(30, ...activity.map(entry => entry.minutes));

  const addTodo = () => {
    if (!title.trim()) return;
    const todo: Todo = { id: newId(), title: title.trim(), priority, due, done: false, createdAt: new Date().toISOString() };
    setData(current => ({ ...current, todos: [todo, ...current.todos] }));
    setTitle(''); setDue(''); setFilter('active');
  };

  const toggleTodo = (id: string) => setData(current => ({
    ...current,
    todos: current.todos.map(todo => todo.id === id ? { ...todo, done: !todo.done, completedAt: todo.done ? undefined : new Date().toISOString() } : todo),
  }));

  const startFocusOnTodo = (todo: Todo) => {
    setSelectedTodo(todo.id);
    if (!session) {
      setData(current => ({
        ...current,
        focusSession: startFocusSession(current.focusMode, 25, todo.id, Date.now(), newId()),
      }));
    } else {
      document.getElementById('rw-focus-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const addLog = () => {
    if (!logDraft.trim() || !logDay) return;
    const entry = { id: newId(), day: logDay, text: logDraft.trim(), minutes: 0 };
    setData(current => ({ ...current, logs: [entry, ...current.logs] }));
    setLogDraft('');
  };

  return (
    <div className="rx-desk">
      <div className="rx-desk-col">
        <div className="rx-kpis">
          <div>
            <b>{active.length}</b>
            <span>进行中的任务 · {doneCount} 项已完成</span>
          </div>
          <div className={overdue ? 'bad' : ''}>
            <b>{overdue}</b>
            <span>{overdue ? '已过截止日期' : '当前无逾期任务'}</span>
          </div>
          <div>
            <b>{weekMinutes}</b>
            <span>近 7 天专注分钟（今日 {totalFocusMinutes(todayLogs)} 分）</span>
          </div>
        </div>

        <div className="rx-desk-hd">
          <h4>研究任务</h4>
          <small className="tabular-nums">{active.length} 项待办</small>
          <span className="rx-spacer" />
          <Segmented
            ariaLabel="任务筛选"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'active', label: `全部待办` },
              { value: 'today', label: `今天与逾期` },
              { value: 'week', label: `未来 7 天` },
              { value: 'done', label: `已完成` },
            ]}
          />
        </div>

        <form className="rx-quick" onSubmit={event => { event.preventDefault(); addTodo(); }}>
          <div className="rx-quick-input">
            <Icon name="plus" size={15} />
            <input
              id="rw-task-input"
              aria-label="新任务内容"
              placeholder="下一步，想推进什么研究？"
              value={title}
              onChange={event => setTitle(event.target.value)}
            />
          </div>
          <select
            aria-label="新任务优先级"
            className="rx-quick-select"
            value={priority}
            onChange={event => setPriority(event.target.value as Todo['priority'])}
          >
            {Object.entries(priorityLabels).map(([value, label]) => (
              <option key={value} value={value}>优先级 · {label}</option>
            ))}
          </select>
          <input
            type="date"
            aria-label="新任务截止日期"
            className="rx-quick-date"
            value={due}
            onChange={event => setDue(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!title.trim()}>
            添加
          </Button>
        </form>

        {visible.length > 0 ? (
          <div className="rx-task-list">
            {visible.map(todo => (
              <div key={todo.id} className={`rx-task${todo.done ? ' done' : ''}`}>
                <button
                  type="button"
                  className={`rx-cb${todo.done ? ' on' : ''}`}
                  aria-label={todo.done ? `恢复任务：${todo.title}` : `完成任务：${todo.title}`}
                  aria-pressed={todo.done}
                  onClick={() => toggleTodo(todo.id)}
                >
                  {todo.done ? <Icon name="check" size={12} /> : null}
                </button>
                <div>
                  <button type="button" className="rx-task-title" onClick={() => setEditing({ ...todo })}>
                    {todo.title}
                  </button>
                  <div className="rx-task-tm">
                    <span className={`rx-pri ${todo.priority}`}>
                      {todo.priority === 'high' ? '高' : todo.priority === 'medium' ? '中' : '低'}
                    </span>
                    {todo.done && todo.completedAt ? (
                      <span>{todo.completedAt.slice(5, 10).replace('-', ' 月 ')} 日完成</span>
                    ) : (
                      <DueLabel due={todo.due} day={day} />
                    )}
                    {todo.notes ? <span>有备注</span> : null}
                  </div>
                </div>
                {!todo.done ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="rx-task-go"
                    disabled={Boolean(session)}
                    title={session ? '专注计时进行中' : '以此任务开始专注'}
                    onClick={() => startFocusOnTodo(todo)}
                  >
                    <Icon name="timer" size={13} />
                    <span>专注</span>
                  </Button>
                ) : <span />}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={filter === 'done' ? 'check' : 'list'}
            title={filter === 'done' ? '还没有已完成的任务' : filter === 'active' ? '从一个小而明确的任务开始' : '该时间范围内没有待办'}
            description={filter === 'active' ? '例如：读完一篇论文，或整理今天的实验结果。' : '切换上方筛选条件查看全部任务。'}
          />
        )}

        <div className="rx-reading-strip">
          <div className="rx-desk-hd" style={{ marginBottom: 8 }}>
            <h4 style={{ fontSize: 14 }}>继续阅读</h4>
            <span className="rx-spacer" />
            <Button variant="ghost" size="sm" onClick={onOpenLibrary}>
              前往书库 <Icon name="right" size={13} />
            </Button>
          </div>
          {recent.length > 0 ? (
            <div className="rx-reading-list">
              {recent.map((doc, idx) => (
                <button
                  key={doc.id}
                  type="button"
                  className="rx-reading-pill"
                  onClick={() => onOpenDocument(doc.id)}
                >
                  <span>0{idx + 1}</span>
                  <div>
                    <strong>{doc.translatedTitle || doc.title}</strong>
                    <small>{[doc.authors[0], doc.year].filter(Boolean).join(' · ') || (doc.format?.toUpperCase() ?? 'PDF')}</small>
                  </div>
                  <Icon name="right" size={14} />
                </button>
              ))}
            </div>
          ) : (
            <p className="text-ink-faint text-[12px] m-0">从书库导入第一篇文献后，最近阅读将显示在这里。</p>
          )}
        </div>
      </div>

      <aside className="rx-desk-side" aria-label="专注与研究记录">
        <ResearchFocus
          data={data}
          setData={setData}
          now={now}
          selectedTodo={selectedTodo}
          onSelectTodo={setSelectedTodo}
        />

        <div>
          <div className="rx-desk-hd" style={{ marginBottom: 4 }}>
            <h4 style={{ fontSize: 14 }}>近 7 天专注</h4>
            <span className="rx-spacer" />
            <small className="tabular-nums">{weekMinutes} 分钟</small>
          </div>
          <div className="rx-week">
            {activity.map(item => (
              <div
                key={item.day}
                className={item.day === day ? 'today' : ''}
                title={`${item.day} · 专注 ${item.minutes} 分钟`}
              >
                <i style={{ height: `${Math.max(8, Math.round((item.minutes / maxWeekMinutes) * 100))}%` }} />
                <span>{item.day === day ? '今' : item.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="rx-desk-hd" style={{ marginBottom: 6 }}>
            <h4 style={{ fontSize: 14 }}>今日研究记录</h4>
            <span className="rx-spacer" />
            <small className="tabular-nums">{todayLogs.length} 条</small>
          </div>
          {shownLogs.length > 0 ? (
            <div className="rx-log-list">
              {shownLogs.map(log => (
                <div key={log.id} className="rx-log">
                  <time>{log.day === day ? '今天' : log.day.slice(5)}</time>
                  <div>
                    <p>
                      <span className="kind">
                        {log.seconds != null || log.minutes > 0 ? `专注 ${logFocusLabel(log)}` : '日志'}
                      </span>
                      {log.text}
                    </p>
                  </div>
                  <IconButton
                    size="sm"
                    icon="trash"
                    label={`删除日志：${log.text}`}
                    className="rx-log-del"
                    onClick={() => setData(current => ({ ...current, logs: current.logs.filter(item => item.id !== log.id) }))}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-ink-faint text-[12px] m-0">完成专注后会自动记录，或在下方快速写下一条。</p>
          )}
          {logs.length > 5 && (
            <Button variant="ghost" size="sm" onClick={() => setAllLogs(v => !v)} style={{ marginTop: 4 }}>
              {allLogs ? '收起记录' : `查看全部 ${logs.length} 条记录`}
            </Button>
          )}
          <form
            className="rx-quick"
            style={{ marginTop: 10, marginBottom: 0 }}
            onSubmit={event => { event.preventDefault(); addLog(); }}
          >
            <div className="rx-quick-input" style={{ flex: '1 1 160px', height: 32 }}>
              <input
                aria-label="研究日志内容"
                placeholder="今天验证了什么？下一步做什么？"
                value={logDraft}
                onChange={event => setLogDraft(event.target.value)}
              />
            </div>
            <Button type="submit" variant="secondary" size="sm" disabled={!logDraft.trim() || !logDay}>
              记录
            </Button>
          </form>
        </div>
      </aside>

      {editing ? (
        <AppDialog open onClose={() => setEditing(null)} className="rw-dialog" aria-labelledby="rw-edit-task-title">
          <form onSubmit={event => {
            event.preventDefault();
            if (!editing.title.trim()) return;
            setData(current => ({
              ...current,
              todos: current.todos.map(todo => todo.id === editing.id ? { ...editing, title: editing.title.trim() } : todo),
            }));
            setEditing(null);
          }}>
            <header>
              <div>
                <h2 id="rw-edit-task-title">编辑研究任务</h2>
              </div>
              <IconButton size="sm" icon="x" label="关闭任务编辑" onClick={() => setEditing(null)} />
            </header>
            <label>
              任务内容
              <input autoFocus required value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} />
            </label>
            <div className="rw-form-columns">
              <label>
                优先级
                <select value={editing.priority} onChange={event => setEditing({ ...editing, priority: event.target.value as Todo['priority'] })}>
                  {Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label>
                截止日期
                <input type="date" value={editing.due} onChange={event => setEditing({ ...editing, due: event.target.value })} />
              </label>
            </div>
            <label>
              研究备注
              <textarea rows={4} placeholder="记录完成标准、实验思路或相关线索" value={editing.notes ?? ''} onChange={event => setEditing({ ...editing, notes: event.target.value })} />
            </label>
            <footer>
              <Button
                variant="danger"
                size="sm"
                className="rw-danger"
                onClick={() => { setData(current => ({ ...current, todos: current.todos.filter(todo => todo.id !== editing.id) })); setEditing(null); }}
              >
                删除任务
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>取消</Button>
              <Button type="submit" variant="primary" size="sm">保存修改</Button>
            </footer>
          </form>
        </AppDialog>
      ) : null}
    </div>
  );
}
