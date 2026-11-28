// PROTOTYPE - NOT FOR PRODUCTION
// Question: 只靠走位 + 三选一构筑的五分钟割草局,本身好不好玩?
// Date: 2026-11-24
// Every tuning value lives here, each with value, min, max and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },

  // ---- 玩家 ----
  move_speed: { value: 260, min: 150, max: 420, step: 5 },        // px/s
  player_hp: { value: 100, min: 40, max: 300, step: 5 },          // 点
  invuln_time: { value: 0.55, min: 0.1, max: 2, step: 0.05 },     // s,受击后的无敌

  // ---- 这局 ----
  run_time: { value: 300, min: 120, max: 600, step: 10 },         // s,到点 Boss 入场
  crowd_cap: { value: 180, min: 40, max: 300, step: 10 },         // 场上怪数上限
  spawn_start: { value: 1.5, min: 0.4, max: 3, step: 0.05 },      // s,开局刷怪间隔
  spawn_end: { value: 0.45, min: 0.15, max: 2, step: 0.05 },      // 到 Boss 时的间隔(线性插值)
  batch_start: { value: 1, min: 1, max: 6, step: 1 },             // 每次刷几只(开局)
  batch_end: { value: 4, min: 1, max: 8, step: 1 },                // 每次刷几只(末段)

  // ---- 经验与升级 ----
  xp_start: { value: 6, min: 3, max: 20, step: 1 },               // 2 级所需经验
  xp_grow: { value: 4, min: 1, max: 12, step: 1 },                // 每级多加所需
  gem_pull: { value: 110, min: 30, max: 400, step: 10 },          // px,吸取半径
  gem_speed: { value: 460, min: 100, max: 900, step: 20 },        // px/s,宝石飞行

  // ---- 武器(1 级基础值;等级按下面的曲线缩放)----
  knife_count: { value: 1, min: 1, max: 6, step: 1 },             // 飞刀同时数(每 2 级 +1)
  knife_dmg: { value: 9, min: 1, max: 40, step: 1 },              // 点
  knife_interval: { value: 1.15, min: 0.3, max: 3, step: 0.05 },  // s,投掷间隔
  knife_speed: { value: 520, min: 200, max: 900, step: 10 },      // px/s
  ring_interval: { value: 3.2, min: 1, max: 6, step: 0.1 },       // 潮环
  ring_dmg: { value: 8, min: 1, max: 40, step: 1 },
  ring_r0: { value: 60, min: 20, max: 150, step: 5 },             // 起始半径
  ring_r1: { value: 130, min: 60, max: 300, step: 5 },            // 每级扩张半径
  zap_interval: { value: 0.55, min: 0.2, max: 2, step: 0.05 },    // 光鳗:闪电间隔
  zap_dmg: { value: 6, min: 1, max: 30, step: 1 },
  zap_range: { value: 230, min: 80, max: 500, step: 10 },         // px
  dmg_per_lvl: { value: 0.3, min: 0.05, max: 0.8, step: 0.05 },   // 每级 +30% 伤害
  rate_per_lvl: { value: 0.08, min: 0.02, max: 0.2, step: 0.01 }, // 每级间隔 -8%

  // ---- 怪:快(跳蚤)/硬(壳将)/远程(海胆)/慢(爬蟹)----
  crab_hp: { value: 22, min: 5, max: 100, step: 1 },
  crab_spd: { value: 58, min: 20, max: 150, step: 2 },
  crab_dmg: { value: 9, min: 1, max: 40, step: 1 },
  flea_hp: { value: 9, min: 3, max: 40, step: 1 },
  flea_spd: { value: 165, min: 60, max: 300, step: 5 },
  flea_dmg: { value: 6, min: 1, max: 30, step: 1 },
  shell_hp: { value: 85, min: 20, max: 300, step: 5 },
  shell_spd: { value: 36, min: 10, max: 90, step: 2 },
  shell_dmg: { value: 14, min: 1, max: 50, step: 1 },
  shell_armor: { value: 5, min: 0, max: 20, step: 1 },            // 每次受击减免
  urchin_hp: { value: 18, min: 5, max: 80, step: 1 },
  urchin_spd: { value: 22, min: 5, max: 80, step: 2 },
  urchin_dmg: { value: 6, min: 1, max: 30, step: 1 },            // 弹伤
  urchin_shot: { value: 3.0, min: 1, max: 8, step: 0.1 },        // s,吐弹间隔
  urchin_range: { value: 270, min: 100, max: 500, step: 10 },    // px,开火距离
  proj_speed: { value: 250, min: 80, max: 600, step: 10 },
  spawn_crab: { value: 0, min: 0, max: 300, step: 5 },            // s,该怪解锁时刻
  spawn_flea: { value: 35, min: 0, max: 300, step: 5 },
  spawn_urchin: { value: 120, min: 0, max: 300, step: 5 },        // 远程:2 分钟
  spawn_shell: { value: 180, min: 0, max: 300, step: 5 },         // 硬壳:3 分钟
  hp_ramp: { value: 2.0, min: 1, max: 4, step: 0.1 },             // Boss 时怪血倍率(线性)
  dmg_ramp: { value: 1.6, min: 1, max: 3, step: 0.05 },           // 怪伤倍率

  // ---- Boss:潮王 ----
  boss_hp: { value: 700, min: 100, max: 3000, step: 20 },
  boss_spd: { value: 46, min: 10, max: 120, step: 2 },
  boss_dmg: { value: 22, min: 5, max: 80, step: 1 },
  boss_adds: { value: 4.5, min: 1, max: 12, step: 0.5 },          // s,召唤爬蟹
  boss_burst: { value: 5.5, min: 1, max: 12, step: 0.5 },         // s,环形弹幕

  // ---- 金币与永久强化(薄存托)----
  coin_chance: { value: 0.12, min: 0, max: 0.5, step: 0.01 },     // 每杀掉金币概率
  meta_cost: { value: 60, min: 10, max: 300, step: 5 },           // 护符价格
  meta_gain: { value: 0.05, min: 0.01, max: 0.3, step: 0.01 },    // 每枚永久 +5% 伤害
};
