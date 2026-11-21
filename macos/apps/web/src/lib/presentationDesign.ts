import type { DocumentSummary } from '@cbct/shared';
import { READING_STEPS, readingStep, type ReadingKind } from './readingSteps';

export const SLIDE_WIDTH = 13.333333;
export const SLIDE_HEIGHT = 7.5;
export const TEXT_FONT = 'Microsoft YaHei';
export const NUMBER_FONT = 'Times New Roman';
export const NUMBER_PATTERN = /([0-9０-９⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]+(?:[.,][0-9]+)*(?:[eE][+-]?[0-9]+)?(?:%|°)?)/g;
export const LAYOUT_NAMES = { editorial: '重点解读', comparison: '对比分析', process: '方法流程', evidence: '图文证据', metrics: '数据聚焦', focus: '核心观点' } as const;
export type PresentationLayout = keyof typeof LAYOUT_NAMES;

export interface PresentationTheme {
  accent: string; accentDark: string; ink: string; muted: string; faint: string;
  line: string; paper: string; canvas: string; fontFace: string;
}
export const DEFAULT_PRESENTATION_THEME: PresentationTheme = {
  accent: '276653', accentDark: '173D32', ink: '21342C', muted: '65766D',
  faint: '87968D', line: 'DCE5DF', paper: 'FFFFFF', canvas: 'F4F7F3', fontFace: TEXT_FONT,
};

function luminance(hex: string) {
  const values = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return values[0]! * .2126 + values[1]! * .7152 + values[2]! * .0722;
}
function contrast(a: string, b: string) { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + .05) / (lo! + .05); }
export function readableTheme(input: PresentationTheme): PresentationTheme {
  const theme = { ...DEFAULT_PRESENTATION_THEME };
  for (const key of ['accent', 'accentDark', 'ink', 'muted', 'faint', 'line', 'paper', 'canvas'] as const) if (/^[\da-f]{6}$/i.test(input[key])) theme[key] = input[key];
  const foreground = contrast('21342C', theme.paper) >= contrast('FFFFFF', theme.paper) ? '21342C' : 'FFFFFF';
  if (contrast(theme.ink, theme.paper) < 4.5) theme.ink = foreground;
  if (contrast(theme.muted, theme.paper) < 3) theme.muted = foreground;
  if (contrast(theme.ink, theme.canvas) < 4.5) theme.canvas = theme.paper;
  if (contrast(theme.accent, theme.paper) < 3) theme.accent = foreground;
  // The cover uses white lettering even when an uploaded template is very pale.
  while (contrast('FFFFFF', theme.accentDark) < 4.5) theme.accentDark = [0, 2, 4].map((offset) => Math.floor(parseInt(theme.accentDark.slice(offset, offset + 2), 16) * .8).toString(16).padStart(2, '0')).join('');
  return theme;
}
export interface PlannedSlide {
  section: ReadingKind; title: string; bullets: string[];
  layout?: PresentationLayout; takeaway?: string; visualIds?: string[]; table?: DeckTable;
}
export interface PresentationPlan { slides: PlannedSlide[] }
export interface DeckVisual { id: string; section: ReadingKind; page: number; caption: string; imageURL: string; points: string[]; notes: string }
export interface DeckTable { header: string[]; rows: string[][] }
export interface DeckPage extends PlannedSlide { visual?: DeckVisual; table?: DeckTable; notes?: string }
interface Bounds { x: number; y: number; w: number; h: number }
export interface TextNode extends Bounds { kind: 'text'; text: string; lines: string[]; fontSize: number; bold: boolean; color: string; align: 'left' | 'center' | 'right'; lineHeight: number }
export interface RectNode extends Bounds { kind: 'rect'; color: string; radius?: number }
export interface LineNode { kind: 'line'; x: number; y: number; w: number; color: string; width: number }
export interface ImageNode extends Bounds { kind: 'image'; url: string; alt: string; visualId: string }
export interface TableNode extends Bounds { kind: 'table'; header: string[]; rows: string[][]; rowHeights: number[]; accent: string; headerInk: string; ink: string; line: string; canvas: string; paper: string; fontSize: number }
export type SlideNode = TextNode | RectNode | LineNode | ImageNode | TableNode;
export interface PresentationScene { id: string; title: string; label: string; section?: ReadingKind; background: string; nodes: SlideNode[]; notes: string }

