/**
 * localStorage 键的集中登记 + 唯一的兜底读写实现。
 *
 * 此前约 20 个键散落在 14 个文件里，三套命名（cbct-v2-* / cbct.* / readx-*）
 * 并存，「try { JSON.parse(localStorage.getItem(K) ?? 默认) } catch」样板逐字
 * 重复 7 份。本文件第一步先做**键名集中**：登记的是各键的现有名字（不改名、
 * 零迁移风险），各文件的局部常量改为引用这里；readJSON/writeJSON 提供唯一
 * 的损坏兜底，随各调用点逐步换用后，键名统一与旧键回退在此一处生效即可。
 */

/** 全部持久化键的登记处。新增键一律先在这里登记再使用。 */
export const STORAGE_KEYS = {
  workspaceMode: 'cbct-v2-workspace-mode',
  theme: 'cbct-v2-theme',
  libraryLayout: 'cbct-v2-library-layout',
  libraryGridDensity: 'cbct-v2-library-grid-density',
  libraryTable: 'cbct-v2-library-table',
  librarySidebarWidth: 'cbct-v2-library-sidebar-width',
  libraryDaily: 'cbct-v2-library-daily',
  dailyRecommendations: 'cbct-v2-daily-recommendations',
  dailyRecommendationRules: 'readx-daily-recommendation-rules',
  researchWorkbench: 'readx-research-workbench-v1',
  focusPendantPosition: 'readx-focus-pendant-left',
  compareSelection: 'readx.compare.selected',
  presentationTemplate: 'readx.presentation.active-template',
  readerPanels: 'cbct.reader.panels',
  readerLayout: 'cbct.reader.layout',
  listeningVoice: 'readx-listening-voice',
  latexTreeWidth: 'readx-latex-tree-width',
  latexDiagnosticsHidden: 'readx-latex-diagnostics-hidden',
  novelPrefs: 'readx-slack-novel-prefs',
  comicPrefs: 'readx-slack-comic-prefs',
  pendantPosition: 'readx-mode-pendant-left',
  slackWebSources: 'readx-slack-web-sources',
  slackStats: 'readx-slack-stats',
  game2048: 'readx-slack-2048',
  slackCountdown: 'readx-slack-countdown',
  slackCountdownOff: 'readx-slack-countdown-off',
  /** 动态键也集中生成，杜绝散落的字符串拼接。 */
  chatSessions: (scope: string) => `cbct.chat.v2:${scope}`,
  paperVisualSelections: (fingerprint: string) => `cbct-visual-selections:v1:${fingerprint}`,
  paperVisualIgnored: (fingerprint: string) => `cbct-visual-selections:v1:${fingerprint}:ignored`,
  paperVisualDetections: (fingerprint: string) => `cbct-visual-detections:${fingerprint}`,
} as const;

/** 读 JSON：损坏或 Storage 被禁用时回退默认值（原 7 份 try/catch 的唯一实现）。 */
export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 写 JSON：Storage 被禁用（隐私模式/配额满）时静默降级。 */
export function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 同上：不逐处抄这段 try/catch */
  }
}

export function readString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 同上 */
  }
}
