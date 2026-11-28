// PROTOTYPE - NOT FOR PRODUCTION
// Question: 无计时、可撤销的扫雷,还剩多少'想出来了'的爽感?
// Date: 2026-11-23
// Every tuning value lives here, each with value, min, max and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },
  // three tiers, graded by the reasoning depth the solver needs, not just board size
  t1_cols: { value: 9, min: 5, max: 12, step: 1 }, // 小盘: singles only
  t1_rows: { value: 9, min: 5, max: 12, step: 1 },
  t1_mines: { value: 10, min: 1, max: 25, step: 1 },
  t2_cols: { value: 12, min: 6, max: 16, step: 1 }, // 中盘: needs a pair (subset) step at least once
  t2_rows: { value: 9, min: 5, max: 14, step: 1 },
  t2_mines: { value: 20, min: 4, max: 40, step: 1 },
  t3_cols: { value: 14, min: 8, max: 18, step: 1 }, // 大盘: pair steps twice or more
  t3_rows: { value: 10, min: 6, max: 14, step: 1 },
  t3_mines: { value: 28, min: 8, max: 55, step: 1 },
  cell_px: { value: 46, min: 30, max: 60, step: 2 }, // board px per cell; the board is static, whole in view
  wave_gap: { value: 0.035, min: 0, max: 0.12, step: 0.005 }, // s between successive diagonals of the finish wave
  flip_dur: { value: 0.24, min: 0.08, max: 0.6, step: 0.02 }, // one cell's flip in seconds
  gen_tries: { value: 60, min: 10, max: 200, step: 5 }, // solver-verified regenerations before relaxing depth
  // sound: the brief's 一声轻响 finish
  chime_a: { value: 660, min: 200, max: 1200, step: 10 }, // finish chime first note, Hz
  chime_b: { value: 880, min: 200, max: 1400, step: 10 }, // ...and the fifth above it
};
