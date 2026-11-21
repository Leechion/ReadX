import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import JSZip from 'jszip';
import type { DocumentSummary, LauncherOpenRequest } from '@cbct/shared';
import { isSectionFormat } from '@cbct/shared';
import { api, streamPresentationComparePlan, streamPresentationPlan, streamPresentationTheme, type PresentationPlanInput, type ReadingEntry, type ReadingVisualAnalysis } from '../api/client';
import { usePDF } from './PDFView';
import { usePaperVisuals } from '../hooks/usePaperVisuals';
import { visualRevision } from '../lib/readingVisuals';
import { READING_STEPS, type ReadingKind } from '../lib/readingSteps';
import { buildCompareDeck, buildReadingDeck, generateCompareDeck, generateReadingDeck, type PresentationPlan, type PresentationTheme } from '../lib/presentation';
import { normalizePlannedSlide, DEFAULT_PRESENTATION_THEME } from '../lib/presentationDesign';
import { PresentationCanvas } from './PresentationCanvas';
import { listPresentationTemplates, savePresentationTemplate, type PresentationTemplateRecord } from '../lib/presentationTemplateLibrary';
import { STORAGE_KEYS } from '../lib/storage';

function savedEntries(raw: Record<string, unknown>) {
  const entries: Partial<Record<ReadingKind, ReadingEntry>> = {};
  for (const step of READING_STEPS) {
    const legacyKey = step.kind === 'experiment' ? 'experimentJSON' : step.kind === 'results' ? 'resultsJSON' : step.kind;
    const value = raw[step.kind] ?? raw[legacyKey];
    if (typeof value === 'string' && value.trim()) entries[step.kind] = { value, demoted: [], validationError: null, updatedAt: '' };
    else if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).value === 'string') {
      const item = value as Partial<ReadingEntry> & { value: string };
      entries[step.kind] = { ...item, value: item.value, demoted: Array.isArray(item.demoted) ? item.demoted : [], validationError: item.validationError ?? null, updatedAt: item.updatedAt ?? '' };
    }
  }
  return entries;
}

interface TemplateReference { id: string; name: string; summary: string; theme: PresentationTheme }

const DEFAULT_THEME = DEFAULT_PRESENTATION_THEME;
const COVER_COLORS = [['#e4eee9', '#477765'], ['#e9e8f2', '#69638e'], ['#f1e7dc', '#a16c42'], ['#e1ebef', '#4c7683'], ['#e9ece0', '#66774d']];

