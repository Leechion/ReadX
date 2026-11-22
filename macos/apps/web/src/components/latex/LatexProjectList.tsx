import { useCallback, useEffect, useState } from 'react';
import type { LatexEngine, LatexProject } from '@cbct/shared';
import { LATEX_ENGINES } from '@cbct/shared';
import { api } from '../../api/client';
import { WorkspaceIcon } from '../WorkspaceIcon';

/**
 * 项目列表：新建 / 从 ZIP 新建 / 删除。
 *
 * 「从 ZIP 新建」刻意做成两步（先建项目再导入）：项目目录与索引先立起来，
 * 导入失败时用户看到的是一个空项目 + 具体错误，而不是「什么都没发生」。
 */
export function LatexProjectList({ onOpen }: { onOpen: (project: LatexProject) => void }) {
  const [projects, setProjects] = useState<LatexProject[]>([]);
  const [title, setTitle] = useState('');
  const [engine, setEngine] = useState<LatexEngine>('pdflatex');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.latexProjects();
      setProjects(result.projects);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(
    async (file?: File) => {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        const project = await api.latexCreateProject({
          title: title.trim() || (file ? file.name.replace(/\.zip$/i, '') : '未命名项目'),
          engine,
        });
        if (file) {
          const report = await api.latexImportZip(project.id, file);
          setNotice(
            `已导入 ${report.files} 个文件，根文档：${report.mainFile}` +
              (report.skipped.length ? `；跳过 ${report.skipped.length} 项（${report.skipped.slice(0, 3).join('、')}${report.skipped.length > 3 ? ' 等' : ''}）` : ''),
          );
        }
        setTitle('');
        await load();
        onOpen(project);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        await load();
      } finally {
        setBusy(false);
      }
    },
    [engine, load, onOpen, title],
  );

  return (
    <section className="latex-project-list">
      <header className="latex-list-head">
        <div>
          <h1>LaTeX Studio</h1>
        </div>
      </header>

      <div className="latex-create-bar">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="新项目名称（留空则用 ZIP 文件名）"
          aria-label="新项目名称"
        />
        <select value={engine} onChange={(event) => setEngine(event.target.value as LatexEngine)} aria-label="编译引擎">
          {LATEX_ENGINES.map((item) => (
            <option key={item.id} value={item.id} title={item.hint}>
              {item.label}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy} onClick={() => void create()}>
          新建空白项目
        </button>
        <label className={`latex-upload${busy ? ' busy' : ''}`}>
          导入 Overleaf ZIP
          <input
            type="file"
            accept=".zip,application/zip"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void create(file);
            }}
          />
        </label>
      </div>

      {error ? <p className="latex-alert error">{error}</p> : null}
      {notice ? <p className="latex-alert ok">{notice}</p> : null}
      {busy ? <p className="latex-alert">正在处理…导入大项目需要一点时间。</p> : null}

      {projects.length === 0 ? (
        <div className="latex-empty">
          <h2>暂无项目</h2>
          <p>新建空白项目或导入 Overleaf ZIP。</p>
        </div>
      ) : (
        <ul className="latex-projects">
          {projects.map((project) => (
            <li key={project.id}>
              <div className="latex-project-card">
                <button type="button" className="latex-project-open" onClick={() => onOpen(project)}>
                  <strong title={project.title}>{project.title}</strong>
                  <span className="latex-project-meta">
                    {LATEX_ENGINES.find((item) => item.id === project.engine)?.label ?? project.engine}
                    {' · '}
                    根文档 {project.mainFile}
                    {project.autoCompile ? ' · 自动编译' : ''}
                  </span>
                </button>
                <time className="latex-project-time" dateTime={project.updatedAt}>
                  上次编辑 {new Date(project.updatedAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </time>
                <div className="latex-project-actions">
                  <button
                    type="button"
                    className="latex-project-icon"
                    data-tooltip="下载项目源码 ZIP"
                    title="下载项目源码 ZIP"
                    aria-label="下载项目源码 ZIP"
                    disabled={!!actionBusy || busy}
                    onClick={async () => {
                      setActionBusy(`download:${project.id}`);
                      setError('');
                      try {
                        const filename = await api.latexExportZip(project.id);
                        setNotice(`已下载 ${filename}`);
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : String(cause));
                      } finally {
                        setActionBusy(null);
                      }
                    }}
                  >
                    <WorkspaceIcon name="download" size={17} />
                  </button>
                  <button
                    type="button"
                    className="latex-project-icon"
                    data-tooltip="复制项目"
                    title="复制项目"
                    aria-label="复制项目"
                    disabled={!!actionBusy || busy}
                    onClick={async () => {
                      setActionBusy(`copy:${project.id}`);
                      setError('');
                      setNotice('');
                      try {
                        const copy = await api.latexDuplicateProject(project.id);
                        await load();
                        setNotice(`已复制为“${copy.title}”`);
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : String(cause));
                      } finally {
                        setActionBusy(null);
                      }
                    }}
                  >
                    <WorkspaceIcon name="copy" size={17} />
                  </button>
                  <button
                    type="button"
                    className="latex-project-icon danger"
                    data-tooltip="删除项目"
                    title="删除项目"
                    aria-label="删除项目"
                    disabled={!!actionBusy || busy}
                    onClick={() => setPendingDelete(project.id)}
                  >
                    <WorkspaceIcon name="trash" size={17} />
                  </button>
                </div>
              </div>
              {pendingDelete === project.id ? (
                <div className="latex-project-confirm">
                  <span>删除项目会连同它磁盘上的源码一起删掉。</span>
                  <button
                    type="button"
                    className="danger"
                    disabled={!!actionBusy}
                    onClick={async () => {
                      setActionBusy(`delete:${project.id}`);
                      try {
                        await api.latexDeleteProject(project.id);
                        setPendingDelete(null);
                        await load();
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : String(cause));
                      } finally {
                        setActionBusy(null);
                      }
                    }}
                  >
                    确认删除
                  </button>
                  <button type="button" onClick={() => setPendingDelete(null)}>
                    取消
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
