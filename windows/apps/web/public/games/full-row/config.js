// PROTOTYPE - NOT FOR PRODUCTION
// Question: 干脆的移动+消行节奏,能不能让人一局接一局?
// Date: 2026-11-23
// Every tuning value lives here, each with value, min, max and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },
  cell: { value: 30, min: 24, max: 36, step: 2 }, // px per grid cell (10 x 20 well)
  gravity: { value: 0.9, min: 0.2, max: 1.5, step: 0.05 }, // seconds per row, level 1
  gravity_min: { value: 0.06, min: 0.03, max: 0.2, step: 0.01 }, // floor of the ramp
  speed_mult: { value: 0.82, min: 0.6, max: 0.95, step: 0.01 }, // gravity x this per level
  round_speed: { value: 0.92, min: 0.8, max: 1, step: 0.01 }, // gravity x this per successive round
  level_lines: { value: 10, min: 5, max: 20, step: 1 }, // rows cleared per level-up
  soft_mult: { value: 12, min: 4, max: 30, step: 1 }, // soft drop: gravity / this
  lock_delay: { value: 0.5, min: 0.1, max: 1, step: 0.05 }, // s resting before locking
  lock_resets: { value: 15, min: 1, max: 30, step: 1 }, // moves that re-arm the lock timer
  das_delay: { value: 0.16, min: 0.05, max: 0.4, step: 0.01 }, // hold before the fast slide
  das_rate: { value: 0.045, min: 0.02, max: 0.15, step: 0.005 }, // s per slide step once going
  buffer_time: { value: 0.15, min: 0.05, max: 0.3, step: 0.01 }, // a turn pressed just before a piece appears is kept
  flash_time: { value: 0.3, min: 0.1, max: 0.6, step: 0.05 }, // the cleared row's white flash
  beat_time: { value: 0.15, min: 0, max: 0.5, step: 0.05 }, // the hold before the stack drops
  drop_time: { value: 0.15, min: 0.05, max: 0.4, step: 0.05 }, // the stack's settle + shake
  score_base: { value: 100, min: 50, max: 400, step: 25 }, // x1 / x3 / x6 / x12 rows, x level
  glow_time: { value: 0.35, min: 0.1, max: 0.8, step: 0.05 }, // the hard-drop landing's warm light
};
