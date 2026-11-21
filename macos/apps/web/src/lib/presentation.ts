import type PptxGenJS from 'pptxgenjs';
import type { DocumentSummary } from '@cbct/shared';
import type { ReadingEntry, ReadingVisualAnalysis } from '../api/client';
import type { PaperVisual } from '../hooks/usePaperVisuals';
import { READING_STEPS, type ReadingKind, type ReadingStep } from './readingSteps';
import { createDeckScenes, paginatePoints, paginateTable, DEFAULT_PRESENTATION_THEME, TEXT_FONT, NUMBER_FONT, NUMBER_PATTERN, type DeckPage, type DeckVisual, type PresentationScene, type PresentationPlan, type PresentationTheme } from './presentationDesign';
export type { PresentationPlan, PresentationTheme } from './presentationDesign';

const MAX_BULLET_CHARS = 170;
type Slide = ReturnType<PptxGenJS['addSlide']>;
type TextRun = Exclude<Parameters<Slide['addText']>[0], string>[number];

function splitFontRuns(text: string): TextRun[] {
  return text.split(NUMBER_PATTERN).filter(Boolean).map((part) => ({ text: part, options: { fontFace: /^[0-9０-９⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/.test(part) ? NUMBER_FONT : TEXT_FONT } }));
}
export interface PresentationInput {
  document?: DocumentSummary | null;
  entries: Partial<Record<ReadingKind, ReadingEntry>>;
  analyses: ReadingVisualAnalysis[];
  visuals: PaperVisual[];
  theme?: PresentationTheme;
  plan?: PresentationPlan;
  /** Streamed previews contain only the pages actually planned so far. */
  plannedOnly?: boolean;
  signal?: AbortSignal;
}
export interface PresentationSummary { slides: number; figures: number; fileName: string }
interface DeckSection { title: string; body: string; status: 'ready' | 'partial' | 'reviewing' }
type BodyBlock = { kind: 'bullets'; items: string[] } | { kind: 'table'; header: string[]; rows: string[][] } | { kind: 'figure'; id: string };

/** The preview and the exported file consume this exact page list and geometry. */
export function buildReadingDeck(input: PresentationInput): PresentationScene[] {
  const pages: DeckPage[] = [];
  const visualById = new Map(input.visuals.filter((v) => v.imageURL && v.extractionStatus === 'ready' && v.reviewStatus !== 'needs-review').map((v) => [v.id, v]));
  const evidence = new Map<string, DeckVisual>();
  for (const analysis of input.analyses) {
    const visual = visualById.get(analysis.id);
    if (!visual?.imageURL) continue;
    evidence.set(analysis.id, { id: analysis.id, section: analysis.step, page: analysis.page, caption: analysis.caption, imageURL: visual.imageURL, points: figureBullets(analysis), notes: figureNotes(analysis) });
  }
  const used = new Set<string>();
  const addEvidence = (visual: DeckVisual, title?: string) => {
    if (used.has(visual.id)) return;
    used.add(visual.id);
    pages.push({ section: visual.section, title: title || truncate(visual.caption, 72) || '图表解读', bullets: paginatePoints(visual.points, 2)[0] ?? [], layout: 'evidence', visual, notes: visual.notes });
  };
  for (const step of READING_STEPS) {
    const entry = input.entries[step.kind];
    if (!entry) continue;
    const sections = sectionsFor(entry, step);
    const sourceNotes = sections.map((section) => `${section.title}\n${section.body}`).join('\n\n');
    const planned = input.plan?.slides.filter((slide) => slide.section === step.kind) ?? [];
    if (planned.length) {
      for (const spec of planned) {
        const linked = (spec.visualIds ?? []).map((id) => evidence.get(id)).filter((v): v is DeckVisual => Boolean(v && v.section === step.kind && !used.has(v.id)));
        const chunks = paginatePoints(spec.bullets.map((p) => latexToText(cleanInline(p))), linked.length ? 2 : spec.layout === 'process' ? 4 : 3);
        chunks.forEach((bullets, i) => {
          const visual = i === 0 ? linked[0] : undefined;
          if (visual) used.add(visual.id);
          pages.push({ ...spec, title: i ? `${spec.title}（续）` : spec.title, bullets, visualIds: visual ? [visual.id] : [], visual,
            notes: [sourceNotes, visual?.notes].filter(Boolean).join('\n\n') });
        });
        for (const visual of linked.slice(1)) addEvidence(visual);
      }
    } else if (!input.plannedOnly) {
      for (const section of sections) {
        for (const block of markdownBlocks(section.body)) {
          if (block.kind === 'bullets') {
            paginatePoints(block.items).forEach((bullets, i) => pages.push({ section: step.kind, title: i ? `${section.title}（续）` : section.title, bullets, notes: section.body }));
          } else if (block.kind === 'figure') {
            const visual = evidence.get(block.id);
            if (visual?.section === step.kind) addEvidence(visual);
          } else {
            for (const table of paginateTable(block)) pages.push({ section: step.kind, title: section.title, bullets: [], notes: section.body, table });
          }
        }
      }
    }
    if (!input.plannedOnly) for (const visual of evidence.values()) if (visual.section === step.kind) addEvidence(visual);
  }
  return createDeckScenes(input.document, pages, input.theme ?? DEFAULT_PRESENTATION_THEME, !input.plannedOnly);
}

/** Build fully editable native text, tables and original, proportionally fitted images. */
export async function generateReadingDeck(input: PresentationInput): Promise<PresentationSummary> {
  const scenes = buildReadingDeck(input);
  return exportScenesToPptx(scenes, input.document?.title || '论文精读报告', input.signal);
}

export interface ComparePresentationInput {
  documents: DocumentSummary[];
  entriesByKey: Record<string, Partial<Record<ReadingKind, ReadingEntry>>>;
  theme?: PresentationTheme;
  plan?: PresentationPlan;
  plannedOnly?: boolean;
  signal?: AbortSignal;
}

/** Multi-paper group-meeting comparison deck: builds preview scenes from AI plan or local readings. */
export function buildCompareDeck(input: ComparePresentationInput): PresentationScene[] {
  const pages: DeckPage[] = [];
  if (input.plan?.slides.length) {
    for (const spec of input.plan.slides) {
      const bullets = spec.bullets.map((p) => latexToText(cleanInline(p)));
      if (spec.table) {
        pages.push({ ...spec, bullets, table: spec.table });
      } else {
        paginatePoints(bullets, spec.layout === 'process' ? 4 : 3).forEach((chunk, i) => {
          pages.push({ ...spec, title: i ? `${spec.title}（续）` : spec.title, bullets: chunk });
        });
      }
    }
  } else if (!input.plannedOnly && input.documents.length >= 2) {
    pages.push({
      section: 'motivation',
      title: `对比范围：${input.documents.length} 篇文献概览`,
      layout: 'editorial',
      bullets: input.documents.map((doc) => `${doc.title || doc.key}${doc.year ? ` (${doc.year})` : ''}${doc.venue ? ` · ${doc.venue}` : ''}`).slice(0, 5),
      takeaway: '点击下方「生成多篇对比 PPT」可基于精读与全文生成完整组会汇报。',
    });
    const header = ['文献', '年份 / 会场', '精读已备章节'];
    const rows = input.documents.map((doc) => {
      const entries = input.entriesByKey[doc.key] ?? {};
      const ready = READING_STEPS.filter((step) => Boolean(entries[step.kind])).map((s) => s.label).join('、') || '正文已就绪';
      return [truncate(doc.title || doc.key, 36), [doc.year, doc.venue].filter(Boolean).join(' · ') || '—', ready];
    });
    pages.push({ section: 'experiment', title: '纳入对比的文献清单', bullets: [], table: { header, rows } });
  }
  const summaryDoc: DocumentSummary = {
    id: 'compare-deck',
    key: 'compare-deck',
    title: `组会多篇对比汇报（${input.documents.length} 篇）`,
    authors: input.documents.flatMap((d) => d.authors.slice(0, 1)).slice(0, 5),
    year: input.documents[0]?.year ?? null,
    venue: 'ReadX 多文献综述',
    doi: '',
    url: '',
    status: 'done',
    pdfPath: '',
    addedAt: '',
    updatedAt: '',
  };
  return createDeckScenes(summaryDoc, pages, input.theme ?? DEFAULT_PRESENTATION_THEME, !input.plannedOnly);
}

export async function generateCompareDeck(input: ComparePresentationInput): Promise<PresentationSummary> {
  const scenes = buildCompareDeck(input);
  return exportScenesToPptx(scenes, `组会多篇对比汇报（${input.documents.length} 篇）`, input.signal);
}

async function exportScenesToPptx(scenes: PresentationScene[], title: string, signal?: AbortSignal): Promise<PresentationSummary> {
  const { default: Pptx } = await import('pptxgenjs');
  const pptx = new Pptx();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'ReadX'; pptx.company = 'ReadX'; pptx.subject = '论文研究汇报';
  pptx.title = title;
  pptx.theme = { headFontFace: TEXT_FONT, bodyFontFace: TEXT_FONT };
  let figures = 0;
  const imageCache = new Map<string, Promise<string | null>>();
  for (const scene of scenes) {
    signal?.throwIfAborted();
    const slide = pptx.addSlide();
    slide.background = { color: scene.background };
    for (const node of scene.nodes) {
      if (node.kind === 'text') {
        slide.addText(splitFontRuns(node.lines.join('\n')), { x: node.x, y: node.y, w: node.w, h: node.h, fontSize: node.fontSize, fontFace: TEXT_FONT, bold: node.bold, color: node.color, align: node.align, valign: 'top', margin: 0, lineSpacingMultiple: 1.18, paraSpaceAfter: 0, fit: 'shrink' });
      } else if (node.kind === 'rect') {
        const box = { x: node.x, y: node.y, w: node.w, h: node.h, fill: { color: node.color }, line: { color: node.color, transparency: 100 } };
        if (node.radius) slide.addShape(pptx.ShapeType.roundRect, { ...box, rectRadius: node.radius });
        else slide.addShape(pptx.ShapeType.rect, box);
      } else if (node.kind === 'line') {
        slide.addShape(pptx.ShapeType.line, { x: node.x, y: node.y, w: node.w, h: 0, line: { color: node.color, width: node.width } });
      } else if (node.kind === 'table') {
        const table: Parameters<Slide['addTable']>[0] = [
          node.header.map((value) => ({ text: splitFontRuns(value), options: { bold: true, color: node.headerInk, fill: { color: node.accent } } })),
          ...node.rows.map((row, i) => row.map((value) => ({ text: splitFontRuns(value), options: { color: node.ink, fill: { color: i % 2 ? node.canvas : node.paper } } }))),
        ];
        slide.addTable(table, { x: node.x, y: node.y, w: node.w, h: node.h, colW: node.header.map(() => node.w / node.header.length), rowH: node.rowHeights, fontFace: TEXT_FONT, fontSize: node.fontSize, border: { type: 'solid', pt: .5, color: node.line }, margin: [.12, .14, .12, .14], valign: 'middle', autoPage: false });
      } else {
        let image = imageCache.get(node.url);
        if (!image) { image = loadImage(node.url); imageCache.set(node.url, image); }
        const data = await image;
        signal?.throwIfAborted();
        if (!data) throw new Error(`无法嵌入原图「${node.alt}」，请待图表加载完成后重试。`);
        const dimensions = await imageDimensions(data);
        const scale = Math.min(node.w / dimensions.width, node.h / dimensions.height);
        const w = dimensions.width * scale, h = dimensions.height * scale;
        slide.addImage({ data, x: node.x + (node.w - w) / 2, y: node.y + (node.h - h) / 2, w, h, altText: node.alt });
        figures++;
      }
    }
    if (scene.notes) slide.addNotes(scene.notes);
  }
  const fileName = `${safeFileName(title)} · ReadX.pptx`;
  signal?.throwIfAborted();
  await pptx.writeFile({ fileName });
  return { slides: scenes.length, figures, fileName };
}

function imageDimensions(data: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve({ width: image.naturalWidth, height: image.naturalHeight }) : reject(new Error('原图尺寸无效'));
    image.onerror = () => reject(new Error('无法读取图表原图尺寸'));
    image.src = data;
  });
}

