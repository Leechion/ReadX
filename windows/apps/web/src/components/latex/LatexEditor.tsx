import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { latexCompletionContext } from '@cbct/shared';
import type { OpenFile } from '../../hooks/useLatexProject';
import type { LatexCompletionIndex } from '../../lib/latex/latexCompletion';
import { applyIndexMarkers, registerLatexCompletion } from '../../lib/latex/latexCompletion';
import { LATEX_LANGUAGE_ID, registerLatexLanguage } from '../../lib/latex/latexLanguage';

// LaTeX 只用基础编辑能力，不需要 JSON/TS 的语言服务：一个 editor worker 就够。
// 这也让 Monaco 的加载体积只有编辑器本体，不带上各语言服务。
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

function resolveReadxMonacoTheme(): 'readx-light' | 'readx-dark' | 'readx-paper' {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return 'readx-dark';
  if (attr === 'paper') return 'readx-paper';
  return 'readx-light';
}

function registerReadxMonacoThemes(monaco: typeof Monaco) {
  monaco.editor.defineTheme('readx-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '2F6F59', fontStyle: 'bold' },
      { token: 'comment', foreground: '8C8E86', fontStyle: 'italic' },
      { token: 'string', foreground: '9D6B26' },
      { token: 'number', foreground: '2F6F59' },
    ],
    colors: {
      'editor.background': '#FBFBF9',
      'editor.foreground': '#1C1D1A',
      'editor.lineHighlightBackground': '#F4F3EF',
      'editor.selectionBackground': '#E6F0EC',
      'editorLineNumber.foreground': '#9A9B93',
      'editorLineNumber.activeForeground': '#1C1D1A',
      'editorCursor.foreground': '#2F6F59',
      'editorGutter.background': '#FBFBF9',
    },
  });
  monaco.editor.defineTheme('readx-paper', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '7A542E', fontStyle: 'bold' },
      { token: 'comment', foreground: '8E836D', fontStyle: 'italic' },
      { token: 'string', foreground: '68492A' },
      { token: 'number', foreground: '7A542E' },
    ],
    colors: {
      'editor.background': '#FAF5E8',
      'editor.foreground': '#262118',
      'editor.lineHighlightBackground': '#F2EBD9',
      'editor.selectionBackground': '#EFE4D0',
      'editorLineNumber.foreground': '#8E836D',
      'editorLineNumber.activeForeground': '#262118',
      'editorCursor.foreground': '#7A542E',
      'editorGutter.background': '#FAF5E8',
    },
  });
  monaco.editor.defineTheme('readx-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '4FA886', fontStyle: 'bold' },
      { token: 'comment', foreground: '747870', fontStyle: 'italic' },
      { token: 'string', foreground: 'D8A24A' },
      { token: 'number', foreground: '4FA886' },
    ],
    colors: {
      'editor.background': '#1C1E1C',
      'editor.foreground': '#E8E9E4',
      'editor.lineHighlightBackground': '#242724',
      'editor.selectionBackground': '#1E342A',
      'editorLineNumber.foreground': '#6F726C',
      'editorLineNumber.activeForeground': '#E8E9E4',
      'editorCursor.foreground': '#4FA886',
      'editorGutter.background': '#1C1E1C',
    },
  });
}

type Editor = Monaco.editor.IStandaloneCodeEditor;

/**
 * Monaco 编辑器。
 *
 * 与文本域的版本保持同一套外部约定（打开多文件、自动保存、冲突提示都不变），
 * 换掉的是编辑内核：每个打开的文件一个 model，切 Tab 只切 model——
 * 这样撤销栈、光标位置、折叠状态都按文件各留一份，切回来还在原处。
 */
