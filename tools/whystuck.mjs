/**
 * For each agent that fails to reach the player: WHY.
 *
 * tools/chase.mjs establishes that 0/6 arrive and that several sit metres below
 * the surface above them. That is the symptom. This asks the grid and the
 * physics directly, per agent:
 *
 *   cellWalkable   is the agent standing on a cell the grid calls walkable?
 *   pathLen        does findPath(agent -> player) return anything at all?
 *   floorAt        what the grid thinks the floor is under the agent
 *   groundY        what physics says is above the agent (burial detector)
 *   spawnedInside  did it START buried, or become buried while moving?
 */
import { chromium } from 'playwright';

const MAP = process.argv[2] ?? 'outpost';
const MODE = process.argv[3] ?? 'horde';
const SECONDS = Number(process.argv[4] ?? 30);
const BASE = process.argv[5] ?? 'http://127.0.0.1:5181/';

const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1000, height: 620 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(`${BASE}?map=${MAP}&mode=${MODE}&menu=0`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 300000 });
await p.waitForTimeout(1500);

const r = await p.evaluate(
  (secs) =>
    new Promise((done) => {
      const e = window.__ENGINE__;
      const ai = e.ctx.peek('ai');
      const pl = e.ctx.peek('player');
      const phys = e.ctx.peek('physics');
      const grid = ai.grid;
      e.ctx.get('render').renderer.render = () => {};

      const born = new Map();
      const t0 = performance.now();
      const snap = (a) => {
        const gy = phys?.groundHeight?.(a.position.x, a.position.z, a.position.y + 8);
        return {
          x: +a.position.x.toFixed(1), y: +a.position.y.toFixed(2), z: +a.position.z.toFixed(1),
          sunk: Number.isFinite(gy) ? +(gy - a.position.y).toFixed(2) : null,
        };
      };

      const tick = () => {
        for (const a of ai.agents) if (a.alive && !born.has(a)) born.set(a, snap(a));
        if (performance.now() - t0 > secs * 1000) {
          const rows = [];
          const total = ai.agents.length;
          const aliveN = ai.agents.filter((x) => x.alive).length;
          for (const a of ai.agents) {
            if (!a.alive) continue;
            const s = snap(a);
            // walkable/floorAt take CELL INDICES; findPath takes vectors plus an
            // out array and returns a COUNT.
            const cx = grid.cellX(a.position.x), cz = grid.cellZ(a.position.z);
            const walkable = grid.walkable(cx, cz);
            const floorAt = grid.inside(cx, cz) ? grid.floorAt(cx, cz) : null;
            let pathLen = null;
            try {
              const out = [];
              pathLen = grid.findPath(a.position, pl.position, out);
            } catch (err) { pathLen = 'ERR ' + String(err).slice(0, 40); }
            // What storey does the pathfinder actually snap this agent to? This is
            // the suspect: findPath calls nearest() WITHOUT a yTol, so `y` is
            // ignored and a cell on another storey is a legal snap target.
            const snapI = grid.nearest(a.position.x, a.position.z, a.position.y);
            const snapY = snapI >= 0 ? grid.floor[snapI] : null;
            const pWalk = grid.walkable(grid.cellX(pl.position.x), grid.cellZ(pl.position.z));
            rows.push({
              variant: a.variantName ?? '?', state: a.state,
              now: s, start: born.get(a) ?? null,
              walkable, floorAt: floorAt == null ? null : +floorAt.toFixed(2),
              snapY: snapY == null ? null : +snapY.toFixed(2),
              // What the AGENT itself is doing, not just what the grid could do.
              agentPathLen: a.pathLen ?? null,
              hasMoveTarget: !!a.hasMoveTarget,
              // >2.5 means _rush gave up on A* and is steering straight at the
              // player, grinding along whatever is in the way.
              moveTargetErr: a.hasMoveTarget && a.moveTarget
                ? +a.moveTarget.distanceTo(pl.position).toFixed(1) : null,
              pathLen, dist: +a.position.distanceTo(pl.position).toFixed(1),
              playerWalkable: pWalk,
            });
          }
          return done({ rows, total, aliveN, player: { x: +pl.position.x.toFixed(1), y: +pl.position.y.toFixed(2), z: +pl.position.z.toFixed(1) } });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  SECONDS
);
await b.close();

console.log(`\nplayer at ${JSON.stringify(r.player)}\n`);
console.log('variant     state    dist  walkable  floorAt  agentY  snapY   pathLen  agPath  mtErr');
for (const x of r.rows) {
  console.log(
    `${x.variant.padEnd(11)}${String(x.state).padEnd(9)}${String(x.dist).padStart(5)}` +
    `${String(x.walkable).padStart(10)}${String(x.floorAt).padStart(9)}${String(x.now.y).padStart(8)}` +
    `${String(x.snapY).padStart(7)}${String(x.pathLen).padStart(10)}${String(x.agentPathLen).padStart(8)}${String(x.moveTargetErr).padStart(7)}`
  );
}
console.log(`\nplayer cell walkable: ${r.rows[0]?.playerWalkable}`);
