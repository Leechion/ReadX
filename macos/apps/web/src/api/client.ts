import type {
  ApiFailure,
  BootstrapInfo,
  DocumentDetail,
  DocumentsResponse,
  LatexEngine,
  LatexBuild,
  LatexAutoFixEvent,
  LatexBuildsResponse,
  LatexDiagnostic,
  LatexFileContent,
  LatexFileOp,
  LatexImportReport,
  LatexIndexResponse,
  LatexProject,
  LatexProjectsResponse,
  LatexRestoreReport,
  LatexSaveResponse,
  LatexSnapshot,
  LatexSnapshotsResponse,
  LatexToolchainReport,
  LatexTreeResponse,
  MetaResponse,
  PageListResponse,
  PageText,
  WireStatus,
} from '@cbct/shared';
import { isApiFailure } from '@cbct/shared';
import { downloadBlob } from '../lib/download';
import { processingFetch, approveProcessingChallenge, type ProcessingChallenge } from './processingConsent';
import type { RealtimeEvent } from '../lib/rtex/wire';

/**
 * API 客户端。
 *
 * token 来源只有一条路径：Electron preload 经 contextBridge 注入。纯浏览器 dev 模式下
 * 没有 token，此时 /v1 请求由 Vite dev proxy 在服务端补上 Authorization——凭据不落渲染进程。
 */
function bootstrap(): BootstrapInfo {
  const injected =
    typeof window === 'undefined' ? undefined : window.__CBCT_V2__;
  return { apiBase: injected?.apiBase ?? '', token: injected?.token ?? '' };
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 本地服务不可达（server 未启动 / 崩溃）与业务错误的文案要分开，否则用户看不懂该重启还是重试。 */
export function isTransportFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof ApiError && error.status === 0)
  );
}