function figureBullets(analysis: ReadingVisualAnalysis): string[] {
  const source = analysis.analysis?.trim() || analysis.observation?.trim() || '';
  if (!source) return [];
  return markdownBlocks(source).flatMap((block) => (block.kind === 'bullets' ? block.items : []));
}

function figureNotes(analysis: ReadingVisualAnalysis): string {
  return [
    analysis.caption,
    analysis.observation ? `图内观察：${analysis.observation}` : '',
    analysis.analysis ? `分析：${analysis.analysis}` : '',
    analysis.limitations ? `证据边界：${analysis.limitations}` : '',
    analysis.evidence ? `原文依据（Page ${analysis.evidence.page}）：${analysis.evidence.excerpt}` : '',
  ].filter(Boolean).join('\n\n');
}

function sectionsFor(entry: ReadingEntry, step: ReadingStep): DeckSection[] {
  const narrated = (entry.narrativeSections ?? []).filter((section) => section && typeof section.body === 'string' && section.body.trim());
  if (narrated.length) {
    return narrated.map((section) => ({ title: section.title?.trim() || step.label, body: section.body, status: section.status ?? 'ready' }));
  }
  if (entry.narrative?.trim()) return splitNarrative(entry.narrative, step.label);
  const structured = structuredSections(parseJSON(entry.value));
  if (structured.length) return structured;
  return entry.value.trim() ? splitNarrative(entry.value, step.label) : [];
}

