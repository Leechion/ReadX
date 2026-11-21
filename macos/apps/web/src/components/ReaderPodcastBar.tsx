import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type PodcastSegment } from '../api/client';

export function ReaderPodcastBar({
  documentKey,
  documentTitle,
  currentPage,
  currentPageText,
  onClose,
}: {
  documentKey: string;
  documentTitle: string;
  currentPage: number;
  currentPageText: string;
  onClose: () => void;
}) {
  const [sourceMode, setSourceMode] = useState<'page' | 'podcast'>('page');
  const [segments, setSegments] = useState<PodcastSegment[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const activeRef = useRef({ segments, activeIndex, rate });
  activeRef.current = { segments, activeIndex, rate };

  const stopSpeech = useCallback(() => {
    if (supported) window.speechSynthesis.cancel();
    setPlaying(false);
  }, [supported]);

  useEffect(() => () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  useEffect(() => {
    if (sourceMode !== 'page') return;
    stopSpeech();
    const cleaned = currentPageText.replace(/\s+/g, ' ').trim();
    if (!cleaned) {
      setSegments([]);
      return;
    }
    const chunks: PodcastSegment[] = [];
    const sentences = cleaned.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
    let buf = '';
    for (const sentence of sentences) {
      if ((buf + ' ' + sentence).length > 360 && buf) {
        chunks.push({ heading: `第 ${currentPage} 页`, text: buf.trim() });
        buf = sentence;
      } else {
        buf = buf ? `${buf} ${sentence}` : sentence;
      }
    }
    if (buf.trim()) chunks.push({ heading: `第 ${currentPage} 页`, text: buf.trim() });
    setSegments(chunks);
    setActiveIndex(0);
  }, [currentPage, currentPageText, sourceMode, stopSpeech]);

  const generatePodcast = async () => {
    stopSpeech();
    setSourceMode('podcast');
    setLoading(true);
    setError('');
    try {
      const res = await api.podcastScript(documentKey);
      setSegments(res.segments);
      setActiveIndex(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const speakIndex = useCallback(
    (idx: number, nextRate = activeRef.current.rate) => {
      if (!supported) {
        setError('当前运行环境不支持系统语音合成（Web Speech API）。');
        return;
      }
      const list = activeRef.current.segments;
      const seg = list[idx];
      if (!seg) {
        setPlaying(false);
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(seg.text);
      utterance.rate = nextRate;
      utterance.lang = /[\u4e00-\u9fff]/.test(seg.text) ? 'zh-CN' : 'en-US';
      utterance.onend = () => {
        if (idx + 1 < activeRef.current.segments.length) {
          setActiveIndex(idx + 1);
          speakIndex(idx + 1, activeRef.current.rate);
        } else {
          setPlaying(false);
        }
      };
      utterance.onerror = () => setPlaying(false);
      setActiveIndex(idx);
      setPlaying(true);
      window.speechSynthesis.speak(utterance);
    },
    [supported],
  );

  const togglePlay = () => {
    if (!segments.length) return;
    if (playing) {
      stopSpeech();
    } else {
      speakIndex(activeIndex);
    }
  };

  const activeSegment = segments[activeIndex];

  return (
    <section className="reader-podcast-bar" aria-label="论文语音速听">
      <div className="reader-podcast-top">
        <div className="reader-podcast-modes">
          <button
            type="button"
            className={sourceMode === 'page' ? 'active' : ''}
            onClick={() => setSourceMode('page')}
          >
            朗读当前页 (P{currentPage})
          </button>
          <button
            type="button"
            className={sourceMode === 'podcast' ? 'active' : ''}
            disabled={loading}
            onClick={() => void generatePodcast()}
          >
            {loading ? '正在生成讲稿…' : 'AI 2 分钟速听讲稿'}
          </button>
        </div>

        <div className="reader-podcast-controls">
          <button
            type="button"
            disabled={!segments.length || activeIndex === 0}
            onClick={() => speakIndex(Math.max(0, activeIndex - 1))}
            title="上一段"
          >
            ⏮
          </button>
          <button
            type="button"
            className="primary"
            disabled={!segments.length || loading}
            onClick={togglePlay}
          >
            {playing ? '暂停' : '朗读'}
          </button>
          <button
            type="button"
            disabled={!segments.length || activeIndex + 1 >= segments.length}
            onClick={() => speakIndex(Math.min(segments.length - 1, activeIndex + 1))}
            title="下一段"
          >
            ⏭
          </button>
          <select
            value={rate}
            aria-label="朗读倍速"
            onChange={(event) => {
              const next = Number(event.target.value);
              setRate(next);
              if (playing) speakIndex(activeIndex, next);
            }}
          >
            <option value={0.85}>0.85x</option>
            <option value={1}>1.0x</option>
            <option value={1.25}>1.25x</option>
            <option value={1.5}>1.5x</option>
          </select>
          <button
            type="button"
            onClick={() => {
              stopSpeech();
              onClose();
            }}
            aria-label="关闭语音速听"
          >
            ×
          </button>
        </div>
      </div>

      {error ? (
        <p className="reader-podcast-error" role="alert">
          {error}
        </p>
      ) : activeSegment ? (
        <div className="reader-podcast-caption">
          <strong>
            {documentTitle.slice(0, 20)} · {activeSegment.heading}（{activeIndex + 1}/{segments.length}）
          </strong>
          <p>{activeSegment.text}</p>
        </div>
      ) : (
        <p className="reader-podcast-empty">
          {loading ? '正在根据精读与正文组织速听讲稿…' : '当前页没有可朗读的文本，可点击「AI 2 分钟速听讲稿」。'}
        </p>
      )}
    </section>
  );
}
