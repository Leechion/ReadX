import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ImportProgress, ImportedDocument } from '../api/client';
import { fileFormatLabel, isImportFileName } from '../api/importLimits';
import { BatchShotVolley, ShotPaper, type BatchShot } from './BatchShotVolley';

/**
 * 弹弓式上传（愤怒的小鸟手感）。
 *
 * 交互：
 *   1. 文件落在下方队列里，先选一张当"子弹"（点一下即可，默认自动选第一张）；
 *   2. 在发射点按住向**后下方**拉——拉得越远，初速越大；
 *   3. 拖拽期间显示**虚线抛物线**预测轨迹，终点画一个落点圈；
 *   4. 松手后文件沿这条抛物线飞出去；落点落在筐口内算进，开始该篇的导入与翻译，
 *      没进则弹回队列，可以重拉。
 *
 * 为什么用抛体而不是贝塞尔"摆过去"：既然是弹弓，速度就应当由拉伸量决定，
 * 轨迹也应当是可预测的重力抛物线——玩家看一眼虚线就知道能不能进。
 *
 * 几何：拖放区高度固定 ZONE_H，篮筐 SVG 贴底，因此筐口位置可静态算出。
 * 改 ZONE_H 必须同步改 CSS 里的 .shot-zone 高度，否则判定圈与画出来的筐错位。
 */

const ZONE_H = 340;

/** 篮筐 SVG 内部坐标：筐口中心在 (RIM_X, RIM_Y)。 */
const HOOP_W = 210;
const HOOP_H = 168;
const RIM_X = HOOP_W / 2;
const RIM_Y = 78;

/** 筐口在拖放区里的归一化位置（SVG 贴底，从下往上算）。 */
const RIM = {
  x: 0.5,
  y: (ZONE_H - (HOOP_H - RIM_Y)) / ZONE_H,
};

/** 发射点（弹弓皮兜的静止位置）：左下角。 */
const ANCHOR = { x: 0.14, y: 0.66 };

/** 篮圈内沿的半宽（归一化到拖放区宽度）：落点要落在这个横向范围内。 */
const RIM_HALF_WIDTH = 0.055;

/** 拉伸上限（归一化）：超过之后初速不再增加，避免手感失控。 */
const MAX_PULL = 0.34;

/** 重力加速度（归一化单位/秒²）。调它等于调"手感重量"。 */
const GRAVITY = 2.6;

type Phase = 'idle' | 'aiming' | 'flying' | 'working' | 'done' | 'failed';

interface Aim {
  /** 皮兜当前被拉到的位置（归一化）。 */
  x: number;
  y: number;
}

export interface ActiveImport {
  file: File;
  result: ImportedDocument | null;
  cancelled: boolean;
}

export interface ShotStageProps {
  queue: File[];
  /** 已投进、正在导入的文件。 */
  active: ActiveImport | null;
  current: (ImportProgress & { at: number }) | null;
  results: ImportedDocument[];
  busy: boolean;
  disabled?: boolean;
  batchShot?: BatchShot | null;
  batchBusy?: boolean;
  onBatchShotEnd: (id: number) => void;
  onQueue: (files: File[]) => void;
  onMake: (file: File) => void;
}

