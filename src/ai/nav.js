/**
 * AI — navigation and cover.
 *
 * NAVIGATION is a dense walkability grid sampled straight out of the physics
 * BVH at boot: one downward ray per cell finds the floor, one upward ray checks
 * standing clearance, and the floor normal gives the slope. That is a navmesh's
 * worth of information for a fraction of the code, and it stays correct for a
 * level the `world` system generated procedurally without any authoring pass.
 *
 *   • A* over the 8-connected grid with a heap, slope and step penalties
 *   • string pulling against a line-of-walk test, so paths hug corners instead
 *     of zig-zagging cell to cell
 *   • per-agent local avoidance so a squad flows around itself
 *
 * COVER is derived from the same grid. Every walkable cell next to a blocker
 * becomes a cover point with a direction and a height class (full / crouch),
 * plus a peek offset that has line of sight past the edge. At runtime cover is
 * scored against the live threat direction, the agent's distance, and what the
 * rest of the squad has already claimed.
 */

import * as THREE from 'three';

const SQRT2 = Math.SQRT2;

/* ------------------------------------------------------------------ */
/* Binary heap for A*                                                  */
/* ------------------------------------------------------------------ */

class Heap {
  constructor(cap) {
    this.idx = new Int32Array(cap);
    this.key = new Float32Array(cap);
    this.n = 0;
  }

  clear() {
    this.n = 0;
  }

  push(i, k) {
    /**
     * GROW, never drop.
     *
     * This used to be `if (this.n >= this.idx.length) return;` - a silent drop
     * when the open list filled. With one storey the node space was 48841 and
     * the heap was sized to match, so it never filled and the bug was invisible
     * for the life of the single-layer grid. A second storey took the node space
     * to 97682 against a `1 << 16` cap, and A* began failing to find routes that
     * a plain flood fill walked without trouble: dropped pushes mean nodes that
     * are never expanded, so the search reports "no path" for a path that
     * exists. Raising the node budget only masked it, because popping made room
     * for a few of the pushes that had been thrown away.
     *
     * A* re-pushes a node every time it finds a cheaper route to it, so the open
     * list is bounded by edges explored, not by the node count - there is no
     * safe fixed size. Growing costs one reallocation on the rare deep search
     * and makes the failure mode impossible.
     */
    if (this.n >= this.idx.length) {
      const cap = this.idx.length * 2;
      const idx = new Int32Array(cap); idx.set(this.idx);
      const key = new Float32Array(cap); key.set(this.key);
      this.idx = idx; this.key = key;
    }
    let c = this.n++;
    this.idx[c] = i;
    this.key[c] = k;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p] <= this.key[c]) break;
      const ti = this.idx[p], tk = this.key[p];
      this.idx[p] = this.idx[c]; this.key[p] = this.key[c];
      this.idx[c] = ti; this.key[c] = tk;
      c = p;
    }
  }

  pop() {
    const top = this.idx[0];
    this.n--;
    if (this.n > 0) {
      this.idx[0] = this.idx[this.n];
      this.key[0] = this.key[this.n];
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let m = c;
        if (l < this.n && this.key[l] < this.key[m]) m = l;
        if (r < this.n && this.key[r] < this.key[m]) m = r;
        if (m === c) break;
        const ti = this.idx[m], tk = this.key[m];
        this.idx[m] = this.idx[c]; this.key[m] = this.key[c];
        this.idx[c] = ti; this.key[c] = tk;
        c = m;
      }
    }
    return top;
  }
}

/* ------------------------------------------------------------------ */
/* Nav grid                                                            */
/* ------------------------------------------------------------------ */

