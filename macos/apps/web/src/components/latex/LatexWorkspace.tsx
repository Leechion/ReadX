import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { DocumentSummary, LatexAutoFixResult, LatexCiteLibraryResult, LatexDiagnostic, LatexEngine, LatexProject, LatexSnapshot, SyncTeXBox } from '@cbct/shared';
import { api, streamLatexAutoFix } from '../../api/client';
import { useLatexBuild } from '../../hooks/useLatexBuild';
import { useLatexProject } from '../../hooks/useLatexProject';
import { useLatexRealtime } from '../../hooks/useLatexRealtime';
import { LatexBuildPanel } from './LatexBuildPanel';
import { LatexAIAssistant } from './LatexAIAssistant';
import { LatexAssetPreview } from './LatexAssetPreview';
import { LatexCiteDialog } from './LatexCiteDialog';
import { LatexEditor } from './LatexEditor';
import { LatexFileTree } from './LatexFileTree';
import { LatexGitDialog } from './LatexGitDialog';
import { LatexPdfPreview } from './LatexPdfPreview';
import { LatexToolbar } from './LatexToolbar';
import { LatexRealtimePreview } from './LatexRealtimePreview';
import { STORAGE_KEYS } from '../../lib/storage';

/**
 * 打开的项目：左文件树 / 中多 Tab 编辑器 / 右编译产物与诊断。
 *
 * 编译流程刻意固定为「先把改动落盘 → 再编译」：否则用户刚敲的字不会出现在 PDF 里，
 * 而他会以为编译坏了（脏文件不落盘是最容易发生也最难自查的一类问题）。
 * 自动编译按「已保存内容的指纹」触发，编译本身不会改变指纹，因此不会自激。
 */