function splitNarrative(markdown: string, fallbackTitle: string): DeckSection[] {
  const sections: DeckSection[] = [];
  let title = fallbackTitle;
  let body: string[] = [];
  const push = () => {
    const text = body.join('\n').trim();
    if (text) sections.push({ title, body: text, status: 'ready' });
    body = [];
  };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^#{2,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      push();
      title = cleanInline(heading[1] ?? fallbackTitle) || fallbackTitle;
      continue;
    }
    body.push(line);
  }
  push();
  return sections;
}

function markdownBlocks(markdown: string): BodyBlock[] {
  const blocks: BodyBlock[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let pending: string[] = [];
  const flush = () => {
    if (pending.length) blocks.push({ kind: 'bullets', items: pending });
    pending = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const token = /^\[\[visual:([^\]\n]+)\]\]$/.exec(line);
    if (token?.[1]) {
      flush();
      blocks.push({ kind: 'figure', id: token[1] });
      continue;
    }
    if (line.startsWith('|') && isTableSeparator(lines[index + 1])) {
      flush();
      const header = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
        rows.push(tableCells(lines[index] ?? ''));
        index += 1;
      }
      index -= 1;
      if (header.length && rows.length) blocks.push({ kind: 'table', header, rows });
      continue;
    }
    if (/^```/.test(line) || /^([-*_])\1{2,}$/.test(line)) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      pushBullet(pending, cleanInline(heading[1] ?? ''));
      continue;
    }
    const list = /^(?:[-*+]|\d+[.)、])\s+(.+)$/.exec(line);
    if (list) {
      pushBullet(pending, cleanInline(list[1] ?? ''));
      continue;
    }
    if (line.startsWith('>')) {
      pushSentences(pending, cleanInline(line.replace(/^>+\s?/, '')));
      continue;
    }
    pushSentences(pending, cleanInline(line));
  }
  flush();
  return blocks;
}

function isTableSeparator(line: string | undefined) {
  if (!line) return false;
  return /^\s*\|?[:\-\s|]*-[:\-\s|]*\|?\s*$/.test(line) && line.includes('|');
}

function tableCells(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => latexToText(cleanInline(cell)).replace(/\|/g, '/'));
}

function pushBullet(target: string[], text: string) {
  const value = latexToText(text);
  if (value) target.push(...chunkText(value, MAX_BULLET_CHARS));
}

function pushSentences(target: string[], text: string) {
  const value = latexToText(text);
  if (!value) return;
  for (const sentence of value.split(/(?<=[。！？；!?;])\s*/)) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    target.push(...chunkText(trimmed, MAX_BULLET_CHARS));
  }
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const part of text.split(/(?<=[，,、：:；;])\s*/)) {
    if (current && current.length + part.length > limit) {
      chunks.push(current.trim());
      current = '';
    }
    if (part.length > limit) {
      for (let index = 0; index < part.length; index += limit) chunks.push(part.slice(index, index + limit).trim());
      continue;
    }
    current += part;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function cleanInline(text: string): string {
  return text
    .replace(/\[\[visual:[^\]]+\]\]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/(\*\*)(.*?)\1/g, '$2')
    .replace(/\*([^*\s][^*]*?)\*/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const LATEX_SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς',
  tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
  equiv: '≡', sim: '∼', propto: '∝', infty: '∞', sum: 'Σ', prod: 'Π', int: '∫', partial: '∂', nabla: '∇',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', in: '∈', notin: '∉', subset: '⊂', supset: '⊃', cup: '∪', cap: '∩',
  forall: '∀', exists: '∃', emptyset: '∅', perp: '⊥', parallel: '∥', angle: '∠', circ: '∘', degree: '°', ldots: '…', dots: '…', cdots: '⋯',
  log: 'log', ln: 'ln', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan', max: 'max', min: 'min', argmax: 'arg max', argmin: 'arg min',
  operatorname: '', mathrm: '', mathbf: '', mathit: '', text: '', left: '', right: '', quad: ' ', qquad: ' ', displaystyle: '',
};

const SUBSCRIPTS: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', n: 'ₙ', i: 'ᵢ', j: 'ⱼ' };
const SUPERSCRIPTS: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };

function latexToText(source: string): string {
  const isLatex = /[$\\]/.test(source);
  let text = source;
  text = text.replace(/\$\$?/g, ' ').replace(/\\\[/g, ' ').replace(/\\\]/g, ' ').replace(/\\\(/g, ' ').replace(/\\\)/g, ' ');
  text = text.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
  text = text.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');
  text = text.replace(/\\(?:text|mathrm|mathbf|mathit|mathcal|mathbb|mathsf|boldsymbol|operatorname)\s*\{([^{}]*)\}/g, '$1');
  text = text.replace(/\\\|/g, '‖').replace(/\\(?:lVert|rVert)/g, '‖').replace(/\\(?:lvert|rvert)/g, '|');
  text = text.replace(/\\([{}])/g, '$1');
  text = text.replace(/\\([a-zA-Z]+)/g, (_, name: string) => LATEX_SYMBOLS[name] ?? name);
  text = text.replace(/[{}]/g, '');
  if (isLatex) {
    text = text.replace(/_([0-9+\-=()nij])/g, (_, value: string) => SUBSCRIPTS[value] ?? `_${value}`);
    text = text.replace(/\^([0-9+\-=()ni])/g, (_, value: string) => SUPERSCRIPTS[value] ?? `^${value}`);
  }
  text = text.replace(/\s+([，。；：、！？）】》])/g, '$1');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function parseJSON(text: string): unknown {
  let source = text.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    if (source.startsWith('```')) source = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      const value: unknown = JSON.parse(source);
      if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
        source = value;
        continue;
      }
      return value;
    } catch {
      return null;
    }
  }
  return null;
}

