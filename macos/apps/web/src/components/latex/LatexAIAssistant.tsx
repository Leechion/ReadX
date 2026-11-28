import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentSummary, LatexAutoFixResult, LatexBuild, LatexSnapshot } from '@cbct/shared';
import { api, latexAIFix, streamLatexChat, type AgentExecutionMode, type LatexAISettings, type LatexSnapshotDiffResult } from '../../api/client';
import { useAIPreferences } from '../../hooks/useAIPreferences';
import { useConfirm } from '../ConfirmDialog';
import { ChatWorkspace } from '../ChatWorkspace';
import { runLatexChat } from '../../lib/latex/latexChatTransport';
import { computeLineDiff } from '../../lib/latex/lineDiff';

export function LatexAIAssistant({
  projectId,
  projectTitle,
  filePath,
  source,
  build,
  documents = [],
  aiAutoFix,
  autoFixRunning,
  autoFixStages,
  autoFixResult,
  autoFixError,
  snapshots,
  onClose,
  onApplyFix,
  onCompile,
  compiling,
  onAutoFix,
  onRollbackSnapshot,
  onRefreshSnapshots,
  onAgentDirectApplied,
  onOpenFile,
}: {
  projectId: string;
  projectTitle: string;
  filePath: string;
  source: string;
  build: LatexBuild | null;
  documents?: DocumentSummary[];
  /** 「AI 直接改文件」总开关：关着就不提供直接写盘入口。 */
  aiAutoFix: boolean;
  autoFixRunning: boolean;
  autoFixStages: string[];
  autoFixResult: LatexAutoFixResult | null;
  autoFixError: string;
  snapshots: LatexSnapshot[];
  onClose: () => void;
  onApplyFix: (proposal: { filePath: string; original: string; content: string }, signal?: AbortSignal) => Promise<string>;
  onCompile: () => void;
  compiling: boolean;
  onAutoFix: (question: string) => void;
  onRollbackSnapshot: (snapshotId: string) => void;
  onRefreshSnapshots: () => void;
  onAgentDirectApplied?: (filePaths: string[]) => Promise<void>;
  onOpenFile?: (path: string) => void;
}) {
  const preferences = useAIPreferences();
  const confirmDialog = useConfirm();
  const chatKey = `latex-project:${projectId}`;
  const [agentMode, setAgentMode] = useState<AgentExecutionMode>('agent');
  const [fixing, setFixing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [fixError, setFixError] = useState('');
  const [fixNotice, setFixNotice] = useState('');
  const [proposal, setProposal] = useState<{ filePath: string; original: string; content: string; summary: string } | null>(null);
  const [reviewMode, setReviewMode] = useState<'diff' | 'proposed' | 'original'>('diff');
  const [snapshotDiff, setSnapshotDiff] = useState<LatexSnapshotDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState('');
  const [fixPanelOpen, setFixPanelOpen] = useState(false);
  const [autoFixNote, setAutoFixNote] = useState('');
  const [referenceKeys, setReferenceKeys] = useState<string[]>([]);
  const [refQuery, setRefQuery] = useState('');

  const filteredDocuments = useMemo(() => {
    const needle = refQuery.trim().toLowerCase();
    if (!needle) return documents;
    return documents.filter((doc) =>
      [doc.title, doc.translatedTitle ?? '', doc.authors.join(' '), doc.venue, doc.year ? String(doc.year) : '', doc.key]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [documents, refQuery]);

  const toggleReference = (id: string) => {
    setReferenceKeys((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 6) return current;
      return [...current, id];
    });
  };

  useEffect(() => {
    if (proposal || autoFixRunning) setFixPanelOpen(true);
  }, [autoFixRunning, proposal]);

  // ---- LaTeX 自己的模型渠道（与全局分开） ----
  const [modelSettings, setModelSettings] = useState<LatexAISettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState({
    followGlobal: true,
    provider: 'openai',
    baseURL: '',
    model: '',
    reasoningEffort: '',
    apiKey: '',
  });
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const modelBox = useRef<HTMLDivElement>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsNotice, setSettingsNotice] = useState('');

  const loadModelSettings = useCallback(async () => {
    try {
      const view = await api.latexAISettings();
      setModelSettings(view);
      setDraft((current) => ({
        ...current,
        followGlobal: view.followGlobal,
        // The settings view reports the effective global channel while following
        // global settings. Keep that model out of the independent draft.
        ...(view.followGlobal ? {
          provider: 'openai',
          baseURL: '',
          model: '',
          reasoningEffort: '',
        } : {
          provider: view.provider === 'anthropic' ? 'anthropic' : 'openai',
          baseURL: view.baseURL,
          model: view.model,
          reasoningEffort: view.reasoningEffort,
        }),
      }));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void loadModelSettings();
  }, [loadModelSettings]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!modelBox.current?.contains(event.target as Node)) setModelMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModelMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [modelMenuOpen]);

  const saveModelSettings = async () => {
    setSettingsBusy(true);
    setSettingsError('');
    setSettingsNotice('');
    try {
      const view = await api.saveLatexAISettings({
        followGlobal: draft.followGlobal,
        provider: draft.provider,
        baseURL: draft.baseURL,
        model: draft.model,
        reasoningEffort: draft.reasoningEffort,
        apiKey: draft.apiKey.trim() || undefined,
      });
      setModelSettings(view);
      setDraft((current) => ({ ...current, apiKey: '' }));
      setSettingsNotice(
        view.followGlobal
          ? '已改为跟随全局 AI 助手设置。'
          : view.keyConfigured
            ? '已保存：LaTeX 的 AI 助手将使用这条渠道（全局设置未改动）。'
            : '已保存渠道，但这条地址还没有 Key：请在上面填入 Key 再保存一次。',
      );
      // 让「是否可用」等状态立刻跟上。
      await preferences.reload();
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  const fetchModels = async () => {
    setSettingsBusy(true);
    setSettingsError('');
    try {
      const result = await api.listModels({
        provider: draft.provider,
        baseURL: draft.baseURL,
        apiKey: draft.apiKey.trim() || undefined,
        refresh: true,
      });
      setModelOptions(result.models ?? []);
      setModelQuery('');
      setModelMenuOpen((result.models ?? []).length > 0);
      setSettingsNotice(
        (result.models ?? []).length
          ? `拿到 ${result.models.length} 个模型，可从模型列表中选择。`
          : result.notice || '这个地址没有返回模型列表，请手动填写模型名。',
      );
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  // 按钮的可用性必须看 LaTeX 的**生效**渠道，而不是全局状态：
  // 只单独配了 LaTeX 渠道、全局仍是 codex 时，这些入口照样要能用。
  const effective = modelSettings?.status;
  /**
   * 给聊天面板看的偏好：把渠道信息换成 LaTeX **实际生效**的那条。
   *
   * 不这么做的话，底部会写着「和 Codex 一起工作」，而请求其实发往 LaTeX 自己的渠道——
   * 界面说的和真正发生的不一致，这类小事最容易让人误判走了哪个模型。
   */
  const chatPreferences = useMemo(() => {
    if (!modelSettings || modelSettings.followGlobal) return preferences;
    return {
      ...preferences,
      // `preferences.model` is resolved from the global Codex catalog. Leaving it
      // here makes the composer display that stale global model ahead of the
      // actual LaTeX model in settings.
      model: undefined,
      catalog: [],
      settings: preferences.settings
        ? {
            ...preferences.settings,
            provider: modelSettings.provider,
            model: modelSettings.model,
            status: modelSettings.status,
          }
        : preferences.settings,
    };
  }, [modelSettings, preferences]);
  const effectiveReady = effective?.configured ?? false;
  const transport = useCallback(
    (
      request: { key: string; question: string; history?: Array<{ role: string; text: string }>; agentMode?: string },
      onChunk: Parameters<typeof streamLatexChat>[1],
      signal?: AbortSignal,
    ) =>
      runLatexChat(
        {
          key: request.key,
          projectId,
          projectTitle,
          filePath,
          source,
          question: request.question,
          agentMode: request.agentMode || agentMode,
          referenceKeys: referenceKeys.length ? referenceKeys : undefined,
          history: request.history,
        },
        (chunk) => {
          onChunk(chunk);
          if (chunk.done && chunk.autoApplied) {
            const changedPaths = (chunk.edits && chunk.edits.length > 0 ? chunk.edits : chunk.edit ? [chunk.edit] : [])
              .map((item) => item.filePath)
              .filter(Boolean);
            if (changedPaths.length && onAgentDirectApplied) {
              void onAgentDirectApplied(changedPaths);
            } else {
              onRefreshSnapshots();
            }
          }
        },
        signal,
      ),
    [agentMode, filePath, onAgentDirectApplied, onRefreshSnapshots, projectId, projectTitle, referenceKeys, source],
  );

  const generateFix = async () => {
    if (!build || build.stale || fixing || !effectiveReady || !/\.tex$/i.test(filePath)) return;
    const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '');
    const relevantDiagnostics = build.diagnostics.filter((diagnostic) => !diagnostic.file || normalize(diagnostic.file) === normalize(filePath));
    if (build.errorCount > 0 && build.diagnostics.some((diagnostic) => diagnostic.file && normalize(diagnostic.file) !== normalize(filePath)) && !relevantDiagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      setFixError('错误位于其他文件。请先在编译诊断中点击对应错误，打开该 .tex 文件后再修复。');
      return;
    }
    setFixing(true);
    setFixError('');
    setFixNotice('');
    setProposal(null);
    try {
      const log = build.hasLog ? (await api.latexBuildLog(build.id)).log : '';
      const result = await latexAIFix({
        projectId,
        projectTitle,
        filePath,
        source,
        diagnostics: relevantDiagnostics,
        buildLog: log.slice(-200_000),
      });
      setProposal({ filePath, original: source, content: result.content, summary: result.summary });
    } catch (cause) {
      setFixError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFixing(false);
    }
  };

  const applyProposal = async () => {
    if (!proposal || proposal.content === proposal.original || applying) return;
    setApplying(true);
    setFixNotice('');
    setFixError('');
    try {
      const notice = await onApplyFix(proposal);
      setFixNotice(notice);
      if (notice.startsWith('已应用并保存')) setProposal(null);
    } catch (cause) {
      setFixError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApplying(false);
    }
  };

  return (
    <aside className="latex-ai-column" aria-label="LaTeX AI 助手">
      <header className="latex-ai-column-head">
        <div>
          <strong>LaTeX AI 助手</strong>
          <span title={modelSettings?.followGlobal ? '当前跟随全局 AI 助手设置' : '当前使用 LaTeX 单独的模型渠道'}>
            {effective?.configured
              ? `${effective.model || effective.provider}${modelSettings?.followGlobal ? '（跟随全局）' : '（LaTeX 单独）'}`
              : '尚未配置可用渠道'}
          </span>
        </div>
        <div className="latex-ai-head-actions">
          <button type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)} title="LaTeX 的 AI 助手可以单独指定模型，不影响阅读与翻译用的渠道">
            模型设置
          </button>
          <button type="button" onClick={onClose} aria-label="关闭 AI 助手">×</button>
        </div>
      </header>

      {settingsOpen ? (
        <section className="latex-ai-models" aria-label="LaTeX 的模型设置">
          <label className="latex-ai-model-toggle">
            <input
              type="checkbox"
              checked={draft.followGlobal}
              onChange={(event) => setDraft((current) => ({ ...current, followGlobal: event.target.checked }))}
            />
            跟随全局 AI 助手设置
          </label>
          {draft.followGlobal ? (
            <p className="latex-ai-models-hint">
              当前使用全局渠道（
              {effective?.model || effective?.provider || '未配置'}）。想让 LaTeX 单独走别的模型，
              取消勾选后填一条 HTTP 渠道即可——阅读与翻译用的渠道不会被动。
            </p>
          ) : (
            <>
              <div className="latex-ai-model-row">
                <select
                  value={draft.provider}
                  onChange={(event) => setDraft((current) => ({ ...current, provider: event.target.value }))}
                  aria-label="接入方式"
                >
                  <option value="openai">OpenAI 兼容</option>
                  <option value="anthropic">Anthropic</option>
                </select>
                <input
                  value={draft.baseURL}
                  onChange={(event) => setDraft((current) => ({ ...current, baseURL: event.target.value }))}
                  placeholder="https://api.example.com/v1"
                  aria-label="API 地址"
                />
              </div>
              <div className="latex-ai-model-row latex-ai-model-picker" ref={modelBox}>
                <input
                  value={draft.model}
                  onFocus={() => setModelMenuOpen(true)}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, model: event.target.value }));
                    setModelQuery(event.target.value);
                    setModelMenuOpen(true);
                  }}
                  placeholder="模型名，例如 deepseek-v4-flash"
                  aria-label="模型"
                  aria-expanded={modelMenuOpen}
                  aria-controls="latex-ai-model-list"
                  role="combobox"
                  aria-autocomplete="list"
                />
                {modelOptions.length ? (
                  <button
                    type="button"
                    className="ai-model-caret"
                    onClick={() => setModelMenuOpen((open) => !open)}
                    aria-label="展开模型列表"
                    aria-expanded={modelMenuOpen}
                    title={`共 ${modelOptions.length} 个模型`}
                  >
                    ⌄
                  </button>
                ) : null}
                {modelMenuOpen && modelOptions.length ? (
                  <div className="ai-model-menu" id="latex-ai-model-list">
                    <input
                      className="ai-model-search"
                      value={modelQuery}
                      onChange={(event) => setModelQuery(event.target.value)}
                      placeholder={`筛选 ${modelOptions.length} 个模型`}
                      aria-label="筛选模型名"
                    />
                    <div className="ai-model-scroll" role="listbox" aria-label="模型列表">
                      {modelOptions
                        .filter((name) => name.toLowerCase().includes(modelQuery.trim().toLowerCase()))
                        .map((name) => (
                          <button
                            key={name}
                            type="button"
                            role="option"
                            aria-selected={name === draft.model}
                            className={`ai-model-item${name === draft.model ? ' active' : ''}`}
                            onClick={() => {
                              setDraft((current) => ({ ...current, model: name }));
                              setModelQuery('');
                              setModelMenuOpen(false);
                            }}
                          >
                            {name}
                          </button>
                        ))}
                      {!modelOptions.some((name) => name.toLowerCase().includes(modelQuery.trim().toLowerCase())) ? (
                        <p className="ai-model-empty">没有匹配的模型名</p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <button type="button" disabled={settingsBusy || !draft.baseURL} onClick={() => void fetchModels()}>
                  拉取模型
                </button>
              </div>
              <div className="latex-ai-model-row">
                <input
                  type="password"
                  value={draft.apiKey}
                  onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
                  placeholder={modelSettings?.keyConfigured ? '这条地址已保存 Key（留空则沿用）' : '填这条地址的 API Key'}
                  aria-label="API Key"
                />
                <select
                  value={draft.reasoningEffort}
                  onChange={(event) => setDraft((current) => ({ ...current, reasoningEffort: event.target.value }))}
                  aria-label="推理强度"
                >
                  <option value="">推理强度：默认</option>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                </select>
              </div>
              <p className="latex-ai-models-hint">
                只支持 HTTP 渠道：CLI 渠道（Codex/Claude Code/Kimi Code）靠拉起本机命令行进程，
                在后台服务里通常不可用。Key 按「渠道 + 地址」单独保存，绝不会被发到别的地址。
              </p>
            </>
          )}
          {settingsError ? <p className="latex-ai-fix-error" role="alert">{settingsError}</p> : null}
          {settingsNotice ? <p className="latex-ai-fix-notice" role="status">{settingsNotice}</p> : null}
          <div className="latex-ai-model-actions">
            <button type="button" onClick={() => void saveModelSettings()} disabled={settingsBusy}>
              {settingsBusy ? '处理中…' : '保存模型设置'}
            </button>
            <button type="button" onClick={() => void loadModelSettings()} disabled={settingsBusy}>
              重新读取
            </button>
          </div>
        </section>
      ) : null}
      {!preferences.loading && modelSettings && !effectiveReady ? (
        <p className="latex-ai-unconfigured">这个项目还没有可用的 AI 渠道：点上面的「模型」为 LaTeX 指定一条 HTTP 渠道（不影响阅读与翻译用的渠道），或在 AI 设置里配置全局渠道。</p>
      ) : null}
      <details className="latex-ai-tools" open={fixPanelOpen} onToggle={(event) => setFixPanelOpen(event.currentTarget.open)}>
      <summary>编译修复与源码快照</summary>
      <section className="latex-ai-fix" aria-label="AI 编译修复">
        {/* 直接写盘：默认关闭，开启后由服务端保证「快照 → 写入 → 强制编译 → 未改善回滚」。 */}
        <div className="latex-ai-autofix">
          <div className="latex-ai-fix-actions">
            <button
              type="button"
              className={aiAutoFix ? 'primary' : ''}
              onClick={() => onAutoFix(autoFixNote)}
              disabled={
                !aiAutoFix || autoFixRunning || compiling || !effectiveReady || !build || build.stale || !/\.tex$/i.test(filePath)
              }
              title={
                !aiAutoFix
                  ? '需要在工具栏打开「自动修复写入」'
                  : 'AI 会直接改写这个文件：写前自动快照，写后强制重新编译，错误没减少就自动回滚'
              }
            >
              {autoFixRunning ? '正在自动修复…' : '自动修复（直接改文件）'}
            </button>
            <span>
              {!aiAutoFix
                ? '未开启「自动修复写入」：可先生成修复建议，再确认应用'
                : !build
                  ? '先编译一次，AI 才知道要修什么'
                  : build.stale
                    ? '源码已变更，请先重新编译'
                    : `${build.errorCount} 个错误 · ${filePath}`}
            </span>
          </div>
          <input
            className="latex-ai-autofix-note"
            value={autoFixNote}
            placeholder="可选：对这次修复的附加要求（例如「不要动参考文献」）"
            onChange={(event) => setAutoFixNote(event.target.value)}
          />
          {autoFixRunning && autoFixStages.length ? (
            <ol className="latex-ai-autofix-stages">
              {autoFixStages.map((stage, index) => (
                <li key={`${index}-${stage}`} className={index === autoFixStages.length - 1 ? 'current' : ''}>
                  {stage}
                </li>
              ))}
            </ol>
          ) : null}
          {autoFixError ? (
            <p className="latex-ai-fix-error" role="alert">
              {autoFixError}
            </p>
          ) : null}
          {autoFixResult ? (
            <div className={`latex-ai-autofix-result outcome-${autoFixResult.outcome}`} role="status">
              <strong>
                {autoFixResult.outcome === 'kept' ? '已应用修改' : '已自动回滚'}
                {' · '}
                {autoFixResult.filePath}
              </strong>
              <p>{autoFixResult.reason}</p>
              <p className="latex-ai-autofix-counts">
                编译错误 {autoFixResult.beforeErrors} → {autoFixResult.afterErrors}
                {autoFixResult.baselineRecompiled ? '（基线是本次现编译的）' : ''}
                {' · '}
                {Math.round(autoFixResult.durationMs / 1000)} 秒
                {autoFixResult.bytesChanged ? ` · ${autoFixResult.bytesChanged > 0 ? '+' : ''}${autoFixResult.bytesChanged} 字节` : ''}
              </p>
              {autoFixResult.summary ? <p className="latex-ai-autofix-summary">{autoFixResult.summary}</p> : null}
              <div className="latex-ai-fix-review-actions">
                <button type="button" onClick={onCompile} disabled={compiling}>
                  {compiling ? '正在编译…' : '重新编译'}
                </button>
                {autoFixResult.snapshotId ? (
                  <button type="button" onClick={() => onRollbackSnapshot(autoFixResult.snapshotId)}>
                    回滚到修改前
                  </button>
                ) : null}
              </div>
              {autoFixResult.outcome === 'rolled-back' && autoFixResult.rejectedContent ? (
                <details className="latex-ai-autofix-rejected">
                  <summary>看看 AI 想改成什么（已回滚，未生效）</summary>
                  <pre>{autoFixResult.rejectedContent}</pre>
                </details>
              ) : null}
            </div>
          ) : null}
          {snapshots.length ? (
            <details className="latex-ai-snapshots" onToggle={(event) => {
              if ((event.target as HTMLDetailsElement).open) onRefreshSnapshots();
            }}>
              <summary>源码快照（{snapshots.length}）· 可回滚</summary>
              <ul>
                {snapshots.slice(0, 6).map((snapshot) => (
                  <li key={snapshot.id}>
                    <span>
                      {snapshot.createdAt.replace('T', ' ').replace('Z', '')} · {snapshot.note || '快照'} · {snapshot.fileCount} 个文件
                    </span>
                    <div className="latex-snapshot-actions">
                      <button
                        type="button"
                        disabled={diffLoading}
                        onClick={() => {
                          if (snapshotDiff?.snapshot.id === snapshot.id) {
                            setSnapshotDiff(null);
                            return;
                          }
                          setDiffLoading(true);
                          setDiffError('');
                          void api.latexSnapshotDiff(snapshot.id)
                            .then((res) => setSnapshotDiff(res))
                            .catch((cause) => setDiffError(cause instanceof Error ? cause.message : String(cause)))
                            .finally(() => setDiffLoading(false));
                        }}
                      >
                        {snapshotDiff?.snapshot.id === snapshot.id ? '收起对比' : '对比当前'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void confirmDialog.bridge
                            .confirm('回滚会把项目源码恢复到这份快照的状态，快照之后新增的文件会被移除。继续？')
                            .then((ok) => {
                              if (ok) onRollbackSnapshot(snapshot.id);
                            });
                        }}
                      >
                        回滚
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {diffError ? <p className="latex-ai-fix-error" role="alert">{diffError}</p> : null}
              {snapshotDiff ? (
                <div className="latex-snapshot-diff">
                  <div className="latex-snapshot-diff-head">
                    <strong>快照对比 · {snapshotDiff.snapshot.note || snapshotDiff.snapshot.id}</strong>
                    <span>{snapshotDiff.files.length ? `${snapshotDiff.files.length} 个文件有差异` : '与当前源码完全一致'}</span>
                  </div>
                  {snapshotDiff.files.map((file) => {
                    if (file.binary || file.tooBig) {
                      return (
                        <div key={file.path} className="latex-diff-file">
                          <div className="latex-diff-file-title">
                            <span>{file.path}</span>
                            <span className="latex-diff-badge">{file.status} · {file.binary ? '二进制文件' : '文件过大'}</span>
                          </div>
                        </div>
                      );
                    }
                    const diff = computeLineDiff(file.before || '', file.after || '');
                    return (
                      <div key={file.path} className="latex-diff-file">
                        <div className="latex-diff-file-title">
                          <span>{file.path}</span>
                          <span className="latex-diff-badge">{file.status} (+{diff.addedCount} / -{diff.removedCount})</span>
                        </div>
                        <pre className="latex-diff-view">
                          {diff.lines.map((line, index) => (
                            <span key={index} className={`latex-diff-line ${line.kind}`}>
                              <span className="latex-diff-sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span>
                              {line.text || ' '}
                            </span>
                          ))}
                        </pre>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <p className="latex-ai-snapshots-hint">回滚是「回到那一刻」：之后新增的文件会被移除，之后的所有改动都会丢失。</p>
            </details>
          ) : null}
        </div>

        <div className="latex-ai-fix-actions">
          <button type="button" onClick={() => void generateFix()} disabled={!effectiveReady || !build || build.stale || fixing || !/\.tex$/i.test(filePath)}>
            {fixing ? '正在分析编译错误…' : 'AI 修复建议（我先看）'}
          </button>
          <span>{!build ? '先编译一次，再让 AI 修复' : build.stale ? '源码已变更，请先重新编译' : `${build.errorCount} 个错误 · ${filePath}`}</span>
        </div>
        {fixError ? <p className="latex-ai-fix-error" role="alert">{fixError}</p> : null}
        {fixNotice ? <p className="latex-ai-fix-notice" role="status">{fixNotice}{fixNotice.startsWith('已应用并保存') ? <button type="button" onClick={onCompile} disabled={compiling}>{compiling ? '正在编译…' : '重新编译'}</button> : null}</p> : null}
        {proposal ? (
          <div className="latex-ai-fix-review">
            <div className="latex-ai-fix-summary"><strong>修改建议 · {proposal.filePath}</strong><p>{proposal.summary || 'AI 已生成当前文件的完整修改版本。'}</p></div>
            <div className="latex-ai-fix-review-actions">
              <div>
                <button type="button" className={reviewMode === 'diff' ? 'active' : ''} onClick={() => setReviewMode('diff')}>行级对比</button>
                <button type="button" className={reviewMode === 'proposed' ? 'active' : ''} onClick={() => setReviewMode('proposed')}>修改后</button>
                <button type="button" className={reviewMode === 'original' ? 'active' : ''} onClick={() => setReviewMode('original')}>修改前</button>
              </div>
              <button type="button" onClick={() => void applyProposal()} disabled={applying || proposal.content === proposal.original}>{applying ? '正在保存…' : '应用并保存'}</button>
              <button type="button" onClick={() => setProposal(null)}>丢弃</button>
            </div>
            {reviewMode === 'diff' ? (() => {
              const diff = computeLineDiff(proposal.original, proposal.content);
              return (
                <pre className="latex-diff-view">
                  {diff.lines.map((line, index) => (
                    <span key={index} className={`latex-diff-line ${line.kind}`}>
                      <span className="latex-diff-sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span>
                      {line.text || ' '}
                    </span>
                  ))}
                </pre>
              );
            })() : (
              <pre className={reviewMode === 'original' ? 'original' : 'proposed'}>{reviewMode === 'original' ? proposal.original : proposal.content}</pre>
            )}
          </div>
        ) : null}
      </section>
      </details>
      {documents.length ? (
        <details className="latex-ai-tools latex-ai-refs">
          <summary>
            关联书库文献（已选 {referenceKeys.length}/6 篇）
          </summary>
          <div className="latex-ai-refs-body">
            <div className="latex-ai-refs-bar">
              <input
                type="search"
                value={refQuery}
                onChange={(event) => setRefQuery(event.target.value)}
                placeholder="筛选书库论文（挂载其精读与批注）…"
                aria-label="筛选参考书库论文"
              />
              {referenceKeys.length ? (
                <button type="button" onClick={() => setReferenceKeys([])}>
                  清空
                </button>
              ) : null}
            </div>
            <ul className="latex-ai-refs-list">
              {filteredDocuments.slice(0, 30).map((doc) => {
                const checked = referenceKeys.includes(doc.id);
                const disabled = !checked && referenceKeys.length >= 6;
                return (
                  <li key={doc.id}>
                    <label className={checked ? 'checked' : undefined}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleReference(doc.id)}
                      />
                      <span>{doc.title || doc.key}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="latex-ai-refs-hint">
              已选文献的五步精读、批注和 BibTeX 键会随提问传给助手，方便起草 Related Work 或对比表。
            </p>
          </div>
        </details>
      ) : null}
      <ChatWorkspace
        documentKey={chatKey}
        title={projectTitle}
        disabled={!effectiveReady}
        quote={null}
        preferences={chatPreferences}
        onCite={() => {}}
        transport={transport}
        trackDocumentStatus={false}
        supportsImages={false}
        welcomeHeading="LaTeX 智能体工作流"
        welcomeQuestions={
          referenceKeys.length
            ? [
                '@章节撰写 基于已选书库文献的精读与批注，为当前章节起草一段 Related Work 并插入 \\cite{}。',
                '@章节撰写 把已选书库文献的方法与实验配置整理成一张 LaTeX booktabs 对比表。',
                '@引用补齐 将已选书库文献补齐到 references.bib 并在正文中插入引用。',
              ]
            : [
                '@编译排错 检查当前项目中的 LaTeX 错误并直接修复目标文件。',
                '@全文润色 帮我润色当前章节的学术表达，保留公式与原意并更新源码。',
                '@章节撰写 为当前论文新建或完善 Method / Experiments 章节文件。',
              ]
        }
        onApplyEdit={onApplyFix}
        agentMode={agentMode}
        onAgentModeChange={setAgentMode}
        onRollbackSnapshot={onRollbackSnapshot}
        onOpenFile={onOpenFile}
        composerHint={
          agentMode === 'agent'
            ? `智能体直改模式：自动创建快照并直接写入/新建文件${referenceKeys.length ? `（已挂载 ${referenceKeys.length} 篇书库文献）` : ''}`
            : agentMode === 'readonly'
              ? '只读规划模式：仅分析源码与规划结构，不改写任何文件'
              : referenceKeys.length
                ? `已挂载 ${referenceKeys.length} 篇书库精读资料；确认修改卡片后保存`
                : '审批修改模式：生成单文件或多文件修改卡片，确认后保存'
        }
      />
      {confirmDialog.node}
    </aside>
  );
}
