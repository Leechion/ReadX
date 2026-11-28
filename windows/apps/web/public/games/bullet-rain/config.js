// PROTOTYPE - NOT FOR PRODUCTION
// Question: 满屏弹幕里'擦边不中'的走位,本身爽不爽?
// Date: 2026-11-26
// Every tuning value lives here, each with value, min, max and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },

  player_speed: { value: 340, min: 220, max: 480, step: 10 }, // 走位速度 px/s
  hit_r:        { value: 7, min: 4, max: 14, step: 1 },       // 玩家判定点半径(比机身小,擦边不中)
  fire_gap:     { value: 0.15, min: 0.08, max: 0.3, step: 0.01 }, // 自动开火间隔秒
  bullet_v:     { value: 720, min: 500, max: 1000, step: 10 },    // 我方弹速 px/s
  dive_v:       { value: 260, min: 180, max: 380, step: 10 },     // 蜂群俯冲速度 px/s
  aimed_v:      { value: 300, min: 200, max: 420, step: 10 },     // 炮舰瞄准弹速 px/s
  ring_v:       { value: 220, min: 150, max: 320, step: 10 },     // 巨舰弹环速度 px/s
  elite_hp:     { value: 60, min: 30, max: 120, step: 5 },        // 巨舰耐久
  lives:        { value: 3, min: 1, max: 5, step: 1 },            // 命数
  invuln:       { value: 2, min: 1, max: 4, step: 0.5 },          // 中弹无敌秒
  bombs:        { value: 2, min: 1, max: 4, step: 1 },            // 每局炸弹数
};
