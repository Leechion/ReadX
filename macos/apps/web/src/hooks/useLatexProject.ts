import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LatexFileOp, LatexNode, LatexProject } from '@cbct/shared';
import { api, ApiError } from '../api/client';
import type { LatexCompletionIndex } from '../lib/latex/latexCompletion';

export interface OpenFile {
  path: string;
  content: string;
  /** 载入时的内容指纹：保存时带回服务端，用于拒绝覆盖外部改动。 */
  revision: string;
  saving: boolean;
  dirty: boolean;
  error: string;
  /** 服务端说「文件已被外部修改」：界面据此提供「重新加载」。 */
  conflict: boolean;
}

const AUTOSAVE_DELAY = 900;

/**
 * 一个打开的 LaTeX 项目的状态机。
 *
 * 三条刻意的设计：
 *   - **源码以服务端文件为准**：这里只缓存正在编辑的内容与 revision，不另立权威副本；
 *   - **保存带 revision**：409 时不覆盖，而是标成冲突并把选择权交给用户；
 *   - **自动保存只在内容真的变了时触发**，且切文件/编译前立刻 flush，
 *     避免「刚敲的字没落盘就去编译」。
 */
export function useLatexProject(projectId: string | null) {
  const [project, setProject] = useState<LatexProject | null>(null);
  const [nodes, setNodes] = useState<LatexNode[]>([]);
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  /** 项目索引：补全用的键，以及「用了但没定义」的键（编辑器据此标波浪线）。 */
  const [index, setIndex] = useState<LatexCompletionIndex & { missingCitations?: string[]; missingLabels?: string[] }>({
    citations: [],
    labels: [],
    missingCitations: [],
    missingLabels: [],
  });
  const timers = useRef(new Map<string, number>());
  // 同一个文件共用一个保存任务，避免自动保存与手动保存使用相同的旧 revision。
  const pendingSaves = useRef(new Map<string, Promise<boolean>>());
  /**
   * 同步维护最新缓冲区：防抖回调和同一任务的下一趟保存不等待 React 重渲染，
   * 也能读到当前内容及刚刚写入的 revision。
   */
  const filesRef = useRef<OpenFile[]>([]);
  const updateFiles = useCallback((mutate: (current: OpenFile[]) => OpenFile[]) => {
    filesRef.current = mutate(filesRef.current);
    setFiles(filesRef.current);
  }, []);

  const refreshTree = useCallback(async () => {
    if (!projectId) return;
    const tree = await api.latexTree(projectId);
    setNodes(tree.nodes);
  }, [projectId]);

  /** 重新扫描项目里的引用键与标签。改名、导入、保存 .bib/.tex 之后都要刷。 */
  const refreshIndex = useCallback(async () => {
    if (!projectId) return;
    try {
      setIndex(await api.latexIndex(projectId));
    } catch {
      // 索引只是补全与提示的辅助：失败不该打断写作，静默保留上一次结果。
    }
  }, [projectId]);

  const reload = useCallback(async () => {
    if (!projectId) {
      setProject(null);
      setNodes([]);
      updateFiles(() => []);
      setActivePath(null);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [detail, tree] = await Promise.all([api.latexProject(projectId), api.latexTree(projectId)]);
      setProject(detail);
      setNodes(tree.nodes);
      await refreshIndex();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId, refreshIndex, updateFiles]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 关掉项目时清掉挂起的自动保存计时器，避免离开后还在往服务端写。
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, [projectId]);

  const setFile = useCallback((path: string, mutate: (file: OpenFile) => OpenFile) => {
    updateFiles((current) => current.map((file) => (file.path === path ? mutate(file) : file)));
  }, [updateFiles]);

  const saveFile = useCallback(
    async function persist(path: string, overwrite = false): Promise<boolean> {
      if (!projectId) return false;
      const pending = pendingSaves.current.get(path);
      if (pending) {
        const saved = await pending;
        return overwrite ? persist(path, true) : saved;
      }
      const timer = timers.current.get(path);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.current.delete(path);

      const task = (async () => {
        let replaceRevision = overwrite;
        for (;;) {
          const target = filesRef.current.find((file) => file.path === path);
          if (!target || !target.dirty) return true;
          setFile(path, (file) => ({ ...file, saving: true, error: '' }));
          try {
            const revision = replaceRevision ? (await api.latexFile(projectId, path)).revision : target.revision;
            const result = await api.latexSaveFile(projectId, path, target.content, revision);
            replaceRevision = false;
            setFile(path, (file) => ({
              ...file,
              saving: false,
              dirty: file.content !== target.content,
              revision: result.revision,
              conflict: false,
              error: '',
            }));
            if (/\.(bib|tex)$/i.test(path)) void refreshIndex();
            // 保存期间又输入了内容时，用刚返回的新 revision 接着保存。
          } catch (cause) {
            const conflict = cause instanceof ApiError && cause.status === 409;
            setFile(path, (file) => ({
              ...file,
              saving: false,
              conflict,
              error: conflict
                ? '磁盘上的文件已被其它程序改动，未覆盖。请选择「重新加载」或「以我的版本强制保存」。'
                : cause instanceof Error ? cause.message : String(cause),
            }));
            return false;
          }
        }
      })();
      pendingSaves.current.set(path, task);
      try {
        return await task;
      } finally {
        if (pendingSaves.current.get(path) === task) pendingSaves.current.delete(path);
      }
    },
    [projectId, refreshIndex, setFile],
  );

  /** 把所有脏文件落盘（切项目、编译前调用）。 */
  const flushAll = useCallback(async (): Promise<boolean> => {
    const dirty = filesRef.current.filter((file) => file.dirty || file.saving);
    for (const file of dirty) {
      if (!(await saveFile(file.path))) {
        setActivePath(file.path);
        setError(`「${file.path}」尚未保存，请先处理保存错误。`);
        return false;
      }
    }
    return filesRef.current.every((file) => !file.dirty && !file.saving);
  }, [saveFile]);

  const openFile = useCallback(
    async (path: string): Promise<boolean> => {
      if (!projectId) return false;
      setActivePath(path);
      if (filesRef.current.some((file) => file.path === path)) return true;
      try {
        const content = await api.latexFile(projectId, path);
        updateFiles((current) =>
          current.some((file) => file.path === path)
            ? current
            : [
                ...current,
                {
                  path,
                  content: content.content,
                  revision: content.revision,
                  saving: false,
                  dirty: false,
                  error: '',
                  conflict: false,
                },
              ],
        );
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
    },
    [projectId, updateFiles],
  );

  const closeFile = useCallback(
    async (path: string) => {
      if (!(await saveFile(path))) return false;
      updateFiles((current) => current.filter((file) => file.path !== path));
      setActivePath((current) => {
        if (current !== path) return current;
        const remaining = filesRef.current.filter((file) => file.path !== path);
        const last = remaining[remaining.length - 1];
        return last ? last.path : null;
      });
      return true;
    },
    [saveFile, updateFiles],
  );

  const scheduleSave = useCallback((path: string) => {
    const existing = timers.current.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    timers.current.set(path, window.setTimeout(() => {
      timers.current.delete(path);
      void saveFile(path);
    }, AUTOSAVE_DELAY));
  }, [saveFile]);

  const updateContent = useCallback(
    (path: string, content: string) => {
      setFile(path, (file) => ({ ...file, content, dirty: true, error: '' }));
      scheduleSave(path);
    },
    [scheduleSave, setFile],
  );

  /** Check the live buffer after asynchronous snapshot creation. */
  const replaceContentIfUnchanged = useCallback((path: string, original: string, content: string) => {
    const file = filesRef.current.find((candidate) => candidate.path === path);
    if (!file || file.content !== original) return false;
    updateContent(path, content);
    return true;
  }, [updateContent]);

  const applyAIEdit = useCallback(async (
    proposal: { filePath: string; original: string; content: string },
    signal?: AbortSignal,
  ): Promise<string> => {
    if (!projectId) return '项目已关闭，未保存修改。';
    signal?.throwIfAborted();
    let createdNew = false;
    if (!(await openFile(proposal.filePath))) {
      if (proposal.original) return '无法打开目标文件，未保存修改。';
      try {
        await api.latexCreateSnapshot(projectId, `AI 新建前：${proposal.filePath}`);
        await api.latexFileOp(projectId, { op: 'new-file', to: proposal.filePath });
        await refreshTree();
        createdNew = true;
      } catch (cause) {
        return cause instanceof Error ? `新建文件失败：${cause.message}` : '新建文件失败。';
      }
      if (!(await openFile(proposal.filePath))) return '无法打开目标文件，未保存修改。';
    }
    const current = filesRef.current.find((file) => file.path === proposal.filePath);
    if (current?.content !== proposal.original) {
      return '源码在 AI 生成期间发生了变化，未应用修改。请重新发送修改要求。';
    }
    if (!createdNew) {
      signal?.throwIfAborted();
      try {
        await api.latexCreateSnapshot(projectId, `AI 修改前：${proposal.filePath}`);
      } catch (cause) {
        return cause instanceof Error ? `创建修改前快照失败，未保存文件：${cause.message}` : '创建修改前快照失败，未保存文件。';
      }
    }
    signal?.throwIfAborted();
    if (!replaceContentIfUnchanged(proposal.filePath, proposal.original, proposal.content)) {
      return '源码在创建快照期间发生了变化，未应用修改。请重新发送修改要求。';
    }
    return await saveFile(proposal.filePath)
      ? `已应用并保存：${proposal.filePath}`
      : '保存失败；修改前快照已保留。请处理编辑器中的保存提示。';
  }, [openFile, projectId, refreshTree, replaceContentIfUnchanged, saveFile]);

  /** 冲突时用户的第二种选择：以本地内容覆盖远端（重新取 revision 后再写）。 */
  const forceSave = useCallback(
    (path: string) => saveFile(path, true),
    [saveFile],
  );

  /** 冲突时重新加载磁盘版本（丢弃本地改动前会先确认）。 */
  const reloadFile = useCallback(
    async (path: string) => {
      if (!projectId) return;
      try {
        const latest = await api.latexFile(projectId, path);
        setFile(path, (file) => ({
          ...file,
          content: latest.content,
          revision: latest.revision,
          dirty: false,
          conflict: false,
          error: '',
        }));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [projectId, setFile],
  );

  const applyOp = useCallback(
    async (op: LatexFileOp) => {
      if (!projectId) return false;
      if (!(await flushAll())) return false;
      try {
        await api.latexFileOp(projectId, op);
        // 重命名/移动会改变路径：把打开的文件按新路径重挂，避免编辑一个不存在的文件。
        if ((op.op === 'rename' || op.op === 'move') && op.from && op.to) {
          const from = op.from;
          const to = op.to;
          for (const [path, timer] of timers.current) {
            if (path === from || path.startsWith(`${from}/`)) {
              window.clearTimeout(timer);
              timers.current.delete(path);
            }
          }
          updateFiles((current) =>
            current.map((file) =>
              file.path === from || file.path.startsWith(`${from}/`)
                ? { ...file, path: to + file.path.slice(from.length) }
                : file,
            ),
          );
          setActivePath((current) => current && (current === from || current.startsWith(`${from}/`))
            ? to + current.slice(from.length) : current);
          for (const file of filesRef.current) {
            if (file.dirty && (file.path === to || file.path.startsWith(`${to}/`))) scheduleSave(file.path);
          }
          const detail = await api.latexProject(projectId);
          setProject(detail);
        }
        await refreshTree();
        await refreshIndex();
        setStatus(`已${op.op === 'copy' ? '复制' : op.op === 'rename' ? '重命名' : '完成'}：${op.to}`);
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
    },
    [projectId, flushAll, refreshIndex, refreshTree, scheduleSave, updateFiles],
  );

  const removeFile = useCallback(
    async (path: string) => {
      if (!projectId) return false;
      try {
        await api.latexDeleteFile(projectId, path);
        updateFiles((current) => current.filter((file) => !(file.path === path || file.path.startsWith(`${path}/`))));
        setActivePath((current) => (current && (current === path || current.startsWith(`${path}/`)) ? null : current));
        await refreshTree();
        await refreshIndex();
        setStatus(`已删除：${path}`);
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
    },
    [projectId, refreshIndex, refreshTree, updateFiles],
  );

  const active = useMemo(
    () => files.find((file) => file.path === activePath) ?? null,
    [activePath, files],
  );

  return {
    project,
    nodes,
    files,
    index,
    refreshIndex,
    active,
    activePath,
    status,
    error,
    loading,
    setStatus,
    setError,
    setActivePath,
    setProject,
    reload,
    refreshTree,
    openFile,
    closeFile,
    updateContent,
    applyAIEdit,
    saveFile,
    forceSave,
    reloadFile,
    flushAll,
    applyOp,
    removeFile,
  };
}
