// PROTOTYPE - NOT FOR PRODUCTION
// Question: 宽容的跳跃 + 看形状就知道怎么过的障碍,满速穿缝能不能一直爽下去?
// Date: 2026-11-26
// Every tuning value lives here, each with value, min, max and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },

  // 跳跃手感
  gravity:    { value: 2600, min: 1500, max: 4000, step: 50 },   // 重力 px/s²
  jump_v:     { value: 980, min: 700, max: 1300, step: 20 },     // 起跳速度 px/s
  hold_lift:  { value: 0.52, min: 0.3, max: 0.8, step: 0.02 },   // 按住时上升段重力乘数(按住=跳更高)
  jump_cut:   { value: 0.45, min: 0.2, max: 0.8, step: 0.05 },   // 松手截断:上升中松跳键,竖直速度乘数(短跳)
  coyote:     { value: 0.09, min: 0.03, max: 0.2, step: 0.01 },  // 土狼时间:离地后仍可起跳的宽容秒
  buffer:     { value: 0.12, min: 0.04, max: 0.25, step: 0.01 }, // 预按缓存:落地前按跳的缓存秒
  slide_time: { value: 0.5, min: 0.25, max: 0.9, step: 0.05 },   // 滑铲持续秒
  fastfall:   { value: 1300, min: 600, max: 2200, step: 50 },    // 空中按下的额外下坠速度 px/s

  // 速度阶梯
  speed0:     { value: 340, min: 240, max: 480, step: 10 },      // 起始跑速 px/s
  speed_mult: { value: 1.13, min: 1.05, max: 1.3, step: 0.01 },  // 每档速度乘数
  tier_time:  { value: 20, min: 8, max: 40, step: 1 },           // 每档持续秒
  speed_max:  { value: 900, min: 600, max: 1200, step: 20 },     // 速度上限 px/s

  // 路段与拾取
  gap_base:   { value: 2.2, min: 1.2, max: 3.5, step: 0.1 },     // 路段之间安全空隙(秒,按当前速度换算成 px)
  pickup_r:   { value: 30, min: 20, max: 60, step: 2 },          // 金币拾取半径 px
  streak_time:{ value: 2, min: 1, max: 4, step: 0.5 },           // 连拾金币升调的保持秒
};
