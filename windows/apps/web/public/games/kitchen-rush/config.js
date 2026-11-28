// PROTOTYPE - NOT FOR PRODUCTION
// Question: 两人一个跑一个递的订单倒计时,能不能让人一边喊一边笑?
// Date: 2026-11-27
// Every tuning value lives here, each with value, min, max and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },

  move_speed:   { value: 240, min: 160, max: 340, step: 10 },  // 走动速度 px/s
  cook_time:    { value: 3.2, min: 1.5, max: 6, step: 0.1 },   // 上炉到熟 秒
  burn_time:    { value: 4.5, min: 2.5, max: 8, step: 0.5 },   // 熟后再待多久烧糊 秒
  order_secs:   { value: 26, min: 14, max: 40, step: 1 },      // 每单限时 秒
  order_ramp:   { value: 0.6, min: 0, max: 1.5, step: 0.1 },   // 每单限时缩短 秒
  order_min:    { value: 12, min: 8, max: 20, step: 1 },       // 限时下限 秒
  max_orders:   { value: 3, min: 2, max: 5, step: 1 },         // 墙上最多同时几张单
  double_from:  { value: 5, min: 3, max: 10, step: 1 },        // 第几单起出双料
  revive_secs:  { value: 1.2, min: 0.5, max: 2.5, step: 0.1 }, // 按住救人所需 秒
  bot_speed:    { value: 190, min: 120, max: 280, step: 10 },  // 机器人搭档速度 px/s
};