export function normalizePlannedSlide(value: unknown, allowed: Set<ReadingKind>): PlannedSlide | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.section !== 'string' || !allowed.has(item.section as ReadingKind) || typeof item.title !== 'string' || !Array.isArray(item.bullets)) return null;
  const title = item.title.trim().slice(0, 160);
  const bullets = item.bullets.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean).slice(0, 6);
  if (!title || !bullets.length) return null;
  const layout = typeof item.layout === 'string' && Object.hasOwn(LAYOUT_NAMES, item.layout) ? item.layout as PresentationLayout : undefined;
  let table: DeckTable | undefined;
  if (item.table && typeof item.table === 'object') {
    const rawTable = item.table as Record<string, unknown>;
    if (Array.isArray(rawTable.header) && Array.isArray(rawTable.rows)) {
      const header = rawTable.header.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).slice(0, 5);
      const rows = rawTable.rows
        .filter((r): r is unknown[] => Array.isArray(r))
        .slice(0, 6)
        .map((r) => header.map((_, i) => (typeof r[i] === 'string' ? (r[i] as string).trim() : '—')));
      if (header.length >= 2 && rows.length >= 1) table = { header, rows };
    }
  }
  return { section: item.section as ReadingKind, title, bullets, layout,
    takeaway: typeof item.takeaway === 'string' ? item.takeaway.trim().slice(0, 240) : undefined,
    visualIds: Array.isArray(item.visualIds) ? item.visualIds.filter((v): v is string => typeof v === 'string').slice(0, 2) : [],
    table };
}

