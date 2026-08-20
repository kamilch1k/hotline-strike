import * as THREE from 'three';
import { paintMasks } from './util.js';
import { LAYER } from '../physics/surfaces.js';

/**
 * Arcade arenas — `?map=strike` and `?map=holdout`.
 *
 * Built to the same one-surface, one-box-prototype rule as the shoot house, so
 * each is up in milliseconds. That constraint is the whole reason this game can
 * ship on a portal.
 *
 * COLOUR COMES FROM THE PALETTE, NOT FROM ASSETS. Every material here is an
 * existing entry in world/palette.js, baked procedurally at load. Downloading
 * textures would trade the property that makes this shippable — one
 * self-contained file, no external requests, which both portals require — for
 * colour that the palette already provides.
 *
 * Shared shape rules, learned from the shoot house:
 *   - every space has two ways out, so no room is a dead end
 *   - cover is ~1.1 m: chest height standing, full cover crouched, which is what
 *     makes the crouch button worth pressing
 *   - 0.7 m ledges are vaultable (MOVE.mantle.autoVaultMax), so a low block is a
 *     route rather than an obstacle
 */

const WALL_T = 0.35;
const DOOR = 2.4;

/**
 * A straight wall with doorways punched out of it, given as centres along the
 * wall's own axis — the way a floor plan is read, rather than as the surviving
 * segments, which is what the renderer needs.
 *
 * `mat` and `y` ride along to the box rows so a wall can be coloured and can sit
 * on top of a plinth.
 */
