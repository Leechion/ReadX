import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { GenerateProgress, ReadingGenerationInput } from '../api/client';
import type { PaperVisual } from '../hooks/usePaperVisuals';
import { prepareReadingVisuals } from './readingVisuals';

export async function preparePaperReading(_key: string, pdf: PDFDocumentProxy | null, visuals: PaperVisual[], textOnly: boolean, signal: AbortSignal, report: (value: GenerateProgress) => void): Promise<ReadingGenerationInput> {
  const input: ReadingGenerationInput = { workflow: 'paper-reader', visuals: [] };
  if (!textOnly && pdf) {
    input.fingerprint = pdf.fingerprints[0] ?? '';
    if (!input.fingerprint) throw new Error('PDF 文档指纹不可用，请重新打开论文');
    input.pageCount = pdf.numPages;
    signal.throwIfAborted();
    report({ percent: 8, message: '复用导入时准备的论文记忆' });
    let encodedSize = 0;
    for (const visual of visuals) {
      signal.throwIfAborted();
      if (visual.extractionStatus !== 'ready') {
        // 只有真正没裁出图片的（crop-failed）才跳过：没图可送。
        // needs-review 的候选（如裁剪区偏大、可能含相邻内容）照样送——图和图注
        // 都是真的，模型看得到内容自会取舍；原先整批跳过会让候选区的图
        // 永远进不了精读。想精确控制裁剪范围的仍可在候选区手动校正后重跑。
        continue;
      }
      try {
        const [reference] = await prepareReadingVisuals(
          [visual],
          signal,
          () => report({ percent: 37, message: `正在准备正文原图 · Page ${visual.page}` }),
          { includeNeedsReview: true },
        );
        if (!reference) continue;
        if (input.visuals.length >= 256 || encodedSize + reference.imagePNG.length > (60 << 20)) throw new Error('原图附件超过单次容量');
        input.visuals.push(reference);
        encodedSize += reference.imagePNG.length;
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
  }
  return input;
}