function themeColor(node: Element | null, fallback: string) {
  const rgb = node?.getElementsByTagNameNS('*', 'srgbClr')[0]?.getAttribute('val');
  const system = node?.getElementsByTagNameNS('*', 'sysClr')[0]?.getAttribute('lastClr');
  const value = (rgb || system || '').replace(/^#/, '');
  return /^[\da-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
}

function textContent(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return [...doc.getElementsByTagNameNS('*', 't')].map((node) => node.textContent?.trim()).filter(Boolean).join(' ');
}

function slideStructure(xml: string, widthEmu: number, heightEmu: number) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const shapes = [...doc.getElementsByTagNameNS('*', 'sp')];
  const regions = shapes.map((shape) => {
    const text = [...shape.getElementsByTagNameNS('*', 't')].map((node) => node.textContent?.trim()).filter(Boolean).join(' ');
    const transform = shape.getElementsByTagNameNS('*', 'xfrm')[0];
    const offset = transform?.getElementsByTagNameNS('*', 'off')[0];
    const y = Number(offset?.getAttribute('y') || 0) / heightEmu;
    const x = Number(offset?.getAttribute('x') || 0) / widthEmu;
    const region = y < 0.2 ? '页眉标题区' : y > 0.82 ? '页脚区' : x < 0.38 ? '左侧内容区' : x > 0.62 ? '右侧内容区' : '中央内容区';
    return { text: text.slice(0, 100), region };
  });
  const counts = new Map<string, number>();
  for (const item of regions) if (item.text) counts.set(item.region, (counts.get(item.region) ?? 0) + 1);
  const layout = [...counts.entries()].map(([region, count]) => `${region}${count}处`).join('、') || '以图形或图片为主';
  const examples = regions.filter((item) => item.text).slice(0, 3).map((item) => `${item.region}「${item.text}」`).join('；');
  const pictures = doc.getElementsByTagNameNS('*', 'pic').length;
  return `${shapes.length} 个文字/形状对象、${pictures} 张图片；布局分布：${layout}${examples ? `；示例：${examples}` : ''}`;
}

async function inspectTemplate(file: File): Promise<Omit<TemplateReference, 'id'>> {
  if (file.size > 80 * 1024 * 1024) throw new Error('模板文件不能超过 80 MiB。');
  const zip = await JSZip.loadAsync(file);
  const themeFile = zip.file('ppt/theme/theme1.xml');
  if (!themeFile) throw new Error('找不到 PowerPoint 主题文件，请上传 .pptx 格式模板。');
  const xml = new DOMParser().parseFromString(await themeFile.async('text'), 'application/xml');
  const scheme = xml.getElementsByTagNameNS('*', 'clrScheme')[0];
  const font = xml.getElementsByTagNameNS('*', 'majorFont')[0]?.getElementsByTagNameNS('*', 'latin')[0]?.getAttribute('typeface') || '';
  const slideSizeXML = await zip.file('ppt/presentation.xml')?.async('text');
  const slideSize = slideSizeXML ? new DOMParser().parseFromString(slideSizeXML, 'application/xml').getElementsByTagNameNS('*', 'sldSz')[0] : null;
  const widthEmu = Number(slideSize?.getAttribute('cx')) || 12192000;
  const heightEmu = Number(slideSize?.getAttribute('cy')) || 6858000;
  const accent = themeColor(scheme?.getElementsByTagNameNS('*', 'accent1')[0] ?? null, DEFAULT_THEME.accent);
  const dark = themeColor(scheme?.getElementsByTagNameNS('*', 'dk1')[0] ?? null, DEFAULT_THEME.accentDark);
  const ink = themeColor(scheme?.getElementsByTagNameNS('*', 'tx1')[0] ?? null, DEFAULT_THEME.ink);
  const paper = themeColor(scheme?.getElementsByTagNameNS('*', 'lt1')[0] ?? null, DEFAULT_THEME.paper);
  const slideFiles = Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path)).sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
  const examples: string[] = [];
  for (const path of slideFiles.slice(0, 8)) {
    const content = await zip.file(path)?.async('text');
    if (content) examples.push(`${path.split('/').pop()}: ${slideStructure(content, widthEmu, heightEmu)}；文本：${textContent(content).slice(0, 220)}`);
  }
  const theme: PresentationTheme = { ...DEFAULT_THEME, accent, accentDark: dark, ink, paper, fontFace: font };
  const summary = `主题色 #${accent}，深色 #${dark}，正文色 #${ink}，背景色 #${paper}，主字体 ${font || '未指定'}；共 ${slideFiles.length} 页。页面内容示例：${examples.filter(Boolean).join(' / ') || '模板未包含可提取的文本示例。'}`;
  return { name: file.name, summary, theme };
}

function learnedTheme(response: string, fallback: PresentationTheme): PresentationTheme {
  const json = firstJSONObject(response);
  if (!json) return fallback;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const color = (key: string, current: string) => typeof value[key] === 'string' && /^[\da-f]{6}$/i.test(value[key] as string) ? (value[key] as string).toUpperCase() : current;
    return { ...fallback, accent: color('accent', fallback.accent), accentDark: color('accentDark', fallback.accentDark), ink: color('ink', fallback.ink), paper: color('paper', fallback.paper), fontFace: typeof value.fontFace === 'string' ? value.fontFace.slice(0, 80) : fallback.fontFace };
  } catch { return fallback; }
}

function parsePresentationPlan(response: string, allowedSections: Set<ReadingKind>): PresentationPlan {
  const json = firstJSONObject(response);
  if (!json) throw new Error('AI 没有返回有效的 baoyu-slide-deck 页面规划。');
  let value: { slides?: unknown };
  try { value = JSON.parse(json) as { slides?: unknown }; }
  catch (cause) { throw new Error(`AI 页面规划 JSON 无法解析：${cause instanceof Error ? cause.message : String(cause)}`); }
  if (!Array.isArray(value.slides)) throw new Error('AI 页面规划缺少 slides 列表。');
  const slides: PresentationPlan['slides'] = [];
  for (const candidate of value.slides.slice(0, 20)) {
    const slide = normalizePlannedSlide(candidate, allowedSections);
    if (slide) slides.push(slide);
  }
  if (!slides.length) throw new Error('AI 页面规划没有可用的标题和要点。');
  return { slides };
}