const GROUP_LABELS: Record<string, string> = {
  dataset: '数据集与划分', acquisition: '采集与几何', training: '训练', loss: '损失', baselines: '对比基线', metrics: '评价指标', results: '结果',
  tables: '结果表', stability: '稳定性', ablation: '消融实验', generalization: '泛化能力', efficiency: '效率', statistics: '统计报告', missing: '缺失与待核对',
  resources: '代码、数据与权重', environment: '环境与依赖', cost: '训练成本', risks: '风险与评测协议', formulas: '关键公式',
  finding: '论文依据', assessment: '分析与推断', action: '核对行动', interpretation: '结果解读', evidence: '证据',
};

function structuredSections(raw: unknown): DeckSection[] {
  if (!isRecord(raw)) return [];
  const sections: DeckSection[] = [];
  if (Array.isArray(raw.sections)) {
    for (const item of raw.sections) {
      if (!isRecord(item) || typeof item.title !== 'string') continue;
      const body = fieldListMarkdown(item.fields);
      if (body) sections.push({ title: item.title, body, status: 'ready' });
    }
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'sections' || key === 'formulas') continue;
    if (key === 'tables') {
      const body = resultsTablesMarkdown(value);
      if (body) sections.push({ title: '结果表', body, status: 'ready' });
      continue;
    }
    const body = valueMarkdown(value);
    if (body) sections.push({ title: GROUP_LABELS[key] ?? key, body, status: 'ready' });
  }
  if (Array.isArray(raw.formulas)) {
    const body = raw.formulas.flatMap((formula) => {
      if (!isRecord(formula) || typeof formula.latex !== 'string') return [];
      const page = typeof formula.page === 'number' ? `（Page ${formula.page}）` : '';
      return [`- $$ ${formula.latex} $$ ${typeof formula.explanation === 'string' ? formula.explanation : ''} ${page}`.trim()];
    }).join('\n');
    if (body) sections.push({ title: '关键公式', body, status: 'ready' });
  }
  return sections;
}

