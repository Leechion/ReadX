'use strict';
// ---- Built to be checked ----------------------------------------------------------------
const params = new URLSearchParams(location.search);
const tune = new Proxy({}, { get: (_, k) => CONFIG[k].value });
const STEP = 1 / 60;
const W = 1280, H = 720;
const PIXEL = false;
const FONT = 'sans-serif';
const TITLE = '一夫当关';
const CONTROLS = ['鼠标:点左下选塔,再点草地落位', '点已放的塔:U 升级 · S 卖出(回 70%)', '空格:提前叫下一波 · P: 暂停 · M: 静音'];
const clock = window.GAME_CLOCK || { now: () => performance.now() / 1000 };
const CHEAP = params.get('render') === 'cheap';
let seed;
function rng() {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const events = [];

// ---- Screen ------------------------------------------------------------------------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
function fit() {
  const k = Math.min(innerWidth / W, innerHeight / H);
  const s = PIXEL ? Math.max(1, Math.floor(k)) : k;
  const r = PIXEL ? 1 : s * (devicePixelRatio || 1);
  canvas.width = Math.round(W * r); canvas.height = Math.round(H * r);
  canvas.style.width = Math.round(W * s) + 'px'; canvas.style.height = Math.round(H * s) + 'px';
  canvas.style.marginTop = Math.max(0, Math.floor((innerHeight - H * s) / 2)) + 'px';
  canvas.style.imageRendering = PIXEL ? 'pixelated' : 'auto';
  ctx.setTransform(r, 0, 0, r, 0, 0); ctx.imageSmoothingEnabled = !PIXEL;
}
addEventListener('resize', fit); fit();
function clear(c) { ctx.fillStyle = c; ctx.fillRect(0, 0, W, H); }
function text(s, x, y, size, c, align = 'center') {
  ctx.fillStyle = c; ctx.font = `${size}px ${FONT}`; ctx.textAlign = align;
  ctx.textBaseline = 'middle'; ctx.fillText(s, x, y);
}

// ---- Input -------------------------------------------------------------------------------
const down = new Set(), hit = new Set();
const pressed = code => hit.has(code);
let px = 0, py = 0, clicked = false;
addEventListener('keydown', e => {
  startAudio();
  if (!e.repeat) { down.add(e.code); hit.add(e.code); }
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', e => down.delete(e.code));
addEventListener('pointerdown', e => { startAudio(); clicked = true; const r = canvas.getBoundingClientRect(); px = (e.clientX - r.left) / r.width * W; py = (e.clientY - r.top) / r.height * H; });
addEventListener('pointermove', e => { const r = canvas.getBoundingClientRect(); px = (e.clientX - r.left) / r.width * W; py = (e.clientY - r.top) / r.height * H; });
addEventListener('blur', () => down.clear());

// ---- Audio -------------------------------------------------------------------------------
let audio = null, muted = false;
function startAudio() {
  if (!audio) {
    const ac = window.GAME_AUDIO || new (window.AudioContext || window.webkitAudioContext)();
    const out = ac.createGain(); out.gain.value = muted ? 0 : tune.volume;
    out.connect(ac.destination); audio = { ac, out };
  }
  if (audio.ac.state === 'suspended') audio.ac.resume();
}
function setMuted(m) { muted = m; if (audio) audio.out.gain.value = m ? 0 : tune.volume; }
addEventListener('tune', () => setMuted(muted));
function tone(freq, dur, type = 'square', vol = 0.3) {
  if (!audio || muted) return;
  const t = audio.ac.currentTime, o = audio.ac.createOscillator(), g = audio.ac.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(audio.out); o.start(t); o.stop(t + dur);
}

// ---- 地图:入口在左,城门在右;路径蜿蜒 ----------------------------------------------------------------
const PATH = [[-40, 140], [300, 140], [300, 420], [90, 420], [90, 610], [560, 610], [560, 250], [840, 250], [840, 520], [1120, 520], [1120, 170], [1330, 170]];
function pathLen() { let L = 0; for (let i = 1; i < PATH.length; i++) L += Math.hypot(PATH[i][0] - PATH[i - 1][0], PATH[i][1] - PATH[i - 1][1]); return L; }
function posOn(d) {
  for (let i = 1; i < PATH.length; i++) {
    const seg = Math.hypot(PATH[i][0] - PATH[i - 1][0], PATH[i][1] - PATH[i - 1][1]);
    if (d <= seg) { const f = seg ? d / seg : 0; return [PATH[i - 1][0] + (PATH[i][0] - PATH[i - 1][0]) * f, PATH[i - 1][1] + (PATH[i][1] - PATH[i - 1][1]) * f]; }
    d -= seg;
  }
  return [PATH[PATH.length - 1][0], PATH[PATH.length - 1][1]];
}
function distToPath(x, y) {
  let best = 1e9;
  for (let i = 1; i < PATH.length; i++) {
    const [ax, ay] = PATH[i - 1], [bx, by] = PATH[i];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
  }
  return best;
}

// ---- 塔与怪 ---------------------------------------------------------------------------------
const TOWERS = {
  dart:   { name: '弓塔', cost: 'dart_cost',   dmg: 'dart_dmg',   rate: 'dart_rate',   range: 'dart_range',   ground: true, air: true,  color: '#6fae5c' },
  cannon: { name: '砲塔', cost: 'cannon_cost', dmg: 'cannon_dmg', rate: 'cannon_rate', range: 'cannon_range', ground: true, air: false, splash: 'cannon_splash', color: '#b0763f' },
  frost:  { name: '冰塔', cost: 'frost_cost',  dmg: 'frost_dmg',  rate: 'frost_rate',  range: 'frost_range',  ground: true, air: true, slow: true,  color: '#5fa8c8' },
};
const FOES = {
  runner: { name: '疾行', hp: 'runner_hp', spd: 'runner_spd', dmg: 'runner_dmg', coin: 'runner_coin', r: 11, air: false },
  brute:  { name: '重甲', hp: 'brute_hp',  spd: 'brute_spd',  dmg: 'brute_dmg',  coin: 'brute_coin',  r: 18, air: false, armor: 'brute_armor' },
  flyer:  { name: '飞掠', hp: 'flyer_hp',  spd: 'flyer_spd',  dmg: 'flyer_dmg',  coin: 'flyer_coin',  r: 12, air: true },
  shield: { name: '盾卫', hp: 'shield_hp', spd: 'shield_spd', dmg: 'shield_dmg', coin: 'shield_coin', r: 15, air: false, shielder: true },
};
const WAVES = [
  [['runner', 5]], [['runner', 8]], [['runner', 6], ['brute', 2]], [['flyer', 3], ['runner', 5]],
  [['brute', 5], ['runner', 6]], [['flyer', 6], ['runner', 6]], [['shield', 2], ['runner', 8], ['brute', 2]],
  [['flyer', 4], ['brute', 5], ['shield', 2]], [['runner', 14], ['shield', 3]], [['brute', 7], ['flyer', 6], ['shield', 3]],
];
let scene, state, uid = 1;

function reset() {
  seed = Number(params.get('seed')) || CONFIG.seed;
  uid = 1;
  const L = pathLen();
  state = {
    phase: 'build', wave: 0, t: 0, lives: tune.lives, coins: tune.start_coins,
    towers: [], foes: [], shots: [], pops: [], coinsFly: [],
    buildT: tune.first_wave_delay, queue: [], spawnT: 0, pathL: L, sel: null, hoverTower: null, won: false, gained: '',
  };
}
function startWave() {
  const s = state;
  s.wave++; s.phase = 'wave'; s.queue = [];
  for (const [kind, n] of WAVES[s.wave - 1]) for (let i = 0; i < n; i++) s.queue.push(kind);
  for (let i = s.queue.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1));[s.queue[i], s.queue[j]] = [s.queue[j], s.queue[i]]; }
  s.spawnT = 0.6;
  tone(220, .25, 'triangle', .35); events.push({ type: 'wave', wave: s.wave });
}
function spawnFoe(kind) {
  const s = state, F = FOES[kind];
  const hpMul = 1 + tune.hp_ramp * (s.wave - 1);
  if (F.air) {
    const y0 = 60 + rng() * 560;
    s.foes.push({ id: uid++, kind, air: true, x: -30, y: y0, vx: tune[F.spd], hp: tune[F.hp] * hpMul, maxhp: tune[F.hp] * hpMul, slow: 0, sh: 0 });
  } else {
    const hp = tune[F.hp] * hpMul;
    s.foes.push({ id: uid++, kind, air: false, d: 0, hp, maxhp: hp, slow: 0, sh: 0, shT: 1 });
  }
}
function foeXY(f) { return f.air ? [f.x, f.y] : posOn(f.d); }
function foeSpd(f) { const F = FOES[f.kind]; return tune[F.spd] * (f.slow > 0 ? tune.frost_slow : 1); }
function hurtFoe(f, dmg, type) {
  const F = FOES[f.kind];
  let d = dmg - (F.armor ? tune[F.armor] : 0); if (d < 1) d = 1;
  if (f.sh > 0) { const a = Math.min(f.sh, d); f.sh -= a; d -= a; }
  f.hp -= d;
  if (type === 'frost' && f.hp > 0) { f.slow = tune.frost_slow_t; }
  if (f.hp <= 0) {
    const s = state, [x, y] = foeXY(f);
    s.coins += tune[F.coin]; s.coinsFly.push({ x, y, t: 0.7 });
    const i = s.foes.indexOf(f); if (i >= 0) s.foes.splice(i, 1);
    tone(520 + rng() * 80, .05, 'square', .1);
  }
}
function placeTower(x, y, kind) {
  const s = state, T = TOWERS[kind];
  if (s.coins < tune[T.cost]) { tone(160, .12, 'sawtooth', .25); return false; }
  if (distToPath(x, y) < 38 || x < 20 || x > W - 20 || y < 76 || y > H - 90) { tone(160, .1, 'sawtooth', .2); return false; }
  for (const t of s.towers) if (Math.hypot(t.x - x, t.y - y) < 44) { tone(160, .1, 'sawtooth', .2); return false; }
  s.coins -= tune[T.cost];
  s.towers.push({ kind, x, y, lvl: 1, spent: tune[T.cost], cd: 0, face: 0 });
  tone(95, .12, 'square', .4); // 咚
  events.push({ type: 'place', kind });
  return true;
}
function upgradeSelected() {
  const t = state.sel; if (!t || t.lvl >= 3) return;
  const cost = Math.round(t.spent * tune.up_cost_mult);
  if (state.coins < cost) { tone(160, .12, 'sawtooth', .25); return; }
  state.coins -= cost; t.spent += cost; t.lvl++; tone(660, .15, 'triangle', .35);
  events.push({ type: 'upgrade', lvl: t.lvl });
}
function sellSelected() {
  const t = state.sel; if (!t) return;
  state.coins += Math.round(t.spent * tune.sell_frac);
  state.towers.splice(state.towers.indexOf(t), 1); state.sel = null; tone(330, .12, 'sine', .3);
  events.push({ type: 'sell' });
}

function update(dt) {
  const s = state;
  s.t += dt;
  // 波间建造
  if (s.phase === 'build') {
    s.buildT -= dt;
    if (pressed('Space')) startWave();
    else if (s.buildT <= 0) startWave();
  } else {
    if (pressed('Space')) { /* 已在波中:不提前 */ }
    s.spawnT -= dt;
    if (s.queue.length && s.spawnT <= 0) { s.spawnT = 0.9; spawnFoe(s.queue.shift()); }
  }
  // 盾卫给周围套盾
  for (const f of s.foes) {
    if (FOES[f.kind].shielder) {
      f.shT -= dt;
      if (f.shT <= 0) { f.shT = tune.shield_rate;
        for (const o of s.foes) if (o !== f && Math.hypot(...vec(o).map((v, i) => v - vec(f)[i])) < tune.shield_radius) o.sh = tune.shield_amt; }
    }
    if (f.slow > 0) f.slow -= dt;
  }
  // 前进
  const endL = s.pathL;
  for (const f of [...s.foes]) {
    if (f.air) { f.x += foeSpd(f) * dt;
      if (f.x > W + 40) { leak(f); } }
    else { f.d += foeSpd(f) * dt;
      if (f.d >= endL) { leak(f); } }
  }
  // 塔射击
  for (const t of s.towers) {
    const T = TOWERS[t.kind];
    const range = tune[T.range] * (1 + 0.18 * (t.lvl - 1));
    t.cd -= dt;
    let best = null, bd = 1e9;
    for (const f of s.foes) {
      if (f.air && !T.air) continue;
      const [x, y] = foeXY(f), d = Math.hypot(x - t.x, y - t.y);
      if (d <= range && (!best || progressOf(f) > progressOf(best))) best = f;
    }
    if (best) { const [bx, by] = foeXY(best); t.face = Math.atan2(by - t.y, bx - t.x); }
    if (best && t.cd <= 0) {
      t.cd = tune[T.rate] * (1 - 0.1 * (t.lvl - 1));
      s.shots.push({ x: t.x, y: t.y - 14, tgt: best.id, kind: t.kind, dmg: tune[T.dmg] * Math.pow(tune.up_dmg_mult, t.lvl - 1) });
      tone(t.kind === 'cannon' ? 240 : 700, .04, t.kind === 'cannon' ? 'square' : 'sine', .12);
    }
  }
  // 弹飞行
  for (const sh of [...s.shots]) {
    const f = s.foes.find(o => o.id === sh.tgt);
    if (!f) { s.shots.splice(s.shots.indexOf(sh), 1); continue; }
    const [fx, fy] = foeXY(f);
    const sp = 560 * dt, d = Math.hypot(fx - sh.x, fy - sh.y);
    if (d < 14) {
      s.shots.splice(s.shots.indexOf(sh), 1);
      const T = TOWERS[sh.kind];
      if (T.splash) {
        for (const o of [...s.foes]) { const [ox, oy] = foeXY(o); if (Math.hypot(ox - fx, oy - fy) < tune[T.splash]) hurtFoe(o, sh.dmg, sh.kind); }
        s.pops.push({ x: fx, y: fy, t: .35, r: tune[T.splash], kind: 'boom' });
      } else hurtFoe(f, sh.dmg, sh.kind);
    } else { sh.x += (fx - sh.x) / d * sp; sh.y += (fy - sh.y) / d * sp; }
  }
  for (const p of s.pops) p.t -= dt; s.pops = s.pops.filter(p => p.t > 0);
  for (const c of s.coinsFly) { c.t -= dt; c.y -= 20 * dt; } s.coinsFly = s.coinsFly.filter(c => c.t > 0);

  // 波结束
  if (s.phase === 'wave' && !s.queue.length && !s.foes.length) {
    s.phase = 'build'; s.buildT = tune.wave_break;
    s.coins += tune.wave_reward + 6 * s.wave;
    tone(523, .15, 'triangle', .3); tone(659, .2, 'triangle', .3);
    events.push({ type: 'clear', wave: s.wave });
    if (s.wave >= Math.min(WAVES.length, tune.wave_count)) { s.won = true; s.gained = `守满 ${s.wave} 波 · 余 ${s.lives} 命`; scene = 'results'; }
  }
  if (s.lives <= 0) { s.gained = `第 ${s.wave} 波破关`; scene = 'over'; }

  // 选择/放置输入
  if (clicked) { handle(px, py); clicked = false; }
  if (pressed('Digit1')) { s.selTower = 'dart'; s.sel = null; }
  if (pressed('Digit2')) { s.selTower = 'cannon'; s.sel = null; }
  if (pressed('Digit3')) { s.selTower = 'frost'; s.sel = null; }
  if (pressed('KeyU')) upgradeSelected();
  if (pressed('KeyS')) sellSelected();
}
function vec(f) { return foeXY(f); }
function progressOf(f) { return f.air ? f.x / W : f.d / state.pathL; }
function leak(f) {
  const s = state, F = FOES[f.kind];
  s.lives -= tune[F.dmg];
  const i = s.foes.indexOf(f); if (i >= 0) s.foes.splice(i, 1);
  tone(180, .3, 'sawtooth', .4); events.push({ type: 'leak', kind: f.kind });
}
const SHOP = ['dart', 'cannon', 'frost'];
function handle(x, y) {
  const s = state;
  for (let i = 0; i < 3; i++) { const bx = 24 + i * 116, by = H - 78;
    if (x > bx && x < bx + 108 && y > by && y < by + 64) { s.selTower = SHOP[i]; s.sel = null; tone(440, .05, 'sine', .15); return; } }
  if (x > W - 190 && x < W - 20 && y > 52 && y < 92) { if (s.phase === 'build') startWave(); return; }
  for (const t of s.towers) if (Math.hypot(t.x - x, t.y - y) < 26) { s.sel = (s.sel === t ? null : t); s.selTower = null; return; }
  if (s.selTower) { placeTower(x, y, s.selTower); }
}

// ---- 绘图 ---------------------------------------------------------------------------------
function drawMap() {
  clear('#e8dcc0'); // 羊皮纸
  for (let i = 0; i < 70; i++) { ctx.fillStyle = 'rgba(120,90,40,0.06)';
    const x = ((i * 331) % W), y = ((i * 719) % H); ctx.fillRect(x, y, 26, 3); }
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#8a7448'; ctx.lineWidth = 58; ctx.beginPath(); ctx.moveTo(PATH[0][0], PATH[0][1]);
  for (let i = 1; i < PATH.length; i++) ctx.lineTo(PATH[i][0], PATH[i][1]); ctx.stroke();
  ctx.strokeStyle = '#c9b280'; ctx.lineWidth = 46; ctx.stroke();
  ctx.setLineDash([4, 22]); ctx.strokeStyle = 'rgba(90,70,35,.5)'; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
  // 城门
  const [gx, gy] = PATH[PATH.length - 1];
  ctx.fillStyle = '#5b4327'; ctx.fillRect(gx - 58, gy - 52, 44, 104);
  ctx.strokeStyle = '#3a2b17'; ctx.lineWidth = 3; ctx.strokeRect(gx - 58, gy - 52, 44, 104);
  ctx.fillStyle = '#2b1f12'; ctx.beginPath(); ctx.arc(gx - 36, gy + 18, 15, Math.PI, 0); ctx.rect(gx - 51, gy + 18, 30, 30); ctx.fill();
  for (let i = 0; i < state.lives; i++) { ctx.fillStyle = '#a33'; ctx.beginPath(); ctx.arc(gx - 62 + (i % 5) * -13, gy - 64 - Math.floor(i / 5) * 13, 4, 0, 7); ctx.fill(); }
  // 入口
  ctx.fillStyle = 'rgba(60,40,20,.7)'; ctx.beginPath(); ctx.arc(-8, PATH[0][1], 26, -1.2, 1.2); ctx.fill();
  if (state.phase === 'build' && state.wave < WAVES.length) {
    text(`第 ${state.wave + 1} 波将至 ${Math.ceil(state.buildT)}s`, W - 105, 72, 20, '#5b4327');
  }
  const [nx, ny] = PATH[1];
  if (state.phase === 'wave' && state.queue.length) {
    ctx.strokeStyle = '#a33'; ctx.lineWidth = 3;
    const k = FOES[state.queue[0]]; ctx.beginPath(); ctx.arc(34, ny, 10, 0, 7); ctx.stroke();
    text(k.name, 56, ny, 16, '#5b4327', 'left');
  }
}
function drawTower(t) {
  const T = TOWERS[t.kind];
  ctx.save(); ctx.translate(t.x, t.y);
  ctx.fillStyle = '#00000022'; ctx.beginPath(); ctx.ellipse(0, 10, 22, 8, 0, 0, 7); ctx.fill();
  ctx.strokeStyle = '#4a3a22'; ctx.lineWidth = 3; ctx.fillStyle = '#d8c9a0';
  ctx.beginPath(); ctx.arc(0, 0, 21, 0, 7); ctx.fill(); ctx.stroke();
  ctx.rotate(t.face);
  if (t.kind === 'dart') {
    ctx.strokeStyle = T.color; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(6, 0, 13, -1.1, 1.1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(20, 0); ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(20, 0); ctx.lineTo(14, -4); ctx.moveTo(20, 0); ctx.lineTo(14, 4); ctx.stroke();
  } else if (t.kind === 'cannon') {
    ctx.fillStyle = '#3f3a35'; ctx.fillRect(2, -7, 22, 14);
    ctx.beginPath(); ctx.arc(0, 0, 12, 0, 7); ctx.fill();
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(24, 0, 5, 0, 7); ctx.fill();
  } else {
    ctx.fillStyle = '#cfe9f5'; ctx.strokeStyle = T.color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(8, 0); ctx.lineTo(0, 16); ctx.lineTo(-8, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-14, -8); ctx.lineTo(14, 8); ctx.moveTo(14, -8); ctx.lineTo(-14, 8); ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.restore();
  for (let i = 0; i < t.lvl; i++) { ctx.fillStyle = '#e8b53a'; ctx.beginPath(); ctx.arc(t.x - 12 + i * 12, t.y + 26, 3.5, 0, 7); ctx.fill(); }
}
function drawFoe(f) { const [x, y] = foeXY(f); drawFoeAt(f, x, y); }
function drawFoeAt(f, x, y) {
  const [dummy, dummy2] = [x, y], F = FOES[f.kind];
  if (f.air) { ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(x, y + 46, 12, 4, 0, 0, 7); ctx.fill(); }
  const wob = Math.sin(state.t * 10 + f.id) * 2;
  if (f.kind === 'runner') {
    ctx.fillStyle = '#d9634a'; ctx.strokeStyle = '#7d2f1e'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(x, y, 11, 8, 0, 0, 7); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x - 18, y + wob); ctx.moveTo(x - 10, y + 3); ctx.lineTo(x - 18, y + 5 - wob); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x + 5, y - 2, 2.5, 0, 7); ctx.fill();
  } else if (f.kind === 'brute') {
    ctx.fillStyle = '#4c5866'; ctx.strokeStyle = '#232c36'; ctx.lineWidth = 3;
    ctx.fillRect(x - 16, y - 14, 32, 28); ctx.strokeRect(x - 16, y - 14, 32, 28);
    ctx.strokeStyle = '#8b97a5'; ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(x - 14, y - 8 + i * 8); ctx.lineTo(x + 14, y - 8 + i * 8); ctx.stroke(); }
    ctx.fillStyle = '#ffcf6e'; ctx.fillRect(x - 8, y - 4, 5, 3); ctx.fillRect(x + 3, y - 4, 5, 3);
  } else if (f.kind === 'flyer') {
    ctx.fillStyle = '#7e5fa8'; ctx.strokeStyle = '#3f2d59'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x + 12, y); ctx.quadraticCurveTo(x, y - 9, x - 12, y); ctx.quadraticCurveTo(x, y + 5, x + 12, y); ctx.fill(); ctx.stroke();
    const w = Math.sin(state.t * 16 + f.id) * 6;
    ctx.beginPath(); ctx.moveTo(x - 4, y - 2); ctx.lineTo(x - 12, y - 14 - w); ctx.lineTo(x + 2, y - 4); ctx.closePath(); ctx.fillStyle = '#b39ddb'; ctx.fill(); ctx.stroke();
  } else if (f.kind === 'shield') {
    ctx.fillStyle = '#3f7d5a'; ctx.strokeStyle = '#1d4430'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, 14, 0, 7); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#cfe6b8'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(x, y, 10, .6, 5.7); ctx.stroke();
    ctx.fillStyle = '#1d4430'; ctx.beginPath(); ctx.arc(x, y - 2, 4, 0, 7); ctx.fill();
  }
  if (f.sh > 0) { ctx.strokeStyle = 'rgba(150,220,255,.9)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, F.r + 5, 0, 7); ctx.stroke(); }
  if (f.slow > 0) { ctx.fillStyle = 'rgba(120,190,230,.35)'; ctx.beginPath(); ctx.arc(x, y, F.r + 2, 0, 7); ctx.fill(); }
  if (f.hp < f.maxhp) { ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(x - 16, y - F.r - 14, 32, 4);
    ctx.fillStyle = '#7ec46a'; ctx.fillRect(x - 16, y - F.r - 14, 32 * Math.max(0, f.hp / f.maxhp), 4); }
}
function drawHUD() {
  const s = state;
  ctx.fillStyle = 'rgba(40,30,15,.85)'; ctx.fillRect(0, 0, W, 44);
  text(`金币 ${Math.floor(s.coins)}`, 24, 22, 22, '#f2d38a', 'left');
  text(`波 ${s.wave}/${WAVES.length}`, 220, 22, 22, '#fff', 'left');
  text(`命 ${s.lives}`, 350, 22, 22, s.lives > 3 ? '#fff' : '#ff8f7a', 'left');
  if (s.phase === 'wave') text(`残敌 ${s.queue.length + s.foes.length}`, 480, 22, 22, '#ddd', 'left');
  // 商店
  SHOP.forEach((k, i) => {
    const T = TOWERS[k], x = 24 + i * 116, y = H - 78, own = s.selTower === k;
    ctx.fillStyle = own ? '#5b4327' : 'rgba(40,30,15,.8)'; ctx.fillRect(x, y, 108, 64);
    ctx.strokeStyle = own ? '#f2d38a' : '#8a7448'; ctx.lineWidth = own ? 3 : 2; ctx.strokeRect(x, y, 108, 64);
    ctx.save(); ctx.translate(x + 26, y + 32); ctx.scale(0.8, 0.8); drawTower({ kind: k, lvl: 1, x: 0, y: 0, face: 0 }); ctx.restore();
    text(T.name, x + 76, y + 22, 18, '#fff'); text(`${Math.round(tune[T.cost])}G`, x + 76, y + 44, 16, '#f2d38a');
    text(String(i + 1), x + 8, y + 10, 13, '#c8b280');
  });
  // 放置预览
  if (s.selTower && py < H - 90 && py > 50) {
    const T = TOWERS[s.selTower], ok = distToPath(px, py) >= 38 && s.coins >= tune[T.cost];
    ctx.strokeStyle = ok ? 'rgba(60,120,60,.6)' : 'rgba(180,50,40,.6)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, tune[T.range], 0, 7); ctx.stroke();
    ctx.fillStyle = ok ? 'rgba(80,160,80,.25)' : 'rgba(190,60,50,.3)'; ctx.fill();
    drawTower({ kind: s.selTower, x: px, y: py, lvl: 1, face: 0 });
  }
  // 选中塔面板
  if (s.sel) {
    const t = s.sel, T = TOWERS[t.kind];
    const range = tune[T.range] * (1 + 0.18 * (t.lvl - 1));
    ctx.strokeStyle = 'rgba(90,70,30,.7)'; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.arc(t.x, t.y, range, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    const x = Math.min(W - 240, Math.max(10, t.x + 40)), y = Math.max(56, t.y - 60);
    ctx.fillStyle = 'rgba(40,30,15,.92)'; ctx.fillRect(x, y, 230, 84); ctx.strokeStyle = '#f2d38a'; ctx.strokeRect(x, y, 230, 84);
    text(`${T.name} Lv${t.lvl}`, x + 12, y + 18, 18, '#fff', 'left');
    if (t.lvl < 3) text(`U 升级 ${Math.round(t.spent * tune.up_cost_mult)}G`, x + 12, y + 44, 16, s.coins >= Math.round(t.spent * tune.up_cost_mult) ? '#9fe08a' : '#888', 'left');
    else text('已满级', x + 12, y + 44, 16, '#f2d38a', 'left');
    text(`S 卖出 +${Math.round(t.spent * tune.sell_frac)}G`, x + 12, y + 66, 16, '#ddd', 'left');
  }
  // 提前叫波按钮
  if (s.phase === 'build') {
    ctx.fillStyle = 'rgba(91,67,39,.95)'; ctx.fillRect(W - 190, 52, 170, 40); ctx.strokeStyle = '#f2d38a'; ctx.strokeRect(W - 190, 52, 170, 40);
    text('空格:提前叫波', W - 105, 72, 18, '#fff');
  }
}
function drawFX() {
  for (const sh of state.shots) {
    const T = TOWERS[sh.kind];
    ctx.fillStyle = sh.kind === 'cannon' ? '#2b2b2b' : sh.kind === 'frost' ? '#bfe4f2' : '#f7e8c0';
    ctx.beginPath(); ctx.arc(sh.x, sh.y, sh.kind === 'cannon' ? 6 : 4, 0, 7); ctx.fill();
  }
  for (const p of state.pops) { ctx.strokeStyle = `rgba(230,140,60,${p.t * 2.5})`; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 - p.t / .35) + 8, 0, 7); ctx.stroke(); }
  for (const c of state.coinsFly) { ctx.fillStyle = `rgba(242,211,138,${c.t + .3})`; ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, 7); ctx.fill(); }
}