export class NavGrid {
  constructor(physics, opts = {}) {
    this.physics = physics;
    this.cell = opts.cell ?? 0.8;
    this.radius = opts.radius ?? 0.36;
    this.height = opts.height ?? 1.78;
    this.crouchHeight = opts.crouchHeight ?? 1.15;
    this.maxStep = opts.maxStep ?? 0.45;
    this.maxSlope = Math.cos((opts.maxSlopeDeg ?? 46) * Math.PI / 180);

    const b = opts.bounds;
    this.minX = Math.floor(b.min.x / this.cell) * this.cell;
    this.minZ = Math.floor(b.min.z / this.cell) * this.cell;
    this.nx = Math.max(1, Math.ceil((b.max.x - this.minX) / this.cell));
    this.nz = Math.max(1, Math.ceil((b.max.z - this.minZ) / this.cell));
    this.topY = b.max.y + 4;

    /**
     * TWO STOREYS PER COLUMN.
     *
     * The grid used to fire one ray down per cell and call the first thing it
     * hit "the floor". Under a roof, a catwalk or a raised terrace that first
     * hit is the OVERHANG, so the ground where the fight actually happens was
     * never recorded, and an agent standing there had no cell to path from.
     * Measured by tools/navlayers.mjs, that discarded 3431 walkable cells on
     * outpost and 3009 on miami - about a third of each map invisible to the
     * AI, which is why enemies stalled at 30 m instead of chasing.
     *
     * Two layers is not a general solution (a three-level car park would still
     * lose its middle) but it covers "ground plus the thing above it", which is
     * every case these maps actually build.
     *
     * Layer 0 stays the TOPMOST surface, so rooftop routes behave exactly as
     * before and every pre-existing flat index still means the same cell.
     * Layer 1 is the first stand-able surface underneath it.
     * Index layout: `layer * n + iz * nx + ix`.
     */
    this.layers = 2;
    const n = this.nx * this.nz;
    this.n = n;
    const total = n * this.layers;
    /** 0 = blocked, 1 = walkable standing, 2 = walkable crouched only */
    this.flags = new Uint8Array(total);
    this.floor = new Float32Array(total);
    this.floor.fill(-Infinity);
    /** how enclosed a cell is: 0 open, 1 hemmed in — used for cover scoring */
    this.enclosure = new Uint8Array(total);

    // A* working set - sized for every layer, not just the ground one.
    this.gScore = new Float32Array(total);
    this.came = new Int32Array(total);
    this.visitStamp = new Int32Array(total);
    /**
     * Closed set. The heuristic below is weighted (x1.06), which makes it
     * inadmissible: without this, a node can be re-expanded every time a
     * cheaper route to it turns up, and the node budget - sized as a multiple
     * of the WALKABLE COUNT - gets spent re-doing work instead of exploring.
     * Long routes then failed on maps that are provably one component.
     * Popping each node at most once makes `walkableCount` a real bound on
     * expansions, at the cost of paths up to 6% longer than optimal.
     */
    this.closedStamp = new Int32Array(total);
    this.stamp = 0;
    this.open = new Heap(Math.min(total, 1 << 16));

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._p0 = new THREE.Vector3();
    this._p1 = new THREE.Vector3();
    this.buildMs = 0;
    this.walkableCount = 0;
  }

  index(ix, iz, layer = 0) {
    return layer * this.n + iz * this.nx + ix;
  }

  /** Decompose a flat index. Never use `i % nx` directly - it drops the layer. */
  ixOf(i) {
    return (i % this.n) % this.nx;
  }

  izOf(i) {
    return ((i % this.n) / this.nx) | 0;
  }

  layerOf(i) {
    return (i / this.n) | 0;
  }

  cellX(x) {
    return Math.round((x - this.minX) / this.cell);
  }

  cellZ(z) {
    return Math.round((z - this.minZ) / this.cell);
  }

  worldX(ix) {
    return this.minX + ix * this.cell;
  }

  worldZ(iz) {
    return this.minZ + iz * this.cell;
  }

  inside(ix, iz) {
    return ix >= 0 && iz >= 0 && ix < this.nx && iz < this.nz;
  }

