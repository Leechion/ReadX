import { useState, type Dispatch, type SetStateAction } from 'react';
import { finishFocusSession, focusSeconds, formatFocusClock, isFocusRunning, newId, startFocusSession, toggleFocusSession, type WorkbenchData } from '../../lib/researchWorkbench';
import { Icon } from '../ui/Icon';
import { Button, IconButton } from '../ui/Primitives';

export function ResearchFocus({ data, setData, now, selectedTodo, onSelectTodo }: {
  data: WorkbenchData; setData: Dispatch<SetStateAction<WorkbenchData>>; now: number;
  selectedTodo: string; onSelectTodo: (id: string) => void;
}) {
  const session = data.focusSession;
  const [minutes, setMinutes] = useState(session?.minutes || 25);
  const mode = session?.mode ?? (session ? 'countdown' : data.focusMode);
  const active = data.todos.filter(todo => !todo.done);
  const todoId = session?.todoId ?? (active.some(todo => todo.id === selectedTodo) ? selectedTodo : '');
  const running = isFocusRunning(session);
  const seconds = session ? focusSeconds(session, now) : mode === 'countdown' ? minutes * 60 : 0;
  const activeTodoTitle = data.todos.find(todo => todo.id === (session?.todoId || todoId))?.title;

  const toggle = () => {
    const timestamp = Date.now();
    const id = newId();
    setData(current => current.focusSession ? toggleFocusSession(current, timestamp)
      : { ...current, focusSession: startFocusSession(mode, minutes, todoId, timestamp, id) });
  };

  return (
    <section className="rx-focus-card" id="rw-focus-panel">
      <div className="rx-focus-tt">
        <span>专注计时 · {mode === 'countdown' ? '倒计时' : '正计时'}</span>
        <span className={`rx-chip${running ? ' info' : ''}`} style={{ height: 22 }}>
          {running ? '进行中' : session ? '已暂停' : '待开始'}
        </span>
      </div>

      <div className="rx-focus-clock" role="timer" aria-label={mode === 'stopwatch' ? '已专注时间' : '专注剩余时间'}>
        {formatFocusClock(seconds)}
      </div>

      {session ? (
        <div className="rx-focus-for">
          正在专注：{activeTodoTitle || '自由专注'}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {([['countdown', '倒计时'], ['stopwatch', '正计时']] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`rx-chip${mode === id ? ' accent' : ''}`}
                aria-pressed={mode === id}
                onClick={() => setData(current => ({ ...current, focusMode: id }))}
                style={{ cursor: 'pointer' }}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            className="rx-focus-select"
            aria-label="关联专注任务"
            value={todoId}
            onChange={event => onSelectTodo(event.target.value)}
          >
            <option value="">自由专注</option>
            {active.map(todo => (
              <option key={todo.id} value={todo.id}>{todo.title}</option>
            ))}
          </select>
          {mode === 'countdown' ? (
            <div className="rx-focus-presets" aria-label="专注时长">
              {[15, 25, 45, 60].map(value => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={minutes === value}
                  onClick={() => setMinutes(value)}
                >
                  {value}m
                </button>
              ))}
            </div>
          ) : (
            <div className="rx-focus-for">从 00:00 开始，按自己的节奏专注</div>
          )}
        </>
      )}

      <div className="rx-focus-ctl">
        <Button variant={session && running ? 'secondary' : 'primary'} size="sm" onClick={toggle}>
          <Icon name={running ? 'pause' : 'play'} size={14} />
          <span>{running ? '暂停' : session ? '继续' : '开始专注'}</span>
        </Button>
        {session ? (
          <>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setData(current => finishFocusSession(current, Date.now(), true))}
            >
              <Icon name="check" size={14} />
              <span>结束并记录</span>
            </Button>
            <IconButton
              size="sm"
              icon="undo"
              label="重置当前专注"
              className="rx-focus-reset"
              title="重置当前专注，不记录本次"
              onClick={() => setData(current => ({ ...current, focusSession: null }))}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}
