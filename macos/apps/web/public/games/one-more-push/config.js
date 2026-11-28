// PROTOTYPE - NOT FOR PRODUCTION
// Question: 死角变暗提醒 + 撤销免费,顿悟型小关卡能不能让人一关接一关?
// Date: 2026-11-26
// Every tuning value lives here, each with value, min, max and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },

  tile:        { value: 72, min: 48, max: 96, step: 4 },     // 格子边长 px
  banner_time: { value: 0.7, min: 0.3, max: 2, step: 0.1 },  // 过关横幅停留秒
  dead_alpha:  { value: 0.45, min: 0.2, max: 0.8, step: 0.05 }, // 死角箱子的变暗程度
  hint_time:   { value: 2, min: 1, max: 5, step: 0.5 },      // "顶死角了"提示停留秒
};