  /**
   * Sample the physics world. Walks each column DOWNWARD, collecting up to
   * `layers` stand-able surfaces, so ground beneath an overhang is recorded
   * rather than hidden by the overhang. ~2-5 rays per cell.
   */
  build() {
    const t0 = performance.now();
    const phys = this.physics;
    /**
     * CHARACTER, not WORLD. The two differ by LAYER.CLIP - invisible collision
     * that blocks bodies but not bullets - and planning on geometry the mover
     * does not share is how you get a route that is valid on paper and a body
     * grinding into nothing. Measured before this: a ghoul on the terrace with
     * a perfectly good 5-waypoint path, blocked by the controller on 495 of
     * 1265 frames, repathing every time the stuck timer expired and getting the
     * same impossible route back.
     *
     * MASK.CHARACTER is a superset of MASK.WORLD, so this only ever removes
     * walkable cells - it cannot invent new ones.
     */
    const MASK = phys.MASK.CHARACTER;
    let walk = 0;
    const BOTTOM = -30;
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const x = this.worldX(ix), z = this.worldZ(iz);
        let y = this.topY;
        let layer = 0;
        // `guard` bounds the descent: coplanar touching faces can return a hit
        // that does not advance `y`, which would otherwise spin here forever.
        for (let guard = 0; guard < 8 && layer < this.layers; guard++) {
          const down = phys.raycast(x, y, z, 0, -1, 0, y - BOTTOM, MASK);
          if (!down.hit) break;
          const fy = down.point.y;
          if (fy > y - 1e-4) { y = fy - 0.05; continue; }
          const i = this.index(ix, iz, layer);
          this.floor[i] = fy;
          if (this._classify(i, x, fy, z, down.normal.y, MASK, layer)) {
            walk++;
            layer++;
          } else if (layer > 0) {
            // An unusable upper layer must not shadow the real surface below,
            // so forget it. Layer 0 keeps its floor even when blocked, because
            // callers read floorAt() for ground height, not just walkability.
            this.floor[i] = -Infinity;
          }
          y = fy - 0.05;
        }
      }
    }
    this.walkableCount = walk;
    /**
     * TO A FIXED POINT, not once.
     *
     * Pruning is not idempotent, because `edge()`'s diagonal test asks whether
     * the two orthogonal corner cells are solid, and pruning turns cells solid.
     * Drop an isolated pocket and any diagonal inside the SURVIVING component
     * that leaned on one of those cells disappears with it - so the component
     * the pass just certified can fragment the moment the pass ends. That is
     * not theoretical: it left 31 of 200 random pairs on outpost genuinely
     * unconnected while the grid reported one component and 100% reachable.
     *
     * Two passes usually settle it; the cap is there so a pathological map
     * cannot spin. Each pass can only remove cells, so this always terminates.
     */
    for (let pass = 0; pass < 8; pass++) {
      const dropped = this._pruneIsolated();
      if (!dropped) break;
      this.pruningPasses = pass + 1;
    }
    this.buildMs = performance.now() - t0;
    return this;
  }

  /**
   * THE definition of a navigation edge. Every consumer goes through here.
   *
   * A* and the connectivity prune used to enumerate neighbours separately, and
   * they disagreed: the prune walked all eight directions unconditionally while
   * A* additionally refused to cut a corner past a blocked orthogonal. So the
   * prune could certify the graph as one component while A* could not actually
   * cross it, and "100% reachable" meant nothing. One function now, so the claim
   * and the search are the same graph by construction.
   *
   * @returns the neighbour node index, or -1 when there is no edge.
   */
  edge(cur, d) {
    const ix = this.ixOf(cur), iz = this.izOf(cur), cy = this.floor[cur];
    const dx = DX[d], dz = DZ[d];
    const ni = this.layerNear(ix + dx, iz + dz, cy);
    if (ni < 0) return -1;
    /**
     * No squeezing diagonally past a solid corner.
     *
     * The test is SOLIDITY, not traversability at this exact height. Asking
     * `layerNear(..., cy)` here - can I stand on that corner cell, starting
     * from my current floor - is far too strict on anything sloped: on a ramp
     * or a terrace edge the orthogonal neighbour is routinely more than one
     * step from `cy` while the diagonal itself is perfectly walkable. That
     * fragmented the graph, and since the prune keeps only the largest
     * component, the fragments were then deleted outright: 2126 cells on
     * outpost, more than a fifth of the map, most of it the sloped ground the
     * two-storey grid had just recovered.
     */
    if (dx && dz) {
      if (!this.walkableAny(ix + dx, iz)) return -1;
      if (!this.walkableAny(ix, iz + dz)) return -1;
    }
    /**
     * SYMMETRIC OR NOT AT ALL.
     *
     * `layerNear` picks the storey closest to the height you are standing on,
     * so it is directional: stepping A -> B can land on one storey while B -> A
     * picks a different one and never comes back. A one-way edge quietly breaks
     * the central promise of the prune - a flood fill explores forward, so it
     * certifies "everything reaches everything" using edges that only work in
     * the direction it happened to walk them. A* searching some other pair then
     * fails on a graph that was declared fully connected. Measured: 31 of 200
     * random pairs on outpost, with a closed set in place and node budget to
     * spare, so it could not be blamed on either.
     *
     * Requiring the reverse edge to exist costs one extra lookup and makes the
     * graph a genuine undirected one, which is what every consumer already
     * assumed it was.
     */
    if (this.layerNear(ix, iz, this.floor[ni]) !== cur) return -1;
    return ni;
  }

  /**
   * Keep only the largest connected component; everything else becomes blocked.
   *
   * Sampling a column downward finds real ground under real roofs, but it also
   * finds the INSIDE of solid boxes: a terrace slab spanning y=0..2.4 lets the
   * ray pass through it and land on the arena floor beneath, where there is
   * 2.4 m of headroom and no wall within arm's reach, so every walkability test
   * passes. That phantom storey is sealed in concrete, and an agent that snaps
   * into it can path around inside it forever without ever reaching the player.
   * Measured on outpost: one 382-cell pocket plus a tail of small ones.
   *
   * Rather than trying to recognise "inside a box" geometrically - which needs
   * watertight meshes and is fragile - this uses the property that actually
   * matters to the AI: if you cannot walk from there to the rest of the map, it
   * is not somewhere an enemy may stand. That also retires the isolated cells
   * the single-layer grid always had (744 on outpost before any of this).
   *
   * Sealed-off legitimate areas (an unreachable rooftop) are pruned too, which
   * is correct: agents could never have got there either, and leaving them
   * walkable only invites `nearest()` to strand a spawn on one.
   */
  _pruneIsolated() {
    const total = this.n * this.layers;
    const comp = new Int32Array(total).fill(-1);
    const stack = [];
    let best = -1, bestSize = 0, nComp = 0;

    for (let s0 = 0; s0 < total; s0++) {
      if (this.flags[s0] === 0 || comp[s0] >= 0) continue;
      const id = nComp++;
      let size = 0;
      stack.length = 0;
      stack.push(s0);
      comp[s0] = id;
      while (stack.length) {
        const cur = stack.pop();
        size++;
        for (let d = 0; d < 8; d++) {
          const ni = this.edge(cur, d);
          if (ni < 0 || comp[ni] >= 0) continue;
          comp[ni] = id;
          stack.push(ni);
        }
      }
      if (size > bestSize) { bestSize = size; best = id; }
    }

    if (best < 0) return 0;
    let dropped = 0;
    for (let i = 0; i < total; i++) {
      if (this.flags[i] === 0 || comp[i] === best) continue;
      this.flags[i] = 0;
      dropped++;
    }
    this.walkableCount -= dropped;
    this.prunedCells = (this.prunedCells ?? 0) + dropped;
    this.componentCount = nComp;
    return dropped;
  }

  /**
   * Decide whether one sampled surface can be stood on, filling `flags` and
   * `enclosure`. Split out of `build` so every layer is judged by identical
   * rules. Returns true when the cell is walkable.
   */
  _classify(i, x, fy, z, normalY, MASK, layer = 0) {
    const phys = this.physics;
    const r = this.radius;
    if (normalY < this.maxSlope) return false;
    /**
     * IS THERE ACTUALLY ROOM TO STAND, or is this the inside of a solid box?
     *
     * The arena floor plane runs under the whole level, so a downward ray that
     * passes through a terrace slab lands on real, up-facing ground at y=0 -
     * inside the concrete. Nothing in the ray tests can tell that apart from a
     * roofed room: the "ceiling" is 2.4 m up and no wall is within arm's reach,
     * because the walls of the box are metres away on every side.
     *
     * The consequence was worse than a few dead cells. Those phantom cells
     * connect to the real ground at the slab's edge, so they survive the
     * component prune, and `lineOfWalk` would then happily run a straight line
     * THROUGH a terrace at ground level. String-pulling collapsed whole routes
     * onto that line, handing rushers a first waypoint 38 m away on the far
     * side of solid rock. Measured: the agent ground against the wall with the
     * controller reporting blocked on 1603 of 1782 frames.
     *
     * A capsule the size of the body is the honest test - if the volume the
     * agent would occupy is not clear, it cannot stand here. Only layers below
     * the first need it: layer 0 is the topmost surface, so by construction
     * there is nothing above it to be inside of, and skipping it keeps the boot
     * cost at roughly one extra query per cell that has a second storey.
     */
    if (layer > 0) {
      /**
       * PARITY, because an overlap query cannot answer this.
       *
       * The first attempt asked `checkCapsule` whether a body fits here.
       * Measured inside a 2.4 m terrace slab on outpost, it answered YES: the
       * physics is triangle-based, so an overlap query measures distance to
       * TRIANGLES, and a capsule floating in the middle of a box touches none
       * of them. Containment is simply not a question that query can answer,
       * and trusting it spawned ghouls inside concrete.
       *
       * Counting surfaces between here and the sky can answer it. Leaving a
       * solid crosses an odd number of faces (from inside a slab, only its top);
       * standing in the open under a roof crosses an even number (the roof's
       * underside and its top). Roofs built on LAYER.SHOOT_ONLY are not in
       * MASK.CHARACTER at all, so they cost zero crossings, which is also even
       * and also correct.
       */
      let crossings = 0;
      let cy = fy + 0.25;
      for (let k = 0; k < 8; k++) {
        const h = phys.raycast(x, cy, z, 0, 1, 0, 400, MASK);
        if (!h.hit) break;
        crossings++;
        cy += h.distance + 0.02;
      }
      if (crossings & 1) return false; // odd -> we are inside the material
    }
    // standing clearance straight up
    const up = phys.raycast(x, fy + 0.25, z, 0, 1, 0, this.height - 0.2, MASK);
    if (!up.hit) this.flags[i] = 1;
    else if (up.distance > this.crouchHeight - 0.25) this.flags[i] = 2;
    else return false;
    // shoulder clearance: four short lateral probes at chest height
    let blocked = 0;
    for (let d = 0; d < 4; d++) {
      const dx = d === 0 ? 1 : d === 1 ? -1 : 0;
      const dz = d === 2 ? 1 : d === 3 ? -1 : 0;
      if (phys.raycastAny(x, fy + 0.95, z, dx, 0, dz, r + 0.06, MASK)) blocked++;
    }
    if (blocked >= 3) {
      this.flags[i] = 0;
      return false;
    }
    this.enclosure[i] = blocked;
    return true;
  }

  /**
   * The walkable layer of (ix,iz) whose floor is within one step of `y`, else
   * -1. This is what keeps the two storeys apart: a cell is a neighbour only if
   * you could actually step onto it from where you are standing, so a roof and
   * the ground under it never connect unless something bridges them.
   */
  layerNear(ix, iz, y) {
    if (!this.inside(ix, iz)) return -1;
    let best = -1, bestD = Infinity;
    for (let l = 0; l < this.layers; l++) {
      const i = this.index(ix, iz, l);
      if (this.flags[i] === 0) continue;
      const d = Math.abs(this.floor[i] - y);
      if (d > this.maxStep || d >= bestD) continue;
      bestD = d;
      best = i;
    }
    return best;
  }

  walkable(ix, iz, crouch = true, layer = 0) {
    if (!this.inside(ix, iz)) return false;
    const f = this.flags[this.index(ix, iz, layer)];
    return crouch ? f !== 0 : f === 1;
  }

  /** Walkable on ANY storey - the right question for coarse reachability. */
  walkableAny(ix, iz, crouch = true) {
    for (let l = 0; l < this.layers; l++) if (this.walkable(ix, iz, crouch, l)) return true;
    return false;
  }

  floorAt(ix, iz, layer = 0) {
    return this.floor[this.index(ix, iz, layer)];
  }

  /**
   * Nearest walkable cell to a world point, searched in rings. Pass `y` plus a
   * `yTol` to reject cells on a different storey — otherwise a spawn point in a
   * street happily snaps onto a market stall's table top.
   */
  nearest(x, z, y = null, maxRings = 8, yTol = Infinity) {
    const cx = this.cellX(x), cz = this.cellZ(z);
    const okY = (i) => y === null || Math.abs(this.floor[i] - y) <= yTol;
    /**
     * Scored over EVERY storey. This is the other half of the overhang fix:
     * with one layer, an agent standing on the ground under a roof snapped to
     * the roof cell above its head, and A* then searched from a storey the
     * agent was not on - which is how `findPath` came back 0 for an agent
     * standing on perfectly good ground.
     *
     * The vertical term is weighted 4x so, at equal horizontal distance, the
     * storey you are actually on always wins.
     */
    const consider = (ix, iz, dx, dz, cur) => {
      let best = cur.best, bestD = cur.bestD;
      for (let l = 0; l < this.layers; l++) {
        if (!this.walkable(ix, iz, true, l)) continue;
        const i = this.index(ix, iz, l);
        if (!okY(i)) continue;
        let d = dx * dx + dz * dz;
        if (y !== null && Number.isFinite(this.floor[i])) d += (this.floor[i] - y) ** 2 * 4;
        if (d < bestD) { bestD = d; best = i; }
      }
      cur.best = best;
      cur.bestD = bestD;
    };

    const here = { best: -1, bestD: Infinity };
    consider(cx, cz, 0, 0, here);
    if (here.best >= 0) return here.best;

    for (let ring = 1; ring <= maxRings; ring++) {
      const acc = { best: -1, bestD: Infinity };
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          consider(cx + dx, cz + dz, dx, dz, acc);
        }
      }
      if (acc.best >= 0) return acc.best;
    }
    return -1;
  }

  /**
   * A* between two world points. Writes world-space waypoints into `out`
   * (an array of THREE.Vector3, reused) and returns the count.
   */
  findPath(from, to, out, opts = {}) {
    const start = this.nearest(from.x, from.z, from.y);
    const goal = this.nearest(to.x, to.z, to.y);
    if (start < 0 || goal < 0) return 0;
    if (start === goal) {
      this._emit(out, 0, to);
      return 1;
    }
    const nx = this.nx;
    const gx = this.ixOf(goal), gz = this.izOf(goal);
    const cell = this.cell;
    /**
     * The cap has to exceed the WALKABLE CELL COUNT, not be a round number.
     *
     * At 6000 it sat just under Holdout's 6532 walkable cells, so a path across
     * the map could exhaust the budget and return zero — and a zero-length path
     * is indistinguishable from "unreachable" to the caller, which then falls
     * back to steering straight at the target and grinds into the nearest wall.
     * An intermittent version of the same bug is the worst kind: it depends on
     * how much of the grid the search happens to open.
     *
     * Derived from the grid so it cannot silently fall behind a bigger map
     * again, with a floor for tiny ones.
     */
    const maxNodes = opts.maxNodes ?? Math.max(6000, (this.walkableCount || 0) * 2);

    this.stamp++;
    const stamp = this.stamp;
    this.open.clear();
    this.gScore[start] = 0;
    this.came[start] = -1;
    this.visitStamp[start] = stamp;
    this.open.push(start, 0);

    let expanded = 0;
    let found = false;
    while (this.open.n > 0 && expanded < maxNodes) {
      const cur = this.open.pop();
      if (cur === goal) {
        found = true;
        break;
      }
      if (this.closedStamp[cur] === stamp) continue; // stale duplicate entry
      this.closedStamp[cur] = stamp;
      expanded++;
      const cxi = this.ixOf(cur), czi = this.izOf(cur);
      const cg = this.gScore[cur];
      const cy = this.floor[cur];
      for (let d = 0; d < 8; d++) {
        const dx = DX[d], dz = DZ[d];
        const ix = cxi + dx, iz = czi + dz;
        /**
         * `edge()` owns the rule: it picks the storey reachable from THIS
         * cell's height (which enforces the step limit, replacing the old
         * explicit `dy` check) and refuses diagonal corner cuts. Two storeys of
         * one column stay disconnected unless a ramp or stair brings their
         * floors within a step of each other, which is the connectivity we
         * want. The prune walks the identical function, so what it certifies as
         * connected is exactly what this search can cross.
         */
        const ni = this.edge(cur, d);
        if (ni < 0) continue;
        const dy = this.floor[ni] - cy;
        let cost = (dx && dz ? SQRT2 : 1) * cell;
        cost += Math.abs(dy) * 2.2; // prefer flat ground
        if (this.flags[ni] === 2) cost += cell * 1.6; // crouch-only squeeze
        cost += this.enclosure[ni] * cell * 0.25; // avoid scraping walls
        const g = cg + cost;
        if (this.closedStamp[ni] === stamp) continue;
        if (this.visitStamp[ni] === stamp && g >= this.gScore[ni]) continue;
        this.visitStamp[ni] = stamp;
        this.gScore[ni] = g;
        this.came[ni] = cur;
        const hx = Math.abs(ix - gx), hz = Math.abs(iz - gz);
        const h = (Math.max(hx, hz) + (SQRT2 - 1) * Math.min(hx, hz)) * cell;
        this.open.push(ni, g + h * 1.06);
      }
    }
    if (!found) return 0;

    // walk the parents back, then string-pull
    const raw = this._raw ?? (this._raw = []);
    raw.length = 0;
    let n = goal;
    while (n >= 0) {
      raw.push(n);
      n = this.came[n];
    }
    raw.reverse();
    return this._stringPull(raw, from, to, out);
  }

  _emit(out, i, v) {
    if (!out[i]) out[i] = new THREE.Vector3();
    out[i].copy(v);
  }

  /**
   * Greedy string pull: keep the furthest waypoint still reachable in a
   * straight walkable line from the anchor. Turns a staircase into a corner.
   */
  _stringPull(raw, from, to, out) {
    let count = 0;
    const anchor = this._v.copy(from);
    let i = 0;
    const pos = this._v2;
    while (i < raw.length - 1) {
      let best = i + 1;
      for (let j = raw.length - 1; j > i; j--) {
        const c = raw[j];
        pos.set(this.worldX(this.ixOf(c)), this.floor[c], this.worldZ(this.izOf(c)));
        if (this.lineOfWalk(anchor, pos)) {
          best = j;
          break;
        }
      }
      const c = raw[best];
      pos.set(this.worldX(this.ixOf(c)), this.floor[c], this.worldZ(this.izOf(c)));
      this._emit(out, count++, pos);
      anchor.copy(pos);
      i = best;
      if (count >= 32) break;
    }
    // finish on the exact goal if we can see it
    if (this.lineOfWalk(anchor, to) && count < 32) this._emit(out, count++, to);
    else if (count === 0) this._emit(out, count++, to);
    return count;
  }

  /** Is the straight segment walkable end to end? */
  lineOfWalk(a, b) {
    /**
     * WALK IT, do not sample it.
     *
     * This used to step along the line and ask, at each sample, "is there a
     * walkable storey near the height I am running at". That question can be
     * true at every single sample while the straight line still crosses a wall,
     * because it never checks that consecutive cells are CONNECTED - only that
     * each one, independently, has some floor at roughly the right height. A
     * terrace and the ground beneath it are exactly that shape, so a line could
     * pass through the terrace's side wall unchallenged.
     *
     * `_stringPull` trusts this to decide which waypoints it may skip, so a
     * false positive does not merely add a bad waypoint, it DELETES the real
     * route between two points and leaves a straight line through rock.
     * Measured on outpost: waypoint 1 landing 33.8 m away behind a terrace
     * wall, with the agent grinding into it on 1379 of 1498 frames.
     *
     * Now it marches cell to cell and requires a real `edge()` for every step -
     * the same edge A* used to build the path it is being asked to shorten. A
     * shortcut is accepted only if it is walkable by the identical rule.
     */
    let cur = this.nearest(a.x, a.z, a.y, 1);
    if (cur < 0) return false;
    const dx = b.x - a.x, dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / (this.cell * 0.5)));
    let ix = this.ixOf(cur), iz = this.izOf(cur);
    // Bounded: a straight line cannot need more cell transitions than its
    // length in cells, plus slack for the diagonal staircase.
    let guard = Math.ceil(dist / this.cell) * 2 + 8;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const nx = this.cellX(a.x + dx * t), nz = this.cellZ(a.z + dz * t);
      while ((ix !== nx || iz !== nz) && guard-- > 0) {
        const sx = Math.sign(nx - ix), sz = Math.sign(nz - iz);
        const d = DIR[(sx + 1) * 3 + (sz + 1)];
        if (d < 0) return false;
        const ni = this.edge(cur, d);
        if (ni < 0) return false;
        cur = ni;
        ix += sx;
        iz += sz;
      }
      if (guard <= 0) return false;
    }
    return true;
  }
}

