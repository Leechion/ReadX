// PROTOTYPE - NOT FOR PRODUCTION
// Question: 两个人挤在一块场地上既抢又撞,能不能一边骂一边笑?
// Date: 2026-11-27
// Every tuning value lives here, each with value, min, max and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },

  move_speed:  { value: 265, min: 180, max: 340, step: 5 },   // 走路速度 px/s
  slow_per:    { value: 0.12, min: 0.05, max: 0.22, step: 0.01 }, // 每带一份碎片减速比例
  dash_speed:  { value: 760, min: 500, max: 1000, step: 20 }, // 冲撞速度 px/s
  dash_time:   { value: 0.18, min: 0.1, max: 0.3, step: 0.01 }, // 冲撞持续 秒
  dash_cool:   { value: 1.1, min: 0.5, max: 2.2, step: 0.1 },  // 冲撞冷却 秒
  stun_time:   { value: 0.55, min: 0.2, max: 1.2, step: 0.05 },// 被撞后眩晕 秒
  carry_max:   { value: 3, min: 1, max: 5, step: 1 },          // 身上最多带几份
  round_secs:  { value: 30, min: 15, max: 60, step: 1 },       // 每局时长 秒
  win_rounds:  { value: 2, min: 2, max: 3, step: 1 },          // 先得几局算赢
  freeze_secs: { value: 1.5, min: 0, max: 3, step: 0.1 },      // 落后补贴:领先者开局冻结 秒
  spawn_every: { value: 1.15, min: 0.5, max: 2.5, step: 0.05 },// 每隔多久冒一颗碎片 秒
  shard_max:   { value: 6, min: 3, max: 10, step: 1 },         // 场上最多几颗
  shard_life:  { value: 6, min: 3, max: 10, step: 0.5 },       // 碎片存活 秒(3 分更短)
  three_chance:{ value: 0.12, min: 0, max: 0.4, step: 0.02 },  // 刷出 3 分的概率
  bot_speed:   { value: 225, min: 150, max: 300, step: 5 },    // 机器人对手速度 px/s
};
