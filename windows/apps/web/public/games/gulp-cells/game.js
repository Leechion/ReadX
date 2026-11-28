'use strict';
// 吞吞 — an eat-and-grow arcade game built on the one-shot starter. Fixed step, window.game
// hooks, play + figures scenes kept; the game replaces everything marked "the game".

// ---- Built to be checked ----------------------------------------------------------------
const params = new URLSearchParams(location.search);
const tune = new Proxy({}, { get: (_, k) => CONFIG[k].value }); // live: tune.seed is CONFIG.seed.value
const STEP = 1 / 60;
const W = 1280, H = 720;
const PIXEL = false;
const FONT = 'sans-serif';
const TITLE = '吞吞';
const CONTROLS = ['朝指针方向游 —— 按住或移动鼠标都行', '吃下比你小的,躲开比你大的', 'P 暂停   M 静音   R 重开'];
const clock = window.GAME_CLOCK || { now: () => performance.now() / 1000 };
const CHEAP = params.get('render') === 'cheap';
let seed;
function rng() { // mulberry32; every gameplay random call reads this, never Math.random
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const events = [];

// ---- Screen ---------------------------------------------------------------------------
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

// ---- Input: the pointer steers; keys by position ------------------------------------------
const down = new Set(), hit = new Set();
const pressed = code => hit.has(code);
addEventListener('keydown', e => {
  startAudio();
  if (!e.repeat) { down.add(e.code); hit.add(e.code); }
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', e => down.delete(e.code));
const pointer = { x: W / 2, y: H / 2, has: false, down: false, click: false };
function setPointer(e) {
  const b = canvas.getBoundingClientRect();
  pointer.x = (e.clientX - b.left) / b.width * W;
  pointer.y = (e.clientY - b.top) / b.height * H;
  pointer.has = true;
}
addEventListener('pointermove', setPointer);
addEventListener('pointerdown', e => { startAudio(); setPointer(e); pointer.down = true; pointer.click = true; });
addEventListener('pointerup', () => pointer.down = false);
addEventListener('blur', () => { down.clear(); pointer.down = false; });

// ---- Audio ------------------------------------------------------------------------------
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

// ---- The game: a petri dish of cells ------------------------------------------------------
// Three kinds, each its own silhouette: 浮点 (soft food speck), 同游 (smooth-backed rival),
// 棘突 (spiked threat). The player is a bright membrane cell that trembles as it swims.
const SPA = 2 * Math.PI;
let uid = 0;
function makeCell(x, y, r, kind) {
  return { id: ++uid, x, y, r, kind, vx: 0, vy: 0, t: rng() * SPA, phase: rng() * SPA };
}
function randInArena(pad) {
  const a = rng() * SPA, d = Math.sqrt(rng()) * (tune.arena_r - pad);
  return [Math.cos(a) * d, Math.sin(a) * d];
}
function spawnRival(s, forceBig) {
  let x = 0, y = 0;
  for (let tries = 0; tries < 8; tries++) { // never born on top of the player
    [x, y] = randInArena(60);
    if (Math.hypot(x - s.me.x, y - s.me.y) > s.me.r * 2.5 + 80) break;
  }
  const big = forceBig !== undefined ? forceBig : rng() < s.bigShare;
  let r;
  if (big) r = s.me.r * (1.08 + rng() * 0.9);
  else r = s.me.r * (0.35 + rng() * 0.55);
  r = Math.max(10, Math.min(r, tune.arena_r * 0.32));
  const c = makeCell(x, y, r, rng() < 0.5 ? 'rival' : 'spike');
  s.cells.push(c);
  return c;
}
function spawnPellet(s) {
  const [x, y] = randInArena(40);
  s.food.push(makeCell(x, y, tune.pellet_r * (0.7 + rng() * 0.6), 'pellet'));
}
function ramp(s) { // the Challenge: density and threat share climb after ramp_t
  const k = Math.max(0, Math.min(1, (s.t - tune.ramp_t) / (tune.ramp_end - tune.ramp_t)));
  s.spawnEvery = tune.spawn_t0 + (tune.spawn_t1 - tune.spawn_t0) * k;
  s.bigShare = tune.big0 + (tune.big1 - tune.big0) * k;
  s.wantCells = Math.round(tune.rival_n0 + (tune.rival_max - tune.rival_n0) * k);
}
function reset() {
  seed = Number(params.get('seed')) || CONFIG.seed;
  const s = { t: 0, score: 0, gained: '', phase: 'play', me: makeCell(0, 0, tune.start_r, 'me'),
              cells: [], food: [], dust: [], trail: [], spawnEvery: tune.spawn_t0, bigShare: tune.big0,
              wantCells: tune.rival_n0, spawnT: 0, grazeT: tune.graze_t, grazed: false, cam: 1, shake: 0 };
  for (let i = 0; i < tune.rival_n0; i++) spawnRival(s, i % 2 === 1); // a mix at birth
  for (let i = 0; i < tune.pellet_n; i++) spawnPellet(s);
  for (let i = 0; i < tune.dust_n; i++) { const [x, y] = randInArena(0); s.dust.push({ x, y, r: 1 + rng() * 2.5, t: rng() * SPA }); }
  ramp(s);
  state = s;
}
function area(r) { return Math.round(r * r / 100); } // the size number: plain counting, scaled
function speedOf(r) { return tune.base_speed * Math.pow(tune.start_r / Math.max(r, 1), tune.speed_pow); }
function lose(s) {
  s.phase = 'over';
  try { const b = +(localStorage.getItem('gulp_best') || 0); if (area(s.me.r) > b) localStorage.setItem('gulp_best', area(s.me.r)); } catch (e) {}
  s.gained = `这局长到 ${area(s.me.r)}   最佳 ${Math.max(area(s.me.r), best())}   吃了 ${s.score} 口   活了 ${Math.floor(s.t)} 秒`;
  events.push({ type: 'lose', size: area(s.me.r) });
  tone(110, 0.35, 'sawtooth', 0.25); s.shake = 0.25;
}
function best() { try { return +(localStorage.getItem('gulp_best') || 0); } catch (e) { return 0; } }
function update(s, dt) {
  s.t += dt;
  if (s.shake > 0) s.shake = Math.max(0, s.shake - dt);
  ramp(s);
  // the player swims toward the pointer: steer by moving OR by holding
  const m = s.me;
  if (pointer.has) {
    const wx = s.cam ? (pointer.x - W / 2) / s.cam + m.x : 0;
    const wy = (pointer.y - H / 2) / s.cam + m.y;
    const dx = wx - m.x, dy = wy - m.y, d = Math.hypot(dx, dy);
    if (d > 4) {
      const v = speedOf(m.r) * (pointer.down || d > m.r ? 1 : 0.35);
      m.vx += (dx / d * v - m.vx) * Math.min(1, dt * 6);
      m.vy += (dy / d * v - m.vy) * Math.min(1, dt * 6);
    } else { m.vx *= 0.9; m.vy *= 0.9; }
  }
  const R = tune.arena_r;
  m.x += m.vx * dt; m.y += m.vy * dt;
  const edge = Math.hypot(m.x, m.y);
  if (edge + m.r > R) { const k = (R - m.r) / Math.max(edge, 1); m.x *= k; m.y *= k; m.vx *= -0.3; m.vy *= -0.3; }
  m.t += dt * (2 + Math.hypot(m.vx, m.vy) / speedOf(m.r) * 3); // the membrane trembles more as it swims
  // the signature: the trail grows with size and speed
  s.trail.push({ x: m.x, y: m.y, r: m.r, a: 1 });
  const maxTrail = Math.round(tune.trail_base + m.r / tune.trail_k);
  while (s.trail.length > maxTrail) s.trail.shift();
  for (const p of s.trail) p.a -= dt * 2.2;
  while (s.trail.length && s.trail[0].a <= 0) s.trail.shift();
  // rivals: flee anything bigger, chase anything smaller — the thin stand-in
  for (const c of s.cells) {
    let fx = 0, fy = 0, near = null, nd = 1e9;
    for (const o of [...s.cells, m]) {
      if (o === c) continue;
      const dx = o.x - c.x, dy = o.y - c.y, d = Math.hypot(dx, dy) || 1;
      if (o.r > c.r * 1.05 && d < o.r * 4) { fx -= dx / d * (1 - d / (o.r * 4)); fy -= dy / d * (1 - d / (o.r * 4)); }
      else if (o.r < c.r * 0.9 && d < c.r * 5 && d < nd) { near = [dx / d, dy / d]; nd = d; }
    }
    if (near && Math.hypot(fx, fy) < 0.2) { fx = near[0] * 0.7; fy = near[1] * 0.7; }
    // keep inside the dish
    const cd = Math.hypot(c.x, c.y);
    if (cd + c.r > R * 0.98) { fx -= c.x / cd; fy -= c.y / cd; }
    const v = speedOf(c.r) * 0.55;
    const fl = Math.hypot(fx, fy) || 1;
    c.vx += (fx / fl * v - c.vx) * Math.min(1, dt * 2.5);
    c.vy += (fy / fl * v - c.vy) * Math.min(1, dt * 2.5);
    c.x += c.vx * dt; c.y += c.vy * dt;
    c.t += dt * 2;
    // the eat check, both ways, with margins that leave no doubt
    const dx = m.x - c.x, dy = m.y - c.y, d = Math.hypot(dx, dy);
    if (c.r > m.r * tune.threat_ratio && d + m.r * tune.kill_margin < c.r) { lose(s); return; }
    if (m.r > c.r * tune.threat_ratio && d + c.r * tune.eat_margin < m.r) {
      m.r += tune.grow_step / m.r * 6; // area grows by the eaten area
      s.score++; s.cells.splice(s.cells.indexOf(c), 1);
      tone(300 + rng() * 200, 0.08, 'square', 0.2);
      events.push({ type: 'eat', kind: c.kind, r: Math.round(c.r) });
    } else if (c.big && !s.grazed && c.r > m.r * tune.threat_ratio && d < c.r + m.r + c.r * 0.6 && d > c.r + m.r * tune.kill_margin) {
      s.grazed = true; // the first big near-miss has been seen sweeping past
    }
  }
  // the scripted first big near-miss, so the first minute reads as the brief says
  if (!s.grazed && (s.grazeT -= dt) <= 0 && !s.grazeDone) {
    s.grazeDone = true;
    const a = rng() * SPA, d0 = tune.arena_r * 0.7;
    const c = spawnRival(s, true);
    c.x = Math.cos(a) * d0; c.y = Math.sin(a) * d0; c.big = true;
  }
  // pellets: static drift; eating is the same visible-inside rule
  for (let i = s.food.length - 1; i >= 0; i--) {
    const p = s.food[i];
    p.t += dt;
    const d = Math.hypot(m.x - p.x, m.y - p.y);
    if (d + p.r * tune.eat_margin < m.r) {
      m.r += tune.grow_step / m.r;
      s.score++; s.food.splice(i, 1);
      tone(600 + rng() * 300, 0.05, 'sine', 0.15);
      events.push({ type: 'eat', kind: 'pellet', r: Math.round(p.r) });
    }
  }
  while (s.food.length < tune.pellet_n) spawnPellet(s);
  s.spawnT += dt; // rivals come back on a timer that tightens with the ramp
  if (s.spawnT >= s.spawnEvery && s.cells.length < s.wantCells) { s.spawnT = 0; spawnRival(s); }
  while (s.cells.length > s.wantCells) s.cells.shift();
  // the camera follows and pulls back as the cell grows
  const want = Math.max(tune.zoom_min, Math.min(tune.zoom_max, tune.zoom_ref / (m.r + 40)));
  s.cam += (want - s.cam) * Math.min(1, dt * 2);
}

// ---- Drawing: the deep-sea dish; every kind its own outline --------------------------------
function cellPath(c, wob) { // wob: membrane tremble, a fraction of the radius
  const amp = wob ? tune.wobble_amp : 0, n = 14;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = i / n * SPA;
    const rr = c.r * (1 + amp * Math.sin(a * 3 + c.t));
    const x = c.x + Math.cos(a) * rr, y = c.y + Math.sin(a) * rr;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
}
function drawSpike(c) { // the threat: a spiky urchin shell — its own silhouette
  const n = 9;
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = i / (n * 2) * SPA + c.t * 0.2;
    const rr = i % 2 ? c.r * 1.32 : c.r * 0.82;
    const x = c.x + Math.cos(a) * rr, y = c.y + Math.sin(a) * rr;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = '#7e2430'; ctx.fill();
  ctx.strokeStyle = '#4d1219'; ctx.lineWidth = 3; ctx.stroke();
  ctx.beginPath(); ctx.arc(c.x, c.y, c.r * 0.32, 0, SPA); ctx.fillStyle = '#c9556a'; ctx.fill();
}
function drawPellet(p) { // food: a soft lobed speck, not a plain dot
  ctx.beginPath();
  for (let i = 0; i <= 10; i++) {
    const a = i / 10 * SPA;
    const rr = p.r * (1 + 0.18 * Math.sin(a * 3 + p.t));
    const x = p.x + Math.cos(a) * rr, y = p.y + Math.sin(a) * rr;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
}
function dishBG() {
  const g = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, H);
  g.addColorStop(0, '#0e3b3a'); g.addColorStop(0.7, '#0a1e33'); g.addColorStop(1, '#060d1c');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
function drawCellBody(c, wob) {
  if (c.kind === 'pellet') {
    drawPellet(c); ctx.fillStyle = '#8fd68a'; ctx.fill();
    ctx.strokeStyle = '#4f8f57'; ctx.lineWidth = 2; ctx.stroke();
    return;
  }
  if (c.kind === 'spike') {
    drawSpike(c);
    return;
  }
  if (c.kind === 'rival') { // a lobed, scalloped outline: not the player's smooth membrane recoloured
    const n = 16; ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = i / n * SPA, rr = c.r * (1 + 0.13 * Math.sin(a * 6 + c.t * 0.8));
      const x = c.x + Math.cos(a) * rr, y = c.y + Math.sin(a) * rr;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.fillStyle = 'rgba(120,150,220,0.5)'; ctx.fill();
    ctx.strokeStyle = '#5a78c0'; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.arc(c.x - c.r * 0.2, c.y - c.r * 0.15, c.r * 0.22, 0, SPA);
    ctx.fillStyle = 'rgba(220,235,255,0.5)'; ctx.fill();
    return;
  }
  // the player: bright, membrane trembling, a long tail of afterimages behind it
  const m = c;
  for (const p of state.trail) {
    ctx.globalAlpha = Math.max(0, p.a) * 0.16;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 0.9, 0, SPA);
    ctx.fillStyle = '#6fe3c8'; ctx.fill();
  }
  ctx.globalAlpha = 1;
  cellPath(m, true); ctx.fillStyle = 'rgba(110,230,200,0.4)'; ctx.fill();
  ctx.strokeStyle = '#bff5e6'; ctx.lineWidth = 4; ctx.stroke();
  cellPath(m, false); ctx.strokeStyle = 'rgba(191,245,230,0.35)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.arc(m.x - m.r * 0.25, m.y - m.r * 0.2, m.r * 0.34, 0, SPA);
  ctx.fillStyle = 'rgba(240,255,250,0.65)'; ctx.fill();
}
function world() { // camera: follow2d, scale by size
  ctx.translate(W / 2, H / 2);
  ctx.scale(state.cam, state.cam);
  if (state.shake > 0) ctx.translate((rng() - 0.5) * state.shake * 40, (rng() - 0.5) * state.shake * 40);
  ctx.translate(-state.me.x, -state.me.y);
}
function drawPlay() {
  dishBG();
  ctx.save(); world();
  // the dish rim
  ctx.beginPath(); ctx.arc(0, 0, tune.arena_r, 0, SPA);
  ctx.strokeStyle = 'rgba(160,220,210,0.25)'; ctx.lineWidth = 6; ctx.stroke();
  for (const d of state.dust) {
    ctx.globalAlpha = 0.18 + 0.1 * Math.sin(d.t); ctx.fillStyle = '#9fd8cf';
    ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, SPA); ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (const p of state.food) drawCellBody(p);
  for (const c of state.cells) drawCellBody(c, true);
  drawCellBody(state.me);
  ctx.restore();
  hud();
}
function hud() {
  const s = state;
  text('体型', 24, 34, 22, 'rgba(210,240,235,0.6)', 'left');
  text(`${area(s.me.r)}`, 24, 66, 40, '#bff5e6', 'left');
  text(`最佳 ${Math.max(best(), area(s.me.r))}`, 24, 104, 22, 'rgba(210,240,235,0.55)', 'left');
  text(`吃了 ${s.score} 口   ${Math.floor(s.t)} 秒`, W - 24, 44, 24, 'rgba(210,240,235,0.6)', 'right');
  // the size bar: the one number that is always on screen
  const bw = 260, x = W / 2 - bw / 2, k = Math.min(1, area(s.me.r) / (area(tune.arena_r * 0.32) || 1));
  ctx.fillStyle = 'rgba(210,240,235,0.15)'; ctx.fillRect(x, H - 30, bw, 8);
  ctx.fillStyle = '#6fe3c8'; ctx.fillRect(x, H - 30, bw * Math.sqrt(k), 8);
}

// ---- Scenes ------------------------------------------------------------------------------
let scene, state;
const figures = { // the sheet: every kind, its own outline, its name under it
  update() {},
  draw() {
    clear('#0a1e33');
    const kinds = [
      ['pellet', '浮点 · 吃它,长身体'], ['me', '你 · 膜边会颤'],
      ['rival', '同游 · 比你小就能吃'], ['spike', '棘突 · 比你大,躲开'],
    ];
    kinds.forEach(([kind, label], i) => {
      const x = 180 + i * 260, y = 330;
      const c = { id: 0, x, y, r: kind === 'pellet' ? 26 : 62, kind, t: 1.2, phase: 0, vx: 0, vy: 0 };
      const saved = state; state = { trail: [], me: c, cam: 1, shake: 0, t: 0 };
      drawCellBody(c, false);
      state = saved;
      text(label.split(' · ')[0], x, y + 110, 26, '#e8f5f0');
      text(label.split(' · ')[1], x, y + 140, 18, 'rgba(210,240,235,0.6)');
    });
    text('四种轮廓,一眼分敌我', W / 2, 560, 24, 'rgba(210,240,235,0.7)');
  },
};
const scenes = {
  figures,
  title: {
    update(dt) {
      state.t += dt;
      const btn = { x: 110, y: 524, w: 310, h: 66 };
      const hover = pointer.x >= btn.x && pointer.x <= btn.x + btn.w && pointer.y >= btn.y && pointer.y <= btn.y + btn.h;
      canvas.style.cursor = hover ? 'pointer' : 'default';
      if (pressed('Enter') || pressed('Space') || (pointer.click && hover)) {
        pointer.click = false; pointer.down = false; canvas.style.cursor = 'default'; reset(); scene = 'play'; return;
      }
      pointer.click = false;
    },
    draw() {
      dishBG();
      const t = state.t || 0;
      // 培养皿光环与微尘
      ctx.save();
      ctx.strokeStyle = 'rgba(111,227,200,0.16)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(930, 360, 245, 0, SPA); ctx.stroke();
      ctx.strokeStyle = 'rgba(111,227,200,0.08)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(930, 360, 290, 0, SPA); ctx.stroke();
      ctx.restore();

      // 右侧活性培养皿生态演示（使用游戏自身 drawCellBody）
      const saved = state;
      const demoMe = { id: 1, x: 930 + Math.cos(t * 0.9) * 38, y: 350 + Math.sin(t * 1.4) * 24, r: 54, kind: 'me', t: t * 2, phase: 0, vx: Math.cos(t), vy: Math.sin(t) };
      const demoRival = { id: 2, x: 800 + Math.sin(t * 0.8) * 28, y: 235 + Math.cos(t * 1.1) * 22, r: 30, kind: 'rival', t: t * 1.5, phase: 1, vx: 1, vy: 0 };
      const demoSpike = { id: 3, x: 1065 + Math.cos(t * 0.7) * 24, y: 460 + Math.sin(t * 0.9) * 26, r: 68, kind: 'spike', t: t, phase: 2, vx: -1, vy: 0 };
      const demoPellets = [
        [810, 440, 10], [870, 210, 9], [1040, 240, 11], [985, 515, 10], [745, 340, 8], [1105, 310, 9],
      ];
      state = { trail: [], me: demoMe, cam: 1, shake: 0, t };
      for (let i = 0; i < demoPellets.length; i++) {
        const [px, py, pr] = demoPellets[i];
        drawCellBody({ id: 10 + i, x: px + Math.sin(t * 1.4 + i) * 6, y: py + Math.cos(t * 1.2 + i) * 6, r: pr, kind: 'pellet', t: t + i, phase: i, vx: 0, vy: 0 }, false);
      }
      drawCellBody(demoRival, false);
      drawCellBody(demoSpike, false);
      drawCellBody(demoMe, false);
      state = saved;

      // 右侧小图例标签
      text('同游 · 可吞', demoRival.x, demoRival.y + 50, 15, 'rgba(191,245,230,0.8)');
      text('你 · 颤动膜边', demoMe.x, demoMe.y + 74, 16, '#bff5e6');
      text('棘突 · 躲开', demoSpike.x, demoSpike.y + 88, 15, 'rgba(232,138,150,0.85)');

      // 左侧标题区
      const lx = 110;
      ctx.beginPath(); ctx.roundRect(lx, 104, 134, 32, 16);
      ctx.fillStyle = 'rgba(111,227,200,0.14)'; ctx.fill();
      ctx.strokeStyle = 'rgba(111,227,200,0.45)'; ctx.lineWidth = 1.5; ctx.stroke();
      text('生物吞噬', lx + 67, 120, 15, '#6fe3c8');

      ctx.save();
      ctx.shadowColor = 'rgba(111,227,200,0.28)'; ctx.shadowBlur = 24;
      text(TITLE, lx, 196, 98, '#bff5e6', 'left');
      ctx.restore();
      text('吃下比你小的，躲开比你大的 —— 越长越大，越慢越沉', lx, 270, 23, 'rgba(210,240,235,0.74)', 'left');

      const hi = best();
      if (hi > 0) {
        ctx.beginPath(); ctx.roundRect(lx, 304, 214, 36, 10);
        ctx.fillStyle = 'rgba(111,227,200,0.12)'; ctx.fill();
        ctx.strokeStyle = 'rgba(111,227,200,0.35)'; ctx.lineWidth = 1.5; ctx.stroke();
        text(`历史最大体型  ${hi}`, lx + 107, 322, 17, '#bff5e6');
      }

      const chips = [
        ['鼠标 / 方向键', '引导游动方向'],
        ['左键 / 空格', '喷射加速（消耗少许质量）'],
        ['P / M', '暂停游戏 / 静音开关'],
      ];
      chips.forEach(([key, desc], i) => {
        const cy = 362 + i * 50;
        ctx.beginPath(); ctx.roundRect(lx, cy, 500, 42, 10);
        ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();
        ctx.strokeStyle = 'rgba(210,240,235,0.12)'; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.beginPath(); ctx.roundRect(lx + 8, cy + 7, 134, 28, 7);
        ctx.fillStyle = 'rgba(111,227,200,0.18)'; ctx.fill();
        text(key, lx + 75, cy + 21, 15, '#bff5e6');
        text(desc, lx + 158, cy + 21, 17, '#d8eee8', 'left');
      });

      // 主开始按钮
      const btn = { x: lx, y: 524, w: 310, h: 66 };
      const hover = pointer.x >= btn.x && pointer.x <= btn.x + btn.w && pointer.y >= btn.y && pointer.y <= btn.y + btn.h;
      ctx.save();
      ctx.shadowColor = hover ? 'rgba(111,227,200,0.5)' : 'rgba(111,227,200,0.22)'; ctx.shadowBlur = hover ? 26 : 14;
      ctx.beginPath(); ctx.roundRect(btn.x, btn.y - (hover ? 2 : 0), btn.w, btn.h, 16);
      ctx.fillStyle = hover ? '#8df0d8' : '#6fe3c8'; ctx.fill();
      ctx.restore();
      text('潜入培养皿  [Enter / 空格]', btn.x + btn.w / 2, btn.y - (hover ? 2 : 0) + btn.h / 2, 22, '#06202a');
    },
  },
  play: {
    update(dt) {
      if (pressed('KeyP') || pressed('Escape')) { scene = 'pause'; return; }
      if (pressed('KeyR')) { reset(); return; }
      update(state, dt);
      if (state.phase === 'over') scene = 'over';
    },
    draw() { drawPlay(); },
  },
  pause: {
    update() { if (pressed('KeyP') || pressed('Escape')) scene = 'play'; },
    draw() { scenes.play.draw(); ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, W, H); text('暂停', W / 2, H / 2, 56, '#fff'); },
  },
  over: {
    update() { if (pressed('KeyR') || pressed('Enter')) { reset(); scene = 'play'; } },
    draw() {
      drawPlay();
      ctx.fillStyle = 'rgba(4,10,16,0.78)'; ctx.fillRect(0, 0, W, H);
      text('被吞了', W / 2, 260, 64, '#e88a96');
      text(state.gained, W / 2, 350, 30, '#bff5e6');
      text('按 R 立刻再来一局', W / 2, H - 120, 26, '#ccc');
    },
  },
  results: {
    update() { if (pressed('Enter')) { reset(); scene = 'play'; } },
    draw() { scenes.over.draw(); },
  },
};

// ---- Loop: fixed step --------------------------------------------------------------------
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
  step(n = 1, draw = true, alpha = 1) {
    for (let i = 0; i < n; i++) step();
    if (draw) { ALPHA = alpha; drawFrame(); }
  },
};

reset();
scene = params.get('scene') || 'title';
last = clock.now();
if (params.get('manual') === '1') drawFrame();
else { requestAnimationFrame(frame); setInterval(timer, 50); }
