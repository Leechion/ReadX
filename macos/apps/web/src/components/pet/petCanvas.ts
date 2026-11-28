import type { PetAccessory, PetMood, PetPeekEdge, PetSkinId } from '@cbct/shared';

export type PetHitZone = 'head' | 'body' | 'tail' | 'desk' | null;

export interface PetRenderState {
  skin: PetSkinId;
  accessory: PetAccessory;
  mood: PetMood;
  theme: 'light' | 'dark' | 'paper';
  peekEdge: PetPeekEdge;
  focusRunning: boolean;
  focusClock?: string;
  voicePlaying: boolean;
  cursor: { x: number; y: number } | null;
  dragging: boolean;
  dropHover: boolean;
  lastKeyPulseAt: number;
  lastPetAt: number;
  lastTailSlapAt: number;
  lastPageFlipAt: number;
  moodChangedAt: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  kind: 'heart' | 'sparkle' | 'z' | 'anger' | 'drop';
}

interface IdleAct {
  kind: 'tilt' | 'slowBlink' | 'groom' | 'yawn' | 'stretch' | 'pageFlip';
  t0: number;
  dur: number;
  side: -1 | 1;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * ReadX 书房小黑猫（墨墨）2D 渲染器：
 * - 分区交互：头（摸头呼噜）/ 身体（吵醒起床气）/ 尾巴（甩尾抗议）/ 书桌（翻页）
 * - 自主待机动作：歪头、慢眨眼、舔爪洗脸、打哈欠、伸懒腰、翻论文页
 * - 书房配饰：墨绿领结、博士帽（流苏晃动）、金丝眼镜、暖红围巾、极简无配饰
 * - 书桌互动道具：迷你机械键盘、翻页论文、热气咖啡杯、专注小台灯、专注倒计时胶囊
 */
export class ReadXPetRenderer {
  private gazeX = 0;
  private gazeY = 0;
  private blinkUntil = 0;
  private nextBlinkAt = performance.now() + 2600 + Math.random() * 2400;
  private earTwitchAt = -10000;
  private nextEarAt = performance.now() + 4200 + Math.random() * 5200;
  private idleAct: IdleAct | null = null;
  private nextIdleActAt = performance.now() + 5500 + Math.random() * 4500;
  private keyToggle = 0;
  private lastTrackedKeyAt = -10000;
  private particles: Particle[] = [];
  private lastParticleAt = 0;
  private prevNow = performance.now();

