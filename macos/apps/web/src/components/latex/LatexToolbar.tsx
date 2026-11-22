import { useEffect, useRef, useState } from 'react';
import type { LatexEngine, LatexNode, LatexProject, LatexToolchainReport } from '@cbct/shared';
import { LATEX_ENGINES } from '@cbct/shared';
import { useConfirm } from '../ConfirmDialog';
import { Icon } from '../ui/Icon';

/**
 * LaTeX 顶部精简工具栏：
 * - 左侧：返回、项目名、保存状态
 * - 右侧：两个深色区分的编译模式切换按钮（实时编译 / 编译）放在外层随时切换 + AI 助手 + 更多配置下拉框
 */
export function LatexToolbar({
  project,
  nodes,
  busy,
  dirtyCount,
  realtimeEnabled,
  compiling,
  starting,
  hasBuild,
  hasPdf,
  toolchains,
  onToggleRealtime,
  onCompile,
  onCancelCompile,
  onPatch,
  onFlush,
  onExportZip,
  onImportZip,
  onOpenGit,
  onDownloadPdf,
  onReloadToolchains,
  onToggleAI,
  aiOpen,
  onBack,
}: {
  project: LatexProject;
  nodes: LatexNode[];
  busy: boolean;
  dirtyCount: number;
  realtimeEnabled: boolean;
  compiling: boolean;
  starting: boolean;
  hasBuild: boolean;
  hasPdf: boolean;
  toolchains: LatexToolchainReport | null;
  onToggleRealtime: (enabled: boolean) => void;
  onCompile: () => void;
  onCancelCompile: () => void;
  onPatch: (patch: { title?: string; mainFile?: string; engine?: LatexEngine; autoCompile?: boolean; aiAutoFix?: boolean }) => void;
  onFlush: () => void;
  onExportZip: () => void;
  onImportZip: (file: File) => void;
  onOpenGit: () => void;
  onDownloadPdf: () => void;
  onReloadToolchains: () => void;
  onToggleAI: () => void;
  aiOpen: boolean;
  onBack: () => void;
}) {
  const texFiles = nodes.filter((node) => node.kind === 'tex');
  const confirmDialog = useConfirm();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  return (
    <header className="latex-toolbar">
      <div className="latex-toolbar-row">
        <button
          type="button"
          className="rx-btn rx-btn-icon rx-btn-ghost"
          onClick={onBack}
          title="回到项目列表"
          aria-label="回到项目列表"
        >
          <Icon name="left" size={14} />
        </button>

        <input
          className="latex-title-input"
          value={project.title}
          onChange={(event) => onPatch({ title: event.target.value })}
          aria-label="项目名"
        />

        <span className={`latex-save-pill${dirtyCount ? ' dirty' : ''}`}>
          {busy ? '处理中…' : dirtyCount ? `未保存 (${dirtyCount}) · Ctrl S` : '已保存'}
        </span>

        <div className="latex-toolbar-spacer" />

        {/* 两种编译模式：深色、不同色系、外置随时切换 */}
        <div className="latex-mode-group" role="group" aria-label="编译模式切换">
          <button
            type="button"
            className={`latex-mode-btn mode-realtime${realtimeEnabled ? ' active' : ''}`}
            aria-pressed={realtimeEnabled}
            onClick={() => onToggleRealtime(true)}
            title="使用 rtex + LuaLaTeX 实时预览编辑段落"
          >
            <span className="latex-mode-dot" aria-hidden="true" />
            <span>实时编译</span>
          </button>

          {compiling ? (
            <button
              type="button"
              className="latex-mode-btn mode-stop active"
              onClick={onCancelCompile}
              title="停止当前编译"
            >
              <span className="latex-mode-dot" aria-hidden="true" />
              <span>停止编译</span>
            </button>
          ) : (
            <button
              type="button"
              className={`latex-mode-btn mode-compile${!realtimeEnabled ? ' active' : ''}`}
              disabled={busy || starting}
              onClick={() => {
                if (realtimeEnabled) onToggleRealtime(false);
                onCompile();
              }}
              title="先保存改动，再用本机 TeX 引擎完整编译"
            >
              <span className="latex-mode-dot" aria-hidden="true" />
              <span>{hasBuild && !realtimeEnabled ? '重新编译' : '编译'}</span>
            </button>
          )}
        </div>

        <button
          type="button"
          className={`latex-ai-toggle-btn${aiOpen ? ' active' : ''}`}
          aria-expanded={aiOpen}
          onClick={onToggleAI}
          title="打开或收起 LaTeX AI 助手"
        >
          <Icon name="chat" size={13} />
          <span>AI 助手</span>
        </button>

        {/* 更多项目配置与操作收进下拉菜单 */}
        <div className="latex-more-wrap" ref={menuRef}>
          <button
            type="button"
            className="latex-more-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((prev) => !prev)}
            title="项目配置与导入导出"
          >
            <Icon name="sliders" size={13} />
            <span>项目与工具</span>
            <Icon name="down" size={12} />
          </button>

          {menuOpen ? (
            <div className="latex-dropdown" role="menu" aria-label="项目与工具菜单">
              <div className="latex-dropdown-sec">
                <label className="latex-dropdown-field">
                  <span>根文档</span>
                  <select value={project.mainFile} onChange={(event) => onPatch({ mainFile: event.target.value })}>
                    {texFiles.some((node) => node.path === project.mainFile) ? null : (
                      <option value={project.mainFile}>{project.mainFile}（缺失）</option>
                    )}
                    {texFiles.map((node) => (
                      <option key={node.path} value={node.path}>
                        {node.path}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="latex-dropdown-field">
                  <span>编译引擎</span>
                  <select
                    value={project.engine}
                    onChange={(event) => onPatch({ engine: event.target.value as LatexEngine })}
                  >
                    {LATEX_ENGINES.map((item) => (
                      <option key={item.id} value={item.id} title={item.hint}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="latex-dropdown-check">
                  <input
                    type="checkbox"
                    checked={project.autoCompile}
                    onChange={(event) => onPatch({ autoCompile: event.target.checked })}
                  />
                  <span>保存后自动编译</span>
                </label>

                <label className={`latex-dropdown-check${project.aiAutoFix ? ' danger' : ''}`}>
                  <input
                    type="checkbox"
                    checked={project.aiAutoFix}
                    onChange={(event) => {
                      if (event.target.checked) {
                        void confirmDialog.bridge
                          .confirm(
                            '开启后，「自动修复」按钮可以直接改写项目里的 .tex 文件。\n\n' +
                              '写入前自动创建源码快照，并强制编译验证；错误没有减少就自动回滚。聊天中的修改仍需逐次确认。\n\n' +
                              '确定开启吗？',
                          )
                          .then((ok) => {
                            if (ok) onPatch({ aiAutoFix: true });
                          });
                        return;
                      }
                      onPatch({ aiAutoFix: false });
                    }}
                  />
                  <span>允许自动修复写入</span>
                </label>
              </div>

              <div className="latex-dropdown-divider" />

              <div className="latex-dropdown-actions">
                <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); onFlush(); }}>
                  <span>立即保存全部</span>
                  <small>Ctrl S</small>
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenGit(); }}>
                  <span>Git 版本与同步</span>
                </button>
                {hasPdf ? (
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onDownloadPdf(); }}>
                    <span>下载当前 PDF</span>
                  </button>
                ) : null}
                <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); onExportZip(); }}>
                  <span>导出源码 ZIP</span>
                </button>
                <button type="button" role="menuitem" disabled={busy} onClick={() => zipInputRef.current?.click()}>
                  <span>导入 Overleaf ZIP…</span>
                </button>
              </div>

              {toolchains ? (
                <>
                  <div className="latex-dropdown-divider" />
                  <div className="latex-dropdown-toolchain">
                    <span>
                      {toolchains.strategy === 'unavailable'
                        ? '未检测到 TeX 引擎'
                        : toolchains.engines.map((e) => `${e.name}${e.usable ? '' : '×'}`).join(' · ')}
                    </span>
                    <button type="button" onClick={onReloadToolchains}>重新探测</button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip"
            hidden
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              setMenuOpen(false);
              if (file) onImportZip(file);
            }}
          />
        </div>
      </div>
      {confirmDialog.node}
    </header>
  );
}
