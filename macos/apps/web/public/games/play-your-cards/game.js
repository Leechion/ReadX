'use strict';
// 一回合制卡牌肉鸽:意图明牌、按出手顺序逐张结算、战后三选一+砍牌。
// 手牌既可拖到目标出,也可点选再点目标(脚本检查用后者)。

// ---- Built to be checked ----------------------------------------------------------------
const params = new URLSearchParams(location.search);
const tune = new Proxy({}, { get: (_, k) => CONFIG[k].value }); // live: tune.energy_base is CONFIG.energy_base.value
const STEP = 1 / 60;            // simulation step in seconds; motion is per second, never per frame
const W = 1280, H = 720;        // logical size
const PIXEL = false;
const FONT = 'sans-serif';
const TITLE = '出牌吧!';
const CONTROLS = ['鼠标:点选手牌再点目标(或拖过去)出牌', '点 结束回合 · 1/2/3 选奖励牌 · X 砍一张牌', 'Esc 跳过奖励 · Enter 开始 · M 静音'];
const clock = window.GAME_CLOCK || { now: () => performance.now() / 1000 };
const CHEAP = params.get('render') === 'cheap';
let seed;
function rng() { // mulberry32; every gameplay random call reads this, never Math.random
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = arr => arr[Math.floor(rng() * arr.length)];
const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
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
function rr(x, y, w, h, rad, fill, stroke, lw = 3) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, rad);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}
function star(cx, cy, r, c) { // 手绘五角星(伤害标记/攻击意图)
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? r * 0.45 : r;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath(); ctx.fillStyle = c; ctx.fill();
}
function shield(cx, cy, r, c) { // 手绘盾形(格挡意图/数值)
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r * 0.9); ctx.lineTo(cx + r, cy - r * 0.9);
  ctx.lineTo(cx + r, cy + r * 0.15); ctx.quadraticCurveTo(cx, cy + r * 1.15, cx - r, cy + r * 0.15);
  ctx.closePath(); ctx.fillStyle = c; ctx.fill();
}
function upArrow(cx, cy, r, c) { // 手绘上箭头(强化/力量意图)
  ctx.beginPath();
  ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r * 0.85, cy + r * 0.1); ctx.lineTo(cx + r * 0.32, cy + r * 0.1);
  ctx.lineTo(cx + r * 0.32, cy + r); ctx.lineTo(cx - r * 0.32, cy + r); ctx.lineTo(cx - r * 0.32, cy + r * 0.1);
  ctx.lineTo(cx - r * 0.85, cy + r * 0.1);
  ctx.closePath(); ctx.fillStyle = c; ctx.fill();
}