function wall(axis, fixed, a, b, h, doors = [], t = WALL_T, mat, y) {
  const out = [];
  const cuts = doors
    .filter((d) => d > a && d < b)
    .sort((p, q) => p - q)
    .flatMap((d) => [d - DOOR / 2, d + DOOR / 2]);
  const edges = [a, ...cuts, b];
  for (let i = 0; i < edges.length; i += 2) {
    const s = edges[i];
    const e = edges[i + 1];
    if (e - s <= 0.05) continue;
    const mid = (s + e) / 2;
    if (axis === 'x') out.push([mid, fixed, e - s, t, h, 0, mat, y]);
    else out.push([fixed, mid, t, e - s, h, 0, mat, y]);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  STRIKE — the round-based map.
 *
 *  Built to the oldest competitive shape there is, because it is the one every
 *  player already knows how to read: two spawns facing each other, TWO routes
 *  between them, and one contested objective where they meet.
 *
 *    LONG   the open north lane. Fast, no cover for the last 12 m, so taking it
 *           is a bet that nobody is already holding the site.
 *    SHORT  the south lane, through a building with two doors. Slower and
 *           blind, but you arrive with a wall at your back.
 * ────────────────────────────────────────────────────────────────────────── */
const STRIKE = [
  // perimeter, 64 x 44
  ...wall('x', 22, -32, 32, 5, [], 0.6, 'concrete'),
  ...wall('x', -22, -32, 32, 5, [], 0.6, 'concrete'),
  ...wall('z', -32, -22, 22, 5, [], 0.6, 'concrete'),
  ...wall('z', 32, -22, 22, 5, [], 0.6, 'concrete'),

  // The spine that splits long from short. One doorway at mid so the two lanes
  // are connected rather than parallel — without it the map is two corridors
  // and every round plays identically.
  ...wall('x', 2, -20, 20, 3.2, [-4], WALL_T, 'plaster_sand'),

  // SHORT — the south building. Two doors, so it is a route and never a trap.
  ...wall('x', -10, -14, 6, 3.2, [-4], WALL_T, 'plaster_cream'),
  ...wall('z', -14, -10, 2, 3.2, [-6], WALL_T, 'plaster_cream'),
  ...wall('z', 6, -10, 2, 3.2, [-6], WALL_T, 'plaster_cream'),

  // SITE — waist-high crates you fight over. Deliberately not a room: cover you
  // can shoot across beats cover you hide behind.
  [0, 10, 5, 1.2, 1.1, 0, 'wood_prop'],
  [-4, 14, 1.2, 4, 1.1, 0, 'wood_prop'],
  [4, 14, 1.2, 4, 1.1, 0, 'wood_prop'],
  [0, 17, 3.4, 1.2, 1.9, 0, 'metal_rust_prop'],

  // LONG — sparse cover, placed so the lane is crossable but never safe.
  [-16, 14, 3.4, 1.2, 1.1, 0.3, 'concrete_prop'],
  [16, 12, 3.4, 1.2, 1.1, -0.3, 'concrete_prop'],
  [-24, 8, 1.2, 5, 1.9, 0, 'plaster_blue'],
  [24, 8, 1.2, 5, 1.9, 0, 'plaster_pink'],

  // spawn-side cover, so neither team is shot the instant it appears
  [-27, -16, 4, 1.2, 1.1, 0, 'concrete_prop'],
  [27, -16, 4, 1.2, 1.1, 0, 'concrete_prop'],
  // vaultable ledges into the site
  [-7, 6, 3, 1, 0.7, 0, 'wood_prop'],
  [7, 6, 3, 1, 0.7, 0, 'wood_prop'],
];

const STRIKE_SPAWNS = [
  [-28, -18, 0.8, 'west spawn'],
  [-24, -19, 0.8, 'west spawn 2'],
  [28, -18, -0.8, 'east spawn'],
  [24, -19, -0.8, 'east spawn 2'],
  [-28, 18, Math.PI - 0.6, 'long west'],
  [28, 18, Math.PI + 0.6, 'long east'],
];

/* ────────────────────────────────────────────────────────────────────────── *
 *  HOLDOUT — the horde map.
 *
 *  Inverted from a versus layout. There is a CENTRE and an OUTSIDE, because the
 *  fight is one player against a tide arriving from all of it.
 *
 *  THE KEEP is raised 1.2 m on a plinth with ramps on three sides. Height is the
 *  whole mechanic: you shoot down into the crowd, they funnel up a ramp, and the
 *  moment you are pushed off the plinth you feel it. Three ramps, never one and
 *  never four — one is a choke you hold forever and the mode stops being a game,
 *  four means you are flanked whichever way you turn.
 *
 *  FOUR DISTRICTS, one per quadrant, each a different colour and a different
 *  fight. A grey box is not neutral, it is unreadable: with nothing to name, a
 *  player cannot say where they died or plan where to go next.
 *
 *    NE  MARKET   pink and cream stalls under red awnings, tight lanes
 *    NW  GARDEN   green hedges, the only soft cover on the map
 *    SW  YARD     stacked containers, hard angles, the one climb outside the keep
 *    SE  POOL     a sunken tiled basin — the only place BELOW you
 *
 *  Nothing above 3 m except the perimeter, so you can always read which side the
 *  next wave is on. That is the whole tension of a horde mode.
 * ────────────────────────────────────────────────────────────────────────── */

/** Plinth height. Also a vault, so being pushed off is not a death sentence. */
const PLINTH = 1.2;

const HOLDOUT = [
  // perimeter, 64 x 64 — square on purpose: no direction is the safe one
  ...wall('x', 32, -32, 32, 5, [], 0.6, 'concrete'),
  ...wall('x', -32, -32, 32, 5, [], 0.6, 'concrete'),
  ...wall('z', -32, -32, 32, 5, [], 0.6, 'concrete'),
  ...wall('z', 32, -32, 32, 5, [], 0.6, 'concrete'),

  /* ---- THE KEEP -------------------------------------------------------- */
  // Plinth: one low slab. Standing on it is the reward.
  [0, 0, 20, 20, PLINTH, 0, 'tile_floor', 0],
  // Parapet — waist high FROM THE PLINTH, a 2.2 m wall from below. One piece of
  // geometry doing both jobs.
  ...wall('x', 9.6, -9.6, 9.6, 1.0, [0], 0.4, 'plaster_cream', PLINTH),
  ...wall('x', -9.6, -9.6, 9.6, 1.0, [], 0.4, 'plaster_cream', PLINTH),
  ...wall('z', -9.6, -9.6, 9.6, 1.0, [0], 0.4, 'plaster_cream', PLINTH),
  ...wall('z', 9.6, -9.6, 9.6, 1.0, [0], 0.4, 'plaster_cream', PLINTH),
  /**
   * STAIRS up: north, west, east. South is solid, so there is always one edge
   * nothing climbs and you can put your back to it.
   *
   * Three steps of 0.4 m, NOT one 1.2 m slab. The first version of this was a
   * single box the height of the plinth, which is a 1.2 m vertical face — above
   * the step height the nav grid will connect across and above
   * MOVE.mantle.autoVaultMax. A flood fill of the grid showed exactly that: the
   * plinth top was a 713-cell ISLAND with no connection to the 5703-cell ground
   * ring, so nothing could path onto the keep and every agent fell back to
   * steering straight into the plinth wall. That is the "enemies walk into
   * walls" bug, and it was mine.
   */
  ...[0, 1, 2].flatMap((i) => {
    const h = 0.4 * (i + 1);
    const off = 15.5 - i * 2;
    return [
      [0, off, 4.4, 2, h, 0, 'concrete_dark', 0],
      [-off, 0, 2, 4.4, h, 0, 'concrete_dark', 0],
      [off, 0, 2, 4.4, h, 0, 'concrete_dark', 0],
    ];
  }),
  // Cover on the plinth — breaks the sightline across it, so a horde that gets
  // up has to come around something instead of straight at you.
  [-4, 3, 3.2, 1.1, 1.1, 0, 'wood_prop', PLINTH],
  [4, -3, 3.2, 1.1, 1.1, 0, 'wood_prop', PLINTH],
  [0, 0, 1.6, 1.6, 2.0, 0.4, 'metal_rust_prop', PLINTH],

  /* ---- NE: MARKET ------------------------------------------------------ */
  [20, 20, 5.5, 3.2, 2.6, 0.15, 'plaster_pink', 0],
  [26, 13, 3.2, 5.5, 2.6, -0.1, 'plaster_cream', 0],
  [14, 25, 5.5, 3.2, 2.6, 0.1, 'plaster_sand', 0],
  // Awnings: thin slabs at head height. Colour you fight UNDER, not just past.
  [20, 15.5, 6, 0.25, 0.3, 0, 'fabric_red', 2.3],
  [24.5, 20, 0.25, 6, 0.3, 0, 'fabric_red', 2.3],
  [15, 20.5, 5, 0.25, 0.3, 0, 'fabric_teal', 2.3],
  // stalls — waist-high, vaultable
  [17, 17, 2.6, 1.0, 1.05, 0.3, 'wood_prop', 0],
  [24, 24, 2.6, 1.0, 1.05, -0.3, 'wood_prop', 0],

  /* ---- NW: GARDEN ------------------------------------------------------ */
  [-19, 19, 7, 1.2, 1.05, 0, 'foliage', 0],
  [-19, 25, 7, 1.2, 1.05, 0, 'foliage', 0],
  [-25, 19, 1.2, 7, 1.05, 0, 'foliage', 0],
  [-14, 24, 1.2, 5, 1.05, 0.2, 'foliage', 0],
  // planter walls: the hard cover the hedges are not
  [-22, 14, 6, 0.8, 0.7, 0, 'plaster_blue', 0],
  [-27, 26, 4, 0.8, 1.9, 0.4, 'plaster_blue', 0],

  /* ---- SW: YARD -------------------------------------------------------- */
  [-20, -18, 6.5, 2.6, 2.6, 0, 'metal_green', 0],
  [-20, -24, 6.5, 2.6, 2.6, 0.06, 'metal_blue', 0],
  [-26, -14, 2.6, 6.5, 2.6, 0, 'metal_rust', 0],
  [-13, -22, 2.6, 6.5, 2.6, -0.05, 'metal_rust', 0],
  // stacked: the only climb outside the keep, reached by vaulting the low crate
  [-20, -18, 5.5, 2.2, 2.4, 0, 'metal_rust', 2.6],
  [-15.5, -18, 1.6, 2.2, 1.3, 0, 'wood_prop', 0],

  /* ---- SE: POOL -------------------------------------------------------- */
  // A basin with a raised rim: the rim is cover, the inside is a place you can
  // be cornered. Tiled, so it reads as somewhere else the instant you see it.
  // The north rim is SPLIT: a sealed rectangle is a room with no door, and the
  // flood fill found the inside of it as its own dead component. A 4 m gap makes
  // it a place you can be pushed into and fight your way out of.
  [15.5, -20, 5, 0.8, 0.9, 0, 'tile_floor', 0],
  [24.5, -20, 5, 0.8, 0.9, 0, 'tile_floor', 0],
  [20, -27, 14, 0.8, 0.9, 0, 'tile_floor', 0],
  [14, -23.5, 0.8, 8, 0.9, 0, 'tile_floor', 0],
  [27, -23.5, 0.8, 8, 0.9, 0, 'tile_floor', 0],
  // diving platform — elevation in the corner furthest from safety
  [25, -14, 4, 4, 2.2, 0, 'plaster_cream', 0],

  /* ---- approach cover, all four gates ---------------------------------- */
  [0, 24, 6, 1.1, 1.05, 0, 'concrete_prop', 0],
  [0, -24, 6, 1.1, 1.05, 0, 'concrete_prop', 0],
  [-24, 0, 1.1, 6, 1.05, 0, 'concrete_prop', 0],
  [24, 0, 1.1, 6, 1.05, 0, 'concrete_prop', 0],
  // vaultable ledges, so a cornered player always has one way out
  [-12, -12, 3, 1, 0.7, 0.5, 'wood_prop', 0],
  [12, 12, 3, 1, 0.7, 0.5, 'wood_prop', 0],
];

/**
 * Player on the plinth, then the ring. `populate()` ranks spawns by distance
 * from the player and garrisons the far half, so putting the keep first and the
 * corners last makes a horde arrive from the perimeter with no mode-specific
 * code.
 */
const HOLDOUT_SPAWNS = [
  [0, 4, 0, 'the keep'],
  [-27, 27, -2.4, 'garden'],
  [27, 27, 2.4, 'market'],
  [-27, -27, -0.7, 'yard'],
  [27, -27, 0.7, 'pool'],
  [0, 29, Math.PI, 'north gate'],
];

/**
 * A stepped ramp, because a box only rotates about Y — there is no pitch, so a
 * slope has to be built out of treads. 0.35 m rises are climbed by the character
 * controller without a mantle, which is what makes an elevation change a ROUTE
 * rather than a wall.
 *
 * `dir` is the axis the ramp climbs along: 'x' or 'z'. `sign` is +1 or -1 for
 * the direction of ascent, so the top tread is the one nearest the platform.
 */
function ramp(x, z, width, dir, steps, mat, sign = 1, rise = 0.35, tread = 1.6) {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const h = rise * (i + 1);
    const off = (i + 0.5) * tread * sign;
    if (dir === 'x') out.push([x + off, z, tread, width, h, 0, mat, 0]);
    else out.push([x, z + off, width, tread, h, 0, mat, 0]);
  }
  return out;
}

/**
 * A ROOF. The reason rooms could not have one until now.
 *
 * The nav grid ray-casts DOWN from above and takes the first surface it meets,
 * so an ordinary lid over a room makes the grid read "floor = the roof" and the
 * interior stops existing as far as pathing is concerned — a stacked floor, the
 * failure this whole map style was bent around avoiding.
 *
 * A roof emitted here goes on LAYER.SHOOT_ONLY instead of LAYER.STATIC, and the
 * masks in physics/surfaces.js do the rest:
 *   MASK.BULLET    includes SHOOT_ONLY -> it stops bullets, like a real roof
 *   MASK.WORLD     does not            -> the nav grid never sees it
 *   MASK.CHARACTER does not            -> nobody can stand on top of it
 * So the room below stays walkable and the lid is still a lid.
 *
 * KNOWN LIMIT, because it is worth knowing rather than discovering: MASK.SIGHT
 * does not include SHOOT_ONLY either, so an AI can technically see a target
 * through a roof. Its shot still hits the roof. Bring SHOOT_ONLY into SIGHT if
 * that ever reads badly in play.
 */
function roof(x, z, w, d, mat, y, t = 0.3, ry = 0) {
  return [{ roof: true, x, z, w, d, t, ry, mat, y }];
}

/**
 * A REAL SLOPE — a pitched slab, not a stack of treads.
 *
 * `buildArena` only ever emitted axis-aligned boxes because the row format has
 * one rotation field and it is yaw. But the accumulator underneath takes a full
 * MATRIX for both the visual and the collision copy, so a pitched ramp was
 * always expressible; nothing had asked for it. Rises `rise` over `len` along
 * `dir`, and the TOP FACE is the surface you walk, so `y` means the same thing
 * it does everywhere else in this file: the height the ramp starts at.
 *
 * Keep the pitch gentle. The nav grid drops any cell whose floor normal is
 * flatter than `maxSlope`, and the character controller has its own slopeLimit;
 * about 1 in 5 is comfortable, 1 in 3 is the practical ceiling.
 */
function slope(x, z, w, len, rise, mat, y = 0, dir = 'z', t = 0.7) {
  return [{ slope: true, x, z, w, len, rise, t, mat, y, dir }];
}

/**
 * A flight of steps that STARTS ON SOMETHING. `ramp` always sits on the ground,
 * which is fine for a single terrace and useless once a map has topography: the
 * climb from a 1.4 platform to a 2.8 one has to begin at 1.4, not at 0.
 *
 * `base` is the height the flight departs from; each tread is drawn as a solid
 * box from `base` up, so the run reads as cut stone rather than as floating
 * slabs. `sign` is the direction of travel, and the LAST tread is the one that
 * lands on the upper deck — place the call so that tread finishes flush with
 * the platform edge, or the top of the flight is a lip the nav grid treats as
 * a wall.
 */
function steps(x, z, width, dir, n, mat, sign = 1, base = 0, rise = 0.35, tread = 1.6) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const h = rise * (i + 1);
    const off = (i + 0.5) * tread * sign;
    if (dir === 'x') out.push([x + off, z, tread, width, h, 0, mat, base]);
    else out.push([x, z + off, width, tread, h, 0, mat, base]);
  }
  return out;
}