export function LatexEditor({
  files,
  active,
  index,
  reveal,
  pendingCiteInsert,
  onActivate,
  onClose,
  onChange,
  onSave,
  onReload,
  onForceSave,
  onSyncToPdf,
  onOpenLibraryCite,
  syncBusy = false,
  readOnly = false,
}: {
  files: OpenFile[];
  active: OpenFile | null;
  index: LatexCompletionIndex & { missingCitations?: string[]; missingLabels?: string[] };
  /** 诊断跳转请求：nonce 变化时滚到对应行并高亮。 */
  reveal?: { path: string; line: number; nonce: number } | null;
  /** 从书库引用弹窗回传的待插入引用键。 */
  pendingCiteInsert?: { keys: string[]; nonce: number } | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
  onReload: (path: string) => void;
  onForceSave: (path: string) => void;
  onSyncToPdf?: (path: string, line: number) => void;
  onOpenLibraryCite?: () => void;
  syncBusy?: boolean;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const models = useRef(new Map<string, Monaco.editor.ITextModel>());
  // 回调放 ref：它们每次渲染都会变，但不该导致重建编辑器。
  const handlers = useRef({ onChange, onSave, onSyncToPdf });
  handlers.current = { onChange, onSave, onSyncToPdf };
  // 提供者跟随编辑器生命周期，索引在当前项目内始终读取最新值。
  const indexRef = useRef(index);
  indexRef.current = index;
  const [ready, setReady] = useState(false);
  // 用户可能正在输入：用 ref 记住「程序化写入 model」的时刻，避免回环。
  const applying = useRef(false);

  // 建编辑器（只建一次）
  useEffect(() => {
    let disposed = false;
    let completion: Monaco.IDisposable | undefined;
    let observer: MutationObserver | undefined;
    void (async () => {
      const monaco = await import('monaco-editor');
      if (disposed || !host.current) return;
      monacoRef.current = monaco;
      registerLatexLanguage(monaco);
      registerReadxMonacoThemes(monaco);
      completion = registerLatexCompletion(monaco, () => indexRef.current);

      const theme = resolveReadxMonacoTheme();
      const instance = monaco.editor.create(host.current, {
        value: '',
        language: LATEX_LANGUAGE_ID,
        theme,
        automaticLayout: true,
        fontSize: 16,
        lineHeight: 21,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        tabSize: 2,
        wordWrap: 'on',
        folding: true,
        bracketPairColorization: { enabled: true },
        suggestOnTriggerCharacters: true,
        quickSuggestions: { other: true, comments: false, strings: true },
        fixedOverflowWidgets: true,
      });
      editor.current = instance;

      // Ctrl/Cmd+S 交给上层保存：自动保存有防抖，用户主动按保存时不该等。
      instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        const path = instance.getModel()?.uri.path.replace(/^\//, '');
        if (path) handlers.current.onSave(path);
      });

      instance.addAction({
        id: 'readx.synctex.forward',
        label: 'SyncTeX：定位到 PDF 对应位置',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyJ],
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.5,
        run: (ed) => {
          const path = ed.getModel()?.uri.path.replace(/^\//, '');
          const pos = ed.getPosition();
          if (path && pos && /\.tex$/i.test(path)) {
            handlers.current.onSyncToPdf?.(path, pos.lineNumber);
          }
        },
      });

      // 主题跟随应用（light -> readx-light, paper -> readx-paper, dark -> readx-dark）。
      observer = new MutationObserver(() => {
        monaco.editor.setTheme(resolveReadxMonacoTheme());
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

      setReady(true);
    })();
    return () => {
      disposed = true;
      completion?.dispose();
      observer?.disconnect();
      for (const model of models.current.values()) model.dispose();
      models.current.clear();
      editor.current?.dispose();
      editor.current = null;
      setReady(false);
    };
  }, []);

  useEffect(() => {
    editor.current?.updateOptions({ readOnly });
  }, [readOnly]);

  // 打开/切换文件：按路径建 model 并切换
  useEffect(() => {
    const monaco = monacoRef.current;
    const instance = editor.current;
    if (!ready || !monaco || !instance) return;
    if (!active) {
      instance.setModel(null);
      return;
    }
    let model = models.current.get(active.path);
    if (!model) {
      model = monaco.editor.createModel(active.content, LATEX_LANGUAGE_ID, monaco.Uri.parse(`file:///${active.path}`));
      models.current.set(active.path, model);
      model.onDidChangeContent(() => {
        if (applying.current) return;
        handlers.current.onChange(active.path, model!.getValue());
      });
    }
    if (instance.getModel() !== model) instance.setModel(model);
    // 容器可能刚从隐藏状态显示出来：强制重排一次，避免 Monaco 以 0 尺寸布局。
    instance.layout();
    instance.focus();
  }, [active, ready]);

  // 外部内容变化（重新加载、强制保存后的 revision 变化）要写回 model
  useEffect(() => {
    const model = active ? models.current.get(active.path) : null;
    if (!model || !active) return;
    if (model.getValue() !== active.content) {
      applying.current = true;
      model.setValue(active.content);
      applying.current = false;
    }
  }, [active]);

  // 关掉的 Tab 释放 model
  useEffect(() => {
    for (const [path, model] of models.current) {
      if (!files.some((file) => file.path === path)) {
        model.dispose();
        models.current.delete(path);
      }
    }
  }, [files]);

  // 诊断/SyncTeX 跳转：滚到对应行并把光标停在那里。
  useEffect(() => {
    const instance = editor.current;
    if (!ready || !instance || !reveal) return;
    const model = models.current.get(reveal.path);
    if (!model) return;
    if (instance.getModel() !== model) instance.setModel(model);
    const line = Math.max(1, Math.min(reveal.line, model.getLineCount()));
    instance.revealLineInCenter(line);
    instance.setPosition({ lineNumber: line, column: 1 });
    instance.focus();
  }, [ready, reveal]);

  // 插入从书库挑选的引用键（光标若已在 \cite{...} 内则只补键名）。
  useEffect(() => {
    const instance = editor.current;
    if (!ready || !instance || !pendingCiteInsert?.keys.length) return;
    const model = instance.getModel();
    if (!model) return;
    const selection = instance.getSelection();
    const pos = selection ? selection.getStartPosition() : instance.getPosition();
    if (!pos) return;
    const lineBefore = model.getValueInRange({
      startLineNumber: pos.lineNumber,
      startColumn: 1,
      endLineNumber: pos.lineNumber,
      endColumn: pos.column,
    });
    const keysJoined = pendingCiteInsert.keys.join(', ');
    let text = `\\cite{${keysJoined}}`;
    if (latexCompletionContext(lineBefore) === 'cite') {
      const openBrace = lineBefore.lastIndexOf('{');
      const inside = openBrace >= 0 ? lineBefore.slice(openBrace + 1).trim() : '';
      text = inside && !inside.endsWith(',') ? `, ${keysJoined}` : keysJoined;
    }
    const targetRange = selection ?? {
      startLineNumber: pos.lineNumber,
      startColumn: pos.column,
      endLineNumber: pos.lineNumber,
      endColumn: pos.column,
    };
    instance.executeEdits('readx-cite-library', [{ range: targetRange, text, forceMoveMarkers: true }]);
    instance.focus();
  }, [pendingCiteInsert, ready]);

  // 索引变化 → 刷新波浪线（引用了不存在的键）
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!ready || !monaco || !active) return;
    const model = models.current.get(active.path);
    if (!model) return;
    applyIndexMarkers(monaco, model, index);
  }, [active, index, ready]);

  // 结构在「有没有打开文件」两种状态下必须一致：Monaco 只在挂载时创建一次，
