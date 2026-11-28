// PROTOTYPE - NOT FOR PRODUCTION
// Question: 第一次点击就见效、每个购买都看得见,十分钟内能不能跑完'点→雇→翻倍→转生'一整圈?
// Date: 2026-11-26
// Every tuning value lives here, each with value, min, max and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },

  click_base:     { value: 2, min: 1, max: 10, step: 1 },        // 每次点击的基础进账(另加每秒的 10%)
  cost_mult:      { value: 1.15, min: 1.1, max: 1.3, step: 0.01 },  // 每雇一个,价格乘数
  mile_step:      { value: 25, min: 10, max: 50, step: 5 },      // 里程碑:每满 N 个
  mile_mult:      { value: 2, min: 1.5, max: 4, step: 0.5 },     // 里程碑产出乘数
  prestige_div:   { value: 10000, min: 2000, max: 50000, step: 1000 }, // 转生:除数(累计收入/除数)开方
  prestige_root:  { value: 0.5, min: 0.3, max: 0.8, step: 0.05 },   // 转生:开几次方根
  prestige_bonus: { value: 0.1, min: 0.02, max: 0.3, step: 0.01 },  // 每点声望的全局产出加成
  away_rate:      { value: 0.5, min: 0.2, max: 1, step: 0.05 },  // 离线收益效率(相对每秒)
  away_cap_h:     { value: 4, min: 1, max: 12, step: 1 },        // 离线收益时长上限(小时)
};