/**
 * DRESSING KITS — small clusters of boxes that read as one object.
 *
 * A map made of single boxes reads as a greybox no matter how well it plays,
 * because real objects are never one volume: an air handler is a body, a louvre
 * band and a cap, and it is the BAND that tells you what it is. These emit three
 * or four rows each and are the cheapest way to buy that read.
 *
 * Every child is CONCENTRIC with its parent so `rot` can be passed straight
 * through — an offset child would need the offset rotated too, and that is a
 * transform stack this format deliberately does not have.
 *
 * THE MATERIAL COUNT IS THE BUDGET, not the box count. Prewarm is rebuilt per
 * map, so a material that is new TO THIS MAP costs shader programs at boot and
 * its own draw batch every frame — Miami went 80 -> 90 programs when this kit
 * first landed with five. It now uses two that were not already on the roof
 * (`steel`, `foliage`) and borrows `neon_white` for everything else. Reach for
 * a material already in the map's list before adding one.
 */

/** Rooftop air handler. The one prop that says "roof" rather than "floor". */
function hvac(x, z, w, d, h, rot = 0) {
  return [
    [x, z, w, d, h, rot, 'steel', 0],
    // Louvre band, proud of the body so it catches its own shadow line.
    [x, z, w * 1.04, d * 1.04, h * 0.3, rot, 'steel', h * 0.42],
    // Cap plate, overhanging — an overhang is what makes a lid look like a lid.
    [x, z, w * 1.12, d * 1.12, 0.12, rot, 'steel', h],
  ];
}

/**
 * Planter. Chest-high rims are cover; these are 0.55 so they are furniture the
 * player can see over and vault, and the foliage above is visual only.
 */
function planter(x, z, w, d, rot = 0) {
  return [
    [x, z, w, d, 0.55, rot, 'neon_white', 0],
    [x, z, w * 0.86, d * 0.86, 0.75, rot, 'foliage', 0.5],
  ];
}

/**
 * Pergola — four posts and a slatted lid. Shade structures do a lot of work:
 * they frame a space as designed, and the slats break the sun into stripes,
 * which is the strongest "this is a built place" cue available for free.
 *
 * Not rotatable: the posts are offset from centre, so `rot` would need the
 * offsets rotated with it. No caller needs it, so it does not exist.
 */
function pergola(x, z, w, d, h = 2.6, slats = 5) {
  const hx = w / 2 - 0.2;
  const hz = d / 2 - 0.2;
  const out = [
    [x - hx, z - hz, 0.28, 0.28, h, 0, 'neon_white', 0],
    [x + hx, z - hz, 0.28, 0.28, h, 0, 'neon_white', 0],
    [x - hx, z + hz, 0.28, 0.28, h, 0, 'neon_white', 0],
    [x + hx, z + hz, 0.28, 0.28, h, 0, 'neon_white', 0],
    // beams along the long edges, tying the posts together
    [x, z - hz, w, 0.3, 0.28, 0, 'neon_white', h],
    [x, z + hz, w, 0.3, 0.28, 0, 'neon_white', h],
  ];
  for (let i = 0; i < slats; i++) {
    const t = (i + 0.5) / slats - 0.5;
    out.push([x + t * w, z, 0.22, d, 0.18, 0, 'neon_white', h + 0.1]);
  }
  return out;
}