/**
 * (sx + 1) * 3 + (sz + 1) -> index into DX/DZ. -1 is the no-move centre.
 */
const DIR = [7, 1, 6, 3, -1, 2, 5, 0, 4];

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

/* ------------------------------------------------------------------ */
/* Cover                                                               */
/* ------------------------------------------------------------------ */

/**
 * A cover point: a spot to stand plus the direction the protection comes from.
 * `high` means the blocker stops a standing shot; otherwise it is crouch cover.
 * `peek` is a lateral offset that clears the edge for shooting.
 */
export class CoverMap {
  constructor(grid, physics) {
    this.grid = grid;
    this.physics = physics;
    this.points = [];
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this.buildMs = 0;
  }

  build(opts = {}) {
    const t0 = performance.now();
    const g = this.grid;
    const phys = this.physics;
    // Same collision set the character controller uses; see build().
    const MASK = phys.MASK.CHARACTER;
    const step = opts.step ?? 1; // sample every Nth cell
    const reach = opts.reach ?? 1.25;
    this.points.length = 0;
    for (let iz = 1; iz < g.nz - 1; iz += step) {
      for (let ix = 1; ix < g.nx - 1; ix += step) {
        // Both storeys: the ground under a roof is exactly where cover lives.
        for (let l = 0; l < g.layers; l++) {
        if (!g.walkable(ix, iz, true, l)) continue;
        const i = g.index(ix, iz, l);
        if (g.enclosure[i] === 0) {
          // still allow cover next to a blocked cell (thin props, sandbags)
          let adj = false;
          for (let d = 0; d < 4 && !adj; d++) {
            if (g.layerNear(ix + DX[d], iz + DZ[d], g.floor[i]) < 0) adj = true;
          }
          if (!adj) continue;
        }
        const x = g.worldX(ix), z = g.worldZ(iz), y = g.floor[i];
        // find the strongest blocking direction at chest and knee height
        for (let d = 0; d < 8; d++) {
          const dx = DX[d] / (d < 4 ? 1 : SQRT2);
          const dz = DZ[d] / (d < 4 ? 1 : SQRT2);
          const low = phys.raycast(x, y + 0.55, z, dx, 0, dz, reach, MASK);
          if (!low.hit) continue;
          const high = phys.raycastAny(x, y + 1.32, z, dx, 0, dz, reach, MASK);
          // must be able to shoot over/around: check a peek to both sides
          this.points.push({
            x, y, z,
            dx, dz, // direction the cover faces (toward the blocker)
            high,
            dist: low.distance,
            claimed: -1,
            score: 0,
          });
          break;
        }
        }
      }
    }
    this.buildMs = performance.now() - t0;
    return this;
  }

