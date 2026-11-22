import { useEffect, useState } from 'react';
import type { LatexBuild, LatexDiagnostic, LatexToolchainReport } from '@cbct/shared';
import { Icon } from '../ui/Icon';

export const LATEX_BUILD_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '编译中',
  succeeded: '已编译',
  failed: '编译失败',
  cancelled: '已取消',
  timeout: '编译超时',
};

/**
 * 底部诊断与日志抽屉（对齐 #s-latex 底部 .diag 面板）：
 * 统一收纳编译报错、行内诊断定位、缺失引用以及完整编译日志，不遮挡 PDF 预览区。
 */
export function LatexBuildPanel({
  toolchains,
  build,
  log,
  logLoading,
  stateError,
  compilerError,
  onClearStateError,
  onClearCompilerError,
  onReloadToolchains,
  onOpenDiagnostic,
  onEnsureLog,
}: {
  toolchains: LatexToolchainReport | null;
  build: LatexBuild | null;
  log: string | null;
  logLoading: boolean;
  stateError?: string;
  compilerError?: string;
  onClearStateError?: () => void;
  onClearCompilerError?: () => void;
  onReloadToolchains: () => void;
  onOpenDiagnostic: (diagnostic: LatexDiagnostic) => void;
  onEnsureLog: () => void;
}) {
  const unavailable = toolchains?.strategy === 'unavailable';
  const diagnostics = build?.diagnostics ?? [];
  const missingCitations = build?.missingCitations ?? [];
  const missingReferences = build?.missingReferences ?? [];
  const errorCount = (build?.errorCount ?? 0) + (compilerError ? 1 : 0) + (stateError ? 1 : 0);
  const warningCount = build?.warningCount ?? 0;

  const hasIssues = Boolean(
    errorCount > 0 ||
      warningCount > 0 ||
      diagnostics.length > 0 ||
      unavailable ||
      missingCitations.length > 0 ||
      missingReferences.length > 0,
  );

  const [open, setOpen] = useState(hasIssues);
  const [panelTab, setPanelTab] = useState<'diagnostics' | 'log'>('diagnostics');

  // 新出现错误或工具链缺失时自动展开底部抽屉。
  useEffect(() => {
    if (errorCount > 0 || unavailable) {
      setOpen(true);
    }
  }, [errorCount, unavailable]);

  const switchTab = (next: 'diagnostics' | 'log') => {
    setPanelTab(next);
    setOpen(true);
    if (next === 'log') onEnsureLog();
  };

  return (
    <details
      className="rx-diag"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>诊断与日志</span>

        {errorCount > 0 ? (
          <span className="rx-chip bad">
            <Icon name="alert" size={11} />
            <span className="tabular-nums">{errorCount} 错误</span>
          </span>
        ) : null}

        {warningCount > 0 ? (
          <span className="rx-chip warn">
            <Icon name="alert" size={11} />
            <span className="tabular-nums">{warningCount} 警告</span>
          </span>
        ) : null}

        {unavailable ? (
          <span className="rx-chip bad">缺少 TeX 引擎</span>
        ) : null}

        <span className="rx-diag-grow" />

        <span className="rx-diag-tabs" onClick={(e) => e.preventDefault()}>
          <button
            type="button"
            className={`rx-diag-tab${panelTab === 'diagnostics' ? ' active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              switchTab('diagnostics');
            }}
          >
            诊断{diagnostics.length ? ` (${diagnostics.length})` : ''}
          </button>
          <button
            type="button"
            className={`rx-diag-tab${panelTab === 'log' ? ' active' : ''}`}
            disabled={!build?.hasLog && !log}
            onClick={(e) => {
              e.stopPropagation();
              switchTab('log');
            }}
          >
            完整日志
          </button>
        </span>

        <Icon name={open ? 'down' : 'right'} size={13} />
      </summary>

      <div className="rx-diag-body">
        {panelTab === 'log' ? (
          <pre className="rx-diag-log">{logLoading ? '正在读取编译日志…' : (log || '（暂无编译日志）')}</pre>
        ) : (
          <>
            {stateError ? (
              <div className="rx-diag-alert bad" role="alert">
                <span>{stateError}</span>
                {onClearStateError ? (
                  <button type="button" onClick={onClearStateError}>忽略</button>
                ) : null}
              </div>
            ) : null}

            {compilerError ? (
              <div className="rx-diag-alert bad" role="alert">
                <span>{compilerError}</span>
                {onClearCompilerError ? (
                  <button type="button" onClick={onClearCompilerError}>忽略</button>
                ) : null}
              </div>
            ) : null}

            {build?.message && build.status !== 'succeeded' ? (
              <div className="rx-diag-alert bad">{build.message}</div>
            ) : null}

            {unavailable && toolchains?.hints.length ? (
              <div className="rx-diag-alert bad">
                <div className="flex flex-col gap-1">
                  {toolchains.hints.map((hint) => (
                    <span key={hint}>{hint}</span>
                  ))}
                </div>
                <button type="button" onClick={onReloadToolchains}>重新探测</button>
              </div>
            ) : null}

            {build && (missingCitations.length > 0 || missingReferences.length > 0) ? (
              <div className="rx-diag-alert warn">
                <span>
                  未定义引用：
                  {missingCitations.length ? ` 文献 ${missingCitations.join('、')}` : ''}
                  {missingReferences.length ? ` 标签 ${missingReferences.join('、')}` : ''}
                </span>
              </div>
            ) : null}

            {diagnostics.length ? (
              <div className="rx-diag-list">
                {diagnostics.map((diagnostic, index) => (
                  <button
                    key={`${diagnostic.file ?? ''}:${diagnostic.line ?? 0}:${index}`}
                    type="button"
                    className={`rx-dg severity-${diagnostic.severity}`}
                    disabled={!diagnostic.file || !diagnostic.line}
                    onClick={() => onOpenDiagnostic(diagnostic)}
                  >
                    <span className="rx-dg-ic">
                      <Icon name="alert" size={14} />
                    </span>
                    <span className="rx-dg-content">
                      <b>{diagnostic.message}</b>
                      <small>
                        {diagnostic.file
                          ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ''}`
                          : diagnostic.line
                            ? `第 ${diagnostic.line} 行`
                            : '未标注位置'}
                        {diagnostic.source ? ` · ${diagnostic.source}` : ''}
                      </small>
                      {diagnostic.snippet ? <code>{diagnostic.snippet}</code> : null}
                    </span>
                  </button>
                ))}
              </div>
            ) : !stateError && !compilerError && !(build && build.status !== 'succeeded') && !unavailable ? (
              <p className="rx-diag-empty">
                {build ? '本次编译无错误或警告。' : '尚未编译，点击上方「编译」或切换至「实时编译」。'}
              </p>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}
