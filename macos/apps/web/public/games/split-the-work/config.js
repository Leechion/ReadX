// PROTOTYPE - NOT FOR PRODUCTION
// Question: 一个人会推、一个人会钻,必须轮流替对方按住门——两个人能不能真的分工?
// Date: 2026-11-27
// Every tuning value lives here, each with value, min, max and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },

  step_time: { value: 0.17, min: 0.09, max: 0.3, step: 0.01 },  // 走一格用多久 秒
  hold_gap:  { value: 0.13, min: 0.05, max: 0.35, step: 0.01 }, // 按住方向键时,两格之间的停顿 秒
  bot_step:  { value: 0.22, min: 0.12, max: 0.35, step: 0.01 }, // 机器人队友走一格用多久 秒
  clear_wait:{ value: 1.1, min: 0.4, max: 2, step: 0.1 },       // 过关后停多久进下一间 秒
  hint_time: { value: 4.5, min: 1, max: 8, step: 0.5 },         // 每间房开头的提示停留 秒
};
