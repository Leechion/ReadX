// PROTOTYPE - NOT FOR PRODUCTION
// Question: 吃—长—躲这一下滚雪球,本身好不好玩?
// Date: 2026-11-23
// Every tuning value lives here, each with value, min, max and step. The game reads them live
// through tune.<name> (index.html); the tweak panel, an add-on, writes them back here.
window.CONFIG = {
  seed: 1, // every gameplay random call reads rng(), seeded from this (or ?seed= in the address)
  volume: { value: 0.5, min: 0, max: 1, step: 0.05 },
  arena_r: { value: 1500, min: 800, max: 2600, step: 50 }, // petri dish radius, world px
  start_r: { value: 26, min: 14, max: 50, step: 2 }, // player's birth radius
  base_speed: { value: 330, min: 150, max: 600, step: 10 }, // px/s at birth size
  speed_pow: { value: 0.45, min: 0.2, max: 0.8, step: 0.05 }, // bigger = slower: (start/r)^this
  grow_step: { value: 60, min: 20, max: 120, step: 5 }, // radius gain per pellet: grow_step / r
  eat_margin: { value: 0.5, min: 0, max: 0.9, step: 0.05 }, // must be visibly inside to eat
  kill_margin: { value: 0.4, min: 0, max: 0.9, step: 0.05 }, // a threat must visibly swallow you
  threat_ratio: { value: 1.08, min: 1.01, max: 1.3, step: 0.01 }, // r > yours x this = threat
  pellet_n: { value: 90, min: 30, max: 200, step: 5 }, // food pellets kept on the dish
  pellet_r: { value: 9, min: 5, max: 16, step: 1 },
  rival_n0: { value: 7, min: 2, max: 16, step: 1 }, // rivals at birth
  rival_max: { value: 30, min: 8, max: 60, step: 2 },
  spawn_t0: { value: 6, min: 2, max: 15, step: 0.5 }, // s between rival spawns before the ramp
  spawn_t1: { value: 2, min: 0.5, max: 6, step: 0.25 }, // ...and once fully ramped
  ramp_t: { value: 25, min: 5, max: 60, step: 1 }, // density ramp starts (s)
  ramp_end: { value: 90, min: 30, max: 200, step: 5 }, // fully ramped (s)
  big0: { value: 0.25, min: 0.05, max: 0.6, step: 0.05 }, // share of bigger rivals when spawning
  big1: { value: 0.5, min: 0.2, max: 0.8, step: 0.05 }, // ...once ramped
  graze_t: { value: 14, min: 5, max: 40, step: 1 }, // the first big near-miss passes at (s)
  zoom_ref: { value: 90, min: 50, max: 160, step: 5 }, // camera scale: zoom_ref / (r + 40)
  zoom_min: { value: 0.34, min: 0.2, max: 0.6, step: 0.02 },
  zoom_max: { value: 1.25, min: 0.8, max: 2, step: 0.05 },
  dust_n: { value: 46, min: 0, max: 120, step: 2 }, // drifting motes in the water
  trail_base: { value: 8, min: 0, max: 30, step: 1 }, // membrane trail: base + r / trail_k
  trail_k: { value: 10, min: 2, max: 30, step: 1 },
  wobble_amp: { value: 0.06, min: 0, max: 0.15, step: 0.005 }, // membrane tremble, x radius
};
