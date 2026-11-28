'use strict';
// ---- Built to be checked ----------------------------------------------------------------
const params = new URLSearchParams(location.search);
const tune = new Proxy({}, { get: (_, k) => CONFIG[k].value });
const STEP = 1 / 60;
const W = 1280, H = 720;
const PIXEL = false;
const FONT = 'sans-serif';
const TITLE = '潮汐割草';
const CONTROLS = ['方向键 / WASD:只走位,武器自动开火', '升级:按 1 / 2 / 3 选卡(或点卡)', 'P: 暂停 · M: 静音', '标题界面: B 用金币买护符(永久 +5% 伤害)'];
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
function hash2(ix, iy) { let h = ix * 374761393 + iy * 668265263 + seed; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

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
let mx = 0, my = 0, click = false;
addEventListener('keydown', e => {
  startAudio();
  if (!e.repeat) { down.add(e.code); hit.add(e.code); }
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', e => down.delete(e.code));
addEventListener('pointerdown', e => { startAudio(); click = true; mx = e.clientX; my = e.clientY; });
addEventListener('pointermove', e => { mx = e.clientX; my = e.clientY; });
addEventListener('blur', () => down.clear());
function toLogical() { const r = canvas.getBoundingClientRect(); return [(mx - r.left) / r.width * W, (my - r.top) / r.height * H]; }

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

// ---- 武器与牌 -------------------------------------------------------------------------------
const WEAPONS = {
  knife: { name: '飞刀', max: 5, desc: l => `向最近的敌人掷刀,${1 + Math.floor((l+1)/2)} 把同屏` },
  ring:  { name: '潮环', max: 5, desc: l => `以你为心的冲击环扫过一圈敌人` },
  zap:   { name: '光鳗', max: 5, desc: l => `电击 ${Math.round(tune.zap_range)} 内最近的敌人` },
};
const EVOS = [
  { w: 'ring', need: 'tidebody', name: '海啸环', note: '潮环满级 + 潮躯 → 更宽、更痛的两倍环' },
  { w: 'knife', need: 'whet', name: '剑气', note: '飞刀满级 + 砺石 → 穿透,伤害 ×1.5' },
  { w: 'zap', need: 'static', name: '雷牢', note: '光鳗满级 + 静电场 → 连跳 3 个目标' },
];
const PASSIVES = {
  boots:   { name: '迅捷靴', note: '移速 +12%', max: 3 },
  tidebody:{ name: '潮躯', note: '受伤 -15%', max: 3 },
  whet:    { name: '砺石', note: '伤害 +15%', max: 3 },
  heart:   { name: '活力心', note: '生命上限 +20', max: 3 },
  magnet:  { name: '磁力符', note: '吸取范围 ×1.4', max: 2 },
  static:  { name: '静电场', note: '攻速 +12%', max: 3 },
  nos:     { name: '寻宝鼻', note: '金币掉率 ×1.6', max: 2 },
};

// ---- 状态 ---------------------------------------------------------------------------------
let scene, state, nextId = 1;
let meta = { coins: 0, charms: 0 };
try { meta = Object.assign(meta, JSON.parse(localStorage.getItem('tide_meta') || '{}')); } catch (e) {}
function saveMeta() { try { localStorage.setItem('tide_meta', JSON.stringify(meta)); } catch (e) {} }

function reset() {
  seed = Number(params.get('seed')) || CONFIG.seed;
  nextId = 1;
  state = {
    t: 0, score: 0, gained: '', phase: 'play',
    p: { x: 0, y: 0, hp: tune.player_hp, maxhp: tune.player_hp, inv: 0, trail: [] },
    lvl: 1, xp: 0, kills: 0,
    w: { knife: 1 }, pas: {}, // 开局自带一把飞刀(brief M1):否则无武器→无击杀→无经验→永远不升级
    enemies: [], gems: [], coins: [], proj: [], knives: [], rings: [], beams: [],
    spawnT: 0, cards: null, offer: '',
    boss: null, won: false,
  };
}
function wLv(k) { return state.w[k] || 0; }
function pLv(k) { return state.pas[k] || 0; }
function dmgBonus() { return (1 + 0.15 * pLv('whet')) * (1 + tune.meta_gain * meta.charms); }
function rateBonus() { return 1 / (1 + 0.12 * pLv('static')); }
function pullRadius() { return tune.gem_pull * Math.pow(1.4, pLv('magnet')); }
function xpNeed() { return tune.xp_start + (state.lvl - 1) * tune.xp_grow; }

function pickCards() {
  const pool = [];
  for (const e of EVOS) if (wLv(e.w) >= WEAPONS[e.w].max && pLv(e.need) >= 1 && !state.w['evo_' + e.w])
    pool.push({ type: 'evo', w: e.w, name: WEAPONS[e.w].name + '→' + e.name, note: e.note });
  for (const k in WEAPONS) {
    const l = wLv(k);
    if (l >= WEAPONS[k].max) continue;
    if (l === 0 && Object.keys(state.w).filter(x => !x.startsWith('evo_')).length >= 4) continue;
    pool.push({ type: 'w', k, name: (l ? WEAPONS[k].name + ' Lv' + (l+1) : '新武器·' + WEAPONS[k].name), note: WEAPONS[k].desc(l + 1) });
  }
  for (const k in PASSIVES) {
    const l = pLv(k);
    if (l >= PASSIVES[k].max) continue;
    pool.push({ type: 'p', k, name: PASSIVES[k].name + (l ? ' Lv' + (l+1) : ' +1'), note: PASSIVES[k].note });
  }
  const cards = [];
  while (cards.length < 3 && pool.length) cards.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  state.cards = cards;
}
function takeCard(i) {
  const c = state.cards && state.cards[i];
  if (!c) return;
  if (c.type === 'evo') { state.w['evo_' + c.w] = 1; tone(660, .25, 'triangle', .4); tone(880, .3, 'triangle', .3); }
  else if (c.type === 'w') { state.w[c.k] = wLv(c.k) + 1; tone(520, .12, 'triangle'); }
  else { state.pas[c.k] = pLv(c.k) + 1; if (c.k === 'heart') { state.p.maxhp += 20; state.p.hp += 20; } tone(440, .1, 'triangle'); }
  state.cards = null; state.phase = 'play';
  events.push({ type: 'card', card: c.name });
}

// ---- 刷怪与敌人 -----------------------------------------------------------------------------
const KINDS = {
  crab:   { r: 15, hp: 'crab_hp',   spd: 'crab_spd',   dmg: 'crab_dmg',   t0: 'spawn_crab' },
  flea:   { r: 9,  hp: 'flea_hp',   spd: 'flea_spd',   dmg: 'flea_dmg',   t0: 'spawn_flea' },
  urchin: { r: 13, hp: 'urchin_hp', spd: 'urchin_spd', dmg: 'urchin_dmg', t0: 'spawn_urchin' },
  shell:  { r: 19, hp: 'shell_hp',  spd: 'shell_spd',  dmg: 'shell_dmg',  t0: 'spawn_shell' },
};
function ramp() { return Math.min(1, state.t / tune.run_time); }
function spawnEnemy(kind, x, y) {
  const K = KINDS[kind];
  const m = 1 + (tune.hp_ramp - 1) * ramp();
  state.enemies.push({ id: nextId++, kind, x, y, hp: tune[K.hp] * m, maxhp: 0, r: K.r, shootT: 1 + rng(), wob: rng() * 7 });
  const e = state.enemies[state.enemies.length - 1]; e.maxhp = e.hp; return e;
}
function doSpawn() {
  const unlocked = Object.keys(KINDS).filter(k => state.t >= tune[KINDS[k].t0]);
  const weight = { crab: 3, flea: 2, urchin: 2, shell: 2 };
  const pool = []; unlocked.forEach(k => { for (let i = 0; i < weight[k]; i++) pool.push(k); });
  const kind = pool[Math.floor(rng() * pool.length)];
  const a = rng() * Math.PI * 2, d = 480 + rng() * 200;
  spawnEnemy(kind, state.p.x + Math.cos(a) * d, state.p.y + Math.sin(a) * d);
}

function hurtPlayer(dmg) {
  const p = state.p;
  if (p.inv > 0 || state.phase !== 'play') return;
  p.hp -= dmg * (1 - 0.15 * pLv('tidebody')) * (1 + (tune.dmg_ramp - 1) * ramp());
  p.inv = tune.invuln_time; tone(150, .18, 'sawtooth', .35);
  if (p.hp <= 0) {
    p.hp = 0; state.gained = `撑到 ${fmt(state.t)} · 击杀 ${state.kills}`;
    meta.coins += Math.floor(state.t / 20); saveMeta();
    scene = 'over'; events.push({ type: 'dead' });
  }
}
function fmt(t) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + String(s).padStart(2, '0'); }

function killEnemy(e) {
  state.enemies.splice(state.enemies.indexOf(e), 1);
  state.kills++; state.score += Math.round(e.maxhp);
  state.gems.push({ x: e.x, y: e.y, t: 0 });
  if (rng() < tune.coin_chance * (1 + 0.6 * pLv('nos'))) state.coins.push({ x: e.x, y: e.y, t: 0 });
  tone(720 + rng() * 120, .05, 'square', .12);
}

// ---- 武器发射 -----------------------------------------------------------------------------
function nearest(x, y, maxD) {
  let best = null, bd = maxD * maxD;
  for (const e of state.enemies) { const dx = e.x - x, dy = e.y - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = e; } }
  if (state.boss && state.boss.hp > 0) { const dx = state.boss.x - x, dy = state.boss.y - y, d = dx * dx + dy * dy; if (d < bd) best = state.boss; }
  return best;
}
function fireWeapons(dt) {
  const s = state;
  s.fireT = (s.fireT || {});
  if (wLv('knife')) {
    const l = wLv('knife'), n = Math.min(6, tune.knife_count + Math.floor(l / 2));
    s.fireT.knife = (s.fireT.knife || 0) - dt;
    if (s.fireT.knife <= 0) {
      s.fireT.knife = tune.knife_interval * Math.pow(1 - tune.rate_per_lvl, l - 1) * rateBonus();
      for (let i = 0; i < n; i++) {
        const t = nearest(s.p.x, s.p.y, 700); if (!t) break;
        const a = Math.atan2(t.y - s.p.y, t.x - s.p.x) + (i - n / 2) * .12;
        s.knives.push({ x: s.p.x, y: s.p.y, vx: Math.cos(a) * tune.knife_speed, vy: Math.sin(a) * tune.knife_speed,
          dmg: tune.knife_dmg * (1 + tune.dmg_per_lvl * (l - 1)) * dmgBonus() * (s.w.evo_knife ? 1.5 : 1), pierce: s.w.evo_knife ? 3 : 1, hit: {} });
      }
      tone(300, .04, 'triangle', .1);
    }
  }
  if (wLv('ring')) {
    const l = wLv('ring');
    s.fireT.ring = (s.fireT.ring || 0) - dt;
    if (s.fireT.ring <= 0) {
      s.fireT.ring = tune.ring_interval * Math.pow(1 - tune.rate_per_lvl, l - 1) * rateBonus();
      s.rings.push({ x: s.p.x, y: s.p.y, r: 30, maxR: tune.ring_r0 + tune.ring_r1 * (l - 1), hit: {},
        dmg: tune.ring_dmg * (1 + tune.dmg_per_lvl * (l - 1)) * dmgBonus() * (s.w.evo_ring ? 2 : 1), wide: s.w.evo_ring ? 46 : 26 });
    }
  }
  if (wLv('zap')) {
    const l = wLv('zap');
    s.fireT.zap = (s.fireT.zap || 0) - dt;
    if (s.fireT.zap <= 0) {
      s.fireT.zap = tune.zap_interval * Math.pow(1 - tune.rate_per_lvl, l - 1) * rateBonus();
      let src = s.p, chains = s.w.evo_zap ? 3 : 1;
      const done = {};
      for (let c = 0; c < chains; c++) {
        const t = nearest(src.x, src.y, tune.zap_range); if (!t) break;
        const d = tune.zap_dmg * (1 + tune.dmg_per_lvl * (l - 1)) * dmgBonus();
        t.hp -= d; s.beams.push({ x1: src.x, y1: src.y, x2: t.x, y2: t.y, t: 0.14 });
        tone(900 + c * 200, .05, 'sawtooth', .08);
        done[t.id] = d; src = t;
        if (t.hp <= 0) { if (t === s.boss) return; killEnemy(t); break; }
      }
    }
  }
}

// ---- 主更新 -----------------------------------------------------------------------------
function update(dt) {
  const s = state;
  if (s.phase === 'levelup') {
    if (pressed('Digit1')) takeCard(0);
    if (pressed('Digit2')) takeCard(1);
    if (pressed('Digit3')) takeCard(2);
    if (click) { const [lx] = toLogical(); const i = Math.floor((lx - (W / 2 - 330)) / 225); if (i >= 0 && i < 3) takeCard(i); }
    click = false; return;
  }
  s.t += dt; s.p.inv = Math.max(0, s.p.inv - dt);

  // 走位(唯一操作)
  let vx = (down.has('ArrowRight') || down.has('KeyD') ? 1 : 0) - (down.has('ArrowLeft') || down.has('KeyA') ? 1 : 0);
  let vy = (down.has('ArrowDown') || down.has('KeyS') ? 1 : 0) - (down.has('ArrowUp') || down.has('KeyW') ? 1 : 0);
  const sp = tune.move_speed * (1 + 0.12 * pLv('boots'));
  if (vx || vy) { const n = Math.hypot(vx, vy); s.p.x += vx / n * sp * dt; s.p.y += vy / n * sp * dt; }
  s.p.trail.unshift({ x: s.p.x, y: s.p.y }); if (s.p.trail.length > 16) s.p.trail.pop();

  // 刷怪
  s.spawnT -= dt;
  if (s.spawnT <= 0 && !s.boss) {
    s.spawnT = tune.spawn_start + (tune.spawn_end - tune.spawn_start) * ramp();
    const n = Math.round(tune.batch_start + (tune.batch_end - tune.batch_start) * ramp());
    for (let i = 0; i < n && s.enemies.length < tune.crowd_cap; i++) doSpawn();
  }

  fireWeapons(dt);

  // 敌人
  const m = 1 + (tune.dmg_ramp - 1) * ramp();
  for (const e of s.enemies) {
    const K = KINDS[e.kind], dx = s.p.x - e.x, dy = s.p.y - e.y, d = Math.hypot(dx, dy) || 1;
    if (e.kind === 'urchin') {
      if (d > tune.urchin_range * .8) { e.x += dx / d * tune[e.kind + '_spd'] * dt; e.y += dy / d * tune[e.kind + '_spd'] * dt; }
      else if (d < tune.urchin_range * .5) { e.x -= dx / d * 20 * dt; e.y -= dy / d * 20 * dt; }
      e.shootT -= dt;
      if (e.shootT <= 0) { e.shootT = tune.urchin_shot; s.proj.push({ x: e.x, y: e.y, vx: dx / d * tune.proj_speed, vy: dy / d * tune.proj_speed }); }
    } else {
      const zig = e.kind === 'flea' ? Math.sin(s.t * 6 + e.wob) * .6 : 0;
      const a = Math.atan2(dy, dx) + zig;
      e.x += Math.cos(a) * tune[e.kind + '_spd'] * dt; e.y += Math.sin(a) * tune[e.kind + '_spd'] * dt;
    }
    if (d < K.r + 13) hurtPlayer(tune[e.kind + '_dmg'] * m);
  }

  // Boss
  if (!s.boss && s.t >= tune.run_time) {
    s.boss = { x: s.p.x + 420, y: s.p.y, hp: tune.boss_hp, maxhp: tune.boss_hp, r: 52, addT: 2, burstT: 3 };
    tone(90, .6, 'sawtooth', .5); events.push({ type: 'boss' });
  }
  if (s.boss) {
    const b = s.boss, dx = s.p.x - b.x, dy = s.p.y - b.y, d = Math.hypot(dx, dy) || 1;
    b.x += dx / d * tune.boss_spd * dt; b.y += dy / d * tune.boss_spd * dt;
    b.addT -= dt; if (b.addT <= 0) { b.addT = tune.boss_adds; for (let i = 0; i < 2; i++) spawnEnemy('crab', b.x + (rng()-.5)*120, b.y + (rng()-.5)*120); }
    b.burstT -= dt; if (b.burstT <= 0) { b.burstT = tune.boss_burst;
      for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; s.proj.push({ x: b.x, y: b.y, vx: Math.cos(a) * tune.proj_speed * .8, vy: Math.sin(a) * tune.proj_speed * .8 }); }
      tone(120, .3, 'square', .4); }
    if (d < b.r + 13) hurtPlayer(tune.boss_dmg * m);
    if (b.hp <= 0) { s.won = true; s.gained = `斩杀潮王 · 击杀 ${state.kills}`; meta.coins += 120; saveMeta();
      scene = 'results'; events.push({ type: 'win' }); return; }
  }

  // 飞刀
  for (const k of s.knives) {
    k.x += k.vx * dt; k.y += k.vy * dt; k.life = (k.life || 0) + dt;
    for (const e of s.enemies) if (!k.hit[e.id] && Math.hypot(e.x - k.x, e.y - k.y) < e.r + 6) {
      k.hit[e.id] = 1; e.hp -= k.dmg - (e.kind === 'shell' ? tune.shell_armor : 0);
      if (e.hp <= 0) killEnemy(e);
      if (Object.keys(k.hit).length >= k.pierce) k.life = 99;
    }
    if (s.boss && !k.hit['b'] && Math.hypot(s.boss.x - k.x, s.boss.y - k.y) < s.boss.r + 6) {
      k.hit['b'] = 1; s.boss.hp -= k.dmg; if (Object.keys(k.hit).length >= k.pierce) k.life = 99; }
  }
  s.knives = s.knives.filter(k => k.life < 1.6 && Math.hypot(k.x - s.p.x, k.y - s.p.y) < 800);

  // 潮环
  for (const r of s.rings) {
    r.r += 620 * dt;
    for (const e of s.enemies) if (!r.hit[e.id] && Math.abs(Math.hypot(e.x - r.x, e.y - r.y) - r.r) < r.wide) {
      r.hit[e.id] = 1; e.hp -= r.dmg - (e.kind === 'shell' ? tune.shell_armor : 0); if (e.hp <= 0) killEnemy(e); }
    if (s.boss && !r.hit['b'] && Math.abs(Math.hypot(s.boss.x - r.x, s.boss.y - r.y) - r.r) < r.wide) { r.hit['b'] = 1; s.boss.hp -= r.dmg; }
  }
  s.rings = s.rings.filter(r => r.r < r.maxR);
  s.beams = s.beams.filter(b => (b.t -= dt) > 0);

  // 敌弹
  for (const p of s.proj) { p.x += p.vx * dt; p.y += p.vy * dt;
    if (Math.hypot(p.x - s.p.x, p.y - s.p.y) < 15) { hurtPlayer(tune.urchin_dmg * m); p.dead = 1; } }
  s.proj = s.proj.filter(p => !p.dead && Math.hypot(p.x - s.p.x, p.y - s.p.y) < 900);

  // 宝石与金币
  const pr = pullRadius();
  for (const g of s.gems) { const d = Math.hypot(g.x - s.p.x, g.y - s.p.y);
    if (d < pr) { const a = Math.atan2(s.p.y - g.y, s.p.x - g.x); g.x += Math.cos(a) * tune.gem_speed * dt; g.y += Math.sin(a) * tune.gem_speed * dt; }
    if (d < 18) { g.dead = 1; s.xp++; tone(560 + rng() * 60, .04, 'sine', .12);
      while (s.xp >= xpNeed()) { s.xp -= xpNeed(); s.lvl++; pickCards(); s.phase = 'levelup'; events.push({ type: 'level', lvl: s.lvl }); } } }
  s.gems = s.gems.filter(g => !g.dead);
  for (const c of s.coins) { const d = Math.hypot(c.x - s.p.x, c.y - s.p.y);
    if (d < pr * 1.4) { const a = Math.atan2(s.p.y - c.y, s.p.x - c.x); c.x += Math.cos(a) * tune.gem_speed * dt; c.y += Math.sin(a) * tune.gem_speed * dt; }
    if (d < 20) { c.dead = 1; meta.coins++; saveMeta(); tone(880, .08, 'triangle', .2); } }
  s.coins = s.coins.filter(c => !c.dead);
  click = false;
}

