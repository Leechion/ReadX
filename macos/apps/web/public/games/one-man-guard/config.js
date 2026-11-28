// PROTOTYPE - NOT FOR PRODUCTION
// Question: 慢节奏精英怪 + 每次放置都要掂量,策划本身好不好玩?
// Date: 2026-11-24
// Every tuning value lives here, each with value, min, max and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },

  // ---- 关卡 ----
  lives: { value: 10, min: 3, max: 30, step: 1 },           // 基地命数
  start_coins: { value: 120, min: 40, max: 400, step: 5 },  // 开局金币
  wave_break: { value: 15, min: 4, max: 40, step: 1 },      // s,波与波之间的建造间隙
  first_wave_delay: { value: 4, min: 1, max: 15, step: 1 }, // s,开局到第一波
  wave_count: { value: 10, min: 3, max: 20, step: 1 },      // 共几波
  hp_ramp: { value: 0.18, min: 0, max: 0.5, step: 0.01 },   // 每波怪血 +18%
  wave_reward: { value: 20, min: 5, max: 80, step: 5 },     // 清波奖励金币(再加 6×波号)

  // ---- 塔 ----
  dart_cost: { value: 50, min: 20, max: 200, step: 5 },
  dart_dmg: { value: 12, min: 2, max: 60, step: 1 },
  dart_rate: { value: 0.35, min: 0.1, max: 2, step: 0.05 }, // s,射击间隔
  dart_range: { value: 135, min: 60, max: 300, step: 5 },   // px
  cannon_cost: { value: 90, min: 30, max: 300, step: 5 },
  cannon_dmg: { value: 30, min: 5, max: 120, step: 1 },
  cannon_rate: { value: 1.6, min: 0.5, max: 4, step: 0.1 },
  cannon_range: { value: 150, min: 60, max: 320, step: 5 },
  cannon_splash: { value: 70, min: 20, max: 160, step: 5 }, // px,溅射半径
  frost_cost: { value: 60, min: 20, max: 250, step: 5 },
  frost_dmg: { value: 6, min: 1, max: 40, step: 1 },
  frost_rate: { value: 0.9, min: 0.3, max: 3, step: 0.05 },
  frost_range: { value: 110, min: 50, max: 260, step: 5 },
  frost_slow: { value: 0.5, min: 0.2, max: 0.9, step: 0.05 }, // 减速后速度倍率
  frost_slow_t: { value: 2, min: 0.5, max: 5, step: 0.1 },    // s
  up_cost_mult: { value: 1.6, min: 1.2, max: 2.5, step: 0.05 }, // 升级价格 = 已投入 × 此倍率
  up_dmg_mult: { value: 1.35, min: 1.05, max: 2, step: 0.05 },
  sell_frac: { value: 0.7, min: 0.3, max: 1, step: 0.05 },    // 卖塔回本比例

  // ---- 怪:疾行(快)/重甲(硬)/飞掠(绕路)/盾卫(护周围) ----
  runner_hp: { value: 40, min: 10, max: 150, step: 5 },
  runner_spd: { value: 95, min: 30, max: 220, step: 5 },      // px/s
  runner_dmg: { value: 1, min: 1, max: 5, step: 1 },          // 漏一只扣几条命
  runner_coin: { value: 8, min: 1, max: 40, step: 1 },
  brute_hp: { value: 170, min: 40, max: 600, step: 10 },
  brute_spd: { value: 42, min: 10, max: 120, step: 2 },
  brute_dmg: { value: 2, min: 1, max: 8, step: 1 },
  brute_coin: { value: 20, min: 5, max: 80, step: 1 },
  brute_armor: { value: 5, min: 0, max: 20, step: 1 },        // 每次受击减免
  flyer_hp: { value: 70, min: 20, max: 260, step: 5 },
  flyer_spd: { value: 75, min: 20, max: 200, step: 5 },
  flyer_dmg: { value: 1, min: 1, max: 5, step: 1 },
  flyer_coin: { value: 12, min: 1, max: 60, step: 1 },
  shield_hp: { value: 120, min: 30, max: 400, step: 5 },
  shield_spd: { value: 55, min: 15, max: 150, step: 5 },
  shield_dmg: { value: 1, min: 1, max: 5, step: 1 },
  shield_coin: { value: 15, min: 1, max: 60, step: 1 },
  shield_amt: { value: 30, min: 5, max: 100, step: 5 },       // 给周围上的盾值
  shield_radius: { value: 90, min: 40, max: 200, step: 5 },   // px
  shield_rate: { value: 4, min: 1, max: 10, step: 0.5 },      // s,套盾间隔
};
