import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent } from 'react';
import type {
  PetActionCommand,
  PetAppState,
  PetHostEvent,
  PetMood,
  PetNavigateTarget,
  PetSettings,
} from '@cbct/shared';
import { api, type DocumentProcessingJob } from '../../api/client';
import { STORAGE_KEYS } from '../../lib/storage';
import { petAudio } from './petAudio';
import { ReadXPetRenderer, type PetRenderState } from './petCanvas';
import './pet.css';

interface BubbleState {
  text: string;
  kind: 'info' | 'working' | 'thinking' | 'waiting' | 'done' | 'error';
  target?: PetNavigateTarget;
  expiresAt?: number;
}

const DEFAULT_SETTINGS: PetSettings = {
  enabled: true,
  skin: 'kuro',
  clickThrough: false,
  scale: 1,
  opacity: 1,
  accessory: 'bowtie',
  soundEnabled: true,
  waterReminderMin: 0,
  x: null,
  y: null,
  peekEdge: 'none',
};

const PET_LINES = [
  '喵~ 拖入 PDF 或链接可直接入库',
  '呼噜呼噜…读完这篇奖励小鱼干',
  '右键我可以开 25 分钟番茄钟哦',
  '后台翻译不用守着，我帮你盯着！',
];

function readInitialTheme(): 'light' | 'dark' | 'paper' {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.theme);
    if (saved === 'dark' || saved === 'paper' || saved === 'light') return saved;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function readOffWorkSummary(): string {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.slackCountdown) ?? 'null') as { offWork?: string } | null;
    const offWork = typeof parsed?.offWork === 'string' && /^\d{2}:\d{2}$/.test(parsed.offWork) && parsed.offWork !== '18:00'
      ? parsed.offWork
      : '17:00';
    const [h, m] = offWork.split(':').map(Number);
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h || 17, m || 0);
    const diffMin = Math.round((target.getTime() - now.getTime()) / 60000);
    if (diffMin > 0) {
      const hours = Math.floor(diffMin / 60);
      const mins = diffMin % 60;
      return hours > 0 ? `距下班 ${hours}h${mins}m` : `距下班 ${mins} 分钟`;
    }
    return '已到下班时间';
  } catch {
    return '';
  }
}

function looksLikePaperLocator(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 500 || /\s/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^(?:arxiv:)?\d{4}\.\d{4,5}(?:v\d+)?$/i.test(trimmed)) return true;
  if (/^(?:doi:)?10\.\d{4,9}\/\S+$/i.test(trimmed)) return true;
  return false;
}

function activeStageLabel(job: DocumentProcessingJob): string {
  const running = job.stages?.find((s) => s.status === 'running');
  if (!running) return '正在处理';
  switch (running.key) {
    case 'ocr':
      return '识别中';
    case 'translate':
      return running.total > 0 ? `翻译 ${running.completed}/${running.total} 页` : '翻译中';
    case 'render':
      return running.total > 0 ? `排版 ${running.completed}/${running.total} 页` : '排版中';
    case 'memory':
      return '构建记忆中';
    default:
      return running.label || '处理中';
  }
}