  public spawnBurst(kind: Particle['kind'], cx: number, cy: number, count = 4): void {
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: cx + (Math.random() - 0.5) * 44,
        y: cy + (Math.random() - 0.5) * 18,
        vx: (Math.random() - 0.5) * 26,
        vy: -26 - Math.random() * 30,
        life: 0,
        maxLife: 0.9 + Math.random() * 0.55,
        kind,
      });
    }
  }

  /** 分区命中检测（坐标系基于 280x300 逻辑画布），支持头/身/尾/书桌差异化交互。 */
  public hitZoneAt(localX: number, localY: number, width: number, height: number): PetHitZone {
    const scale = Math.min(width / 280, height / 300);
    if (scale <= 0) return null;
    const lx = localX / scale;
    const ly = localY / scale;

    // 尾巴区域（右侧曲线）
    if (lx >= 186 && lx <= 236 && ly >= 146 && ly <= 222) return 'tail';
    // 书桌区域（底部）
    if (lx >= 50 && lx <= 230 && ly >= 216 && ly <= 262) return 'desk';
    // 头部与耳朵
    if (lx >= 82 && lx <= 198 && ly >= 86 && ly <= 182) return 'head';
    // 身体
    if (lx >= 84 && lx <= 196 && ly >= 182 && ly <= 222) return 'body';
    return null;
  }

  public hitTest(localX: number, localY: number, width: number, height: number): boolean {
    return this.hitZoneAt(localX, localY, width, height) !== null;
  }

  public render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    state: PetRenderState,
    now: number,
  ): void {
    const dt = Math.min(0.08, Math.max(0.001, (now - this.prevNow) / 1000));
    this.prevNow = now;

    if (state.lastKeyPulseAt !== this.lastTrackedKeyAt) {
      this.lastTrackedKeyAt = state.lastKeyPulseAt;
      this.keyToggle = (this.keyToggle + 1) % 6;
    }

    ctx.clearRect(0, 0, width, height);

    const scale = Math.min(width / 280, height / 300);
    ctx.save();
    ctx.scale(scale, scale);

    const cx = 140;
    const baseY = 232;

    // 视线追踪
    let targetGazeX = 0;
    let targetGazeY = 0;
    if (state.cursor && state.mood !== 'sleeping') {
      targetGazeX = clamp((state.cursor.x / Math.max(1, width) - 0.5) * 2, -1, 1);
      targetGazeY = clamp((state.cursor.y / Math.max(1, height) - 0.55) * 2, -1, 1);
    }
    const gazeEase = Math.min(1, dt * 9);
    this.gazeX = lerp(this.gazeX, targetGazeX, gazeEase);
    this.gazeY = lerp(this.gazeY, targetGazeY, gazeEase);

    // 眨眼、耳动与自主待机动作调度
    if (now >= this.nextBlinkAt) {
      this.blinkUntil = now + 130;
      this.nextBlinkAt = now + 2600 + Math.random() * 3200;
    }
    if (now >= this.nextEarAt) {
      this.earTwitchAt = now;
      this.nextEarAt = now + 4000 + Math.random() * 5400;
    }
    this.updateIdleAct(state, now);
    this.updateParticles(state, now, dt, cx, baseY);

    const peekTilt = state.peekEdge === 'left' ? 0.12 : state.peekEdge === 'right' ? -0.12 : 0;
    const peekShiftX = state.peekEdge === 'left' ? 14 : state.peekEdge === 'right' ? -14 : 0;
    const dragLift = state.dragging ? -6 : 0;
    const stretchLift = this.idleAct?.kind === 'stretch'
      ? Math.sin(((now - this.idleAct.t0) / this.idleAct.dur) * Math.PI) * -9
      : 0;
    const breath = state.mood === 'sleeping'
      ? Math.sin(now * 0.0022) * 1.6
      : Math.sin(now * 0.0036) * 2.1;

    ctx.save();
    ctx.translate(cx + peekShiftX, baseY + dragLift);
    ctx.rotate(peekTilt);

    this.drawDeskShadow(ctx, state);
    if (state.focusRunning) {
      this.drawDeskLamp(ctx, now, state.theme);
    }

    this.drawKuroCatCharacter(ctx, now, breath + stretchLift, state);
    this.drawStudyDesk(ctx, now, state);
    this.drawForegroundPaws(ctx, now, state);

    ctx.restore();

    this.drawParticles(ctx);
    ctx.restore();
  }

  private updateIdleAct(state: PetRenderState, now: number): void {
    if (state.mood !== 'idle' || state.dragging) {
      this.idleAct = null;
      return;
    }
    if (this.idleAct && now >= this.idleAct.t0 + this.idleAct.dur) {
      this.idleAct = null;
      this.nextIdleActAt = now + 5200 + Math.random() * 5600;
    }
    if (!this.idleAct && now >= this.nextIdleActAt) {
      const kinds: IdleAct['kind'][] = ['tilt', 'slowBlink', 'groom', 'yawn', 'stretch', 'pageFlip'];
      const kind = kinds[Math.floor(Math.random() * kinds.length)]!;
      const dur = kind === 'groom' ? 1700 : kind === 'yawn' ? 1400 : kind === 'stretch' ? 1500 : 1200;
      this.idleAct = { kind, t0: now, dur, side: Math.random() < 0.5 ? -1 : 1 };
    }
  }

  private updateParticles(state: PetRenderState, now: number, dt: number, cx: number, baseY: number): void {
    if (state.mood === 'sleeping' && now - this.lastParticleAt > 1150) {
      this.lastParticleAt = now;
      this.particles.push({
        x: cx + 34,
        y: baseY - 102,
        vx: 10,
        vy: -22,
        life: 0,
        maxLife: 1.5,
        kind: 'z',
      });
    } else if (state.mood === 'petted' && now - state.lastPetAt < 1800 && now - this.lastParticleAt > 400) {
      this.lastParticleAt = now;
      this.spawnBurst('heart', cx, baseY - 122, 1);
    } else if (state.mood === 'done' && now - state.moodChangedAt < 2500 && now - this.lastParticleAt > 460) {
      this.lastParticleAt = now;
      this.spawnBurst('sparkle', cx, baseY - 122, 2);
    } else if (state.mood === 'drink' && now - this.lastParticleAt > 650) {
      this.lastParticleAt = now;
      this.spawnBurst('drop', cx + 52, baseY - 46, 1);
    } else if (state.mood === 'angry' && now - state.moodChangedAt < 2400 && now - this.lastParticleAt > 700) {
      this.lastParticleAt = now;
      this.particles.push({
        x: cx + 38,
        y: baseY - 126,
        vx: 6,
        vy: -14,
        life: 0,
        maxLife: 0.9,
        kind: 'anger',
      });
    }

    this.particles = this.particles.filter((p) => {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      return p.life < p.maxLife;
    });
  }

  private drawParticles(ctx: CanvasRenderingContext2D): void {
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      const alpha = t < 0.2 ? t / 0.2 : Math.max(0, 1 - (t - 0.2) / 0.8);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      if (p.kind === 'heart') {
        ctx.fillStyle = '#e56b82';
        ctx.beginPath();
        ctx.moveTo(0, 3);
        ctx.bezierCurveTo(-6, -2, -6, -8, 0, -4);
        ctx.bezierCurveTo(6, -8, 6, -2, 0, 3);
        ctx.fill();
      } else if (p.kind === 'sparkle') {
        ctx.fillStyle = '#2b6651';
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const ang = (i * Math.PI) / 2;
          ctx.lineTo(Math.cos(ang) * 6, Math.sin(ang) * 6);
          ctx.lineTo(Math.cos(ang + Math.PI / 4) * 2, Math.sin(ang + Math.PI / 4) * 2);
        }
        ctx.closePath();
        ctx.fill();
      } else if (p.kind === 'drop') {
        ctx.fillStyle = '#4a9ad4';
        ctx.beginPath();
        ctx.moveTo(0, -6);
        ctx.quadraticCurveTo(5, 1, 0, 5);
        ctx.quadraticCurveTo(-5, 1, 0, -6);
        ctx.fill();
      } else if (p.kind === 'anger') {
        ctx.strokeStyle = '#d6453a';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(-4, -4);
        ctx.quadraticCurveTo(-1, -1, -4, 4);
        ctx.moveTo(4, -4);
        ctx.quadraticCurveTo(1, -1, 4, 4);
        ctx.moveTo(-4, -4);
        ctx.quadraticCurveTo(0, -1, 4, -4);
        ctx.moveTo(-4, 4);
        ctx.quadraticCurveTo(0, 1, 4, 4);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#5f6e64';
        ctx.font = '700 13px sans-serif';
        ctx.fillText('Z', 0, 0);
      }
      ctx.restore();
    }
  }

  private drawDeskShadow(ctx: CanvasRenderingContext2D, state: PetRenderState): void {
    ctx.save();
    ctx.fillStyle = state.theme === 'dark' ? 'rgba(0, 0, 0, 0.36)' : 'rgba(22, 38, 30, 0.14)';
    ctx.beginPath();
    ctx.ellipse(0, 24, 86, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawDeskLamp(ctx: CanvasRenderingContext2D, now: number, theme: PetRenderState['theme']): void {
    ctx.save();
    const glow = 0.25 + Math.sin(now * 0.004) * 0.04;
    const grad = ctx.createRadialGradient(-68, -68, 4, -68, -56, 58);
    grad.addColorStop(0, `rgba(255, 226, 150, ${glow + 0.18})`);
    grad.addColorStop(1, 'rgba(255, 226, 150, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(-68, -56, 58, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = theme === 'dark' ? '#95ab9e' : '#354b41';
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-74, -4);
    ctx.quadraticCurveTo(-84, -46, -68, -72);
    ctx.stroke();

    ctx.fillStyle = '#2b6651';
    ctx.beginPath();
    ctx.moveTo(-79, -68);
    ctx.lineTo(-55, -75);
    ctx.lineTo(-51, -60);
    ctx.lineTo(-76, -57);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawKuroCatCharacter(
    ctx: CanvasRenderingContext2D,
    now: number,
    breath: number,
    state: PetRenderState,
  ): void {
    const isDark = state.theme === 'dark';
    const fur = isDark ? '#202624' : '#1b201e';
    const furOutline = isDark ? '#54665d' : '#101412';
    const earInner = '#d98c94';
    const recentKey = now - state.lastKeyPulseAt < 240;
    const tailSlapAge = now - state.lastTailSlapAt;
    const tailSlapping = tailSlapAge >= 0 && tailSlapAge < 420;
    const excited = state.mood === 'done' || state.mood === 'petted';
    const grumpyShake = state.mood === 'angry' && now - state.moodChangedAt < 450
      ? Math.sin(now * 0.06) * 2.5
      : 0;
    const bounce = excited ? Math.abs(Math.sin(now * 0.011)) * -6 : 0;

    ctx.save();
    ctx.translate(grumpyShake, breath + bounce);

    // 尾巴（甩尾拍打 / 开心快速摇 / 平常轻摆）
    const tailSpeed = tailSlapping ? 0.036 : (excited || state.mood === 'working' || recentKey ? 0.01 : 0.0032);
    const tailAmp = tailSlapping ? 22 : excited ? 14 : state.mood === 'angry' ? 16 : 7;
    const tailWag = Math.sin(now * tailSpeed) * tailAmp;
    const tailTipY = tailSlapping ? -32 : -70;
    ctx.save();
    ctx.strokeStyle = fur;
    ctx.lineWidth = state.mood === 'angry' ? 13 : 11;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(46, -16);
    ctx.quadraticCurveTo(78 + tailWag * 0.5, -34, 72 + tailWag, tailTipY);
    ctx.stroke();
    ctx.restore();

    // 圆润身体
    ctx.fillStyle = fur;
    ctx.strokeStyle = furOutline;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.ellipse(0, -34, 50, 44, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 颈部配饰（墨绿领结 / 暖红围巾）
    if (state.accessory === 'bowtie') {
      ctx.fillStyle = '#2b6651';
      ctx.beginPath();
      ctx.moveTo(0, -45);
      ctx.lineTo(-13, -52);
      ctx.lineTo(-11, -38);
      ctx.closePath();
      ctx.moveTo(0, -45);
      ctx.lineTo(13, -52);
      ctx.lineTo(11, -38);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#e5b85b';
      ctx.beginPath();
      ctx.arc(0, -45, 3.2, 0, Math.PI * 2);
      ctx.fill();
    } else if (state.accessory === 'scarf') {
      ctx.fillStyle = '#c44b42';
      ctx.beginPath();
      ctx.roundRect(-28, -53, 56, 13, 6);
      ctx.fill();
      ctx.fillStyle = '#d96259';
      ctx.beginPath();
      ctx.roundRect(8, -44, 13, 22, 4);
      ctx.fill();
      ctx.fillStyle = '#f2d388';
      ctx.fillRect(10, -28, 9, 2.5);
    }

    // 头部姿态
    let tilt = 0;
    if (state.mood === 'thinking') {
      tilt = Math.sin(now * 0.002) * 0.05 - 0.09;
    } else if (state.mood === 'waiting' || state.mood === 'drink') {
      tilt = 0.07;
    } else if (this.idleAct?.kind === 'tilt') {
      const p = (now - this.idleAct.t0) / this.idleAct.dur;
      tilt = Math.sin(p * Math.PI) * 0.14 * this.idleAct.side;
    }

    const sleepDrop = state.mood === 'sleeping' ? 8 : 0;
    ctx.save();
    ctx.translate(0, -90 + sleepDrop);
    ctx.rotate(tilt);

    // 双耳（生气压扁飞机耳，平时偶尔抽动）
    const twitchAge = now - this.earTwitchAt;
    const rightEarAngle = twitchAge >= 0 && twitchAge < 220 ? Math.sin((twitchAge / 220) * Math.PI) * 0.16 : 0;
    const flatEar = state.mood === 'angry' || state.mood === 'error' ? 0.32 : 0;
    const drawEar = (side: -1 | 1, extraRot: number) => {
      ctx.save();
      ctx.translate(side * 34, -30);
      ctx.rotate(side * (0.22 + flatEar) + extraRot);
      ctx.fillStyle = fur;
      ctx.strokeStyle = furOutline;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(-16, 12);
      ctx.quadraticCurveTo(-4, -26, 2, -28);
      ctx.quadraticCurveTo(10, -24, 17, 10);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = earInner;
      ctx.beginPath();
      ctx.moveTo(-8, 6);
      ctx.quadraticCurveTo(-1, -14, 2, -16);
      ctx.quadraticCurveTo(7, -13, 10, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    drawEar(-1, 0);
    drawEar(1, rightEarAngle);

    // 脑袋轮廓
    ctx.fillStyle = fur;
    ctx.strokeStyle = furOutline;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.ellipse(0, 0, 48, 40, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 博士学士帽配饰
    if (state.accessory === 'gradcap') {
      const tasselSwing = Math.sin(now * 0.005) * 4;
      ctx.save();
      ctx.translate(0, -34);
      ctx.fillStyle = '#1f2e28';
      ctx.strokeStyle = '#3d594c';
      ctx.lineWidth = 1.6;
      // 帽顶菱形
      ctx.beginPath();
      ctx.moveTo(0, -14);
      ctx.lineTo(36, -3);
      ctx.lineTo(0, 7);
      ctx.lineTo(-36, -3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // 帽箍
      ctx.beginPath();
      ctx.roundRect(-18, 2, 36, 9, 4);
      ctx.fill();
      // 金色流苏
      ctx.strokeStyle = '#e5b85b';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(0, -3);
      ctx.lineTo(28, 0);
      ctx.lineTo(30 + tasselSwing, 16);
      ctx.stroke();
      ctx.fillStyle = '#e5b85b';
      ctx.beginPath();
      ctx.arc(30 + tasselSwing, 17, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 眼睛
    const slowBlinking = this.idleAct?.kind === 'slowBlink';
    const yawning = this.idleAct?.kind === 'yawn';
    const blinking = now < this.blinkUntil || slowBlinking || yawning;
    const eyeY = -2 + this.gazeY * 2;
    const gx = this.gazeX * 3.5;
    const gy = this.gazeY * 2.5;

    for (const side of [-1, 1] as const) {
      const ex = side * 19;
      if (state.mood === 'sleeping' || blinking) {
        ctx.strokeStyle = '#9fd1b8';
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(ex, eyeY + 2, 7.5, 0.2, Math.PI - 0.2);
        ctx.stroke();
      } else if (state.mood === 'done' || state.mood === 'petted') {
        ctx.strokeStyle = '#f2c96d';
        ctx.lineWidth = 2.8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(ex, eyeY + 4, 8, Math.PI + 0.3, -0.3);
        ctx.stroke();
      } else if (state.mood === 'error') {
        ctx.strokeStyle = '#ef7e74';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(ex - 5, eyeY - 5);
        ctx.lineTo(ex + 5, eyeY + 5);
        ctx.moveTo(ex + 5, eyeY - 5);
        ctx.lineTo(ex - 5, eyeY + 5);
        ctx.stroke();
      } else {
        const grad = ctx.createRadialGradient(ex + gx * 0.4, eyeY - 3, 2, ex, eyeY, 11);
        grad.addColorStop(0, '#f4d97b');
        grad.addColorStop(1, '#58a87b');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(ex, eyeY, 9.2, state.mood === 'angry' ? 7.4 : 9.8, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#111614';
        ctx.beginPath();
        ctx.ellipse(ex + gx, eyeY + gy, state.mood === 'angry' ? 2.8 : 4.4, 5.6, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(ex + gx - 2.3, eyeY + gy - 2.6, 2.2, 0, Math.PI * 2);
        ctx.fill();

        // 起床气八字怒眉
        if (state.mood === 'angry') {
          ctx.strokeStyle = '#e58e7e';
          ctx.lineWidth = 2.6;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(ex - side * 9, eyeY - 6);
          ctx.lineTo(ex + side * 8, eyeY - 12);
          ctx.stroke();
        }
      }
    }

    // 眼镜（学者配饰 或 thinking 状态自动佩戴）
    if (state.accessory === 'glasses' || state.mood === 'thinking') {
      ctx.strokeStyle = '#d7b878';
      ctx.lineWidth = 1.9;
      ctx.beginPath();
      ctx.arc(-19, eyeY, 12.2, 0, Math.PI * 2);
      ctx.moveTo(-6.8, eyeY);
      ctx.lineTo(6.8, eyeY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(19, eyeY, 12.2, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 腮红
    if (state.mood === 'petted' || state.mood === 'done' || state.mood === 'angry') {
      ctx.fillStyle = state.mood === 'angry' ? 'rgba(225, 86, 86, 0.45)' : 'rgba(235, 118, 138, 0.48)';
      ctx.beginPath();
      ctx.ellipse(-28, 10, 7, 4, 0, 0, Math.PI * 2);
      ctx.ellipse(28, 10, 7, 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 鼻子 & 嘴巴（打哈欠 / 起床气 / 常规 w 嘴）
    ctx.fillStyle = '#ea99a2';
    ctx.beginPath();
    ctx.ellipse(0, 9, 3.2, 2.2, 0, 0, Math.PI * 2);
    ctx.fill();

    if (yawning) {
      ctx.fillStyle = '#d97885';
      ctx.beginPath();
      ctx.ellipse(0, 17, 6.2, 7.2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (state.mood === 'angry') {
      ctx.strokeStyle = '#e59992';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-6, 17);
      ctx.quadraticCurveTo(0, 13, 6, 17);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#d8ded9';
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-6, 14);
      ctx.quadraticCurveTo(-3, 18, 0, 14);
      ctx.quadraticCurveTo(3, 18, 6, 14);
      ctx.stroke();
    }

    // 舔爪洗脸动画
    if (this.idleAct?.kind === 'groom') {
      const p = (now - this.idleAct.t0) / this.idleAct.dur;
      const rub = Math.sin(p * Math.PI * 4) * 5;
      ctx.fillStyle = fur;
      ctx.strokeStyle = furOutline;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(22, 10 + rub, 10, 8, -0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // 语音速听耳机
    if (state.voicePlaying) {
      this.drawHeadphones(ctx, -49, 49, -6);
    }

    ctx.restore();
    ctx.restore();
  }

  private drawHeadphones(ctx: CanvasRenderingContext2D, leftX: number, rightX: number, earY: number): void {
    ctx.save();
    ctx.strokeStyle = '#2b6651';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, earY - 4, Math.abs(rightX) - 2, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();

    ctx.fillStyle = '#2b6651';
    ctx.strokeStyle = '#e4efe8';
    ctx.lineWidth = 1.8;
    for (const x of [leftX, rightX]) {
      ctx.beginPath();
      ctx.roundRect(x - 6, earY - 12, 12, 24, 6);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawStudyDesk(ctx: CanvasRenderingContext2D, now: number, state: PetRenderState): void {
    const isDark = state.theme === 'dark';
    const isPaper = state.theme === 'paper';
    const deskFill = isDark ? '#25312c' : isPaper ? '#e7dcc8' : '#e4efe8';
    const deskStroke = isDark ? '#4a6257' : '#2b6651';
    const sheetFill = isDark ? '#1a211e' : '#ffffff';
    const recentKey = now - state.lastKeyPulseAt < 220;
    const flipping = (now - state.lastPageFlipAt < 450) || this.idleAct?.kind === 'pageFlip';

    ctx.save();
    // 迷你书桌台面
    ctx.fillStyle = deskFill;
    ctx.strokeStyle = deskStroke;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.roundRect(-88, -14, 176, 36, 11);
    ctx.fill();
    ctx.stroke();

    // 左侧打开的论文书页
    ctx.fillStyle = sheetFill;
    ctx.strokeStyle = isDark ? '#3c4d45' : '#c9d3ca';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.roundRect(-64, -9, 54, 24, 4);
    ctx.fill();
    ctx.stroke();

    if (flipping) {
      ctx.fillStyle = isDark ? '#2e3c35' : '#eef5f0';
      ctx.beginPath();
      ctx.moveTo(-37, -9);
      ctx.quadraticCurveTo(-24, -18, -12, -8);
      ctx.lineTo(-12, 15);
      ctx.lineTo(-37, 15);
      ctx.closePath();
      ctx.fill();
    }

    const activeLine = state.mood === 'working' ? Math.floor((now / 260) % 3) : -1;
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i === activeLine ? '#2b6651' : (isDark ? '#586960' : '#b7c4bc');
      ctx.fillRect(-57, -3 + i * 6, i === 2 ? 26 : 38, 2);
    }

    // 中间偏右迷你机械键盘（打字时键帽发光！）
    ctx.fillStyle = isDark ? '#181e1b' : '#2d3b34';
    ctx.beginPath();
    ctx.roundRect(-4, -8, 56, 22, 4);
    ctx.fill();
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 6; col++) {
        const idx = row * 6 + col;
        const lit = (recentKey || state.mood === 'working') && (idx % 6 === this.keyToggle);
        ctx.fillStyle = lit ? '#7ad4a5' : (isDark ? '#3a4942' : '#d8e3dc');
        ctx.fillRect(0 + col * 8, -4 + row * 8, 6, 5);
      }
    }

    // 右侧小热茶/咖啡杯（喝水提醒时微微举起晃动！）
    const mugLift = state.mood === 'drink' ? Math.sin(now * 0.012) * 4 - 8 : 0;
    ctx.save();
    ctx.translate(66, -3 + mugLift);
    // 热气
    ctx.strokeStyle = isDark ? 'rgba(210, 230, 220, 0.45)' : 'rgba(43, 102, 81, 0.35)';
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    const steam = Math.sin(now * 0.004) * 2.5;
    ctx.beginPath();
    ctx.moveTo(-3, -10);
    ctx.quadraticCurveTo(-3 + steam, -16, -1, -21);
    ctx.moveTo(3, -10);
    ctx.quadraticCurveTo(3 - steam, -15, 2, -20);
    ctx.stroke();
    // 杯身
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#2b6651';
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.roundRect(-8, -8, 16, 17, 4);
    ctx.fill();
    ctx.stroke();
    // 杯把
    ctx.beginPath();
    ctx.arc(8, 0, 4, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.restore();

    // 专注倒计时迷你徽章（开启番茄钟时贴在书桌左下角）
    if (state.focusRunning && state.focusClock) {
      ctx.fillStyle = '#2b6651';
      ctx.beginPath();
      ctx.roundRect(-84, 15, 58, 15, 7);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 9.5px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(state.focusClock, -55, 22.8);
    }

    // 警告/待确认小圆标
    if (state.mood === 'waiting' || state.mood === 'error') {
      ctx.fillStyle = state.mood === 'error' ? '#b03a2e' : '#c58422';
      ctx.beginPath();
      ctx.arc(76, -16, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', 76, -15.5);
    }

    ctx.restore();
  }

  private drawForegroundPaws(ctx: CanvasRenderingContext2D, now: number, state: PetRenderState): void {
    const recentKey = now - state.lastKeyPulseAt < 220;
    const pawFill = state.theme === 'dark' ? '#242b28' : '#1b201e';
    const pawStroke = state.theme === 'dark' ? '#54665d' : '#0f1311';

    const typing = state.mood === 'working' || recentKey;
    const tapLeft = typing ? (this.keyToggle % 2 === 0 ? -5 : 1) : 0;
    const tapRight = typing ? (this.keyToggle % 2 === 1 ? -5 : 1) : 0;
    const raiseRight = state.mood === 'waiting' || state.mood === 'drink' ? -18 : 0;

    const drawPaw = (x: number, y: number) => {
      ctx.save();
      ctx.fillStyle = pawFill;
      ctx.strokeStyle = pawStroke;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y, 12.5, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#e59aa3';
      ctx.beginPath();
      ctx.arc(x, y + 1, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    drawPaw(-26, -11 + tapLeft);
    drawPaw(32, -11 + tapRight + raiseRight);
  }
}
