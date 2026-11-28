// PROTOTYPE - NOT FOR PRODUCTION
// Question: 碎砖的节奏 + 球速渐紧,能不能让人一局接一局?
// Date: 2026-11-26
// Every tuning value lives here, each with value, min, max, and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },

  ball_speed:   { value: 420, min: 300, max: 600, step: 10 },    // 球基础速度 px/s
  speed_max:    { value: 780, min: 600, max: 1000, step: 10 },   // 球速上限 px/s
  tier_bricks:  { value: 8, min: 4, max: 16, step: 1 },          // 每碎 N 块提速一档
  tier_mult:    { value: 1.06, min: 1.02, max: 1.15, step: 0.01 }, // 每档速度乘数
  wall_bonus:   { value: 40, min: 0, max: 120, step: 10 },       // 每面新墙的基础速加成 px/s
  paddle_w:     { value: 140, min: 80, max: 220, step: 10 },     // 板宽 px
  paddle_speed: { value: 760, min: 400, max: 1200, step: 20 },   // 键盘移板速度 px/s
  deflect_max:  { value: 65, min: 40, max: 80, step: 5 },        // 板边最大弹角(度)
  combo_step:   { value: 0.5, min: 0.1, max: 2, step: 0.1 },     // 连击每层的加成倍数
  lives:        { value: 3, min: 1, max: 5, step: 1 },           // 命数
};