// ---- 绘图:全部手绘剪影,无 emoji -----------------------------------------------------------------
function worldCam() { return [W / 2 - state.p.x, H / 2 - state.p.y]; }
function drawBG() {
  const [ox, oy] = worldCam();
  ctx.fillStyle = '#0c1626'; ctx.fillRect(0, 0, W, H);
  const T = 220, x0 = Math.floor((-ox) / T) - 1, y0 = Math.floor((-oy) / T) - 1;
  for (let iy = y0; iy < y0 + H / T + 3; iy++) for (let ix = x0; ix < x0 + W / T + 3; ix++) {
    const h = hash2(ix, iy), px = ix * T + ox, py = iy * T + oy;
    if (h < .32) { ctx.fillStyle = 'rgba(90,180,190,0.07)'; ctx.beginPath(); ctx.ellipse(px + T / 2, py + T / 2, T * .34 + h * 60, T * .2 + h * 30, h * 7, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(140,210,220,0.10)'; ctx.lineWidth = 2; ctx.stroke(); }
    else if (h < .4) { ctx.fillStyle = 'rgba(120,240,230,0.12)'; for (let i = 0; i < 3; i++) ctx.fillRect(px + h * 180 + i * 22, py + ((h * 977) % 1) * 160, 2, 2); }
    else if (h < .52) { ctx.strokeStyle = 'rgba(90,150,120,0.22)'; ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) { const wx = px + 40 + h * 120 + i * 14, wy = py + ((h * 511 + i) % 1) * 170;
        ctx.beginPath(); ctx.moveTo(wx, wy); ctx.quadraticCurveTo(wx + 4, wy - 14, wx + (i - 1) * 6, wy - 24); ctx.stroke(); } }
  }
}
function drawPlayer() {
  const s = state, [ox, oy] = worldCam();
  // 拖尾
  for (let i = s.p.trail.length - 1; i >= 0; i--) { const tr = s.p.trail[i], a = (1 - i / s.p.trail.length) * .25;
    ctx.fillStyle = `rgba(255,214,140,${a})`; ctx.beginPath(); ctx.arc(tr.x + ox, tr.y + oy, 10 * (1 - i / 24), 0, 7); ctx.fill(); }
  const px = s.p.x + ox, py = s.p.y + oy;
  if (s.p.inv > 0 && Math.floor(s.t * 20) % 2) return;
  const g = ctx.createRadialGradient(px, py, 4, px, py, 46);
  g.addColorStop(0, 'rgba(255,236,180,0.55)'); g.addColorStop(1, 'rgba(255,236,180,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, 46, 0, 7); ctx.fill();
  ctx.fillStyle = '#ffe9b8'; ctx.beginPath(); ctx.arc(px, py, 11, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff7e0'; ctx.beginPath(); ctx.arc(px, py - 2, 6, 0, 7); ctx.fill();
  ctx.strokeStyle = '#d99a3a'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(px, py, 11, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(px, py - 11); ctx.quadraticCurveTo(px + 3, py - 19, px, py - 24); ctx.stroke(); // 灯芯火苗
}
function drawEnemy(e) {
  const [ox, oy] = worldCam(); const x = e.x + ox, y = e.y + oy;
  if (x < -60 || x > W + 60 || y < -60 || y > H + 60) return;
  const wob = Math.sin(state.t * 8 + e.wob) * 1.5;
  if (e.kind === 'crab') {
    ctx.fillStyle = '#e2645f'; ctx.strokeStyle = '#8f2f2b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(x, y, 15, 11, 0, 0, 7); ctx.fill(); ctx.stroke();
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(x - 12 + i * 12, y + 6); ctx.lineTo(x - 16 + i * 14, y + 14 + wob); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(x - 17, y - 6, 5, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.arc(x + 17, y - 6, 5, 0, 7); ctx.stroke();
    ctx.fillStyle = '#2a1210'; ctx.fillRect(x - 5, y - 4, 2.5, 2.5); ctx.fillRect(x + 3, y - 4, 2.5, 2.5);
  } else if (e.kind === 'flea') {
    ctx.fillStyle = '#d8a83f'; ctx.strokeStyle = '#8a6112'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(x, y, 9, 6, Math.atan2(state.p.y - e.y, state.p.x - e.x), 0, 7); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 6, y + 3); ctx.quadraticCurveTo(x - 14, y + 10 + wob, x - 18, y + 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + 7, y - 2); ctx.lineTo(x + 12, y - 7); ctx.stroke();
  } else if (e.kind === 'urchin') {
    ctx.fillStyle = '#41305e'; ctx.strokeStyle = '#b98cff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.fill();
    for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 8, y + Math.sin(a) * 8); ctx.lineTo(x + Math.cos(a) * (17 + wob), y + Math.sin(a) * (17 + wob)); ctx.stroke(); }
    ctx.fillStyle = '#e8d9ff'; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
  } else if (e.kind === 'shell') {
    ctx.fillStyle = '#3f7d5a'; ctx.strokeStyle = '#1d4430'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y - 2, 19, Math.PI, 0); ctx.quadraticCurveTo(x + 19, y + 10, x, y + 11); ctx.quadraticCurveTo(x - 19, y + 10, x - 19, y - 2); ctx.fill(); ctx.stroke();
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(x, y + 4, 6 + i * 5, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); }
    ctx.fillStyle = '#c9e2d2'; ctx.beginPath(); ctx.arc(x - 6, y + 6, 2.5, 0, 7); ctx.arc(x + 6, y + 6, 2.5, 0, 7); ctx.fill();
  }
  if (e.hp < e.maxhp) { ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(x - 14, y - e.r - 12, 28, 4);
    ctx.fillStyle = '#ff7b6e'; ctx.fillRect(x - 14, y - e.r - 12, 28 * Math.max(0, e.hp / e.maxhp), 4); }
}
function drawBoss() {
  const b = state.boss; if (!b) return;
  const [ox, oy] = worldCam(); const x = b.x + ox, y = b.y + oy;
  ctx.fillStyle = '#a93226'; ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(x, y + 4, 46, Math.PI, 0); ctx.quadraticCurveTo(x + 46, y + 40, x, y + 42); ctx.quadraticCurveTo(x - 46, y + 40, x - 46, y + 4); ctx.fill(); ctx.stroke();
  for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(x, y + 30, 9 + i * 9, Math.PI * 1.1, Math.PI * 1.9); ctx.strokeStyle = 'rgba(242,193,78,.5)'; ctx.lineWidth = 2; ctx.stroke(); }
  ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 4;
  for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(x - 40 + i * 20, y - 12); ctx.lineTo(x - 34 + i * 20, y - 34 - (i % 2) * 8); ctx.stroke(); }
  ctx.fillStyle = '#ffe1b0'; ctx.beginPath(); ctx.arc(x - 16, y + 26, 6, 0, 7); ctx.arc(x + 16, y + 26, 6, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(x - 52, y + 12, 13, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.arc(x + 52, y + 12, 13, 0, 7); ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(x - 60, y - 76, 120, 9);
  ctx.fillStyle = '#ff5f52'; ctx.fillRect(x - 60, y - 76, 120 * Math.max(0, b.hp / b.maxhp), 9);
  text('潮王', x, y - 90, 26, '#ffd97a');
}
function drawFX() {
  const [ox, oy] = worldCam(); const s = state;
  ctx.fillStyle = '#9ff0c0';
  for (const g of s.gems) { const x = g.x + ox, y = g.y + oy; ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 4, y); ctx.closePath(); ctx.fill(); }
  for (const c of s.coins) { const x = c.x + ox, y = c.y + oy; ctx.fillStyle = '#f2c14e';
    ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.strokeStyle = '#9a6f1c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 6, .6, 2.6); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(170,220,255,.8)'; ctx.lineWidth = 2; ctx.fillStyle = '#cfe6ff';
  for (const k of s.knives) { const x = k.x + ox, y = k.y + oy, a = Math.atan2(k.vy, k.vx);
    ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.beginPath(); ctx.moveTo(-9, -3); ctx.lineTo(7, 0); ctx.lineTo(-9, 3); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore(); }
  for (const r of s.rings) { ctx.strokeStyle = `rgba(150,235,220,${Math.max(0, .6 - r.r / r.maxR * .5)})`; ctx.lineWidth = r.wide * .5;
    ctx.beginPath(); ctx.arc(r.x + ox, r.y + oy, r.r, 0, 7); ctx.stroke(); }
  for (const b of s.beams) { ctx.strokeStyle = `rgba(200,220,255,${Math.min(.9, b.t * 6)})`; ctx.lineWidth = 3; ctx.beginPath();
    ctx.moveTo(b.x1 + ox, b.y1 + oy); const mx2 = (b.x1 + b.x2) / 2 + ox + 12, my2 = (b.y1 + b.y2) / 2 + oy - 12;
    ctx.quadraticCurveTo(mx2, my2, b.x2 + ox, b.y2 + oy); ctx.stroke(); }
  ctx.fillStyle = '#b7c6e8';
  for (const p of s.proj) { const x = p.x + ox, y = p.y + oy; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
    ctx.strokeStyle = '#6a5b8a'; ctx.lineWidth = 1.5; for (let i = 0; i < 4; i++) { const a = i * 1.57 + state.t * 5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * 8, y + Math.sin(a) * 8); ctx.stroke(); } }
}
function drawHUD() {
  const s = state;
  ctx.fillStyle = 'rgba(8,12,22,.72)'; ctx.fillRect(0, 0, W, 46);
  ctx.fillStyle = 'rgba(20,30,45,.9)'; ctx.fillRect(16, 14, 220, 18);
  ctx.fillStyle = '#ff6b5e'; ctx.fillRect(16, 14, 220 * (s.p.hp / s.p.maxhp), 18);
  ctx.strokeStyle = '#c8d6e8'; ctx.lineWidth = 1.5; ctx.strokeRect(16, 14, 220, 18);
  text(`${Math.ceil(s.p.hp)}/${s.p.maxhp}`, 126, 23, 14, '#fff');
  text(s.t < tune.run_time ? fmt(tune.run_time - s.t) : 'BOSS!', W / 2, 23, 30, s.t < tune.run_time ? '#fff' : '#ff7b6e');
  text(`Lv${s.lvl}`, W / 2 + 110, 23, 20, '#9ff0c0', 'left');
  ctx.fillStyle = 'rgba(20,30,45,.9)'; ctx.fillRect(W / 2 + 160, 17, 130, 12);
  ctx.fillStyle = '#7ec8ff'; ctx.fillRect(W / 2 + 160, 17, 130 * (s.xp / xpNeed()), 12);
  text(`击杀 ${s.kills}`, W - 160, 23, 16, '#cfe0f5', 'left');
  text(`金币 ${meta.coins}`, W - 60, 23, 16, '#f2c14e', 'left');
  // 武器栏(左下)
  let i = 0;
  for (const k in s.w) { if (k.startsWith('evo_')) continue; const l = s.w[k];
    const evo = s.w['evo_' + k] ? '→' + (EVOS.find(e => e.w === k) || {}).name : '';
    text(`${WEAPONS[k].name} Lv${l}${evo}`, 20, H - 18 - i * 20, 15, '#cfe0f5', 'left'); i++; }
  for (const k in s.pas) { text(`${PASSIVES[k].name} ${'▪'.repeat(s.pas[k])}`, 250, H - 18 - i * 20, 15, '#9ff0c0', 'left'); i++; }
}
function drawLevelUp() {
  clear('rgba(4,8,16,0.72)');
  text(`升级!Lv ${state.lvl} —— 按 1 / 2 / 3 选一张`, W / 2, H / 2 - 190, 34, '#fff');
  const cw = 210;
  state.cards.forEach((c, i) => {
    const x = W / 2 - 330 + i * 225, y = H / 2 - 120;
    ctx.fillStyle = c.type === 'evo' ? '#233a5e' : '#182640'; ctx.fillRect(x, y, cw, 250);
    ctx.strokeStyle = c.type === 'evo' ? '#f2c14e' : '#5a7bb5'; ctx.lineWidth = 3; ctx.strokeRect(x, y, cw, 250);
    text(String(i + 1), x + 24, y + 30, 30, '#8fb3ff');
    text(c.name, x + cw / 2, y + 70, 24, '#fff');
    const words = c.note.split(/(?<=[。，,·→])/); let wy = y + 110;
    for (const wd of words) { text(wd, x + cw / 2, wy, 17, '#cfe0f5'); wy += 24; }
  });
}