function fieldListMarkdown(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const key = typeof item.k === 'string' ? item.k : '';
    const text = typeof item.v === 'string' ? item.v : '';
    if (!key && !text) return [];
    const page = typeof item.page === 'number' ? `（Page ${item.page}）` : '';
    return [`- ${key ? `**${key}**：` : ''}${text}${page}`];
  }).join('\n');
}

function valueMarkdown(value: unknown, depth = 0): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      const body = valueMarkdown(item, depth + 1);
      if (!body) return '';
      return body.startsWith('- ') || body.startsWith('**') ? body : `- ${body}`;
    }).filter(Boolean).join('\n');
  }
  if (!isRecord(value)) return '';
  if (typeof value.k === 'string' && typeof value.v === 'string') {
    const page = typeof value.page === 'number' ? `（Page ${value.page}）` : '';
    return `- **${value.k}**：${value.v}${page}`;
  }
  const finding = valueMarkdown(value.finding, depth + 1).replace(/^-\s*/, '');
  if (finding && typeof value.assessment === 'string' && typeof value.action === 'string') {
    return `- **论文依据**：${finding}\n- **分析与推断**：${value.assessment}\n- **核对行动**：${value.action}`;
  }
  return Object.entries(value)
    .filter(([key]) => !['id', 'tableID', 'visualID', 'primaryMethodID'].includes(key))
    .map(([key, item]) => {
      const body = valueMarkdown(item, depth + 1);
      return body ? `**${GROUP_LABELS[key] ?? key}**\n${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function resultsTablesMarkdown(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((table) => {
    if (!isRecord(table)) return [];
    const columns = Array.isArray(table.columns) ? table.columns.filter(isRecord) : [];
    const rows = Array.isArray(table.rows) ? table.rows.filter(isRecord) : [];
    if (!columns.length || !rows.length) return [];
    const header = ['方法', ...columns.map((column) => (typeof column.label === 'string' ? column.label.replace(/\|/g, '/') : ''))];
    const body = rows.map((row) => {
      const cells = Array.isArray(row.cells) ? row.cells.filter(isRecord) : [];
      return [
        (typeof row.method === 'string' ? row.method : '').replace(/\|/g, '/'),
        ...columns.map((column) => {
          const cell = cells.find((item) => item.columnID === column.id);
          const text = cell && typeof cell.valueText === 'string' ? cell.valueText.replace(/\|/g, '/') : '—';
          const uncertainty = cell && typeof cell.uncertaintyText === 'string' ? ` ± ${cell.uncertaintyText.replace(/\|/g, '/')}` : '';
          return text + uncertainty;
        }),
      ];
    });
    return [
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...body.map((row) => `| ${row.join(' | ')} |`),
    ].join('\n');
  }).join('\n\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string, limit: number): string {
  const value = text.trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function safeFileName(text: string): string {
  return text.replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || '论文精读报告';
}

async function loadImage(url: string | null): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith('data:image/')) return url;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' && reader.result ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
