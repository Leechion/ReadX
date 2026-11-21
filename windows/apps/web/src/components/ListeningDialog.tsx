import { useEffect, useId, useRef, useState } from 'react';
import { loadVoiceStudio, synthesizeSpeech, type StudioCatalog, type StudioVoice } from '../api/voiceStudio';
import { playStudioAudio, readingParts, speakWithSystem, splitSpeech, type ListeningBlock, type ListeningControls, type ListeningCue, type ListeningSource } from '../lib/listening';
import { readString, STORAGE_KEYS, writeString } from '../lib/storage';
import { AppDialog } from './AppDialog';
import { OwnVoiceRecording } from './OwnVoiceRecording';
import './listening.css';

const AUTO = 'system:default';
const voiceKey = (voice: StudioVoice) => JSON.stringify([voice.kind, voice.id, voice.kind === 'preset' ? voice.model : '']);
const voiceLabel = (voice: StudioVoice) => [voice.name, voice.language === 'Auto' ? '' : voice.language, voice.engine].filter(Boolean).join(' · ');

export function ListeningDialog({ sourceLabel, selection, hasTranslation, initialSource, syncSource, readText, onStart, onCue, onClose }: {
  sourceLabel: string;
  selection: ListeningBlock;
  hasTranslation: boolean;
  initialSource: ListeningSource;
  syncSource?: { source: ListeningSource; nonce: number };
  readText: (source: ListeningSource, signal: AbortSignal) => Promise<ListeningBlock[]>;
  onStart: (source: ListeningSource) => void;
  onCue: (source: ListeningSource, cue: ListeningCue | null) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [source, setSource] = useState(initialSource);
  const lastSyncNonce = useRef(syncSource?.nonce ?? 0);
  const [compact, setCompact] = useState(false);
  const [currentCue, setCurrentCue] = useState<ListeningCue | null>(null);
  const playerRef = useRef<HTMLElement>(null);
  const [chosen, setChosen] = useState(() => readString(STORAGE_KEYS.listeningVoice, AUTO));
  const [filter, setFilter] = useState('');
  const [rate, setRate] = useState(1.25);
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [catalog, setCatalog] = useState<StudioCatalog | null>(null);
  const [studioError, setStudioError] = useState('');
  const [version, setVersion] = useState(0);
  const [updating, setUpdating] = useState(true);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'paused'>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const session = useRef<AbortController | null>(null);
  const controls = useRef<ListeningControls | null>(null);
  useEffect(() => () => session.current?.abort(), []);
  useEffect(() => {
    if (!syncSource || syncSource.nonce === lastSyncNonce.current) return;
    lastSyncNonce.current = syncSource.nonce;
    session.current?.abort();
    session.current = null;
    controls.current = null;
    setSource(syncSource.source);
    setStatus('idle');
    setProgress('');
    setError('');
    setCurrentCue(null);
    onCue(syncSource.source, null);
  }, [syncSource, onCue]);
  useEffect(() => {
    if (compact) playerRef.current?.focus({ preventScroll: true });
  }, [compact]);
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const update = () => setSystemVoices(synth.getVoices().filter(voice => voice.localService));
    update();
    synth.addEventListener('voiceschanged', update);
    return () => synth.removeEventListener('voiceschanged', update);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setUpdating(true); setStudioError('');
    loadVoiceStudio(controller.signal).then(data => {
      if (!controller.signal.aborted) setCatalog(data);
    }).catch(cause => {
      if (!controller.signal.aborted) setStudioError(cause instanceof Error ? cause.message : 'VoiceStudio 音色列表载入失败');
    }).finally(() => { if (!controller.signal.aborted) setUpdating(false); });
    return () => controller.abort();
  }, [version]);

  const studioVoices = catalog?.voices ?? [];
  const studioVoice = studioVoices.find(voice => voiceKey(voice) === chosen);
  const systemVoice = systemVoices.find(voice => 'system:' + voice.voiceURI === chosen);
  const currentVoice = studioVoice || systemVoice ? chosen : AUTO;
  const systemSupported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const busy = status !== 'idle';
  const canPlay = studioVoice ? Boolean(studioVoice.model) : systemSupported;
  const choose = (value: string) => {
    setChosen(value);
    setError('');
    writeString(STORAGE_KEYS.listeningVoice, value);
  };
  const onVoiceSaved = (voice: StudioVoice) => {
    const model = catalog?.cloneModel;
    setCatalog(current => current && { ...current, voices: [{ ...voice, model }, ...current.voices.filter(item => item.id !== voice.id || item.kind !== 'profile')] });
    choose(voiceKey(voice));
    setFilter('');
    setRecording(false);
    setVersion(value => value + 1);
  };
  const stop = () => {
    session.current?.abort();
    session.current = null;
    controls.current = null;
    setStatus('idle');
    setProgress('');
    setCurrentCue(null);
    onCue(source, null);
  };
  const resume = async () => {
    const active = session.current;
    try { await controls.current?.resume(); if (session.current === active) setStatus('playing'); }
    catch { if (session.current === active) { stop(); setError('无法继续播放，请重新开始'); } }
  };
  const play = async (preview: boolean, overrideSource?: ListeningSource, delayMs = 0) => {
    const activeSource = overrideSource ?? source;
    if (session.current || !canPlay) return;
    const controller = new AbortController();
    session.current = controller;
    const signal = controller.signal;
    setError(''); setStatus('loading'); setProgress(preview ? '正在准备试听…' : '正在读取正文…');
    if (!preview) {
      setCompact(true);
      onStart(activeSource);
    }
    try {
      if (delayMs > 0) await new Promise<void>(resolve => {
        const timer = window.setTimeout(resolve, delayMs);
        signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true });
      });
      signal.throwIfAborted();
      const language = studioVoice?.language === 'Auto' ? 'zh' : studioVoice?.language ?? systemVoice?.lang ?? '';
      const chinese = /zh|chinese|mandarin|cantonese|sichuan/i.test(language) || (!language && activeSource === 'translation');
      const sample = chinese ? '你好，这里是 ReadX。你正在试听当前选中的音色。' : 'Hello, this is ReadX. You are listening to a preview of the selected voice.';
      const limit = studioVoice ? 220 : 180;
      const parts = preview
        ? splitSpeech(sample, limit).map(text => ({ text, cue: null }))
        : readingParts(activeSource === 'selection' ? [selection] : await readText(activeSource, signal), limit);
      signal.throwIfAborted();
      if (!parts.length) throw new Error(activeSource === 'translation' ? '当前页还没有可朗读的译文' : '没有可朗读的正文。扫描页需要先完成文字识别');
      const askStudio = (part: string) => studioVoice
        ? synthesizeSpeech(studioVoice, part, rate, signal).then(audio => ({ audio }), (error: unknown) => ({ error }))
        : undefined;
      let queued = askStudio(parts[0]!.text);
      for (const [index, { text: part, cue }] of parts.entries()) {
        signal.throwIfAborted();
        controls.current = null;
        setStatus('loading');
        setProgress(studioVoice ? '正在合成下一句…' : '正在准备朗读…');
        const started = (actions: ListeningControls) => {
          controls.current = actions;
          if (cue) {
            setCurrentCue(cue);
            onCue(activeSource, cue);
          }
          setProgress(cue ? `第 ${cue.number} / ${cue.total} 句` : '正在试听');
          setStatus('playing');
        };
        if (queued) {
          const result = await queued;
          if ('error' in result) throw result.error;
          signal.throwIfAborted();
          const next = parts[index + 1];
          queued = next ? askStudio(next.text) : undefined;
          await playStudioAudio(result.audio, signal, started);
        } else {
          const language = /\p{Script=Han}/u.test(part) ? 'zh' : 'en';
          const automatic = systemVoices.find(voice => voice.default && voice.lang.toLowerCase().startsWith(language))
            ?? systemVoices.find(voice => voice.lang.toLowerCase().startsWith(language));
          await speakWithSystem(part, rate, systemVoice ?? automatic, signal, started);
        }
      }
      setProgress(preview ? '试听结束' : '朗读结束');
    } catch (cause) {
      if (!signal.aborted) {
        setProgress('');
        setError(cause instanceof Error ? cause.message : '朗读失败，请重试');
      }
    } finally {
      if (!signal.aborted) {
        session.current = null;
        controls.current = null;
        controller.abort();
        setStatus('idle');
        setCurrentCue(null);
        if (!preview) onCue(activeSource, null);
      }
    }
  };

  const switchSource = (next: ListeningSource) => {
    const wasBusy = Boolean(session.current);
    stop();
    setSource(next);
    if (canPlay) void play(false, next, wasBusy ? 40 : 0);
  };

  const pause = () => { controls.current?.pause(); setStatus('paused'); };
  if (compact) return <section ref={playerRef} tabIndex={-1} className="listening-player" aria-label="语音速听播放器">
    <div className="listening-player-text">
      {!error && <span className="listening-wave" data-active={status === 'playing' ? 'true' : 'false'} aria-hidden="true"><i /><i /><i /></span>}
      <span className="listening-source-badge">{source === 'translation' ? '译文' : source === 'selection' ? '选区' : '原文'}</span>
      <span role={error ? 'alert' : 'status'}>{error || (status === 'paused' ? '已暂停 · ' + progress : progress || '朗读已停止')}</span>
      {currentCue && <span className="listening-player-line" title={currentCue.text}>{currentCue.text}</span>}
    </div>
    <div className="listening-player-actions">
      {status === 'playing' && <button type="button" onClick={pause}>暂停</button>}
      {status === 'paused' && <button type="button" onClick={() => void resume()}>继续</button>}
      {busy && <button type="button" onClick={stop}>停止</button>}
      {!busy && <button type="button" onClick={() => void play(false)} disabled={!canPlay}>重新朗读</button>}
      {hasTranslation && source !== 'selection' && <button type="button" disabled={!canPlay} onClick={() => switchSource(source === 'translation' ? 'original' : 'translation')}>{source === 'translation' ? '读原文' : '读译文'}</button>}
      <button type="button" onClick={() => { stop(); setCompact(false); }}>设置</button>
      <button type="button" aria-label="关闭播放器" title="关闭播放器" onClick={onClose}>×</button>
    </div>
  </section>;

  const query = filter.trim().toLocaleLowerCase();
  const groups = [
    ['我的 VoiceStudio 音色', studioVoices.filter(voice => voice.kind === 'profile')],
    ['VoiceStudio 默认和模型预设', studioVoices.filter(voice => voice.kind === 'default' || voice.kind === 'preset')],
    ['VoiceStudio 设计音色', studioVoices.filter(voice => voice.kind === 'design' && (
      voice === studioVoice || (query ? voiceLabel(voice).toLocaleLowerCase().includes(query) : voice.featured)
    ))],
  ] as const;

  return <AppDialog open onClose={onClose} className="listening-dialog" aria-labelledby={titleId}>
    <header><h2 id={titleId}>语音速听</h2><button type="button" onClick={onClose}>关闭</button></header>
    {recording ? <OwnVoiceRecording onSaved={onVoiceSaved} onBack={() => setRecording(false)} /> : <>
      <div className="listening-selection">
        <label>朗读范围<select value={source} disabled={busy} onChange={event => { setSource(event.target.value as ListeningSource); setError(''); }}>
          <option value="original">{sourceLabel}原文</option>
          {hasTranslation && <option value="translation">{sourceLabel}译文</option>}
          {selection.text && <option value="selection">选中文字</option>}
        </select></label>
        <label>语速<select value={rate} disabled={busy} onChange={event => setRate(Number(event.target.value))}>
          {[0.75, 1, 1.25, 1.5, 1.75, 2].map(value => <option key={value} value={value}>{value}×</option>)}
        </select></label>
      </div>
      {studioVoices.some(voice => voice.kind === 'design') && <label>搜索 VoiceStudio 设计音色
        <input type="search" placeholder="按名称、语言搜索全部设计音色" value={filter} disabled={busy} onChange={event => setFilter(event.target.value)} />
      </label>}
      <label>音色<select value={currentVoice} disabled={busy} onChange={event => choose(event.target.value)}>
        <optgroup label="系统音色">
          <option value={AUTO} disabled={!systemSupported}>系统自动选择</option>
          {systemVoices.map(voice => <option key={voice.voiceURI} value={'system:' + voice.voiceURI}>{voice.name} · {voice.lang}</option>)}
        </optgroup>
        {groups.map(([label, items]) => items.length > 0 && <optgroup key={label} label={label}>
          {items.map(voice => <option key={voiceKey(voice)} value={voiceKey(voice)} disabled={!voice.model}>{voiceLabel(voice)}{!voice.model ? '（需要兼容模型）' : ''}</option>)}
        </optgroup>)}
      </select></label>
      {query && !groups[2][1].some(voice => voiceLabel(voice).toLocaleLowerCase().includes(query)) && <small>没有匹配的设计音色</small>}
      {studioVoice && !studioVoice.model && <small>请在 VoiceStudio 里准备兼容的声音模型，然后刷新音色。</small>}
      <div className="listening-actions">
        <button type="button" disabled={busy || !canPlay} onClick={() => void play(true)}>试听音色</button>
        <button type="button" disabled={busy || updating} onClick={() => setVersion(value => value + 1)}>刷新音色</button>
        <button type="button" title={!catalog ? '先连接本机 VoiceStudio' : undefined} disabled={!catalog || updating || busy} onClick={() => { setProgress(''); setRecording(true); }}>录制自己的声音</button>
      </div>
      {updating ? <small role="status">正在读取本机 VoiceStudio 音色…</small> : studioError && <small role="status">{studioError}</small>}
      {error && <p className="listening-error" role="alert">{error}</p>}
      {progress && <p className="listening-progress" role="status">{progress}</p>}
      <footer>
        {busy ? <>
          <button type="button" onClick={stop}>停止</button>
          {status === 'playing' && <button type="button" className="listening-primary" onClick={pause}>暂停</button>}
          {status === 'paused' && <button type="button" className="listening-primary" onClick={() => void resume()}>继续</button>}
        </> : <button type="button" className="listening-primary" disabled={!canPlay} onClick={() => void play(false)}>开始朗读</button>}
      </footer>
    </>}
  </AppDialog>;
}
