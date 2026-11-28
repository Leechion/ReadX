import type { PaperVisual } from '../hooks/usePaperVisuals';
import type { ReadingVisualReference, GenerateProgress, ReadingVisualAnalysis } from '../api/client';

// Excludes transient blob URLs; changing a crop or caption invalidates its placement.
export function visualRevision(visual: PaperVisual) {
  return JSON.stringify(['vision-v1', visual.id, visual.kind, visual.page, visual.suggestedStep, visual.cropBounds ?? visual.detectedBounds]);
}

export function currentVisualAnalyses(items: ReadingVisualAnalysis[] | undefined, visuals: PaperVisual[]) {
  const current = new Map(visuals.filter((v) => v.extractionStatus === 'ready' && v.reviewStatus !== 'needs-review').map((v) => [v.id, v]));
  return (items ?? []).filter((item) => { const visual = current.get(item.id); return visual && visualRevision(visual) === item.revision && visual.caption === item.caption; });
}

export async function prepareReadingVisuals(
  visuals: PaperVisual[],
  signal: AbortSignal,
  onProgress: (progress: GenerateProgress) => void,
  options?: { includeNeedsReview?: boolean },
): Promise<ReadingVisualReference[]> {
  const includeNeedsReview = options?.includeNeedsReview ?? false;
  const ready = visuals.filter(
    (v) => v.extractionStatus === 'ready' && (includeNeedsReview || v.reviewStatus !== 'needs-review'),
  );
  const references: ReadingVisualReference[] = [];
  let size = 0;
  for (const [index, visual] of ready.entries()) {
    signal.throwIfAborted();
    if (!visual.imageURL?.startsWith('blob:')) throw new Error('图表图片已失效，请重新识别。');
    onProgress({ percent: 3, message: '正在准备图表图片 ' + (index + 1) + ' / ' + ready.length + '…' });
    const response = await fetch(visual.imageURL, { signal });
    const bitmap = await createImageBitmap(await response.blob());
    let imagePNG: string;
    try {
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法准备图表图片，请重新打开论文。');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      imagePNG = canvas.toDataURL('image/png').split(',')[1]!;
      canvas.width = 0; canvas.height = 0;
    } finally { bitmap.close(); }
    signal.throwIfAborted();
    size += imagePNG.length;
    if (imagePNG.length > (8 << 20) * 4 / 3 || size > (60 << 20) || ready.length > 256) throw new Error('图表附件超过单篇容量，未跳过任何图片。请分卷导入后再生成。');
    references.push({ id: visual.id, kind: visual.kind, page: visual.page, caption: visual.caption, suggestedStep: visual.suggestedStep, revision: visualRevision(visual), imagePNG });
  }
  return references;
}
