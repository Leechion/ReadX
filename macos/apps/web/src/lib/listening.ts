export function splitSpeech(text: string, limit: number): string[] {
  const chars = Array.from(text.trim());
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + limit, chars.length);
    if (end < chars.length) {
      const earliest = start + Math.floor(limit / 2);
      let split = end;
      while (split > earliest && !/[。！？；.!?;\n]/u.test(chars[split - 1]!)) split--;
      if (split === earliest) {
        split = end;
        while (split > earliest && !/\s/u.test(chars[split - 1]!)) split--;
      }
      if (split > earliest) end = split;
    }
    const chunk = chars.slice(start, end).join('').trim();
    if (chunk) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

export type ListeningSource = 'original' | 'translation' | 'selection';
export type ListeningPane = Exclude<ListeningSource, 'selection'>;

export interface ListeningBlock {
  text: string;
  block?: number;
  startOffset?: number;
  box?: { x: number; y: number; width: number; height: number };
}

export interface ListeningCue extends ListeningBlock {
  number: number;
  total: number;
  occurrence: number;
}

// PDF line breaks, ligatures and discretionary hyphens can differ from the OCR transcript.
export function listeningMatchChar(char: string): string {
  return char.normalize('NFKC').toLowerCase().replace(/[\s\u00ad\u200b\-\u2010\u2011]/gu, '');
}

export function readingParts(blocks: ListeningBlock[], limit: number): { text: string; cue: ListeningCue }[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const sentences = blocks.flatMap(block => block.text.split(/\r?\n[\t ]*\r?\n/u).flatMap(paragraph =>
    Array.from(segmenter.segment(paragraph.replace(/\s+/gu, ' ')), ({ segment }) => ({ ...block, text: segment.trim() }))
      .filter(sentence => sentence.text)));
  const occurrences = new Map<string, number>();
  return sentences.flatMap((sentence, index) => {
    const identity = `${sentence.block ?? ''}:${Array.from(sentence.text, listeningMatchChar).join('')}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const cue = { ...sentence, number: index + 1, total: sentences.length, occurrence };
    return splitSpeech(sentence.text, limit).map(text => ({ text, cue }));
  });
}

export interface ListeningControls {
  pause: () => void;
  resume: () => Promise<void>;
}

export function speakWithSystem(
  text: string, rate: number, voice: SpeechSynthesisVoice | undefined, signal: AbortSignal,
  onPlay: (controls: ListeningControls) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice ?? null;
    utterance.rate = rate;
    utterance.lang = voice?.lang ?? (/\p{Script=Han}/u.test(text) ? 'zh-CN' : 'en-US');
    const finish = (error?: unknown) => {
      signal.removeEventListener('abort', abort);
      utterance.onend = utterance.onerror = utterance.onstart = null;
      if (error) reject(error);
      else resolve();
    };
    const abort = () => { finish(signal.reason); synth.cancel(); synth.resume(); };
    signal.addEventListener('abort', abort, { once: true });
    utterance.onstart = () => onPlay({ pause: () => synth.pause(), resume: async () => synth.resume() });
    utterance.onend = () => finish();
    utterance.onerror = (event) => finish(new Error(`系统朗读失败（${event.error}）。请检查系统语音设置`));
    try { synth.speak(utterance); } catch (error) { finish(error); }
  });
}

export function playStudioAudio(
  blob: Blob, signal: AbortSignal, onPlay: (controls: ListeningControls) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const finish = (error?: unknown) => {
      signal.removeEventListener('abort', abort);
      audio.onended = audio.onerror = audio.onplaying = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error('无法播放 VoiceStudio 生成的音频'));
    audio.onplaying = () => onPlay({ pause: () => audio.pause(), resume: () => audio.play() });
    void audio.play().catch(error => {
      if (!signal.aborted && audio.onerror) finish(error);
    });
  });
}