export function PetStage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ReadXPetRenderer | null>(null);
  if (!rendererRef.current) rendererRef.current = new ReadXPetRenderer();

  const [settings, setSettings] = useState<PetSettings>(DEFAULT_SETTINGS);
  const [appState, setAppState] = useState<PetAppState>(() => ({ theme: readInitialTheme() }));
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const [hoverInteractive, setHoverInteractive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [altHeld, setAltHeld] = useState(false);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const appStateRef = useRef(appState);
  appStateRef.current = appState;
  const interactiveRef = useRef(false);
  const bubbleRef = useRef(bubble);
  bubbleRef.current = bubble;
  const petLineIndexRef = useRef(0);

  const renderStateRef = useRef<PetRenderState>({
    skin: 'kuro',
    accessory: 'bowtie',
    mood: 'idle',
    theme: readInitialTheme(),
    peekEdge: 'none',
    focusRunning: false,
    focusClock: undefined,
    voicePlaying: false,
    cursor: null,
    dragging: false,
    dropHover: false,
    lastKeyPulseAt: -10000,
    lastPetAt: -10000,
    lastTailSlapAt: -10000,
    lastPageFlipAt: -10000,
    moodChangedAt: performance.now(),
  });

  const lastActivityAtRef = useRef(performance.now());
  const jobMoodRef = useRef<PetMood>('idle');
  const seenJobStatesRef = useRef<Map<string, string>>(new Map());
  const jobsBootstrappedRef = useRef(false);
  const prevFocusRunningRef = useRef(false);

  const dragRef = useRef<{
    pointerId: number;
    startScreenX: number;
    startScreenY: number;
    startWinX: number;
    startWinY: number;
    offsetX: number;
    offsetY: number;
    moved: boolean;
  } | null>(null);

  const soundOn = () => settingsRef.current.soundEnabled !== false;

  const updateMood = useCallback((next: PetMood) => {
    const rs = renderStateRef.current;
    if (rs.mood !== next) {
      rs.mood = next;
      rs.moodChangedAt = performance.now();
    }
  }, []);

  const syncInteractive = useCallback((next: boolean) => {
    if (interactiveRef.current === next) return;
    interactiveRef.current = next;
    setHoverInteractive(next);
    window.__READX_PET__?.setInteractive(next);
  }, []);

  const importByLocator = useCallback(async (locator: string) => {
    lastActivityAtRef.current = performance.now();
    updateMood('thinking');
    setBubble({ kind: 'working', text: '正在拉取论文原文…' });
    try {
      const { file } = await api.downloadPublication(locator, undefined);
      updateMood('working');
      setBubble({ kind: 'working', text: `已下载 ${file.name.slice(0, 12)}，正在入库…` });
      const result = await api.upload([file]);
      const first = result.results?.[0];
      if (first?.error) {
        updateMood('error');
        petAudio.playChime(soundOn(), 'error');
        setBubble({ kind: 'error', text: first.error, target: { kind: 'import' }, expiresAt: Date.now() + 8000 });
        return;
      }
      const doc = first?.document;
      const title = doc?.title || first?.name || file.name;
      updateMood('done');
      petAudio.playChime(soundOn(), 'done');
      setBubble({
        kind: 'done',
        text: `已抓取《${title.slice(0, 12)}》· 点击阅读`,
        target: doc ? { kind: 'document', id: doc.id, key: doc.key } : { kind: 'screen', screen: 'library' },
        expiresAt: Date.now() + 9000,
      });
      window.__READX_PET__?.notifyLibraryUpdated();
    } catch (error) {
      updateMood('error');
      petAudio.playChime(soundOn(), 'error');
      setBubble({
        kind: 'error',
        text: error instanceof Error ? error.message.slice(0, 26) : '拉取失败，点击打开导入',
        target: { kind: 'import' },
        expiresAt: Date.now() + 8000,
      });
    }
  }, [updateMood]);

  const showBriefing = useCallback(async () => {
    lastActivityAtRef.current = performance.now();
    updateMood('thinking');
    setBubble({ kind: 'thinking', text: '翻翻书架统计中…' });
    try {
      const stats = await api.stats();
      const off = readOffWorkSummary();
      const parts = [
        `在库 ${stats.library.active} 篇`,
        `在读 ${stats.library.reading}`,
        `精读 ${stats.library.done}`,
      ];
      if (off) parts.push(off);
      updateMood('done');
      petAudio.playMeow(soundOn());
      setBubble({
        kind: 'done',
        text: parts.join(' · '),
        target: { kind: 'screen', screen: 'calendar' },
        expiresAt: Date.now() + 8500,
      });
    } catch {
      updateMood('idle');
      setBubble({ kind: 'info', text: '暂时连不上书库统计', expiresAt: Date.now() + 3500 });
    }
  }, [updateMood]);

  const triggerWaterReminder = useCallback(() => {
    lastActivityAtRef.current = performance.now();
    updateMood('drink');
    petAudio.playChime(soundOn(), 'water');
    rendererRef.current!.spawnBurst('drop', 192, 185, 3);
    setBubble({
      kind: 'waiting',
      text: '喝口水、远眺 20 秒吧~（摸头关闭）',
      expiresAt: Date.now() + 60_000,
    });
  }, [updateMood]);

  const runActionCommand = useCallback((action: PetActionCommand) => {
    const now = performance.now();
    if (action === 'pet') {
      lastActivityAtRef.current = now;
      renderStateRef.current.lastPetAt = now;
      updateMood('petted');
      petAudio.playPurr(soundOn());
      rendererRef.current!.spawnBurst('heart', 140, 108, 5);
      setBubble({ kind: 'info', text: '呼噜呼噜~ 真舒服喵', expiresAt: Date.now() + 3200 });
    } else if (action === 'nap') {
      updateMood('sleeping');
      setBubble({ kind: 'info', text: '蜷起来打个盹儿 Zzz…', expiresAt: Date.now() + 3000 });
    } else if (action === 'wake') {
      lastActivityAtRef.current = now;
      updateMood(jobMoodRef.current);
      petAudio.playMeow(soundOn());
      rendererRef.current!.spawnBurst('sparkle', 140, 108, 4);
      setBubble({ kind: 'info', text: '精神满满，继续读论文！', expiresAt: Date.now() + 3200 });
    } else if (action === 'drink_reminder') {
      triggerWaterReminder();
    } else if (action === 'briefing') {
      void showBriefing();
    } else if (action === 'clipboard_import') {
      void window.__READX_PET__?.readClipboard().then((text) => {
        if (!looksLikePaperLocator(text)) {
          petAudio.playMeow(soundOn());
          setBubble({
            kind: 'info',
            text: '剪贴板里没看到 arXiv / DOI / 论文链接',
            target: { kind: 'import' },
            expiresAt: Date.now() + 4500,
          });
          return;
        }
        void importByLocator(text);
      });
    }
  }, [importByLocator, showBriefing, triggerWaterReminder, updateMood]);

  const runActionRef = useRef(runActionCommand);
  runActionRef.current = runActionCommand;

  // 订阅 Electron 宿主事件
  useEffect(() => {
    document.title = 'ReadX · 桌面伴侣';
    document.documentElement.classList.add('readx-pet-window');
    const bridge = window.__READX_PET__;
    if (!bridge) return () => {
      document.documentElement.classList.remove('readx-pet-window');
    };

    const applySettings = (loaded: PetSettings) => {
      setSettings(loaded);
      renderStateRef.current.skin = loaded.skin;
      renderStateRef.current.accessory = loaded.accessory ?? 'bowtie';
      renderStateRef.current.peekEdge = loaded.peekEdge ?? 'none';
    };

    void bridge.getSettings().then(applySettings).catch(() => {});

    const off = bridge.onHostEvent((event: PetHostEvent) => {
      if (event.type === 'settings') {
        applySettings(event.settings);
      } else if (event.type === 'pointer') {
        renderStateRef.current.cursor = { x: event.x, y: event.y };
        setAltHeld(event.altHeld);
        const canvas = canvasRef.current;
        const overPet = event.inside && canvas
          ? rendererRef.current!.hitTest(event.x, event.y, canvas.clientWidth, canvas.clientHeight)
          : false;
        const shouldInteract = overPet || Boolean(bubbleRef.current) || Boolean(dragRef.current);
        syncInteractive(shouldInteract);
      } else if (event.type === 'keyPulse') {
        renderStateRef.current.lastKeyPulseAt = performance.now();
        lastActivityAtRef.current = performance.now();
        if (renderStateRef.current.mood === 'sleeping') {
          updateMood(jobMoodRef.current);
        }
      } else if (event.type === 'alt') {
        setAltHeld(event.held);
      } else if (event.type === 'action') {
        runActionRef.current(event.action);
      } else if (event.type === 'appState') {
        setAppState((prev) => {
          const merged = { ...prev, ...event.state };
          if (merged.theme) renderStateRef.current.theme = merged.theme;
          const nextFocus = Boolean(merged.focusRunning);
          renderStateRef.current.focusRunning = nextFocus;
          renderStateRef.current.focusClock = merged.focusClock;
          renderStateRef.current.voicePlaying = Boolean(merged.voicePlaying);
          if (nextFocus && !prevFocusRunningRef.current) {
            lastActivityAtRef.current = performance.now();
            if (renderStateRef.current.mood === 'sleeping') updateMood('idle');
            setBubble({ kind: 'info', text: '台灯亮起，专注陪读开始！', expiresAt: Date.now() + 3400 });
          } else if (!nextFocus && prevFocusRunningRef.current && merged.focusClock === '00:00') {
            updateMood('done');
            petAudio.playChime(soundOn(), 'done');
            setBubble({ kind: 'done', text: '专注完成！伸个懒腰休息一下~', expiresAt: Date.now() + 7000 });
          }
          prevFocusRunningRef.current = nextFocus;
          return merged;
        });
      }
    });

    bridge.ready();
    return () => {
      off();
      document.documentElement.classList.remove('readx-pet-window');
    };
  }, [syncInteractive, updateMood]);

  // 定时护眼喝水提醒
  useEffect(() => {
    const minutes = settings.waterReminderMin ?? 0;
    if (minutes <= 0) return;
    const timer = window.setInterval(() => {
      if (renderStateRef.current.mood !== 'working') {
        triggerWaterReminder();
      }
    }, minutes * 60_000);
    return () => window.clearInterval(timer);
  }, [settings.waterReminderMin, triggerWaterReminder]);

  // 后台文档流水线（OCR / 翻译 / 排版 / 论文记忆）状态轮询
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;

    const poll = async () => {
      try {
        const res = await api.documentJobs(controller.signal);
        if (controller.signal.aborted) return;

        const runningJobs = res.jobs.filter(
          (job) => job.status === 'running' || job.stages?.some((s) => s.status === 'running'),
        );

        if (runningJobs.length > 0) {
          const lead = runningJobs[0]!;
          jobMoodRef.current = 'working';
          lastActivityAtRef.current = performance.now();
          updateMood('working');
          const shortTitle = lead.name.length > 14 ? `${lead.name.slice(0, 13)}…` : lead.name;
          setBubble({
            kind: 'working',
            text: `${shortTitle} · ${activeStageLabel(lead)}`,
            target: lead.documentKey ? { kind: 'document', key: lead.documentKey } : { kind: 'screen', screen: 'library' },
          });
        } else {
          if (jobMoodRef.current === 'working') {
            jobMoodRef.current = 'idle';
          }
          if (jobsBootstrappedRef.current) {
            for (const job of res.jobs.slice(0, 8)) {
              const prev = seenJobStatesRef.current.get(job.key);
              if (prev === 'running' && job.status === 'done') {
                updateMood('done');
                petAudio.playChime(soundOn(), 'done');
                const shortTitle = job.name.length > 12 ? `${job.name.slice(0, 11)}…` : job.name;
                setBubble({
                  kind: 'done',
                  text: `《${shortTitle}》已就绪 · 点击阅读`,
                  target: job.documentKey ? { kind: 'document', key: job.documentKey } : { kind: 'screen', screen: 'library' },
                  expiresAt: Date.now() + 9000,
                });
                window.__READX_PET__?.notifyLibraryUpdated();
                break;
              }
              if (prev === 'running' && job.status === 'failed') {
                updateMood('error');
                petAudio.playChime(soundOn(), 'error');
                const shortTitle = job.name.length > 12 ? `${job.name.slice(0, 11)}…` : job.name;
                setBubble({
                  kind: 'error',
                  text: `《${shortTitle}》处理失败 · 点击查看`,
                  target: { kind: 'screen', screen: 'library' },
                  expiresAt: Date.now() + 10000,
                });
                break;
              }
            }
          }
          if (renderStateRef.current.mood === 'working') {
            updateMood('idle');
          }
        }

        const nextSeen = new Map<string, string>();
        for (const job of res.jobs.slice(0, 20)) {
          nextSeen.set(job.key, job.status);
        }
        seenJobStatesRef.current = nextSeen;
        jobsBootstrappedRef.current = true;
      } catch {
        /* 后台轮询失败静默重试 */
      }

      if (!controller.signal.aborted) {
        timer = window.setTimeout(poll, 3500);
      }
    };

    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [updateMood]);

  // 气泡超时清理 + 情绪回落 + 休眠降帧
  useEffect(() => {
    const id = window.setInterval(() => {
      const nowMs = Date.now();
      setBubble((current) => (current?.expiresAt && nowMs >= current.expiresAt ? null : current));

      const rs = renderStateRef.current;
      const nowPerf = performance.now();
      const idleMs = nowPerf - lastActivityAtRef.current;
      if (rs.mood === 'petted' && nowPerf - rs.lastPetAt > 2000) {
        updateMood(jobMoodRef.current);
      } else if (rs.mood === 'angry' && nowPerf - rs.moodChangedAt > 4800) {
        updateMood(jobMoodRef.current);
      } else if (rs.mood === 'done' && nowPerf - rs.moodChangedAt > 2600 && jobMoodRef.current === 'idle') {
        updateMood('idle');
      } else if (rs.mood === 'idle' && idleMs > 24_000 && !rs.focusRunning && !rs.voicePlaying) {
        updateMood('sleeping');
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [updateMood]);

  // 2D Canvas 渲染循环（动态降帧：休眠 4 FPS / 常态 ~28 FPS / 互动 60 FPS）
  useEffect(() => {
    let rafId = 0;
    let lastDraw = 0;

    const frame = (now: number) => {
      rafId = window.requestAnimationFrame(frame);
      const rs = renderStateRef.current;
      const activeMotion = rs.dragging
        || rs.mood === 'done'
        || rs.mood === 'petted'
        || rs.mood === 'angry'
        || rs.mood === 'drink'
        || rs.mood === 'working'
        || now - rs.lastKeyPulseAt < 500
        || now - rs.lastTailSlapAt < 500;
      const minInterval = rs.mood === 'sleeping' ? 240 : activeMotion ? 16 : 34;
      if (now - lastDraw < minInterval) return;
      lastDraw = now;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rectW = Math.max(1, canvas.clientWidth);
      const rectH = Math.max(1, canvas.clientHeight);
      const targetW = Math.round(rectW * dpr);
      const targetH = Math.round(rectH * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rendererRef.current!.render(ctx, rectW, rectH, rs, now);
    };

    rafId = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(rafId);
  }, []);

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas || !rendererRef.current!.hitTest(event.nativeEvent.offsetX, event.nativeEvent.offsetY, canvas.clientWidth, canvas.clientHeight)) {
      return;
    }
    lastActivityAtRef.current = performance.now();
    dragRef.current = {
      pointerId: event.pointerId,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      startWinX: settingsRef.current.x ?? window.screenX,
      startWinY: settingsRef.current.y ?? window.screenY,
      offsetX: event.nativeEvent.offsetX,
      offsetY: event.nativeEvent.offsetY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.screenX - active.startScreenX;
    const dy = event.screenY - active.startScreenY;
    if (Math.hypot(dx, dy) >= 4 && !active.moved) {
      active.moved = true;
      setDragging(true);
      renderStateRef.current.dragging = true;
    }
    if (!active.moved) return;
    void window.__READX_PET__?.moveTo(active.startWinX + dx, active.startWinY + dy).then((pos) => {
      settingsRef.current = { ...settingsRef.current, x: pos.x, y: pos.y, peekEdge: pos.peekEdge };
      renderStateRef.current.peekEdge = pos.peekEdge;
    });
  };

  const handlePointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const wasMoved = active.moved;
    setDragging(false);
    renderStateRef.current.dragging = false;

    if (wasMoved) return;

    const canvas = canvasRef.current;
    const zone = canvas
      ? rendererRef.current!.hitZoneAt(active.offsetX, active.offsetY, canvas.clientWidth, canvas.clientHeight)
      : 'head';
    const now = performance.now();
    const rs = renderStateRef.current;
    lastActivityAtRef.current = now;

    // 1. 午睡时戳身体/尾巴 -> 触发可爱起床气；摸头则温柔唤醒
    if (rs.mood === 'sleeping' && zone !== 'head') {
      updateMood('angry');
      petAudio.playGrumpy(soundOn());
      rendererRef.current!.spawnBurst('anger', 175, 108, 2);
      setBubble({ kind: 'error', text: '吵醒本喵了！摸摸头才消气', expiresAt: Date.now() + 4500 });
      return;
    }

    // 2. 生气时摸头 -> 呼噜消气
    if (rs.mood === 'angry' && zone === 'head') {
      rs.lastPetAt = now;
      updateMood('petted');
      petAudio.playPurr(soundOn());
      rendererRef.current!.spawnBurst('heart', 140, 108, 5);
      setBubble({ kind: 'done', text: '呼噜…摸摸头就原谅你啦', expiresAt: Date.now() + 3400 });
      return;
    }

    // 3. 喝水提醒态被点击 -> 打卡关闭
    if (rs.mood === 'drink') {
      rs.lastPetAt = now;
      updateMood('petted');
      petAudio.playPurr(soundOn());
      rendererRef.current!.spawnBurst('heart', 140, 108, 4);
      setBubble({ kind: 'done', text: '喝水真乖！继续冲论文~', expiresAt: Date.now() + 3200 });
      return;
    }

    // 4. 戳尾巴 -> 甩尾抗议
    if (zone === 'tail') {
      rs.lastTailSlapAt = now;
      petAudio.playGrumpy(soundOn());
      setBubble({ kind: 'info', text: '别拽尾巴喵！', expiresAt: Date.now() + 2600 });
      return;
    }

    // 5. 点书桌 -> 翻论文页 + 闪光
    if (zone === 'desk') {
      rs.lastPageFlipAt = now;
      rendererRef.current!.spawnBurst('sparkle', 105, 224, 3);
      setBubble({ kind: 'info', text: '帮主人翻了一页论文~', expiresAt: Date.now() + 2400 });
      return;
    }

    // 6. 摸头或戳肚皮 -> 呼噜 / 轻喵 + 爱心
    rs.lastPetAt = now;
    updateMood('petted');
    if (zone === 'head') {
      petAudio.playPurr(soundOn());
      rendererRef.current!.spawnBurst('heart', 140, 108, 4);
    } else {
      petAudio.playMeow(soundOn());
      rendererRef.current!.spawnBurst('heart', 140, 152, 3);
    }
    if (!bubbleRef.current) {
      const hint = appStateRef.current.focusRunning && appStateRef.current.focusClock
        ? `专注进行中 · ${appStateRef.current.focusClock}`
        : PET_LINES[petLineIndexRef.current++ % PET_LINES.length]!;
      setBubble({ kind: 'info', text: hint, expiresAt: Date.now() + 3200 });
    }
  };

  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    window.__READX_PET__?.showContextMenu();
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    const types = event.dataTransfer.types;
    if (!types.includes('Files') && !types.includes('text/uri-list') && !types.includes('text/plain')) return;
    event.preventDefault();
    setDropHover(true);
    renderStateRef.current.dropHover = true;
    syncInteractive(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    const types = event.dataTransfer.types;
    if (!types.includes('Files') && !types.includes('text/uri-list') && !types.includes('text/plain')) return;
    event.preventDefault();
  };

  const handleDragLeave = () => {
    setDropHover(false);
    renderStateRef.current.dropHover = false;
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropHover(false);
    renderStateRef.current.dropHover = false;
    const files = Array.from(event.dataTransfer.files);
    if (files.length) {
      lastActivityAtRef.current = performance.now();
      updateMood('working');
      setBubble({ kind: 'working', text: `接住 ${files.length} 份文献，正在入库…` });

      void api.upload(files, undefined, undefined, (progressEvent) => {
        if (progressEvent.progress?.message) {
          setBubble({ kind: 'working', text: progressEvent.progress.message });
        }
      }).then((result) => {
        const first = result.results?.[0];
        if (first?.error) {
          updateMood('error');
          petAudio.playChime(soundOn(), 'error');
          setBubble({ kind: 'error', text: first.error, target: { kind: 'import' }, expiresAt: Date.now() + 8000 });
          return;
        }
        const doc = first?.document;
        const title = doc?.title || first?.name || '';
        updateMood('done');
        petAudio.playChime(soundOn(), 'done');
        setBubble({
          kind: 'done',
          text: title ? `已接住《${title.slice(0, 12)}》· 点击打开` : '论文已加入 ReadX 书库',
          target: doc ? { kind: 'document', id: doc.id, key: doc.key } : { kind: 'screen', screen: 'library' },
          expiresAt: Date.now() + 9000,
        });
        window.__READX_PET__?.notifyLibraryUpdated();
      }).catch((error) => {
        updateMood('error');
        petAudio.playChime(soundOn(), 'error');
        setBubble({
          kind: 'error',
          text: error instanceof Error ? error.message : '导入失败，点击打开书库重试',
          target: { kind: 'import' },
          expiresAt: Date.now() + 8000,
        });
      });
      return;
    }

    // 也支持拖入 arXiv / DOI / PDF 网址
    const droppedText = (event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain') || '').split('\n')[0]?.trim() ?? '';
    if (looksLikePaperLocator(droppedText)) {
      void importByLocator(droppedText);
    }
  };

  const handleRootMouseMove = (event: MouseEvent<HTMLElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    renderStateRef.current.cursor = { x, y };
    const overPet = rendererRef.current!.hitTest(x, y, canvas.clientWidth, canvas.clientHeight);
    const shouldInteract = overPet || Boolean(bubbleRef.current) || Boolean(dragRef.current);
    syncInteractive(shouldInteract);
  };

  const theme = appState.theme ?? 'light';
  const opacity = settings.opacity ?? 1;

  return (
    <main
      className="readx-pet-root"
      style={{ opacity }}
      onMouseMove={handleRootMouseMove}
      onMouseLeave={() => {
        if (!dragRef.current) syncInteractive(false);
      }}
      onContextMenu={handleContextMenu}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {bubble ? (
        <button
          type="button"
          className="readx-pet-bubble"
          data-theme={theme}
          data-kind={bubble.kind}
          onMouseEnter={() => syncInteractive(true)}
          onClick={() => {
            if (bubble.target) {
              window.__READX_PET__?.navigateMain(bubble.target);
            } else {
              window.__READX_PET__?.navigateMain({ kind: 'screen', screen: 'library' });
            }
          }}
          title="点击跳转到 ReadX 对应页面"
        >
          <span className="readx-pet-bubble-dot" aria-hidden="true" />
          <span className="readx-pet-bubble-text">{bubble.text}</span>
        </button>
      ) : null}

      {dropHover ? (
        <div className="readx-pet-drop-ring" aria-hidden="true">
          <span>松手喂给 ReadX 入库</span>
        </div>
      ) : null}

      <canvas
        ref={canvasRef}
        className={`readx-pet-canvas${hoverInteractive && (!settings.clickThrough || altHeld) ? ' is-grabbable' : ''}${dragging ? ' is-dragging' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={() => window.__READX_PET__?.navigateMain({ kind: 'screen', screen: 'library' })}
      />
    </main>
  );
}
