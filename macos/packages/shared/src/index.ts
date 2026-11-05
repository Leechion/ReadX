/**
 * v2 前后端共享契约。
 *
 * 这里每个字段的命名都必须与 Go 侧的 JSON tag 完全一致（internal/httpapi/server.go）；
 * 改名属于破坏性变更，需要同步改 Go、web、desktop 三处。
 */

/** server 打印到 stdout 的就绪行前缀，desktop 壳按它解析。 */
export const READY_PREFIX = 'CBCT_V2_READY ';

export * from './text.js';
export * from './annotate.js';

/** dev 模式下 server 写出的就绪文件，Vite proxy 靠它注入本地 token。 */
export const DEV_INFO_FILE = 'apps/server/dev-info.json';

export type DocumentStatus = 'queue' | 'reading' | 'done' | 'archive';

/** 后端状态值可能先于前端枚举演进（S1 之后会加分类），因此运行时按 string 收，展示时兜底。 */
export type WireStatus = DocumentStatus | (string & {});

export interface DocumentSummary {
  format?: 'pdf' | 'epub';
  hasPdf?: boolean;
  id: string;
  key: string;
  title: string;
  translatedTitle?: string;
  authors: string[];
  year: number | null;
  venue: string;
  doi: string;
  url: string;
  status: WireStatus;
  paperMemoryStatus?: string;
  paperMemoryMessage?: string;
  pdfPath: string;
  addedAt: string;
  updatedAt: string;
}

export interface DocumentsResponse {
  documents: DocumentSummary[];
  total: number;
}

export interface MetaResponse {
  app: string;
  version: string;
  dataRoot: string;
  dbPath: string;
  schemaVersion: number;
  startedAt: string;
  documentsTotal: number;
}

export interface HealthResponse {
  ok: boolean;
  schemaVersion: number;
}

export interface ApiFailure {
  error: string;
}

/** Electron preload 经 contextBridge 注入；纯浏览器 dev 模式下不存在，此时走 Vite proxy。 */
export interface BootstrapInfo {
  apiBase: string;
  token: string;
}

export function isApiFailure(value: unknown): value is ApiFailure {
  return typeof value === 'object' && value !== null && typeof (value as ApiFailure).error === 'string';
}

export function statusLabel(status: WireStatus): string {
  switch (status) {
    case 'queue':
      return '待读';
    case 'reading':
      return '在读';
    case 'done':
      return '已精读';
    case 'archive':
      return '归档';
    default:
      return String(status);
  }
}

/** 就绪信息的线上格式（Go: cmd/server/main.go emitReady）。 */
export interface ReadyInfo {
  port: number;
  host: string;
  token: string;
  dataRoot: string;
  dbPath: string;
  pid: number;
}

export interface PageSummary {
  page: number;
  chars: number;
  hash: string;
  updatedAt: string;
}

export interface PageText {
  page: number;
  text: string;
  chars: number;
  hash: string;
  updatedAt: string;
}

export interface PageListResponse {
  key: string;
  pages: PageSummary[];
  total: number;
}

/** 详情：documents 表的一行 + 逐页索引 + 已存精读产物（未解析时为 null）。 */
export interface DocumentDetail {
  sections?: { index: number; href: string; title: string }[];
  document: DocumentSummary;
  pages: PageSummary[];
  reading: Record<string, unknown> | null;
  hasPdf: boolean;
  hasText: boolean;
  fromOcr: boolean;
}

/** 一次「旧 JSON → SQLite」导入的结果。 */
export interface ImportReport {
  documentsAdded: number;
  documentsUpdated: number;
  documentsUnchanged: number;
  pagesImported: number;
  pagesUnchanged: number;
  textCaches: number;
  readingsImported: number;
  backupDir?: string;
  warnings: string[];
  startedAt: string;
  finishedAt: string;
}

declare global {
  interface Window {
    __CBCT_V2__?: BootstrapInfo;
    __READX_DESKTOP_UPDATES__?: DesktopUpdateBridge;
    __READX_SYNC__?: DesktopSyncBridge;
    __READX_BACKUP__?: DesktopBackupBridge;
    __READX_CAPTURE__?: { enable(): Promise<boolean> };
    __READX_LAUNCHER__?: DesktopLauncherBridge;
  }
}

export interface DesktopUpdateStatus {
  state: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'error' | 'unsupported' | 'unavailable';
  currentVersion?: string;
  version?: string;
  releaseNotes?: string;
  percent?: number;
  message?: string;
  operation?: 'check' | 'download' | 'install';
  installMode?: 'manual-dmg';
}

export interface DesktopUpdateBridge {
  getStatus(): Promise<DesktopUpdateStatus>;
  check(): Promise<DesktopUpdateStatus>;
  download(): Promise<DesktopUpdateStatus>;
  install(): Promise<DesktopUpdateStatus>;
  onStatus(callback: (status: DesktopUpdateStatus) => void): () => void;
}

export interface DesktopSyncBridge {
  chooseFolder(): Promise<string | null>;
  getNutstorePassword(): Promise<string>;
  setNutstorePassword(password: string): Promise<void>;
}

export interface DesktopBackupBridge {
  prepare(action: 'create' | 'restore'): Promise<boolean>;
  cancel(): Promise<void>;
  run(action: 'create' | 'restore', browserState: string): Promise<boolean>;
  pendingBrowserState(): Promise<string | null>;
  acknowledgeBrowserState(): Promise<void>;
}

export type LauncherWorkspace = 'library' | 'research' | 'presentation' | 'latex' | 'slack';
export interface LauncherTarget { workspace: LauncherWorkspace; id?: string }
export type LauncherOpenRequest = LauncherTarget & { nonce: number };
export interface LauncherProject { id: string; title: string; subtitle?: string }
export interface LauncherGroup {
  workspace: LauncherWorkspace;
  projects: LauncherProject[];
  error?: string;
}
export interface LauncherCatalog { current: LauncherWorkspace; groups: LauncherGroup[] }
export type LauncherEvent =
  | { type: 'show'; catalog: LauncherCatalog; x: number; y: number }
  | { type: 'catalog'; catalog: LauncherCatalog }
  | { type: 'pointer'; x: number; y: number }
  | { type: 'release'; x: number; y: number }
  | { type: 'hide' }
  | { type: 'wheel'; delta: number };
export interface DesktopLauncherBridge {
  ready(): void;
  publish(catalog: LauncherCatalog): void;
  activate(target: LauncherTarget): void;
  dismiss(): void;
  onEvent(callback: (event: LauncherEvent) => void): () => void;
  onRequestCatalog(callback: () => void): () => void;
  onNavigate(callback: (target: LauncherTarget) => void): () => void;
}

export * from './pdfLayout.js';

export * from './outline.js';

export * from './latex.js';

export * from './game2048.js';