export async function request<T>(
  path: string,
  init?: { signal?: AbortSignal; method?: string; body?: unknown },
): Promise<T> {
  const { apiBase, token } = bootstrap();
  const headers = new Headers({ Accept: 'application/json' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await processingFetch(apiBase + path, {
      headers,
      signal: init?.signal,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'omit',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    throw new ApiError('本地服务未响应，请确认 server 已启动', 0);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message = isApiFailure(payload)
      ? (payload as ApiFailure).error
      : `HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }
  if (payload === null)
    throw new ApiError(`${path} 返回空响应`, response.status);
  return payload as T;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value && value.trim()) search.set(key, value.trim());
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

/** 书目导出的查询串：keys 与 category 互斥，由服务端兜底校验。 */
function citationQuery(params: {
  format: CitationFormat;
  keys?: string[];
  category?: string;
}): string {
  return query({
    format: params.format,
    keys: params.keys?.length ? params.keys.join(',') : undefined,
    category: params.category,
  });
}

export interface AIStatus {
  provider?: string;
  configured: boolean;
  model?: string;
  reasoningEffort?: string;
  host?: string;
  error?: string;
}

export interface ReadingEntry {
  value: string;
  demoted: string[];
  validationError: string | null;
  updatedAt: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  visuals?: ReadingVisualAnalysis[];
  visualSourceHash?: string;
  narrative?: string;
  narrativeSections?: { title: string; body: string; status: 'ready' | 'partial' | 'reviewing' }[];
  readerStatus?: 'ready' | 'partial' | 'reviewing';
  readerIssues?: string[];
}

export interface ReadingGenerationInput {
  visuals: ReadingVisualReference[];
  workflow: 'paper-reader';
  fingerprint?: string;
  pageCount?: number;
  unavailableVisuals?: string[];
  repositoryURL?: string;
}

export interface ReadingVisualAnalysis {
  id: string;
  revision: string;
  kind: 'figure' | 'table';
  page: number;
  caption: string;
  step: 'motivation' | 'method' | 'experiment' | 'results' | 'reproduction';
  section: string;
  observation: string;
  analysis: string;
  limitations: string;
  evidence: { k: string; v: string; page: number; excerpt: string } | null;
}

export interface ReadingVisualReference {
  id: string;
  kind: 'figure' | 'table';
  page: number;
  caption: string;
  suggestedStep: 'motivation' | 'method' | 'experiment' | 'results' | 'reproduction';
  revision: string;
  imagePNG: string;
}

export interface ReadingsResponse {
  key: string;
  entries: Record<string, unknown>;
}

export interface GenerateResponse {
  saved: boolean;
  kind: string;
  skipped?: boolean;
  message?: string;
  pruned: boolean;
  demoted: string[];
  validationError: string | null;
  attempts: number;
}

export interface GenerateProgress {
  percent: number;
  message: string;
}

export interface ComparisonExperimentJob {
  key: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  percent: number;
  message: string;
  error?: string;
  updatedAt: string;
}

export interface LatexAIEditProposal {
  summary: string;
  filePath: string;
  original: string;
  content: string;
}

export interface ChatChunk {
  meta?: { included: number; total: number; scope: string; unit?: string; provider?: string; model?: string; reasoningEffort?: string };
  progress?: string;
  delta?: string;
  done?: boolean;
  text?: string;
  error?: string;
  partial?: string;
  edit?: LatexAIEditProposal | null;
}

/**
 * 流式对话：SSE 逐块回调。
 *
 * 服务端在流里既会发 delta 也会发 error（例如上游 finish_reason 不是 stop）——
 * 那种情况下已吐出的半句必须保留在界面上但标明「未保存」，不能假装成功。
 */
/**
 * 唯一的 SSE 传输与解析实现。原先 6 份同构的 reader+decoder+buffer+split('\n')
 * 循环（streamChat / streamLatexAutoFix / streamPresentationTheme /
 * streamPresentationPlan / attachArxivPDF / generate）收敛于此；线上协议不变，
 * 各端点只保留事件分发与终止条件。uploadPublications 是 XHR 上传（进度语义不同）
 * 与未使用的 importRemotePublication 暂不迁移，待 client.ts 按资源拆分时处理。
 */

/** 鉴权发起一个 SSE POST。fetch 层错误原样抛出（调用方按需包装）。 */
async function fetchSSE(endpoint: string, requestBody: unknown, signal?: AbortSignal): Promise<Response> {
  const { apiBase, token } = bootstrap();
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await processingFetch(`${apiBase}${endpoint}`, {
    method: 'POST', headers, body: JSON.stringify(requestBody), signal, credentials: 'omit',
  });
  if (!response.ok) {
    const text = await response.text();
    let message = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as ApiFailure;
      if (isApiFailure(parsed)) message = parsed.error;
    } catch {
      if (text) message = text.slice(0, 200);
    }
    throw new ApiError(message, response.status);
  }
  return response;
}

/**
 * 消费 SSE 流：逐行解析 data: 帧，JSON.parse 成功后交给 onEvent；
 * onEvent 返回 true 表示该帧为终止帧（done/error/result 等，各端点自行判定）。
 * 单帧解析失败跳过（缺终止帧会在收束处统一报 502，与原实现一致）。
 */
async function consumeSSE<T>(
  response: Response,
  emptyBodyMessage: string,
  onEvent: (event: T) => boolean,
  noTerminalMessage: string,
): Promise<void> {
  if (!response.body) throw new ApiError(emptyBodyMessage, response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  const processLine = (raw: string) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let event: T;
    try { event = JSON.parse(payload) as T; }
    catch { return; /* 仅跳过损坏的 JSON；业务回调异常必须传给调用方。 */ }
    terminal = onEvent(event);
  };
  try {
    while (!terminal) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) { processLine(line); if (terminal) break; }
    }
    if (!terminal) processLine(buffer + decoder.decode());
    if (!terminal) throw new ApiError(noTerminalMessage, 502);
  } finally {
    try { await reader.cancel(); } catch { /* Preserve the original callback/stream error. */ }
    reader.releaseLock();
  }
}

export async function streamChat(
  request: {
    key: string;
    mode?: string;
    question: string;
    scope?: string;
    history?: Array<{ role: string; text: string }>;
    images?: string[];
    projectId?: string;
    projectTitle?: string;
    filePath?: string;
    source?: string;
  },
  onChunk: (chunk: ChatChunk) => void,
  signal?: AbortSignal,
  endpoint = '/v1/ai/chat',
): Promise<void> {
  const response = await fetchSSE(endpoint, request, signal);
  await consumeSSE<ChatChunk>(response, '接口没有返回流式内容。', (chunk) => {
    const terminal = Boolean(chunk.done || chunk.error);
    onChunk(chunk);
    return terminal;
  }, '连接中断，回答未完成，未保存。');
}

export async function streamLatexRealtime(
  projectId: string,
  onEvent: (event: RealtimeEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetchSSE(`/v1/latex/projects/${encodeURIComponent(projectId)}/realtime`, {}, signal);
  await consumeSSE<RealtimeEvent>(response, '实时预览没有返回数据', event => {
    onEvent(event);
    return 'event' in event && (event.event === 'ReadXStopped' || event.event === 'ReadXError');
  }, '实时预览连接已中断，请重试。');
}

export function streamLatexChat(
  request: { key: string; projectId: string; projectTitle: string; filePath: string; source: string; question: string; history?: Array<{ role: string; text: string }> },
  onChunk: (chunk: ChatChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamChat(request, onChunk, signal, '/v1/ai/latex-chat');
}

export function latexAIEdit(requestBody: {
  projectId: string;
  projectTitle: string;
  filePath: string;
  source: string;
  question: string;
}): Promise<{ summary: string; filePath: string; original: string; content: string }> {
  return request('/v1/ai/latex-edit', { method: 'POST', body: requestBody });
}

export function latexAIFix(requestBody: {
  projectId: string;
  projectTitle: string;
  filePath: string;
  source: string;
  diagnostics: LatexDiagnostic[];
  buildLog: string;
}): Promise<{ summary: string; content: string }> {
  return request('/v1/ai/latex-fix', { method: 'POST', body: requestBody });
}

/**
 * AI 直接写盘（会改源码）。
 *
 * 服务端会先打快照、写入、强制重新编译，再按「错误有没有减少」决定保留还是回滚；
 * 阶段变化与最终结果都通过 SSE 回来，界面据此逐步显示，而不是转圈等一个黑盒结果。
 * 编译日志在服务端脱敏后才发给模型（客户端无从绕过）。
 */
export async function streamLatexAutoFix(
  requestBody: { projectId: string; projectTitle: string; filePath: string; question?: string },
  onEvent: (event: LatexAutoFixEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetchSSE('/v1/ai/latex-autofix', requestBody, signal);
  await consumeSSE<LatexAutoFixEvent>(response, '自动修复服务没有返回流式内容。', (event) => {
    const terminal = Boolean(event.done || event.error);
    onEvent(event);
    return terminal;
  }, '自动修复连接中断，未确认结果。');
}

/** 使用已配置的助教模型分析 PPT 模板摘要，不附带论文正文。 */
export async function streamPresentationTheme(summary: string, onChunk: (chunk: ChatChunk) => void, signal?: AbortSignal): Promise<void> {
  const response = await fetchSSE('/v1/ai/presentation-theme', { summary }, signal);
  await consumeSSE<ChatChunk>(response, '模板分析服务没有返回流式内容。', (chunk) => {
    const terminal = Boolean(chunk.done || chunk.error);
    onChunk(chunk);
    return terminal;
  }, '模板分析连接中断。');
}

export interface PresentationPlanInput {
  paperKey: string;
  title: string;
  authors: string[];
  sections: { kind: 'motivation' | 'method' | 'experiment' | 'results' | 'reproduction'; label: string; content: string }[];
  visuals: { id: string; kind: string; page: number; caption: string; section: string; insight?: string }[];
  templateContext?: string;
}

/** Run the bundled baoyu-slide-deck skill through the configured AI provider. */
export async function streamPresentationPlan(input: PresentationPlanInput, onChunk: (chunk: ChatChunk) => void, signal?: AbortSignal): Promise<void> {
  const response = await fetchSSE('/v1/ai/presentation-plan', input, signal);
  await consumeSSE<ChatChunk>(response, 'baoyu-slide-deck 没有返回页面规划。', (chunk) => {
    const terminal = Boolean(chunk.done || chunk.error);
    onChunk(chunk);
    return terminal;
  }, 'baoyu-slide-deck 页面规划连接中断。');
}

export interface Annotation {
  locator?: AnnotationLocator;
  id: string;
  documentId: string;
  page: number | null;
  kind: 'highlight' | 'underline' | 'question' | string;
  quote: string;
  note: string;
  color: string;
  tags: string[];
  startOffset: number | null;
  endOffset: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationListResponse {
  key: string;
  annotations: Annotation[];
  total: number;
}

export interface LeeParagraph {
  index: number;
  text: string;
  box: [number, number, number, number];
  kind: string;
  role?: string;
  sourceOrder?: number;
  translatable: boolean;
}

export interface LeeVisualBlock {
  index: number;
  kind: 'table' | 'image' | 'formula';
  text: string;
  box: [number, number, number, number];
}

export interface LeeParagraphs {
  available: boolean;
  page: number;
  width: number;
  height: number;
  blocks: LeeParagraph[];
  visuals: LeeVisualBlock[];
}

export interface TranslatedPDFResponse {
  key: string;
  pages: number;
  blocks: number;
  skipped: number;
  overflow: number;
  collisions: number;
  failedMath: number;
  bytes: number;
  download: string;
}

export interface TranslationPreview {
  available: boolean;
  page: number;
  width?: number;
  height?: number;
  translatedBlocks?: number;
  totalBlocks?: number;
  blocks: { source: string; target: string; box: [number, number, number, number] }[];
}

export interface RenderStatus {
  available: boolean;
  error: string;
  ocrConfigured: boolean;
  ocrError: string;
}

export interface OCRSettings {
  provider: string;
  baseURL: string;
  model: string;
  configured: boolean;
  documentation?: string;
  providers?: Record<'paddle' | 'mineru', { baseURL: string; model: string; configured: boolean }>;
}

/** 导入任务的一个阶段（OCR / 翻译 / 渲染）。 */
export interface JobStage {
  key: 'ocr' | 'translate' | 'render' | string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | string;
  message: string;
  substage?: string;
  completed: number;
  total: number;
  unit?: string;
  resultCount?: number;
  resultUnit?: string;
}

export interface JobRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  pages: number;
  error?: string;
}

export interface DocumentJob {
  key: string;
  name: string;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted' | string;
  startedAt: string;
  updatedAt: string;
  error?: string;
  pages: number;
  stages: JobStage[];
  runs: JobRun[];
}

export interface DocumentProcessingJob extends DocumentJob {
  documentKey?: string;
}

export interface DocumentMeta {
  key: string;
  favorite: boolean;
  tags: string[];
  categories: string[];
  deleted: boolean;
  updatedAt: string;
}

export interface DocumentMetaResponse {
  meta: DocumentMeta[];
  total: number;
}

export interface Category {
  name: string;
  color: string;
  order: number;
}

export interface CategoryListResponse {
  categories: Category[];
  total: number;
}

export interface ReproductionTask {
  status: 'todo' | 'verified' | 'blocked' | string;
  note: string;
  updatedAt: string;
}

export interface ReproductionItem {
  finding: {
    k: string;
    v: string;
    page: number | null;
    excerpt: string | null;
  };
  assessment: string;
  action: string;
}

export interface ReproductionChecklist {
  key: string;
  revisions: Record<string, Record<string, ReproductionTask>>;
  analyses: Record<
    string,
    {
      resources: ReproductionItem[];
      environment: ReproductionItem[];
      cost: ReproductionItem[];
      missing: ReproductionItem[];
      risks: ReproductionItem[];
    }
  >;
  repoChecks: Record<string, ReproductionTask>;
}

export interface RepoCheck {
  path: string;
  kind: string;
  detail: string;
  line: number | null;
  id: string;
}

export interface TagListResponse {
  tags: string[];
  total: number;
}

/** 阅读日历：某天里的一篇论文（落在它最近一次被阅读的那天）。 */
export interface CalendarPaper {
  key: string;
  title: string;
  format: string;
  page?: number;
  updatedAt: string;
  hasReading?: boolean;
  hasAnnotation?: boolean;
}

export interface CalendarDay {
  date: string;
  count: number;
  papers: CalendarPaper[];
}

export interface CalendarResponse {
  days: CalendarDay[];
  totalPapers: number;
  /** 数据口径说明，直接展示给用户，避免误解为完整阅读历史。 */
  basis: string;
}

/** 图谱节点的三类实体：概念 / 方法 / 结论。 */
export type GraphNodeKind = 'concept' | 'method' | 'conclusion';

/** 一条关系的原文依据：论文 + 页码 + 逐字摘录（服务端已对正文核验过）。 */
export interface GraphEvidence {
  paperKey: string;
  paperTitle: string;
  page: number;
  excerpt: string;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: GraphNodeKind;
  docs: string[];
  /** 模型给出的同义写法；两个不同 label 靠别名相交被视为同一实体。 */
  aliases?: string[];
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  docs: string[];
  evidence: GraphEvidence[];
}

export interface GraphPaper {
  key: string;
  title: string;
  extractedAt: string;
  nodeCount: number;
  relationCount: number;
  dropped: number;
}

export interface KnowledgeGraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  papers: GraphPaper[];
  /** 有正文缓存的文档总数；papers 更少说明还有论文没抽取。 */
  totalDocuments: number;
}

export interface AnnotationRect { x: number; y: number; width: number; height: number }
export interface AnnotationLocator {
  kind: 'pdf' | 'epub';
  href?: string;
  blockStart?: number;
  blockEnd?: number;
  startOffset?: number;
  endOffset?: number;
  rects?: AnnotationRect[];
  noteRect?: AnnotationRect;
}
export interface EPUBSection {
  index: number;
  href: string;
  title: string;
  text: string;
  blocks: { kind: string; text?: string; src?: string; id?: string }[];
}
/**
 * LaTeX 工作区自己的模型渠道。
 *
 * 独立于全局设置：全局可能是一个只适合阅读/翻译的渠道（例如 Codex 桥），
 * 而 LaTeX 的写作助手需要在后台服务里真正可用。密钥仍然按「渠道|地址」隔离保存，
 * 这里只回状态，永远不回 Key。
 */
export interface LatexAISettings {
  followGlobal: boolean;
  provider: string;
  baseURL: string;
  model: string;
  reasoningEffort: string;
  keyConfigured: boolean;
  status: AIStatus;
}

export interface AISettings {
  provider: string;
  baseURL: string;
  model: string;
  reasoningEffort?: string;
  codexFastMode?: boolean;
  translationPreparation?: 'off' | 'artifacts_only' | 'terms' | 'terms+style' | 'editorial';
  keyConfigured: boolean;
  status: AIStatus;
  /** LaTeX 工作区的模型渠道状态（与全局分开）。 */
  latex?: LatexAISettings;
  cli: Record<string, boolean>;
  codex?: { available: boolean; authenticated: boolean; source: string; message: string };
  workbuddy?: { authenticated: boolean; nickname?: string; expiresAt?: number; login?: { state?: string; url?: string; pending: boolean; error?: string } };
}
export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  serviceTiers?: { id: string; name: string; description: string }[];
  isDefault: boolean;
}
export interface ImportedDocument {
  document?: import('@cbct/shared').DocumentSummary;
  name: string;
  existing: boolean;
  error?: string;
  warning?: string;
}
export interface DailyRecommendation {
  id: string;
  arxiv?: string;
  title: string;
  authors: string[];
  venue: string;
  year: number;
  published: string;
  doi: string;
  url: string;
  pdfUrl: string;
  abstract: string;
}
export interface DailyRecommendationRules {
  field: string;
  keywords: string[];
  exclude: string[];
  venues: string[];
  years: number;
}
export interface ResearchFeedItem { id: string; title: string; url: string; published: string; summary: string; source: string }
export interface ImportProgress {
  stage: string;
  message: string;
  name?: string;
  file?: number;
  files?: number;
  completed: number;
  total: number;
  /** 服务端为这次导入创建的任务键：前端据此轮询任务面板。 */
  jobKey?: string;
}
export interface ImportStreamEvent {
  progress?: ImportProgress;
  heartbeat?: boolean;
}

export interface ImportMetadataHint {
  localOnly?: boolean;
  title: string;
  author: string;
  authors?: string[];
  venue?: string;
  year?: number;
  doi: string;
  arxiv: string;
  firstPage: string;
  source?: string;
}

function uploadPublications(files: File[], signal?: AbortSignal, metadata?: ImportMetadataHint[], onProgress?: (event: ImportStreamEvent) => void, processingGrant?: string): Promise<{ results: ImportedDocument[] }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const { apiBase, token } = bootstrap();
    const data = new FormData();
    files.forEach(file => data.append('files', file));
    if (metadata) data.set('metadata', JSON.stringify(metadata));
    const xhr = new XMLHttpRequest();
    let offset = 0, buffer = '', settled = false;
    let result: { results: ImportedDocument[] } | undefined;
    const abort = () => xhr.abort();
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new ApiError('导入连接中断，未确认结果，请刷新书库查看。', 502));
    };
    const processLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const event = JSON.parse(line.slice(5).trim()) as ImportStreamEvent & { results?: ImportedDocument[]; error?: string };
      if (event.error) throw new ApiError(event.error, 502);
      if (event.results) result = { results: event.results };
      onProgress?.(event);
    };
    const read = (last = false) => {
      if (!xhr.getResponseHeader('Content-Type')?.includes('text/event-stream')) return;
      buffer += xhr.responseText.slice(offset);
      offset = xhr.responseText.length;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(processLine);
      if (last && buffer.trim()) { processLine(buffer); buffer = ''; }
    };
    xhr.open('POST', apiBase + '/v1/import/files');
    xhr.setRequestHeader('Accept', 'text/event-stream');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    if (processingGrant) xhr.setRequestHeader('X-ReadX-Processing-Grant', processingGrant);
    xhr.upload.onprogress = event => onProgress?.({ progress: { stage: 'upload', message: '正在上传文件与排版数据到本地服务', completed: event.loaded, total: event.lengthComputable ? event.total : 0 } });
    xhr.upload.onload = () => onProgress?.({ progress: { stage: 'upload', message: '上传已完成，等待本地服务检查文件', completed: 0, total: 0 } });
    xhr.onprogress = () => { try { read(); } catch (error) { finish(error); xhr.abort(); } };
    xhr.onload = () => {
      if (xhr.status === 428 && !processingGrant) {
        let challenge: ProcessingChallenge;
        try { challenge = JSON.parse(xhr.responseText) as ProcessingChallenge; } catch (error) { finish(error); return; }
        const headers = new Headers(); if (token) headers.set('Authorization', `Bearer ${token}`);
        void approveProcessingChallenge(challenge, apiBase, headers, signal).then(grant => {
          settled = true; signal?.removeEventListener('abort', abort);
          resolve(uploadPublications(files, signal, metadata, onProgress, grant));
        }).catch(finish);
        return;
      }
      try {
        if (xhr.status < 200 || xhr.status >= 300) {
          let message = `HTTP ${xhr.status}`;
          try { message = (JSON.parse(xhr.responseText) as ApiFailure).error || message; } catch { /* Preserve HTTP status. */ }
          throw new ApiError(message, xhr.status);
        }
        read(true);
        if (!xhr.getResponseHeader('Content-Type')?.includes('text/event-stream')) result = JSON.parse(xhr.responseText) as typeof result;
        finish();
      } catch (error) { finish(error); }
    };
    xhr.onerror = () => finish(new ApiError('本地服务连接中断，请刷新书库确认已导入的文件。', 0));
    xhr.onabort = () => finish(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(data);
  });
}
export interface ImportCandidate {
  title: string;
  doi: string;
  url: string;
  arxiv?: string;
  authors: string[];
  venue?: string;
  year?: number;
}
export interface ReadingLocation {
  kind: 'pdf' | 'epub';
  page?: number;
  href?: string;
  index?: number;
}

export interface ArxivDownloadProgress {
  message: string;
  received: number;
  total: number;
}

export async function authenticatedFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const { apiBase, token } = bootstrap();
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await processingFetch(apiBase + path, {
    ...init,
    headers,
    credentials: 'omit',
  });
  if (!response.ok) {
    const payload = (await response
      .json()
      .catch(() => null)) as ApiFailure | null;
    throw new ApiError(
      payload?.error ?? `HTTP ${response.status}`,
      response.status,
    );
  }
  return response;
}
export interface NewAnnotation {
  page: number | null;
  locator?: AnnotationLocator;
  kind: string;
  quote: string;
  note?: string;
  color?: string;
  tags?: string[];
}


export type CitationFormat = 'bibtex' | 'ris';

/** 一篇论文的条目类型判定结果（kind/field/basis 由服务端按会场名推断）。 */
export interface CitationPreviewItem {
  key: string;
  title: string;
  citeKey: string;
  kind: string;
  field: string;
  value: string;
  basis: string;
}

/** 导出前的预览：把「会写成什么」和「哪些字段是空的」在下载之前摊开。 */
export interface CitationPreview {
  format: string;
  count: number;
  skipped: number;
  items: CitationPreviewItem[];
  bases: { basis: string; count: number }[];
  warnings: string[];
}

export interface CitationExportResult {
  filename: string;
  exported: number;
  skipped: number;
}

/** 一条命中：片段拆成 before/match/after，界面只负责把 match 标黄，不需要解析标记。 */
export interface SearchHit {
  key: string;
  title: string;
  year: number;
  status: string;
  page: number;
  count: number;
  before: string;
  match: string;
  after: string;
}

/**
 * 索引覆盖度。检索语料只有「导入过 OCR 正文」和「在阅读器里打开过并提取过正文」的页，
 * 所以未索引的论文数必须显示出来，不能让用户把「搜不到」当成「不存在」。
 */
export interface SearchCoverage {
  documents: number;
  indexedDocuments: number;
  unindexedDocuments: number;
  indexedPages: number;
  trashedDocuments: number;
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  matches: number;
  documents: number;
  truncated: boolean;
  coverage: SearchCoverage;
}

/** 一个阶段的耗时汇总。PerPageMs 只在有页数可摊时给出，缺省表示无法摊派。 */
export interface StageStats {
  key: string;
  label: string;
  runs: number;
  totalMs: number;
  medianMs: number;
  maxMs: number;
  perPageMs?: number;
}

export interface NamedCount {
  name: string;
  count: number;
}

/**
 * 书库与阅读统计。
 *
 * 这里没有「读了多久」：页面停留时长需要前台心跳，当前没有采集。
 * 处理耗时来自任务阶段自己盖的时间戳，老任务缺时间戳的会单独计数（missingStageTiming）。
 */
export interface StatsResponse {
  library: {
    total: number;
    active: number;
    queue: number;
    reading: number;
    done: number;
    archive: number;
    favorite: number;
    trashed: number;
    shelves: number;
  };
  reading: {
    located: number;
    activeWeek: number;
    activeMonth: number;
    annotations: number;
    annotationsMonth: number;
    readingNotes: number;
    indexedDocuments: number;
    indexedPages: number;
  };
  processing: {
    jobs: number;
    runs: number;
    failedRuns: number;
    pages: number;
    stages: StageStats[];
    slowest: { key: string; title: string; stage: string; ms: number }[];
    missingStageTiming: number;
    totalRunMs: number;
    medianRunMs: number;
  };
  distribution: {
    years: NamedCount[];
    shelves: NamedCount[];
    tags: NamedCount[];
  };
  basis: string[];
}

/** /v1/trends 的条目：字段名沿用后端 Go 字段（该结构没有 JSON tag）。 */
export interface TrendFinding {
  Topic: string;
  Count: number;
  IsSupported: boolean;
  Claim: string;
  Caveat: string;
  Evidence?: { category: string; value: string; evidence?: string }[];
}

export interface TrendsResponse {
  sample: { papers: string[]; count: number };
  findings: TrendFinding[];
  coverage: { Category: string; Count: number }[];
  minimum: number;
}

/** 库内引用关系的一条边。relation：reference = 本文引用了它，citation = 它引用了本文。 */
export interface CitationEdge {
  key: string;
  title: string;
  year: number;
  doi: string;
  relation: 'reference' | 'citation';
}

export interface CitationNetworkResponse {
  key: string;
  title: string;
  doi: string;
  available: boolean;
  openAlexId?: string;
  fetchedAt?: string;
  fromCache: boolean;
  inLibrary: CitationEdge[];
  external: { title: string; year: number; doi: string }[];
  counts: {
    references: number;
    citations: number;
    resolvedReferences: number;
    inLibraryReferences: number;
    inLibraryCitations: number;
  };
  disclosure: string[];
}

export const api = {
  syncSettings: (signal?: AbortSignal) =>
    request<{ enabled: boolean; provider: 'folder' | 'jianguoyun'; folderPath: string; webdavUsername: string; lastSync: string }>('/v1/sync/settings', { signal }),
  saveSyncSettings: (settings: { provider: 'folder' | 'jianguoyun'; folderPath?: string; webdavUsername?: string }) =>
    request<{ enabled: boolean; provider: 'folder' | 'jianguoyun'; folderPath: string; webdavUsername: string; lastSync: string }>('/v1/sync/settings', {
      method: 'PUT', body: settings,
    }),
  syncNow: (credentials: { password?: string } = {}) =>
    request<{ synced: boolean; documents: number; annotations: number; readingPositions: number; lastSync: string }>('/v1/sync', { method: 'POST', body: credentials }),
  /** Legado 书源页面经本地 Go 服务抓取并校验公网 HTTPS 地址。 */
  fetchWebSourcePage: async (url: string, signal?: AbortSignal) => {
    const response = await authenticatedFetch(
      `/v1/books/fetch-web?mode=page&url=${encodeURIComponent(url)}`,
      { signal },
    );
    if (!response.ok) throw new Error(await response.text());
    return {
      bytes: await response.arrayBuffer(),
      contentType: response.headers.get('content-type') ?? '',
    };
  },
  fetchWebSourceImage: async (url: string, signal?: AbortSignal) => {
    const response = await authenticatedFetch(
      `/v1/books/fetch-web?mode=image&url=${encodeURIComponent(url)}`,
      { signal },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.blob();
  },
  settings: () => request<AISettings>('/v1/ai/settings'),
  saveSettings: (body: {
    provider: string;
    baseURL: string;
    model: string;
    reasoningEffort?: string;
    codexFastMode?: boolean;
    translationPreparation?: 'off' | 'artifacts_only' | 'terms' | 'terms+style' | 'editorial';
    apiKey?: string;
    clearKey?: boolean;
  }) => request<AISettings>('/v1/ai/settings', { method: 'PUT', body }),
  /** LaTeX 工作区的模型渠道（与全局分开；followGlobal=true 表示跟随全局）。 */
  latexAISettings: () => request<LatexAISettings>('/v1/ai/latex-settings'),
  saveLatexAISettings: (body: {
    followGlobal: boolean;
    provider?: string;
    baseURL?: string;
    model?: string;
    reasoningEffort?: string;
    apiKey?: string;
  }) => request<LatexAISettings>('/v1/ai/latex-settings', { method: 'PUT', body }),
  testAI: () =>
    request<{ ok: boolean; answer: string }>('/v1/ai/test', {
      method: 'POST',
      body: {},
    }),
  /** 读取当前地址可用的模型列表：Key 可传刚输入的（未保存也能先看），否则用该地址已保存的。 */
  listModels: (body: { provider: string; baseURL: string; apiKey?: string; refresh?: boolean }) =>
    request<{ models: string[]; catalog?: CodexModel[]; source?: string; notice?: string }>('/v1/ai/models', { method: 'POST', body }),
  workbuddyLogin: () => request<{ state: string; url: string; pending: boolean }>('/v1/ai/workbuddy/login', { method: 'POST', body: {} }),
  workbuddyLoginStatus: () => request<{ authenticated: boolean; nickname?: string; expiresAt?: number; login?: { state?: string; url?: string; pending: boolean; error?: string } }>('/v1/ai/workbuddy/login'),
  workbuddyLogout: () => request<{ authenticated: boolean }>('/v1/ai/workbuddy/login', { method: 'DELETE' }),
  upload: uploadPublications,
  dailyRecommendations: (rules: DailyRecommendationRules, signal?: AbortSignal) => {
    const query = new URLSearchParams({
      field: rules.field,
      keywords: rules.keywords.join('\n'),
      exclude: rules.exclude.join('\n'),
      venues: rules.venues.join('\n'),
      years: String(rules.years),
    });
    return request<{ papers: DailyRecommendation[]; fetchedAt: string }>(`/v1/discovery/daily?${query}`, { signal });
  },
  researchFeed: (source: 'arxiv' | 'journals' | 'weekly', signal?: AbortSignal) =>
    request<{ items: ResearchFeedItem[]; fetchedAt: string }>(`/v1/discovery/feed?source=${source}`, { signal }),
  translateResearchTitle: (title: string, signal?: AbortSignal) =>
    request<{ translation: string }>('/v1/discovery/translate-title', { method: 'POST', body: { title }, signal }),
  downloadPublication: async (value: string, title: string | undefined, signal?: AbortSignal, onProgress?: (received: number, total: number) => void) => {
    const response = await authenticatedFetch('/v1/import/url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, title, downloadOnly: true }), signal,
    });
    const decode = (header: string) => decodeURIComponent((response.headers.get(header) ?? '').replace(/\+/g, ' '));
    const chunks: BlobPart[] = [];
    const total = Number(response.headers.get('Content-Length')) || 0;
    let received = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new ApiError('下载服务未返回论文文件', 502);
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk as BlobPart);
      received += chunk.byteLength;
      onProgress?.(received, total);
    }
    return { file: new File(chunks, decode('X-Publication-Name') || 'paper.pdf'), source: decode('X-Publication-Source') };
  },
  searchImport: (q: string, signal?: AbortSignal) =>
    request<{ results: ImportCandidate[] }>(
      `/v1/import/search?q=${encodeURIComponent(q)}`,
      { signal },
    ),
  attachArxivPDF: async (key: string, arxiv: string, signal?: AbortSignal, onProgress?: (progress: ArxivDownloadProgress) => void) => {
    const response = await authenticatedFetch(`/v1/documents/${encodeURIComponent(key)}/arxiv-pdf`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ arxiv }), signal,
    });
    let result: ImportedDocument | undefined;
    let streamError = '';
    await consumeSSE<{ progress?: ArxivDownloadProgress; result?: ImportedDocument; error?: string }>(
      response,
      'arXiv 下载服务没有返回进度流',
      (event) => {
        if (event.progress) onProgress?.(event.progress);
        if (event.result) result = event.result;
        if (event.error) streamError = event.error;
        return Boolean(event.result || event.error);
      },
      'arXiv 下载连接中断，未确认 PDF 已关联。',
    );
    if (streamError) throw new ApiError(streamError, 502);
    if (!result) throw new ApiError('arXiv 下载连接中断，未确认 PDF 已关联。', 502);
    return result;
  },
  file: async (key: string, signal?: AbortSignal) =>
    (
      await authenticatedFetch(
        `/v1/documents/${encodeURIComponent(key)}/file`,
        { signal },
      )
    ).arrayBuffer(),
  translatedFile: async (key: string, signal?: AbortSignal) =>
    (
      await authenticatedFetch(
        `/v1/documents/${encodeURIComponent(key)}/translated-pdf`,
        { signal },
      )
    ).arrayBuffer(),
  translatedRenderFile: async (key: string, page: number, signal?: AbortSignal) =>
    (
      await authenticatedFetch(
        `/v1/documents/${encodeURIComponent(key)}/pages/${page}/translated-render`,
        { signal },
      )
    ).arrayBuffer(),
  paragraphs: (key: string, page: number, signal?: AbortSignal) =>
    request<LeeParagraphs>(
      `/v1/documents/${encodeURIComponent(key)}/pages/${page}/paragraphs`,
      { signal },
    ),
  translationPreview: (key: string, page: number, signal?: AbortSignal) =>
    request<TranslationPreview>(
      `/v1/documents/${encodeURIComponent(key)}/pages/${page}/translation-preview`,
      { signal },
    ),
  retranslate: (key: string, signal?: AbortSignal) =>
    request<{ jobKey: string; status: string }>(
      `/v1/documents/${encodeURIComponent(key)}/retranslate`,
      { method: 'POST', signal },
    ),
  section: (key: string, index: number, signal?: AbortSignal) =>
    request<EPUBSection>(
      `/v1/documents/${encodeURIComponent(key)}/sections/${index}`,
      { signal },
    ),
  resource: async (key: string, path: string, signal?: AbortSignal) =>
    (
      await authenticatedFetch(
        `/v1/documents/${encodeURIComponent(key)}/resource?path=${encodeURIComponent(path)}`,
        { signal },
      )
    ).blob(),
  location: (key: string) =>
    request<{ location: ReadingLocation | null }>(
      `/v1/documents/${encodeURIComponent(key)}/location`,
    ),
  saveLocation: (key: string, location: ReadingLocation) =>
    request<{ saved: boolean }>(
      `/v1/documents/${encodeURIComponent(key)}/location`,
      { method: 'PUT', body: location },
    ),
  meta: (signal?: AbortSignal) => request<MetaResponse>('/v1/meta', { signal }),
  annotations: (key: string, signal?: AbortSignal) =>
    request<AnnotationListResponse>(
      `/v1/annotations/${encodeURIComponent(key)}`,
      { signal },
    ),
  createAnnotation: (key: string, body: NewAnnotation) =>
    request<Annotation>(`/v1/annotations/${encodeURIComponent(key)}`, {
      method: 'POST',
      body,
    }),
  patchAnnotation: (
    id: string,
    body: { note?: string; color?: string; kind?: string; tags?: string[]; noteRect?: AnnotationRect },
  ) =>
    request<{ id: string; updated: boolean }>(
      `/v1/annotation/${encodeURIComponent(id)}`,
      { method: 'PATCH', body },
    ),
  deleteAnnotation: (id: string) =>
    request<{ id: string; deleted: boolean }>(
      `/v1/annotation/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  /** 批注导出为 Markdown：走带 token 的 fetch 拿 blob，再由渲染进程触发下载（直链拿不到 token）。 */
  exportAnnotations: async (key: string): Promise<string> => {
    const { apiBase, token } = bootstrap();
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(
      `${apiBase}/v1/annotations/${encodeURIComponent(key)}/export`,
      {
        headers,
        credentials: 'omit',
      },
    );
    if (!response.ok) {
      const text = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as ApiFailure;
        if (isApiFailure(parsed)) message = parsed.error;
      } catch {
        /* 非 JSON 错误体：保留兜底文案 */
      }
      throw new ApiError(message, response.status);
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename =
      /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${key}-annotations.md`;
    const blob = await response.blob();
    downloadBlob(blob, filename);
    return filename;
  },
  readings: (key: string, signal?: AbortSignal) =>
    request<ReadingsResponse>(`/v1/readings/${encodeURIComponent(key)}`, {
      signal,
    }),
  /** 书目导出预览：条目类型是按会场名推断的，所以先让用户看清依据再下载。 */
  citationPreview: (
    params: { format: CitationFormat; keys?: string[]; category?: string },
    signal?: AbortSignal,
  ) =>
    request<CitationPreview>(
      `/v1/citations/preview${citationQuery(params)}`,
      { signal },
    ),
  /** 全库全文检索：逐字匹配逐页正文，覆盖度随结果一起返回。 */
  search: (query: string, signal?: AbortSignal) =>
    request<SearchResponse>(`/v1/search?q=${encodeURIComponent(query)}`, {
      signal,
    }),
  /** 下载书目文件（BibTeX / RIS）。跳过与导出的篇数从响应头读，界面如实提示。 */
  exportCitations: async (params: {
    format: CitationFormat;
    keys?: string[];
    category?: string;
  }): Promise<CitationExportResult> => {
    const { apiBase, token } = bootstrap();
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`${apiBase}/v1/citations${citationQuery(params)}`, {
      headers,
      credentials: 'omit',
    });
    if (!response.ok) {
      const text = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as ApiFailure;
        if (isApiFailure(parsed)) message = parsed.error;
      } catch {
        /* 非 JSON 错误体：保留兜底文案 */
      }
      throw new ApiError(message, response.status);
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename =
      /filename="([^"]+)"/.exec(disposition)?.[1] ??
      `readx-citations.${params.format === 'ris' ? 'ris' : 'bib'}`;
    const blob = await response.blob();
    downloadBlob(blob, filename);
    return {
      filename,
      exported: Number(response.headers.get('X-ReadX-Exported') ?? '0'),
      skipped: Number(response.headers.get('X-ReadX-Skipped') ?? '0'),
    };
  },
  /** 校验并返回 LeePDF 导入阶段生成的排版译文 PDF 信息。 */
  translatedPDF: (key: string, body: { pageCount: number }, signal?: AbortSignal) =>
    request<TranslatedPDFResponse>(`/v1/documents/${encodeURIComponent(key)}/translated-pdf`, {
      method: 'POST',
      body,
      signal,
    }),
  downloadTranslatedPDF: async (key: string, signal?: AbortSignal): Promise<Blob> => {
    const { apiBase, token } = bootstrap();
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`${apiBase}/v1/documents/${encodeURIComponent(key)}/translated-pdf`, {
      headers,
      signal,
      credentials: 'omit',
    });
    if (!response.ok) {
      const text = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as ApiFailure;
        if (isApiFailure(parsed)) message = parsed.error;
      } catch {
        /* 非 JSON 错误体：保留兜底文案 */
      }
      throw new ApiError(message, response.status);
    }
    return response.blob();
  },
  /** 全部文档的处理任务，包含尚未入库的上传任务。 */
  documentJobs: (signal?: AbortSignal) =>
    request<{ jobs: DocumentProcessingJob[] }>('/v1/document-jobs', { signal }),
  /** 这篇文档最近一次导入任务（OCR → 翻译 → 渲染），供任务进度面板轮询。 */
  documentJob: (key: string, signal?: AbortSignal) =>
    request<{ available: boolean; job?: DocumentJob }>(
      `/v1/documents/${encodeURIComponent(key)}/job`,
      { signal },
    ),
  cancelDocumentJob: (key: string, signal?: AbortSignal) =>
    request<{ cancelled: boolean }>(
      `/v1/documents/${encodeURIComponent(key)}/job/cancel`,
      { method: 'POST', signal },
    ),
  ocrSettings: (signal?: AbortSignal) => request<OCRSettings>('/v1/ocr/settings', { signal }),
  saveOCRSettings: (body: { provider?: 'paddle' | 'mineru'; token?: string; clearToken?: boolean; baseURL?: string; model?: string }, signal?: AbortSignal) =>
    request<OCRSettings>('/v1/ocr/settings', { method: 'PUT', body, signal }),
  comparisonExperimentJob: (key: string, signal?: AbortSignal) =>
    request<ComparisonExperimentJob>(`/v1/documents/${encodeURIComponent(key)}/comparison-experiment-job`, { signal }),
  startComparisonExperiment: (key: string) =>
    request<ComparisonExperimentJob>(`/v1/documents/${encodeURIComponent(key)}/comparison-experiment-job`, { method: 'POST' }),
  generate: async (
    key: string,
    kind: 'motivation' | 'method' | 'experiment' | 'results' | 'reproduction' | 'visuals',
    visuals: ReadingVisualReference[] = [],
    onProgress?: (progress: GenerateProgress) => void,
    signal?: AbortSignal,
    onEntry?: (kind: string, entry: ReadingEntry) => void,
    paper?: Omit<ReadingGenerationInput, 'visuals'>,
  ): Promise<GenerateResponse> => {
    // fetch 层的包装（abort 透传、本地服务未响应映射为 status 0）是该端点专属行为，保留；
    // 帧解析收敛进 consumeSSE。
    let response: Response;
    try {
      response = await fetchSSE('/v1/ai/generate', { key, kind, visuals, ...paper }, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof ApiError) throw error;
      throw new ApiError(error instanceof Error ? error.message : '本地服务未响应', 0);
    }
    let result: GenerateResponse | null = null;
    let streamError = '';
    await consumeSSE<{ progress?: GenerateProgress; result?: GenerateResponse; error?: string; entry?: ReadingEntry; kind?: string }>(
      response,
      '精读生成没有返回进度流。',
      (event) => {
        if (event.progress) onProgress?.(event.progress);
        if (event.entry && event.kind) onEntry?.(event.kind, event.entry);
        if (event.result) result = event.result;
        if (event.error) streamError = event.error;
        return Boolean(event.result || event.error);
      },
      '生成连接中断，精读结果未确认保存。',
    );
    if (streamError) throw new ApiError(streamError, 502);
    if (!result) throw new ApiError('生成连接中断，精读结果未确认保存。', 502);
    return result;
  },
  documents: (
    signal?: AbortSignal,
    filters?: { status?: string; q?: string },
  ) =>
    request<DocumentsResponse>(`/v1/documents${query(filters ?? {})}`, {
      signal,
    }),
  document: (key: string, signal?: AbortSignal) =>
    request<DocumentDetail>(`/v1/documents/${encodeURIComponent(key)}`, {
      signal,
    }),
  pages: (key: string, signal?: AbortSignal) =>
    request<PageListResponse>(
      `/v1/documents/${encodeURIComponent(key)}/pages`,
      { signal },
    ),
  page: (key: string, page: number, signal?: AbortSignal) =>
    request<PageText>(
      `/v1/documents/${encodeURIComponent(key)}/pages/${page}`,
      { signal },
    ),
  putPage: (key: string, page: number, text: string, signal?: AbortSignal) =>
    request<{ page: number; hash: string; chars: number }>(
      `/v1/documents/${encodeURIComponent(key)}/pages/${page}`,
      {
        method: 'PUT',
        body: { text },
        signal,
      },
    ),
  setStatus: (key: string, status: WireStatus) =>
    request<{ key: string; status: string }>(
      `/v1/documents/${encodeURIComponent(key)}/status`,
      {
        method: 'PATCH',
        body: { status },
      },
    ),
  documentsMeta: (signal?: AbortSignal) =>
    request<DocumentMetaResponse>('/v1/documents-meta', { signal }),
  emptyTrash: (keys: string[]) =>
    request<{ deletedKeys: string[]; libraryCopiesRemoved: number; originalFilesPreserved: boolean }>('/v1/trash/empty', {
      method: 'POST',
      body: { keys },
    }),
  patchDocumentMeta: (
    key: string,
    body: {
      favorite?: boolean;
      tags?: string[];
      categories?: string[];
      deleted?: boolean;
    },
  ) =>
    request<DocumentMeta>(`/v1/documents/${encodeURIComponent(key)}/meta`, {
      method: 'PATCH',
      body,
    }),
  categories: (signal?: AbortSignal) =>
    request<CategoryListResponse>('/v1/categories', { signal }),
  upsertCategory: (body: { name: string; color: string; order?: number }) =>
    request<{ categories: Category[]; updated: boolean }>('/v1/categories', {
      method: 'POST',
      body,
    }),
  deleteCategory: (name: string) =>
    request<{ categories: Category[]; deleted: boolean }>(
      `/v1/category/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),
  reproduction: (key: string, signal?: AbortSignal) =>
    request<{ key: string; checklist: ReproductionChecklist }>(
      `/v1/reproduction/${encodeURIComponent(key)}`,
      { signal },
    ),
  analyzeReproduction: (key: string, value: string) =>
    request<{
      ok: boolean;
      revision: string;
      groups: { id: string; label: string; count: number }[];
      unknownCount: number;
    }>(`/v1/reproduction/${encodeURIComponent(key)}/analyze`, {
      method: 'POST',
      body: { value },
    }),
  setReproductionTask: (
    key: string,
    body: { revision: string; itemId: string; status?: string; note?: string },
  ) =>
    request<{ ok: boolean; task: ReproductionTask }>(
      `/v1/reproduction/${encodeURIComponent(key)}/task`,
      { method: 'PATCH', body },
    ),
  repoChecks: (files: { path: string; lines: string[] }[]) =>
    request<{ ok: boolean; checks: RepoCheck[] }>(
      '/v1/reproduction/repo-checks',
      { method: 'POST', body: { files } },
    ),
  tags: (signal?: AbortSignal) =>
    request<TagListResponse>('/v1/tags', { signal }),
  duplicates: (signal?: AbortSignal) =>
    request<{
      groups: { primaryKey: string; keys: string[] }[];
      total: number;
    }>('/v1/duplicates', { signal }),
  graph: (signal?: AbortSignal) =>
    request<KnowledgeGraphResponse>('/v1/graph', { signal }),
  /** 阅读日历：按"每篇最近一次阅读"聚合，覆盖面见 basis。 */
  calendar: (signal?: AbortSignal) =>
    request<CalendarResponse>('/v1/calendar', { signal }),
  /** 书库与阅读统计（口径随响应一起返回，界面照实展示）。 */
  stats: (signal?: AbortSignal) =>
    request<StatsResponse>('/v1/stats', { signal }),
  /** 主题分布：按题录关键词聚合，样本不足时后端只报计数、不下判断。 */
  trends: (signal?: AbortSignal) =>
    request<TrendsResponse>('/v1/trends', { signal }),
  /** 库内引用关系（OpenAlex 元数据，缓存 7 天；refresh=true 强制重取）。 */
  citationNetwork: (key: string, refresh = false, signal?: AbortSignal) =>
    request<CitationNetworkResponse>(
      `/v1/documents/${encodeURIComponent(key)}/citations${refresh ? '?refresh=1' : ''}`,
      { signal },
    ),
  /** 对一篇论文跑图谱抽取；已有结果时 force=true 才会重新调模型。 */
  graphExtract: (key: string, force = false) =>
    request<{ skipped: boolean; paper: GraphPaper }>(
      '/v1/graph/extract',
      { method: 'POST', body: { key, force } },
    ),
  graphRemove: (key: string) =>
    request<{ key: string; deleted: boolean }>(
      `/v1/graph/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    ),

  // ---- LaTeX Studio：独立命名空间，与阅读/翻译接口互不影响 ----

  latexProjects: (signal?: AbortSignal) =>
    request<LatexProjectsResponse>('/v1/latex/projects', { signal }),
  latexCreateProject: (body: { title: string; engine: LatexEngine; mainFile?: string }) =>
    request<LatexProject>('/v1/latex/projects', { method: 'POST', body }),
  latexProject: (id: string, signal?: AbortSignal) =>
    request<LatexProject>(`/v1/latex/projects/${encodeURIComponent(id)}`, { signal }),
  latexUpdateProject: (
    id: string,
    patch: { title?: string; mainFile?: string; engine?: LatexEngine; autoCompile?: boolean },
  ) =>
    request<LatexProject>(`/v1/latex/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    }),
  latexDeleteProject: (id: string) =>
    request<{ deleted: boolean }>(`/v1/latex/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  latexDuplicateProject: (id: string) =>
    request<LatexProject>(`/v1/latex/projects/${encodeURIComponent(id)}/duplicate`, { method: 'POST' }),
  latexTree: (id: string, signal?: AbortSignal) =>
    request<LatexTreeResponse>(`/v1/latex/projects/${encodeURIComponent(id)}/tree`, { signal }),
  /** 项目索引：补全用的引用键/标签，以及「用了但没定义」的键。 */
  latexIndex: (id: string, signal?: AbortSignal) =>
    request<LatexIndexResponse>(`/v1/latex/projects/${encodeURIComponent(id)}/index`, { signal }),
  /** 读文本文件；二进制资源通过独立的 asset API 预览或下载。 */
  latexFile: (id: string, path: string, signal?: AbortSignal) =>
    request<LatexFileContent>(
      `/v1/latex/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
      { signal },
    ),
  latexAsset: async (id: string, path: string, signal?: AbortSignal): Promise<Blob> => {
    const response = await authenticatedFetch(
      `/v1/latex/projects/${encodeURIComponent(id)}/asset?path=${encodeURIComponent(path)}`,
      { signal },
    );
    return response.blob();
  },
  latexUploadAsset: async (id: string, path: string, file: File): Promise<void> => {
    await authenticatedFetch(
      `/v1/latex/projects/${encodeURIComponent(id)}/asset?path=${encodeURIComponent(path)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      },
    );
  },
  latexSaveFile: (id: string, path: string, content: string, revision: string) =>
    request<LatexSaveResponse>(
      `/v1/latex/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
      { method: 'PUT', body: { content, revision } },
    ),
  latexDeleteFile: (id: string, path: string) =>
    request<{ deleted: boolean }>(
      `/v1/latex/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' },
    ),
  latexFileOp: (id: string, op: LatexFileOp) =>
    request<{ ok: boolean }>(`/v1/latex/projects/${encodeURIComponent(id)}/file-ops`, {
      method: 'POST',
      body: op,
    }),
  /** 导入 ZIP：整个压缩包就是请求体（服务端自己卡条目数、体积、Zip Slip）。 */
  latexImportZip: async (id: string, file: File): Promise<LatexImportReport> => {
    const response = await authenticatedFetch(
      `/v1/latex/projects/${encodeURIComponent(id)}/import-zip`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      },
    );
    return (await response.json()) as LatexImportReport;
  },
  /** 导出源码 ZIP（排除编译副产物），直接触发浏览器下载。 */
  latexExportZip: async (id: string): Promise<string> => {
    const response = await authenticatedFetch(
      `/v1/latex/projects/${encodeURIComponent(id)}/export-zip`,
    );
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'readx-latex-project.zip';
    const blob = await response.blob();
    downloadBlob(blob, filename);
    return filename;
  },

  // ---- 编译（PR3）----

  /** 本机 TeX 工具链的真实状态；refresh=true 重新探测（装完 TeX 后不必重启应用）。 */
  latexToolchains: (refresh = false, signal?: AbortSignal) =>
    request<LatexToolchainReport>(`/v1/latex/toolchains${refresh ? '?refresh=1' : ''}`, { signal }),
  /** 发起一次编译；服务端异步执行，返回可轮询的记录。 */
  latexStartBuild: (id: string, body: { engine?: string; timeoutSeconds?: number } = {}) =>
    request<LatexBuild>(`/v1/latex/projects/${encodeURIComponent(id)}/builds`, {
      method: 'POST',
      body,
    }),
  latexBuilds: (id: string, signal?: AbortSignal) =>
    request<LatexBuildsResponse>(`/v1/latex/projects/${encodeURIComponent(id)}/builds`, { signal }),
  latexBuild: (buildId: string, signal?: AbortSignal) =>
    request<LatexBuild>(`/v1/latex/builds/${encodeURIComponent(buildId)}`, { signal }),
  latexBuildLog: (buildId: string) =>
    request<{ log: string }>(`/v1/latex/builds/${encodeURIComponent(buildId)}/log`),
  latexCancelBuild: (buildId: string) =>
    request<{ cancelled: boolean }>(`/v1/latex/builds/${encodeURIComponent(buildId)}/cancel`, {
      method: 'POST',
    }),
  /** 取编译产物的字节流：PDF.js 要数据，普通 URL 带不上 token。 */
  latexBuildPdf: async (buildId: string, signal?: AbortSignal): Promise<ArrayBuffer> => {
    const response = await authenticatedFetch(
      `/v1/latex/builds/${encodeURIComponent(buildId)}/pdf`,
      { signal },
    );
    return response.arrayBuffer();
  },

  // ---- 源码快照（AI 直接写盘的安全网）----

  latexSnapshots: (projectId: string, signal?: AbortSignal) =>
    request<LatexSnapshotsResponse>(
      `/v1/latex/projects/${encodeURIComponent(projectId)}/snapshots`,
      { signal },
    ),
  /** 手动打一份快照（AI 写盘前后端也会自动打）。 */
  latexCreateSnapshot: (projectId: string, note: string) =>
    request<LatexSnapshot>(`/v1/latex/projects/${encodeURIComponent(projectId)}/snapshots`, {
      method: 'POST',
      body: { note },
    }),
  /** 回滚：会把源码恢复到快照状态，之后新增的文件会被移除（报告里逐条列出）。 */
  latexRestoreSnapshot: (snapshotId: string) =>
    request<LatexRestoreReport>(`/v1/latex/snapshots/${encodeURIComponent(snapshotId)}`, {
      method: 'POST',
    }),
  /** 下载 PDF 到本地。 */
  latexDownloadPdf: async (buildId: string, filename: string): Promise<void> => {
    const response = await authenticatedFetch(
      `/v1/latex/builds/${encodeURIComponent(buildId)}/pdf?download=1`,
    );
    const blob = await response.blob();
    downloadBlob(blob, filename);
  },
};