/** Parasol: post plus canopy. Reads as a pool deck from anywhere on the map. */
function parasol(x, z) {
  return [
    [x, z, 0.18, 0.18, 2.3, 0, 'neon_white', 0],
    [x, z, 3.2, 3.2, 0.16, 0, 'neon_white', 2.3],
  ];
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  MIAMI — "SKYLINE". A ROOFTOP COMPLEX WITH REAL TOPOGRAPHY.
 *
 *  The previous pass was a flat square with thin walls stood on it, and it read
 *  as exactly that: one plane, one elevation, cover scattered about. The fix is
 *  not more props. It is to STOP TREATING THE GROUND AS THE MAP.
 *
 *  Everything here is built UP from the deck in four bands, and the low ground
 *  is what is left between the blocks rather than a floor the level sits on:
 *
 *      4.2   antenna deck            the one place that overlooks everything
 *      2.8   CT DECK (north)         high ground, reached by the grand stair
 *      1.4   WEST WING / EAST WING   the two raised flanks, built on
 *      0.0   MID, TUNNEL, SOUTH      the canyon floor you start on
 *
 *  That is where the height comes from, and it is also where the passages come
 *  from: TUNNEL is not a wall with deck beside it, it is a 5 m slot at ground
 *  level between two 1.4 m platforms with 3 m walls on top of them — 4.4 m of
 *  stone either side of you, which is a trench you fight along, not a lane.
 *
 *      z=+33  ┌────────────┬───────────────────┬────────────┐
 *             │  B SITE    │     CT DECK 2.8   │  A SITE    │
 *             │  (indoor)  │   ▲ grand stair   │  (indoor)  │
 *      z=+22  │  west wing ├───────────────────┤ east wing  │
 *             │    1.4     │                   │    1.4     │
 *      z=+12  │            │       MID         ├────────────┤
 *             │            │       0.0         │  TUNNEL 0.0│  ← 5 m trench
 *      z=+7   │            │                   ├────────────┤
 *             │            │                   │ east wing  │
 *      z=-9   ├────────────┴───────────────────┴────────────┤
 *             │             SOUTH DECK 0.0 (spawn)          │
 *      z=-33  └─────────────────────────────────────────────┘
 *
 *  NO ROOFED TUNNELS, and that is a hard engine limit rather than a choice: the
 *  nav grid is a single 2-D height field, so a walkable floor above a walkable
 *  floor gives an agent two surfaces at one x/z and pathing takes whichever it
 *  sampled. Every climb here is an open stair and nothing is ever underneath
 *  anything. Vertigo's stacked levels need a second grid, which is a rewrite.
 *
 *  Twelve materials, all of them already on this roof. A material new to a map
 *  buys shader programs at boot and its own draw batch per frame.
 * ────────────────────────────────────────────────────────────────────────── */
const MIAMI = [
  // Roof edge. Waist high so it reads as a parapet and still blocks a fall.
  ...wall('x', -33, -33, 33, 1.15, [], 0.6, 'neon_white', 0),
  ...wall('z', -33, -33, 33, 1.15, [], 0.6, 'neon_white', 0),
  ...wall('z', 33, -33, 33, 1.15, [], 0.6, 'neon_white', 0),
  [0, -33, 66, 0.8, 0.12, 0, 'steel', 1.15],
  [-33, 0, 0.8, 66, 0.12, 0, 'steel', 1.15],
  [33, 0, 0.8, 66, 0.12, 0, 'steel', 1.15],

  /* ══ TERRAIN ══════════════════════════════════════════════════════════════
   * The four blocks the whole map is cut from. Everything after this sits ON
   * one of them, and the gaps between them ARE the low ground — mid, the
   * trench and the south deck are not built, they are what was left.
   */
  // WEST WING, 1.4 — solid, and the B building stands on it.
  [-24, 12, 18, 42, 1.4, 0, 'neon_white', 0],
  // EAST WING, 1.4 — split in two so the trench can run between the halves.
  [24, -1, 18, 16, 1.4, 0, 'neon_white', 0],
  [24, 17, 18, 10, 1.4, 0, 'neon_white', 0],
  // CT DECK, 2.8 — north, spanning both wings. The high ground.
  [0, 27.5, 30, 11, 2.8, 0, 'neon_white', 0],
  // Antenna deck, 4.2 — small, and the only thing above the CT deck.
  [0, 31, 9, 4, 1.4, 0, 'neon_cyan', 2.8],
  ...steps(0, 24.4, 5, 'z', 4, 'neon_cyan', 1, 2.8),

  /* ══ CLIMBS ═══════════════════════════════════════════════════════════════
   * Six ways up, because a map whose high ground has one stair is a map with
   * one fight in it. Each flight lands flush with its deck; a lip at the top is
   * a wall as far as the nav grid is concerned.
   */
  // south deck -> west wing, and -> east wing
  ...steps(-24, -15.6, 8, 'z', 4, 'neon_purple', 1, 0),
  ...steps(24, -15.6, 8, 'z', 4, 'neon_purple', 1, 0),
  // mid -> west wing (climb west), mid -> east wing north (climb east)
  ...steps(-8.6, 4, 8, 'x', 4, 'neon_purple', -1, 0),
  ...steps(8.6, 18, 8, 'x', 4, 'neon_purple', 1, 0),
  // THE GRAND STAIR: mid all the way to the CT deck, 8 treads, 2.8 m.
  // It is the widest thing on the map because it is the fight everyone wants.
  ...steps(0, 9.2, 11, 'z', 8, 'neon_purple', 1, 0),
  // trench -> east wing north, at the trench's far end
  ...steps(30, 6.4, 5, 'z', 4, 'neon_purple', 1, 0),

  /* ══ TUNNEL — the trench ══════════════════════════════════════════════════
   * 5 m wide at ground level with a 1.4 platform either side and a 3 m wall on
   * top of each: 4.4 m of stone, no sky at the sides, one way in from mid and
   * one stair out at the east end. This is the slow route and it is blind.
   */
  ...wall('x', 7, 15, 33, 3.0, [], WALL_T, 'neon_white', 1.4),
  ...wall('x', 12, 15, 33, 3.0, [26], WALL_T, 'neon_white', 1.4),
  // Mouth markers, so the trench is findable from mid.
  [15.2, 9.5, 0.3, 5, 0.14, 0, 'lamp_lens', 0],
  [22, 9.5, 1.1, 1.1, 1.1, 0.3, 'neon_orange', 0],
  [27, 9.5, 1.1, 1.1, 0.7, -0.2, 'neon_pink', 0],

  /* ══ B SITE — the west building, on the west wing ═════════════════════════
   * A real interior: two rooms, three doors, and a window slot onto mid. You
   * take it by going inside, which is what makes it different from A.
   */
  ...wall('x', 14, -32, -16, 3.2, [-28, -20], WALL_T, 'neon_pink', 1.4),
  ...wall('x', 28, -32, -16, 3.2, [-24], WALL_T, 'neon_pink', 1.4),
  ...wall('z', -32, 14, 28, 3.2, [], WALL_T, 'neon_pink', 1.4),
  ...wall('z', -16, 14, 28, 3.2, [18, 25], WALL_T, 'neon_pink', 1.4),
  // internal divider — two rooms, offset doors, no through-shot
  ...wall('x', 21, -32, -16, 2.8, [-26], WALL_T, 'neon_white', 1.4),
  // cover inside, on the platform
  [-29, 17, 2.6, 1.1, 1.05, 0, 'neon_orange', 1.4],
  [-19, 25, 1.1, 2.6, 1.05, 0, 'neon_orange', 1.4],
  [-25, 24, 1.6, 1.6, 0.7, 0.4, 'neon_pink', 1.4],

  /* ══ A SITE — the east building, on the east wing ═════════════════════════
   * Open-sided instead of enclosed: a canopy on posts over the site, so it is
   * held from cover rather than from inside a room. The counterpart to B.
   */
  ...wall('x', 13, 17, 31, 3.0, [21, 27], WALL_T, 'neon_teal', 1.4),
  ...wall('z', 31, 13, 21, 3.0, [], WALL_T, 'neon_teal', 1.4),
  // canopy: four posts and a slab, at head height above the platform
  [19, 16, 0.4, 0.4, 2.6, 0, 'steel', 1.4],
  [29, 16, 0.4, 0.4, 2.6, 0, 'steel', 1.4],
  [19, 20, 0.4, 0.4, 2.6, 0, 'steel', 1.4],
  [29, 20, 0.4, 0.4, 2.6, 0, 'steel', 1.4],
  /**
   * AN OPEN FRAME, NOT A SLAB. A solid 12x6 roof here was a walkable surface at
   * 4.25 m directly over the 1.4 m platform — a stacked floor, the one thing
   * this map's whole shape exists to avoid. The nav grid takes the FIRST
   * surface a downward ray meets, so the whole of A site read as "floor at
   * 4.25" and the platform underneath stopped existing as far as pathing was
   * concerned. HOLDOUT's awnings get away with the same trick only because they
   * are 0.25 m strips and shadow almost nothing. Beams, therefore: same read
   * from below, no meaningful footprint from above.
   */
  [24, 15.4, 12, 0.35, 0.28, 0, 'neon_teal', 4.0],
  [24, 18, 12, 0.35, 0.28, 0, 'neon_teal', 4.0],
  [24, 20.6, 12, 0.35, 0.28, 0, 'neon_teal', 4.0],
  [19, 18, 0.35, 6, 0.28, 0, 'neon_teal', 4.0],
  [29, 18, 0.35, 6, 0.28, 0, 'neon_teal', 4.0],
  // cover under it
  [21, 18.5, 2.6, 1.1, 1.05, 0, 'neon_orange', 1.4],
  [27.5, 17, 1.1, 2.6, 1.05, 0, 'neon_orange', 1.4],
  [24, 21, 1.6, 1.6, 0.7, -0.3, 'neon_pink', 1.4],

  /* ══ CT DECK — the high ground ════════════════════════════════════════════
   * A parapet along its south face makes it waist-high from above and a 4.2 m
   * wall from mid: one piece of geometry doing both jobs. The two gaps are
   * where the grand stair and the wing stairs arrive.
   */
  ...wall('x', 22, -15, 15, 1.0, [0], 0.4, 'neon_white', 2.8),
  [-11, 26, 2.6, 1.1, 1.05, 0, 'neon_orange', 2.8],
  [11, 26, 2.6, 1.1, 1.05, 0, 'neon_orange', 2.8],
  /**
   * NO CAP PLATE ON THE ANTENNA DECK. A 0.16 m trim slab across the top turned
   * the last stair rise into 3.85 -> 4.36, and 0.51 m is past what the nav grid
   * will step: the deck became an island reachable by nothing. A decorative
   * slab laid over the landing of a flight is a step-height change, so trim
   * either stays off the top surface or comes out of the deck's own height.
   */
  // wing -> CT deck, one flight each side, starting at 1.4
  ...steps(-17.5, 27.5, 6, 'x', 4, 'neon_purple', 1, 1.4),
  ...steps(17.5, 27.5, 6, 'x', 4, 'neon_purple', -1, 1.4),

  /* ══ MID — the canyon floor ═══════════════════════════════════════════════
   * Ground level between two 1.4 m walls of platform, with the CT deck closing
   * the north end 2.8 m up. Crates are the only high ground down here and they
   * are climbable: 0.7 onto 1.4 puts you on the wing without using a stair.
   */
  [-6, -2, 3.2, 3.2, 0.7, 0, 'neon_orange', 0],
  [-6, 1.4, 3.2, 3.2, 1.4, 0, 'neon_orange', 0],
  [7, 6, 3.2, 3.2, 0.7, 0.2, 'neon_pink', 0],
  [7, 9.4, 3.2, 3.2, 1.4, 0.2, 'neon_pink', 0],
  [-9, 14, 4.4, 1.1, 1.1, 0, 'neon_orange', 0],
  [10, -4, 1.1, 4.4, 1.1, 0, 'neon_orange', 0],
  [0, 4, 5, 1.1, 0.7, 0, 'neon_cyan', 0],
  // the pool, flush with the canyon floor
  [-3, -12, 13, 7, 0.05, 0, 'neon_cyan', 0],
  [-3, -8.3, 13.4, 0.28, 0.12, 0, 'window_glow', 0],
  [-3, -15.7, 13.4, 0.28, 0.12, 0, 'window_glow', 0],

  /* ══ SOUTH DECK — spawn ═══════════════════════════════════════════════════
   * The emptiest ground on the map on purpose: it is where you fall back to,
   * and cover here would let a player hold it and never see the level.
   */
  ...planter(-26, -28, 6, 1.4),
  ...planter(0, -30, 8, 1.4),
  ...planter(26, -28, 6, 1.4),
  ...parasol(-12, -24),
  ...parasol(13, -24),
  [0, -20, 6, 1.1, 0.7, 0, 'neon_pink', 0],
  // lane mouths, colour-coded from spawn
  [-24, -19.6, 16, 0.3, 0.14, 0, 'emissive_warm', 0],
  [0, -19.6, 12, 0.3, 0.14, 0, 'window_glow', 0],
  [24, -19.6, 16, 0.3, 0.14, 0, 'lamp_lens', 0],

  /* ══ MACHINERY & NEON ═════════════════════════════════════════════════════ */
  ...hvac(-30, -6, 4.0, 3.0, 1.8, 0.18),
  ...hvac(30, -6, 3.4, 2.6, 1.5),
  ...planter(-20, 30, 5, 1.4),
  ...planter(20, 30, 5, 1.4),
  [0, 32.6, 28, 0.3, 0.14, 0, 'window_glow', 2.8],
  [-24, 32.6, 16, 0.3, 0.14, 0, 'emissive_warm', 1.4],
  [24, 32.6, 16, 0.3, 0.14, 0, 'emissive_warm', 1.4],
  // mast on the antenna deck — the map's landmark, visible from the whole roof
  [0, 31, 0.24, 0.24, 6.0, 0, 'steel', 4.2],
  [0, 31, 1.4, 0.16, 0.14, 0, 'steel', 9.4],
];

/**
 * Spread across all four elevations and every lane, never inside a building and
 * never on a stair. In horde mode these are also where the wave arrives from,
 * so clustering them would make every wave come from one bearing.
 */
const MIAMI_SPAWNS = [
  [0, -27, 0, 'south deck'],
  [-24, -4, 0.4, 'west wing'],
  [24, -4, -0.4, 'east wing'],
  [0, 2, 0, 'mid'],
  [24, 9.5, Math.PI, 'tunnel'],
  [0, 25, Math.PI, 'ct deck'],
];

/* ────────────────────────────────────────────────────────────────────────── *
 *  ZONE — the Soviet works.
 *
 *  Cracked concrete, panel blocks and rusted steel: a decommissioned plant with
 *  a yard around it. Same terrace rule as MIAMI — the loading dock and the
 *  substation roof are raised and ramped, never stacked over anything.
 *
 *  Shape is a broken ring: three buildings around a central yard with gaps
 *  between them, so a horde arrives from several bearings at once and the
 *  player can always break line of sight by rounding a corner rather than by
 *  finding the one correct door.
 * ────────────────────────────────────────────────────────────────────────── */
const ZONE = [
  // perimeter fence — corrugated, with two gaps that read as ways out
  ...wall('x', -35, -35, 35, 2.4, [-12, 14], 0.3, 'corrugated', 0),
  ...wall('x', 35, -35, 35, 2.4, [0], 0.3, 'corrugated', 0),
  ...wall('z', -35, -35, 35, 2.4, [10], 0.3, 'corrugated', 0),
  ...wall('z', 35, -35, 35, 2.4, [-10], 0.3, 'corrugated', 0),

  // ---- panel block, north-west. Gutted: two doors and no roof to hide under.
  ...wall('x', 12, -30, -8, 3.6, [-24, -14], WALL_T, 'concrete_dark', 0),
  ...wall('x', 26, -30, -8, 3.6, [-20], WALL_T, 'concrete_dark', 0),
  ...wall('z', -30, 12, 26, 3.6, [19], WALL_T, 'concrete_dark', 0),
  ...wall('z', -8, 12, 26, 3.6, [19], WALL_T, 'concrete_dark', 0),
  // internal spine, so the inside is two rooms rather than one hall
  ...wall('z', -19, 14, 24, 2.6, [17, 22], WALL_T, 'concrete', 0),

  // ---- workshop, east. Open front onto the yard.
  ...wall('z', 16, -22, 4, 3.2, [-16, -4], WALL_T, 'brick', 0),
  ...wall('z', 30, -22, 4, 3.2, [], WALL_T, 'brick', 0),
  ...wall('x', -22, 16, 30, 3.2, [23], WALL_T, 'brick', 0),
  ...wall('x', 4, 16, 30, 3.2, [23], WALL_T, 'brick', 0),
  // loading dock: raised platform with a ramp down into the yard
  [23, -12, 12, 5, 1.05, 0, 'concrete', 0],
  ...ramp(23, -7.5, 5, 'z', 3, 'concrete_dark', 1),

  // ---- substation, south-west. Low roof you can actually get onto.
  [-20, -20, 12, 12, 2.1, 0, 'brick_fine', 0],
  ...ramp(-11.5, -20, 5, 'x', 6, 'concrete_dark', 1, 0.35, 1.5),

  // ---- yard clutter: cover at chest height, vaultable at 0.7
  [0, 0, 3.2, 3.2, 2.8, 0.4, 'metal_rust', 0], // reactor stack
  [-4, 8, 2.2, 2.2, 1.1, 0, 'metal_rust_prop', 0],
  [6, -6, 4.4, 1.1, 1.1, 0, 'concrete_prop', 0],
  [12, 6, 1.1, 4.4, 1.1, 0, 'concrete_prop', 0],
  [-8, -6, 2.6, 1.1, 0.7, 0, 'wood_dark', 0],
  [8, 14, 2.6, 1.1, 0.7, 0, 'wood_dark', 0],
  [18, 24, 2.4, 2.4, 1.6, 0.3, 'metal_rust', 0],
  [-28, 4, 2.4, 2.4, 1.6, -0.5, 'metal_rust', 0],
  [30, 14, 1.1, 6, 1.1, 0, 'concrete_prop', 0],
  [-14, 30, 6, 1.1, 1.1, 0, 'concrete_prop', 0],
  [26, -30, 3.2, 3.2, 2.2, 0.2, 'metal_dark', 0],

  // ---- colour, so the yard is not one grey mass. Soviet industrial paint is
  // actually loud: ochre panels, teal doors, red-lead primer on the steelwork.
  [-19, 12.2, 12, 0.3, 2.4, 0, 'metal_green', 0], // panel block door band
  [23, 15.8, 12, 0.3, 2.2, 0, 'fabric_teal', 0], // workshop shutter
  [-20, -13.8, 12, 0.3, 2.1, 0, 'metal_rust', 0], // substation face
  [0, 0, 3.6, 3.6, 0.35, 0.4, 'metal_rust_prop', 2.8], // stack cap
  // sodium lamps on the yard poles — the one warm note in a cold map
  [-14, -2, 0.35, 0.35, 5.2, 0, 'metal_dark', 0],
  [-14, -2, 0.9, 0.9, 0.3, 0, 'lamp_lens', 5.2],
  [14, 10, 0.35, 0.35, 5.2, 0, 'metal_dark', 0],
  [14, 10, 0.9, 0.9, 0.3, 0, 'lamp_lens', 5.2],
  [2, 26, 0.35, 0.35, 5.2, 0, 'metal_dark', 0],
  [2, 26, 0.9, 0.9, 0.3, 0, 'lamp_lens', 5.2],
  // hazard striping at the dock edge
  [23, -14.6, 12, 0.3, 0.14, 0, 'emissive_warm', 1.05],
];

/** Yard centre-south: open, flat, and away from the buildings' footprints. */
const ZONE_SPAWNS = [
  [0, -26, 0, 'yard'],
  [-30, 30, -2.4, 'panel block'],
  [30, 30, 2.4, 'workshop'],
  [-30, -32, -0.6, 'substation'],
  [32, 0, 1.6, 'east gate'],
  [0, 32, Math.PI, 'north gap'],
];

/* ────────────────────────────────────────────────────────────────────────── *
 *  OUTPOST — a walled desert border post. Sand, brick and dust.
 *
 *  The third location, and the point of it is CONTRAST. Miami is a neon rooftop
 *  of open platforms; this is a walled compound at ground level that you fight
 *  through BUILDINGS rather than across terraces. Different silhouette, different
 *  palette, different kind of fight — a map list is only worth having if the
 *  entries do not play the same.
 *
 *      z=+33  ┌──────────────┬─────────────────┬──────────────┐
 *             │   B COURT    │  STATION HOUSE  │   A DOCK     │
 *             │  (enclosed)  │      2.4        │    1.2       │
 *      z=+18  ├────┬─────────┴────┬───────┬────┴──────┬───────┤
 *             │ W  │   WEST HOUSE │  MID  │ EAST HOUSE│  E    │
 *             │ A  │   (4 doors)  │       │ (4 doors) │  A    │
 *             │ L  ├──────────────┤ well  ├───────────┤  L    │
 *      z=-14  │ L  │              │       │           │  L    │
 *             │ E  │              │       │           │  E    │
 *      z=-20  ├────┴──────────────┴───────┴───────────┴───────┤
 *             │            DEPOT YARD  (spawn)                │
 *      z=-33  └───────────────────────────────────────────────┘
 *
 *  THE TWO SITES ARE OPPOSITES, on purpose, so calling one is worth doing:
 *    A DOCK   a raised loading platform, open, two stairs, no roof. You hold it
 *             from height and you are visible from everywhere while you do.
 *    B COURT  a walled yard at ground level, two doors, no sightline in or out.
 *             You hold it from cover and never see what is coming.
 *
 *  Same engine limit as MIAMI: the nav grid is a single 2-D height field, so
 *  nothing walkable sits above anything walkable. The awnings are 0.3 m strips
 *  for exactly that reason — a solid roof over a courtyard would make the nav
 *  grid think the courtyard's floor was the roof.
 * ────────────────────────────────────────────────────────────────────────── */
const OUTPOST = [
  /* ══ COMPOUND WALL ════════════════════════════════════════════════════════
   * 4 m and solid: this is a walled post, not a rooftop, so the boundary reads
   * as something built rather than as the edge of the world.
   */
  ...wall('x', -33, -33, 33, 4.0, [], 0.7, 'plaster_sand', 0),
  ...wall('x', 33, -33, 33, 4.0, [], 0.7, 'plaster_sand', 0),
  ...wall('z', -33, -33, 33, 4.0, [], 0.7, 'plaster_sand', 0),
  ...wall('z', 33, -33, 33, 4.0, [], 0.7, 'plaster_sand', 0),
  // Coping course in brick — one band of a second material stops 4 m of flat
  // sand from reading as a texture-mapped box.
  [0, -33, 66, 0.9, 0.35, 0, 'brick', 4.0],
  [0, 33, 66, 0.9, 0.35, 0, 'brick', 4.0],
  [-33, 0, 0.9, 66, 0.35, 0, 'brick', 4.0],
  [33, 0, 0.9, 66, 0.35, 0, 'brick', 4.0],

  /* ══ WEST HOUSE ═══════════════════════════════════════════════════════════
   * Four doors, no two on the same axis, so it is a junction you can be flanked
   * inside rather than a corridor with a door at each end.
   */
  ...wall('x', -14, -24, -10, 3.5, [-17], WALL_T, 'plaster_sand', 0),
  ...wall('x', 6, -24, -10, 3.5, [-20, -13], WALL_T, 'plaster_sand', 0),
  ...wall('z', -24, -14, 6, 3.5, [-4], WALL_T, 'brick', 0),
  ...wall('z', -10, -14, 6, 3.5, [0], WALL_T, 'brick', 0),
  // internal divider: two rooms, one offset door, no through-shot
  ...wall('x', -4, -24, -10, 3.0, [-21], WALL_T, 'brick_fine', 0),
  // Lid. Sits 0.1 above the 3.5 walls so the wall tops are still lit from
  // outside and the interior reads as a room rather than a sealed box.
  ...roof(-17, -4, 15, 21, 'corrugated', 3.6),
  [-21, -11, 2.2, 1.1, 1.0, 0, 'wood_prop', 0],
  [-12.5, 2, 1.1, 2.2, 1.0, 0, 'wood_prop', 0],
  [-18, 1, 1.4, 1.4, 0.7, 0.3, 'wood_prop', 0],

  /* ══ EAST HOUSE ═══════════════════════════════════════════════════════════ */
  ...wall('x', -14, 10, 24, 3.5, [20], WALL_T, 'plaster_sand', 0),
  ...wall('x', 6, 10, 24, 3.5, [13], WALL_T, 'plaster_sand', 0),
  ...wall('z', 10, -14, 6, 3.5, [-8, 2], WALL_T, 'brick', 0),
  ...wall('z', 24, -14, 6, 3.5, [-4], WALL_T, 'brick', 0),
  ...wall('x', -4, 10, 24, 3.0, [21], WALL_T, 'brick_fine', 0),
  ...roof(17, -4, 15, 21, 'corrugated', 3.6),
  [21, -11, 2.2, 1.1, 1.0, 0, 'wood_prop', 0],
  [12.5, 2, 1.1, 2.2, 1.0, 0, 'wood_prop', 0],
  [18, -8, 1.4, 1.4, 0.7, -0.3, 'wood_prop', 0],

  /* ══ A DOCK — the raised site, north-east ═════════════════════════════════
   * A concrete loading platform 1.2 up with two stairs and no roof. Height and
   * exposure in the same package: you shoot down into the approach and anyone
   * on the station house is looking straight at you.
   */
  [24, 25, 18, 14, 1.2, 0, 'concrete', 0],
  /**
   * A vehicle RAMP up the south face and a stair on the west. A loading dock
   * has a ramp — and mixing the two means the two approaches feel different
   * under the feet as well as on the map: the ramp is faster and completely
   * open, the stair is shorter and tucked against mid.
   */
  ...slope(24, 11.2, 9, 6.8, 1.2, 'concrete_dark', 0, 'z'),
  ...steps(10.2, 25, 8, 'x', 3, 'concrete_dark', 1, 0, 0.4, 1.6),
  // dock edge and its hazard stripe
  [24, 18.2, 18, 0.4, 0.25, 0, 'concrete_dark', 1.2],
  [24, 18.0, 18, 0.22, 0.1, 0, 'emissive_warm', 1.2],
  // cargo on the dock: cover, and the 0.7s are climbable onto the 1.4s
  [19, 23, 2.4, 2.4, 1.0, 0, 'wood_prop', 1.2],
  [30, 22, 2.4, 2.4, 0.7, 0.2, 'wood_prop', 1.2],
  [30, 24.4, 2.4, 2.4, 1.4, 0.2, 'wood_prop', 1.2],
  [22, 30, 4.4, 1.2, 1.0, 0, 'metal_rust', 1.2],
  // a corrugated canopy on posts — beams only, never a slab
  [17, 27, 0.35, 0.35, 2.6, 0, 'metal_rust', 1.2],
  [31, 27, 0.35, 0.35, 2.6, 0, 'metal_rust', 1.2],
  [24, 27, 15, 0.3, 0.25, 0, 'corrugated', 3.8],
  [24, 29.4, 15, 0.3, 0.25, 0, 'corrugated', 3.8],

  /* ══ B COURT — the enclosed site, north-west ══════════════════════════════
   * Ground level, walled on every side, two doors and no line of sight out. The
   * exact inverse of A: you cannot be shot from the station house in here, and
   * you cannot see it coming either.
   */
  ...wall('x', 18, -33, -13, 3.5, [-28, -19], WALL_T, 'plaster_sand', 0),
  ...wall('z', -13, 18, 33, 3.5, [26], WALL_T, 'plaster_sand', 0),
  // a low inner wall, so the yard is two pockets rather than one box
  [-23, 25, 8, 0.5, 1.1, 0, 'brick', 0],
  [-29, 21, 2.2, 2.2, 1.0, 0.2, 'wood_prop', 0],
  [-17, 30, 2.4, 1.2, 1.0, 0, 'wood_prop', 0],
  [-26, 30, 1.6, 1.6, 0.7, -0.3, 'wood_prop', 0],
  // well head in the corner, and a palm — the only green on the map
  [-30, 31, 2.2, 2.2, 0.9, 0, 'brick_fine', 0],
  [-20.5, 21, 1.6, 1.6, 0.55, 0, 'brick', 0],
  [-20.5, 21, 1.3, 1.3, 2.6, 0, 'foliage', 0.55],
  // red awnings over the doors: 0.3 m strips, deliberately not roofs
  [-28, 17.4, 3.4, 0.3, 0.25, 0, 'fabric_red', 2.8],
  [-19, 17.4, 3.4, 0.3, 0.25, 0, 'fabric_red', 2.8],

  /* ══ STATION HOUSE — the high ground, north centre ════════════════════════
   * 2.4 up a six-tread flight straight out of mid, with a brick hut on top that
   * has a door on three sides. It overlooks A completely and B not at all,
   * which is the whole reason to take one site over the other.
   */
  [0, 27, 26, 12, 2.4, 0, 'concrete', 0],
  ...steps(0, 12.2, 10, 'z', 6, 'concrete_dark', 1, 0, 0.4, 1.6),
  /**
   * SIDE ROUTE onto the station house, up its west flank out of the alley.
   * The grand stair is the obvious way and everyone watches it; this is long,
   * narrow and comes up behind whoever is doing the watching. A high position
   * with exactly one approach is a position nobody can be dislodged from.
   */
  ...slope(-12.5, 9, 4.5, 12, 2.4, 'concrete_dark', 0, 'z'),
  ...wall('z', -14.8, 9, 21, 1.1, [], 0.3, 'plaster_sand', 0.6),
  ...wall('x', 24, -9, 9, 3.0, [0], WALL_T, 'brick', 2.4),
  ...wall('x', 31, -9, 9, 3.0, [], WALL_T, 'brick', 2.4),
  ...wall('z', -9, 24, 31, 3.0, [27], WALL_T, 'brick', 2.4),
  ...wall('z', 9, 24, 31, 3.0, [27], WALL_T, 'brick', 2.4),
  ...roof(0, 27.5, 19, 8, 'corrugated', 5.5),
  // parapet along the south lip: waist high up here, 3.6 m from mid
  ...wall('x', 21.2, -13, 13, 1.0, [0], 0.4, 'plaster_sand', 2.4),
  [-11, 23, 2.2, 1.1, 1.0, 0, 'wood_prop', 2.4],
  [11, 23, 2.2, 1.1, 1.0, 0, 'wood_prop', 2.4],
  /**
   * ONE STAIR, ON PURPOSE — and the two flank flights that used to be here were
   * wrong twice over. `steps()` always RISES along `sign`, so writing them as
   * "descending off the house" built them upside down: the 0.4 tread landed
   * against the 2.4 platform and the 2.4 tread sat out in the open, which is a
   * wall with a step in front of it. The east one also ran straight through
   * A dock's footprint.
   *
   * They are gone rather than fixed. The house is reached from mid, A dock from
   * its own two stairs, B court from the alley — all of them via the ground, so
   * holding the high ground means giving it up to rotate. A direct house-to-dock
   * link would make the strongest position on the map also the best connected.
   */

  /* ══ MID — the well street ════════════════════════════════════════════════
   * The fast way to the station stair and the only place both houses overlook.
   * The well is hard cover you can circle; everything else is waist high.
   */
  /**
   * The well sits OFF the map's centre deliberately. At (0,-2) its 1.32 m head
   * covered world (0,0), which is the point tools/nav-check.mjs paths its whole
   * sample ring to — the target was the top of an unclimbable pillar, so 8 of 16
   * bearings reported "no path" on a map that is fully connected. The check is
   * worth more than the centimetres.
   */
  [-4, 2, 3.6, 3.6, 1.1, 0, 'brick_fine', 0],
  [-4, 2, 4.0, 4.0, 0.22, 0, 'brick', 1.1],
  [-6, 8, 2.4, 1.2, 1.0, 0, 'wood_prop', 0],
  [6, 8, 1.2, 2.4, 1.0, 0, 'wood_prop', 0],
  [4, -10, 2.2, 2.2, 0.7, 0.25, 'wood_prop', 0],
  [4, -12.4, 2.2, 2.2, 1.4, 0.25, 'wood_prop', 0],
  [-5, -8, 4.4, 1.1, 1.0, 0, 'concrete_prop', 0],
  [0, 12, 6, 1.1, 0.7, 0, 'concrete_prop', 0],

  /* ══ ALLEYS — west and east ═══════════════════════════════════════════════
   * 9 m between the compound wall and a house, running the length of the map.
   * Long, blind at both ends, and the only route that never crosses mid.
   */
  [-28, -6, 1.2, 4.4, 1.0, 0, 'concrete_prop', 0],
  [-29, 6, 2.2, 2.2, 0.7, 0.3, 'wood_prop', 0],
  [-27, 12, 2.4, 1.2, 1.0, 0, 'metal_rust', 0],
  [28, -6, 1.2, 4.4, 1.0, 0, 'concrete_prop', 0],
  [29, 6, 2.2, 2.2, 0.7, -0.3, 'wood_prop', 0],
  [27, 12, 2.4, 1.2, 1.0, 0, 'metal_rust', 0],

  /* ══ DEPOT YARD — spawn ═══════════════════════════════════════════════════
   * Deliberately thin cover: it is where you start and fall back to, and a yard
   * you can hold forever is a yard you never leave.
   */
  [-16, -24, 2.4, 2.4, 1.0, 0.15, 'wood_prop', 0],
  [16, -24, 2.4, 2.4, 1.0, -0.15, 'wood_prop', 0],
  [0, -28, 6, 1.2, 0.7, 0, 'concrete_prop', 0],
  [-26, -29, 3.2, 1.2, 1.0, 0, 'metal_rust', 0],
  [26, -29, 3.2, 1.2, 1.0, 0, 'metal_rust', 0],
  // lane mouths, so the three routes north are legible from spawn
  [-28, -19.6, 10, 0.3, 0.12, 0, 'emissive_warm', 0],
  [0, -19.6, 14, 0.3, 0.12, 0, 'lamp_lens', 0],
  [28, -19.6, 10, 0.3, 0.12, 0, 'emissive_warm', 0],

  /* ══ LAMPS ════════════════════════════════════════════════════════════════ */
  [-12, -6, 0.3, 0.3, 4.6, 0, 'metal_rust', 0],
  [-12, -6, 0.8, 0.8, 0.28, 0, 'lamp_lens', 4.6],
  [12, 10, 0.3, 0.3, 4.6, 0, 'metal_rust', 0],
  [12, 10, 0.8, 0.8, 0.28, 0, 'lamp_lens', 4.6],
  [0, 30, 0.3, 0.3, 3.4, 0, 'metal_rust', 2.4],
  [0, 30, 0.8, 0.8, 0.28, 0, 'lamp_lens', 5.8],
];

/** Every route and both sites, on open ground and never on a stair. */
const OUTPOST_SPAWNS = [
  [0, -27, 0, 'depot yard'],
  [-29, -4, 0.5, 'west alley'],
  [29, -4, -0.5, 'east alley'],
  [0, 4, 0, 'well street'],
  [-24, 28, Math.PI, 'b court'],
  [24, 24, Math.PI, 'a dock'],
];

export const ARENAS = {
  /**
   * 15.4 — late afternoon. A desert map wants a low sun: it is what puts a long
   * shadow off every wall and separates the sand planes from each other. Miami
   * needs 13.0 for the opposite reason (see the note there) — its palette goes
   * beige the moment the sun warms up, and this one wants exactly that warmth.
   */
  outpost: {
    walls: OUTPOST,
    spawns: OUTPOST_SPAWNS,
    floor: [70, 70],
    ground: 'road_dust',
    sky: 15.4,
    exposure: -0.7,
    weather: {
      cloudCoverage: 0.05,
      cirrusCoverage: 0.16,
      turbidity: 2.6,
      horizonMurk: 0.12,
      /** Dust haze, but nowhere near enough to eat the dome — see MIAMI. */
      fogDensity: 0.004,
      groundAlbedo: 0xb08a5c,
    },
  },
  strike: { walls: STRIKE, spawns: STRIKE_SPAWNS, floor: [68, 48], ground: 'road_dust' },
  holdout: { walls: HOLDOUT, spawns: HOLDOUT_SPAWNS, floor: [68, 68], ground: 'sand' },
  /**
   * 13.0, measured rather than picked. tools/hour-sweep.mjs prints the sun's
   * blue/red ratio against the hour: it peaks at 0.755 around noon and falls
   * away hard on both sides (0.70 at 15.4, 0.46 at 18). Since white plaster
   * renders as albedo x sun colour, every hour after ~14 turns this deck beige
   * no matter what the palette says — the "concrete" in the screenshots was
   * literally the light, measured at rgb(160,143,122) with a sun tint of
   * (1, 0.87, 0.70). 13.0 keeps the sun near its most neutral while the
   * altitude (65 degrees) still throws readable shadows.
   */
  miami: {
    walls: MIAMI,
    spawns: MIAMI_SPAWNS,
    floor: [70, 70],
    ground: 'neon_white',
    sky: 13.0,
    /** Negative EV = brighter. See the note in world/index.js. */
    exposure: -1.2,
    /**
     * `cloudCoverage`, NOT `coverage`. setWeather is an Object.assign onto the
     * live weather object, so a wrong key is silently accepted and the sky
     * simply never changes — which is exactly what a previous pass did here,
     * writing two dead properties and leaving the default overcast in place.
     * The names are in SkySystem's `this.weather`, not in its doc comment.
     */
    /**
     * The "grey goo sky" was the HORIZON, not the dome. Pointed up, this sky
     * already measured a saturated blue (sat 0.7); pointed at the skyline —
     * which is where a first-person camera actually looks — it measured
     * rgb(130,123,114), a flat grey-tan band. That band is aerosol: turbidity
     * scatters the blue out, `horizonMurk` deliberately fades the dome to grey
     * at eye level, and the fog sits on top of both. All three are dialled to
     * near-nothing here, so the blue runs all the way down to the parapet.
     */
    weather: {
      cloudCoverage: 0.0,
      cirrusCoverage: 0.08,
      turbidity: 1.1,
      horizonMurk: 0.015,
      /**
       * ZERO, and this is the single line that fixed "the skybox is grey goo".
       *
       * Fog integrates along the view ray, and the sky is at effectively
       * infinite distance, so it accumulates to full opacity and REPLACES the
       * dome rather than tinting it. Measured on this exact view: at a density
       * of 0.03 — which reads like "barely any" — the horizon sampled
       * rgb(147,143,140), flat grey; at 0 the same pixel is rgb(8,112,144),
       * the ocean. Nothing else about the sky had to change. Every previous
       * attempt was tuning the dome underneath an opaque grey sheet.
       */
      fogDensity: 0,
      // A rooftop has no walls to the skyline, so everything past the parapet
      // is the sky's lower hemisphere and this colour is literally the whole
      // backdrop. Miami is looking at the Atlantic.
      groundAlbedo: 0x1d7f96,
    },
  },
  // The Zone keeps its overcast — there it is the point rather than an accident.
  zone: {
    walls: ZONE,
    spawns: ZONE_SPAWNS,
    floor: [74, 74],
    ground: 'asphalt',
    sky: 16.2,
    weather: {
      cloudCoverage: 0.62,
      cirrusCoverage: 0.4,
      turbidity: 3.2,
      fogDensity: 0.6,
      // Wet pine and dead grass to the treeline, not desert sand.
      groundAlbedo: 0x3c4433,
    },
  },
};

/**
 * @param {object} A   the world Assembler
 * @param {string} id  'strike' | 'holdout'
 */
export function buildArena(A, id) {
  const spec = ARENAS[id];
  if (!spec) return;

  /**
   * The palette entries are `vertexMasks: true`, so the wear/grime/AO attribute
   * has to exist before the geometry is merged — without it the Accum drops the
   * mesh and the level renders as nothing but collision. Same trap as the
   * whitebox and the shoot house; see the note there.
   */
  const flat = (g) => (
    paintMasks(g, (x, y, z, nx, ny, nz, out) => {
      out[0] = 0.08;
      out[1] = 0.1;
      out[2] = 0;
    }),
    g
  );

  const ground = spec.ground ?? 'plaster_white';
  const floor = flat(new THREE.PlaneGeometry(spec.floor[0], spec.floor[1], 1, 1));
  floor.rotateX(-Math.PI / 2);
  A.add(ground, floor, null);
  A.collideGeo(ground, floor);
  floor.dispose();

  /**
   * One unit cube, reused for every box. `mat` and `y` are optional tail fields,
   * so the older six-field rows still read the same. `y` is the base the box
   * SITS ON, not its centre — that is how a floor plan is written, and it is the
   * only way stacking onto a plinth stays legible.
   */
  const unit = flat(new THREE.BoxGeometry(1, 1, 1));
  /**
   * Coplanar faces shimmer. Trim laid exactly on top of a wall, or a stripe at
   * exactly the height of the slab under it, puts two surfaces on the same
   * plane and the depth buffer picks per-pixel — which is the "bad edges
   * between boxes" you see as a crawling seam along every joint. Every box is
   * grown by this much, so touching boxes INTERPENETRATE by a hair instead of
   * sharing a plane. It is far below the smallest real dimension here (0.1 m),
   * so nothing moves that a player could measure.
   */
  const SEAM = 0.006;

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();

  for (const row of spec.walls) {
    /* ---- pitched slope, and roofs: object rows, see slope()/roof() -------- */
    if (!Array.isArray(row)) {
      const m = row.mat ?? 'plaster_white';
      if (row.slope) {
        const { x, z, w, len, rise, t, y, dir } = row;
        const run = Math.hypot(len, rise);
        const pitch = Math.atan2(rise, len);
        // The TOP face is the walking surface, so the slab centre drops half a
        // thickness along its own normal rather than half a thickness in Y.
        const nx = dir === 'x' ? -Math.sin(pitch) : 0;
        const nz = dir === 'z' ? -Math.sin(pitch) : 0;
        const ny = Math.cos(pitch);
        const cx = x + (dir === 'x' ? len / 2 : 0) - (t / 2) * nx;
        const cz = z + (dir === 'z' ? len / 2 : 0) - (t / 2) * nz;
        const cy = y + rise / 2 - (t / 2) * ny;
        // Pitch about the axis ACROSS the run: a z-ramp tips about X.
        _e.set(dir === 'z' ? -pitch : 0, 0, dir === 'x' ? pitch : 0, 'XYZ');
        _q.setFromEuler(_e);
        _p.set(cx, cy, cz);
        _s.set(dir === 'x' ? run : w, t, dir === 'z' ? run : w);
        _m.compose(_p, _q, _s);
        A.add(m, unit, _m);
        A.collideGeo(m, unit, _m);
        continue;
      }
      if (row.roof) {
        const { x, z, w, d, t, ry, y } = row;
        const cy = y + t / 2;
        A.addBox(m, unit, x, cy, z, ry, w, t, d);
        // SHOOT_ONLY, not STATIC — see roof(). This is the whole trick.
        _e.set(0, ry, 0, 'XYZ');
        _q.setFromEuler(_e);
        _p.set(x, cy, z);
        _s.set(w, t, d);
        _m.compose(_p, _q, _s);
        A.collideGeoLayer(m, LAYER.SHOOT_ONLY, unit, _m);
        continue;
      }
      continue;
    }

    const [x, z, w, d, h, ry, mat, y] = row;
    const m = mat ?? 'plaster_white';
    const cy = (y ?? 0) + h / 2;
    A.addBox(m, unit, x, cy, z, ry, w + SEAM, h + SEAM, d + SEAM);
    A.box(m, x, cy, z, w, h, d, ry);
  }
  unit.dispose();
}