// 容器位置一旦变化（React 会重挂那个 div），编辑器就留在了游离节点上——界面看着是空的。
  return (
    <div className="latex-editor">
      <div className="latex-tabs" role="tablist">
        {files.length ? (
          files.map((file) => (
            <div key={file.path} className={`latex-tab${active?.path === file.path ? ' active' : ''}`}>
              <button type="button" role="tab" aria-selected={active?.path === file.path} onClick={() => onActivate(file.path)}>
                <span className="latex-tab-name">{file.path.split('/').pop()}</span>
                {file.dirty ? <span className="latex-tab-dot" title="未保存">●</span> : null}
                {file.saving ? <span className="latex-tab-saving" title="保存中">…</span> : null}
              </button>
              <button type="button" className="latex-tab-close" title="关闭" onClick={() => onClose(file.path)}>
                ×
              </button>
            </div>
          ))
        ) : (
          <span className="latex-tabs-hint">没有打开的文件</span>
        )}
      </div>

      {active ? (
        <div className="latex-editor-head">
          <span className="latex-editor-path">{active.path}</span>
          <div className="latex-editor-head-right">
            {/\.tex$/i.test(active.path) && onOpenLibraryCite ? (
              <button
                type="button"
                className="latex-editor-mini-btn"
                onClick={onOpenLibraryCite}
                title="从 ReadX 书库检索论文并写入 .bib，同时插入 \\cite{}"
              >
                + 书库引用
              </button>
            ) : null}
            {/\.tex$/i.test(active.path) && onSyncToPdf ? (
              <button
                type="button"
                className="latex-editor-mini-btn"
                disabled={syncBusy}
                onClick={() => {
                  const line = editor.current?.getPosition()?.lineNumber ?? 1;
                  onSyncToPdf(active.path, line);
                }}
                title="SyncTeX：从当前光标行定位到 PDF（快捷键 Ctrl/Cmd+Alt+J）"
              >
                {syncBusy ? '定位中…' : '定位到 PDF'}
              </button>
            ) : null}
            <span className="latex-editor-state">
              {active.conflict ? '与磁盘冲突' : active.saving ? '保存中…' : active.dirty ? '未保存' : `已保存 · ${active.revision.slice(0, 8)}`}
            </span>
          </div>
        </div>
      ) : null}

      {active?.conflict ? (
        <div className="latex-conflict" role="alert">
          <p>{active.error}</p>
          <button type="button" onClick={() => onReload(active.path)}>重新加载磁盘版本</button>
          <button type="button" className="danger" onClick={() => onForceSave(active.path)}>以我的版本覆盖</button>
        </div>
      ) : active?.error ? (
        <p className="latex-alert error">{active.error}</p>
      ) : null}

      <div className={`latex-monaco${active ? '' : ' hidden'}`} ref={host} data-testid="latex-editor" />

      {active ? null : (
        <div className="latex-editor-placeholder">
          <p>从左侧选择文件开始编辑</p>
        </div>
      )}
    </div>
  );
}