// ---- Input: keys by position + mouse (click / drag) -------------------------------------
const down = new Set(), hit = new Set();
const pressed = code => hit.has(code);
const mouse = { x: -1, y: -1, down: false, clicked: false, dx: 0, dy: 0 };
function toGame(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
}
addEventListener('keydown', e => {
  startAudio();
  if (!e.repeat) { down.add(e.code); hit.add(e.code); }
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', e => down.delete(e.code));
addEventListener('blur', () => down.clear());
addEventListener('pointerdown', e => {
  startAudio();
  const p = toGame(e);
  mouse.x = p.x; mouse.y = p.y; mouse.down = true; mouse.clicked = false; mouse.dx = p.x; mouse.dy = p.y;
});
addEventListener('pointermove', e => {
  const p = toGame(e);
  if (mouse.down) { mouse.x = p.x; mouse.y = p.y; }
  else { const q = toGame(e); mouse.x = q.x; mouse.y = q.y; }
});
addEventListener('pointerup', e => {
  const p = toGame(e);
  mouse.x = p.x; mouse.y = p.y;
  if (mouse.down) {
    mouse.clicked = true;
    mouse.howFar = Math.hypot(p.x - mouse.dx, p.y - mouse.dy); // 拖动>40px 按落点出牌,否则算点选
    mouse.down = false;
  }
});

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

// ---- 牌与敌人定义(数值全部来自 config.js 的 tune)--------------------------------------
// kind: attack 需点目标 · block 自手 · all 打全体 · buff 我方全体 · weak 需点目标 · shiv 需点目标
const CARDS = {
  strike: { name: '打击', cost: () => 1, kind: 'attack', dmg: () => tune.strike_dmg, frame: 'atk',
    kw: '对一个敌人造成 {d} 点伤害。', play: (s, tgt) => dealDmg(s, tgt, tune.strike_dmg) },
  defend: { name: '防御', cost: () => 1, kind: 'block', blk: () => tune.defend_block, frame: 'blk',
    kw: '获得 {b} 点格挡,回合末消失。', play: s => addBlock(s, tune.defend_block) },
  cleave: { name: '横扫', cost: () => tune.cleave_cost, kind: 'all', frame: 'atk',
    kw: '对所有敌人各造成一点小伤害。', play: s => s.foes.forEach(e => e.hp > 0 && dealDmg(s, e, tune.cleave_dmg)) },
  ironwall: { name: '铁壁', cost: () => tune.ironwall_cost, kind: 'block', frame: 'blk',
    kw: '获得一大块格挡,回合末消失。', play: s => addBlock(s, tune.ironwall_block) },
  double: { name: '二连', cost: () => tune.double_cost, kind: 'attack', frame: 'atk',
    kw: '对同一敌人连打两下。', play: (s, tgt) => { dealDmg(s, tgt, tune.double_per); dealDmg(s, tgt, tune.double_per); } },
  bash: { name: '重击', cost: () => tune.bash_cost, kind: 'attack', frame: 'atk',
    kw: '花 2 能量,一击狠的。', play: (s, tgt) => dealDmg(s, tgt, tune.bash_dmg) },
  curse: { name: '诅咒', cost: () => tune.curse_cost, kind: 'weak', frame: 'sp',
    kw: '目标下回合力量 -{w}(意图数字跟着变小)。', play: (s, tgt) => { tgt.weak = (tgt.weak || 0) + tune.curse_amt; pop(s, tgt.x, tgt.y - 96, '-' + tune.curse_amt + ' 力量', '#b48cff'); tone(300, 0.14, 'triangle', 0.22); } },
  shiv: { name: '飞刀', cost: () => tune.shiv_cost, kind: 'attack', frame: 'atk',
    kw: '0 费,扎一下就走。', play: (s, tgt) => dealDmg(s, tgt, tune.shiv_dmg) },
  rally: { name: '鼓舞', cost: () => tune.rally_cost, kind: 'buff', frame: 'sp',
    kw: '本回合你的每张攻击牌 +{p} 伤害。', play: s => { s.rally = (s.rally || 0) + tune.rally_amt; pop(s, W / 2, 470, '+' + tune.rally_amt + ' 力量', '#ffd76a'); tone(520, 0.12, 'triangle', 0.25); } },
};
const FRAMES = { atk: '#d84b4b', blk: '#3f8fd6', sp: '#b48cff' }; // 三种边框:攻击红 / 格挡蓝 / 技能紫
const CARD_KEYS = ['cleave', 'ironwall', 'double', 'bash', 'curse', 'shiv', 'rally'];

// 意图:atk=每段伤害 ×段数 · blk=自带格挡 · up=强化 · call=召唤 · sup=给同伴加力量。
// 意图数字先把玩家现有格挡扣掉(明牌=含你的格挡)。
function mkSwarm(hp, atk, hits) { return { kind: 'swarm', name: '疾行者', hp, maxhp: hp, atk, hits, intent: 'atk', w: 150, h: 150, hue: 145 }; }
function mkBrute(hp, atk) { return { kind: 'brute', name: '岩背', hp, maxhp: hp, atk, hits: 1, intent: 'atk', w: 240, h: 230, hue: 32, brace: 0 }; }
function mkSupport(hp, buff, atk) { return { kind: 'support', name: '唤灵者', hp, maxhp: hp, buff, atk, intent: 'sup', w: 170, h: 190, hue: 265 }; }
function mkWall(hp, blk, atk) { return { kind: 'wall', name: '盾墙', hp, maxhp: hp, blk, atk, intent: 'blk', w: 210, h: 195, hue: 205, block: 0 }; }
function mkBoss(hp) { return { kind: 'boss', name: '深渊主祭', hp, maxhp: hp, atk: tune.boss_slam, power: 0, hits: 1, intent: 'atk', phase: 0, w: 290, h: 270, hue: 12 }; }
function mkAdd(hp, atk) { return { kind: 'add', name: '祭俑', hp, maxhp: hp, atk, hits: 1, intent: 'atk', w: 120, h: 120, hue: 45, y: 240, flash: 0, dead: 0, weak: 0, block: 0 }; }

const LAYOUTS = {
  fight1: s => ({ foes: [mkSwarm(tune.swarm_a_hp, tune.swarm_a_atk, tune.swarm_a_hits), mkSwarm(tune.swarm_a_hp, tune.swarm_a_atk, tune.swarm_a_hits)] }),
  fight2: s => ({ foes: [mkBrute(tune.brute_hp, tune.brute_atk), mkSwarm(tune.swarm_a_hp, tune.swarm_a_atk, tune.swarm_a_hits)] }),
  fight3: s => ({ foes: [mkSwarm(tune.swarm_a_hp, tune.swarm_a_atk, tune.swarm_a_hits), mkSwarm(tune.swarm_a_hp, tune.swarm_a_atk, tune.swarm_a_hits), mkSupport(tune.support_hp, tune.support_buff, tune.support_atk)] }),
  elite: s => ({ foes: [mkWall(tune.elite_wall_hp, tune.elite_wall_block, tune.elite_wall_atk), mkSwarm(tune.elite_swarm_hp, tune.elite_swarm_atk, 2), mkSwarm(tune.elite_swarm_hp, tune.elite_swarm_atk, 2)] }),
  boss: s => ({ foes: [mkBoss(tune.boss_hp)] }),
};

// 分层小地图:3 战 + 精英 + 休息 + Boss,线性一列,节点可点。
function buildMap() {
  const kinds = [
    { key: 'fight1', label: '战斗', x: 130 }, { key: 'fight2', label: '战斗', x: 355 },
    { key: 'fight3', label: '战斗', x: 580 }, { key: 'elite', label: '精英', x: 805 },
    { key: 'rest', label: '休息', x: 1030 }, { key: 'boss', label: 'Boss', x: 1200 },
  ];
  return kinds.map((n, i) => ({ ...n, y: 340 + ((i % 2) ? 100 : -60), done: false }));
}

// ---- Scenes -----------------------------------------------------------------------------
let scene, state;
function newRun() {
  state.deck = [{ id: 'strike' }, { id: 'strike' }, { id: 'strike' }, { id: 'strike' }, { id: 'defend' }, { id: 'defend' }, { id: 'defend' }, { id: 'cleave' }]; // 小起手:4 打击 + 3 防御 + 1 横扫
  state.gold = 0; state.map = buildMap(); state.node = 0;
  state.score = 0; state.kills = 0; state.gained = ''; state.gainedRest = 0;
  state.hpMax = tune.player_hp; state.hp = state.hpMax; state.energyUp = 0; state.deckUid = 0;
  state.reward = null; state.culling = false; state.nodeKey = null; state.nodeName = null;
}
function reset() {
  seed = Number(params.get('seed')) || CONFIG.seed;
  state = { t: 0, score: 0, gained: '' };
  events.length = 0;
  newRun();
}
function enterFight(key) {
  const lay = LAYOUTS[key]();
  state.foes = lay.foes;
  state.bossKey = key === 'boss'; state.nodeKey = key;
  layoutFoes(state.foes);
  state.block = 0; state.rally = 0; state.flyCount = 0; state.str = 0; // HP 不随开打回满:肉鸽的本钱就是这管血
  state.draw = []; state.hand = []; state.discard = [];
  state.turn = 1; state.energy = tune.energy_base + state.energyUp;
  state.selected = -1; state.resolving = false; state.over = null;
  state.shake = 0; state.pops = []; state.flies = []; state.booms = [];
  reshuffleDraw(); rollIntents(state); drawHand();
  tone(190, 0.18, 'triangle', 0.3);
  events.push({ e: 'fight', key });
}

// ---- 战斗核心 ----------------------------------------------------------------------------
function layoutFoes(foes) {
  const alive = foes.filter(e => e.hp > 0);
  const n = alive.length, band = 1080, x0 = 100;
  alive.forEach((e, i) => {
    e.x = n === 1 ? W / 2 + 120 : x0 + band * (i + 0.5) / n;
    e.y = 300; // 站位行:drawFoe/foeAt 都读 e.y,不设就是 NaN,敌人会整排隐形
  });
}
function reshuffleDraw() {
  state.draw = state.deck.map((c, i) => ({ ...c, uid: state.deckUid = (state.deckUid || 0) + 1 }));
  for (let i = state.draw.length - 1; i > 0; i--) { // Fisher-Yates,走种子 rng
    const j = Math.floor(rng() * (i + 1)); [state.draw[i], state.draw[j]] = [state.draw[j], state.draw[i]];
  }
}
function drawHand() {
  const need = tune.hand_size - state.hand.length;
  for (let k = 0; k < need; k++) {
    if (!state.draw.length) { state.draw = state.discard; state.discard = []; reshuffleKeepOrder(); }
    if (!state.draw.length) break;
    state.hand.push(state.draw.pop());
  }
  layoutHand();
}
function reshuffleKeepOrder() {
  for (let i = state.draw.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [state.draw[i], state.draw[j]] = [state.draw[j], state.draw[i]]; }
}
function endTurnDiscard() { state.discard.push(...state.hand); state.hand = []; layoutHand(); }
function layoutHand() {
  const n = state.hand.length, cw = 118, gap = 10, x0 = (W - (n * cw + (n - 1) * gap)) / 2;
  state.hand.forEach((c, i) => { c.x = x0 + i * (cw + gap) + cw / 2; c.y = 628; });
}
function intentDmg(s, e) { return Math.max(0, e.atk + (e.power || 0) - (e.weak || 0)); }
function rollIntents(s) { // s = state:重掷全体敌人下回合的意图
  for (const e of s.foes) {
    if (e.hp <= 0) continue;
    if (e.kind === 'swarm' || e.kind === 'add') e.intent = 'atk';
    else if (e.kind === 'brute') { e.brace = state.turn % 2 === 0; e.intent = e.brace ? 'blk' : 'atk'; }
    else if (e.kind === 'support') { e.next = e.next === 'atk' ? 'sup' : 'atk'; e.intent = e.next; }
    else if (e.kind === 'wall') { e.intent = 'blk'; } // 盾墙自带格挡,意图显示"挡 X"
    else if (e.kind === 'boss') {
      e.phase = (e.phase + 1) % 3;
      e.intent = e.phase === 0 ? 'atk' : e.phase === 1 ? 'up' : 'call';
    }
  }
}
function dealDmg(s, e, raw) {
  const dmg = Math.max(0, raw + s.str + s.rally);
  let d = dmg;
  if (e.block > 0) { const ab = Math.min(e.block, d); e.block -= ab; d -= ab; }
  e.hp = Math.max(0, e.hp - d);
  e.flash = 0.14;
  pop(s, e.x, e.y - e.h * 0.4, String(dmg), '#ffdf6a', 34);
  tone(180 + 40 * s.flyCount, 0.07, 'square', 0.2);
  if (e.hp <= 0 && !e.dead) {
    e.dead = 0.01; s.kills++; s.score += 10;
    s.booms.push({ x: e.x, y: e.y, t: 0 });
    tone(70, 0.28, 'sawtooth', 0.45); tone(52, 0.34, 'square', 0.4); // 斩杀爆响
    events.push({ e: 'kill', kind: e.kind, turn: s.turn });
  }
}
function addBlock(s, amt) {
  s.block += amt;
  pop(s, 300, 470, '+' + amt + ' 格挡', '#8fc7ff', 30);
  tone(140, 0.1, 'triangle', 0.25);
}
function playerTake(s, raw, from) {
  let d = raw;
  if (s.block > 0) { const ab = Math.min(s.block, d); s.block -= ab; d -= ab; if (ab) pop(s, 300, 420, '-' + ab, '#8fc7ff', 26); }
  if (d > 0) {
    s.hp = Math.max(0, s.hp - d); s.shake = 0.3;
    pop(s, 300, 380, String(d), '#ff7a6a', 34);
    tone(90, 0.16, 'sawtooth', 0.4);
  }
  if (s.hp <= 0 && !s.over) {
    s.over = 'dead'; s.fightTimer = 0.9; // 和胜利一样:定格一下再切 over
    s.gained = `死于 ${s.nodeName || '途中'} · 第 ${s.turn} 回合 · 击杀 ${s.kills} 只`;
    events.push({ e: 'death', turn: s.turn });
    tone(60, 0.5, 'sawtooth', 0.5);
  }
}
function foeAct(s, e) {
  if (e.kind === 'swarm' || e.kind === 'add') { for (let k = 0; k < (e.hits || 1); k++) playerTake(s, intentDmg(s, e), e); }
  else if (e.kind === 'brute') {
    if (e.brace) { e.block = tune.brute_block; pop(s, e.x, e.y - 90, '抱头防御', '#8fc7ff', 24); }
    else { e.block = 0; playerTake(s, intentDmg(s, e), e); }
  }
  else if (e.kind === 'support') {
    if (e.intent === 'sup') { for (const o of s.foes) if (o !== e && o.hp > 0) o.power = (o.power || 0) + e.buff; pop(s, e.x, e.y - 100, '全队 +' + e.buff + ' 力量', '#d9b8ff', 24); }
    else playerTake(s, intentDmg(s, e), e);
  }
  else if (e.kind === 'wall') { e.block = e.blk; playerTake(s, intentDmg(s, e), e); }
  else if (e.kind === 'boss') {
    if (e.intent === 'atk') playerTake(s, intentDmg(s, e), e);
    else if (e.intent === 'up') { e.power += tune.boss_buff; pop(s, e.x, e.y - 130, '+' + tune.boss_buff + ' 力量', '#ffd76a', 26); }
    else if (s.foes.filter(f => f.hp > 0).length <= 3) {
      const a = mkAdd(tune.boss_add_hp, tune.boss_add_atk);
      s.foes.push(a); layoutFoes(s.foes);
      pop(s, a.x, a.y - 70, '召唤!', '#ffdf6a', 26);
    }
  }
  e.weak = Math.max(0, (e.weak || 0) - 1); // 诅咒只压一回合
}
function endPlayerTurn(s) {
  for (const e of s.foes) if (e.hp > 0) foeAct(s, e);
  if (s.over) return;
  s.block = 0; s.rally = 0;
  for (const e of s.foes) if (e.kind !== 'wall') e.block = 0;
  s.turn++; s.energy = tune.energy_base + (s.energyUp || 0);
  endTurnDiscard(); drawHand(); rollIntents(state);
  events.push({ e: 'turn', n: s.turn });
  tone(150, 0.1, 'sine', 0.2);
}
function checkBattleEnd(s) {
  if (s.over) return;
  if (s.foes.every(e => e.hp <= 0)) {
    s.over = 'win';
    s.gold += s.bossKey ? 0 : s.nodeKey === 'elite' ? tune.gold_elite : tune.gold_fight;
    s.score += 50;
    events.push({ e: 'win', node: s.nodeKey });
    tone(660, 0.12, 'triangle', 0.3); tone(880, 0.2, 'triangle', 0.3);
    if (s.bossKey) {
      s.gained = `通关!第 ${s.turn} 回合 · 击杀 ${s.kills} 只 · 剩 ${s.hp} HP`;
      s.fightTimer = 0.9; // 到 results
    } else { s.reward = rollReward(); s.fightTimer = 0.7; }
  }
}
function rollReward() {
  const opts = [];
  const pool = CARD_KEYS.slice();
  while (opts.length < tune.reward_picks && pool.length) {
    opts.push({ card: pool.splice(Math.floor(rng() * pool.length), 1)[0] });
  }
  if (rng() * 100 < tune.reward_energy_up) opts[opts.length - 1] = { special: 'energy' };
  return opts;
}

// ---- 出牌:点选→点目标,或拖到落点;按出手顺序逐张结算 ----------------------------------
function canPlay(s, c) {
  const def = CARDS[c.id];
  const need = def.cost();
  if (s.energy < need) return '能量不够(还差 ' + (need - s.energy) + ' 点)';
  if (def.kind === 'attack' || def.kind === 'weak') {
    if (!s.foes.some(e => e.hp > 0)) return '场上没有活着的敌人';
  }
  return null;
}
function needsTarget(c) { const k = CARDS[c.id].kind; return k === 'attack' || k === 'weak'; }
function foeAt(x, y) {
  for (const e of state.foes) if (e.hp > 0 && Math.abs(x - e.x) < e.w / 2 + 20 && Math.abs(y - e.y) < e.h / 2 + 30) return e;
  return null;
}
function playCard(s, c, tgt) {
  const def = CARDS[c.id];
  s.energy -= def.cost();
  s.hand.splice(s.hand.indexOf(c), 1);
  s.discard.push(c); s.selected = -1;
  s.flyCount = (s.flyCount || 0) + 1;
  s.flies.push({ x0: c.x, y0: c.y, tx: tgt ? tgt.x : 300, ty: tgt ? tgt.y - 60 : 430, t: 0, id: c.id, card: c, tgt });
  events.push({ e: 'play', card: c.id, turn: s.turn });
  layoutHand();
}
function resolveFly(s, f) {
  const def = CARDS[f.id];
  let tgt = f.tgt;
  if ((def.kind === 'attack' || def.kind === 'weak') && (!tgt || tgt.hp <= 0)) {
    tgt = s.foes.find(e => e.hp > 0) || null; // 目标已死:转火最近活着的
  }
  if (def.kind === 'block') def.play(s);
  else if (def.kind === 'buff') def.play(s);
  else if (def.kind === 'all') def.play(s);
  else if (tgt) def.play(s, tgt);
  checkBattleEnd(s);
}

// ---- 结算动画队列 ------------------------------------------------------------------------
function pop(s, x, y, txt, c, size = 26) { s.pops.push({ x, y, txt, c, size, t: 0 }); }

// ---- 场景内小状态机:fight / reward / cull / map / over ---------------------------------
function fightUpdate(s, dt) {
  s.t += dt; // 敌人摆动/光环动画读 state.t,战斗里也要走
  if (s.fightTimer) { // 战斗结束后的短暂定格,再切结果界面
    s.fightTimer -= dt;
    if (s.fightTimer <= 0) {
      s.fightTimer = 0;
      if (s.over === 'dead') { scene = 'over'; }
      else if (s.bossKey) { scene = 'results'; }
      else { if (s.map[s.node]) s.map[s.node].done = true; scene = 'reward'; }
    }
    return;
  }
  if (pressed('Escape')) { endPlayerTurn(s); return; }
  // 出牌:先消费本次点击/拖动
  if (mouse.clicked) {
    const x = mouse.x, y = mouse.y;
    mouse.clicked = false;
    if (!s.resolving) {
      const btn = endTurnBtn(s);
      if (inRect(x, y, btn)) { tone(120, 0.08, 'square', 0.25); endPlayerTurn(s); return; }
      let card = null;
      for (const c of s.hand) if (Math.abs(x - c.x) < 62 && Math.abs(y - c.y) < 84) { card = c; break; }
      const foe = foeAt(x, y);
      if (mouse.howFar > 40 && card && needsTarget(card) && foe) {
        const why = canPlay(s, card); if (!why) playCard(s, card, foe); else pop(s, foe.x, foe.y - 120, why, '#ff9a8a', 22);
      } else if (card && (mouse.howFar <= 40 || !needsTarget(card))) {
        if (!needsTarget(card)) {
          const why = canPlay(s, card);
          if (!why) playCard(s, card, null); else { s.selected = s.hand.indexOf(card); s.whyBlocked = why; s.whyT = 1.4; }
        } else s.selected = s.selected === s.hand.indexOf(card) ? -1 : s.hand.indexOf(card);
      } else if (foe && s.selected >= 0 && needsTarget(s.hand[s.selected])) {
        const c = s.hand[s.selected]; const why = canPlay(s, c);
        if (!why) playCard(s, c, foe); else pop(s, foe.x, foe.y - 120, why, '#ff9a8a', 22);
      } else s.selected = -1;
    }
  } else mouse.clicked = false;
  if (s.whyT) { s.whyT -= dt; if (s.whyT <= 0) s.whyBlocked = null; }
  // 逐张飞牌结算(出手顺序)
  if (!s.resolving && s.flies.length) s.resolving = true;
  if (s.resolving && s.flies.length) {
    const f = s.flies[0]; f.t += dt / 0.22;
    if (f.t >= 1) { s.flies.shift(); resolveFly(s, f); if (!s.flies.length) s.resolving = false; }
  }
  for (const p of s.pops) p.t += dt; s.pops = s.pops.filter(p => p.t < 0.8);
  for (const b of s.booms) b.t += dt; s.booms = s.booms.filter(b => b.t < 0.5);
  for (const e of s.foes) {
    if (e.flash > 0) e.flash -= dt;
    if (e.dead > 0) e.dead += dt;
  }
  if (s.shake > 0) s.shake -= dt;
  checkBattleEnd(s);
}
const inRect = (x, y, r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
function endTurnBtn(s) { return { x: 1128, y: 560, w: 128, h: 56 }; }

// ---- Scenes: keep only the day-one screens the brief calls for ----------------------------
const scenes = {
  figures: {
    update(dt) { state.t += dt; },
    draw() {
      clear('#171210'); text('敌人图鉴', W / 2, 44, 34, '#e8d9b0');
      const list = [
        [mkSwarm(tune.swarm_a_hp, tune.swarm_a_atk, tune.swarm_a_hits), '疾行者 ×2段快攻'],
        [mkBrute(tune.brute_hp, tune.brute_atk), '岩背 重击+偶数回合防御'],
        [mkSupport(tune.support_hp, tune.support_buff, tune.support_atk), '唤灵者 给同伴加力量'],
        [mkWall(tune.elite_wall_hp, tune.elite_wall_block, tune.elite_wall_atk), '盾墙(精英)自带格挡'],
        [mkBoss(tune.boss_hp), '深渊主祭 重击/强化/召唤'],
        [mkAdd(tune.boss_add_hp, tune.boss_add_atk), '祭俑(Boss 召唤)'],
      ];
      list.forEach(([e, label], i) => {
        e.x = 115 + i * 205; e.y = 285; e.flash = 0;
        drawFoe(e); text(label, e.x, 440, 17, '#cbb98a');
      });
      const demo = { hand: [{ id: 'strike' }, { id: 'defend' }, { id: 'cleave' }, { id: 'curse' }], selected: -1, resolving: false, flies: [], energy: 3, foes: [] };
      demo.hand.forEach((c, i) => { c.x = 330 + i * 170; c.y = 580; drawCard(demo, c, i, false); });
      text('攻击牌(红) · 格挡牌(蓝) · 技能牌(紫)', W / 2, 660, 22, '#9a8b6a');
    },
  },
  title: {
    update(dt) {
      state.t += dt;
      const btn = { x: 96, y: 526, w: 310, h: 64 };
      const hover = mouse.x >= btn.x && mouse.x <= btn.x + btn.w && mouse.y >= btn.y && mouse.y <= btn.y + btn.h;
      canvas.style.cursor = hover ? 'pointer' : 'default';
      if (pressed('Enter') || pressed('Space') || (mouse.clicked && hover)) {
        mouse.clicked = false; canvas.style.cursor = 'default'; reset(); scene = 'play'; return;
      }
      mouse.clicked = false;
    },
    draw() {
      clear('#14100c');
      const t = state.t || 0;
      // 暖色烛火暗角
      const g = ctx.createRadialGradient(920, 340, 40, 920, 340, 520);
      g.addColorStop(0, 'rgba(255, 200, 100, 0.12)'); g.addColorStop(1, 'rgba(20, 16, 12, 0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

      rr(56, 56, W - 112, H - 112, 24, 'rgba(29, 23, 18, 0.92)', '#5a4630', 2.5);

      const lx = 96;
      rr(lx, 96, 168, 32, 16, 'rgba(255, 215, 106, 0.12)', 'rgba(255, 215, 106, 0.45)', 1.5);
      text('回合制卡牌肉鸽', lx + 84, 112, 15, '#ffd76a');

      ctx.save();
      ctx.shadowColor = 'rgba(255, 215, 106, 0.22)'; ctx.shadowBlur = 22;
      text(TITLE, lx, 188, 86, '#f0e2b8', 'left');
      ctx.restore();
      text('意图明牌 · 逐张连锁结算 · 战后三选一构筑', lx, 256, 22, '#b39a6a', 'left');

      // 意图图例小徽章
      const intents = [
        ['star', '#e07a5f', '攻击意图'],
        ['shield', '#7aa9e0', '格挡意图'],
        ['up', '#b98cff', '强化意图'],
      ];
      intents.forEach(([kind, col, label], i) => {
        const ix = lx + i * 172, iy = 296;
        rr(ix, iy, 158, 42, 10, 'rgba(255,255,255,0.04)', 'rgba(179,154,106,0.24)', 1.2);
        if (kind === 'star') star(ix + 24, iy + 21, 11, col);
        else if (kind === 'shield') shield(ix + 24, iy + 21, 10, col);
        else upArrow(ix + 24, iy + 21, 10, col);
        text(label, ix + 46, iy + 21, 16, '#d8c9a8', 'left');
      });

      const chips = [
        ['点选 / 拖拽', '选牌后点目标或直接拖上敌人'],
        ['1 / 2 / 3 · X', '战后三选一加牌 · 商店砍废牌'],
        ['Enter / 空格', '推进地图节点或直接开战'],
      ];
      chips.forEach(([k, v], i) => {
        const cy = 362 + i * 48;
        rr(lx, cy, 514, 38, 10, 'rgba(255,255,255,0.03)', 'rgba(90,70,48,0.65)', 1.2);
        rr(lx + 8, cy + 6, 128, 26, 7, 'rgba(255,215,106,0.14)', null);
        text(k, lx + 72, cy + 19, 14, '#ffd76a');
        text(v, lx + 148, cy + 19, 16, '#d8c9a8', 'left');
      });

      const btn = { x: lx, y: 526, w: 310, h: 64 };
      const hover = mouse.x >= btn.x && mouse.x <= btn.x + btn.w && mouse.y >= btn.y && mouse.y <= btn.y + btn.h;
      ctx.save();
      ctx.shadowColor = hover ? 'rgba(255, 215, 106, 0.45)' : 'rgba(255, 215, 106, 0.2)'; ctx.shadowBlur = hover ? 22 : 12;
      rr(btn.x, btn.y - (hover ? 2 : 0), btn.w, btn.h, 15, hover ? '#ffe18a' : '#f0c652', '#8a621c', 2.5);
      ctx.restore();
      text('踏入地牢  [Enter / 空格]', btn.x + btn.w / 2, btn.y - (hover ? 2 : 0) + btn.h / 2, 21, '#24180c');

      // 右侧对决预览（深渊主祭 + 三张手牌）
      rr(660, 96, 524, 528, 18, '#17120e', '#4d3b28', 2);
      const boss = mkBoss(tune.boss_hp); boss.x = 922; boss.y = 228; boss.flash = 0;
      drawFoe(boss);
      star(922 - 22, 122, 13, '#e07a5f'); text('12', 922 + 8, 122, 22, '#ff9a8a', 'left');
      text('深渊主祭', 922, 336, 18, '#cbb98a');

      const demo = { hand: [{ id: 'strike' }, { id: 'defend' }, { id: 'cleave' }], selected: -1, resolving: false, flies: [], energy: 3, foes: [] };
      demo.hand.forEach((c, i) => {
        c.x = 772 + i * 150;
        c.y = 502 + Math.sin(t * 2.2 + i * 0.9) * 5;
        drawCard(demo, c, i, false);
      });
    },
  },
  play: { // 地图枢纽即 play:检查按名字找 play,playinput 行只在 scene === 'play' 时记
    update(dt) {
      state.t += dt;
      if (pressed('Enter') || pressed('Space')) { // 键盘也能推进(Enter 开始当前节点)
        const nd = state.map[state.node];
        if (nd && !nd.done) clickNode(nd);
        return;
      }
      if (mouse.clicked) {
        const x = mouse.x, y = mouse.y; mouse.clicked = false;
        state.map.forEach((nd, i) => {
          if (i !== state.node || nd.done) return;
          if (Math.hypot(x - nd.x, y - nd.y) < 46) clickNode(nd);
        });
      }
    },
    draw() {
      clear('#14100c');
      text('推进地图', 40, 44, 30, '#e8d9b0', 'left');
      text(`HP ${state.hp}/${state.hpMax} · 金币 ${state.gold} · 牌组 ${state.deck.length} 张`, W - 40, 44, 24, '#cbb98a', 'right');
      ctx.strokeStyle = '#5a4630'; ctx.lineWidth = 6; ctx.setLineDash([4, 14]);
      ctx.beginPath(); state.map.forEach((nd, i) => i ? ctx.lineTo(nd.x, nd.y) : ctx.moveTo(nd.x, nd.y)); ctx.stroke(); ctx.setLineDash([]);
      state.map.forEach((nd, i) => {
        const cur = i === state.node;
        rr(nd.x - 40, nd.y - 40, 80, 80, cur ? 14 : 40, nd.done ? '#241d15' : cur ? '#3a2c1a' : '#20191300'.slice(0, 7), cur ? '#ffd76a' : '#5a4630', cur ? 4 : 2);
        if (nd.key === 'rest') { ctx.fillStyle = nd.done ? '#556' : '#9fd'; ctx.beginPath(); ctx.moveTo(nd.x, nd.y - 16); ctx.quadraticCurveTo(nd.x + 18, nd.y, nd.x, nd.y + 16); ctx.quadraticCurveTo(nd.x - 18, nd.y, nd.x, nd.y - 16); ctx.fill(); }
        else if (nd.key === 'elite') star(nd.x, nd.y, 18, nd.done ? '#555' : '#e07a4a');
        else if (nd.key === 'boss') { star(nd.x, nd.y, 22, nd.done ? '#555' : '#d84b4b'); shield(nd.x, nd.y + 4, 12, '#333'); }
        else { star(nd.x, nd.y, 16, nd.done ? '#555' : '#c9a86a'); }
        text(nd.label + (nd.done ? ' ✓' : ''), nd.x, nd.y + 66, 20, cur ? '#ffd76a' : '#9a8b6a');
      });
      if (state.gainedRest) text('休息:回复了 HP', W / 2, 560, 26, '#9fd');
      text(NEEDS_MAP_HINT(), W / 2, 660, 24, '#8a7a5a');
    },
  },
  fight: {
    update(dt) { fightUpdate(state, dt); },
    draw() { drawFight(state); },
  },
  reward: {
    update(dt) {
      state.t += dt;
      if (pressed('Escape')) { nextAfterReward(); return; }
      if (pressed('Digit1')) takeReward(0);
      if (pressed('Digit2')) takeReward(1);
      if (pressed('Digit3')) takeReward(2);
      if (mouse.clicked) {
        const x = mouse.x, y = mouse.y; mouse.clicked = false;
        state.reward.forEach((o, i) => { const rx = 250 + i * 300; if (Math.abs(x - rx) < 120 && Math.abs(y - 380) < 150) takeReward(i); });
        if (inRect(x, y, { x: 540, y: 580, w: 200, h: 54 })) nextAfterReward();
        if (inRect(x, y, { x: 1040, y: 580, w: 200, h: 54 })) { state.culling = true; }
      }
      if (state.culling) cullClick();
    },
    draw() {
      clear('#14100c');
      text('战后三选一(1/2/3 或点击,Esc 跳过)', W / 2, 90, 34, '#f0e2b8');
      text(`金币 ${state.gold}`, W - 40, 44, 26, '#ffd76a', 'right');
      state.reward.forEach((o, i) => {
        const x = 250 + i * 300, y = 380;
        if (o.special === 'energy') {
          rr(x - 110, y - 150, 220, 300, 14, '#1a2418', '#7fd08a');
          upArrow(x, y - 40, 34, '#7fd08a');
          text('能量上限 +1', x, y + 60, 26, '#cdeccd');
          text('整个冒险有效', x, y + 96, 20, '#7a9a7a');
        } else {
          const c = { id: o.card, x, y };
          drawCardList(c, i);
        }
        text(String(i + 1), x - 96, y - 132, 24, '#8a7a5a');
      });
      rr(540, 580, 200, 54, 10, '#241d15', '#5a4630'); text('跳过', 640, 607, 26, '#d8c9a8');
      const canCull = state.gold >= tune.cull_cost && state.deck.length > 8;
      rr(1040, 580, 200, 54, 10, state.culling ? '#3a2c1a' : '#241d15', canCull ? '#ffd76a' : '#5a4630');
      text(`砍牌 ${tune.cull_cost} 金`, 1140, 607, 24, canCull ? '#ffd76a' : '#6a5a40');
      if (state.culling) drawCull();
    },
  },
  over: {
    update(dt) { state.t += dt; if (pressed('Enter') || pressed('KeyR')) { reset(); scene = 'play'; } },
    draw() {
      drawFight(state);
      ctx.fillStyle = 'rgba(10,4,2,0.78)'; ctx.fillRect(0, 0, W, H);
      text('倒下了', W / 2, 280, 64, '#ff7a6a');
      text(state.gained, W / 2, 360, 28, '#d8c9a8');
      text('Enter 一键重开(新种子)', W / 2, 440, 28, '#ffd76a');
    },
  },
  results: {
    update(dt) { state.t += dt; if (pressed('Enter')) { state.runs = (state.runs || 0) + 1; newRun(); scene = 'play'; } },
    draw() {
      clear('#10140c');
      text('Boss 倒下,这局通了!', W / 2, 260, 60, '#9fe08a');
      text(state.gained, W / 2, 350, 30, '#d8c9a8');
      text(`金币 ${state.gold} · 最终牌组 ${state.deck.length} 张`, W / 2, 400, 26, '#cbb98a');
      text('Enter 再来一局', W / 2, 480, 28, '#ffd76a');
    },
  },
};
function clickNode(nd) { // 点/Enter 走当前节点:休息回血,战斗进战斗
  if (nd.key === 'rest') {
    const heal = Math.round(state.hpMax * tune.rest_heal_frac);
    state.hp = Math.min(state.hpMax, state.hp + heal);
    state.gainedRest = heal;
    nd.done = true; state.node++; events.push({ e: 'rest', heal });
    tone(240, 0.3, 'sine', 0.25);
  } else {
    state.nodeName = nd.label;
    enterFight(nd.key === 'boss' ? 'boss' : nd.key);
    scene = 'fight'; // enterFight 只备战不切场景:不写这行,点节点后还停在地图上
  }
}
function NEEDS_MAP_HINT() {
  const nd = state.map[state.node];
  return nd ? `下一个节点:${nd.label}(点它)` : '';
}
function drawCardList(c, i) {
  const def = CARDS[c.id];
  rr(c.x - 110, c.y - 150, 220, 300, 14, '#241c14', FRAMES[def.frame]);
  text(def.name, c.x, c.y - 100, 30, '#f0e2b8');
  text('费用 ' + def.cost(), c.x, c.y - 60, 22, '#cbb98a');
  wrap(def.kw, c.x, c.y, 200, 22).forEach((ln, j) => text(ln, c.x, c.y + 10 + j * 26, 20, '#b39a6a'));
}
function takeReward(i) {
  const o = state.reward[i]; if (!o) return;
  if (o.special === 'energy') { state.energyUp = (state.energyUp || 0) + 1; events.push({ e: 'reward', card: 'energy+' }); }
  else { state.deck.push({ id: o.card }); events.push({ e: 'reward', card: o.card }); }
  state.score += 5;
  nextAfterReward();
}
function nextAfterReward() {
  const nd = state.map[state.node]; if (nd) nd.done = true;
  state.node++; state.reward = null; state.culling = null;
  if (state.node >= state.map.length) { scene = 'results'; state.gained = state.gained || '走到了地图尽头'; }
  else scene = 'play';
  tone(500, 0.1, 'sine', 0.2);
}
function cullClick() {
  if (!mouse.clicked) return;
  const x = mouse.x, y = mouse.y; mouse.clicked = false;
  if (state.gold < tune.cull_cost) return;
  const n = state.deck.length, cw = 64, x0 = (W - n * (cw + 8)) / 2;
  for (let i = 0; i < n; i++) {
    const cx = x0 + i * (cw + 8);
    if (x >= cx && x <= cx + cw && y >= 560 && y <= 640) {
      if (state.deck.length <= 8) return; // 起手牌不许砍到底以下
      const cut = state.deck[i].id; // 先记 id 再删:splice 之后 deck[i] 已经是隔壁那张
      state.deck.splice(i, 1); state.gold -= tune.cull_cost;
      state.culling = false; events.push({ e: 'cull', card: cut });
      tone(330, 0.12, 'square', 0.25);
      return;
    }
  }
}
function drawCull() {
  ctx.fillStyle = 'rgba(8,5,3,0.88)'; ctx.fillRect(0, 480, W, 240);
  text(`点一张牌砍掉(每局牌组最少留 8 张 · 剩 ${state.deck.length} 张)`, W / 2, 520, 24, '#ffd76a');
  const n = state.deck.length, cw = 64, x0 = (W - n * (cw + 8)) / 2;
  state.deck.forEach((c, i) => {
    const def = CARDS[c.id];
    rr(x0 + i * (cw + 8), 560, cw, 80, 8, '#241c14', FRAMES[def.frame], 2);
    text(def.name, x0 + i * (cw + 8) + cw / 2, 600, 16, '#e8d9b0');
  });
}

// ---- 战斗绘制 ------------------------------------------------------------------------------
function wrap(str, x, y, maxW, size) {
  ctx.font = `${size}px ${FONT}`;
  const out = []; let line = '';
  for (const ch of str) {
    if (ctx.measureText(line + ch).width > maxW) { out.push(line); line = ch; }
    else line += ch;
  }
  if (line) out.push(line);
  return out;
}
function drawFoe(e) {
  const a = e.dead ? Math.max(0, 1 - e.dead * 2) : 1;
  ctx.save(); ctx.globalAlpha = a;
  if (e.dead) { ctx.translate(e.x, e.y); ctx.rotate(e.dead * 1.2); ctx.translate(-e.x, -e.y); }
  const sway = Math.sin(state.t * 2 + e.x) * 3;
  const col = e.flash > 0 ? '#ffffff' : `hsl(${e.hue} 45% 46%)`;
  const dk = `hsl(${e.hue} 50% 22%)`;
  const X = e.x, Y = e.y + sway, hw = e.w / 2, hh = e.h / 2;
  if (e.kind === 'swarm') { // 疾行者:尖刺小虫,四条腿
    ctx.fillStyle = col; ctx.strokeStyle = dk; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.ellipse(X, Y, hw * 0.62, hh * 0.6, 0, 0, 7); ctx.fill(); ctx.stroke();
    for (let k = 0; k < 4; k++) { const px = X - hw * 0.5 + k * hw * 0.33; ctx.beginPath(); ctx.moveTo(px, Y + hh * 0.4); ctx.lineTo(px - 8, Y + hh * 0.85); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(X - 10, Y - hh * 0.55); ctx.lineTo(X, Y - hh * 0.95); ctx.lineTo(X + 10, Y - hh * 0.55); ctx.closePath(); ctx.fillStyle = dk; ctx.fill();
    eye(X - 14, Y - 8, 5, col); eye(X + 14, Y - 8, 5, col);
  } else if (e.kind === 'brute') { // 岩背:方厚巨石,背上有棱
    rr(X - hw * 0.75, Y - hh * 0.6, hw * 1.5, hh * 1.3, 18, col, dk, 5);
    ctx.fillStyle = dk;
    for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.moveTo(X - hw * 0.5 + k * hw * 0.5, Y - hh * 0.6); ctx.lineTo(X - hw * 0.35 + k * hw * 0.5, Y - hh * 0.95); ctx.lineTo(X - hw * 0.2 + k * hw * 0.5, Y - hh * 0.6); ctx.closePath(); ctx.fill(); }
    eye(X - 22, Y - 10, 8, '#fff'); eye(X + 22, Y - 10, 8, '#fff');
    if (e.brace) { shield(X, Y + 20, 30, '#8fc7ff'); }
  } else if (e.kind === 'support') { // 唤灵者:细高袍子 + 光环
    ctx.fillStyle = col; ctx.strokeStyle = dk; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(X, Y - hh * 0.85); ctx.lineTo(X + hw * 0.55, Y + hh * 0.75); ctx.lineTo(X - hw * 0.55, Y + hh * 0.75); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(X, Y - hh * 0.55, hw * 0.3, 0, 7); ctx.fillStyle = `hsl(${e.hue} 60% 70%)`; ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    for (let k = 0; k < 3; k++) { const aa = state.t * 2 + k * 2.1; ctx.beginPath(); ctx.arc(X + Math.cos(aa) * 56, Y - 40 + Math.sin(aa) * 18, 5, 0, 7); ctx.stroke(); }
  } else if (e.kind === 'wall') { // 盾墙:一面巨盾 + 后面一双眼睛
    shield(X, Y + 10, hw * 0.85, col); ctx.lineWidth = 5; ctx.strokeStyle = dk;
    ctx.beginPath(); ctx.moveTo(X, Y - hh * 0.6); ctx.lineTo(X, Y + hh * 0.7); ctx.stroke();
    eye(X - 30, Y - 40, 7, '#fff'); eye(X + 30, Y - 40, 7, '#fff');
  } else if (e.kind === 'add') { // 祭俑:陶片小俑
    rr(X - 34, Y - 40, 68, 84, 12, col, dk, 4);
    eye(X - 12, Y - 16, 5, '#402'); eye(X + 12, Y - 16, 5, '#402');
    ctx.strokeStyle = dk; ctx.beginPath(); ctx.moveTo(X - 20, Y + 24); ctx.lineTo(X + 20, Y + 24); ctx.stroke();
  } else if (e.kind === 'boss') { // 深渊主祭:大袍 + 三眼 + 角冠
    ctx.fillStyle = col; ctx.strokeStyle = dk; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(X, Y - hh * 0.9); ctx.lineTo(X + hw * 0.7, Y + hh * 0.8); ctx.quadraticCurveTo(X, Y + hh, X - hw * 0.7, Y + hh * 0.8); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = dk;
    for (let k = -1; k <= 1; k += 2) { ctx.beginPath(); ctx.moveTo(X + k * 40, Y - hh * 0.75); ctx.lineTo(X + k * 76, Y - hh * 1.15); ctx.lineTo(X + k * 52, Y - hh * 0.5); ctx.closePath(); ctx.fill(); }
    eye(X, Y - 30, 10, '#ffdf6a'); eye(X - 34, Y - 6, 7, '#fff'); eye(X + 34, Y - 6, 7, '#fff');
  }
  ctx.restore();
  if (e.dead || a <= 0) return;
  // 血条
  const bw = Math.max(90, e.w * 0.7);
  rr(X - bw / 2, Y + hh * 0.92, bw, 12, 6, '#20160f', '#5a4630', 2);
  ctx.fillStyle = '#d84b4b'; ctx.fillRect(X - bw / 2 + 1, Y + hh * 0.92 + 1, (bw - 2) * e.hp / e.maxhp, 10);
  // 意图气泡(数字已扣玩家格挡)
  const iy = Y - hh - 46;
  rr(X - 58, iy - 26, 116, 52, 14, 'rgba(10,8,5,0.85)', '#8a7a5a', 2);
  const shown = e.intent === 'atk' || e.intent === 'boss' ? null : 0;
  if (e.intent === 'atk') {
    const d = intentDmg(state, e), hits = e.hits || 1;
    star(X - 34, iy, 13, '#ff8a6a');
    text(d + (hits > 1 ? ' ×' + hits : ''), X + 12, iy, 26, '#ffd0c0');
  } else if (e.intent === 'blk') {
    shield(X - 34, iy, 12, '#8fc7ff');
    text('挡 ' + (e.block || e.blk || 10), X + 14, iy, 24, '#cde6ff');
  } else if (e.intent === 'up') {
    upArrow(X - 34, iy, 12, '#ffd76a'); text('+' + tune.boss_buff + ' 力量', X + 16, iy, 22, '#ffe9a8');
  } else if (e.intent === 'call') {
    star(X - 38, iy, 10, '#ffdf6a'); star(X - 18, iy + 6, 8, '#ffdf6a'); text('召唤', X + 24, iy, 24, '#ffdf6a');
  } else if (e.intent === 'sup') {
    upArrow(X - 36, iy, 11, '#d9b8ff'); text('队 +' + e.buff, X + 16, iy, 22, '#e6d4ff');
  }
  if ((e.power || 0) > 0) text('力+' + e.power, X + bw / 2 - 6, Y + hh * 0.92 + 30, 20, '#ffd76a', 'right');
  if ((e.weak || 0) > 0) text('弱-' + e.weak, X - bw / 2 + 6, Y + hh * 0.92 + 30, 20, '#b48cff', 'left');
}
function eye(x, y, r, c) { ctx.fillStyle = '#1a120a'; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y - 1, r * 0.45, 0, 7); ctx.fill(); }
function drawCard(s, c, i, sel) {
  const def = CARDS[c.id];
  const hov = !s.resolving && !s.over && Math.abs(mouse.x - c.x) < 62 && Math.abs(mouse.y - c.y) < 84;
  const lift = (sel || hov) ? 26 : 0;
  const playable = !canPlay(s, c);
  ctx.save();
  if (!playable && !sel) ctx.globalAlpha = 0.9;
  ctx.translate(c.x, c.y - lift); ctx.rotate((i - (s.hand.length - 1) / 2) * 0.045);
  rr(-60, -82, 120, 164, 12, playable ? '#2c2216' : '#221b12', sel ? '#ffd76a' : FRAMES[def.frame], sel ? 5 : 3);
  text(def.name, 0, -58, 26, '#f0e2b8');
  ctx.beginPath(); ctx.arc(-44, -62, 17, 0, 7); ctx.fillStyle = '#141009'; ctx.fill();
  ctx.strokeStyle = playable ? '#ffd76a' : '#6a5a40'; ctx.lineWidth = 2.5; ctx.stroke();
  text(String(def.cost()), -44, -62, 22, playable ? '#ffd76a' : '#8a7a5a');
  const d = def.dmg ? def.dmg() : def.blk ? def.blk() : 0;
  const kw = def.kw.replace('{d}', d + (s.str ? ' (+' + s.str + ')' : '')).replace('{b}', d + '').replace('{w}', tune.curse_amt).replace('{p}', tune.rally_amt);
  wrap(kw, 0, 6, 104, 17).forEach((ln, j) => text(ln, 0, -14 + j * 22, 17, '#cbb98a'));
  ctx.restore();
}
function drawFight(s) {
  const shx = s.shake > 0 ? Math.sin(s.shake * 60) * 8 * s.shake : 0;
  ctx.save(); ctx.translate(shx, 0);
  clear('#171210');
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#211812'); g.addColorStop(1, '#120d09');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#3a2c1c'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 380); ctx.lineTo(W, 380); ctx.stroke();
  for (const e of s.foes) drawFoe(e);
  for (const b of s.booms) { // 斩杀爆响:两圈外扩
    const t = b.t / 0.5;
    ctx.strokeStyle = `rgba(255,220,120,${1 - t})`; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(b.x, b.y, 20 + 90 * t, 0, 7); ctx.stroke();
    ctx.strokeStyle = `rgba(255,120,80,${0.8 * (1 - t)})`;
    ctx.beginPath(); ctx.arc(b.x, b.y, 10 + 55 * t, 0, 7); ctx.stroke();
  }
  // 玩家:一枚持盾棋型(左下)
  const px = 300, py = 470;
  shield(px, py, 42, '#d9c9a0'); shield(px, py, 34, '#7a9ac0');
  text(String(s.hp), px, py + 4, 30, s.hp <= s.hpMax * 0.3 ? '#ff7a6a' : '#10233a');
  if (s.block > 0) { shield(px - 56, py - 6, 26, '#8fc7ff'); text(String(s.block), px - 56, py - 4, 22, '#0d2438'); }
  if (s.str + s.rally > 0) { star(px + 56, py - 4, 16, '#ff8a6a'); text(String(s.str + s.rally), px + 56, py - 4, 20, '#fff'); }
  rr(px - 90, py + 60, 180, 14, 7, '#20160f', '#5a4630', 2);
  ctx.fillStyle = s.hp > s.hpMax * 0.3 ? '#7fbf6a' : '#d84b4b';
  ctx.fillRect(px - 89, py + 61, 178 * s.hp / s.hpMax, 12);
  // 能量球
  ctx.beginPath(); ctx.arc(110, 640, 40, 0, 7); ctx.fillStyle = '#141009'; ctx.fill();
  ctx.strokeStyle = '#ffd76a'; ctx.lineWidth = 4; ctx.stroke();
  text(s.energy + '/' + (tune.energy_base + (s.energyUp || 0)), 110, 640, 24, '#ffd76a');
  // 抽/弃堆计数
  text('抽 ' + s.draw.length, 60, 706, 22, '#9a8b6a');
  text('弃 ' + s.discard.length, 130, 706, 22, '#9a8b6a');
  text('回合 ' + s.turn, W - 60, 706, 22, '#9a8b6a', 'right');
  // 手牌
  s.hand.forEach((c, i) => drawCard(s, c, i, s.selected === i));
  if (s.whyBlocked) text(s.whyBlocked, W / 2, 500, 26, '#ff9a8a');
  // 结束回合按钮
  const btn = endTurnBtn(s);
  rr(btn.x, btn.y, btn.w, btn.h, 10, '#2c2216', '#ffd76a', 3);
  text('结束回合', btn.x + btn.w / 2, btn.y + btn.h / 2, 26, '#f0e2b8');
  // 飞牌(逐张结算)
  for (const f of s.flies) {
    const t = Math.min(1, f.t), x = f.x0 + (f.tx - f.x0) * t, y = f.y0 + (f.ty - f.y0) * t - Math.sin(t * Math.PI) * 60;
    rr(x - 30, y - 42, 60, 84, 8, '#2c2216', FRAMES[CARDS[f.id].frame], 3);
    text(CARDS[f.id].name, x, y, 18, '#f0e2b8');
  }
  // 飘字
  for (const p of s.pops) {
    const t = p.t / 0.8;
    ctx.globalAlpha = 1 - t; text(p.txt, p.x, p.y - t * 46, p.size, p.c); ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (s.over === 'win' && s.fightTimer) text(s.bossKey ? '胜利!' : '清场!', W / 2, 200, 48, '#ffd76a');
  if (s.resolving) text('结算中…', 24, 32, 22, '#8a7a5a', 'left');
}

// ---- Loop: fixed step, frame time clamped ---------------------------------------------
function step() {
  if (pressed('KeyM')) { setMuted(!muted); hit.delete('KeyM'); }
  scenes[scene].update(STEP); hit.clear(); mouse.clicked = false;
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

// ---- What a check can read and drive ----------------------------------------------------
window.game = {
  get scene() { return scene; },
  get state() { return state; },
  press(code) { hit.add(code); },
  hold(code, on) { on ? down.add(code) : down.delete(code); },
  click(x, y) { mouse.x = x; mouse.y = y; mouse.clicked = true; mouse.howFar = 0; }, // 脚本检查:合成一次点击
  get events() { return events; },
  step(n = 1, draw = true, alpha = 1) {
    for (let i = 0; i < n; i++) step();
    if (draw) { ALPHA = alpha; drawFrame(); }
  },
};

reset();
scene = params.get('scene') || 'title';
if (scene === 'fight') enterFight('fight1');
last = clock.now();
if (params.get('manual') === '1') drawFrame();
else { requestAnimationFrame(frame); setInterval(timer, 50); }
