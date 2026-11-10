import { useEffect, useState } from 'react';
import { fileFormatLabel } from '../api/importLimits';
import './batch-shot.css';

export interface BatchShot { id: number; files: File[] }

export function ShotPaper({ file }: { file: File }) {
  return <><span className="shot-sheet"><span className="shot-fold" /><span className="shot-ln" style={{ top: 26, width: 24 }} /><span className="shot-ln" style={{ top: 33, width: 32 }} /><span className="shot-ln" style={{ top: 40, width: 28 }} /></span><span className="shot-tag">{fileFormatLabel(file.name)}</span></>;
}

const FLIGHT_MS = 1050;
const SINK_MS = 180;

/** Decorative volley: the upload request runs independently of this timeline. */
export function BatchShotVolley({ shot, from, rim, gravity, onLand, onComplete }: {
  shot: BatchShot; from: { x: number; y: number }; rim: { x: number; y: number }; gravity: number;
  onLand: () => void; onComplete: (id: number) => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const count = shot.files.length;
  // Large queues still finish the volley promptly; only airborne cards are rendered.
  const stagger = Math.min(170, 4000 / Math.max(1, count - 1));
  const duration = (count - 1) * stagger + FLIGHT_MS + SINK_MS;

  useEffect(() => {
    if (!count || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onComplete(shot.id);
      return;
    }
    const startedAt = performance.now();
    let landed = 0;
    let frame = 0;
    const tick = () => {
      const now = performance.now() - startedAt;
      const nextLanded = Math.max(0, Math.min(count, Math.floor((now - FLIGHT_MS) / stagger) + 1));
      if (nextLanded > landed) { landed = nextLanded; onLand(); }
      if (now >= duration) { onComplete(shot.id); return; }
      setElapsed(now);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [shot.id, count, stagger, duration, onLand, onComplete]);

  const landed = Math.max(0, Math.min(count, Math.floor((elapsed - FLIGHT_MS) / stagger) + 1));
  const launched = Math.min(count, Math.floor(elapsed / stagger) + 1);
  const firstVisible = Math.max(0, Math.ceil((elapsed - FLIGHT_MS - SINK_MS) / stagger));
  const seconds = FLIGHT_MS / 1000;
  const velocityX = (rim.x - from.x) / seconds;
  const velocityY = (rim.y - from.y - .5 * gravity * seconds * seconds) / seconds;

  return <>
    <div className="shot-batch-caption" role="status"><strong>连续投篮 {landed} / {count}</strong><span>{shot.files[Math.max(0, launched - 1)]?.name}</span></div>
    <div className="shot-batch-flights" aria-hidden="true">
      {shot.files.slice(firstVisible, launched).map((file, offset) => {
        const index = firstVisible + offset;
        const age = elapsed - index * stagger;
        const t = Math.min(age, FLIGHT_MS) / 1000;
        const progress = Math.min(1, age / FLIGHT_MS);
        const sink = Math.max(0, (age - FLIGHT_MS) / SINK_MS);
        const x = from.x + velocityX * t;
        const y = from.y + velocityY * t + .5 * gravity * t * t + sink * .14;
        const scale = (.8 + Math.sin(progress * Math.PI) * .15 - progress * .22) * (1 - sink * .7);
        return <span key={index} className={`shot-ball shot-batch-ball${sink > 0 ? ' is-sinking' : ''}`} style={{ left: `${x * 100}%`, top: `${y * 100}%`, opacity: Math.min(1, age / 90) * (1 - sink), transform: `translate(-50%, -50%) rotate(${-18 + progress * 30}deg) scale(${scale})` }}><ShotPaper file={file} /></span>;
      })}
    </div>
  </>;
}