const STAGE_TEXT: Record<string, string> = {
  preparing: '检查文件',
  parse: '解析排版',
  upload: '上传中',
  received: '检查文件',
  metadata: 'AI 识别信息',
  translation: '翻译全文',
  saving: '保存书库',
  done: '已导入',
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** 网兜：两组斜线交出菱形 + 横向圈。方向必须一致，否则两族镜像成 X。 */
function useNet() {
  return useMemo(() => {
    const cx = RIM_X;
    const rx = 52;
    const botY = RIM_Y + 84;
    const botHalf = 34;
    const NT = 11;
    const top: [number, number][] = [];
    const bot: [number, number][] = [];
    for (let i = 0; i < NT; i += 1) {
      const a = Math.PI - (Math.PI * i) / (NT - 1);
      top.push([cx + rx * Math.cos(a), RIM_Y + 1.5 * Math.sin(a)]);
      bot.push([cx - botHalf + (2 * botHalf * i) / (NT - 1), botY]);
    }
    const line = (a: [number, number], b: [number, number], o: number) =>
      `M${a[0].toFixed(1)} ${a[1].toFixed(1)} L${b[0].toFixed(1)} ${b[1].toFixed(1)}|${o}`;
    const out: string[] = [];
    for (let i = 0; i < NT; i += 1) {
      if (i < NT - 1) out.push(line(top[i]!, bot[i + 1]!, 0.55));
      if (i > 0) out.push(line(top[i]!, bot[i - 1]!, 0.55));
      out.push(line(top[i]!, bot[i]!, 0.28));
    }
    for (const f of [0.34, 0.68]) {
      const ring = top.map((p, i) => [
        p[0] + (bot[i]![0] - p[0]) * f,
        p[1] + (bot[i]![1] - p[1]) * f,
      ] as [number, number]);
      for (let i = 0; i < NT - 1; i += 1) out.push(line(ring[i]!, ring[i + 1]!, 0.42));
    }
    for (let i = 0; i < NT - 1; i += 1) out.push(line(bot[i]!, bot[i + 1]!, 0.55));
    return out;
  }, []);
}

/** 由拉伸量算初速：方向与拉伸相反（向后拉→向前飞）。 */
function launchVelocity(aim: Aim) {
  const dx = ANCHOR.x - aim.x;
  const dy = ANCHOR.y - aim.y;
  const pull = Math.min(Math.hypot(dx, dy), MAX_PULL);
  if (pull < 0.02) return null;
  // 归一化方向后按拉伸量给速度；纵向略收，手感更接近抛体。
  const power = (pull / MAX_PULL) * 1.5;
  const len = Math.hypot(dx, dy) || 1;
  return { vx: (dx / len) * power, vy: (dy / len) * power * 0.72 };
}

/**
 * 解析抛物线 x(t)=ax0+vx·t, y(t)=ay0+vy·t+½g·t²，
 * 返回采样点与"下落穿过筐口高度"时的落点。
 * 用解析解而不是逐帧模拟，是为了让虚线预测与真实飞行**完全一致**——
 * 预测和结果不一致的话，这就是个骗人的准星。
 */
function trajectory(from: { x: number; y: number }, v: { vx: number; vy: number }) {
  const points: { x: number; y: number }[] = [];
  const steps = 46;
  const tf = 1.05;
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * tf;
    points.push({
      x: from.x + v.vx * t,
      y: from.y + v.vy * t + 0.5 * GRAVITY * t * t,
    });
  }
  // 解 y(t) = RIM.y 的较大根（下落段）
  const a = 0.5 * GRAVITY;
  const b = v.vy;
  const c = from.y - RIM.y;
  const disc = b * b - 4 * a * c;
  let landing: { x: number; y: number; t: number } | null = null;
  if (disc >= 0) {
    const t = (-b + Math.sqrt(disc)) / (2 * a);
    if (t > 0) landing = { x: from.x + v.vx * t, y: RIM.y, t };
  }
  return { points, landing };
}

/** 落点是否算进：横向落在篮圈内沿范围内。 */
function isMake(landing: { x: number } | null) {
  return Boolean(landing && Math.abs(landing.x - RIM.x) <= RIM_HALF_WIDTH);
}

