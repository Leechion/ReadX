// PROTOTYPE - NOT FOR PRODUCTION
// Question: 意图明牌 + 一回合连锁结算,能不能玩出'这一回合我全算了'的爽感?
// Date: 2026-11-24
// Every tuning value lives here, each with value, min, max and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },

  // ---- 玩家 ----
  player_hp: { value: 60, min: 20, max: 200, step: 5 },        // 点;HP 不回复,除节点休息
  energy_base: { value: 3, min: 1, max: 5, step: 1 },           // 每回合固定能量(点)
  hand_size: { value: 5, min: 3, max: 8, step: 1 },             // 每回合新手牌张数(回合末整手弃掉)
  strike_dmg: { value: 6, min: 1, max: 20, step: 1 },           // 打击:单体伤害
  defend_block: { value: 5, min: 1, max: 20, step: 1 },         // 防御:格挡(回合末消失)
  rest_heal_frac: { value: 0.3, min: 0.1, max: 0.6, step: 0.05 }, // 休息:回最大 HP 的比例

  // ---- 奖励与砍牌 ----
  reward_picks: { value: 3, min: 1, max: 5, step: 1 },          // 战后三选一的张数(可全跳过)
  reward_energy_up: { value: 4, min: 0, max: 10, step: 1 },     // 稀有奖励:能量上限 +1 的权重(百)
  cull_cost: { value: 60, min: 0, max: 200, step: 5 },          // 砍牌服务价钱(金币)
  gold_fight: { value: 25, min: 0, max: 100, step: 5 },         // 每场战斗金币
  gold_elite: { value: 40, min: 0, max: 100, step: 5 },         // 精英战金币

  // ---- 小怪 1:快攻小怪(疾行者)----
  swarm_a_n: { value: 2, min: 1, max: 6, step: 1 },             // 首战数量
  swarm_a_hp: { value: 14, min: 5, max: 60, step: 1 },
  swarm_a_atk: { value: 4, min: 1, max: 20, step: 1 },          // 每回合 1 下
  swarm_a_hits: { value: 2, min: 1, max: 4, step: 1 },          // 连击段数(打法:快攻)

  // ---- 小怪 2:大件(岩背)----
  brute_hp: { value: 34, min: 10, max: 120, step: 2 },
  brute_atk: { value: 14, min: 2, max: 40, step: 1 },           // 打法:重击,必须格挡
  brute_block: { value: 10, min: 0, max: 40, step: 1 },         // 偶数回合抱头防御的格挡

  // ---- 小怪 3:支援(唤灵者)----
  support_hp: { value: 20, min: 5, max: 80, step: 1 },
  support_buff: { value: 3, min: 1, max: 10, step: 1 },         // 每回合给全体同伴 +力量
  support_atk: { value: 5, min: 0, max: 20, step: 1 },

  // ---- 精英:盾墙 + 双快攻 ----
  elite_wall_hp: { value: 46, min: 10, max: 150, step: 2 },
  elite_wall_atk: { value: 7, min: 1, max: 30, step: 1 },       // 盾墙每回合 1 下
  elite_wall_block: { value: 8, min: 0, max: 30, step: 1 },     // 每回合自带格挡(打法:盾墙)
  elite_swarm_n: { value: 2, min: 1, max: 4, step: 1 },
  elite_swarm_hp: { value: 16, min: 5, max: 60, step: 1 },
  elite_swarm_atk: { value: 5, min: 1, max: 20, step: 1 },

  // ---- Boss:高伤 + 强化 ----
  boss_hp: { value: 110, min: 30, max: 400, step: 5 },
  boss_slam: { value: 18, min: 2, max: 50, step: 1 },           // 重击回合
  boss_buff: { value: 4, min: 1, max: 12, step: 1 },            // 强化回合:自身 +力量
  boss_add_hp: { value: 12, min: 5, max: 60, step: 1 },         // Boss 召的小怪 HP
  boss_add_atk: { value: 4, min: 1, max: 20, step: 1 },

  // ---- 奖励卡池(打法多样)----
  cleave_cost: { value: 1, max: 3, min: 0, step: 1 },   cleave_dmg: { value: 9, min: 1, max: 30, step: 1 },  // 横扫:全体小伤害
  ironwall_cost: { value: 2, max: 3, min: 0, step: 1 }, ironwall_block: { value: 14, min: 1, max: 40, step: 1 }, // 铁壁:大格挡
  double_cost: { value: 1, max: 3, min: 0, step: 1 },   double_per: { value: 4, min: 1, max: 20, step: 1 }, // 二连:单目标×2
  bash_cost: { value: 2, max: 3, min: 0, step: 1 },     bash_dmg: { value: 16, min: 1, max: 40, step: 1 },   // 重击:高价高伤
  curse_cost: { value: 0, max: 3, min: 0, step: 1 },    curse_amt: { value: 2, min: 1, max: 10, step: 1 },   // 诅咒:目标下回合 -力量(易伤)
  shiv_cost: { value: 0, max: 3, min: 0, step: 1 },     shiv_dmg: { value: 4, min: 1, max: 20, step: 1 },    // 飞刀:0 费
  rally_cost: { value: 1, max: 3, min: 0, step: 1 },    rally_amt: { value: 3, min: 1, max: 10, step: 1 },   // 鼓舞:全体 +力量(本回合)
};
