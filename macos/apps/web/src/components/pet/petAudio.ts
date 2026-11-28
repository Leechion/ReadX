/**
 * 轻量 Web Audio 拟声引擎（零外置音频文件）：
 * 合成柔和的 24.5Hz 猫呼噜、轻喵、起床气哼声与任务完成提示铃。
 */
class PetAudioEngine {
  private ctx: AudioContext | null = null;
  private lastPurrAt = 0;
  private lastChimeAt = 0;

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!this.ctx) {
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /** 24.5Hz 温柔呼噜声（摸头触发） */
  public playPurr(enabled: boolean): void {
    if (!enabled) return;
    const nowMs = performance.now();
    if (nowMs - this.lastPurrAt < 700) return;
    this.lastPurrAt = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const dur = 0.72;

    const carrier = ctx.createOscillator();
    carrier.type = 'sawtooth';
    carrier.frequency.setValueAtTime(52, t0);
    carrier.frequency.linearRampToValueAtTime(46, t0 + dur);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(24.5, t0);

    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(0.032, t0);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(165, t0);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(0.055, t0 + 0.14);
    env.gain.setValueAtTime(0.048, t0 + dur - 0.22);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    lfo.connect(lfoGain);
    lfoGain.connect(env.gain);
    carrier.connect(filter);
    filter.connect(env);
    env.connect(ctx.destination);

    carrier.start(t0);
    lfo.start(t0);
    carrier.stop(t0 + dur + 0.02);
    lfo.stop(t0 + dur + 0.02);
  }

  /** 轻柔“喵~”问候音 */
  public playMeow(enabled: boolean): void {
    if (!enabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t0 = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(540, t0);
    osc.frequency.exponentialRampToValueAtTime(760, t0 + 0.09);
    osc.frequency.exponentialRampToValueAtTime(470, t0 + 0.28);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(980, t0);
    filter.Q.setValueAtTime(1.8, t0);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(0.055, t0 + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.32);
  }

  /** 起床气短促“哼喵！” */
  public playGrumpy(enabled: boolean): void {
    if (!enabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t0 = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(340, t0);
    osc.frequency.exponentialRampToValueAtTime(210, t0 + 0.22);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(620, t0);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(0.048, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.26);
  }

  /** 书房风铃提示音（论文就绪 / 报错 / 喝水提醒） */
  public playChime(enabled: boolean, kind: 'done' | 'error' | 'water'): void {
    if (!enabled) return;
    const nowMs = performance.now();
    if (nowMs - this.lastChimeAt < 1000) return;
    this.lastChimeAt = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const notes = kind === 'done'
      ? [659.25, 880]
      : kind === 'water'
        ? [523.25, 659.25, 783.99]
        : [330, 261.63];

    notes.forEach((freq, idx) => {
      const start = t0 + idx * 0.11;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.05, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.34);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.36);
    });
  }
}

export const petAudio = new PetAudioEngine();