// ---- 场景 ---------------------------------------------------------------------------------
const scenes = {
  figures: {
    update(dt) { state.t += dt; },
    draw() {
      clear('#0c1626');
      const items = [
        ['提灯人(玩家)', () => drawFigurePlayer(0, 0)],
        ['爬蟹·慢', () => drawFigureEnemy('crab', 0, 0)],
        ['跳蚤·快', () => drawFigureEnemy('flea', 0, 0)],
        ['海胆·远程', () => drawFigureEnemy('urchin', 0, 0)],
        ['壳将·硬', () => drawFigureEnemy('shell', 0, 0)],
        ['潮王·Boss', () => drawFigureBoss(0, 0)],
      ];
      items.forEach((it, i) => {
        const x = 130 + i * 200, y = H / 2 - 30;
        ctx.save(); ctx.translate(x, y); it[1](); ctx.restore();
        text(it[0], x, y + 90, 18, '#cfe0f5');
      });
    },
  },
  title: {
    update(dt) {
      state.t += dt;
      const [lx, ly] = toLogical();
      const startBtn = { x: 96, y: 540, w: 300, h: 64 };
      const shopBtn = { x: 430, y: 422, w: 210, h: 52 };
      const hoverStart = lx >= startBtn.x && lx <= startBtn.x + startBtn.w && ly >= startBtn.y && ly <= startBtn.y + startBtn.h;
      const hoverShop = lx >= shopBtn.x && lx <= shopBtn.x + shopBtn.w && ly >= shopBtn.y && ly <= shopBtn.y + shopBtn.h;
      canvas.style.cursor = (hoverStart || hoverShop) ? 'pointer' : 'default';

      if (pressed('KeyB') || (click && hoverShop)) {
        click = false;
        if (meta.coins >= tune.meta_cost) { meta.coins -= tune.meta_cost; meta.charms++; saveMeta(); tone(880, .12, 'triangle'); }
        else tone(160, .15, 'sawtooth');
        return;
      }
      if (pressed('Enter') || pressed('Space') || (click && hoverStart)) {
        click = false; canvas.style.cursor = 'default'; reset(); scene = 'play'; return;
      }
      click = false;
    },
    draw() {
      drawBG();
      const t = state.t || 0;
      const [mxp, myp] = toLogical();

      // 右侧深海灯笼与环绕海怪演示
      const cx = 946, cy = 360;
      for (let r = 0; r < 3; r++) {
        ctx.strokeStyle = `rgba(111, 210, 230, ${0.18 - r * 0.045})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, 115 + r * 62 + Math.sin(t * 2 + r) * 6, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.save(); ctx.translate(cx, cy); drawFigurePlayer(); ctx.restore();
      const demoFoes = [
        ['crab', 0, 155], ['flea', 1.6, 145], ['urchin', 3.1, 185], ['shell', 4.6, 175],
      ];
      for (const [k, ph, rad] of demoFoes) {
        const a = t * 0.45 + ph;
        ctx.save(); ctx.translate(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
        drawFigureEnemy(k);
        ctx.restore();
      }
      text('提灯人 · 自动索敌清潮', cx, cy + 248, 18, '#9fd4eb');

      // 左侧信息卡片
      const lx = 96;
      ctx.beginPath(); ctx.roundRect(lx, 76, 184, 30, 15);
      ctx.fillStyle = 'rgba(255, 233, 184, 0.14)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255, 233, 184, 0.48)'; ctx.lineWidth = 1.5; ctx.stroke();
      text('3 分钟潮汐生存 · 斩潮王', lx + 92, 91, 14, '#ffe9b8');

      ctx.save();
      ctx.shadowColor = 'rgba(255, 233, 184, 0.24)'; ctx.shadowBlur = 24;
      text(TITLE, lx, 166, 88, '#ffe9b8', 'left');
      ctx.restore();
      text('只管走位，飞刀 / 潮环 / 光鳗自动出击', lx, 234, 22, '#cfe0f5', 'left');

      const chips = [
        ['WASD / 方向键', '海底走位避怪'],
        ['1 / 2 / 3 · 点卡', '升级三选一（支持武器进化）'],
        ['P / M', '暂停 / 静音开关'],
      ];
      chips.forEach(([k, v], i) => {
        const cy2 = 270 + i * 44;
        ctx.beginPath(); ctx.roundRect(lx, cy2, 544, 36, 9);
        ctx.fillStyle = 'rgba(18, 32, 54, 0.78)'; ctx.fill();
        ctx.strokeStyle = 'rgba(143, 179, 255, 0.22)'; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.beginPath(); ctx.roundRect(lx + 8, cy2 + 6, 148, 24, 6);
        ctx.fillStyle = 'rgba(126, 200, 255, 0.16)'; ctx.fill();
        text(k, lx + 82, cy2 + 18, 14, '#a8dcff');
        text(v, lx + 170, cy2 + 18, 15, '#d7e5f7', 'left');
      });

      // 局外护符商店条
      ctx.beginPath(); ctx.roundRect(lx, 412, 554, 72, 12);
      ctx.fillStyle = 'rgba(24, 36, 58, 0.88)'; ctx.fill();
      ctx.strokeStyle = 'rgba(242, 193, 78, 0.42)'; ctx.lineWidth = 1.6; ctx.stroke();
      text(`金币 ${meta.coins}   ·   护符 ×${meta.charms}`, lx + 20, 436, 20, '#f2c14e', 'left');
      text(`永久伤害加成 +${Math.round(meta.charms * tune.meta_gain * 100)}%`, lx + 20, 464, 15, '#9ff0c0', 'left');

      const shopBtn = { x: 430, y: 422, w: 210, h: 52 };
      const canBuy = meta.coins >= tune.meta_cost;
      const hoverShop = mxp >= shopBtn.x && mxp <= shopBtn.x + shopBtn.w && myp >= shopBtn.y && myp <= shopBtn.y + shopBtn.h;
      ctx.beginPath(); ctx.roundRect(shopBtn.x, shopBtn.y, shopBtn.w, shopBtn.h, 10);
      ctx.fillStyle = canBuy ? (hoverShop ? '#ffd166' : '#e6b440') : 'rgba(255,255,255,0.08)'; ctx.fill();
      text(`购护符 (${Math.round(tune.meta_cost)}G) [B]`, shopBtn.x + shopBtn.w / 2, shopBtn.y + shopBtn.h / 2, 16, canBuy ? '#1b1408' : '#7b8aa0');

      // 主开始按钮
      const startBtn = { x: lx, y: 540, w: 300, h: 64 };
      const hoverStart = mxp >= startBtn.x && mxp <= startBtn.x + startBtn.w && myp >= startBtn.y && myp <= startBtn.y + startBtn.h;
      ctx.save();
      ctx.shadowColor = hoverStart ? 'rgba(255, 233, 184, 0.45)' : 'rgba(255, 233, 184, 0.2)'; ctx.shadowBlur = hoverStart ? 24 : 12;
      ctx.beginPath(); ctx.roundRect(startBtn.x, startBtn.y - (hoverStart ? 2 : 0), startBtn.w, startBtn.h, 15);
      ctx.fillStyle = hoverStart ? '#fff2cf' : '#ffe2a0'; ctx.fill();
      ctx.restore();
      text('提灯入海  [Enter / 空格]', startBtn.x + startBtn.w / 2, startBtn.y - (hoverStart ? 2 : 0) + startBtn.h / 2, 21, '#0c1626');
    },
  },
  play: {
    update(dt) {
      if (pressed('KeyP') || pressed('Escape')) { scene = 'pause'; return; }
      update(dt);
    },
    draw() {
      drawBG();
      for (const e of state.enemies) drawEnemy(e);
      drawBoss(); drawFX(); drawPlayer(); drawHUD();
      if (state.phase === 'levelup') drawLevelUp();
    },
  },
  pause: {
    update() { if (pressed('KeyP') || pressed('Escape')) scene = 'play'; },
    draw() { scenes.play.draw(); clear('rgba(4,8,16,0.6)'); text('暂停', W / 2, H / 2, 48, '#fff'); text('P 继续', W / 2, H / 2 + 44, 22, '#ccc'); },
  },
  over: {
    update() { if (pressed('KeyR') || pressed('Enter')) { reset(); scene = 'play'; } },
    draw() { scenes.play.draw(); clear('rgba(10,6,6,0.66)'); text('被潮汐吞没了', W / 2, H / 2 - 40, 46, '#ff9b8f');
      text(state.gained, W / 2, H / 2 + 12, 26, '#fff'); text('R 再来一局', W / 2, H / 2 + 56, 24, '#ccc'); },
  },
  results: {
    update() { if (pressed('Enter')) { reset(); scene = 'play'; } },
    draw() { scenes.play.draw(); clear('rgba(6,10,16,0.6)'); text('潮王倒了!', W / 2, H / 2 - 40, 52, '#9ff0c0');
      text(state.gained, W / 2, H / 2 + 12, 26, '#fff'); text('Enter 再来一局', W / 2, H / 2 + 56, 24, '#ccc'); },
  },
};
function drawFigurePlayer() {
  const g = ctx.createRadialGradient(0, 0, 4, 0, 0, 46);
  g.addColorStop(0, 'rgba(255,236,180,0.55)'); g.addColorStop(1, 'rgba(255,236,180,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 46, 0, 7); ctx.fill();
  ctx.fillStyle = '#ffe9b8'; ctx.beginPath(); ctx.arc(0, 0, 11, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff7e0'; ctx.beginPath(); ctx.arc(0, -2, 6, 0, 7); ctx.fill();
  ctx.strokeStyle = '#d99a3a'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(0, 0, 11, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -11); ctx.quadraticCurveTo(3, -19, 0, -24); ctx.stroke();
}
function drawFigureEnemy(kind) {
  const fake = { kind, x: state.p.x - W / 2, y: state.p.y - H / 2, hp: 1, maxhp: 1, r: KINDS[kind].r, wob: 0 };
  drawEnemy(fake);
}
function drawFigureBoss() {
  state.boss = { x: state.p.x - W / 2, y: state.p.y - H / 2, hp: 1, maxhp: 1, r: 52 };
  drawBoss(); state.boss = null;
}

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