export function UploadShotStage({
  queue,
  active,
  current,
  results,
  busy,
  disabled,
  batchShot,
  batchBusy,
  onBatchShotEnd,
  onQueue,
  onMake,
}: ShotStageProps) {
  const [hot, setHot] = useState(false);
  const [selectionNotice, setSelectionNotice] = useState('');
  const queueFiles = (selected: File[], folder = false) => {
    const documents = selected.filter((file) => isImportFileName(file.name) || file.type === 'application/pdf' || file.type === 'application/epub+zip');
    if (documents.length) onQueue(documents);
    const skipped = selected.length - documents.length;
    setSelectionNotice(folder
      ? `已从文件夹及子文件夹中找到 ${documents.length} 篇文献${skipped ? `，忽略 ${skipped} 个其他文件` : ''}`
      : skipped ? `已忽略 ${skipped} 个暂不支持的文件（支持 PDF / EPUB / TXT / MD / DOCX / FB2 / MOBI）` : '');
  };
  const [aim, setAim] = useState<Aim | null>(null);
  /** 正在飞行的球：起点、初速、起始时间；null 表示没在飞。 */
  const [flight, setFlight] = useState<{ file: File; from: Aim; v: { vx: number; vy: number }; start: number } | null>(null);
  const [missAt, setMissAt] = useState<{ x: number; nonce: number } | null>(null);
  const [madeNonce, setMadeNonce] = useState(0);
  /** 用文件对象保持选中项，移除前面的文件时不会选中另一篇。 */
  const [selected, setSelected] = useState<File | null>(null);
  const [, setFrame] = useState(0);
  const zoneRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const reduceMotion = useRef(
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const net = useNet();
  const onBatchLand = useCallback(() => setMadeNonce(value => value + 1), []);

  useEffect(() => {
    if (batchShot) zoneRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [batchShot?.id]);

  const toNorm = useCallback((clientX: number, clientY: number) => {
    const rect = zoneRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return { x: ANCHOR.x, y: ANCHOR.y };
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
  }, []);

  const velocity = aim ? launchVelocity(aim) : null;
  const preview = velocity ? trajectory(ANCHOR, velocity) : null;
  const willMake = isMake(preview?.landing ?? null);
  const queued = selected && queue.includes(selected) ? selected : queue[0] ?? null;
  const ammo = flight?.file ?? queued;

  /** 拉弓：按住发射点或球本身，向任意方向拖动。 */
  useEffect(() => {
    if (!aim || flight) return;
    if (busy || disabled) {
      setAim(null);
      return;
    }
    const onMove = (event: PointerEvent) => setAim(toNorm(event.clientX, event.clientY));
    const onUp = () => {
      const v = aim ? launchVelocity(aim) : null;
      if (v && ammo) {
        if (reduceMotion.current) {
          // 关掉动效时不留悬空状态：直接判定并按结果处理。
          if (isMake(trajectory(ANCHOR, v).landing)) {
            setMadeNonce((n) => n + 1);
            onMake(ammo);
          } else {
            setMissAt({ x: trajectory(ANCHOR, v).landing?.x ?? RIM.x, nonce: Date.now() });
          }
          setAim(null);
          return;
        }
        setFlight({ file: ammo, from: ANCHOR, v, start: performance.now() });
      }
      setAim(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    const onCancel = () => setAim(null);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [aim, flight, ammo, busy, disabled, onMake, toNorm]);

  /** 飞行：用与预测完全相同的解析式推进；到达落点那一刻判定。 */
  useEffect(() => {
    if (!flight) return;
    if (busy || disabled) {
      setFlight(null);
      return;
    }
    const v = flight.v;
    const a = 0.5 * GRAVITY;
    const b = v.vy;
    const c = flight.from.y - RIM.y;
    const disc = b * b - 4 * a * c;
    const endT = disc >= 0 ? (-b + Math.sqrt(disc)) / (2 * a) : 1.1;
    let raf = 0;
    const tick = () => {
      const t = (performance.now() - flight.start) / 1000;
      if (t >= Math.max(endT, 0.25)) {
        const landing = disc >= 0
          ? { x: flight.from.x + v.vx * endT, y: RIM.y }
          : null;
        if (isMake(landing)) {
          setMadeNonce((n) => n + 1);
          onMake(flight.file);
        } else {
          setMissAt({ x: landing?.x ?? RIM.x, nonce: Date.now() });
        }
        setFlight(null);
        return;
      }
      setFrame((n) => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [flight, busy, disabled, onMake]);

  useEffect(() => {
    if (!missAt) return;
    const timer = window.setTimeout(() => setMissAt(null), 900);
    return () => window.clearTimeout(timer);
  }, [missAt]);

  const [made, setMade] = useState(false);
  useEffect(() => {
    if (!madeNonce) return;
    setMade(true);
    const timer = window.setTimeout(() => setMade(false), 620);
    return () => window.clearTimeout(timer);
  }, [madeNonce]);

  const activeResult = active?.result;
  const activeState: Phase = !active
    ? 'idle'
    : activeResult
      ? activeResult.error ? 'failed' : 'done'
      : 'working';
  const terminal = activeState === 'failed' || activeState === 'done';
  const stopped = active?.cancelled;
  const measured = current != null && current.total > 0;
  const percent = measured && current ? Math.min(100, Math.floor((current.completed / current.total) * 100)) : null;
  const doneTotal = results.filter((item) => !item.error).length;

  /** 球当前所在位置：飞行中按解析式算，瞄准时在皮兜，否则在发射点。 */
  const ballAt = (() => {
    if (flight) {
      const t = (performance.now() - flight.start) / 1000;
      return {
        x: flight.from.x + flight.v.vx * t,
        y: flight.from.y + flight.v.vy * t + 0.5 * GRAVITY * t * t,
      };
    }
    return aim ?? ANCHOR;
  })();

  const pulling = Boolean(aim) && !flight;
  const pullBack = pulling && aim ? Math.hypot(ANCHOR.x - aim.x, ANCHOR.y - aim.y) : 0;

  return (
    <div className="shot-stage">
      <div
        ref={zoneRef}
        className={`shot-zone${hot ? ' hot' : ''}${disabled ? ' disabled' : ''}${pulling ? ' aiming' : ''}${batchShot ? ' batch-volley' : ''}`}
        onDragEnter={(event) => {
          event.preventDefault();
          if (disabled) return;
          dragDepth.current += 1;
          setHot(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setHot(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          dragDepth.current = 0;
          setHot(false);
          if (!disabled) queueFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <span className="shot-count">
          {batchBusy ? `批量处理中 · 已导入 ${doneTotal}` : active && !active.result ? `处理中 ${doneTotal + 1}` : `已导入 ${doneTotal}`}
        </span>

        <div className="shot-pickers">
        <label className="shot-picker" role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} onKeyDown={(event) => {
          if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            event.currentTarget.querySelector('input')?.click();
          }
        }}>
          选择文件
          <input
            type="file"
            accept=".pdf,.epub,.txt,.md,.docx,.fb2,.mobi,application/pdf,application/epub+zip,text/plain,text/markdown"
            multiple
            disabled={disabled}
            onChange={(event) => {
              queueFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
        </label>
        <label className="shot-picker" role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} onKeyDown={(event) => {
          if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            event.currentTarget.querySelector('input')?.click();
          }
        }}>
          选择文件夹
          <input
            type="file"
            multiple
            disabled={disabled}
            ref={(input) => { input?.setAttribute('webkitdirectory', ''); }}
            onChange={(event) => {
              queueFiles(Array.from(event.target.files ?? []), true);
              event.target.value = '';
            }}
          />
        </label>
        </div>

        {/* 虚线预测轨迹 + 落点圈：终点决定能不能进 */}
        <svg className="shot-aim" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {preview ? (
            <>
              <polyline
                className={`shot-path${willMake ? ' make' : ''}`}
                points={preview.points.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
                vectorEffect="non-scaling-stroke"
              />
              {preview.landing ? (
                <ellipse
                  className={`shot-landing${willMake ? ' make' : ''}`}
                  cx={preview.landing.x * 100}
                  cy={preview.landing.y * 100}
                  rx={RIM_HALF_WIDTH * 100}
                  ry={2.1}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </>
          ) : null}
        </svg>

        {batchShot && <BatchShotVolley key={batchShot.id} shot={batchShot} from={ANCHOR} rim={RIM} gravity={GRAVITY} onLand={onBatchLand} onComplete={onBatchShotEnd} />}
        <svg className="shot-hoop" viewBox={`0 0 ${HOOP_W} ${HOOP_H}`} aria-hidden="true">
          <rect className="shot-board" x={RIM_X - 46} y={RIM_Y - 64} width={92} height={52} rx={5} />
          <rect className="shot-bracket" x={RIM_X - 13} y={RIM_Y - 12} width={26} height={12} />
          <ellipse className="shot-rim" cx={RIM_X} cy={RIM_Y} rx={52} ry={7} fill="none" />
          <g key={madeNonce} className={`shot-net${made ? ' splash' : ''}`}>
            {net.map((item) => {
              const [d, o] = item.split('|');
              return <path key={item} d={d} opacity={o} />;
            })}
          </g>
        </svg>

        {made ? <span key={madeNonce} className="shot-ripple" style={{ left: `${RIM.x * 100}%`, top: `${RIM.y * 100}%` }} /> : null}
        {missAt ? (
          <span className="shot-miss" style={{ left: `${missAt.x * 100}%`, top: `${RIM.y * 100}%` }}>
            没进
          </span>
        ) : null}

        {/* 球（当前子弹），可按住拖动 */}
        {ammo && !batchShot ? (
          <span
            className={`shot-ball${flight ? ' flying' : ''}${pulling ? ' pulling' : ''}${willMake && pulling ? ' make' : ''}`}
            style={{ left: `${ballAt.x * 100}%`, top: `${ballAt.y * 100}%` }}
            onPointerDown={(event) => {
              if (disabled || busy || flight) return;
              event.preventDefault();
              setAim(toNorm(event.clientX, event.clientY));
            }}
            title={`${ammo.name} — 向后拉，松手投出`}
          >
            <ShotPaper file={ammo} />
          </span>
        ) : null}

        {/* 力度条：拉得越远越满 */}
        {pulling ? (
          <span className="shot-power">
            <span style={{ width: `${Math.min(100, (pullBack / MAX_PULL) * 100).toFixed(0)}%` }} />
          </span>
        ) : null}

        {batchShot ? null : batchBusy ? <div className="shot-invite"><strong>正在并行处理文献</strong></div> : !ammo ? (
          <div className="shot-invite">
            <strong>添加论文或文件夹</strong>
            <span>文件夹会包含子文件夹中的 PDF / EPUB / TXT / MD / DOCX / FB2 / MOBI</span>
          </div>
        ) : (
          <div className="shot-hint">
            {queue.length > 1 ? `队列还有 ${queue.length} 张 · ` : ''}
            按住纸片向后拉，虚线对准筐口
          </div>
        )}
      </div>

      {selectionNotice && <p className="text-xs text-ink-faint" role="status">{selectionNotice}</p>}
      {/* 队列：点选子弹 */}
      {queue.length ? (
        <ul className="shot-queue" aria-label="待投队列">
          {queue.map((file, index) => (
            <li key={`${file.name}-${index}`} className={`shot-chip${file === queued ? ' picked' : ''}`}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setSelected(file)}
                title={file === queued ? '当前子弹' : `选它当子弹：${file.name}`}
              >
                <span className="shot-mini" aria-hidden="true">
                  <svg viewBox="0 0 30 39">
                    <rect x="1" y="1" width="28" height="37" rx="3.5" className="shot-mini-page" />
                    <path d="M21 1 h8 v8 z" className="shot-mini-fold" />
                    <rect x="2" y="29" width="22" height="9" rx="2" className="shot-mini-tag" />
                    <text x="13" y="35.6" textAnchor="middle" fontSize="7" fontWeight="700" className="shot-mini-text">
                      {fileFormatLabel(file.name)}
                    </text>
                  </svg>
                </span>
                <span className="shot-chip-name" title={file.webkitRelativePath || file.name}>{file.name}</span>
                <span className="shot-chip-size">{humanSize(file.size)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {queued ? <div className="shot-quick-actions"><span title={queued.name}>{queued.name}</span><button type="button" className="primary-button" disabled={busy || disabled || Boolean(flight) || Boolean(aim)} onClick={() => onMake(queued)}>直接导入</button></div> : null}

      {/* 正在导入的那一篇 */}
      {active ? (
        <ul className="shot-rows" aria-label="导入进度">
          <li className={`shot-row ${activeState}`} data-state={activeState}>
            <span className="shot-mini" aria-hidden="true">
              <svg viewBox="0 0 30 39">
                <rect x="1" y="1" width="28" height="37" rx="3.5" className="shot-mini-page" />
                <path d="M21 1 h8 v8 z" className="shot-mini-fold" />
                <g className="shot-mini-lines">
                  <rect x="6" y="12" width="10" height="1.8" rx="1" />
                  <rect x="6" y="16" width="14" height="1.8" rx="1" />
                  <rect x="6" y="20" width="12" height="1.8" rx="1" />
                </g>
                <rect x="2" y="29" width="22" height="9" rx="2" className="shot-mini-tag" />
                <text x="13" y="35.6" textAnchor="middle" fontSize="7" fontWeight="700" className="shot-mini-text">
                  {fileFormatLabel(active.file.name)}
                </text>
              </svg>
            </span>
            <span className="shot-name" title={active.file.name}>{active.file.name}</span>
            <span className="shot-size">{humanSize(active.file.size)}</span>
            <span className="shot-state">
              {activeState === 'done'
                ? activeResult?.existing ? '书库已有' : '已导入'
                : activeState === 'failed'
                  ? stopped ? '已中断' : '失败'
                  : (current && STAGE_TEXT[current.stage]) || '已进筐'}
            </span>
            <span className="shot-track">
              <span
                className={`shot-bar${activeState === 'done' ? ' done' : ''}${activeState === 'failed' ? ' bad' : ''}${activeState === 'working' && !measured && !terminal ? ' unknown' : ''}`}
                style={
                  activeState === 'done'
                    ? { width: '100%' }
                    : activeState === 'working' && measured
                      ? { width: `${percent}%` }
                      : undefined
                }
              />
            </span>
            <span className={`shot-check${activeState === 'done' ? ' on' : ''}${activeState === 'failed' ? ' bad' : ''}`} aria-hidden="true">
              {activeState === 'failed' ? (
                <svg viewBox="0 0 16 16"><path d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5" /></svg>
              ) : (
                <svg viewBox="0 0 16 16"><path d="M3.4 8.6 L6.6 11.7 L12.6 4.9" /></svg>
              )}
            </span>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