  /**
   * Best cover for an agent at `pos` against a threat at `threat`.
   * Scoring, in order of weight: does the blocker actually sit between us and
   * the threat, is the spot a sensible distance from both, is it free, and does
   * a peek from it have line of sight (a hole to shoot through).
   */
  pick(pos, threat, opts = {}) {
    const wantMin = opts.minRange ?? 6;
    const wantMax = opts.maxRange ?? 26;
    const claimId = opts.id ?? -1;
    const squad = opts.squad ?? null;
    const maxTravel = opts.maxTravel ?? 22;
    const yRef = opts.yRef ?? null;
    const yTol = opts.yTol ?? Infinity;
    let best = null;
    let bestScore = -Infinity;
    const tx = threat.x, tz = threat.z;
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (p.claimed >= 0 && p.claimed !== claimId) continue;
      const toThreatX = tx - p.x, toThreatZ = tz - p.z;
      const dT = Math.hypot(toThreatX, toThreatZ);
      if (dT < 2.5 || dT > 40) continue;
      const travel = Math.hypot(p.x - pos.x, p.z - pos.z);
      if (travel > maxTravel) continue;
      if (yRef !== null && Math.abs(p.y - yRef) > yTol) continue;
      // protection: the blocker must be on the threat side
      const prot = (toThreatX / dT) * p.dx + (toThreatZ / dT) * p.dz;
      if (prot < 0.25) continue;
      let score = prot * 5 + (p.high ? 2.2 : 1.0);
      // range preference
      if (dT < wantMin) score -= (wantMin - dT) * 0.55;
      else if (dT > wantMax) score -= (dT - wantMax) * 0.28;
      score -= travel * 0.16;
      // do not bunch up
      if (squad) {
        for (const other of squad) {
          if (!other || other.id === claimId || !other.alive) continue;
          const d = Math.hypot(other.position.x - p.x, other.position.z - p.z);
          if (d < 3.2) score -= (3.2 - d) * 1.4;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best && claimId >= 0) {
      for (const p of this.points) if (p.claimed === claimId) p.claimed = -1;
      best.claimed = claimId;
    }
    return best;
  }

  release(claimId) {
    for (const p of this.points) if (p.claimed === claimId) p.claimed = -1;
  }

  /**
   * Where to lean out from a cover point to shoot: try both sides and pick the
   * one with line of sight from the eye to the threat.
   */
  peekOffset(cover, threat, eyeH, out) {
    const phys = this.physics;
    // lateral axis = perpendicular to the cover facing
    const lx = -cover.dz, lz = cover.dx;
    const from = this._v;
    const to = this._v2.set(threat.x, threat.y, threat.z);
    for (const s of [1, -1, 0]) {
      const px = cover.x + lx * 0.62 * s;
      const pz = cover.z + lz * 0.62 * s;
      from.set(px, cover.y + eyeH, pz);
      if (phys.lineOfSight(from, to, phys.MASK.SIGHT)) {
        out.set(px, cover.y, pz);
        return s;
      }
    }
    out.set(cover.x, cover.y, cover.z);
    return 0;
  }
}
