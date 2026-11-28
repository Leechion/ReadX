'use strict';
// 《手忙脚乱》— 同屏双人厨房:取食材 → 切 → 下锅 → 装盘 → 送单窗。
// 1P WASD + E;2P 方向键 + L;2P 不按任何键时机器人搭档补位(按一下即接管)。
// 联网双人需要服务器,这一版只有同屏。

// ---- Built to be checked ----------------------------------------------------------------
const params = new URLSearchParams(location.search);
const tune = new Proxy({}, { get: (_, k) => CONFIG[k].value });
const STEP = 1 / 60;
const W = 1280, H = 720;
const PIXEL = false;
const FONT = 'sans-serif';
const TITLE = '手忙脚乱';
const CONTROLS = ['1P:WASD 走 · E 拿/放', '2P:方向键 走 · L 拿/放(按一下接管)'];
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

// ---- 输入 ----------------------------------------------------------------------------
const down = new Set(), hit = new Set();
const pressed = code => hit.has(code);
const tp = { x: -1, y: -1, click: false };
function toLogical(e) {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H];
}
addEventListener('keydown', e => {
  startAudio();
  if (!e.repeat) { down.add(e.code); hit.add(e.code); }
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', e => down.delete(e.code));
addEventListener('pointermove', e => { const [x, y] = toLogical(e); tp.x = x; tp.y = y; });
addEventListener('pointerdown', e => { startAudio(); const [x, y] = toLogical(e); tp.x = x; tp.y = y; tp.click = true; });
addEventListener('blur', () => down.clear());
function drawButton(btn, label, fill, hoverFill, textCol, hover) {
  const dy = hover ? -2 : 0;
  ctx.save();
  ctx.shadowColor = hover ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = hover ? 18 : 10;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(btn.x, btn.y + dy, btn.w, btn.h, 14);
  else ctx.rect(btn.x, btn.y + dy, btn.w, btn.h);
  ctx.fillStyle = hover ? hoverFill : fill;
  ctx.fill();
  ctx.restore();
  text(label, btn.x + btn.w / 2, btn.y + dy + btn.h / 2, 22, textCol);
}
function inRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// ---- Audio ----------------------------------------------------------------------------
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
function tone(freq, dur, type = 'square', vol = 0.3, delay = 0) {
  if (!audio || muted) return;
  const t = audio.ac.currentTime + delay, o = audio.ac.createOscillator(), g = audio.ac.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(audio.out); o.start(t); o.stop(t + dur);
}

// ---- 厨房布局:16×8 格,格 64px ---------------------------------------------------------
const TILE = 64, GX = 128, GY = 190;
const GW = 16, GH = 6;
const ITEMS = ['bread', 'tomato', 'fish', 'egg'];
const ITEM_CN = { bread: '面包', tomato: '番茄', fish: '小鱼', egg: '鸡蛋' };

let scene, state;
function rect(tx, ty, tw, th) { return { x: GX + tx * TILE, y: GY + ty * TILE, w: tw * TILE, h: th * TILE }; }

function reset() {
  seed = Number(params.get('seed')) || CONFIG.seed;
  let best = 0;
  try { best = Number(localStorage.getItem('kitchen_best')) || 0; } catch (e) {}
  // 两排台面夹一条走道:上排是食材箱和送单窗,下排是案板、盘子堆和四口炉灶。
  const st = [
    { id: 'bin_bread',  kind: 'bin', item: 'bread',  label: '面包箱', ...rect(1, 1, 2, 1) },
    { id: 'bin_tomato', kind: 'bin', item: 'tomato', label: '番茄箱', ...rect(4, 1, 2, 1) },
    { id: 'bin_fish',   kind: 'bin', item: 'fish',   label: '鱼箱',   ...rect(7, 1, 2, 1) },
    { id: 'bin_egg',    kind: 'bin', item: 'egg',    label: '蛋箱',   ...rect(10, 1, 2, 1) },
    { id: 'window',     kind: 'window', label: '送单窗', ...rect(13, 1, 3, 1) },
    { id: 'board0', kind: 'board', label: '案板', item: null, cutT: 0, ...rect(2, 4, 2, 1) },
    { id: 'board1', kind: 'board', label: '案板', item: null, cutT: 0, ...rect(4, 4, 2, 1) },
    { id: 'plate',  kind: 'plate', label: '盘子堆', slots: { '1': [], '2': [] }, ...rect(6, 4, 2, 1) },
    { id: 'stove0', kind: 'stove', label: '炉灶', item: null, state: 'idle', cookT: 0, ...rect(8, 4, 2, 1) },
    { id: 'stove1', kind: 'stove', label: '炉灶', item: null, state: 'idle', cookT: 0, ...rect(10, 4, 2, 1) },
    { id: 'stove2', kind: 'stove', label: '炉灶', item: null, state: 'idle', cookT: 0, ...rect(12, 4, 2, 1) },
    { id: 'stove3', kind: 'stove', label: '炉灶', item: null, state: 'idle', cookT: 0, ...rect(14, 4, 2, 1) },
  ];
  state = {
    t: 0, score: 0, best, orders: [], nextOrder: 0, orderSeq: 0, spawnT: 1,
    stations: st,
    p1: { x: GX + 2 * TILE, y: GY + 192, color: '#e07a3a', tag: '1', down: false, rev: 0, hold: null, kx: 0, ky: 0 },
    p2: { x: GX + 14 * TILE, y: GY + 192, color: '#3aa0c0', tag: '2', down: false, rev: 0, hold: null, kx: 0, ky: 0 },
    bot: true, botT: 0, botTarget: null, botWait: 0,
    smoke: [], floats: [], flash: 0, gained: '',
  };
  spawnOrder();
}

// ---- 订单 ------------------------------------------------------------------------------
function spawnOrder() {
  const s = state;
  if (s.orders.length >= tune.max_orders) return;
  const n = s.orderSeq + 1;
  const items = [];
  const kinds = Math.min(1 + Math.floor(n / tune.double_from), 2);
  for (let i = 0; i < kinds; i++) items.push(ITEMS[Math.floor(rng() * ITEMS.length)]);
  const total = Math.max(tune.order_min, tune.order_secs - (n - 1) * tune.order_ramp);
  s.orders.push({ id: ++s.orderSeq, items, timer: total, total });
  s.nextOrder = n;
  tone(700, 0.08, 'triangle', 0.14);
  events.push({ e: 'order', n: s.orderSeq, items: items.join('+') });
}
function deliver(plate) {
  const s = state;
  const key = plate.items.map(i => i.kind).sort().join(',');
  const idx = s.orders.findIndex(o => o.items.slice().sort().join(',') === key);
  if (idx < 0) { tone(170, 0.12, 'sawtooth', 0.16); events.push({ e: 'wrong', key }); return false; }
  s.orders.splice(idx, 1);
  s.score++;
  s.flash = 0.15;
  tone(660, 0.1, 'square', 0.22); tone(990, 0.2, 'square', 0.22, 0.09);
  events.push({ e: 'served', n: s.score });
  if (s.score > s.best) { s.best = s.score; try { localStorage.setItem('kitchen_best', String(s.best)); } catch (e) {} }
  return true;
}

// ---- 站点与玩家 -------------------------------------------------------------------------
function distRect(p, st) {
  const cx = Math.max(st.x, Math.min(p.x, st.x + st.w));
  const cy = Math.max(st.y, Math.min(p.y, st.y + st.h));
  return Math.hypot(p.x - cx, p.y - cy);
}
function nearStation(p) {
  let best = null, bd = 1e9;
  for (const st of state.stations) {
    const d = distRect(p, st);
    if (d < 52 && d < bd) { bd = d; best = st; }
  }
  return best;
}
function act(p, forced) { // 一名玩家“按一下”;forced 让机器人认准自己的目标台面
  if (p.down) return;
  const st = forced || nearStation(p);
  if (!st) return;
  if (st.kind === 'bin') {
    if (!p.hold) { p.hold = { kind: st.item, stage: 'raw' }; tone(520, 0.05, 'triangle', 0.12); }
  } else if (st.kind === 'board') {
    if (p.hold && p.hold.stage === 'raw' && !st.item) { st.item = p.hold; st.cutT = 0.5; p.hold = null; tone(360, 0.06, 'square', 0.12); }
    else if (p.hold && p.hold.stage === 'raw' && st.item && st.item.stage === 'cut') {
      // 一手放一手取:案板占着也能倒个手,不会两头堵死
      const t = st.item; st.item = p.hold; st.cutT = 0.5; p.hold = t;
      tone(420, 0.06, 'square', 0.12);
    }
    else if (!p.hold && st.item && st.item.stage === 'cut') { p.hold = st.item; st.item = null; tone(480, 0.05, 'triangle', 0.12); }
  } else if (st.kind === 'stove') {
    if (st.state === 'burnt') { st.state = 'idle'; st.item = null; tone(240, 0.14, 'sawtooth', 0.2); events.push({ e: 'clear' }); }
    else if (p.hold && p.hold.stage === 'cut' && !st.item) { st.item = p.hold; p.hold = null; st.state = 'cooking'; st.cookT = 0; tone(300, 0.08, 'square', 0.14); }
    else if (p.hold && p.hold.kind === 'plate' && st.item && st.state === 'cooked') { p.hold.items.push(st.item); st.item = null; st.state = 'idle'; tone(560, 0.06, 'triangle', 0.14); } // 端盘接着装
    else if (!p.hold && st.item && st.state === 'cooked') { p.hold = st.item; st.item = null; st.state = 'idle'; tone(560, 0.06, 'triangle', 0.14); }
    else if (p.hold && p.hold.stage === 'raw' && !st.item) { tone(170, 0.1, 'sawtooth', 0.14); } // 生食材不能下锅
  } else if (st.kind === 'plate') {
    const mine = st.slots[p.tag];
    if (p.hold && p.hold.stage === 'cooked') { mine.push(p.hold); p.hold = null; tone(620, 0.06, 'triangle', 0.14); }
    else if (p.hold && p.hold.kind === 'plate' && p.hold.items.length) { // 剩菜倒掉,空盘留在手里
      p.hold.items = []; tone(200, 0.14, 'sawtooth', 0.16); events.push({ e: 'dump', who: p.tag });
    }
    else if (p.hold && p.hold.kind === 'plate') { p.hold = null; tone(360, 0.05, 'square', 0.1); } // 空盘放回
    else if (!p.hold && mine.length) { p.hold = { kind: 'plate', items: mine.splice(0) }; tone(660, 0.06, 'triangle', 0.16); }
    else if (!p.hold) { p.hold = { kind: 'plate', items: [] }; tone(700, 0.05, 'triangle', 0.12); } // 拿一个干净盘子
  } else if (st.kind === 'window') {
    if (p.hold && p.hold.kind === 'plate' && p.hold.items.length) { if (deliver(p.hold)) p.hold = null; }
  }
}
function collide(p) {
  const R = 20;
  for (const st of state.stations) {
    const sx = st.x - R, sy = st.y - R, sw = st.w + R * 2, sh = st.h + R * 2;
    if (p.x > sx && p.x < sx + sw && p.y > sy && p.y < sy + sh) {
      // 推到最近的边
      const dl = p.x - sx, dr = sx + sw - p.x, dt = p.y - sy, db = sy + sh - p.y;
      const m = Math.min(dl, dr, dt, db);
      if (m === dl) p.x = sx; else if (m === dr) p.x = sx + sw;
      else if (m === dt) p.y = sy; else p.y = sy + sh;
    }
  }
  p.x = Math.max(GX + 16, Math.min(GX + GW * TILE - 16, p.x));
  p.y = Math.max(GY + 16, Math.min(GY + GH * TILE - 16, p.y));
}
function movePlayer(p, kx, ky, speed, dt) {
  if (p.down) return;
  const m = Math.hypot(kx, ky) || 1;
  p.x += kx / m * speed * dt;
  collide(p);
  p.y += ky / m * speed * dt;
  collide(p);
}
function knockDown(p, why) {
  if (p.down) return;
  p.down = true; p.rev = 0;
  tone(120, 0.3, 'sawtooth', 0.2);
  events.push({ e: 'down', who: p.tag, why });
}
function tryRevive(p, partner, pressing, dt) {
  if (!p.down) return;
  if (pressing && Math.hypot(partner.x - p.x, partner.y - p.y) < 70 && !partner.down) {
    p.rev += dt;
    if (p.rev >= tune.revive_secs) { p.down = false; p.rev = 0; tone(760, 0.12, 'square', 0.2); tone(1040, 0.16, 'square', 0.18, 0.1); events.push({ e: 'revive', who: p.tag }); }
  }
}

// ---- 机器人搭档:跑腿、切、烧、装盘、送单、救人 --------------------------------------
function botStep(dt) {
  const s = state;
  if (!s.bot) return;
  const b = s.p2;
  if (b.down) { // 机器人不会自己起来,等 1P 救
    return;
  }
  // 救人优先
  if (s.p1.down) {
    b.x += Math.sign(s.p1.x - b.x) * tune.bot_speed * dt;
    b.y += Math.sign(s.p1.y - b.y) * tune.bot_speed * dt;
    collide(b);
    if (Math.hypot(b.x - s.p1.x, b.y - s.p1.y) < 60) {
      s.p1.rev += dt;
      if (s.p1.rev >= tune.revive_secs) { s.p1.down = false; s.p1.rev = 0; tone(760, 0.12, 'square', 0.2); events.push({ e: 'revive', who: '1' }); }
    }
    return;
  }
  const target = (function () {
    s.botPush = Math.max(0, (s.botPush || 0) - dt);
    const t = botChoose(b, s.botPush > 0);
    if (t) { s.botWait = 0; return t; }
    // 干等着急了就放开礼让,免得两个人都闲着
    s.botWait = (s.botWait || 0) + dt;
    if (s.botWait > 1.2) { s.botPush = 1.5; s.botWait = 0; return botChoose(b, true); }
    return null;
  })();
  if (!target) return;
  if (distRect(b, target) < 50) { act(b, target); return; } // 站到台面边上了才动手
  let cx = target.x + target.w / 2, cy = target.y + target.h / 2;
  // 1P 占着这台面时站到另一头,别贴在人身上(不挡路)
  if (Math.hypot(cx - s.p1.x, cy - s.p1.y) < 140) cx += (b.x < s.p1.x ? -1 : 1) * (target.w / 2 + 26);
  const d = Math.hypot(b.x - cx, b.y - cy) || 1;
  b.x += (cx - b.x) / d * tune.bot_speed * dt; collide(b);
  b.y += (cy - b.y) / d * tune.bot_speed * dt; collide(b);
}
function botChoose(b, push) {
  const s = state;
  const by = k => s.stations.filter(st => st.kind === k);
  const gap = st => Math.hypot(st.x + st.w / 2 - b.x, st.y + st.h / 2 - b.y);
  const other = st => Math.hypot(st.x + st.w / 2 - s.p1.x, st.y + st.h / 2 - s.p1.y);
  // 礼让:1P 就贴在这台面边(130 内)而且比机器人近,机器人就去干别的;干等着急了(push)照样干
  const mine = st => !push && other(st) < 130 && other(st) + 20 < gap(st);
  const pick = list => list.find(st => !mine(st)) || null;
  const plateSt = by('plate')[0];
  const keyOf = list => list.map(i => i.kind).sort().join(',');
  const fits = list => list.length > 0 && s.orders.some(o => keyOf(o.items.map(k => ({ kind: k }))) === keyOf(list));
  // 盘里的料还能不能凑成某张单:能就返回还差的那一种,凑不成返回 null
  const missing = list => {
    const have = list.map(i => i.kind);
    for (const o of s.orders) {
      const need = o.items.slice(); // 不去重:双料单要两份
      let ok = true;
      for (const k of have) { const i = need.indexOf(k); if (i < 0) { ok = false; break; } need.splice(i, 1); }
      if (ok && need.length) return need[0];
    }
    return null;
  };

  if (b.hold && b.hold.kind === 'plate') {
    if (fits(b.hold.items)) return pick(by('window')); // 这盘够了 → 去送
    return pick([plateSt]);                            // 废菜倒掉 / 空盘放回
  }
  if (b.hold && b.hold.stage === 'cooked') return pick([plateSt]); // 做好的菜端去装自己的盘
  if (b.hold && b.hold.stage === 'cut') return pick(by('stove').filter(st => !st.item));
  if (b.hold && b.hold.stage === 'raw') {
    const boards = by('board');
    return pick(boards.filter(st => !st.item))
        || pick(boards.filter(st => st.item && st.item.stage === 'cut')); // 都占着就换一块切好的走
  }
  if (b.hold) return null;

  // 空着手:看自己盘里攒了什么
  const on = plateSt.slots['2'];
  if (fits(on)) return pick([plateSt]); // 凑齐了 → 端起盘子
  // 盘里还差料就先补料,不然先清掉没用的
  let want = missing(on);
  if (!want && on.length) return pick([plateSt]); // 盘里凑不成任何单:端起来倒掉
  const burnt = pick(by('stove').filter(st => st.state === 'burnt'));
  if (burnt) return burnt;
  const cooked = pick(by('stove').filter(st => st.state === 'cooked' && (!want || st.item.kind === want)));
  if (cooked) return cooked;
  const cut = pick(by('board').filter(st => st.item && st.item.stage === 'cut' && (!want || st.item.kind === want)));
  if (cut) return cut;
  const kind = want || (s.orders.length ? s.orders[0].items[0] : ITEMS[0]);
  return pick(by('bin').filter(st => st.item === kind))
      || pick(by('bin').filter(st => st.item !== kind));
}

// ---- 场景 -----------------------------------------------------------------------------
const scenes = {
  figures: {
    update(dt) { state.t += dt; },
    draw() {
      drawKitchen();
      const c = '#f7ead2';
      const cols = [160, 310, 460, 610, 760, 910, 1060];
      // 上排:两个人、倒下的人、四种食材
      drawCook(cols[0], 250, '#e07a3a', '1', false, 0);  text('1P·暖橙', cols[0], 330, 22, c);
      drawCook(cols[1], 250, '#3aa0c0', '2', false, 0);  text('2P·青蓝', cols[1], 330, 22, c);
      drawCook(cols[2], 250, '#3aa0c0', '2', true, 0.6); text('倒下·待救', cols[2], 330, 22, c);
      ITEMS.forEach((k, i) => { drawFood(k, cols[3 + i], 240, 52, 'raw'); text(ITEM_CN[k], cols[3 + i], 330, 20, c); });
      // 下排:切好、出锅、盘子、两口炉灶、案板、订单票
      drawFood('bread', cols[0], 470, 52, 'cut');    text('切好', cols[0], 560, 20, c);
      drawFood('bread', cols[1], 470, 52, 'cooked'); text('出锅', cols[1], 560, 20, c);
      drawPlate(cols[2], 470, 46, [{ kind: 'bread', stage: 'cooked' }]); text('盘子(装好)', cols[2], 560, 20, c);
      drawStoveArt(cols[3] - 64, 440, 128, 64, 'cooking', 0.4); text('炉灶·在烧', cols[3], 560, 20, c);
      drawStoveArt(cols[4] - 64, 440, 128, 64, 'burnt', 0);     text('炉灶·糊了', cols[4], 560, 20, c);
      drawBoard(cols[5] - 64, 440, 128, 64, { kind: 'fish', stage: 'cut' }, 0); text('案板', cols[5], 560, 20, c);
      drawTicket(cols[6] - 58, 430, { items: ['bread', 'fish'], timer: 12, total: 26 }, 0); text('订单票', cols[6], 560, 20, c);
    },
  },
  title: {
    update() {
      const btn = { x: W / 2 - 170, y: 522, w: 340, h: 60 };
      const hover = inRect(tp.x, tp.y, btn);
      canvas.style.cursor = hover ? 'pointer' : 'default';
      if (pressed('Enter') || pressed('Space') || (tp.click && hover)) {
        tp.click = false; canvas.style.cursor = 'default'; scene = 'play'; return;
      }
      tp.click = false;
    },
    draw() {
      drawKitchen();
      ctx.fillStyle = 'rgba(40,24,12,0.5)'; ctx.fillRect(0, 0, W, H);
      text(TITLE, W / 2, 170, 88, '#fff0d8');
      text('两人一个跑一个递,订单催着', W / 2, 248, 28, '#f0c9a0');
      CONTROLS.forEach((cn, i) => text(cn, W / 2, 320 + i * 38, 26, '#ffd9b0'));
      text('2P 不按键时,机器人搭档会补位', W / 2, 420, 22, '#e8b48a');
      if (state.best > 0) text(`最佳 ${state.best} 单`, W / 2, 476, 26, '#ffca7a');
      const btn = { x: W / 2 - 170, y: 522, w: 340, h: 60 };
      drawButton(btn, '开张做菜  [Enter / 空格]', '#e07a3a', '#f29456', '#fff8ee', inRect(tp.x, tp.y, btn));
    },
  },
  play: {
    update(dt) {
      if (pressed('KeyP') || pressed('Escape')) { scene = 'pause'; return; }
      const s = state;
      s.t += dt;
      if (s.flash > 0) s.flash -= dt;
      // 2P 接管
      if (s.bot) {
        for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyL']) {
          if (down.has(k) || pressed(k)) { s.bot = false; s.p2.x = GX + 14 * TILE; s.p2.y = GY + 192; events.push({ e: 'join', who: '2' }); break; }
        }
      }
      // 1P
      const k1x = (down.has('KeyD') ? 1 : 0) - (down.has('KeyA') ? 1 : 0);
      const k1y = (down.has('KeyS') ? 1 : 0) - (down.has('KeyW') ? 1 : 0);
      movePlayer(s.p1, k1x, k1y, tune.move_speed, dt);
      if (pressed('KeyE')) act(s.p1);
      // 2P
      if (!s.bot) {
        const k2x = (down.has('ArrowRight') ? 1 : 0) - (down.has('ArrowLeft') ? 1 : 0);
        const k2y = (down.has('ArrowDown') ? 1 : 0) - (down.has('ArrowUp') ? 1 : 0);
        movePlayer(s.p2, k2x, k2y, tune.move_speed, dt);
        if (pressed('KeyL')) act(s.p2);
      } else botStep(dt);
      // 救人:1P 按住 E 救 2P,2P 按住 L 救 1P
      tryRevive(s.p2, s.p1, down.has('KeyE'), dt);
      tryRevive(s.p1, s.p2, down.has('KeyL'), dt);
      // 站点计时
      for (const st of s.stations) {
        if (st.kind === 'board' && st.item && st.item.stage === 'raw') {
          st.cutT -= dt;
          if (st.cutT <= 0) { st.item.stage = 'cut'; tone(420, 0.06, 'square', 0.1); }
        }
        if (st.kind === 'stove') {
          if (st.state === 'cooking') {
            st.cookT += dt;
            if (st.cookT >= tune.cook_time) { st.state = 'cooked'; st.item.stage = 'cooked'; st.burnT = 0; tone(880, 0.1, 'triangle', 0.16); events.push({ e: 'cooked' }); }
          } else if (st.state === 'cooked') {
            st.burnT = (st.burnT || 0) + dt;
            if (st.burnT >= tune.burn_time) { st.state = 'burnt'; tone(150, 0.3, 'sawtooth', 0.2); events.push({ e: 'burnt' }); }
          }
        }
      }
      // 糊锅的烟熏倒站在烟里的人
      s.smoke = [];
      for (const st of s.stations) if (st.kind === 'stove' && st.state === 'burnt') s.smoke.push({ x: st.x + st.w / 2, y: st.y + st.h / 2 });
      for (const p of [s.p1, s.p2]) {
        if (p.down) continue;
        for (const sm of s.smoke) {
          if (Math.hypot(p.x - sm.x, p.y - sm.y) < 66) {
            p.smokeT = (p.smokeT || 0) + dt;
            if (p.smokeT > 1.3) { p.smokeT = 0; knockDown(p, 'smoke'); }
          } else p.smokeT = 0;
        }
        if (s.smoke.length === 0) p.smokeT = 0;
      }
      // 两人都倒 → 结束
      if (s.p1.down && s.p2.down) {
        s.gained = `做成了 ${s.score} 单${s.score >= s.best && s.score > 0 ? ' · 新纪录!' : ''}`;
        events.push({ e: 'gameover', score: s.score });
        scene = 'over';
        return;
      }
      // 订单计时与新单
      for (const o of s.orders) o.timer -= dt;
      const before = s.orders.length;
      s.orders = s.orders.filter(o => o.timer > 0);
      if (s.orders.length < before) { tone(200, 0.15, 'sawtooth', 0.14); events.push({ e: 'expired' }); }
      s.spawnT -= dt;
      if (s.spawnT <= 0) { s.spawnT = 4; spawnOrder(); }
    },
    draw() { drawWorld(); },
  },
  pause: {
    update() { if (pressed('KeyP') || pressed('Escape')) scene = 'play'; },
    draw() { drawWorld(); ctx.fillStyle = 'rgba(30,16,8,0.55)'; ctx.fillRect(0, 0, W, H); text('暂停', W / 2, H / 2, 52, '#fff0d8'); },
  },
  over: {
    update() {
      const btn = { x: W / 2 - 170, y: 432, w: 340, h: 58 };
      const hover = inRect(tp.x, tp.y, btn);
      canvas.style.cursor = hover ? 'pointer' : 'default';
      if (pressed('Enter') || pressed('Space') || pressed('KeyR') || (tp.click && hover)) {
        tp.click = false; canvas.style.cursor = 'default'; reset(); scene = 'play'; return;
      }
      tp.click = false;
    },
    draw() {
      drawWorld();
      ctx.fillStyle = 'rgba(30,16,8,0.62)'; ctx.fillRect(0, 0, W, H);
      text('两个人都倒了', W / 2, 240, 56, '#fff0d8');
      text(state.gained, W / 2, 325, 34, '#ffca7a');
      text(`最佳 ${state.best} 单`, W / 2, 380, 26, '#f0c9a0');
      const btn = { x: W / 2 - 170, y: 432, w: 340, h: 58 };
      drawButton(btn, '再开张  [Enter / 空格]', '#e07a3a', '#f29456', '#fff8ee', inRect(tp.x, tp.y, btn));
    },
  },
};

// ---- 绘制:暖色小厨房 --------------------------------------------------------------------
function drawKitchen() {
  clear('#6a4a30');
  // 后墙:订单票贴在这面墙上
  const wall = ctx.createLinearGradient(0, 0, 0, GY - 20);
  wall.addColorStop(0, '#7b5b3c'); wall.addColorStop(1, '#6b4c31');
  ctx.fillStyle = wall; ctx.fillRect(0, 0, W, GY - 20);
  ctx.fillStyle = 'rgba(40,24,12,0.28)'; ctx.fillRect(0, GY - 24, W, 6);
  ctx.strokeStyle = 'rgba(255,238,210,0.10)'; ctx.lineWidth = 2;
  for (let x = 0; x < W; x += 96) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, GY - 24); ctx.stroke(); }
  // 木地板格
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#8a6240' : '#825c3c';
      ctx.fillRect(GX + x * TILE, GY + y * TILE, TILE, TILE);
      ctx.strokeStyle = 'rgba(40,24,12,0.25)'; ctx.lineWidth = 1;
      ctx.strokeRect(GX + x * TILE + 0.5, GY + y * TILE + 0.5, TILE - 1, TILE - 1);
    }
  }
  ctx.strokeStyle = '#4a3020'; ctx.lineWidth = 6;
  ctx.strokeRect(GX - 3, GY - 3, GW * TILE + 6, GH * TILE + 6);
}
function drawCounter(st, t) { // 台面
  ctx.fillStyle = '#efe3cc';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(st.x, st.y, st.w, st.h, 10); else ctx.rect(st.x, st.y, st.w, st.h);
  ctx.fill();
  ctx.fillStyle = '#dbcbb0'; ctx.fillRect(st.x + 4, st.y + st.h - 10, st.w - 8, 6);
  ctx.strokeStyle = '#b8a184'; ctx.lineWidth = 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(st.x, st.y, st.w, st.h, 10); else ctx.rect(st.x, st.y, st.w, st.h);
  ctx.stroke();
}
function drawFood(kind, x, y, s, stage) { // 食材:手绘小图形,不用 emoji
  ctx.save(); ctx.translate(x, y);
  const sc = s / 46; ctx.scale(sc, sc);
  if (kind === 'bread') {
    ctx.fillStyle = '#d9a25c';
    ctx.beginPath(); ctx.ellipse(0, 0, 22, 14, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = '#a06a2c'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.strokeStyle = '#f0cf9a'; ctx.lineWidth = 3;
    for (const dx of [-10, 0, 10]) { ctx.beginPath(); ctx.moveTo(dx - 3, -8); ctx.lineTo(dx + 3, 6); ctx.stroke(); }
  } else if (kind === 'tomato') {
    ctx.fillStyle = '#d8483c';
    ctx.beginPath(); ctx.arc(0, 2, 15, 0, 7); ctx.fill();
    ctx.strokeStyle = '#94302a'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#4a8a3a';
    ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(7, -7); ctx.lineTo(0, -4); ctx.lineTo(-7, -7); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#f09080'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(-5, -2, 4, 3.6, 5.2); ctx.stroke();
  } else if (kind === 'fish') {
    ctx.fillStyle = '#7aa8c8';
    ctx.beginPath(); ctx.ellipse(-2, 0, 18, 10, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(24, -9); ctx.lineTo(24, 9); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#3a6078'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#243848'; ctx.beginPath(); ctx.arc(-10, -2, 2.2, 0, 7); ctx.fill();
    ctx.strokeStyle = '#4a7a98'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 7, -1.2, 1.2); ctx.stroke();
  } else { // egg
    ctx.fillStyle = '#f6efdd';
    ctx.beginPath(); ctx.ellipse(0, 0, 18, 14, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = '#cbbfa4'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#f0c040'; ctx.beginPath(); ctx.arc(2, 1, 7, 0, 7); ctx.fill();
    ctx.strokeStyle = '#c89820'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  if (stage === 'cooked') { // 出锅:焦边 + 热气
    ctx.strokeStyle = 'rgba(110,56,18,0.65)'; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.arc(0, 2, 20, 3.3, 6.1); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.62)'; ctx.lineWidth = 2.5;
    for (const dx of [-9, 0, 9]) {
      ctx.beginPath(); ctx.moveTo(dx, -16); ctx.quadraticCurveTo(dx + 5, -24, dx, -32); ctx.stroke();
    }
  } else if (stage === 'cut') { // 切好:几道刀口
    for (let i = -1; i <= 1; i++) {
      ctx.strokeStyle = 'rgba(96,58,24,0.85)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(i * 9 - 2, -11); ctx.lineTo(i * 9 + 2, 11); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,252,240,0.9)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(i * 9 - 3, -11); ctx.lineTo(i * 9 + 1, 11); ctx.stroke();
    }
  }
  ctx.restore();
}
function drawTag(cx, cy, color, tag) { // 头顶同款小三角记号,放在盘子边上标明是谁的
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx + 7, cy + 5); ctx.lineTo(cx - 7, cy + 5); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#3a2a20'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#1a120c'; ctx.font = `bold 10px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(tag, cx, cy + 1);
}
function drawPlate(x, y, r, items) { // 白圆盘 + 金边
  ctx.fillStyle = '#f4f0e6'; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  ctx.strokeStyle = '#d8b45a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r - 2, 0, 7); ctx.stroke();
  ctx.strokeStyle = '#e8e0d0'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r * 0.66, 0, 7); ctx.stroke();
  items.forEach((it, i) => drawFood(it.kind, x + (i - (items.length - 1) / 2) * r * 0.8, y, r * 0.75, it.stage));
}
function drawStoveArt(x, y, w, h, stateName, cookT) { // 炉灶:金属灶眼 + 蓝火苗 / 焦黑冒烟
  const bx = x + w / 2, by = y + h * 0.56, rx = w * 0.33, ry = h * 0.27;
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#aaa29b'); g.addColorStop(1, '#7a7169');
  ctx.fillStyle = g;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 8); else ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.strokeStyle = '#554d47'; ctx.lineWidth = 2; ctx.stroke();
  // 灶眼
  ctx.fillStyle = '#3a332e';
  ctx.beginPath(); ctx.ellipse(bx, by, rx, ry, 0, 0, 7); ctx.fill();
  ctx.strokeStyle = '#c0b8b0'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.ellipse(bx, by, rx, ry, 0, 0, 7); ctx.stroke();
  // 支架:三条横挡
  ctx.strokeStyle = '#6c645d'; ctx.lineWidth = 3;
  for (const k of [-0.5, 0, 0.5]) {
    ctx.beginPath(); ctx.moveTo(bx - rx * 0.92, by + k * ry * 0.9); ctx.lineTo(bx + rx * 0.92, by + k * ry * 0.9); ctx.stroke();
  }
  if (stateName === 'cooking' || stateName === 'cooked') { // 蓝火苗
    for (let i = -1; i <= 1; i++) {
      const fx = bx + i * 26, fh = 16 + Math.sin(performance.now() / 120 + i) * 5;
      ctx.fillStyle = '#5ab0f0';
      ctx.beginPath(); ctx.moveTo(fx - 7, by + 4); ctx.quadraticCurveTo(fx, by + 4 - fh, fx + 7, by + 4); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#bfe8ff';
      ctx.beginPath(); ctx.moveTo(fx - 3, by + 4); ctx.quadraticCurveTo(fx, by + 4 - fh * 0.55, fx + 3, by + 4); ctx.closePath(); ctx.fill();
    }
  }
  if (stateName === 'burnt') { // 焦黑冒烟
    ctx.fillStyle = '#2a2420';
    ctx.beginPath(); ctx.ellipse(bx, by - 2, rx * 0.7, ry * 0.8, 0, 0, 7); ctx.fill();
    for (let i = 0; i < 3; i++) {
      const t = performance.now() / 900 + i * 0.7;
      ctx.fillStyle = `rgba(50,44,40,${0.35 - (t % 1) * 0.25})`;
      ctx.beginPath(); ctx.arc(bx + Math.sin(t * 5) * 12, y + h * 0.3 - (t % 1) * 34, 12 + (t % 1) * 12, 0, 7); ctx.fill();
    }
  }
  if (stateName === 'cooking' && cookT > 0) { // 进度细条
    ctx.fillStyle = '#3a2a20'; ctx.fillRect(x + 8, y + h - 8, w - 16, 4);
    ctx.fillStyle = '#7ad07a'; ctx.fillRect(x + 8, y + h - 8, (w - 16) * Math.min(1, cookT), 4);
  }
}
function drawBoard(x, y, w, h, item, cutT) {
  ctx.fillStyle = '#c9a469';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 8); else ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.strokeStyle = '#8f6c3a'; ctx.lineWidth = 2; ctx.stroke();
  for (let i = 0; i < 4; i++) { ctx.strokeStyle = 'rgba(120,88,44,0.35)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 8, y + 12 + i * 13); ctx.lineTo(x + w - 8, y + 12 + i * 13); ctx.stroke(); }
  if (item) drawFood(item.kind, x + w / 2, y + h / 2, 40, item.stage);
}
function drawTicket(x, y, o, i) { // 墙上订单票:纸条带红边 + 限时条
  const w = 116, h = 78;
  ctx.fillStyle = '#f6efdc';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#b03a2a'; ctx.lineWidth = 3; ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  o.items.forEach((k, j) => drawFood(k, x + 26 + j * 34, y + 30, 34, 'raw'));
  const p = Math.max(0, Math.min(1, o.timer / o.total));
  ctx.fillStyle = '#cbbfa4'; ctx.fillRect(x + 8, y + h - 16, w - 16, 7);
  ctx.fillStyle = p > 0.45 ? '#6ab04a' : p > 0.2 ? '#e0952c' : '#d04a2a';
  ctx.fillRect(x + 8, y + h - 16, (w - 16) * p, 7);
}
function drawCook(x, y, color, tag, isDown, rev) { // 小厨师:圆头 + 围裙 + 头顶同色记号
  ctx.save(); ctx.translate(x, y);
  if (isDown) ctx.rotate(0.9);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(0, 4, 15, 18, 0, 0, 7); ctx.fill();          // 身体
  ctx.fillStyle = '#f6efdd';
  ctx.beginPath(); ctx.ellipse(0, 8, 10, 12, 0, 0, 7); ctx.fill();          // 围裙
  ctx.fillStyle = '#f0d0a8';
  ctx.beginPath(); ctx.arc(0, -18, 10, 0, 7); ctx.fill();                   // 头
  ctx.fillStyle = '#fff6e6';
  ctx.beginPath(); ctx.ellipse(0, -26, 11, 7, 0, Math.PI, 0); ctx.fill();   // 厨师帽
  ctx.fillStyle = '#3a2a20';
  ctx.beginPath(); ctx.arc(-3.5, -18, 1.8, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(3.5, -18, 1.8, 0, 7); ctx.fill();
  // 头顶记号
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(0, -52); ctx.lineTo(8, -40); ctx.lineTo(-8, -40); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#3a2a20'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#1a120c'; ctx.font = `bold 11px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(tag, 0, -46);
  if (isDown && rev > 0) { // 救人进度环
    ctx.strokeStyle = '#7ad07a'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, 0, 30, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, rev / tune.revive_secs)); ctx.stroke();
  }
  ctx.restore();
}
function drawHeld(p) { // 手上的东西画在号码记号上方,两样都看得见
  if (!p.hold) return;
  if (p.hold.kind === 'plate') drawPlate(p.x, p.y - 72, 16, p.hold.items);
  else drawFood(p.hold.kind, p.x, p.y - 72, 22, p.hold.stage);
}
function drawWorld() {
  const s = state;
  drawKitchen();
  for (const st of s.stations) {
    if (st.kind === 'stove') drawStoveArt(st.x, st.y, st.w, st.h, st.state, st.state === 'cooking' ? st.cookT / tune.cook_time : 0);
    else if (st.kind === 'board') drawBoard(st.x, st.y, st.w, st.h, st.item, st.cutT);
    else {
      drawCounter(st, s.t);
      if (st.kind === 'bin') { drawFood(st.item, st.x + st.w / 2, st.y + st.h / 2, 46, 'raw'); }
      else if (st.kind === 'plate') { // 两个盘子,各归各的
        for (const tg of ['1', '2']) {
          const px = st.x + st.w * (tg === '1' ? 0.32 : 0.68), py = st.y + st.h * 0.5;
          drawPlate(px, py, 22, st.slots[tg]);
          drawTag(px + 18, py - 18, tg === '1' ? '#e07a3a' : '#3aa0c0', tg);
        }
      }
      else if (st.kind === 'window') { // 送单窗:带窗口的台面
        ctx.fillStyle = '#3a2a20'; ctx.fillRect(st.x + 16, st.y + 14, st.w - 32, st.h - 28);
        ctx.fillStyle = '#f0d8b0'; ctx.fillRect(st.x + 22, st.y + 20, st.w - 44, st.h - 40);
      }
    }
    text(st.label, st.x + st.w / 2, st.y + st.h + 14, 15, 'rgba(255,240,216,0.85)');
  }
  // 墙上订单票
  s.orders.forEach((o, i) => drawTicket(GX + i * 128, 30, o, i));
  // 玩家
  drawCook(s.p1.x, s.p1.y, s.p1.color, '1', s.p1.down, s.p1.rev);
  drawHeld(s.p1);
  drawCook(s.p2.x, s.p2.y, s.p2.color, s.bot ? '机' : '2', s.p2.down, s.p2.rev);
  drawHeld(s.p2);
  // HUD
  text(`做成 ${s.score} 单`, W - 40, 60, 28, '#fff0d8', 'right');
  text(`最佳 ${s.best}`, W - 40, 92, 18, '#e8b48a', 'right');
  text(`剩 ${s.orders.length} 张单`, W - 40, 118, 18, '#f0c9a0', 'right');
  if (s.flash > 0) { ctx.fillStyle = `rgba(255,240,200,${s.flash})`; ctx.fillRect(0, 0, W, H); }
}

// ---- Loop: fixed step, frame time clamped ---------------------------------------------
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

// ---- What a check can read and drive ---------------------------------------------------
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
