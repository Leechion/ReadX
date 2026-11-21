import { useEffect, useRef, useState } from 'react';
import { saveOwnVoice, type StudioVoice } from '../api/voiceStudio';

const SAMPLE = '今天我想读一篇有意思的论文。我会先看看它提出的问题，再听听作者是怎么验证想法的。';
const MIN_SECONDS = 3;
const MAX_SECONDS = 30;

export function OwnVoiceRecording({ onSaved, onBack }: { onSaved: (voice: StudioVoice) => void; onBack: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'permission' | 'recording' | 'finishing' | 'saving'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [audio, setAudio] = useState<Blob>();
  const [audioURL, setAudioURL] = useState('');
  const [name, setName] = useState('我的声音');
  const [transcript, setTranscript] = useState(SAMPLE);
  const [ownVoice, setOwnVoice] = useState(false);
  const [error, setError] = useState('');
  const operation = useRef<AbortController | null>(null);
  const stopRecording = useRef<() => void>(() => {});
  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    if (!audio) { setAudioURL(''); return; }
    const url = URL.createObjectURL(audio);
    setAudioURL(url);
    return () => URL.revokeObjectURL(url);
  }, [audio]);

  const supported = typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined';
  const record = async () => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setError(''); setAudio(undefined); setElapsed(0); setPhase('permission');
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      controller.signal.throwIfAborted();
      const microphone = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(microphone, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 96_000 });
      const parts: Blob[] = [];
      const started = performance.now();
      let timer = 0;
      const release = () => {
        window.clearInterval(timer);
        microphone.getTracks().forEach(track => track.stop());
        controller.signal.removeEventListener('abort', cancel);
        stopRecording.current = () => {};
      };
      const cancel = () => {
        if (recorder.state !== 'inactive') recorder.stop();
        release();
      };
      stopRecording.current = () => {
        if (recorder.state !== 'inactive') {
          window.clearInterval(timer);
          setPhase('finishing');
          recorder.stop();
        }
      };
      recorder.ondataavailable = (event) => { if (event.data.size) parts.push(event.data); };
      recorder.onerror = () => {
        if (!controller.signal.aborted) {
          operation.current = null;
          setPhase('idle');
          setError('录音中断，请检查麦克风后重试');
          controller.abort();
        }
      };
      recorder.onstop = () => {
        release();
        if (controller.signal.aborted) return;
        operation.current = null;
        setPhase('idle');
        const clip = new Blob(parts, { type: recorder.mimeType || parts[0]?.type || mimeType });
        if (performance.now() - started < MIN_SECONDS * 1000 || clip.size < 1000) setError('请录制至少 3 秒清晰的讲话');
        else setAudio(clip);
      };
      controller.signal.addEventListener('abort', cancel, { once: true });
      recorder.start();
      setPhase('recording');
      timer = window.setInterval(() => {
        const seconds = Math.floor((performance.now() - started) / 1000);
        setElapsed(Math.min(seconds, MAX_SECONDS));
        if (seconds >= MAX_SECONDS) stopRecording.current();
      }, 200);
    } catch (cause) {
      stream?.getTracks().forEach(track => track.stop());
      if (!controller.signal.aborted) {
        operation.current = null;
        setPhase('idle');
        setError(cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? '没有麦克风权限，请在系统设置或浏览器中允许 ReadX 访问麦克风'
          : '无法开始录音，请检查麦克风是否可用');
        controller.abort();
      }
    }
  };

  const save = async () => {
    if (!audio || !name.trim() || !transcript.trim() || !ownVoice || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setPhase('saving'); setError('');
    try {
      const voice = await saveOwnVoice(name.trim(), transcript.trim(), audio, controller.signal);
      if (!controller.signal.aborted) onSaved(voice);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '音色保存失败');
    } finally {
      if (!controller.signal.aborted) { operation.current = null; setPhase('idle'); }
    }
  };

  return <section className="listening-record">
    <h3>录制自己的声音</h3>
    <p>朗读下方文字，或改成你准备朗读的内容。录音保存到本机 VoiceStudio。</p>
    <label>音色名称<input value={name} maxLength={60} disabled={phase === 'saving'} onChange={event => setName(event.target.value)} /></label>
    <label>录音原文<textarea rows={3} value={transcript} maxLength={600} disabled={phase !== 'idle' || Boolean(audio)} onChange={event => setTranscript(event.target.value)} /></label>
    <label className="checkbox-label"><input type="checkbox" checked={ownVoice} onChange={event => setOwnVoice(event.target.checked)} disabled={phase !== 'idle'} />我确认录制的是自己的声音</label>
    {!supported && <p role="status">当前环境不支持麦克风录音。</p>}
    <div className="listening-actions">
      {phase === 'recording'
        ? <button type="button" onClick={() => stopRecording.current()}>停止录音（{elapsed} / {MAX_SECONDS} 秒）</button>
        : <button type="button" disabled={!supported || !ownVoice || !transcript.trim() || phase !== 'idle'} onClick={() => void record()}>
            {phase === 'permission' ? '等待麦克风权限…' : phase === 'finishing' ? '正在处理录音…' : audio ? '重新录制' : '开始录音'}
          </button>}
      {audio && phase === 'idle' && <button type="button" onClick={() => setAudio(undefined)}>清除录音</button>}
    </div>
    {audioURL && phase !== 'saving' && <audio controls src={audioURL} aria-label="试听我的录音" />}
    {error && <p className="listening-error" role="alert">{error}</p>}
    <footer>
      <button type="button" disabled={phase === 'saving'} onClick={onBack}>返回音色选择</button>
      <button type="button" className="listening-primary" disabled={phase !== 'idle' || !audio || !ownVoice || !name.trim() || !transcript.trim()} onClick={() => void save()}>{phase === 'saving' ? '正在保存…' : '保存并使用'}</button>
    </footer>
  </section>;
}