// ---- 场景 ---------------------------------------------------------------------------------
const scenes = {
  figures: {
    update(dt) { state.t += dt; },
    draw() {
      clear('#e8dcc0');
      const kinds = ['runner', 'brute', 'flyer', 'shield'];
      const items = [
        ['弓塔', 'dart'], ['砲塔', 'cannon'], ['冰塔', 'frost'],
        ['疾行·快', null], ['重甲·硬', null], ['飞掠·绕路', null], ['盾卫·护群', null],
      ];
      items.forEach((it, i) => {
        const x = 150 + i * 165, y = H / 2 - 20;
        ctx.save(); ctx.translate(x, y);
        if (it[1]) drawTower({ kind: it[1], x: 0, y: 0, lvl: 2, face: 0 });
        else {
          const f = { kind: kinds[i - 3], id: 4 + i, hp: 20, maxhp: 20, x: 0, y: 0, d: -1, air: kinds[i - 3] === 'flyer' };
          drawFoeAt(f, 0, 0);
        }
        ctx.restore();
        text(it[0], x, y + 60, 18, '#5b4327');
      });
    },
  },
  title: {
    update(dt) {
      state.t += dt;
      const btn = { x: 118, y: 540, w: 300, h: 62 };
      const hover = px >= btn.x && px <= btn.x + btn.w && py >= btn.y && py <= btn.y + btn.h;
      canvas.style.cursor = hover ? 'pointer' : 'default';
      if (pressed('Enter') || pressed('Space') || (clicked && hover)) {
        clicked = false; canvas.style.cursor = 'default'; reset(); scene = 'play'; return;
      }
      clicked = false;
    },
    draw() {
      const prevPhase = state.phase;
      state.phase = 'title';
      drawMap();
      state.phase = prevPhase;

      const t = state.t || 0;
      // 地图右侧实时布防与敌军巡游预览
      drawTower({ kind: 'dart', x: 710, y: 365, lvl: 2, face: Math.sin(t * 1.4) * 0.6 - 0.3 });
      drawTower({ kind: 'cannon', x: 965, y: 375, lvl: 2, face: Math.cos(t * 1.1) * 0.5 + 1.8 });
      drawTower({ kind: 'frost', x: 1005, y: 195, lvl: 1, face: t * 0.7 });
      const demoFoes = [
        { kind: 'runner', id: 1, hp: 10, maxhp: 10, d: 1550 + ((t * 95) % 900), air: false, sh: 0, slow: 0 },
        { kind: 'brute', id: 2, hp: 10, maxhp: 10, d: 1380 + ((t * 95) % 900), air: false, sh: 0, slow: 1 },
        { kind: 'shield', id: 3, hp: 10, maxhp: 10, d: 1720 + ((t * 95) % 900), air: false, sh: 1, slow: 0 },
      ];
      for (const f of demoFoes) drawFoe(f);

      // 左侧羊皮纸兵书面板
      const cx = 82, cy = 78, cw = 556, ch = 564;
      ctx.save();
      ctx.shadowColor = 'rgba(40,26,10,0.28)'; ctx.shadowBlur = 24;
      ctx.beginPath(); ctx.roundRect(cx, cy, cw, ch, 18);
      ctx.fillStyle = 'rgba(244, 232, 202, 0.94)'; ctx.fill();
      ctx.restore();
      ctx.strokeStyle = '#6e5534'; ctx.lineWidth = 3; ctx.stroke();
      ctx.strokeStyle = 'rgba(110, 85, 52, 0.3)'; ctx.lineWidth = 1.5;
      ctx.strokeRect(cx + 10, cy + 10, cw - 20, ch - 20);

      const lx = cx + 36;
      ctx.beginPath(); ctx.roundRect(lx, cy + 32, 168, 30, 15);
      ctx.fillStyle = '#5b4327'; ctx.fill();
      text('10 波防线 · 10 命城门', lx + 84, cy + 47, 14, '#f2d38a');

      text(TITLE, lx, cy + 114, 78, '#3f2c16', 'left');
      text('择草地筑塔布防，守住蜿蜒官道尽头的城门', lx, cy + 174, 20, '#6b563a', 'left');

      // 三座防御塔小卡
      const towerCards = [
        ['dart', '弓塔', `${Math.round(tune.dart_cost)}G · 速射`],
        ['cannon', '砲塔', `${Math.round(tune.cannon_cost)}G · 溅射`],
        ['frost', '冰塔', `${Math.round(tune.frost_cost)}G · 减速`],
      ];
      towerCards.forEach(([k, name, sub], i) => {
        const tx = lx + i * 164, ty = cy + 206;
        ctx.beginPath(); ctx.roundRect(tx, ty, 152, 102, 12);
        ctx.fillStyle = '#e7d7b2'; ctx.fill();
        ctx.strokeStyle = '#9c8357'; ctx.lineWidth = 1.8; ctx.stroke();
        ctx.save(); ctx.translate(tx + 76, ty + 36); ctx.scale(0.95, 0.95);
        drawTower({ kind: k, lvl: 1, x: 0, y: 0, face: -0.4 });
        ctx.restore();
        text(name, tx + 76, ty + 72, 17, '#3f2c16');
        text(sub, tx + 76, ty + 91, 13, '#6b563a');
      });

      // 操作说明芯片
      const notes = [
        ['鼠标 / 1·2·3', '左下选塔，点草地落位'],
        ['点塔 + U / S', '升级强化或卖出回 70%'],
        ['空格 / P / M', '提前叫波 / 暂停 / 静音'],
      ];
      notes.forEach(([k, v], i) => {
        const ny = cy + 328 + i * 42;
        ctx.beginPath(); ctx.roundRect(lx, ny, 480, 34, 8);
        ctx.fillStyle = 'rgba(91, 67, 39, 0.09)'; ctx.fill();
        text(k, lx + 14, ny + 17, 15, '#8a3222', 'left');
        text(v, lx + 150, ny + 17, 15, '#4c3a22', 'left');
      });

      // 主开始按钮
      const btn = { x: lx, y: 540, w: 300, h: 62 };
      const hover = px >= btn.x && px <= btn.x + btn.w && py >= btn.y && py <= btn.y + btn.h;
      ctx.save();
      ctx.shadowColor = hover ? 'rgba(163, 51, 51, 0.42)' : 'rgba(91, 67, 39, 0.25)'; ctx.shadowBlur = hover ? 20 : 10;
      ctx.beginPath(); ctx.roundRect(btn.x, btn.y - (hover ? 2 : 0), btn.w, btn.h, 14);
      ctx.fillStyle = hover ? '#b83b2e' : '#9c2f24'; ctx.fill();
      ctx.strokeStyle = '#5a1912'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.restore();
      text('布防迎敌  [Enter / 空格]', btn.x + btn.w / 2, btn.y - (hover ? 2 : 0) + btn.h / 2, 21, '#fdf2d8');
    },
  },
  play: {
    update(dt) {
      if (pressed('KeyP') || pressed('Escape')) { scene = 'pause'; return; }
      update(dt);
    },
    draw() {
      drawMap();
      for (const t of state.towers) drawTower(t);
      for (const f of state.foes) drawFoe(f);
      drawFX(); drawHUD();
    },
  },
  pause: {
    update() { if (pressed('KeyP') || pressed('Escape')) scene = 'play'; },
    draw() { scenes.play.draw(); clear('rgba(30,22,10,0.55)'); text('暂停', W / 2, H / 2, 48, '#fff'); text('P 继续', W / 2, H / 2 + 44, 22, '#eee'); },
  },
  over: {
    update() { if (pressed('KeyR') || pressed('Enter')) { reset(); scene = 'play'; } },
    draw() { scenes.play.draw(); clear('rgba(30,10,10,0.6)'); text('城门被破了', W / 2, H / 2 - 30, 46, '#ff9b8f');
      text(state.gained, W / 2, H / 2 + 16, 24, '#fff'); text('R 再来', W / 2, H / 2 + 56, 22, '#ccc'); },
  },
  results: {
    update() { if (pressed('Enter')) { reset(); scene = 'play'; } },
    draw() { scenes.play.draw(); clear('rgba(20,25,12,0.6)'); text('守满了!', W / 2, H / 2 - 30, 48, '#9fe08a');
      text(state.gained, W / 2, H / 2 + 16, 24, '#fff'); text('Enter 再来一局', W / 2, H / 2 + 56, 22, '#ccc'); },
  },
};

// ---- 主循环 -------------------------------------------------------------------------------
function step() {
  if (pressed('KeyM')) { setMuted(!muted); hit.delete('KeyM'); }
  scenes[scene].update(STEP); hit.clear();
}
let last, acc = 0, ALPHA = 1;
function tick() {
  const now = clock.now();
  acc += Math.min(now - last, 0.25); last = now;
  while (acc >= STEP) { step(); acc -= STEP; }
  ALPHA = acc / STEP;
  drawFrame();
}
function drawFrame() { scenes[scene].draw(); }
function frame() { tick(); requestAnimationFrame(frame); }
function timer() { if (document.visibilityState === 'visible' && clock.now() - last > 0.1) tick(); }

window.game = {
  get scene() { return scene; },
  get state() { return state; },
  press(code) { hit.add(code); },
  hold(code, on) { on ? down.add(code) : down.delete(code); },
  get events() { return events; },
  step(n = 1, draw = true, alpha = 1) { for (let i = 0; i < n; i++) step(); if (draw) { ALPHA = alpha; drawFrame(); } },
};
reset();
scene = params.get('scene') || 'title';
last = clock.now();
if (params.get('manual') === '1') drawFrame();
else { requestAnimationFrame(frame); setInterval(timer, 50); }
