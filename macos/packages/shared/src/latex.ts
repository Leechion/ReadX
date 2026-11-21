/**
 * LaTeX Studio 的前后端契约（Go: internal/httpapi/latex_projects.go）。
 *
 * 与阅读/翻译链路完全分离：项目源码是磁盘上的真实文件，这里只描述 API 形状。
 * 路径字段一律是「相对项目 src/ 的相对路径」，统一用 `/`，永远不是宿主机绝对路径。
 */

export type LatexEngine = 'pdflatex' | 'xelatex' | 'lualatex';

export const LATEX_ENGINES: { id: LatexEngine; label: string; hint: string }[] = [
  { id: 'pdflatex', label: 'pdfLaTeX', hint: '最快，绝大多数英文期刊模板用它' },
  { id: 'xelatex', label: 'XeLaTeX', hint: '需要系统字体或中文时用它' },
  { id: 'lualatex', label: 'LuaLaTeX', hint: '需要 Lua 扩展或 OpenType 字体时用它' },
];

export interface LatexProject {
  id: string;
  title: string;
  /** 根文档相对路径（编译入口）。 */
  mainFile: string;
  engine: LatexEngine | string;
  autoCompile: boolean;
  /**
   * 「AI 直接改文件」总开关，默认关闭。
   * 开启后 AI 才能写入项目源码：每次写入前自动快照，写后强制编译验证，没改善自动回滚。
   */
  aiAutoFix: boolean;
  createdAt: string;
  updatedAt: string;
  lastBuildId: string;
  lastSuccessBuildId: string;
}

export interface LatexProjectsResponse {
  projects: LatexProject[];
  total: number;
}

export type LatexNodeKind = 'dir' | 'tex' | 'bib' | 'image' | 'text' | 'other';

export interface LatexNode {
  path: string;
  name: string;
  kind: LatexNodeKind;
  size: number;
  modifiedAt: string;
}

export interface LatexTreeResponse {
  nodes: LatexNode[];
  total: number;
}

export interface LatexFileContent {
  path: string;
  kind: LatexNodeKind;
  content: string;
  /** 内容指纹：保存时原样带回，服务端据此拒绝覆盖外部改动。 */
  revision: string;
  size: number;
}

export interface LatexSaveResponse {
  revision: string;
}

export type LatexFileOpKind = 'new-file' | 'new-dir' | 'rename' | 'move' | 'copy';

export interface LatexFileOp {
  op: LatexFileOpKind;
  from?: string;
  to: string;
}

export interface LatexImportReport {
  files: number;
  bytes: number;
  /** 被跳过的条目及原因（符号链接、副产物、超限…）：界面要如实显示，不能静默丢弃。 */
  skipped: string[];
  mainFile: string;
}

/**
 * 项目索引：补全与「引用了不存在的键」提示的依据。
 * 服务端扫 .bib 的条目键与 .tex 的 \label，并算出用了却没定义的那批——
 * 那正是编译必然报 undefined 的硬问题。
 */
export interface LatexIndexResponse {
  citations: string[];
  labels: string[];
  usedCitations: string[];
  usedLabels: string[];
  missingCitations: string[];
  missingLabels: string[];
  scannedFiles: number;
}

/**
 * 光标的补全上下文。
 *
 * 抽成纯函数放在共享包里，是为了能直接对「一串文本」做单元测试：
 * 这类判断一旦写错，表现是「补全列表里混进了文档里的词」，
 * 靠肉眼看界面很难定位（真发生过）。编辑器只负责把光标前的这一行交给它。
 */
export type LatexCompletionContext = 'cite' | 'ref' | 'begin' | 'usepackage' | 'command' | 'none';

export function latexCompletionContext(lineBeforeCursor: string): LatexCompletionContext {
  // 键名上下文：\cite{a,b 与 \ref{sec:x 的括号还没闭合时，只该给键名。
  if (/\\(?:cite[a-zA-Z]*|Citep?|Citet?)\s*(?:\[[^\]]*\])*\s*\{[^}]*$/.test(lineBeforeCursor)) return 'cite';
  if (/\\(?:ref|eqref|autoref|cref|Cref|pageref)\s*\{[^}]*$/.test(lineBeforeCursor)) return 'ref';
  if (/\\begin\{[^}]*$/.test(lineBeforeCursor)) return 'begin';
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*$/.test(lineBeforeCursor)) return 'usepackage';
  if (/\\[a-zA-Z@]*$/.test(lineBeforeCursor)) return 'command';
  return 'none';
}

