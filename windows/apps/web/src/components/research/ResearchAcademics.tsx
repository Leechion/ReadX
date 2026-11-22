import { useState, type Dispatch, type SetStateAction } from 'react';
import {
  dayDistance,
  localDay,
  newId,
  paperStatuses,
  publicationCount,
  studyProgress,
  type PaperRecord,
  type PaperStatus,
  type Requirement,
  type WorkbenchData,
} from '../../lib/researchWorkbench';
import { AppDialog } from '../AppDialog';
import { Icon } from '../ui/Icon';
import { Button, EmptyState, IconButton } from '../ui/Primitives';

function DegreeSettings({ data, onSave, onClose }: {
  data: WorkbenchData;
  onSave: (values: Pick<WorkbenchData, 'enrollment' | 'programYears' | 'publicationTarget' | 'publicationBaseline'>) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState({
    enrollment: data.enrollment,
    programYears: data.programYears,
    publicationTarget: data.publicationTarget,
    publicationBaseline: data.publicationBaseline,
  });
  return (
    <AppDialog open onClose={onClose} className="rw-dialog" aria-labelledby="rw-settings-title">
      <form onSubmit={event => { event.preventDefault(); onSave(draft); onClose(); }}>
        <header>
          <div>
            <h2 id="rw-settings-title">编辑培养信息</h2>
          </div>
          <IconButton size="sm" icon="x" label="关闭培养设置" onClick={onClose} />
        </header>
        <p className="text-[12px] text-ink-faint m-0 leading-relaxed">根据入学日期和学制计算时间进度。论文目标请按院系实际要求填写。</p>
        <div className="rw-form-columns">
          <label>
            入学日期
            <input autoFocus type="date" required value={draft.enrollment} onChange={event => setDraft({ ...draft, enrollment: event.target.value })} />
          </label>
          <label>
            培养年限
            <select value={draft.programYears} onChange={event => setDraft({ ...draft, programYears: Number(event.target.value) })}>
              {[2, 2.5, 3, 4, 5, 6, 7, 8].map(year => <option key={year} value={year}>{year} 年</option>)}
            </select>
          </label>
        </div>
        <div className="rw-form-columns">
          <label>
            录用 / 发表目标
            <input type="number" min="0" step="1" required value={draft.publicationTarget} onChange={event => setDraft({ ...draft, publicationTarget: Math.max(0, Number(event.target.value)) })} />
          </label>
          <label>
            此前已发表（未逐篇录入）
            <input type="number" min="0" step="1" required value={draft.publicationBaseline} onChange={event => setDraft({ ...draft, publicationBaseline: Math.max(0, Number(event.target.value)) })} />
          </label>
        </div>
        <footer>
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" size="sm">保存培养信息</Button>
        </footer>
      </form>
    </AppDialog>
  );
}

export function ResearchAcademics({ data, setData, now, settingsOpen, onCloseSettings }: {
  data: WorkbenchData; setData: Dispatch<SetStateAction<WorkbenchData>>; now: number; settingsOpen: boolean; onCloseSettings: () => void;
}) {
  const day = localDay(new Date(now));
  const study = studyProgress(data.enrollment, data.programYears, new Date(now));
  const published = publicationCount(data);
  const doneRequirements = data.requirementItems.filter(item => item.done).length;
  const [reqComposerOpen, setReqComposerOpen] = useState(false);
  const [requirementTitle, setRequirementTitle] = useState('');
  const [requirementDue, setRequirementDue] = useState('');
  const [editingRequirement, setEditingRequirement] = useState<Requirement | null>(null);
  const [paper, setPaper] = useState<PaperRecord | null>(null);
  const [paperFilter, setPaperFilter] = useState<PaperStatus | 'all'>('all');
  const [localSettings, setLocalSettings] = useState(false);

  const pendingRequirements = [...data.requirementItems].sort(
    (a, b) => Number(a.done) - Number(b.done) || (a.due || '9999').localeCompare(b.due || '9999'),
  );
  const papers = data.papers.filter(item => paperFilter === 'all' || item.status === paperFilter);
  const formatYM = (date: Date) => `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}`;
  const newPaper = () => setPaper({ id: newId(), title: '', venue: '', year: String(new Date(now).getFullYear()), role: '', status: 'draft' });
  const remainingTarget = Math.max(0, data.publicationTarget - published);

  return (
    <div className="rx-desk-col wide">
      <div className="rx-desk-hd">
        <h4>
          {study
            ? `培养周期 · ${study.currentYear ? `第 ${study.currentYear} 学年` : '即将入学'} · ${data.programYears} 年制`
            : '培养周期 · 尚未设置'}
        </h4>
        <span className="rx-spacer" />
        <Button variant="ghost" size="sm" onClick={() => setLocalSettings(true)}>
          <Icon name="sliders" size={14} />
          <span>编辑培养信息</span>
        </Button>
      </div>

      {study ? (
        <>
          <div className="rx-tl">
            <div className="rx-tl-now" style={{ left: `${Math.min(92, Math.max(8, study.percent))}%` }}>
              {study.percent >= 100 ? '已到预计毕业时间' : `今天 · 距预计毕业还有 ${study.remainingDays} 天`}
            </div>
            <div className="rx-tl-track" role="progressbar" aria-label="培养周期进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={study.percent}>
              <i style={{ width: `${study.percent}%` }} />
            </div>
            <div className="rx-tl-ticks">
              <span>{formatYM(study.start)} 入学</span>
              <span>第 {Math.max(1, Math.min(Math.ceil(data.programYears), 2))} 学年</span>
              <span>第 {Math.max(2, Math.min(Math.ceil(data.programYears), 3))} 学年</span>
              <span>{formatYM(study.finish)} 预计毕业</span>
            </div>
          </div>
          <p className="text-[12px] text-ink-faint mt-2 mb-0">
            培养周期已走过 {Math.min(study.elapsedMonths, study.totalMonths)} / {study.totalMonths} 个月。时间进度只用于规划，毕业完成度以实际要求为准。
          </p>
        </>
      ) : (
        <EmptyState
          icon="cal"
          title="填写入学日期与培养年限"
          description="设置后可显示所在学年、培养时间轴与距毕业剩余天数。"
          action={
            <Button variant="primary" size="sm" onClick={() => setLocalSettings(true)}>
              设置培养信息
            </Button>
          }
        />
      )}

      <div className="rx-ac-grid">
        {/* Left: Graduation Requirements */}
        <div>
          <div className="rx-desk-hd">
            <h4 style={{ fontSize: 14 }}>毕业要求</h4>
            <small className="tabular-nums">
              {data.requirementItems.length} 项 · {data.requirementItems.length - doneRequirements} 项待完成
            </small>
            <span className="rx-spacer" />
            <Button variant="ghost" size="sm" onClick={() => setReqComposerOpen(v => !v)}>
              <Icon name="plus" size={14} />
              <span>添加</span>
            </Button>
          </div>

          {reqComposerOpen ? (
            <form
              className="rx-quick"
              onSubmit={event => {
                event.preventDefault();
                if (!requirementTitle.trim()) return;
                const requirement = { id: newId(), title: requirementTitle.trim(), due: requirementDue, done: false };
                setData(current => ({ ...current, requirementItems: [...current.requirementItems, requirement] }));
                setRequirementTitle('');
                setRequirementDue('');
                setReqComposerOpen(false);
              }}
            >
              <div className="rx-quick-input" style={{ height: 34 }}>
                <input
                  autoFocus
                  aria-label="新的毕业要求"
                  placeholder="例如：开题报告、修满学分"
                  value={requirementTitle}
                  onChange={event => setRequirementTitle(event.target.value)}
                />
              </div>
              <input
                type="date"
                aria-label="毕业要求截止日期"
                className="rx-quick-date"
                style={{ height: 34 }}
                value={requirementDue}
                onChange={event => setRequirementDue(event.target.value)}
              />
              <Button type="submit" variant="primary" size="sm" disabled={!requirementTitle.trim()}>
                保存
              </Button>
            </form>
          ) : null}

          {pendingRequirements.length > 0 ? (
            <div>
              {pendingRequirements.map(item => {
                const overdue = !item.done && item.due && item.due < day;
                return (
                  <div key={item.id} className={`rx-req${item.done ? ' done' : ''}`}>
                    <button
                      type="button"
                      className={`rx-cb${item.done ? ' on' : ''}`}
                      aria-pressed={item.done}
                      aria-label={`${item.done ? '恢复' : '完成'}要求：${item.title}`}
                      onClick={() => setData(current => ({
                        ...current,
                        requirementItems: current.requirementItems.map(value => value.id === item.id ? { ...value, done: !value.done } : value),
                      }))}
                    >
                      {item.done ? <Icon name="check" size={12} /> : null}
                    </button>
                    <button
                      type="button"
                      className="rx-req-title"
                      onClick={() => setEditingRequirement({ ...item })}
                    >
                      {item.title}
                    </button>
                    <small className={overdue ? 'od' : ''}>
                      {item.done
                        ? '已完成'
                        : overdue
                          ? `逾期 ${-dayDistance(day, item.due)} 天`
                          : item.due
                            ? `${item.due.slice(0, 7).replace('-', '.')} 截止`
                            : '待完成'}
                    </small>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[12px] text-ink-faint m-0 py-4">
              把学分、资格考试、开题、中期考核与答辩放进清单；点击右上角「添加」。
            </p>
          )}
        </div>

        {/* Right: Papers & Output */}
        <div>
          <div className="rx-desk-hd">
            <h4 style={{ fontSize: 14 }}>论文与成果</h4>
            <small className="tabular-nums">
              {data.publicationTarget > 0
                ? remainingTarget === 0
                  ? `目标 ${data.publicationTarget} 篇 · 已达成`
                  : `目标 ${data.publicationTarget} 篇 · 还差 ${remainingTarget} 篇`
                : `共 ${data.papers.length} 篇`}
            </small>
            <span className="rx-spacer" />
            <Button variant="ghost" size="sm" onClick={newPaper}>
              <Icon name="plus" size={14} />
              <span>记录论文</span>
            </Button>
          </div>

          <div className="rx-funnel" role="group" aria-label="论文阶段筛选">
            {(Object.keys(paperStatuses) as PaperStatus[]).map(status => {
              const count = data.papers.filter(item => item.status === status).length;
              const pressed = paperFilter === status;
              return (
                <button
                  key={status}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => setPaperFilter(value => value === status ? 'all' : status)}
                >
                  <b>{count}</b>
                  <span>{paperStatuses[status]}</span>
                </button>
              );
            })}
          </div>

          {papers.length > 0 ? (
            <table className="rx-tbl">
              <thead>
                <tr>
                  <th>论文 / 发表来源</th>
                  <th>角色</th>
                  <th className="r">年份</th>
                  <th style={{ width: 32 }} />
                </tr>
              </thead>
              <tbody>
                {papers.map(item => (
                  <tr key={item.id}>
                    <td>
                      <button
                        type="button"
                        onClick={() => setPaper({ ...item })}
                        className="text-left font-medium text-ink hover:text-accent bg-transparent border-0 p-0 cursor-pointer"
                      >
                        {item.title}
                      </button>
                      <div className="text-[12px] text-ink-faint">
                        {item.venue || '未填发表来源'} · {paperStatuses[item.status]}
                      </div>
                    </td>
                    <td>{item.role || '—'}</td>
                    <td className="r">{item.year || '—'}</td>
                    <td>
                      <IconButton size="sm" icon="pen" label={`编辑论文：${item.title}`} onClick={() => setPaper({ ...item })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[12px] text-ink-faint m-0 py-4">
              {paperFilter === 'all' ? '点击上方「记录论文」，追踪撰写到发表全流程。' : '该阶段下暂无记录。'}
            </p>
          )}
          <p className="text-[12px] text-ink-faint mt-2 mb-0">
            点击上方 5 格阶段按钮筛选对应论文，再次点击可恢复显示全部。
            {data.publicationBaseline > 0 ? ` 另有 ${data.publicationBaseline} 篇历史发表计入目标。` : ''}
          </p>
        </div>
      </div>

      {(settingsOpen || localSettings) ? (
        <DegreeSettings
          data={data}
          onSave={values => setData(current => ({ ...current, ...values }))}
          onClose={() => { setLocalSettings(false); onCloseSettings(); }}
        />
      ) : null}

      {paper ? (
        <AppDialog open onClose={() => setPaper(null)} className="rw-dialog" aria-labelledby="rw-paper-title">
          <form onSubmit={event => {
            event.preventDefault();
            if (!paper.title.trim()) return;
            const saved = { ...paper, title: paper.title.trim() };
            setData(current => ({
              ...current,
              papers: current.papers.some(item => item.id === saved.id)
                ? current.papers.map(item => item.id === saved.id ? saved : item)
                : [saved, ...current.papers],
            }));
            setPaper(null);
          }}>
            <header>
              <div>
                <h2 id="rw-paper-title">{data.papers.some(item => item.id === paper.id) ? '编辑论文记录' : '记录一篇论文'}</h2>
              </div>
              <IconButton size="sm" icon="x" label="关闭论文记录" onClick={() => setPaper(null)} />
            </header>
            <label>
              论文标题
              <input autoFocus required placeholder="论文的完整标题" value={paper.title} onChange={event => setPaper({ ...paper, title: event.target.value })} />
            </label>
            <label>
              期刊 / 会议
              <input placeholder="例如：MICCAI、Nature Methods" value={paper.venue} onChange={event => setPaper({ ...paper, venue: event.target.value })} />
            </label>
            <div className="rw-form-columns">
              <label>
                年份
                <input type="number" min="1900" max="2200" value={paper.year} onChange={event => setPaper({ ...paper, year: event.target.value })} />
              </label>
              <label>
                作者角色
                <input placeholder="例如：一作、共一、共同作者" value={paper.role} onChange={event => setPaper({ ...paper, role: event.target.value })} />
              </label>
            </div>
            <label>
              当前阶段
              <select value={paper.status} onChange={event => setPaper({ ...paper, status: event.target.value as PaperStatus })}>
                {Object.entries(paperStatuses).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
              </select>
            </label>
            <footer>
              {data.papers.some(item => item.id === paper.id) ? (
                <Button
                  variant="danger"
                  size="sm"
                  className="rw-danger"
                  onClick={() => { setData(current => ({ ...current, papers: current.papers.filter(item => item.id !== paper.id) })); setPaper(null); }}
                >
                  删除记录
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => setPaper(null)}>取消</Button>
              <Button type="submit" variant="primary" size="sm">保存记录</Button>
            </footer>
          </form>
        </AppDialog>
      ) : null}

      {editingRequirement ? (
        <AppDialog open onClose={() => setEditingRequirement(null)} className="rw-dialog" aria-labelledby="rw-requirement-title">
          <form onSubmit={event => {
            event.preventDefault();
            if (!editingRequirement.title.trim()) return;
            setData(current => ({
              ...current,
              requirementItems: current.requirementItems.map(item => item.id === editingRequirement.id ? { ...editingRequirement, title: editingRequirement.title.trim() } : item),
            }));
            setEditingRequirement(null);
          }}>
            <header>
              <h2 id="rw-requirement-title">编辑毕业要求</h2>
              <IconButton size="sm" icon="x" label="关闭毕业要求编辑" onClick={() => setEditingRequirement(null)} />
            </header>
            <label>
              要求内容
              <input autoFocus required value={editingRequirement.title} onChange={event => setEditingRequirement({ ...editingRequirement, title: event.target.value })} />
            </label>
            <label>
              截止日期
              <input type="date" value={editingRequirement.due} onChange={event => setEditingRequirement({ ...editingRequirement, due: event.target.value })} />
            </label>
            <footer>
              <Button
                variant="danger"
                size="sm"
                className="rw-danger"
                onClick={() => { setData(current => ({ ...current, requirementItems: current.requirementItems.filter(item => item.id !== editingRequirement.id) })); setEditingRequirement(null); }}
              >
                删除要求
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditingRequirement(null)}>取消</Button>
              <Button type="submit" variant="primary" size="sm">保存修改</Button>
            </footer>
          </form>
        </AppDialog>
      ) : null}
    </div>
  );
}