// The same measured text boxes feed the SVG preview and native PowerPoint text.
export function textUnits(value: string): number {
  return [...value].reduce((sum, char) => sum + (/\s/.test(char) ? .28 : /[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 1 : /[MW@%]/.test(char) ? .85 : /[il.,:;'!|]/.test(char) ? .3 : /[A-Z]/.test(char) ? .66 : .54), 0);
}
export function wrapSlideText(text: string, width: number, fontSize: number): string[] {
  const limit = width * 72 / fontSize * .93;
  return text.split('\n').flatMap((paragraph) => {
    const words = paragraph.match(/[A-Za-z0-9]+(?:[-'’.,][A-Za-z0-9]+)*|\s+|./gu) ?? [''];
    const lines: string[] = []; let line = '';
    for (const word of words) {
      if (line && textUnits(line + word) > limit) { lines.push(line.trim()); line = ''; }
      // Long URLs and identifiers must also stay within the text box.
      if (textUnits(word) > limit) {
        for (const char of word) {
          if (line && textUnits(line + char) > limit) { lines.push(line.trim()); line = ''; }
          line += char;
        }
      } else line += word;
    }
    if (line.trim() || !lines.length) lines.push(line.trim());
    return lines;
  });
}
function text(scene: PresentationScene, value: string, box: Bounds, size: number, color: string, bold = false, align: TextNode['align'] = 'left') {
  if (!value.trim()) return;
  let fontSize = size;
  let lines = wrapSlideText(value, box.w, fontSize);
  while (lines.length * fontSize / 72 * 1.18 > box.h && fontSize > 11) { fontSize -= .5; lines = wrapSlideText(value, box.w, fontSize); }
  scene.nodes.push({ kind: 'text', ...box, text: value, lines, fontSize, bold, color, align, lineHeight: fontSize / 72 * 1.18 });
}
function rect(scene: PresentationScene, x: number, y: number, w: number, h: number, color: string, radius = 0) { scene.nodes.push({ kind: 'rect', x, y, w, h, color, radius: radius || undefined }); }
function line(scene: PresentationScene, x: number, y: number, w: number, color: string, width = .7) { scene.nodes.push({ kind: 'line', x, y, w, color, width }); }
export function paginatePoints(points: string[], max = 3): string[][] {
  const fragments = points.flatMap((point) => {
    if (textUnits(point) <= 94) return [point];
    const result: string[] = []; let current = '';
    for (const phrase of point.match(/[^。！？；;]+[。！？；;]?/g) ?? [point]) {
      if (current && textUnits(current + phrase) > 94) { result.push(current); current = ''; }
      if (textUnits(phrase) > 94) {
        for (const part of wrapSlideText(phrase, 7.8, 12)) result.push(part);
      } else current += phrase;
    }
    if (current.trim()) result.push(current.trim());
    return result;
  });
  const pages: string[][] = []; let current: string[] = [];
  for (const point of fragments) {
    if (current.length && (current.length >= max || current.reduce((sum, p) => sum + textUnits(p), 0) + textUnits(point) > 180)) { pages.push(current); current = []; }
    current.push(point);
  }
  if (current.length) pages.push(current);
  return pages;
}

export function paginateTable(table: DeckTable): DeckTable[] {
  const result: DeckTable[] = [];
  for (let col = 1; col < Math.max(2, table.header.length); col += 4) {
    const columns = [0, ...Array.from({ length: Math.min(4, table.header.length - col) }, (_, i) => col + i)];
    const width = 11.97 / columns.length - .28;
    const header = columns.map((c) => table.header[c] ?? '');
    const headerH = Math.max(.62, ...header.map((cell) => wrapSlideText(cell, width, 14).length * 14 / 72 * 1.18 + .24));
    let rows: string[][] = [], height = headerH;
    for (const row of table.rows) {
      const cells = columns.map((c) => wrapSlideText(row[c] ?? '', width, 14));
      const maxLines = Math.max(1, Math.floor((4.2 - headerH - .24) / (14 / 72 * 1.18)));
      const slices = Math.ceil(Math.max(...cells.map((cell) => cell.length)) / maxLines);
      for (let part = 0; part < slices; part++) {
        const chunk = cells.map((cell, i) => part && i === 0 && cell.length <= maxLines ? cell.join('\n') : cell.slice(part * maxLines, (part + 1) * maxLines).join('\n'));
        const rowH = Math.max(.62, ...chunk.map((cell) => cell.split('\n').length * 14 / 72 * 1.18 + .24));
        if (rows.length && height + rowH > 4.3) { result.push({ header, rows }); rows = []; height = headerH; }
        rows.push(chunk); height += rowH;
      }
    }
    if (rows.length) result.push({ header, rows });
  }
  return result;
}
export function chooseLayout(page: PlannedSlide, index = 0): PresentationLayout {
  if (page.visualIds?.length) return 'evidence';
  if (page.bullets.length === 1) return 'focus';
  if (page.layout && page.layout !== 'evidence') return page.layout;
  if (page.section === 'method' && page.bullets.length >= 2) return 'process';
  if (page.section === 'results' && page.bullets.filter((p) => /\d+(?:\.\d+)?\s*(?:%|dB|ms|GB|倍)/i.test(p)).length >= 2) return 'metrics';
  if (page.bullets.length === 2 && page.section === 'motivation') return 'comparison';
  return index % 3 === 2 ? 'focus' : 'editorial';
}

/** 线性混色：ratio 是第一个颜色的权重，用于从主题色派生卡片底色。 */
function mix(hex: string, other: string, ratio: number): string {
  const blend = (a: string, b: string) => Math.round(parseInt(a, 16) * ratio + parseInt(b, 16) * (1 - ratio));
  return [0, 2, 4].map((offset) => blend(hex.slice(offset, offset + 2), other.slice(offset, offset + 2)).toString(16).padStart(2, '0')).join('');
}
function onAccent(theme: PresentationTheme): string {
  return contrast('FFFFFF', theme.accent) >= 4.5 ? 'FFFFFF' : '21342C';
}
/** 从主题派生的版面色板：卡片底色保证正文对比度，深色页文字统一为亮色。 */
interface DeckPalette { panel: string; panelLite: string; onDark: string; onDarkFaint: string }
function paletteOf(theme: PresentationTheme): DeckPalette {
  let panel = mix(theme.accent, theme.paper, .08);
  let panelLite = mix(theme.accent, theme.paper, .04);
  if (contrast(theme.ink, panel) < 4.2) panel = theme.canvas;
  if (contrast(theme.ink, panelLite) < 4.2) panelLite = theme.paper;
  return {
    panel, panelLite,
    onDark: mix('FFFFFF', theme.accentDark, .1),
    onDarkFaint: mix('FFFFFF', theme.accentDark, .32),
  };
}

function base(id: string, title: string, label: string, theme: PresentationTheme, section?: ReadingKind): PresentationScene {
  return { id, title, label, section, background: theme.paper, nodes: [], notes: '' };
}
function frame(scene: PresentationScene, theme: PresentationTheme, page: number, total: number) {
  line(scene, .68, 6.98, 11.97, theme.line);
  text(scene, 'ReadX · 论文精读', { x: .68, y: 7.09, w: 3, h: .2 }, 9, theme.faint);
  text(scene, `${String(page).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, { x: 11.3, y: 7.06, w: 1.35, h: .22 }, 10, theme.faint, false, 'right');
}
/** 内容页页头：章节色签 + 大标题 + 短色条，取代旧版裸标题。 */
function headerBlock(scene: PresentationScene, title: string, chip: string, theme: PresentationTheme) {
  const chipW = textUnits(chip) * 10.5 / 72 + .38;
  rect(scene, .68, .46, chipW, .33, theme.accent, .07);
  text(scene, chip, { x: .68, y: .485, w: chipW, h: .26 }, 10.5, onAccent(theme), true, 'center');
  text(scene, title, { x: .68, y: .95, w: 11.97, h: .8 }, 27, theme.ink, true);
  rect(scene, .68, 1.82, .8, .05, theme.accent);
}
/** 底部要点色带：整页的视觉锚点，截断保证任何输入都放得下。 */
function takeawayBand(scene: PresentationScene, value: string | undefined, theme: PresentationTheme, palette: DeckPalette) {
  if (!value) return;
  rect(scene, .68, 6.28, 11.97, .58, palette.panel);
  rect(scene, .68, 6.28, .08, .58, theme.accent);
  text(scene, '核心要点', { x: .95, y: 6.38, w: 1.05, h: .3 }, 11, theme.accent, true);
  text(scene, value.length > 100 ? `${value.slice(0, 99)}…` : value, { x: 2.12, y: 6.36, w: 10.33, h: .44 }, 13.5, theme.ink, true);
}
/** 单文本要点：靠自动缩字兜底，两段式「引导词+正文」在密集内容下会互相挤占高度。 */
function point(scene: PresentationScene, value: string, x: number, y: number, w: number, h: number, theme: PresentationTheme, size = 21) {
  text(scene, value, { x, y, w, h }, size, theme.ink);
}

function contentScene(page: DeckPage, index: number, theme: PresentationTheme, palette: DeckPalette): PresentationScene {
  const layout = page.visual ? 'evidence' : chooseLayout(page, index);
  const scene = base(`content-${index}`, page.title, page.table ? '数据表格' : LAYOUT_NAMES[layout], theme, page.section);
  scene.notes = [page.notes, page.takeaway].filter(Boolean).join('\n\n');
  headerBlock(scene, page.title, readingStep(page.section).label, theme);
  const bullets = page.bullets;
  if (page.table) {
    const width = 11.97 / page.table.header.length - .28;
    const cells = [page.table.header, ...page.table.rows].map((row) => row.map((cell) => wrapSlideText(cell, width, 14).join('\n')));
    const rowHeights = cells.map((row) => Math.max(.62, ...row.map((cell) => cell.split('\n').length * 14 / 72 * 1.18 + .24)));
    scene.nodes.push({ kind: 'table', x: .68, y: 2.15, w: 11.97, h: rowHeights.reduce((a, b) => a + b, 0), header: cells[0]!, rows: cells.slice(1), rowHeights, fontSize: 14, accent: theme.accent, headerInk: onAccent(theme), ink: theme.ink, line: theme.line, canvas: theme.canvas, paper: theme.paper });
  } else if (page.visual) {
    const v = page.visual;
    rect(scene, .68, 2.05, 7.3, 4.01, theme.canvas, .12);
    scene.nodes.push({ kind: 'image', x: .88, y: 2.25, w: 6.9, h: 3.28, url: v.imageURL, alt: v.caption, visualId: v.id });
    text(scene, `Page ${v.page} · ${v.caption.length > 80 ? `${v.caption.slice(0, 79)}…` : v.caption}`, { x: .92, y: 5.6, w: 6.82, h: .4 }, 10.5, theme.muted);
    const points = bullets.length ? bullets : paginatePoints(v.points, 3).flat();
    const count = Math.min(points.length, 3);
    points.slice(0, 3).forEach((value, i) => {
      const rowY = 2.05 + i * (4.01 / Math.max(count, 1));
      text(scene, String(i + 1).padStart(2, '0'), { x: 8.3, y: rowY + .04, w: .5, h: .3 }, 13, theme.accent, true);
      point(scene, value, 8.86, rowY, 3.79, 4.01 / Math.max(count, 1) - .1, theme, 16);
    });
    takeawayBand(scene, page.takeaway, theme, palette);
  } else if (layout === 'process') {
    const count = Math.min(bullets.length, 4), gap = .3, width = (11.97 - (count - 1) * gap) / count;
    if (count > 1) line(scene, .68 + width, 2.75, 11.97 - width * 2, theme.line, 1.2);
    bullets.slice(0, 4).forEach((value, i) => {
      const x = .68 + i * (width + gap);
      rect(scene, x, 2.05, width, 3.6, palette.panel, .14);
      text(scene, String(i + 1).padStart(2, '0'), { x: x + .26, y: 2.29, w: width - .52, h: .55 }, 26, theme.accent, true);
      point(scene, value, x + .26, 2.98, width - .52, 2.45, theme, 16);
    });
    takeawayBand(scene, page.takeaway, theme, palette);
  } else if (layout === 'comparison') {
    const columns = [bullets.filter((_, i) => i % 2 === 0), bullets.filter((_, i) => i % 2 === 1)];
    columns.forEach((values, i) => {
      const x = .68 + i * 6.11;
      rect(scene, x, 2.05, 5.86, 4.01, i ? palette.panel : palette.panelLite, .14);
      // A/B 标签与要点整组在面板内垂直居中，内容少时不会堆在顶部。
      const rows = Math.max(values.length, 1);
      const groupH = .95 + rows * 1.02;
      const top = 2.05 + (4.01 - groupH) / 2;
      rect(scene, x + .3, top + .31, .36, .36, theme.accent, .08);
      text(scene, i ? 'B' : 'A', { x: x + .3, y: top + .34, w: .36, h: .3 }, 13, onAccent(theme), true, 'center');
      values.slice(0, 3).forEach((value, j) => point(scene, value, x + .3, top + .93 + j * 1.02, 5.26, .98, theme, 17));
    });
    takeawayBand(scene, page.takeaway, theme, palette);
  } else if (layout === 'metrics' && bullets.filter((p) => /\d/.test(p)).length >= 2) {
    const count = Math.min(3, bullets.length), gap = .3, width = (11.97 - (count - 1) * gap) / count;
    bullets.slice(0, 3).forEach((value, i) => {
      const x = .68 + i * (width + gap);
      rect(scene, x, 2.05, width, 3.3, palette.panelLite, .14);
      const match = /[+-]?\d+(?:\.\d+)?\s*(?:%|dB|ms\b|GB\b|MB\b|倍|×)/i.exec(value) ?? /(?<![\w.])\d+\.\d+(?![\w.])/.exec(value) ?? /(?<![\w.])\d+(?![\w.])/.exec(value);
      text(scene, match?.[0] ?? String(i + 1), { x: x + .28, y: 2.35, w: width - .56, h: 1.05 }, 44, theme.accent, true);
      line(scene, x + .28, 3.62, .6, theme.accent, 1.6);
      point(scene, value, x + .28, 3.85, width - .56, 1.28, theme, 16);
    });
    takeawayBand(scene, page.takeaway, theme, palette);
  } else if (layout === 'focus') {
    rect(scene, .68, 2.05, 11.97, 3.5, palette.panel);
    rect(scene, .68, 2.05, .09, 3.5, theme.accent);
    text(scene, bullets[0] ?? '', { x: 1.12, y: 2.4, w: 10.9, h: 1.62 }, 27, theme.ink, true);
    bullets.slice(1, 3).forEach((value, i) => {
      text(scene, '—', { x: 1.12, y: 4.2 + i * .62, w: .3, h: .32 }, 14, theme.accent, true);
      text(scene, value, { x: 1.52, y: 4.14 + i * .62, w: 10.48, h: .58 }, 15, theme.muted);
    });
    takeawayBand(scene, page.takeaway, theme, palette);
  } else {
    rect(scene, .68, 2.05, 5.3, 4.01, palette.panel, .16);
    rect(scene, .98, 2.38, .4, .07, theme.accent);
    // 观点在面板内垂直居中：单行观点不会把面板留成上重下空。
    const lead = bullets[0] ?? '';
    const leadHeight = Math.min(3.1, Math.max(.8, wrapSlideText(lead, 4.7, 24).length * 24 / 72 * 1.18));
    text(scene, lead, { x: .98, y: 2.05 + (4.01 - leadHeight) / 2, w: 4.7, h: leadHeight }, 24, theme.ink, true);
    const rest = bullets.slice(1, 4);
    const rows = Math.max(rest.length, 1);
    const cardH = (4.01 - (rows - 1) * .22) / rows;
    rest.forEach((value, i) => {
      const y = 2.05 + i * (cardH + .22);
      rect(scene, 6.28, y, 6.37, cardH, palette.panelLite, .12);
      text(scene, String(i + 1).padStart(2, '0'), { x: 6.54, y: y + .16, w: .55, h: .3 }, 12, theme.accent, true);
      point(scene, value, 7.2, y + .14, 5.28, cardH - .3, theme, 16);
    });
    takeawayBand(scene, page.takeaway, theme, palette);
  }
  return scene;
}

/** 深色分隔页：封面—内容—分隔页—结尾页形成深浅节奏。 */
function dividerScene(step: { kind: ReadingKind; label: string }, index: number, firstTitle: string, theme: PresentationTheme, palette: DeckPalette): PresentationScene {
  const scene = base(`divider-${index}`, step.label, step.label, theme, step.kind);
  scene.background = theme.accentDark;
  rect(scene, 0, 0, .22, 7.5, theme.accent);
  text(scene, `SECTION ${String(index + 1).padStart(2, '0')}`, { x: .95, y: 2.0, w: 5, h: .3 }, 11, palette.onDarkFaint, true);
  text(scene, String(index + 1).padStart(2, '0'), { x: 8.6, y: 1.15, w: 4.05, h: 3.1 }, 150, mix('FFFFFF', theme.accentDark, .18), true, 'right');
  text(scene, step.label, { x: .95, y: 2.5, w: 8, h: 1.0 }, 38, 'FFFFFF', true);
  rect(scene, .97, 3.68, 1.0, .08, theme.accent);
  text(scene, firstTitle.length > 60 ? `${firstTitle.slice(0, 59)}…` : firstTitle, { x: .95, y: 3.98, w: 8.5, h: .8 }, 15, palette.onDark);
  text(scene, 'ReadX', { x: .95, y: 6.95, w: 2, h: .25 }, 11, palette.onDarkFaint);
  return scene;
}

export function createDeckScenes(document: DocumentSummary | null | undefined, pages: DeckPage[], inputTheme = DEFAULT_PRESENTATION_THEME, includeSummary = true): PresentationScene[] {
  const theme = readableTheme(inputTheme);
  const palette = paletteOf(theme);
  const title = document?.title?.trim() || '论文精读报告';
  const cover = base('cover', title, '封面', theme);
  cover.background = theme.accentDark;
  rect(cover, 0, 0, .22, 7.5, theme.accent);
  rect(cover, 0, 6.55, 13.34, .95, mix(theme.accentDark, 'FFFFFF', .05));
  text(cover, 'READX · RESEARCH DECK', { x: .95, y: .78, w: 8, h: .3 }, 11, palette.onDarkFaint, true);
  text(cover, title, { x: .95, y: 1.7, w: 11.5, h: 2.9 }, title.length > 130 ? 34 : 40, 'FFFFFF', true);
  rect(cover, .97, 4.85, 1.15, .09, theme.accent);
  const meta = [document?.authors?.slice(0, 5).join(', '), document?.venue, document?.year].filter(Boolean).join(' · ');
  text(cover, (meta || '论文研读与学术汇报').slice(0, 140), { x: .95, y: 5.15, w: 11.6, h: .8 }, 14, palette.onDark);
  text(cover, 'ReadX 论文精读', { x: .95, y: 6.85, w: 4, h: .28 }, 11, palette.onDarkFaint);
  // 年份大字落在底部横带右端，填补封面右下的空，也和分隔页的数字水印呼应。
  if (document?.year) text(cover, String(document.year), { x: 8.9, y: 6.22, w: 3.9, h: 1.26 }, 86, mix(theme.accentDark, 'FFFFFF', .22), true, 'right');
  const scenes: PresentationScene[] = [cover];
  const sections = READING_STEPS.filter((step) => pages.some((page) => page.section === step.kind));
  if (sections.length > 1) {
    const agenda = base('agenda', '研究脉络', '研究脉络', theme);
    headerBlock(agenda, '研究脉络', 'AGENDA', theme);
    const cardW = (11.97 - .3) / 2;
    const rows = Math.ceil(sections.length / 2);
    const cardH = Math.min(1.5, (4.01 - (rows - 1) * .24) / rows);
    sections.forEach((step, i) => {
      const x = .68 + (i % 2) * (cardW + .3), y = 2.05 + Math.floor(i / 2) * (cardH + .24);
      rect(agenda, x, y, cardW, cardH, palette.panelLite, .12);
      text(agenda, String(i + 1).padStart(2, '0'), { x: x + .28, y: y + .18, w: .8, h: .42 }, 20, theme.accent, true);
      text(agenda, step.label, { x: x + 1.08, y: y + .2, w: cardW - 1.32, h: .38 }, 17, theme.ink, true);
      const firstTitle = pages.find((page) => page.section === step.kind)?.title ?? '';
      text(agenda, firstTitle.length > 40 ? `${firstTitle.slice(0, 39)}…` : firstTitle, { x: x + 1.08, y: y + .62, w: cardW - 1.38, h: Math.max(.42, cardH - .72) }, 11.5, theme.muted);
    });
    scenes.push(agenda);
  }
  let lastSection: ReadingKind | null = null;
  pages.forEach((page, index) => {
    if (page.section !== lastSection) {
      lastSection = page.section;
      const sectionIndex = sections.findIndex((step) => step.kind === page.section);
      if (sectionIndex >= 0) scenes.push(dividerScene(sections[sectionIndex]!, sectionIndex, page.title, theme, palette));
    }
    scenes.push(contentScene(page, index, theme, palette));
  });
  if (pages.length && includeSummary) {
    const closing = base('summary', '研究总结', '研究总结', theme);
    closing.background = theme.accentDark;
    rect(closing, 0, 0, .22, 7.5, theme.accent);
    text(closing, 'READX · SUMMARY', { x: .95, y: .82, w: 5, h: .3 }, 11, palette.onDarkFaint, true);
    text(closing, '研究总结', { x: .95, y: 1.38, w: 8, h: .9 }, 34, 'FFFFFF', true);
    rect(closing, .97, 2.46, 1.0, .08, theme.accent);
    const summary = ['motivation', 'method', 'results'].flatMap((kind) => {
      const page = pages.find((p) => p.section === kind && !p.visual && !p.table);
      return page ? [{ kind: kind as ReadingKind, point: page.takeaway || page.bullets[0] || '' }] : [];
    });
    (summary.length ? summary : pages.slice(-2).map((page) => ({ kind: page.section, point: page.takeaway || page.bullets[0] || '' }))).slice(0, 3).forEach((item, i) => {
      const y = 2.9 + i * 1.15;
      text(closing, readingStep(item.kind).label, { x: .95, y: y + .06, w: 2.2, h: .35 }, 13, palette.onDark, true);
      text(closing, item.point, { x: 3.35, y, w: 9.3, h: 1.0 }, 19, 'FFFFFF');
    });
    text(closing, 'ReadX', { x: .95, y: 6.95, w: 2, h: .25 }, 11, palette.onDarkFaint);
    scenes.push(closing);
  }
  scenes.forEach((scene, index) => { if (index && scene.background === theme.paper) frame(scene, theme, index + 1, scenes.length); });
  return scenes;
}