/** 本机某个 TeX 可执行文件的探测结果。 */
export interface LatexToolchain {
  name: string;
  path: string;
  version: string;
  usable: boolean;
  /** usable=false 时必填：界面要如实显示「为什么不能用」，而不是干巴巴一句失败。 */
  reason?: string;
}

export interface LatexToolchainReport {
  engines: LatexToolchain[];
  auxTools: LatexToolchain[];
  preferred: string;
  /** latexmk 优先；不可用时用内置多趟；都没有则 unavailable。 */
  strategy: 'latexmk' | 'builtin-multipass' | 'unavailable';
  hints: string[];
}

export type LatexBuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';

export interface LatexDiagnostic {
  severity: 'error' | 'warning' | 'info';
  file?: string;
  line?: number;
  message: string;
  /** 谁报的这条诊断：LaTeX、Package lineno、Class IEEEtran… */
  source?: string;
  /**
   * 位置是怎么来的：
   * - `log`：日志行直接给出的文件与行号；
   * - `search`：在项目源码里找到了这个引用键（\cite/\ref 的键），位置确定；
   * - 空：没有位置（警告常常说不出文件，宁可不给也不猜错）。
   */
  locationSource?: 'log' | 'search';
  /** 出错处的源码片段（TeX 日志的 l.NN 行）。 */
  snippet?: string;
  raw?: string;
}

export interface LatexBuild {
  id: string;
  projectId: string;
  revision: string;
  status: LatexBuildStatus;
  reason?: string;
  engine: string;
  mainFile: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  errorCount: number;
  warningCount: number;
  pages: number;
  message?: string;
  diagnostics: LatexDiagnostic[];
  hasPdf: boolean;
  hasLog: boolean;
  /** 产物对应的源码已不是当前磁盘内容：界面要提示「重新编译」。 */
  stale: boolean;
  missingCitations: string[];
  missingReferences: string[];
}

export interface LatexBuildsResponse {
  builds: LatexBuild[];
  total: number;
}

/** 源码快照：AI 直接写盘前会自动留一份，用户也可以手动打快照与回滚。 */
export interface LatexSnapshot {
  id: string;
  projectId: string;
  note: string;
  manifest: string;
  fileCount: number;
  byteCount: number;
  createdAt: string;
}

export interface LatexSnapshotsResponse {
  snapshots: LatexSnapshot[];
  total: number;
}

/** 回滚报告：快照之后新增的文件会被移除，所以必须如实列出。 */
export interface LatexRestoreReport {
  snapshotId: string;
  restored: number;
  removedFiles: string[];
}

/** AI 直接写盘的结果：改了什么、编译前后各多少错误、保留还是回滚。 */
export interface LatexAutoFixResult {
  filePath: string;
  summary: string;
  outcome: 'kept' | 'rolled-back';
  reason: string;
  snapshotId: string;
  buildId: string;
  beforeBuildId: string;
  beforeErrors: number;
  afterErrors: number;
  beforeStatus: string;
  afterStatus: string;
  beforeMessage: string;
  afterMessage: string;
  diagnostics: LatexDiagnostic[];
  bytesChanged: number;
  durationMs: number;
  /** 基线是这次现编译的（原基线不存在或已过期）。 */
  baselineRecompiled: boolean;
  /** 只在被回滚时给出：AI 想改成什么。 */
  rejectedContent?: string;
}

/** 自动修复的流式事件。 */
export interface LatexAutoFixEvent {
  stage?: string;
  detail?: string;
  summary?: string;
  bytes?: number;
  error?: string;
  logRedacted?: boolean;
  done?: boolean;
  result?: LatexAutoFixResult;
}

/** SyncTeX 正向跳转返回的 PDF 区域（PDF pt，左上角原点）。 */
export interface SyncTeXBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SyncTeXForwardResult {
  file: string;
  line: number;
  page: number;
  exact: boolean;
  boxes: SyncTeXBox[];
}

export interface SyncTeXLocation {
  file: string;
  line: number;
  column: number;
  page: number;
}

/** 从 ReadX 书库批量写入项目 .bib 文件的结果。 */
export interface LatexCiteLibraryResult {
  bibFile: string;
  keys: string[];
  inserted: string[];
  alreadyPresent: string[];
  skipped: number;
  revision: string;
  bibTeX: string;
}