function parsePartialPresentationPlan(response: string, allowedSections: Set<ReadingKind>): PresentationPlan {
  const match = /"slides"\s*:\s*\[/.exec(response);
  if (!match) return { slides: [] };
  const start = match.index + match[0].length;
  const slides: PresentationPlan['slides'] = [];
  let objectStart = -1, depth = 0, inString = false, escaped = false;
  for (let index = start; index < response.length; index++) {
    const char = response[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      if (depth === 0) objectStart = index;
      depth++;
    } else if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        try {
          const slide = normalizePlannedSlide(JSON.parse(response.slice(objectStart, index + 1)), allowedSections);
          if (slide) slides.push(slide);
        } catch { /* A partially streamed slide is not previewable until its JSON object closes. */ }
        objectStart = -1;
        if (slides.length >= 20) break;
      }
    } else if (char === ']' && depth === 0) break;
  }
  return { slides };
}

/** Parse only the first complete JSON object; ignore fences or model text after it. */
function firstJSONObject(source: string): string | null {
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

export function PresentationWorkspace({ documents, onBack, launchRequest }: { documents: DocumentSummary[]; onBack: () => void; launchRequest?: LauncherOpenRequest | null }) {
  const [deckMode, setDeckMode] = useState<'single' | 'compare'>('single');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<DocumentSummary | null>(null);
  const [compareSelection, setCompareSelection] = useState<string[]>([]);
  const [compareEntriesByKey, setCompareEntriesByKey] = useState<Record<string, Partial<Record<ReadingKind, ReadingEntry>>>>({});
  const [exporting, setExporting] = useState(false);
  const handledLaunch = useRef<number | null>(null);
  useEffect(() => {
    if (exporting || !launchRequest?.id || handledLaunch.current === launchRequest.nonce) return;
    const target = documents.find(doc => doc.id === launchRequest.id);
    if (target) { handledLaunch.current = launchRequest.nonce; setSelected(target); }
  }, [launchRequest, documents, exporting]);
  const [entries, setEntries] = useState<Partial<Record<ReadingKind, ReadingEntry>>>({});
  const [analyses, setAnalyses] = useState<ReadingVisualAnalysis[]>([]);
  const [loading, setLoading] = useState(false);
  const [readingError, setReadingError] = useState('');
  const [generationPhase, setGenerationPhase] = useState<'idle' | 'reading' | 'planning' | 'building' | 'complete' | 'error'>('idle');
  const [generationProgress, setGenerationProgress] = useState({ current: 0, total: 0 });
  const [livePlan, setLivePlan] = useState<PresentationPlan | null>(null);
  const [livePreviewIndex, setLivePreviewIndex] = useState(0);
  const [notice, setNotice] = useState('');
  const [template, setTemplate] = useState<TemplateReference | null>(null);
  const [templateLibrary, setTemplateLibrary] = useState<PresentationTemplateRecord[]>([]);
  const [activeTemplateId, setActiveTemplateId] = useState('');
  const [templateLibraryReady, setTemplateLibraryReady] = useState(false);
  const [templateReady, setTemplateReady] = useState(false);
  const [templateStatus, setTemplateStatus] = useState('');
  const [learning, setLearning] = useState(false);
  const visibleTemplateLibrary = templateLibrary.filter((item) => !item.builtin);
  const activeTemplateIsVisible = visibleTemplateLibrary.some((item) => item.id === activeTemplateId);
  const uploadRef = useRef<HTMLInputElement>(null);
  const generationAbort = useRef<AbortController | null>(null);
  const followLive = useRef(true);
  const thumbnailRef = useRef<HTMLElement>(null);
  useEffect(() => () => generationAbort.current?.abort(), []);
  const canLoadPDF = Boolean(selected && !isSectionFormat(selected.format) && (selected.hasPdf ?? Boolean(selected.pdfPath)));
  const pdf = usePDF(canLoadPDF ? selected!.key : null);
  const { visuals, progress: visualProgress, error: visualError } = usePaperVisuals(pdf.document, canLoadPDF, selected?.key);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let storageWarning = '';
      try {
        let records: PresentationTemplateRecord[] = [];
        try { records = await listPresentationTemplates(); }
        catch (cause) { storageWarning = cause instanceof Error ? cause.message : String(cause); }
        if (!records.some((item) => item.id === 'builtin-vit3-report-en')) {
          const response = await fetch('/ppt-templates/ViT3_Report_EN.pptx');
          if (!response.ok) throw new Error('无法读取内置 ViT3 模板文件。');
          const file = new File([await response.blob()], 'ViT3_Report_EN.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
          const reference = await inspectTemplate(file);
          const builtin: PresentationTemplateRecord = { ...reference, id: 'builtin-vit3-report-en', file, builtin: true, savedAt: new Date().toISOString() };
          try { await savePresentationTemplate(builtin); }
          catch (cause) { storageWarning ||= cause instanceof Error ? cause.message : String(cause); }
          records = [...records, builtin].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
        }
        if (cancelled) return;
        setTemplateLibrary(records);
        let rememberedId = '';
        try { rememberedId = localStorage.getItem(STORAGE_KEYS.presentationTemplate) ?? ''; } catch { /* Storage may be disabled. */ }
        const initial = records.find((item) => item.id === rememberedId) ?? records.find((item) => item.id === 'builtin-vit3-report-en') ?? records[0];
        if (initial) {
          setActiveTemplateId(initial.id);
          setTemplate({ id: initial.id, name: initial.name, summary: initial.summary, theme: initial.theme });
          setTemplateReady(true);
        }
        if (storageWarning) setTemplateStatus(`模板可以使用，但本机模板库暂时无法持久保存：${storageWarning}`);
        setTemplateLibraryReady(true);
      } catch (cause) {
        if (!cancelled) {
          setTemplateLibraryReady(true);
          setTemplateStatus(`模板库初始化失败：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selected) { setEntries({}); setAnalyses([]); setReadingError(''); setLoading(false); setGenerationPhase('idle'); setLivePlan(null); return; }
    const controller = new AbortController();
    setLoading(true); setEntries({}); setAnalyses([]); setReadingError(''); setNotice(''); setGenerationPhase('idle'); setGenerationProgress({ current: 0, total: 0 }); setLivePlan(null); setLivePreviewIndex(0);
    void api.readings(selected.key, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      const loaded = savedEntries(result.entries);
      const rawVisuals = result.entries.visualAnalysis as ReadingEntry | undefined;
      const all = [...Object.values(loaded).flatMap((entry) => entry?.visuals ?? []), ...(Array.isArray(rawVisuals?.visuals) ? rawVisuals.visuals : [])];
      setEntries(loaded);
      setAnalyses([...new Map(all.map((item) => [item.id, item])).values()]);
    }).catch((cause) => {
      if (!controller.signal.aborted) setReadingError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selected]);

  useEffect(() => {
    if (!selected || !template || !templateReady) return;
    const controller = new AbortController();
    let response = '';
    let streamError = '';
    let receivedThemeDeltas = false;
    setLearning(true); setTemplateStatus('AI 正在学习模板的配色、信息层级和版式…');
    void streamPresentationTheme(template.summary, (chunk) => {
      if (chunk.error) { response += chunk.partial || ''; streamError = chunk.error; }
      else if (chunk.delta !== undefined) { response += chunk.delta; receivedThemeDeltas = true; }
      else if (chunk.done && chunk.text !== undefined && !receivedThemeDeltas) response = chunk.text;
    }, controller.signal).then(() => {
      if (controller.signal.aborted) return;
      if (streamError) throw new Error(streamError);
      setTemplate((current) => current ? { ...current, theme: learnedTheme(response, current.theme) } : current);
      setTemplateStatus('');
    }).catch((cause) => {
      if (!controller.signal.aborted) setTemplateStatus(`模板已读取；AI 参考暂不可用：${cause instanceof Error ? cause.message : String(cause)}`);
    }).finally(() => { if (!controller.signal.aborted) setLearning(false); });
    return () => controller.abort();
  }, [selected?.key, template?.id, templateReady]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return documents.filter((doc) => !normalized || `${doc.title} ${doc.translatedTitle ?? ''} ${doc.authors.join(' ')}`.toLocaleLowerCase().includes(normalized));
  }, [documents, query]);
  const noteCount = Object.keys(entries).length;
  const readyAnalyses = useMemo(() => {
    if (!visuals.length) return analyses;
    const visualByID = new Map(visuals.map((visual) => [visual.id, visual]));
    return analyses.filter((analysis) => {
      const visual = visualByID.get(analysis.id);
      return !visual || (visual.reviewStatus !== 'needs-review' && visualRevision(visual) === analysis.revision && visual.caption === analysis.caption);
    });
  }, [analyses, visuals]);
  const compareDocs = useMemo(
    () => compareSelection.map((key) => documents.find((doc) => doc.key === key)).filter((doc): doc is DocumentSummary => Boolean(doc)),
    [compareSelection, documents],
  );
  useEffect(() => {
    if (deckMode !== 'compare' || !compareDocs.length) return;
    const controller = new AbortController();
    void Promise.all(
      compareDocs.map(async (doc) => {
        if (compareEntriesByKey[doc.key]) return;
        try {
          const res = await api.readings(doc.key, controller.signal);
          if (!controller.signal.aborted) {
            setCompareEntriesByKey((cur) => ({ ...cur, [doc.key]: savedEntries(res.entries) }));
          }
        } catch { /* fallback to empty entries */ }
      }),
    );
    return () => controller.abort();
  }, [compareDocs, compareEntriesByKey, deckMode]);

  const toggleCompareDoc = (doc: DocumentSummary) => {
    setCompareSelection((cur) => {
      if (cur.includes(doc.key)) return cur.filter((k) => k !== doc.key);
      if (cur.length >= 5) return cur;
      return [...cur, doc.key];
    });
    setLivePlan(null);
  };

  const scenes = useMemo(() => {
    if (deckMode === 'compare') {
      return compareDocs.length >= 2
        ? buildCompareDeck({ documents: compareDocs, entriesByKey: compareEntriesByKey, theme: template?.theme, plan: livePlan ?? undefined, plannedOnly: exporting })
        : [];
    }
    return selected ? buildReadingDeck({ document: selected, entries, analyses: readyAnalyses, visuals, theme: template?.theme, plan: livePlan ?? undefined, plannedOnly: exporting }) : [];
  }, [compareDocs, compareEntriesByKey, deckMode, selected, entries, readyAnalyses, visuals, template?.theme, livePlan, exporting]);
  const activeScene = scenes[Math.min(livePreviewIndex, Math.max(0, scenes.length - 1))];
  const generationStageLabel = generationPhase === 'reading' ? '通读全文' : generationPhase === 'planning' ? '设计页面' : generationPhase === 'building' ? '构建 PPT' : generationPhase === 'complete' ? '已生成' : generationPhase === 'error' ? '生成中断' : '准备就绪';
  const readingProgressPercent = generationProgress.total ? Math.round(generationProgress.current / generationProgress.total * 100) : 0;
  useEffect(() => {
    setLivePreviewIndex((current) => exporting && followLive.current ? Math.max(0, scenes.length - 1) : Math.min(current, Math.max(0, scenes.length - 1)));
  }, [scenes.length, exporting]);
  useEffect(() => {
    thumbnailRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [livePreviewIndex]);
  const selectPreview = (index: number) => { followLive.current = false; setLivePreviewIndex(index); };

  const uploadTemplate = async (file?: File) => {
    if (!file) return;
    setTemplateReady(false);
    setTemplateStatus('正在读取模板主题…');
    try {
      const reference = await inspectTemplate(file);
      const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const record: PresentationTemplateRecord = { ...reference, id, file, builtin: false, savedAt: new Date().toISOString() };
      let saved = true;
      let saveError = '';
      try { await savePresentationTemplate(record); }
      catch (cause) { saved = false; saveError = cause instanceof Error ? cause.message : String(cause); }
      setTemplate({ ...reference, id });
      setActiveTemplateId(id);
      setTemplateLibrary((current) => [...current.filter((item) => item.id !== id), record].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name)));
      if (saved) try { localStorage.setItem(STORAGE_KEYS.presentationTemplate, id); } catch { /* Storage may be disabled. */ }
      setTemplateReady(true);
      setTemplateStatus(saved ? '模板已保存到模板库，AI 将参考它的主题和版式。' : `模板已载入供本次生成使用，但未能保存到模板库：${saveError}`);
    } catch (cause) {
      setTemplate(null);
      setTemplateReady(false);
      setTemplateStatus(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const activateTemplate = (id: string) => {
    const item = templateLibrary.find((record) => record.id === id);
    if (!item) return;
    setActiveTemplateId(item.id);
    setTemplate({ id: item.id, name: item.name, summary: item.summary, theme: item.theme });
    setTemplateReady(true);
    setTemplateStatus(`已选择${item.builtin ? '内置模板' : '模板库模板'}「${item.name}」。`);
    try { localStorage.setItem(STORAGE_KEYS.presentationTemplate, item.id); } catch { /* Storage may be disabled. */ }
  };

  const generateCompare = async () => {
    if (compareDocs.length < 2 || exporting) return;
    const controller = new AbortController();
    generationAbort.current = controller; followLive.current = true;
    setExporting(true); setGenerationPhase('reading'); setGenerationProgress({ current: 0, total: 0 }); setLivePlan(null); setLivePreviewIndex(0);
    setNotice(`正在整理 ${compareDocs.length} 篇论文的精读与方法脉络…`);
    try {
      const allowedSections = new Set<ReadingKind>(READING_STEPS.map((s) => s.kind));
      let planText = '';
      let planError = '';
      let receivedPlanDeltas = false;
      await streamPresentationComparePlan(
        compareDocs.map((d) => d.key),
        template?.summary,
        (chunk) => {
          if (chunk.error) { planText += chunk.partial || ''; planError = chunk.error; }
          else if (chunk.progress) { setNotice(chunk.progress); setGenerationPhase('planning'); }
          else if (chunk.delta !== undefined) {
            planText += chunk.delta;
            receivedPlanDeltas = true;
            setGenerationPhase('planning');
            const partial = parsePartialPresentationPlan(planText, allowedSections);
            if (partial.slides.length) setLivePlan(partial);
          } else if (chunk.done && chunk.text !== undefined && !receivedPlanDeltas) planText = chunk.text;
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (planError) throw new Error(planError);
      const plan = parsePresentationPlan(planText, allowedSections);
      setLivePlan(plan);
      setGenerationPhase('building');
      setNotice('对比结构已规划完成，正在生成可编辑多篇对比 PPT…');
      const summary = await generateCompareDeck({ documents: compareDocs, entriesByKey: compareEntriesByKey, theme: template?.theme, plan, signal: controller.signal });
      setGenerationPhase('complete');
      setNotice(`多篇对比 PPT 已生成：${summary.slides} 页 · ${summary.fileName}`);
    } catch (cause) {
      if (controller.signal.aborted) { setGenerationPhase('idle'); setNotice('已停止生成，已完成的页面草稿仍可预览。'); return; }
      setGenerationPhase('error');
      setNotice(`多篇对比 PPT 生成失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { generationAbort.current = null; setExporting(false); }
  };

  const generate = async () => {
    if (!selected || exporting || loading || visualProgress || !noteCount) return;
    const controller = new AbortController();
    generationAbort.current = controller; followLive.current = true;
    setExporting(true); setGenerationPhase('reading'); setGenerationProgress({ current: 0, total: 0 }); setLivePlan(null); setLivePreviewIndex(0); setNotice('正在读取论文全文，为 PPT 整理研究脉络…');
    try {
      const planSections = READING_STEPS.flatMap((step) => {
        const entry = entries[step.kind];
        if (!entry) return [];
        const content = entry.narrativeSections?.map((section) => `## ${section.title}\n${section.body}`).join('\n\n') || entry.narrative || entry.value;
        return [{ kind: step.kind, label: step.label, content: content.slice(0, 8_000) }];
      }) as PresentationPlanInput['sections'];
      let planText = '';
      let planError = '';
      let receivedPlanDeltas = false;
      await streamPresentationPlan({
        paperKey: selected.key,
        title: selected.title || selected.translatedTitle || '论文精读报告',
        authors: selected.authors.slice(0, 10),
        sections: planSections,
        visuals: readyAnalyses.slice(0, 100).map((visual) => ({ id: visual.id, kind: visual.kind, page: visual.page, caption: visual.caption.slice(0, 300), section: visual.step, insight: (visual.analysis || visual.observation || '').slice(0, 700) })),
        templateContext: template?.summary,
      }, (chunk) => {
        if (chunk.error) { planText += chunk.partial || ''; planError = chunk.error; }
        else if (chunk.progress) {
          setNotice(chunk.progress);
          if (chunk.progress.startsWith('全文已读完')) setGenerationPhase('planning');
          else {
            setGenerationPhase('reading');
            const match = /第\s*(\d+)\s*\/\s*(\d+)\s*部分/.exec(chunk.progress);
            if (match) setGenerationProgress({ current: Number(match[1]), total: Number(match[2]) });
          }
        }
        else if (chunk.delta !== undefined) {
          planText += chunk.delta;
          receivedPlanDeltas = true;
          setGenerationPhase('planning');
          const partial = parsePartialPresentationPlan(planText, new Set(planSections.map((section) => section.kind)));
          if (partial.slides.length) {
            setLivePlan(partial);
          }
        }
        else if (chunk.done && chunk.text !== undefined && !receivedPlanDeltas) planText = chunk.text;
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (planError) throw new Error(planError);
      const plan = parsePresentationPlan(planText, new Set(planSections.map((section) => section.kind)));
      setLivePlan(plan);
      setGenerationPhase('building');
      setNotice('版式设计完成，正在嵌入原图并构建可编辑 PPT…');
      if (controller.signal.aborted) return;
      const summary = await generateReadingDeck({ document: selected, entries, analyses: readyAnalyses, visuals, theme: template?.theme, plan, signal: controller.signal });
      setGenerationPhase('complete');
      setNotice(`PPT 已生成：${summary.slides} 页${summary.figures ? `，含 ${summary.figures} 张图表` : ''} · ${summary.fileName}`);
    } catch (cause) {
      if (controller.signal.aborted) { setGenerationPhase('idle'); setNotice('已停止生成，已完成的页面草稿仍可预览。'); return; }
      setGenerationPhase('error');
      setNotice(`PPT 生成失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { generationAbort.current = null; setExporting(false); }
  };

  return <main className="presentation-workspace" aria-labelledby="presentation-workspace-title">
    <div className="presentation-studio">
      <header className="presentation-studio-header">
        <div className="presentation-studio-brand"><img className="presentation-brand-mark" src="/icon.svg" alt="" aria-hidden="true" /><div><p className="section-eyebrow">READX · PRESENTATION STUDIO</p><h1 id="presentation-workspace-title">论文演示稿</h1></div></div>
        <div className="presentation-header-actions">
          <input ref={uploadRef} type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" hidden onChange={(event) => { void uploadTemplate(event.target.files?.[0]); event.currentTarget.value = ''; }} />
          <label className="presentation-template-picker"><span>模板库</span><select value={activeTemplateIsVisible ? activeTemplateId : template && activeTemplateId !== 'builtin-vit3-report-en' ? activeTemplateId : ''} onChange={(event) => activateTemplate(event.target.value)} disabled={exporting || !templateLibraryReady || !templateLibrary.length || learning} aria-label="选择 PPT 模板">{!templateLibraryReady && <option value="">正在加载…</option>}{templateLibraryReady && !activeTemplateIsVisible && (!template || activeTemplateId === 'builtin-vit3-report-en') && <option value="">{activeTemplateId === 'builtin-vit3-report-en' ? '默认主题' : visibleTemplateLibrary.length ? '选择模板' : '模板库为空'}</option>}{template && activeTemplateId !== 'builtin-vit3-report-en' && !activeTemplateIsVisible && <option value={activeTemplateId}>{template.name} · 本次使用</option>}{visibleTemplateLibrary.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <button type="button" className={`presentation-template-button${template ? ' has-template' : ''}`} onClick={() => uploadRef.current?.click()} disabled={exporting || !templateLibraryReady || learning}><span aria-hidden="true">＋</span>{learning ? 'AI 正在学习' : template ? '上传到模板库' : '上传 PPT 模板'}</button>
          <button type="button" className="presentation-back-button" onClick={onBack}>返回书库</button>
        </div>
      </header>
      <div className="presentation-studio-main">
        <aside className="presentation-library-panel" aria-label="论文书库">
          <div className="presentation-library-heading"><div><span className="section-eyebrow">YOUR LIBRARY</span><h2>{deckMode === 'compare' ? '多篇组会对比 (2–5 篇)' : '选择论文'}</h2></div><span className="presentation-count">{deckMode === 'compare' ? `已选 ${compareDocs.length}/5` : `${filtered.length} 篇`}</span></div>
          <div className="presentation-mode-switch" role="group" aria-label="演示稿模式">
            <button type="button" className={deckMode === 'single' ? 'active' : ''} disabled={exporting} onClick={() => { setDeckMode('single'); setLivePlan(null); }}>单篇精讲</button>
            <button type="button" className={deckMode === 'compare' ? 'active' : ''} disabled={exporting} onClick={() => { setDeckMode('compare'); setLivePlan(null); }}>多篇对比</button>
          </div>
          <label className="presentation-picker-search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或作者" /></label>
          <div className="presentation-paper-grid" role="listbox" aria-label="选择论文" aria-multiselectable={deckMode === 'compare'}>
            {filtered.map((doc, index) => {
              const cover = COVER_COLORS[index % COVER_COLORS.length]!;
              const active = deckMode === 'compare' ? compareSelection.includes(doc.key) : selected?.key === doc.key;
              return <button type="button" role="option" aria-selected={active} key={doc.key} disabled={exporting} onClick={() => deckMode === 'compare' ? toggleCompareDoc(doc) : setSelected(doc)} className={`presentation-paper-card${active ? ' selected' : ''}`}>
                <span className="presentation-paper-cover" style={{ '--cover-bg': cover[0], '--cover-ink': cover[1] } as CSSProperties}><strong className="presentation-cover-title">{doc.title || doc.translatedTitle || '（无标题）'}</strong><span className="presentation-cover-lines" /><span className="presentation-cover-brand">{deckMode === 'compare' && active ? '✓ 已选对比' : 'READX · PAPER'}</span></span>
                <span className="presentation-paper-copy"><small>{doc.authors.slice(0, 1).join('') || '作者未知'}{doc.year ? ` · ${doc.year}` : ''}</small></span>
              </button>;
            })}
            {!filtered.length && <p className="presentation-picker-empty">{documents.length ? '没有匹配的论文。' : '书库里还没有可选择的论文。'}</p>}
          </div>
        </aside>
        <section className="presentation-preview-panel" aria-label="PPT 实时预览">
          <div className="presentation-preview-toolbar">
            <div><span className="section-eyebrow">SLIDE STUDIO</span><h2>{activeScene?.label || '演示稿预览'}</h2></div>
            <div className="presentation-preview-toolbar-right"><span className={`presentation-preview-state${exporting ? ' is-generating' : ''}`}><i />{generationStageLabel}</span><span className="presentation-page-count">{scenes.length ? `${livePreviewIndex + 1} / ${scenes.length}` : '16 : 9'}</span></div>
          </div>
          {templateStatus && <p className={`presentation-template-status${templateStatus.includes('失败') || templateStatus.includes('不可用') ? ' warning' : ''}`} role="status">{templateStatus}</p>}
          <div className="presentation-slide-stage presentation-scene-stage">
            {activeScene ? <PresentationCanvas scene={activeScene} /> : <div className="presentation-slide-welcome"><span>16:9</span><h3>把论文变成一场清晰的汇报</h3><p>选择论文，AI 将通读全文，编排观点、方法与图表。</p></div>}
          </div>
          {exporting && <div className="presentation-generation-track" role="status"><div className="presentation-generation-steps">{['通读全文', '设计页面', '构建 PPT'].map((label, i) => <span key={label} className={i === (generationPhase === 'reading' ? 0 : generationPhase === 'planning' ? 1 : 2) ? 'active' : ''}><b>{i + 1}</b>{label}</span>)}<button type="button" onClick={() => generationAbort.current?.abort()} disabled={generationPhase === 'building'}>停止</button></div><div className="presentation-generation-line"><span style={{ width: `${generationPhase === 'reading' ? Math.max(4, readingProgressPercent * .42) : generationPhase === 'planning' ? 48 : 92}%` }} /></div></div>}
          {scenes.length > 0 && <div className="presentation-deck-controls"><button type="button" aria-label="上一张幻灯片" disabled={livePreviewIndex === 0} onClick={() => selectPreview(livePreviewIndex - 1)}>←</button><span>{activeScene?.title}</span><button type="button" aria-label="下一张幻灯片" disabled={livePreviewIndex >= scenes.length - 1} onClick={() => selectPreview(livePreviewIndex + 1)}>→</button></div>}
          <nav ref={thumbnailRef} className="presentation-thumbnail-strip" aria-label="幻灯片预览">{scenes.map((scene, index) => <button key={scene.id} type="button" title={scene.title} aria-label={`第 ${index + 1} 页：${scene.title}`} aria-current={livePreviewIndex === index ? 'page' : undefined} className={livePreviewIndex === index ? 'active' : ''} onClick={() => selectPreview(index)}><PresentationCanvas scene={scene} thumbnail /><span>{String(index + 1).padStart(2, '0')}<small>{scene.label}</small></span></button>)}</nav>
          {selected && <div className="presentation-preview-meta"><span>{loading ? '正在读取精读记录…' : readingError ? '精读记录读取失败' : `${noteCount} 节精读记录 · ${readyAnalyses.length} 张图表`}</span>{(visualProgress || visualError) && <span>{visualProgress ? `正在准备图表 ${visualProgress.page}/${visualProgress.total}` : '部分原图暂不可用'}</span>}</div>}
          {notice && <p className="presentation-generation-notice" role="status">{notice}</p>}
        </section>
      </div>
      <footer className="presentation-studio-footer">
        {deckMode === 'compare' ? (
          <button type="button" className="presentation-generate-button" disabled={compareDocs.length < 2 || exporting || learning} onClick={() => void generateCompare()}>
            {exporting ? '正在生成多篇对比…' : `生成 ${compareDocs.length} 篇组会对比 PPT`}
            <span aria-hidden="true">→</span>
          </button>
        ) : (
          <button type="button" className="presentation-generate-button" disabled={!selected || loading || !noteCount || exporting || learning || Boolean(visualProgress)} onClick={() => void generate()}>
            {exporting ? '正在生成…' : visualProgress ? '正在准备图表…' : '生成学术演示稿'}
            <span aria-hidden="true">→</span>
          </button>
        )}
      </footer>
    </div>
  </main>;
}