export function LatexWorkspace({
  project,
  documents = [],
  onClose,
  onProjectChange,
  registerBeforeLeave,
}: {
  project: LatexProject;
  documents?: DocumentSummary[];
  onClose: () => void;
  onProjectChange: (project: LatexProject) => void;
  registerBeforeLeave?: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const state = useLatexProject(project.id);
  const compiler = useLatexBuild(project.id);
  const [realtimeEnabled, setRealtimeEnabled] = useState(false);
  const realtime = useLatexRealtime(project.id, (state.project ?? project).mainFile,
    (state.project ?? project).engine, realtimeEnabled, state.files);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ path: string; line: number; nonce: number } | null>(null);
  const [citeDialogOpen, setCiteDialogOpen] = useState(false);
  const [gitDialogOpen, setGitDialogOpen] = useState(false);
  const [pendingCiteInsert, setPendingCiteInsert] = useState<{ keys: string[]; nonce: number } | null>(null);
  const [syncTarget, setSyncTarget] = useState<{ page: number; boxes: SyncTeXBox[]; nonce: number } | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [activeAssetPath, setActiveAssetPath] = useState<string | null>(null);
  const [assetPreview, setAssetPreview] = useState<{ path: string; url: string; contentType: string; size: number } | null>(null);
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetError, setAssetError] = useState('');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [paneWeights, setPaneWeights] = useState<[number, number, number]>([0.5, 0.5, 0]);
  const [treeWidth, setTreeWidth] = useState(() => {
    if (typeof window === 'undefined') return 250;
    const saved = Number(window.localStorage.getItem(STORAGE_KEYS.latexTreeWidth));
    return Number.isFinite(saved) && saved >= 180 ? Math.min(saved, 900) : 250;
  });
  const panesRef = useRef<HTMLDivElement>(null);
  const resizeGesture = useRef<{ divider: 0 | 1; startX: number; weights: [number, number, number] } | null>(null);
  const treeResizeGesture = useRef<{ startX: number; startWidth: number } | null>(null);
  const assetRequest = useRef(0);
  const lastCompiledSignature = useRef('');
  const assetUrl = assetPreview?.url;

  useEffect(() => () => { if (assetUrl) URL.revokeObjectURL(assetUrl); }, [assetUrl]);
  useEffect(() => () => { assetRequest.current += 1; }, []);

  const setAssistantVisibility = useCallback((open: boolean) => {
    setAssistantOpen(open);
    setPaneWeights((weights) => {
      if (open) {
        if (weights[2] > 0) return weights;
        const editorPdfTotal = weights[0] + weights[1] || 1;
        return [weights[0] / editorPdfTotal * 0.72, weights[1] / editorPdfTotal * 0.72, 0.28];
      }
      const editorPdfTotal = weights[0] + weights[1] || 1;
      return [weights[0] / editorPdfTotal, weights[1] / editorPdfTotal, 0];
    });
  }, []);

  const resizePanes = useCallback((event: PointerEvent) => {
    const treeGesture = treeResizeGesture.current;
    if (treeGesture) {
      const nextWidth = Math.max(180, Math.min(900, treeGesture.startWidth + event.clientX - treeGesture.startX));
      setTreeWidth(nextWidth);
      return;
    }
    const gesture = resizeGesture.current;
    if (!gesture || !panesRef.current) return;
    const bounds = panesRef.current.getBoundingClientRect();
    const contentWidth = Math.max(bounds.width, panesRef.current.scrollWidth);
    const fixedWidth = treeWidth + 6 * (assistantOpen ? 2 : 1) + 260 + 300 + (assistantOpen ? 320 : 0);
    const flexibleWidth = Math.max(1, contentWidth - fixedWidth);
    const left = gesture.divider;
    const pairTotal = gesture.weights[left]! + gesture.weights[left + 1]!;
    const delta = (event.clientX - gesture.startX) / flexibleWidth;
    const nextLeft = Math.max(0, Math.min(pairTotal, gesture.weights[left]! + delta));
    setPaneWeights((weights) => {
      const next: [number, number, number] = [...weights];
      next[left] = nextLeft;
      next[left + 1] = pairTotal - nextLeft;
      return next;
    });
  }, [assistantOpen, treeWidth]);

  const stopResize = useCallback(() => {
    if (treeResizeGesture.current) {
      treeResizeGesture.current = null;
      window.localStorage.setItem(STORAGE_KEYS.latexTreeWidth, String(treeWidth));
    }
    resizeGesture.current = null;
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  }, [treeWidth]);

  useEffect(() => {
    window.addEventListener('pointermove', resizePanes);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
    return () => {
      window.removeEventListener('pointermove', resizePanes);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
      stopResize();
    };
  }, [resizePanes, stopResize]);

  const beginResize = (divider: 0 | 1, event: ReactPointerEvent<HTMLDivElement>) => {
    resizeGesture.current = { divider, startX: event.clientX, weights: [...paneWeights] };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const beginTreeResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    treeResizeGesture.current = { startX: event.clientX, startWidth: treeWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const nudgeDivider = (divider: 0 | 1, direction: -1 | 1) => {
    setPaneWeights((weights) => {
      const next: [number, number, number] = [...weights];
      const pairTotal = weights[divider]! + weights[divider + 1]!;
      const bounds = panesRef.current?.getBoundingClientRect();
      const contentWidth = Math.max(bounds?.width ?? 1200, panesRef.current?.scrollWidth ?? 0);
      const fixedWidth = treeWidth + 6 * (assistantOpen ? 2 : 1) + 260 + 300 + (assistantOpen ? 320 : 0);
      const flexibleWidth = Math.max(1, contentWidth - fixedWidth);
      const step = Math.min(pairTotal / 2, 18 / flexibleWidth);
      next[divider] = Math.max(0, Math.min(pairTotal, weights[divider]! + direction * step));
      next[divider + 1] = pairTotal - next[divider];
      return next;
    });
  };

  const patch = useCallback(
    async (next: { title?: string; mainFile?: string; engine?: LatexEngine; autoCompile?: boolean; aiAutoFix?: boolean }) => {
      try {
        const updated = await api.latexUpdateProject(project.id, next);
        state.setProject(updated);
        onProjectChange(updated);
      } catch (cause) {
        state.setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [onProjectChange, project.id, state],
  );

  const dirtyCount = state.files.filter((file) => file.dirty).length;

  useEffect(() => {
    registerBeforeLeave?.(state.flushAll);
    return () => registerBeforeLeave?.(null);
  }, [registerBeforeLeave, state.flushAll]);

  const compile = useCallback(async () => {
    // 先把所有改动落盘：编译的是磁盘上的源码，不是编辑器里的草稿。
    if (!(await state.flushAll())) return;
    await compiler.start();
  }, [compiler, state]);

  // ---- AI 直接写盘 + 源码快照 ----
  const [snapshots, setSnapshots] = useState<LatexSnapshot[]>([]);
  const [autoFixRunning, setAutoFixRunning] = useState(false);
  const [autoFixStages, setAutoFixStages] = useState<string[]>([]);
  const [autoFixResult, setAutoFixResult] = useState<LatexAutoFixResult | null>(null);
  const [autoFixError, setAutoFixError] = useState('');

  const refreshSnapshots = useCallback(async () => {
    try {
      const result = await api.latexSnapshots(project.id);
      setSnapshots(result.snapshots);
    } catch {
      // 快照列表只是辅助信息：拉不到不该打断写作。
    }
  }, [project.id]);

  const applyAIFix = useCallback(async (proposal: { filePath: string; original: string; content: string }, signal?: AbortSignal) => {
    const notice = await state.applyAIEdit(proposal, signal);
    void refreshSnapshots();
    void state.refreshTree();
    void state.refreshIndex();
    return notice;
  }, [refreshSnapshots, state]);

  useEffect(() => {
    void refreshSnapshots();
  }, [refreshSnapshots]);

  /**
   * 跑一次「AI 直接写盘」。
   *
   * 关键在写盘之后：服务端改了磁盘上的文件，编辑器里还留着旧内容
   * （下次保存就会撞 revision 冲突），所以这里必须重新载入受影响的文件、
   * 刷新编译历史与快照列表——否则界面会显示一份已经不存在的稿子。
   */
  const runAutoFix = useCallback(
    async (question: string) => {
      // 面板上显示的就是「要修哪个文件」，这里必须用同一套回退规则（打开的文件 → 根文档），
      // 否则会出现「按钮上写着 broken.tex，点了却说先打开文件」的自相矛盾。
      const target = state.activePath ?? (state.project ?? project).mainFile;
      if (!target) {
        setAutoFixError('这个项目还没有根文档：请先在工具栏指定。');
        return;
      }
      // 先把自己的改动落盘：AI 读到的是磁盘内容，编辑器里的草稿不算数。
      if (!(await state.flushAll())) {
        setAutoFixError('有文件没能保存，已中止：请先处理保存冲突。');
        return;
      }
      setAutoFixRunning(true);
      setAutoFixError('');
      setAutoFixStages([]);
      setAutoFixResult(null);
      try {
        await streamLatexAutoFix(
          { projectId: project.id, projectTitle: (state.project ?? project).title, filePath: target, question },
          (event) => {
            if (event.error) {
              setAutoFixError(event.error);
              return;
            }
            if (event.stage && event.detail) {
              setAutoFixStages((current) => [...current, event.detail!]);
              return;
            }
            if (event.done && event.result) {
              setAutoFixResult(event.result);
              if (event.result.outcome === 'kept') {
                setAutoFixStages((current) => [...current, '已保留修改']);
              } else {
                setAutoFixStages((current) => [...current, '已自动回滚']);
              }
            }
          },
        );
      } catch (cause) {
        setAutoFixError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setAutoFixRunning(false);
        // 无论保留还是回滚，磁盘都可能已经变了：把编辑器与状态拉回真实情况。
        await state.reloadFile(target).catch(() => undefined);
        await state.refreshTree().catch(() => undefined);
        await compiler.reloadHistory();
        await refreshSnapshots();
      }
    },
    [compiler, project, refreshSnapshots, state],
  );

  const rollbackSnapshot = useCallback(
    async (snapshotId: string) => {
      setAutoFixError('');
      try {
        const report = await api.latexRestoreSnapshot(snapshotId);
        // 回滚后打开的每个文件都可能已经不是编辑器里那份：全部重新载入。
        for (const file of state.files) {
          await state.reloadFile(file.path).catch(() => undefined);
        }
        await state.refreshTree();
        await state.refreshIndex();
        await compiler.reloadHistory();
        await refreshSnapshots();
        setAutoFixResult(null);
        state.setStatus(
          `已回滚 ${report.restored} 个文件` +
            (report.removedFiles.length ? `，移除 ${report.removedFiles.length} 项新增内容` : ''),
        );
      } catch (cause) {
        setAutoFixError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [compiler, refreshSnapshots, state],
  );

  // 自动编译：内容已保存且与上次编译不同时触发一次。
  const savedSignature = useMemo(
    () => state.files.map((file) => `${file.path}:${file.revision}`).sort().join('|'),
    [state.files],
  );
  useEffect(() => {
    const current = state.project ?? project;
    if (!current.autoCompile || realtimeEnabled) return;
    if (!savedSignature || savedSignature === lastCompiledSignature.current) return;
    if (compiler.running || dirtyCount > 0) return;
    lastCompiledSignature.current = savedSignature;
    void compiler.start();
  }, [compiler, dirtyCount, project, savedSignature, state.project, realtimeEnabled]);

  // 成功编译后把指纹记下来，避免刚编译完又被自动编译触发一次。
  useEffect(() => {
    if (compiler.build?.status === 'succeeded') lastCompiledSignature.current = savedSignature;
  }, [compiler.build?.status, savedSignature]);

  const importZip = useCallback(
    async (file: File) => {
      setBusy(true);
      try {
        if (!(await state.flushAll())) return;
        const report = await api.latexImportZip(project.id, file);
        await state.refreshTree();
        await state.refreshIndex();
        await state.reload();
        state.setStatus(
          `已导入 ${report.files} 个文件，根文档：${report.mainFile}` +
            (report.skipped.length ? `；跳过 ${report.skipped.length} 项` : ''),
        );
      } catch (cause) {
        state.setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [project.id, state],
  );

  const exportZip = useCallback(async () => {
    setBusy(true);
    try {
      if (!(await state.flushAll())) return;
      const filename = await api.latexExportZip(project.id);
      state.setStatus(`已导出 ${filename}`);
    } catch (cause) {
      state.setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [project.id, state]);

  const openTextFile = useCallback((path: string) => {
    assetRequest.current += 1;
    setActiveAssetPath(null);
    setAssetPreview(null);
    setAssetLoading(false);
    setAssetError('');
    void state.openFile(path);
  }, [state.openFile]);

  const openAsset = useCallback(async (path: string) => {
    const requestId = ++assetRequest.current;
    state.setActivePath(path);
    setActiveAssetPath(path);
    setAssetPreview(null);
    setAssetError('');
    setAssetLoading(true);
    try {
      const blob = await api.latexAsset(project.id, path);
      if (requestId !== assetRequest.current) return;
      const url = URL.createObjectURL(blob);
      setAssetPreview({ path, url, contentType: blob.type || 'application/octet-stream', size: blob.size });
    } catch (cause) {
      if (requestId === assetRequest.current) setAssetError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestId === assetRequest.current) setAssetLoading(false);
    }
  }, [project.id, state.setActivePath]);

  const uploadAssets = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      for (const file of files) await api.latexUploadAsset(project.id, `figures/${file.name}`, file);
      await state.refreshTree();
      state.setStatus(`已上传 ${files.length} 个资源到 figures/`);
      await openAsset(`figures/${files[0]!.name}`);
    } catch (cause) {
      state.setError(cause instanceof Error ? cause.message : String(cause));
      await state.refreshTree();
    } finally {
      setBusy(false);
    }
  }, [openAsset, project.id, state]);

  /** 点诊断：打开对应文件并滚到那一行。 */
  const openDiagnostic = useCallback(
    async (diagnostic: LatexDiagnostic) => {
      if (!diagnostic.file) return;
      await state.openFile(diagnostic.file);
      setReveal({
        path: diagnostic.file,
        line: diagnostic.line && diagnostic.line > 0 ? diagnostic.line : 1,
        nonce: Date.now(),
      });
    },
    [state],
  );

  const showLog = useCallback(async () => {
    if (!compiler.build) return;
    try {
      const result = await api.latexBuildLog(compiler.build.id);
      setLog(result.log);
    } catch (cause) {
      state.setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [compiler.build, state]);

  const current = state.project ?? project;
  const activeBuild = compiler.build;

  const handleLibraryCited = useCallback(
    async (result: LatexCiteLibraryResult) => {
      await state.refreshTree();
      if (state.files.some((file) => file.path === result.bibFile)) {
        await state.reloadFile(result.bibFile).catch(() => undefined);
      }
      await state.refreshIndex();
      setPendingCiteInsert((currentInsert) => ({
        keys: result.keys,
        nonce: (currentInsert?.nonce ?? 0) + 1,
      }));
      const details: string[] = [];
      if (result.inserted.length) details.push(`已写入 ${result.inserted.length} 条到 ${result.bibFile}`);
      if (result.alreadyPresent.length) details.push(`复用既有键 ${result.alreadyPresent.length} 条`);
      state.setStatus(details.join('，') || `已插入 \\cite{${result.keys.join(', ')}}`);
    },
    [state],
  );

  const syncToPdf = useCallback(
    async (path: string, line: number) => {
      if (!activeBuild || !activeBuild.hasPdf) {
        state.setError('请先编译生成 PDF，再使用 SyncTeX 定位。');
        return;
      }
      if (realtimeEnabled) {
        setRealtimeEnabled(false);
      }
      setSyncBusy(true);
      try {
        const result = await api.latexSyncTeXForward(activeBuild.id, path, line);
        setSyncTarget({ page: result.page, boxes: result.boxes, nonce: Date.now() });
        state.setStatus(
          result.exact
            ? `SyncTeX：已定位到 PDF 第 ${result.page} 页`
            : `SyncTeX：当前行无直接排版节点，已就近定位到第 ${result.page} 页（对应第 ${result.line} 行）`,
        );
      } catch (cause) {
        state.setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSyncBusy(false);
      }
    },
    [activeBuild, realtimeEnabled, state],
  );

  const reverseSync = useCallback(
    async (page: number, x: number, y: number) => {
      if (!activeBuild || !activeBuild.hasPdf) return;
      try {
        const location = await api.latexSyncTeXReverse(activeBuild.id, page, x, y);
        await state.openFile(location.file);
        setReveal({ path: location.file, line: location.line, nonce: Date.now() });
        state.setStatus(`SyncTeX：已跳回 ${location.file}:${location.line}`);
      } catch (cause) {
        state.setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [activeBuild, state],
  );

  return (
    <section className="latex-workspace">
      <LatexToolbar
        project={current}
        nodes={state.nodes}
        busy={busy || state.loading}
        dirtyCount={dirtyCount}
        onPatch={(next) => void patch(next)}
        onFlush={() => void state.flushAll()}
        onExportZip={() => void exportZip()}
        onImportZip={(file) => void importZip(file)}
        onToggleAI={() => setAssistantVisibility(!assistantOpen)}
        aiOpen={assistantOpen}
        onBack={() => {
          void state.flushAll().then((saved) => { if (saved) onClose(); });
        }}
        extra={
          <>
            <button type="button" onClick={() => setGitDialogOpen(true)} title="查看 Git 版本状态、提交并同步到远程仓库">
              Git 版本
            </button>
            <button type="button" aria-pressed={realtimeEnabled}
              onClick={() => setRealtimeEnabled(value => !value)}
              title="使用 rtex 和 LuaLaTeX 实时更新编辑中的段落；关闭后查看普通 PDF">
              {realtimeEnabled ? '关闭实时预览' : '实时预览'}
            </button>
            {compiler.running ? (
              <button type="button" onClick={() => void compiler.cancel()} title="停止当前编译">
                停止编译
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={busy || compiler.starting}
                onClick={() => void compile()}
                title="先保存改动，再用本机 TeX 编译当前项目"
              >
                {activeBuild ? '重新编译' : '编译'}
              </button>
            )}
          </>
        }
      />
      {state.error ? (
        <p className="latex-alert error" role="alert">
          {state.error}
          <button type="button" onClick={() => state.setError('')}>
            知道了
          </button>
        </p>
      ) : null}
      {compiler.error ? (
        <p className="latex-alert error" role="alert">
          {compiler.error}
          <button type="button" onClick={() => compiler.setError('')}>
            知道了
          </button>
        </p>
      ) : null}
      {state.status ? (
        <p className="latex-alert ok">
          {state.status}
          <button type="button" onClick={() => state.setStatus('')}>
            知道了
          </button>
        </p>
      ) : null}
      <div
        className="latex-panes"
        ref={panesRef}
        style={{
          gridTemplateColumns: assistantOpen
            ? `${treeWidth}px 6px minmax(260px, ${paneWeights[0]}fr) 6px minmax(300px, ${paneWeights[1]}fr) 6px minmax(320px, ${paneWeights[2]}fr)`
            : `${treeWidth}px 6px minmax(260px, ${paneWeights[0]}fr) 6px minmax(300px, ${paneWeights[1]}fr)`,
        }}
      >
        <aside className="latex-pane-tree">
          <LatexFileTree
            nodes={state.nodes}
            activePath={state.activePath}
            mainFile={current.mainFile}
            busy={busy}
            onOpen={openTextFile}
            onOpenAsset={(path) => void openAsset(path)}
            onUploadAssets={(files) => void uploadAssets(files)}
            onOp={(op) => void state.applyOp(op)}
            onDelete={(path) => void state.removeFile(path)}
            onExportZip={() => void exportZip()}
          />
        </aside>
        <div
          className="latex-pane-resizer"
          role="separator"
          aria-label="调整项目目录宽度"
          aria-orientation="vertical"
          aria-valuenow={Math.round(treeWidth)}
          aria-valuemin={180}
          aria-valuemax={900}
          tabIndex={0}
          onPointerDown={beginTreeResize}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              setTreeWidth((width) => {
                const nextWidth = Math.max(180, Math.min(900, width + (event.key === 'ArrowRight' ? 18 : -18)));
                window.localStorage.setItem(STORAGE_KEYS.latexTreeWidth, String(nextWidth));
                return nextWidth;
              });
            }
          }}
        />
        <div className="latex-pane-editor">
          <div className={`latex-editor-host${activeAssetPath ? ' hidden' : ''}`}>
            <LatexEditor
              files={state.files}
              active={state.active}
              index={state.index}
              reveal={reveal}
              pendingCiteInsert={pendingCiteInsert}
              onActivate={openTextFile}
              onClose={(path) => void state.closeFile(path)}
              onChange={state.updateContent}
              onSave={(path) => void state.saveFile(path)}
              onReload={(path) => void state.reloadFile(path)}
              onForceSave={(path) => void state.forceSave(path)}
              onSyncToPdf={(path, line) => void syncToPdf(path, line)}
              onOpenLibraryCite={() => setCiteDialogOpen(true)}
              syncBusy={syncBusy}
              readOnly={autoFixRunning}
            />
          </div>
          {activeAssetPath ? (
            <LatexAssetPreview
              path={activeAssetPath}
              asset={assetPreview?.path === activeAssetPath ? assetPreview : null}
              loading={assetLoading}
              error={assetError}
            />
          ) : null}
        </div>
        <div
          className="latex-pane-resizer"
          role="separator"
          aria-label="调整 TeX 编辑区和 PDF 预览区宽度"
          aria-orientation="vertical"
          aria-valuenow={Math.round(paneWeights[0] * 100)}
          tabIndex={0}
          onPointerDown={(event) => beginResize(0, event)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              nudgeDivider(0, event.key === 'ArrowLeft' ? -1 : 1);
            }
          }}
        />
        <aside className="latex-pane-preview">
          {realtimeEnabled ? <LatexRealtimePreview realtime={realtime} supported={current.engine === 'lualatex'}
            onSwitchEngine={() => void patch({ engine: 'lualatex' })}
            onDiagnostic={diagnostic => {
              const raw = diagnostic.file?.replaceAll('\\', '/').replace(/^\.\//, '');
              const file = state.nodes.map(node => node.path).sort((a,b) => b.length - a.length)
                .find(path => raw === path || raw?.endsWith(`/${path}`));
              if (file && !file.startsWith('/') && !file.includes(':') && !file.split('/').includes('..')) {
                void state.openFile(file).then(() => setReveal({ path: file, line: diagnostic.line || 1, nonce: Date.now() }));
              }
            }} /> : <>
          <LatexBuildPanel
            toolchains={compiler.toolchains}
            build={activeBuild}
            running={compiler.running}
            starting={compiler.starting}
            onCompile={() => void compile()}
            onCancel={() => void compiler.cancel()}
            onReloadToolchains={() => void compiler.reloadToolchains()}
            onOpenDiagnostic={(diagnostic) => void openDiagnostic(diagnostic)}
            onShowLog={() => void showLog()}
          />
          <LatexPdfPreview
            buildId={activeBuild && activeBuild.hasPdf ? activeBuild.id : null}
            load={api.latexBuildPdf}
            syncTarget={syncTarget}
            onReverseSync={(pageNumber, x, y) => void reverseSync(pageNumber, x, y)}
            onError={(message) => state.setError(message)}
            onDownload={() => {
              if (!activeBuild) return;
              void api.latexDownloadPdf(activeBuild.id, `${current.title || 'document'}.pdf`);
            }}
          />
          </>}
        </aside>
        {assistantOpen ? (
          <>
            <div
              className="latex-pane-resizer"
              role="separator"
              aria-label="调整 PDF 预览区和 AI 助手宽度"
              aria-orientation="vertical"
              aria-valuenow={Math.round(paneWeights[1] * 100)}
              tabIndex={0}
              onPointerDown={(event) => beginResize(1, event)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  nudgeDivider(1, event.key === 'ArrowLeft' ? -1 : 1);
                }
              }}
            />
            <LatexAIAssistant
              projectId={current.id}
              projectTitle={current.title}
              filePath={activeAssetPath ?? state.active?.path ?? current.mainFile}
              source={state.active?.content ?? ''}
              build={activeBuild}
              documents={documents}
              aiAutoFix={current.aiAutoFix}
              autoFixRunning={autoFixRunning}
              autoFixStages={autoFixStages}
              autoFixResult={autoFixResult}
              autoFixError={autoFixError}
              snapshots={snapshots}
              onClose={() => setAssistantVisibility(false)}
              onApplyFix={applyAIFix}
              onAutoFix={(question) => void runAutoFix(question)}
              onRollbackSnapshot={(snapshotId) => void rollbackSnapshot(snapshotId)}
              onRefreshSnapshots={() => void refreshSnapshots()}
              onCompile={() => { if (!compiler.running && !compiler.starting) void compile(); }}
              compiling={compiler.running || compiler.starting}
            />
          </>
        ) : null}
      </div>
      {log !== null ? (
        <div className="latex-log-overlay" role="dialog" aria-label="编译日志">
          <div className="latex-log-box">
            <header>
              <strong>编译日志</strong>
              <button type="button" onClick={() => setLog(null)}>
                关闭
              </button>
            </header>
            <pre>{log || '（日志为空）'}</pre>
          </div>
        </div>
      ) : null}
      <LatexCiteDialog
        open={citeDialogOpen}
        projectId={current.id}
        documents={documents}
        nodes={state.nodes}
        onClose={() => setCiteDialogOpen(false)}
        onInserted={handleLibraryCited}
      />
      {gitDialogOpen ? (
        <LatexGitDialog
          open={gitDialogOpen}
          projectId={current.id}
          projectTitle={current.title}
          onClose={() => setGitDialogOpen(false)}
          onSyncComplete={() => {
            void state.reload();
          }}
        />
      ) : null}
    </section>
  );
}
